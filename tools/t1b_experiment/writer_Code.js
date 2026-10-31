/**
 * T1-B 阶段B 非生产实验 · 写者项目（模拟 W3 无锁独立写者 / W4 新项目）
 * 与 writerB 为两个"独立 script 项目"（不同 scriptId），用于实证跨项目锁语义。
 * 仅读写传入的隔离测试表 ssId；不读主库/生产表；不充当任何正式填报入口。
 *
 * v3 修订（响应 Tom 09:51Z 静态复核）：
 *  #1 runOwn=OWN 负对照（写者自身锁，跨项目不互斥，复现漏洞）；runShared=CENTRAL 正例（集中锁，跨项目互斥）
 *  #2 释放状态透传：RELEASED 仅当 release.ok；否则记 RELEASE_FAIL，绝不伪造成功
 *  #3 setfreeze 走 guardedWriteFreeze（与受保护写同一协调域）
 *  #4 日志写入独立 log sheet + execId 关联；业务写（ACQUIRED）在受保护区间内
 */
var SSID = 'REPLACE_SSID';
var LOCKER_URL = 'REPLACE_LOCKER_URL'; // 集中锁端点部署 URL（非生产）；配置前 CENTRAL 模式返回 LOCKER_URL_NOT_CONFIGURED

function _execId() { return Utilities.getUuid(); }

function runTest(ssId, writerName, sleepMs, mode) {
  var eid = _execId();
  var sheet = SpreadsheetApp.openById(ssId).getSheets()[0];
  var start = new Date();
  var handleMode = (mode === 'OWN') ? 'OWN' : 'CENTRAL'; // OWN = 负对照；CENTRAL = 正例
  // 真实受保护写路径：锁 + 冻结闸 + 业务写（ACQUIRED 即模拟一次受保护写）同域（guardedWrite 内）
  var r = SharedLockLib.guardedWrite(ssId, 't1b-exp-guard', function () {
    var seq = sheet.getLastRow();
    SharedLockLib.appendLog(ssId, [eid, start.toISOString(), writerName, handleMode, 'ACQUIRED', 1, 'seq=' + seq]);
    Utilities.sleep(sleepMs || 4000);
    return { seq: seq };
  }, handleMode, LOCKER_URL);
  var end = new Date();
  // #2 释放状态透传：仅 release.ok 才记 RELEASED；释放失败/未知记 RELEASE_FAIL（不伪造）；未取得锁/冻结拒写记 REJECTED
  var rel = r.release;
  if (r.ok && rel && rel.released) {
    SharedLockLib.appendLog(ssId, [eid, end.toISOString(), writerName, handleMode, 'RELEASED', 1, 'released']);
  } else if (r.ok) {
    SharedLockLib.appendLog(ssId, [eid, end.toISOString(), writerName, handleMode, 'RELEASE_FAIL', 0, JSON.stringify(rel || {})]);
  } else {
    SharedLockLib.appendLog(ssId, [eid, end.toISOString(), writerName, handleMode, 'REJECTED', 0, r.reason]);
  }
  return { writer: writerName, acquired: r.ok, mode: handleMode, reason: r.reason, release: rel, execId: eid,
           start: start.toISOString(), end: end.toISOString() };
}

function guardTest(ssId) {
  var verdict = SharedLockLib.guardCheck(ssId);
  SharedLockLib.appendLog(ssId, [_execId(), new Date().toISOString(), 'GUARD', 'freeze', verdict, verdict === 'PERIOD_LOCKED' ? 1 : 0, '']);
  return verdict;
}

function setFreeze(ssId, val) { return SharedLockLib.guardedWriteFreeze(ssId, val, LOCKER_URL); }
function register(ssId, name, mode) { return SharedLockLib.guardedRegister(ssId, name, mode || 'CENTRAL', LOCKER_URL); }

function doGet(e) {
  var p = e.parameter || {};
  var sid = p.ssId || SSID;
  if (p.mode === 'install') {
    var m = (p.lockMode === 'OWN') ? 'runOwn' : 'runShared'; // 明确区分负对照 / 正例触发器
    ScriptApp.newTrigger(m).timeBased().after(90000).create();
    return ContentService.createTextOutput('trigger installed ' + m);
  }
  if (p.mode === 'run') {
    var r = runTest(sid, p.name || 'writerX', parseInt(p.sleep || '4000', 10), p.lockMode || 'CENTRAL');
    return ContentService.createTextOutput(JSON.stringify(r));
  }
  if (p.mode === 'read') {
    var rows = SpreadsheetApp.openById(sid).getSheets()[0].getDataRange().getValues();
    return ContentService.createTextOutput(JSON.stringify(rows));
  }
  if (p.mode === 'setfreeze') {
    var fv = setFreeze(sid, p.val === '1' ? 1 : 0);
    return ContentService.createTextOutput('freeze=' + JSON.stringify(fv));
  }
  if (p.mode === 'guard') {
    var v = guardTest(sid);
    return ContentService.createTextOutput(v);
  }
  return ContentService.createTextOutput('bad mode');
}

function runOwn() { runTest(SSID, 'writerTrig', 4000, 'OWN'); }        // 负对照：自身锁，跨项目不互斥（复现漏洞 N2）
function runShared() { runTest(SSID, 'writerTrig', 4000, 'CENTRAL'); } // 正例：集中锁，跨项目互斥（E2 验证 N1）
