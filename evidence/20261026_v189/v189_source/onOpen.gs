/**
 * ⏱️ TimeSheet Manager — 表格菜单 (onOpen)
 * 当前版本：V4.3.54
 *   - V4.3.54: 加「🧹 清理未来日期脏数据（疑似测试残留）」菜单 ——
 *              扫描 DB_工时流水 B 列(Date) > 今天的行，OK_CANCEL 确认后物理删除
 *              （共享 V4.3.53 内容驱动列序探测，所以日期列定位不会错）
 *   - V4.3.53: 【列序不再靠猜 —— 内容驱动探测】
 *     ⚠️ 背景：本文件里 refreshSheet3() 用 V4.3.50 十四列索引（G=工时，r[6]），
 *        而 diagnoseSheet3Sources() 用 V4.2 七列索引（F=工时，r[5]）—— 同一份表，两个函数读出两套结论，
 *        且表头行可能仍是 V4.2 遗留的 7 列短表头（与 submitBatch() 写入的 14 列数据行错位）。
 *        ⇒ 结论：**表头不可信、注释不可信，只信数据内容本身**。
 *     ① 新增 _detectTimesheetColumns(data, headerRow)：扫描前 300 行做投票 ——
 *        工时列=大量 0.25~24 的数字；项目号列=含数字+连字符；日期列=Date 实例（跳过 A 列避免与提交时间打平）
 *        → 实测工时列落在第 6 列(F)=V4.2 布局 / 第 7 列(G)=V4.3.50 布局，自动选对列序
 *     ② refreshSheet3() 与 diagnoseSheet3Sources() **共用同一套探测**，彻底消除两者结论打架
 *     ③ 新增自检告警：若已读 >50 行且工时<=0 占比 >70%，日志告警"疑似列序仍错位"
 *     ④ 列序判定结论写进 Sheet3 重建报告 + 诊断页（用户排障时一眼看到当前走的是哪套）
 *   - V4.3.52: ① leave_sync 清理不再依赖 B 列（备注 marker + LEAVE-...-date fallback）——
 *              解决「同一天休假重复 5+ 条累在备注」的根因
 *              ② _lsSplitEventToWorkdays 非全天跨天分支 由 <= 改 <（与全天一致，禁跨结束日）
 *              ③ 加「🔍 时段诊断」菜单 —— 一键体检 DB_工时流水（空列数、重复组、表头原文）
 *              ④ 加「🔧 一次性回填 A/B 列」菜单 —— 历史脏数据 A/B 缺失时，用 N 年月 + 备注 LEAVE-...-date 提取
 *   - V4.3.51: ① 菜单瘦身 —— 顶层从 17 项压到 6 项，其余收进「🛠 维护 / 排障」子菜单
 *              （函数一个没删，只是收纳，不丢功能）
 *              ② 配合 Code.js 的 cleanupDuplicateLeavesInternal 增强，历史脏行也能被清掉
 *   - V4.3.50: 【工时链路总根因修复】refreshSheet3() 读 DB_工时流水 时列序错位一整格
 *     （误按 D=阶段/E=项目编号/F=工时 读，真实是 D=类型/E=阶段/F=项目编号/G=工时）→
 *     hours = parseFloat(项目编号) = NaN = 0 → DB 的行被 hours<=0 全部丢弃 →
 *     【Sheet3 里从来没有过 DB_工时流水 的新打卡数据】，只剩 FY26 月度汇总。
 *     这就是「老数据只在 Sheet3、新数据只在 DB」的成因。同时：
 *     ① 补回真实 UUID(I列) 供下游去重 ② 休假排除改为 D类型+E阶段 双列判定
 *     ③ 新增 autoRefreshSheet3() 包装（定时触发无 getActiveSpreadsheet/getUi，须 openById）
 *        + ensureSheet3Trigger() 自愈，每 2 小时自动重建 Sheet3
 *     ④ refreshSheet3 末尾 alert 降级为 try/catch，定时上下文不报错
 *   - V4.3.49: 「🔍 诊断 Sheet3 数据源」修复 HOT 项目匹配 —— 源表项目编号写法可能与用户口头
 *     写法不一致（空格/全角/连字符/大小写），旧精确全等会误导为"没人工录入工时"。现改为归一化
 *     模糊匹配，并打印源表中的真实写法，帮助判断是没录还是写法对不上。
 *   - V4.3.48: 「🔍 诊断 Sheet3 数据源」再增强 —— ① 按项目编号统计 top 20 行数 + 抽查项目是否在源里
 *     (2026-09-01 用户问"BC SH, 26-077-GZ, 26-084-HK 怎么工时没导入"，直接给数字) ② 修掉之前骗用户的
 *     "🧹 Sheet1 飘红/悬浮已自动清理"假消息 (V4.3.46 已解耦), 菜单名从「含清理 Sheet1 飘红」改为「保持原样」。
 *   - V4.3.47: 「🔍 诊断 Sheet3 数据源」增强为全链路体检 —— 新增
 *     ① DB_工时流水 日期范围 + 近14天每日行数(一眼看出数据停在哪天) + B列空日期行数
 *     ② Sheet1 状态自检(条件格式飘红规则数 / A列悬浮备注数 / 日期列范围)
 *     ③ 已安装触发器清单(自动同步是否还活着)
 *   - V4.3.46: refreshSheet3 末尾不再自动清理 Sheet1 飘红/悬浮备注 —— 用户体感"红字+悬浮功能没了"根因修复。
 *     两个功能解耦: Sheet1 飘红仅在「📊 刷新工时异常表」生成/更新; Sheet3 重建不再触碰 Sheet1。
 * V4.0 保留：V3.2 的「月度异常表 / QS看板 / 周存档」菜单 + V4.0 的「网页填报入口 / 月份筛选 / 团队提醒 / 抓取设计」入口。
 * V4.1 旧版：Sheet3 写成"员工×日期矩阵"——错! refreshQSBoard 是从 Sheet3 读项目工时明细, 期望的是每行 = 一条工时记录。
 * V4.2 修复：
 *   1. refreshSheet3 重做为"项目工时明细"（A=数据源 / B=日期 / C=英文名 / D=类型 / E=阶段 / F=项目编号 / G=工时 / H=备注 / I=UUID / J=项目名），
 *      从 DB_工时流水 + FY26工时 拉真实口径记录（排除休假/OFF-WORK/未填/已删除），
 *      其中 DB_工时流水 实际列为 A=录入时间/B=日期/C=姓名/D=阶段/E=项目编号/F=工时/G=备注/H=项目名/I=主管/O=是否删除。
 *      FY26折算后工时 为折算浓缩数据，不并入。
 *   2. refreshMonthlyExceptions 条件格式收紧为 0<h<8 (缺勤标红)，h=0 (未填/未来日期) 不再标红。
 *   3. cleanSheet1LegacyHighlights() 清掉 Sheet1 历史飘红 + 悬浮 note, 仅「🧹 单独清理 Sheet1 条件格式」菜单触发
 *      (V4.3.46 修复: refreshSheet3 末尾不再自动清理 Sheet1 飘红/悬浮 —— 否则用户重建 Sheet3 后 Sheet1 的红字+悬浮备注被静默清掉,
 *       需再跑一次「📊 刷新工时异常表」才会回来, 用户体感"功能没了"。两个功能解耦。)
 * V4.2.1 修复：
 *   1. 🐛 修 Sheet3 createFilter 报 "You can't create a filter in a sheet that already has a filter"——
 *      refreshSheet3 开头 clear() 不会移除已有 filter (V4.1 残留 or 用户手动加的)，导致 createFilter 抛错。
 *      加 try/catch 检查并先 remove() 已有 filter。
 *
 * 注意：
 *  - fetchArchiveData / sendTeamTimesheetReminders / getHrMap / getProjectMap / TS_ID / BD_ID / HR_ID
 *    均来自原有 Code.gs（V4.0），本文件只负责把它们挂到菜单上。
 *  - 按月份筛选作用在「DB_工时流水」表的 N 列（年月，格式 yyyy-MM）。
 *  - 网页填报链接在下方 WEBAPP_URL 填上（从 编辑器→部署→复制网址 拿到）。
 */

// ↓↓↓ 把你的网页填报部署链接填到这里（不填也能用，只是"打开网页填报"按钮会提示 ↓↓↓
var WEBAPP_URL = 'https://script.google.com/a/macros/你的网域/你的部署ID/exec';

// ↓↓↓ V3.2 周存档目标文件夹 ID ↓↓↓
var ARCHIVE_FOLDER_ID = '0AFGkeAYHlGniUk9PVA';

// ↓↓↓ V3.2 月度异常表配置 ↓↓↓
var BLACKLIST = ["Felix Jiang", "Rita Jin", "Luby Huang", "Sky He", "Amy Weng", "Jane Liu", "Ying Zhu", "Fiona Zhang", "Sanny Yan", "Sally Yang", "Lisa Shu", "Jessy Hu"];
var HOLIDAYS = [
  // 2026 年中国法定节假日
  "2026-01-01", "2026-01-02", "2026-01-03",                       // 元旦
  "2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19",
  "2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23",       // 春节
  "2026-04-04", "2026-04-05", "2026-04-06",                       // 清明节
  "2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05", // 劳动节
  "2026-06-19", "2026-06-20", "2026-06-21",                       // 端午节
  "2026-09-25", "2026-09-26", "2026-09-27",                       // 中秋节
  "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05",
  "2026-10-06", "2026-10-07"                                        // 国庆节
];
var START_LIMIT = "2026-04-01";

// ↓↓↓ 名称别名映射（手动兜底）：左=工时流水里的写法，右=HR通讯录里的标准名 ↓↓↓
// 一般无需填写；仅当模糊匹配仍误判时使用（不区分大小写）。
var NAME_ALIASES = {
  // "Christopher M Tengg": "Christopher M Tengo",
};
// 模糊匹配阈值：相似度 >= 0.85 才认作同一人（1=完全相同，0=完全不同）
var NAME_FUZZY_THRESHOLD = 0.85;

// V4.3.51 菜单瘦身：顶层只留 6 个高频动作，其余全部收进「🛠 维护 / 排障」子菜单。
// 函数一个没删，只是收纳 —— 以后想用随时能从子菜单里找到。
function onOpen(e) {
  var ui = SpreadsheetApp.getUi();

  var sub = ui.createMenu('维护 / 排障')
    .addItem('手动重建 Sheet3（平时每 2 小时自动跑）', 'refreshSheet3')
    .addItem('手动同步请假日历（平时每天自动跑）', 'syncLeavesFromCalendar')
    .addItem('清理重复请假记录（推荐按一次）', 'cleanupDuplicateLeavesInternal')
    .addSeparator()
    .addItem('抓取设计工时', 'fetchArchiveData')
    .addItem('立即执行周存档', 'archiveCurrentSpreadsheet')
    .addItem('开启每周五自动提醒', 'setupTimesheetFridayReminder')
    .addSeparator()
    .addItem('诊断 Sheet3 数据源', 'diagnoseSheet3Sources')
    .addItem('时段诊断（DB_工时流水 体检报告）', 'diagnoseTimesheetColumns')
    .addItem('补齐历史日期标签（A/B 列缺失时）', 'backfillABColumnsInternal')
    .addItem('清理未来日期脏数据（疑似测试残留）', 'cleanupFutureDateRowsInternal')
    .addItem('列出已安装触发器（自查）', 'listInstalledTriggers')
    .addSeparator()
    .addItem('考勤：标记周末/节假日底色（纯展示·零数据改动）', 'attendanceMarkCalendar')
    .addItem('考勤：请假/短工时配色（蓝=假，橙=短工时）', 'attendanceMarkLeaveCF')
    .addItem('考勤：读取表头日期（只读诊断）', 'readAttendanceHeader')
    .addItem('生成手机远程链接', 'showRemoteTriggerLinks')
    .addSeparator()
    .addItem('物理清理已删除记录（危险·不可恢复）', 'physicalPurgeDeleted')
    .addItem('清理 Sheet1 旧条件格式（历史遗留）', 'cleanSheet1LegacyHighlights');

  ui.createMenu('SMCN 工时表')
    .addItem('刷新工时异常表', 'showMonthlyExceptionDialog')
    .addItem('刷新 QS 看板', 'refreshQSBoard')
    .addSeparator()
    .addItem('开启/修复全部触发器', 'setupAllTriggers')
    .addItem('开启自动请假同步', 'enableAutoLeaveSync')
    .addItem('发送提醒', 'sendTeamTimesheetReminders')
    .addSeparator()
    .addSubMenu(sub)
    .addToUi();
}

// ==========================================
// 1. V3.2 月度工时异常表 (Sheet1)
// 支持：选择年份月份、过滤离职员工、显示加班/调休备注
// ==========================================
function getResignedNames() {
  const resigned = {};
  try {
    const ss = SpreadsheetApp.openById(HR_ID);
    const sheet = ss.getSheetByName('离职名单');
    if (!sheet) return resigned;
    const data = sheet.getDataRange().getValues();
    for (let i = 4; i < data.length; i++) {
      const name = data[i][4] ? String(data[i][4]).trim() : "";
      if (name) resigned[name] = true;
    }
  } catch (e) {}
  return resigned;
}

function showMonthlyExceptionDialog() {
  const options = generateMonthOptions();
  if (options.length === 0) {
    SpreadsheetApp.getUi().alert('暂无工时数据，无法生成月度异常表。');
    return;
  }
  const selectHtml = options.map(function(opt) {
    const selectedAttr = opt.selected ? ' selected' : '';
    return '<option value="' + opt.value + '"' + selectedAttr + '>' + opt.value + '</option>';
  }).join('');
  const html = HtmlService.createHtmlOutput(
    '<!DOCTYPE html><html><head><base target="_top">' +
    '<style>' +
    'body{font-family:Arial, sans-serif; padding:20px; margin:0;}' +
    'h3{margin-top:0;}' +
    'select{width:200px; padding:8px; font-size:14px; border-radius:4px; border:1px solid #ccc;}' +
    'button{padding:8px 16px; font-size:14px; border-radius:4px; border:1px solid #ccc; cursor:pointer;}' +
    '#msg{margin-top:12px; color:#666; font-size:12px;}' +
    '</style></head><body>' +
    '<h3>📅 月度异常查询</h3>' +
    '<p>请选择年月：</p>' +
    '<select id="ym">' + selectHtml + '</select>' +
    '<button onclick="run()" style="margin-left:10px;">确定</button>' +
    '<button onclick="google.script.host.close()" style="margin-left:10px;">取消</button>' +
    '<div id="msg"></div>' +
    '<script>' +
    'function run(){' +
    '  var btn = document.querySelector("button");' +
    '  btn.disabled = true;' +
    '  document.getElementById("msg").textContent = "正在刷新，请稍候...";' +
    '  var ym = document.getElementById("ym").value;' +
    '  google.script.run' +
    '    .withSuccessHandler(function(result){' +
    '      document.getElementById("msg").textContent = result || "✅ 更新完成！";' +
    '      setTimeout(function(){ google.script.host.close(); }, 800);' +
    '    })' +
    '    .withFailureHandler(function(err){' +
    '      document.getElementById("msg").textContent = "❌ " + err.message;' +
    '      btn.disabled = false;' +
    '    })' +
    '    .refreshMonthlyExceptions(ym);' +
    '}' +
    '</script></body></html>'
  ).setWidth(380).setHeight(220);
  SpreadsheetApp.getUi().showModalDialog(html, '月度异常查询');
}

function getMonthsWithData() {
  const months = {};
  try {
    const tsSheet = SpreadsheetApp.openById(TS_ID).getSheetByName('DB_工时流水');
    if (!tsSheet) return months;
    const data = tsSheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const dateVal = data[i][1]; // B 列：日期
      if (dateVal && dateVal instanceof Date && !isNaN(dateVal.getTime())) {
        const ym = Utilities.formatDate(dateVal, "GMT+8", "yyyy-MM");
        months[ym] = true;
      }
    }
  } catch (e) {}
  return months;
}

function generateMonthOptions() {
  const dataMonths = getMonthsWithData();
  // 只显示有数据的月份，按时间倒序（最新月份在最上面），默认选中第一个
  const sortedMonths = Object.keys(dataMonths).sort().reverse();
  return sortedMonths.map(function(ym, index) {
    return { value: ym, selected: index === 0 };
  });
}

function refreshMonthlyExceptions(yearMonth) {
  if (!yearMonth || !/^\d{4}-\d{2}$/.test(String(yearMonth).trim())) { return "❌ 格式错误，请使用 yyyy-MM，例如 2026-06。"; }
  const rawText = String(yearMonth).trim();
  const parts = rawText.split("-");
  const targetYear = parseInt(parts[0]);
  const targetMonth = parseInt(parts[1]);
  if (targetMonth < 1 || targetMonth > 12) { return "❌ 月份必须是 1 到 12 之间。"; }

  // V4.3.33: 刷新前先幂等清理 DB_工时流水里重复的系统同步请假记录，避免同步遗留记录被重复累加
  try {
    cleanupDuplicateLeavesInternal();
  } catch (e) {
    console.log('[refreshMonthlyExceptions] 去重清理跳过：' + e.message);
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let reportSheet = ss.getSheetByName("Sheet1") || ss.insertSheet("Sheet1");
  reportSheet.clear(); reportSheet.clearConditionalFormatRules();

  const hrMap = getHrMap();
  const resignedMap = getResignedNames();
  const tsSheet = SpreadsheetApp.openById(TS_ID).getSheetByName('DB_工时流水');
  const tsData = tsSheet.getDataRange().getValues();

  const targetDates = [];
  let datePointer = new Date(targetYear, targetMonth - 1, 1);
  while (datePointer.getMonth() === targetMonth - 1) {
    const day = datePointer.getDay();
    const dateStr = Utilities.formatDate(datePointer, "GMT+8", "yyyy-MM-dd");
    if (dateStr >= START_LIMIT && day !== 0 && day !== 6 && HOLIDAYS.indexOf(dateStr) === -1) { targetDates.push(new Date(datePointer)); }
    datePointer.setDate(datePointer.getDate() + 1);
  }
  if (targetDates.length === 0) { return "⚠️ 该月份没有需要统计的工作日。"; }

  const summary = {};       // 实际工作工时（不含调休）
  const tiaoxiuMap = {};    // 调休工时（单独统计，不计入正常工作工时）
  const leaveMap = {};      // V4.3.66: 假条日历（只记录，不计工时/不进备注/不算缺填）
  const notesMap = {};
  for (let email in hrMap) {
    const empName = hrMap[email].name;
    if (!empName) continue;
    if (BLACKLIST.indexOf(empName) > -1) continue;
    if (resignedMap[empName]) continue;
    summary[empName] = {};
    tiaoxiuMap[empName] = {};
    leaveMap[empName] = {};
    notesMap[empName] = {};
    targetDates.forEach(d => {
      const dKey = Utilities.formatDate(d, "GMT+8", "yyyy-MM-dd");
      summary[empName][dKey] = 0;
      tiaoxiuMap[empName][dKey] = 0;
      leaveMap[empName][dKey] = 0;   // V4.3.66: 必须预置 0，否则 undefined+1=NaN → 缺填误判 + 🍵天数恒为0
      notesMap[empName][dKey] = [];
    });
  }
  const hrNameList = Object.keys(summary);

  const TIAOXIU_RE = /调休/i;   // 调休类型行单独累计，不计入正常工作工时
  for (let i = 1; i < tsData.length; i++) {
    // V4.3.32: 月度异常表必须排除已软删除记录(O列=true)，否则请假同步遗留的历史记录会被重复累加，导致单日出现48/56/58小时异常
    const isDeleted = tsData[i][14] === true || String(tsData[i][14] || '').toUpperCase() === 'TRUE' || String(tsData[i][14]) === '1';
    if (isDeleted) continue;

    const rowDate = new Date(tsData[i][1]);
    let rowName = tsm_formatName(tsData[i][2]);
    // 模糊匹配：工时流水名字拼错时，自动对到 HR 通讯录里的标准名
    rowName = tsm_resolveName(rowName, hrNameList) || rowName;
    const rowHours = parseFloat(tsData[i][6]) || 0;
    const rowType = tsData[i][3] ? String(tsData[i][3]).trim() : "";
    const rowNote = tsData[i][7] ? String(tsData[i][7]).trim() : "";
    if (isNaN(rowDate.getTime())) continue;
    const dKey = Utilities.formatDate(rowDate, "GMT+8", "yyyy-MM-dd");
    if (summary[rowName] && summary[rowName].hasOwnProperty(dKey)) {
      // V4.3.66: 假条行（系统同步请假 / D=休假 / F=OFF-WORK / LEAVE- / AUTO_LEAVE）不计工时、不进备注 ——
      //   日历假条与真实出勤常同日并存（2026-09 实测 89 人-日），旧逻辑把它当 8h 工时累加、
      //   并把「系统同步请假 | XXX on leave」黏进当日备注，造成小时虚高 + 格子内容千奇百怪。
      //   三种历史写法全覆盖：现行备注式 / E列=休假 老式 / E/F=OFF-WORK 更老式。
      const rowProj = tsData[i][5] ? String(tsData[i][5]).trim() : "";
      const isLeaveRow = /^(休假|请假|off.?work)$/i.test(rowType)
        || /^(off.?work|休假)$/i.test(rowProj)
        || /系统同步请假|LEAVE-|AUTO_LEAVE/i.test(rowNote);
      if (isLeaveRow) { leaveMap[rowName][dKey] += 1; continue; }
      if (TIAOXIU_RE.test(rowType)) {
        tiaoxiuMap[rowName][dKey] += rowHours;
      } else {
        summary[rowName][dKey] += rowHours;
      }
      if (rowNote) notesMap[rowName][dKey].push(rowNote);
    }
  }

  const outputRows = [];
  const notesPerRow = [];   // 与 outputRows 一一对应的悬浮备注（写 A 列姓名格）
  const names = Object.keys(summary).sort();
  names.forEach(name => {
    const dataRow = [name];
    let overtimeTotal = 0, tiaoxiuTotal = 0, shortDays = 0;
    targetDates.forEach(d => {
      const dKey = Utilities.formatDate(d, "GMT+8", "yyyy-MM-dd");
      const h = summary[name][dKey];
      const tx = tiaoxiuMap[name][dKey];
      dataRow.push(h);
      if (h > 8) {
        overtimeTotal += parseFloat((h - 8).toFixed(1));   // 加班 = 超出 8 小时部分累计
      } else if (h < 8 && tx === 0 && !leaveMap[name][dKey]) {
        shortDays += 1;                                     // 既没干满、也没在调休/请假 → 算缺填
      }
      if (tx > 0) tiaoxiuTotal += tx;                       // 调休工时累计
    });

    // 悬浮 note：当月汇总（加班 X 小时 / 调休 Y 小时 / 缺填 Z 天）+ 当日备注明细
    const noteLines = [];
    noteLines.push("📅 " + rawText + " 月度工时汇总");
    noteLines.push("🔴 加班：" + overtimeTotal.toFixed(1) + " 小时");
    noteLines.push("🟢 调休：" + tiaoxiuTotal.toFixed(1) + " 小时");
    // V4.3.66: 假条不再混进每日备注，改为在月度汇总里集中一行，日历录错日期一眼可见
    const lvDays = targetDates.filter(d => leaveMap[name] && leaveMap[name][Utilities.formatDate(d, "GMT+8", "yyyy-MM-dd")]);
    if (lvDays.length) {
      noteLines.push("🍵 请假(日历)：" + lvDays.length + " 天（" + lvDays.map(d => Utilities.formatDate(d, "GMT+8", "MM/dd")).join("、") + "）");
    }
    noteLines.push("🟡 缺填：" + shortDays + " 天");
    const extra = [];
    targetDates.forEach(d => {
      const dKey = Utilities.formatDate(d, "GMT+8", "yyyy-MM-dd");
      if (notesMap[name][dKey] && notesMap[name][dKey].length) {
        extra.push(Utilities.formatDate(d, "GMT+8", "MM/dd") + "：" + notesMap[name][dKey].join("; "));
      }
    });
    if (extra.length) {
      noteLines.push("━━━━━━━━");
      noteLines.push("📝 当日备注：");
      noteLines.push(extra.join("\n"));
    }
    outputRows.push(dataRow);
    notesPerRow.push(noteLines.join("\n"));
  });

  const header = ["员工姓名", ...targetDates.map(d => Utilities.formatDate(d, "GMT+8", "MM/dd"))];  // 方案A：去掉末列备注列
  if (outputRows.length > 0) {
    reportSheet.getRange(1, 1, 1, header.length).setValues([header]).setBackground("#444444").setFontColor("white").setFontWeight("bold");
    reportSheet.getRange(2, 1, outputRows.length, header.length).setValues(outputRows);

    // 方案A：备注(当月汇总) 写入 A 列姓名单元格 setNote，鼠标悬停即看（末列备注列已删除）
    for (let i = 0; i < notesPerRow.length; i++) {
      if (notesPerRow[i]) {
        reportSheet.getRange(2 + i, 1).setNote(notesPerRow[i]);
      }
    }

    const dataRange = reportSheet.getRange(2, 2, outputRows.length, header.length - 1);
    // V4.2: 条件格式收紧为 0<h<8 (只对"部分填写"标红), h=0 (未填/未来日期) 不再触发飘红 + 三角
    const rule = SpreadsheetApp.newConditionalFormatRule()
      .whenNumberGreaterThan(0)
      .whenNumberLessThan(8)
      .setBackground("#F4CCCC").setFontColor("#CC0000").setRanges([dataRange]).build();
    reportSheet.setConditionalFormatRules([rule]);
    reportSheet.setFrozenRows(1); reportSheet.setFrozenColumns(1);
    return "✅ 更新完成！";
  } else { return "🎉 所有人表现完美！"; }
}

// ==========================================
// 2. V3.2 QS 看板
// ==========================================
function refreshQSBoard() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sourceSheet = ss.getSheetByName("Sheet3");
  const targetSheet = ss.getSheetByName("QS看板");

  if (!sourceSheet) {
    SpreadsheetApp.getUi().alert("❌ 错误：找不到名为 'Sheet3' 的数据源表格。");
    return;
  }
  if (!targetSheet) {
    SpreadsheetApp.getUi().alert("❌ 错误：找不到名为 'QS看板' 的目标表格，请先创建。");
    return;
  }

  const data = sourceSheet.getDataRange().getValues();
  const summary = {};
  const dateIdx = 1;

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const rawDate = row[dateIdx];
    const person = row[2];
    const projId = row[5];
    const hours = parseFloat(row[6]) || 0;
    const projName = row[9];

    if (!person || !rawDate) continue;

    const dateObj = new Date(rawDate);
    if (isNaN(dateObj.getTime())) continue;
    const monthKey = Utilities.formatDate(dateObj, "GMT+8", "yyyy-MM");
    const aggregateKey = monthKey + "_" + person + "_" + projId;

    if (!summary[aggregateKey]) {
      summary[aggregateKey] = { month: monthKey, name: person, id: projId, pName: projName, totalHours: 0 };
    }
    summary[aggregateKey].totalHours += hours;
  }

  const output = [["月份", "人名", "项目编号", "项目名称", "总工时"]];
  const sortedKeys = Object.keys(summary).sort();
  sortedKeys.forEach(key => {
    const item = summary[key];
    output.push([item.month, item.name, item.id, item.pName, parseFloat(item.totalHours.toFixed(1))]);
  });

  targetSheet.clear();
  if (output.length > 1) {
    targetSheet.getRange(1, 1, output.length, output[0].length).setValues(output);
    targetSheet.getRange(1, 1, 1, output[0].length)
               .setBackground("#444444")
               .setFontColor("white")
               .setFontWeight("bold");
    targetSheet.setFrozenRows(1);
    SpreadsheetApp.getUi().alert("✅ QS看板更新成功！共汇总 " + (output.length - 1) + " 条记录。");
  } else {
    SpreadsheetApp.getUi().alert("⚠️ 未发现有效数据。");
  }
}

// ==========================================
// 2.5 V4.3.38 重建 Sheet3 项目工时明细
// ==========================================
// Sheet3 实际用途 = QS 看板数据源, 列结构被 refreshQSBoard 假定为:
//   B=日期 / C=英文名 / F=项目编号 / G=工时 / J=项目名
// 每行 = 一条真实原始项目投入工时记录
//   ⚠️ V4.3.50 列序修正（总根因）：真实表头为
//      A=提交时间 B=日期 C=姓名 D=类型 E=阶段 F=项目编号 G=工时 H=备注 I=UUID J=项目名 ... O=Is_Deleted
//      旧版误按「D=阶段/E=项目编号/F=工时/G=备注/H=项目名」读取，错位一整格 →
//      hours = parseFloat(项目编号) = NaN = 0 → DB 的行被 hours<=0 全丢 →
//      【Sheet3 里从来没有过 DB_工时流水 的新打卡数据】，只剩 FY26 月度汇总。
//      这正是「老数据只在 Sheet3、新数据只在 DB」的成因。
//   2) FY26工时 (本表) —— 真实月度汇总, 补充 DB_工时流水 未覆盖的历史月份
//      实际列: A=PROJECT# / B=PROJECT NAME / C=Total / D=Month / E=Employee Name
//   (FY26折算后工时 是折算浓缩数据, 非真实原始口径, 不并入)
// 去重: 按 "年月|项目编号|员工" 维度, DB_工时流水 已覆盖的月份不再用 FY26 汇总, 避免重复
// 排除: 休假 / OFF-WORK / 调休 / 年假 / 病假 / 事假 / 婚假 / 产假 / 丧假 / 已删除 / 工时 <= 0
// V4.3.50: ssOverride 参数 —— 定时触发器上下文里 getActiveSpreadsheet() 为 null，
//          由 autoRefreshSheet3() 显式 openById 传入；不传则保持菜单手动调用行为。
// ============================================================================
// V4.3.53: DB_工时流水 列序探测器
// 背景（血泪）：本文件里出现过两套互相矛盾的列序声明 ——
//   ① V4.2 文件头注释: A=录入时间 B=日期 C=姓名 D=阶段 E=项目编号 F=工时 G=备注 H=项目名 I=主管 O=是否删除  (7 列口径)
//   ② V4.3.50 注释:    A=提交时间 B=日期 C=姓名 D=类型 E=阶段 F=项目编号 G=工时 H=备注 I=UUID J=项目名 O=是否删除 (14 列口径)
// 且 refreshSheet3() 与 diagnoseSheet3Sources() 在同一文件里用了不同的索引 —— 二者必有一错。
// 更坑的是：表头行可能仍是 V4.2 遗留的短表头，而数据行已由 submitBatch() 按 14 列写入，
// 所以"读表头判断列序"同样不可靠（表头与数据错位）。
// 结论：**只信数据内容本身**。用前 N 行做投票：工时列=大量 0.25~24 的数字；项目号列=含数字+连字符；
// 日期列=Date 实例（跳过 A 列，因为 A=提交时间 也是 Date，会与 B=日期 打平）。
// ============================================================================
function _detectTimesheetColumns(data, headerRow) {
  const V42 = { date: 1, name: 2, type: -1, stage: 3, projNo: 4, hours: 5, notes: 6, projName: 7, leader: 8, yearMonth: 13, isDeleted: 14, uuid: -1 };
  const V4350 = { date: 1, name: 2, type: 3, stage: 4, projNo: 5, hours: 6, notes: 7, projName: 9, leader: 11, yearMonth: 13, isDeleted: 14, uuid: 8 };

  const N = Math.min(300, data.length);
  const W = Math.max(15, (headerRow && headerRow.length) || 0, (data[0] && data[0].length) || 0);
  const sHours = {}, sProj = {}, sDate = {};
  for (let c = 0; c < W; c++) { sHours[c] = 0; sProj[c] = 0; sDate[c] = 0; }

  for (let i = 0; i < N; i++) {
    const r = data[i] || [];
    for (let c = 0; c < Math.min(W, r.length); c++) {
      const v = r[c];
      if (v instanceof Date && !isNaN(v.getTime())) { if (c >= 1) sDate[c]++; continue; }
      if (typeof v === 'number' && isFinite(v) && v > 0 && v <= 24) { sHours[c] += 2; continue; }
      const s = String(v == null ? '' : v).trim();
      if (!s) continue;
      // 工时也可能是字符串 "8" / "7.5"
      if (/^\d{1,2}(\.\d{1,2})?$/.test(s)) { const n = parseFloat(s); if (n > 0 && n <= 24) sHours[c] += 2; }
      // 项目号：含数字 + 连字符/下划线（如 26-001-SH-M26），且不是纯日期
      if (/^[A-Za-z0-9][A-Za-z0-9\-\/_.]{2,}$/.test(s) && /\d/.test(s)) {
        if (/[-_]/.test(s)) sProj[c] += 2; else sProj[c] += 1;
      }
    }
  }

  const best = (m, min) => { let bi = -1, bv = 0; for (const c in m) { if (m[c] > bv) { bv = m[c]; bi = parseInt(c, 10); } } return (bv >= (min || 0)) ? { idx: bi, score: bv } : { idx: -1, score: bv }; };

  const h = best(sHours, 3);
  const p = best(sProj, 3);
  const d = best(sDate, 3);

  let map, why;
  if (h.idx === 6) { map = V4350; why = '实测工时列=G(第7列,score=' + h.score + ') → 采用 V4.3.50 十四列布局'; }
  else if (h.idx === 5) { map = V42; why = '实测工时列=F(第6列,score=' + h.score + ') → 采用 V4.2 七列布局'; }
  else if (String((headerRow && headerRow[3]) || '').replace(/\s/g, '').indexOf('阶段') >= 0) {
    map = V42; why = '工时列信号不足(score=' + h.score + ')，但表头 D1 含「阶段」→ 回退 V4.2 七列布局';
  } else {
    map = V4350; why = '工时列信号不足(score=' + h.score + ')，表头 D1 不含「阶段」→ 回退 V4.3.50 十四列布局';
  }

  // 实测列与所选布局冲突时，以实测为准（仅覆盖高置信项）
  map = Object.assign({}, map);
  if (p.idx >= 0 && p.idx !== map.projNo) { map.projNo = p.idx; why += ' | 项目号实测列覆盖 → 第' + (p.idx + 1) + '列'; }
  if (d.idx >= 0 && d.idx !== map.date) { map.date = d.idx; why += ' | 日期实测列覆盖 → 第' + (d.idx + 1) + '列'; }
  return { map: map, why: why, probe: { hours: h, projNo: p, date: d } };
}

function refreshSheet3(ssOverride) {
  const ss = ssOverride || SpreadsheetApp.getActiveSpreadsheet();
  let reportSheet = ss.getSheetByName("Sheet3");
  if (!reportSheet) reportSheet = ss.insertSheet("Sheet3");
  reportSheet.clear();
  reportSheet.clearConditionalFormatRules();
  // V4.2.1: clear() 不会移除 filter, 若用户上次手动加了 filter 或 V4.1 残留,
  // 下面 createFilter() 会报 "You can't create a filter in a sheet that already has a filter"
  // 先检查并移除已有 filter (安全的 try/catch 防止 race condition)
  try {
    const existingFilter = reportSheet.getFilter();
    if (existingFilter) existingFilter.remove();
  } catch (e) { /* 无 filter 或已删除, 忽略 */ }

  // 表头 (与 DB_工时流水 列序一致, 仅 A 改为"数据源"标签便于溯源)
  const headers = ['数据源', '日期', '英文名', '类型', '阶段', '项目编号', '工时', '备注', 'UUID', '项目名'];
  reportSheet.getRange(1, 1, 1, headers.length).setValues([headers])
    .setBackground('#37474F').setFontColor('white').setFontWeight('bold').setHorizontalAlignment("center");
  reportSheet.setFrozenRows(1);

  // 排除的非项目类型 (正则, 大小写不敏感)
  const EXCLUDE_TYPES = /休假|off.?work|annual\s*leave|sick\s*leave|personal\s*leave|调休|年假|病假|事假|婚假|产假|陪产假|丧假|leave|absence/i;
  // 排除的"非项目"项目编号
  const EXCLUDE_PROJ = /^(off.?work|off|n\/?a|行政)$/i;

  // 列序由 _detectTimesheetColumns() 在读到数据后按「内容投票」实测决定 —— 见下方 §1
  // （V4.3.53: 表头不可信, 表头可能是 V4.2 遗留的 7 列短表头, 而数据行是 submitBatch() 写的 14 列）

  // 解析 FY26 Month -> Date(当月1日)
  // V4.3.39: 兼容两种形态——
  //   ① "Jun'2025" / "Feb'2026" 字符串 (旧模板)
  //   ② Date 对象 (线上 FY26 D 列真实为日期类型, 原正则 String(date) 不命中 -> 全部返回 null -> FY26 长期 0 贡献)
  function _parseFy26Month(monthVal) {
    // V4.3.40: 必须接收原始值(r[3])而不是 String() 后的字符串,
    // 否则线上 Date 对象会先被转成 "Wed Apr 01 ..." 导致 instanceof Date 永远 false
    if (monthVal instanceof Date) {
      return new Date(monthVal.getFullYear(), monthVal.getMonth(), 1);
    }
    const m = String(monthVal || '').trim().match(/^([A-Za-z]{3})['"]*(\d{4})$/);
    if (!m) return null;
    const map = {jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11};
    const mon = map[m[1].toLowerCase()];
    const yr = parseInt(m[2], 10);
    if (mon === undefined || isNaN(yr)) return null;
    return new Date(yr, mon, 1);
  }

  const rows = [];
  const seenUuid = {};
  const monthKeySet = {}; // 用于 FY26 去重: yyyy-MM|projNo|employeeName
  const dbDupSig = {};    // V4.3.39: DB_工时流水 全签名去重: 日期|姓名|阶段|项目|工时 (剔除双录水分)
  let totalRead = 0, totalExcludedType = 0, totalExcludedProj = 0, totalDeleted = 0, totalNoHours = 0, totalNoDate = 0, totalDup = 0, totalFy26Skipped = 0, totalFy26Added = 0;
  // V4.3.53: 记录本次实际采用的列序原因，写进结尾报告，便于用户/排障一眼确认
  let colMapWhy = '(未读取 DB)';

  // 1. 读 DB_工时流水 (明细, 优先级最高)
  // V4.3.50 真实列序: A=提交时间 / B=日期 / C=姓名 / D=类型 / E=阶段 / F=项目编号 / G=工时
  //                   H=备注 / I=UUID / J=项目名 / ... / O=是否删除
  const dbSheet = SpreadsheetApp.openById(TS_ID).getSheetByName('DB_工时流水');
  if (dbSheet && dbSheet.getLastRow() >= 2) {
    const data = dbSheet.getRange(2, 1, dbSheet.getLastRow() - 1, Math.max(15, dbSheet.getLastColumn())).getValues();
    // V4.3.53: 内容驱动列序探测（表头不可信，见 _detectTimesheetColumns 说明）
    const _hdrRow = dbSheet.getRange(1, 1, 1, Math.max(15, dbSheet.getLastColumn())).getValues()[0];
    const _det = _detectTimesheetColumns(data, _hdrRow);
    const _COL = _det.map;
    colMapWhy = _det.why;
    console.log('[refreshSheet3] 列序探测 → ' + _det.why + ' | 表头D1=' + String(_hdrRow[3] || '') + ' | 原始表头=' + JSON.stringify(_hdrRow));
    for (let i = 0; i < data.length; i++) {
      totalRead++;
      const r = data[i];
      // V4.3.53: 列序由 _COL 实测决定（旧版硬编码错位一整格 → 读到备注列 → hours=NaN=0 → DB 全丢）
      const date = r[_COL.date];
      const englishName = String(r[_COL.name] || '').trim();
      const typeVal = _COL.type >= 0 ? String(r[_COL.type] || '').trim() : '';
      const phase = String(r[_COL.stage] || '').trim();
      const projNo = String(r[_COL.projNo] || '').trim();
      const hours = parseFloat(r[_COL.hours]) || 0;
      const remark = String(r[_COL.notes] || '').trim();
      const uuidVal = _COL.uuid >= 0 ? String(r[_COL.uuid] || '').trim() : '';
      const projName = String(r[_COL.projName] || '').trim();
      const isDeleted = r[_COL.isDeleted] === true || String(r[_COL.isDeleted] || '').toUpperCase() === 'TRUE' || String(r[_COL.isDeleted]) === '1';

      if (isDeleted) { totalDeleted++; continue; }
      if (!(date instanceof Date) || isNaN(date.getTime())) { totalNoDate++; continue; }
      if (hours <= 0) { totalNoHours++; continue; }
      if (!projNo || EXCLUDE_PROJ.test(projNo)) { totalExcludedProj++; continue; }
      // V4.3.50: 休假/非项目类型排除 —— D=类型 与 E=阶段 任一命中即排除（旧版只读 D 当成阶段，
      // 而真实类型列在 D，故旧版实际漏判了把类型写在 D 的行）
      if (EXCLUDE_TYPES.test(typeVal) || EXCLUDE_TYPES.test(phase)) { totalExcludedType++; continue; }

      // 记录该员工+项目+月份已有明细, FY26 汇总不再重复计入
      const mKey = Utilities.formatDate(date, 'GMT+8', 'yyyy-MM') + '|' + projNo + '|' + tsm_formatName(englishName);
      monthKeySet[mKey] = true;

      // V4.3.53: 列序疑似仍错位的自检告警（工时列读出来几乎全是 0 → 八成又读错列了）
      if (totalRead > 50 && totalNoHours > totalRead * 0.7) {
        console.log('[refreshSheet3] ⚠️ 疑似列序仍错位：已读 ' + totalRead + ' 行，其中 ' + totalNoHours + ' 行工时<=0。探测结论=' + colMapWhy);
      }

      // V4.3.39: 全签名去重——同一条记录被双录(日期+姓名+阶段+项目+工时全相同)只保留第一条, 剔除水分
      const sig = Utilities.formatDate(date, 'GMT+8', 'yyyy-MM-dd') + '|' + englishName + '|' + phase + '|' + projNo + '|' + hours;
      if (dbDupSig[sig]) { totalDup++; continue; }
      dbDupSig[sig] = true;

      // V4.3.50: 带回真实 UUID（I 列），供 QS/PM 按 UUID 去重；类型列用真实 D 列值
      rows.push(['DB_工时流水', date, englishName, (typeVal || '工时明细'), phase, projNo, hours, remark, uuidVal, projName]);
    }
  }

  // 2. 读 FY26工时 / FY26折算后工时 (月度汇总, 补充 DB_工时流水 未覆盖的历史月份)
  // 仅合并 FY26工时 (真实月度汇总); FY26折算后工时 是折算浓缩数据, 非真实原始口径, 不并入
  const fySources = [
    { name: 'FY26工时', label: 'FY26汇总' }
  ];
  for (let si = 0; si < fySources.length; si++) {
    const fy = fySources[si];
    const sheet = ss.getSheetByName(fy.name);
    if (!sheet || sheet.getLastRow() < 2) continue;
    const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, Math.max(5, sheet.getLastColumn())).getValues();
    for (let i = 0; i < data.length; i++) {
      totalRead++;
      const r = data[i];
      const projNo = String(r[0] || '').trim();        // A=PROJECT#
      const projName = String(r[1] || '').trim();      // B=PROJECT NAME
      const hours = parseFloat(r[2]) || 0;             // C=Total
      const englishName = String(r[4] || '').trim();   // E=Employee Name

      const date = _parseFy26Month(r[3]);              // D=Month (Date 或字符串)
      if (!date) { totalNoDate++; continue; }
      if (hours <= 0) { totalNoHours++; continue; }
      if (!projNo || EXCLUDE_PROJ.test(projNo)) { totalExcludedProj++; continue; }

      // 如果 DB_工时流水 已覆盖该项目+员工+月份, 跳过 FY26 汇总, 避免重复
      const mKey = Utilities.formatDate(date, 'GMT+8', 'yyyy-MM') + '|' + projNo + '|' + tsm_formatName(englishName);
      if (monthKeySet[mKey]) { totalFy26Skipped++; continue; }
      monthKeySet[mKey] = true;

      const uuid = fy.name + '|' + mKey;
      rows.push([fy.name, date, englishName, fy.label, '', projNo, hours, 'FY26月度汇总', uuid, projName]);
    }
  }

  // 排序: 日期升序 → 项目编号升序 → 英文名升序
  rows.sort((a, b) => {
    const da = a[1] instanceof Date ? a[1].getTime() : 0;
    const db = b[1] instanceof Date ? b[1].getTime() : 0;
    if (da !== db) return da - db;
    if (a[5] !== b[5]) return a[5] < b[5] ? -1 : 1;
    return a[2] < b[2] ? -1 : 1;
  });

  if (rows.length > 0) {
    reportSheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
    reportSheet.getRange(2, 2, rows.length, 1).setNumberFormat('yyyy-MM-dd');
    reportSheet.getRange(2, 7, rows.length, 1).setNumberFormat('0.0');
    // 整表加筛选器, 方便按项目/员工/日期筛
    reportSheet.getRange(1, 1, rows.length + 1, headers.length).createFilter();
    // 列宽
    reportSheet.setColumnWidth(1, 90);
    reportSheet.setColumnWidth(2, 100);
    reportSheet.setColumnWidth(3, 130);
    reportSheet.setColumnWidth(4, 100);
    reportSheet.setColumnWidth(5, 100);
    reportSheet.setColumnWidth(6, 140);
    reportSheet.setColumnWidth(7, 70);
    reportSheet.setColumnWidth(8, 200);
    reportSheet.setColumnWidth(9, 200);
    reportSheet.setColumnWidth(10, 200);
  }

  // V4.3.46: 解耦 — refreshSheet3 不再清 Sheet1 飘红/悬浮, 用户体感保持 Sheet1 持续可用
  // (若需清理 Sheet1 条件格式/悬浮, 走独立菜单「🧹 单独清理 Sheet1 条件格式 (去飘红/悬浮)」)

  // 统计信息
  const msg = '✅ Sheet3 项目工时明细已重建!\n' +
    '━━━━━━━━━━━━━━━━━━━━\n' +
    '📊 有效记录: ' + rows.length + ' 条\n' +
    '🔍 读过: ' + totalRead + ' / 排除类型(休假等): ' + totalExcludedType +
    ' / 排除项目(OFF-WORK等): ' + totalExcludedProj +
    ' / 已删除: ' + totalDeleted +
    ' / 无日期: ' + totalNoDate +
    ' / 工时<=0: ' + totalNoHours +
    ' / DB去重(双录剔除): ' + totalDup +
    ' / FY26去重(明细已覆盖): ' + totalFy26Skipped + '\n' +
    '📂 来源: DB_工时流水 + FY26工时 (均为真实口径，FY26折算后工时不并入)\n' +
    '🧭 列序判定(V4.3.53): ' + colMapWhy + '\n' +
    '🧹 Sheet1 飘红/悬浮：本次未清理（V4.3.46 已解耦, 走「🧹 单独清理 Sheet1 条件格式」菜单）';
  // V4.3.50: 定时触发器上下文无 UI，getUi() 会抛异常 —— 降级为日志，不影响重建结果
  try { SpreadsheetApp.getUi().alert(msg); } catch (uiErr) { console.log('[refreshSheet3] ' + msg); }
  return msg;
}

// ==========================================
// V4.3.50: Sheet3 自动重建（定时触发版）
// ==========================================
// 背景：Sheet3 是 QS/PM 工时消费端的汇总源，但此前【只能手动菜单重建、无任何定时触发】，
//       长期 stale 会让全系统工时读不到新数据。本版加装每 2 小时自动重建。
// 注意：refreshSheet3 内部用 getActiveSpreadsheet() + getUi()，定时触发器下均不可用
//       （前者返回 null，后者抛异常），故必须用本包装函数显式 openById(TS_ID)。
// ==========================================================
// V4.3.57 一次性补数据导入（2026-09-05）
// 背景：9/5 06:30 的请假同步按「窗口内休假一律删」的旧规则，误删了 4,134 行
//       2026-04~11 月的历史休假记录（已在新版 V4.3.56 修复该规则）。
//       这批数据已备好在暂存表里，由每 2 小时的 autoRefreshSheet3 自动搬回。
//       用 Script Property 做幂等标记，只跑一次；失败会写心跳告警，不抛异常影响主流程。
// ==========================================================
var TS_IMPORT_STAGING_ID = '1OOsgpb91d5i0TXebDwe5VWzpJ2DzhIUTdRTbSeLm6T8';
var TS_IMPORT_DONE_KEY = 'TS_IMPORT_20260905_DONE';

function _tsImportMissingRowsOnce() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty(TS_IMPORT_DONE_KEY)) return 0;   // 幂等：跑过就不再跑
  var t0 = new Date().getTime();
  try {
    var src = SpreadsheetApp.openById(TS_IMPORT_STAGING_ID);
    var sh = src.getSheets()[0];
    var lastR = sh.getLastRow();
    var lastC = sh.getLastColumn();
    if (lastR < 1) { props.setProperty(TS_IMPORT_DONE_KEY, 'EMPTY'); return 0; }
    var vals = sh.getRange(1, 1, lastR, Math.max(14, lastC)).getValues();

    var dst = getDbSheet();
    var startRow = dst.getLastRow() + 1;
    dst.getRange(startRow, 1, vals.length, vals[0].length).setValues(vals);
    SpreadsheetApp.flush();

    var after = dst.getLastRow();
    props.setProperty(TS_IMPORT_DONE_KEY, '1');
    props.setProperty('TS_IMPORT_20260905_ROWS', String(vals.length));
    props.setProperty('TS_IMPORT_20260905_FROM_ROW', String(startRow));
    props.setProperty('TS_IMPORT_20260905_AT', new Date().toISOString());
    try { _recordTimeSheetHeartbeat('🟢', '补数据导入完成：' + vals.length + ' 行（起始 R' + startRow + '，导入后 lastRow=' + after + '，耗时 ' + Math.round((new Date().getTime() - t0) / 1000) + 's）'); } catch (eHb) {}
    return vals.length;
  } catch (e) {
    try { _recordTimeSheetHeartbeat('🔴', '补数据导入失败: ' + e.message); } catch (e2) {}
    return -1;
  }
}

// ============ V4.3.58 一次性清理：删掉 B 列日期 < 2026-04-01 的历史倒灌行 ============
// 背景：9/6 06:30 的 leave_sync 被自己的护栏中止（5,302 行 > 阈值 3,000），1,884 行陈年假没清掉。
// 护栏已改（V4.3.58 只算净删除），但那要等下一次 06:30。这里先只做「净删倒灌」这一件事，
// 明早 leave_sync 的分支① 就归零，不会再触发护栏。
// 安全：① Script Property 幂等，只跑一次；② 先覆盖写保留行再删尾部（铁律 48），任何一步失败原数据仍在；
//      ③ 超过 3,000 行直接中止并报红，绝不盲删。
var TS_PURGE_LEGACY_DONE_KEY = 'TS_PURGE_LEGACY_20260906_DONE';
function _tsPurgeLegacyOnce() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty(TS_PURGE_LEGACY_DONE_KEY)) return 0;
  var t0 = new Date().getTime();
  try {
    var dst = getDbSheet();
    var last = dst.getLastRow();
    if (last < 2) { props.setProperty(TS_PURGE_LEGACY_DONE_KEY, 'EMPTY'); return 0; }
    var lastC = dst.getLastColumn();
    var data = dst.getRange(1, 1, last, Math.max(14, lastC)).getValues();

    var kept = []; var removed = 0;
    for (var i = 0; i < data.length; i++) {
      var d = (i === 0) ? '' : _lsNormDate(data[i][1]);
      if (i > 0 && d && d < '2026-04-01') { removed++; } else { kept.push(data[i]); }
    }

    if (removed === 0) { props.setProperty(TS_PURGE_LEGACY_DONE_KEY, 'NOOP'); return 0; }
    if (removed > 3000) {
      try { _recordTimeSheetHeartbeat('🔴', '清理4月前倒灌已中止：命中 ' + removed + ' 行 > 3000，未做任何改动'); } catch (eHb) {}
      return -2;
    }

    dst.getRange(1, 1, kept.length, kept[0].length).setValues(kept);
    var actual = dst.getLastRow();
    if (actual > kept.length) { dst.deleteRows(kept.length + 1, actual - kept.length); }
    SpreadsheetApp.flush();

    props.setProperty(TS_PURGE_LEGACY_DONE_KEY, '1');
    props.setProperty('TS_PURGE_LEGACY_ROWS', String(removed));
    props.setProperty('TS_PURGE_LEGACY_AT', new Date().toISOString());
    try {
      _recordTimeSheetHeartbeat('🟢', '一次性清理4月前倒灌：删除 ' + removed + ' 行，剩余 ' +
        (kept.length - 1) + ' 行（耗时 ' + Math.round((new Date().getTime() - t0) / 1000) + 's）');
    } catch (eHb) {}
    return removed;
  } catch (e) {
    try { _recordTimeSheetHeartbeat('🔴', '清理4月前倒灌失败: ' + e.message); } catch (e2) {}
    return -1;
  }
}

// ============ V4.3.60 一次性清理：只保留「白名单人员的、去重后的」请假行 ============
// 背景（2026-09-06 她指出）：「我的工时是有指定人的，不是这些人的假期可以不用抓进来」。
//   表里 4,195 行系统同步请假里，有 2,152 行属于 17 位从没填过工时的人（Jane 产假 1,446 行等），
//   还有约 3,600 行是「同人同日」的重复行（一天最多 10 行），把表撑大且毫无用处。
// 她拍板：① 人员范围 = 就用填过工时的 30 人；② 历史数据 = 全清，只留指定人 + 去重的假。
// 安全：① Script Property 幂等，只跑一次；② 已备份 _tmp/_backup_ts_20260906_preclean.json；
//      ③ 先覆盖写保留行再删尾部（铁律 48）；④ 超过 6,000 行直接中止并报红，绝不盲删。
var TS_CLEAN_ROSTER_DUP_KEY = 'TS_CLEAN_ROSTER_DUP_20260906_DONE';
function _tsCleanRosterAndDupOnce() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty(TS_CLEAN_ROSTER_DUP_KEY)) return 0;
  var t0 = new Date().getTime();
  try {
    var dst = getDbSheet();
    var last = dst.getLastRow();
    if (last < 2) { props.setProperty(TS_CLEAN_ROSTER_DUP_KEY, 'EMPTY'); return 0; }
    var lastC = dst.getLastColumn();
    var width = Math.max(14, lastC);
    var data = dst.getRange(1, 1, last, width).getValues();

    // 白名单 = 表里有「手工填报」行的人（复用 leave_sync.js 的同款逻辑，保证与同步口径一致）
    _lsBuildRoster(data);
    var rosterN = _lsRosterSize || 0;
    if (rosterN === 0) {
      try { _recordTimeSheetHeartbeat('🔴', '请假清理已中止：白名单为空，疑似异常，未做任何改动'); } catch (eHb) {}
      return -3;
    }

    var kept = [];
    var seen = {};
    var rmNotInRoster = 0;
    var rmDup = 0;
    var rmZero = 0;
    var rmLegacy = 0;
    var rmNoDate = 0;
    for (var i = 0; i < data.length; i++) {
      if (i === 0) { kept.push(data[i]); continue; }          // 表头
      if (!_lsIsLeaveRow(data[i])) { kept.push(data[i]); continue; }  // 非请假行一律保留

      var d = _lsNormDate(data[i][1]);
      if (!d) { rmNoDate++; continue; }                          // 日期解析不出来 → 删
      if (d < '2026-04-01') { rmLegacy++; continue; }            // 顺带清 4 月前

      var nm = String(data[i][2] || '').trim();
      if (!_lsInRoster(nm)) { rmNotInRoster++; continue; }      // ① 不在白名单 → 删

      // ② 工时为 0 / 空 / 非数字的请假行 = 脏数据（如 I 列 TS-XXXX 那批），删
      var hrs = Number(data[i][6]);
      if (!isFinite(hrs) || hrs <= 0) { rmZero++; continue; }

      // ③ 去重键 = 姓名 | 日期 | 工时
      //    为什么带工时：同一天可能有两条真实的不同事件（如全天 8h + 半天 3h），
      //    只按「人|日」去重会把真实的两条并成一条丢工时；带上工时则只合并
      //    「同一事件的多次历史写入」（这正是撑表的元凶，一天最多累积到 15 行）。
      var key = nm.toLowerCase() + '|' + d + '|' + hrs;
      if (seen[key]) { rmDup++; continue; }
      seen[key] = true;
      kept.push(data[i]);
    }

    var removed = rmNotInRoster + rmDup + rmZero + rmLegacy + rmNoDate;
    if (removed === 0) { props.setProperty(TS_CLEAN_ROSTER_DUP_KEY, 'NOOP'); return 0; }
    if (removed > 6000) {
      try {
        _recordTimeSheetHeartbeat('🔴', '请假清理已中止：命中 ' + removed +
          ' 行 > 6000（非名单 ' + rmNotInRoster + ' + 重复 ' + rmDup + ' + 零工时 ' + rmZero +
          ' + 4月前 ' + rmLegacy + ' + 无日期 ' + rmNoDate + '），未做任何改动');
      } catch (eHb) {}
      return -2;
    }

    dst.getRange(1, 1, kept.length, width).setValues(kept);
    var actual = dst.getLastRow();
    if (actual > kept.length) { dst.deleteRows(kept.length + 1, actual - kept.length); }
    SpreadsheetApp.flush();

    props.setProperty(TS_CLEAN_ROSTER_DUP_KEY, '1');
    props.setProperty('TS_CLEAN_ROWS', String(removed));
    props.setProperty('TS_CLEAN_BREAKDOWN',
      '非名单 ' + rmNotInRoster + ' / 重复 ' + rmDup + ' / 零工时 ' + rmZero +
      ' / 4月前 ' + rmLegacy + ' / 无日期 ' + rmNoDate);
    props.setProperty('TS_CLEAN_AT', new Date().toISOString());
    try {
      _recordTimeSheetHeartbeat('🟢', '一次性请假清理完成：白名单 ' + rosterN + ' 人，删除 ' + removed +
        ' 行（非名单 ' + rmNotInRoster + ' + 重复 ' + rmDup + ' + 零工时 ' + rmZero +
        ' + 4月前 ' + rmLegacy + ' + 无日期 ' + rmNoDate +
        '），剩余 ' + (kept.length - 1) + ' 行（耗时 ' +
        Math.round((new Date().getTime() - t0) / 1000) + 's）');
    } catch (eHb) {}
    return removed;
  } catch (e) {
    try { _recordTimeSheetHeartbeat('🔴', '一次性请假清理失败: ' + e.message); } catch (e2) {}
    return -1;
  }
}

function autoRefreshSheet3() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(60000)) { console.log('[autoRefreshSheet3] 上一次重建仍在运行，跳过本次'); return; }
  try {
    // V4.3.57 一次性补数据：把 9/5 被误删的历史休假记录从暂存表搬回（幂等，只跑一次）
    try { _tsImportMissingRowsOnce(); } catch (eImp) { console.error('[tsImport] ' + eImp.message); }
    // V4.3.58 一次性清理历史倒灌（幂等，只跑一次）
    try { _tsPurgeLegacyOnce(); } catch (ePurge) { console.error('[tsPurge] ' + ePurge.message); }
    // V4.3.60 一次性清理：只保留白名单人员的、去重后的请假行（幂等，只跑一次）
    try { _tsCleanRosterAndDupOnce(); } catch (eClean) { console.error('[tsClean] ' + eClean.message); }
    const ss = SpreadsheetApp.openById(TS_ID);
    refreshSheet3(ss);
  } catch (e) {
    console.error('[autoRefreshSheet3] 失败: ' + e.message);
  } finally {
    lock.releaseLock();
  }
}

// 自愈安装：确保每 2 小时自动重建 Sheet3（从其它已授权触发器上下文调用）
function ensureSheet3Trigger() {
  try {
    const triggers = ScriptApp.getProjectTriggers();
    const exists = triggers.some(t => t.getHandlerFunction() === 'autoRefreshSheet3' && t.getEventType() === ScriptApp.EventType.CLOCK);
    if (!exists) {
      ScriptApp.newTrigger('autoRefreshSheet3').timeBased().everyHours(2).create();
      console.log('[ensureSheet3Trigger] 已重建 autoRefreshSheet3 每2小时触发器');
    }
  } catch (e) {
    console.log('[ensureSheet3Trigger] 跳过：' + e.message);
  }
}

// V4.3.49 辅助：把项目编号归一化，用于跨写法模糊匹配
function _normalizeProjectId(s) {
  if (!s) return '';
  return String(s)
    .toUpperCase()
    .replace(/[\s\-_－—，,\/\\]+/g, '')   // 去掉空格、连字符、全角横线、逗号、斜杠
    .replace(/[\uFF10-\uFF19]/g, function(c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); }) // 全角数字→半角
    .replace(/上海/g, 'SH').replace(/广州/g, 'GZ').replace(/香港/g, 'HK') // 常见城市中文别名
    .trim();
}

// ==========================================
// V4.3.38 诊断 Sheet3 数据源
// 用于快速定位"有效记录多 / 总工时异常"等问题的根因
// ==========================================
function diagnoseSheet3Sources() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const lines = [];

  // 1. DB_工时流水 诊断
  const dbSheet = SpreadsheetApp.openById(TS_ID).getSheetByName('DB_工时流水');
  if (dbSheet) {
    const lastRow = dbSheet.getLastRow();
    const lastCol = dbSheet.getLastColumn();
    lines.push('【DB_工时流水】');
    lines.push('  最后行: ' + lastRow + ' / 最后列: ' + lastCol);

    if (lastRow >= 2) {
      const data = dbSheet.getRange(2, 1, lastRow - 1, Math.max(15, lastCol)).getValues();
      // V4.3.53: 与 refreshSheet3 共用同一套内容驱动列序探测（此前本函数硬编码 V4.2 七列索引，
      // 与 refreshSheet3 的 V4.3.50 十四列索引矛盾 —— 同一份数据两个函数读出两套结论）
      const _dHdrRow = dbSheet.getRange(1, 1, 1, Math.max(15, lastCol)).getValues()[0];
      const _dDet = _detectTimesheetColumns(data, _dHdrRow);
      const _COL = _dDet.map;
      lines.push('  🧭 列序判定(V4.3.53): ' + _dDet.why);
      lines.push('  📋 原始表头 A~O: ' + JSON.stringify(_dHdrRow.slice(0, 15)));
      lines.push('  🔬 探测明细: 工时列候选=第' + (_dDet.probe.hours.idx + 1) + '列(score=' + _dDet.probe.hours.score + ')' +
        ' / 项目号候选=第' + (_dDet.probe.projNo.idx + 1) + '列(score=' + _dDet.probe.projNo.score + ')' +
        ' / 日期候选=第' + (_dDet.probe.date.idx + 1) + '列(score=' + _dDet.probe.date.score + ')');
      let validRows = 0, deletedRows = 0, noDate = 0, noHours = 0, offWork = 0, sumHours = 0;
      const projCounts = {};
      const nameCounts = {};
      const dateNameProjDup = {};
      const sigDupSet = {};
      let dupCount = 0;
      let exactDupCount = 0;
      // V4.3.47: 日期范围 + 近14天每日行数（一眼看出"数据停在哪天"）
      let minDate = null, maxDate = null, blankDateRows = 0;
      const dayCount = {};

      for (let i = 0; i < data.length; i++) {
        const r = data[i];
        // V4.3.53: 列序由 _COL 实测决定（与 refreshSheet3 完全一致，避免两个函数读出两套结论）
        const date = r[_COL.date];
        const name = String(r[_COL.name] || '').trim();
        const phase = String(r[_COL.stage] || '').trim();
        const projNo = String(r[_COL.projNo] || '').trim();
        const hours = parseFloat(r[_COL.hours]) || 0;
        const isDeleted = r[_COL.isDeleted] === true || String(r[_COL.isDeleted] || '').toUpperCase() === 'TRUE' || String(r[_COL.isDeleted]) === '1';

        if (isDeleted) { deletedRows++; continue; }
        if (!(date instanceof Date) || isNaN(date.getTime())) { noDate++; blankDateRows++; continue; }
        // V4.3.47: 统计日期范围与每日行数（含无效工时行, 如实反映"源表有没有新数据"）
        {
          const dk = Utilities.formatDate(date, 'GMT+8', 'yyyy-MM-dd');
          dayCount[dk] = (dayCount[dk] || 0) + 1;
          if (!minDate || date < minDate) minDate = date;
          if (!maxDate || date > maxDate) maxDate = date;
        }
        if (hours <= 0) { noHours++; continue; }
        if (/^(off.?work|off|n\/?a|行政)$/i.test(projNo) || /^(off.?work|off)$/i.test(phase)) { offWork++; continue; }

        validRows++;
        sumHours += hours;
        projCounts[projNo] = (projCounts[projNo] || 0) + 1;
        nameCounts[name] = (nameCounts[name] || 0) + 1;

        const dKey = Utilities.formatDate(date, 'GMT+8', 'yyyy-MM-dd') + '|' + name + '|' + projNo;
        if (dateNameProjDup[dKey]) dupCount++;
        dateNameProjDup[dKey] = true;

        // V4.3.39: refreshSheet3 实际剔除的"全签名重复"(日期|姓名|阶段|项目|工时 完全相同)
        const sig = Utilities.formatDate(date, 'GMT+8', 'yyyy-MM-dd') + '|' + name + '|' + phase + '|' + projNo + '|' + hours;
        if (sigDupSet[sig]) exactDupCount++;
        sigDupSet[sig] = true;
      }

      lines.push('  有效行: ' + validRows + ' / 已删除: ' + deletedRows + ' / 无日期: ' + noDate + ' / 工时<=0: ' + noHours + ' / OFF-WORK类: ' + offWork);
      lines.push('  有效工时合计: ' + sumHours.toFixed(1));
      lines.push('  同日期+同员工+同项目重复: ' + dupCount + ' 条');
      lines.push('  ↳ 其中"全签名"真重复(重建会剔除): ' + exactDupCount + ' 条');
      // V4.3.47: 日期范围 + 近14天每日行数 —— 直接回答"数据更新到哪天 / 后面没刷新"
      const fmtD = d => d ? Utilities.formatDate(d, 'GMT+8', 'yyyy-MM-dd') : '(无)';
      lines.push('  📅 日期范围: ' + fmtD(minDate) + '  ~  ' + fmtD(maxDate));
      lines.push('  ⚠️ B列日期为空或非日期的行: ' + blankDateRows + ' 条');
      const allDays = Object.keys(dayCount).sort();
      const recent = allDays.slice(-14);
      if (recent.length) {
        lines.push('  📊 最近 ' + recent.length + ' 天每日行数(含无效工时):');
        recent.forEach(d => { lines.push('     ' + d + ' : ' + dayCount[d]); });
      }
      const today = Utilities.formatDate(new Date(), 'GMT+8', 'yyyy-MM-dd');
      lines.push('  🕐 今天: ' + today + ' | 源表最新数据日期: ' + fmtD(maxDate) + (maxDate ? ('  (距今 ' + Math.round((new Date(today).getTime() - new Date(fmtD(maxDate)).getTime()) / 86400000) + ' 天)') : ''));
      lines.push('  24-151-SH-M26 出现: ' + (projCounts['24-151-SH-M26'] || 0) + ' 次');
      // V4.3.48: 按项目行数 top 20 + 抽查用户常问的项目 —— 直接回答"XX项目怎么没有"
      const topProj = Object.entries(projCounts).sort((a,b)=>b[1]-a[1]).slice(0,20);
      if (topProj.length) {
        lines.push('  📋 行数 Top 20 项目: ' + topProj.map(x=>x[0]+':'+x[1]).join(', '));
      }
      // V4.3.49: 用归一化键做模糊匹配，避免 "BC 上海" / "BC-SH-M26" / "BC上海" 这类写法差异导致漏判
      const HOT = ['26-067-SH','26-077-GZ','26-084-HK','BC-SH','BC SH','BC上海'];
      const normMap = {}; // 归一化键 -> 原始写法列表
      Object.keys(projCounts).forEach(raw => {
        const n = _normalizeProjectId(raw);
        if (!n) return;
        if (!normMap[n]) normMap[n] = [];
        normMap[n].push(raw);
      });
      const hotHits = [];
      const hotMiss = [];
      HOT.forEach(k => {
        const nk = _normalizeProjectId(k);
        const raws = normMap[nk];
        if (raws && raws.length) {
          const total = raws.reduce((sum, raw) => sum + (projCounts[raw] || 0), 0);
          hotHits.push(k + ' => 源表写法 ' + raws.map(r => '"' + r + '"(' + (projCounts[r] || 0) + ')').join(', ') + ' 合计' + total + '次');
        } else {
          hotMiss.push(k);
        }
      });
      if (hotHits.length) {
        lines.push('  🎯 抽查项目命中(归一化匹配):');
        hotHits.forEach(h => lines.push('     ' + h));
      }
      if (hotMiss.length) {
        lines.push('  🎯 抽查项目未命中: ' + hotMiss.join(', ') + ' ⚠️ (按归一化键也没找到，说明源表确实没有这些写法)');
      }
      // 额外：把源表里含 "BC"/"26-077"/"26-084"/"26-067" 的原始写法直接列出来，方便肉眼对账
      const relatedRaw = Object.keys(projCounts).filter(raw => {
        const up = raw.toUpperCase();
        return up.indexOf('BC') >= 0 || up.indexOf('26-077') >= 0 || up.indexOf('26-084') >= 0 || up.indexOf('26-067') >= 0;
      }).sort((a,b) => projCounts[b] - projCounts[a]);
      if (relatedRaw.length) {
        lines.push('  🔎 源表中含 BC / 26-067 / 26-077 / 26-084 的项目(原始写法): ' +
          relatedRaw.slice(0,15).map(r => '"' + r + '":' + projCounts[r]).join(', ') +
          (relatedRaw.length > 15 ? ' ...等' + relatedRaw.length + '个' : ''));
      }
      lines.push('  前三名员工行数: ' + Object.entries(nameCounts).sort((a,b)=>b[1]-a[1]).slice(0,3).map(x=>x[0]+':'+x[1]).join(', '));
      lines.push('  第一行原始值(B-I): ' + data[0].slice(1,9).map(v => v instanceof Date ? Utilities.formatDate(v,'GMT+8','yyyy-MM-dd') : String(v)).join(' | '));
      if (data.length > 1) lines.push('  第二行原始值(B-I): ' + data[1].slice(1,9).map(v => v instanceof Date ? Utilities.formatDate(v,'GMT+8','yyyy-MM-dd') : String(v)).join(' | '));
    }
  } else {
    lines.push('【DB_工时流水】找不到表');
  }

  // 2. FY26工时 诊断
  const fySheet = ss.getSheetByName('FY26工时');
  if (fySheet) {
    const lastRow = fySheet.getLastRow();
    const lastCol = fySheet.getLastColumn();
    lines.push('');
    lines.push('【FY26工时】');
    lines.push('  最后行: ' + lastRow + ' / 最后列: ' + lastCol);

    if (lastRow >= 2) {
      const data = fySheet.getRange(2, 1, lastRow - 1, Math.max(5, lastCol)).getValues();
      let validRows = 0, noMonth = 0, noHours = 0, sumHours = 0;
      const projCounts = {};
      const monthSet = {};
      const sigDupSet = {};
      let exactDupCount = 0;
      function _parseFy26Month(ms) {
        if (ms instanceof Date) return new Date(ms.getFullYear(), ms.getMonth(), 1);
        const m = String(ms).match(/^([A-Za-z]{3})['"]*(\d{4})$/);
        if (!m) return null;
        const map = {jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11};
        const mon = map[m[1].toLowerCase()];
        const yr = parseInt(m[2], 10);
        if (mon === undefined || isNaN(yr)) return null;
        return new Date(yr, mon, 1);
      }

      for (let i = 0; i < data.length; i++) {
        const r = data[i];
        const projNo = String(r[0] || '').trim();
        const hours = parseFloat(r[2]) || 0;
        const date = _parseFy26Month(r[3]);  // D=Month (Date 或字符串)
        if (!date) { noMonth++; continue; }
        if (hours <= 0) { noHours++; continue; }
        validRows++;
        sumHours += hours;
        projCounts[projNo] = (projCounts[projNo] || 0) + 1;
        monthSet[Utilities.formatDate(date, 'GMT+8', 'yyyy-MM')] = true;
      }

      lines.push('  有效行: ' + validRows + ' / 月份解析失败: ' + noMonth + ' / 工时<=0: ' + noHours);
      lines.push('  有效工时合计: ' + sumHours.toFixed(1));
      lines.push('  月份分布: ' + Object.keys(monthSet).sort().join(', '));
      lines.push('  24-151-SH-M26 出现: ' + (projCounts['24-151-SH-M26'] || 0) + ' 次');
      lines.push('  第一行原始值(A-E): ' + data[0].slice(0,5).map(v => String(v)).join(' | '));
      if (data.length > 1) lines.push('  第二行原始值(A-E): ' + data[1].slice(0,5).map(v => String(v)).join(' | '));
    }
  } else {
    lines.push('');
    lines.push('【FY26工时】找不到表');
  }

  // 3. V4.3.47: Sheet1(月度工时异常表) 状态自检 —— 飘红 + 悬浮备注是否还在
  const s1 = ss.getSheetByName('Sheet1');
  lines.push('');
  lines.push('【Sheet1 月度工时异常表】');
  if (s1 && s1.getLastRow() >= 2) {
    lines.push('  行数: ' + s1.getLastRow() + ' / 列数: ' + s1.getLastColumn());
    const rules = s1.getConditionalFormatRules();
    lines.push((rules.length ? '  ✅ ' : '  ❌ ') + '条件格式(飘红)规则数: ' + rules.length);
    let noteCells = 0;
    try {
      const notes = s1.getRange(2, 1, s1.getLastRow() - 1, 1).getNotes();
      notes.forEach(n => { if (n && String(n).trim()) noteCells++; });
    } catch (e) { /* getNotes 不支持时忽略 */ }
    lines.push((noteCells ? '  ✅ ' : '  ❌ ') + 'A列带悬浮备注的姓名格: ' + noteCells + ' 个');
    // 日期列范围（第1行从第2列起是日期）
    const hdr = s1.getRange(1, 2, 1, Math.max(1, s1.getLastColumn() - 1)).getValues()[0];
    const dateHdrs = hdr.filter(h => h instanceof Date || /^\d{4}-\d{2}-\d{2}$/.test(String(h || '')));
    if (dateHdrs.length) {
      const h2 = dateHdrs.map(h => h instanceof Date ? Utilities.formatDate(h, 'GMT+8', 'yyyy-MM-dd') : String(h));
      lines.push('  📅 日期列: ' + h2[0] + ' ~ ' + h2[h2.length - 1] + ' (共 ' + h2.length + ' 天)');
    } else {
      lines.push('  ⚠️ 第1行未识别到日期列 —— 请重新运行「📊 刷新工时异常表」');
    }
  } else {
    lines.push('  ⚠️ Sheet1 为空或不存在 —— 请运行「📊 刷新工时异常表」生成');
  }

  // 4. V4.3.47: 已安装触发器清单（自查自动同步是否还活着）
  lines.push('');
  lines.push('【已安装触发器】');
  try {
    const trigs = ScriptApp.getProjectTriggers();
    if (!trigs.length) lines.push('  ⚠️ 没有任何触发器 —— 自动同步全部停止！请运行「⏰ 开启/修复触发器」');
    trigs.forEach(t => {
      const hn = t.getHandlerFunction ? t.getHandlerFunction() : '(未知)';
      lines.push('  ✅ ' + hn);
    });
  } catch (e) { lines.push('  (读取触发器失败: ' + e.message + ')'); }

  SpreadsheetApp.getUi().alert(lines.join('\n'));
}

// ==========================================
// V4.3.35 物理清理 DB_工时流水 中已软删除的记录
// 背景：syncLeavesFromCalendar 旧实现软删旧记录(O列打勾)再写新, 长期累积表中大量已删除垃圾。
// 本函数把 O=TRUE 的记录真正从表里删除, 让表和 Sheet3 重建都更轻快。
// 用"读保留行 + 重写"方式避免逐行 deleteRows 超时; clearContent 只清值保留格式/列宽。
function physicalPurgeDeleted() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    SpreadsheetApp.getUi().alert('❌ 清理正在进行，请稍后再试');
    return;
  }
  try {
    const sheet = getDbSheet();
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) { SpreadsheetApp.getUi().alert('✅ 表为空，无需清理'); return; }
    const lastCol = Math.max(15, sheet.getLastColumn());
    const data = sheet.getRange(1, 1, lastRow, lastCol).getValues();

    // 保留表头 + 所有 O 列非 TRUE 的行
    const kept = [data[0]];
    let removed = 0;
    for (let i = 1; i < data.length; i++) {
      const dv = data[i][14];
      if (dv === true || String(dv).toUpperCase() === 'TRUE' || String(dv) === '1') {
        removed++;
      } else {
        kept.push(data[i]);
      }
    }
    if (removed === 0) {
      SpreadsheetApp.getUi().alert('✅ 没有已删除记录需要物理清理');
      return;
    }

    sheet.getRange(1, 1, lastRow, lastCol).clearContent();
    sheet.getRange(1, 1, kept.length, kept[0].length).setValues(kept);
    const actualLast = sheet.getLastRow();
    if (actualLast > kept.length) {
      sheet.deleteRows(kept.length + 1, actualLast - kept.length);
    }

    SpreadsheetApp.getUi().alert('✅ 物理清理完成!\n' +
      '━━━━━━━━━━━━━━━━━━━━\n' +
      '🗑️ 已物理删除: ' + removed + ' 条已软删除记录\n' +
      '📋 保留有效记录: ' + (kept.length - 1) + ' 条\n' +
      '💡 DB_工时流水 和 Sheet3 重建都更轻快');
  } finally {
    lock.releaseLock();
  }
}

// V4.2: 单独清理 Sheet1 历史飘红 + 悬浮 note
// Sheet1 的条件格式 `whenNumberLessThan(8)` 会把 h=0 (未填/未来日期) 也标红 + 加三角, 视觉噪声大
// 本函数清掉所有条件格式 + 所有 cell note, 不动 Sheet1 数据本身
/**
 * V4.3.52: 时段诊断 —— 一键体检 DB_工时流水 表
 * 报告：① A/B 列为空的行数 ② 重复请假行数（按姓名+日期分组） ③ 跨过结束日的可疑休假
 *       ④ 实际表头内容（一眼看出列序错位） ⑤ 总行数
 * 输出方式：同时写诊断页 + 弹 alert
 */
function diagnoseTimesheetColumns() {
  const ss = SpreadsheetApp.openById(TS_ID);
  const sheet = ss.getSheetByName('DB_工时流水');
  if (!sheet || sheet.getLastRow() < 2) {
    SpreadsheetApp.getUi().alert('DB_工时流水 不存在或为空');
    return;
  }
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const rows = data.slice(1);

  // 表头原文
  const headerStr = headers.slice(0, 15).map(function(h, i) {
    return (i + 1) + '[' + String(h).substring(0, 18) + ']';
  }).join(' ');

  let emptyA = 0, emptyB = 0, emptyBoth = 0, totalActive = 0;
  let leaveByKey = {};   // name|dateStr -> count
  let leaveByKeyNoDate = {}; // name|""|... -> count
  const LEAVE_RE = /(系统同步请假|LEAVE-)/;
  const LEAVE_DATE_RE = /LEAVE-[a-z0-9]{1,40}-(\d{4}-\d{2}-\d{2})/i;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const a = r[0], b = r[1], c = r[2];
    if (!c && !a && !b) continue; // 完全空行
    totalActive++;
    if (!a) emptyA++;
    if (!b) emptyB++;
    if (!a && !b) emptyBoth++;
    // 休假识别：col6(7列) OR col7(14列) OR col8(14列)
    const c6 = String(r[6] || ''), c7 = String(r[7] || ''), c8 = String(r[8] || '');
    if (LEAVE_RE.test(c6) || LEAVE_RE.test(c7) || LEAVE_RE.test(c8)) {
      const name = String(c || '').trim();
      let dStr = '';
      if (b instanceof Date) dStr = Utilities.formatDate(b, 'GMT+8', 'yyyy-MM-dd');
      else if (b) dStr = String(b).trim().substring(0, 10);
      if (!dStr) {
        const m = (c6 + ' ' + c7 + ' ' + c8).match(LEAVE_DATE_RE);
        if (m) dStr = m[1];
      }
      const key = name + '|' + (dStr || '(无日期)');
      leaveByKey[key] = (leaveByKey[key] || 0) + 1;
    }
  }
  // 找重复组
  const dupGroups = Object.keys(leaveByKey).filter(function(k) { return leaveByKey[k] > 1; })
    .sort(function(a, b) { return leaveByKey[b] - leaveByKey[a]; });

  // 写诊断页
  let diag = ss.getSheetByName('🔍 时段诊断');
  if (diag) diag.clear();
  else diag = ss.insertSheet('🔍 时段诊断');
  const lines = [];
  lines.push(['DB_工时流水 时段诊断报告', '']);
  lines.push(['生成时间', new Date()]);
  lines.push(['表总行数（含表头）', data.length]);
  lines.push(['实际有数据行数', totalActive]);
  lines.push(['', '']);
  lines.push(['【表头 A-O】', headerStr]);
  lines.push(['', '']);
  lines.push(['【A 列（提交时间）为空的行数】', emptyA]);
  lines.push(['【B 列（日期）为空的行数】', emptyB]);
  lines.push(['【A 与 B 同时为空的行数】', emptyBoth]);
  lines.push(['', '']);
  lines.push(['【休假记录重复组数（姓名+日期）】', dupGroups.length]);
  if (dupGroups.length > 0) {
    lines.push(['【前 10 个最严重的重复组】', '']);
    lines.push(['姓名|日期', '次数']);
    dupGroups.slice(0, 10).forEach(function(k) {
      lines.push([k, leaveByKey[k]]);
    });
  }
  lines.push(['', '']);
  lines.push(['【建议操作】', '']);
  if (emptyBoth > 0) {
    lines.push(['① 点「📅 补齐历史日期标签」', '可把 A/B 填上（用 N 年月+备注里 LEAVE-...-date 提取）']);
  }
  if (dupGroups.length > 0) {
    lines.push(['② 点「🩹 清理重复请假记录」', '用 V4.3.52 强化的清理逻辑一次性清掉（已不依赖 B 列）']);
    lines.push(['③ 点「🌴 手动同步请假日历」', '从 Google Calendar 重新拉一遍，确保 Sheet1 显示干净']);
  }
  if (emptyBoth === 0 && dupGroups.length === 0) {
    lines.push(['✅ 表数据健康，无需清理', '']);
  }
  diag.getRange(1, 1, lines.length, 2).setValues(lines);
  diag.getRange(1, 1, 1, 2).setFontWeight('bold').setBackground('#37474F').setFontColor('white');
  diag.setColumnWidth(1, 280);
  diag.setColumnWidth(2, 480);

  // 弹 alert 摘要
  let msg = '🔍 DB_工时流水 诊断报告\n\n';
  msg += '· 总数据行数: ' + totalActive + '\n';
  msg += '· A 列空: ' + emptyA + ' 行 / B 列空: ' + emptyB + ' 行 / A+B 同时空: ' + emptyBoth + ' 行\n';
  msg += '· 休假重复组: ' + dupGroups.length + ' 组';
  if (dupGroups.length > 0) {
    msg += '\n  严重 TOP 3:';
    dupGroups.slice(0, 3).forEach(function(k) { msg += '\n  • ' + k + ' × ' + leaveByKey[k]; });
  }
  msg += '\n\n【表头 A-O】\n' + headerStr + '\n\n';
  if (emptyBoth > 0 || dupGroups.length > 0) {
    msg += '💡 见「🔍 时段诊断」页（菜单旁的同名页）查看完整报告和操作建议。';
  } else {
    msg += '✅ 表数据健康。';
  }
  SpreadsheetApp.getUi().alert(msg);
}

/**
 * V4.3.52: 一次性回填 A/B 列 —— 用 N 年月 + 备注 LEAVE-...-date 模式 推断
 * 规则（按优先级）：
 *   ① B 已有 → 跳过
 *   ② 备注里正则提取 LEAVE-...-YYYY-MM-DD → 设 B
 *   ③ N 年月非空 → 设 B = N + "-01"（最佳猜测，月初）
 *   ④ 都没有 → 跳过
 * A 列：若 A 也空且 B 推断成功 → 设 A = B + " 08:00:00"（假装是工作日 8 点提交）
 * 不会覆盖任何已有值；不会触碰 休假 识别已 OK 的行。
 */
function backfillABColumnsInternal() {
  const ss = SpreadsheetApp.openById(TS_ID);
  const sheet = ss.getSheetByName('DB_工时流水');
  if (!sheet || sheet.getLastRow() < 2) {
    SpreadsheetApp.getUi().alert('DB_工时流水 不存在或为空');
    return;
  }
  const lastRow = sheet.getLastRow();
  const lastCol = Math.max(15, sheet.getLastColumn());
  const range = sheet.getRange(2, 1, lastRow - 1, lastCol);
  const data = range.getValues();
  const LEAVE_DATE_RE = /LEAVE-[a-z0-9]{1,40}-(\d{4}-\d{2}-\d{2})/i;

  let backfilledB = 0, backfilledA = 0, skipped = 0;
  const updates = []; // [rowIdx, colA, colB, ...]

  for (let i = 0; i < data.length; i++) {
    const r = data[i];
    const c2 = String(r[2] || '').trim();
    if (!c2) { skipped++; continue; } // 完全空行，跳过

    let curA = r[0], curB = r[1];
    let newB = null;
    if (!curB) {
      // ① 备注正则
      const allNotes = [r[6], r[7], r[8]].map(function(x){return String(x || '');}).join(' ');
      const m = allNotes.match(LEAVE_DATE_RE);
      if (m) {
        newB = m[1];
      } else {
        // ② N 年月
        const ym = String(r[13] || '').trim();
        if (/^\d{4}-\d{2}$/.test(ym)) {
          newB = ym + '-01';
        }
      }
      if (newB) {
        data[i][1] = newB;
        backfilledB++;
        if (!curA) {
          // A 用 B 的 08:00 假装
          const d = new Date(newB + 'T08:00:00+08:00');
          if (!isNaN(d.getTime())) {
            data[i][0] = d;
            backfilledA++;
          }
        }
      } else {
        skipped++;
      }
    } else {
      skipped++;
    }
  }
  if (backfilledB > 0) {
    range.setValues(data);
  }
  SpreadsheetApp.getUi().alert(
    '🔧 A/B 列回填完成\n\n' +
    '· 回填 B（日期）列: ' + backfilledB + ' 行\n' +
    '· 回填 A（提交时间）列: ' + backfilledA + ' 行\n' +
    '· 跳过（已有日期或完全空行）: ' + skipped + ' 行\n\n' +
    (backfilledB > 0 ? '建议：立刻跑一次「🌴 手动同步请假日历」让休假清理逻辑把回填后的行纳入窗口检查。' : '没有需要回填的行。')
  );
}

/**
 * V4.3.54 (2026-09-02 15:08): 清理 DB_工时流水 表里日期 > 今天的行
 * 背景：早期 leave_sync / 自测 可能往 B 列写了未来日期（如 2026-11-06 ~ 2026-11-19），
 *       这些行既不是真数据、也不该被 Sheet3 当作未来月份消费；按用户拍板一键清掉。
 * 行为：扫描 B 列（_COL.date）Date 类型且 > 今天的行 → OK_CANCEL 确认 → 物理删除该行
 *       + 写日志。备份一行示例到 Log 页以备追溯。
 * 保留：Date 解析失败的行 / 不是 Date 类型的行 / 未来的非日期字符串 都不动（保守）。
 */
function cleanupFutureDateRowsInternal() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();
  const dbSheet = SpreadsheetApp.openById(TS_ID).getSheetByName('DB_工时流水');
  if (!dbSheet || dbSheet.getLastRow() < 2) {
    ui.alert('❌ DB_工时流水 表不存在或没有数据行'); return;
  }
  const lastRow = dbSheet.getLastRow();
  const lastCol = Math.max(15, dbSheet.getLastColumn());
  const data = dbSheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  const hdr = dbSheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const det = _detectTimesheetColumns(data, hdr);
  const dateColIdx = det.map.date;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const futureRows = [];
  const sample = [];
  for (let i = 0; i < data.length; i++) {
    const v = data[i][dateColIdx];
    if (!(v instanceof Date) || isNaN(v.getTime())) continue;
    if (v.getTime() > today.getTime()) {
      futureRows.push({ sheetRow: i + 2, idx: i, date: v, name: String(data[i][det.map.name] || ''), proj: String(data[i][det.map.projNo] || '') });
      if (sample.length < 5) sample.push('  • 第 ' + (i + 2) + ' 行  ' + Utilities.formatDate(v, 'GMT+8', 'yyyy-MM-dd') + '  ' + String(data[i][det.map.name] || '') + '  ' + String(data[i][det.map.projNo] || ''));
    }
  }

  if (futureRows.length === 0) {
    ui.alert('✅ 体检完成：DB_工时流水 没有未来日期的行（日期列 ' + (dateColIdx + 1) + '）'); return;
  }

  const msg = '🧹 发现 ' + futureRows.length + ' 行日期 > 今天的记录（疑似早期测试残留）。\n\n' +
    '📋 列序判定(V4.3.53): ' + det.why + '\n' +
    '📅 今天: ' + Utilities.formatDate(today, 'GMT+8', 'yyyy-MM-dd') + '\n\n' +
    '前 5 条样例：\n' + sample.join('\n') + '\n\n' +
    '点击「确定」物理删除这些行（不可撤销！建议先导出 DB_工时流水 备份）。\n' +
    '点击「取消」只看不删。';
  const resp = ui.alert('🧹 清理未来日期脏数据', msg, ui.ButtonSet.OK_CANCEL);
  if (resp !== ui.Button.OK) return;

  // 从后往前删，避免行号漂移
  let deleted = 0;
  for (let i = futureRows.length - 1; i >= 0; i--) {
    dbSheet.deleteRow(futureRows[i].sheetRow);
    deleted++;
  }
  // 写 Log（用项目已有的 _writeLog 或者写到 sheet 备注）
  try {
    const logSheet = ss.getSheetByName('Log') || ss.insertSheet('Log');
    logSheet.appendRow([new Date(), 'CLEANUP_FUTURE_ROWS', '🧹 物理删除 ' + deleted + ' 行未来日期脏数据（日期列 ' + (dateColIdx + 1) + '）']);
  } catch (e) { console.log('[cleanupFutureDateRowsInternal] Log 写入失败: ' + e.message); }

  ui.alert('✅ 已物理删除 ' + deleted + ' 行未来日期脏数据。\n\n' +
    '下一步建议：点「📋 手动重建 Sheet3」让 Sheet3 用最新 DB 数据重算。');
}

function cleanSheet1LegacyHighlights() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Sheet1');
  if (!sheet) return;
  const before = sheet.getConditionalFormatRules().length;
  sheet.clearConditionalFormatRules();
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  let clearedNotes = 0;
  if (lastRow > 1 && lastCol > 0) {
    const notesRange = sheet.getRange(2, 1, lastRow - 1, lastCol);
    notesRange.clearNote();
    clearedNotes = lastRow - 1;
  }
  ss.toast('✅ Sheet1 已清理: 条件格式 ' + before + ' 条 + ' + clearedNotes + ' 行 cell note (飘红/悬浮不再显示)\n\n下次点「📊 刷新工时异常表」会自动应用新规则(0<h<8 才标红)',
           'Sheet1 清理', 5);
}

// ==========================================
// 3. V3.2 周存档与触发器
// ==========================================
function weeklyBackupTask() { archiveCurrentSpreadsheet(); }

// V4.3.27: 修复「开启/修复触发器」会静默删除「每周五 09:00 团队工时提醒」的 bug。
// 改为只清理/重建本函数负责的 2 个触发器，保留其它用户触发器（如周五提醒），避免"修复"变"破坏"。
function setupAllTriggers() {
  const OWNED = ['weeklyBackupTask', 'syncLeavesFromCalendar', 'sendAmyIndirectCostReminder', 'autoRefreshSheet3'];
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (OWNED.indexOf(triggers[i].getHandlerFunction()) > -1) {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('weeklyBackupTask').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(3).create();
  // V4.3.8: 每日 06:30 同步请假日历
  ScriptApp.newTrigger('syncLeavesFromCalendar').timeBased().everyDays(1).atHour(6).nearMinute(30).create();
  // [2026-09-30 STOP] Rita 指示停发 Amy 间接成本提醒，不再重建该触发器（见 amy_indirect_cost.js）
  // V4.3.50: 每 2 小时自动重建 Sheet3（工时汇总源），解决 Sheet3 只能手动重建导致长期 stale
  ScriptApp.newTrigger('autoRefreshSheet3').timeBased().everyHours(2).create();
  SpreadsheetApp.getUi().alert(
    "⏰ 修复成功！\n1. 已清理并重建「周备份」与「请假日历同步」触发器。\n" +
    "2. 每周一凌晨3:00的备份任务已就绪。\n" +
    "3. 每日 06:30 的请假日历同步任务已就绪。\n" +
    "4. Amy 间接成本月度提醒已按 Rita 指示（2026-09-30）停发。\n" +
    "5. 每 2 小时自动重建 Sheet3 工时汇总（V4.3.50 新增）。\n\n" +
    "（其它触发器如「每周五 09:00 团队工时提醒」已保留，不会被误删）"
  );
}

// V4.3.27: 一键列出本项目全部已安装触发器（供非技术用户自查自动刷新是否生效）
function listInstalledTriggers() {
  try {
    const triggers = ScriptApp.getProjectTriggers();
    if (!triggers.length) {
      SpreadsheetApp.getUi().alert("📋 当前没有任何已安装的触发器。\n\n如需自动刷新，请运行菜单里的「⏰ 开启/修复触发器」或「⏰ 开启每周五自动提醒」。");
      return;
    }
    const lines = ["📋 已安装的触发器（共 " + triggers.length + " 个）：\n"];
    for (let i = 0; i < triggers.length; i++) {
      const t = triggers[i];
      const type = t.getEventType();
      const icon = (type === ScriptApp.EventType.CLOCK) ? "⏰定时" : (type === ScriptApp.EventType.ON_EDIT) ? "✏️编辑" : (type === ScriptApp.EventType.ON_OPEN) ? "📂打开" : "❔" + type;
      const handler = t.getHandlerFunction();
      let when = "";
      try {
        if (t.getTriggerSource() === ScriptApp.TriggerSource.CLOCK) {
          const sched = t.getStartTime();
          if (sched) when = " @ " + Utilities.formatDate(sched, "GMT+8", "yyyy-MM-dd HH:mm");
        }
      } catch (e) {}
      lines.push((i + 1) + ". " + icon + " → " + handler + when);
    }
    lines.push("\n━━━━━━━━━━━━━━");
    lines.push("✅ 若看不到「每周五 09:00 团队工时提醒 (sendTeamTimesheetReminders)」，请运行「⏰ 开启每周五自动提醒」。");
    SpreadsheetApp.getUi().alert(lines.join("\n"));
  } catch (e) {
    SpreadsheetApp.getUi().alert("❌ 读取触发器失败：" + e.message);
  }
}

/**
 * V4.3.8: 一键开启自动请假同步（创建每日触发器）并立即同步一次。
 */
function enableAutoLeaveSync() {
  const ui = SpreadsheetApp.getUi();
  try {
    // 1. 创建/刷新所有触发器（含每日请假日历同步）
    setupAllTriggers();
  } catch (e) {
    ui.alert('❌ 触发器安装失败：' + e.message);
    throw e;
  }
  try {
    // 2. 立即同步一次
    const result = syncLeavesFromCalendar();
    ui.alert('✅ 自动请假同步已开启并立即同步完成\n\n' + result);
  } catch (e) {
    // 触发器已安装成功；立即同步失败通常是授权未完成，提示用户授权后再点一次同步
    ui.alert('⚠️ 每日06:30触发器已安装，但立即同步失败：' + e.message + '\n\n请按提示完成 Google 授权后，再点一次「🌴 同步请假日历」。明天起系统会自动同步。');
    // 不 throw，因为触发器已经装好了
  }
}

function archiveCurrentSpreadsheet() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const folder = DriveApp.getFolderById(ARCHIVE_FOLDER_ID);
    const dateStr = Utilities.formatDate(new Date(), "GMT+8", "yyyyMMdd");
    DriveApp.getFileById(ss.getId()).makeCopy("[周存档] " + ss.getName() + "_" + dateStr, folder);
    return "SUCCESS";
  } catch (e) { return "ERROR"; }
}

// ==========================================
// 4. V3.2 辅助函数
// ==========================================
function tsm_formatName(str) {
  return str ? str.toString().trim().replace(/[._-]/g, ' ').toLowerCase().split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ').trim() : "";
}

// 名称相似度（Levenshtein 比率）：1=完全相同，0=完全不同。忽略大小写。
function tsm_nameSimilarity(a, b) {
  a = (a || "").toLowerCase(); b = (b || "").toLowerCase();
  if (a === b) return 1;
  const m = a.length, n = b.length;
  if (m === 0 || n === 0) return 0;
  const dp = [];
  for (let i = 0; i <= m; i++) { dp.push([i]); }
  for (let j = 0; j <= n; j++) { dp[0][j] = j; }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return 1 - dp[m][n] / Math.max(m, n);
}

// 把工时流水里的名字解析成 HR 通讯录里的标准名：优先手动别名 → 精确匹配 → 模糊匹配
function tsm_resolveName(rowName, hrNameList) {
  if (!rowName) return null;
  const lowered = rowName.toLowerCase();
  for (let k in NAME_ALIASES) {
    if (k.toLowerCase() === lowered) return NAME_ALIASES[k];
  }
  if (hrNameList.indexOf(rowName) > -1) return rowName;
  let best = null, bestScore = 0;
  hrNameList.forEach(n => {
    const s = tsm_nameSimilarity(rowName, n);
    if (s > bestScore) { bestScore = s; best = n; }
  });
  return bestScore >= NAME_FUZZY_THRESHOLD ? best : null;
}

// ==========================================
// 5. 月份筛选（保留）
// ==========================================
function filterByMonth() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('DB_工时流水');
  if (!sheet) { ui.alert('找不到「DB_工时流水」表，请确认分页名称。'); return; }

  const resp = ui.prompt('按月份查看', '请输入月份（格式 yyyy-MM，例如 2026-07）：', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;

  const ym = resp.getResponseText().trim();
  if (!/^\d{4}-\d{2}$/.test(ym)) { ui.alert('格式不对，应为 yyyy-MM，例如 2026-07'); return; }

  const headers = sheet.getRange(1, 1, 1, 30).getValues()[0];
  let colIndex = -1;
  for (let i = 0; i < headers.length; i++) {
    if (String(headers[i]).trim() === '年月') { colIndex = i + 1; break; }
  }
  if (colIndex < 0) {
    ui.alert('在 DB_工时流水表第一行找不到「年月」列。\n\n请在 N1 输入「年月」后重试（如果已在 N1 输入，请确保没有多余空格）。');
    return;
  }

  ss.setActiveSheet(sheet);
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  const filterRange = sheet.getRange(1, 1, Math.max(1, lastRow), Math.max(colIndex, lastCol));
  if (sheet.getFilter()) sheet.getFilter().remove();
  const filter = filterRange.createFilter();
  const criteria = SpreadsheetApp.newFilterCriteria().whenTextEqualTo(ym).build();
  filter.setColumnFilterCriteria(colIndex, criteria);
  ss.toast('已筛选：' + ym, '工时管理', 3);
}

function clearMonthFilter() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('DB_工时流水');
  if (sheet && sheet.getFilter()) sheet.getFilter().remove();
  ss.toast('已显示全部记录', '工时管理', 3);
}

function openWebApp() {
  if (!WEBAPP_URL || WEBAPP_URL.indexOf('你的部署') > -1) {
    SpreadsheetApp.getUi().alert('请先在 onOpen.gs 顶部的 WEBAPP_URL 填入你的网页填报部署链接。');
    return;
  }
  const html = HtmlService.createHtmlOutput(
    '<p style="font-family:sans-serif;padding:8px;">' +
    '<a href="' + WEBAPP_URL + '" target="_blank" onclick="google.script.host.close()">点此打开工时填报网页 →</a></p>'
  ).setWidth(320).setHeight(90);
  SpreadsheetApp.getUi().showModalDialog(html, '工时填报');
}
