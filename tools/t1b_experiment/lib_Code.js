/**
 * T1-B 阶段B 非生产实验 · 共享锁库（E2/E3 落地原型）
 * 被 writerA / writerB 两个独立项目共同引用 -> 二者调用 acquireLock 锁定的是"本库脚本域"，跨项目互斥成立。
 * 冻结状态 TS_WRITE_FREEZE 与写者注册表存于单一共享配置表（E3 单一受信源），杜绝"同名 Script Properties 各自为政"。
 * 纯非生产；不读主库/生产表；仅读写传入的测试表 ssId。表内只用默认 Sheet1（config 在固定格、log 追加于下方）。
 *
 * v2 修订（响应 Tom 09:03Z 静态评审）：
 *  - readFreeze 改为三态状态机（ON/OFF/UNKNOWN），UNKNOWN 一律 fail-closed 拒写（修复发现#1）
 *  - acquireLock 返回可释放的锁柄；新增 releaseLock，调用方显式释放（修复发现#3）
 *  - 新增 guardedWrite：锁 + 冻结闸(guardCheck) + 实际受保护写 同域绑定，失败/冻结一律不进入写（修复发现#4）
 */
var SHARED_LOCK_DOMAIN = 't1b-exp-guard';
var FREEZE_ON = 1, FREEZE_OFF = 0, FREEZE_UNKNOWN = -1;

function _sheet(ssId) { return SpreadsheetApp.openById(ssId).getSheets()[0]; }

// E2: 跨项目共享锁。返回 {ok, lock, domain, t}；调用方必须配对调用 releaseLock(handle)。
function acquireLock(domain, holdMs) {
  var lock = LockService.getScriptLock();
  try {
    var ok = lock.tryLock(holdMs || 30000);
    return { ok: ok, lock: ok ? lock : null, domain: domain, t: new Date().toISOString() };
  } catch (e) {
    return { ok: false, lock: null, error: String(e), domain: domain, t: new Date().toISOString() };
  }
}
function releaseLock(handle) {
  if (handle && handle.lock) {
    try { handle.lock.releaseLock(); return { released: true, t: new Date().toISOString() }; }
    catch (e) { return { released: false, error: String(e), t: new Date().toISOString() }; }
  }
  return { released: false, t: new Date().toISOString() };
}

// E3: 严格三态冻结状态机（修复发现#1：空值/错误类型/未知形态一律 UNKNOWN 拒写）
function readFreeze(ssId) {
  var v;
  try { v = _sheet(ssId).getRange('A1').getValue(); }
  catch (e) { return FREEZE_UNKNOWN; } // 读取失败 -> 拒写
  if (v === FREEZE_ON || v === '1' || v === true) return FREEZE_ON;
  if (v === FREEZE_OFF || v === 0 || v === '0' || v === false) return FREEZE_OFF;
  return FREEZE_UNKNOWN; // 空值/错误类型/未知形态 -> UNKNOWN，fail-closed
}
function writeFreeze(ssId, val) {
  _sheet(ssId).getRange('A1').setValue(val ? FREEZE_ON : FREEZE_OFF);
  return readFreeze(ssId);
}
function guardCheck(ssId) {
  var f = readFreeze(ssId);
  if (f === FREEZE_ON) return 'PERIOD_LOCKED';
  if (f === FREEZE_OFF) return 'OK';
  return 'UNKNOWN_REJECT'; // fail-closed：缺值/异常/不可读 一律拒写
}

// 统一受保护写入口（修复发现#4：锁 + 冻结闸 + 真实受保护写 同域绑定）
function guardedWrite(ssId, domain, protectedFn) {
  var handle = acquireLock(domain, 30000);
  if (!handle.ok) return { ok: false, reason: 'ACQUIRE_FAILED', lockRef: domain };
  try {
    var verdict = guardCheck(ssId);
    if (verdict !== 'OK') return { ok: false, reason: verdict, lockRef: domain }; // PERIOD_LOCKED / UNKNOWN_REJECT
    var result = protectedFn();
    return { ok: true, result: result, lockRef: domain };
  } finally {
    releaseLock(handle);
  }
}

function registerWriter(ssId, name) {
  var sh = _sheet(ssId);
  sh.getRange('A2').setValue((sh.getRange('A2').getValue() || '') + '|' + name);
  return name;
}
// 受保护的写者注册（与 guardedWrite 同域，修复发现#4：注册写此前未纳入统一保护）
function guardedRegister(ssId, name) {
  return guardedWrite(ssId, SHARED_LOCK_DOMAIN, function () { return registerWriter(ssId, name); });
}

function appendLog(ssId, row) { _sheet(ssId).appendRow(row); }
