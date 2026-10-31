/**
 * T1-B 阶段B 非生产实验 · 共享锁库 / 集中锁协调器（E2/E3 落地原型）v4
 * 被 writerA / writerB 两个独立项目共同引用；集中锁端点(deploy 为 web app)即本文件部署。
 *
 * v4 修订（响应 Tom 10:51Z v3 中央锁安全缺口 4 条）：
 *  #1 CENTRAL 正例根本性修正：v3 的 doLocker_ 在 acquire 后写 token 即返回，锁随执行结束释放，
 *     第二次 acquire 可覆盖同域 token —— 这是 check-then-act 竞态，锁并未在真实写期间跨写者持有。
 *     改为：集中端点把"冻结闸 + 受保护写 + 释放"整体纳入【同一次服务端锁内】(doGuard_ 内 try/finally)，
 *     两写者 funnel 同一集中部署 → 该部署的 getScriptLock 真正串行化两者对共享表的写。
 *  #2 释放结果确定：集中端点内 finally 真实 releaseLock，released 由 finally 实际结果决定，不再凭 token 相等伪造；
 *     单调 fencing 令牌(持久 FENCE_<domain>)随每次持锁递增、随写记录，供独立观察者检测陈旧写。
 *  #3 guardedWriteFreeze 删 OWN 降级：CENTRAL 不可用即 fail-closed 返回失败，不降级本地锁（避免故障时并发改冻结值）。
 *  #4 资源绑定 + 非生产声明：集中端点仅接受 ALLOWED_SSID（资源绑定）；身份/重放/ACL 为生产加固项，本实验不解决、明示不用于生产。
 *
 * 纯非生产；不读主库/生产表；仅操作授权隔离测试表。
 * 部署红线：LOCKER_URL / ALLOWED_SSID 均为 REPLACE_* 占位；未配置前 CENTRAL 返回 NOT_CONFIGURED；正式运行须由有权方部署并填 URL/ID。
 */
var SHARED_LOCK_DOMAIN = 't1b-exp-guard';
var FREEZE_ON = 1, FREEZE_OFF = 0, FREEZE_UNKNOWN = -1;
var ALLOWED_SSID = 'REPLACE_SSID'; // 集中锁协调器资源绑定：仅允许授权隔离测试表

function _sheet(ssId) { return SpreadsheetApp.openById(ssId).getSheets()[0]; }
function _logSheet(ssId) {
  var book = SpreadsheetApp.openById(ssId);
  var name = 't1b_exp_log';
  var sh = book.getSheetByName(name);
  if (!sh) { sh = book.insertSheet(name); sh.appendRow(['execId', 'ts', 'writer', 'mode', 'event', 'ok', 'detail']); }
  return sh;
}
function _fence(domain) {
  var props = PropertiesService.getScriptProperties();
  var key = 'FENCE_' + domain;
  var n = (parseInt(props.getProperty(key) || '0', 10) + 1);
  props.setProperty(key, String(n));
  return n; // 单调令牌（持久状态）
}

// ---------------- E3：严格三态冻结 ----------------
function readFreeze(ssId) {
  var v;
  try { v = _sheet(ssId).getRange('A1').getValue(); }
  catch (e) { return FREEZE_UNKNOWN; } // 读取失败 -> 拒写
  if (v === FREEZE_ON || v === '1' || v === true) return FREEZE_ON;
  if (v === FREEZE_OFF || v === 0 || v === '0' || v === false) return FREEZE_OFF;
  return FREEZE_UNKNOWN; // 空值/错误类型/未知 -> UNKNOWN，fail-closed
}
function writeFreeze(ssId, val) { _sheet(ssId).getRange('A1').setValue(val ? FREEZE_ON : FREEZE_OFF); return readFreeze(ssId); }
function guardCheck(ssId) {
  var f = readFreeze(ssId);
  if (f === FREEZE_ON) return 'PERIOD_LOCKED';
  if (f === FREEZE_OFF) return 'OK';
  return 'UNKNOWN_REJECT'; // fail-closed
}

// ---------------- E2：两种真实路径 ----------------
// OWN 负对照：写者本地持自身 getScriptLock 做受保护写 —— 跨项目不互斥（复现漏洞本身）
function guardedWriteOwn(ssId, domain, eid, writerName, sleepMs) {
  var lock = LockService.getScriptLock();
  var ok = false;
  try { ok = lock.tryLock(30000); } catch (e) {}
  if (!ok) return { ok: false, reason: 'OWN_ACQUIRE_FAILED', fencing: null, released: false, mode: 'OWN' };
  var released = false;
  try {
    var verdict = guardCheck(ssId);
    if (verdict !== 'OK') return { ok: false, reason: verdict, fencing: null, released: false, mode: 'OWN' };
    var seq = _sheet(ssId).getLastRow();
    _logSheet(ssId).appendRow([eid, new Date().toISOString(), writerName, 'OWN', 'ACQUIRED', 1, 'seq=' + seq]);
    var sl = sleepMs || 0; if (sl > 0) Utilities.sleep(sl);
    _logSheet(ssId).appendRow([eid, new Date().toISOString(), writerName, 'OWN', 'RELEASED', 1, 'seq=' + seq]);
    return { ok: true, fencing: null, released: true, mode: 'OWN' };
  } finally {
    try { lock.releaseLock(); released = true; } catch (e) { released = false; }
  }
}
// CENTRAL 正例：受保护写整体 funnel 进集中锁端点（端点内持锁+闸+写+释放）
function centralGuardedWrite(ssId, domain, payload, lockerUrl) {
  if (!lockerUrl || lockerUrl.indexOf('REPLACE') === 0) return { ok: false, reason: 'LOCKER_URL_NOT_CONFIGURED', fencing: null, released: false, mode: 'CENTRAL' };
  try {
    var url = lockerUrl + '?op=write&domain=' + encodeURIComponent(domain) +
      '&ssId=' + encodeURIComponent(ssId) + '&writer=' + encodeURIComponent(payload.writer || '') +
      '&eid=' + encodeURIComponent(payload.eid || '') + '&sleep=' + encodeURIComponent(payload.sleep || '0') +
      '&kind=' + encodeURIComponent(payload.kind || 'write');
    var res = UrlFetchApp.fetch(url, { method: 'post', muteHttpExceptions: true, payload: '' });
    var j = JSON.parse(res.getContentText());
    return { ok: !!j.ok, reason: j.reason || null, fencing: j.fencing || null, seq: j.seq || null,
             released: j.released === true, mode: 'CENTRAL' };
  } catch (e) { return { ok: false, reason: 'FETCH_ERR:' + e, fencing: null, released: false, mode: 'CENTRAL' }; }
}
// 统一入口：writer 调用
function guardedWrite(ssId, domain, eid, writerName, sleepMs, mode, lockerUrl, kind) {
  if (mode === 'OWN') return guardedWriteOwn(ssId, domain, eid, writerName, sleepMs);
  return centralGuardedWrite(ssId, domain, { writer: writerName, eid: eid, sleep: sleepMs, kind: kind }, lockerUrl);
}

// ---------------- 冻结变更：CENTRAL 失败 fail-closed，不降级 OWN（修复 #3）----------------
function guardedWriteFreeze(ssId, val, lockerUrl) {
  if (!lockerUrl || lockerUrl.indexOf('REPLACE') === 0) return { ok: false, reason: 'LOCKER_URL_NOT_CONFIGURED' };
  try {
    var url = lockerUrl + '?op=freeze&domain=' + encodeURIComponent(SHARED_LOCK_DOMAIN) +
      '&ssId=' + encodeURIComponent(ssId) + '&val=' + (val ? 1 : 0);
    var res = UrlFetchApp.fetch(url, { method: 'post', muteHttpExceptions: true, payload: '' });
    var j = JSON.parse(res.getContentText());
    if (j.ok) return { ok: true, freeze: j.freeze };
    return { ok: false, reason: j.reason || 'FREEZE_FAILED' }; // 不降级到 OWN
  } catch (e) { return { ok: false, reason: 'FREEZE_FETCH_ERR:' + e }; }
}

// ---------------- 集中锁协调器端点（部署为 web app；两写者 funnel 进同一部署）----------------
function doGet(e) { return doGuard_(e); }
function doPost(e) { return doGuard_(e); }
function doGuard_(e) {
  var p = (e && e.parameter) || {};
  var domain = p.domain || SHARED_LOCK_DOMAIN;
  var ssId = p.ssId || ALLOWED_SSID;
  // 资源绑定（#4）：仅接受授权隔离测试表
  if (ssId !== ALLOWED_SSID) return ContentService.createTextOutput(JSON.stringify({ ok: false, reason: 'RESOURCE_BINDING_REJECT', released: false }));
  var lock = LockService.getScriptLock(); // 本集中部署自身锁域 —— 两写者 funnel 进此域 -> 真正互斥
  var ok = false;
  try { ok = lock.tryLock(parseInt(p.hold, 10) || 30000); } catch (err) {}
  if (!ok) return ContentService.createTextOutput(JSON.stringify({ ok: false, reason: 'CENTRAL_LOCK_BUSY', released: false }));
  var fence = _fence(domain); // 单调 fencing 令牌（持久状态）
  var released = false;
  var result;
  try {
    if (p.op === 'freeze') {
      var fv = (p.val === '1') ? FREEZE_ON : FREEZE_OFF;
      writeFreeze(ssId, fv === FREEZE_ON);
      result = { ok: true, freeze: readFreeze(ssId), fencing: fence };
    } else {
      // op=write（默认）：冻结闸 + 受保护写 整体在锁内
      var verdict = guardCheck(ssId);
      if (verdict !== 'OK') { result = { ok: false, reason: verdict, fencing: fence }; }
      else {
        var sheet = _sheet(ssId);
        var seq = sheet.getLastRow();
        var eid = p.eid || Utilities.getUuid();
        var writer = p.writer || 'writerX';
        var kind = p.kind || 'write';
        _logSheet(ssId).appendRow([eid, new Date().toISOString(), writer, 'CENTRAL', 'ACQUIRED', 1, 'seq=' + seq + ' fence=' + fence + ' kind=' + kind]);
        var sl = parseInt(p.sleep || '0', 10); if (sl > 0) Utilities.sleep(sl);
        _logSheet(ssId).appendRow([eid, new Date().toISOString(), writer, 'CENTRAL', 'RELEASED', 1, 'seq=' + seq + ' fence=' + fence + ' kind=' + kind]);
        result = { ok: true, fencing: fence, seq: seq };
      }
    }
  } finally {
    try { lock.releaseLock(); released = true; } catch (err) { released = false; }
  }
  // released 由 finally 实际结果决定，不伪造
  return ContentService.createTextOutput(JSON.stringify(Object.assign({}, result || {}, { released: released })));
}

function appendLog(ssId, row) { _logSheet(ssId).appendRow(row); }
