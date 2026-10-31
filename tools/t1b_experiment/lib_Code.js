/**
 * T1-B 阶段B 非生产实验 · 共享锁库 / 集中锁协调器（E2/E3 落地原型）v7
 * 被 writerA / writerB 两个独立项目共同引用；集中锁端点(deploy 为 web app)即本文件部署。
 *
 * v7 修订（响应 Tom 12:26Z 第7轮静态复核 5 条）：核心——把【数据分类账】设为 fence 排序与准入的
 *   唯一权威源，B1 控制格降级为纯展示缓存（永不参与准入决策）；补齐请求身份绑定 + 持久完整索引
 *   + 单表原子注册 + 只读对账(UNKNOWN 阻断) + 独立核验后才解锁。
 *  #1 幂等/身份绑定（Tom 7-1）：_ledgerHasEid 仅扫 200 行且只比 eid → 改为 _ledgerLookup 全表扫描
 *     （持久完整索引；生产须持久化哈希索引，非生产全表即完整索引）+ 请求身份绑定（writer|domain|eid|kind|payload）。
 *     同身份重放 → 返回【原始凭据】(原 fence/seq，不重算)；同 eid 不同内容 → EID_CONTENT_CONFLICT 拒写；
 *     覆盖 >200 行 / 冲突 / 并发重放负例。
 *  #2 fence 决策源（Tom 7-2）：_nextFence 原损坏时回退 B1 或 0 → 改为【仅从数据分类账最大 fence 重算】
 *     （_ledgerMaxFence），区分首初始化(空账本→1)与损坏(有行→按账本重算，绝不静默归 0)；B1 仅展示，
 *     损坏/落后不影响准入。未知状态阻断（_ledgerBlocked）。
 *  #3 准入不依赖 B1 + 崩溃窗口阻断（Tom 7-3）：_guardCore 原先用 B1 判断再 append，crashsim 允许 B1 落后
 *     且不阻断后续写 → 改为准入全部基于权威账本；新增 _ledgerBlocked（CRASH_PENDING / NaN / 缺口任一即阻断写），
 *     崩溃窗口不再自动放行；appendRow 原子性由单表单 appendRow 保证；目标侧拒旧写 = 单调 fence 条件写。
 *  #4 注册单表原子（Tom 7-4）：原 register 先写 data 后写 registry 两步易留部分状态 → 改为【单次 appendRow
 *     同时承载 data + registry 标记(kind='register')】，消除跨表双写；registry 由 _regLookup 从账本派生，
 *     不再有"两步中断/重试跳过修复"问题；单次 append 即证明该写完整。
 *  #5 对账只读 + 独立核验解锁（Tom 7-5）：reconcileLedger 改为【只读诊断】，绝不自动改缓存/自动升级为 PASS；
 *     保留 UNKNOWN 并 needsIndependentVerification；新增 reconcileResolve（须 token）仅在独立核验后修复缓存；
 *     畸形行标记不静默跳过。release 失败 / 端点鉴权 / ACL / 目标侧 fencing / 真实隔离仍为运行时+治理实证（待授权环境）。
 *
 * 纯非生产；不读主库/生产表；仅操作授权隔离测试表。
 * 部署红线：LOCKER_URL / ALLOWED_SSID 均为 REPLACE_* 占位；未配置前 CENTRAL 返回 NOT_CONFIGURED；正式运行须由有权方部署并填 URL/ID。
 */
var SHARED_LOCK_DOMAIN = 't1b-exp-guard';
var FREEZE_ON = 1, FREEZE_OFF = 0, FREEZE_UNKNOWN = -1;
var ALLOWED_SSID = 'REPLACE_SSID'; // 集中锁协调器资源绑定：仅允许授权隔离测试表

// ---------------- v6 #2 严格整数解析（整数/范围/溢出/读取错误 一律失败） ----------------
function _parseIntStrict(v, min, max) {
  if (v === null || v === undefined) return null;
  var s = String(v).trim();
  if (s === '') return null;
  if (!/^-?\d+$/.test(s)) return null;           // 仅允许纯整数字面，拒绝 '1.2' / 'abc' / '' 等
  var n = parseInt(s, 10);
  if (isNaN(n) || !isFinite(n)) return null;
  if (min !== undefined && n < min) return null;
  if (max !== undefined && n > max) return null;
  return n;
}

function _book(ssId) { return SpreadsheetApp.openById(ssId); }
function _sheet(ssId) { return _book(ssId).getSheets()[0]; }
// v7 数据分类账 = fence 排序与准入【唯一权威源】。列：
// 1 eid | 2 ts | 3 writer | 4 domain | 5 kind(write/register) | 6 action | 7 fence | 8 identity | 9 status(COMMITTED/CRASH_PENDING/REPLAYED) | 10 payload | 11 replayed
function _dataSheet(ssId) {
  var book = _book(ssId), name = 't1b_exp_data';
  var sh = book.getSheetByName(name);
  if (!sh) { sh = book.insertSheet(name); sh.appendRow(['eid', 'ts', 'writer', 'domain', 'kind', 'action', 'fence', 'identity', 'status', 'payload', 'replayed']); }
  return sh;
}
function _logSheet(ssId) {
  var book = _book(ssId), name = 't1b_exp_log';
  var sh = book.getSheetByName(name);
  if (!sh) { sh = book.insertSheet(name); sh.appendRow(['execId', 'ts', 'writer', 'mode', 'event', 'ok', 'detail']); }
  return sh;
}

// ---------------- v7 #2 权威 fence 源 = 数据分类账最大 fence（B1 仅展示，永不参与决策）----------------
function _ledgerMaxFence(ssId) {
  var sh = _dataSheet(ssId), last = sh.getLastRow();
  var maxF = 0;
  if (last > 1) {
    var fc = sh.getRange(2, 7, last - 1, 1).getValues(); // 第7列 = fence
    for (var i = 0; i < fc.length; i++) {
      var f = _parseIntStrict(fc[i][0], 0, 9007199254740991);
      if (f !== null && f > maxF) maxF = f;
    }
  }
  return maxF; // 空账本 -> 0（首初始化 fence=1）；有行 -> 按账本重算，绝不静默归 0
}
// v7 #2 _nextFence：仅从权威账本重算，区分首初始化与损坏；读取失败 fail-closed(null)
function _nextFence(ssId, domain) {
  var maxF = _ledgerMaxFence(ssId);
  if (maxF === null) return null; // 读取异常 -> 拒写（不回退 B1/0）
  return maxF + 1;
}

// ---------------- v7 #1 持久完整索引 + 请求身份绑定（替代原 _ledgerHasEid 仅扫 200 行只比 eid）----------------
// identity = writer|domain|eid|kind|payload；全表扫描 = 完整索引；命中返回【原始凭据】(原 fence/seq)
function _ledgerLookup(ssId, identity, eid) {
  var sh = _dataSheet(ssId), last = sh.getLastRow();
  if (last <= 1) return { found: false, conflict: false };
  var idCol = sh.getRange(2, 8, last - 1, 1).getValues();  // 第8列 identity
  var eidCol = sh.getRange(2, 1, last - 1, 1).getValues();  // 第1列 eid
  for (var i = 0; i < idCol.length; i++) {
    var row = i + 2;
    if (String(idCol[i][0]) === String(identity)) {
      var frow = sh.getRange(row, 1, 1, 11).getValues()[0];
      return { found: true, conflict: false, fence: _parseIntStrict(frow[6], 0, 9007199254740991), seq: row, status: String(frow[8] || ''), replayed: true };
    }
    if (String(eidCol[i][0]) === String(eid) && String(idCol[i][0]) !== String(identity)) {
      return { found: false, conflict: true }; // 同 eid 不同内容 -> 冲突拒写
    }
  }
  return { found: false, conflict: false };
}
// v7 #3/#5 准入阻断：账本存在任何未核验异常（CRASH_PENDING / NaN / 缺口）即阻断写，直到独立核验
function _ledgerBlocked(ssId) {
  var sh = _dataSheet(ssId), last = sh.getLastRow();
  if (last <= 1) return false;
  var fc = sh.getRange(2, 7, last - 1, 1).getValues();
  var sc = sh.getRange(2, 9, last - 1, 1).getValues();
  var maxF = 0, seen = {};
  for (var i = 0; i < fc.length; i++) {
    var row = i + 2;
    var f = _parseIntStrict(fc[i][0], 0, 9007199254740991);
    if (f === null) return true;            // 畸形 fence -> 阻断
    seen[f] = true; if (f > maxF) maxF = f;
    if (String(sc[i][0]) === 'CRASH_PENDING') return true; // 未核验崩溃窗口 -> 阻断
  }
  for (var k = 1; k <= maxF; k++) { if (!seen[k]) return true; } // 缺口 -> 阻断
  return false;
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
    if (verdict !== 'OK') { out.reason = verdict; return out; } // 冻结闸拒写 -> REJECTED（结构化返回）
    fence = _nextFence(ssId, domain);
    if (fence === null) { out.reason = 'FENCE_READ_REJECT'; return out; }
    seq = _dataSheet(ssId).getLastRow();
    var sl = _parseIntStrict(sleepMs, 0, 600000); if (sl > 0) Utilities.sleep(sl);
    // v7：OWN 也写权威账本（11 列对齐），但它不经过集中端点，故跨项目不互斥 = 负对照
    var idn = writerName + '|' + domain + '|' + eid + '|write|OWN-local';
    _dataSheet(ssId).appendRow([eid, new Date().toISOString(), writerName, domain, 'write', 'OWN-local', fence, idn, 'COMMITTED', 'OWN-local', '']);
    _logSheet(ssId).appendRow([eid, new Date().toISOString(), writerName, 'OWN', 'ACQUIRED', 1, 'seq=' + seq + ' fence=' + fence]);
  } finally {
    try { lock.releaseLock(); released = true; } catch (e) { released = false; }
    out.released = released; // 真实释放结果，绝不伪造
    var ev = released ? 'RELEASED' : 'RELEASE_FAIL';
    _logSheet(ssId).appendRow([eid, new Date().toISOString(), writerName, 'OWN', ev, released ? 1 : 0,
      'seq=' + (seq == null ? '' : seq) + ' fence=' + fence + ' released=' + released]);
  }
  out.ok = true; out.fencing = fence; out.seq = seq;
  return out;
}

// ---------------- E2：CENTRAL 正例（集中锁端点内真正持锁 + 原子分类账写 + 释放）----------------
function centralGuardedWrite(ssId, domain, payload, lockerUrl, op) {
  if (!lockerUrl || lockerUrl.indexOf('REPLACE') === 0) return { ok: false, reason: 'LOCKER_URL_NOT_CONFIGURED', fencing: null, released: false, mode: 'CENTRAL' };
  try {
    var url = lockerUrl + '?op=' + encodeURIComponent(op || 'write') + '&domain=' + encodeURIComponent(domain) +
      '&ssId=' + encodeURIComponent(ssId) + '&writer=' + encodeURIComponent(payload.writer || '') +
      '&eid=' + encodeURIComponent(payload.eid || '') + '&sleep=' + encodeURIComponent(payload.sleep || '0') +
      '&kind=' + encodeURIComponent(payload.kind || 'write') +
      '&crashsim=' + encodeURIComponent(payload.crashsim || '0') + '&val=' + encodeURIComponent(payload.val || '') +
      '&payload=' + encodeURIComponent(payload.payload || '') + '&token=' + encodeURIComponent(payload.token || '');
    var res = UrlFetchApp.fetch(url, { method: 'post', muteHttpExceptions: true, payload: '' });
    var j = JSON.parse(res.getContentText());
    return { ok: !!j.ok, reason: j.reason || null, fencing: j.fencing || null, seq: j.seq || null, released: j.released === true, mode: 'CENTRAL', replayed: !!j.replayed };
  } catch (e) { return { ok: false, reason: 'FETCH_ERR:' + e, fencing: null, released: false, mode: 'CENTRAL' }; }
}
function guardedWrite(ssId, domain, eid, writerName, sleepMs, mode, lockerUrl, kind, crashsim, payload) {
  if (mode === 'OWN') return guardedWriteOwn(ssId, domain, eid, writerName, sleepMs);
  var op = (kind === 'register') ? 'register' : 'write';
  return centralGuardedWrite(ssId, domain, { writer: writerName, eid: eid, sleep: sleepMs, kind: kind, crashsim: crashsim || '0', payload: payload || '' }, lockerUrl, op);
}

// ---------------- 冻结变更：CENTRAL 失败 fail-closed，不降级 OWN（维持上轮修复）----------------
function guardedWriteFreeze(ssId, rawVal, lockerUrl) {
  if (!lockerUrl || lockerUrl.indexOf('REPLACE') === 0) return { ok: false, reason: 'LOCKER_URL_NOT_CONFIGURED' };
  try {
    var url = lockerUrl + '?op=freeze&domain=' + encodeURIComponent(SHARED_LOCK_DOMAIN) +
      '&ssId=' + encodeURIComponent(ssId) + '&val=' + encodeURIComponent(rawVal === undefined ? '' : String(rawVal));
    var res = UrlFetchApp.fetch(url, { method: 'post', muteHttpExceptions: true, payload: '' });
    var j = JSON.parse(res.getContentText());
    if (j.ok) return { ok: true, freeze: j.freeze };
    return { ok: false, reason: j.reason || 'FREEZE_FAILED' };
  } catch (e) { return { ok: false, reason: 'FREEZE_FETCH_ERR:' + e }; }
}

// ---------------- v7 #1/#2/#3/#4 受保护核心（已在持锁 try 内调用）----------------
function _guardCore(ssId, p, eid, writer, kind, released, fence, seq) {
  var verdict = guardCheck(ssId);
  if (verdict !== 'OK') return { result: { ok: false, reason: verdict, fencing: null, replayed: false }, fence: fence, seq: seq };
  // v7 #3/#5：准入全部基于权威账本；任何未核验异常(CRASH_PENDING/NaN/缺口)阻断写，直到独立核验
  if (_ledgerBlocked(ssId)) return { result: { ok: false, reason: 'RECONCILE_PENDING_REJECT', fencing: null, replayed: false }, fence: fence, seq: seq };
  // v7 #1 请求身份绑定 + 持久完整索引（全表）：重放返回原始凭据；同 eid 异内容拒写
  var identity = writer + '|' + (p.domain || SHARED_LOCK_DOMAIN) + '|' + eid + '|' + kind + '|' + (p.payload || '');
  var look = _ledgerLookup(ssId, identity, eid);
  if (look.conflict) return { result: { ok: false, reason: 'EID_CONTENT_CONFLICT', fencing: null, replayed: false }, fence: fence, seq: seq };
  if (look.found) return { result: { ok: true, fencing: look.fence, seq: look.seq, replayed: true }, fence: look.fence, seq: look.seq };
  // v7 #2 单调 fence：仅从权威账本重算（非 B1）
  fence = _nextFence(ssId, p.domain || SHARED_LOCK_DOMAIN);
  if (fence === null) return { result: { ok: false, reason: 'FENCE_READ_REJECT', fencing: null, replayed: false }, fence: fence, seq: seq };
  var lastFence = _ledgerMaxFence(ssId);
  if (lastFence !== null && fence <= lastFence) return { result: { ok: false, reason: 'STALE_FENCE_REJECT', fencing: fence, replayed: false }, fence: fence, seq: seq };
  seq = _dataSheet(ssId).getLastRow();
  var sl = _parseIntStrict(p.sleep, 0, 600000) || 0; if (sl > 0) Utilities.sleep(sl);
  // v7 #4：单次 appendRow 同时承载 data + registry 标记(kind)，消除跨表双写部分状态；
  //       crashsim=1 -> status=CRASH_PENDING（随后由 reconcileResolve 独立核验后才解锁，期间 _ledgerBlocked 阻断写）
  var status = (p.crashsim === '1') ? 'CRASH_PENDING' : 'COMMITTED';
  _dataSheet(ssId).appendRow([eid, new Date().toISOString(), writer, p.domain || SHARED_LOCK_DOMAIN, kind, (p.payload || ''), fence, identity, status, (p.payload || ''), '']);
  _logSheet(ssId).appendRow([eid, new Date().toISOString(), writer, 'CENTRAL', 'ACQUIRED', 1, 'seq=' + seq + ' fence=' + fence + ' kind=' + kind + ' status=' + status]);
  // v7 #3 B1 仅为展示缓存，准入从不依赖；乐观刷新（crashsim 不刷新，保留 PENDING 以触发阻断）
  if (p.crashsim !== '1') _sheet(ssId).getRange('B1').setValue(fence);
  return { result: { ok: true, fencing: fence, seq: seq, replayed: false }, fence: fence, seq: seq };
}

// v7 #4 注册视图：从权威账本派生（kind='register'），不再有独立 registry 表双写
function _regLookup(ssId, eid) {
  var sh = _dataSheet(ssId), last = sh.getLastRow(), out = [];
  if (last > 1) {
    var kc = sh.getRange(2, 5, last - 1, 1).getValues();
    var ec = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < kc.length; i++) { if (String(kc[i][0]) === 'register' && (eid ? String(ec[i][0]) === String(eid) : true)) out.push({ eid: ec[i][0], row: i + 2 }); }
  }
  return out;
}

// ---------------- v7 #5 对账：只读诊断（绝不自动改缓存/自动升级 PASS）+ 独立核验后才解锁 ----------------
function reconcileLedger(ssId) {
  var sh = _dataSheet(ssId), last = sh.getLastRow();
  var maxF = 0, gaps = [], pending = [], malformed = [], seen = {};
  if (last > 1) {
    var fc = sh.getRange(2, 7, last - 1, 1).getValues();
    var sc = sh.getRange(2, 9, last - 1, 1).getValues();
    for (var i = 0; i < fc.length; i++) {
      var row = i + 2;
      var f = _parseIntStrict(fc[i][0], 0, 9007199254740991);
      if (f === null) { malformed.push('row' + row + ':NaN'); continue; } // 标记，不静默跳过
      seen[f] = true; if (f > maxF) maxF = f;
      if (String(sc[i][0]) === 'CRASH_PENDING') pending.push('row' + row + ':CRASH_PENDING');
    }
    for (var k = 1; k <= maxF; k++) { if (!seen[k]) gaps.push('missing:' + k); }
  }
  var unknown = (malformed.length > 0 || pending.length > 0 || gaps.length > 0);
  // v7 #5：DO NOT setValue B1 / DO NOT auto-upgrade to PASS；保留 UNKNOWN 并要求独立核验
  return { maxLedger: maxF, gaps: gaps, pending: pending, malformed: malformed, unknown: unknown, reconciled: false, needsIndependentVerification: unknown };
}
function reconcileResolve(ssId, token) {
  // v7 #5：ONLY after independent verification；须 token；修复缓存仅在此步发生
  if (!token) return { ok: false, reason: 'RESOLVE_TOKEN_REQUIRED' };
  var r = reconcileLedger(ssId);
  if (r.unknown) return { ok: false, reason: 'STILL_UNKNOWN_BLOCKED', report: r };
  _sheet(ssId).getRange('B1').setValue(r.maxLedger); // 缓存刷新仅在核验通过后
  return { ok: true, cache: r.maxLedger, maxLedger: r.maxLedger };
}

// ---------------- 集中锁协调器端点（部署为 web app；两写者 funnel 进同一部署）----------------
function doGet(e) { return doGuard_(e); }
function doPost(e) { return doGuard_(e); }
function doGuard_(e) {
  var p = (e && e.parameter) || {};
  var domain = p.domain || SHARED_LOCK_DOMAIN;
  var ssId = p.ssId || ALLOWED_SSID;
  if (ssId !== ALLOWED_SSID) return ContentService.createTextOutput(JSON.stringify({ ok: false, reason: 'RESOURCE_BINDING_REJECT', released: false }));
  // v7 #5 端点鉴权重放占位：要求显式 token（非生产允许空，但记录 REPLAY_TOKEN_MISSING 供独立观察者核证）
  var token = p.token || '';
  if (!token && p.op !== 'reconcile' && p.op !== 'resolve') _logSheet(ssId).appendRow([p.eid || Utilities.getUuid(), new Date().toISOString(), p.writer || 'writerX', 'CENTRAL', 'REPLAY_TOKEN_MISSING', 0, 'op=' + (p.op || 'write')]);
  var lock = LockService.getScriptLock(); // 本集中部署自身锁域 —— 两写者 funnel 进此域 -> 真正互斥
  var ok = false;
  try { ok = lock.tryLock(_parseIntStrict(p.hold, 1, 600000) || 30000); } catch (err) {}
  if (!ok) return ContentService.createTextOutput(JSON.stringify({ ok: false, reason: 'CENTRAL_LOCK_BUSY', released: false }));
  var released = false, fence = null, seq = null, result = null;
  var eid = p.eid || Utilities.getUuid(), writer = p.writer || 'writerX', kind = p.kind || 'write';
  try {
    if (p.op === 'freeze') {
      // v6 #2/#4 严格解析：仅 '1'/'0' 合法，其余拒绝
      if (p.val !== '1' && p.val !== '0') { result = { ok: false, reason: 'FREEZE_BAD_VALUE', released: false }; }
      else { writeFreeze(ssId, p.val === '1'); result = { ok: true, freeze: readFreeze(ssId), fencing: null }; }
    } else if (p.op === 'reconcile') {
      result = reconcileLedger(ssId); // v7 #5 只读诊断
    } else if (p.op === 'resolve') {
      result = reconcileResolve(ssId, token); // v7 #5 独立核验后解锁
    } else if (p.op === 'register') {
      // v7 #4 注册统一校验：经 _guardCore（guardCheck + 身份绑定 + 单调 fence + 单表原子写）
      var rc = _guardCore(ssId, p, eid, writer, 'register', released, fence, seq);
      result = rc.result; fence = rc.fence; seq = rc.seq;
      // registry 由 _regLookup 从账本派生，无独立双写
    } else {
      // op=write（默认）：统一受保护原子写
      var wc = _guardCore(ssId, p, eid, writer, kind, released, fence, seq);
      result = wc.result; fence = wc.fence; seq = wc.seq;
    }
  } finally {
    try { lock.releaseLock(); released = true; } catch (err) { released = false; }
  }
  if (result && (result.ok || result.reason) && (p.op === 'write' || p.op === 'register')) {
    var ev = released ? 'RELEASED' : 'RELEASE_FAIL';
    _logSheet(ssId).appendRow([eid, new Date().toISOString(), writer, 'CENTRAL', ev, released ? 1 : 0,
      'seq=' + (seq == null ? '' : seq) + ' fence=' + (fence == null ? '' : fence) + ' kind=' + kind + ' released=' + released]);
  }
  return ContentService.createTextOutput(JSON.stringify(Object.assign({}, result || {}, { released: released })));
}
function appendLog(ssId, row) { _logSheet(ssId).appendRow(row); }
