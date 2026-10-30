'use strict';
// 独立 mock 测试（Tom 反复要求"未独立复测"）：用内存依赖桩证明 ts_softdel_core 的双阶段预检语义。
// 不依赖任何生产/hktool/网络；只验证"全体预检通过才写 / 任一预检失败整批零写"这一核心不变量。
const norm = require('./ts_softdel_norm.js');
const core = require('./ts_softdel_core.js');

let PROD_ROWS = {};   // row -> 15-col array
let PROD_O = {};      // row -> O 列值
let MASTER_MAP = {};  // uuid -> [{cells:[...]}]
let WRITE_COUNT = 0;

function mkCells(uuid, bizDate, oVal) {
  const a = new Array(15).fill('');
  a[1] = bizDate; a[8] = uuid; a[14] = oVal;
  return a;
}

function makeDeps() {
  const journal = [];
  return {
    PL_DB_SHEET: 'DB_工时流水',
    journalAppend(rec) { journal.push(rec); return true; },
    journalList(jobId, itemId) { return journal.filter(r => r.jobId === jobId && r.itemId === itemId); },
    journalGet(jobId, itemId) {
      const arr = journal.filter(r => r.jobId === jobId && r.itemId === itemId);
      return arr.length ? arr[arr.length - 1] : null;
    },
    acquireMasterLock() { return 'mlock'; },
    releaseMasterLock() {},
    acquireLock() { return 'lock'; },
    releaseLock() {},
    guardCheck() { return { ok: true }; },
    policy() { return {}; },
    isClearance() { return false; },
    readAllMaster() { return { complete: true, version: 'V1', map: MASTER_MAP }; },
    readProdO(row) { return PROD_O[row]; },
    readProdRow(row) { return PROD_ROWS[row]; },
    writeProdO(row, val) { WRITE_COUNT++; PROD_O[row] = val; return true; },
  };
}

function buildBatch(specs) {
  // specs: [{row, keeperRow, uuid, level, drift?}]
  const rows = specs.map(s => {
    // T1-B 双录入本质：target / keeper / 底稿 三者【同 uuid】、仅行号与 O 列不同（O 在 0–13 比较范围外）。
    const tCells = mkCells(s.uuid, '2026-04-15', 'FALSE');
    const kCells = mkCells(s.uuid, '2026-04-15', 'FALSE');
    const bCells = mkCells(s.uuid, '2026-04-15', 'FALSE');
    const item = {
      row: s.row, uuid: s.uuid, keeperRow: s.keeperRow, level: s.level,
      expectHash: norm._sdRowHash(tCells, false),
      keeperHash: norm._sdRowHash(kCells, false),
    };
    if (s.level === 'A') item.expectBaseHash = norm._sdRowHash(bCells, false);
    PROD_ROWS[s.row] = tCells;
    PROD_ROWS[s.keeperRow] = kCells;
    PROD_O[s.row] = 'FALSE';
    PROD_O[s.keeperRow] = 'FALSE';
    MASTER_MAP[s.uuid] = [{ cells: bCells }];
    if (s.drift) {
      // 制造 UUID_DRIFT：live 目标行 UUID 与申报不符
      PROD_ROWS[s.row] = mkCells(s.uuid + '_WRONG', '2026-04-15', 'FALSE');
    }
    return item;
  });
  return rows;
}

function run(label, specs, dry) {
  WRITE_COUNT = 0;
  const deps = makeDeps();
  const rows = buildBatch(specs);
  const e = { postBody: { action: 'softDelGuarded', sheet: 'DB_工时流水', dry: dry,
    expectMasterVersion: 'V1', jobId: 'JTEST_' + label, batchId: 'BTEST', rows } };
  const res = JSON.parse(core.tsSoftDelGuardedCore(e, deps));
  return { res, writes: WRITE_COUNT };
}

let fails = 0;
function assert(cond, msg) { if (!cond) { console.log('  FAIL: ' + msg); fails++; } else { console.log('  ok: ' + msg); } }

console.log('=== 测试1：全体预检通过（非 dry）=> 全写 ===');
{
  const { res, writes } = run('T1', [
    { row: 2, keeperRow: 3, uuid: 'U-AAA', level: 'A' },
    { row: 4, keeperRow: 5, uuid: 'U-BBB', level: 'A' },
  ], false);
  assert(res.ok === true, '批次 ok=true');
  assert(res.patched === 2, 'patched=2 (got ' + res.patched + ')');
  assert(writes === 2, 'writeProdO 被调用 2 次 (got ' + writes + ')');
}

console.log('=== 测试2：一个目标预检失败（UUID_DRIFT）=> 整批零写 ===');
{
  const { res, writes } = run('T2', [
    { row: 2, keeperRow: 3, uuid: 'U-AAA', level: 'A' },
    { row: 4, keeperRow: 5, uuid: 'U-BBB', level: 'A', drift: true },
  ], false);
  assert(res.ok === false, '批次 ok=false');
  assert(writes === 0, 'writeProdO 零调用 (got ' + writes + ') — 核心不变量：预检失败整批不写');
  const r2 = res.results.find(r => r.row === 2);
  const r4 = res.results.find(r => r.row === 4);
  assert(r4 && r4.reason === 'UUID_DRIFT', '失败目标记 UUID_DRIFT');
  assert(r2 && r2.reason === 'BATCH_REJECTED_PRECHECK', '通过目标记 BATCH_REJECTED_PRECHECK（未写）');
}

console.log('=== 测试3：全体通过但 dry=true => 零写、ok=true ===');
{
  const { res, writes } = run('T3', [
    { row: 2, keeperRow: 3, uuid: 'U-AAA', level: 'A' },
    { row: 4, keeperRow: 5, uuid: 'U-BBB', level: 'A' },
  ], true);
  assert(res.ok === true, '批次 ok=true');
  assert(writes === 0, 'dry 下 writeProdO 零调用 (got ' + writes + ')');
  assert(res.patched === 0, 'dry 下 patched=0');
}

console.log('=== 测试4：PERIOD_LOCKED 命中 => 整批零写 ===');
{
  // 用 guardCheck 返回 ok:false 且不放行 clearance => 第二目标锁拒绝
  WRITE_COUNT = 0;
  const deps = makeDeps();
  deps.guardCheck = () => ({ ok: false, reason: 'PERIOD_LOCKED' });
  const rows = buildBatch([
    { row: 2, keeperRow: 3, uuid: 'U-AAA', level: 'A' },
    { row: 4, keeperRow: 5, uuid: 'U-BBB', level: 'A' },
  ]);
  const e = { postBody: { action: 'softDelGuarded', sheet: 'DB_工时流水', dry: false,
    expectMasterVersion: 'V1', jobId: 'JTEST_T4', batchId: 'BTEST', rows } };
  const res = JSON.parse(core.tsSoftDelGuardedCore(e, deps));
  assert(res.ok === false, '批次 ok=false');
  assert(WRITE_COUNT === 0, 'writeProdO 零调用 (got ' + WRITE_COUNT + ')');
  const anyWrote = res.results.some(r => r.wrote === true);
  assert(!anyWrote, '无任何目标被写入（无 wrote:true）— 预检期锁失败整批零写');
}

console.log('=== 测试5：第二目标 PREPARED_LOG_FAILED => 首目标写成功、第二 UNKNOWN、第三 NOT_ATTEMPTED（Tom W 批·点③ 停止闸门）===');
{
  // 3 目标；仅第二目标(itemId=4)的 PREPARED 日志写失败 -> 触发 writeStopped
  const deps = makeDeps();
  deps.journalAppend = (rec) => { if (rec.state === 'PREPARED' && rec.itemId === 4) throw new Error('simulated log write failure'); return true; };
  WRITE_COUNT = 0;
  const rows = buildBatch([
    { row: 2, keeperRow: 3, uuid: 'U-AAA', level: 'A' },
    { row: 4, keeperRow: 5, uuid: 'U-BBB', level: 'A' },
    { row: 6, keeperRow: 7, uuid: 'U-CCC', level: 'A' },
  ]);
  const e = { postBody: { action: 'softDelGuarded', sheet: 'DB_工时流水', dry: false,
    expectMasterVersion: 'V1', jobId: 'JTEST_T5', batchId: 'BTEST', rows } };
  const res = JSON.parse(core.tsSoftDelGuardedCore(e, deps));
  assert(res.ok === false, '批次 ok=false');
  assert(WRITE_COUNT === 1, '仅首目标实际写入 1 次 (got ' + WRITE_COUNT + ')');
  const r2 = res.results.find(r => r.row === 2);
  const r4 = res.results.find(r => r.row === 4);
  const r6 = res.results.find(r => r.row === 6);
  assert(r2 && r2.wrote === true && (r2.state === 'CONFIRMED_SUCCESS' || r2.state === 'COMMITTED'), '首目标已确认成功(CONFIRMED_SUCCESS/COMMITTED)');
  assert(r4 && r4.reason === 'PREPARED_LOG_FAILED' && r4.state === 'UNCONFIRMED', '第二目标 PREPARED_LOG_FAILED/UNCONFIRMED');
  assert(r6 && r6.reason === 'BATCH_STOPPED_NOT_ATTEMPTED' && r6.state === 'NOT_ATTEMPTED', '第三目标停止未尝试(NOT_ATTEMPTED)');
}

console.log('=== 测试6：首目标写入异常(WRITE_FLUSH_EXCEPTION) => 首 UNKNOWN、后续 NOT_ATTEMPTED（Tom W 批·点③ 停止闸门）===');
{
  const deps = makeDeps();
  deps.writeProdO = (row, val) => { if (row === 2) throw new Error('simulated flush failure'); WRITE_COUNT++; PROD_O[row] = val; return true; };
  WRITE_COUNT = 0;
  const rows = buildBatch([
    { row: 2, keeperRow: 3, uuid: 'U-AAA', level: 'A' },
    { row: 4, keeperRow: 5, uuid: 'U-BBB', level: 'A' },
    { row: 6, keeperRow: 7, uuid: 'U-CCC', level: 'A' },
  ]);
  const e = { postBody: { action: 'softDelGuarded', sheet: 'DB_工时流水', dry: false,
    expectMasterVersion: 'V1', jobId: 'JTEST_T6', batchId: 'BTEST', rows } };
  const res = JSON.parse(core.tsSoftDelGuardedCore(e, deps));
  assert(res.ok === false, '批次 ok=false');
  assert(WRITE_COUNT === 0, '首目标写抛异常、零成功写入 (got ' + WRITE_COUNT + ')');
  const r2 = res.results.find(r => r.row === 2);
  const r4 = res.results.find(r => r.row === 4);
  const r6 = res.results.find(r => r.row === 6);
  assert(r2 && r2.reason === 'WRITE_FLUSH_EXCEPTION' && r2.state === 'UNKNOWN', '首目标写入异常/UNKNOWN（不谎称成功）');
  assert(r4 && r4.state === 'NOT_ATTEMPTED', '第二目标未尝试(NOT_ATTEMPTED)');
  assert(r6 && r6.state === 'NOT_ATTEMPTED', '第三目标未尝试(NOT_ATTEMPTED)');
}

console.log('\n' + (fails ? ('FAIL: ' + fails + ' 项') : 'PASS: 双阶段预检 + 写停止闸门不变量全部成立（全体通过才写 / 任一失败整批零写 / 首失败即停后续 NOT_ATTEMPTED）'));
process.exit(fails ? 1 : 0);
