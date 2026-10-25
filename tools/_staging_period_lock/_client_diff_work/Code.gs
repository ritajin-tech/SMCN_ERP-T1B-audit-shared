/**
 * 👑 TimeSheet Manager V4.0 RC (Release Candidate)
 * 核心升级：并发锁、软删除审计、全局抽象句柄、12位 Record ID、Token 深度清理
 */

var TS_ID = '1Pi5u9fEawgp7yICWPMMyQCT_LbwTZthQDW-H05xYdVI'; 
var BD_ID = '122GRtBPsk1KyEwFJ3QeolYO9jmyT1SmEB47cuohclKc'; 
var HR_ID = '1XZy2gxHEZAbWKW_BoBHkUd--Ozmv5uqcC6Uw6wJDWoQ'; 

function getDbSheet() { return SpreadsheetApp.openById(TS_ID).getSheetByName('DB_工时流水'); }
function getHrSpreadsheet() { return SpreadsheetApp.openById(HR_ID); }
function getProjectSpreadsheet() { return SpreadsheetApp.openById(BD_ID); }

var _hrNameCache = null;
function getExactName(rawName) {
  if (!rawName) return "";
  if (!_hrNameCache) {
    _hrNameCache = {};
    try {
      const ss = getHrSpreadsheet();
      ['员工通讯录', '离职名单'].forEach(sheetName => {
        const sheet = ss.getSheetByName(sheetName);
        if (sheet) {
          const data = sheet.getDataRange().getValues();
          for (let i = 4; i < data.length; i++) {
            const exact = data[i][4] ? String(data[i][4]).trim() : ""; 
            if (exact) {
              const searchKey = exact.toLowerCase().replace(/[._-]/g, ' ').replace(/\s+/g, ' ').trim();
              if (!_hrNameCache[searchKey]) _hrNameCache[searchKey] = exact;
            }
          }
        }
      });
    } catch(e) {}
  }
  let lookupKey = String(rawName).replace(/on leave/i, '').trim().toLowerCase().replace(/[._-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (_hrNameCache[lookupKey]) return _hrNameCache[lookupKey];
  // V4.3.29: 容错——日历/外部姓名常只填 handle 或名(如 "aien")，而 HR 名册列存全名("Aien Wang")，
  // 精确键缺失会令该员工请假/工时记录被出勤自检·看板按姓名过滤时静默丢失（如 aien 请假不进出勤自检）。
  // 退化为「首词前缀唯一命中」：lookupKey 等于某 HR 键的首词且唯一时，回退到该全名；多命中/无命中保持原 raw(保守，避免跨人误判)。
  const _kList = Object.keys(_hrNameCache);
  const _hits = [];
  for (let _k = 0; _k < _kList.length; _k++) {
    const _c = _kList[_k];
    if (_c.indexOf(lookupKey + ' ') === 0) _hits.push(_hrNameCache[_c]);
  }
  if (_hits.length === 1) return _hits[0];
  return String(rawName).replace(/on leave/i, '').trim();
}

function getHrMap() {
  const cache = CacheService.getScriptCache();
  let cachedMap = cache.get('SYS_HR_MAP');
  if (cachedMap) return JSON.parse(cachedMap);

  const lock = LockService.getScriptLock();
  lock.waitLock(5000); 
  try {
    cachedMap = cache.get('SYS_HR_MAP');
    if (cachedMap) return JSON.parse(cachedMap);

    const ss = getHrSpreadsheet();
    const userMap = {};
    ['员工通讯录', '离职名单'].forEach(sheetName => {
      const sheet = ss.getSheetByName(sheetName);
      if (sheet) {
        const data = sheet.getDataRange().getValues();
        for (let i = 4; i < data.length; i++) {
          const emailKey = data[i][9] ? String(data[i][9]).toLowerCase().replace(/\s+/g, '').trim() : ""; 
          if (emailKey && emailKey.length > 5 && !userMap[emailKey]) {
            userMap[emailKey] = { name: data[i][4] ? String(data[i][4]).trim() : "", leader: data[i][10] || "TBD", dept: data[i][5] ? String(data[i][5]).trim() : "" };
          }
        }
      }
    });
    cache.put('SYS_HR_MAP', JSON.stringify(userMap), 1800);
    return userMap;
  } finally {
    lock.releaseLock();
  }
}

function formatPid(id) { 
  if (!id) return ""; 
  let v = String(id).trim().toUpperCase(); 
  if (/^\d{5}$/.test(v)) return v.substring(0, 2) + "-" + v.substring(2); 
  return v; 
}

function getProjectMap() {
  const cache = CacheService.getScriptCache();
  let cachedPMap = cache.get('SYS_PROJECT_MAP');
  if (cachedPMap) return JSON.parse(cachedPMap);

  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    cachedPMap = cache.get('SYS_PROJECT_MAP');
    if (cachedPMap) return JSON.parse(cachedPMap);

    const data = getProjectSpreadsheet().getSheets()[0].getDataRange().getValues();
    const pMap = { "OFF-WORK": "OFF-WORK / Leave", "INTERNAL": "INTERNAL / Internal" }; 
    for (let i = 1; i < data.length; i++) {
      let id = formatPid(data[i][0]);
      if (id && !pMap[id]) pMap[id] = data[i][1] || "Unnamed / 未命名"; 
    }
    cache.put('SYS_PROJECT_MAP', JSON.stringify(pMap), 1800);
    return pMap;
  } catch (e) { 
    return { "OFF-WORK": "OFF-WORK / Leave", "INTERNAL": "INTERNAL / Internal" }; 
  } finally {
    lock.releaseLock();
  }
}

function safeGetUuid(cellValue) {
  if (cellValue === null || cellValue === undefined) return "";
  if (cellValue instanceof Date) return cellValue.getTime().toString();
  return String(cellValue).trim();
}

// 前端自动版本检测用：每次发版改这个数字，旧版 HTML 加载时会发现不匹配并自动重载
const TS_APP_VERSION = '4.3.72'; // V4.3.71: 整表写回加 B 列日期护栏 _tsSetValuesGuarded（写后回读校验并自动还原），杜绝 purgeRows/purgeSoftLeaves 静默改坏业务日期

function getAppVersion() {
  return { version: TS_APP_VERSION };
}

/**
 * V4.3.62 POST 入口 —— 给「写入端哑管道」用（appendRows / patchCells）。
 * GET 的 query string 装不下上千行数据，必须走 POST body。
 * body: {"action":"appendRows","token":"SMCN-...","rows":[[...14列...],...]}
 * ⚠️ Google 对 Web App 的 POST 会先回 302，客户端需要把同一份 body 再 POST 到 Location。
 */
function doPost(e) {
  var r = _rtMaybeHandlePost(e);
  if (r) return r;
  return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'no action in POST body' }))
           .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  var r = _rtMaybeHandle(e); if (r) return r;
  return HtmlService.createTemplateFromFile('Index')
         .evaluate()
         .setTitle('TimeSheet Manager V4.0 RC')
         .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
         .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function verifyUserAndGetToken(email) {
  if (!email) throw new Error("Email required / 邮箱不能为空");
  const cleanEmail = email.toLowerCase().replace(/\s+/g, '').trim();
  const hr = getHrMap()[cleanEmail];
  
  if (!hr || !hr.name) throw new Error("Email not authorized in HR directory / 该邮箱未授权");

  const token = "TS-" + Utilities.getUuid().replace(/-/g, '').substring(0, 16);
  const tokenData = { email: cleanEmail, expire: Date.now() + 7 * 24 * 60 * 60 * 1000 };
  
  CacheService.getScriptCache().put(token, JSON.stringify(tokenData), 21600);
  PropertiesService.getScriptProperties().setProperty('AUTH_' + token, JSON.stringify(tokenData));
  
  return { token: token, name: hr.name };
}

function getCurrentUser(token) {
  if (!token) throw new Error("AUTH_FAILED:Unauthorized access / 未授权访问");
  
  const cache = CacheService.getScriptCache();
  const props = PropertiesService.getScriptProperties();
  let tokenStr = cache.get(token) || props.getProperty('AUTH_' + token);
  
  if (!tokenStr) throw new Error("AUTH_FAILED:Session expired. Please logout and verify again. / 登录已过期");
  
  const tokenData = JSON.parse(tokenStr);
  
  if (Date.now() > tokenData.expire) {
    props.deleteProperty('AUTH_' + token);
    cache.remove(token);
    throw new Error("AUTH_FAILED:Session exceeded 7 days. Please login again. / 登录会话已过期");
  }

  cache.put(token, JSON.stringify(tokenData), 21600); 

  const hr = getHrMap()[tokenData.email];
  if (!hr || !hr.name) throw new Error("AUTH_FAILED:Account permission error / 账号权限异常");
  
  return hr;
}

function cleanupExpiredTokens() {
  const props = PropertiesService.getScriptProperties();
  const cache = CacheService.getScriptCache();
  const keys = props.getKeys();
  const now = Date.now();
  let deletedCount = 0;

  keys.forEach(key => {
    if (key.startsWith('AUTH_')) {
      try {
        const tokenData = JSON.parse(props.getProperty(key));
        if (now > tokenData.expire) {
          props.deleteProperty(key);
          cache.remove(key.replace('AUTH_', '')); 
          deletedCount++;
        }
      } catch (e) {
        props.deleteProperty(key); 
      }
    }
  });
  console.log(`[Nightly Audit] Token 清理完毕，移除了 ${deletedCount} 个过期令牌。`);
}

function getDashboardData(token, timeRange) {
  const user = getCurrentUser(token);
  const myName = user.name;
  const today = new Date();
  
  let startOfRange, endOfRange, dateRangeStr;
  if (timeRange === 'month') {
    startOfRange = new Date(today.getFullYear(), today.getMonth(), 1);
    endOfRange = new Date(today.getFullYear(), today.getMonth() + 1, 0, 23, 59, 59, 999); 
    dateRangeStr = "This Month / 本月";
  } else {
    let weekOffset = parseInt(timeRange) || 0;
    const dayOfWeek = today.getDay() === 0 ? 7 : today.getDay(); 
    startOfRange = new Date(today.getFullYear(), today.getMonth(), today.getDate() - dayOfWeek + 1 - (weekOffset * 7));
    endOfRange = new Date(startOfRange.getFullYear(), startOfRange.getMonth(), startOfRange.getDate() + 6, 23, 59, 59, 999); 
    dateRangeStr = "Week / 周概览 (" + Utilities.formatDate(startOfRange, "GMT+8", "MM/dd") + " - " + Utilities.formatDate(endOfRange, "GMT+8", "MM/dd") + ")";
  }

  const tsData = getDbSheet().getDataRange().getValues();
  let logs = [], matrix = {}; 
  
  for (let i = 1; i < tsData.length; i++) {
    const dv = tsData[i][14];
    if (dv === true || String(dv).toUpperCase() === "TRUE") continue;
    
    if (getExactName(tsData[i][2]) !== myName) continue;
    const rowProject = String(tsData[i][5] || "").trim();
    const rowNotes = String(tsData[i][7] || "").trim().toLowerCase();
    const isLeaveRecord = /^(OFF[-_]?WORK|OFF|休假|LEAVE|ANNUAL\s*LEAVE|SICK\s*LEAVE|PERSONAL\s*LEAVE|请假|调休|年假|病假|事假|婚假|产假|陪产假|丧假)$/i.test(rowProject) ||
                          rowNotes.includes("系统同步请假") || rowNotes.includes("on leave");
    if (isLeaveRecord) continue; // V4.3.11: 请假/休假不计入本月看板与明细列表，避免与出勤自检页重复且易混淆（如 07-31 8h/0h 混杂）
    let rowDate = new Date(tsData[i][1]); 
    if (isNaN(rowDate.getTime()) || rowDate < startOfRange || rowDate > endOfRange) continue;
    
    let log = { uuid: safeGetUuid(tsData[i][8]), date: Utilities.formatDate(rowDate, "GMT+8", "yyyy-MM-dd"), stage: tsData[i][4], project: tsData[i][5], hours: parseFloat(tsData[i][6]) || 0, notes: tsData[i][7], rowHash: _plRowContentHash(tsData[i]) };
    logs.push(log);
    if (!matrix[log.project]) matrix[log.project] = [0,0,0,0,0,0,0];
    let logDay = rowDate.getDay() === 0 ? 6 : rowDate.getDay() - 1; 
    matrix[log.project][logDay] += log.hours;
  }
  logs.sort((a, b) => new Date(b.date) - new Date(a.date));
  return { pMap: getProjectMap(), matrix: matrix, logs: logs, range: dateRangeStr, userName: myName };
}

/**
 * V4.0: 明细补录页 - 按指定年月查询当前用户的工时日志（用于跨月批量补录/行内编辑）
 * 复用 getDashboardData 的读取与过滤逻辑（按姓名+软删过滤），只返回该月 logs。
 * 返回 {pMap, logs, userName}，不返回 matrix（日历用不到）。
 */
function getDetailLogsByMonth(token, year, month) {
  const user = getCurrentUser(token);
  const myName = user.name;
  const y = parseInt(year), m = parseInt(month);
  if (isNaN(y) || isNaN(m) || m < 1 || m > 12) throw new Error("Invalid year/month / 年月参数无效");
  const startOfRange = new Date(y, m - 1, 1);
  const endOfRange = new Date(y, m, 0, 23, 59, 59, 999);
  const tsData = getDbSheet().getDataRange().getValues();
  let logs = [];
  for (let i = 1; i < tsData.length; i++) {
    const dv = tsData[i][14];
    if (dv === true || String(dv).toUpperCase() === "TRUE") continue;
    if (getExactName(tsData[i][2]) !== myName) continue;
    const rowProject = String(tsData[i][5] || "").trim();
    const rowNotes = String(tsData[i][7] || "").trim().toLowerCase();
    const isLeaveRecord = /^(OFF[-_]?WORK|OFF|休假|LEAVE|ANNUAL\s*LEAVE|SICK\s*LEAVE|请假|调休|年假|病假|事假|婚假|产假|陪产假|丧假)$/i.test(rowProject) ||
                          rowNotes.includes("系统同步请假") ||
                          rowNotes.includes("on leave");
    if (isLeaveRecord) continue; // 休假/请假记录不在明细补录页展示，避免与系统同步请假重复
    let rowDate = new Date(tsData[i][1]);
    if (isNaN(rowDate.getTime()) || rowDate < startOfRange || rowDate > endOfRange) continue;
    logs.push({
      uuid: safeGetUuid(tsData[i][8]),
      date: Utilities.formatDate(rowDate, "GMT+8", "yyyy-MM-dd"),
      stage: tsData[i][4],
      project: tsData[i][5],
      hours: parseFloat(tsData[i][6]) || 0,
      notes: tsData[i][7],
      rowHash: _plRowContentHash(tsData[i])
    });
  }
  logs.sort((a, b) => new Date(b.date) - new Date(a.date));
  return { pMap: getProjectMap(), logs: logs, userName: myName };
}

/**
 * V4.3.6: 出勤自检 —— 返回指定年月当前用户「每日工时」与「请假日」，供前端日历热力图渲染漏填/少填。
 * - 工作日(周一~周五)且过去：0h → 漏填；<8h → 少填；>=8h → 达标。
 * - 请假日(项目=OFF-WORK/休假 或 备注含"系统同步请假/on leave") 标记为请假。
 * - 周末、未来日期不计入考核。
 * 返回 { year, month, dayHours:{date:hours}, leaveDays:{date:true}, standard, today }
 */
function getMonthAttendance(token, year, month) {
  const user = getCurrentUser(token);
  const myName = user.name;
  const y = parseInt(year), m = parseInt(month);
  if (isNaN(y) || isNaN(m) || m < 1 || m > 12) throw new Error("Invalid year/month / 年月参数无效");
  const startOfRange = new Date(y, m - 1, 1);
  const endOfRange = new Date(y, m, 0, 23, 59, 59, 999);
  const tsData = getDbSheet().getDataRange().getValues();
  const dayHours = {};   // dateStr -> 工作工时合计
  const leaveDays = {};  // dateStr -> 请假工时合计（数值，用于半天识别）
  const leaveDetailMap = {}; // V13.39/#560: 同日去重，ds -> {date, hours, note}，保留最大工时 + 合并不同备注
  const holidaySet = {}; // dateStr -> true（法定节假日，来自全局 HOLIDAYS）
  (typeof HOLIDAYS !== 'undefined' ? HOLIDAYS : []).forEach(function(d){ holidaySet[d] = true; });
  for (let i = 1; i < tsData.length; i++) {
    const dv = tsData[i][14];
    if (dv === true || String(dv).toUpperCase() === "TRUE") continue;
    if (getExactName(tsData[i][2]) !== myName) continue;
    const rowProject = String(tsData[i][5] || "").trim();
    const rowNotes = String(tsData[i][7] || "").trim().toLowerCase();
    const isLeave = /^(OFF[-_]?WORK|OFF|休假|LEAVE|ANNUAL\s*LEAVE|SICK\s*LEAVE|PERSONAL\s*LEAVE|请假|调休|年假|病假|事假|婚假|产假|陪产假|丧假)$/i.test(rowProject) ||
                      rowNotes.includes("系统同步请假") || rowNotes.includes("on leave");
    const rowDate = new Date(tsData[i][1]);
    if (isNaN(rowDate.getTime()) || rowDate < startOfRange || rowDate > endOfRange) continue;
    const ds = Utilities.formatDate(rowDate, "GMT+8", "yyyy-MM-dd");
    if (isLeave) {
      const lvH = (parseFloat(tsData[i][6]) || 0);
      leaveDays[ds] = (leaveDays[ds] || 0) + lvH;
      // V13.39/#560: 同日多源（如手动 OFF-WORK 行 + 日历同步请假行）去重，保留最大工时 + 合并不同备注
      const _note = String(tsData[i][7] || "").trim();
      if (!leaveDetailMap[ds]) {
        leaveDetailMap[ds] = { date: ds, hours: lvH, note: _note };
      } else {
        if (lvH > leaveDetailMap[ds].hours) leaveDetailMap[ds].hours = lvH;
        if (_note && leaveDetailMap[ds].note.indexOf(_note) === -1) {
          leaveDetailMap[ds].note = leaveDetailMap[ds].note ? (leaveDetailMap[ds].note + "; " + _note) : _note;
        }
      }
    }
    else { dayHours[ds] = (dayHours[ds] || 0) + (parseFloat(tsData[i][6]) || 0); }
  }
  // V13.39/#560: 由去重 map 生成请假清单（日期升序，yyyy-MM-dd 字符序即正确时序）
  const leaveDetails = Object.keys(leaveDetailMap).sort().map(function(k){ return leaveDetailMap[k]; });
  const today = Utilities.formatDate(new Date(), "GMT+8", "yyyy-MM-dd");
  return { year: y, month: m, dayHours: dayHours, leaveDays: leaveDays, leaveDetails: leaveDetails, holidays: holidaySet, standard: 8, today: today };
}

/**
 * V4.3.62 【类型列修复】根据阶段/项目编号推导 D 列「类型」。
 * 背景（2026-09-11 事故）：submitBatch 自 5 月起把 D 列写死为空串 ""，
 *  导致所有手工行无类型 —— 分类统计 / 成本分摊口径失真，且 8、9 月两次靠批量回填治标。
 * 规则（与历史三种写法一致：执行端 / 内部 / 休假）：
 *   ① 显式传了 type 且非空 → 用传入值
 *   ② 阶段以 "6." 开头（内部事务）或项目编号 = INTERNAL → 内部
 *   ③ 其余一律 执行端
 */
function _tsDeriveType(f) {
  var t = String((f && f.type) || '').trim();
  if (t) return t;
  var stage = String((f && f.stage) || '');
  var pid = String((f && f.project) || '').toUpperCase();
  if (stage.indexOf('6.') === 0 || pid.indexOf('INTERNAL') >= 0) return '内部';
  return '执行端';
}

/**
 * V4.3.63 【重复提交幂等键】
 * 同一人 + 同一业务日期 + 同项目 + 同工时 + 同阶段 + 同备注 = 视为同一次填报。
 * 用于拦截「手机上点一下没反应 → 连点 5 次 → 写进 5 条」的重复写入。
 */
function _tsDupKey(name, date, pid, hours, stage, notes) {
  var h = (parseFloat(hours) || 0);
  try { h = Number(h.toFixed(2)); } catch (e) {}
  return [String(name || '').trim(),
          String(date || '').substring(0, 10),
          String(pid || '').trim().toUpperCase(),
          String(h),
          String(stage || '').trim(),
          String(notes || '').trim()].join('|');
}

function submitBatch(token, tasks) {
  const user = getCurrentUser(token);
  const pMap = getProjectMap();
  const newRows = [];
  const expectIds = [];   // V4.3.62: 写后回读校验用

  // ===== V4.3.63 ① 批内去重：同一次调用里完全相同的行只写一条 =====
  const inBatchSeen = {};
  // ===== V4.3.63 ② 近 10 分钟内已写过的相同行 → 跳过（幂等） =====
  const IDEMPOTENT_WINDOW_MS = 10 * 60 * 1000;
  let recentSeen = {};
  try {
    const s0 = getDbSheet();
    const last = s0.getLastRow();
    if (last > 1) {
      const from = Math.max(2, last - 799);          // 只回看最后 800 行，避免全表读取
      const tail = s0.getRange(from, 1, last - from + 1, 15).getValues();
      const nowMs = Date.now();
      tail.forEach(function(r) {
        const dv = r[14];
        if (dv === true || String(dv).toUpperCase() === 'TRUE') return;
        if (String(r[2] || '').trim() !== String(user.name).trim()) return;
        const t = (r[0] instanceof Date) ? r[0].getTime() : new Date(r[0]).getTime();
        if (!t || (nowMs - t) > IDEMPOTENT_WINDOW_MS) return;
        recentSeen[_tsDupKey(r[2], r[1], r[5], r[6], r[4], r[7])] = true;
      });
    }
  } catch (e) { /* 幂等检查失败不阻断提交，宁可重复也不能丢数据 */ }

  let skippedDup = 0;
  tasks.forEach(f => {
    const pid = formatPid(f.project);
    const k = _tsDupKey(user.name, f.date, pid, f.hours, f.stage, f.notes);
    if (inBatchSeen[k] || recentSeen[k]) { skippedDup++; return; }
    inBatchSeen[k] = true;

    const recordId = "TS-" + Utilities.getUuid().replace(/-/g, '').substring(0, 12).toUpperCase();
    const pName = pMap[pid] || "Other / 其他";
    const yearMonth = String(f.date).substring(0, 7); 
    
    newRows.push([
      new Date(), f.date, String(user.name), _tsDeriveType(f), String(f.stage), pid, parseFloat(f.hours)||0, String(f.notes), recordId, pName, "", user.leader, "", yearMonth
    ]);
    expectIds.push(recordId);
  });

  if (newRows.length === 0) {
    // 全部被幂等拦掉 —— 说明用户刚提交过一模一样的内容，直接报成功，避免前端报错让人再点
    return skippedDup > 0 ? ("SUCCESS (skipped " + skippedDup + " duplicate)") : "SUCCESS";
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000); 
  try {
    const sheet = getDbSheet();
    const startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, newRows.length, 14).setValues(newRows);

    // V4.3.62 【写后回读校验】确认这 N 条的 UUID 真的落在表上。
    //   否则前端只看到 "SUCCESS" 而数据其实没进来 —— 9/11「填写的没了」的体验根因之一。
    const written = sheet.getRange(startRow, 9, newRows.length, 1).getValues().map(function(r){ return String(r[0]); });
    let missed = 0;
    expectIds.forEach(function(id){ if (written.indexOf(id) < 0) missed++; });
    if (missed > 0) {
      throw new Error("写入校验失败：" + missed + "/" + newRows.length + " 条未落表，请重试（数据未丢失）");
    }
    return "SUCCESS";
  } catch (e) { 
    throw new Error(e.message || "Batch write failed. Please retry. / 批量写入失败"); 
  } finally {
    lock.releaseLock();
  }
}

function updateTimesheet(token, f) {
  try {
    const user = getCurrentUser(token);
    const sheet = getDbSheet();
    const data = sheet.getDataRange().getValues();
    const pMap = getProjectMap();
    
    for (let i = 1; i < data.length; i++) {
      const dv = data[i][14];
      if (dv === true || String(dv).toUpperCase() === "TRUE") continue; 
      
      if (safeGetUuid(data[i][8]) == String(f.uuid).trim() && String(data[i][2]) === String(user.name)) {
        let row = i + 1;
        sheet.getRange(row, 2, 1, 9).setValues([[
          f.date, String(user.name), "", String(f.stage), formatPid(f.project), parseFloat(f.hours) || 0, String(f.notes), safeGetUuid(data[i][8]), pMap[formatPid(f.project)] || "Other / 其他"
        ]]);
        return "SUCCESS";
      }
    }
    throw new Error("Record not found or no permission to edit. / 记录未找到或无权限修改");
  } catch (e) { throw new Error(e.message || "Update failed / 更新失败"); }
}

function softDeleteRecord(token, uuid) {
  try {
    const user = getCurrentUser(token);
    const sheet = getDbSheet();
    const data = sheet.getDataRange().getValues();
    
    for (let i = 1; i < data.length; i++) {
      if (safeGetUuid(data[i][8]) == String(uuid).trim() && String(data[i][2]) === String(user.name)) { 
        sheet.getRange(i + 1, 15, 1, 3).setValues([[true, user.name, new Date()]]); 
        return "SUCCESS"; 
      }
    }
    throw new Error("Record not found or no permission to delete. / 记录未找到或无权限删除");
  } catch (e) { throw new Error(e.message || "Delete failed / 删除失败"); }
}

/**
 * V4.3.5: 幂等清理 DB_工时流水 中重复的请假/休假记录。
 * 匹配项目编号为 OFF-WORK / OFF / 休假 / leave 等，或备注含"系统同步请假"/"on leave"的记录。
 * 按 姓名+日期 分组，每组只保留一条（优先保留工时最大的），其余做软删除（O列=TRUE）。
 * 返回清理统计字符串。
 *
 * V4.3.51 增强：兼容两种列序，否则「V4.3.44- 时期写歪的历史脏行」永远抓不到。
 *   修好后 (V4.3.50+)：D=类型 E=阶段 F=项目编号='OFF-WORK' G=工时 H=备注  I=UUID
 *   历史脏行 (V4.3.44-)：D=类型 E=阶段 F=工时        G=备注   H=UUID
 *   判定改为「D列类型 OR F列项目编号 OR G/H列含同步标记」三者取或；
 *   工时改为「先取 G 列，取不到再回退 F 列」—— 两种列序都能拿到正确小时数。
 *
 * V4.3.52 增强：日期 fallback —— 旧行 B 列为空时，尝试从 备注/G列 提取 LEAVE-...-YYYY-MM-DD
 *   仍然拿不到日期 → 强分组 key  = name|__NODATE__，让历史脏行也能被合并
 */
function cleanupDuplicateLeavesInternal() {
  const LEAVE_PATTERN = /^(OFF[-_]?WORK|OFF|休假|LEAVE|ANNUAL\s*LEAVE|SICK\s*LEAVE|PERSONAL\s*LEAVE|请假|调休|年假|病假|事假|婚假|产假|陪产假|丧假)$/i;
  const LEAVE_DATE_RE = /LEAVE-[a-z0-9]{1,40}-(\d{4}-\d{2}-\d{2})/i;
  const sheet = getDbSheet();
  const data = sheet.getDataRange().getValues();
  const seen = {}; // key: name|date -> { rowIndex(0-based), hours }
  let kept = 0, removed = 0, skipped = 0;

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    for (let i = 1; i < data.length; i++) {
      const dv = data[i][14];
      if (dv === true || String(dv).toUpperCase() === "TRUE") continue;

      // V4.3.51：兼容两种列序，否则历史脏行永远抓不到
      //   修好后 (V4.3.50+)：D=类型(3)  E=阶段(4)  F=项目编号(5)='OFF-WORK'  G=工时(6)  H=备注(7)
      //   历史脏行 (V4.3.44-)：D=类型(3)  E=阶段(4)  F=工时(5)  G=备注(6)  H=UUID(7)
      const project = String(data[i][5] || "").trim();
      const typeVal = String(data[i][3] || "").trim();
      const notes = (String(data[i][7] || "") + " " + String(data[i][6] || "")).trim().toLowerCase();
      const isLeave = LEAVE_PATTERN.test(project)        // 正常行：项目编号=OFF-WORK
                   || LEAVE_PATTERN.test(typeVal)        // 两种列序都成立：D 列一律是「休假」
                   || notes.includes("系统同步请假")
                   || notes.includes("on leave");
      if (!isLeave) continue;

      const name = String(data[i][2] || "").trim();
      if (!name) { skipped++; continue; }

      // V4.3.52: 日期三路 fallback（B 解析 → 备注正则 → 无日期归 __NODATE__）
      const dateVal = data[i][1];
      let dateStr = '';
      if (dateVal) {
        const dateObj = (dateVal instanceof Date) ? dateVal : new Date(dateVal);
        if (!isNaN(dateObj.getTime())) {
          dateStr = Utilities.formatDate(dateObj, "GMT+8", "yyyy-MM-dd");
        }
      }
      if (!dateStr) {
        const m = (String(data[i][6] || '') + ' ' + String(data[i][7] || '') + ' ' + String(data[i][8] || '')).match(LEAVE_DATE_RE);
        if (m) dateStr = m[1];
      }
      if (!dateStr) dateStr = '__NODATE__';

      const hours = parseFloat(data[i][6]) || parseFloat(data[i][5]) || 0;
      const key = name + "|" + dateStr;

      if (!seen[key]) {
        seen[key] = { row: i, hours: hours };
        kept++;
      } else {
        // 保留工时更大的一条；相同时保留先出现的那条
        if (hours > seen[key].hours) {
          sheet.getRange(seen[key].row + 1, 15).setValue(true);
          removed++;
          seen[key] = { row: i, hours: hours };
        } else {
          sheet.getRange(i + 1, 15).setValue(true);
          removed++;
        }
      }
    }
  } finally {
    lock.releaseLock();
  }

  return "请假去重完成：保留 " + kept + " 条，软删除重复 " + removed + " 条（V4.3.52 兼容空 B 列，" + skipped + " 条无姓名跳过）";
}

// 供你测试手动触发
function testCleanup() { cleanupExpiredTokens(); }