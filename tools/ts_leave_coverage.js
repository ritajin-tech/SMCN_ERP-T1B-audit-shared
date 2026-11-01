'use strict';
/**
 * 生产表请假行 × 主库请假页 覆盖核对（只读）
 *
 * 背景：Rita 2026-11-02 指出制度口径——「请假只应有主库『请假』页一份（直接来自日历），
 *       生产表的请假行可以删」。源码实证支持该口径：
 *         Code.js:349-351「2026-10-15 起日历假只进主库『请假』页、不进生产表」
 *         Code.js:352-375 员工端热力图已改读主库请假页（只读合并）
 *         MEMORY 铁律：主库=请假权威源；生产表=唯一工时源
 *
 * 用途：删除（软标）前先算业务值——逐条核对生产表存活请假行是否被主库请假页同人同日覆盖。
 *       🔴 未被覆盖的行一律不得删（删了就是真丢数据），本脚本会单独列出。
 *
 * 用法：node tools/ts_leave_coverage.js [--csv]
 * EXIT: 0=全部被覆盖（可删） / 1=存在未覆盖（需人工裁定） / 2=读取不完整，不下结论
 */
const https = require('https');
const fs = require('fs');
const { URL: NU } = require('url');
const WEBAPP = 'https://script.google.com/macros/s/AKfycbyq9RYrH1n7DKkoYBVi2cBmsgQLT51i3yaqVP_xF7twQYW0--r39ryu7rJfj1Wn4dTHVA/exec';
const KEY = require('./.hktool_remote.json').key;
const TS_ID = '1Pi5u9fEawgp7yICWPMMyQCT_LbwTZthQDW-H05xYdVI';
const MASTER_ID = '1oxPj0mzN8poP2vQ7Bm-YKXuU49p9b0c1asyrZn4Py44';
const PROD_TAB = 'DB_工时流水';
const LEAVE_TAB = '请假';
const NL = String.fromCharCode(10);

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
// 口径：hktool UTC+8h 取日期（与主库/生产表 B 列 ISO 存储一致）
function day8(v) {
  if (!v) return '';
  const d = (v instanceof Date) ? v : new Date(v);
  if (isNaN(d.getTime())) {
    const m = String(v).match(/(\d{4})-(\d{2})-(\d{2})/);
    return m ? m[0] : '';
  }
  return UtilitiesLike(d);
}
function UtilitiesLike(d) {
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return t.getUTCFullYear() + '-' + p(t.getUTCMonth() + 1) + '-' + p(t.getUTCDate());
}
function isLeaveRow(r) {
  const s = (String(r[7] || '') + ' ' + String(r[8] || '') + ' ' + String(r[5] || '')).toUpperCase();
  return /LEAVE-/.test(s) || /系统同步请假/.test(String(r[7] || '')) || /OFF-WORK/.test(s);
}

(async () => {
  // 1) 主库请假页（权威源）：姓名 A(0) / 日期 B(1) / 工时 F(5) / 来源 I(8)
  const mMeta = await get('inspectWorkbook', { ssId: MASTER_ID, sheet: LEAVE_TAB, mode: 'meta' });
  const mLast = mMeta && mMeta.lastRow ? mMeta.lastRow : 0;
  if (!mLast) { console.log('ABORT: 主库请假页读取失败'); process.exit(2); }
  const master = [];
  const M_PAGE = 400;
  let mFailed = 0;
  for (let s = 2; s <= mLast; s += M_PAGE) {
    const e = Math.min(mLast, s + M_PAGE - 1);
    const r = await get('inspectWorkbook', { ssId: MASTER_ID, sheet: LEAVE_TAB, mode: 'values', a1: 'A' + s + ':J' + e });
    const v = (r && r.values) || [];
    if (v.length < (e - s + 1)) mFailed++;
    v.forEach((row, i) => {
      const name = String((row || [])[0] || '').trim();
      if (!name) return;
      master.push({ row: s + i, name, date: day8((row || [])[1]), hours: parseFloat((row || [])[5]) || 0, src: String((row || [])[8] || '').trim() });
    });
  }
  const mIdx = {};
  master.forEach(m => { const k = m.name + '|' + m.date; (mIdx[k] = mIdx[k] || []).push(m); });

  // 2) 生产表请假行（存活）
  const pMeta = await get('inspectWorkbook', { ssId: TS_ID, sheet: PROD_TAB, mode: 'meta' });
  const pLast = pMeta && pMeta.lastRow ? pMeta.lastRow : 0;
  if (!pLast) { console.log('ABORT: 生产表读取失败'); process.exit(2); }
  const prod = [];
  const P_PAGE = 300;
  let pFailed = 0;
  for (let s = 2; s <= pLast; s += P_PAGE) {
    const e = Math.min(pLast, s + P_PAGE - 1);
    const r = await get('inspectWorkbook', { ssId: TS_ID, sheet: PROD_TAB, mode: 'values', a1: 'A' + s + ':R' + e });
    const v = (r && r.values) || [];
    if (v.length < (e - s + 1)) pFailed++;
    v.forEach((row, i) => {
      if (!String((row || [])[0] || '').trim() && !String((row || [])[2] || '').trim()) return;
      const del = String((row || [])[14] || '').trim().toUpperCase() === 'TRUE';
      if (del) return;                       // 只看存活
      if (!isLeaveRow(row)) return;
      prod.push({
        row: s + i, name: String((row || [])[2] || '').trim(), date: day8((row || [])[1]),
        hours: parseFloat((row || [])[6]) || 0, project: String((row || [])[5] || '').trim(),
        notes: String((row || [])[7] || '').trim(), uuid: String((row || [])[8] || '').trim()
      });
    });
  }

  // 3) 覆盖比对
  const covered = [], notCovered = [];
  prod.forEach(p => {
    const hits = mIdx[p.name + '|' + p.date] || [];
    if (hits.length) covered.push({ p: p, m: hits[0] }); else notCovered.push(p);
  });

  const sumH = a => a.reduce((s, x) => s + (x.hours || (x.p ? x.p.hours : 0)), 0);
  const out = [];
  out.push('主库请假页: lastRow=' + mLast + ' 有效行=' + master.length + ' 短页=' + mFailed);
  out.push('生产表存活请假行: ' + prod.length + ' 短页=' + pFailed);
  out.push('——');
  out.push('被主库覆盖（可软删）: ' + covered.length + ' 行 / ' + sumH(covered.map(c => c.p)).toFixed(1) + 'h');
  out.push('未被覆盖（🔴 不得删）: ' + notCovered.length + ' 行 / ' + sumH(notCovered).toFixed(1) + 'h');
  // 日期分布：是否含 2026-10-15 之后（按制度不应再进生产表）
  const after = prod.filter(p => p.date > '2026-10-15');
  out.push('生产表请假行中日期 > 2026-10-15 的: ' + after.length + ' 行' + (after.length ? '（按制度不应再写入生产表，属活跃写入路径迹象）' : ''));
  if (notCovered.length) {
    out.push('—— 未覆盖明细（前 30） ——');
    notCovered.slice(0, 30).forEach(p => out.push('  行' + p.row + ' ' + p.name + ' ' + p.date + ' ' + p.hours + 'h ' + p.project + ' | ' + p.notes.slice(0, 40)));
  }
  const txt = out.join(NL);
  console.log(txt);
  fs.writeFileSync('_tmp/leave_coverage_' + new Date().toISOString().slice(0, 10) + '.txt', txt + NL, 'utf8');
  if (process.argv.includes('--csv')) {
    const lines = ['row,name,date,hours,covered'];
    prod.forEach(p => {
      const c = (mIdx[p.name + '|' + p.date] || []).length ? 1 : 0;
      lines.push([p.row, p.name, p.date, p.hours, c].join(','));
    });
    fs.writeFileSync('_tmp/leave_prod_rows.csv', lines.join(NL) + NL, 'utf8');
  }
  // 诊断：导出主库姓名+日期全集，供本地比对（判断是真缺失还是口径差异）
  fs.writeFileSync('_tmp/master_leave_pairs.csv',
    ['name,date,hours,src'].concat(master.map(m => [m.name, m.date, m.hours, m.src].join(','))).join(NL) + NL, 'utf8');
  if (mFailed || pFailed) process.exit(2);
  process.exit(notCovered.length ? 1 : 0);
})();
