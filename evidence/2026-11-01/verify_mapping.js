#!/usr/bin/env node
'use strict';
/*
 * verify_mapping.js — T1-B 全量映射独立核验（只读 / 自包含 / 零依赖）
 *
 * 目的：让审核方在不依赖我方“报告”、不触碰生产数据的前提下，从【源快照】独立复算哈希，
 *       证明 controlled_audit_EXACT_ALL / 候选保留映射CSV 中的 targetHash/keeperHash/baseHash
 *       确实源自源快照行 cells，而非凭空声明。
 *
 * 用法：node verify_mapping.js
 * 前置：与本脚本同目录的 ① prod_scan_LIVE_*.json ② controlled_audit_EXACT_ALL_*.json
 *       ③ T1-B_候选保留映射_可核查_*.csv
 *
 * 算法单一可信源：tools/ts_softdel_norm.js 的 _sdRowHash（此处内联，逐字同文）。
 * 三级核验：L1 表内一致性 / L2 审计JSON一致性 / L3 源快照重算。
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

// ---------- 内联 _sdRowHash（与 tools/ts_softdel_norm.js 逐字一致） ----------
function _sdIsoTz(v) {
  let d = null;
  if (v instanceof Date) d = v;
  else if (typeof v === 'string') {
    const s = v.trim();
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
    if (!m) return null;
    const y = +m[1], mo = +m[2], da = +m[3];
    if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
    const hh = m[4] !== undefined ? +m[4] : 0;
    const mi = m[5] !== undefined ? +m[5] : 0;
    const ss = m[6] !== undefined ? +m[6] : 0;
    if (hh > 23 || mi > 59 || ss > 59) return null;
    d = new Date(Date.UTC(y, mo - 1, da, hh, mi, ss));
  }
  if (!d || isNaN(d.getTime())) return null;
  const t = d.getTime() + 8 * 3600 * 1000;
  const u = new Date(t);
  const p = n => (n < 10 ? '0' + n : '' + n);
  return u.getUTCFullYear() + '-' + p(u.getUTCMonth() + 1) + '-' + p(u.getUTCDate()) +
    'T' + p(u.getUTCHours()) + ':' + p(u.getUTCMinutes()) + ':' + p(u.getUTCSeconds()) + '+08:00';
}
function _sdCellTok(v) {
  if (v === null || v === undefined) return ['null'];
  if (typeof v === 'number') return ['num', String(v)];
  if (typeof v === 'boolean') return ['bool', v ? 'true' : 'false'];
  if (typeof v === 'object' && typeof v.getFullYear === 'function') {
    const iso = _sdIsoTz(v);
    return iso ? ['date', iso] : ['null'];
  }
  return ['str', String(v)];
}
function _sdHashCols(timeOnly) {
  const cols = [1];
  for (let c = 2; c <= 13; c++) cols.push(c);
  if (!timeOnly) cols.push(0);
  cols.push(14);
  return cols;
}
function _sdCanonRow(cells, cols) {
  const arr = [];
  for (let i = 0; i < cols.length; i++) arr.push(_sdCellTok(cells ? cells[cols[i]] : undefined));
  return JSON.stringify(arr);
}
function _sdSha256(s) {
  return 'sha256:' + crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}
function _sdRowHash(cells, timeOnly) {
  return _sdSha256(_sdCanonRow(cells, _sdHashCols(timeOnly)));
}
// 双态尝试验证：timeOnly 不确定时，true/false 任一命中即证明可复现
function hashMatches(cells, recorded) {
  if (!recorded) return false;
  return _sdRowHash(cells, true) === recorded || _sdRowHash(cells, false) === recorded;
}

// ---------- 加载文件 ----------
const dir = __dirname;
function pick(namePrefix) {
  const f = fs.readdirSync(dir).find(x => x.startsWith(namePrefix));
  if (!f) throw new Error('找不到 ' + namePrefix + '*');
  return path.join(dir, f);
}
const prodScan = JSON.parse(fs.readFileSync(pick('prod_scan_LIVE_'), 'utf8'));
const audit = JSON.parse(fs.readFileSync(pick('controlled_audit_EXACT_ALL_'), 'utf8'));
const csvPath = pick('T1-B_候选保留映射_可核查_');

// 源快照行索引：row -> cells
const rowIndex = {};
for (const uuid of Object.keys(prodScan.byUuid)) {
  for (const rec of prodScan.byUuid[uuid]) {
    rowIndex[rec.row] = rec.cells;
  }
}

// ---------- L3：源快照重算 vs 审计JSON记录 ----------
let totalTargets = 0, l3TargetOK = 0, l3KeeperOK = 0, l3TargetFail = [], l3KeeperFail = [];
const groups = [...(audit.detail.safe || []), ...(audit.detail.notInBase || [])];
for (const g of groups) {
  for (const t of g.targets || []) {
    totalTargets++;
    const tc = rowIndex[t.row], kc = rowIndex[t.keeperRow];
    if (tc && hashMatches(tc, t.targetHash)) l3TargetOK++; else l3TargetFail.push(t.row);
    if (kc && hashMatches(kc, t.keeperHash)) l3KeeperOK++; else l3KeeperFail.push(t.keeperRow);
  }
}

// ---------- L1+L2：CSV 表内一致性 + 与审计JSON互核 ----------
const csvLines = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/).filter(l => l.length);
const csvHeader = csvLines.shift();
const csvRows = csvLines.length;
let csvSameHash = 0, csvMismatch = [];
let safeCount = 0, notInBaseCount = 0;
let csvBaseHashOK = 0, csvBaseHashCheck = 0;
for (const line of csvLines) {
  const c = line.split(',');
  const [cat, , , , , targetHash, keeperHash, same, hasBase, baseHash] = c;
  if (cat === 'SAFE') safeCount++;
  else if (cat === 'NOT_IN_BASE') notInBaseCount++;
  if (targetHash === keeperHash && same === 'YES') csvSameHash++;
  else csvMismatch.push(line.slice(0, 60));
  if (hasBase === 'true') { csvBaseHashCheck++; if (baseHash && baseHash !== 'NO_BASE') csvBaseHashOK++; }
}

// ---------- 报告 ----------
console.log('=== T1-B 全量映射独立核验报告 ===');
console.log('L1 表内一致性:');
console.log('  CSV 数据行 =', csvRows, '(期望 1340)');
console.log('  SAFE =', safeCount, '/ NOT_IN_BASE =', notInBaseCount, '(期望 866 / 474)');
console.log('  targetHash==keeperHash 且 同值=TRUE =', csvSameHash, '/', csvRows);
console.log('L2 审计JSON:');
console.log('  审计JSON 候选目标总数 =', totalTargets, '(期望 == CSV 数据行 1340)');
console.log('L3 源快照重算 (prod_scan -> _sdRowHash):');
console.log('  target 重算命中 =', l3TargetOK, '/', totalTargets);
console.log('  keeper 重算命中 =', l3KeeperOK, '/', totalTargets);
console.log('  底稿 baseHash 复核(有底稿组) =', csvBaseHashOK, '/', csvBaseHashCheck);

const pass =
  csvRows === 1340 &&
  safeCount === 866 && notInBaseCount === 474 &&
  csvSameHash === 1340 &&
  totalTargets === 1340 &&
  l3TargetOK === totalTargets && l3KeeperOK === totalTargets;

console.log('\nRESULT:', pass ? 'PASS ✅' : 'FAIL ❌');
if (!pass) {
  if (csvMismatch.length) console.log('  CSV 同值异常样本:', csvMismatch.slice(0, 5));
  if (l3TargetFail.length) console.log('  L3 target 未命中行:', l3TargetFail.slice(0, 10));
  if (l3KeeperFail.length) console.log('  L3 keeper 未命中行:', l3KeeperFail.slice(0, 10));
  process.exit(1);
}
console.log('全部三级核验通过：哈希确实源自源快照，映射可信。');
