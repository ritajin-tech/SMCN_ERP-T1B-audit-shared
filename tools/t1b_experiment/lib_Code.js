/**
 * T1-B 阶段B 非生产实验 · 共享锁库（E2/E3 落地原型）
 * 被 writerA / writerB 两个独立项目共同引用 -> 二者调用 acquireLock 锁定的是"本库脚本域"，跨项目互斥成立。
 * 冻结状态 TS_WRITE_FREEZE 与写者注册表存于单一共享配置表（E3 单一受信源），杜绝"同名 Script Properties 各自为政"。
 * 纯非生产；不读主库/生产表；仅读写传入的测试表 ssId。表内只用默认 Sheet1（config 在固定格、log 追加于下方）。
 */
var SHARED_LOCK_DOMAIN = 't1b-exp-guard';

function _sheet(ssId) { return SpreadsheetApp.openById(ssId).getSheets()[0]; }

function acquireLock(domain, holdMs) {
  var lock = LockService.getScriptLock(); // 锁定"本库"脚本域 -> 所有引用本库者共享同一锁域
  try {
    var ok = lock.tryLock(holdMs || 30000);
    return { acquired: ok, domain: domain, t: new Date().toISOString() };
  } catch (e) {
    return { acquired: false, error: String(e), t: new Date().toISOString() };
  }
}

function readFreeze(ssId) {
  var v = _sheet(ssId).getRange('A1').getValue();
  return (v === 1 || v === '1' || v === true) ? 1 : 0;
}

function writeFreeze(ssId, val) {
  _sheet(ssId).getRange('A1').setValue(val ? 1 : 0);
  return readFreeze(ssId);
}

function guardCheck(ssId) {
  return readFreeze(ssId) === 1 ? 'PERIOD_LOCKED' : 'OK';
}

function registerWriter(ssId, name) {
  var sh = _sheet(ssId);
  sh.getRange('A2').setValue((sh.getRange('A2').getValue() || '') + '|' + name);
  return name;
}

function appendLog(ssId, row) { _sheet(ssId).appendRow(row); }
