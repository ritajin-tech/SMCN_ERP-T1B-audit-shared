/**
 * 🩹 V4.3.50 请假日历同步修复（列序修正 + 重复累积根因修复）
 * 读取 China Employee - Leave Calendar，按事件实际时长写工时，按事件 ID 幂等去重。
 *
 * V4.3.55 请假UUID碰撞根因修复（关键）：
 *  原 recordId = LEAVE- + _lsSanitizeId(eventId).substring(0,32) + '-' + dateStr
 *    —— 把事件ID清洗后截断前32字符当 UUID，会让不同事件（不同人/不同日期）撞同 UUID
 *    → 9/3 暴露：8/24 基线里 9,424 条「同 UUID」实为不同真实请假（截断碰撞）
 *    → 清理/同步逻辑基于该 UUID 误判 → 重复考勤 / 误删隐患
 *  改 recordId = LEAVE- + Utilities.getUuid()（去连字符 32hex） + '-' + dateStr
 *    —— 每行全局唯一，保留 LEAVE-...-<date> 格式以兼容 LEAVE_DATE_RE 日期回退正则
 *
 * V4.3.50（重要，两处真 bug）：
 *  ① 【列序错位】DB_工时流水 真实表头为
 *       A提交时间 B日期 C姓名 D类型 E阶段 F项目编号 G工时 H备注 I UUID J项目名 ... N年月 O=Is_Deleted
 *     V4.3.44 误按「F=工时/G=备注/H=recordId/I=项目名」写入，错位一整格 →
 *       工时(数字)写进了 F=项目编号列（污染出「项目编号=8」这类脏值）
 *       备注(文本)写进了 G=工时列（下游 parseFloat 读成 0）
 *     现按真实表头写入：D=类型'休假' E=阶段 F=项目编号'OFF-WORK' G=工时 H=备注 I=UUID J=项目名
 *     ⚠️ V4.3.44 的注释「线上表头是 F=工时/G=备注」是错的，V4.3.43 反而是对的。
 *
 *  ② 【休假重复累积真因】清理旧记录时用 `String(data[i][1])` 取日期，
 *     B 列在表里被存成 Date 对象 → String(Date) = "Wed Sep 02 2026 00:00:00 GMT+0800 (...)"
 *     与 '2026-08-01' 做字符串比较时 `dateStr <= endStr` 恒为 false →
 *     【旧的请假记录永远删不掉，每天同步又追加一遍】= 休假重复计算。
 *     现用 _lsNormDate() 统一归一化成 'yyyy-MM-dd' 再比较。
 *
 *  V4.3.45：清理标记列读取修正（index7→index6），本版进一步兼容新旧两种写入位置。
 */

const LEAVE_CALENDAR_ID = 'c_b9432c84c439fafa5948d1e7ae7eed3eb43aa6781340d326c151e1452661ea57@group.calendar.google.com';
const LEAVE_SYNC_SOURCE = '系统同步请假';
const LEAVE_SYNC_EVENT_PREFIX = 'LEAVE-';
const LEAVE_SYNC_TZ = 'GMT+8';
const LEAVE_SYNC_LOCK_TOKEN = 'LEAVE_SYNC_LOCK';
// V4.3.56: 本表只保留 2026-04-01 起的数据（DB 打卡 2026-04-01 才启用，更早的休假行是请假日历倒灌的历史脏数据）。
// 早于此日期的假：既不写入，也不参与「本次可重建」判定。
const LEAVE_SYNC_MIN_DATE = '2026-04-01';

// 2026-10-15 Rita 决定：请假同步目标从生产表(DB_工时流水)切换到主库(考勤表)，只追加不重写。
// 生产表此后只管工时填报；考勤以主库「请假」分页为准。
// false = 一进门就返回：不读日历、不碰任何表，只留痕 + 报心跳；触发器仍保持存活。
// 暂停/恢复：改这一行即可，下一天 06:30 自动生效。
const LEAVE_SYNC_ENABLED = true;

/**
 * V4.3.52:
 *   ① 清理逻辑不再依赖 B 列日期（历史脏行 B 为空 → 永远过不了窗口检查 = 永远删不掉）
 *      改判：备注含「系统同步请假」OR「LEAVE-」则视作系统同步记录 + 三路日期 fallback（B / 备注 / 无日期强删）
 *   ② _lsSplitEventToWorkdays 非全天跨天分支 由 <= 改 <（与全天分支保持一致，多同步一天）
 *   ③ 兼容 7 列(V4.2) / 11 列(V4.3.52) / 14 列(V4.3.50) 三种写入位置
 * V4.3.30: 请假同步触发器自愈 —— 确保每日 06:30 syncLeavesFromCalendar 触发器存在。
 * 从已授权的安装型触发器（syncLeavesFromCalendar 自身 / sendAmyIndirectCostReminder）调用；
 * 简单 onOpen 无授权无法建立定时触发器，故不依赖 onOpen。
 */
function ensureLeaveSyncTrigger() {
  try {
    const triggers = ScriptApp.getProjectTriggers();
    const exists = triggers.some(t => t.getHandlerFunction() === 'syncLeavesFromCalendar' && t.getEventType() === ScriptApp.EventType.CLOCK);
    if (!exists) {
      ScriptApp.newTrigger('syncLeavesFromCalendar').timeBased().everyDays(1).atHour(6).nearMinute(30).create();
      console.log('[ensureLeaveSyncTrigger] 已重建 syncLeavesFromCalendar 每日06:30触发器');
    }
  } catch (e) {
    console.log('[ensureLeaveSyncTrigger] 跳过：' + e.message);
  }
}

/**
 * 主入口：同步请假日历 → 主库（考勤表）「请假」分页。【V4.3.80 目标切换 · 2026-10-15】
 *
 * Rita 2026-10-15 决定：
 *   ① 请假数据不再写入生产表 DB_工时流水（生产表只管工时填报）；
 *   ② 改为每天往主库「请假」分页【只追加新增行，不整表重写、不删除任何行】；
 *   ③ 考勤以主库为准，生产表不再作为考勤来源。
 *
 * 与旧版（写生产表）的本质区别：
 *   旧：读全表 → 删 → 从第 1 行重写 → 删尾（每天把表压实一遍，行号漂移、数据带产生的根因）
 *   新：读日历 → 与主库现有行按「事件ID|日期」比对 → 只把缺的追加到末尾；一行不改、一行不删
 *
 * 去重键：evId|日期（与主库现有 H 列「事件ID|日期|姓名」同源，取前两段，容忍姓名写法差异）
 * 展开规则（与主库现有数据惯例逐条对齐，同 masterLeaves）：
 *   - 全天事件：按自然日(GMT+8)逐天展开，每天 8h，周末不跳过
 *   - 定时事件：按当日实际覆盖时长，单日上限 8h，0.1h 取整
 *   - 多日事件每天一行；L=当日序号、M=事件天数（按窗口内可见跨度计）
 *   - 日历里删掉的假不会被清出主库（只追加，不清理）——这是「不整表刷新」的代价
 *
 * @param {number} monthsBack  兼容旧签名保留，不再使用（窗口起点固定为数据起点 LEAVE_SYNC_MIN_DATE）
 * @param {number} monthsAhead 往后同步几个月（默认 2）
 * @returns {string} 结果摘要
 */
function syncLeavesFromCalendar(monthsBack, monthsAhead) {
  // V4.3.70 触发器传参污染修复（保留）：只接受有限数字，其余回落默认值
  monthsBack = (typeof monthsBack === 'number' && isFinite(monthsBack)) ? monthsBack : 1;
  monthsAhead = (typeof monthsAhead === 'number' && isFinite(monthsAhead)) ? monthsAhead : 2;

  // 总开关：false = 一进门就返回，不读日历、不碰任何表
  if (!LEAVE_SYNC_ENABLED) {
    var _offMsg = '请假同步已停用（开关 LEAVE_SYNC_ENABLED=false）';
    try { _tsWriteLog('leave_sync_disabled', _offMsg + '；本次未读日历、未写任何表'); } catch (eLog) {}
    try { _recordTimeSheetHeartbeat('⚪', _offMsg); } catch (eHb) {}
    return _offMsg + '；未读取日历、未改动任何数据。';
  }

  // V4.3.30: 从已授权触发器上下文自愈安装本触发器
  ensureLeaveSyncTrigger();
  // V4.3.50: 顺带自愈安装 Sheet3 每 2 小时自动重建触发器（同属已授权上下文）
  try { ensureSheet3Trigger(); } catch (e) { console.log('[ensureSheet3Trigger] ' + e.message); }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('同步请假正在运行，请稍后再试');

  try {
    const cal = CalendarApp.getCalendarById(LEAVE_CALENDAR_ID);
    if (!cal) throw new Error('无法访问请假日历：' + LEAVE_CALENDAR_ID);

    // 窗口：起点固定为数据起点 LEAVE_SYNC_MIN_DATE，终点 = 今天所在月 + monthsAhead 个月的月末
    //   固定起点 + 实例级去重 ⇒ 漏建的事件后续每天都会被补上，重复运行也不会产生重复行
    const now = new Date();
    const startDate = _lsParseDay(LEAVE_SYNC_MIN_DATE);
    let endDate = new Date(now.getFullYear(), now.getMonth() + monthsAhead + 1, 0, 23, 59, 59);
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime()) || startDate >= endDate) {
      endDate = new Date(now.getFullYear(), now.getMonth() + 3, 0, 23, 59, 59);
    }
    const startStr = _lsFmt(startDate);
    const endStr = _lsFmt(endDate);

    const events = cal.getEvents(startDate, endDate);

    // 主库（考勤表）：闸门与 masterCreate 同源 —— 不自动新建、不碰生产表、名称必须匹配
    const master = _lsGetMasterSs();
    const leaveSheet = master.getSheetByName(MASTER_LEAVE_SHEET_NAME);
    if (!leaveSheet) throw new Error('主库缺少「' + MASTER_LEAVE_SHEET_NAME + '」分页，已中止（未写任何数据）');

    // 现有去重键（evId|日期）
    const existing = _lsMasterLeaveKeys(leaveSheet);

    const newRows = [];
    const seen = {};
    let skippedDup = 0;
    let skippedNoName = 0;
    let eventCount = 0;

    events.forEach(function (e) {
      const title = String(e.getTitle() || '').trim();
      if (!title) return;
      const rawName = _lsExtractName(title);
      if (!rawName) return;
      const name = getExactName(rawName);
      if (!name) { skippedNoName++; return; }

      const t0 = e.getStartTime().getTime();
      const t1 = e.getEndTime().getTime();
      if (!(t1 > t0)) return;
      const eventId = (e.getId() || '').split('@')[0];
      if (!eventId) return;
      const allDay = e.isAllDayEvent();
      const jStr = new Date(t0).toISOString();
      const kStr = new Date(t1).toISOString();
      eventCount++;

      // 按自然日展开（只展开窗口内可见跨度；与主库现有行惯例一致：周末不跳过）
      const firstDay = _lsBjDateStr(t0);
      const lastDay = _lsBjDateStr(t1 - 1);
      let total = _lsDaysBetween(firstDay, lastDay) + 1;
      if (total < 1) total = 1;
      if (total > MASTER_LEAVE_MAX_DAYS) total = MASTER_LEAVE_MAX_DAYS;

      for (let i = 0; i < total; i++) {
        const dayStr = _lsAddDays(firstDay, i);
        if (dayStr < LEAVE_SYNC_MIN_DATE) continue;
        if (dayStr < startStr || dayStr > endStr) continue;
        const dedupKey = eventId + '|' + dayStr;
        if (seen[dedupKey] || existing[dedupKey]) { skippedDup++; continue; }
        seen[dedupKey] = true;

        let hours = 8;
        if (!allDay) {
          const dayStartMs = _lsDayStartMs(dayStr);
          const ds = Math.max(t0, dayStartMs);
          const de = Math.min(t1, dayStartMs + 86400000);
          hours = (de - ds) / 3600000;
          if (hours > 8) hours = 8;
          if (hours < 0) hours = 0;
          hours = Math.round(hours * 10) / 10;
        }

        newRows.push([
          name,                                          // A 姓名
          new Date(_lsDayStartMs(dayStr)).toISOString(), // B 日期（当日 00:00 GMT+8）
          '休假',                                        // C 类型
          'OFF-WORK',                                    // D 阶段
          'OFF-WORK',                                    // E 项目编号
          hours,                                         // F 工时
          LEAVE_SYNC_SOURCE,                             // G 备注
          eventId + '|' + dayStr + '|' + name,           // H 去重键（实例级）
          '日历',                                        // I 来源
          jStr,                                          // J 事件开始
          kStr,                                          // K 事件结束
          i + 1,                                         // L 当日序号
          total,                                         // M 事件天数
          allDay ? '是' : '否'                           // N 全天
        ]);
      }
    });

    // 护栏：稳态下每天只该追加个位数；暴涨 = 去重失效 → 中止，绝不污染主库
    if (newRows.length > MASTER_LEAVE_MAX_APPEND) {
      const haltMsg = '请假同步已中止：本次将追加 ' + newRows.length + ' 行，超过安全阈值 ' +
                      MASTER_LEAVE_MAX_APPEND + ' 行，疑似去重失效。主库未做任何改动。';
      try { _recordTimeSheetHeartbeat('🔴', haltMsg); } catch (eHb) {}
      throw new Error(haltMsg);
    }

    if (newRows.length > 0) {
      const startRow = leaveSheet.getLastRow() + 1;
      leaveSheet.getRange(startRow, 1, newRows.length, 14).setValues(newRows);
    }

    _tsWriteLog('leave_sync_master',
      '追加 ' + newRows.length + ' 行到主库「请假」分页；跳过已存在 ' + skippedDup +
      ' 行；窗口 ' + startStr + '~' + endStr + '；事件 ' + eventCount + ' 个；无姓名 ' + skippedNoName + ' 个');
    _recordTimeSheetHeartbeat('🟢', '请假同步→考勤表正常：新增 ' + newRows.length + ' 行');
    return '请假同步完成（目标＝主库考勤表，只追加不重写）：新增 ' + newRows.length +
           ' 条，跳过已存在 ' + skippedDup + ' 条（区间 ' + startStr + ' ~ ' + endStr + '）';
  } catch (e) {
    try { _recordTimeSheetHeartbeat('🔴', e.message); } catch (eHb) {}
    throw e;
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// V4.3.80 主库（考勤表）写入辅助 —— 只追加，不重写，不删除
// ============================================================
var MASTER_LEAVE_SHEET_NAME = '请假';
var MASTER_LEAVE_MAX_DAYS = 800;    // 单事件展开上限，防病态超长事件
var MASTER_LEAVE_MAX_APPEND = 300;  // 单次追加上限，超过即中止（去重失效保护）

// 打开主库（闸门与 masterCreate.js 同源：不自动新建、不碰生产表、名称必须匹配）
// 属性缺失时的引导值：主库 2026-10-14 由本地工具直接建表灌数，未经过 masterCreate，
//   因此 MASTER_SSID 属性可能从未写入。引导值同样要过全部闸门，通过后才补写属性——
//   补写之后属性恢复为唯一来源，引导值不再起作用。
var MASTER_SSID_BOOTSTRAP = '1oxPj0mzN8poP2vQ7Bm-YKXuU49p9b0c1asyrZn4Py44';
function _lsGetMasterSs() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(MASTER_PROP_KEY);
  var bootstrapped = false;
  if (!id) { id = MASTER_SSID_BOOTSTRAP; bootstrapped = true; }
  if (typeof _masterIsForbidden === 'function' && _masterIsForbidden(id)) {
    throw new Error('主库 ID 指向受保护目标（生产表），已硬阻断');
  }
  var ss = null;
  try { ss = SpreadsheetApp.openById(id); } catch (err) { ss = null; }
  if (!ss) throw new Error('主库无法打开（表被删/无权限/ID 变更），已中止');
  if (ss.getName() !== MASTER_SS_NAME) {
    throw new Error('目标表名称不等于 ' + MASTER_SS_NAME + '，已中止');
  }
  if (bootstrapped) {
    try { props.setProperty(MASTER_PROP_KEY, ss.getId()); } catch (eSet) {}
  }
  return ss;
}

// 读主库请假页 H 列现有去重键，返回 {evId|日期: true}
function _lsMasterLeaveKeys(sheet) {
  var set = {};
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return set;
  var values = sheet.getRange(2, 8, lastRow - 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    var k = String(values[i][0] || '').trim();
    if (!k) continue;
    var parts = k.split('|');
    if (parts.length >= 2 && parts[0] && parts[1]) set[parts[0] + '|' + parts[1]] = true;
  }
  return set;
}

// 'yyyy-MM-dd' → Date（脚本时区 Asia/Shanghai 的当天零点）
function _lsParseDay(ds) {
  var p = ds.split('-');
  return new Date(+p[0], +p[1] - 1, +p[2]);
}

// 时间戳 → GMT+8 日期串
function _lsBjDateStr(ms) {
  return Utilities.formatDate(new Date(ms), 'GMT+8', 'yyyy-MM-dd');
}

// 当日 00:00(GMT+8) 的时间戳
function _lsDayStartMs(ds) {
  var p = ds.split('-');
  return Date.UTC(+p[0], +p[1] - 1, +p[2]) - 8 * 3600000;
}

// 日期串加 N 天
function _lsAddDays(ds, n) {
  var d = _lsParseDay(ds);
  d.setDate(d.getDate() + n);
  return Utilities.formatDate(d, 'GMT+8', 'yyyy-MM-dd');
}

// 两个日期串相差几天（b - a）
function _lsDaysBetween(a, b) {
  return Math.round((_lsParseDay(b).getTime() - _lsParseDay(a).getTime()) / 86400000);
}


/** 从事件标题提取姓名（取第一个 '-' 前面的内容）。 */
function _lsExtractName(title) {
  const m = title.match(/^([^\-–—]+)/);
  if (m) return m[1].trim();
  return title.trim();
}

/**
 * 把事件拆成按工作日的记录。全天事件跨天每天 8h；定时事件按实际时长，单日最多 8h。
 *
 * V4.3.59 【窗口 clamp】新增可选参数 clampStart / clampEnd（同步窗口的起止 Date）。
 *   背景：CalendarApp.getEvents(from, to) 的语义是「返回与区间**重叠**的事件」，不是「返回区间内的事件」。
 *         所以一个 2026-04-01 开始、11-18 结束的长假，在 8/1~11/30 的窗口里照样被捞回来；
 *         更极端的是日历里存在跨年的超长事件（甚至是 2023 年开始的），每次同步都会被捞一遍。
 *   旧行为：切分时从**事件真实开始日**一路切到**真实结束日**，完全不管窗口 →
 *         ① 倒灌 2023-2026-03 的陈年假（已由 LEAVE_SYNC_MIN_DATE 兜底拦住写入）；
 *         ② rebuildKeys 暴涨 → 9/6 实测 3,418 行「删后重建」，把护栏撑爆（5,302 > 3,000）。
 *   新行为：只生成 [clampStart, clampEnd] 区间内的日期。窗口外的部分等窗口滚动过去自然会被补上；
 *         且因为 rebuildKeys 也随之收窄，窗口外的既有行不会被判定为「本次可重建」→ 不会被误删。
 *   不传 clampStart/clampEnd 时行为与旧版完全一致（向后兼容）。
 */
/**
 * V4.3.60 【人员白名单】只同步「工时表里有手工填报记录的人」的假。
 *   背景（2026-09-06 她指出）：工时表只跟踪指定的人，不填工时的人（如休产假的 Jane、
 *   行政/后勤等）的假不该进这张表 —— 进了也没人用，还把表撑大、让 rebuildKeys 虚高。
 *   判定依据：DB_工时流水 里出现过「手工填报」行的姓名即为名单成员。
 *   **系统同步的请假行不算证据**（否则「某人只有假没有工时」会被自己反向证明在名单里）。
 * 人员变动自动跟随：新人一旦填了工时，下次同步就自动纳入，无需维护。
 */
var _lsRoster = null;
var _lsRosterSize = 0;
function _lsIsLeaveRow(r) {
  // 宽口径：命中任一列标记 / E=休假·OFF-WORK / F=OFF-WORK / I=AUTO_LEAVE 都算请假行。
  // 宁可把请假行判准（否则「某人只有假没工时」会被自己反向证明进名单，白名单失效）。
  if (r.length < 9) return false;
  const G = String(r[6] || ''), H = String(r[7] || ''), I = String(r[8] || '');
  if (/(系统同步请假|LEAVE-|AUTO_LEAVE)/i.test(G + ' ' + H + ' ' + I)) return true;
  const E = String(r[4] || '').trim(), F = String(r[5] || '').trim();
  if (/^(休假|OFF-WORK)$/i.test(E)) return true;
  if (/^OFF-WORK$/i.test(F)) return true;
  return false;
}
function _lsBuildRoster(data) {
  const set = {};
  for (let i = 1; i < data.length; i++) {
    const nm = String(data[i][2] || '').trim();
    if (!nm) continue;
    if (_lsIsLeaveRow(data[i])) continue;   // 请假行不算「这人要记工时」的证据
    const k = nm.toLowerCase();
    set[k] = true;
    // 兼容日历里的 "XXX on leave" 写法
    const base = nm.replace(/on leave/i, '').trim().toLowerCase();
    if (base) set[base] = true;
  }
  _lsRoster = set;
  _lsRosterSize = Object.keys(set).length;
  return set;
}
function _lsInRoster(name) {
  if (!_lsRoster) return true;   // 名单未就绪时不拦截（保守，宁多勿漏）
  const k = String(name || '').trim().toLowerCase();
  if (_lsRoster[k]) return true;
  // 日历里常写 "Aien Shen on leave" / "XXX 休假"，去掉后缀再试一次
  const base = k.replace(/on leave/i, '').trim();
  if (base && _lsRoster[base]) return true;
  return false;
}

function _lsSplitEventToWorkdays(start, end, allDay, clampStart, clampEnd) {
  const days = [];
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const tz = LEAVE_SYNC_TZ;
  // V4.3.32: 请假同步应跳过中国法定节假日(定义在 onOpen.js 全局 HOLIDAYS)，避免节假日被计为工作日
  const holidaySet = {};
  (typeof HOLIDAYS !== 'undefined' ? HOLIDAYS : []).forEach(function(h) { holidaySet[h] = true; });

  // 窗口右界取「结束后一天」，因为切分用 < 比较（结束日 exclusive）
  const clampEndEx = clampEnd ? new Date(clampEnd.getTime() + MS_PER_DAY) : null;

  const evStart = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const evEnd = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  // 事件与窗口完全无交集 → 一行都不该生成
  if (clampEndEx && evStart >= clampEndEx) return days;
  if (clampStart && evEnd <= clampStart) return days;

  if (allDay) {
    let d = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    let endDate = new Date(end.getFullYear(), end.getMonth(), end.getDate());
    if (clampStart && d < clampStart) d = new Date(clampStart);
    if (clampEndEx && endDate > clampEndEx) endDate = clampEndEx;
    while (d < endDate) {  // Google Calendar 全天事件结束日期为 exclusive，应使用 < 而非 <=
      const day = d.getDay();
      const ds = Utilities.formatDate(d, tz, 'yyyy-MM-dd');
      if (day !== 0 && day !== 6 && !holidaySet[ds]) {
        days.push({ dateStr: ds, hours: 8 });
      }
      d = new Date(d.getTime() + MS_PER_DAY);
    }
  } else {
    let startDate = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    let endDate = new Date(end.getFullYear(), end.getMonth(), end.getDate());
    if (clampStart && startDate < clampStart) startDate = new Date(clampStart);
    if (clampEndEx && endDate > clampEndEx) endDate = clampEndEx;

    if (startDate.getTime() === endDate.getTime()) {
      const hours = Math.min(8, Math.max(0.5, (end - start) / (1000 * 60 * 60)));
      const ds = Utilities.formatDate(startDate, tz, 'yyyy-MM-dd');
      if (!holidaySet[ds]) {
        days.push({ dateStr: ds, hours: _lsRoundHalf(hours) });
      }
    } else {
      let d = new Date(startDate);
      // V4.3.52: 与全天分支保持一致，使用 < 而非 <=
      // 定时（非全天）事件的 getEndTime() 是事件真正结束的瞬时时间（如 2026-08-05 18:00），
      // 按日历 0 点切片会包含结束当天——但用户的请假意图通常是「含起始日、不含结束日」，
      // 且与全天分支（<）保持一致更稳。
      while (d < endDate) {
        const day = d.getDay();
        const ds = Utilities.formatDate(d, tz, 'yyyy-MM-dd');
        if (day !== 0 && day !== 6 && !holidaySet[ds]) {
          days.push({ dateStr: ds, hours: 8 });
        }
        d = new Date(d.getTime() + MS_PER_DAY);
      }
    }
  }

  return days;
}

function _lsFmt(d) {
  return Utilities.formatDate(d, LEAVE_SYNC_TZ, 'yyyy-MM-dd');
}

/**
 * V4.3.50: 把 B 列日期统一归一化为 'yyyy-MM-dd' 字符串。
 * 表里 B 列可能是 Date 对象，也可能是字符串 —— 直接 String() 会得到
 * "Wed Sep 02 2026 00:00:00 GMT+0800 (...)" 导致区间比较全部失效（休假重复累积真因）。
 */
function _lsNormDate(v) {
  if (!v) return '';
  if (v instanceof Date) {
    try { return Utilities.formatDate(v, LEAVE_SYNC_TZ, 'yyyy-MM-dd'); } catch (e) { return ''; }
  }
  return String(v).trim().substring(0, 10);
}

function _lsRoundHalf(n) {
  return Math.round(n * 2) / 2;
}

function _lsSanitizeId(id) {
  return String(id || '').replace(/[^a-zA-Z0-9]/g, '');
}

// V4.3.31: 请假同步健康度上报到 pmlist 心跳看板（复用 pmlist 表格 ID）
// Project No/Module 固定为 "TimeSheet"，每次同步更新同一行，便于一眼看全员请假同步是否健康
function _recordTimeSheetHeartbeat(status, errMsg) {
  try {
    var PMLIST_ID = '1XVvgruEU8nIUjTgLP4x13e7h-Ua7zHrsohoryzwUifQ';
    var ss = SpreadsheetApp.openById(PMLIST_ID);
    var sheet = ss.getSheetByName('Sync Heartbeat / 同步心跳');
    if (!sheet) {
      sheet = ss.insertSheet('Sync Heartbeat / 同步心跳');
      sheet.appendRow(['Project No', 'Module', 'Last Sync', 'Status', 'Last Error']);
      sheet.getRange(1, 1, 1, 5).setFontWeight('bold');
    }
    var pNo = 'TimeSheet';
    var module = 'TimeSheet';
    var now = Utilities.formatDate(new Date(), 'GMT+8', 'yyyy-MM-dd HH:mm:ss');
    var data = sheet.getDataRange().getValues();
    var foundRow = -1;
    for (var r = 1; r < data.length; r++) {
      if (data[r][0] && String(data[r][0]).trim() === pNo && String(data[r][1] || '').trim() === module) { foundRow = r + 1; break; }
    }
    if (foundRow === -1) {
      sheet.appendRow([pNo, module, now, status, errMsg || '']);
    } else {
      sheet.getRange(foundRow, 3).setValue(now);
      sheet.getRange(foundRow, 4).setValue(status);
      sheet.getRange(foundRow, 5).setValue(errMsg || '');
    }
  } catch (e) {
    console.error('TimeSheet heartbeat write failed: ' + e.message);
  }
}
