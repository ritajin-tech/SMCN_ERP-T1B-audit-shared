// 生产工时表【软标】执行器 —— 默认只读试算（dry-run），--apply 才真写
// 用途：把 base_uuid_audit.js 判定的 A 级 SAFE 冗余副本行，安全地标记 O 列 = TRUE（不物理删）
//
// CAS 校验（任一不符即拒写，绝不"看着像就写"）：
//   1. 目标行 I 列 UUID == 预期 UUID（身份未漂移）
//   2. 目标行 O 列当前不是 TRUE（未重复软标）
//   3. 目标行与 keeper 行 14 列负载逐列相同（diffCount = 0）
//   4. keeper 行存在，且自身未被软标
//   5. 主库底稿该 UUID 恰有 1 行（软标后主库不少数据）
//
// 用法：
//   node tools/ts_softdel.js --rows 10807                 # 单行试算（默认 dry-run）
//   node tools/ts_softdel.js --uuid TS-D6F94979E326
//   node tools/ts_softdel.js --audit-safe                 # A 级 922 行全量试算
//   node tools/ts_softdel.js --rows 10807 --apply         # 真写（须 TS_WRITE_FREEZE=0）
//   node tools/ts_softdel.js --rows 10807 --emit <file>   # 只导出 patchCells 载荷
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { URL: NU } = require('url');

const WEBAPP = 'https://script.google.com/macros/s/AKfycbyq9RYrH1n7DKkoYBVi2cBmsgQLT51i3yaqVP_xF7twQYW0--r39ryu7rJfj1Wn4dTHVA/exec';
const KEY = require('./.hktool_remote.json').key;
const TS_ID = '1Pi5u9fEawgp7yICWPMMyQCT_LbwTZthQDW-H05xYdVI';
const PROD_TAB = 'DB_工时流水';
const MASTER_ID = '1oxPj0mzN8poP2vQ7Bm-YKXuU49p9b0c1asyrZn4Py44';
const BASE_TAB = '工时_候选0824';
const AUDIT = path.join(__dirname, '..', '_tmp', 'evidence', 'base_uuid_audit_20261027.json');

// ---- 只读通道（hktool）----
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
    await new Promise(r => setTimeout(r, 1000));
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

function parseArgs() {
  const a = process.argv.slice(2); const o = { rows: [], apply: false, emit: null, auditSafe: false, uuid: null };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--rows') { a[++i].split(',').forEach(x => o.rows.push(parseInt(x, 10))); }
    else if (a[i] === '--uuid') o.uuid = a[++i];
    else if (a[i] === '--apply') o.apply = true;
    else if (a[i] === '--emit') o.emit = a[++i];
    else if (a[i] === '--audit-safe') o.auditSafe = true;
  }
  return o;
}

(async () => {
  const o = parseArgs();
  let targets = [];   // {row, uuid, keeperRow, expected}

  if (o.auditSafe || o.uuid || o.rows.length) {
    const audit = JSON.parse(fs.readFileSync(AUDIT, 'utf8'));
    const all = audit.detail.safe || [];
    if (o.auditSafe) {
      // A 级全量：每条的副本行 = prodRowNums 中除 keeper 外的行（keeper = 首行）
      for (const rec of all) {
        const keep = rec.prodRowNums[0];
        for (const r of rec.prodRowNums.slice(1)) targets.push({ row: r, uuid: rec.uuid, keeperRow: keep });
      }
    } else if (o.uuid) {
      const rec = all.find(x => x.uuid === o.uuid);
      if (!rec) throw new Error('该 UUID 不在 A 级 SAFE 清单中，拒绝处理：' + o.uuid);
      const keep = rec.prodRowNums[0];
      for (const r of rec.prodRowNums.slice(1)) targets.push({ row: r, uuid: rec.uuid, keeperRow: keep });
    } else {
      for (const row of o.rows) {
        const rec = all.find(x => x.prodRowNums.includes(row));
        if (!rec) throw new Error('第 ' + row + ' 行不在 A 级 SAFE 清单中，拒绝处理');
        const keep = rec.prodRowNums[0];
        if (row === keep) throw new Error('第 ' + row + ' 行是 keeper（保留行），拒绝软标');
        targets.push({ row, uuid: rec.uuid, keeperRow: keep });
      }
    }
  } else {
    throw new Error('用法：--rows <行号,行号> | --uuid <UUID> | --audit-safe   [--apply] [--emit <file>]');
  }

  process.stderr.write('[READ] 只读回读生产表与底稿，做 CAS 校验...\n');
  const prod = await readAll(TS_ID, PROD_TAB, 'Q');
  const base = await readAll(MASTER_ID, BASE_TAB, 'K');
  const prodByRow = {}; prod.forEach(r => { prodByRow[r.row] = r.cells; });
  const baseUuidCount = {};
  base.slice(1).forEach(r => { const u = norm(r.cells[8]); if (u) baseUuidCount[u] = (baseUuidCount[u] || 0) + 1; });

  const pass = [], fail = [];
  for (const t of targets) {
    const dup = prodByRow[t.row], keep = prodByRow[t.keeperRow];
    const reasons = [];
    if (!dup) reasons.push('目标行不存在');
    if (!keep) reasons.push('keeper 行不存在');
    if (dup && keep) {
      if (norm(dup[8]) !== t.uuid) reasons.push('UUID 漂移：实际 ' + norm(dup[8]) + ' ≠ 预期 ' + t.uuid);
      if (softDel(dup)) reasons.push('目标行已被软标（幂等跳过）');
      if (softDel(keep)) reasons.push('keeper 行已被软标 → 软标副本会让这组全部失效');
      let diff = 0;
      for (let c = 0; c <= 13; c++) if (norm(dup[c]) !== norm(keep[c])) diff++;
      if (diff !== 0) reasons.push('与 keeper 负载不一致（' + diff + ' 列不同）→ 属异负载，不得自动裁决');
      const bc = baseUuidCount[t.uuid] || 0;
      if (bc !== 1) reasons.push('底稿该 UUID 行数 = ' + bc + '（须恰为 1）');
    }
    if (reasons.length) fail.push({ ...t, reasons });
    else pass.push({ ...t, hours: parseFloat(dup[6]) || 0, bizDate: norm(dup[1]).slice(0, 10) });
  }

  const totalH = pass.reduce((s, x) => s + x.hours, 0);
  process.stderr.write('\n=== CAS 校验结果 ===\n');
  process.stderr.write('通过 ' + pass.length + ' 行 / ' + totalH.toFixed(1) + 'h\n');
  process.stderr.write('拒绝 ' + fail.length + ' 行\n');
  fail.slice(0, 10).forEach(f => process.stderr.write('  ✗ 行 ' + f.row + '：' + f.reasons.join('；') + '\n'));
  if (fail.length > 10) process.stderr.write('  ... 其余 ' + (fail.length - 10) + ' 行见输出\n');

  // 🔴 tsPatchCells 的 cells 是【数组】格式 [row, col, value]，不是对象
  //    （源码 RemoteActions.js:186 `Number(c[0]) / c[1] / c[2]`；历史载荷 _tmp/_ts_patch_cells.json 同格式）
  const payload = { cells: pass.map(p => [p.row, 15, 'TRUE']) };
  const out = {
    meta: {
      generatedAtBJT: new Date(Date.now() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19),
      mode: o.apply ? 'APPLY' : 'DRY_RUN',
      logic: 'A 级 SAFE 冗余副本软标（O 列 = TRUE，不物理删）',
      cas: 'UUID + keeper 负载逐列一致 + keeper 未软标 + 底稿 UUID 恰 1 行'
    },
    passed: pass, rejected: fail,
    totals: { rows: pass.length, hours: +totalH.toFixed(1) },
    patchCellsPayload: payload
  };

  if (o.emit) {
    fs.writeFileSync(o.emit, JSON.stringify(payload, null, 2), 'utf8');
    process.stderr.write('\n[EMIT] 载荷已写入 ' + o.emit + '\n');
  }
  if (!o.apply) {
    process.stderr.write('\n[DRY-RUN] 未写入任何数据。真写请加 --apply（并先解除 TS_WRITE_FREEZE）。\n');
    process.stdout.write(JSON.stringify(out, null, 2));
    return;
  }

  const pfile = path.join(__dirname, '..', '_tmp', 'ts_softdel_payload.json');
  fs.writeFileSync(pfile, JSON.stringify(payload, null, 2), 'utf8');
  process.stderr.write('[APPLY] 调用 tools/ts_post.py patchCells ...\n');
  try {
    const r = execFileSync('python', [path.join(__dirname, 'ts_post.py'), 'patchCells', pfile],
      { encoding: 'utf8', env: process.env });
    process.stderr.write(r + '\n');
  } catch (e) {
    process.stderr.write('[FAIL] 写入被拒或失败：' + (e.stdout || '') + (e.stderr || e.message) + '\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(out, null, 2));
})();
