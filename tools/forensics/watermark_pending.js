// A6：水位线挂起行取证（只读）—— 复刻 syncProdToMaster 的判定，数出「待人工裁」的行
// 对照源码：masterAttendanceLive.js:82-128（syncProdToMaster）
// 挂起定义：生产表有、主库底稿没有（UUID 与内容键都不在底稿）、且【录入时间 <= 底稿水位线】的行，
//           同步时会被 continue 跳过，既不进底稿也不报错 —— 即长期悬空的漏报行。
// 用法：node tools/forensics/watermark_pending.js
const https = require('https');
const { URL: NU } = require('url');
const WEBAPP = 'https://script.google.com/macros/s/AKfycbyq9RYrH1n7DKkoYBVi2cBmsgQLT51i3yaqVP_xF7twQYW0--r39ryu7rJfj1Wn4dTHVA/exec';
const KEY = require('../.hktool_remote.json').key;

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
// 复刻 _malBizDate：GMT+8 的 yyyy-MM-dd
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
const num = v => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };

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
  let excluded = 0, inBase = 0, pending = [], wouldAdd = [];
  for (let j = 1; j < prod.rows.length; j++) {
    const p = prod.rows[j].cells;
    const name = norm(p[2]); if (!name) { excluded++; continue; }
    if (isLeave(p) || softDel(p)) { excluded++; continue; }
    const pd = malBizDate(p[1]); if (!pd || pd.indexOf('2026') !== 0) { excluded++; continue; }
    const pu = norm(p[8]);
    const ck = contentKey(name, p[5], p[6], pd, p[7]);
    if ((pu && baseU[pu]) || baseC[ck]) { inBase++; continue; }
    const pts = ts(p[0]); if (isNaN(pts)) { excluded++; continue; }
    const rec = { row: prod.rows[j].row, uuid: pu, name, bizDate: pd,
                  project: norm(p[5]), hours: num(p[6]), note: norm(p[7]).slice(0, 30),
                  loggedAt: norm(p[0]) };
    if (watermark !== null && pts <= watermark) pending.push(rec); else wouldAdd.push(rec);
  }

  const out = {
    meta: { generatedAtBJT: new Date(Date.now() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19),
            readOnly: true, logic: '复刻 masterAttendanceLive.js:82-128 syncProdToMaster',
            master: { ssId: MASTER_ID, tab: BASE_TAB }, prod: { ssId: TS_ID, tab: PROD_TAB } },
    base: { rows: base.rows.length - 1, watermarkISO: watermark ? new Date(watermark).toISOString() : null,
            watermarkBJT: watermark ? new Date(watermark + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19) : null },
    prod: { rows: prod.rows.length - 1, excluded, alreadyInBase: inBase },
    pending: { count: pending.length, hours: +(pending.reduce((s, r) => s + r.hours, 0)).toFixed(1),
               sample: pending.slice(0, 10) },
    wouldAdd: { count: wouldAdd.length, hours: +(wouldAdd.reduce((s, r) => s + r.hours, 0)).toFixed(1),
                sample: wouldAdd.slice(0, 10) },
    pendingDetail: pending
  };
  process.stdout.write(JSON.stringify(out, null, 2));
})();
