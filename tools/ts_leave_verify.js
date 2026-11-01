'use strict';
/**
 * 请假行软删前后的定向核验（只读）
 * 用法：node tools/ts_leave_verify.js <rows.json> <BEFORE|AFTER>
 * 输出：evidence JSON（oTrue / oEmpty / p值分布 / 样本），并落盘 _tmp/
 */
const https = require('https');
const fs = require('fs');
const { URL: NU } = require('url');
const WEBAPP = 'https://script.google.com/macros/s/AKfycbyq9RYrH1n7DKkoYBVi2cBmsgQLT51i3yaqVP_xF7twQYW0--r39ryu7rJfj1Wn4dTHVA/exec';
const KEY = require('./.hktool_remote.json').key;
const TS_ID = '1Pi5u9fEawgp7yICWPMMyQCT_LbwTZthQDW-H05xYdVI';
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
(async () => {
  const rows = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).rows;
  const tag = (process.argv[3] || 'BEFORE').toUpperCase();
  const meta = await get('inspectWorkbook', { ssId: TS_ID, sheet: 'DB_工时流水', mode: 'meta' });
  const last = meta.lastRow;
  const set = new Set(rows);
  const got = {};
  const PAGE = 500;
  let failed = 0;
  for (let s = 2; s <= last; s += PAGE) {
    const e = Math.min(last, s + PAGE - 1);
    if (e < rows[0] || s > rows[rows.length - 1]) continue;   // 只扫目标区间
    const r = await get('inspectWorkbook', { ssId: TS_ID, sheet: 'DB_工时流水', mode: 'values', a1: 'O' + s + ':Q' + e });
    const v = (r && r.values) || [];
    if (v.length < (e - s + 1)) failed++;
    v.forEach((row, i) => {
      const rn = s + i;
      if (!set.has(rn)) return;
      got[rn] = { o: (row || [])[0], p: (row || [])[1], q: (row || [])[2] };
    });
  }
  let oTrue = 0, oEmpty = 0;
  const pmap = {}, samples = [];
  rows.forEach(rn => {
    const g = got[rn];
    if (!g) return;
    const o = String(g.o === undefined || g.o === null ? '' : g.o).trim().toUpperCase();
    if (o === 'TRUE') oTrue++; else if (o === '') oEmpty++;
    const p = String(g.p === undefined || g.p === null ? '' : g.p).trim() || '(空)';
    pmap[p] = (pmap[p] || 0) + 1;
    if (samples.length < 3) samples.push({ row: rn, O: g.o, P: g.p });
  });
  const out = {
    tag, ts: new Date().toISOString(), sheet: 'DB_工时流水', ssid: TS_ID,
    requested: rows.length, read: Object.keys(got).length, complete: Object.keys(got).length === rows.length,
    failedPages: failed, oTrue, oEmpty, pmap, samples
  };
  fs.writeFileSync('_tmp/evidence_leave_' + tag + '_2026-11-02.json', JSON.stringify(out, null, 1), 'utf8');
  console.log(JSON.stringify(out, null, 1));

  // 附加：抓取服务端写日志末段（留证）
  const lw = await get('inspectWorkbook', { ssId: TS_ID, sheet: '_TS_WRITE_LOG', mode: 'meta' });
  const lwLast = lw && lw.lastRow ? lw.lastRow : 0;
  const lg = await get('inspectWorkbook', { ssId: TS_ID, sheet: '_TS_WRITE_LOG', mode: 'values', a1: 'A' + Math.max(1, lwLast - 4) + ':C' + lwLast });
  const logTxt = JSON.stringify(lg && lg.values);
  fs.appendFileSync('_tmp/evidence_leave_' + tag + '_2026-11-02.json', String.fromCharCode(10) + '// _TS_WRITE_LOG tail: ' + logTxt + String.fromCharCode(10), 'utf8');
  console.log('_TS_WRITE_LOG tail=' + logTxt);
  process.exit(out.complete ? 0 : 2);
})();
