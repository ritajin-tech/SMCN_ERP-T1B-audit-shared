// 补丁离线行为测试台（纯本地，零生产调用）
//
// 目的：把「补丁对不对」从「静态看代码」变成「跑出来给你看」。
// 用内存版表格 + 内存版锁，在 Node 的 vm 沙箱里加载 Apps Script 源码，
// 对【未打补丁的基线】与【打完 5 份补丁】跑同一组用例，直接对比行为差异。
//
// 每个变体持有完全独立的内存表与锁状态（互不污染），用例可重复跑。
//
// 用法：node tools/patch_harness.js
// 依赖：/d/AI_DATA/WorkBuddy/_ts_current_20261026/（clasp pull 的线上源码）
//       tools/v4_patches/*.patch（5 份单职责补丁）
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

// Windows 下 /d/... 会被解析成 C:\d\...，必须用盘符形式
const SRC_CANDIDATES = [
  'D:/AI_DATA/WorkBuddy/_ts_current_20261026',
  '/d/AI_DATA/WorkBuddy/_ts_current_20261026',
  'C:/Users/rita.jin/WorkBuddy/_ts_current_20261026'
];
const SRC = SRC_CANDIDATES.find(p => fs.existsSync(path.join(p, 'RemoteActions.js')));
if (!SRC) throw new Error('找不到 ts-manager 源码目录，已试：' + SRC_CANDIDATES.join(' | '));

const PATCH_DIR = path.join(__dirname, 'v4_patches');
const PATCH_ORDER = [
  'A1c_PeriodLockGuard_guardedInsert.patch',
  'A0_PeriodLockGuard_cleanupGuard.patch',
  'A1_RemoteActions_tsAppendRows.patch',
  'A1b_RemoteActions_tsPatchCells.patch',
  'A0d_RemoteActions_dupReport_deny.patch'
];
const LOAD_FILES = ['PeriodLockGuard.js', 'RemoteActions.js'];

const HEADER = ['A录入时间', 'B日期', 'C姓名', 'D类型', 'E阶段', 'F项目编号', 'G工时', 'H备注',
  'I UUID', 'J项目名', 'K', 'L', 'M', 'N', 'O软删', 'P', 'Q'];

// ---------- 每个变体一套独立的内存世界 ----------
function makeStore() {
  return { sheets: {}, lockHeld: false, lockBusy: false, lockCalls: [], observations: [] };
}

function makeSheet(store, name, header, dataRows) {
  const grid = [header.slice()].concat((dataRows || []).map(r => r.slice()));
  const cell = (r, c) => (grid[r - 1] ? grid[r - 1][c - 1] : undefined);
  const setCell = (r, c, v) => {
    while (grid.length < r) grid.push(new Array(header.length).fill(''));
    while (grid[r - 1].length < c) grid[r - 1].push('');
    grid[r - 1][c - 1] = v;
  };
  function range(r, c, nR, nC) {
    return {
      getValues: function () {
        store.observations.push({ op: 'read', row: r, col: c, nRows: nR, lockHeld: store.lockHeld });
        const out = [];
        for (let i = 0; i < nR; i++) {
          const row = [];
          for (let j = 0; j < nC; j++) row.push(cell(r + i, c + j) === undefined ? '' : cell(r + i, c + j));
          out.push(row);
        }
        return out;
      },
      getDisplayValues: function () { return this.getValues(); },
      setValues: function (vals) {
        store.observations.push({ op: 'write', row: r, col: c, nRows: nR, lockHeld: store.lockHeld });
        for (let i = 0; i < (vals || []).length; i++)
          for (let j = 0; j < (vals[i] || []).length; j++) setCell(r + i, c + j, vals[i][j]);
      },
      setValue: function (v) {
        store.observations.push({ op: 'write', row: r, col: c, nRows: 1, lockHeld: store.lockHeld });
        setCell(r, c, v);
      },
      getValue: function () { return cell(r, c) === undefined ? '' : cell(r, c); },
      clearContent: function () {},
      getBackgrounds: function () { return [['']]; },
      setBackground: function () {},
      setFontWeight: function () {},
      setNumberFormat: function () {}
    };
  }
  const sheet = {
    getName: () => name,
    getLastRow: () => grid.length,
    getLastColumn: () => Math.max.apply(null, grid.map(r => r.length)),
    getDataRange: () => range(1, 1, grid.length, Math.max.apply(null, grid.map(r => r.length))),
    appendRow: (row) => { grid.push(row.slice()); },
    getRange: (r, c, nR, nC) => range(r, c, nR || 1, nC || 1),
    insertRowsAfter: function () {},
    deleteRows: function () {},
    _grid: grid
  };
  return sheet;
}

function shimFromCode() {
  const code = fs.readFileSync(path.join(SRC, 'Code.js'), 'utf8');
  const parts = [];
  const tsId = code.match(/^var TS_ID\s*=\s*'[^']*';/m);
  if (tsId) parts.push(tsId[0]);
  const gds = code.match(/^function getDbSheet\(\)\s*\{[\s\S]*?\n\}/m);
  if (gds) parts.push(gds[0]);
  return parts.join('\n');
}

function buildVariant(files) {
  const store = makeStore();
  store.sheets['DB_工时流水'] = makeSheet(store, 'DB_工时流水', HEADER, []);
  store.sheets['_TS_LOG'] = makeSheet(store, '_TS_LOG', ['a'], []);
  store.sheets['别的页'] = makeSheet(store, '别的页', HEADER, []);

  const ss = {
    getId: () => 'mock-ss-id',
    getSheetByName: n => store.sheets[n] || null,
    getSheets: () => Object.keys(store.sheets).map(n => store.sheets[n]),
    insertSheet: n => (store.sheets[n] = makeSheet(store, n, ['a'], []))
  };
  function stubProps() {
    const m = {};
    return { getProperty: k => (k in m ? m[k] : null), setProperty: (k, v) => { m[k] = String(v); },
             deleteProperty: k => { delete m[k]; }, getProperties: () => m };
  }
  const sandbox = {
    console, JSON, Date, Math, String, Number, Boolean, Array, Object, RegExp,
    isNaN, parseInt, parseFloat, Error, TypeError,
    LockService: {
      getScriptLock: () => ({
        tryLock: function (ms) {
          store.lockCalls.push(ms);
          if (store.lockBusy) return false;
          store.lockHeld = true;
          store.observations.push({ op: 'lock_acquired', lockHeld: true });
          return true;
        },
        releaseLock: function () {
          store.lockHeld = false;
          store.observations.push({ op: 'lock_released', lockHeld: false });
        },
        hasLock: () => store.lockHeld
      })
    },
    SpreadsheetApp: {
      openById: () => ss,
      flush: function () { store.observations.push({ op: 'flush', lockHeld: store.lockHeld }); },
      getActiveSpreadsheet: () => ss,
      newDataValidation: () => ({}),
      DataValidationCriteria: {}
    },
    PropertiesService: { getDocumentProperties: stubProps, getScriptProperties: stubProps, getUserProperties: stubProps },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {} }) },
    Utilities: { sleep: () => {}, formatDate: d => String(d), computeDigest: () => [0], getUuid: () => 'mock-uuid' },
    Logger: { log: () => {} },
    MailApp: { sendEmail: () => {} },
    ScriptApp: { getScriptId: () => 'mock', newTrigger: () => ({}) }
  };
  const src = shimFromCode() + '\n;\n' + files.map(f => fs.readFileSync(f, 'utf8')).join('\n;\n');
  vm.createContext(sandbox);
  try { vm.runInContext(src, sandbox, { timeout: 20000 }); }
  catch (e) { return { store, sandbox: null, error: String(e && e.message || e) }; }
  return { store, sandbox };
}

function preparePatched(patches) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness_'));
  for (const f of LOAD_FILES) fs.copyFileSync(path.join(SRC, f), path.join(tmp, f));
  for (const p of patches) {
    execFileSync('git', ['-c', 'core.autocrlf=false', 'apply', path.join(PATCH_DIR, p)],
      { cwd: tmp, stdio: 'pipe' });
  }
  return tmp;
}

// ---------- 用例 ----------
const RESULTS = [];
function check(id, title, fn) {
  let r;
  try { r = fn(); } catch (e) { r = { pass: false, detail: 'EXCEPTION: ' + (e && e.message || e) }; }
  RESULTS.push(Object.assign({ id, title }, r));
  console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${id}  ${title}\n       ${r.detail}`);
}

const mkRow = (date, uuid, hours) => {
  const r = new Array(14).fill('');
  r[0] = '2026-10-20T00:00:00.000Z';
  r[1] = date;
  r[2] = 'Tester';
  r[5] = '26-084-HK';
  r[6] = String(hours === undefined ? 2 : hours);
  r[7] = '报价';
  r[8] = uuid;
  return r;
};

function seed(v, uuid) {
  v.store.sheets['DB_工时流水'].getRange(2, 1, 1, 14).setValues([mkRow('2026-10-08', uuid, 2)]);
  v.store.observations = [];
}

function runAppend(v, rows, opts) {
  opts = opts || {};
  const e = { parameter: {}, postBody: { rows: rows } };
  if (opts.dry) e.parameter.dry = '1';
  if (opts.force) e.parameter.force = '1';
  let j;
  try { j = JSON.parse(v.sandbox.tsAppendRows(e)); } catch (err) { j = { parseError: String(err) }; }
  return j;
}

(async () => {
  console.log('=== 补丁离线行为测试台 ===');
  console.log('源码：' + SRC);
  const patchedDir = preparePatched(PATCH_ORDER);
  console.log('补丁后源码目录：' + patchedDir + '\n');

  // A1-only：只把去重搬进锁内、不提前取锁 —— 正是 Tom Q2 警告的"半修"形态
  let a1OnlyDir = null;
  try { a1OnlyDir = preparePatched(['A1_RemoteActions_tsAppendRows.patch']); }
  catch (e) { console.log('[注意] A1-only 变体准备失败：' + String(e.stderr || e.message) + '\n'); }

  const base = buildVariant(LOAD_FILES.map(f => path.join(SRC, f)));
  const patched = buildVariant(LOAD_FILES.map(f => path.join(patchedDir, f)));
  const a1Only = a1OnlyDir ? buildVariant(LOAD_FILES.map(f => path.join(a1OnlyDir, f))) : null;
  if (!base.sandbox) { console.log('基线加载失败：' + base.error); process.exit(1); }
  if (!patched.sandbox) { console.log('补丁后加载失败：' + patched.error); process.exit(1); }
  if (a1Only && !a1Only.sandbox) { console.log('A1-only 加载失败：' + a1Only.error); a1Only = null; }
  console.log('变体加载成功（内存表与锁状态互相隔离）：' +
    ['基线', a1Only ? '仅A1' : null, '全补丁'].filter(Boolean).join(' / ') + '\n');

  // ---- T1 根因 TOCTOU：去重读 I 列时锁是否持有 ----
  check('T1', '去重读 I 列时是否持有锁（根因 TOCTOU）', () => {
    const out = {};
    for (const [name, v] of [['baseline', base], ['patched', patched]]) {
      seed(v, 'TS-AAA-1');
      runAppend(v, [mkRow('2026-10-08', 'TS-AAA-1', 2)]);
      const uuidReads = v.store.observations.filter(o => o.op === 'read' && o.col === 9);
      out[name] = { total: uuidReads.length, outside: uuidReads.filter(o => !o.lockHeld).length };
    }
    return {
      pass: out.baseline.outside > 0 && out.patched.outside === 0,
      detail: `基线：读 I 列 ${out.baseline.total} 次，${out.baseline.outside} 次在锁外（=TOCTOU 现场）；`
        + `补丁后：${out.patched.total} 次读，锁外 ${out.patched.outside} 次`
    };
  });

  // ---- T2 重复行拦下 + 新行不被误杀 ----
  check('T2', '同 UUID 二次提交被拦下，且新行不被误杀', () => {
    const out = {};
    for (const [name, v] of [['baseline', base], ['patched', patched]]) {
      seed(v, 'TS-BBB-2');
      const dup = runAppend(v, [mkRow('2026-10-08', 'TS-BBB-2', 2)]);
      v.store.observations = [];
      const fresh = runAppend(v, [mkRow('2026-10-09', 'TS-CCC-3', 3)]);
      out[name] = { dup, fresh };
    }
    const ok = out.patched.dup.wrote === 0 && out.patched.dup.skippedDup === 1
      && out.patched.fresh.wrote === 1 && out.baseline.fresh.wrote === 1;
    return {
      pass: ok,
      detail: `重复行：基线 wrote=${out.baseline.dup.wrote}/skipDup=${out.baseline.dup.skippedDup}，`
        + `补丁后 wrote=${out.patched.dup.wrote}/skipDup=${out.patched.dup.skippedDup}；`
        + `新行：基线 wrote=${out.baseline.fresh.wrote}，补丁后 wrote=${out.patched.fresh.wrote}`
    };
  });

  // ---- T3 Tom Q2：只把去重搬进锁内（不打 A1c）会连坐整批 ----
  check('T3', '[Tom Q2] 仅 A1 会连坐整批；A1+A1c 才不会', () => {
    const scenario = (v) => {
      seed(v, 'TS-DDD-4');
      const r = runAppend(v, [
        mkRow('2026-09-15', 'TS-DDD-4', 2),      // 关账期且重复 → 应先被去重跳过
        mkRow('2026-10-15', 'TS-EEE-5', 3)       // 当期新行 → 应正常写入
      ]);
      return { ok: r.ok, err: r.error, wrote: r.wrote, skipDup: r.skippedDup };
    };
    const out = { base: scenario(base), full: scenario(patched) };
    const half = a1Only ? scenario(a1Only) : null;
    const pass = half
      ? (half.wrote === undefined || half.wrote === 0) && out.full.wrote === 1 && out.full.skipDup === 1
      : out.full.wrote === 1 && out.full.skipDup === 1;
    return {
      pass,
      detail: (half
        ? `仅A1（去重进锁内但取锁不提前）：wrote=${half.wrote} err=${half.err} ← 连坐，正是 Tom Q2 的副作用；`
        : '')
        + `全补丁 A1+A1c：wrote=${out.full.wrote} skipDup=${out.full.skipDup}（重复行先去重，当期新行正常写入）`
    };
  });

  // ---- T4 fail-closed ----
  check('T4', '锁被占用时 fail-closed（报错，不静默放行）', () => {
    seed(patched, 'TS-FFF-6');
    patched.store.lockBusy = true;
    const r = runAppend(patched, [mkRow('2026-10-15', 'TS-GGG-7', 3)]);
    patched.store.lockBusy = false;
    const wrote = patched.store.observations.filter(o => o.op === 'write').length;
    return {
      pass: r.ok === false && /LOCK_BUSY/.test(String(r.error || '')) && wrote === 0,
      detail: `ok=${r.ok} error=${r.error}，期间写入次数=${wrote}（须报错且一次都不写）`
    };
  });

  // ---- T5 A0d ----
  check('T5', '[A0d] tsDupReport(fix=1) 的自动改写必须失效', () => {
    const run = (v) => { try { return JSON.parse(v.sandbox.tsDupReport({ parameter: { fix: '1' }, postBody: {} })); }
                         catch (e) { return { error: String(e && e.message || e) }; } };
    const b = run(base), p = run(patched);
    return {
      pass: p.ok === false && /DUP_FIX_DISABLED/.test(String(p.error || '')),
      detail: `基线 fix=1：ok=${b.ok}（会写 O=TRUE）｜补丁后：ok=${p.ok} error=${p.error}`
    };
  });

  // ---- T6 A1b：patchCells 无论目标页都应持锁，且值确实写进去 ----
  check('T6', '[A1b] patchCells 持锁 + 值写入正确', () => {
    patched.store.observations = [];
    let r;
    try {
      r = JSON.parse(patched.sandbox.tsPatchCells({
        parameter: {}, postBody: { cells: [[2, 15, 'TRUE']] }     // DB_工时流水 第2行 O 列
      }));
    } catch (e) { r = { error: String(e && e.message || e) }; }
    const outside = patched.store.observations.filter(o => o.op === 'write' && !o.lockHeld);
    const written = patched.store.sheets['DB_工时流水']._grid[1] ?
      patched.store.sheets['DB_工时流水']._grid[1][14] : '';
    return {
      pass: outside.length === 0 && r.ok === true && String(written) === 'TRUE',
      detail: `锁外写入=${outside.length}（须 0）；ok=${r.ok} ${r.error ? 'error=' + r.error : ''}；`
        + `O2 实际值='${written}'（须 TRUE）`
    };
  });

  // ---- T7 回归 ----
  check('T7', '回归：无 UUID 的新行不被误杀', () => {
    seed(patched, 'TS-HHH-8');
    const r = runAppend(patched, [mkRow('2026-10-16', '', 4)]);
    return { pass: r.ok === true && r.wrote === 1, detail: `ok=${r.ok} wrote=${r.wrote}` };
  });

  // ---- T8 幂等：dry 与真写判定一致 ----
  check('T8', 'dry 预演与真写的去重判定一致', () => {
    seed(patched, 'TS-III-9');
    const dry = runAppend(patched, [mkRow('2026-10-08', 'TS-III-9', 2), mkRow('2026-10-17', 'TS-JJJ-10', 5)], { dry: true });
    const count = { dry: dry.wouldWrite };
    seed(patched, 'TS-III-9');
    const real = runAppend(patched, [mkRow('2026-10-08', 'TS-III-9', 2), mkRow('2026-10-17', 'TS-JJJ-10', 5)]);
    count.real = real.wrote;
    return {
      pass: count.dry === 1 && count.real === 1,
      detail: `dry 预演 wouldWrite=${count.dry}，真写 wrote=${count.real}（须一致，dry 才可信）`
    };
  });

  // ---- T9/T10/T11 A0 清理护栏：CAS 必须拒掉被改过/已消失的目标行 ----
  const sh = () => patched.store.sheets['DB_工时流水'];
  const rowOf = (uuid) => {
    const g = sh()._grid;
    for (let i = 1; i < g.length; i++) if (String(g[i][8] || '').trim() === uuid) return { idx: i, data: g[i] };
    return null;
  };
  const hashOf = (uuid) => {
    const r = rowOf(uuid); if (!r) return null;
    return patched.sandbox._tsRowPayloadHash(r.data);
  };

  check('T9', '[A0] 护栏 dry-run：只校验不写入', () => {
    seed(patched, 'TS-KKK-11');
    patched.store.observations = [];
    const h = hashOf('TS-KKK-11');
    const r = patched.sandbox._tsGuardedCleanup({ sheet: sh(), expect: [{ uuid: 'TS-KKK-11', payloadHash: h }], dry: true });
    const writes = patched.store.observations.filter(o => o.op === 'write').length;
    return {
      pass: r.ok === true && r.dry === true && r.matched.length === 1 && writes === 0,
      detail: `ok=${r.ok} dry=${r.dry} matched=${(r.matched || []).length}，写入次数=${writes}（dry 必须零写入）`
    };
  });

  check('T10', '[A0] CAS 拒掉「目标行已被改动」', () => {
    seed(patched, 'TS-LLL-12');
    const h = hashOf('TS-LLL-12');
    // 篡改：把该行工时从 2 改成 99（模拟校验后被别人改过）
    const r0 = rowOf('TS-LLL-12');
    sh().getRange(r0.idx + 1, 7).setValue('99');
    patched.store.observations = [];
    const r = patched.sandbox._tsGuardedCleanup({
      sheet: sh(), expect: [{ uuid: 'TS-LLL-12', payloadHash: h }], dry: false
    });
    const writes = patched.store.observations.filter(o => o.op === 'write').length;
    const mm = (r.mismatched || [])[0] || {};
    return {
      pass: r.ok === false && r.reason === 'PL_REJECT_CLEANUP_CAS_FAILED'
        && mm.reason === 'PL_REJECT_PAYLOAD_CHANGED' && writes === 0,
      detail: `ok=${r.ok} reason=${r.reason}，首条 mismatch=${mm.reason}，写入次数=${writes}（必须整批拒下且一次不写）`
    };
  });

  check('T11', '[A0] CAS 拒掉「目标行已消失」', () => {
    seed(patched, 'TS-MMM-13');
    const h = hashOf('TS-MMM-13');
    const r = patched.sandbox._tsGuardedCleanup({
      sheet: sh(), expect: [{ uuid: 'TS-NOPE-14', payloadHash: h }], dry: false
    });
    const mm = (r.mismatched || [])[0] || {};
    return {
      pass: r.ok === false && mm.reason === 'PL_REJECT_ROW_GONE',
      detail: `ok=${r.ok} reason=${r.reason}，首条 mismatch=${mm.reason}（行没了必须拒，不能静默跳过）`
    };
  });

  const failed = RESULTS.filter(r => !r.pass);
  console.log('\n=== 汇总 ===');
  console.log(`${RESULTS.length - failed.length}/${RESULTS.length} 通过`);
  failed.forEach(r => console.log('  FAIL ' + r.id + ' ' + r.title));
  console.log('\n补丁后源码：' + patchedDir + '（可 diff 复核）');
  process.exit(failed.length ? 1 : 0);
})();
