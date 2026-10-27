// 隔离 GAS 适配器 harness（回应 Tom 2026-10-27 复审条件 #2）
//
// 目的：用【隔离的 GAS 适配器】加载 gen_gas_softdel.py 生成的【真实交付文件】
//      （tools/v4_patches/full/ts_softdel_gas_embedded.js），在 Node 的 vm 沙箱里以 GAS shim 运行；
//      同时用 Node 原生 ts_softdel_core.js（同一份业务逻辑）对【同一份内存表】跑相同输入，
//      逐项比对 Date/字符串/前导零/布尔/审计指纹/期锁结果/响应，给出行为等价证据。
//
// 关键：GAS 端 Utilities.computeDigest 用 Node crypto 实现【真实的 SHA-256】（与 GAS 原生一致），
//      因此审计指纹跨环境逐字节一致；一旦 GAS 副本与 Node 漂移，CAS 哈希不匹配会让两边决策分裂 → 测试失败。
//
// 用法：node tools/ts_softdel_gas_harness.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const HERE = __dirname;
const GAS_FILE = path.join(HERE, 'v4_patches', 'full', 'ts_softdel_gas_embedded.js');
const CORE = require('./ts_softdel_core.js');
const NORM = require('./ts_softdel_norm.js');
const PL = require('./period_lock_port.js');

const TS_ID = '1Pi5u9fEawgp7yICWPMMyQCT_LbwTZthQDW-H05xYdVI';
const MASTER_ID = '1oxPj0mzN8poP2vQ7Bm-YKXuU49p9b0c1asyrZn4Py44';
const PROD_TAB = 'DB_工时流水';
const BASE_TAB = '工时_候选0824';

// 固定 jobId：GAS 与 Node 两侧注入同一个值，使 jobId 逐字一致（核心默认会随机生成，
// 否则两侧 jobId 不同会让等价比对伪失败）。核心读取 body.jobId || p.jobId || batchId || 随机。
const TEST_JOB = 'JTEST-EQUIV-FIXED';

const HEADER = ['A录入时间', 'B日期', 'C姓名', 'D类型', 'E阶段', 'F项目编号', 'G工时', 'H备注',
  'I UUID', 'J项目名', 'K', 'L', 'M', 'N', 'O软删', 'P', 'Q'];

// ---------- 内存表世界（GAS 与 Node 各持一份，种子相同，互不污染）----------
function makeStore() {
  return {
    sheets: {},            // name -> { grid: [][], lastRow }
    lockBusy: false,
    lockHeld: false,
    observations: []
  };
}
function makeSheet(store, name) {
  const grid = [HEADER.slice()];
  const cell = (r, c) => (grid[r - 1] ? grid[r - 1][c - 1] : undefined);
  const setCell = (r, c, v) => {
    while (grid.length < r) grid.push(new Array(HEADER.length).fill(''));
    while (grid[r - 1].length < c) grid[r - 1].push('');
    grid[r - 1][c - 1] = v;
  };
  function range(r, c, nR, nC) {
    return {
      getValues() {
        const out = [];
        for (let i = 0; i < nR; i++) {
          const row = [];
          for (let j = 0; j < nC; j++) row.push(cell(r + i, c + j) === undefined ? '' : cell(r + i, c + j));
          out.push(row);
        }
        return out;
      },
      getDisplayValues() { return this.getValues(); },
      setValues(vals) {
        store.observations.push({ op: 'write', row: r, col: c, nRows: nR });
        for (let i = 0; i < (vals || []).length; i++)
          for (let j = 0; j < (vals[i] || []).length; j++) setCell(r + i, c + j, vals[i][j]);
      },
      setValue(v) { store.observations.push({ op: 'write', row: r, col: c }); setCell(r, c, v); },
      getValue() { return cell(r, c) === undefined ? '' : cell(r, c); },
      clearContent() {}
    };
  }
  const sheet = {
    getName: () => name,
    getLastRow: () => grid.length,
    getLastColumn: () => Math.max.apply(null, grid.map(r => r.length)),
    getDataRange: () => range(1, 1, grid.length, Math.max.apply(null, grid.map(r => r.length))),
    appendRow: (row) => { grid.push(row.slice()); },
    getRange: (r, c, nR, nC) => range(r, c, nR || 1, nC || 1),
    insertRowsAfter() {},
    deleteRows() {},
    _grid: grid
  };
  store.sheets[name] = sheet;
  return sheet;
}

// ---------- GAS shim（忠实复刻 GAS 原生 API 行为，含真实 SHA-256）----------
function gasShim(store) {
  const mkSs = (id) => ({
    getId: () => id,
    getName: () => (id === TS_ID ? 'ProdSS' : 'MasterSS'),
    getSheetByName: (n) => store.sheets[n] || null,        // 与 makeSheet 共用同一 registry
    insertSheet: (n) => makeSheet(store, n),               // makeSheet 会把新表写入 store.sheets
    getSheets: () => Object.keys(store.sheets).map(n => store.sheets[n])
  });
  const prodSs = mkSs(TS_ID);
  const masterSs = mkSs(MASTER_ID);
  return {
    console, JSON, Date, Math, String, Number, Boolean, Array, Object, RegExp,
    isNaN, parseInt, parseFloat, Error, TypeError,
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      computeDigest(alg, s) {
        const h = crypto.createHash('sha256').update(s, 'utf8').digest();
        const arr = [];
        for (let i = 0; i < h.length; i++) { const b = h[i]; arr.push(b < 128 ? b : b - 256); }
        return arr;
      },
      formatDate(d, tz, fmt) {
        // 仅实现 GAS 用到的两种格式
        const dt = (d instanceof Date) ? d : new Date(d);
        const t = dt.getTime() + 8 * 3600 * 1000;
        const u = new Date(t);
        const p = (n) => (n < 10 ? '0' + n : '' + n);
        const s = u.getUTCFullYear() + '-' + p(u.getUTCMonth() + 1) + '-' + p(u.getUTCDate());
        if (fmt === 'yyyy-MM-dd') return s;
        return s + ' ' + p(u.getUTCHours()) + ':' + p(u.getUTCMinutes()) + ':' + p(u.getUTCSeconds());
      },
      getUuid: () => 'mock-uuid'
    },
    LockService: {
      getScriptLock: () => ({
        tryLock(ms) {
          if (store.lockBusy) return false;
          store.lockHeld = true;
          store.observations.push({ op: 'lock_acquired' });
          return true;
        },
        releaseLock() { store.lockHeld = false; store.observations.push({ op: 'lock_released' }); },
        hasLock: () => store.lockHeld
      })
    },
    SpreadsheetApp: {
      openById: (id) => (id === MASTER_ID ? masterSs : prodSs),
      flush: () => store.observations.push({ op: 'flush' }),
      getActiveSpreadsheet: () => prodSs,
      newDataValidation: () => ({}),
      DataValidationCriteria: {}
    },
    PropertiesService: { getDocumentProperties: () => stubProps(), getScriptProperties: () => stubProps(), getUserProperties: () => stubProps() },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {} }) },
    Logger: { log: () => {} },
    MailApp: { sendEmail: () => {} },
    ScriptApp: { getScriptId: () => 'mock', newTrigger: () => ({}) }
  };
}
function stubProps() {
  const m = {};
  return { getProperty: k => (k in m ? m[k] : null), setProperty: (k, v) => { m[k] = String(v); }, deleteProperty: k => { delete m[k]; }, getProperties: () => m };
}

// ---------- Node 端 deps（读同一份内存表，逻辑与 GAS 包装器镜像）----------
function nodeDeps(store) {
  const prod = store.sheets[PROD_TAB];
  const master = store.sheets[BASE_TAB] || makeSheet(store, BASE_TAB);
  const getRow = (sheet, row) => (sheet && sheet._grid[row - 1]) || null;
  const lock = { held: false };
  return {
    PL_DB_SHEET: PROD_TAB,
    isClearance: () => false,
    guardCheck: (bizDate, origBiz, policy) => PL._plGuardCheck(bizDate, origBiz, policy || PL._plPolicy()),
    policy: () => PL._plPolicy(),
    acquireMasterLock() { if (store.lockBusy) throw new Error('LOCK_BUSY'); lock.held = true; return lock; },
    acquireLock() { if (store.lockBusy) throw new Error('LOCK_BUSY'); lock.held = true; return lock; },
    releaseLock(l) { lock.held = false; },
    releaseMasterLock(l) { lock.held = false; },
    readProdRow(row) { const g = getRow(prod, row); return g ? g.slice() : null; },
    readProdO(row) { const g = getRow(prod, row); return g ? g[14] : null; },
    writeProdO(row, val) { if (!prod) return false; const g = prod._grid[row - 1]; if (!g) return false; g[14] = val; return true; },
    readAllMaster() {
      const g = master._grid;
      const map = {};
      const vals = [];
      for (let r = 1; r < g.length; r++) {
        vals.push(g[r].slice());
        const u = NORM._sdNorm(g[r][8]);
        if (u) (map[u] = map[u] || []).push({ row: r + 1, cells: g[r].slice() });
      }
      const fp = NORM._sdSha256(JSON.stringify(vals.map(row => NORM._sdCanonRow(row, [1, 2, 3, 4, 5, 6, 7, 8, 9]))));
      return { map, complete: true, version: fp };
    },
    journalAppend(rec) { const js = store.sheets['_TS_SOFTDEL_LOG'] || makeSheet(store, '_TS_SOFTDEL_LOG'); js._grid.push([String(rec.ts), rec.jobId, rec.subBatchId, rec.itemId, rec.requestHash, rec.state]); },
    journalGet(jobId, itemId) {
      const js = store.sheets['_TS_SOFTDEL_LOG'];
      if (!js) return null;
      for (let i = js._grid.length - 1; i >= 1; i--) {
        const g = js._grid[i];
        if (String(g[3] || '') === String(itemId) && String(g[1] || '') === String(jobId))
          return { jobId: g[1], subBatchId: g[2], itemId: g[3], requestHash: g[4], state: g[5] };
      }
      return null;
    }
  };
}

// ---------- 加载 GAS 生成物 ----------
function loadGas() {
  const src = fs.readFileSync(GAS_FILE, 'utf8');
  const store = makeStore();
  const sandbox = gasShim(store);
  vm.createContext(sandbox);
  try { vm.runInContext(src, sandbox, { timeout: 20000 }); }
  catch (e) { return { store: null, sandbox: null, error: String(e && e.message || e) }; }
  return { store, sandbox };
}

// ---------- 候选构造 ----------
const _mkRow = (date, uuid, hours, entry, name) => {
  const r = new Array(15).fill('');
  r[0] = entry != null ? entry : new Date(Date.UTC(2026, 9, 8, 1, 0, 0)); // Date 类型录入时间（测试 Date 路径）
  r[1] = date;            // 业务日期（可为 Date 或字符串）
  r[2] = name || 'Tester';
  r[3] = '工时';
  r[4] = '阶段';
  r[5] = '26-084-HK';
  r[6] = String(hours === undefined ? 2 : hours);
  r[7] = '报价';
  r[8] = uuid;
  return r;
};

// 计算候选 CAS 哈希（用真实 norm 函数，GAS/Node 共用）
function hashesFor(cells, timeOnly) {
  return NORM._sdRowHash(cells, !!timeOnly);
}

// ---------- 用例 ----------
const RESULTS = [];
function check(id, title, fn) {
  let r;
  try { r = fn(); } catch (e) { r = { pass: false, detail: 'EXCEPTION: ' + (e && e.message || e) }; }
  RESULTS.push(Object.assign({ id, title }, r));
  console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${id}  ${title}\n       ${r.detail}`);
}

// 等价比对：GAS vs Node 的响应 + O 列副作用 必须一致
function compareRun(gasJson, nodeJson, storeG, storeN, rowOfInterest) {
  const g = JSON.parse(gasJson), n = JSON.parse(nodeJson);
  const issues = [];
  if (g.ok !== n.ok) issues.push(`ok: GAS=${g.ok} Node=${n.ok}`);
  if (g.version !== n.version) issues.push(`version: GAS=${g.version} Node=${n.version}`);
  if ((g.batchId || null) !== (n.batchId || null)) issues.push(`batchId: GAS=${g.batchId} Node=${n.batchId}`);
  if ((g.jobId || null) !== (n.jobId || null)) issues.push(`jobId: GAS=${g.jobId} Node=${n.jobId}`);
  if ((g.dry !== undefined) && (g.dry !== n.dry)) issues.push(`dry: GAS=${g.dry} Node=${n.dry}`);
  if ((g.patched !== undefined) && (g.patched !== n.patched)) issues.push(`patched: GAS=${g.patched} Node=${n.patched}`);
  if ((g.total !== undefined) && (g.total !== n.total)) issues.push(`total: GAS=${g.total} Node=${n.total}`);
  const gr = (g.results || []), nr = (n.results || []);
  if (gr.length !== nr.length) issues.push(`results.length: GAS=${gr.length} Node=${nr.length}`);
  const ge = {}, ne = {};
  gr.forEach(x => ge[x.row] = x); nr.forEach(x => ne[x.row] = x);
  Object.keys(Object.assign({}, ge, ne)).forEach(row => {
    const a = ge[row] || {}, b = ne[row] || {};
    ['ok', 'wrote', 'reason', 'level'].forEach(k => {
      if ((a[k] || null) !== (b[k] || null)) issues.push(`row${row}.${k}: GAS=${JSON.stringify(a[k])} Node=${JSON.stringify(b[k])}`);
    });
  });
  // O 列副作用必须一致
  [rowOfInterest].filter(Boolean).forEach(row => {
    const oG = (storeG.sheets[PROD_TAB]._grid[row - 1] || [])[14];
    const oN = (storeN.sheets[PROD_TAB]._grid[row - 1] || [])[14];
    if (String(oG || '') !== String(oN || '')) issues.push(`O[${row}]: GAS=${JSON.stringify(oG)} Node=${JSON.stringify(oN)}`);
  });
  return { pass: issues.length === 0, detail: issues.length ? issues.join('； ') : `一致（ok=${g.ok} patched=${g.patched} results=${gr.length}）` };
}

function seedPair(store, row, keeperRow, opts) {
  opts = opts || {};
  const date = opts.date || new Date(Date.UTC(2026, 9, 8));      // 2026-10-08（>= cut-off，允许）
  const entry = opts.entry || new Date(Date.UTC(2026, 9, 8, 1, 0, 0));
  const name = opts.name || 'Tester';
  const target = _mkRow(date, opts.uuid || 'TS-GAS-1', opts.hours, entry, name);
  const keeper = _mkRow(date, opts.uuid || 'TS-GAS-1', opts.hours, entry, name);
  if (opts.targetOverrides) Object.assign(target, opts.targetOverrides);
  if (opts.keeperOverrides) Object.assign(keeper, opts.keeperOverrides);
  // _grid 为 0 基：行号 - 1
  store.sheets[PROD_TAB]._grid[row - 1] = target;
  store.sheets[PROD_TAB]._grid[keeperRow - 1] = keeper;
  // 主库底稿：与 prod target 同一内容（A 级 base 匹配）；子类可覆盖
  const master = store.sheets[BASE_TAB] || makeSheet(store, BASE_TAB);
  master._grid[1] = target.slice();
  return { target, keeper };
}

(async () => {
  console.log('=== 隔离 GAS 适配器 harness（跨环境等价证明）===');
  console.log('GAS 生成物：' + GAS_FILE + '\n');

  const gas = loadGas();
  if (!gas.sandbox) { console.log('GAS 生成物加载失败：' + gas.error); process.exit(1); }
  console.log('GAS 生成物加载成功（已定义 tsSoftDelGuarded 等全局）\n');

  // 先跑 norm 自检（跨环境一致性：GAS 与 Node 固定向量必须一致）
  check('G0', 'norm 跨环境自检：GAS 与 Node 的 4 个固定 SHA-256 向量一致', () => {
    const gSelf = gas.sandbox.norm._sdSelfTest();
    const nSelf = NORM._sdSelfTest();
    const issues = [];
    for (let i = 0; i < nSelf.length; i++) {
      if (gSelf[i].got !== nSelf[i].got) issues.push(`${nSelf[i].name}: GAS=${gSelf[i].got} Node=${nSelf[i].got}`);
      if (!gSelf[i].ok) issues.push(`${gSelf[i].name}: GAS ok=false`);
    }
    return { pass: issues.length === 0, detail: issues.length ? issues.join('； ') : '4 向量全一致（含前导零 V2 / 业务日期 V3 / timeOnly V4）' };
  });

  // 场景驱动：同一组种子，GAS 与 Node 各跑一次，比对
  const scenarios = [];
  function add(id, title, opts) { scenarios.push(Object.assign({ id, title }, opts)); }

  // S1：dry 有效 A 级对
  add('S1', 'dry 有效 A 级对 → 双方 ok:true, wrote:false', {
    setup: (s) => {
      const p = seedPair(s, 3, 2, { uuid: 'TS-GAS-A1' });
      return { row: 3, keeperRow: 2, uuid: 'TS-GAS-A1', level: 'A',
        expectHash: hashesFor(p.target, false), keeperHash: hashesFor(p.keeper, false),
        expectBaseHash: hashesFor(p.target, false) };
    }
  });
  // S2：真实写入（apply）→ 双方 patched:1 且 O=TRUE
  add('S2', '真实写入 → 双方 patched:1, O 列= TRUE', {
    apply: true,
    setup: (s) => {
      const p = seedPair(s, 3, 2, { uuid: 'TS-GAS-A2' });
      return { row: 3, keeperRow: 2, uuid: 'TS-GAS-A2', level: 'A',
        expectHash: hashesFor(p.target, false), keeperHash: hashesFor(p.keeper, false),
        expectBaseHash: hashesFor(p.target, false) };
    }
  });
  // S3：已软标 → ALREADY_SOFTDEL
  add('S3', '目标已软标 → 双方 ALREADY_SOFTDEL', {
    setup: (s) => {
      const p = seedPair(s, 3, 2, { uuid: 'TS-GAS-A3' });
      s.sheets[PROD_TAB]._grid[3 - 1][14] = true;   // 目标 O=TRUE
      return { row: 3, keeperRow: 2, uuid: 'TS-GAS-A3', level: 'A',
        expectHash: hashesFor(p.target, false), keeperHash: hashesFor(p.keeper, false),
        expectBaseHash: hashesFor(p.target, false) };
    }
  });
  // S4：UUID 漂移 → UUID_DRIFT
  add('S4', '目标 UUID 被改 → 双方 UUID_DRIFT', {
    setup: (s) => {
      const p = seedPair(s, 3, 2, { uuid: 'TS-GAS-A4' });
      s.sheets[PROD_TAB]._grid[3 - 1][8] = 'TS-OTHER';   // 实际 UUID 被改
      return { row: 3, keeperRow: 2, uuid: 'TS-GAS-A4', level: 'A',
        expectHash: hashesFor(p.target, false), keeperHash: hashesFor(p.keeper, false),
        expectBaseHash: hashesFor(p.target, false) };
    }
  });
  // S5：PAYLOAD_DIFF（非 timeOnly 负载列真实不同，哈希各自匹配）
  add('S5', '负载列真实不同 → 双方 PAYLOAD_DIFF', {
    setup: (s) => {
      const p = seedPair(s, 3, 2, { uuid: 'TS-GAS-A5', targetOverrides: { 2: 'NameX' }, keeperOverrides: { 2: 'NameY' } });
      // 哈希按各自实际细胞算 → 各自匹配；但 target vs keeper 负载不同 → PAYLOAD_DIFF
      return { row: 3, keeperRow: 2, uuid: 'TS-GAS-A5', level: 'A',
        expectHash: hashesFor(p.target, false), keeperHash: hashesFor(p.keeper, false),
        expectBaseHash: hashesFor(p.target, false) };
    }
  });
  // S6：前导零不合并（列2="007" 双方一致）→ 不得误判 DRIFT/DIFF
  add('S6', '前导零 "007" 一致 → 双方通过（类型保全）', {
    setup: (s) => {
      const p = seedPair(s, 3, 2, { uuid: 'TS-GAS-A6', targetOverrides: { 2: '007' }, keeperOverrides: { 2: '007' } });
      return { row: 3, keeperRow: 2, uuid: 'TS-GAS-A6', level: 'A',
        expectHash: hashesFor(p.target, false), keeperHash: hashesFor(p.keeper, false),
        expectBaseHash: hashesFor(p.target, false) };
    }
  });
  // S7：timeOnly 对（双方录入时间绑定）
  add('S7', 'timeOnly 对 → 双方通过', {
    timeOnly: true,
    setup: (s) => {
      const entryT = new Date(Date.UTC(2026, 9, 8, 1, 0, 0));
      const entryK = new Date(Date.UTC(2026, 9, 8, 2, 0, 0));
      const p = seedPair(s, 3, 2, { uuid: 'TS-GAS-A7', entry: entryT, keeperOverrides: { 0: entryK } });
      return { row: 3, keeperRow: 2, uuid: 'TS-GAS-A7', level: 'A', timeOnly: true,
        expectHash: hashesFor(p.target, true), keeperHash: hashesFor(p.keeper, true),
        expectBaseHash: hashesFor(p.target, false),
        expectEntryTime: NORM._sdSha256(JSON.stringify(NORM._sdCellTok(p.target[0]))),
        keeperEntryTime: NORM._sdSha256(JSON.stringify(NORM._sdCellTok(p.keeper[0]))) };
    }
  });
  // S8：期锁（业务日期早于 cut-off 2026-10-01）→ PERIOD_LOCKED
  add('S8', '业务日期 < cut-off → 双方 PERIOD_LOCKED', {
    dateBefore: true,
    setup: (s) => {
      const p = seedPair(s, 3, 2, { uuid: 'TS-GAS-A8', date: new Date(Date.UTC(2026, 8, 15)) });  // 2026-09-15
      return { row: 3, keeperRow: 2, uuid: 'TS-GAS-A8', level: 'A',
        expectHash: hashesFor(p.target, false), keeperHash: hashesFor(p.keeper, false),
        expectBaseHash: hashesFor(p.target, false) };
    }
  });
  // S9：底稿漂移 → BASE_DRIFT
  add('S9', '底稿哈希不符 → 双方 BASE_DRIFT', {
    setup: (s) => {
      const p = seedPair(s, 3, 2, { uuid: 'TS-GAS-A9' });
      // 底稿放一份"别的内容"，但候选的 expectBaseHash 用 target 的真实哈希 → 不符
      const master = s.sheets[BASE_TAB] || makeSheet(s, BASE_TAB);
      master._grid[1] = _mkRow(new Date(Date.UTC(2026, 9, 8)), 'TS-GAS-A9', 2, new Date(Date.UTC(2026, 9, 8, 1, 0, 0)), 'OTHER_NAME');
      return { row: 3, keeperRow: 2, uuid: 'TS-GAS-A9', level: 'A',
        expectHash: hashesFor(p.target, false), keeperHash: hashesFor(p.keeper, false),
        expectBaseHash: hashesFor(p.target, false) };
    }
  });
  // S10：业务日期为 Date 类型（GAS 原生 Date）→ 哈希与期锁跨环境一致
  add('S10', '业务日期 Date 类型（GAS 原生）→ 通过', {
    setup: (s) => {
      const p = seedPair(s, 3, 2, { uuid: 'TS-GAS-A10', date: new Date(Date.UTC(2026, 9, 8)) });  // Date 类型
      return { row: 3, keeperRow: 2, uuid: 'TS-GAS-A10', level: 'A',
        expectHash: hashesFor(p.target, false), keeperHash: hashesFor(p.keeper, false),
        expectBaseHash: hashesFor(p.target, false) };
    }
  });

  for (const sc of scenarios) {
    // GAS 世界
    const gStore = makeStore(); makeSheet(gStore, PROD_TAB); makeSheet(gStore, BASE_TAB);
    const gSand = gasShim(gStore);
    vm.createContext(gSand);
    vm.runInContext(fs.readFileSync(GAS_FILE, 'utf8'), gSand, { timeout: 20000 });
    const gCand = sc.setup(gStore);
    const gE = { parameter: sc.apply ? {} : { dry: '1' }, postBody: { rows: [gCand], dry: sc.apply ? '0' : '1', jobId: TEST_JOB } };
    let gOut; try { gOut = gSand.tsSoftDelGuarded(gE); } catch (e) { gOut = JSON.stringify({ ok: false, error: String(e.message || e) }); }

    // Node 世界
    const nStore = makeStore(); makeSheet(nStore, PROD_TAB); makeSheet(nStore, BASE_TAB);
    const nCand = sc.setup(nStore);
    const nDeps = nodeDeps(nStore);
    const nE = { parameter: sc.apply ? {} : { dry: '1' }, postBody: { rows: [nCand], dry: sc.apply ? '0' : '1', jobId: TEST_JOB } };
    let nOut;
    try { nOut = CORE.tsSoftDelGuardedCore(nE, nDeps); }
    catch (e) { nOut = JSON.stringify({ ok: false, error: String(e.message || e) }); }

    check(sc.id, sc.title, () => compareRun(gOut, nOut, gStore, nStore, gCand.row));
  }

  // S11：锁占用 → 双方 fail-closed LOCK_BUSY（回应 Tom #2 锁交错/第二锁失败释放第一锁）
  check('S11', '锁被占用 → 双方 LOCK_BUSY（fail-closed，不写）', () => {
    const gStore = makeStore(); makeSheet(gStore, PROD_TAB); makeSheet(gStore, BASE_TAB);
    const gSand = gasShim(gStore); vm.createContext(gSand);
    vm.runInContext(fs.readFileSync(GAS_FILE, 'utf8'), gSand, { timeout: 20000 });
    const pG = seedPair(gStore, 3, 2, { uuid: 'TS-GAS-LK' });
    const gCand = { row: 3, keeperRow: 2, uuid: 'TS-GAS-LK', level: 'A', expectHash: hashesFor(pG.target, false), keeperHash: hashesFor(pG.keeper, false), expectBaseHash: hashesFor(pG.target, false) };
    gStore.lockBusy = true;
    const gWritesBefore = gStore.observations.filter(o => o.op === 'write').length;
    let gOut; try { gOut = gSand.tsSoftDelGuarded({ parameter: {}, postBody: { rows: [gCand], dry: '0', jobId: TEST_JOB } }); } catch (e) { gOut = JSON.stringify({ ok: false, error: String(e.message || e) }); }
    const gWritesAfter = gStore.observations.filter(o => o.op === 'write').length;
    gStore.lockBusy = false;

    const nStore = makeStore(); makeSheet(nStore, PROD_TAB); makeSheet(nStore, BASE_TAB);
    const nDeps = nodeDeps(nStore);
    const pN = seedPair(nStore, 3, 2, { uuid: 'TS-GAS-LK' });
    const nCand = { row: 3, keeperRow: 2, uuid: 'TS-GAS-LK', level: 'A', expectHash: hashesFor(pN.target, false), keeperHash: hashesFor(pN.keeper, false), expectBaseHash: hashesFor(pN.target, false) };
    nStore.lockBusy = true;
    let nOut; try { nOut = CORE.tsSoftDelGuardedCore({ parameter: {}, postBody: { rows: [nCand], dry: '0', jobId: TEST_JOB } }, nDeps); } catch (e) { nOut = JSON.stringify({ ok: false, error: String(e.message || e) }); }
    nStore.lockBusy = false;
    const g = JSON.parse(gOut), n = JSON.parse(nOut);
    const pass = g.ok === false && n.ok === false
      && /LOCK_BUSY/.test(String(g.error || '')) && /LOCK_BUSY/.test(String(n.error || ''))
      && (gWritesAfter - gWritesBefore) === 0;
    return { pass, detail: `GAS ok=${g.ok} error=${g.error}；Node ok=${n.ok} error=${n.error}；锁占用期间 GAS 写入次数=${gWritesAfter - gWritesBefore}（须 0）` };
  });

  // S12：释放后同一请求成功（第二锁失败→释放第一锁 的可达性）
  check('S12', '锁释放后 → 同一请求成功（O=TRUE），证明锁确实被释放', () => {
    const gStore = makeStore(); makeSheet(gStore, PROD_TAB); makeSheet(gStore, BASE_TAB);
    const gSand = gasShim(gStore); vm.createContext(gSand);
    vm.runInContext(fs.readFileSync(GAS_FILE, 'utf8'), gSand, { timeout: 20000 });
    const p = seedPair(gStore, 3, 2, { uuid: 'TS-GAS-RL' });
    const cand = { row: 3, keeperRow: 2, uuid: 'TS-GAS-RL', level: 'A', expectHash: hashesFor(p.target, false), keeperHash: hashesFor(p.keeper, false), expectBaseHash: hashesFor(p.target, false) };
    let gOut; try { gOut = gSand.tsSoftDelGuarded({ parameter: {}, postBody: { rows: [cand], dry: '0', jobId: TEST_JOB } }); } catch (e) { gOut = JSON.stringify({ ok: false, error: String(e.message || e) }); }
    const g = JSON.parse(gOut);
    const oAfter = (gStore.sheets[PROD_TAB]._grid[3 - 1] || [])[14];
    const pass = g.ok === true && g.patched === 1 && String(oAfter).toUpperCase() === 'TRUE';
    return { pass, detail: `ok=${g.ok} patched=${g.patched} O[3]=${oAfter}（释放后写入成功）` };
  });

  const failed = RESULTS.filter(r => !r.pass);
  console.log('\n=== 汇总 ===');
  console.log(`${RESULTS.length - failed.length}/${RESULTS.length} 通过`);
  failed.forEach(r => console.log('  FAIL ' + r.id + ' ' + r.title));
  process.exit(failed.length ? 1 : 0);
})();
