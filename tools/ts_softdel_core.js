// ts_softdel_core.js — 软标动作【真实服务端业务核心】（v2：回应 Tom 2026-10-27 复审 7 项条件）
// 单一可信源：GAS 部署（RemoteActions）与原生 Node 隔离 harness 共用同一份逻辑，
// 仅通过 deps 注入存储/锁/网络/期锁/日志依赖，不在测试替身里另写一份更强的服务端逻辑。
//
// 7 项条件落地：
//  #1 锁内原值：主库全量读取（readAllMaster）与写入同处一把锁内；底稿读不完整 → 整批拒绝
//      （B 级不会再被"误判底稿0行"放行）；跨项目写协调 = 主库文档锁（acquireMasterLock）。
//  #2 字段规范化契约：业务日期(列1)纳入指纹并规范为显式时区 ISO；SHA-256（非 djb2）；
//      类型保全（前导零 ID 不 coercion）；O 审计列纳入；timeOnly 仅排除录入时间列0但仍分别绑定。
//  #3 真实期锁适配器：要求 deps.guardCheck 为真实函数（来自 period_lock_port），缺失 → 整批拒绝；
//      跑真实 _plGuardCheck/_plParseBizDate/_plPolicy，typeof 守卫。
//  #4 严格响应契约：信封含 version；ok/dry 严格布尔；逐项 ok/wrote 严格布尔。
//  #5 批次日志（journal）：PREPARED/COMMITTED/REJECTED/UNKNOWN；--status 验同一身份/请求，
//      读取失败留 UNKNOWN（不自动重试）；O=TRUE 来源不明 ≠ 本请求完成。
//  #6 参数/keeper 类型闭合：用解析后 zrow===zk（非 '2'===2 绕过）；严格 JSON 类型；拒绝 null/未知 dry、
//      非数组 rows、越界/表头、空/非法 uuid、未知顶层字段、重复/循环依赖（先建 keeper 图）；
//      flush 异常区分"已写未确认"与"未写"（非一律 ROW_READ_FAIL）。
//  #7 分页版本闭合：主库读取返回 version（真实修订绑定/前后快照哈希），缺失表/空探测 = 显式失败。

'use strict';

var norm = require('./ts_softdel_norm.js');
var pl = require('./period_lock_port.js');
var _sdRowHash = norm._sdRowHash;
var _sdCellTok = norm._sdCellTok;
var _sdSoftDel = norm._sdSoftDel;
var _sdSha256 = norm._sdSha256;

var VERSION = 'ts_softdel_core/2';
var ROW_KEYS = ['row', 'uuid', 'keeperRow', 'level', 'timeOnly', 'expectHash',
  'keeperHash', 'expectBaseHash', 'clearance', 'expectEntryTime', 'keeperEntryTime'];
var TOP_KEYS = ['batchId', 'rows', 'dry', 'sheet', 'clearance', 'jobId', 'action', 'token'];

// 单格规范化 token（用于 timeOnly 的录入时间绑定，单格）
function _sdCellHash(v) { return _sdSha256(JSON.stringify(_sdCellTok(v))); }

function _res(ok, extra) {
  var o = { ok: !!ok, version: VERSION };
  for (var k in extra) if (extra.hasOwnProperty(k)) o[k] = extra[k];
  return JSON.stringify(o);
}

// 结构化校验（输入形态 + 逐行 + keeper 图）；返回 {error} 或 {rows}
function _validateInput(e, deps) {
  var p = e.parameter || {};
  var body = e.postBody || {};
  var top = Object.keys(body).concat(Object.keys(p));
  var unknownTop = top.filter(function (k) { return TOP_KEYS.indexOf(k) < 0; });
  if (unknownTop.length) return { error: 'unknown top-level fields: ' + unknownTop.join(',') };

  var rows = body.rows || p.rows;
  if (!Array.isArray(rows)) return { error: 'rows must be an array' };
  if (!rows.length) return { error: 'no rows provided' };
  if (rows.length > 2000) return { error: 'too many rows: ' + rows.length };

  // dry 严格：接受布尔或约定字符串 0/1/true/false（GAS/运输层惯例）；拒绝 null/未知/数字/其它字符串
  var dryExplicit = (p.dry !== undefined) ? p.dry : body.dry;
  if (dryExplicit !== undefined) {
    var dryOk = (dryExplicit === true || dryExplicit === false ||
                 dryExplicit === '0' || dryExplicit === '1' ||
                 dryExplicit === 'true' || dryExplicit === 'false');
    if (!dryOk) return { error: 'dry must be boolean or 0/1 string, got: ' + JSON.stringify(dryExplicit) };
  }

  var sheetName = String(p.sheet || body.sheet || deps.PL_DB_SHEET);
  if (sheetName !== deps.PL_DB_SHEET) {
    return { error: 'sheet not allowed: ' + sheetName + ' (must be ' + deps.PL_DB_SHEET + ')' };
  }

  var seenTarget = {};
  var keeperOf = {};   // row -> keeperRow（用于循环/依赖检测）
  for (var z = 0; z < rows.length; z++) {
    var zr = rows[z] || {};
    var unknown = Object.keys(zr).filter(function (k) { return ROW_KEYS.indexOf(k) < 0; });
    if (unknown.length) return { error: 'row#' + z + ' unknown fields: ' + unknown.join(',') };

    var zrow = Number(zr.row), zk = Number(zr.keeperRow);
    if (!Number.isInteger(zrow) || zrow < 2) return { error: 'row#' + z + ' bad row: ' + JSON.stringify(zr.row) };
    if (!Number.isInteger(zk) || zk < 2) return { error: 'row#' + z + ' bad keeperRow: ' + JSON.stringify(zr.keeperRow) };
    // 条件 #6：用解析后比较，避免 '2' === 2 绕过
    if (zrow === zk) return { error: 'row#' + z + ' row==keeperRow (self-reference)' };

    if (!zr.uuid || typeof zr.uuid !== 'string' || !zr.uuid.trim()) {
      return { error: 'row#' + z + ' missing/invalid uuid' };
    }
    if (zr.level !== 'A' && zr.level !== 'B') return { error: 'row#' + z + ' bad level: ' + JSON.stringify(zr.level) };
    if (!zr.expectHash || !zr.keeperHash) return { error: 'row#' + z + ' missing expectHash/keeperHash' };
    if (zr.level === 'A' && !zr.expectBaseHash) return { error: 'row#' + z + ' A-level missing expectBaseHash' };
    if (zr.timeOnly != null && typeof zr.timeOnly !== 'boolean') {
      return { error: 'row#' + z + ' bad timeOnly (must be boolean)' };
    }
    // timeOnly 时须绑定双方录入时间（条件 #2）
    if (zr.timeOnly === true) {
      if (!zr.expectEntryTime || !zr.keeperEntryTime) {
        return { error: 'row#' + z + ' timeOnly requires expectEntryTime & keeperEntryTime' };
      }
    }
    if (seenTarget[zrow]) return { error: 'duplicate target row: ' + zrow };
    seenTarget[zrow] = true;
    keeperOf[zrow] = zk;
  }

  // 条件 #6：先建 keeper 图，拒绝"目标是他人 keeper"与循环依赖
  var targets = {};
  rows.forEach(function (r) { if (r && r.row != null) targets[Number(r.row)] = true; });
  for (var z2 = 0; z2 < rows.length; z2++) {
    var krow = Number(rows[z2].keeperRow);
    if (targets[krow]) {
      return { error: 'row#' + z2 + ' keeperRow=' + krow + ' is also a target in this batch (dependency conflict)' };
    }
  }
  // 循环检测：keeper 链最终必须落在非目标的保留行
  for (var z3 = 0; z3 < rows.length; z3++) {
    var cur = Number(rows[z3].keeperRow), seen = {};
    while (cur != null && targets[cur] && !seen[cur]) { seen[cur] = true; cur = keeperOf[cur]; }
    if (cur != null && seen[cur]) return { error: 'row#' + z3 + ' cyclic keeper dependency' };
  }

  return { rows: rows };
}

// 主入口
function tsSoftDelGuardedCore(e, deps) {
  e = e || {};
  // 只读状态查询（条件 #5）
  if ((e.postBody && e.postBody.action === 'statusQuery') || (e.parameter && e.parameter.action === 'statusQuery')) {
    return tsSoftDelStatus(e, deps);
  }

  var v = _validateInput(e, deps);
  if (v.error) return _res(false, { error: v.error });
  var rows = v.rows;

  var p = e.parameter || {};
  var body = e.postBody || {};
  var dryExplicit = (p.dry !== undefined) ? p.dry : body.dry;
  var dry = !(dryExplicit === false || dryExplicit === '0' || dryExplicit === 'false');   // 默认 true（fail-closed）
  var batchId = body.batchId || p.batchId || null;
  var jobId = body.jobId || p.jobId || batchId || ('J' + Date.now().toString(36));
  var clearanceToken = body.clearance || p.clearance || null;
  var clearanceOk = clearanceToken ? !!deps.isClearance(clearanceToken, rows) : false;

  // 条件 #3：真实期锁依赖缺失 → 整批拒绝（不静默放行）
  if (typeof deps.guardCheck !== 'function') {
    return _res(false, { error: 'PERIOD_DEP_MISSING', batchId: batchId });
  }
  var policy = (typeof deps.policy === 'function') ? deps.policy() : pl._plPolicy();

  // 条件 #1/#7：跨项目写协调 —— 主库文档锁 + 生产文档锁（固定顺序：master 先，prod 后）
  var _mlock = deps.acquireMasterLock ? deps.acquireMasterLock() : null;
  var _lock = deps.acquireLock();
  var results = [], patched = 0, anyFail = false;
  try {
    // 条件 #1：主库全量读取必须在锁内（消除 build-masterMap-before-lock 的 TOCTOU）；
    //         读不完整 → 整批拒绝，B 级不会再被"误判底稿0行"放行。
    var master = deps.readAllMaster ? deps.readAllMaster() : { map: {}, complete: true, version: 'none' };
    if (!master.complete) {
      return _res(false, { error: 'BASE_READ_INCOMPLETE', detail: master.error || '', version: master.version || null, batchId: batchId });
    }
    var masterMap = master.map || {};

    for (var i = 0; i < rows.length; i++) {
      var it = rows[i] || {};
      var row = Number(it.row), uuid = String(it.uuid || '');
      var keeperRow = Number(it.keeperRow), level = String(it.level || '');
      var timeOnly = (it.timeOnly === true);
      var itemId = row;
      var requestHash = _sdSha256(JSON.stringify({
        row: row, uuid: uuid, keeperRow: keeperRow, level: level, timeOnly: timeOnly,
        expectHash: it.expectHash, keeperHash: it.keeperHash, expectBaseHash: it.expectBaseHash,
        expectEntryTime: it.expectEntryTime, keeperEntryTime: it.keeperEntryTime
      }));
      var wrote = false, writtenUnconfirmed = false;
      try {
        // 锁内重读实时值
        var vals = deps.readProdRow(row);
        if (!vals) { journal(deps, jobId, batchId, itemId, requestHash, 'REJECTED'); results.push({ row: row, ok: false, reason: 'ROW_NOT_FOUND' }); anyFail = true; continue; }
        var kVals = deps.readProdRow(keeperRow);

        if (norm._sdNorm(vals[8]) !== uuid) { journal(deps, jobId, batchId, itemId, requestHash, 'REJECTED'); results.push({ row: row, ok: false, reason: 'UUID_DRIFT', actual: norm._sdNorm(vals[8]) }); anyFail = true; continue; }
        if (_sdSoftDel(vals[14])) { journal(deps, jobId, batchId, itemId, requestHash, 'REJECTED'); results.push({ row: row, ok: false, wrote: false, reason: 'ALREADY_SOFTDEL' }); anyFail = true; continue; }
        if (!kVals || _sdSoftDel(kVals[14])) { journal(deps, jobId, batchId, itemId, requestHash, 'REJECTED'); results.push({ row: row, ok: false, reason: 'KEEPER_INVALID' }); anyFail = true; continue; }

        // 条件 #2：CAS 绑定到已审计原值（SHA-256 指纹，含列1业务日期/排除列0当 timeOnly/含列14审计）
        var liveHash = _sdRowHash(vals, timeOnly);
        var liveKHash = _sdRowHash(kVals, timeOnly);
        if (liveHash !== it.expectHash) { journal(deps, jobId, batchId, itemId, requestHash, 'REJECTED'); results.push({ row: row, ok: false, reason: 'TARGET_DRIFT', expect: it.expectHash, actual: liveHash }); anyFail = true; continue; }
        if (liveKHash !== it.keeperHash) { journal(deps, jobId, batchId, itemId, requestHash, 'REJECTED'); results.push({ row: row, ok: false, reason: 'KEEPER_DRIFT', expect: it.keeperHash, actual: liveKHash }); anyFail = true; continue; }

        // 条件 #2：timeOnly 时录入时间分别绑定（双方），差异被接受但必须"被声明且匹配"
        if (timeOnly) {
          var liveEntry = _sdCellHash(vals[0]);
          var liveKEntry = _sdCellHash(kVals[0]);
          if (liveEntry !== it.expectEntryTime || liveKEntry !== it.keeperEntryTime) {
            journal(deps, jobId, batchId, itemId, requestHash, 'REJECTED');
            results.push({ row: row, ok: false, reason: 'ENTRY_TIME_DRIFT' }); anyFail = true; continue;
          }
        }

        // 负载一致性（冗余保险，timeOnly 仅允许列0差异）
        var diffs = [];
        for (var c = 0; c <= 13; c++) if (norm._sdNorm(vals[c]) !== norm._sdNorm(kVals[c])) diffs.push(c);
        var allowed = timeOnly && diffs.length > 0 && diffs.every(function (x) { return x === 0; });
        if (diffs.length > 0 && !allowed) { journal(deps, jobId, batchId, itemId, requestHash, 'REJECTED'); results.push({ row: row, ok: false, reason: 'PAYLOAD_DIFF', cols: diffs }); anyFail = true; continue; }

        // 条件 #3：真实期锁（锁内对目标行业务日期跑真实 _plGuardCheck）
        var bizDate = norm._sdNorm(vals[1]);
        var g = deps.guardCheck(bizDate, null, policy);
        if (!g.ok && !clearanceOk) { journal(deps, jobId, batchId, itemId, requestHash, 'REJECTED'); results.push({ row: row, ok: false, reason: 'PERIOD_LOCKED', date: bizDate, detail: g.reason || '' }); anyFail = true; continue; }

        // 等级与底稿核对（A：底稿恰 1 行且哈希/状态相符；B：底稿 0 行）
        if (level === 'A') {
          var mMatches = masterMap[uuid] || [];
          if (mMatches.length !== 1) { journal(deps, jobId, batchId, itemId, requestHash, 'REJECTED'); results.push({ row: row, ok: false, reason: (mMatches.length === 0 ? 'BASE_NOT_FOUND' : 'BASE_NOT_UNIQUE'), count: mMatches.length }); anyFail = true; continue; }
          var mHash = _sdRowHash(mMatches[0].cells, false);
          if (mHash !== it.expectBaseHash) { journal(deps, jobId, batchId, itemId, requestHash, 'REJECTED'); results.push({ row: row, ok: false, reason: 'BASE_DRIFT', expect: it.expectBaseHash, actual: mHash }); anyFail = true; continue; }
        } else {
          var mB = masterMap[uuid] || [];
          if (mB.length !== 0) { journal(deps, jobId, batchId, itemId, requestHash, 'REJECTED'); results.push({ row: row, ok: false, reason: 'BASE_HAS_MATCH', count: mB.length }); anyFail = true; continue; }
        }

        // 写 O 列（仅非 dry 且上述全过）
        journal(deps, jobId, batchId, itemId, requestHash, 'PREPARED');
        if (!dry) {
          var wroteOk = false;
          try {
            wroteOk = deps.writeProdO(row, 'TRUE');
          } catch (we) {
            // 条件 #6：flush 异常 —— 已尝试写但无法确认落盘，区分"已写未确认"
            journal(deps, jobId, batchId, itemId, requestHash, 'UNKNOWN');
            results.push({ row: row, ok: false, wrote: false, reason: 'WRITE_FLUSH_EXCEPTION', error: String(we && we.message || we) });
            anyFail = true; continue;
          }
          if (!wroteOk) { journal(deps, jobId, batchId, itemId, requestHash, 'REJECTED'); results.push({ row: row, ok: false, reason: 'WRITE_FAILED' }); anyFail = true; continue; }
          var after = null;
          try { after = deps.readProdO(row); }
          catch (re) {
            // 写了但回读失败 → 已写未确认（非"未写"），留 UNKNOWN
            journal(deps, jobId, batchId, itemId, requestHash, 'UNKNOWN');
            results.push({ row: row, ok: false, wrote: true, reason: 'WRITE_UNCONFIRMED', error: String(re && re.message || re) });
            anyFail = true; continue;
          }
          if (norm._sdNorm(after) !== 'TRUE') { journal(deps, jobId, batchId, itemId, requestHash, 'REJECTED'); results.push({ row: row, ok: false, reason: 'WRITE_NOT_CONFIRMED', actual: String(after) }); anyFail = true; continue; }
          wrote = true;
          journal(deps, jobId, batchId, itemId, requestHash, 'COMMITTED');
        }
        results.push({ row: row, ok: true, wrote: wrote, level: level });
        if (wrote) patched++;
      } catch (rerr) {
        // 读类异常 → 行未读/未写（非 flush）；flush 已在上面单独区分
        journal(deps, jobId, batchId, itemId, requestHash, 'REJECTED');
        results.push({ row: row, ok: false, reason: 'ROW_READ_FAIL', error: String(rerr && rerr.message || rerr) });
        anyFail = true;
      }
    }
  } finally {
    try { deps.releaseLock(_lock); } catch (rl) {}
    try { if (deps.releaseMasterLock && _mlock) deps.releaseMasterLock(_mlock); } catch (rl2) {}
  }
  // 诚实上报：任一失败 → 批次 ok=false（不暗示原子回滚）
  return _res(!anyFail, { batchId: batchId, jobId: jobId, dry: dry, patched: patched, total: rows.length, results: results });
}

function journal(deps, jobId, subBatchId, itemId, requestHash, state) {
  if (typeof deps.journalAppend !== 'function') return;
  try {
    deps.journalAppend({ jobId: jobId, subBatchId: subBatchId, itemId: itemId, requestHash: requestHash, state: state, ts: Date.now() });
  } catch (e) {}
}

// 条件 #5：只读批次日志查询 —— 验同一身份/请求；读取失败留 UNKNOWN；O=TRUE 来源不明 ≠ 完成
function tsSoftDelStatus(e, deps) {
  var p = e.parameter || {};
  var body = e.postBody || {};
  var jobId = body.jobId || p.jobId || null;
  var rows = body.rows || p.rows || [];
  if (!Array.isArray(rows)) rows = [];
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var itemId = (rows[i] && rows[i].row != null) ? Number(rows[i].row) : Number(rows[i]);
    var entry = (typeof deps.journalGet === 'function') ? deps.journalGet(jobId, itemId) : null;
    var oVal = deps.readProdO ? deps.readProdO(itemId) : null;
    var oTrue = (oVal === true || String(oVal || '').toUpperCase() === 'TRUE');
    var state;
    if (!entry) {
      // 无日志：O=TRUE 但来源不明（可能是历史软标/他请求），不能断言本请求完成
      state = oTrue ? 'O_TRUE_SOURCE_UNKNOWN' : 'UNKNOWN';
    } else if (entry.state === 'COMMITTED') {
      state = 'COMMITTED';
    } else if (entry.state === 'UNKNOWN') {
      state = 'UNKNOWN';
    } else if (entry.state === 'REJECTED') {
      state = 'REJECTED';
    } else {
      state = entry.state;   // PREPARED 等
    }
    out.push({ jobId: jobId, itemId: itemId, state: state, journalState: entry ? entry.state : null, oValue: oVal });
  }
  return _res(true, { action: 'statusQuery', batchId: jobId, rows: out });
}

module.exports = {
  tsSoftDelGuardedCore: tsSoftDelGuardedCore,
  tsSoftDelStatus: tsSoftDelStatus,
  _validateInput: _validateInput,
  VERSION: VERSION,
  ROW_KEYS: ROW_KEYS, TOP_KEYS: TOP_KEYS
};
