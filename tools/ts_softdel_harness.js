// 忠实隔离 harness（Tom 点1/2/4/5 + Phase1/2）：真实 ts_softdel.js 执行器 + 真实 ts_post.py 运输层，
// 经 localhost 隔离端点，服务端用【真实】 ts_softdel_core.js 业务核心；mock 只替换存储/锁/网络依赖。
// 不加载任何生产地址/密钥；默认生产地址不会被触达。
//
// 关键修正：
//  - 执行器用 async spawn（非 execFileSync），避免阻塞本进程事件循环导致 mock 永不响应而假死。
//  - /gas 的 302 Location 用绝对 URL（与真实 GAS 一致），ts_post.py 才能正确 GET 回响应体。
//  - hkRead 按 A1 范围切列，使 rereadO('O6:O6') 只回 O 列（而非整行），忠实复刻 hktool 行为。
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---- 与核心完全一致的规范化 + hash（直接用真实核心的副本逻辑，仅用于模型/审计生成）----
const _sdNorm = v => {
  if (v === undefined || v === null) return '';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  var s = String(v).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return String(Number(s));
  return s;
};
function _sdNormHash(cells) {
  var s = '';
  for (var c = 2; c <= 13; c++) s += '\x1f' + _sdNorm(cells ? cells[c] : '');
  var h = 5381;
  for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return 'h' + h.toString(16);
}
const core = require(path.join(__dirname, 'ts_softdel_core.js'));
const { tsSoftDelGuardedCore } = core;

const TS_ID = '1Pi5u9fEawgp7yICWPMMyQCT_LbwTZthQDW-H05xYdVI';
const MASTER_ID = '1oxPj0mzN8poP2vQ7Bm-YKXuU49p9b0c1asyrZn4Py44';
const PROD_TAB = 'DB_工时流水';
const BASE_TAB = '工时_候选0824';
const PL_DB_SHEET = PROD_TAB;

// ---- 内存模型：生产表 920 行（触发 3 页分页），底稿 460 数据行 ----
function blank() { return new Array(15).fill(''); }
const prodRows = [];   // 1-indexed: prodRows[r] = cells (r 从 1 开始)
const masterRows = []; // 底稿（独立表）：row1=表头，row2.. 每个 uuid 恰 1 行（keeper 内容）
let masterRowByUuid = {};
function buildModel() {
  // 每个 UUID 两行：奇数=keeper（保留），偶数=冗余（待软标）；两行是 TOCTOU 双写出的【逐列完全相同副本】。
  let rid = 1;
  for (let g = 0; g < 460; g++) {
    const uuid = 'TS-TEST-' + String(g).padStart(4, '0');
    const bizDate = '2026-11-0' + ((g % 9) + 1); // 均在锁定期(2026-10-01)之后
    const hours = 8;
    const k = blank(); k[0]='2026-10-01 09:00'; k[1]=bizDate; k[2]='Name'+g; k[5]='PRJ'; k[6]=hours; k[8]=uuid; k[14]=false;
    prodRows[rid] = k;
    const t = k.slice();                 // 与 keeper 逐列完全相同（真实双写副本）
    prodRows[rid + 1] = t;
    rid += 2;
  }
  // 底稿：独立表。row1=表头（col2 有文字、无 uuid，避免被 readAll 过滤且不被计入）；
  // row2 起每个 uuid 恰 1 行（仅 keeper 入底稿，冗余副本不在底稿中），与真实"主库底稿权威"一致。
  masterRows[1] = blank(); masterRows[1][2] = 'NAME';  // 表头
  masterRowByUuid = {};
  let mrow = 2;
  for (let r = 1; r < prodRows.length; r++) {
    const c = prodRows[r];
    if (c && _sdNorm(c[8]) && (r % 2 === 1)) {   // 仅 keeper 行入底稿
      const m = blank(); m[1]=c[1]; m[2]=c[2]; m[5]=c[5]; m[6]=c[6]; m[8]=c[8];
      masterRows[mrow] = m; masterRowByUuid[c[8]] = mrow; mrow++;
    }
  }
  // 取 groups[0] 的冗余行（行2）先软标，作 ALREADY_SOFTDEL 样本
  if (prodRows[2]) prodRows[2][14] = 'TRUE';
}
buildModel();
const PROD_LAST = prodRows.length - 1;   // 最大行号（含 header 占位，row0 空）
const MASTER_LAST = masterRows.length - 1;

// ---- mock 配置（注入故障）----
const mockCfg = { failRanges: [], failMasterRanges: [], truncateLast: false, drift: false, dropWriteResponse: false, lockAll: false };

// ---- 内存 deps（与模型一致）----
const deps = {
  PL_DB_SHEET, PROD_TAB, BASE_TAB, MASTER_ID, TS_ID,
  readProdRow: (row) => (prodRows[row] ? prodRows[row].slice() : null),
  writeProdO: (row, v) => { if (!prodRows[row]) return false; prodRows[row][14] = v; return true; },
  readProdO: (row) => (prodRows[row] ? prodRows[row][14] : null),
  readMasterByUuid: (uuid) => Object.keys(masterRows).filter(r => _sdNorm(masterRows[r][8]) === uuid)
      .map(r => ({ row: +r, cells: masterRows[r].slice() })),
  acquireLock: () => ({ id: 'L' }), releaseLock: () => {},
  policy: () => ({ lockedBefore: mockCfg.lockAll ? '2099-01-01' : '2026-10-01' }),
  guardCheck: (bizDate) => {
    const lock = deps.policy().lockedBefore;
    if (bizDate && bizDate < lock) return { ok: false, reason: 'locked ' + bizDate };
    return { ok: true };
  },
  isClearance: () => false,
};

// ---- A1 范围解析 + 列字母→索引 ----
function colIdx(letters) { let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }
function parseRange(a1) {
  const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)/.exec(a1);
  if (m) return { sc: m[1], sr: +m[2], ec: m[3], er: +m[4] };
  const m2 = /([A-Z]+)(\d+)/.exec(a1);
  return { sc: m2[1], sr: +m2[2], ec: m2[1], er: +m2[2] };
}
// ---- HTTP mock：hktool 读通道 + GAS doPost（真实核心）----
function hkRead(ssId, sheet, a1) {
  const cr = parseRange(a1);
  const scIdx = colIdx(cr.sc), ecIdx = colIdx(cr.ec);
  const frList = (ssId === TS_ID) ? mockCfg.failRanges : mockCfg.failMasterRanges;
  for (const fr of frList) if (cr.sr >= fr[0] && cr.sr <= fr[1]) return {};   // 该页读取失败
  const store = (ssId === TS_ID) ? prodRows : masterRows;
  const last = (ssId === TS_ID) ? PROD_LAST : MASTER_LAST;
  if (cr.sr === 1 && cr.er === 2) { // probe：仅探测 lastRow
    const dr = mockCfg.drift ? last + 200 : last;
    return { lastRow: dr, values: [[], []] };
  }
  const vals = [];
  let got = 0;
  for (let r = cr.sr; r <= cr.er; r++) {
    if (store[r]) { vals.push(store[r].slice(scIdx, ecIdx + 1)); got++; }
  }
  // 末页截短：只返回一半
  if (mockCfg.truncateLast && cr.er >= last) {
    vals.length = Math.floor(vals.length / 2) || 1;
  }
  return { lastRow: last, values: vals };
}
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    const u = req.url;
    const abs = 'http://127.0.0.1:' + server.address().port;
    const close = () => res.setHeader('Connection', 'close');
    if (u && u.startsWith('/hk')) {
      let pl = {}; try { pl = JSON.parse(body); } catch (e) {}
      const r = hkRead(pl.args.ssId, pl.args.sheet, pl.args.a1);
      close();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: r }));
      return;
    }
    if (u && u === '/gas') {
      let pl = {}; try { pl = JSON.parse(body); } catch (e) {}
      // GAS 语义：POST 主体即 e.postBody；此处直接把解析后的主体作为 postBody 注入核心。
      const e2 = { parameter: pl.parameter || {}, postBody: pl || {} };
      const out = tsSoftDelGuardedCore(e2, deps);
      if (mockCfg.dropWriteResponse) {
        close();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('');   // 写后丢响应（模拟网络丢包）
        return;
      }
      server._gasResult = out;   // 存结果，GET /gas_result 取回（模拟 GAS 302→GET）
      close();
      res.writeHead(302, { 'Location': abs + u + '_result' });  // 绝对 URL（与真实 GAS 一致）
      res.end();
      return;
    }
    if (u && u.indexOf('_result') >= 0) {
      close();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(server._gasResult || JSON.stringify({ note: 'use POST first' }));
      return;
    }
    close();
    res.writeHead(404); res.end('nf');
  });
});

// ---- 生成审计 JSON（与模型一致，携带三级 hash）----
function genAudit() {
  const detail = { safe: [], notInBase: [], baseAlsoDup: [], orphanInBase: [] };
  const byUuid = {};
  for (let r = 1; r < prodRows.length; r++) {
    const c = prodRows[r]; if (!c) continue;
    const u = _sdNorm(c[8]); if (!u) continue;
    (byUuid[u] = byUuid[u] || []).push(r);
  }
  for (const u of Object.keys(byUuid)) {
    const rows = byUuid[u];
    const keeper = rows[0];
    const targets = [];
    for (let i = 1; i < rows.length; i++) {
      targets.push({ row: rows[i], keeperRow: keeper, targetHash: _sdNormHash(prodRows[rows[i]]),
        keeperHash: _sdNormHash(prodRows[keeper]), baseHash: _sdNormHash(masterRows[masterRowByUuid[u]]) });
    }
    const rec = { uuid: u, prodRows: rows.length, prodLive: rows.length, prodLiveHours: 8,
      baseRows: 1, baseRowNums: [keeper], prodRowNums: rows.slice(0, 5), targets, month: '2026-11' };
    detail.safe.push(rec);
  }
  const audit = { meta: { generatedAtBJT: '2026-10-27 99:99', readOnly: true }, detail };
  const f = path.join(os.tmpdir(), 'ts_audit_iso.json');
  fs.writeFileSync(f, JSON.stringify(audit));
  return f;
}

// ---- 运行真实执行器（async spawn，不阻塞事件循环）----
function runExecutor(extraArgs, envAdd) {
  return new Promise(resolve => {
    const auditF = genAudit();
    const port = server.address().port;
    // 隔离环境：剥离代理变量（WorkBuddy 服务代理会把 127.0.0.1 也转发导致 python urllib 假死），
    // 并显式 no_proxy 本地环回。生产 ts_post.py 走真实代理访问 GAS，本 harness 不需要。
    const cleanEnv = Object.assign({}, process.env);
    ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy','ALL_PROXY','all_proxy'].forEach(k => delete cleanEnv[k]);
    cleanEnv.NO_PROXY = '127.0.0.1,localhost';
    cleanEnv.no_proxy = '127.0.0.1,localhost';
    const env = Object.assign({}, cleanEnv, {
      TS_WEBAPP_OVERRIDE: 'http://127.0.0.1:' + port + '/hk',
      TS_AUDIT_OVERRIDE: auditF,
      TS_POST_BIN: path.join(__dirname, 'ts_post.py'),
      TS_WRITE_FREEZE: '0',
      TS_SELFCHECK: path.join(os.tmpdir(), 'ts_selfcheck_iso.json'),
    }, envAdd || {});
    fs.writeFileSync(env.TS_SELFCHECK, JSON.stringify({
      url: 'http://127.0.0.1:' + port + '/gas', token: 'dummy' }));
    const args = [path.join(__dirname, 'ts_softdel.js')].concat(extraArgs);
    const cp = spawn('node', args, { env });
    let out = '', err = '';
    cp.stdout.on('data', d => out += d);
    cp.stderr.on('data', d => err += d);
    cp.on('close', code => resolve({ stdout: out, stderr: err, code: code || 0 }));
    cp.on('error', e => resolve({ stdout: out, stderr: err + '\n[SPAWN-ERR] ' + e.message, code: 1 }));
  });
}

// ---- 场景断言 ----
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra).slice(0, 4000) : '')); }
}

server.listen(0, '127.0.0.1', async () => {
  console.log('mock listening on ' + server.address().port);

  console.log('=== 场景A：端到端 happy path（真实执行器+真实运输层+真实核心，dry-run 默认）===');
  mockCfg.failRanges = []; mockCfg.failMasterRanges = []; mockCfg.truncateLast = false; mockCfg.drift = false; mockCfg.dropWriteResponse = false; mockCfg.lockAll = false;
  let r = await runExecutor(['--audit-safe', '--emit', path.join(os.tmpdir(), 'ts_iso_payload.json')]);
  check('dry-run 退出 0', r.code === 0, { code: r.code, err: r.stderr.slice(-300) });
  check('CAS 通过行数>0（"通过"在 stderr）', /通过/.test(r.stderr), r.stderr.slice(-200));
  check('输出含 action=softDelGuarded', (r.stdout + r.stderr).includes('softDelGuarded'), r.stdout.slice(0, 120));
  let payload = null;
  try { payload = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'ts_iso_payload.json'), 'utf8')); } catch (e) {}
  check('载荷携带 batchId + 每行 expectHash/keeperHash/expectBaseHash', payload && payload.batchId && payload.rows[0] && payload.rows[0].expectHash && payload.rows[0].keeperHash && payload.rows[0].expectBaseHash, payload && payload.rows && payload.rows[0]);

  console.log('=== 场景B：端到端 APPLY（真实写，经真实运输层→真实核心→回读确认）===');
  r = await runExecutor(['--rows', '4', '--apply']);
  check('apply 退出 0', r.code === 0, { code: r.code, err: r.stderr.slice(0, 6000) });
  check('apply 后该行 O=TRUE（独立回读确认）', _sdNorm(prodRows[4][14]) === 'TRUE', prodRows[4][14]);

  console.log('=== 场景C：已软标行（ALREADY_SOFTDEL 诚实返回 ok:false，非 ok:true）===');
  r = await runExecutor(['--rows', '2', '--apply']);
  check('已软标行被拒（O 仍 TRUE，且报"已被软标"）', _sdNorm(prodRows[2][14]) === 'TRUE' && (/已被软标/.test(r.stdout + r.stderr)), { code: r.code, out: (r.stdout + r.stderr).slice(-200) });

  console.log('=== 场景D：分页完整性——生产表中间页失败→整批拒绝（Tom 点4）===');
  mockCfg.failRanges = [[401, 800]];
  r = await runExecutor(['--audit-safe']);
  mockCfg.failRanges = [];
  check('生产表中间页失败→执行器 ABORT 且退出 1', /ABORT/.test(r.stdout + r.stderr) && r.code === 1, { code: r.code, out: (r.stdout + r.stderr).slice(-200) });

  console.log('=== 场景E：分页完整性——末页截短→整批拒绝 ===');
  mockCfg.truncateLast = true;
  r = await runExecutor(['--audit-safe']);
  mockCfg.truncateLast = false;
  check('末页截短→执行器 ABORT 且退出 1', /ABORT/.test(r.stdout + r.stderr) && r.code === 1, { code: r.code, out: (r.stdout + r.stderr).slice(-200) });

  console.log('=== 场景F：分页完整性——lastRow 漂移→整批拒绝 ===');
  mockCfg.drift = true;
  r = await runExecutor(['--audit-safe']);
  mockCfg.drift = false;
  check('lastRow 漂移→执行器 ABORT 且退出 1', /ABORT/.test(r.stdout + r.stderr) && r.code === 1, { code: r.code, out: (r.stdout + r.stderr).slice(-200) });

  console.log('=== 场景G：底稿漏页→整批拒绝（readAll 通用完整性，独立注入 master 失败页）===');
  mockCfg.failMasterRanges = [[401, 800]];
  r = await runExecutor(['--audit-safe']);
  mockCfg.failMasterRanges = [];
  check('底稿中间页失败→执行器 ABORT 且退出 1', /ABORT/.test(r.stdout + r.stderr) && r.code === 1, { code: r.code, out: (r.stdout + r.stderr).slice(-200) });

  console.log('=== 场景H：期锁（真实核心，无 clearance→PERIOD_LOCKED）===');
  mockCfg.lockAll = true;
  r = await runExecutor(['--rows', '8', '--apply']);
  mockCfg.lockAll = false;
  check('期锁生效→服务端 ok=false（不写，报 PERIOD_LOCKED）', /PERIOD_LOCKED/.test(r.stdout + r.stderr) && r.code === 1, { code: r.code, out: (r.stdout + r.stderr).slice(0, 1800) });
  check('期锁拦截未写（O 仍非 TRUE）', _sdNorm(prodRows[8][14]) !== 'TRUE', prodRows[8][14]);

  console.log('=== 场景I：响应丢失（写后丢响应）→ 登记不明、不盲重试；--status 回读确认已写 ===');
  mockCfg.dropWriteResponse = true;
  r = await runExecutor(['--rows', '6', '--apply']);
  mockCfg.dropWriteResponse = false;
  check('响应丢失→执行器 FAIL/登记不明（不盲重试）', r.code === 1 && /FAIL|响应/.test(r.stdout + r.stderr), { code: r.code, out: (r.stdout + r.stderr).slice(-200) });
  check('响应丢失期间核心仍真实写入 O=TRUE（副作用已发生，非幻觉）', _sdNorm(prodRows[6][14]) === 'TRUE', prodRows[6][14]);
  const sr = await runExecutor(['--status', '6']);
  check('--status 回读确认行6 已写（WROTE_OR_ALREADY_APPLIED）', /WROTE_OR_ALREADY_APPLIED/.test(sr.stdout + sr.stderr), (sr.stdout + sr.stderr).slice(-300));

  console.log('\n=== 忠实 harness 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
  server.close();
  fs.writeFileSync(path.join(os.tmpdir(), 'ts_faithful_iso_result.txt'), pass + '/' + fail);
  process.exit(fail ? 1 : 0);
});
