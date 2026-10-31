'use strict';
/**
 * 只读取证：空 UUID 是否仍在增长？（决定「止血是否闭环」→ 能否解冻清存量）
 *
 * 背景：RemoteActions.gs:111 `if (uid && exist[uid]) { skippedDup++; continue; }`
 *       —— uid 为空时【不做查重】，直接写入。故空 UUID 行可无限重复。
 *       若近期新增行仍大量为空 UUID ⇒ 漏洞活跃 ⇒ 清完还会长回来，不得解冻。
 *
 * 输出：按提交日(近 N 日)统计 新增行数 / 空UUID行数 / 空UUID占比 / 工时。
 * 用法：node tools/ts_emptyuuid_trend.js [days=14]
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
const normDate = v => {
  if (!v) return '';
  const s = String(v).trim();
  const m = s.match(/^(\d{4})[-\/](\d{2})[-\/](\d{2})/);
  return m ? m[1] + '-' + m[2] + '-' + m[3] : '';
};
const isSoftDel = v => ['TRUE', 'true', '✔', '1'].includes(String(v || '').trim());

(async () => {
  const days = parseInt(process.argv[2] || '14', 10);
  const m1 = await get('inspectWorkbook', { ssId: TS_ID, sheet: PROD_TAB, mode: 'values', a1: 'A1:A12000' });
  let last = 0;
  if (m1 && m1.values) { last = m1.values.length; while (last > 0 && !String((m1.values[last - 1] || [])[0] || '').trim()) last--; }
  if (!last) { console.error('无法确定总行数'); process.exit(1); }

  const CH = 500, all = [];
  for (let s = 2; s <= last; s += CH) {
    const e = Math.min(s + CH - 1, last);
    const v = await getRange(TS_ID, PROD_TAB, 'A' + s + ':O' + e);
    if (!v.length) continue;
    for (let i = 0; i < v.length; i++) {
      const r = v[i] || [];
      if (isSoftDel(r[14])) continue;              // 只看存活行
      all.push({ row: s + i, date: normDate(r[0]),
                 uuid: String(r[8] || '').trim(),
                 hours: parseFloat(String(r[6] ?? '').replace(/[^0-9.\-]/g, '')) || 0 });
    }
    process.stderr.write('rows: ' + all.length + '\r');
  }
  process.stderr.write('\n');

  const dates = all.map(r => r.date).filter(Boolean).sort();
  const cutoff = dates[dates.length - 1]
    ? new Date(new Date(dates[dates.length - 1]).getTime() - days * 86400000).toISOString().slice(0, 10)
    : '';
  const byDay = new Map();
  all.forEach(r => { if (r.date && r.date >= cutoff) {
    if (!byDay.has(r.date)) byDay.set(r.date, { total: 0, emptyUuid: 0, hours: 0 });
    const o = byDay.get(r.date); o.total++; o.hours += r.hours; if (!r.uuid) o.emptyUuid++;
  } });

  const out = { ts: new Date().toISOString(), lastRow: last, alive: all.length, windowDays: days, cutoff, byDay: [] };
  let wTot = 0, wEmpty = 0;
  [...byDay.keys()].sort().forEach(d => {
    const o = byDay.get(d); wTot += o.total; wEmpty += o.emptyUuid;
    out.byDay.push({ date: d, rows: o.total, emptyUuid: o.emptyUuid,
                     emptyPct: Math.round(o.emptyUuid / o.total * 1000) / 10,
                     hours: Math.round(o.hours * 100) / 100 });
  });
  out.window = { rows: wTot, emptyUuid: wEmpty, emptyPct: wTot ? Math.round(wEmpty / wTot * 1000) / 10 : 0 };
  out.verdict = out.window.emptyPct === 0
    ? '窗口内零空 UUID ⇒ 空 UUID 为历史遗留，漏洞未再触发'
    : '窗口内仍有 ' + out.window.emptyPct + '% 空 UUID ⇒ 漏洞活跃，清完还会长回来';

  const outdir = path.join(__dirname, '..', '_tmp', 'evidence');
  fs.mkdirSync(outdir, { recursive: true });
  const f = path.join(outdir, 'emptyuuid_trend_' + String(out.ts).slice(0, 10) + '.json');
  fs.writeFileSync(f, JSON.stringify(out, null, 2), 'utf8');
  console.log(JSON.stringify(out, null, 2));
  console.error('\nWROTE ' + f);
})();
