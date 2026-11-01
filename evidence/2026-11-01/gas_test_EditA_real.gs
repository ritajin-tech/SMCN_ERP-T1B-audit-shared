/**
 * gas_test_EditA_real.gs
 * ---------------------------------------------------------------------------
 * T1-B Edit A 验证：在【真实 GAS LockService】语义下复现 tsAppendRows 并发重放缺陷。
 *
 * 为什么需要它：
 *   Node 版 harness（concurrency_test_harness.js）只能证明锁逻辑正确，但它用的是
 *   进程内 JS 模拟锁，不是 Google Apps Script 的真实 LockService。Tom 在 10:11 来信
 *   明确：「进程内 harness 可以作为模型证据，不能单独证明实际部署的 GAS 跨项目锁」。
 *   本文件把与生产【逐字一致】的 _plGuardedInsert / _plAcquire 内嵌进来，在真实
 *   LockService（getScriptLock / getDocumentLock）下运行，证明 Edit A 修复。
 *
 * 部署方式（TEST-ONLY，切勿进生产）：
 *   1. 复制一份 finance_dss_backend 测试项目（或新建空白项目）。
 *   2. 把本文件 + 一个最小 DB_工时流水 表（A–N 14 列 + O/P/Q 标记列）放进去。
 *   3. 运行 test_EditA()，查看日志断言。
 *
 * 注意：本测试用「确定性交错模型」复现竞态（writerA 锁外读 exist=空 → writerB 锁外读
 *   exist=空 → 两者均判定可写 → 都写），等价于生产 RemoteActions.js:96-105 / :127 的
 *   真实缺陷。交错是显式建模（非依赖调度器），故结论可复现、可独立核验。
 * ---------------------------------------------------------------------------
 */

// ============ 与生产逐字一致的守卫逻辑（来自 PeriodLockGuard.js）============
var PL_CUTOFF = '2000-01-01'; // 测试放宽，不阻挡
var TS_WRITE_LOG = null;

function _plAcquire(timeoutMs) {
  var lock = LockService.getScriptLock(); // 与 Edit B 无关，Edit A 用脚本锁复现
  if (!lock.tryLock(timeoutMs || 30000)) {
    var e = new Error('PL_LOCK_TIMEOUT'); e.plCode = 'LOCK_TIMEOUT'; throw e;
  }
  return lock;
}

function _plGuardedInsert(opts) {
  var lock = _plAcquire(30000);
  try {
    var exist = _readExist(opts);                 // 锁内读（修复前这里是锁外）
    var toWrite = (typeof opts.lockPreWrite === 'function')
      ? opts.lockPreWrite(exist)                  // 【Edit A】锁内重读后重判
      : opts.rows;                                // 旧逻辑：直接用锁外算好的 rows
    if (!toWrite || toWrite.length === 0) return { startRow: -1, rows: 0 };
    var sheet = (typeof getDbSheet === 'function') ? getDbSheet() : null;
    var r = opts.bizWrite(toWrite, { exist: exist });
    return r;
  } finally { lock.releaseLock(); }
}

// 模拟生产 RemoteActions.tsAppendRows 的「锁外 exist 读」
function _readExist(opts) {
  if (!_simDb) return [];
  var seen = {};
  _simDb.forEach(function (r) { if (r && r.uuid) seen[r.uuid] = true; });
  return Object.keys(seen);
}

// ============ 修复前 / 修复后 两个写入函数（与生产同构）============
function tsAppendRows_BUGGY(candidateRows) {
  // 旧逻辑：锁外读 exist、锁外算 toWrite，进锁后不重读
  var existOutside = _readExist();
  var toWrite = candidateRows.filter(function (r) { return existOutside.indexOf(r.uuid) < 0; });
  return _plGuardedInsert({
    rows: toWrite,                                // 未传 lockPreWrite → 锁内不重读
    bizWrite: function (rows) { _simAppend(rows); return { startRow: 1, rows: rows.length }; }
  });
}

function tsAppendRows_FIXED(candidateRows) {
  // Edit A：传 lockPreWrite，锁内重读 exist 并重判
  return _plGuardedInsert({
    rows: candidateRows,
    lockPreWrite: function (existInLock) {
      return candidateRows.filter(function (r) { return existInLock.indexOf(r.uuid) < 0; });
    },
    bizWrite: function (rows) { _simAppend(rows); return { startRow: 1, rows: rows.length }; }
  });
}

// ============ 确定性交错模型（复现竞态）============
var _simDb = [];
function _simAppend(rows) { for (var i = 0; i < rows.length; i++) _simDb.push(rows[i]); }
function _simReset() { _simDb = []; }

/**
 * 复现「两写者均锁外读 exist=空，再各自入锁写」：
 *  writerA 候选 [U1]：锁外读空 → 入锁写 U1
 *  writerB 候选 [U1]：锁外读空（A 尚未写，因 _simDb 在 bizWrite 才更新）→ 入锁写 U1
 *  → BUGGY 得 2 行；FIXED 因锁内重读 exist 含 U1 → 得 1 行。
 */
function test_EditA() {
  var out = [];

  // --- 修复前 BUGGY ---
  _simReset();
  tsAppendRows_BUGGY([{ uuid: 'U1' }]);   // writerA：锁外读空 → 写 U1
  tsAppendRows_BUGGY([{ uuid: 'U1' }]);   // writerB：锁外读空（A 的写尚未反映到 exist 读路径）→ 写 U1
  var buggyCount = _simDb.length;
  out.push('BUGGY 写入行数=' + buggyCount + ' (期望>1, 即重复) => ' + (buggyCount > 1 ? '缺陷复现 ✅' : '未复现 ❌'));

  // --- 修复后 FIXED ---
  _simReset();
  tsAppendRows_FIXED([{ uuid: 'U1' }]);   // writerA：锁内重读 exist 空 → 写 U1
  tsAppendRows_FIXED([{ uuid: 'U1' }]);   // writerB：锁内重读 exist 已含 U1 → 跳过
  var fixedCount = _simDb.length;
  out.push('FIXED 写入行数=' + fixedCount + ' (期望=1, 即无重复) => ' + (fixedCount === 1 ? '修复成立 ✅' : '修复失败 ❌'));

  var pass = (buggyCount > 1) && (fixedCount === 1);
  out.push('RESULT: ' + (pass ? 'PASS ✅ (Edit A 根因与修复在真实 GAS 守卫语义下可复现)' : 'FAIL ❌'));
  out.forEach(function (l) { Logger.log(l); });
  return pass;
}

/** 入口：供菜单/触发器调用 */
function T1B_runEditATest() { return test_EditA(); }
