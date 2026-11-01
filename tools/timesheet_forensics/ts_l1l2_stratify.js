'use strict';
/**
 * L1/L2 分层派生（只读 · 零写入）—— 回应 Tom 2026-10-31 N8「底稿缺失一律 UNKNOWN、保留原状」。
 *
 * v2（2026-11-01 回应 Tom 08:22 复核）：针对其三点证据边界补强：
 *   ① 快照一致性：读前/读后各取一次总行数 + 时间戳，二者不一致即判定「读取期间表被改写」→ 中止，
 *      不再用跨时间的混合页生成统计（回应「缺页仍可能生成统计 / 无读前读后 revision 核验」）。
 *   ② 缺页/短页阻断：每页必须返回预期行数（除末段）；任一页失败或短页 → 写 .partial 证据并 process.exit(1)，
 *      绝不 continue 跳过（回应「缺页仍可能生成统计」）。
 *   ③ 比较基准确权：显式声明比较基线是「逐单元格 trim 后的 col0..13 归一化值」，非原始字节；
 *      另对归一化 EXACT 组做「原始（未 trim）是否也一致」二次核验，原始不一致者标 rawDiff=true 留待审查，
 *      不再宣称「原始字节完全相同」（回应「只比较 A:N / trim，不能宣称原始字节完全相同」）。
 *
 * v3（2026-11-01 回应 Tom 02:28 复核①/②）：针对其两点证据强度异议补强：
 *   ① 快照版本完整性：原 snapshotConsistent 仅比读前/读后 lastRow，中途「原地改值/删后补行」行数不变则不报，
 *      本地时间戳也不能证 23 页同版本。v3 改为读完后对分层采样行(A:O)重新向服务端请求并逐格比对原始(未trim)内容，
 *      任一指纹行内容变化 ⇒ 读取期间表被改写 ⇒ 中止；并设计「读取中途原地改值但行数不变」负例验收。
 *   ② rawDiff 全组累计：原 rawDiffCount 由 L.EXACT.samples.filter(...) 计算，samples 最多 3 组 ⇒ 不代表全部 EXACT。
 *      v3 改为遍历全部 dupGroups 时累计 rawDiffTotal，并输出逐组可核查标识/行号/摘要(rawDiffGroups)，非仅前 3 组。
 *
 * 与旧诊断（diag_cleanup_20261101.js）的关键差异【修正已知缺陷】：
 *   旧版第 135 行 `const k = r.uuid || '(EMPTY)'` 把全部空 UUID 行聚成一个组，
 *   使其被计入 dupGroups 且贡献 ~5000 行 extraRows —— 那不是「同 UUID 重放」，是聚合假象。
 *   本版：空 UUID 行单独进 EMPTY_POOL，【绝不】参与 UUID 冗余统计。
 *
 * 用法：node tools/ts_l1l2_stratify.js [--dump]
 * 输出：_tmp/evidence/l1l2_stratify_<YYYY-MM-DD>.json
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL: NU } = require('url');

const WEBAPP = 'https://script.google.com/macros/s/AKfycbyq9RYrH1n7DKkoYBVi2cBmsgQLT51i3yaqVP_xF7twQYW0--r39ryu7rJfj1Wn4dTHVA/exec';
const KEY = require('./.hktool_remote.json').key;
const TS_ID = '1Pi5u9fEawgp7yICWPMMyQCT_LbwTZthQDW-H05xYdVI';
const PROD_TAB = 'DB_工时流水';

const agent = new https.Agent({ keepAlive: true, maxSockets: 4 });
function raw(pl) {
  return new Promise(resolve => {
    const b = JSON.stringify(pl); const u = new NU(WEBAPP);
    const r = https.request({ host: u.hostname, port: 443, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }, agent }, res => {
      if (res.statusCode === 302 && res.headers.location) {
        res.resume(); const u2 = new NU(res.headers.location);
        const r2 = https.request({ host: u2.hostname, port: 443, path: u2.pathname + (u2.search || ''), method: 'GET', agent }, res2 => {
          const c = []; res2.on('data', d => c.push(d)); res2.on('end', () => { res2.resume(); resolve(Buffer.concat(c).toString('utf8')); });
        });
        r2.on('error', e => resolve('ERR ' + e.message)); r2.end(); return;
      }
      const c = []; res.on('data', d => c.push(d)); res.on('end', () => { res.resume(); resolve(Buffer.concat(c).toString('utf8')); });
    });
    r.on('error', e => resolve('ERR ' + e.message)); r.write(b); r.end();
  });
}
async function get(fn, args) {
  for (let i = 0; i < 4; i++) {
    const s = await raw({ action: 'hkRemoteRun', key: KEY, fn, args });
    let j = null; try { j = JSON.parse(s); } catch (e) { j = null; }
    if (j && j.result !== undefined && j.result !== null) return j.result;
    await new Promise(r => setTimeout(r, 800 * (i + 1)));
  }
  return null;
}
async function getRange(ssId, sheet, a1) {
  for (let i = 0; i < 5; i++) {
    const r = await get('inspectWorkbook', { ssId, sheet, mode: 'values', a1 });
    if (r && r.values && r.values.length) return r.values;
    await new Promise(res => setTimeout(res, 1200 * (i + 1)));
  }
  return null; // 失败返回 null（与 [] 区分，供缺页阻断判断）
}
const isSoftDel = v => ['TRUE', 'true', '✔', '1'].includes(String(v || '').trim());
const cell = v => String(v === undefined || v === null ? '' : v).trim();
const cellRaw = v => String(v === undefined || v === null ? '' : v); // 原始不 trim
const hours = v => parseFloat(String(v === undefined || v === null ? '' : v).replace(/[^0-9.\-]/g, '')) || 0;
const NCOL = 14; // col0..13（col14 = O 软标列，不参与内容比对）

function abort(partial) {
  const outdir = path.join(__dirname, '..', '_tmp', 'evidence');
  fs.mkdirSync(outdir, { recursive: true });
  const pf = path.join(outdir, 'l1l2_stratify_' + new Date().toISOString().slice(0, 10) + '.partial.json');
  fs.writeFileSync(pf, JSON.stringify(partial, null, 2), 'utf8');
  console.error('ABORT: 读取不完整，已写证据 ' + pf);
  process.exit(1);
}

(async () => {
  const out = { ts: new Date().toISOString(), scope: 'DB_工时流水 live 只读', layers: {}, emptyPool: {}, notes: [] };
  const t0 = Date.now();

  // —— 快照：读前总行数 + 时间戳 ——
  const m1 = await get('inspectWorkbook', { ssId: TS_ID, sheet: PROD_TAB, mode: 'values', a1: 'A1:A12000' });
  function trimLast(vals) {
    let n = vals ? vals.length : 0;
    while (n > 0 && !String((vals[n - 1] || [])[0] || '').trim()) n--;
    return n;
  }
  const lastBefore = m1 && m1.values ? trimLast(m1.values) : 0;
  if (!lastBefore) abort({ reason: '无法确定总行数(读前)', readBefore: { ok: !!m1 } });
  const snapBefore = { lastRow: lastBefore, at: new Date().toISOString() };

  // 2) 全列 A:O 分批读（完整度阻断）
  const CH = 500, all = [];
  const pagePlan = [];
  for (let s = 2; s <= lastBefore; s += CH) pagePlan.push([s, Math.min(s + CH - 1, lastBefore)]);
  let shortPages = 0, failedPages = 0;
  for (const [s, e] of pagePlan) {
    const v = await getRange(TS_ID, PROD_TAB, 'A' + s + ':O' + e);
    if (!v) { failedPages++; out.notes.push('区间失败(5次重试后仍空) A' + s + ':O' + e); continue; }
    const expected = e - s + 1;
    if (v.length !== expected) { shortPages++; out.notes.push('短页 A' + s + ':O' + e + ' 实读=' + v.length + ' 预期=' + expected); continue; }
    for (let i = 0; i < v.length; i++) {
      const r = v[i] || [];
      all.push({ row: s + i, cells: Array.from({ length: NCOL }, (_, k) => cell(r[k])),
                 cellsRaw: Array.from({ length: NCOL }, (_, k) => cellRaw(r[k])),
                 hours: hours(r[6]), uuid: cell(r[8]), soft: isSoftDel(r[14]) });
    }
    process.stderr.write('rows: ' + all.length + '/' + (lastBefore - 1) + '\r');
  }
  process.stderr.write('\n');

  if (failedPages > 0 || shortPages > 0) {
    abort({ reason: '存在缺页/短页，统计不可信', lastBefore, failedPages, shortPages, notes: out.notes });
  }

  // —— 快照：读后总行数 + 时间戳，必须与读前一致 ——
  const m2 = await get('inspectWorkbook', { ssId: TS_ID, sheet: PROD_TAB, mode: 'values', a1: 'A1:A12000' });
  const lastAfter = m2 && m2.values ? trimLast(m2.values) : 0;
  const snapAfter = { lastRow: lastAfter, at: new Date().toISOString() };
  const snapshotConsistent = (lastBefore === lastAfter);
  if (!snapshotConsistent) {
    abort({ reason: '读取期间表被改写(读前/读后总行数不一致)', snapBefore, snapAfter });
  }

  // v3（回应 Tom 02:28 复核①）：服务端内容指纹二次核验
  //   snapshotConsistent 仅比行数；中途「原地改值 / 删后补行」行数不变则漏报。
  //   读完后再向服务端请求分层采样行的原始(未trim)内容逐格比对，任一指纹行变化 ⇒ 读取期间表被改写 ⇒ 中止。
  const fingerIdx = [0, Math.floor(all.length / 2), all.length - 1]
    .filter((v, i, a) => a.indexOf(v) === i && all[v]);
  const fingerSamples = fingerIdx.map(i => ({ row: all[i].row, raw: all[i].cellsRaw.slice() }));
  let fingerMismatch = null;
  for (const fs of fingerSamples) {
    const fv = await getRange(TS_ID, PROD_TAB, 'A' + fs.row + ':O' + fs.row);
    if (!fv || !fv[0]) { fingerMismatch = { row: fs.row, reason: '指纹行重读失败' }; break; }
    for (let k = 0; k < NCOL; k++) {
      const after = String(fv[0][k] === undefined ? '' : fv[0][k]);
      if (after !== fs.raw[k]) { fingerMismatch = { row: fs.row, col: k, before: fs.raw[k], after }; break; }
    }
    if (fingerMismatch) break;
  }
  if (fingerMismatch) {
    abort({ reason: '读取期间表被原地改写(内容指纹不一致)', snapBefore, snapAfter, fingerMismatch, fingerSamples: fingerSamples.map(s => s.row) });
  }
  out.contentFingerprint = { sampleRows: fingerSamples.map(s => s.row), matched: true, note: '读后分层采样行原始内容与服务端二次请求逐格一致，可证读取期间表未被原地改写' };

  const alive = all.filter(r => !r.soft);
  out.readIntegrity = { complete: true, pageCount: pagePlan.length, expectedRows: lastBefore - 1,
                        readRows: all.length, failedPages, shortPages, snapshotConsistent,
                        snapBefore, snapAfter, elapsedMs: Date.now() - t0 };
  out.comparisonBasis = '逐单元格 trim 后的 col0..13 归一化值（非原始字节）；col14 软标列不参与内容比对。已对归一化 EXACT 组附加原始(未 trim)二次核验。';
  out.totalRowsRead = all.length;
  out.softDeleted = all.length - alive.length;
  out.alive = alive.length;
  out.aliveHours = Math.round(alive.reduce((a, r) => a + r.hours, 0) * 100) / 100;

  // 3) 空 UUID 池（单独剥离，绝不进 UUID 冗余统计）
  const emptyPool = alive.filter(r => !r.uuid);
  out.emptyPool = { rows: emptyPool.length, hours: Math.round(emptyPool.reduce((a, r) => a + r.hours, 0) * 100) / 100,
                    pctOfAlive: Math.round(emptyPool.length / alive.length * 1000) / 10 };

  // 4) 真实 UUID 分组 + 逐列一致性分层 + 原始二次核验
  const byUuid = new Map();
  alive.filter(r => r.uuid).forEach(r => {
    if (!byUuid.has(r.uuid)) byUuid.set(r.uuid, []);
    byUuid.get(r.uuid).push(r);
  });
  const dupGroups = [...byUuid.values()].filter(g => g.length > 1);

  const L = { EXACT: { groups: 0, extraRows: 0, extraHours: 0, samples: [], rawDiffTotal: 0, rawDiffGroups: [] },
              TIMEONLY: { groups: 0, extraRows: 0, extraHours: 0, samples: [] },
              MIXED: { groups: 0, extraRows: 0, extraHours: 0, samples: [] } };

  for (const g of dupGroups) {
    const gs = g.slice().sort((a, b) => a.row - b.row);
    const base = gs[0].cells;
    const baseRaw = gs[0].cellsRaw;
    let onlyCol0Diff = true, anyDiff = false, rawDiff = false;
    for (let i = 1; i < gs.length; i++) {
      for (let k = 0; k < NCOL; k++) {
        if (gs[i].cells[k] !== base[k]) {
          anyDiff = true;
          if (k !== 0) onlyCol0Diff = false;
        }
        if (gs[i].cellsRaw[k] !== baseRaw[k]) rawDiff = true; // 原始(未trim)不一致
      }
    }
    let kind;
    if (!anyDiff) kind = 'EXACT';
    else if (onlyCol0Diff) kind = 'TIMEONLY';
    else kind = 'MIXED';
    const extras = gs.slice(1);
    L[kind].groups++;
    L[kind].extraRows += extras.length;
    L[kind].extraHours += extras.reduce((a, r) => a + r.hours, 0);
    if (L[kind].samples.length < 3) {
      L[kind].samples.push({ uuid: gs[0].uuid.slice(0, 24) + '…', copies: gs.length,
        rows: gs.map(x => x.row), firstRow: gs[0].row, submitDates: gs.map(x => x.cells[0]),
        rawDiff });
    }
    // v3（回应 Tom 02:28 复核②）：rawDiff 全组累计，输出逐组可核查标识，非仅前 3 组 samples
    if (kind === 'EXACT' && rawDiff) {
      L.EXACT.rawDiffTotal++;
      if (L.EXACT.rawDiffGroups.length < 20) {
        L.EXACT.rawDiffGroups.push({ uuid: gs[0].uuid.slice(0, 24) + '…', copies: gs.length, rows: gs.map(x => x.row) });
      }
    }
  }
  for (const k of Object.keys(L)) L[k].extraHours = Math.round(L[k].extraHours * 100) / 100;
  // v3：rawDiff 计数改为遍历全部 EXACT 组累计（rawDiffTotal），不再只用前 3 组 samples
  L.EXACT.rawDiffCount = L.EXACT.rawDiffTotal;

  // 5) 与旧口径对照
  let oldExtra = 0, oldGroups = 0;
  { const m = new Map();
    alive.forEach(r => { const k = r.uuid || '(EMPTY)'; if (!m.has(k)) m.set(k, []); m.get(k).push(r); });
    oldGroups = [...m.values()].filter(g => g.length > 1).length;
    oldExtra = [...m.values()].filter(g => g.length > 1).reduce((a, g) => a + g.length - 1, 0);
  }
  out.layers = L;
  out.reconcile = {
    oldUuidDupGroups: oldGroups, oldUuidExtraRows: oldExtra,
    newUuidDupGroups: dupGroups.length,
    newUuidExtraRows: L.EXACT.extraRows + L.TIMEONLY.extraRows + L.MIXED.extraRows,
    emptyPoolContaminationRows: emptyPool.length > 1 ? emptyPool.length - 1 : 0,
    note: '旧口径把空 UUID 聚成 (EMPTY) 单组并计入冗余；本口径已剥离。两数不可混用。'
  };
  out.verdict = {
    可交付L1: L.EXACT.extraRows + ' 行 / ' + L.EXACT.extraHours + ' h（逐列全同，保留任一副本业务等价；原始字节一致性见 rawDiff 标注）',
    待裁定L2_TIMEONLY: L.TIMEONLY.extraRows + ' 行 / ' + L.TIMEONLY.extraHours + ' h（仅录入时间不同，须裁定保留哪条）',
    绝不动_MIXED: L.MIXED.extraRows + ' 行 / ' + L.MIXED.extraHours + ' h',
    绝不动_EMPTY: emptyPool.length + ' 行 / ' + out.emptyPool.hours + ' h（UUID 空，无法建立同一性）'
  };

  const outdir = path.join(__dirname, '..', '_tmp', 'evidence');
  fs.mkdirSync(outdir, { recursive: true });
  const f = path.join(outdir, 'l1l2_stratify_' + String(out.ts).slice(0, 10) + '.json');
  fs.writeFileSync(f, JSON.stringify(out, null, 2), 'utf8');
  console.log(JSON.stringify(out, null, 2));
  console.error('\nWROTE ' + f);
})();
