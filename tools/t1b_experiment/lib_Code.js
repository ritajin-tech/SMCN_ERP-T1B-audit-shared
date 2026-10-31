/**
 * T1-B 阶段B 非生产实验 · 共享锁库 / 集中锁协调器（E2/E3 落地原型）v5
 * 被 writerA / writerB 两个独立项目共同引用；集中锁端点(deploy 为 web app)即本文件部署。
 *
 * v5 修订（响应 Tom 11:22Z v4 静态复核 5 条）：
 *  #1 RELEASED 日志/返回值伪造：v4 在 finally 的 releaseLock() 之前写 RELEASED 日志、guardedWriteOwn 硬编码 released:true；
 *     改为 RELEASED 日志与返回值均在 finally 实际释放后、按真实 released 记录。
 *  #2 _fence 移到锁内 try（故障/中断下不 advance，状态可观测）。
 *  #3 真实受保护写 + 真实注册：op=write 在锁内对 t1b_exp_data 表真实追加业务行（非仅日志）；
 *     op=register 在锁内真实写 t1b_exp_registry 注册记录（非仅记 kind）。
 *  #4 fencing 强制：t1b_exp_data 控制格 B1 存 lastFence；写入仅当 fence>lastFence 才提交并持久化（原子条件写，陈旧写被拒可观测）。
 *  #5 严格 freeze 解析：op=freeze 仅接受 val 严格 '1'/'0'，其余一律拒绝；ACL/身份/重放为生产加固项，非生产实验明示不解决。
 *
 * 纯非生产；不读主库/生产表；仅操作授权隔离测试表。
 * 部署红线：LOCKER_URL / ALLOWED_SSID 均为 REPLACE_* 占位；未配置前 CENTRAL 返回 NOT_CONFIGURED；正式运行须由有权方部署并填 URL/ID。
 */
var SHARED_LOCK_DOMAIN = 't1b-exp-guard';
var FREEZE_ON = 1, FREEZE_OFF = 0, FREEZE_UNKNOWN = -1;
var ALLOWED_SSID = 'REPLACE_SSID'; // 集中锁协调器资源绑定：仅允许授权隔离测试表

function _book(ssId) { return SpreadsheetApp.openById(ssId); }
function _sheet(ssId) { return _book(ssId).getSheets()[0]; }
function _dataSheet(ssId) {
  var book = _book(ssId), name = 't1b_exp_data'; // 真实受保护资源（业务写目标）
  var sh = book.getSheetByName(name);
  if (!sh) { sh = book.insertSheet(name); sh.appendRow(['eid', 'ts', 'writer', 'kind', 'fence', 'payload']); }
  return sh;
}
function _logSheet(ssId) {
  var book = _book(ssId), name = 't1b_exp_log';
  var sh = book.getSheetByName(name);
  if (!sh) { sh = book.insertSheet(name); sh.appendRow(['execId', 'ts', 'writer', 'mode', 'event', 'ok', 'detail']); }
  return sh;
}
function _regSheet(ssId) {
  var book = _book(ssId), name = 't1b_exp_registry';
  var sh = book.getSheetByName(name);
  if (!sh) { sh = book.insertSheet(name); sh.appendRow(['eid', 'ts', 'writer', 'fence', 'detail']); }
  return sh;
}
function _nextFence(ssId, domain) { // 单调令牌（持久状态）；仅在真正持锁后 advance（修复 #2）
  var props = PropertiesService.getScriptProperties();
  var key = 'FENCE_' + domain;
  var n = (parseInt(props.getProperty(key) || '0', 10) + 1);
  props.setProperty(key, String(n));
  return n;
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

// ---------------- E2：OWN 负对照（本地自身锁，跨项目不互斥，复现漏洞本身）----------------
function guardedWriteOwn(ssId, domain, eid, writerName, sleepMs) {
  var lock = LockService.getScriptLock();
  var ok = false;
  try { ok = lock.tryLock(30000); } catch (e) {}
  if (!ok) return { ok: false, reason: 'OWN_ACQUIRE_FAILED', fencing: null, released: false, mode: 'OWN' };
  var released = false, fence = null, seq = null;
  var out = { ok: false, reason: null, fencing: null, released: false, mode: 'OWN', seq: null };
  try {
    var verdict = guardCheck(ssId);
    if (verdict !== 'OK') { out.reason = verdict; return; } // 冻结闸拒写 -> REJECTED
    fence = _nextFence(ssId, domain);                       // 仅持锁后 advance（#2）
    seq = _sheet(ssId).getLastRow();
    _logSheet(ssId).appendRow([eid, new Date().toISOString(), writerName, 'OWN', 'ACQUIRED', 1, 'seq=' + seq + ' fence=' + fence]);
    var sl = sleepMs || 0; if (sl > 0) Utilities.sleep(sl);
    _dataSheet(ssId).appendRow([eid, new Date().toISOString(), writerName, 'write', fence, 'OWN-local']); // #3 真实受保护写
    out.ok = true; out.fencing = fence; out.seq = seq;
  } finally {
    try { lock.releaseLock(); released = true; } catch (e) { released = false; }
    out.released = released; // #1 真实释放结果，绝不伪造
    _logSheet(ssId).appendRow([eid, new Date().toISOString(), writerName, 'OWN', out.ok ? 'RELEASED' : 'REJECTED', out.ok && released ? 1 : 0,
      'seq=' + (seq == null ? '' : seq) + ' fence=' + fence + ' released=' + released]);
  }
  return out;
}

// ---------------- E2：CENTRAL 正例（集中锁端点内真正持锁 + 真实写 + 释放）----------------
function centralGuardedWrite(ssId, domain, payload, lockerUrl, op) {
  if (!lockerUrl || lockerUrl.indexOf('REPLACE') === 0) return { ok: false, reason: 'LOCKER_URL_NOT_CONFIGURED', fencing: null, released: false, mode: 'CENTRAL' };
  try {
    var url = lockerUrl + '?op=' + encodeURIComponent(op || 'write') + '&domain=' + encodeURIComponent(domain) +
      '&ssId=' + encodeURIComponent(ssId) + '&writer=' + encodeURIComponent(payload.writer || '') +
      '&eid=' + encodeURIComponent(payload.eid || '') + '&sleep=' + encodeURIComponent(payload.sleep || '0') +
      '&kind=' + encodeURIComponent(payload.kind || 'write');
    var res = UrlFetchApp.fetch(url, { method: 'post', muteHttpExceptions: true, payload: '' });
    var j = JSON.parse(res.getContentText());
    return { ok: !!j.ok, reason: j.reason || null, fencing: j.fencing || null, seq: j.seq || null, released: j.released === true, mode: 'CENTRAL' };
  } catch (e) { return { ok: false, reason: 'FETCH_ERR:' + e, fencing: null, released: false, mode: 'CENTRAL' }; }
}
function guardedWrite(ssId, domain, eid, writerName, sleepMs, mode, lockerUrl, kind) {
  if (mode === 'OWN') return guardedWriteOwn(ssId, domain, eid, writerName, sleepMs);
  var op = (kind === 'register') ? 'register' : 'write'; // 真实注册走 op=register（#3）
  return centralGuardedWrite(ssId, domain, { writer: writerName, eid: eid, sleep: sleepMs, kind: kind }, lockerUrl, op);
}

// ---------------- 冻结变更：CENTRAL 失败 fail-closed，不降级 OWN（维持上轮修复）----------------
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
  if (ssId !== ALLOWED_SSID) return ContentService.createTextOutput(JSON.stringify({ ok: false, reason: 'RESOURCE_BINDING_REJECT', released: false }));
  var lock = LockService.getScriptLock(); // 本集中部署自身锁域 —— 两写者 funnel 进此域 -> 真正互斥
  var ok = false;
  try { ok = lock.tryLock(parseInt(p.hold, 10) || 30000); } catch (err) {}
  if (!ok) return ContentService.createTextOutput(JSON.stringify({ ok: false, reason: 'CENTRAL_LOCK_BUSY', released: false }));
  var released = false, fence = null, seq = null;
  var eid = p.eid || Utilities.getUuid(), writer = p.writer || 'writerX', kind = p.kind || 'write', result = null;
  try {
    if (p.op === 'freeze') {
      // #5 严格解析：仅 '1'/'0' 合法，其余拒绝
      if (p.val !== '1' && p.val !== '0') { result = { ok: false, reason: 'FREEZE_BAD_VALUE', released: false }; }
      else { writeFreeze(ssId, p.val === '1'); result = { ok: true, freeze: readFreeze(ssId), fencing: null }; }
    } else if (p.op === 'register') {
      // #3 真实注册：锁内写注册记录（非仅记 kind）
      fence = _nextFence(ssId, domain); // 仅持锁后 advance（#2）
      _regSheet(ssId).appendRow([eid, new Date().toISOString(), writer, fence, 'register']);
      result = { ok: true, fencing: fence };
    } else {
      // op=write（默认）：冻结闸 + 受保护真实写 + fencing 条件写 整体在锁内
      var verdict = guardCheck(ssId);
      if (verdict !== 'OK') { result = { ok: false, reason: verdict, fencing: null }; }
      else {
        fence = _nextFence(ssId, domain); // 仅持锁后 advance（#2）
        // #4 fencing 强制：仅当 fence > 控制格 B1 lastFence 才提交并持久化（原子条件写，陈旧写被拒可观测）
        var lastFence = parseInt(_sheet(ssId).getRange('B1').getValue() || '0', 10);
        if (fence <= lastFence) { result = { ok: false, reason: 'STALE_FENCE_REJECT', fencing: fence }; }
        else {
          seq = _sheet(ssId).getLastRow();
          _logSheet(ssId).appendRow([eid, new Date().toISOString(), writer, 'CENTRAL', 'ACQUIRED', 1, 'seq=' + seq + ' fence=' + fence + ' kind=' + kind]);
          var sl = parseInt(p.sleep || '0', 10); if (sl > 0) Utilities.sleep(sl);
          _dataSheet(ssId).appendRow([eid, new Date().toISOString(), writer, kind, fence, 'payload']); // #3 真实受保护写（data 表=业务写目标）
          _sheet(ssId).getRange('B1').setValue(fence); // 持久化 lastFence（原子条件写）
          result = { ok: true, fencing: fence, seq: seq };
        }
      }
    }
  } finally {
    try { lock.releaseLock(); released = true; } catch (err) { released = false; }
  }
  // #1 RELEASED 日志与返回值均在释放后、按真实 released 记录（不伪造）
  if (result && result.ok && (p.op === 'write' || p.op === 'register')) {
    _logSheet(ssId).appendRow([eid, new Date().toISOString(), writer, 'CENTRAL', 'RELEASED', released ? 1 : 0,
      'seq=' + (seq == null ? '' : seq) + ' fence=' + (fence == null ? '' : fence) + ' kind=' + kind + ' released=' + released]);
  }
  return ContentService.createTextOutput(JSON.stringify(Object.assign({}, result || {}, { released: released })));
}
function appendLog(ssId, row) { _logSheet(ssId).appendRow(row); }
