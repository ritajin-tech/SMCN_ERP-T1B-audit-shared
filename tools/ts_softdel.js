// 生产工时表【软标】执行器 —— 默认只读试算（dry-run），--apply 才真写
// 用途：把 base_uuid_audit.js 判定的 A 级 SAFE 冗余副本行，安全地标记 O 列 = TRUE（不物理删）
//
// 设计（回应 Tom 2026-10-27 复审 7 项条件）：
//  - 服务端 CAS（tsSoftDelGuarded）：身份/负载/keeper/底稿/期锁 全在锁内闭环，客户端只发候选+校验条件。
//  - 严格响应契约（#4）：信封须含 version；ok/dry 严格布尔；逐项 ok/wrote 严格布尔；
//    dry 响应不得计入"已写完成"；缺失字段/错误类型/dry 响应/未知状态 → 拒绝、不盲重试。
//  - 批次日志（#5）：--status 经服务端 journal 查询（同一 jobId/itemId/requestHash），
//    读取失败留 UNKNOWN；O=TRUE 来源不明 ≠ 本请求完成；措辞改为"已完成/未确认/需人工核实"。
//  - 分页版本闭合（#7）：读前 probe 取 lastRow+revision，读后 re-probe；漂移/空探测 → 整批拒绝。
//
// 用法：
//   node tools/ts_softdel.js --rows 10807                 # 单行试算（默认 dry-run）
//   node tools/ts_softdel.js --uuid TS-D6F94979E326
//   node tools/ts_softdel.js --audit-safe                 # A 级 922 行全量试算
//   node tools/ts_softdel.js --rows 10807 --apply         # 真写（须 TS_WRITE_FREEZE=0）
//   node tools/ts_softdel.js --rows 10807 --emit <file>   # 只导出 patchCells 载荷
//   node tools/ts_softdel.js --status 6 [--jobid <J...>]  # 批次日志查询
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { URL: NU } = require('url');
const norm = require('./ts_softdel_norm.js');

// 🔧 测试 seam（默认=生产值；仅离线 harness 用 env 覆盖，不影响生产行为）
const WEBAPP = process.env.TS_WEBAPP_OVERRIDE || 'https://script.google.com/macros/s/AKfycbyq9RYrH1n7DKkoYBVi2cBmsgQLT51i3yaqVP_xF7twQYW0--r39ryu7rJfj1Wn4dTHVA/exec';
const TS_POST_BIN = process.env.TS_POST_BIN || path.join(__dirname, 'ts_post.py');
const AUDIT = process.env.TS_AUDIT_OVERRIDE || path.join(__dirname, '..', '_tmp', 'evidence', 'base_uuid_audit_20261027.json');
let KEY = null;
try { KEY = require('./.hktool_remote.json').key; } catch (e) { KEY = null; }
const TS_ID = '1Pi5u9fEawgp7yICWPMMyQCT_LbwTZthQDW-H05xYdVI';
const PROD_TAB = 'DB_工时流水';
const MASTER_ID = '1oxPj0mzN8poP2vQ7Bm-YKXuU49p9b0c1asyrZn4Py44';
const BASE_TAB = '工时_候选0824';

const _sdNorm = norm._sdNorm;
const softDel = r => (r[14] === true || String(r[14] || '').toUpperCase() === 'TRUE');

// ---- 只读通道（hktool）----
function call(pl) {
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

// 分页完整性读取（Tom 点4 / 条件 #7）：读前 probe 取 lastRow+revision；读后 re-probe 比对；
// 任一页失败(0行)/截短/漂移/空探测 → ok=false（整批拒绝，不盲写）。
async function readAll(ssId, sheet, lastCol) {
  const probe = await get({ ssId, sheet, mode: 'values', a1: 'A1:' + lastCol + '2' });
  const last = probe.lastRow || 0;
  const revision = probe.revision != null ? probe.revision : null;
  if (!last || last < 2) {
    return { rows: [], lastRow: last, pages: [], ok: false, reason: 'EMPTY_PROBE' };
  }
  const pages = [];
  const rows = [];
  let pageFail = false, truncated = false;
  for (let s = 1; s <= last; s += 400) {
    const e = Math.min(s + 399, last);
    const r = await get({ ssId, sheet, mode: 'values', a1: `A${s}:${lastCol}${e}` });
    const got = (r && r.values) ? r.values.length : 0;
    const expected = (e - s + 1);
    const isLast = (e >= last);
    const ok = got > 0 && (got === expected || (isLast && s + got - 1 >= last));
    pages.push({ reqStart: s, reqEnd: e, got, expected, ok });
    if (!ok) { if (got === 0) pageFail = true; else truncated = true; }
    (r && r.values ? r.values : []).forEach((cells, i) => rows.push({ row: s + i, cells: cells || [] }));
  }
  // 条件 #7：读后 re-probe 检测"读期间漂移"——与读前 lastRow/revision 不一致即失败
  const probe2 = await get({ ssId, sheet, mode: 'values', a1: 'A1:' + lastCol + '2' });
  if (probe2.lastRow !== last || (revision != null && probe2.revision != null && probe2.revision !== revision)) {
    return { rows, lastRow: last, pages, ok: false, reason: 'DRIFT_DURING_READ', driftLast: probe2.lastRow };
  }
  const data = rows.filter(x => x.cells.some(c => String(c ?? '').trim() !== ''));
  return { rows: data, lastRow: last, pages, ok: !pageFail && !truncated, revision };
}

function parseArgs() {
  const a = process.argv.slice(2);
  const o = { rows: [], apply: false, emit: null, auditSafe: false, auditAll: false, uuid: null, timeOnly: false, status: null, jobId: null };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--rows') { a[++i].split(',').forEach(x => o.rows.push(parseInt(x, 10))); }
    else if (a[i] === '--uuid') o.uuid = a[++i];
    else if (a[i] === '--apply') o.apply = true;
    else if (a[i] === '--emit') o.emit = a[++i];
    else if (a[i] === '--audit-safe') o.auditSafe = true;
    else if (a[i] === '--audit-all') o.auditAll = true;
    else if (a[i] === '--allow-time-only') o.timeOnly = true;
    else if (a[i] === '--status') o.status = a[++i].split(',').map(x => parseInt(x, 10));
    else if (a[i] === '--jobid') o.jobId = a[++i];
  }
  return o;
}

function jobIdFile() { return path.join(__dirname, '..', '_tmp', 'ts_last_jobid.json'); }
function saveJobId(jid) { try { fs.mkdirSync(path.dirname(jobIdFile()), { recursive: true }); fs.writeFileSync(jobIdFile(), JSON.stringify({ jobId: jid }), 'utf8'); } catch (e) {} }
function loadJobId() { try { return JSON.parse(fs.readFileSync(jobIdFile(), 'utf8')).jobId; } catch (e) { return null; } }

(async () => {
  const o = parseArgs();

  // ---- 批次日志查询（条件 #5）：经服务端 journal 查询 + 独立 O 回读交叉验证 ----
  if (o.status && o.status.length) {
    process.stderr.write('[STATUS] 批次日志查询（服务端 journal + 独立 O 回读）...\n');
    const jobId = o.jobId || loadJobId();
    const statusPayload = { action: 'statusQuery', jobId: jobId, rows: o.status.map(r => ({ row: r })) };
    const spf = path.join(__dirname, '..', '_tmp', 'ts_status_query.json');
    fs.writeFileSync(spf, JSON.stringify(statusPayload), 'utf8');
    const qenv = Object.assign({}, process.env, { TS_WEBAPP_OVERRIDE: WEBAPP, TS_POST_BIN, TS_WRITE_FREEZE: '0' });
    let journalRows = [];
    try {
      const sq = execFileSync('python', [TS_POST_BIN, 'softDelGuarded', spf], { encoding: 'utf8', env: qenv });
      let sj; try { sj = JSON.parse(sq); } catch (e) {}
      journalRows = (sj && sj.rows) || [];
    } catch (e) {
      process.stderr.write('[STATUS] 服务端 journal 查询失败（登记 UNKNOWN，不自动重试）：' + ((e.stderr || e.message || '').slice(0, 300)) + '\n');
    }
    const reread = await rereadO(o.status);
    const out = o.status.map(r => {
      const jr = journalRows.find(x => x.itemId === r);
      const oTrue = (reread[r] === true || reread[r] === 'true' || reread[r] === 'TRUE');
      let state;
      if (!jr) {
        // 无日志：O=TRUE 但来源不明（可能是历史软标/他请求），不能断言本请求完成
        state = oTrue ? 'O_TRUE_SOURCE_UNKNOWN' : 'UNKNOWN';
      } else if (jr.state === 'COMMITTED') state = 'COMMITTED';
      else if (jr.state === 'REJECTED') state = 'REJECTED';
      else if (jr.state === 'UNKNOWN') state = 'UNKNOWN';
      else state = jr.state;
      return { row: r, state, journalState: jr ? jr.state : null, oValue: reread[r] };
    });
    process.stdout.write(JSON.stringify({ action: 'statusQuery', jobId, rows: out }, null, 2));
    return;
  }

  let targets = [];   // {row, uuid, keeperRow, expectHash, keeperHash, expectBaseHash, fromSafe}

  if (o.auditAll || o.auditSafe || o.uuid || o.rows.length) {
    const audit = JSON.parse(fs.readFileSync(AUDIT, 'utf8'));
    const safe = audit.detail.safe || [];
    const notInBase = audit.detail.notInBase || [];
    const collect = (rec, fromSafe) => {
      for (const t of (rec.targets || [])) {
        targets.push({ row: t.row, uuid: rec.uuid, keeperRow: t.keeperRow,
          expectHash: t.targetHash, keeperHash: t.keeperHash, expectBaseHash: t.baseHash, fromSafe });
      }
    };
    if (o.auditAll) {
      for (const rec of safe) collect(rec, true);
      for (const rec of notInBase) collect(rec, false);
    } else if (o.auditSafe) {
      for (const rec of safe) collect(rec, true);
    } else if (o.uuid) {
      const inSafe = safe.find(x => x.uuid === o.uuid);
      const rec = inSafe || notInBase.find(x => x.uuid === o.uuid);
      if (!rec) throw new Error('该 UUID 不在可处理清单中，拒绝：' + o.uuid);
      collect(rec, !!inSafe);
    } else {
      for (const row of o.rows) {
        let found = null, fSafe = false;
        for (const rec of safe) { if ((rec.targets || []).some(t => t.row === row)) { found = rec; fSafe = true; break; } }
        if (!found) for (const rec of notInBase) { if ((rec.targets || []).some(t => t.row === row)) { found = rec; break; } }
        if (!found) throw new Error('第 ' + row + ' 行不在可处理清单中，拒绝处理');
        const t = (found.targets || []).find(t => t.row === row);
        const keep = t.keeperRow;
        if (row === keep) throw new Error('第 ' + row + ' 行是 keeper（保留行），拒绝软标');
        targets.push({ row, uuid: found.uuid, keeperRow: keep,
          expectHash: t.targetHash, keeperHash: t.keeperHash, expectBaseHash: t.baseHash, fromSafe: fSafe });
      }
    }
  } else {
    throw new Error('用法：--rows <行号,行号> | --uuid <UUID> | --audit-safe | --audit-all | --status <行号,行号> [--jobid <J>]  [--allow-time-only] [--apply] [--emit <file>]');
  }

  process.stderr.write('[READ] 只读回读生产表与底稿，做 CAS 校验...\n');
  const prod = await readAll(TS_ID, PROD_TAB, 'Q');
  const base = await readAll(MASTER_ID, BASE_TAB, 'O');
  const prodByRow = {}; prod.rows.forEach(r => { prodByRow[r.row] = r.cells; });
  const baseUuidCount = {};
  base.rows.slice(1).forEach(r => { const u = _sdNorm(r.cells[8]); if (u) baseUuidCount[u] = (baseUuidCount[u] || 0) + 1; });

  // 分页完整性（含版本闭合 / 空探测）：任一失败/截短/漂移即整批拒绝
  if (!prod.ok) {
    process.stderr.write('\n[ABORT] 生产表读取分页不完整/漂移/空探测（' + (prod.reason || '') + '，页明细见 stderr），整批拒绝，不盲写\n');
    process.stderr.write('  pages: ' + JSON.stringify(prod.pages) + '\n');
    process.exit(1);
  }
  if (!base.ok) {
    process.stderr.write('\n[ABORT] 主库底稿读取分页不完整/漂移/空探测（' + (base.reason || '') + '，页明细见 stderr），整批拒绝，不盲写\n');
    process.stderr.write('  pages: ' + JSON.stringify(base.pages) + '\n');
    process.exit(1);
  }
  if (prod.rows.length <= 1 || base.rows.length <= 1) {
    process.stderr.write('\n[ABORT] 读取到的数据行过少（生产 ' + prod.rows.length + ' / 底稿 ' + base.rows.length + '），整批拒绝\n');
    process.exit(1);
  }

  const pass = [], fail = [];
  for (const t of targets) {
    const dup = prodByRow[t.row], keep = prodByRow[t.keeperRow];
    const reasons = [];
    if (!dup) reasons.push('目标行不存在');
    if (!keep) reasons.push('keeper 行不存在');
    if (dup && keep) {
      if (_sdNorm(dup[8]) !== t.uuid) reasons.push('UUID 漂移：实际 ' + _sdNorm(dup[8]) + ' ≠ 预期 ' + t.uuid);
      if (softDel(dup)) reasons.push('目标行已被软标（幂等跳过）');
      if (softDel(keep)) reasons.push('keeper 行已被软标 → 软标副本会让这组全部失效');
      const diffs = [];
      for (let c = 0; c <= 13; c++) if (_sdNorm(dup[c]) !== _sdNorm(keep[c])) diffs.push(c);
      const allowed = o.timeOnly && diffs.length > 0 && diffs.every(c => c === 0);
      if (diffs.length > 0 && !allowed) {
        reasons.push('与 keeper 负载不一致（列 ' + diffs.join(',') + ' 不同）→ 属异负载，不得自动裁决');
      }
      const bc = baseUuidCount[t.uuid] || 0;
      const expectLevel = t.fromSafe ? 'A' : 'B';
      if (expectLevel === 'A' && bc !== 1) reasons.push('A级预期但底稿该UUID行数=' + bc + '（须恰为1，底稿可能读取失败/缺页）');
      if (expectLevel === 'B' && bc !== 0) reasons.push('B级预期但底稿该UUID行数=' + bc + '（须为0）');
    }
    if (reasons.length) fail.push({ ...t, reasons });
    else {
      pass.push({ ...t, hours: parseFloat(_sdNorm(dup[6])) || 0,
                  bizDate: new Date(new Date(_sdNorm(dup[1])).getTime() + 8 * 3600e3).toISOString().slice(0, 10),
                  level: t.fromSafe ? 'A' : 'B' });
    }
  }

  const totalH = pass.reduce((s, x) => s + x.hours, 0);
  process.stderr.write('\n=== CAS 校验结果 ===\n');
  process.stderr.write('通过 ' + pass.length + ' 行 / ' + totalH.toFixed(1) + 'h\n');
  process.stderr.write('拒绝 ' + fail.length + ' 行\n');
  fail.slice(0, 10).forEach(f => process.stderr.write('  ✗ 行 ' + f.row + '：' + f.reasons.join('；') + '\n'));
  if (fail.length > 10) process.stderr.write('  ... 其余 ' + (fail.length - 10) + ' 行见输出\n');

  const jobId = 'J' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const payload = {
    jobId, batchId: jobId,
    rows: pass.map(p => ({
      row: p.row, uuid: p.uuid, keeperRow: p.keeperRow, level: p.level, timeOnly: o.timeOnly,
      expectHash: p.expectHash, keeperHash: p.keeperHash, expectBaseHash: p.expectBaseHash
    }))
  };
  const out = {
    meta: {
      generatedAtBJT: new Date(Date.now() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19),
      mode: o.apply ? 'APPLY' : 'DRY_RUN',
      logic: 'A/B 级冗余副本软标（O 列 = TRUE，不物理删）',
      cas: '服务端 tsSoftDelGuarded 锁内重读 UUID+负载+keeper+底稿映射+SHA-256指纹+期锁 校验后写并回读',
      action: 'softDelGuarded', jobId, batchId: jobId, version: 'ts_softdel_core/2'
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

  // 分批真写：服务端在锁内做 CAS + 写 + 回读；客户端仍分批（防 Web App 超时），
  // 且每批后独立回读生产 O 列做后验。注意：服务端默认 dry=true（fail-closed），
  // 真写须显式 dry=false 且 TS_WRITE_FREEZE=0；本执行器发 dry:'0'（=false）。
  saveJobId(jobId);
  const BATCH = 300;
  const pfile = path.join(__dirname, '..', '_tmp', 'ts_softdel_payload.json');
  try { fs.mkdirSync(path.dirname(pfile), { recursive: true }); } catch (e) {}
  let done = 0;
  for (let s = 0; s < payload.rows.length; s += BATCH) {
    const batch = payload.rows.slice(s, s + BATCH);
    const subBatchId = jobId + '-' + (Math.floor(s / BATCH) + 1);
    fs.writeFileSync(pfile, JSON.stringify({ jobId, batchId: subBatchId, dry: '0', rows: batch }), 'utf8');
    process.stderr.write('[APPLY] 批次 ' + (Math.floor(s / BATCH) + 1) + '：' + batch.length + ' 行 ...\n');
    try {
      const r = execFileSync('python', [TS_POST_BIN, 'softDelGuarded', pfile], { encoding: 'utf8', env: process.env });
      let j;
      try { j = JSON.parse(r); }
      catch (pe) {
        process.stderr.write('[FAIL] 服务端响应非 JSON（登记不明、不盲重试）：' + r.slice(0, 300) + '\n');
        process.exit(1);
      }
      // 条件 #4：严格响应契约
      if (typeof j !== 'object' || !j) { process.stderr.write('[FAIL] 响应非对象（登记不明、不盲重试）\n'); process.exit(1); }
      if (typeof j.version !== 'string') { process.stderr.write('[FAIL] 响应缺 version 字段（契约不符）：' + JSON.stringify(j).slice(0, 200) + '\n'); process.exit(1); }
      if (j.batchId && j.batchId !== subBatchId) {
        process.stderr.write('[FAIL] 批次ID不匹配（疑似串批）：期望 ' + subBatchId + ' 实际 ' + j.batchId + ' —— 登记不明，不盲重试\n');
        process.exit(1);
      }
      if (j.batchId == null) {  // 条件 #4：缺 batchId 字段 → 拒绝
        process.stderr.write('[FAIL] 响应缺 batchId 字段（契约不符，疑似非本服务响应）—— 登记不明，不盲重试\n');
        process.exit(1);
      }
      if (j.ok !== true) {  // 严格布尔
        const bad = (Array.isArray(j.results) ? j.results : []).filter(x => !(x && x.ok)).map(x => 'row' + (x && x.row) + ':' + (x && x.reason));
        process.stderr.write('[FAIL] 服务端返回 ok≠true：' + (j.error ? ('[' + j.error + '] ') : '') + bad.join('；') + ' —— 登记不明，不盲重试\n');
        process.exit(1);
      }
      // dry 响应：本应 apply，却回 dry=true → 契约矛盾，未真实写入，不得计入 done
      if (j.dry === true) {
        process.stderr.write('[FAIL] 响应 dry=true 但本批申请 apply（dry=0）—— 服务端未真实写入，拒绝并登记不明，不盲重试\n');
        process.exit(1);
      }
      const results = Array.isArray(j.results) ? j.results : [];
      const reqRows = batch.map(b => b.row).slice().sort((a, b) => a - b);
      const resRows = results.map(x => (x && typeof x.row === 'number') ? x.row : null).filter(x => x != null).sort((a, b) => a - b);
      const missing = reqRows.filter(r => !resRows.includes(r));
      const extra = resRows.filter(r => !reqRows.includes(r));
      if (resRows.length !== reqRows.length || missing.length || extra.length) {
        process.stderr.write('[FAIL] 响应行与请求不一一对应（缺失[' + missing + '] 额外[' + extra + ']）—— 登记不明，不盲重试\n');
        process.exit(1);
      }
      // 逐项 ok/wrote 严格布尔；只有 wrote===true 才算真实写入
      for (const x of results) {
        if (x.ok !== true || x.wrote !== true) {
          process.stderr.write('[FAIL] 响应项非(ok&wrote 均为true)：row' + (x && x.row) + ' ok=' + x.ok + ' wrote=' + x.wrote + ' reason=' + x.reason + ' —— 登记不明，不盲重试\n');
          process.exit(1);
        }
      }
      // 独立回读后验（不信任返回声明）
      const reread = await rereadO(batch.map(b => b.row));
      const mismatch = batch.filter(b => !reread[b.row]).map(b => b.row);
      if (mismatch.length) {
        process.stderr.write('[FAIL] 回读核对不符（O 列非 TRUE）：行 ' + mismatch.join(',') + ' —— 登记不明，不盲重试\n');
        process.exit(1);
      }
      done += batch.length;   // 仅当 wrote===true 且回读确认才计入
    } catch (e) {
      process.stderr.write('[FAIL] 批次在 ' + (s + 1) + '–' + (s + batch.length) + ' 行失败，已中止：'
        + (e.stdout || '') + (e.stderr || e.message) + '\n');
      process.stderr.write('[FAIL] 已完成 ' + done + ' 行；剩余未写。本次为"已完成/未确认"状态，需用 --status 核实，勿直接重跑盲写\n');
      process.exit(1);
    }
  }
  process.stderr.write('[APPLY] 全部完成：' + done + ' 行\n');
  process.stdout.write(JSON.stringify(out, null, 2));
})();

// 每批后独立回读（只读通道，不写生产）确认这些行的 O 列 == TRUE。
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
