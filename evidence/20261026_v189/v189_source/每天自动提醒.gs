/**
 * V4.3.25 #658: 每周五 09:00 由 Luby 邮箱给「本周还没填齐工时」的人发警告提醒
 * - 仅统计本周（周一 ~ 今天）工作日，某天工时 < 8 即视为未完成
 * - 发件人显示为 Luby（replyTo 回 Luby 真邮箱），提醒将影响当月考勤记录
 * - 触发器 setupTimesheetFridayReminder() 每周五 09:00 触发；也可菜单「📧 发送提醒」立即发
 */
// V4.3.77 [2026-10-15] Rita 指示：停用周五工时提醒邮件（先不发）。
// 开关置于函数最前端 ⇒ 定时触发与菜单「📧 发送提醒」手动调用均受控；
// 停用时只写内部台账 + 本地提示，不读任何表、不发任何邮件、不删任何触发器。
// 恢复：把 false 改 true、推一次 HEAD 即可，触发器无需重建。
const TIMESHEET_REMINDER_ENABLED = false;

function sendTeamTimesheetReminders() {
  if (!TIMESHEET_REMINDER_ENABLED) {
    try { _tsWriteLog('friday_reminder_disabled', 'Rita 2026-10-15 指示停用；触发器保留，改 true 后自动恢复'); } catch (e) {}
    try { SpreadsheetApp.getUi().toast('⚪ 周五工时提醒已停用（Rita 2026-10-15 指示）', '工时提醒', 5); } catch (e) {}
    return;
  }
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1. 获取人员名单（邮箱）
  const userSheet = ss.getSheetByName("人员名单");
  if (!userSheet) {
    console.error("找不到名为 '人员名单' 的分页，请检查页面名称！");
    return;
  }
  const userData = userSheet.getDataRange().getValues();
  const emailMap = {};
  for (let i = 1; i < userData.length; i++) {
    const nameKey = userData[i][0].toString().trim();
    const emailVal = userData[i][1].toString().trim();
    if (nameKey) emailMap[nameKey] = emailVal;
  }

  // 2. 获取工时数据主表
  const dataSheet = ss.getSheets()[0];
  const data = dataSheet.getDataRange().getValues();
  const tz = "GMT+8";
  const todayStr = Utilities.formatDate(new Date(), tz, "yyyy/MM/dd");
  const spreadsheetUrl = ss.getUrl();

  // 3. 本周一 00:00 作为统计起点
  const now = new Date();
  const dow = now.getDay(); // 0=周日
  const mondayOffset = (dow === 0) ? -6 : (1 - dow);
  const monday = new Date(now);
  monday.setDate(now.getDate() + mondayOffset);
  monday.setHours(0, 0, 0, 0);
  const mondayStr = Utilities.formatDate(monday, tz, "yyyy/MM/dd");

  const BLACK = (typeof BLACKLIST !== 'undefined') ? BLACKLIST : [];

  // 4. 统计每人本周未完成的工作日
  const incompleteMap = {};
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const nameInSheet = row[0].toString().trim();
    const dateValue = row[2];
    const hoursFilled = parseFloat(row[3]) || 0;

    if (!nameInSheet) continue;
    if (BLACK.indexOf(nameInSheet) > -1) continue;

    // 解析日期（兼容 Date 与可转 Date 的值）
    let d = null;
    if (dateValue instanceof Date) d = dateValue;
    else if (dateValue) { const t = new Date(dateValue); if (!isNaN(t.getTime())) d = t; }
    if (!d) continue;

    const dStr = Utilities.formatDate(d, tz, "yyyy/MM/dd");
    if (dStr < mondayStr || dStr > todayStr) continue; // 仅本周一 ~ 今天
    const dw = d.getDay();
    if (dw === 0 || dw === 6) continue; // 周末不计入

    if (hoursFilled < 8) {
      if (!incompleteMap[nameInSheet]) incompleteMap[nameInSheet] = [];
      const md = Utilities.formatDate(d, tz, "MM/dd");
      incompleteMap[nameInSheet].push(md + " (" + hoursFilled + "h)");
    }
  }

  // 5. 逐个发送（从 Luby 邮箱发出）
  let sent = 0;
  for (const name in incompleteMap) {
    const targetEmail = emailMap[name];
    if (!targetEmail) { console.warn("未能在'人员名单'中找到 " + name + " 的邮箱"); continue; }
    sendFridayReminder(targetEmail, name, incompleteMap[name], spreadsheetUrl);
    sent++;
  }
  console.log("周五提醒已发送 " + sent + " 封（本周未完成人数）");
  try { SpreadsheetApp.getUi().toast("📧 周五提醒已发送 " + sent + " 封", "工时提醒", 5); } catch (e) {}
}

function sendFridayReminder(email, name, days, url) {
  const subject = "[工时填报警告 / Timesheet Alert] " + name + "，你本周还有 " + days.length + " 天工时未填齐，将影响当月考勤记录";
  const dayList = days.map(function(d) { return "  • " + d; }).join("\n");
  const body =
    "你好 " + name + "，\n\n" +
    "系统检测到你本周（周一至今）以下工作日的工时记录尚未填齐（不足 8 小时）：\n" +
    dayList + "\n\n" +
    "⚠️ 重要提醒：工时记录是考勤依据。请务必在本月内（建议次月 5 日前）补齐上述日期的工时，\n" +
    "逾期未完成将计入考勤异常，影响当月出勤与薪资核算。\n\n" +
    "请尽快登录填写：" + url + "\n\n" +
    "— Luby Huang (Space Matrix 运营)";
  MailApp.sendEmail({
    to: email,
    subject: subject,
    body: body,
    name: "Luby",
    replyTo: "luby@spacematrix.com"
  });
  console.log("周五提醒已发送至：" + name + " (" + email + ")");
}

/**
 * V4.3.25 #658: 设置「每周五 09:00」自动提醒触发器（幂等，重复运行只保留一个）
 */
function setupTimesheetFridayReminder() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'sendTeamTimesheetReminders') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('sendTeamTimesheetReminders')
    .timeBased().onWeekDay(ScriptApp.WeekDay.FRIDAY).atHour(9).create();
  SpreadsheetApp.getUi().alert(
    "⏰ 每周五 09:00 自动提醒已开启！\n\n" +
    "每周五上午 9 点，系统会以 Luby 的邮箱给本周工时未填齐的同事发送警告提醒，\n" +
    "提醒其尽快补齐，逾期将影响当月考勤记录。\n\n" +
    "（也可在「📧 发送提醒」菜单立即手动发送一次）"
  );
}
