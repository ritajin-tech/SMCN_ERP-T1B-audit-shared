#!/usr/bin/env node
// ts_live_opq_read.js — 只读：拉生产表 DB_工时流水 O:P:Q 整列，提取目标 153 行(119+34)当前真实 O/P/Q 单元格值。
// 用途：补 T1-B 保全证据缺口——Tom 要求「写后值来自同一目标单元格的操作后 live 读取」，含 Q 列。
// 系统已冻结(17:41:29Z 后零写入)，故当前读值 == 操作后态。零生产写、不动链接。
const https = require('https'), http = require('http'), fs = require('fs'), path = require('path');
const { URL: NU } = require('url');
const KEY = require('./.hktool_remote.json').key;
const WEBAPP = 'https://script.google.com/macros/s/AKfycbyq9RYrH1n7DKkoYBVi2cBmsgQLT51i3yaqVP_xF7twQYW0--r39ryu7rJfj1Wn4dTHVA/exec';
const TS_ID = '1Pi5u9fEawgp7yICWPMMyQCT_LbwTZthQDW-H05xYdVI', PROD_TAB = 'DB_工时流水';
const _agent = (WEBAPP.startsWith('http://')) ? new http.Agent({ keepAlive: true, maxSockets: 5 }) : new https.Agent({ keepAlive: true, maxSockets: 5 });
function call(pl) {
  const t = (WEBAPP.startsWith('http://')) ? http : https;
  return new Promise(resolve => {
    const b = JSON.stringify(pl); const u = new NU(WEBAPP);
    const d = (t === http) ? 80 : 443;
    const o = { host: u.hostname, port: u.port || d, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }, agent: _agent };
    const r = t.request(o, res => {
      if (res.statusCode === 302 && res.headers.location) {
        res.resume(); const u2 = new NU(res.headers.location);
        const r2 = t.request({ host: u2.hostname, port: u2.port || d, path: u2.pathname + (u2.search || ''), method: 'GET', agent: _agent }, res2 => {
          const c = []; res2.on('data', d => c.push(d)); res2.on('end', () => { res2.resume(); resolve(Buffer.concat(c).toString('utf8')); });
        });
        r2.on('error', e => resolve('ERR ' + e.message)); r2.end(); return;
      }
      const c = []; res.on('data', d => c.push(d)); res.on('end', () => { res.resume(); resolve(Buffer.concat(c).toString('utf8')); });
    });
    r.on('error', e => resolve('ERR ' + e.message)); r.write(b); r.end();
  });
}
async function get(args) {
  for (let i = 0; i < 6; i++) {
    const s = await call({ action: 'hkRemoteRun', key: KEY, fn: 'inspectWorkbook', args });
    let j; try { j = JSON.parse(s); } catch (e) {}
    if (j && j.result) return j.result;
    await new Promise(r => setTimeout(r, 1500));
  }
  return {};
}
(async () => {
  const tgt = JSON.parse(fs.readFileSync('/tmp/target_rows.json', 'utf8'));
  const all = tgt.r119.concat(tgt.r34);
  const set119 = new Set(tgt.r119), set34 = new Set(tgt.r34);
  // 探测末行
  const probe = await get({ ssId: TS_ID, sheet: PROD_TAB, mode: 'values', a1: 'A1:Q2' });
  const last = probe.lastRow || 0;
  if (!last || last < 2) { console.error('PROBE FAIL', JSON.stringify(probe).slice(0, 200)); process.exit(1); }
  // 分块读 A:Q（每块 400 行），提取 153 行全 17 列（A:N 业务字段 + O:P:Q 软删审计列）
  const byRow = {};
  for (let s = 1; s <= last; s += 400) {
    const e = Math.min(s + 399, last);
    const r = await get({ ssId: TS_ID, sheet: PROD_TAB, mode: 'values', a1: `A${s}:Q${e}` });
    const vals = (r && r.values) ? r.values : [];
    vals.forEach((c, i) => {
      const rr = s + i;
      if (rr <= last && (set119.has(rr) || set34.has(rr))) {
        const cells = (c || []).map(x => x == null ? '' : x);
        byRow[rr] = { O: cells[14], P: cells[15], Q: cells[16], AN: cells.slice(0, 14) };
      }
    });
  }
  const out = { ts: new Date().toISOString(), ssId: TS_ID, sheet: PROD_TAB, frozen: true,
    note: '系统自 2026-11-01T17:41:29Z 起零生产写；当前读值即操作后态。A:N 为业务字段(未写入列),O:P:Q 为软删审计列(写入列)。',
    rows: {} };
  all.forEach(rr => {
    const b = byRow[rr];
    out.rows[rr] = { set: set119.has(rr) ? '119' : '34',
      O: b ? b.O : '(未读到)', P: b ? b.P : '(未读到)', Q: b ? b.Q : '(未读到)',
      AN_len: b ? b.AN.length : 0, AN: b ? b.AN : [] };
  });
  const fp = path.join(__dirname, '..', '_tmp', 'audit_shared', 'evidence', '2026-11-02', 'live_opq_postop_153rows.json');
  fs.writeFileSync(fp, JSON.stringify(out, null, 2), 'utf8');
  const qRead = Object.values(out.rows).filter(x => x.Q && x.Q !== '(未读到)').length;
  console.log('WROTE', fp, '| target', all.length, '| got', Object.keys(byRow).length, '| Q-read', qRead);
})();
