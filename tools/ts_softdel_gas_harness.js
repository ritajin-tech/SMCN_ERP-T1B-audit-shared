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
// v5 B3（Tom 第 5 项）：真实入口绑定后的最终文件 + 分发器，用于「同版本实际分发」测试
const FINAL_FILE = path.join(HERE, 'v4_patches', 'full', 'RemoteActions.A1d_v4_FINAL_entry_bound.js');
const RT_FILE = path.join(HERE, 'v4_patches', 'full', 'RemoteTrigger.js');
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
    // v5 B2：脚本属性绑定到 store.props（可注入），此前每次调用都新建空 map，
    //   测试无法注入生产策略 —— 真实策略读取路径等于没被测到。
    PropertiesService: {
      getDocumentProperties: () => stubProps(store),
      getScriptProperties: () => stubProps(store),
      getUserProperties: () => stubProps(store)
    },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {} }) },
    Logger: { log: () => {} },
    MailApp: { sendEmail: () => {} },
    ScriptApp: { getScriptId: () => 'mock', newTrigger: () => ({}) }
  };
}
function stubProps(store) {
  if (!store.props) store.props = {};      // 与 store 生命周期绑定（同一脚本属性集）
  const m = store.props;
  return { getProperty: k => (k in m ? m[k] : null), setProperty: (k, v) => { m[k] = String(v); }, deleteProperty: k => { delete m[k]; }, getProperties: () => m };
}

// ---------- Node 端 deps（读同一份内存表，逻辑与 GAS 包装器镜像）----------
// v5 B2（Tom 第 3 项）：客户端/测试侧取得主库版本指纹（与服务端 readAllMaster 同源算法，
// 覆盖 0..14 全列并绑定 rowCount）。真写请求必须携带 expectMasterVersion，否则整批被拒。
function masterVerOf(store) {
  const g = (store.sheets[BASE_TAB] || {})._grid || [];
  const vals = [];
  // v5 B2：与 GAS 端 readAllMaster 逐字同口径 —— GAS 用 getRange(1,1,last,15)，
  //   【含表头行】。此前 Node 侧从 r=1 起（不含表头），两边指纹必然不同，
  //   导致 harness 算出的 expectMasterVersion 在 GAS 侧永远不匹配（被抓到的真实不一致）。
  for (let r = 0; r < g.length; r++) vals.push(g[r].slice());
  const allCols = []; for (let ci = 0; ci <= 14; ci++) allCols.push(ci);
  return NORM._sdSha256(JSON.stringify({
    rowCount: vals.length,
    rows: vals.map(row => NORM._sdCanonRow(row, allCols))
  }));
}

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
    // v5 B3（Tom 第 5 项）：锁状态提升到 **store 级**（此前每个 deps 各持一个独立 lock 对象，
    //   两个执行者可“同时”持有同一把锁 ⇒ 无法证明并发互斥，S13 只能是故障注入）。
    //   现在同一 store 上第二个执行者取同一把锁会被真实拒绝。
    acquireMasterLock() { if (store.lockBusy || store._mHeld) throw new Error('LOCK_BUSY'); store._mHeld = true; return lock; },
    acquireLock() { if (store.lockBusy || store._pHeld) throw new Error('LOCK_BUSY'); store._pHeld = true; return lock; },
    releaseLock(l) { store._pHeld = false; lock.held = false; },
    releaseMasterLock(l) { store._mHeld = false; lock.held = false; },
    readProdRow(row) { const g = getRow(prod, row); return g ? g.slice() : null; },
    readProdO(row) { const g = getRow(prod, row); return g ? g[14] : null; },
    writeProdO(row, val) { if (!prod) return false; const g = prod._grid[row - 1]; if (!g) return false; g[14] = val; return true; },
    readAllMaster() {
      const g = master._grid;
      const map = {};
      const vals = [];
      // v5 B2：与 GAS 端 getRange(1,1,last,15) 同口径（含表头行）；
      //   表头 UUID 为空故不入 map，仅影响指纹 —— 与生产保持一致。
      for (let r = 0; r < g.length; r++) {
        vals.push(g[r].slice());
        const u = NORM._sdNorm(g[r][8]);
        if (u) (map[u] = map[u] || []).push({ row: r + 1, cells: g[r].slice() });
      }
      // Tom #6：指纹必须覆盖全部相关列 0..14 并绑定 rowCount，
      // 只覆盖 1..9 列会让 0/10..14 列的改动（含同 rowCount 改值）不触发版本变化。
      const allCols = []; for (let ci = 0; ci <= 14; ci++) allCols.push(ci);
      const fp = NORM._sdSha256(JSON.stringify({
        rowCount: vals.length,
        rows: vals.map(row => NORM._sdCanonRow(row, allCols))
      }));
      return { map, complete: true, version: fp };
    },
    journalAppend(rec) {
      const js = store.sheets['_TS_SOFTDEL_LOG'] || makeSheet(store, '_TS_SOFTDEL_LOG');
      js._grid.push([String(rec.ts), rec.jobId, rec.subBatchId, rec.itemId, rec.requestHash,
        rec.uuid == null ? null : rec.uuid, rec.state, rec.reason == null ? null : rec.reason]);
    },
    journalGet(jobId, itemId) {
      const js = store.sheets['_TS_SOFTDEL_LOG'];
      if (!js) return null;
      for (let i = js._grid.length - 1; i >= 1; i--) {
        const g = js._grid[i];
        if (String(g[3] || '') === String(itemId) && String(g[1] || '') === String(jobId))
          return { jobId: g[1], subBatchId: g[2], itemId: g[3], requestHash: g[4], uuid: g[5], state: g[6], reason: g[7] };
      }
      return null;
    },
    // Tom #4：全量日志 —— 身份检索必须看到该 jobId+itemId 下的全部记录，不能只取最后一条
    journalList(jobId, itemId) {
      const js = store.sheets['_TS_SOFTDEL_LOG'];
      if (!js) return [];
      const out = [];
      for (let i = 1; i < js._grid.length; i++) {
        const g = js._grid[i];
        if (String(g[3] || '') === String(itemId) && String(g[1] || '') === String(jobId))
          out.push({ jobId: g[1], subBatchId: g[2], itemId: g[3], requestHash: g[4], uuid: g[5], state: g[6], reason: g[7] });
      }
      return out;
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

  // Tom #3：S1–S10 除「两侧相等」外，还必须【逐项断言预期成功/拒绝值】——
  // 只比相等会出现「两侧同错也通过」的假绿。
  const EXPECT = {
    S1:  { ok: true,  patched: 0 },
    S2:  { ok: true,  patched: 1 },
    S3:  { ok: false, reason: 'ALREADY_SOFTDEL' },
    S4:  { ok: false, reason: 'UUID_DRIFT' },
    S5:  { ok: false, reason: 'PAYLOAD_DIFF' },
    S6:  { ok: true,  patched: 0 },
    S7:  { ok: true,  patched: 0 },
    S8:  { ok: false, reason: 'PERIOD_LOCKED' },
    S9:  { ok: false, reason: 'BASE_DRIFT' },
    S10: { ok: true,  patched: 0 }
  };

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
    const gE = { parameter: sc.apply ? {} : { dry: '1' }, postBody: { rows: [gCand], dry: sc.apply ? '0' : '1', jobId: TEST_JOB, expectMasterVersion: sc.apply ? masterVerOf(gStore) : undefined } };
    let gOut; try { gOut = gSand.tsSoftDelGuarded(gE); } catch (e) { gOut = JSON.stringify({ ok: false, error: String(e.message || e) }); }

    // Node 世界
    const nStore = makeStore(); makeSheet(nStore, PROD_TAB); makeSheet(nStore, BASE_TAB);
    const nCand = sc.setup(nStore);
    const nDeps = nodeDeps(nStore);
    const nE = { parameter: sc.apply ? {} : { dry: '1' }, postBody: { rows: [nCand], dry: sc.apply ? '0' : '1', jobId: TEST_JOB, expectMasterVersion: sc.apply ? masterVerOf(nStore) : undefined } };
    let nOut;
    try { nOut = CORE.tsSoftDelGuardedCore(nE, nDeps); }
    catch (e) { nOut = JSON.stringify({ ok: false, error: String(e.message || e) }); }

    check(sc.id, sc.title, () => {
      const eq = compareRun(gOut, nOut, gStore, nStore, gCand.row);
      const exp = EXPECT[sc.id];
      if (!exp) return eq;
      const gv = JSON.parse(gOut), nv = JSON.parse(nOut);
      const issues = [];
      const chk = (tag, o) => {
        Object.keys(exp).forEach(k => {
          const got = o[k], want = exp[k];
          if (k === 'reason') {
            const gr0 = (o.results && o.results[0]) ? o.results[0].reason : null;
            if (String(gr0 || '') !== String(want)) issues.push(`${tag}.results[0].reason: 期望=${want} 实际=${JSON.stringify(gr0)}`);
          } else if (got !== want) issues.push(`${tag}.${k}: 期望=${JSON.stringify(want)} 实际=${JSON.stringify(got)}`);
        });
      };
      chk('GAS', gv); chk('Node', nv);
      if (issues.length) return { pass: false, detail: '预期值断言失败 → ' + issues.join('； ') };
      return { pass: eq.pass, detail: eq.pass ? (eq.detail + ' ＋ 预期值断言通过') : eq.detail };
    });
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
    let gOut; try { gOut = gSand.tsSoftDelGuarded({ parameter: {}, postBody: { rows: [gCand], dry: '0', jobId: TEST_JOB, expectMasterVersion: masterVerOf(gStore) } }); } catch (e) { gOut = JSON.stringify({ ok: false, error: String(e.message || e) }); }
    const gWritesAfter = gStore.observations.filter(o => o.op === 'write').length;
    gStore.lockBusy = false;

    const nStore = makeStore(); makeSheet(nStore, PROD_TAB); makeSheet(nStore, BASE_TAB);
    const nDeps = nodeDeps(nStore);
    const pN = seedPair(nStore, 3, 2, { uuid: 'TS-GAS-LK' });
    const nCand = { row: 3, keeperRow: 2, uuid: 'TS-GAS-LK', level: 'A', expectHash: hashesFor(pN.target, false), keeperHash: hashesFor(pN.keeper, false), expectBaseHash: hashesFor(pN.target, false) };
    nStore.lockBusy = true;
    let nOut; try { nOut = CORE.tsSoftDelGuardedCore({ parameter: {}, postBody: { rows: [nCand], dry: '0', jobId: TEST_JOB, expectMasterVersion: masterVerOf(nStore) } }, nDeps); } catch (e) { nOut = JSON.stringify({ ok: false, error: String(e.message || e) }); }
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
    let gOut; try { gOut = gSand.tsSoftDelGuarded({ parameter: {}, postBody: { rows: [cand], dry: '0', jobId: TEST_JOB, expectMasterVersion: masterVerOf(gStore) } }); } catch (e) { gOut = JSON.stringify({ ok: false, error: String(e.message || e) }); }
    const g = JSON.parse(gOut);
    const oAfter = (gStore.sheets[PROD_TAB]._grid[3 - 1] || [])[14];
    const pass = g.ok === true && g.patched === 1 && String(oAfter).toUpperCase() === 'TRUE';
    return { pass, detail: `ok=${g.ok} patched=${g.patched} O[3]=${oAfter}（释放后写入成功）` };
  });

  // ---- Tom #3：锁序闭合（双执行者共享 store 交错 + 第二锁失败释放第一锁）----
  check('S13', '共享 store 双执行者交错：第一锁成功/第二锁失败 → 第一锁必须被释放（Tom #3）', () => {
    const store = makeStore(); makeSheet(store, PROD_TAB); makeSheet(store, BASE_TAB);
    const deps = nodeDeps(store);
    let masterReleased = 0, prodReleased = 0;
    const origMaster = deps.acquireMasterLock, origRelM = deps.releaseMasterLock, origRelP = deps.releaseLock;
    deps.acquireMasterLock = function () {
      const l = origMaster();
      store.lockBusy = true;   // 模拟执行者 B 占用：第一把锁成功后，第二把锁必然失败
      return l;
    };
    deps.releaseMasterLock = function (l) { masterReleased++; return origRelM(l); };
    deps.releaseLock = function (l) { prodReleased++; return origRelP(l); };
    const p = seedPair(store, 3, 2, { uuid: 'TS-GAS-LK2' });
    const cand = { row: 3, keeperRow: 2, uuid: 'TS-GAS-LK2', level: 'A', expectHash: hashesFor(p.target, false), keeperHash: hashesFor(p.keeper, false), expectBaseHash: hashesFor(p.target, false) };
    let out;
    try { out = CORE.tsSoftDelGuardedCore({ parameter: {}, postBody: { rows: [cand], dry: '0', jobId: TEST_JOB, expectMasterVersion: masterVerOf(store) } }, deps); }
    catch (e) { out = JSON.stringify({ ok: false, error: 'THROWN: ' + String(e.message || e) }); }
    const j = JSON.parse(out);
    const pass = j.ok === false && /LOCK_BUSY/.test(String(j.error || '')) && masterReleased === 1 && prodReleased === 0;
    return { pass, detail: `ok=${j.ok} error=${j.error}；第一锁释放=${masterReleased}（须 1）；第二锁释放=${prodReleased}（须 0，未取得）` };
  });

  check('S14', '锁获取失败不留悬挂锁：GAS 侧 released≥acquired 且未持锁（Tom #3）', () => {
    const store = makeStore(); makeSheet(store, PROD_TAB); makeSheet(store, BASE_TAB);
    const sand = gasShim(store); vm.createContext(sand);
    vm.runInContext(fs.readFileSync(GAS_FILE, 'utf8'), sand, { timeout: 20000 });
    const p = seedPair(store, 3, 2, { uuid: 'TS-GAS-LK3' });
    const cand = { row: 3, keeperRow: 2, uuid: 'TS-GAS-LK3', level: 'A', expectHash: hashesFor(p.target, false), keeperHash: hashesFor(p.keeper, false), expectBaseHash: hashesFor(p.target, false) };
    store.lockBusy = true;
    let out;
    try { out = sand.tsSoftDelGuarded({ parameter: {}, postBody: { rows: [cand], dry: '0', jobId: TEST_JOB, expectMasterVersion: masterVerOf(store) } }); }
    catch (e) { out = JSON.stringify({ ok: false, error: 'THROWN: ' + String(e.message || e) }); }
    store.lockBusy = false;
    const acq = store.observations.filter(o => o.op === 'lock_acquired').length;
    const rel = store.observations.filter(o => o.op === 'lock_released').length;
    const j = JSON.parse(out);
    const pass = j.ok === false && store.lockHeld !== true && rel >= acq;
    return { pass, detail: `ok=${j.ok} error=${j.error}；acquired=${acq} released=${rel} lockHeld=${store.lockHeld}（须 released>=acquired）` };
  });

  // ---- Tom #4：dry 独立语义（不写业务恢复日志）----
  check('S15', 'dry 不写业务恢复日志（Tom #4）：GAS 与 Node 的 journal 条数均为 0', () => {
    const nStore = makeStore(); makeSheet(nStore, PROD_TAB); makeSheet(nStore, BASE_TAB);
    const nDeps = nodeDeps(nStore);
    const pn = seedPair(nStore, 3, 2, { uuid: 'TS-GAS-DRY' });
    const cn = { row: 3, keeperRow: 2, uuid: 'TS-GAS-DRY', level: 'A', expectHash: hashesFor(pn.target, false), keeperHash: hashesFor(pn.keeper, false), expectBaseHash: hashesFor(pn.target, false) };
    const nOut = JSON.parse(CORE.tsSoftDelGuardedCore({ parameter: {}, postBody: { rows: [cn], dry: '1', jobId: TEST_JOB } }, nDeps));
    const nLog = nStore.sheets['_TS_SOFTDEL_LOG'] ? Math.max(0, nStore.sheets['_TS_SOFTDEL_LOG']._grid.length - 1) : 0;

    const gStore = makeStore(); makeSheet(gStore, PROD_TAB); makeSheet(gStore, BASE_TAB);
    const gSand = gasShim(gStore); vm.createContext(gSand);
    vm.runInContext(fs.readFileSync(GAS_FILE, 'utf8'), gSand, { timeout: 20000 });
    const pg = seedPair(gStore, 3, 2, { uuid: 'TS-GAS-DRY' });
    const cg = { row: 3, keeperRow: 2, uuid: 'TS-GAS-DRY', level: 'A', expectHash: hashesFor(pg.target, false), keeperHash: hashesFor(pg.keeper, false), expectBaseHash: hashesFor(pg.target, false) };
    const gOut = JSON.parse(gSand.tsSoftDelGuarded({ parameter: {}, postBody: { rows: [cg], dry: '1', jobId: TEST_JOB } }));
    const gLog = gStore.sheets['_TS_SOFTDEL_LOG'] ? Math.max(0, gStore.sheets['_TS_SOFTDEL_LOG']._grid.length - 1) : 0;

    const pass = nOut.ok === true && gOut.ok === true && nLog === 0 && gLog === 0;
    return { pass, detail: `Node ok=${nOut.ok} 日志=${nLog}（须 0）；GAS ok=${gOut.ok} 日志=${gLog}（须 0）` };
  });

  // ---- Tom #4：幂等命中必须先复核实时 O，不能无条件声称 wrote:true ----
  check('S16', '幂等命中但实时 O 已非 TRUE → 不得声称 wrote:true（Tom #4）', () => {
    const store = makeStore(); makeSheet(store, PROD_TAB); makeSheet(store, BASE_TAB);
    const deps = nodeDeps(store);
    const p = seedPair(store, 3, 2, { uuid: 'TS-GAS-IDEM' });
    const cand = { row: 3, keeperRow: 2, uuid: 'TS-GAS-IDEM', level: 'A', expectHash: hashesFor(p.target, false), keeperHash: hashesFor(p.keeper, false), expectBaseHash: hashesFor(p.target, false) };
    const e1 = { parameter: {}, postBody: { rows: [cand], dry: '0', jobId: TEST_JOB, batchId: TEST_JOB + '-1', expectMasterVersion: masterVerOf(store) } };
    const r1 = JSON.parse(CORE.tsSoftDelGuardedCore(e1, deps));
    store.sheets[PROD_TAB]._grid[3 - 1][14] = '';   // 模拟 O 被改回/丢失
    const r2 = JSON.parse(CORE.tsSoftDelGuardedCore(e1, deps));
    const it2 = (r2.results || [])[0] || {};
    const pass = r1.ok === true && r1.patched === 1 && r2.ok === false
      && it2.reason === 'IDEMPOTENT_O_DRIFT' && it2.wrote !== true;
    return { pass, detail: `首次 ok=${r1.ok} patched=${r1.patched}；二次 reason=${it2.reason} wrote=${it2.wrote}（须 IDEMPOTENT_O_DRIFT 且 wrote≠true）` };
  });

  // ---- Tom #4：冲突记录不得覆盖原完成凭据 ----
  check('S17', '同键不同 requestHash 的 REJECTED 不覆盖原 COMMITTED 凭据（Tom #4）', () => {
    const store = makeStore(); makeSheet(store, PROD_TAB); makeSheet(store, BASE_TAB);
    const deps = nodeDeps(store);
    const p = seedPair(store, 3, 2, { uuid: 'TS-GAS-CONF' });
    const c1 = { row: 3, keeperRow: 2, uuid: 'TS-GAS-CONF', level: 'A', expectHash: hashesFor(p.target, false), keeperHash: hashesFor(p.keeper, false), expectBaseHash: hashesFor(p.target, false) };
    const r1 = JSON.parse(CORE.tsSoftDelGuardedCore({ parameter: {}, postBody: { rows: [c1], dry: '0', jobId: TEST_JOB, batchId: TEST_JOB + '-1', expectMasterVersion: masterVerOf(store) } }, deps));
    const h1 = CORE._requestHashOf(c1);
    const c2 = Object.assign({}, c1, { expectHash: 'sha256:deadbeef' });   // 同键、不同 requestHash
    const r2 = JSON.parse(CORE.tsSoftDelGuardedCore({ parameter: {}, postBody: { rows: [c2], dry: '0', jobId: TEST_JOB, batchId: TEST_JOB + '-1', expectMasterVersion: masterVerOf(store) } }, deps));
    const recs = deps.journalList(TEST_JOB, 3);
    const commit1 = recs.find(x => x.requestHash === h1 && x.state === 'COMMITTED');
    const it2 = (r2.results || [])[0] || {};
    const pass = r1.ok === true && r2.ok === false && it2.reason === 'KEY_REUSE_CONFLICT' && !!commit1;
    return { pass, detail: `首次 ok=${r1.ok}；二次 reason=${it2.reason}；原 COMMITTED 凭据仍在=${!!commit1}（日志共 ${recs.length} 条）` };
  });

  // ---- Tom #5：状态查询逐项绑定原 manifest 身份 ----
  check('S18', '状态查询身份绑定：requestHash 不符 → UNKNOWN；相符且 O=TRUE → COMMITTED（Tom #5）', () => {
    const store = makeStore(); makeSheet(store, PROD_TAB); makeSheet(store, BASE_TAB);
    const deps = nodeDeps(store);
    const p = seedPair(store, 3, 2, { uuid: 'TS-GAS-ST' });
    const SB = TEST_JOB + '-1';   // v5：真实 subBatchId（与发送端一致）
    const c1 = { row: 3, keeperRow: 2, uuid: 'TS-GAS-ST', level: 'A', expectHash: hashesFor(p.target, false), keeperHash: hashesFor(p.keeper, false), expectBaseHash: hashesFor(p.target, false) };
    JSON.parse(CORE.tsSoftDelGuardedCore({ parameter: {}, postBody: { rows: [c1], dry: '0', jobId: TEST_JOB, batchId: SB, expectMasterVersion: masterVerOf(store) } }, deps));
    const h1 = CORE._requestHashOf(c1);
    const qrow = (hash) => ({ row: 3, subBatchId: SB, requestHash: hash, uuid: c1.uuid });
    const wrong = JSON.parse(CORE.tsSoftDelStatus({ postBody: { action: 'statusQuery', jobId: TEST_JOB, rows: [qrow('sha256:WRONG')] } }, deps));
    const right = JSON.parse(CORE.tsSoftDelStatus({ postBody: { action: 'statusQuery', jobId: TEST_JOB, rows: [qrow(h1)] } }, deps));
    // v5 新增：身份声明不全（缺 subBatchId）→ 必须 UNKNOWN，不得放行
    const incompl = JSON.parse(CORE.tsSoftDelStatus({ postBody: { action: 'statusQuery', jobId: TEST_JOB, rows: [{ row: 3, requestHash: h1, uuid: c1.uuid }] } }, deps));
    const w = (wrong.rows || [])[0] || {}, r = (right.rows || [])[0] || {}, inc = (incompl.rows || [])[0] || {};
    const pass = w.state === 'UNKNOWN' && r.state === 'COMMITTED' && r.identity === 'BOUND'
      && inc.state === 'UNKNOWN' && inc.identity === 'INCOMPLETE_QUERY_IDENTITY';
    return { pass, detail: `错 hash → ${w.state}/${w.identity}；对 hash → ${r.state}/${r.identity}；缺 subBatchId → ${inc.state}/${inc.identity}` };
  });

  // ---- Tom #2：statusQuery 必须经同一受控入口抵达核心 ----
  check('S19', 'statusQuery 经同一受控入口抵达核心（Tom #2）：GAS tsSoftDelGuarded(action=statusQuery)', () => {
    const gStore = makeStore(); makeSheet(gStore, PROD_TAB); makeSheet(gStore, BASE_TAB);
    const gSand = gasShim(gStore); vm.createContext(gSand);
    vm.runInContext(fs.readFileSync(GAS_FILE, 'utf8'), gSand, { timeout: 20000 });
    const p = seedPair(gStore, 3, 2, { uuid: 'TS-GAS-SQ' });
    const c1 = { row: 3, keeperRow: 2, uuid: 'TS-GAS-SQ', level: 'A', expectHash: hashesFor(p.target, false), keeperHash: hashesFor(p.keeper, false), expectBaseHash: hashesFor(p.target, false) };
    const SB = TEST_JOB + '-1';   // v5：真实 subBatchId
    const w1 = JSON.parse(gSand.tsSoftDelGuarded({ parameter: {}, postBody: { rows: [c1], dry: '0', jobId: TEST_JOB, batchId: SB, expectMasterVersion: masterVerOf(gStore) } }));
    const h1 = CORE._requestHashOf(c1);
    const sq = JSON.parse(gSand.tsSoftDelGuarded({ parameter: {}, postBody: { action: 'statusQuery', jobId: TEST_JOB, rows: [{ row: 3, subBatchId: SB, requestHash: h1, uuid: c1.uuid }] } }));
    const r0 = (sq.rows || [])[0] || {};
    const pass = w1.ok === true && sq.action === 'statusQuery' && r0.state === 'COMMITTED' && r0.identity === 'BOUND';
    return { pass, detail: `写入 ok=${w1.ok}；statusQuery action=${sq.action} state=${r0.state} identity=${r0.identity}` };
  });


  // ================= v5 · B1 验收负例与恢复用例（Tom 第 1/2 项） =================

  const mkDeps = () => {
    const store = makeStore(); makeSheet(store, PROD_TAB); makeSheet(store, BASE_TAB);
    return { store, deps: nodeDeps(store) };
  };
  const mkCand = (p, uuid, extra) => Object.assign({
    row: 3, keeperRow: 2, uuid, level: 'A',
    expectHash: hashesFor(p.target, false), keeperHash: hashesFor(p.keeper, false),
    expectBaseHash: hashesFor(p.target, false)
  }, extra || {});
  const logCount = (store, jobId, row) => {
    const js = store.sheets['_TS_SOFTDEL_LOG'];
    if (!js) return 0;
    return js._grid.filter(g => String(g[1] || '') === String(jobId) && String(g[3] || '') === String(row)).length;
  };

  // ---- 负例 1/5：空 UUID 与 uuid:null 一律拒绝 ----
  check('S20', '负例：UUID 为空串 / null 一律拒绝，不得放行写入（Tom #1 验收）', () => {
    const a = mkDeps(); const pa = seedPair(a.store, 3, 2, { uuid: 'TS-GAS-U0' });
    const ra = JSON.parse(CORE.tsSoftDelGuardedCore({ parameter: {}, postBody: { rows: [mkCand(pa, '')], dry: '0', jobId: TEST_JOB, batchId: TEST_JOB + '-1', expectMasterVersion: masterVerOf(a.store) } }, a.deps));
    const b = mkDeps(); const pb = seedPair(b.store, 3, 2, { uuid: 'TS-GAS-U1' });
    const rb = JSON.parse(CORE.tsSoftDelGuardedCore({ parameter: {}, postBody: { rows: [mkCand(pb, null)], dry: '0', jobId: TEST_JOB, batchId: TEST_JOB + '-1', expectMasterVersion: masterVerOf(b.store) } }, b.deps));
    const ia = (ra.results || [])[0] || {}, ib = (rb.results || [])[0] || {};
    const oa = a.deps.readProdO(3), ob = b.deps.readProdO(3);
    const pass = ra.ok === false && rb.ok === false && !(oa === true || String(oa || '').toUpperCase() === 'TRUE')
      && !(ob === true || String(ob || '').toUpperCase() === 'TRUE');
    return { pass, detail: `空串 ok=${ra.ok} 拒因=${ia.reason || ra.error || '-'}；null ok=${rb.ok} 拒因=${ib.reason || rb.error || '-'}；O 均未置 TRUE` };
  });

  // ---- 负例 2/5：错 subBatchId 不得命中完成凭据 ----
  check('S21', '负例：subBatchId 不符 → 状态查询 SUBBATCH_MISMATCH / UNKNOWN（Tom #1 验收）', () => {
    const { store, deps } = mkDeps();
    const SB = TEST_JOB + '-1';
    const p = seedPair(store, 3, 2, { uuid: 'TS-GAS-SB' });
    const c1 = mkCand(p, 'TS-GAS-SB');
    JSON.parse(CORE.tsSoftDelGuardedCore({ parameter: {}, postBody: { rows: [c1], dry: '0', jobId: TEST_JOB, batchId: SB, expectMasterVersion: masterVerOf(store) } }, deps));
    const h1 = CORE._requestHashOf(c1);
    const bad = JSON.parse(CORE.tsSoftDelStatus({ postBody: { action: 'statusQuery', jobId: TEST_JOB,
      rows: [{ row: 3, subBatchId: TEST_JOB + '-9', requestHash: h1, uuid: c1.uuid }] } }, deps));
    const r0 = (bad.rows || [])[0] || {};
    const pass = r0.state === 'UNKNOWN' && r0.identity === 'SUBBATCH_MISMATCH';
    return { pass, detail: `错 subBatchId → state=${r0.state} identity=${r0.identity}` };
  });

  // ---- 负例 3/5：日志不可读取 ⇒ 拒绝新写（不可读取 ≠ 允许写） ----
  check('S22', '日志读失败 ⇒ 拒绝新写并登记 JOURNAL_READ_ERROR（Tom #2 验收）', () => {
    const { store, deps } = mkDeps();
    const p = seedPair(store, 3, 2, { uuid: 'TS-GAS-JRE' });
    const c1 = mkCand(p, 'TS-GAS-JRE');
    deps.journalList = function () { throw new Error('SIMULATED_JOURNAL_READ_FAIL'); };
    const r = JSON.parse(CORE.tsSoftDelGuardedCore({ parameter: {}, postBody: { rows: [c1], dry: '0', jobId: TEST_JOB, batchId: TEST_JOB + '-1', expectMasterVersion: masterVerOf(store) } }, deps));
    const it = (r.results || [])[0] || {};
    const o = deps.readProdO(3);
    const pass = r.ok === false && it.reason === 'JOURNAL_READ_ERROR' && !(o === true || String(o || '').toUpperCase() === 'TRUE');
    return { pass, detail: `ok=${r.ok} reason=${it.reason} state=${it.state}；O 未写=${!(o === true || String(o || '').toUpperCase() === 'TRUE')}` };
  });

  // ---- 恢复用例：写后主库版本漂移 ⇒ VOIDED 持久化，后续不得再报 COMMITTED ----
  check('S23', '恢复：写后漂移追加 VOIDED；重放被 PRIOR_VOIDED 拦下；status 不再报 COMMITTED（Tom #2）', () => {
    const { store, deps } = mkDeps();
    const SB = TEST_JOB + '-1';
    const p = seedPair(store, 3, 2, { uuid: 'TS-GAS-VOID' });
    const c1 = mkCand(p, 'TS-GAS-VOID');
    let n = 0; const orig = deps.readAllMaster;
    deps.readAllMaster = function () {                 // 第二次（写后复核）返回漂移版本
      n++; const r = orig.call(deps);
      // 仅第 2 次（写后复核）漂移；后续读恢复正常，才能验证「重放被 PRIOR_VOIDED 拦下」
      return (n === 2) ? { map: r.map, complete: true, version: String(r.version) + '-DRIFTED' } : r;
    };
    const w = JSON.parse(CORE.tsSoftDelGuardedCore({ parameter: {}, postBody: { rows: [c1], dry: '0', jobId: TEST_JOB, batchId: SB, expectMasterVersion: masterVerOf(store) } }, deps));
    const h1 = CORE._requestHashOf(c1);
    const recs = deps.journalList(TEST_JOB, 3);
    const voided = recs.find(x => x.state === 'VOIDED');
    const st = JSON.parse(CORE.tsSoftDelStatus({ postBody: { action: 'statusQuery', jobId: TEST_JOB,
      rows: [{ row: 3, subBatchId: SB, requestHash: h1, uuid: c1.uuid }] } }, deps));
    const r0 = (st.rows || [])[0] || {};
    const again = JSON.parse(CORE.tsSoftDelGuardedCore({ parameter: {}, postBody: { rows: [c1], dry: '0', jobId: TEST_JOB, batchId: SB, expectMasterVersion: masterVerOf(store) } }, deps));
    const it2 = (again.results || [])[0] || {};
    const pass = w.ok === false && !!voided && r0.state !== 'COMMITTED' && it2.reason === 'PRIOR_VOIDED';
    return { pass, detail: `写入 ok=${w.ok}；VOIDED 记录=${!!voided}(reason=${voided ? voided.reason : '-'})；status=${r0.state}；重放 reason=${it2.reason}` };
  });

  // ---- 负例 4/5：dry 的【拒绝】分支同样不写任何业务恢复日志 ----
  check('S24', 'dry 拒绝分支（UUID/TARGET 漂移等）不留 REJECTED 痕（Tom #2 验收）', () => {
    const { store, deps } = mkDeps();
    const p = seedPair(store, 3, 2, { uuid: 'TS-GAS-DRYREJ' });
    const bad = mkCand(p, 'TS-GAS-DRYREJ', { expectHash: 'sha256:deadbeef' });   // 触发 TARGET_DRIFT
    const r = JSON.parse(CORE.tsSoftDelGuardedCore({ parameter: {}, postBody: { rows: [bad], dry: '1', jobId: TEST_JOB, batchId: TEST_JOB + '-1' } }, deps));
    const it = (r.results || [])[0] || {};
    const n = logCount(store, TEST_JOB, 3);
    const pass = r.ok === false && it.reason === 'TARGET_DRIFT' && n === 0;
    return { pass, detail: `dry 拒绝 reason=${it.reason}；日志条数=${n}（须 0）` };
  });


  // ================= v5 · B2 验收：真实期锁策略四态 + 版本缺失拒写（Tom 第 3/4 项） =================

  // 用 GAS 沙箱跑真实策略读取路径（props 注入 store.props）
  const gasRunWith = (props, opts) => {
    const store = makeStore(); makeSheet(store, PROD_TAB); makeSheet(store, BASE_TAB);
    store.props = Object.assign({}, props || {});
    const sand = gasShim(store); vm.createContext(sand);
    vm.runInContext(fs.readFileSync(GAS_FILE, 'utf8'), sand, { timeout: 20000 });
    const p = seedPair(store, 3, 2, Object.assign({ uuid: 'TS-GAS-PL' }, opts || {}));
    const cand = { row: 3, keeperRow: 2, uuid: 'TS-GAS-PL', level: 'A',
      expectHash: hashesFor(p.target, false), keeperHash: hashesFor(p.keeper, false),
      expectBaseHash: hashesFor(p.target, false) };
    const out = JSON.parse(sand.tsSoftDelGuarded({ parameter: {}, postBody: {
      rows: [cand], dry: '0', jobId: TEST_JOB, batchId: TEST_JOB + '-1',
      expectMasterVersion: masterVerOf(store) } }));
    const it = (out.results || [])[0] || {};
    return { out, it, o: store.sheets[PROD_TAB]._grid[2][14] };
  };
  const POL = (o) => JSON.stringify(Object.assign({ closed: true, futureOpen: true, cutoff: '2026-10-01' }, o || {}));

  // ---- 策略四态 1：策略缺失（真首次态，无哨兵）→ futureOpen=true，未来日期放行 ----
  check('S25', '期锁策略四态 1/4：策略缺失（真首次态）→ 未来日期放行（Tom #4）', () => {
    const { out, it } = gasRunWith({});   // 无策略键、无哨兵
    const pass = out.ok === true && it.wrote === true;
    return { pass, detail: `ok=${out.ok} wrote=${it.wrote} reason=${it.reason || out.error || '-'}` };
  });

  // ---- 策略四态 2：JSON 损坏 → fail-closed（futureOpen=false）→ 未来日期被拒 ----
  check('S26', '期锁策略四态 2/4：策略 JSON 损坏 → fail-closed 收紧，未来日期被拒（Tom #4）', () => {
    const { out, it } = gasRunWith({ PERIOD_LOCK_STATE: '{broken', PERIOD_LOCK_POLICY_INIT: '1' });
    const pass = out.ok === false && it.reason === 'PERIOD_LOCKED'
      && /PL_REJECT_FUTURE_CLOSED/.test(String(it.detail || ''));
    return { pass, detail: `ok=${out.ok} reason=${it.reason} detail=${it.detail || out.error}` };
  });

  // ---- 策略四态 3：futureOpen=false → 未来日期被拒 ----
  check('S27', '期锁策略四态 3/4：策略 futureOpen=false → 未来日期被拒（Tom #4）', () => {
    const { out, it } = gasRunWith({ PERIOD_LOCK_STATE: POL({ futureOpen: false }), PERIOD_LOCK_POLICY_INIT: '1' });
    const pass = out.ok === false && it.reason === 'PERIOD_LOCKED'
      && /PL_REJECT_FUTURE_CLOSED/.test(String(it.detail || ''));
    return { pass, detail: `ok=${out.ok} reason=${it.reason} detail=${it.detail || out.error}` };
  });

  // ---- 策略四态 4：关账 cutoff 调整（业务日落在新的锁定期内）→ 被拒 ----
  check('S28', '期锁策略四态 4/4：关账 cutoff 调整后业务日落进锁定期 → 被拒（Tom #4）', () => {
    // 业务日 2026-10-02 < cutoff 2026-10-05 ⇒ PL_REJECT_NEW_DATE_CLOSED
    const { out, it } = gasRunWith(
      { PERIOD_LOCK_STATE: POL({ cutoff: '2026-10-05' }), PERIOD_LOCK_POLICY_INIT: '1' },
      { date: new Date(Date.UTC(2026, 9, 2)) });
    const pass = out.ok === false && it.reason === 'PERIOD_LOCKED'
      && /PL_REJECT_NEW_DATE_CLOSED/.test(String(it.detail || ''));
    return { pass, detail: `ok=${out.ok} reason=${it.reason} detail=${it.detail || out.error}` };
  });

  // ---- 版本缺失拒写（真写必须声明 expectMasterVersion）----
  check('S29', '真写缺 expectMasterVersion → 整批 MASTER_VERSION_REQUIRED；dry 探测可回显版本（Tom #3）', () => {
    const store = makeStore(); makeSheet(store, PROD_TAB); makeSheet(store, BASE_TAB);
    const deps = nodeDeps(store);
    const p = seedPair(store, 3, 2, { uuid: 'TS-GAS-MV' });
    const c1 = { row: 3, keeperRow: 2, uuid: 'TS-GAS-MV', level: 'A', expectHash: hashesFor(p.target, false),
      keeperHash: hashesFor(p.keeper, false), expectBaseHash: hashesFor(p.target, false) };
    const noVer = JSON.parse(CORE.tsSoftDelGuardedCore({ parameter: {}, postBody: { rows: [c1], dry: '0', jobId: TEST_JOB, batchId: TEST_JOB + '-1' } }, deps));
    const probe = JSON.parse(CORE.tsSoftDelGuardedCore({ parameter: {}, postBody: { rows: [c1], dry: '1', jobId: TEST_JOB, batchId: TEST_JOB + '-probe' } }, deps));
    const withVer = JSON.parse(CORE.tsSoftDelGuardedCore({ parameter: {}, postBody: { rows: [c1], dry: '0', jobId: TEST_JOB, batchId: TEST_JOB + '-1', expectMasterVersion: masterVerOf(store) } }, deps));
    const badVer = JSON.parse(CORE.tsSoftDelGuardedCore({ parameter: {}, postBody: { rows: [c1], dry: '0', jobId: TEST_JOB, batchId: TEST_JOB + '-1', expectMasterVersion: 'sha256:WRONG' } }, deps));
    const pass = noVer.ok === false && noVer.error === 'MASTER_VERSION_REQUIRED'
      && !!probe.masterVersion && probe.masterVersion === masterVerOf(store)
      && withVer.ok === true && badVer.ok === false && badVer.error === 'MASTER_VERSION_MISMATCH';
    return { pass, detail: `缺版本=${noVer.error}；探测回显=${!!probe.masterVersion}且与本地一致=${probe.masterVersion === masterVerOf(store)}；正确版本 ok=${withVer.ok}；错版本=${badVer.error}` };
  });


  // ============ v5 · B3：同版本实际分发 + 严格响应 + O 类型统一 + 真实交错（Tom 第 5/6 项） ============

  // 真实分发沙箱：加载【最终入口绑定文件】+【RemoteTrigger 分发器】
  const makeDispatch = (store) => {
    const sand = Object.assign(gasShim(store), {
      // RemoteTrigger 的 _rtResponse 需要 ContentService；_rtMaybeHandle 需要 Session
      ContentService: {
        MimeType: { JSON: 'JSON' },
        createTextOutput: (t) => ({ setMimeType: () => ({ getContent: () => String(t) }) })
      },
      Session: { getScriptTimeZone: () => 'GMT+8' }
    });
    vm.createContext(sand);
    vm.runInContext(fs.readFileSync(FINAL_FILE, 'utf8'), sand, { timeout: 60000 });
    vm.runInContext(fs.readFileSync(RT_FILE, 'utf8'), sand, { timeout: 30000 });
    return sand;
  };
  const DISP_UUID = 'TS-GAS-DISP';
  const dispCand = (p) => ({ row: 3, keeperRow: 2, uuid: DISP_UUID, level: 'A',
    expectHash: hashesFor(p.target, false), keeperHash: hashesFor(p.keeper, false),
    expectBaseHash: hashesFor(p.target, false) });

  // ---- 真实分发：经 _rtMaybeHandlePost → REMOTE_ACTIONS → tsSoftDelGuarded ----
  check('S30', '同版本实际分发：_rtMaybeHandlePost → REMOTE_ACTIONS.softDelGuarded → 抵达核心并写入（Tom #5）', () => {
    const store = makeStore(); makeSheet(store, PROD_TAB); makeSheet(store, BASE_TAB);
    const sand = makeDispatch(store);
    const p = seedPair(store, 3, 2, { uuid: DISP_UUID });
    const SB = TEST_JOB + '-1';
    const payload = { action: 'softDelGuarded', jobId: TEST_JOB, batchId: SB, dry: '0',
      expectMasterVersion: masterVerOf(store), rows: [dispCand(p)] };
    // 1) 无 token → 被门控拒绝（首跑顺便初始化 token）
    const r1 = JSON.parse(sand._rtMaybeHandlePost({ postData: { contents: JSON.stringify(payload) } }).getContent());
    const tok = (store.props || {}).REMOTE_TOKEN;
    // 2) 带 token → 抵达核心
    const r2 = JSON.parse(sand._rtMaybeHandlePost({ postData: { contents: JSON.stringify(Object.assign({}, payload, { token: tok })) } }).getContent());
    let inner = null; try { inner = JSON.parse(r2.message); } catch (e) { inner = null; }
    const o = store.sheets[PROD_TAB]._grid[3 - 1][14];
    // 注：分发器 _rtMaybeHandle 会把 action 统一 toLowerCase 后再查表，
    //     故回显的 r2.action 为小写 'softdelguarded' —— 这正是大小写不敏感查表能命中的原因。
    const pass = r1.ok === false && !!tok && r2.ok === true
      && String(r2.action).toLowerCase() === 'softdelguarded'
      && !!inner && inner.ok === true && String(o).toUpperCase() === 'TRUE';
    return { pass, detail: `无 token ok=${r1.ok}；带 token ok=${r2.ok} action=${r2.action}；核心 ok=${inner ? inner.ok : '-'}；O[3]=${o}` };
  });

  // ---- 装配形态：postData.contents / parameter.payload 可达；rows 放 parameter 不可达 ----
  check('S31', '装配契约：postData.contents 与 parameter.payload 均能抵达；rows 置于 parameter 不可达（Tom #5）', () => {
    const mk = () => { const st = makeStore(); makeSheet(st, PROD_TAB); makeSheet(st, BASE_TAB); return st; };
    const run = (st, e) => {
      const sand = makeDispatch(st);
      const p = seedPair(st, 3, 2, { uuid: DISP_UUID });
      const SB = TEST_JOB + '-1';
      const base = { action: 'softDelGuarded', jobId: TEST_JOB, batchId: SB, dry: '0',
        expectMasterVersion: masterVerOf(st), rows: [dispCand(p)] };
      const tok0 = (st.props || {}).REMOTE_TOKEN;
      const body = Object.assign({}, base, tok0 ? { token: tok0 } : {});
      const r0 = JSON.parse(sand._rtMaybeHandlePost(e(body)).getContent());
      const tok = (st.props || {}).REMOTE_TOKEN || tok0;
      const body2 = Object.assign({}, base, { token: tok });
      const r = JSON.parse(sand._rtMaybeHandlePost(e(body2)).getContent());
      let inner = null; try { inner = JSON.parse(r.message); } catch (err) { inner = null; }
      return { r, inner, st };
    };
    // 形态 1：postData.contents（JSON 串）
    const a = run(mk(), (b) => ({ postData: { contents: JSON.stringify(b) } }));
    // 形态 2：parameter.payload（JSON 串）
    const b = run(mk(), (b2) => ({ parameter: { payload: JSON.stringify(b2) } }));
    // 形态 3：rows 放在 parameter 标量上（不经 postBody）→ 核心拿不到 rows，必须拒绝
    const c = run(mk(), (b3) => {
      const q = Object.assign({}, b3); const rows = q.rows; delete q.rows;
      const params = {}; Object.keys(q).forEach(k => { params[k] = q[k]; });
      return { parameter: params, postBody: {}, rowsOnParameter: rows };
    });
    const raw = (x) => String((x.r && (x.r.message !== undefined ? x.r.message : x.r.error)) || '').slice(0, 90);
    const pass = a.inner && a.inner.ok === true && b.inner && b.inner.ok === true
      && c.inner && c.inner.ok === false;
    return { pass, detail: `postData=${a.inner ? a.inner.ok : '-'}；parameter.payload=${b.inner ? b.inner.ok : '-'}[${raw(b)}]；`
      + `rows 仅走 parameter=${c.inner ? c.inner.ok : '-'}（须 false，印证 rows 只走 postBody）[${raw(c)}]` };
  });

  // ---- statusQuery 经同一入口抵达 ----
  check('S32', 'statusQuery 经同一受控入口抵达核心（经 REMOTE_ACTIONS 分发，非直调）（Tom #5）', () => {
    const store = makeStore(); makeSheet(store, PROD_TAB); makeSheet(store, BASE_TAB);
    const sand = makeDispatch(store);
    const p = seedPair(store, 3, 2, { uuid: DISP_UUID });
    // 候选须【写前一次性取用】：seedPair 返回的是活引用，写入会改写其 O 列，
    // 若写成后再重算哈希（dispCand(p) 含 hashesFor(p.target)）会带上 O=TRUE，与日志不一致。
    const cand = dispCand(p);
    const SB = TEST_JOB + '-1';
    const w = { action: 'softDelGuarded', jobId: TEST_JOB, batchId: SB, dry: '0',
      expectMasterVersion: masterVerOf(store), rows: [cand] };
    // 先无 token 触发一次以初始化 token
    sand._rtMaybeHandlePost({ postData: { contents: JSON.stringify(w) } });
    const tok = (store.props || {}).REMOTE_TOKEN;
    const wOut = JSON.parse(sand._rtMaybeHandlePost({ postData: { contents: JSON.stringify(Object.assign({}, w, { token: tok })) } }).getContent());
    const h = CORE._requestHashOf(cand);
    const sq = { action: 'statusQuery', jobId: TEST_JOB, token: tok,
      rows: [{ row: 3, subBatchId: SB, requestHash: h, uuid: DISP_UUID }] };
    const r = JSON.parse(sand._rtMaybeHandlePost({ postData: { contents: JSON.stringify(sq) } }).getContent());
    let inner = null; try { inner = JSON.parse(r.message); } catch (e) { inner = null; }
    const r0 = (inner && inner.rows ? inner.rows[0] : null) || {};
    if (process.env.DBG_S32) {
      const jt = Object.keys(store.sheets || {});
      const jn = jt.filter(k => /LOG|JOURNAL/i.test(k));
      console.log('   [DBG] sheets=' + jt.join('|'));
      console.log('   [DBG] 写响应=' + JSON.stringify(wOut || null));
      console.log('   [DBG] wantHash=' + h + ' SB=' + SB);
      jn.forEach(k => console.log('   [DBG] ' + k + ' => ' + JSON.stringify((store.sheets[k]._grid || []).slice(0, 8))));
      console.log('   [DBG] status=' + JSON.stringify(r0));
    }
    const pass = r.ok === true && !!inner && inner.action === 'statusQuery'
      && r0.state === 'COMMITTED' && r0.identity === 'BOUND';
    return { pass, detail: `分发 ok=${r.ok} action=${inner ? inner.action : '-'}；state=${r0.state} identity=${r0.identity}` };
  });

  // ---- O 类型统一：布尔 true / 字符串 'TRUE' / 'true' 三种真实返回均判成功 ----
  check('S33', "O 类型统一：回读为布尔 true / 'TRUE' / 'true' 均判成功（Tom #6）", () => {
    const variants = [true, 'TRUE', 'true'];
    const got = [];
    for (const v of variants) {
      const store = makeStore(); makeSheet(store, PROD_TAB); makeSheet(store, BASE_TAB);
      const deps = nodeDeps(store);
      const p = seedPair(store, 3, 2, { uuid: 'TS-GAS-OT' });
      const c1 = { row: 3, keeperRow: 2, uuid: 'TS-GAS-OT', level: 'A', expectHash: hashesFor(p.target, false),
        keeperHash: hashesFor(p.keeper, false), expectBaseHash: hashesFor(p.target, false) };
      // 写后回读返回指定形态（模拟 GAS getValues 的真实差异）
      const origWrite = deps.writeProdO;
      deps.writeProdO = function (row, val) { const okk = origWrite(row, val); deps.readProdO = () => v; return okk; };
      const r = JSON.parse(CORE.tsSoftDelGuardedCore({ parameter: {}, postBody: { rows: [c1], dry: '0',
        jobId: TEST_JOB, batchId: TEST_JOB + '-1', expectMasterVersion: masterVerOf(store) } }, deps));
      got.push({ v: String(v), ok: r.ok, reason: ((r.results || [])[0] || {}).reason || r.error || '-' });
    }
    const pass = got.every(g => g.ok === true);
    return { pass, detail: got.map(g => `${g.v}→ok=${g.ok}${g.ok ? '' : '(' + g.reason + ')'}`).join('；') };
  });

  // ---- 真实双执行者交错：A 持第一锁期间 B 并发调用被真实拒绝；A 完成后 B 重试成功 ----
  check('S34', '真实双执行者交错：A 持锁期间 B 并发被 LOCK_BUSY 拒；B 事后重试不得冒领成功；A 同身份重试真幂等（Tom #5）', () => {
    const store = makeStore(); makeSheet(store, PROD_TAB); makeSheet(store, BASE_TAB);
    const depsA = nodeDeps(store);
    const p = seedPair(store, 3, 2, { uuid: 'TS-GAS-CC' });
    const c1 = { row: 3, keeperRow: 2, uuid: 'TS-GAS-CC', level: 'A', expectHash: hashesFor(p.target, false),
      keeperHash: hashesFor(p.keeper, false), expectBaseHash: hashesFor(p.target, false) };
    const mv = masterVerOf(store);
    let bOut = null;
    const origM = depsA.acquireMasterLock;
    depsA.acquireMasterLock = function () {
      const l = origM();                       // A 取到第一把锁（store 级互斥生效）
      // A 尚未跑完，另一个【真实执行者 B】在同一 store 上并发发起请求
      const depsB = nodeDeps(store);
      bOut = JSON.parse(CORE.tsSoftDelGuardedCore({ parameter: {}, postBody: { rows: [c1], dry: '0',
        jobId: TEST_JOB + 'B', batchId: TEST_JOB + 'B-1', expectMasterVersion: mv } }, depsB));
      return l;
    };
    const aOut = JSON.parse(CORE.tsSoftDelGuardedCore({ parameter: {}, postBody: { rows: [c1], dry: '0',
      jobId: TEST_JOB, batchId: TEST_JOB + '-1', expectMasterVersion: mv } }, depsA));
    // A 完成后锁已释放。B 用【另一身份(jobId B)】重试：行已被 A 软标，
    //   B 无自己的完成凭据 ⇒ 必须以 ALREADY_SOFTDEL 拒绝，不得冒领 wrote:true。
    //   （先前版本断言"B 重试成功"是错的：那等于让无凭据的第三方把别人的写入记到自己账上。）
    const bAfter = JSON.parse(CORE.tsSoftDelGuardedCore({ parameter: {}, postBody: { rows: [c1], dry: '0',
      jobId: TEST_JOB + 'B', batchId: TEST_JOB + 'B-1', expectMasterVersion: mv } }, nodeDeps(store)));
    const bItem = (((bAfter.results) || [])[0]) || {};
    // A 用【同身份】重试：命中完成凭据 + 复核实时 O/UUID/keeper ⇒ 真幂等成功（wrote:true）
    const aAgain = JSON.parse(CORE.tsSoftDelGuardedCore({ parameter: {}, postBody: { rows: [c1], dry: '0',
      jobId: TEST_JOB, batchId: TEST_JOB + '-1', expectMasterVersion: mv } }, nodeDeps(store)));
    const aItem = (((aAgain.results) || [])[0]) || {};
    const bj = bOut || {};
    const pass = aOut.ok === true && bj.ok === false && /LOCK_BUSY/.test(String(bj.error || ''))
      && bAfter.ok === false && bItem.reason === 'ALREADY_SOFTDEL' && bItem.wrote !== true
      && aAgain.ok === true && aItem.idempotent === true && aItem.wrote === true;
    return { pass, detail: `A ok=${aOut.ok}；并发 B ok=${bj.ok} error=${bj.error || '-'}；`
      + `B 事后重试 ok=${bAfter.ok} reason=${bItem.reason || bAfter.error || '-'}（须 ALREADY_SOFTDEL，不得冒领）；`
      + `A 同身份重试 ok=${aAgain.ok} idempotent=${aItem.idempotent} wrote=${aItem.wrote}` };
  });

  const failed = RESULTS.filter(r => !r.pass);
  console.log('\n=== 汇总 ===');
  console.log(`${RESULTS.length - failed.length}/${RESULTS.length} 通过`);
  failed.forEach(r => console.log('  FAIL ' + r.id + ' ' + r.title));
  process.exit(failed.length ? 1 : 0);
})();
