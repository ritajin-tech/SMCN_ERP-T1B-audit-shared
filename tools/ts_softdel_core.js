// ts_softdel_core.js — 软标动作【真实服务端业务核心】
// 单一可信源：GAS 部署（RemoteActions）与原生 Node 隔离 harness 共用同一份逻辑，
// 仅通过 deps 注入存储/锁/网络/期锁依赖，不在测试替身里另写一份更强的服务端逻辑。
//
// 设计目标（回应 Tom 2026-10-27 复审，点2/3/6 + 分阶段方案）：
//  - 期锁：锁内对目标行业务日期跑 _plGuardCheck；锁定期默认拒（PERIOD_LOCKED），
//    仅当携带【独立授权】的 clearance 且通过校验才放行（默认不放开门禁）。
//  - CAS 绑定到已审计原值：请求必须携带 target/keeper 的规范化 14 列 hash 与 A 级底稿 hash；
//    锁内重读实时值与预期 hash 比对，目标+keeper 一起漂移也会因 hash 不符被拒（DRIFT）。
//  - fail-closed：默认 dry（不写，除非显式 dry='0'）；sheet 锁定 PL_DB_SHEET（拒绝调用方覆盖）；
//    结构化校验拒绝 row==keeperRow / 重复目标 / 越界 / 非法 level / 未知字段；
//    timeOnly 用严格布尔（字符串 'false' 不再算真）；部分写后诚实返回 ok=false 并逐行标明已写/未写。
//  - 批次 journal：返回逐项 {row,ok,wrote,reason}；并提供只读状态查询（按 row 回读真实 O）。

'use strict';

// ---- 规范化与 hash（与 GAS 端 _sdNorm 保持一致）----
// 跨格式一致性：GAS 原生读（数值/布尔/Date）与 Node/hktool 读（常为字符串）须归一化到同一字符串。
//  - 数值：统一走 String(Number(x))，消除 "8.0"/8 的差别；
//  - 布尔：true/false；空：''。
function _sdNorm(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  var s = String(v).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return String(Number(s)); // "8.0"→"8"，与 GAS 原生数值对齐
  return s;
}
function _sdSoftDel(r) {
  return (r === true || String(r || '').toUpperCase() === 'TRUE');
}
// 规范化 hash：对 2..13 列（排除 0=录入时间、1=业务日期两个日期列）做内容指纹（djb2）。
// 排除日期列的原因：
//   - 列0 是 timeOnly 允许差异的列，排除后 timeOnly 行仍能 hash 命中（与软标语义一致）；
//   - 列1 是 Date，GAS 原生 Date 与 hktool 字符串序列化不同，排除避免跨格式误判；
//     其正确性由服务端 _plGuardCheck（期锁）与 PAYLOAD_DIFF（目标vs keeper，同格式）兜底。
function _sdNormHash(cells) {
  var s = '';
  for (var c = 2; c <= 13; c++) s += '\x1f' + _sdNorm(cells ? cells[c] : '');
  var h = 5381;
  for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return 'h' + h.toString(16);
}
function _isTrue(v) {
  return v === true || v === 'true' || v === 1 || v === '1';
}
function _isFalse(v) {
  return v === false || v === 'false' || v === 0 || v === '0' || v == null;
}

// 允许透传的字段白名单（未知字段一律拒绝 —— fail-closed）
var ROW_KEYS = ['row', 'uuid', 'keeperRow', 'level', 'timeOnly',
  'expectHash', 'keeperHash', 'expectBaseHash', 'clearance'];

// 主入口：e={parameter, postBody}；deps 注入真实/模拟依赖。
// deps 必须提供：
//   PL_DB_SHEET, PROD_TAB, BASE_TAB, MASTER_ID, TS_ID
//   readProdRow(row) -> cells[0..14] | null
//   writeProdO(row, value) -> bool（写入成功）
//   readProdO(row) -> value
//   readMasterByUuid(uuid) -> [{row, cells}]（扫底稿，返回所有匹配）
//   acquireLock() -> handle；releaseLock(handle)
//   policy() -> 期锁策略对象
//   guardCheck(bizDate, origDate, policy) -> {ok, reason}
//   isClearance(token, rows) -> bool（独立授权的历史清理放行，默认 false）
function tsSoftDelGuardedCore(e, deps) {
  e = e || {};
  var p = e.parameter || {};
  var body = e.postBody || {};
  var rows = body.rows || p.rows || [];
  // 默认 dry = true（fail-closed：不写，除非显式 dry='0'/'false' 才写）
  var dry = true;
  var dryExplicit = (p.dry !== undefined) ? p.dry : body.dry;
  if (dryExplicit !== undefined && _isFalse(dryExplicit)) dry = false;
  var batchId = body.batchId || p.batchId || null;
  var sheetName = String(p.sheet || body.sheet || deps.PL_DB_SHEET);
  var MASTER_ID = deps.MASTER_ID;
  var BASE_TAB = deps.BASE_TAB;

  if (!rows.length) return _res(false, { error: 'no rows provided' });
  if (rows.length > 2000) return _res(false, { error: 'too many rows: ' + rows.length });

  // fail-closed：sheet 锁定 PL_DB_SHEET，拒绝调用方覆盖
  if (sheetName !== deps.PL_DB_SHEET) {
    return _res(false, { error: 'sheet not allowed: ' + sheetName + ' (must be ' + deps.PL_DB_SHEET + ')' });
  }

  // 结构化校验：每行必须带合法字段；拒绝 row==keeperRow / 重复目标 / 越界 / 非法 level / 未知字段
  var seenTarget = {};
  for (var z = 0; z < rows.length; z++) {
    var zr = rows[z] || {};
    var unknown = Object.keys(zr).filter(function (k) { return ROW_KEYS.indexOf(k) < 0; });
    if (unknown.length) return _res(false, { error: 'row#' + z + ' unknown fields: ' + unknown.join(',') });
    var zrow = Number(zr.row), zk = Number(zr.keeperRow);
    if (!Number.isInteger(zrow) || zrow < 2) return _res(false, { error: 'row#' + z + ' bad row: ' + zr.row });
    if (!Number.isInteger(zk) || zk < 2) return _res(false, { error: 'row#' + z + ' bad keeperRow: ' + zr.keeperRow });
    if (!zr.uuid) return _res(false, { error: 'row#' + z + ' missing uuid' });
    if (zr.row === zr.keeperRow) return _res(false, { error: 'row#' + z + ' row==keeperRow (self-reference)' });
    if (zr.level !== 'A' && zr.level !== 'B') return _res(false, { error: 'row#' + z + ' bad level: ' + zr.level });
    if (!zr.expectHash || !zr.keeperHash) return _res(false, { error: 'row#' + z + ' missing expectHash/keeperHash' });
    if (zr.level === 'A' && !zr.expectBaseHash) return _res(false, { error: 'row#' + z + ' A-level missing expectBaseHash' });
    if (zr.timeOnly != null && !_isTrue(zr.timeOnly) && !_isFalse(zr.timeOnly)) {
      return _res(false, { error: 'row#' + z + ' bad timeOnly' });
    }
    if (seenTarget[zrow]) return _res(false, { error: 'duplicate target row: ' + zrow });
    seenTarget[zrow] = true;
  }

  var clearanceToken = body.clearance || p.clearance || null;
  var clearanceOk = false;
  if (clearanceToken) clearanceOk = !!deps.isClearance(clearanceToken, rows);

  var _lock = deps.acquireLock();
  var results = [], patched = 0, anyFail = false;
  try {
    for (var i = 0; i < rows.length; i++) {
      var it = rows[i] || {};
      var row = Number(it.row), uuid = String(it.uuid || '');
      var keeperRow = Number(it.keeperRow), level = String(it.level || '');
      var timeOnly = _isTrue(it.timeOnly);
      try {
        var vals = deps.readProdRow(row);
        if (!vals) { results.push({ row: row, ok: false, reason: 'ROW_NOT_FOUND' }); anyFail = true; continue; }
        var kVals = deps.readProdRow(keeperRow);

        // UUID 身份
        if (_sdNorm(vals[8]) !== uuid) {
          results.push({ row: row, ok: false, reason: 'UUID_DRIFT', actual: _sdNorm(vals[8]) }); anyFail = true; continue;
        }
        // 已软标 → 幂等跳过（真实返回 ok:false/ALREADY_SOFTDEL，不虚构 ok:true）
        if (_sdSoftDel(vals[14])) {
          results.push({ row: row, ok: false, wrote: false, reason: 'ALREADY_SOFTDEL' }); anyFail = true; continue;
        }
        if (!kVals || _sdSoftDel(kVals[14])) {
          results.push({ row: row, ok: false, reason: 'KEEPER_INVALID' }); anyFail = true; continue;
        }

        // CAS 绑定到已审计原值：实时规范化 hash 必须与请求携带的预期 hash 一致
        var liveHash = _sdNormHash(vals);
        var liveKHash = _sdNormHash(kVals);
        if (liveHash !== it.expectHash) {
          results.push({ row: row, ok: false, reason: 'TARGET_DRIFT', expect: it.expectHash, actual: liveHash }); anyFail = true; continue;
        }
        if (liveKHash !== it.keeperHash) {
          results.push({ row: row, ok: false, reason: 'KEEPER_DRIFT', expect: it.keeperHash, actual: liveKHash }); anyFail = true; continue;
        }
        // 负载一致性（keeper 已确认 hash 一致，此处冗余保险）：除 timeOnly 豁免列0外须全同
        var diffs = [];
        for (var c = 0; c <= 13; c++) if (_sdNorm(vals[c]) !== _sdNorm(kVals[c])) diffs.push(c);
        var allowed = timeOnly && diffs.length > 0 && diffs.every(function (x) { return x === 0; });
        if (diffs.length > 0 && !allowed) {
          results.push({ row: row, ok: false, reason: 'PAYLOAD_DIFF', cols: diffs }); anyFail = true; continue;
        }

        // 期锁：锁内对目标行业务日期跑 _plGuardCheck；锁定期默认拒，除非独立授权 clearance
        var bizDate = _sdNorm(vals[1]);
        if (deps.guardCheck) {
          var g = deps.guardCheck(bizDate, null, deps.policy());
          if (!g.ok && !clearanceOk) {
            results.push({ row: row, ok: false, reason: 'PERIOD_LOCKED', date: bizDate, detail: g.reason || '' }); anyFail = true; continue;
          }
        }

        // 等级与底稿核对（A：底稿恰 1 行且 hash/状态相符；B：底稿 0 行）
        if (level === 'A') {
          var mMatches = deps.readMasterByUuid(uuid) || [];
          if (mMatches.length !== 1) {
            results.push({ row: row, ok: false, reason: (mMatches.length === 0 ? 'BASE_NOT_FOUND' : 'BASE_NOT_UNIQUE'), count: mMatches.length }); anyFail = true; continue;
          }
          var mHash = _sdNormHash(mMatches[0].cells);
          if (mHash !== it.expectBaseHash) {
            results.push({ row: row, ok: false, reason: 'BASE_DRIFT', expect: it.expectBaseHash, actual: mHash }); anyFail = true; continue;
          }
        } else { // B
          var mB = deps.readMasterByUuid(uuid) || [];
          if (mB.length !== 0) {
            results.push({ row: row, ok: false, reason: 'BASE_HAS_MATCH', count: mB.length }); anyFail = true; continue;
          }
        }

        // 写 O 列（仅非 dry 且上述全过）
        var wrote = false;
        if (!dry) {
          if (!deps.writeProdO(row, 'TRUE')) {
            results.push({ row: row, ok: false, reason: 'WRITE_FAILED' }); anyFail = true; continue;
          }
          var after = deps.readProdO(row);
          if (_sdNorm(after) !== 'TRUE') {
            results.push({ row: row, ok: false, reason: 'WRITE_NOT_CONFIRMED', actual: String(after) }); anyFail = true; continue;
          }
          wrote = true;
        }
        results.push({ row: row, ok: true, wrote: wrote, level: level });
        if (wrote) patched++;
      } catch (rerr) {
        results.push({ row: row, ok: false, reason: 'ROW_READ_FAIL', error: String(rerr && rerr.message || rerr) });
        anyFail = true;
      }
    }
  } finally {
    try { deps.releaseLock(_lock); } catch (rl) {}
  }
  // 诚实上报：任一失败 → 批次 ok=false（不暗示原子回滚）
  return _res(!anyFail, { batchId: batchId, dry: dry, patched: patched, total: rows.length, results: results });
}

function _res(ok, extra) {
  var o = { ok: !!ok };
  for (var k in extra) if (extra.hasOwnProperty(k)) o[k] = extra[k];
  return JSON.stringify(o);
}

module.exports = {
  tsSoftDelGuardedCore: tsSoftDelGuardedCore,
  _sdNorm: _sdNorm, _sdSoftDel: _sdSoftDel, _sdNormHash: _sdNormHash,
  _isTrue: _isTrue, _isFalse: _isFalse, ROW_KEYS: ROW_KEYS
};
