/**
 * ⏱️ TimeSheet Manager — 表格菜单 (onOpen)
 * 当前版本：V4.3.46 (refreshSheet3 末尾不再自动清理 Sheet1 飘红/悬浮备注 —— 用户体感"红字+悬浮功能没了"根因修复。两个功能解耦: Sheet1 飘红仅在「📊 刷新工时异常表」生成/更新; Sheet3 重建不再触碰 Sheet1。)
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

function onOpen(e) {
  SpreadsheetApp.getUi()
    .createMenu('👑 系统管理')
    .addItem('📊 刷新工时异常表', 'showMonthlyExceptionDialog')
    .addItem('📈 刷新 QS 看板', 'refreshQSBoard')
    .addItem('📋 重建 Sheet3 项目工时明细 (含清理 Sheet1 飘红)', 'refreshSheet3')
    .addItem('🔍 诊断 Sheet3 数据源', 'diagnoseSheet3Sources')
    .addItem('🧹 单独清理 Sheet1 条件格式 (去飘红/悬浮)', 'cleanSheet1LegacyHighlights')
    .addItem('🩹 清理重复请假记录', 'cleanupDuplicateLeavesInternal')
    .addItem('🧹 物理清理已删除记录', 'physicalPurgeDeleted')
    .addSeparator()
    .addItem('💾 立即执行周存档', 'archiveCurrentSpreadsheet')
    .addItem('⏰ 开启/修复触发器', 'setupAllTriggers')
    .addItem('🤖 开启自动请假同步', 'enableAutoLeaveSync')
    .addSeparator()
    .addItem('📥 抓取设计工时', 'fetchArchiveData')
    .addItem('📧 发送提醒', 'sendTeamTimesheetReminders')
    .addItem('⏰ 开启每周五自动提醒', 'setupTimesheetFridayReminder')
    .addSeparator()
    .addItem('📱 生成手机远程链接', 'showRemoteTriggerLinks')
    .addSeparator()
    .addItem('🌴 同步请假日历', 'syncLeavesFromCalendar')
    .addSeparator()
    .addItem('📋 列出已安装触发器 (自查)', 'listInstalledTriggers')
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
  const notesMap = {};
  for (let email in hrMap) {
    const empName = hrMap[email].name;
    if (!empName) continue;
    if (BLACKLIST.indexOf(empName) > -1) continue;
    if (resignedMap[empName]) continue;
    summary[empName] = {};
    tiaoxiuMap[empName] = {};
    notesMap[empName] = {};
    targetDates.forEach(d => {
      const dKey = Utilities.formatDate(d, "GMT+8", "yyyy-MM-dd");
      summary[empName][dKey] = 0;
      tiaoxiuMap[empName][dKey] = 0;
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
      } else if (h < 8 && tx === 0) {
        shortDays += 1;                                     // 既没干满、也没在调休 → 算缺填
      }
      if (tx > 0) tiaoxiuTotal += tx;                       // 调休工时累计
    });

    // 悬浮 note：当月汇总（加班 X 小时 / 调休 Y 小时 / 缺填 Z 天）+ 当日备注明细
    const noteLines = [];
    noteLines.push("📅 " + rawText + " 月度工时汇总");
    noteLines.push("🔴 加班：" + overtimeTotal.toFixed(1) + " 小时");
    noteLines.push("🟢 调休：" + tiaoxiuTotal.toFixed(1) + " 小时");
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
// 数据源 (均为真实口径, 不含折算):
//   1) DB_工时流水 (TS_ID 外部) —— 明细, 优先级最高
//      实际列: A=录入时间 / B=日期 / C=姓名 / D=阶段 / E=项目编号 / F=工时 / G=备注 / H=项目名 / I=主管 / O=是否删除
//   2) FY26工时 (本表) —— 真实月度汇总, 补充 DB_工时流水 未覆盖的历史月份
//      实际列: A=PROJECT# / B=PROJECT NAME / C=Total / D=Month / E=Employee Name
//   (FY26折算后工时 是折算浓缩数据, 非真实原始口径, 不并入)
// 去重: 按 "年月|项目编号|员工" 维度, DB_工时流水 已覆盖的月份不再用 FY26 汇总, 避免重复
// 排除: 休假 / OFF-WORK / 调休 / 年假 / 病假 / 事假 / 婚假 / 产假 / 丧假 / 已删除 / 工时 <= 0
function refreshSheet3() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
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

  // 1. 读 DB_工时流水 (明细, 优先级最高)
  // 实际列: A=录入时间 / B=日期 / C=姓名 / D=阶段 / E=项目编号 / F=工时 / G=备注 / H=项目名 / I=主管 / O=是否删除
  const dbSheet = SpreadsheetApp.openById(TS_ID).getSheetByName('DB_工时流水');
  if (dbSheet && dbSheet.getLastRow() >= 2) {
    const data = dbSheet.getRange(2, 1, dbSheet.getLastRow() - 1, Math.max(15, dbSheet.getLastColumn())).getValues();
    for (let i = 0; i < data.length; i++) {
      totalRead++;
      const r = data[i];
      const date = r[1];                                  // B=日期
      const englishName = String(r[2] || '').trim();       // C=姓名
      const phase = String(r[3] || '').trim();              // D=阶段
      const projNo = String(r[4] || '').trim();             // E=项目编号
      const hours = parseFloat(r[5]) || 0;                  // F=工时
      const remark = String(r[6] || '').trim();             // G=备注
      const projName = String(r[7] || '').trim();           // H=项目名
      const isDeleted = r[14] === true || String(r[14] || '').toUpperCase() === 'TRUE' || String(r[14]) === '1'; // O=是否删除

      if (isDeleted) { totalDeleted++; continue; }
      if (!(date instanceof Date) || isNaN(date.getTime())) { totalNoDate++; continue; }
      if (hours <= 0) { totalNoHours++; continue; }
      if (!projNo || EXCLUDE_PROJ.test(projNo)) { totalExcludedProj++; continue; }
      // DB_工时流水 没有独立"类型"列, 阶段列(D)即类型, 用 phase 做休假/非项目类型排除
      if (EXCLUDE_TYPES.test(phase)) { totalExcludedType++; continue; }

      // 记录该员工+项目+月份已有明细, FY26 汇总不再重复计入
      const mKey = Utilities.formatDate(date, 'GMT+8', 'yyyy-MM') + '|' + projNo + '|' + tsm_formatName(englishName);
      monthKeySet[mKey] = true;

      // V4.3.39: 全签名去重——同一条记录被双录(日期+姓名+阶段+项目+工时全相同)只保留第一条, 剔除水分
      const sig = Utilities.formatDate(date, 'GMT+8', 'yyyy-MM-dd') + '|' + englishName + '|' + phase + '|' + projNo + '|' + hours;
      if (dbDupSig[sig]) { totalDup++; continue; }
      dbDupSig[sig] = true;

      // DB_工时流水 无 UUID 列, 类型列置为"工时明细"
      rows.push(['DB_工时流水', date, englishName, '工时明细', phase, projNo, hours, remark, '', projName]);
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
    '🧹 Sheet1 飘红/悬浮已自动清理';
  SpreadsheetApp.getUi().alert(msg);
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
      let validRows = 0, deletedRows = 0, noDate = 0, noHours = 0, offWork = 0, sumHours = 0;
      const projCounts = {};
      const nameCounts = {};
      const dateNameProjDup = {};
      const sigDupSet = {};
      let dupCount = 0;
      let exactDupCount = 0;

      for (let i = 0; i < data.length; i++) {
        const r = data[i];
        const date = r[1];                                   // B=日期
        const name = String(r[2] || '').trim();               // C=姓名
        const phase = String(r[3] || '').trim();              // D=阶段
        const projNo = String(r[4] || '').trim();             // E=项目编号
        const hours = parseFloat(r[5]) || 0;                  // F=工时
        const isDeleted = r[14] === true || String(r[14] || '').toUpperCase() === 'TRUE' || String(r[14]) === '1'; // O=是否删除

        if (isDeleted) { deletedRows++; continue; }
        if (!(date instanceof Date) || isNaN(date.getTime())) { noDate++; continue; }
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
      lines.push('  24-151-SH-M26 出现: ' + (projCounts['24-151-SH-M26'] || 0) + ' 次');
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
  const OWNED = ['weeklyBackupTask', 'syncLeavesFromCalendar', 'sendAmyIndirectCostReminder'];
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (OWNED.indexOf(triggers[i].getHandlerFunction()) > -1) {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('weeklyBackupTask').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(3).create();
  // V4.3.8: 每日 06:30 同步请假日历
  ScriptApp.newTrigger('syncLeavesFromCalendar').timeBased().everyDays(1).atHour(6).nearMinute(30).create();
  // Amy 间接成本月度提醒：每日 09:00 检查，命中「当月最后一个工作日」才发（见 amy_indirect_cost.js）
  ScriptApp.newTrigger('sendAmyIndirectCostReminder').timeBased().everyDays(1).atHour(9).create();
  SpreadsheetApp.getUi().alert(
    "⏰ 修复成功！\n1. 已清理并重建「周备份」与「请假日历同步」触发器。\n" +
    "2. 每周一凌晨3:00的备份任务已就绪。\n" +
    "3. 每日 06:30 的请假日历同步任务已就绪。\n" +
    "4. 每日 09:00 检查「Amy 间接成本月度提醒」（最后一个工作日发给 Amy）。\n\n" +
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
