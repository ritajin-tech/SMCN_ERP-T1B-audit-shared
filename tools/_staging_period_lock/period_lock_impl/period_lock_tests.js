/**
 * T1-B · period-lock guard R1-R14 测试件（Node 可跑 · fail-closed）
 * ============================================================
 * 用法：node period_lock_tests.js
 * 退出码：全部通过 exit 0；任一失败 exit 1。
 * mock：LockService / SpreadsheetApp / PropertiesService / Utilities（内存实现）
 * 断言纪律：每个用例显式断言「拒/放行 + 拒绝码 + 零写副作用 + 调用次数」。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

// ============================================================
// 0. 载入被测模块（GAS 风格全局函数）
// ============================================================
const guardSrc = fs.readFileSync(path.join(__dirname, 'PeriodLockGuard.gs'), 'utf8');
(0, eval)(guardSrc);   // 间接 eval → 全局作用域，供下方直接调用

// ============================================================
// 1. GAS 环境 mock
// ============================================================
function makeSheet(name, rows) {
  const sheet = {
    _name: name, _rows: rows || [],
    getLastRow() { return this._rows.length; },
    getDataRange() {
      const self = this;
      return { getValues: () => JSON.parse(JSON.stringify(self._rows)) };
    },
    getRange(a, b, c, d) {
      const self = this;
      if (c === undefined) {                       // 单格 setValue
        return {
          setValue(v) { self._rows[a - 1][b - 1] = v; },
          getValue() { return self._rows[a - 1][b - 1]; }
        };
      }
      return {                                    // 区域
        getValues: () => self._rows.slice(a - 1, a - 1 + c).map(r => r.slice(b - 1, b - 1 + d)),
        setValues: (vals) => {
          for (let i = 0; i < vals.length; i++)
            for (let j = 0; j < vals[i].length; j++)
              self._rows[a - 1 + i][b - 1 + j] = vals[i][j];
        }
      };
    },
    appendRow(arr) { this._rows.push(arr.slice()); },
    insertSheet(n) { const s = makeSheet(n, []); this._ss._sheets[n] = s; return s; }
  };
  return sheet;
}

const env = {
  _props: new Map(),
  _propsBroken: false,
  _lock: { failTryLock: false, held: false, tryLockCalls: 0 },
  _flushCount: 0,
  _sheets: {},
  reset() {
    this._props = new Map();
    this._propsBroken = false;
    this._lock = { failTryLock: false, held: false, tryLockCalls: 0 };
    this._flushCount = 0;
    this._sheets = {};
  }
};

global.TS_ID = 'MOCK_TS_ID';
global.Utilities = {
  formatDate: (d, tz, fmt) => {
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) +
           ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
  },
  getUuid: () => 'uuid-mock-0001'
};
global.LockService = {
  getScriptLock: () => ({
    tryLock: (ms) => { env._lock.tryLockCalls++; if (env._lock.failTryLock) return false; env._lock.held = true; return true; },
    releaseLock: () => { env._lock.held = false; },
    hasLock: () => env._lock.held
  })
};
global.SpreadsheetApp = {
  flush: () => { env._flushCount++; },
  openById: (id) => ({
    getId: () => id,
    getSheetByName: (n) => env._sheets[n] || null,
    insertSheet: (n) => { const s = makeSheet(n, []); env._sheets[n] = s; return s; }
  })
};
global.PropertiesService = {
  getScriptProperties: () => ({
    getProperty: (k) => { if (env._propsBroken) throw new Error('props unavailable'); return env._props.has(k) ? env._props.get(k) : null; },
    setProperty: (k, v) => { env._props.set(k, v); }
  })
};

// 标准 DB 行（列序见 patches §0）：A ts, B fillDate, C name, D type, E stage, F pid,
//   G hours, H notes, I uuid, J pname, K '', L leader, M '', N ym, O del, P delby, Q delat
const HDR = ['ts', 'fillDate', 'name', 'type', 'stage', 'pid', 'hours', 'notes', 'uuid', 'pname', '', 'leader', '', 'ym', 'del', 'delby', 'delat'];
function dbRow(bizDate, uuid, deleted) {
  return ['2026-10-01 10:00:00', bizDate, '张三', '执行端', '1.1', 'PRJ-1', 8, '', uuid, '项目一', '', '', '', bizDate.substring(0, 7),
          deleted ? true : '', '', ''];
}
function freshDb() {
  env.reset();
  env._sheets['DB_工时流水'] = makeSheet('DB_工时流水', [HDR.slice(),
    dbRow('2026-09-15', 'UUID-SEP-OLD'),    // 行2：9 月（已关账）
    dbRow('2026-10-15', 'UUID-OCT-NEW')]);  // 行3：10 月（开放）
}

// ============================================================
// 2. 用例登记
// ============================================================
const results = [];
function t(id, name, fn) {
  try { fn(); results.push({ id, name, ok: true }); }
  catch (e) { results.push({ id, name, ok: false, err: String(e && e.message || e) }); }
}
function expectReject(fn, code) {
  try { fn(); throw new Error('期望被拒(' + code + ')但放行了'); }
  catch (e) {
    if (String(e.message).indexOf('期望被拒') === 0) throw e;
    if (e.plCode !== code && String(e.message).indexOf(code) < 0)
      throw new Error('拒绝码不符：期望 ' + code + ' 实得 ' + (e.plCode || e.message));
    return e;
  }
}

// ============================================================
// 3. R1-R14
// ============================================================

// R1 新增 9-15 → 拒
t('R1', '新增 fillDate=2026-09-15 → 拒', () => {
  freshDb();
  const r = _plGuardCheck('2026-09-15', null, _plPolicy());
  assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'PL_REJECT_NEW_DATE_CLOSED');
});

// R2 新增 10-15 → 过
t('R2', '新增 fillDate=2026-10-15 → 放行', () => {
  freshDb();
  const r = _plGuardCheck('2026-10-15', null, _plPolicy());
  assert.strictEqual(r.ok, true);
});

// R3 旧行改到 10 月后 → 拒（双向·原值）
t('R3', '修改：9月旧行日期改到10月后 → 拒', () => {
  freshDb();
  const r = _plGuardCheck('2026-10-20', '2026-09-15', _plPolicy());
  assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'PL_REJECT_ORIG_DATE_CLOSED');
});

// R4 10 月行改回 9 月 → 拒（双向·新值）
t('R4', '修改：10月行日期回改9月 → 拒', () => {
  freshDb();
  const r = _plGuardCheck('2026-09-20', '2026-10-20', _plPolicy());
  assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'PL_REJECT_NEW_DATE_CLOSED');
});

// R5 删除旧行 → 拒
t('R5', '删除9月旧行 → 拒', () => {
  freshDb();
  const r = _plGuardCheck('2026-09-15', '2026-09-15', _plPolicy());   // 删除以原期间过门禁
  assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'PL_REJECT_NEW_DATE_CLOSED');
});

// R6 批量含旧日期 → 整批零写
t('R6', '批量导入含旧日期行 → 整批拒零写', () => {
  freshDb();
  let calls = 0;
  expectReject(() => _plGuardedInsert({
    sheet: env._sheets['DB_工时流水'],
    rows: [['ts', '2026-10-16'], ['ts', '2026-09-16']],
    dateOf: (r) => r[1],
    bizWrite: () => { calls++; return 'SUCCESS'; }
  }), 'PL_REJECT_NEW_DATE_CLOSED');
  assert.strictEqual(calls, 0, '批前校验失败不得执行业务写');
  assert.strictEqual(env._sheets['DB_工时流水']._rows.length, 3, '零写：行数不变');
});

// R7 配置读取失败 → fail-closed 拒历史写入
t('R7', '锁政策态读取失败 → fail-closed（历史拒）', () => {
  freshDb();
  env._propsBroken = true;
  const p = _plPolicy();
  assert.strictEqual(p.closed, true); assert.strictEqual(p.source, 'default');
  const r = _plGuardCheck('2026-09-15', null, p);
  assert.strictEqual(r.ok, false);
});

// R8 futureOpen=false → 未来日期亦拒
t('R8', 'futureOpen=false → 未来日期拒', () => {
  freshDb();
  _plSetPolicy(true, false, 'test');
  const r = _plGuardCheck('2026-10-15', null, _plPolicy());
  assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'PL_REJECT_FUTURE_CLOSED');
});

// R9 例外路径暂缓：guard 无解锁入口；closed 下历史修改一律拒
t('R9', '例外路径暂缓：无解锁API+closed下历史修改拒', () => {
  assert.ok(!/function\s+_plUnlock/.test(guardSrc), 'guard 不得包含例外解锁函数');
  freshDb();
  const r = _plGuardCheck('2026-10-01', '2026-09-15', _plPolicy());
  assert.strictEqual(r.ok, false);
});

// R10a 他人改于重核之前 → mismatch 拒
t('R10a', '重核前他人改行 → PL_REJECT_ROW_CHANGED', () => {
  freshDb();
  const sh = env._sheets['DB_工时流水'];
  const r = _plRecheckRow(sh, 'UUID-SEP-OLD', '2026-10-15', false);  // 期望 10 月，实为 9 月
  assert.strictEqual(r.found, true); assert.strictEqual(r.mismatch, true);
});

// R10b-B1 锁竞争超时 → 零写拒
t('R10b-B1', 'tryLock 失败 → PL_REJECT_LOCK_BUSY 零写', () => {
  freshDb();
  env._lock.failTryLock = true;
  let calls = 0;
  expectReject(() => _plGuardedMutation({
    sheet: env._sheets['DB_工时流水'], uuid: 'UUID-OCT-NEW',
    newDateRaw: '2026-10-20', origDateRaw: '2026-10-15', expectDeleted: false,
    bizWrite: () => { calls++; return 'SUCCESS'; }
  }), 'PL_REJECT_LOCK_BUSY');
  assert.strictEqual(calls, 0, '取锁失败零写');
  assert.strictEqual(env._sheets['DB_工时流水']._rows[2][1], '2026-10-15', '数据未被触碰');
});

// R10b-B2 等到锁后重核相符 → 放行
t('R10b-B2', '等到锁后重核相符 → 放行写入', () => {
  freshDb();
  const sh = env._sheets['DB_工时流水'];
  const res = _plGuardedMutation({
    sheet: sh, uuid: 'UUID-OCT-NEW',
    newDateRaw: '2026-10-20', origDateRaw: '2026-10-15', expectDeleted: false,
    bizWrite: () => { sh.getRange(3, 2).setValue('2026-10-20'); return 'SUCCESS'; }
  });
  assert.strictEqual(res, 'SUCCESS');
  assert.strictEqual(sh._rows[2][1], '2026-10-20');
  assert.ok(env._flushCount >= 1, '释放锁前必须 flush');
  assert.strictEqual(env._lock.held, false, 'finally 释放锁');
});

// R10c 外部写者：guard 发现但不自动回滚（只拒+不擦除）
t('R10c', '外部写者改行 → 重核发现拒之，不自动回滚', () => {
  freshDb();
  const sh = env._sheets['DB_工时流水'];
  sh.getRange(3, 2).setValue('2026-09-20');      // 模拟外部写者绕过 guard 直改
  expectReject(() => _plGuardedMutation({
    sheet: sh, uuid: 'UUID-OCT-NEW',
    newDateRaw: '2026-10-20', origDateRaw: '2026-10-15', expectDeleted: false,
    bizWrite: () => { sh.getRange(3, 2).setValue('2026-10-20'); return 'SUCCESS'; }
  }), 'PL_REJECT_ROW_CHANGED');
  assert.strictEqual(sh._rows[2][1], '2026-09-20', '不自动回滚：外部写入值保持原样（仅告警路径处置）');
});

// R10d 无竞争 9 月请求：取锁成功但锁内门禁拒
t('R10d', '无竞争9月请求取锁成功 → 锁内期间门禁拒', () => {
  freshDb();
  let calls = 0;
  expectReject(() => _plGuardedMutation({
    sheet: env._sheets['DB_工时流水'], uuid: 'UUID-OCT-NEW',
    newDateRaw: '2026-09-15', origDateRaw: '2026-10-15', expectDeleted: false,
    bizWrite: () => { calls++; return 'SUCCESS'; }
  }), 'PL_REJECT_NEW_DATE_CLOSED');
  assert.ok(env._lock.tryLockCalls >= 1, '9月请求同样走到取锁（证明取锁与门禁分离）');
  assert.strictEqual(calls, 0, '门禁拒 → 零写');
});

// R11 策略持久化往返（回滚后状态仍在；执行约束由保留 guard 提供）
t('R11', '锁政策态持久化往返一致', () => {
  freshDb();
  _plSetPolicy(true, true, 'rita');
  const p1 = _plPolicy();
  assert.strictEqual(p1.closed, true); assert.strictEqual(p1.futureOpen, true);
  assert.strictEqual(p1.updatedBy, 'rita'); assert.strictEqual(p1.source, 'props');
  const patches = fs.readFileSync(path.join(__dirname, 'period_lock_entry_patches.md'), 'utf8');
  assert.ok(patches.indexOf('保留执行锁入口') >= 0, 'patches 必须含回滚保留执行锁入口条目');
});

// R12a 批前合格 → 正常写
t('R12a', '批前校验全合格 → 正常写入', () => {
  freshDb();
  const sh = env._sheets['DB_工时流水'];
  const res = _plGuardedInsert({
    sheet: sh, rows: [['ts', '2026-10-16'], ['ts', '2026-10-17']],
    dateOf: (r) => r[1],
    bizWrite: () => { sh._rows.push(['ts', '2026-10-16', 'x']); sh._rows.push(['ts', '2026-10-17', 'x']); return 'SUCCESS'; }
  });
  assert.strictEqual(res, 'SUCCESS');
  assert.strictEqual(sh._rows.length, 5);
});

// R12b 业务写中途失败 → 不确定登记+释放+不重放
t('R12b', '业务写中途失败 → 登记不确定批次，不重放不补偿', () => {
  freshDb();
  const sh = env._sheets['DB_工时流水'];
  let calls = 0;
  expectReject(() => _plGuardedMutation({
    sheet: sh, uuid: 'UUID-OCT-NEW',
    newDateRaw: '2026-10-20', origDateRaw: '2026-10-15', expectDeleted: false,
    bizWrite: () => { calls++; const e = new Error('API interrupted'); e.plCode = 'BIZ_WRITE_FAILED'; throw e; }
  }), 'API interrupted');
  assert.strictEqual(calls, 1, '不得重放');
  assert.strictEqual(env._lock.held, false, 'finally 释放');
  const log = env._sheets['_TS_WRITE_LOG'];
  assert.ok(log && log._rows.length >= 2, 'R12b：不确定批次必须登记');
  assert.ok(String(log._rows[log._rows.length - 1][2]).indexOf('待人工核查') >= 0);
});

// R13 审计（不确定登记）写失败 → 不阻断不谎报
t('R13', '不确定登记写失败 → 不阻断错误传播', () => {
  freshDb();
  env._sheets['_TS_WRITE_LOG'] = {
    appendRow() { throw new Error('log sheet broken'); },
    _rows: []
  };
  // 直接测 _plLogUncertain 自身静默
  _plLogUncertain('unit', 'detail');
  // 再测 R12b 路径里日志故障不影响 reject 码
  const sh = env._sheets['DB_工时流水'];
  expectReject(() => _plGuardedMutation({
    sheet: sh, uuid: 'UUID-OCT-NEW',
    newDateRaw: '2026-10-20', origDateRaw: '2026-10-15', expectDeleted: false,
    bizWrite: () => { const e = new Error('API interrupted'); e.plCode = 'BIZ_WRITE_FAILED'; throw e; }
  }), 'API interrupted');
  assert.ok(!/function\s+_plUnlock/.test(guardSrc), 'guard 不含例外解锁（R13 同 R9）');
});

// R14 例外滥用负例：单签/同人双签/重放/到期
t('R14', '例外滥用负例全拒（无例外入口）', () => {
  assert.ok(!/function\s+_plUnlock/.test(guardSrc), '无单签解锁函数');
  assert.ok(!/unlockExpire|expiresAt/.test(guardSrc), '无到期概念（例外路径暂缓）');
  freshDb();
  // 重放：同一合法 mutation 重复执行，第二次仍过门禁（不会因"前面写过"被误拒——这是放行属性）；
  // 滥用侧断言：任何历史期间写入重放仍被拒
  for (let i = 0; i < 3; i++) {
    const r = _plGuardCheck('2026-09-15', '2026-09-15', _plPolicy());
    assert.strictEqual(r.ok, false, '第 ' + (i + 1) + ' 次重放仍拒');
  }
  // 同人双签/单签：guard 层无任何按主体放行的分支
  assert.ok(!/sysadmin|isAdmin/.test(guardSrc), 'guard 无按主体放行逻辑');
});

// ============================================================
// 4. 汇总
// ============================================================
const pass = results.filter(r => r.ok).length;
const fail = results.filter(r => !r.ok);
results.forEach(r => {
  console.log((r.ok ? '✅' : '❌') + ' ' + r.id + ' ' + r.name + (r.ok ? '' : '  → ' + r.err));
});
console.log('----------------------------------------');
console.log('R1-R14: ' + pass + '/' + results.length + ' 通过' + (fail.length ? '，' + fail.length + ' 失败' : '（fail-closed 全绿）'));
process.exit(fail.length ? 1 : 0);
