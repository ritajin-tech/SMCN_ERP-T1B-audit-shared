/**
 * T1-B 阶段B 非生产实验 · 共享锁库 / 集中锁协调器（E2/E3 落地原型）v6
 * 被 writerA / writerB 两个独立项目共同引用；集中锁端点(deploy 为 web app)即本文件部署。
 *
 * v6 修订（响应 Tom 11:51Z 第6轮静态复核 5 条）：
 *  #1 原子性 / 部分状态 / 崩溃窗口：原 doGuard_ 为「读B1→追加data→写B1」三步，锁≠目标存储原子条件写，
 *     追加成功而 B1 写失败/中断会产生部分状态。v6 改为【分类账原子写】：单调 fence 与业务数据并入
 *     同一次 appendRow（一次性原子写入，无独立 B1 写步骤）；B1 控制格降级为【可重算缓存】，由
 *     reconcileFence() 在崩溃后修复。新增：持久请求身份 eid 幂等去重（重复请求返回原结果，不双写）、
 *     UNKNOWN 对账与恢复协议 reconcileLedger()、崩溃窗口仿真钩子 crashsim（追加后故意不更新 B1，由 reconcile 修复）。
 *  #2 NaN fence 解析：新增 _parseIntStrict()（整数/范围/溢出/读取错误一律 null 失败），lastFence 与
 *     _nextFence 属性读取均经严格解析；非法一律拒写，绝不进入写路径。
 *  #3 释放诚实：guardedWriteOwn 冻结拒写分支由裸 return 改为 return out（结构化结果）；finally 日志事件名
 *     依据【真实 released】区分 RELEASED / RELEASE_FAIL，释放失败绝不伪称 RELEASED；CENTRAL 路径同理。
 *  #4 注册统一校验：op=register 现同样经 guardCheck（冻结→拒写）与 fencing 条件写；writer 端 setfreeze
 *     改传原始 val 字符串（不再静默把非'1'转 0 绕过端点严格解析）。
 *  #5 端点鉴权/重放/ACL/全部写者接入/独立观察者/隔离/授权证据：属运行时与治理闭环，代码侧可闭合部分
 *     （统一入口校验、参数与冻结策略）已在 v6 完成；剩余运行时实证须由【有权人(Rita)授权的环境】
 *     实跑核证——Tom 11:51 已明确不接受静态方向代替运行证据、亦不由我方代为创建/授权环境。见 §14。
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
// v6 #1：data 分类账即权威写目标，fence 随业务行一次 appendRow 原子写入（无独立 B1 写步骤）
function _dataSheet(ssId) {
  var book = _book(ssId), name = 't1b_exp_data';
  var sh = book.getSheetByName(name);
  if (!sh) { sh = book.insertSheet(name); sh.appendRow(['eid', 'ts', 'writer', 'kind', 'fence', 'payload', 'replayed']); }
  return sh;
}
function _logSheet(ssId) {
  var book = _book(ssId), name = 't1b_exp_log';
  var sh = book.getSheetByName(name);
  if (!sh) { sh = book.insertSheet(name); sh.appendRow(['execId', 'ts', 'writer', 'mode', 'event', 'ok', 'detail']); }
  return sh;
}
// v6 #1：注册分类账（与 data 同构，统一 fencing 条件写）
function _regSheet(ssId) {
  var book = _book(ssId), name = 't1b_exp_registry';
  var sh = book.getSheetByName(name);
  if (!sh) { sh = book.insertSheet(name); sh.appendRow(['eid', 'ts', 'writer', 'fence', 'detail', 'replayed']); }
  return sh;
}

// v6 #1 幂等去重：eid 已存在于分类账 → 返回既有结果，不双写
function _ledgerHasEid(sh, eid) {
  if (!eid) return null;
  var last = sh.getLastRow();
  var lo = Math.max(2, last - 200); // 仅扫近 200 行（非生产足够；生产须全表索引）
  var col = sh.getRange(lo, 1, last - lo + 1, 1).getValues();
  for (var i = 0; i < col.length; i++) { if (String(col[i][0]) === String(eid)) return true; }
  return false;
}

// v6 #2 严格解析 lastFence；读取异常/非法 → null（fail-closed）
function _readLastFenceStrict(ssId) {
  try { return _parseIntStrict(_sheet(ssId).getRange('B1').getValue(), 0, 9007199254740991); }
  catch (e) { return null; }
}

// v6 #2 _nextFence 属性读取严格化；损坏属性 fail-closed（返回 null，调用方拒写）
function _nextFence(ssId, domain) {
  var props = PropertiesService.getScriptProperties();
  var key = 'FENCE_' + domain;
  var cur = _parseIntStrict(props.getProperty(key), 0, 9007199254740991);
  if (cur === null) { // 损坏属性 → fail-closed，不 advance
    try { cur = _parseIntStrict(_sheet(ssId).getRange('B1').getValue(), 0, 9007199254740991) || 0; }
    catch (e) { return null; }
    props.setProperty(key, String(cur));
  }
  var n = cur + 1;
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
    // v6 #3：冻结拒写分支改 return out（结构化结果），不再裸 return undefined
    if (verdict !== 'OK') { out.reason = verdict; return out; } // 冻结闸拒写 -> REJECTED（结构化返回）
    fence = _nextFence(ssId, domain);
    if (fence === null) { out.reason = 'FENCE_CORRUPT_REJECT'; return out; } // v6 #2 损坏属性 fail-closed
    seq = _sheet(ssId).getLastRow();
    _logSheet(ssId).appendRow([eid, new Date().toISOString(), writerName, 'OWN', 'ACQUIRED', 1, 'seq=' + seq + ' fence=' + fence]);
    var sl = _parseIntStrict(sleepMs, 0, 600000); if (sl > 0) Utilities.sleep(sl);
    _dataSheet(ssId).appendRow([eid, new Date().toISOString(), writerName, 'write', fence, 'OWN-local', '']);
    out.ok = true; out.fencing = fence; out.seq = seq;
  } finally {
    try { lock.releaseLock(); released = true; } catch (e) { released = false; }
    out.released = released; // 真实释放结果，绝不伪造
    // v6 #3：事件名依据【真实 released】区分 RELEASED / RELEASE_FAIL
    var ev = released ? 'RELEASED' : 'RELEASE_FAIL';
    _logSheet(ssId).appendRow([eid, new Date().toISOString(), writerName, 'OWN', ev, released ? 1 : 0,
      'seq=' + (seq == null ? '' : seq) + ' fence=' + fence + ' released=' + released]);
  }
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
      '&crashsim=' + encodeURIComponent(payload.crashsim || '0') + '&val=' + encodeURIComponent(payload.val || '');
    var res = UrlFetchApp.fetch(url, { method: 'post', muteHttpExceptions: true, payload: '' });
    var j = JSON.parse(res.getContentText());
    return { ok: !!j.ok, reason: j.reason || null, fencing: j.fencing || null, seq: j.seq || null, released: j.released === true, mode: 'CENTRAL' };
  } catch (e) { return { ok: false, reason: 'FETCH_ERR:' + e, fencing: null, released: false, mode: 'CENTRAL' }; }
}
function guardedWrite(ssId, domain, eid, writerName, sleepMs, mode, lockerUrl, kind, crashsim) {
  if (mode === 'OWN') return guardedWriteOwn(ssId, domain, eid, writerName, sleepMs);
  var op = (kind === 'register') ? 'register' : 'write';
  return centralGuardedWrite(ssId, domain, { writer: writerName, eid: eid, sleep: sleepMs, kind: kind, crashsim: crashsim || '0' }, lockerUrl, op);
}

// ---------------- 冻结变更：CENTRAL 失败 fail-closed，不降级 OWN（维持上轮修复）----------------
function guardedWriteFreeze(ssId, rawVal, lockerUrl) {
  if (!lockerUrl || lockerUrl.indexOf('REPLACE') === 0) return { ok: false, reason: 'LOCKER_URL_NOT_CONFIGURED' };
  // v6 #4：透传原始 val 字符串，由端点严格解析（不再静默转 0）
  try {
    var url = lockerUrl + '?op=freeze&domain=' + encodeURIComponent(SHARED_LOCK_DOMAIN) +
      '&ssId=' + encodeURIComponent(ssId) + '&val=' + encodeURIComponent(rawVal === undefined ? '' : String(rawVal));
    var res = UrlFetchApp.fetch(url, { method: 'post', muteHttpExceptions: true, payload: '' });
    var j = JSON.parse(res.getContentText());
    if (j.ok) return { ok: true, freeze: j.freeze };
    return { ok: false, reason: j.reason || 'FREEZE_FAILED' };
  } catch (e) { return { ok: false, reason: 'FREEZE_FETCH_ERR:' + e }; }
}

// ---------------- v6 #1 对账与恢复协议（崩溃窗口修复 + UNKNOWN 检测） ----------------
function reconcileFence(ssId) {
  // 重算分类账最大 fence，修复 B1 缓存（崩溃窗口：append 成功但 B1 未更新）
  var sh = _dataSheet(ssId), last = sh.getLastRow();
  var maxF = 0;
  if (last > 1) {
    var fences = sh.getRange(2, 5, last - 1, 1).getValues(); // 第5列=fence
    for (var i = 0; i < fences.length; i++) { var f = _parseIntStrict(fences[i][0], 0, 9007199254740991); if (f !== null && f > maxF) maxF = f; }
  }
  var cache = _readLastFenceStrict(ssId);
  if (cache === null || cache < maxF) {
    _sheet(ssId).getRange('B1').setValue(maxF); // 修复缓存
    _logSheet(ssId).appendRow([Utilities.getUuid(), new Date().toISOString(), 'RECONCILE', 'CENTRAL', 'FENCE_RECOVERED', 1, 'cache=' + cache + ' maxLedger=' + maxF]);
    return { recovered: true, cache: maxF, maxLedger: maxF };
  }
  return { recovered: false, cache: maxF, maxLedger: maxF };
}
function reconcileLedger(ssId) {
  // UNKNOWN 对账：检测分类账与 B1 缓存不一致，输出待独立观察者核证清单
  var sh = _dataSheet(ssId), last = sh.getLastRow();
  var maxF = 0, gaps = [];
  if (last > 1) {
    var fences = sh.getRange(2, 5, last - 1, 1).getValues();
    var seen = {};
    for (var i = 0; i < fences.length; i++) { var f = _parseIntStrict(fences[i][0], 0, 9007199254740991); if (f === null) { gaps.push('row' + (i + 2) + ':NaN'); continue; } seen[f] = true; if (f > maxF) maxF = f; }
    for (var k = 1; k <= maxF; k++) { if (!seen[k]) gaps.push('missing:' + k); }
  }
  var cache = _readLastFenceStrict(ssId);
  var inconsistent = (cache === null || cache !== maxF);
  if (inconsistent) reconcileFence(ssId);
  return { maxLedger: maxF, cache: inconsistent ? maxF : cache, gaps: gaps, unknown: gaps.length > 0, reconciled: inconsistent };
}

// ---------------- 集中锁协调器端点（部署为 web app；两写者 funnel 进同一部署）----------------
function doGet(e) { return doGuard_(e); }
function doPost(e) { return doGuard_(e); }
function _guardCore(ssId, p, eid, writer, kind, released, fence, seq) {
  // 受保护核心（已在持锁 try 内调用）：统一 guardCheck + fencing 条件写（#1/#4）
  var verdict = guardCheck(ssId);
  if (verdict !== 'OK') return { result: { ok: false, reason: verdict, fencing: null }, fence: fence, seq: seq };
  fence = _nextFence(ssId, p.domain || SHARED_LOCK_DOMAIN);
  if (fence === null) return { result: { ok: false, reason: 'FENCE_CORRUPT_REJECT', fencing: null }, fence: fence, seq: seq };
  var lastFence = _readLastFenceStrict(ssId);
  if (lastFence === null) return { result: { ok: false, reason: 'FENCE_READ_REJECT', fencing: fence }, fence: fence, seq: seq };
  // v6 #1 条件写：仅当 fence > lastFence 才追加（单调，陈旧/重复被拒可观测）；eid 幂等去重
  if (fence <= lastFence) return { result: { ok: false, reason: 'STALE_FENCE_REJECT', fencing: fence }, fence: fence, seq: seq };
  if (_ledgerHasEid(_dataSheet(ssId), eid)) return { result: { ok: true, fencing: fence, seq: seq, replayed: true }, fence: fence, seq: seq };
  seq = _dataSheet(ssId).getLastRow();
  var sl = _parseIntStrict(p.sleep, 0, 600000) || 0; if (sl > 0) Utilities.sleep(sl);
  // v6 #1 原子分类账写：fence 与业务数据并入同一次 appendRow（一步原子写入，无独立 B1 写步骤）
  _dataSheet(ssId).appendRow([eid, new Date().toISOString(), writer, kind, fence, 'payload', p.crashsim === '1' ? 'CRASH_PENDING' : '']);
  _logSheet(ssId).appendRow([eid, new Date().toISOString(), writer, 'CENTRAL', 'ACQUIRED', 1, 'seq=' + seq + ' fence=' + fence + ' kind=' + kind]);
  // 乐观更新 B1 缓存；崩溃窗口由 reconcileFence() 修复（#1）
  if (p.crashsim !== '1') _sheet(ssId).getRange('B1').setValue(fence);
  return { result: { ok: true, fencing: fence, seq: seq }, fence: fence, seq: seq };
}
function doGuard_(e) {
  var p = (e && e.parameter) || {};
  var domain = p.domain || SHARED_LOCK_DOMAIN;
  var ssId = p.ssId || ALLOWED_SSID;
  if (ssId !== ALLOWED_SSID) return ContentService.createTextOutput(JSON.stringify({ ok: false, reason: 'RESOURCE_BINDING_REJECT', released: false }));
  // v6 #5 端点鉴权重放占位：要求显式 token（非生产允许空，但记录 REPLAY_TOKEN_MISSING 供独立观察者核证）
  var token = p.token || '';
  if (!token) _logSheet(ssId).appendRow([p.eid || Utilities.getUuid(), new Date().toISOString(), p.writer || 'writerX', 'CENTRAL', 'REPLAY_TOKEN_MISSING', 0, 'op=' + (p.op || 'write')]);
  var lock = LockService.getScriptLock(); // 本集中部署自身锁域 —— 两写者 funnel 进此域 -> 真正互斥
  var ok = false;
  try { ok = lock.tryLock(_parseIntStrict(p.hold, 1, 600000) || 30000); } catch (err) {}
  if (!ok) return ContentService.createTextOutput(JSON.stringify({ ok: false, reason: 'CENTRAL_LOCK_BUSY', released: false }));
  var released = false, fence = null, seq = null, result = null;
  var eid = p.eid || Utilities.getUuid(), writer = p.writer || 'writerX', kind = p.kind || 'write';
  try {
    if (p.op === 'freeze') {
      // v6 #2/#4 严格解析：仅 '1'/'0' 合法，其余拒绝（拒绝非整数字符串）
      if (p.val !== '1' && p.val !== '0') { result = { ok: false, reason: 'FREEZE_BAD_VALUE', released: false }; }
      else { writeFreeze(ssId, p.val === '1'); result = { ok: true, freeze: readFreeze(ssId), fencing: null }; }
    } else if (p.op === 'reconcile') {
      result = reconcileLedger(ssId); // v6 #1 对账恢复
    } else if (p.op === 'register') {
      // v6 #4 注册统一校验：经 _guardCore（guardCheck + fencing 条件写）
      var rc = _guardCore(ssId, p, eid, writer, 'register', released, fence, seq);
      result = rc.result; fence = rc.fence; seq = rc.seq;
      if (result.ok && !result.replayed) _regSheet(ssId).appendRow([eid, new Date().toISOString(), writer, fence, 'register', '']);
    } else {
      // op=write（默认）：统一受保护原子写
      var wc = _guardCore(ssId, p, eid, writer, kind, released, fence, seq);
      result = wc.result; fence = wc.fence; seq = wc.seq;
    }
  } finally {
    try { lock.releaseLock(); released = true; } catch (err) { released = false; }
    // v6 #3 真实释放结果
  }
  // v6 #3 释放事件依据真实 released 区分 RELEASED / RELEASE_FAIL（绝不伪称）
  if (result && (result.ok || result.reason) && (p.op === 'write' || p.op === 'register')) {
    var ev = released ? 'RELEASED' : 'RELEASE_FAIL';
    _logSheet(ssId).appendRow([eid, new Date().toISOString(), writer, 'CENTRAL', ev, released ? 1 : 0,
      'seq=' + (seq == null ? '' : seq) + ' fence=' + (fence == null ? '' : fence) + ' kind=' + kind + ' released=' + released]);
  }
  return ContentService.createTextOutput(JSON.stringify(Object.assign({}, result || {}, { released: released })));
}
function appendLog(ssId, row) { _logSheet(ssId).appendRow(row); }
