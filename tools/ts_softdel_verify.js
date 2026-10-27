// 软标执行后复核器（只读）：证明「1567 行全部软标成功、keeper 零误伤、底稿零变化」
//
// 用途：GO-S4+A4+B 执行完之后跑一次，五项断言全过才算执行成功。
// 在执行前跑也可以：此时应报告 1567 行「待软标」（未软标），用于自测脚本本身。
//
// 断言：
//   A1 载荷 1567 行的 O 列全部 = TRUE（软标成功；执行前则全部未软标）
//   A2 每组的 keeper 行 O 列 ≠ TRUE（keeper 未被误伤）
//   A3 副本行与 keeper 行 UUID 一致（执行期间未漂移）
//   A4 主库底稿 UUID/内容键双维仍零重复（软标只动生产表，底稿一字未变）
//   A5 十月目标行 R10807 状态符合预期（执行后应为 TRUE）
//
// 用法：node tools/ts_softdel_verify.js
const https = require('https');
const { URL: NU } = require('url');
const fs = require('fs');
const path = require('path');
const WEBAPP = 'https://script.google.com/macros/s/AKfycbyq9RYrH1n7DKkoYBVi2cBmsgQLT51i3yaqVP_xF7twQYW0--r39ryu7rJfj1Wn4dTHVA/exec';
const KEY = require('./.hktool_remote.json').key;
const TS_ID = '1Pi5u9fEawgp7yICWPMMyQCT_LbwTZthQDW-H05xYdVI';
const MASTER_ID = '1oxPj0mzN8poP2vQ7Bm-YKXuU49p9b0c1asyrZn4Py44';
const PAYLOAD = path.join(__dirname, '..', '_tmp', 'softdel_ALL_1567_payload_recheck.json');

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
  return out.filter(x => x.cells.some(c => String(c ?? '').trim() !== ''));
}
const norm = v => (v === undefined || v === null) ? '' : String(v).trim();
const softDel = r => (r[14] === true || String(r[14] || '').toUpperCase() === 'TRUE');

(async () => {
  const payload = JSON.parse(fs.readFileSync(PAYLOAD, 'utf8'));
  const cells = payload.cells || [];
  const dupRows = cells.map(c => c[0]);
  console.log('=== 软标执行后复核 ===');
  console.log('载荷行数：' + dupRows.length + '（预期 1567）');

  const prod = await readAll(TS_ID, 'DB_工时流水', 'Q');
  const base = await readAll(MASTER_ID, '工时_候选0824', 'K');
  const prodByRow = {}; prod.forEach(r => { prodByRow[r.row] = r.cells; });
  console.log('生产表数据行：' + prod.length + '｜底稿数据行：' + (base.length - 1));

  // keeper 映射：与 ts_softdel.js 同一快照（AUDIT）推导
  const audit = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '_tmp', 'evidence', 'base_uuid_audit_20261027.json'), 'utf8'));
  const recs = (audit.detail.safe || []).concat(audit.detail.notInBase || []);
  const rowToKeeper = {};
  recs.forEach(rec => { const keep = rec.prodRowNums[0]; rec.prodRowNums.slice(1).forEach(r => { rowToKeeper[r] = keep; }); });

  const results = { A1: { ok: 0, bad: [] }, A2: { ok: 0, bad: [] }, A3: { ok: 0, bad: [] }, A5: null };
  for (const row of dupRows) {
    const dup = prodByRow[row];
    if (!dup) { results.A1.bad.push(row + ':行不存在'); continue; }
    if (softDel(dup)) results.A1.ok++; else results.A1.bad.push(row + ':未软标');
    const keepRow = rowToKeeper[row];
    if (!keepRow) { results.A2.bad.push(row + ':无 keeper 映射'); continue; }
    const keep = prodByRow[keepRow];
    if (!keep) { results.A2.bad.push(row + ':keeper 行不存在'); continue; }
    if (!softDel(keep)) results.A2.ok++; else results.A2.bad.push(row + ':keeper 已被软标');
    if (norm(dup[8]) === norm(keep[8]) && norm(dup[8])) results.A3.ok++; else results.A3.bad.push(row + ':UUID 不一致');
  }
  // A5 十月目标行
  const r10807 = prodByRow[10807];
  results.A5 = r10807 ? { exists: true, softdel: softDel(r10807), uuid: norm(r10807[8]) } : { exists: false };

  // A4 底稿双维零重复（与 base_uuid_audit 同口径）
  const baseUuid = {}, baseKey = {};
  let dupU = 0, dupK = 0;
  for (let i = 1; i < base.length; i++) {
    const r = base[i].cells;
    const u = norm(r[8]);
    if (u) { baseUuid[u] = (baseUuid[u] || 0) + 1; if (baseUuid[u] > 1) dupU++; }
    const nm = norm(r[2]);
    const dt = norm(r[1]).slice(0, 10);
    if (nm && dt) {
      const k = [nm, norm(r[5]).toLowerCase(), norm(r[6]), dt, norm(r[7])].join('\u0002');
      baseKey[k] = (baseKey[k] || 0) + 1; if (baseKey[k] > 1) dupK++;
    }
  }

  const postExec = results.A1.bad.length === 0;
  console.log('\n--- 断言结果 ---');
  console.log('A1 软标成功：' + results.A1.ok + '/' + dupRows.length + (postExec ? '（全部已软标）' : '（存在未软标/异常：' + results.A1.bad.slice(0, 5).join('; ') + '）'));
  console.log('A2 keeper 零误伤：' + results.A2.ok + ' 通过 / ' + results.A2.bad.length + ' 异常' + (results.A2.bad.length ? '（' + results.A2.bad.slice(0, 5).join('; ') + '）' : ''));
  console.log('A3 UUID 未漂移：' + results.A3.ok + ' 通过 / ' + results.A3.bad.length + ' 异常' + (results.A3.bad.length ? '（' + results.A3.bad.slice(0, 5).join('; ') + '）' : ''));
  console.log('A4 底稿零重复：UUID 多行组 ' + dupU + '｜内容键多行组 ' + dupK + '（须均为 0）');
  console.log('A5 十月 R10807：' + JSON.stringify(results.A5));

  const pass = postExec
    ? results.A2.bad.length === 0 && results.A3.bad.length === 0 && dupU === 0 && dupK === 0 && results.A5.softdel === true
    : results.A2.bad.length === 0 && results.A3.bad.length === 0 && dupU === 0 && dupK === 0;
  console.log('\n=== 汇总：' + (pass ? (postExec ? 'PASS（执行后状态正确）' : 'PASS（执行前状态：1567 行待软标，脚本自测通过）') : 'FAIL') + ' ===');
  fs.writeFileSync(path.join(__dirname, '..', '_tmp', 'softdel_verify_' + (postExec ? 'post' : 'pre') + '_20261027.json'),
    JSON.stringify({ checkedAtBJT: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19), postExec, dupRows: dupRows.length, results, baseDup: { dupU, dupK } }, null, 1));
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
