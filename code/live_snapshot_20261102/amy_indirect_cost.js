/**
 * Amy 间接成本月度提醒（挂在已有的 Timesheet 管理器项目里，复用其 MailApp 与触发器机制）
 * - 每月「最后一个工作日」09:00 由 Rita 的 Gmail 给 Amy Weng 发提醒，更新间接成本
 * - 用 ScriptProperties 记「本月已发」，避免重复发送
 * - 安装：setupAmyMonthlyReminder()（经菜单或 clasp run 跑一次即可，无需手动在 Google UI 点）
 */

const AMY_EMAIL = "amy.weng@spacematrix.com";
const AMY_NAME  = "Amy Weng";
const AMY_SHEET_URL = ""; // 间接成本台账链接；留空则不附带，可后续填

/**
 * 主函数：判定今天是否为当月最后一个工作日，是则发提醒。由每日 09:00 触发器调用。
 */
function sendAmyIndirectCostReminder() {
  // V4.3.30: 每日09:00自检，若请假同步触发器被删则重建（需已授权上下文）
  if (typeof ensureLeaveSyncTrigger === 'function') ensureLeaveSyncTrigger();

  // [2026-09-30 STOP] Rita 指示停发 Amy 间接成本提醒邮件。本函数保留仅为
  // leave sync 触发器自检入口，不再发送任何邮件。如需恢复：还原本函数体。
  console.log("[Amy间接成本] 已按 Rita 指示（2026-09-30）停发，跳过。");
  return;

  const today = new Date();
  if (!isLastWorkingDayOfMonth(today)) {
    console.log("[Amy间接成本] 今天不是最后一个工作日，跳过。");
    return;
  }
  const props = PropertiesService.getScriptProperties();
  const monthKey = Utilities.formatDate(today, "GMT+8", "yyyy-MM");
  if (props.getProperty("amyIndirectCostSentMonth") === monthKey) {
    console.log("[Amy间接成本] 本月已发过（" + monthKey + "），跳过。");
    return;
  }
  try {
    amySendMail();
    props.setProperty("amyIndirectCostSentMonth", monthKey);
    console.log("[Amy间接成本] 已发送 → " + AMY_EMAIL + "（" + monthKey + "）");
  } catch (e) {
    console.error("[Amy间接成本] 发送失败：" + e.message);
  }
}

/**
 * 实际发信（来自 Rita 的 Gmail / MailApp）
 */
function amySendMail() {
  const url = AMY_SHEET_URL && AMY_SHEET_URL.trim() ? AMY_SHEET_URL.trim()
            : (SpreadsheetApp.getActiveSpreadsheet() ? SpreadsheetApp.getActiveSpreadsheet().getUrl() : "（请在间接成本台账中更新）");
  const subject = "[间接成本更新提醒 / Indirect Cost Update] 请于本月底（最后一个工作日）前完成更新";
  const body =
    "你好 " + AMY_NAME + "，\n\n" +
    "本月底将至，请记得在「当月最后一个工作日」前完成各项目的「间接成本（Indirect Cost）」更新，" +
    "以确保月度财务数据准确。\n\n" +
    "更新入口：" + url + "\n\n" +
    "如已完成可忽略本邮件；如有疑问请直接回复。\n\n" +
    "祝工作顺利！\n" +
    "Rita";
  MailApp.sendEmail({
    to: AMY_EMAIL,
    subject: subject,
    body: body,
    name: "Rita"
  });
  console.log("[Amy间接成本] 邮件已发送至：" + AMY_NAME + " (" + AMY_EMAIL + ")");
}

/**
 * 安装「每日 09:00」触发器（幂等：重复运行只保留一个）
 */
function setupAmyMonthlyReminder() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "sendAmyIndirectCostReminder") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger("sendAmyIndirectCostReminder")
    .timeBased().everyDays(1).atHour(9).create();
  console.log("⏰ Amy 间接成本提醒已开启：每日 09:00 检查，命中最后一个工作日才发。");
}

/**
 * 立即给 Amy 发一封（验证用，会真实发出）
 */
function testSendAmyNow() {
  try { amySendMail(); console.log("[测试] 已发送给 Amy：" + AMY_EMAIL); }
  catch (e) { console.error("[测试] 失败：" + e.message); }
}

/**
 * 立即给自己（Rita）发一封同样内容的测试，验证发件人确实是 Rita 的 Gmail、内容无误
 */
function testSendAmySelf() {
  const url = AMY_SHEET_URL && AMY_SHEET_URL.trim() ? AMY_SHEET_URL.trim() : "（请在间接成本台账中更新）";
  const subject = "[测试 / Test] 间接成本更新提醒（发件人验证）";
  const body =
    "你好 " + AMY_NAME + "，\n\n" +
    "本月底将至，请记得在「当月最后一个工作日」前完成各项目的「间接成本（Indirect Cost）」更新，" +
    "以确保月度财务数据准确。\n\n" +
    "更新入口：" + url + "\n\n" +
    "如已完成可忽略本邮件；如有疑问请直接回复。\n\n" +
    "祝工作顺利！\n" +
    "Rita";
  MailApp.sendEmail({ to: Session.getActiveUser().getEmail(), subject: subject, body: body, name: "Rita" });
  console.log("[测试] 已发送给本人（" + Session.getActiveUser().getEmail() + "）验证用。");
}

/**
 * 判定给定日期是否为当月最后一个工作日（周末回退到周五）
 */
function isLastWorkingDayOfMonth(d) {
  const year = d.getFullYear();
  const month = d.getMonth();
  const lastDay = new Date(year, month + 1, 0);
  let lastWork = new Date(lastDay);
  while (lastWork.getDay() === 0 || lastWork.getDay() === 6) {
    lastWork.setDate(lastWork.getDate() - 1);
  }
  return d.getFullYear() === lastWork.getFullYear() &&
         d.getMonth() === lastWork.getMonth() &&
         d.getDate() === lastWork.getDate();
}
