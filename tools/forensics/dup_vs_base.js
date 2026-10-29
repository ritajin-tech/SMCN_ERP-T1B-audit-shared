// A6+ 交叉取证（只读）：把「UUID 重复组」与「生产行在主库底稿中的归属」打在一张表上，
// 回答 Tom 的阻断问题：软标掉副本行，会不会把主库唯一的那份数据也一起弄丢？
// 复用逻辑：watermark_pending.js（syncProdToMaster 判定）+ oct_dup_evidence.js（UUID 分组）
// 用法：node tools/forensics/dup_vs_base.js
const https = require('https');
const { URL: NU } = require('url');
const WEBAPP = '<HKTOOL_WEBAPP_URL: 见本地 .hktool_remote.json（公开仓不内嵌端点）>';
const KEY = process.env.TS_HKTOOL_KEY || '<HKTOOL_KEY: 见本地 .hktool_remote.json（公开仓不内嵌）>';

const MASTER_ID = '1oxPj0mzN8poP2vQ7Bm-YKXuU49p9b0c1asyrZn4Py44';
const BASE_TAB = '工时_候选0824';
const TS_ID = '1Pi5u9fEawgp7yICWPMMyQCT_LbwTZthQDW-H05xYdVI';
const PROD_TAB = 'DB_工时流水';

function call(pl) {
  return new Promise(resolve => {
    const b = JSON.stringify(pl); const u = new NU(WEBAPP);
    const r = https.request({ host: u.host, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) } }, res => {
      if (res.statusCode === 302 && res.headers.location) {
        res.resume(); const u2 = new NU(res.headers.location);
        const r2 = https.request({ host: u2.host, path: u2.pathname + (u2.search || ''), method: 'GET' }, res2 => {
          const c = []; res2.on('data', d => c.push(d)); res2.on('end', () => resolve(Buffer.concat(c).toString('utf8')));
        });
        r2.on('error', e => resolve('ERR ' + e.message)); r2.end(); return;
      }
      const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve(Buffer.concat(c).toString('utf8')));
    });
    r.on('error', e => resolve('ERR ' + e.message)); r.write(b); r.end();
  });
}
async function get(args) {
  for (let i = 0; i < 4; i++) {
    const s = await call({ action: 'hkRemoteRun', key: KEY, fn: 'inspectWorkbook', args });
    let j; try { j = JSON.parse(s); } catch (e) {}
    if (j && j.result) return j.result;
    await new Promise(r => setTimeout(r, 1200));
  }
  return {};
}
async function readAll(ssId, sheet, lastCol) {
  const probe = await get({ ssId, sheet, mode: 'values', a1: 'A1:' + lastCol + '2' });
  const last = probe.lastRow || 0;
  const out = [];
  for (let s = 1; s <= last; s += 400) {
    const e = Math.min(s + 399, last);
    const r = await get({ ssId, sheet, mode: 'values', a1: `A${s}:${lastCol}${e}` });
    (r.values || []).forEach((cells, i) => out.push({ row: s + i, cells: cells || [] }));
  }
  return { rows: out.filter(x => x.cells.some(c => String(c ?? '').trim() !== '')), lastRow: last };
}

const norm = v => (v === undefined || v === null) ? '' : String(v).trim();
const ts = v => { const t = new Date(norm(v)).getTime(); return isNaN(t) ? NaN : t; };
const num = v => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
function malBizDate(v) {
  if (!v) return '';
  const d = new Date(norm(v)); if (isNaN(d.getTime())) return norm(v).substring(0, 10);
  return new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 10);
}
const contentKey = (nm, proj, hrs, dt, note) =>
  [nm, String(proj || '').toLowerCase(), String(hrs || ''), dt, String(note || '')].join('\u0002');
const isLeave = r => /休假|请假/.test(norm(r[3])) || /OFF-WORK/i.test(norm(r[4])) ||
  /OFF-WORK/i.test(norm(r[5])) || /系统同步请假|LEAVE-|AUTO_LEAVE/i.test(norm(r[6]) + ' ' + norm(r[7]) + ' ' + norm(r[8]));
const softDel = r => (r[14] === true || String(r[14] || '').toUpperCase() === 'TRUE');

(async () => {
  const base = await readAll(MASTER_ID, BASE_TAB, 'K');
  const baseU = {}, baseC = {};
  let watermark = null;
  for (let i = 1; i < base.rows.length; i++) {
    const r = base.rows[i].cells;
    const u = norm(r[8]); if (u) baseU[u] = true;
    const nm = norm(r[2]), dt = malBizDate(r[1]);
    if (nm && dt) baseC[contentKey(nm, r[5], r[6], dt, r[7])] = true;
    const t = ts(r[0]); if (!isNaN(t) && (watermark === null || t > watermark)) watermark = t;
  }
  process.stderr.write(`[BASE] 底稿数据行 ${base.rows.length - 1}，水位线 ${watermark ? new Date(watermark).toISOString() : '(无)'}\n`);

  const prod = await readAll(TS_ID, PROD_TAB, 'Q');
  // 1) 每一行归类：excluded(排除) / inBase(已在底稿) / pending(水位线下悬空) / wouldAdd(待同步)
  const clsOf = {};
  const rowInfo = {};
  for (let j = 1; j < prod.rows.length; j++) {
    const row = prod.rows[j].row, p = prod.rows[j].cells;
    const name = norm(p[2]);
    const pu = norm(p[8]);
    const pd = malBizDate(p[1]);
    const hrs = num(p[6]);
    rowInfo[row] = { row, uuid: pu, name, bizDate: pd, hours: hrs, softDel: softDel(p) };
    if (!name) { clsOf[row] = 'excluded'; continue; }
    if (isLeave(p) || softDel(p)) { clsOf[row] = 'excluded'; continue; }
    if (!pd || pd.indexOf('2026') !== 0) { clsOf[row] = 'excluded'; continue; }
    const ck = contentKey(name, p[5], p[6], pd, p[7]);
    if ((pu && baseU[pu]) || baseC[ck]) { clsOf[row] = 'inBase'; continue; }
    const pts = ts(p[0]); if (isNaN(pts)) { clsOf[row] = 'excluded'; continue; }
    clsOf[row] = (watermark !== null && pts <= watermark) ? 'pending' : 'wouldAdd';
  }

  // 2) UUID 分组（含已软删行），与 oct_dup_evidence.js 同口径
  const groups = {};
  for (let j = 1; j < prod.rows.length; j++) {
    const row = prod.rows[j].row, p = prod.rows[j].cells;
    const pu = norm(p[8]); if (!pu) continue;           // 无 UUID 的老行不参与
    (groups[pu] = groups[pu] || []).push({ row, cells: p, loggedAt: ts(p[0]) });
  }
  const dupGroups = [];
  for (const u of Object.keys(groups)) {
    const g = groups[u]; if (g.length < 2) continue;
    g.sort((a, b) => (isNaN(a.loggedAt) ? 9e15 : a.loggedAt) - (isNaN(b.loggedAt) ? 9e15 : b.loggedAt));
    const keeper = g[0], dups = g.slice(1);
    for (const d of dups) {
      let diffCount = 0, diffs = [];
      for (let c = 0; c <= 13; c++) {
        const a = norm(keeper.cells[c]), b = norm(d.cells[c]);
        if (a !== b) { diffCount++; if (diffs.length < 6) diffs.push({ col: 'idx' + c, keeper: a.slice(0, 40), dup: b.slice(0, 40) }); }
      }
      dupGroups.push({
        uuid: u, month: malBizDate(keeper.cells[1]).slice(0, 7),
        keeper: { row: keeper.row, cls: clsOf[keeper.row] || '?', softDel: softDel(keeper.cells), hours: num(keeper.cells[6]), loggedAt: norm(keeper.cells[0]) },
        dup: { row: d.row, cls: clsOf[d.row] || '?', softDel: softDel(d.cells), hours: num(d.cells[6]), loggedAt: norm(d.cells[0]) },
        diffCount, diffs
      });
    }
  }

  // 3) 安全矩阵：软标 dup 会不会丢主库唯一副本？
  const tally = {};
  const buckets = {};
  for (const g of dupGroups) {
    const live = !g.dup.softDel;                      // 只统计仍生效（未软标）的副本
    const k = (live ? 'LIVE_' : 'SOFT_') + g.keeper.cls + '_' + g.dup.cls;
    tally[k] = (tally[k] || 0) + 1;
    if (live) (buckets[k] = buckets[k] || []).push(g);
  }
  const safe = dupGroups.filter(g => !g.dup.softDel && (g.keeper.cls === 'inBase' || g.keeper.cls === 'pending') && g.dup.cls === 'pending');
  const risky = dupGroups.filter(g => !g.dup.softDel && g.dup.cls === 'inBase' && g.keeper.cls !== 'inBase');
  const bothInBase = dupGroups.filter(g => !g.dup.softDel && g.keeper.cls === 'inBase' && g.dup.cls === 'inBase');

  const out = {
    meta: {
      generatedAtBJT: new Date(Date.now() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19),
      readOnly: true,
      logic: 'UUID 分组(含软删) × syncProdToMaster 归属分类',
      note: 'cls: inBase=已在主库底稿 / pending=水位线下悬空永不进底稿 / excluded=请假|软删|非2026|无姓名 / wouldAdd=待同步',
      master: { ssId: MASTER_ID, tab: BASE_TAB }, prod: { ssId: TS_ID, tab: PROD_TAB }
    },
    base: { rows: base.rows.length - 1, watermarkISO: watermark ? new Date(watermark).toISOString() : null,
            watermarkBJT: watermark ? new Date(watermark + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19) : null },
    prod: { lastRow: prod.lastRow, dataRows: prod.rows.length - 1,
            clsCount: Object.values(clsOf).reduce((m, c) => (m[c] = (m[c] || 0) + 1, m), {}) },
    dupGroups: { total: dupGroups.length, stillLive: dupGroups.filter(g => !g.dup.softDel).length,
                 alreadySoft: dupGroups.filter(g => g.dup.softDel).length },
    matrix: tally,
    verdict: {
      SAFE_softdel_dup: { count: safe.length, hours: +safe.reduce((s, g) => s + g.dup.hours, 0).toFixed(1),
        meaning: 'keeper 已在底稿或同为悬空、dup 悬空 → 软标 dup 不会让主库少数据',
        sample: safe.slice(0, 5) },
      RISKY_dupInBase_keeperNot: { count: risky.length, hours: +risky.reduce((s, g) => s + g.dup.hours, 0).toFixed(1),
        meaning: 'dup 在底稿、keeper 不在 → 软标 dup 会让主库少一条，必须人工裁',
        sample: risky.slice(0, 5) },
      BOTH_IN_BASE: { count: bothInBase.length, hours: +bothInBase.reduce((s, g) => s + g.dup.hours, 0).toFixed(1),
        meaning: '双份都进了底稿 → 主库本身已重复，软标生产 dup 不够，还要清底稿',
        sample: bothInBase.slice(0, 5) }
    },
    allGroups: dupGroups
  };
  process.stdout.write(JSON.stringify(out, null, 2));
})();
