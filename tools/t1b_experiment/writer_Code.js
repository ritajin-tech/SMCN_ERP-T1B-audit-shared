/**
 * T1-B 阶段B 非生产实验 · 写者项目（模拟 W3 无锁独立写者 / W4 新项目）v4
 * 与 writerB 为两个"独立 script 项目"（不同 scriptId），用于实证跨项目锁语义。
 * 仅读写传入的隔离测试表 ssId；不读主库/生产表；不充当任何正式填报入口。
 *
 * v4 修订（响应 Tom 10:51Z）：
 *  #1 OWN 负对照 = 写者本地持自身 getScriptLock 做受保护写（ACQUIRED/RELEASED 在锁内本地记录），跨项目不互斥，复现漏洞；
 *     CENTRAL 正例 = 受保护写整体 funnel 进集中锁端点（端点内真正持锁+闸+写+释放，权威日志含单调 fencing 令牌），跨项目互斥。
 *  #2 释放/结果透传：CENTRAL 模式下 released 由集中端点 finally 真实决定；writer 据其记 OK/REJECTED/FAIL，绝不伪造。
 */
var SSID = 'REPLACE_SSID';
var LOCKER_URL = 'REPLACE_LOCKER_URL'; // 集中锁端点部署 URL（非生产）；配置前 CENTRAL 模式返回 LOCKER_URL_NOT_CONFIGURED

function _execId() { return Utilities.getUuid(); }

function runTest(ssId, writerName, sleepMs, mode) {
  var eid = _execId();
  var start = new Date();
  var handleMode = (mode === 'OWN') ? 'OWN' : 'CENTRAL';
  // OWN：写者本地持自身锁做受保护写（ACQUIRED/RELEASED 在锁内本地记录）
  // CENTRAL：受保护写整体 funnel 进集中端点（端点内持锁+闸+写+释放，权威日志含 fencing 令牌）
  var r = SharedLockLib.guardedWrite(ssId, 't1b-exp-guard', eid, writerName, sleepMs || 4000, handleMode, LOCKER_URL, 'write');
  var end = new Date();
  // #2 释放/结果透传，不伪造
  var rel = r.released;
  var status = r.ok ? 'OK' : ((r.reason === 'PERIOD_LOCKED' || r.reason === 'UNKNOWN_REJECT') ? 'REJECTED' : 'FAIL');
  SharedLockLib.appendLog(ssId, [eid, end.toISOString(), writerName, handleMode, status, r.ok ? 1 : 0,
    'reason=' + (r.reason || '') + ' fence=' + (r.fencing || '') + ' rel=' + rel]);
  return { writer: writerName, acquired: r.ok, mode: handleMode, reason: r.reason, fencing: r.fencing, released: rel, execId: eid,
           start: start.toISOString(), end: end.toISOString() };
}

function guardTest(ssId) {
  var verdict = SharedLockLib.guardCheck(ssId);
  SharedLockLib.appendLog(ssId, [_execId(), new Date().toISOString(), 'GUARD', 'freeze', verdict, verdict === 'PERIOD_LOCKED' ? 1 : 0, '']);
  return verdict;
}

function setFreeze(ssId, val) { return SharedLockLib.guardedWriteFreeze(ssId, val, LOCKER_URL); }
function register(ssId, name, mode) {
  var eid = _execId();
  return SharedLockLib.guardedWrite(ssId, 't1b-exp-guard', eid, name, 0, mode || 'CENTRAL', LOCKER_URL, 'register');
}

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

function runOwn() { runTest(SSID, 'writerTrig', 4000, 'OWN'); }        // 负对照：本地自身锁，跨项目不互斥（复现漏洞 N2）
function runShared() { runTest(SSID, 'writerTrig', 4000, 'CENTRAL'); } // 正例：集中锁端点内真正持锁（E2 验证 N1）
