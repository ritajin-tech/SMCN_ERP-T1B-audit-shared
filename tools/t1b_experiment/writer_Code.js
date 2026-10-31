/**
 * T1-B 阶段B 非生产实验 · 写者项目（模拟 W3 无锁独立写者 / W4 新项目）v6
 * 与 writerB 为两个"独立 script 项目"（不同 scriptId），用于实证跨项目锁语义。
 * 仅读写传入的隔离测试表 ssId；不读主库/生产表；不充当任何正式填报入口。
 *
 * v6 修订（响应 Tom 11:51Z）：
 *  #4 setFreeze 透传原始 val 字符串（不再静默把非'1'转 0 绕过端点严格解析）；
 *     新增 crashsim 透传（runTest 支持崩溃窗口仿真）与 reconcile 触发器（崩溃后恢复核证）。
 *  #3 释放/结果透传：CENTRAL 模式 released 由集中端点 finally 真实决定；本文件据其记 OK/REJECTED/FAIL/RELEASE_FAIL，绝不伪造。
 */
var SSID = 'REPLACE_SSID';
var LOCKER_URL = 'REPLACE_LOCKER_URL'; // 集中锁端点部署 URL（非生产）；配置前 CENTRAL 模式返回 LOCKER_URL_NOT_CONFIGURED

function _execId() { return Utilities.getUuid(); }

function runTest(ssId, writerName, sleepMs, mode, crashsim, payload, fixedEid) {
  var eid = fixedEid || _execId(); // v7 #1：fixedEid 支持重放演示（同身份应返回原凭据）
  var start = new Date();
  var handleMode = (mode === 'OWN') ? 'OWN' : 'CENTRAL';
  // OWN：写者本地持自身锁做受保护写（ACQUIRED/RELEASED 在锁内本地记录），跨项目不互斥，复现漏洞；
  // CENTRAL：受保护原子写整体 funnel 进集中端点（端点内真正持锁+闸+原子分类账写+释放），跨项目互斥。
  var r = SharedLockLib.guardedWrite(ssId, 't1b-exp-guard', eid, writerName, sleepMs || 4000, handleMode, LOCKER_URL, 'write', crashsim, payload || '');
  var end = new Date();
  var rel = r.released;
  var status = r.ok ? 'OK' : ((r.reason === 'PERIOD_LOCKED' || r.reason === 'UNKNOWN_REJECT' || r.reason === 'FENCE_CORRUPT_REJECT' || r.reason === 'FENCE_READ_REJECT' || r.reason === 'RECONCILE_PENDING_REJECT' || r.reason === 'EID_CONTENT_CONFLICT') ? 'REJECTED' : 'FAIL');
  SharedLockLib.appendLog(ssId, [eid, end.toISOString(), writerName, handleMode, status, r.ok ? 1 : 0,
    'reason=' + (r.reason || '') + ' fence=' + (r.fencing || '') + ' rel=' + rel + (r.replayed ? ' replayed=1' : '')]);
  return { writer: writerName, acquired: r.ok, mode: handleMode, reason: r.reason, fencing: r.fencing, released: rel, execId: eid, replayed: !!r.replayed,
           start: start.toISOString(), end: end.toISOString() };
}

function guardTest(ssId) {
  var verdict = SharedLockLib.guardCheck(ssId);
  SharedLockLib.appendLog(ssId, [_execId(), new Date().toISOString(), 'GUARD', 'freeze', verdict, verdict === 'PERIOD_LOCKED' ? 1 : 0, '']);
  return verdict;
}

function setFreeze(ssId, rawVal) {
  // v6 #4：透传原始 val 字符串，由端点严格解析（非'1'/'0' 一律 FREEZE_BAD_VALUE 拒绝）
  return SharedLockLib.guardedWriteFreeze(ssId, rawVal, LOCKER_URL);
}
function register(ssId, name, mode) {
  var eid = _execId();
  return SharedLockLib.guardedWrite(ssId, 't1b-exp-guard', eid, name, 0, mode || 'CENTRAL', LOCKER_URL, 'register');
}
function reconcile(ssId) { return SharedLockLib.reconcileLedger(ssId); }
function resolve(ssId, token) { return SharedLockLib.reconcileResolve(ssId, token); } // v7 #5 独立核验后才解锁

function doGet(e) {
  var p = e.parameter || {};
  var sid = p.ssId || SSID;
  if (p.mode === 'install') {
    var m = (p.lockMode === 'OWN') ? 'runOwn' : 'runShared';
    ScriptApp.newTrigger(m).timeBased().after(90000).create();
    return ContentService.createTextOutput('trigger installed ' + m);
  }
  if (p.mode === 'run') {
    // v7 #1 重放演示：传 eid 固定值 + 相同 payload → 应返回原凭据(replayed=1)；崩溃窗口仿真 crashsim=1
    var r = runTest(sid, p.name || 'writerX', parseInt(p.sleep || '4000', 10), p.lockMode || 'CENTRAL', p.crashsim === '1' ? '1' : '0', p.payload || '', p.eid || '');
    return ContentService.createTextOutput(JSON.stringify(r));
  }
  if (p.mode === 'read') {
    var rows = SpreadsheetApp.openById(sid).getSheets()[0].getDataRange().getValues();
    return ContentService.createTextOutput(JSON.stringify(rows));
  }
  if (p.mode === 'setfreeze') {
    var fv = setFreeze(sid, p.val); // v6 #4 透传原始 val
    return ContentService.createTextOutput('freeze=' + JSON.stringify(fv));
  }
  if (p.mode === 'guard') {
    var v = guardTest(sid);
    return ContentService.createTextOutput(v);
  }
  if (p.mode === 'register') {
    var rr = register(sid, p.name || 'writerX', p.lockMode || 'CENTRAL');
    return ContentService.createTextOutput(JSON.stringify(rr));
  }
  if (p.mode === 'reconcile') {
    var rc = reconcile(sid);
    return ContentService.createTextOutput(JSON.stringify(rc));
  }
  if (p.mode === 'resolve') {
    var rx = resolve(sid, p.token || 'TEST_TOKEN'); // v7 #5 独立核验后解锁（须 token）
    return ContentService.createTextOutput(JSON.stringify(rx));
  }
  return ContentService.createTextOutput('bad mode');
}

function runOwn() { runTest(SSID, 'writerTrig', 4000, 'OWN'); }        // 负对照：本地自身锁，跨项目不互斥（复现漏洞 N2）
function runShared() { runTest(SSID, 'writerTrig', 4000, 'CENTRAL'); } // 正例：集中锁端点内真正持锁（E2 验证 N1）
function runSharedCrash() { runTest(SSID, 'writerTrig', 0, 'CENTRAL', '1'); } // v6 #1 崩溃窗口仿真（N1-crash）：须 reconcile 恢复
