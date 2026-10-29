#!/usr/bin/env node
// 离线受控审计生成器（零 hktool 依赖）—— 由 live prod_scan + 底稿快照 CSV 派生执行器兼容 JSON
//
// 安全判据（严格对齐 ts_softdel_core.js 服务端 CAS）：
//  - 组内 prod 副本 col0..13 全同        -> exact   （timeOnly=false）
//  - 组内仅 col0(录入时间) 不同          -> timeonly（须 --allow-time-only，哈希按 timeOnly=true）
//  - col1..13 任一不同                  -> mixed   （UNSAFE，剔除，绝不动）
//  - 底稿该 UUID 行数 == 1              -> A 级（须 expectBaseHash，按 timeOnly=false 计）
//  - 底稿该 UUID 行数 == 0              -> B 级（notInBase，底稿须 0 行）
//  - 底稿该 UUID 行数 >= 2              -> 歧义（UNSAFE 剔除）
//  - A 级 exact：底稿恰 1 行；服务端会再校验底稿自身哈希自洽（本离线工具不再做 prod↔底稿 内容比对）
//
// 哈希（单一可信源 ts_softdel_norm._sdRowHash）：
//  - targetHash / keeperHash 按该组 timeOnly 标志
//  - baseHash 恒按 timeOnly=false（服务端 mHash 恒 false）
//
// 用法：
//   node tools/ts_controlled_audit_offline.js \
//     --prod _tmp/evidence/prod_scan_2026-10-29-13-50-10.json \
//     --base _backups/sheets/2026-10-29/主库T1B__工时.csv \
//     [--out _tmp/evidence]
//
// 测试：node tools/ts_controlled_audit_offline.test.js   （分类边界与失败关闭条件负例）
'use strict';

const fs = require('fs');
const path = require('path');
const norm = require('./ts_softdel_norm.js');
const _sdRowHash = norm._sdRowHash;
const _sdNorm = norm._sdNorm;
const HEADER_KEY = '⚙ 唯一码 (UUID)';
const UUID_COL = 8;

function parseArgs(argv) {
  const o = { prod: null, base: null, out: path.join(__dirname, '..', '_tmp', 'evidence') };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--prod') o.prod = argv[++i];
    else if (argv[i] === '--base') o.base = argv[++i];
    else if (argv[i] === '--out') o.out = argv[++i];
  }
  return o;
}

// RFC4180 风格 CSV 解析（处理双引号转义与字段内逗号）
function parseCsv(text) {
  const rows = [];
  let i = 0, n = text.length;
  while (i < n) {
    const row = []; let field = '';
    while (i < n && text[i] !== '\n' && text[i] !== '\r') {
      if (text[i] === '"') {
        i++;
        while (i < n) {
          if (text[i] === '"') {
            if (text[i + 1] === '"') { field += '"'; i += 2; }
            else { i++; break; }
          } else { field += text[i]; i++; }
        }
      } else if (text[i] === ',') {
        row.push(field); field = ''; i++;
      } else { field += text[i]; i++; }
    }
    while (i < n && (text[i] === '\r' || text[i] === '\n')) i++;
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}

function normCells(cells) {
  // 补齐到至少 15 列（含 O 列索引 14），缺失按空串
  const c = cells.slice();
  while (c.length < 15) c.push('');
  return c;
}

// ---------------------------------------------------------------------------
// 🔴 纯分类函数（可测，无 IO / 无副作用）：给定一组 prod 副本 + 底稿行数组，判定归类。
// 返回：
//   { bucket:'safeExactA'|'safeTimeOnlyA'|'notInBase'|'timeonlyB', rec }   —— 可纳入候选
//   { bucket:'unsafe', reason:'PAYLOAD_DIFF'|'BASE_NOT_UNIQUE' }            —— 剔除（UNSAFE，绝不动）
//   { bucket:'alreadyHandled' }                                            —— 历史已正确终态，排除
//   null                                                                  —— 不足 2 行 / 表头，跳过
// 这是 Tom 要求的"分类边界与失败关闭条件"的唯一权威实现，单测见 ts_controlled_audit_offline.test.js。
// ---------------------------------------------------------------------------
function classifyGroup(uuid, entries, baseArr) {
  if (!Array.isArray(entries) || entries.length < 2) return null;
  if (uuid === HEADER_KEY) return null;

  // 失败关闭条件①：组内任一副本 O 列已 TRUE → 已是正确终态（保留活体+标记冗余），不再纳入 candidate
  const anySoft = entries.some(e => String(e.soft).toUpperCase() === 'TRUE');
  if (anySoft) return { bucket: 'alreadyHandled' };

  const cols = entries.map(e => normCells(e.cells).slice(0, 14));
  const identicalAll = cols.every(c => JSON.stringify(c) === JSON.stringify(cols[0]));
  const payloadKey = c => JSON.stringify(c.slice(1, 14)); // col1..13
  const identicalPayload = cols.every(c => payloadKey(c) === payloadKey(cols[0]));

  let type, timeOnly;
  if (identicalAll) { type = 'exact'; timeOnly = false; }
  else if (identicalPayload) { type = 'timeonly'; timeOnly = true; }
  else { type = 'mixed'; timeOnly = false; }

  const bc = (baseArr || []).length;

  // 失败关闭条件②：payload 不一致 → UNSAFE，剔除
  if (type === 'mixed') return { bucket: 'unsafe', reason: 'PAYLOAD_DIFF' };
  // 失败关闭条件③：底稿非唯一 → UNSAFE，剔除
  if (bc >= 2) return { bucket: 'unsafe', reason: 'BASE_NOT_UNIQUE' };

  // keeper = 第一条（最低行号）；targets = 其余
  const sorted = entries.slice().sort((a, b) => a.row - b.row);
  const keeper = sorted[0];
  const targets = sorted.slice(1);
  const kCells = normCells(keeper.cells);

  const buildTarget = (t) => {
    const tCells = normCells(t.cells);
    const baseCells = (bc === 1) ? normCells(baseArr[0]) : kCells;
    return {
      row: t.row,
      keeperRow: keeper.row,
      targetHash: _sdRowHash(tCells, timeOnly),
      keeperHash: _sdRowHash(kCells, timeOnly),
      baseHash: _sdRowHash(baseCells, false)
    };
  };
  const rec = { uuid, baseCount: bc, targets: targets.map(buildTarget) };

  if (bc === 1) {
    // A 级（底稿恰 1 行）：exact 或 timeonly
    return { bucket: (type === 'exact') ? 'safeExactA' : 'safeTimeOnlyA', rec };
  }
  // bc === 0 -> B 级（notInBase）：exact 或 timeonly（后者需另行授权）
  return { bucket: (type === 'exact') ? 'notInBase' : 'timeonlyB', rec };
}

function main() {
  const o = parseArgs(process.argv);
  if (!o.prod || !o.base) {
    console.error('usage: --prod <scan.json> --base <base.csv> [--out <dir>]');
    process.exit(2);
  }
  const ps = JSON.parse(fs.readFileSync(o.prod, 'utf8'));
  const byUuid = ps.byUuid || {};
  const scanMeta = ps.meta || {};

  // 底稿快照
  const baseText = fs.readFileSync(o.base, 'utf8');
  const baseRows = parseCsv(baseText);
  const baseByUuid = {};
  for (let r = 1; r < baseRows.length; r++) {
    const row = baseRows[r];
    if (row.length <= UUID_COL) continue;
    const u = _sdNorm(row[UUID_COL]);
    if (u) (baseByUuid[u] = baseByUuid[u] || []).push(normCells(row));
  }

  const safeExactA = [];
  const safeTimeOnlyA = [];
  const notInBase = [];
  const timeonlyB = [];
  const unsafe = [];
  const alreadyHandled = [];

  for (const uuid of Object.keys(byUuid)) {
    const entries = byUuid[uuid];
    const c = classifyGroup(uuid, entries, baseByUuid[uuid] || []);
    if (!c) continue;
    if (c.bucket === 'alreadyHandled') { alreadyHandled.push(uuid); continue; }
    if (c.bucket === 'unsafe') { unsafe.push({ uuid, reason: c.reason, prodCopies: entries.length }); continue; }
    if (c.bucket === 'safeExactA') safeExactA.push(c.rec);
    else if (c.bucket === 'safeTimeOnlyA') safeTimeOnlyA.push(c.rec);
    else if (c.bucket === 'notInBase') notInBase.push(c.rec);
    else if (c.bucket === 'timeonlyB') timeonlyB.push(c.rec);
  }

  const stamp = (scanMeta.scannedAtBJT || new Date(Date.now() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19)).replace(/[:\s]/g, '-');
  const out = o.out;
  fs.mkdirSync(out, { recursive: true });

  const metaBlock = {
    generatedAtBJT: new Date(Date.now() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19),
    source: { prodScan: o.prod, baseSnapshot: o.base, scanMeta },
    logic: 'A/B 级冗余副本软标（O 列=TRUE，不物理删）；哈希单一可信源 ts_softdel_norm._sdRowHash',
    note: 'phase1_exactA 用 --audit-safe 跑（无 --allow-time-only）；phase2_timeonlyA 用 --audit-safe --allow-time-only；phase2_B 用 --audit-all'
  };

  const writeJson = (name, detail) => {
    const fp = path.join(out, name);
    fs.writeFileSync(fp, JSON.stringify({ meta: metaBlock, detail }, null, 2), 'utf8');
    return fp;
  };

  const fp1 = writeJson('controlled_audit_phase1_exactA_' + stamp + '.json', { safe: safeExactA, notInBase: [] });
  const fp2 = writeJson('controlled_audit_phase2_timeonlyA_' + stamp + '.json', { safe: safeTimeOnlyA, notInBase: [] });
  const fp3 = writeJson('controlled_audit_phase2_B_' + stamp + '.json', { safe: [], notInBase });
  const fpS = writeJson('controlled_audit_summary_' + stamp + '.json', {
    counts: {
      safeExactA: safeExactA.length,
      safeTimeOnlyA: safeTimeOnlyA.length,
      notInBaseExact: notInBase.length,
      timeonlyB: timeonlyB.length,
      unsafe: unsafe.length,
      alreadyHandled: alreadyHandled.length
    },
    unsafeList: unsafe,
    timeonlyBList: timeonlyB.map(r => r.uuid),
    alreadyHandledList: alreadyHandled
  });

  const sumRows = arr => arr.reduce((s, r) => s + r.targets.length, 0);
  console.log('=== 离线受控审计生成完成 ===');
  console.log('A 级精确 (phase1_exactA) :', safeExactA.length, '组 /', sumRows(safeExactA), '冗余行 ->', fp1);
  console.log('A 级仅col0差(phase2_tOA) :', safeTimeOnlyA.length, '组 /', sumRows(safeTimeOnlyA), '冗余行 ->', fp2);
  console.log('B 级底稿0行 (phase2_B)    :', notInBase.length, '组 /', sumRows(notInBase), '冗余行 ->', fp3);
  console.log('B 级仅col0差(需另授权)    :', timeonlyB.length, '组');
  console.log('剔除(UNSAFE)              :', unsafe.length, '组 ->', fpS);
  console.log('历史已处理(组内已有TRUE)   :', alreadyHandled.length, '组（已正确终态，不纳入 candidate）');
  console.log('  (明细见 summary 的 alreadyHandledList)');
}

// 🔴 导出（供单测 / 执行器复用）；直接运行时才跑 main()
module.exports = { classifyGroup, parseCsv, normCells, HEADER_KEY, UUID_COL };
if (require.main === module) main();
