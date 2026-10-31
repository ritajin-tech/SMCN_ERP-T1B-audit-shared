'use strict';
/**
 * L1/L2 分层派生（只读 · 零写入）—— 回应 Tom 2026-10-31 N8「底稿缺失一律 UNKNOWN、保留原状」。
 *
 * 与旧诊断（diag_cleanup_20261101.js）的关键差异【修正已知缺陷】：
 *   旧版第 135 行 `const k = r.uuid || '(EMPTY)'` 把全部空 UUID 行聚成一个组，
 *   使其被计入 dupGroups 且贡献 ~5000 行 extraRows —— 那不是「同 UUID 重放」，是聚合假象。
 *   本版：空 UUID 行单独进 EMPTY_POOL，【绝不】参与 UUID 冗余统计。
 *
 * 分层判据（不依赖底稿，正面回应 N8）：
 *   EXACT    : 同 UUID 组内所有存活副本 col0..13 逐列全同
 *              → 保留任意一副本，业务结果【完全相同】（不是"保留最早"的推定）
 *   TIMEONLY : 仅 col0(录入时间) 不同，col1..13 全同
 *              → 有实质差异，须裁定保留哪一条录入时间
 *   MIXED    : col1..13 任一不同 → 绝不动（连"内容一致"都不成立）
 *   EMPTY    : UUID 为空，无法用 UUID 建立同一性 → 一律 UNKNOWN，保留原状
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
  return [];
}
const isSoftDel = v => ['TRUE', 'true', '✔', '1'].includes(String(v || '').trim());
const cell = v => String(v === undefined || v === null ? '' : v).trim();
const hours = v => parseFloat(String(v === undefined || v === null ? '' : v).replace(/[^0-9.\-]/g, '')) || 0;
const NCOL = 14; // col0..13（col14 = O 软标列，不参与内容比对）

(async () => {
  const out = { ts: new Date().toISOString(), scope: 'DB_工时流水 live 只读', layers: {}, emptyPool: {}, notes: [] };

  // 1) 定位最后一行
  const m1 = await get('inspectWorkbook', { ssId: TS_ID, sheet: PROD_TAB, mode: 'values', a1: 'A1:A12000' });
  let last = 0;
  if (m1 && m1.values) {
    last = m1.values.length;
    while (last > 0 && !String((m1.values[last - 1] || [])[0] || '').trim()) last--;
  }
  if (!last) { console.error('无法确定总行数'); process.exit(1); }
  out.lastRow = last;

  // 2) 全列 A:O 分批读
  const CH = 500, all = [];
  for (let s = 2; s <= last; s += CH) {
    const e = Math.min(s + CH - 1, last);
    const v = await getRange(TS_ID, PROD_TAB, 'A' + s + ':O' + e);
    if (!v.length) { out.notes.push('区间空/失败 A' + s + ':O' + e); continue; }
    for (let i = 0; i < v.length; i++) {
      const r = v[i] || [];
      all.push({ row: s + i, cells: Array.from({ length: NCOL }, (_, k) => cell(r[k])),
                 hours: hours(r[6]), uuid: cell(r[8]), soft: isSoftDel(r[14]) });
    }
    process.stderr.write('rows: ' + all.length + '/' + (last - 1) + '\r');
  }
  process.stderr.write('\n');

  const alive = all.filter(r => !r.soft);
  out.totalRowsRead = all.length;
  out.softDeleted = all.length - alive.length;
  out.alive = alive.length;
  out.aliveHours = Math.round(alive.reduce((a, r) => a + r.hours, 0) * 100) / 100;

  // 3) 空 UUID 池（单独剥离，绝不进 UUID 冗余统计）
  const emptyPool = alive.filter(r => !r.uuid);
  out.emptyPool = { rows: emptyPool.length, hours: Math.round(emptyPool.reduce((a, r) => a + r.hours, 0) * 100) / 100,
                    pctOfAlive: Math.round(emptyPool.length / alive.length * 1000) / 10 };

  // 4) 真实 UUID 分组 + 逐列一致性分层
  const byUuid = new Map();
  alive.filter(r => r.uuid).forEach(r => {
    if (!byUuid.has(r.uuid)) byUuid.set(r.uuid, []);
    byUuid.get(r.uuid).push(r);
  });
  const dupGroups = [...byUuid.values()].filter(g => g.length > 1);

  const L = { EXACT: { groups: 0, extraRows: 0, extraHours: 0, samples: [] },
              TIMEONLY: { groups: 0, extraRows: 0, extraHours: 0, samples: [] },
              MIXED: { groups: 0, extraRows: 0, extraHours: 0, samples: [] } };

  for (const g of dupGroups) {
    const gs = g.slice().sort((a, b) => a.row - b.row);
    const base = gs[0].cells;
    let onlyCol0Diff = true, anyDiff = false;
    for (let i = 1; i < gs.length; i++) {
      for (let k = 0; k < NCOL; k++) {
        if (gs[i].cells[k] !== base[k]) {
          anyDiff = true;
          if (k !== 0) onlyCol0Diff = false;
        }
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
        rows: gs.map(x => x.row), firstRow: gs[0].row, submitDates: gs.map(x => x.cells[0]) });
    }
  }
  for (const k of Object.keys(L)) L[k].extraHours = Math.round(L[k].extraHours * 100) / 100;

  // 5) 与旧口径对照（暴露旧口径被空 UUID 污染的程度）
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
    可交付L1: L.EXACT.extraRows + ' 行 / ' + L.EXACT.extraHours + ' h（逐列全同，保留任一副本业务等价）',
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
