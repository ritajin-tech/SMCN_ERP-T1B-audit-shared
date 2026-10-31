/**
 * T1-B 阶段B 非生产实验 · 共享锁库 / 集中锁协调器（E2/E3 落地原型）v10
 * 被 writerA / writerB 两个独立项目共同引用；集中锁端点(deploy 为 web app)即本文件部署。
 *
 * v7 修订（响应 Tom 12:26Z 第7轮静态复核 5 条）：核心——把【数据分类账】设为 fence 排序与准入的
 *   唯一权威源，B1 控制格降级为纯展示缓存（永不参与准入决策）；补齐请求身份绑定 + 持久完整索引
 *   + 单表原子注册 + 只读对账(UNKNOWN 阻断) + 独立核验后才解锁。
 *
 * v8 修订（响应 Tom 21:51Z 第8轮 3 条）：账本完整性 fail-closed（DUP/ZERO/BADSTATUS）+ HMAC 签名令牌
 *   职责分离 + 24h 新鲜度 + 账本状态绑定 + 负例拒 TEST_TOKEN。
 *
 * v9 修订（响应 Tom 22:22Z 第9轮 3 条）：
 *  #1 签名令牌真证据绑定增强（Tom 9-1）：原仅绑 maxf+时间 → 现绑【资源 ID + 完整账本状态摘要(digest)
 *     + 处置依据(basis) + 一次性 nonce】，并拒绝【未来时间戳】(时间上界)；核验覆盖 跨资源 / 同 maxf
 *     内容变化 / 未来时间 / 重放 四类负例（RESOURCE_MISMATCH / DIGEST_MISMATCH / FUTURE / 伪造 sig）。
 *  #2 CRASH_PENDING 授权处置 & 恢复闭环 + 幂等（Tom 9-2）：原 unknown 直接拒、CRASH_PENDING 无恢复路径、
 *     写缓存后再写处置有中断窗口 → 现：仅 CRASH_PENDING(无畸形/缺口) 经签名令牌授权后翻 COMMITTED(恢复崩溃写)；
 *     真实损坏(malformed/gaps)仍阻断；处置记录按 (maxLedger,nonce) 幂等（崩溃重试不双写）；全程在集中锁内
 *     + 审计留痕 + 失败 fail-closed（令牌无效绝不写）。
 *  #3 目标侧条件写/防绕过/隔离权限/释放失败/故障恢复：属【授权隔离环境实证】项（Tom 9-3），代码侧已含单调 fence
 *     条件写 + 资源绑定 RESOURCE_BINDING_REJECT + 端点真实释放记录；运行实证仍须 Rita 已签 §5 授权环境后由独立核验人跑通。
 *
 * v10 修订（响应 Tom 22:51Z 第10轮 3 条）：
 *  #1 恢复流程闭合（Tom 10-1/10-2）：原 reconcileResolve 先翻 COMMITTED(解阻)再写审计/标 nonce，中间故障可能“解阻却缺审计”；
 *     且状态翻转改变摘要，原令牌重试在摘要校验处被拒不达幂等判据。→ 改为【可恢复持久状态机】：审计处置+标 nonce 先于解阻；
 *     崩溃重试先按 (maxf,nonce) 查审计短路在摘要重校验之前；令牌摘要绑定解阻前状态，单次解阻仍需有效令牌，重试靠审计幂等而非令牌重放。
 *     实现 _tokenStruct + 重排 reconcileResolve。
 *  #2 诚实界定资源绑定≠调用方鉴权（Tom 10-3）：RESOURCE_BINDING_REJECT 是【目标/目的地】校验非【调用方身份】认证；
 *     REPLAY_TOKEN_MISSING 仅观测钩子，不据其声称“防绕过”。
 *  #3 目标侧拒旧写/权限隔离/释放失败/恢复端到端：仍属【授权隔离环境实证】项（Tom 10-实证），代码侧已含 STALE_FENCE_REJECT +
 *     资源绑定 + RELEASED/RELEASE_FAIL + 状态机恢复；运行实证须 Rita 已签 §5 授权环境后由独立核验人跑通。
 *
 * 纯非生产；不读主库/生产表；仅操作授权隔离测试表。
 * 部署红线：LOCKER_URL / ALLOWED_SSID / RESOLVE_SECRET 均为 REPLACE_* 占位；未配置前 CENTRAL 返回 NOT_CONFIGURED；
 *   正式运行须由有权方部署并填 URL/ID/SECRET。
 */
var SHARED_LOCK_DOMAIN = 't1b-exp-guard';
var FREEZE_ON = 1, FREEZE_OFF = 0, FREEZE_UNKNOWN = -1;
var ALLOWED_SSID = 'REPLACE_SSID'; // 集中锁协调器资源绑定：仅允许授权隔离测试表
var RESOLVE_SECRET = 'REPLACE_VERIFY_SECRET'; // 独立核验令牌签名密钥；仅由有权方在授权环境配置，绝不入仓
var VALID_STATUS = ['COMMITTED', 'CRASH_PENDING', 'REPLAYED']; // 合法账本状态白名单（之外皆非法，fail-closed）

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
function _dispositionSheet(ssId) {
  var book = _book(ssId), name = 't1b_exp_disposition';
  var sh = book.getSheetByName(name);
  if (!sh) { sh = book.insertSheet(name); sh.appendRow(['ts', 'approver', 'verifier', 'maxLedger', 'action', 'basis', 'nonce']); }
  return sh;
}
function _nonceSheet(ssId) {
  var book = _book(ssId), name = 't1b_exp_nonce';
  var sh = book.getSheetByName(name);
  if (!sh) { sh = book.insertSheet(name); sh.appendRow(['nonce', 'ts', 'approver', 'verifier', 'maxLedger']); }
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

// ---------------- v9 #1 完整账本状态摘要（绑定进令牌，同 maxf 内容变化亦检）----------------
function _ledgerDigest(ssId) {
  var sh = _dataSheet(ssId), last = sh.getLastRow();
  var parts = ['n' + last];
  if (last > 1) {
    var fc = sh.getRange(2, 7, last - 1, 1).getValues();
    var sc = sh.getRange(2, 9, last - 1, 1).getValues();
    for (var i = 0; i < fc.length; i++) {
      var f = _parseIntStrict(fc[i][0], 0, 9007199254740991);
      parts.push((f === null ? 'X' : f) + '|' + String(sc[i][0] || ''));
    }
  }
  var data = parts.join('#');
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, data); // 确定性摘要，非密；绑定账本状态
}

// ---------------- v7 #1 持久完整索引 + 请求身份绑定（替代原 _ledgerHasEid 仅扫 200 行只比 eid）----------------
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
// v7 #3/#5 准入阻断：账本存在任何未核验异常即阻断写，直到独立核验
// v8 #1：新增 重复 fence / 零值 fence / 非法状态 检测，均 fail-closed 阻断
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
    if (f === 0) return true;               // v8 #1 零值 fence（fence 恒>=1）-> 阻断
    if (seen[f]) return true;               // v8 #1 重复 fence -> 阻断（双写/完整性违例）
    seen[f] = true; if (f > maxF) maxF = f;
    var st = String(sc[i][0] || '');
    if (VALID_STATUS.indexOf(st) < 0) return true; // v8 #1 非法状态 -> 阻断
    if (st === 'CRASH_PENDING') return true; // 未核验崩溃窗口 -> 阻断
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
      if (f === null) { malformed.push('row' + row + ':NaN'); continue; }      // 标记，不静默跳过
      if (f === 0) { malformed.push('row' + row + ':ZERO'); continue; }        // v8 #1 零值 fence
      if (seen[f]) { malformed.push('row' + row + ':DUP'); continue; }         // v8 #1 重复 fence（双写/完整性违例）
      seen[f] = true; if (f > maxF) maxF = f;
      var st = String(sc[i][0] || '');
      if (VALID_STATUS.indexOf(st) < 0) { malformed.push('row' + row + ':BADSTATUS:' + st); continue; } // v8 #1 非法状态
      if (st === 'CRASH_PENDING') pending.push('row' + row + ':CRASH_PENDING');
    }
    for (var k = 1; k <= maxF; k++) { if (!seen[k]) gaps.push('missing:' + k); }
  }
  var unknown = (malformed.length > 0 || pending.length > 0 || gaps.length > 0);
  // v7 #5：DO NOT setValue B1 / DO NOT auto-upgrade to PASS；保留 UNKNOWN 并要求独立核验
  return { maxLedger: maxF, gaps: gaps, pending: pending, malformed: malformed, unknown: unknown, reconciled: false, needsIndependentVerification: unknown };
}

// v9 #1 HMAC + 令牌构造/核验（资源 + 摘要 + basis + nonce + 时间上下界 + 职责分离 + 账本/digest 绑定）
function _hmacHex(secret, data) {
  var sig = Utilities.computeHmacSha256Signature(data, secret);
  var h = '';
  for (var i = 0; i < sig.length; i++) { var b = sig[i]; if (b < 0) b += 256; h += ('0' + (b & 0xff).toString(16)).slice(-2); }
  return h;
}
// 供【授权工具链】（非本仓代码）在有 SECRET 的授权环境内生成令牌；本仓只做核验，绝不内置密钥
// 令牌 = approver|verifier|resourceId|maxf|digest|basis|nonce|ts|sig（9 段）
function buildResolveToken(approver, verifier, resourceId, maxf, digest, basis, nonce, ts, secret) {
  var body = approver + '|' + verifier + '|' + resourceId + '|' + maxf + '|' + digest + '|' + basis + '|' + nonce + '|' + ts;
  return body + '|' + _hmacHex(secret, body);
}
function _verifyResolveToken(token, currentMaxF, ssId) {
  if (!token) return { ok: false, reason: 'RESOLVE_TOKEN_REQUIRED' };
  var parts = String(token).split('|');
  if (parts.length !== 9) return { ok: false, reason: 'RESOLVE_TOKEN_MALFORMED' };
  var approver = parts[0], verifier = parts[1], resourceId = parts[2], maxf = parts[3], digest = parts[4], basis = parts[5], nonce = parts[6], ts = parts[7], sig = parts[8];
  if (!approver || !verifier || !resourceId || !maxf || !digest || !basis || !nonce || !ts || !sig) return { ok: false, reason: 'RESOLVE_TOKEN_INVALID' };
  if (!RESOLVE_SECRET || RESOLVE_SECRET.indexOf('REPLACE') === 0) return { ok: false, reason: 'RESOLVE_SECRET_NOT_CONFIGURED' };
  var body = approver + '|' + verifier + '|' + resourceId + '|' + maxf + '|' + digest + '|' + basis + '|' + nonce + '|' + ts;
  if (_hmacHex(RESOLVE_SECRET, body) !== sig) return { ok: false, reason: 'RESOLVE_TOKEN_INVALID' }; // 伪造/字符串 ≠ 核验证明
  if (approver === verifier) return { ok: false, reason: 'RESOLVE_SEPARATION_DUTY_VIOLATED' }; // 批准者≠独立复核者
  var t = _parseIntStrict(ts, 0, 9007199254740991);
  if (t === null) return { ok: false, reason: 'RESOLVE_TOKEN_INVALID' };
  var now = Date.now();
  if (t > now + 600000) return { ok: false, reason: 'RESOLVE_TOKEN_FUTURE' };   // v9 #1 拒绝未来时间戳（时间上界）
  if (now - t > 86400000) return { ok: false, reason: 'RESOLVE_TOKEN_EXPIRED' }; // v9 #1 24h 新鲜度（时间下界）
  if (resourceId !== ALLOWED_SSID) return { ok: false, reason: 'RESOLVE_RESOURCE_MISMATCH' }; // v9 #1 跨资源负例
  var mf = _parseIntStrict(maxf, 1, 9007199254740991);
  if (mf === null || mf !== currentMaxF) return { ok: false, reason: 'RESOLVE_LEDGER_MISMATCH' }; // v9 #1 账本状态绑定(maxf)
  var dg = _ledgerDigest(ssId);
  if (dg !== digest) return { ok: false, reason: 'RESOLVE_DIGEST_MISMATCH' }; // v9 #1 完整账本摘要绑定（同 maxf 内容变化亦拒）
  return { ok: true, approver: approver, verifier: verifier, maxf: mf, nonce: nonce, basis: basis };
}
function _nonceUsed(ssId, nonce) {
  var sh = _nonceSheet(ssId), last = sh.getLastRow();
  if (last <= 1) return false;
  var nc = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < nc.length; i++) { if (String(nc[i][0]) === String(nonce)) return true; }
  return false;
}
function _markNonceUsed(ssId, nonce, approver, verifier, maxLedger) {
  _nonceSheet(ssId).appendRow([nonce, new Date().toISOString(), approver || '', verifier || '', maxLedger || '']);
}
function _dispositionExists(ssId, maxLedger, nonce) {
  var sh = _dispositionSheet(ssId), last = sh.getLastRow();
  if (last <= 1) return false;
  var mc = sh.getRange(2, 4, last - 1, 1).getValues(); // maxLedger
  var nc = sh.getRange(2, 7, last - 1, 1).getValues(); // nonce
  for (var i = 0; i < mc.length; i++) { if (String(mc[i][0]) === String(maxLedger) && String(nc[i][0]) === String(nonce)) return true; }
  return false;
}
// v9 #2 CRASH_PENDING 授权处置：翻为 COMMITTED（恢复崩溃写）；真实损坏不动
function _flipCrashPendingToCommitted(ssId) {
  var sh = _dataSheet(ssId), last = sh.getLastRow();
  if (last <= 1) return 0;
  var sc = sh.getRange(2, 9, last - 1, 1).getValues();
  var n = 0;
  for (var i = 0; i < sc.length; i++) {
    if (String(sc[i][0] || '') === 'CRASH_PENDING') { sh.getRange(i + 2, 9).setValue('COMMITTED'); n++; }
  }
  return n;
}
// v10 #1 可恢复持久状态机（响应 Tom 22:51Z 第10轮 10-1/10-2）：审计先于解阻 + 幂等短路在摘要重校验之前
// 设计要点：
//  · 解阻（翻 COMMITTED）必须在【审计处置记录已落 + nonce 已标记】之后 -> “解阻 ⇔ 已审计”二态一致
//  · 崩溃重试：先按令牌结构取 (maxf,nonce) 查审计/nonce 是否已落（无需密钥解析），已落则直接幂等成功，
//    短路在【摘要重校验】之前，避免“状态翻转改变摘要 -> 原令牌在摘要校验处被拒 -> 幂等判据到不了”的死结
//  · 令牌摘要绑定【解阻前状态】；单次解阻仍需有效令牌；重试靠审计幂等而非令牌重放
function _tokenStruct(token) {
  if (!token) return null;
  var parts = String(token).split('|');
  if (parts.length !== 9) return null;
  return { approver: parts[0], verifier: parts[1], resourceId: parts[2], maxf: parts[3], digest: parts[4], basis: parts[5], nonce: parts[6], ts: parts[7], sig: parts[8] };
}
function reconcileResolve(ssId, token) {
  var r = reconcileLedger(ssId);
  var onlyPending = (r.pending.length > 0 && r.malformed.length === 0 && r.gaps.length === 0);
  if (r.unknown && !onlyPending) return { ok: false, reason: 'STILL_UNKNOWN_BLOCKED', report: r }; // 真实损坏仍阻断
  // v10 #1 幂等短路：先按令牌结构取 (maxf,nonce) 查审计/nonce 是否已落（不校验签名，查的是“上次是否已审计”）
  var ts0 = _tokenStruct(token);
  if (ts0 && ts0.nonce) {
    var mf0 = _parseIntStrict(ts0.maxf, 1, 9007199254740991);
    if (mf0 !== null && (_dispositionExists(ssId, mf0, ts0.nonce) || _nonceUsed(ssId, ts0.nonce))) {
      return { ok: true, cache: r.maxLedger, maxLedger: r.maxLedger, idempotent: true, approver: ts0.approver, verifier: ts0.verifier, note: 'audit-present-before-digest-reverify' };
    }
  }
  // v10 #1 全量令牌核验（摘要绑定【解阻前状态】，此时尚未翻状态，摘要仍匹配当前账本）
  var v = _verifyResolveToken(token, r.maxLedger, ssId);
  if (!v.ok) return { ok: false, reason: v.reason }; // 令牌无效 -> 绝不写（fail-closed）
  // v10 #1 审计先于解阻：先落处置记录 + 标 nonce，再翻 COMMITTED（解阻）
  _dispositionSheet(ssId).appendRow([new Date().toISOString(), v.approver, v.verifier, r.maxLedger, (onlyPending ? 'RECOVERED' : 'RESOLVED'), v.basis, v.nonce]);
  _markNonceUsed(ssId, v.nonce, v.approver, v.verifier, r.maxLedger);
  // v10 #1 解阻（仅 CRASH_PENDING -> 翻 COMMITTED）；翻本身幂等（已 COMMITTED 再翻计 0）；至此“解阻 ⇔ 已审计”
  var flipped = onlyPending ? _flipCrashPendingToCommitted(ssId) : 0;
  _sheet(ssId).getRange('B1').setValue(r.maxLedger); // 刷新展示缓存（仅核验+审计通过后）
  return { ok: true, cache: r.maxLedger, maxLedger: r.maxLedger, approver: v.approver, verifier: v.verifier, recoveredPending: onlyPending, flipped: flipped };
}

// ---------------- 集中锁协调器端点（部署为 web app；两写者 funnel 进同一部署）----------------
function doGet(e) { return doGuard_(e); }
function doPost(e) { return doGuard_(e); }
function doGuard_(e) {
  var p = (e && e.parameter) || {};
  var domain = p.domain || SHARED_LOCK_DOMAIN;
  var ssId = p.ssId || ALLOWED_SSID;
  if (ssId !== ALLOWED_SSID) return ContentService.createTextOutput(JSON.stringify({ ok: false, reason: 'RESOURCE_BINDING_REJECT', released: false }));
  // v10 #3 诚实界定（响应 Tom 22:51Z 第10轮 10-3）：资源绑定(RESOURCE_BINDING_REJECT) 仅约束“写入目标必须是授权隔离表”，
  //   是【目标/目的地】校验，NOT【调用方身份】认证；调用方身份依赖部署访问控制（仅授权编辑器可调），属部署期属性而非代码属性。
  //   REPLAY_TOKEN_MISSING 仅作独立观察者观测钩子，不构成鉴权，也不据此声称“防绕过”。
  var token = p.token || '';
  if (!token && p.op !== 'reconcile' && p.op !== 'resolve') _logSheet(ssId).appendRow([p.eid || Utilities.getUuid(), new Date().toISOString(), p.writer || 'writerX', 'CENTRAL', 'REPLAY_TOKEN_MISSING', 0, 'op=' + (p.op || 'write') + ' note=observation-hook-not-auth']);
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
      result = reconcileResolve(ssId, token); // v9 #2 授权恢复闭环（集中锁内）
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
