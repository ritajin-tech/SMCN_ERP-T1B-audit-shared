'use strict';
/**
 * 只读取证：空 UUID 是否仍在增长？（决定「止血是否闭环」→ 能否解冻清存量）
 *
 * 背景：RemoteActions.gs:111 `if (uid && exist[uid]) { skippedDup++; continue; }`
 *       —— uid 为空时【不做查重】，直接写入。故空 UUID 行可无限重复。
 *       若近期新增行仍大量为空 UUID ⇒ 漏洞活跃 ⇒ 清完还会长回来，不得解冻。
 *
 * v2（2026-11-01 回应 Tom 08:22 复核）：针对其证据边界补强：
 *   ① 不完整读取拒绝结论：任一页失败/短页 → incomplete=true，不下结论、emptyPct 置 null，process.exit(1)。
 *   ② 零样本：窗口内无样本 → emptyPct 置 null，verdict 明确「无法判定」，不输出 0%。
 *   ③ 时间口径声明：col0 为「提交日期」(submit-date)，非写入时间(write-time)；空 UUID 占比只反映
 *      提交日期口径，不能单独证明写入时间，也不能证明未来不会重放（并发重放/旁路仍须独立验证）。
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
  return null;
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
  function trimLast(vals) {
    let n = vals ? vals.length : 0;
    while (n > 0 && !String((vals[n - 1] || [])[0] || '').trim()) n--;
    return n;
  }
  const last = m1 && m1.values ? trimLast(m1.values) : 0;
  if (!last) { console.error('无法确定总行数'); process.exit(1); }

  const CH = 500, all = [];
  let failedPages = 0, shortPages = 0;
  for (let s = 2; s <= last; s += CH) {
    const e = Math.min(s + CH - 1, last);
    const v = await getRange(TS_ID, PROD_TAB, 'A' + s + ':O' + e);
    if (!v) { failedPages++; continue; }
    const expected = e - s + 1;
    if (v.length !== expected) { shortPages++; continue; }
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

  if (failedPages > 0 || shortPages > 0) {
    const outdir = path.join(__dirname, '..', '_tmp', 'evidence');
    fs.mkdirSync(outdir, { recursive: true });
    const pf = path.join(outdir, 'emptyuuid_trend_' + new Date().toISOString().slice(0, 10) + '.partial.json');
    fs.writeFileSync(pf, JSON.stringify({ incomplete: true, failedPages, shortPages }, null, 2), 'utf8');
    console.error('ABORT: 读取不完整（失败页 ' + failedPages + ' / 短页 ' + shortPages + '），已写 ' + pf);
    process.exit(1);
  }

  const dates = all.map(r => r.date).filter(Boolean).sort();
  const cutoff = dates[dates.length - 1]
    ? new Date(new Date(dates[dates.length - 1]).getTime() - days * 86400000).toISOString().slice(0, 10)
    : '';
  const byDay = new Map();
  all.forEach(r => { if (r.date && r.date >= cutoff) {
    if (!byDay.has(r.date)) byDay.set(r.date, { total: 0, emptyUuid: 0, hours: 0 });
    const o = byDay.get(r.date); o.total++; o.hours += r.hours; if (!r.uuid) o.emptyUuid++;
  } });

  const out = { ts: new Date().toISOString(), lastRow: last, alive: all.length, windowDays: days, cutoff,
                timeCaliber: 'col0 = 提交日期(submit-date)，非写入时间(write-time)；空UUID占比仅反映该口径，不能证明写入时间，亦不能单独排除未来并发重放/旁路', byDay: [] };
  let wTot = 0, wEmpty = 0;
  [...byDay.keys()].sort().forEach(d => {
    const o = byDay.get(d); wTot += o.total; wEmpty += o.emptyUuid;
    out.byDay.push({ date: d, rows: o.total, emptyUuid: o.emptyUuid,
                     emptyPct: o.total ? Math.round(o.emptyUuid / o.total * 1000) / 10 : null,
                     hours: Math.round(o.hours * 100) / 100 });
  });

  out.window = { rows: wTot, emptyUuid: wEmpty,
                 emptyPct: wTot ? Math.round(wEmpty / wTot * 1000) / 10 : null };
  out.complete = true;
  out.verdict = wTot === 0
    ? '窗口内无样本（' + wTot + ' 行），无法判定空UUID是否仍在增长'
    : (out.window.emptyPct === 0
        ? '窗口内零空 UUID ⇒ 空 UUID 为历史遗留，漏洞当前未再触发（注：仅提交日期口径，并发重放/旁路仍须独立验证）'
        : '窗口内仍有 ' + out.window.emptyPct + '% 空 UUID ⇒ 漏洞活跃，清完还会长回来');

  const outdir = path.join(__dirname, '..', '_tmp', 'evidence');
  fs.mkdirSync(outdir, { recursive: true });
  const f = path.join(outdir, 'emptyuuid_trend_' + String(out.ts).slice(0, 10) + '.json');
  fs.writeFileSync(f, JSON.stringify(out, null, 2), 'utf8');
  console.log(JSON.stringify(out, null, 2));
  console.error('\nWROTE ' + f);
})();
