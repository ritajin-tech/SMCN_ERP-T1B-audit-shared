'use strict';
// Tom 第十轮 #1/#2/#3 的【真实 core 调用路径】集成负例：
//   证明当 deps.isClearance 返回结构化拒绝对象（{ok:false, reason}）、或抛异常时，
//   ts_softdel_core 不会绕过期锁、不会写生产，且两把锁都被释放。
// 全部为内存替身（非生产）；不构成隔离/生产状态证明。
const norm = require('./ts_softdel_norm.js');
const core = require('./ts_softdel_core.js');
const cl = require('./ts_clearance.js');

let PROD_ROWS = {}, PROD_O = {}, MASTER_MAP = {}, WRITE_COUNT = 0;
let LOCK_LOG = [];   // 记录 acquire/release，用于证明 #2 异常时锁必被释放

const SECRET = 'integration-secret';
const MASTER_VERSION = 'V1';

function mkCells(uuid, bizDate, oVal) {
  const a = new Array(15).fill('');
  a[1] = bizDate; a[8] = uuid; a[14] = oVal;
  return a;
}

function buildBatch(specs) {
  PROD_ROWS = {}; PROD_O = {}; MASTER_MAP = {};
  return specs.map(s => {
    const tCells = mkCells(s.uuid, '2026-04-15', 'FALSE');
    const kCells = mkCells(s.uuid, '2026-04-15', 'FALSE');
    const bCells = mkCells(s.uuid, '2026-04-15', 'FALSE');
    const item = {
      row: s.row, uuid: s.uuid, keeperRow: s.keeperRow, level: s.level,
      expectHash: norm._sdRowHash(tCells, false),
      keeperHash: norm._sdRowHash(kCells, false),
      expectBaseHash: norm._sdRowHash(bCells, false),
    };
    PROD_ROWS[s.row] = tCells;
    PROD_ROWS[s.keeperRow] = kCells;
    PROD_O[s.row] = 'FALSE';
    PROD_O[s.keeperRow] = 'FALSE';
    MASTER_MAP[s.uuid] = [{ cells: bCells }];
    return item;
  });
}

// deps 工厂。opts:
//   - clearance: 无/令牌字符串；- isClearanceImpl: 覆盖实现；- now: 注入时钟
function makeDeps(opts) {
  opts = opts || {};
  const journal = [];
  const store = opts.store || cl.makeStore();
  return {
    PL_DB_SHEET: 'DB_工时流水',
    journalAppend(rec) { journal.push(rec); return true; },
    journalList(jobId, itemId) { return journal.filter(r => r.jobId === jobId && r.itemId === itemId); },
    journalGet(jobId, itemId) {
      const arr = journal.filter(r => r.jobId === jobId && r.itemId === itemId);
      return arr.length ? arr[arr.length - 1] : null;
    },
    acquireMasterLock() { LOCK_LOG.push('acquire:master'); return { id: 'M_LOCK', held: true, released: false }; },
    releaseMasterLock(h) { LOCK_LOG.push('release:master'); },
    // 返回【已持有】的句柄 —— Tom #3 要求 core 交给 isClearance 的是同一把锁
    acquireLock() { LOCK_LOG.push('acquire:guard'); return { id: 'GUARD_LOCK', held: true, released: false }; },
    releaseLock(h) { LOCK_LOG.push('release:guard'); },
    // 期锁：恒定锁定 —— 只有 clearance 放行才允许写
    guardCheck() { return { ok: false, reason: 'PERIOD_LOCKED' }; },
    policy() { return {}; },
    isClearance(tok, rows, ctx) {
      if (opts.isClearanceImpl) return opts.isClearanceImpl(tok, rows, ctx);
      // 真实实现：服务端派生作用域已在 core 锁内算好并随 ctx 传入
      return cl.consumeClearance(tok, Object.assign({}, ctx, {
        lockId: 'GUARD_LOCK', store: store, secret: SECRET, consumer: 'exec1',
        now: opts.now != null ? opts.now : NOW,
      }));
    },
    readAllMaster() { return { complete: true, version: MASTER_VERSION, map: MASTER_MAP }; },
    readProdO(row) { return PROD_O[row]; },
    readProdRow(row) { return PROD_ROWS[row]; },
    writeProdO(row, val) { WRITE_COUNT++; PROD_O[row] = val; return true; },
  };
}

const NOW = 1_700_000_000_000;
const SPECS = [{ row: 2, keeperRow: 3, uuid: 'U-AAA', level: 'A' }];

function run(label, opts) {
  WRITE_COUNT = 0; LOCK_LOG = [];
  const rows = buildBatch(SPECS);
  const deps = makeDeps(opts);
  const e = { postBody: { action: 'softDelGuarded', sheet: 'DB_工时流水', dry: false,
    expectMasterVersion: MASTER_VERSION, jobId: 'JCLEAR_' + label, batchId: 'BTEST',
    rows: rows, clearance: opts.clearance } };
  const res = JSON.parse(core.tsSoftDelGuardedCore(e, deps));
  return { res, writes: WRITE_COUNT, locks: LOCK_LOG.slice() };
}

// 服务端派生作用域（与 core 内部口径一致）
function serverDerivedScope(rows) {
  return {
    rowSetDigest: core._rowSetDigestOf(rows),
    snapshotFingerprint: norm._sdSha256(JSON.stringify({ v: MASTER_VERSION })),
  };
}

function issueToken(opts) {
  const rows = buildBatch(SPECS);
  const sc = serverDerivedScope(rows);
  const store = opts.store || cl.makeStore();
  const r = cl.issueClearance({
    signer: 'rita', jobId: opts.jobId, ...sc,
    ttlMinutes: opts.ttlMinutes != null ? opts.ttlMinutes : 15,
    secret: SECRET, store: store, now: NOW,
  });
  return { token: r.token, nonce: r.nonce, store: store, rows: rows, scope: sc };
}

let fails = 0;
function assert(cond, msg) { if (!cond) { console.log('  FAIL: ' + msg); fails++; } else { console.log('  ok: ' + msg); } }

console.log('=== 集成1：无 clearance + 期锁锁定 → PERIOD_LOCKED、零写 ===');
{
  const { res, writes, locks } = run('NONE', {});
  assert(res.ok === false, '批次 ok=false');
  assert(res.results[0] && res.results[0].reason === 'PERIOD_LOCKED', '逐项 PERIOD_LOCKED');
  assert(writes === 0, '零生产写 (got ' + writes + ')');
  assert(locks.filter(x => x === 'release:guard').length === 1, 'guard 锁被释放 1 次');
  assert(locks.filter(x => x === 'release:master').length === 1, 'master 锁被释放 1 次');
}

console.log('=== 集成2：有效 clearance → 放行（证明 #1 严格契约不会误伤真 ok）===');
{
  const t = issueToken({ jobId: 'JCLEAR_OK' });
  const { res, writes } = run('OK', { clearance: t.token, store: t.store, now: NOW + 1000 });
  assert(res.ok === true, '批次 ok=true（clearance 放行）got=' + JSON.stringify(res).slice(0, 160));
  assert(writes === 1, '目标被写 1 次 (got ' + writes + ')');
}

console.log('=== 集成3（Tom #1）：isClearance 返回 {ok:false} 对象 → 不得绕过、零写 ===');
{
  const { res, writes } = run('OBJFALSE', { clearance: 'tok', isClearanceImpl: () => ({ ok: false, reason: 'REVOKED' }) });
  assert(res.ok === false, '批次 ok=false');
  assert(res.results[0] && res.results[0].reason === 'PERIOD_LOCKED', '仍判 PERIOD_LOCKED（对象 truthy 未绕过期锁）');
  assert(writes === 0, '零生产写 (got ' + writes + ')');
}

console.log('=== 集成4（Tom #1）：返回 ok:"true" 字符串 → 拒绝 ===');
{
  const { res, writes } = run('STRTRUE', { clearance: 'tok', isClearanceImpl: () => ({ ok: 'true' }) });
  assert(res.ok === false, '批次 ok=false');
  assert(writes === 0, '零生产写 (got ' + writes + ')');
}

console.log('=== 集成5（Tom #2）：isClearance 抛异常 → fail-closed 且两把锁都释放 ===');
{
  const { res, writes, locks } = run('THROW', { clearance: 'tok', isClearanceImpl: () => { throw new Error('boom'); } });
  assert(res.ok === false, '批次 ok=false（异常≠放行）');
  assert(writes === 0, '零生产写 (got ' + writes + ')');
  assert(locks.filter(x => x === 'release:guard').length === 1, 'guard 锁仍被释放（不再悬挂）');
  assert(locks.filter(x => x === 'release:master').length === 1, 'master 锁仍被释放（不再悬挂）');
}

console.log('=== 集成6：真实拒绝路径 —— 过期 → 零写 ===');
{
  const t = issueToken({ jobId: 'JCLEAR_EXP', ttlMinutes: 15 });
  const { res, writes } = run('EXP', { clearance: t.token, store: t.store, now: NOW + 16 * 60 * 1000 });
  assert(res.ok === false, '批次 ok=false');
  assert(writes === 0, '零生产写 (got ' + writes + ')');
}

console.log('=== 集成7：真实拒绝路径 —— 撤销 → 零写 ===');
{
  const t = issueToken({ jobId: 'JCLEAR_REV' });
  const held = cl.makeHeldLock('GUARD_LOCK');
  cl.revokeClearance(t.token, { secret: SECRET, store: t.store, lock: held, now: NOW + 500 });
  const { res, writes } = run('REV', { clearance: t.token, store: t.store, now: NOW + 1000 });
  assert(res.ok === false, '批次 ok=false');
  assert(writes === 0, '零生产写 (got ' + writes + ')');
}

console.log('=== 集成8：真实拒绝路径 —— 重放（二次消费同 token）→ 零写 ===');
{
  // jobId 必须与该次批次一致（core 的 jobId = 'JCLEAR_' + label），否则服务端派生作用域会判 SCOPE_MISMATCH
  const t = issueToken({ jobId: 'JCLEAR_REPLAY1' });
  const r1 = run('REPLAY1', { clearance: t.token, store: t.store, now: NOW + 1000 });
  assert(r1.res.ok === true && r1.writes === 1, '首次放行并写 1 次');
  const r2 = run('REPLAY2', { clearance: t.token, store: t.store, now: NOW + 2000 });
  assert(r2.res.ok === false, '重放批次 ok=false');
  assert(r2.writes === 0, '重放零生产写 (got ' + r2.writes + ')');
}

console.log('=== 集成9（Tom #3）：core 未提供持锁句柄 → clearance 拒绝、零写 ===');
{
  // 模拟「传入了非句柄/未持锁对象」：core 把 acquireLock 返回值直传，此处返回字符串 → LOCK_MISSING
  let plus = 0;
  const rows = buildBatch(SPECS);
  const t = issueToken({ jobId: 'JCLEAR_NOLOCK' });
  const fakeDeps = Object.assign(makeDeps({ clearance: t.token, store: t.store, now: NOW + 1000 }), {
    acquireLock() { return 'NOT_A_HANDLE'; },
  });
  WRITE_COUNT = 0; LOCK_LOG = [];
  const res = JSON.parse(core.tsSoftDelGuardedCore({ postBody: {
    action: 'softDelGuarded', sheet: 'DB_工时流水', dry: false, expectMasterVersion: MASTER_VERSION,
    jobId: 'JCLEAR_NOLOCK', batchId: 'BTEST', rows: rows, clearance: t.token,
  } }, fakeDeps));
  assert(res.ok === false, '批次 ok=false（锁句柄缺失 → clearance 拒绝）');
  assert(WRITE_COUNT === 0, '零生产写 (got ' + WRITE_COUNT + ')');
}

console.log('=== 集成10：缺失 isClearance 依赖 → CLEARANCE_DEP_MISSING、零写 ===');
{
  const rows = buildBatch(SPECS);
  const deps = makeDeps({});
  delete deps.isClearance;
  WRITE_COUNT = 0; LOCK_LOG = [];
  const res = JSON.parse(core.tsSoftDelGuardedCore({ postBody: {
    action: 'softDelGuarded', sheet: 'DB_工时流水', dry: false, expectMasterVersion: MASTER_VERSION,
    jobId: 'JCLEAR_DEPMISS', batchId: 'BTEST', rows: rows, clearance: 'sometoken',
  } }, deps));
  assert(res.error === 'CLEARANCE_DEP_MISSING', '报 CLEARANCE_DEP_MISSING (got ' + res.error + ')');
  assert(WRITE_COUNT === 0, '零生产写');
}

console.log('\n=== Tom 第十轮 core 集成负例 ===');
console.log(fails === 0 ? '结果：全部 PASS' : '结果：' + fails + ' 项 FAIL');
process.exit(fails === 0 ? 0 : 1);
