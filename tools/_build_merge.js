'use strict';
const fs = require('fs');
const SRC = 'C:/Users/rita.jin/SMCN_ERP-T1B-audit-shared/tools/_live_PeriodLockGuard.js';
const OUT = 'C:/Users/rita.jin/SMCN_ERP-T1B-audit-shared/tools/_merged_PeriodLockGuard.js';
let s = fs.readFileSync(SRC, 'utf8');

// ---- 0. Ledger functions + helpers (insert before _plAcquire) ----
const LEDGER = `
// === T1-B N3 收敛：请求级耐久账本（owner-ruled M2 v1，不换链接 @HEAD 推送） ===
var PL_LEDGER_KEY = 'TS_WRITE_LEDGER';
function _plLedgerGet(requestId) {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(PL_LEDGER_KEY);
    if (!raw) return null;
    var m = JSON.parse(raw);
    return (m && m[requestId]) ? m[requestId] : null;
  } catch (e) { return null; }
}
function _plLedgerSet(requestId, state, payloadHash) {
  var props = PropertiesService.getScriptProperties();
  var m = {};
  var raw = props.getProperty(PL_LEDGER_KEY);
  if (raw) { try { m = JSON.parse(raw) || {}; } catch (e) { m = {}; } }
  m[requestId] = {
    state: state, payloadHash: payloadHash,
    ts: Utilities.formatDate(new Date(), 'GMT+8', 'yyyy-MM-dd HH:mm:ss')
  };
  props.setProperty(PL_LEDGER_KEY, JSON.stringify(m)); // 同步提交即抛，无 uncertain 返回
}
function _plDeriveRequestId(seed) {
  try {
    var str = (typeof seed === 'string') ? seed : JSON.stringify(seed);
    var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str);
    return 'plr_' + Utilities.base64EncodeWebSafe(digest);
  } catch (e) { return 'plr_fb_' + String(Math.abs(((seed || '') + '').length)); }
}
// 预留/重放/挂起：返回 {action:'replay'|'proceed'}，PENDING 抛 PL_SUSPEND_PENDING_INFLIGHT
function _plLedgerReserveOrReplay(requestId, payloadHash) {
  var led = _plLedgerGet(requestId);
  if (led && led.state === 'DONE') {
    if (led.payloadHash === payloadHash) return { action: 'replay' };
    var em = new Error('PL_REJECT_REQUEST_ID_MISMATCH'); em.plCode = 'PL_REJECT_REQUEST_ID_MISMATCH'; throw em;
  }
  if (led && led.state === 'PENDING') {
    var ep = new Error('PL_SUSPEND_PENDING_INFLIGHT'); ep.plCode = 'PL_SUSPEND_PENDING_INFLIGHT'; throw ep;
  }
  try { _plLedgerSet(requestId, 'PENDING', payloadHash); }
  catch (le) { var el = new Error('PL_SUSPEND_LEDGER_IO'); el.plCode = 'PL_SUSPEND_LEDGER_IO'; el.plCause = String(le); throw el; }
  return { action: 'proceed' };
}
`;

const anchorAcquire = 'function _plAcquire(timeoutMs) {';
if (!s.includes(anchorAcquire)) throw new Error('anchor _plAcquire not found');
if (s.includes('PL_LEDGER_KEY')) throw new Error('ledger already present? abort');
s = s.replace(anchorAcquire, LEDGER + '\n' + anchorAcquire);

// NOTE: insert (C) BEFORE (A) so the (C) anchor still maps to the original
// call site (the (A) block re-emits the same line, which would otherwise steal the match).
// ---- 1. _plGuardedInsert (C) after bizWrite, then (A) before enteredWrite ----
const insC_anchor = "    var result = opts.bizWrite(rows, policy);";
const insC_block = `    var result = opts.bizWrite(rows, policy);
    // [T1-B N3] 业务写成功 → 翻转 DONE（同步提交即抛；失败=挂起，绝不翻重/绝不写第二标记）
    try { _plLedgerSet(_rid, 'DONE', _ph); }
    catch (le) { logAttempted = true; var _ed = new Error('PL_SUSPEND_LEDGER_IO'); _ed.plCode = 'PL_SUSPEND_LEDGER_IO'; _ed.plCause = String((le && le.message) || le); throw _ed; }`;
if (!s.includes(insC_anchor)) throw new Error('insert (C) anchor not found');
s = s.replace(insC_anchor, insC_block);

const insA_anchor = "    enteredWrite = true;\n    var result = opts.bizWrite(rows, policy);";
const insA_block = `    // [T1-B N3/owner-ruled M2] 请求级耐久账本：预留/重放/挂起（不换链接 @HEAD）
    var _rid = opts.requestId || _plDeriveRequestId({ k: 'ins', r: opts.rows, d: opts.dateOf });
    var _ph = opts.payloadHash || _plDeriveRequestId({ k: 'ins-p', r: opts.rows, d: opts.dateOf });
    var _lr = _plLedgerReserveOrReplay(_rid, _ph);
    if (_lr.action === 'replay') { return { wrote: 0, duplicates: duplicates, replay: true }; }
    enteredWrite = true;
    var result = opts.bizWrite(rows, policy);`;
if (!s.includes(insA_anchor)) throw new Error('insert (A) anchor not found');
s = s.replace(insA_anchor, insA_block);

// ---- 2. _plGuardedMutation (C) after bizWrite, then (A) before enteredWrite ----
const mutC_anchor = "    var result = opts.bizWrite(recheck, policy);";
const mutC_block = `    var result = opts.bizWrite(recheck, policy);
    // [T1-B N3] 业务写成功 → 翻转 DONE
    try { _plLedgerSet(_rid, 'DONE', _ph); }
    catch (le) { logAttempted = true; var _ed = new Error('PL_SUSPEND_LEDGER_IO'); _ed.plCode = 'PL_SUSPEND_LEDGER_IO'; _ed.plCause = String((le && le.message) || le); throw _ed; }`;
if (!s.includes(mutC_anchor)) throw new Error('mutation (C) anchor not found');
s = s.replace(mutC_anchor, mutC_block);

const mutA_anchor = "    enteredWrite = true;\n    var result = opts.bizWrite(recheck, policy);";
const mutA_block = `    // [T1-B N3/owner-ruled M2] 请求级耐久账本：预留/重放/挂起（不换链接 @HEAD）
    var _rid = opts.requestId || _plDeriveRequestId({ k: 'mut', u: opts.uuid, n: opts.newDateRaw });
    var _ph = opts.payloadHash || _plDeriveRequestId({ k: 'mut-p', u: opts.uuid, n: opts.newDateRaw });
    var _lr = _plLedgerReserveOrReplay(_rid, _ph);
    if (_lr.action === 'replay') { return { wrote: 0, replay: true }; }
    enteredWrite = true;
    var result = opts.bizWrite(recheck, policy);`;
if (!s.includes(mutA_anchor)) throw new Error('mutation (A) anchor not found');
s = s.replace(mutA_anchor, mutA_block);

// sanity: counts
const cnt = (re) => (s.match(re) || []).length;
console.log('PL_LEDGER_KEY present:', s.includes('PL_LEDGER_KEY'));
console.log('_plLedgerGet defs:', cnt(/function _plLedgerGet\(/g));
console.log('_plLedgerSet defs:', cnt(/function _plLedgerSet\(/g));
console.log('_plLedgerReserveOrReplay defs:', cnt(/function _plLedgerReserveOrReplay\(/g));
console.log('_plDeriveRequestId defs:', cnt(/function _plDeriveRequestId\(/g));
console.log('insert (A) replay-return:', cnt(/_lr\.action === 'replay'/g));
console.log('insert (C) flip:', cnt(/_plLedgerSet\(_rid, 'DONE', _ph\)/g));
console.log('mutation (A) replay-return:', cnt(/_lr\.action === 'replay'/g));
fs.writeFileSync(OUT, s);
console.log('merged written to', OUT, '| bytes=', Buffer.byteLength(s), '| lines=', s.split('\n').length);
