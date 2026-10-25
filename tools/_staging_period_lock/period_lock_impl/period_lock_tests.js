/**
 * T1-B · period-lock guard R1-R17 测试件 v2（Node 可跑 · fail-closed）
 * ============================================================
 * 用法：node period_lock_tests.js   退出码：全绿 exit 0；任一失败 exit 1。
 * v2 相对 v1（应 Tom 09:27 ⑥）：
 *   - 锁 mock 改「双执行互斥」：held=true 时 tryLock 返回 false（不再只靠布尔）
 *   - 新增 _plGuardPatch 用例组（R15：O:Q ranges/空 B/原值未知/原行不存在/非B列不拦）
 *   - 新增内容版本绑定（R10e：last-write-wins 防护）
 *   - R12b 改普通 Error（无自定义码）＋部分写后异常＋flush 抛错路径（R12c）
 *   - R7b 精确边界：配置故障时历史拒、未来仍放行（不概称任何写均拒）
 *   - R16 正则完整锚定；R11 cutoff 坏值
 *   - R10c 语义改为：参与入口重核发现即拒＋不宣称外部覆盖保证＋不自动回滚
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

// ============================================================
// 0. 载入被测模块
// ============================================================
const guardSrc = fs.readFileSync(path.join(__dirname, 'PeriodLockGuard.gs'), 'utf8');
(0, eval)(guardSrc);

// ============================================================
// 1. GAS 环境 mock（锁＝双执行互斥）
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
      if (c === undefined) {
        return {
          setValue(v) { self._rows[a - 1][b - 1] = v; },
          getValue() { return self._rows[a - 1][b - 1]; }
        };
      }
      return {
        getValues: () => self._rows.slice(a - 1, a - 1 + c).map(r => r.slice(b - 1, b - 1 + d)),
        setValues: (vals) => {
          for (let i = 0; i < vals.length; i++)
            for (let j = 0; j < vals[i].length; j++)
              self._rows[a - 1 + i][b - 1 + j] = vals[i][j];
        }
      };
    },
    appendRow(arr) { this._rows.push(arr.slice()); },
    insertSheet(n) { const s = makeSheet(n, []); env._sheets[n] = s; return s; }
  };
  return sheet;
}

const env = {
  _props: new Map(), _propsBroken: false,
  _lock: { held: false, tryLockCalls: 0 },
  _flushCount: 0, _flushThrows: false,
  _sheets: {},
  reset() {
    this._props = new Map(); this._propsBroken = false;
    this._lock = { held: false, tryLockCalls: 0 };
    this._flushCount = 0; this._flushThrows = false;
    this._sheets = {};
  }
};

global.TS_ID = 'MOCK_TS_ID';
global.Utilities = {
  // 忠实 mock：按 fmt 参数返回（真实 GAS formatDate 行为）
  formatDate: (d, tz, fmt) => {
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    const y = d.getUTCFullYear(), mo = p(d.getUTCMonth() + 1), da = p(d.getUTCDate());
    const hh = p(d.getUTCHours()), mi = p(d.getUTCMinutes()), ss = p(d.getUTCSeconds());
    if (fmt === 'yyyy-MM-dd') return y + '-' + mo + '-' + da;
    if (fmt === 'yyyy-MM-dd HH:mm:ss') return y + '-' + mo + '-' + da + ' ' + hh + ':' + mi + ':' + ss;
    return y + '-' + mo + '-' + da + ' ' + hh + ':' + mi + ':' + ss;
  },
  getUuid: () => 'uuid-mock-0001'
};
// 双执行互斥：held 期间任何执行 tryLock 必失败
global.LockService = {
  getScriptLock: () => ({
    tryLock: (ms) => {
      env._lock.tryLockCalls++;
      if (env._lock.held) return false;
      env._lock.held = true; return true;
    },
    releaseLock: () => { env._lock.held = false; },
    hasLock: () => env._lock.held
  })
};
global.SpreadsheetApp = {
  flush: () => { if (env._flushThrows) throw new Error('flush failed'); env._flushCount++; },
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
function contentHashOf(sheet, row) { return _plRowContentHash(sheet._rows[row - 1]); }

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
function logRows() { const l = env._sheets['_TS_WRITE_LOG']; return l ? l._rows.length - 1 : 0; }

// ============================================================
// R1-R8 基础门禁
// ============================================================
t('R1', '新增 9-15 → 拒', () => {
  freshDb();
  const r = _plGuardCheck('2026-09-15', null, _plPolicy());
  assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'PL_REJECT_NEW_DATE_CLOSED');
});
t('R2', '新增 10-15 → 放行', () => {
  freshDb();
  assert.strictEqual(_plGuardCheck('2026-10-15', null, _plPolicy()).ok, true);
});
t('R3', '9月旧行改到10月后 → 拒（原值）', () => {
  freshDb();
  const r = _plGuardCheck('2026-10-20', '2026-09-15', _plPolicy());
  assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'PL_REJECT_ORIG_DATE_CLOSED');
});
t('R4', '10月行回改9月 → 拒（新值）', () => {
  freshDb();
  const r = _plGuardCheck('2026-09-20', '2026-10-20', _plPolicy());
  assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'PL_REJECT_NEW_DATE_CLOSED');
});
t('R5', '删除9月旧行 → 拒', () => {
  freshDb();
  const r = _plGuardCheck('2026-09-15', '2026-09-15', _plPolicy());
  assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'PL_REJECT_NEW_DATE_CLOSED');
});
t('R6', '批量含旧日期 → 整批零写', () => {
  freshDb();
  let calls = 0;
  expectReject(() => _plGuardedInsert({
    sheet: env._sheets['DB_工时流水'],
    rows: [['ts', '2026-10-16'], ['ts', '2026-09-16']],
    dateOf: (r) => r[1],
    bizWrite: () => { calls++; return 'SUCCESS'; }
  }), 'PL_REJECT_NEW_DATE_CLOSED');
  assert.strictEqual(calls, 0);
  assert.strictEqual(env._sheets['DB_工时流水']._rows.length, 3);
});
t('R7', '配置读取失败 → 历史拒', () => {
  freshDb();
  env._propsBroken = true;
  const p = _plPolicy();
  assert.strictEqual(p.closed, true); assert.strictEqual(p.source, 'default');
  assert.strictEqual(_plGuardCheck('2026-09-15', null, p).ok, false);
});
t('R7b', '精确边界：配置故障未来仍放行（不概称任何写均拒）', () => {
  freshDb();
  env._propsBroken = true;
  const p = _plPolicy();
  assert.strictEqual(_plGuardCheck('2026-10-15', null, p).ok, true);
});
t('R8', 'futureOpen=false → 未来日期拒', () => {
  freshDb();
  _plSetPolicy(true, false, 'test');
  const r = _plGuardCheck('2026-10-15', null, _plPolicy());
  assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'PL_REJECT_FUTURE_CLOSED');
});
t('R9', '例外路径暂缓：无解锁API', () => {
  assert.ok(!/function\s+_plUnlock/.test(guardSrc));
  freshDb();
  assert.strictEqual(_plGuardCheck('2026-10-01', '2026-09-15', _plPolicy()).ok, false);
});

// ============================================================
// R10 组：锁内重核（行号/版本/唯一性/归属）
// ============================================================
t('R10a', '锁内重核返回实际行号+内容哈希', () => {
  freshDb();
  const sh = env._sheets['DB_工时流水'];
  const rc = _plRecheckRow(sh, 'UUID-OCT-NEW', null, null);
  assert.strictEqual(rc.found, true); assert.strictEqual(rc.row, 3);
  assert.strictEqual(rc.bizDate, '2026-10-15');
  assert.ok(rc.contentHash && rc.contentHash.length > 0);
});
t('R10a2', '行消失 → ROW_GONE', () => {
  freshDb();
  const rc = _plRecheckRow(env._sheets['DB_工时流水'], 'UUID-NOPE', null, null);
  assert.strictEqual(rc.mismatch, true); assert.strictEqual(rc.reason, 'PL_REJECT_ROW_GONE');
});
t('R10a3', '重复 UUID → NOT_UNIQUE（无唯一性即拒）', () => {
  freshDb();
  env._sheets['DB_工时流水']._rows.push(dbRow('2026-10-20', 'UUID-OCT-NEW'));
  const rc = _plRecheckRow(env._sheets['DB_工时流水'], 'UUID-OCT-NEW', null, null);
  assert.strictEqual(rc.mismatch, true); assert.strictEqual(rc.reason, 'PL_REJECT_UUID_NOT_UNIQUE');
});
t('R10a4', '锁内姓名不符 → OWNER_MISMATCH', () => {
  freshDb();
  const rc = _plRecheckRow(env._sheets['DB_工时流水'], 'UUID-OCT-NEW', null, '李四');
  assert.strictEqual(rc.mismatch, true); assert.strictEqual(rc.reason, 'PL_REJECT_OWNER_MISMATCH');
});
t('R10a5', '锁内原值未知（B列非法）→ ORIG_UNKNOWN', () => {
  freshDb();
  env._sheets['DB_工时流水'].getRange(3, 2).setValue('garbage-date');
  const rc = _plRecheckRow(env._sheets['DB_工时流水'], 'UUID-OCT-NEW', null, null);
  assert.strictEqual(rc.mismatch, true); assert.strictEqual(rc.reason, 'PL_REJECT_ORIG_UNKNOWN');
});
t('R10b-B1', '双执行互斥：A持锁中B tryLock失败 → LOCK_BUSY 零写', () => {
  freshDb();
  env._lock.held = true;                       // 模拟另一执行持有互斥
  let calls = 0;
  expectReject(() => _plGuardedMutation({
    sheet: env._sheets['DB_工时流水'], uuid: 'UUID-OCT-NEW',
    newDateRaw: '2026-10-20',
    bizWrite: () => { calls++; return 'SUCCESS'; }
  }), 'PL_REJECT_LOCK_BUSY');
  assert.strictEqual(calls, 0);
  assert.strictEqual(env._sheets['DB_工时流水']._rows[2][1], '2026-10-15', '数据未被触碰');
});
t('R10b-B2', '取锁成功重核相符 → 放行；写入用锁内实读行号', () => {
  freshDb();
  const sh = env._sheets['DB_工时流水'];
  let usedRow = 0;
  const res = _plGuardedMutation({
    sheet: sh, uuid: 'UUID-OCT-NEW', newDateRaw: '2026-10-20',
    bizWrite: (recheck) => { usedRow = recheck.row; sh.getRange(recheck.row, 2).setValue('2026-10-20'); return 'SUCCESS'; }
  });
  assert.strictEqual(res, 'SUCCESS');
  assert.strictEqual(usedRow, 3, 'bizWrite 必须用锁内实读行号');
  assert.strictEqual(sh._rows[2][1], '2026-10-20');
  assert.ok(env._flushCount >= 1, '释放锁前必须 flush');
  assert.strictEqual(env._lock.held, false, 'finally 释放');
});
t('R10c', '外部写者：重核发现内容版本不符 → 拒；不自动回滚（值保持）', () => {
  freshDb();
  const sh = env._sheets['DB_工时流水'];
  sh.getRange(3, 7).setValue(3);               // 外部写者绕过 guard 改工时（内容版本变）
  const staleHash = contentHashOf(sh, 3);
  sh.getRange(3, 7).setValue(99);              // 再改一次 → 锁外读到的 stale
  expectReject(() => _plGuardedMutation({
    sheet: sh, uuid: 'UUID-OCT-NEW', newDateRaw: '2026-10-20',
    expectContentHash: staleHash,
    bizWrite: (recheck) => { sh.getRange(recheck.row, 2).setValue('2026-10-20'); return 'SUCCESS'; }
  }), 'PL_REJECT_CONTENT_VERSION');
  assert.strictEqual(sh._rows[2][6], 99, '不自动回滚：外部写入值保持原样');
});
t('R10d', '无竞争9月请求取锁成功 → 锁内门禁拒', () => {
  freshDb();
  let calls = 0;
  expectReject(() => _plGuardedMutation({
    sheet: env._sheets['DB_工时流水'], uuid: 'UUID-OCT-NEW',
    newDateRaw: '2026-09-15',
    bizWrite: () => { calls++; return 'SUCCESS'; }
  }), 'PL_REJECT_NEW_DATE_CLOSED');
  assert.ok(env._lock.tryLockCalls >= 1, '9月请求同样走到取锁（取锁与门禁分离）');
  assert.strictEqual(calls, 0);
});
t('R10e', '内容版本绑定：last-write-wins 防护', () => {
  freshDb();
  const sh = env._sheets['DB_工时流水'];
  const v1 = contentHashOf(sh, 3);
  // A 先写（改同日工时，合法业务操作）
  _plGuardedMutation({
    sheet: sh, uuid: 'UUID-OCT-NEW', newDateRaw: '2026-10-15', expectContentHash: v1,
    bizWrite: (recheck) => { sh.getRange(recheck.row, 7).setValue(5); return 'SUCCESS'; }
  });
  // B 持锁外旧内容 v1 再写 → 锁内重核发现版本已变 → 拒
  expectReject(() => _plGuardedMutation({
    sheet: sh, uuid: 'UUID-OCT-NEW', newDateRaw: '2026-10-15', expectContentHash: v1,
    bizWrite: (recheck) => { sh.getRange(recheck.row, 7).setValue(7); return 'SUCCESS'; }
  }), 'PL_REJECT_CONTENT_VERSION');
  assert.strictEqual(sh._rows[2][6], 5, 'A 的写入保留，B 的陈旧写入被拒');
});

// ============================================================
// R11/R12 组
// ============================================================
t('R11', '策略持久化往返 + cutoff 坏值回退', () => {
  freshDb();
  _plSetPolicy(true, true, 'rita');
  const p1 = _plPolicy();
  assert.strictEqual(p1.closed, true); assert.strictEqual(p1.updatedBy, 'rita');
  // cutoff 坏值 → 回退内置
  env._props.set('PERIOD_LOCK_STATE', JSON.stringify({ closed: true, cutoff: 'garbage', futureOpen: true }));
  const p2 = _plPolicy();
  assert.strictEqual(p2.cutoff, PL_CUTOFF, '坏 cutoff 不得改变历史判定');
  const src = fs.readFileSync(path.join(__dirname, 'period_lock_integrated_src.gs'), 'utf8');
  assert.ok(src.indexOf('入口 1/5') >= 0 && src.indexOf('入口 5/5') >= 0, '集成源码须含全部 5 入口');
});
t('R12a', '批前校验全合格 → 正常写入', () => {
  freshDb();
  const sh = env._sheets['DB_工时流水'];
  const res = _plGuardedInsert({
    sheet: sh, rows: [['ts', '2026-10-16'], ['ts', '2026-10-17']],
    dateOf: (r) => r[1],
    bizWrite: (rows) => { rows.forEach(r => sh._rows.push(r.slice())); return 'SUCCESS'; }
  });
  assert.strictEqual(res, 'SUCCESS');
  assert.strictEqual(sh._rows.length, 5);
});
t('R12b', '业务写普通异常（无自定义码）→ 登记一次+释放+不重放', () => {
  freshDb();
  const sh = env._sheets['DB_工时流水'];
  const before = logRows();
  let calls = 0;
  expectReject(() => _plGuardedMutation({
    sheet: sh, uuid: 'UUID-OCT-NEW', newDateRaw: '2026-10-20',
    bizWrite: () => { calls++; throw new Error('Exception: 服务超时'); }   // 普通 Error
  }), 'Exception: 服务超时');
  assert.strictEqual(calls, 1, '不得重放');
  assert.strictEqual(env._lock.held, false, 'finally 释放');
  assert.strictEqual(logRows() - before, 1, 'R12b：进入写阶段的任何异常登记一次');
});
t('R12b2', '部分写后普通异常 → 登记（结果不确定）', () => {
  freshDb();
  const sh = env._sheets['DB_工时流水'];
  const before = logRows();
  expectReject(() => _plGuardedMutation({
    sheet: sh, uuid: 'UUID-OCT-NEW', newDateRaw: '2026-10-20',
    bizWrite: (recheck) => {
      sh.getRange(recheck.row, 2).setValue('2026-10-20');   // 前半已写
      throw new Error('Exception: 中途中断');               // 后半失败
    }
  }), 'Exception: 中途中断');
  assert.strictEqual(logRows() - before, 1, '部分写后异常必须登记不确定');
});
t('R12c', 'flush 抛错 → PL_UNCERTAIN 且只登记一次（不双登记）', () => {
  freshDb();
  const sh = env._sheets['DB_工时流水'];
  const before = logRows();
  env._flushThrows = true;
  expectReject(() => _plGuardedMutation({
    sheet: sh, uuid: 'UUID-OCT-NEW', newDateRaw: '2026-10-20',
    bizWrite: (recheck) => { sh.getRange(recheck.row, 2).setValue('2026-10-20'); return 'SUCCESS'; }
  }), 'PL_UNCERTAIN_FLUSH_FAILED');
  assert.strictEqual(logRows() - before, 1, 'flush 失败只登记一次');
  assert.strictEqual(env._lock.held, false);
});
t('R13', '不确定登记写失败 → 不阻断错误传播', () => {
  freshDb();
  env._sheets['_TS_WRITE_LOG'] = { appendRow() { throw new Error('log broken'); }, _rows: [] };
  _plLogUncertain('unit', 'detail');           // 静默
  const sh = env._sheets['DB_工时流水'];
  expectReject(() => _plGuardedMutation({
    sheet: sh, uuid: 'UUID-OCT-NEW', newDateRaw: '2026-10-20',
    bizWrite: () => { throw new Error('Exception: x'); }
  }), 'Exception: x');
});
t('R14', '例外滥用负例全拒（无例外入口）', () => {
  assert.ok(!/function\s+_plUnlock/.test(guardSrc));
  assert.ok(!/unlockExpire|expiresAt/.test(guardSrc));
  assert.ok(!/sysadmin|isAdmin/.test(guardSrc), 'guard 无按主体放行逻辑');
  freshDb();
  for (let i = 0; i < 3; i++) {
    assert.strictEqual(_plGuardCheck('2026-09-15', '2026-09-15', _plPolicy()).ok, false);
  }
});

// ============================================================
// R15 组：_plGuardPatch（[审1] 三态 + 全覆盖）
// ============================================================
t('R15-P1', 'ranges O:Q 写9月行 → 拒', () => {
  freshDb();
  const r = _plGuardPatch(env._sheets['DB_工时流水'], [], [{ row: 2, col: 15, values: [[true]] }]);
  assert.strictEqual(r.ok, false);
  assert.ok(r.offenders.some(o => o.reason === 'PL_REJECT_ORIG_DATE_CLOSED'));
});
t('R15-P2', 'ranges 覆盖B列且新B为空 → 拒（禁清空）', () => {
  freshDb();
  const r = _plGuardPatch(env._sheets['DB_工时流水'], [], [{ row: 3, col: 2, values: [['']] }]);
  assert.strictEqual(r.ok, false);
  assert.ok(r.offenders.some(o => o.reason === 'PL_REJECT_BAD_NEW_DATE'));
});
t('R15-P3', 'cells O:Q 原日期非法 → 拒（原值未知）', () => {
  freshDb();
  env._sheets['DB_工时流水'].getRange(2, 2).setValue('garbage');
  const r = _plGuardPatch(env._sheets['DB_工时流水'], [[2, 15, true]], []);
  assert.strictEqual(r.ok, false);
  assert.ok(r.offenders.some(o => o.reason === 'PL_REJECT_ORIG_UNKNOWN'));
});
t('R15-P4', 'B cells 原行不存在 → 放行（新增）', () => {
  freshDb();
  const r = _plGuardPatch(env._sheets['DB_工时流水'], [[999, 2, '2026-10-20']], []);
  assert.strictEqual(r.ok, true);
});
t('R15-P5', 'B cells 10月行改10-20 → 放行', () => {
  freshDb();
  const r = _plGuardPatch(env._sheets['DB_工时流水'], [[3, 2, '2026-10-20']], []);
  assert.strictEqual(r.ok, true);
});
t('R15-P6', 'B cells 9月行 → 拒', () => {
  freshDb();
  const r = _plGuardPatch(env._sheets['DB_工时流水'], [[2, 2, '2026-10-20']], []);
  assert.strictEqual(r.ok, false);
  assert.ok(r.offenders.some(o => o.reason === 'PL_REJECT_ORIG_DATE_CLOSED'));
});
t('R15-P7', '非B/O:Q列（G列工时）→ 不拦（覆盖边界）', () => {
  freshDb();
  const r = _plGuardPatch(env._sheets['DB_工时流水'], [[2, 7, 3.5]], []);
  assert.strictEqual(r.ok, true);
});
t('R15-P8', 'ranges 同时覆盖 B 与 O:Q → 两规则都执行', () => {
  freshDb();
  // 宽 range（B..Q，col2 起 16 列宽）同时覆盖 B 与 O:Q
  function wideRange(row, bVal, delVal) {
    var v = new Array(16).fill('');
    v[0] = bVal; v[13] = delVal;                         // B=索引0, O=索引13
    return { row: row, col: 2, values: [v] };
  }
  // 行3（10月）B 合法且软删合法（10月可删）→ 放行
  const ok = _plGuardPatch(env._sheets['DB_工时流水'], [], [wideRange(3, '2026-10-25', true)]);
  assert.strictEqual(ok.ok, true);
  // 行2（9月）→ B 与 O:Q 双拒
  const bad = _plGuardPatch(env._sheets['DB_工时流水'], [], [wideRange(2, '2026-10-25', true)]);
  assert.strictEqual(bad.ok, false);
  assert.ok(bad.offenders.length >= 2, 'B 与 O:Q 均产出 offender');
});

// ============================================================
// R16/R17：解析完整锚定 + 回退保留
// ============================================================
t('R16', '业务日解析完整锚定', () => {
  freshDb();
  assert.strictEqual(_plParseBizDate('2026-10-01garbage'), null, '尾缀垃圾必须拒');
  assert.strictEqual(_plParseBizDate('2026-10-01T25:99'), null, '非法时分拒');
  assert.strictEqual(_plParseBizDate('2026-13-01'), null, '越界月拒');
  assert.strictEqual(_plParseBizDate('2026/10/1'), '2026-10-01', 'yyyy/M/d 接受');
  assert.strictEqual(_plParseBizDate('2026-10-01T08:30'), '2026-10-01');
  assert.strictEqual(_plParseBizDate('2026-10-01 08:30:00'), '2026-10-01');
  assert.strictEqual(_plParseBizDate(new Date(Date.UTC(2026, 8, 15))), '2026-09-15', 'Date 对象 GMT+8 归日');
  assert.strictEqual(_plGuardCheck('2026-10-01garbage', null, _plPolicy()).reason, 'PL_REJECT_BAD_NEW_DATE');
});
t('R17', '回退保留：集成源码含全部5入口+执行锁保留条款', () => {
  const src = fs.readFileSync(path.join(__dirname, 'period_lock_integrated_src.gs'), 'utf8');
  ['submitBatch', 'updateTimesheet', 'softDeleteRecord', 'tsAppendRows', 'tsPatchCells'].forEach(fn => {
    assert.ok(src.indexOf('function ' + fn + '(') >= 0, '集成源码须含 ' + fn);
  });
  assert.ok(!/\.\.\./.test(src.replace(/\/\/.*$/gm, '')), '集成源码不得含省略号（可完整核对）');
});

// ============================================================
// 汇总
// ============================================================
const pass = results.filter(r => r.ok).length;
const fail = results.filter(r => !r.ok);
results.forEach(r => {
  console.log((r.ok ? '✅' : '❌') + ' ' + r.id + ' ' + r.name + (r.ok ? '' : '  → ' + r.err));
});
console.log('----------------------------------------');
console.log('R1-R17: ' + pass + '/' + results.length + ' 通过' + (fail.length ? '，' + fail.length + ' 失败' : '（fail-closed 全绿）'));
process.exit(fail.length ? 1 : 0);
