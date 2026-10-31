/**
 * T1-B 阶段B 非生产实验 · 写者项目（模拟 W3 无锁独立写者 / W4 新项目）
 * 与 writerB 为两个"独立 script 项目"（不同 scriptId），用于实证跨项目锁语义。
 * 仅读写传入的隔离测试表 ssId；不读主库/生产表；不充当任何正式填报入口。
 *
 * v2 修订（响应 Tom 09:03Z 静态评审）：
 *  - runTest 改为经 guardedWrite：锁未取到或冻结 -> 记 REJECTED，绝不伪造 RELEASED（修复发现#2）
 *  - ACQUIRED 仅在真正持锁且通过冻结闸后记录；RELEASED 仅在实际释放后记录（修复发现#2）
 *  - 受保护区间 = guardedWrite 内；锁柄显式释放（修复发现#3）
 *  - guard 闸与真实受保护写路径同域绑定（修复发现#4）
 */
function runTest(ssId, writerName, sleepMs, useShared) {
  var sheet = SpreadsheetApp.openById(ssId).getSheets()[0];
  var start = new Date();
  var ref = useShared ? 'SHARED_LIB' : 'OWN_PROJECT';
  // 真实受保护写路径：锁 + 冻结闸 + 写 同域（guardedWrite 内）
  var r = SharedLockLib.guardedWrite(ssId, 't1b-exp-guard', function () {
    var seq = sheet.getLastRow();
    sheet.appendRow([start.toISOString(), writerName, ref, 'ACQUIRED', 1, seq, '']);
    Utilities.sleep(sleepMs || 4000);
    return { seq: seq };
  });
  var end = new Date();
  if (r.ok) {
    // 仅在实际释放后记录 RELEASED，绝不伪造
    sheet.appendRow([end.toISOString(), writerName, ref, 'RELEASED', 1, sheet.getLastRow(), 'released']);
  } else {
    // 未取得锁 / 冻结拒写 -> 记 REJECTED，不得进入受保护写入，不得伪造 RELEASED
    sheet.appendRow([end.toISOString(), writerName, ref, 'REJECTED', 0, sheet.getLastRow(), r.reason]);
  }
  return { writer: writerName, acquired: r.ok, reason: r.reason, lockRef: ref,
           start: start.toISOString(), end: end.toISOString() };
}

function guardTest(ssId) {
  var verdict = SharedLockLib.guardCheck(ssId);
  SpreadsheetApp.openById(ssId).getSheets()[0].appendRow(
    [new Date().toISOString(), 'GUARD', 'freeze', verdict, verdict === 'PERIOD_LOCKED' ? 1 : 0, '', '']);
  return verdict;
}

function setFreeze(ssId, val) { return SharedLockLib.writeFreeze(ssId, val); }
function register(ssId, name) { return SharedLockLib.guardedRegister(ssId, name); }

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
