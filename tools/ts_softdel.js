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
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { URL: NU } = require('url');

// 🔧 测试 seam（默认=生产值；仅离线 harness 用 env 覆盖，不影响生产行为）
const WEBAPP = process.env.TS_WEBAPP_OVERRIDE || 'https://script.google.com/macros/s/AKfycbyq9RYrH1n7DKkoYBVi2cBmsgQLT51i3yaqVP_xF7twQYW0--r39ryu7rJfj1Wn4dTHVA/exec';
const TS_POST_BIN = process.env.TS_POST_BIN || path.join(__dirname, 'ts_post.py');
const AUDIT = process.env.TS_AUDIT_OVERRIDE || path.join(__dirname, '..', '_tmp', 'evidence', 'base_uuid_audit_20261027.json');
// KEY 仅在真实（非 mock）调用时用到；离线 harness 用 TS_WEBAPP_OVERRIDE 走 mock，无需密钥文件。
// 故按需加载并容忍缺失（缺失时 KEY=null，离线传输层不会真正使用它）。
let KEY = null;
try { KEY = require('./.hktool_remote.json').key; } catch (e) { KEY = null; }
const TS_ID = '1Pi5u9fEawgp7yICWPMMyQCT_LbwTZthQDW-H05xYdVI';
const PROD_TAB = 'DB_工时流水';
const MASTER_ID = '1oxPj0mzN8poP2vQ7Bm-YKXuU49p9b0c1asyrZn4Py44';
const BASE_TAB = '工时_候选0824';

// ---- 只读通道（hktool）----
function call(pl) {
  // 🔧 按 URL 协议选传输层：https（默认生产）/ http（离线 harness 等）。默认生产走 https，不受影响。
  const transport = (WEBAPP.startsWith('http://')) ? http : https;
  return new Promise(resolve => {
    const b = JSON.stringify(pl); const u = new NU(WEBAPP);
    const defPort = (transport === http) ? 80 : 443;
    const ropt = { host: u.hostname, port: u.port || defPort, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) } };
    const r = transport.request(ropt, res => {
      if (res.statusCode === 302 && res.headers.location) {
        res.resume(); const u2 = new NU(res.headers.location);
        const r2 = transport.request({ host: u2.hostname, port: u2.port || defPort, path: u2.pathname + (u2.search || ''), method: 'GET' }, res2 => {
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
  const a = process.argv.slice(2);
  const o = { rows: [], apply: false, emit: null, auditSafe: false, auditAll: false, uuid: null, timeOnly: false };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--rows') { a[++i].split(',').forEach(x => o.rows.push(parseInt(x, 10))); }
    else if (a[i] === '--uuid') o.uuid = a[++i];
    else if (a[i] === '--apply') o.apply = true;
    else if (a[i] === '--emit') o.emit = a[++i];
    else if (a[i] === '--audit-safe') o.auditSafe = true;
    else if (a[i] === '--audit-all') o.auditAll = true;   // A 级 + B 级（Rita 已授权：重复即删）
    else if (a[i] === '--allow-time-only') o.timeOnly = true;  // 允许仅 A 列录入时间不同
  }
  return o;
}

(async () => {
  const o = parseArgs();
  let targets = [];   // {row, uuid, keeperRow, expectBase}

  if (o.auditAll || o.auditSafe || o.uuid || o.rows.length) {
    const audit = JSON.parse(fs.readFileSync(AUDIT, 'utf8'));
    const safe = audit.detail.safe || [];
    const notInBase = audit.detail.notInBase || [];
    const pick = (rec, fromSafe) => {
      const keep = rec.prodRowNums[0];
      for (const r of rec.prodRowNums.slice(1)) {
        targets.push({ row: r, uuid: rec.uuid, keeperRow: keep, expectBase: keep, fromSafe });
      }
    };
    if (o.auditAll) {
      for (const rec of safe) pick(rec, true);
      for (const rec of notInBase) pick(rec, false);
    } else if (o.auditSafe) {
      for (const rec of safe) pick(rec, true);
    } else if (o.uuid) {
      const inSafe = safe.find(x => x.uuid === o.uuid);
      const rec = inSafe || notInBase.find(x => x.uuid === o.uuid);
      if (!rec) throw new Error('该 UUID 不在可处理清单中，拒绝：' + o.uuid);
      pick(rec, !!inSafe);
    } else {
      for (const row of o.rows) {
        const inSafe = safe.find(x => x.prodRowNums.includes(row));
        const rec = inSafe || notInBase.find(x => x.prodRowNums.includes(row));
        if (!rec) throw new Error('第 ' + row + ' 行不在可处理清单中，拒绝处理');
        const keep = rec.prodRowNums[0];
        if (row === keep) throw new Error('第 ' + row + ' 行是 keeper（保留行），拒绝软标');
        targets.push({ row, uuid: rec.uuid, keeperRow: keep, expectBase: keep, fromSafe: !!inSafe });
      }
    }
  } else {
    throw new Error('用法：--rows <行号,行号> | --uuid <UUID> | --audit-safe | --audit-all  [--allow-time-only] [--apply] [--emit <file>]');
  }

  process.stderr.write('[READ] 只读回读生产表与底稿，做 CAS 校验...\n');
  const prod = await readAll(TS_ID, PROD_TAB, 'Q');
  const base = await readAll(MASTER_ID, BASE_TAB, 'K');
  const prodByRow = {}; prod.forEach(r => { prodByRow[r.row] = r.cells; });
  const baseUuidCount = {};
  base.slice(1).forEach(r => { const u = norm(r.cells[8]); if (u) baseUuidCount[u] = (baseUuidCount[u] || 0) + 1; });

  // 阻断4：读取失败/缺页必须整批拒绝（不能把空读取当成"底稿0行=B级"放行）
  if (!Array.isArray(prod) || !prod.length || prod.length <= 1) {
    process.stderr.write('\n[ABORT] 生产表读取失败或为空（' + (Array.isArray(prod) ? prod.length : '非数组') + ' 行），整批拒绝，不盲写\n');
    process.exit(1);
  }
  if (!Array.isArray(base) || !base.length || base.length <= 1) {
    process.stderr.write('\n[ABORT] 主库底稿读取失败或为空（' + (Array.isArray(base) ? base.length : '非数组') + ' 行），整批拒绝，不盲写\n');
    process.exit(1);
  }

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
      // 负载一致性：默认要求 14 列全同；--allow-time-only 时允许仅 A 列（录入时间）不同
      const diffs = [];
      for (let c = 0; c <= 13; c++) if (norm(dup[c]) !== norm(keep[c])) diffs.push(c);
      const allowed = o.timeOnly && diffs.length > 0 && diffs.every(c => c === 0);
      if (diffs.length > 0 && !allowed) {
        reasons.push('与 keeper 负载不一致（列 ' + diffs.join(',') + ' 不同）→ 属异负载，不得自动裁决');
      }
      // 绑定预期等级（防自动降级，Tom 阻断4）：来源 safe → 预期 A（底稿恰1行）；notInBase → 预期 B（底稿0行）。
      // 若底稿读取异常致 bc 偏离预期，A 级会因 bc≠1 失败，不会悄悄当 B 放行。
      const bc = baseUuidCount[t.uuid] || 0;
      const expectLevel = t.fromSafe ? 'A' : 'B';
      if (expectLevel === 'A' && bc !== 1) reasons.push('A级预期但底稿该UUID行数=' + bc + '（须恰为1，底稿可能读取失败/缺页）');
      if (expectLevel === 'B' && bc !== 0) reasons.push('B级预期但底稿该UUID行数=' + bc + '（须为0）');
    }
    if (reasons.length) fail.push({ ...t, reasons });
    else {
      const d = norm(dup[0]);
      pass.push({ ...t, hours: parseFloat(dup[6]) || 0,
                  bizDate: new Date(new Date(norm(dup[1])).getTime() + 8 * 3600e3).toISOString().slice(0, 10),
                  level: t.fromSafe ? 'A' : 'B' });
    }
  }

  const totalH = pass.reduce((s, x) => s + x.hours, 0);
  process.stderr.write('\n=== CAS 校验结果 ===\n');
  process.stderr.write('通过 ' + pass.length + ' 行 / ' + totalH.toFixed(1) + 'h\n');
  process.stderr.write('拒绝 ' + fail.length + ' 行\n');
  fail.slice(0, 10).forEach(f => process.stderr.write('  ✗ 行 ' + f.row + '：' + f.reasons.join('；') + '\n'));
  if (fail.length > 10) process.stderr.write('  ... 其余 ' + (fail.length - 10) + ' 行见输出\n');

  // 🔴 改用服务端 CAS 动作 tsSoftDelGuarded（A1d）：把校验条件一起发往服务端锁内闭环，
  //    不再客户端先校验、再裸发 [row,15,TRUE]（Tom 2026-10-27 第1条：闭合 CAS 到服务端写入）
  const payload = { rows: pass.map(p => ({
    row: p.row, uuid: p.uuid, keeperRow: p.keeperRow, expectBase: p.keeperRow,
    level: p.level, timeOnly: o.timeOnly
  })) };
  const out = {
    meta: {
      generatedAtBJT: new Date(Date.now() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19),
      mode: o.apply ? 'APPLY' : 'DRY_RUN',
      logic: 'A/B 级冗余副本软标（O 列 = TRUE，不物理删）',
      cas: '服务端 tsSoftDelGuarded 锁内重读 UUID+负载+keeper+底稿映射 校验后写并回读',
      action: 'softDelGuarded'
    },
    passed: pass, rejected: fail,
    totals: { rows: pass.length, hours: +totalH.toFixed(1) },
    softDelGuardedPayload: payload
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

  // 分批真写：服务端 tsSoftDelGuarded 在锁内做 CAS + 写 + 回读；客户端仍分批（防 Web App 超时），
  // 且每批后独立回读生产 O 列做后验（Tom 阻断2/3：严格解析响应、不把返回声称当独立后验、未知结果不盲重试）。
    const BATCH = 300;
  const pfile = path.join(__dirname, '..', '_tmp', 'ts_softdel_payload.json');
  try { fs.mkdirSync(path.dirname(pfile), { recursive: true }); } catch (e) {}
  let done = 0;
  for (let s = 0; s < payload.rows.length; s += BATCH) {
    const batch = payload.rows.slice(s, s + BATCH);
    fs.writeFileSync(pfile, JSON.stringify({ rows: batch }, null, 2), 'utf8');
    process.stderr.write('[APPLY] 批次 ' + (Math.floor(s / BATCH) + 1) + '：' + batch.length + ' 行 ...\n');
    try {
      const r = execFileSync('python', [TS_POST_BIN, 'softDelGuarded', pfile],
        { encoding: 'utf8', env: process.env });
      let j;
      try { j = JSON.parse(r); }
      catch (pe) {
        process.stderr.write('[FAIL] 服务端响应非 JSON（登记不明、不盲重试）：' + r.slice(0, 300) + '\n');
        process.exit(1);
      }
      if (!j.ok) {
        process.stderr.write('[FAIL] 服务端返回 ok=false（登记不明、不盲重试）：' + JSON.stringify(j.error || j) + '\n');
        process.exit(1);
      }
      const results = j.results || [];
      const wrote = results.filter(x => x && x.ok).length;
      if (wrote !== batch.length) {
        const bad = results.filter(x => !(x && x.ok)).map(x => 'row' + (x && x.row) + ':' + (x && x.reason)).join('；');
        process.stderr.write('[FAIL] 本批期望写 ' + batch.length + ' 实际写入 ' + wrote + '：' + bad + ' —— 登记不明，不盲重试\n');
        process.exit(1);
      }
      // 阻断3：每批后独立回读（只读通道）确认 O 列 == TRUE，不信任返回声明
      const reread = await rereadO(batch.map(b => b.row));
      const mismatch = batch.filter(b => !reread[b.row]).map(b => b.row);
      if (mismatch.length) {
        process.stderr.write('[FAIL] 回读核对不符（O 列非 TRUE）：行 ' + mismatch.join(',') + ' —— 登记不明，不盲重试\n');
        process.exit(1);
      }
      done += batch.length;
    } catch (e) {
      process.stderr.write('[FAIL] 批次在 ' + (s + 1) + '–' + (s + batch.length) + ' 行失败，已中止：'
        + (e.stdout || '') + (e.stderr || e.message) + '\n');
      process.stderr.write('[FAIL] 已完成 ' + done + ' 行；剩余未写，可重跑（已写格会被服务端 CAS 判为"已软标"跳过）\n');
      process.exit(1);
    }
  }
  process.stderr.write('[APPLY] 全部完成：' + done + ' 行\n');
  process.stdout.write(JSON.stringify(out, null, 2));
})();

// 阻断3：每批后独立回读（只读通道，不写生产）确认这些行的 O 列 == TRUE。
// 不信任服务端返回的 patched 声明，作为独立后验；读取失败视为不符 → 触发中止。
async function rereadO(rows) {
  const out = {};
  for (const row of rows) {
    try {
      const r = await get({ ssId: TS_ID, sheet: PROD_TAB, mode: 'values', a1: 'O' + row + ':O' + row });
      const v = (r.values && r.values[0] && r.values[0][0]);
      out[row] = String(v === undefined || v === null ? '' : v).toUpperCase() === 'TRUE';
    } catch (e) { out[row] = false; }
  }
  return out;
}
