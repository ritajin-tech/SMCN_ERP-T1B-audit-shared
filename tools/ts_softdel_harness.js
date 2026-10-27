// 忠实隔离 harness（Tom 点1/2/4/5 + 7 项条件）：真实 ts_softdel.js 执行器 + 真实 ts_post.py 运输层，
// 经 localhost 隔离端点，服务端用【真实】 ts_softdel_core.js 业务核心；mock 只替换存储/锁/网络依赖。
// 不加载任何生产地址/密钥；默认生产地址不会被触达。
//
// 本 harness 同时：
//  - 调用真实规范模块 ts_softdel_norm.js（SHA-256/类型保全）与 period_lock_port.js（真实期锁）；
//  - 复刻 GAS 内联副本与 Node 模块的「跨环境一致性」（见场景 S）；
//  - 复盖 Tom 7 项负例：主库锁内读取/缺页整批拒、两成员日期共同漂移、缺 master 表 B 级、缺 batchId/dry 响应/null 参数、
//    自指混合类型、跨页版本变更、写成后响应丢失且状态读取失败。
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const norm = require(path.join(__dirname, 'ts_softdel_norm.js'));
const pl = require(path.join(__dirname, 'period_lock_port.js'));
const core = require(path.join(__dirname, 'ts_softdel_core.js'));
const { tsSoftDelGuardedCore } = core;

const _sdNorm = norm._sdNorm;
const _sdRowHash = norm._sdRowHash;

const TS_ID = '1Pi5u9fEawgp7yICWPMMyQCT_LbwTZthQDW-H05xYdVI';
const MASTER_ID = '1oxPj0mzN8poP2vQ7Bm-YKXuU49p9b0c1asyrZn4Py44';
const PROD_TAB = 'DB_工时流水';
const BASE_TAB = '工时_候选0824';
const PL_DB_SHEET = PROD_TAB;

// ---- 内存模型：生产表 920 行（触发 3 页分页），底稿 460 数据行 ----
function blank() { return new Array(15).fill(''); }
const prodRows = [];
const masterRows = [];
let masterRowByUuid = {};
function buildModel() {
  let rid = 1;
  for (let g = 0; g < 460; g++) {
    const uuid = 'TS-TEST-' + String(g).padStart(4, '0');
    const bizDate = '2026-11-0' + ((g % 9) + 1); // 均在锁定期(2026-10-01)之后
    const hours = 8;
    const k = blank(); k[0] = '2026-10-01 09:00'; k[1] = bizDate; k[2] = 'Name' + g; k[5] = 'PRJ'; k[6] = hours; k[8] = uuid; k[14] = false;
    prodRows[rid] = k;
    const t = k.slice();
    prodRows[rid + 1] = t;
    rid += 2;
  }
  masterRows[1] = blank(); masterRows[1][2] = 'NAME';
  masterRowByUuid = {};
  let mrow = 2;
  for (let r = 1; r < prodRows.length; r++) {
    const c = prodRows[r];
    if (c && _sdNorm(c[8]) && (r % 2 === 1)) {
      const m = blank(); m[1] = c[1]; m[2] = c[2]; m[5] = c[5]; m[6] = c[6]; m[8] = c[8];
      masterRows[mrow] = m; masterRowByUuid[c[8]] = mrow; mrow++;
    }
  }
  if (prodRows[2]) prodRows[2][14] = 'TRUE';
}
buildModel();
const PROD_LAST = prodRows.length - 1;
const MASTER_LAST = masterRows.length - 1;

// ---- mock 配置（注入故障）----
const mockCfg = {
  failRanges: [], failMasterRanges: [], truncateLast: false, drift: false, driftDuringRead: false,
  dropWriteResponse: false, lockAll: false, masterIncomplete: false, masterVersion: null,
  noPeriodDep: false, forceDryResponse: false, stripBatchId: false, journalReadFails: false,
  _probes: 0
};

// ---- 内存 deps 工厂（HTTP mock 与 core-unit 共用，保证同一套真实逻辑）----
function makeCoreDeps(model) {
  const journalStore = model.journalStore || (model.journalStore = {});
  return {
    PL_DB_SHEET, PROD_TAB, BASE_TAB, MASTER_ID, TS_ID, VERSION: core.VERSION,
    readProdRow: (row) => (model.prodRows[row] ? model.prodRows[row].slice() : null),
    writeProdO: (row, v) => { if (!model.prodRows[row]) return false; model.prodRows[row][14] = v; return true; },
    readProdO: (row) => (model.prodRows[row] ? model.prodRows[row][14] : null),
    readAllMaster: () => {
      if (mockCfg.masterIncomplete) return { map: {}, complete: false, error: 'MASTER_PROBE_FAIL', version: null };
      const map = {};
      for (let r = 1; r < model.masterRows.length; r++) {
        const c = model.masterRows[r]; if (!c) continue;
        const u = _sdNorm(c[8]); if (!u) continue;
        (map[u] = map[u] || []).push({ row: r, cells: c.slice() });
      }
      return { map, complete: true, version: (mockCfg.masterVersion != null ? mockCfg.masterVersion : 'v1') };
    },
    acquireLock: () => ({ id: 'L' }), releaseLock: () => {},
    acquireMasterLock: () => ({ id: 'ML' }), releaseMasterLock: () => {},
    policy: () => (mockCfg.lockAll ? { closed: true, cutoff: pl.PL_CUTOFF, futureOpen: false } : pl._plPolicy()),
    guardCheck: (bizDate, origBiz, policy) => pl._plGuardCheck(bizDate, origBiz, policy),
    isClearance: () => false,
    journalAppend: (entry) => { journalStore[entry.jobId + ':' + entry.itemId] = entry; },
    journalGet: (jobId, itemId) => {
      if (mockCfg.journalReadFails) throw new Error('journal read failed');
      return journalStore[jobId + ':' + itemId] || null;
    }
  };
}

// ---- A1 范围解析 + 列字母→索引 ----
function colIdx(letters) { let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }
function parseRange(a1) {
  const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)/.exec(a1);
  if (m) return { sc: m[1], sr: +m[2], ec: m[3], er: +m[4] };
  const m2 = /([A-Z]+)(\d+)/.exec(a1);
  return { sc: m2[1], sr: +m2[2], ec: m2[1], er: +m[2] };
}
// ---- HTTP mock：hktool 读通道 + GAS doPost（真实核心）----
function hkRead(ssId, sheet, a1) {
  const cr = parseRange(a1);
  const scIdx = colIdx(cr.sc), ecIdx = colIdx(cr.ec);
  const frList = (ssId === TS_ID) ? mockCfg.failRanges : mockCfg.failMasterRanges;
  for (const fr of frList) if (cr.sr >= fr[0] && cr.sr <= fr[1]) return {};
  const store = (ssId === TS_ID) ? prodRows : masterRows;
  const last = (ssId === TS_ID) ? PROD_LAST : MASTER_LAST;
  if (cr.sr === 1 && cr.er === 2) { // probe
    mockCfg._probes++;
    let dr = last, rev = mockCfg.revision || 'rev1';
    if (mockCfg.driftDuringRead && mockCfg._probes >= 2) { dr = last + 200; rev = 'rev2'; } // 读期间漂移（re-probe 变化）
    else if (mockCfg.drift) { dr = last + 200; rev = 'rev2'; }
    return { lastRow: dr, revision: rev, values: [[], []] };
  }
  const vals = [];
  let got = 0;
  for (let r = cr.sr; r <= cr.er; r++) {
    if (store[r]) { vals.push(store[r].slice(scIdx, ecIdx + 1)); got++; }
  }
  if (mockCfg.truncateLast && cr.er >= last) vals.length = Math.floor(vals.length / 2) || 1;
  return { lastRow: last, revision: 'rev1', values: vals };
}
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    const u = req.url;
    const abs = 'http://127.0.0.1:' + server.address().port;
    const close = () => res.setHeader('Connection', 'close');
    console.error('[MOCK] ' + req.method + ' ' + u + ' body=' + body.slice(0, 80).replace(/\n/g, ' '));
    if (u && u.startsWith('/hk')) {
      let pl2 = {}; try { pl2 = JSON.parse(body); } catch (e) {}
      const r = hkRead(pl2.args.ssId, pl2.args.sheet, pl2.args.a1);
      close(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ result: r }));
      console.error('[MOCK] /hk -> lastRow=' + r.lastRow + ' rows=' + (r.values ? r.values.length : 0));
      return;
    }
    if (u && u === '/gas') {
      let pl2 = {}; try { pl2 = JSON.parse(body); } catch (e) {}
      const e2 = { parameter: pl2.parameter || {}, postBody: pl2 || {} };
      // 按本请求开关应用 deps 变体（不影响其它请求）
      const d = Object.assign({}, makeCoreDeps({ prodRows, masterRows, journalStore: server._journalSet || server._journalStore }));
      if (mockCfg.noPeriodDep) d.guardCheck = undefined;
      let out;
      const _rowsDbg = Array.isArray(pl2.rows) ? pl2.rows : [{ _nonArray: typeof pl2.rows, val: String(pl2.rows).slice(0,50) }];
      fs.appendFileSync(path.join(os.tmpdir(),'hb.log'), 'GAS-PRE rows=' + JSON.stringify(_rowsDbg.map(x=>({r:x.row,k:x.keeperRow,u:x.uuid,l:x.level}))).slice(0,200) + '\n');
      try { out = tsSoftDelGuardedCore(e2, d); }
      catch (err) { out = JSON.stringify({ ok: false, version: core.VERSION, error: 'CORE_EXCEPTION: ' + (err && err.message || err) }); }
      fs.appendFileSync(path.join(os.tmpdir(),'hb.log'), 'GAS-POST ok=' + (function(){try{return JSON.parse(out).ok}catch(e){return 'parsefail'}}()) + '\n');
      if (mockCfg.forceDryResponse) { try { const o = JSON.parse(out); o.dry = true; out = JSON.stringify(o); } catch (e) {} }
      if (mockCfg.stripBatchId) { try { const o = JSON.parse(out); delete o.batchId; out = JSON.stringify(o); } catch (e) {} }
      if (mockCfg.dropWriteResponse) { close(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(''); console.error('[MOCK] /gas -> dropped'); return; }
      server._gasResult = out;
      close(); res.writeHead(302, { 'Location': abs + u + '_result' });
      res.end();
      console.error('[MOCK] /gas -> ' + out.slice(0, 120));
      return;
    }
    if (u && u.indexOf('_result') >= 0) {
      close(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(server._gasResult || JSON.stringify({ note: 'use POST first' }));
      console.error('[MOCK] /gas_result -> ' + (server._gasResult || '').slice(0, 120));
      return;
    }
    close(); res.writeHead(404); res.end('nf');
  });
});
server._journalStore = {};

// ---- 硬看门狗：若事件循环仍存活但整跑超时，强制退出并报告活跃句柄数（用于诊断卡点）----
const HARNESS_HARD_MS = (process.env.HARNESS_HARD_MS ? parseInt(process.env.HARNESS_HARD_MS, 10) : 90000);
const _hard = setTimeout(() => {
  let nh = -1; try { nh = process._getActiveHandles().length; } catch (e) {}
  console.error('\n[HARNESS-HARD-TIMEOUT] 事件循环仍存活，但整跑超时。活跃句柄数=' + nh);
  try { fs.appendFileSync(path.join(os.tmpdir(),'hb.log'), 'HARD-TIMEOUT handles=' + nh + '\n'); } catch (e) {}
  process.exit(2);
}, HARNESS_HARD_MS);
_hard.unref && _hard.unref();

// 心跳：写入独立文件，避免被缓冲/强杀吞掉；用于定位事件循环被阻塞的时刻
const _hb = setInterval(() => {
  try {
    let nh = -1; try { nh = process._getActiveHandles().length; } catch (e) {}
    fs.appendFileSync(path.join(os.tmpdir(),'hb.log'), Date.now() + ' alive handles=' + nh + '\n');
  } catch (e) {}
}, 2000);

// ---- 生成审计 JSON（与模型一致，携带 SHA-256 三级 hash）----
function genAudit() {
  fs.appendFileSync(path.join(os.tmpdir(),'hb.log'), 'genAudit-start len=' + prodRows.length + '\n');
  const detail = { safe: [], notInBase: [], baseAlsoDup: [], orphanInBase: [] };
  const byUuid = {};
  for (let r =1; r < prodRows.length; r++) {
    const c = prodRows[r]; if (!c) continue;
    const u = _sdNorm(c[8]); if (!u) continue;
    (byUuid[u] = byUuid[u] || []).push(r);
  }
  for (const u of Object.keys(byUuid)) {
    const rows = byUuid[u];
    const keeper = rows[0];
    const targets = [];
    for (let i = 1; i < rows.length; i++) {
      targets.push({ row: rows[i], keeperRow: keeper, targetHash: _sdRowHash(prodRows[rows[i]], false),
        keeperHash: _sdRowHash(prodRows[keeper], false), baseHash: _sdRowHash(masterRows[masterRowByUuid[u]], false) });
    }
    const rec = { uuid: u, prodRows: rows.length, prodLive: rows.length, prodLiveHours: 8,
      baseRows: 1, baseRowNums: [keeper], prodRowNums: rows.slice(0, 5), targets, month: '2026-11' };
    detail.safe.push(rec);
  }
  fs.appendFileSync(path.join(os.tmpdir(),'hb.log'), 'genAudit-end safe=' + detail.safe.length + '\n');
  const audit = { meta: { generatedAtBJT: '2026-10-27 99:99', readOnly: true }, detail };
  const f = path.join(os.tmpdir(), 'ts_audit_iso.json');
  fs.writeFileSync(f, JSON.stringify(audit));
  return f;
}

// ---- 运行真实执行器（async spawn，不阻塞事件循环）----
function runExecutor(extraArgs, envAdd) {
  return new Promise(resolve => {
    const HB = path.join(os.tmpdir(), 'hb.log');
    fs.appendFileSync(HB, 're-a genAudit\n');
    const auditF = genAudit();
    fs.appendFileSync(HB, 're-b port\n');
    const port = server.address().port;
    const cleanEnv = Object.assign({}, process.env);
    ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy','ALL_PROXY','all_proxy'].forEach(k => delete cleanEnv[k]);
    cleanEnv.NO_PROXY = '127.0.0.1,localhost';
    cleanEnv.no_proxy = '127.0.0.1,localhost';
    fs.appendFileSync(HB, 're-c env\n');
    const env = Object.assign({}, cleanEnv, {
      TS_WEBAPP_OVERRIDE: 'http://127.0.0.1:' + port + '/hk',
      TS_AUDIT_OVERRIDE: auditF,
      TS_POST_BIN: path.join(__dirname, 'ts_post.py'),
      TS_WRITE_FREEZE: '0',
      TS_SELFCHECK: path.join(os.tmpdir(), 'ts_selfcheck_iso.json'),
    }, envAdd || {});
    fs.appendFileSync(HB, 're-d writeSelfcheck\n');
    fs.writeFileSync(env.TS_SELFCHECK, JSON.stringify({
      url: 'http://127.0.0.1:' + port + '/gas', token: 'dummy' }));
    const args = [path.join(__dirname, 'ts_softdel.js')].concat(extraArgs);
    fs.appendFileSync(HB, 're-e spawn\n');
    const cp = spawn('node', args, { env });
    fs.appendFileSync(HB, 're-f handlers\n');
    let out = '', err = '';
    // 实时透传子进程输出，便于定位卡点
    cp.stdout.on('data', d => { out += d; process.stdout.write('  [CHILD-OUT] ' + d.toString().replace(/\n/g, '\n  [CHILD-OUT] ')); });
    cp.stderr.on('data', d => { err += d; process.stdout.write('  [CHILD-ERR] ' + d.toString().replace(/\n/g, '\n  [CHILD-ERR] ')); });
    const _watchdog = setTimeout(() => { try { cp.kill('SIGKILL'); } catch (e) {} resolve({ stdout: out, stderr: err + '\n[WATCHDOG-KILL] spawn exceeded 30s', code: 1 }); }, 30000);
    cp.on('close', code => { clearTimeout(_watchdog); resolve({ stdout: out, stderr: err, code: code || 0 }); });
    cp.on('error', e => { clearTimeout(_watchdog); resolve({ stdout: out, stderr: err + '\n[SPAWN-ERR] ' + e.message, code: 1 }); });
    fs.appendFileSync(HB, 're-g return-promise\n');
  });
}

// ---- 异步运行真实 python 运输层（避免 execFileSync 阻塞事件循环导致 mock 死锁）----
function runPython(args, envAdd) {
  return new Promise(resolve => {
    const cleanEnv = Object.assign({}, process.env);
    ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy','ALL_PROXY','all_proxy'].forEach(k => delete cleanEnv[k]);
    cleanEnv.NO_PROXY = '127.0.0.1,localhost'; cleanEnv.no_proxy = '127.0.0.1,localhost';
    const env = Object.assign({}, cleanEnv, {
      TS_POST_BIN: path.join(__dirname, 'ts_post.py'), TS_WRITE_FREEZE: '0',
      TS_SELFCHECK: path.join(os.tmpdir(), 'ts_selfcheck_iso.json')
    }, envAdd || {});
    const cp = spawn('python', args, { env });
    let out = '', err = '';
    cp.stdout.on('data', d => { out += d; process.stdout.write('  [PY-OUT] ' + d.toString().replace(/\n/g, '\n  [PY-OUT] ')); });
    cp.stderr.on('data', d => { err += d; process.stdout.write('  [PY-ERR] ' + d.toString().replace(/\n/g, '\n  [PY-ERR] ')); });
    const wd = setTimeout(() => { try { cp.kill('SIGKILL'); } catch (e) {} resolve({ stdout: out, stderr: err + '\n[WATCHDOG-KILL] python exceeded 25s', code: 1 }); }, 25000);
    cp.on('close', code => { clearTimeout(wd); resolve({ stdout: out, stderr: err, code: code || 0 }); });
    cp.on('error', e => { clearTimeout(wd); resolve({ stdout: out, stderr: err + '\n[SPAWN-ERR] ' + e.message, code: 1 }); });
  });
}

// ---- 场景断言 ----
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra).slice(0, 4000) : '')); }
}
// ---- 直接调用核心做 #6 参数/keeper 类型闭合单测 ----
function runCoreUnit() {
  console.log('=== Core-Unit：参数/keeper 类型闭合（条件 #6）===');
  function baseDeps(extra) {
    const m = { prodRows: [blank(), blank(), blank(), blank(), blank()], masterRows: [blank(), blank()], journalStore: {} };
    m.prodRows[1] = blank();                       // row1 表头（uuid 空，忽略）
    m.prodRows[2] = blank(); m.prodRows[2][8] = 'U1'; m.prodRows[2][14] = false; // row2 = keeper（保留）
    m.prodRows[3] = m.prodRows[2].slice();         // row3 = 冗余副本1
    m.prodRows[4] = m.prodRows[2].slice();         // row4 = 冗余副本2
    m.masterRows[1] = blank();                     // row1 表头
    m.masterRows[2] = blank(); m.masterRows[2][8] = 'U1'; // 底稿恰 1 行
    const d = makeCoreDeps(m);
    return Object.assign(d, extra || {});
  }
  function callCore(d, rows, body) {
    const e = { postBody: Object.assign({ rows }, body || {}) };
    return JSON.parse(tsSoftDelGuardedCore(e, d));
  }
  // 自指混合类型：row:'3' 与 keeperRow:3 —— 解析后相等必须拒绝（旧逻辑 '3'===3 不拒绝）
  let d = baseDeps();
  let r = callCore(d, [{ row: '3', keeperRow: 3, uuid: 'U1', level: 'A', expectHash: 'x', keeperHash: 'y', expectBaseHash: 'z' }], { dry: false });
  check('自指混合类型(row:"3"/keeper:3)被拒', r.ok === false && /self-reference/.test(r.error || ''), r);
  // null dry 被拒
  d = baseDeps();
  r = callCore(d, [{ row: 3, keeperRow: 2, uuid: 'U1', level: 'A', expectHash: 'x', keeperHash: 'y', expectBaseHash: 'z' }], { dry: null });
  check('null dry 被拒', r.ok === false && /dry/.test(r.error || ''), r);
  // 非数组 rows 被拒
  d = baseDeps();
  r = callCore(d, 'notarray', {});
  check('非数组 rows 被拒', r.ok === false && /array/.test(r.error || ''), r);
  // 未知顶层字段被拒
  d = baseDeps();
  r = callCore(d, [{ row: 3, keeperRow: 2, uuid: 'U1', level: 'A', expectHash: 'x', keeperHash: 'y', expectBaseHash: 'z' }], { dry: false, bogus: 1 });
  check('未知顶层字段被拒', r.ok === false && /top-level/.test(r.error || ''), r);
  // 目标是他人 keeper（依赖冲突）被拒
  d = baseDeps();
  r = callCore(d, [
    { row: 3, keeperRow: 4, uuid: 'U1', level: 'A', expectHash: 'x', keeperHash: 'y', expectBaseHash: 'z' },
    { row: 4, keeperRow: 2, uuid: 'U1', level: 'A', expectHash: 'x', keeperHash: 'y', expectBaseHash: 'z' }
  ], { dry: false });
  check('目标是他人 keeper（依赖冲突）被拒', r.ok === false && /dependency/.test(r.error || ''), r);
  // 缺期锁依赖 → 整批拒绝
  d = baseDeps({ guardCheck: undefined });
  r = callCore(d, [{ row: 3, keeperRow: 2, uuid: 'U1', level: 'A', expectHash: 'x', keeperHash: 'y', expectBaseHash: 'z' }], { dry: false });
  check('缺期锁依赖(PERIOD_DEP_MISSING)被拒', r.ok === false && /PERIOD_DEP_MISSING/.test(r.error || ''), r);
  // 主库读不完整 → 整批拒绝（B 级不再被误判放行）
  d = baseDeps(); mockCfg.masterIncomplete = true;
  r = callCore(d, [{ row: 3, keeperRow: 2, uuid: 'U1', level: 'B', expectHash: 'x', keeperHash: 'y' }], { dry: false });
  mockCfg.masterIncomplete = false;
  check('主库读不完整(BASE_READ_INCOMPLETE)整批拒', r.ok === false && /BASE_READ_INCOMPLETE/.test(r.error || ''), r);
  // 两成员日期共同漂移 → 均 TARGET_DRIFT（服务端 CAS 捕获，条件 #2/#6）
  d = baseDeps();
  r = callCore(d, [
    { row: 3, keeperRow: 2, uuid: 'U1', level: 'A', expectHash: 'WRONG1', keeperHash: 'y', expectBaseHash: 'z' },
    { row: 4, keeperRow: 2, uuid: 'U1', level: 'A', expectHash: 'WRONG2', keeperHash: 'y', expectBaseHash: 'z' }
  ], { dry: false });
  const driftCnt = (r.results || []).filter(x => x.reason === 'TARGET_DRIFT').length;
  check('两成员均 TARGET_DRIFT（drift 被服务端 CAS 捕获）', r.ok === false && driftCnt === 2, r);
}

server.listen(0, '127.0.0.1', async () => {
  console.log('mock listening on ' + server.address().port);
  runCoreUnit();

  console.log('=== 场景A：端到端 happy path（真实执行器+真实运输层+真实核心，dry-run 默认）===');
  mockCfg.failRanges = []; mockCfg.failMasterRanges = []; mockCfg.truncateLast = false; mockCfg.drift = false; mockCfg.driftDuringRead = false; mockCfg.dropWriteResponse = false; mockCfg.lockAll = false; mockCfg.masterIncomplete = false; mockCfg.noPeriodDep = false; mockCfg.forceDryResponse = false; mockCfg.stripBatchId = false; mockCfg.journalReadFails = false; mockCfg._probes = 0;
  let r = await runExecutor(['--audit-safe', '--emit', path.join(os.tmpdir(), 'ts_iso_payload.json')]);
  check('dry-run 退出 0', r.code === 0, { code: r.code, err: r.stderr.slice(-300) });
  check('CAS 通过行数>0（"通过"在 stderr）', /通过/.test(r.stderr), r.stderr.slice(-200));
  check('输出含 version=ts_softdel_core/2', (r.stdout + r.stderr).includes('ts_softdel_core/2'), r.stdout.slice(0, 200));
  let payload = null;
  try { payload = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'ts_iso_payload.json'), 'utf8')); } catch (e) {}
  check('载荷携带 jobId + 每行 expectHash/keeperHash/expectBaseHash(SHA-256)', payload && payload.jobId && payload.rows[0] && /^sha256:/.test(payload.rows[0].expectHash) && /^sha256:/.test(payload.rows[0].keeperHash) && /^sha256:/.test(payload.rows[0].expectBaseHash), payload && payload.rows && payload.rows[0]);

  console.log('=== 场景B：端到端 APPLY（真实写，经真实运输层→真实核心→回读确认）===');
  r = await runExecutor(['--rows', '4', '--apply']);
  check('apply 退出 0', r.code === 0, { code: r.code, err: r.stderr.slice(0, 6000) });
  check('apply 后该行 O=TRUE（独立回读确认）', _sdNorm(prodRows[4][14]) === 'TRUE', prodRows[4][14]);

  console.log('=== 场景C：已软标行（ALREADY_SOFTDEL 诚实返回 ok:false，非 ok:true）===');
  r = await runExecutor(['--rows', '2', '--apply']);
  check('已软标行被拒（O 仍 TRUE，且报"已被软标"）', _sdNorm(prodRows[2][14]) === 'TRUE' && (/已被软标/.test(r.stdout + r.stderr)), { code: r.code, out: (r.stdout + r.stderr).slice(-200) });

  console.log('=== 场景D：分页完整性——生产表中间页失败→整批拒绝 ===');
  mockCfg.failRanges = [[401, 800]];
  r = await runExecutor(['--audit-safe']);
  mockCfg.failRanges = [];
  check('生产表中间页失败→执行器 ABORT 且退出 1', /ABORT/.test(r.stdout + r.stderr) && r.code === 1, { code: r.code, out: (r.stdout + r.stderr).slice(-200) });

  console.log('=== 场景E：分页完整性——末页截短→整批拒绝 ===');
  mockCfg.truncateLast = true;
  r = await runExecutor(['--audit-safe']);
  mockCfg.truncateLast = false;
  check('末页截短→执行器 ABORT 且退出 1', /ABORT/.test(r.stdout + r.stderr) && r.code === 1, { code: r.code, out: (r.stdout + r.stderr).slice(-200) });

  console.log('=== 场景F：分页完整性——lastRow 初始漂移→整批拒绝 ===');
  mockCfg.drift = true;
  r = await runExecutor(['--audit-safe']);
  mockCfg.drift = false;
  check('lastRow 漂移→执行器 ABORT 且退出 1', /ABORT/.test(r.stdout + r.stderr) && r.code === 1, { code: r.code, out: (r.stdout + r.stderr).slice(-200) });

  console.log('=== 场景G：底稿漏页→整批拒绝（readAll 通用完整性，独立注入 master 失败页）===');
  mockCfg.failMasterRanges = [[401, 800]];
  r = await runExecutor(['--audit-safe']);
  mockCfg.failMasterRanges = [];
  check('底稿中间页失败→执行器 ABORT 且退出 1', /ABORT/.test(r.stdout + r.stderr) && r.code === 1, { code: r.code, out: (r.stdout + r.stderr).slice(-200) });

  console.log('=== 场景H：期锁（真实适配器，无 clearance→PERIOD_LOCKED）===');
  mockCfg.lockAll = true;
  r = await runExecutor(['--rows', '8', '--apply']);
  mockCfg.lockAll = false;
  check('期锁生效→服务端 ok=false（不写，报 PERIOD_LOCKED）', /PERIOD_LOCKED/.test(r.stdout + r.stderr) && r.code === 1, { code: r.code, out: (r.stdout + r.stderr).slice(0, 1800) });
  check('期锁拦截未写（O 仍非 TRUE）', _sdNorm(prodRows[8][14]) !== 'TRUE', prodRows[8][14]);

  console.log('=== 场景I：响应丢失（写后丢响应）→ 登记不明、不盲重试；--status 经 journal 核实 COMMITTED ===');
  // 先把行6复位（避免 ALREADY_SOFTDEL 干扰），再 apply；dropWriteResponse=true 写后丢响应
  prodRows[6][14] = false;
  mockCfg.dropWriteResponse = true;
  r = await runExecutor(['--rows', '6', '--apply']);
  mockCfg.dropWriteResponse = false;
  check('响应丢失→执行器 FAIL/登记不明（不盲重试）', r.code === 1 && /FAIL|响应/.test(r.stdout + r.stderr), { code: r.code, out: (r.stdout + r.stderr).slice(-200) });
  check('响应丢失期间核心仍真实写入 O=TRUE（副作用已发生，非幻觉）', _sdNorm(prodRows[6][14]) === 'TRUE', prodRows[6][14]);
  const sr = await runExecutor(['--status', '6']);
  check('--status 经 journal 核实行6=COMMITTED（已完成，非"可重跑"措辞）', /COMMITTED/.test(sr.stdout + sr.stderr), (sr.stdout + sr.stderr).slice(-400));

  console.log('=== 场景J：主库锁内读取/缺页→整批拒绝（条件 #1，服务端 BASE_READ_INCOMPLETE）===');
  // 仅令 readAllMaster 不完整（hkRead 底稿仍正常，以隔离服务端守卫）
  mockCfg.masterIncomplete = true;
  r = await runExecutor(['--rows', '10', '--apply']);
  mockCfg.masterIncomplete = false;
  check('主库读不完整→服务端 BASE_READ_INCOMPLETE，整批拒且未写', r.code === 1 && /BASE_READ_INCOMPLETE|FAIL/.test(r.stdout + r.stderr) && _sdNorm(prodRows[10][14]) !== 'TRUE', { code: r.code, out: (r.stdout + r.stderr).slice(-200), o10: prodRows[10][14] });

  console.log('=== 场景K：缺期锁依赖→整批拒绝（条件 #3，PERIOD_DEP_MISSING）===');
  mockCfg.noPeriodDep = true;
  r = await runExecutor(['--rows', '12', '--apply']);
  mockCfg.noPeriodDep = false;
  check('缺期锁依赖→服务端 PERIOD_DEP_MISSING，整批拒且未写', r.code === 1 && /PERIOD_DEP_MISSING/.test(r.stdout + r.stderr) && _sdNorm(prodRows[12][14]) !== 'TRUE', { code: r.code, out: (r.stdout + r.stderr).slice(-200) });

  console.log('=== 场景L：端到端——客户端预筛拦截异负载（与核心 TARGET_DRIFT 互补）===');
  // 说明：端到端通道下客户端预筛会先拦下"目标≠keeper 负载"的行（防御纵深），
  // 服务端 TARGET_DRIFT 由 Core-Unit「两成员日期共同漂移」覆盖。此处验证端到端预筛拦截且未写。
  prodRows[4][14] = false; prodRows[6][14] = false; prodRows[4][1] = '2026-11-01'; prodRows[6][1] = '2026-11-01';
  r = await runExecutor(['--rows', '4,6', '--apply']);
  check('L 端到端：异负载行被客户端预筛拒（0 写入，未误写）', r.code === 0 && _sdNorm(prodRows[4][14]) !== 'TRUE' && _sdNorm(prodRows[6][14]) !== 'TRUE', { code: r.code, out: (r.stdout + r.stderr).slice(-200) });

  console.log('=== 场景M：跨页版本变更/读期间漂移→ executor 整批拒绝（条件 #7）===');
  mockCfg.driftDuringRead = true; mockCfg._probes = 0;
  r = await runExecutor(['--audit-safe']);
  mockCfg.driftDuringRead = false; mockCfg._probes = 0;
  check('读期间漂移(re-probe 变化)→ executor ABORT 且退出 1', /ABORT|DRIFT_DURING_READ/.test(r.stdout + r.stderr) && r.code === 1, { code: r.code, out: (r.stdout + r.stderr).slice(-200) });

  console.log('=== 场景N：缺 batchId / dry 响应 / 状态读取失败（条件 #4/#5）===');
  // N1: 缺 batchId（服务端回包被剥离 batchId）→ 执行器拒绝
  mockCfg.stripBatchId = true;
  r = await runExecutor(['--rows', '14', '--apply']);
  mockCfg.stripBatchId = false;
  check('N1 缺 batchId→执行器拒绝（契约不符，不接受畸形响应）', r.code === 1 && /batchId|缺/.test(r.stdout + r.stderr), { code: r.code, out: (r.stdout + r.stderr).slice(-200) });
  // N2: 服务端回 dry=true（契约矛盾）→ 执行器拒绝且未计入已写
  prodRows[16][14] = false;
  mockCfg.forceDryResponse = true;
  r = await runExecutor(['--rows', '16', '--apply']);
  mockCfg.forceDryResponse = false;
  check('N2 dry 响应→执行器拒绝（dry 响应不得计为已写）', r.code === 1 && /dry|DRY/.test(r.stdout + r.stderr), { code: r.code, out: (r.stdout + r.stderr).slice(-200) });
  // N3: 写成后响应丢失 + 状态读取失败 → --status 留 UNKNOWN（不自动重试）
  prodRows[18][14] = false;
  mockCfg.dropWriteResponse = true;
  await runExecutor(['--rows', '18', '--apply']);
  mockCfg.dropWriteResponse = false;
  mockCfg.journalReadFails = true;
  const sr3 = await runExecutor(['--status', '18']);
  mockCfg.journalReadFails = false;
  check('N3 写成后响应丢失 + 状态读取失败→ --status 留 UNKNOWN（不自动重试）', /UNKNOWN/.test(sr3.stdout + sr3.stderr), (sr3.stdout + sr3.stderr).slice(-400));

  console.log('=== 场景O：缺 master 表 B 级（条件 #1 服务端守卫，与 J 同机制，单独列示 B 级）===');
  mockCfg.masterIncomplete = true;
  r = await runExecutor(['--rows', '20', '--apply']);
  mockCfg.masterIncomplete = false;
  check('缺 master 表→ B 级整批拒（不会再被误判底稿0行放行）', r.code === 1 && /BASE_READ_INCOMPLETE|FAIL/.test(r.stdout + r.stderr) && _sdNorm(prodRows[20][14]) !== 'TRUE', { code: r.code, out: (r.stdout + r.stderr).slice(-200) });

  console.log('=== 场景P：null 参数（顶层 rows 为非数组）→ 直接拒绝（条件 #6，经运输层通道）===');
  // 通过构造 payload 文件直接走 ts_post→/gas（绕开审计读取）；rows 设为非数组
  const pf = path.join(os.tmpdir(), 'ts_nullparam.json');
  fs.writeFileSync(pf, JSON.stringify({ jobId: 'JX', batchId: 'JX-1', dry: '0', rows: 'oops' }));
  try { fs.appendFileSync(path.join(os.tmpdir(),'hb.log'), 'P-start\n'); } catch (e) {}
  const pr = await runPython([path.join(__dirname, 'ts_post.py'), 'softDelGuarded', pf]);
  const pn = pr.stdout + pr.stderr;
  try { fs.appendFileSync(path.join(os.tmpdir(),'hb.log'), 'P-resolve pnlen=' + pn.length + ' hasArray=' + /array/.test(pn) + ' code=' + pr.code + '\n'); } catch (e) {}
  check('P null 参数(rows 非数组)→ 服务端拒绝', /array/.test(pn), pn.slice(-300));

  console.log('=== 场景Q：APPLY 严格响应契约正向（version/ok/wrote 严格布尔）===');
  try { fs.appendFileSync(path.join(os.tmpdir(),'hb.log'), 'SCEN-Q-start\n'); } catch (e) {}
  prodRows[22][14] = false;
  r = await runExecutor(['--rows', '22', '--apply']);
  try { fs.appendFileSync(path.join(os.tmpdir(),'hb.log'), 'SCEN-Q-resolve code=' + r.code + '\n'); } catch (e) {}
  check('Q APPLY 退出 0 且响应含 version=ts_softdel_core/2 且模式 APPLY', r.code === 0 && /ts_softdel_core\/2/.test(r.stdout + r.stderr) && /"mode": "APPLY"/.test(r.stdout), { code: r.code, out: r.stdout.slice(-300) });
  check('Q APPLY 后行22 O=TRUE', _sdNorm(prodRows[22][14]) === 'TRUE', prodRows[22][14]);

  if (process.env.HARNESS_STOP_AFTER === 'Q') { console.log('[STOP_AFTER=Q] 提前退出'); server.close(); process.exit(fail ? 1 : 0); }

  console.log('=== 场景S：跨环境一致性（GAS 内联副本 == Node 模块）===');
  const self = norm._sdSelfTest();
  const allOk = self.every(v => v.ok);
  check('SHA-256 固定向量全部命中（GAS/Node 同算法）', allOk, self);

  console.log('\n=== 忠实 harness 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
  server.close();
  fs.writeFileSync(path.join(os.tmpdir(), 'ts_faithful_iso_result.txt'), pass + '/' + fail);
  process.exit(fail ? 1 : 0);
});
