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
const _sdSha256 = norm._sdSha256;
const _sdCellTok = norm._sdCellTok;
const softDel = r => (r[14] === true || String(r[14] || '').toUpperCase() === 'TRUE');
const _cellHash = v => _sdSha256(JSON.stringify(_sdCellTok(v)));

// 请求身份指纹：直接复用服务端核心导出的同一函数（单一可信源），
// 不再在客户端另写一份 —— 否则键序/类型/undefined 省略规则任一不一致，
// --status 的身份绑定就会永久失配并退化为 UNKNOWN。
const requestHashOf = require('./ts_softdel_core.js')._requestHashOf;
// 期望的服务端版本【从核心导出读取】，不再在客户端硬编码版本字符串 ——
// 这正是 Tom #1 抓到的「规范源与生成物版本错配」的成因，改成单一可信源后不可能再错配。
const CORE_VERSION = require('./ts_softdel_core.js').VERSION;

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
    // 每页严格（Tom #2 v3）：返回数必须 == 请求数；不足(0行)或超量(含末页)均令整份快照失败，不盲写
    const ok = got > 0 && got === expected;
    pages.push({ reqStart: s, reqEnd: e, got, expected, ok });
    if (!ok) { if (got === 0) pageFail = true; else truncated = true; }
    // 仅纳入 ≤ last 的行，超界项（服务器多返）不进候选
    (r && r.values ? r.values : []).forEach((cells, i) => {
      const rr = s + i;
      if (rr <= last) rows.push({ row: rr, cells: cells || [] });
    });
  }
  // 条件 #7（Tom #2 v2）：读后 re-probe 检测"读期间漂移"——与读前 lastRow/revision 不一致即失败；
  //   revision 缺失/切换（任一端 null 或异值）一律失败（服务端版本绑定不替代客户端快照完整性证明）。
  const probe2 = await get({ ssId, sheet, mode: 'values', a1: 'A1:' + lastCol + '2' });
  const rev2 = probe2.revision != null ? probe2.revision : null;
  if (probe2.lastRow !== last || revision == null || rev2 == null || revision !== rev2) {
    return { rows, lastRow: last, pages, ok: false, reason: (revision == null || rev2 == null ? 'REVISION_MISSING' : 'DRIFT_DURING_READ'), driftLast: probe2.lastRow, rev1: revision, rev2 };
  }
  const data = rows.filter(x => x.cells.some(c => String(c ?? '').trim() !== ''));
  return { rows: data, lastRow: last, pages, ok: !pageFail && !truncated, revision };
}

// 单一运输契约解析（回应 Tom #1 v2）：从信封解析核心 message，envelope/core 分离，
// 重复字段冲突即拒绝，核心 ok=false 不得被外层 ok=true 掩盖。返回核心对象或抛错（调用方 exit 1）。
function unwrapEnvelope(env) {
  if (!env || typeof env !== 'object') throw new Error('ENVELOPE_NOT_OBJECT');
  const hasVersion = !!env.version;
  // 合同（Tom #1 v4，回应本轮 Tom 指出的分支缺口）：形态由 message【属性存在性】决定，而非仅 typeof string。
  // 纯核心形态 = 有 version 且【无 message 属性】；若 message 属性存在则【必须是可解析字符串】，
  // 否则（message 为 null / object / array 等非字符串）→ 违反合同，fail-closed。
  const messageExists = Object.prototype.hasOwnProperty.call(env, 'message');
  const hasMessage = messageExists && (typeof env.message === 'string');
  // 唯一响应形态约定：核心对象(含 version) 与 信封(message 字符串) 二选一，不得混用。
  if (hasVersion && !messageExists) {
    return env;                          // 纯核心形态（新部署）：顶层即权威核心对象
  }
  if (!hasMessage) {
    // message 属性存在但非字符串（version+message:null/object/array）→ 违反合同
    if (hasVersion && messageExists) throw new Error('MESSAGE_NOT_STRING');
    throw new Error('NO_CORE_MESSAGE');
  }
  let m;
  try { m = JSON.parse(env.message); } catch (_e) { throw new Error('BAD_MESSAGE_JSON'); }
  if (!m || typeof m !== 'object') throw new Error('BAD_MESSAGE_OBJECT');
  // 双形态共存（顶层 version 与 message 同时出现）：合同歧义，须做【双向、类型敏感、字段集完整一致】比较。
  // 既往仅遍历内层字段并比较重叠项；本轮收紧：两侧任一多/缺字段即冲突（外层多字段 / 内层缺字段均拒绝），
  // 内层 ok:false 即使外层 ok:true 也不得被掩盖（外层成功包络不得掩盖内层失败）。
  if (hasVersion) {
    const conflict = [];
    const ek = Object.keys(env), mk = Object.keys(m);
    const all = new Set(ek.concat(mk));
    for (const k of all) {
      if (k === 'version' || k === 'message') continue;   // 信封字段不参与核心内容比较
      const inE = ek.indexOf(k) >= 0, inM = mk.indexOf(k) >= 0;
      if (inE && inM) {
        if (JSON.stringify(env[k]) !== JSON.stringify(m[k])) conflict.push(k);
      } else {
        conflict.push(k);   // 一侧有另一侧无 → 字段集不完整一致
      }
    }
    if (conflict.length) throw new Error('FIELD_CONFLICT:' + conflict.sort().join(','));
  }
  if (m.ok === false || m.ok === 'false') throw new Error('CORE_OK_FALSE');
  return m;
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
    // Tom #5：状态查询必须携带原请求身份（requestHash/uuid），否则服务端无从逐项绑定，
    // 客户端也不能据服务端自称的 COMMITTED 下结论。
    const mfFile = path.join(__dirname, '..', '_tmp', 'ts_softdel_manifest_' + jobId + '.json');
    let manifest = null;
    try { manifest = JSON.parse(fs.readFileSync(mfFile, 'utf8')); } catch (e) { manifest = null; }
    if (!manifest) {
      process.stderr.write('[STATUS] 未找到原请求清单 ' + mfFile + ' → 无法逐项绑定身份，全部登记 UNKNOWN，不盲判\n');
    }
    const idOf = {};
    if (manifest && Array.isArray(manifest.rows)) {
      manifest.rows.forEach(r => {
        idOf[r.row] = { requestHash: r.requestHash, uuid: r.uuid, subBatchId: r.subBatchId };
      });
    }
    // v5（Tom 第 1 项）：--status 必须发【四项完整身份】row + subBatchId + requestHash + uuid，
    //   缺任一 → 服务端按白名单判 INCOMPLETE_QUERY_IDENTITY，客户端也按同一规则判 UNKNOWN。
    const statusPayload = { action: 'statusQuery', jobId: jobId,
      rows: o.status.map(r => ({ row: r,
        subBatchId: idOf[r] ? (idOf[r].subBatchId || null) : null,
        requestHash: idOf[r] ? (idOf[r].requestHash || null) : null,
        uuid: idOf[r] ? (idOf[r].uuid || null) : null })) };
    const spf = path.join(__dirname, '..', '_tmp', 'ts_status_query.json');
    fs.writeFileSync(spf, JSON.stringify(statusPayload), 'utf8');
    const qenv = Object.assign({}, process.env, { TS_WEBAPP_OVERRIDE: WEBAPP, TS_POST_BIN, TS_WRITE_FREEZE: '0' });
    let journalRows = [];
    try {
      const sq = execFileSync('python', [TS_POST_BIN, 'softDelGuarded', spf], { encoding: 'utf8', env: qenv });
      let sj;
      try { sj = unwrapEnvelope(JSON.parse(sq)); }
      catch (e) { sj = null; }   // 契约解析失败 → 全部登记 UNKNOWN，不盲判
      journalRows = (sj && sj.rows) || [];
    } catch (e) {
      process.stderr.write('[STATUS] 服务端 journal 查询失败（登记 UNKNOWN，不自动重试）：' + ((e.stderr || e.message || '').slice(0, 300)) + '\n');
    }
    const reread = await rereadO(o.status);
    const WHITELIST = ['COMMITTED', 'REJECTED', 'UNKNOWN', 'VOIDED'];
    // 严格一一校验（Tom #4 v3）：任何额外/缺失/重复/身份异常 → 整批协议失败（全部 UNKNOWN），不得据任一匹配行下判
    const reqSet = new Set(o.status.map(Number));
    // Tom 本轮#4（G3 收紧）：请求侧 --status 也必须唯一；重复请求行（如 26,26）属畸形输入，
    //   与响应侧 DUP_JOURNAL_ROW 一致 → 该请求行 UNKNOWN(DUP_REQUEST_ROW)，不盲判。
    const _seen = new Set(), dupReq = new Set();
    for (const r of o.status.map(Number)) { if (_seen.has(r)) dupReq.add(r); else _seen.add(r); }
    const extraRows = journalRows.filter(x => !reqSet.has(Number(x.itemId)));
    let protocolOk = (extraRows.length === 0);
    for (const r of o.status) {
      const matches = journalRows.filter(x => Number(x.itemId) === Number(r));
      if (matches.length !== 1) { protocolOk = false; continue; }
      const jr = matches[0];
      const mf = idOf[r];
      const bound = !!(mf && mf.requestHash && mf.subBatchId && mf.uuid);
      const idOk = bound && String(jr.jobId) === String(jobId) && String(jr.subBatchId) === String(mf.subBatchId)
        && String(jr.requestHash) === String(mf.requestHash) && String(jr.uuid) === String(mf.uuid);
      if (!idOk || WHITELIST.indexOf(jr.state) < 0) protocolOk = false;
    }
    if (!protocolOk) {
      process.stderr.write('[STATUS] 响应集合结构异常（额外/缺失/重复/身份异常）→ 整批登记 UNKNOWN，不盲判\n');
    }
    const out = o.status.map(r => {
      // Tom 本轮#4：重复请求行 → 该请求行 UNKNOWN（与响应侧 DUP_JOURNAL_ROW 唯一性规则一致）
      if (dupReq.has(r)) {
        return { row: r, state: 'UNKNOWN', journalState: null, identity: 'DUP_REQUEST_ROW', oValue: reread[r] };
      }
      if (!protocolOk) {
        // 整批协议失败：任何结构性异常都令本次查询所有行 UNKNOWN，绝不据任一匹配行下结论
        return { row: r, state: 'UNKNOWN', journalState: null, identity: 'PROTOCOL_ANOMALY', oValue: reread[r] };
      }
      // v2（Tom #4）：要求【唯一一行】—— 同 itemId 多行（重复）或零行（缺失）均不得下判
      const matches = journalRows.filter(x => Number(x.itemId) === Number(r));
      const oVal = reread[r];
      const oTrue = (oVal === true || String(oVal || '').toUpperCase() === 'TRUE');
      const mf = idOf[r];
      // v5（Tom 第 1 项）：客户端自身也必须声明完整身份（四项缺一不可）
      const bound = !!(mf && mf.requestHash && mf.subBatchId && mf.uuid);
      let state, identity;
      if (matches.length !== 1) {
        state = 'UNKNOWN'; identity = matches.length === 0 ? 'NO_JOURNAL' : 'DUP_JOURNAL_ROW';
      } else if (!bound) {
        // 无法绑身份 → 一律 UNKNOWN（绝不据服务端自称的 COMMITTED 下结论）
        state = 'UNKNOWN'; identity = 'MANIFEST_MISSING';
      } else {
        const jr = matches[0];
        // v2（Tom #4）：客户端对 manifest 身份【逐项严格匹配】jobId/subBatchId/requestHash/uuid，要求唯一一行
        const idOk = String(jr.jobId) === String(jobId) && String(jr.subBatchId) === String(mf.subBatchId)
          && String(jr.requestHash) === String(mf.requestHash) && String(jr.uuid) === String(mf.uuid);
        if (!idOk) { state = 'UNKNOWN'; identity = 'CLIENT_IDENTITY_MISMATCH'; }
        else if (WHITELIST.indexOf(jr.state) < 0) { state = 'UNKNOWN'; identity = 'STATE_NOT_WHITELISTED'; }
        // Tom #5：独立 O 回读不符 → 不得返回 COMMITTED；VOIDED/UNKNOWN/PREPARED 等一律 UNKNOWN（PREPARED 不得读作成功）
        else if (jr.state === 'COMMITTED') { state = oTrue ? 'COMMITTED' : 'UNKNOWN'; }
        else if (jr.state === 'REJECTED') { state = 'REJECTED'; }
        else { state = 'UNKNOWN'; }
        if (idOk && WHITELIST.indexOf(jr.state) >= 0) identity = 'BOUND';
      }
      return { row: r, state, journalState: matches.length === 1 ? matches[0].state : null, identity, oValue: oVal };
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
                  // Tom #5：timeOnly 下录入时间虽排除出行哈希，但仍须【分别绑定】双方录入时间
                  expectEntryTime: _cellHash(dup[0]), keeperEntryTime: _cellHash(keep[0]),
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
  // v5（Tom 第 1 项）：分批大小提前定义 —— manifest 必须记录每行所属批次的【真实】subBatchId。
  //   此前 manifest 只存顶层 jobId，而实际发送是 jobId-N，导致 --status 发的 subBatchId 与
  //   服务端日志中的 subBatchId 永久不一致（身份绑定名存实亡）。
  const BATCH = 300;
  const payload = {
    jobId, batchId: jobId,
    rows: pass.map(p => {
      const r = {
        row: p.row, uuid: p.uuid, keeperRow: p.keeperRow, level: p.level, timeOnly: o.timeOnly,
        expectHash: p.expectHash, keeperHash: p.keeperHash, expectBaseHash: p.expectBaseHash
      };
      // Tom #5：timeOnly 时必须把双方录入时间绑定进载荷；否则服务端会因
      // 缺 expectEntryTime/keeperEntryTime 而整批拒绝（_validateInput 硬性要求）。
      if (o.timeOnly === true) {
        r.expectEntryTime = p.expectEntryTime;
        r.keeperEntryTime = p.keeperEntryTime;
      }
      return r;
    })
  };
  // Tom #5：原请求清单持久化 —— 不落盘则 --status 无从比对 requestHash，身份绑定会永久退化。
  // 此处尚未发生任何写入，落盘失败即可安全中止。
  const manifestRows = payload.rows.map((r, ri) => Object.assign({}, r, {
    requestHash: requestHashOf(r),
    subBatchId: jobId + '-' + (Math.floor(ri / BATCH) + 1)
  }));
  // v5 B2：真写必须端到端绑定主库版本 —— 先探测，写不进 manifest 就中止。
  let masterVersion = null;
  // 无候选行时客户端已预筛全部拒绝，不存在写入，也就无需版本绑定；
  // 若仍发探测（rows 为空）反而会被服务端拒，把「预筛拒绝」误报成「探测失败」。
  if (o.apply && payload.rows.length) {
    masterVersion = probeMasterVersion(payload.rows, jobId);
    if (!masterVersion) {
      process.stderr.write('[ABORT] 主库版本探测失败（无法做版本前后绑定，拒绝盲写）\n');
      process.exit(1);
    }
    process.stderr.write('[PROBE] 主库版本指纹已取得并写入 manifest\n');
  }
  const manifestFile = path.join(__dirname, '..', '_tmp', 'ts_softdel_manifest_' + jobId + '.json');
  try {
    fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
    fs.writeFileSync(manifestFile, JSON.stringify({ jobId, batchSize: BATCH, timeOnly: o.timeOnly,
      masterVersion: masterVersion, rows: manifestRows }, null, 2), 'utf8');
    process.stderr.write('[MANIFEST] 原请求清单已写入 ' + manifestFile + '\n');
  } catch (me) {
    process.stderr.write('[ABORT] 原请求清单落盘失败（无法做身份绑定，拒绝盲写）：' + (me && me.message) + '\n');
    process.exit(1);
  }

  const out = {
    meta: {
      generatedAtBJT: new Date(Date.now() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19),
      mode: o.apply ? 'APPLY' : 'DRY_RUN',
      logic: 'A/B 级冗余副本软标（O 列 = TRUE，不物理删）',
      cas: '服务端 tsSoftDelGuarded 锁内重读 UUID+负载+keeper+底稿映射+SHA-256指纹+期锁 校验后写并回读',
      action: 'softDelGuarded', jobId, batchId: jobId, version: CORE_VERSION
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
  const pfile = path.join(__dirname, '..', '_tmp', 'ts_softdel_payload.json');
  try { fs.mkdirSync(path.dirname(pfile), { recursive: true }); } catch (e) {}
  let done = 0;
  for (let s = 0; s < payload.rows.length; s += BATCH) {
    const batch = payload.rows.slice(s, s + BATCH);
    const subBatchId = jobId + '-' + (Math.floor(s / BATCH) + 1);
    fs.writeFileSync(pfile, JSON.stringify({ jobId, batchId: subBatchId, dry: '0',
      expectMasterVersion: masterVersion, rows: batch }), 'utf8');
    process.stderr.write('[APPLY] 批次 ' + (Math.floor(s / BATCH) + 1) + '：' + batch.length + ' 行 ...\n');
    try {
      const r = execFileSync('python', [TS_POST_BIN, 'softDelGuarded', pfile], { encoding: 'utf8', env: process.env });
      let j;
      try { j = unwrapEnvelope(JSON.parse(r)); }
      catch (pe) {
        process.stderr.write('[FAIL] 服务端响应非 JSON或契约不符（' + (pe.message || '坏 JSON') + '）：登记不明、不盲重试 —— ' + r.slice(0, 200) + '\n');
        process.exit(1);
      }
      // 条件 #4/#5：严格响应契约（逐字闭合 Tom 复审条件 #5：version 精确 / jobId / batchId===subBatchId / dry===false / ok===true / 计数一致）
      if (typeof j !== 'object' || !j) { process.stderr.write('[FAIL] 响应非对象（登记不明、不盲重试）\n'); process.exit(1); }
      if (j.version !== CORE_VERSION) {
        process.stderr.write('[FAIL] 响应 version 不符（须 ' + CORE_VERSION + '）：' + JSON.stringify(j).slice(0, 200) + ' —— 登记不明，不盲重试\n');
        process.exit(1);
      }
      if (j.jobId !== jobId) {
        process.stderr.write('[FAIL] jobId 不匹配（疑似非本服务/串批）：期望 ' + jobId + ' 实际 ' + j.jobId + ' —— 登记不明，不盲重试\n');
        process.exit(1);
      }
      // v6（Tom #1）：action 为【必需】字段 —— 缺失或回显不符即拒绝，不得「缺失就跳过」。
      //   防止「另一动作/另一服务的响应」被当作本次软标结果接受；大小写不敏感（分发器回显小写 softdelguarded）。
      if (j.action === undefined || j.action === null || String(j.action).toLowerCase() !== 'softdelguarded') {
        process.stderr.write('[FAIL] 响应 action 缺失或回显不符（须 softDelGuarded）：实际 ' + j.action + ' —— 登记不明，不盲重试\n');
        process.exit(1);
      }
      // v6（Tom #1）：masterVersion 为【必需】字段 —— 缺失/空/与声明不符即拒绝（不得「缺失就跳过」）。
      //   服务端侧前后绑定的证据；core 写响应恒带 masterVersion，dry 探测亦回显，故恒非空。
      if (j.masterVersion === undefined || j.masterVersion === null || String(j.masterVersion) === '' || String(j.masterVersion) !== String(masterVersion)) {
        process.stderr.write('[FAIL] 响应 masterVersion 缺失/空/与声明不符：声明 ' + masterVersion + ' 实际 ' + j.masterVersion + ' —— 登记不明，不盲重试\n');
        process.exit(1);
      }
      if (j.batchId == null) {  // 条件 #4/#5：缺 batchId 字段 → 拒绝（保持字面 batchId 便于契约断言）
        process.stderr.write('[FAIL] 响应缺 batchId 字段（契约不符，疑似非本服务响应）—— 登记不明，不盲重试\n');
        process.exit(1);
      }
      if (j.batchId !== subBatchId) {
        process.stderr.write('[FAIL] 批次ID不匹配（疑似串批）：期望 ' + subBatchId + ' 实际 ' + j.batchId + ' —— 登记不明，不盲重试\n');
        process.exit(1);
      }
      if (j.ok !== true) {  // 严格布尔
        const bad = (Array.isArray(j.results) ? j.results : []).filter(x => !(x && x.ok)).map(x => 'row' + (x && x.row) + ':' + (x && x.reason));
        process.stderr.write('[FAIL] 服务端返回 ok≠true：' + (j.error ? ('[' + j.error + '] ') : '') + bad.join('；') + ' —— 登记不明，不盲重试\n');
        process.exit(1);
      }
      // dry 响应：本应 apply，却回 dry≠false → 契约矛盾，未真实写入，不得计入 done
      if (j.dry !== false) {
        process.stderr.write('[FAIL] 响应 dry≠false（期望 false，实际 ' + j.dry + '）—— 服务端未真实写入，拒绝并登记不明，不盲重试\n');
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
      const wroteCount = results.filter(x => x.ok === true && x.wrote === true).length;
      for (const x of results) {
        if (x.ok !== true || x.wrote !== true) {
          process.stderr.write('[FAIL] 响应项非(ok&wrote 均为true)：row' + (x && x.row) + ' ok=' + x.ok + ' wrote=' + x.wrote + ' reason=' + x.reason + ' —— 登记不明，不盲重试\n');
          process.exit(1);
        }
      }
      // 计数一致性（Tom #5）：patched === 实际 wrote 项数；total === 请求行数
      // v5（Tom 第 6 项）：此前为 `typeof === 'number' &&`，缺失/字符串/浮点会被整段跳过；
      //   改为「必须是整数且精确相等」，缺失或任何非整数一律拒。
      if (!Number.isInteger(j.total) || j.total !== batch.length) {
        process.stderr.write('[FAIL] 响应 total 非整数或不等于请求行数（total=' + JSON.stringify(j.total) + ' 请求=' + batch.length + '）—— 计数不一致，登记不明，不盲重试\n');
        process.exit(1);
      }
      if (!Number.isInteger(j.patched) || j.patched !== wroteCount) {
        process.stderr.write('[FAIL] 响应 patched 非整数或不等于实际 wrote 项数（patched=' + JSON.stringify(j.patched) + ' 实际=' + wroteCount + '）—— 计数不一致，登记不明，不盲重试\n');
        process.exit(1);
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
// v5 B2（Tom 第 3 项）：真写前先做一次 **dry 探测**取得服务端主库版本指纹。
//   此前客户端从不发送 expectMasterVersion，服务端又是 truthy 回退 ⇒ 版本前后绑定形同虚设。
//   现在：探测 → 取得 masterVersion → 写入 manifest → 每批真写声明该版本 → 服务端比对。
//   探测本身是 dry，不产生任何写入；探测失败 → 返回 null → 调用方中止（fail-closed）。
function probeMasterVersion(rows, jobId) {
  const pf = path.join(__dirname, '..', '_tmp', 'ts_softdel_probe.json');
  const probe = { action: 'softDelGuarded', jobId, batchId: jobId + '-probe', dry: '1', rows: rows.slice(0, 1) };
  try { fs.mkdirSync(path.dirname(pf), { recursive: true }); } catch (e) {}
  fs.writeFileSync(pf, JSON.stringify(probe), 'utf8');
  try {
    const r = execFileSync('python', [TS_POST_BIN, 'softDelGuarded', pf], { encoding: 'utf8', env: process.env });
    const j = JSON.parse(r);
    if (j && j.masterVersion) return String(j.masterVersion);
    // 服务端的 fail-closed 原因（主库读不完整 / 缺期锁依赖等）必须可见，不能只静默返回 null
    process.stderr.write('[PROBE] 探测响应无 masterVersion（fail-closed）：' + String(r).slice(0, 400) + '\n');
    return null;
  } catch (e) {
    // 探测失败必须可诊断：把子进程的 stdout/stderr 一并打出，
    // 否则「主库读不完整 / 缺期锁依赖」等 fail-closed 原因会被吞成一句“探测失败”。
    const d = String((e.stdout || '') + (e.stderr || '') + (e.message || e));
    process.stderr.write('[PROBE] 主库版本探测失败（fail-closed，不盲写）：' + d.slice(0, 400) + '\n');
    return null;
  }
}

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
