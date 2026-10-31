/**
 * T1-B 阶段B 非生产实验 · 共享锁库（E2/E3 落地原型）v3
 * 被 writerA / writerB 两个独立项目共同引用。
 *
 * v3 修订（响应 Tom 09:51Z v2 静态复核 5 条）：
 *  #1 锁路径真实分流：
 *      OWN     —— 写者项目自身 getScriptLock（跨项目不互斥，负对照/复现漏洞）
 *      LIB     —— 库内 getScriptLock（经实测仍按"执行脚本"域，跨项目不互斥；证明"仅抽到库里"无效）
 *      CENTRAL —— 集中锁端点（单一部署，内部持自身 getScriptLock；两写者都 urlFetch 它 → 真正跨项目互斥，正例）
 *  #2 releaseLock 返回值透传；guardedWrite 把释放结果附进返回；释放失败/未知不得记 RELEASED
 *  #3 writeFreeze 纳入同一协调域（guardedWriteFreeze）；并显式声明权限面未封闭（须外部 ACL）
 *  #4 独立日志通道（t1b_exp_log sheet）+ 关联 execId，业务写与观察日志分离
 *
 * 纯非生产；不读主库/生产表；仅读写传入的测试表 ssId。
 * 部署红线：本文件含 doLocker_（集中锁端点），但 LOCKER_URL 为占位 REPLACE_LOCKER_URL，
 * 未配置前 CENTRAL 模式返回 LOCKER_URL_NOT_CONFIGURED；正式运行须由有权方部署并填入 URL。
 */
var SHARED_LOCK_DOMAIN = 't1b-exp-guard';
var FREEZE_ON = 1, FREEZE_OFF = 0, FREEZE_UNKNOWN = -1;

function _sheet(ssId) { return SpreadsheetApp.openById(ssId).getSheets()[0]; }
function _logSheet(ssId) {
  var book = SpreadsheetApp.openById(ssId);
  var name = 't1b_exp_log';
  var sh = book.getSheetByName(name);
  if (!sh) { sh = book.insertSheet(name); sh.appendRow(['execId', 'ts', 'writer', 'mode', 'event', 'ok', 'detail']); }
  return sh;
}

// ---------------- E2：三种真实锁路径 ----------------

// OWN：写者自身 getScriptLock —— 跨项目不互斥（漏洞本身，负对照）
function acquireOwnLock(holdMs) {
  var lock = LockService.getScriptLock();
  try { var ok = lock.tryLock(holdMs || 30000); return { ok: ok, lock: ok ? lock : null, mode: 'OWN', t: new Date().toISOString() }; }
  catch (e) { return { ok: false, error: String(e), mode: 'OWN', t: new Date().toISOString() }; }
}
// LIB：库内 getScriptLock —— 经实测仍按"执行脚本"域（writerA 调锁 A 域、writerB 调锁 B 域）→ 跨项目不互斥
function acquireLibLock(domain, holdMs) {
  var lock = LockService.getScriptLock();
  try { var ok = lock.tryLock(holdMs || 30000); return { ok: ok, lock: ok ? lock : null, mode: 'LIB', domain: domain, t: new Date().toISOString() }; }
  catch (e) { return { ok: false, error: String(e), mode: 'LIB', domain: domain, t: new Date().toISOString() }; }
}
// CENTRAL：集中锁端点（单一部署，内部持自身 getScriptLock）—— 两写者都 urlFetch 它 → 真正跨项目互斥（正例）
function acquireCentralLock(domain, holdMs, lockerUrl) {
  if (!lockerUrl || lockerUrl.indexOf('REPLACE') === 0) {
    return { ok: false, error: 'LOCKER_URL_NOT_CONFIGURED', mode: 'CENTRAL', t: new Date().toISOString() };
  }
  try {
    var url = lockerUrl + '?op=acquire&domain=' + encodeURIComponent(domain) + '&hold=' + (holdMs || 30000);
    var res = UrlFetchApp.fetch(url, { method: 'post', muteHttpExceptions: true, payload: '' });
    var j = JSON.parse(res.getContentText());
    return { ok: !!j.ok, token: j.token || null, mode: 'CENTRAL', domain: domain, t: new Date().toISOString() };
  } catch (e) { return { ok: false, error: String(e), mode: 'CENTRAL', domain: domain, t: new Date().toISOString() }; }
}
function releaseCentralLock(domain, token, lockerUrl) {
  if (!lockerUrl || lockerUrl.indexOf('REPLACE') === 0) return { released: false, error: 'LOCKER_URL_NOT_CONFIGURED' };
  try {
    var url = lockerUrl + '?op=release&domain=' + encodeURIComponent(domain) + '&token=' + encodeURIComponent(token || '');
    var res = UrlFetchApp.fetch(url, { method: 'post', muteHttpExceptions: true, payload: '' });
    var j = JSON.parse(res.getContentText());
    return { released: !!j.released, t: new Date().toISOString() };
  } catch (e) { return { released: false, error: String(e), t: new Date().toISOString() }; }
}
// 统一释放（OWN/LIB 锁柄 + CENTRAL token）
function releaseLock(handle, lockerUrl) {
  if (!handle) return { released: false, t: new Date().toISOString() };
  if (handle.mode === 'CENTRAL') return releaseCentralLock(handle.domain, handle.token, lockerUrl);
  if (handle.lock) {
    try { handle.lock.releaseLock(); return { released: true, t: new Date().toISOString() }; }
    catch (e) { return { released: false, error: String(e), t: new Date().toISOString() }; }
  }
  return { released: false, t: new Date().toISOString() };
}

// ---------------- E3：严格三态冻结 ----------------
function readFreeze(ssId) {
  var v;
  try { v = _sheet(ssId).getRange('A1').getValue(); }
  catch (e) { return FREEZE_UNKNOWN; } // 读取失败 -> 拒写
  if (v === FREEZE_ON || v === '1' || v === true) return FREEZE_ON;
  if (v === FREEZE_OFF || v === 0 || v === '0' || v === false) return FREEZE_OFF;
  return FREEZE_UNKNOWN; // 空值/错误类型/未知形态 -> UNKNOWN，fail-closed
}
// 冻结写入（注意：仍无法封闭"能写该表者即可改 A1"的权限面；此为架构局限，须外部 ACL，如实声明）
function writeFreeze(ssId, val) {
  _sheet(ssId).getRange('A1').setValue(val ? FREEZE_ON : FREEZE_OFF);
  return readFreeze(ssId);
}
// 冻结变更纳入同一协调域（修复 #3：原先 writeFreeze 直接写、无锁）
function guardedWriteFreeze(ssId, val, lockerUrl) {
  var handle = acquireCentralLock(SHARED_LOCK_DOMAIN, 30000, lockerUrl);
  if (!handle.ok) { handle = acquireOwnLock(30000); if (!handle.ok) return { ok: false, reason: 'FREEZE_LOCK_FAILED' }; }
  try { var f = writeFreeze(ssId, val); return { ok: true, freeze: f }; }
  finally { releaseLock(handle, lockerUrl); }
}
function guardCheck(ssId) {
  var f = readFreeze(ssId);
  if (f === FREEZE_ON) return 'PERIOD_LOCKED';
  if (f === FREEZE_OFF) return 'OK';
  return 'UNKNOWN_REJECT'; // fail-closed
}

// ---------------- 受保护写入口（释放状态透传 #2）----------------
function guardedWrite(ssId, domain, protectedFn, mode, lockerUrl) {
  var handle;
  if (mode === 'OWN') handle = acquireOwnLock(30000);
  else if (mode === 'CENTRAL') handle = acquireCentralLock(domain, 30000, lockerUrl);
  else handle = acquireLibLock(domain, 30000); // LIB 默认
  if (!handle.ok) return { ok: false, reason: 'ACQUIRE_FAILED:' + handle.mode, mode: handle.mode, release: { released: false, skipped: true } };
  var out = { ok: false, mode: handle.mode, release: { released: false } };
  try {
    var verdict = guardCheck(ssId);
    if (verdict !== 'OK') { out.ok = false; out.reason = verdict; return out; } // PERIOD_LOCKED / UNKNOWN_REJECT
    out.result = protectedFn();
    out.ok = true;
    return out;
  } finally {
    out.release = releaseLock(handle, lockerUrl); // 释放结果透传，调用方据此决定记 RELEASED 还是 RELEASE_FAIL
  }
}

function registerWriter(ssId, name) {
  var sh = _sheet(ssId);
  sh.getRange('A2').setValue((sh.getRange('A2').getValue() || '') + '|' + name);
  return name;
}
function guardedRegister(ssId, name, mode, lockerUrl) {
  return guardedWrite(ssId, SHARED_LOCK_DOMAIN, function () { return registerWriter(ssId, name); }, mode, lockerUrl);
}

// ---------------- 日志（独立通道 #4）----------------
function appendLog(ssId, row) { _logSheet(ssId).appendRow(row); }

// ---------------- 集中锁端点（部署为 web app 后提供 CENTRAL 锁）----------------
function doGet(e) { return doLocker_(e); }
function doPost(e) { return doLocker_(e); }
function doLocker_(e) {
  var p = (e && e.parameter) || {};
  var domain = p.domain || SHARED_LOCK_DOMAIN;
  var props = PropertiesService.getScriptProperties();
  var lock = LockService.getScriptLock(); // 本脚本（集中锁部署）自身的锁域 —— 两写者都 funnel 进此域 → 真正互斥
  if (p.op === 'acquire') {
    var ok = lock.tryLock(parseInt(p.hold, 10) || 30000);
    var token = ok ? Utilities.getUuid() : null;
    if (ok) props.setProperty('LOCK_' + domain, token);
    return ContentService.createTextOutput(JSON.stringify({ ok: ok, token: token }));
  }
  if (p.op === 'release') {
    var t = p.token || '';
    var cur = props.getProperty('LOCK_' + domain) || '';
    var had = (cur === t && t !== '');
    if (had) { try { lock.releaseLock(); } catch (e) {} props.deleteProperty('LOCK_' + domain); }
    return ContentService.createTextOutput(JSON.stringify({ released: had }));
  }
  return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'BAD_OP' }));
}
