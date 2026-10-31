/**
 * T1-B 阶段B 非生产实验 · 写者项目（模拟 W3 无锁独立写者 / W4 新项目）
 * 与 writerB 为两个"独立 script 项目"（不同 scriptId），用于实证跨项目锁语义。
 * 仅读写传入的隔离测试表 ssId；不读主库/生产表；不充当任何正式填报入口。
 *
 * 远程调用（由 Python 经临时 web app 引导触发，跑完即删部署，净零链接）：
 *   doGet(e): ?mode=run&useShared=0|1&sleep=4000&name=writerX  -> 跑一次 runTest 并返回文本
 *   doGet(e): ?mode=install&useShared=0|1 -> 装一个 90s 后触发 runTest 的定时触发器（用于并发演练）
 */
function runTest(ssId, writerName, sleepMs, useShared) {
  var sheet = SpreadsheetApp.openById(ssId).getSheets()[0];
  var start = new Date();
  var acquired = false, lockRef = null;
  try {
    if (useShared) {
      var r = SharedLockLib.acquireLock('t1b-exp-guard', 30000);
      acquired = r.acquired; lockRef = 'SHARED_LIB';
    } else {
      var lock = LockService.getScriptLock();
      acquired = lock.tryLock(30000); lockRef = 'OWN_PROJECT';
    }
    var seq = sheet.getLastRow();
    sheet.appendRow([start.toISOString(), writerName, lockRef, 'ACQUIRED', acquired ? 1 : 0, seq, '']);
    if (acquired) Utilities.sleep(sleepMs || 4000);
  } finally { /* own 锁 tryLock 后自动释放；shared 库锁同理 */ }
  var end = new Date();
  sheet.appendRow([end.toISOString(), writerName, lockRef, 'RELEASED', acquired ? 1 : 0, seq, '']);
  return { writer: writerName, acquired: acquired, lockRef: lockRef,
           start: start.toISOString(), end: end.toISOString() };
}

function guardTest(ssId) {
  var verdict = SharedLockLib.guardCheck(ssId); // E3 单一受信源读冻结
  SpreadsheetApp.openById(ssId).getSheets()[0].appendRow(
    [new Date().toISOString(), 'GUARD', 'freeze', verdict, verdict === 'PERIOD_LOCKED' ? 1 : 0, '', '']);
  return verdict;
}

function setFreeze(ssId, val) { return SharedLockLib.writeFreeze(ssId, val); }
function register(ssId, name) { return SharedLockLib.registerWriter(ssId, name); }

function doGet(e) {
  var p = e.parameter || {};
  var sid = p.ssId || '';
  if (p.mode === 'install') {
    var us = (p.useShared === '1');
    ScriptApp.newTrigger(us ? 'runShared' : 'runOwn')
      .timeBased().after(90000).create();
    return ContentService.createTextOutput('trigger installed useShared=' + us);
  }
  if (p.mode === 'run') {
    var r = runTest(sid, p.name || 'writerX', parseInt(p.sleep || '4000', 10), p.useShared === '1');
    return ContentService.createTextOutput(JSON.stringify(r));
  }
  if (p.mode === 'read') {
    var rows = SpreadsheetApp.openById(sid).getSheets()[0].getDataRange().getValues();
    return ContentService.createTextOutput(JSON.stringify(rows));
  }
  if (p.mode === 'setfreeze') {
    var fv = SharedLockLib.writeFreeze(sid, p.val === '1' ? 1 : 0);
    return ContentService.createTextOutput('freeze=' + fv);
  }
  if (p.mode === 'guard') {
    var v = SharedLockLib.guardCheck(sid);
    SpreadsheetApp.openById(sid).getSheets()[0].appendRow(
      [new Date().toISOString(), 'GUARD', 'freeze', v, v === 'PERIOD_LOCKED' ? 1 : 0, '', '']);
    return ContentService.createTextOutput(v);
  }
  return ContentService.createTextOutput('bad mode');
}

function runOwn() { runTest(SSID, 'writerTrig', 4000, false); }
function runShared() { runTest(SSID, 'writerTrig', 4000, true); }
// 触发器内拿不到参数，故 SSID 由 bootstrap 写入（仅本实验）；生产代码不依赖此。
var SSID = 'REPLACE_SSID';
