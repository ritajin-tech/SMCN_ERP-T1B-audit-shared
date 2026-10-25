/**
 * T1-B · period-lock guard R1-R17 + I1-I8 + V1-V12 + W1-W8 测试件 v5（Node 可跑 · fail-closed）
 * ============================================================
 * 用法：node period_lock_tests.js   退出码：全绿 exit 0；任一失败 exit 1。
 * v3 相对 v2（应 Tom 09:59 五条）：
 *   [审①] R10f 删除幂等（expectDeleted）、R10g 哈希覆盖 K/M 列；
 *          I1/I2/I3 真实入口版本绑定与删除幂等（锁外读→锁内重核竞态注入）。
 *   [审②] R12e 全重复批次：skippedAll 约定、bizWrite 零调用、零登记；
 *          I4/I5 submitBatch/tsAppendRows 全重复回报（含 I4b/I5b 正常写对照）。
 *   [审③] R12d 登记表不存在返回 false 且不自动建表；R13 登记失败 plLogFailed 外显；
 *          I7 tsPatchCells 写阶段异常+无登记表 → JSON logFailed:true。
 *   [审④] R11b cutoff 真实日历校验（假日期回退）；R7/R7b/R7c 故障收紧登记
 *          （读取故障 = closed=true + futureOpen=false；原 futureClosed 不放开）。
 *   [审⑤] R15-P9 表头行保护；R15-P10 O:Q 期间政策统一；I6/I6b/I8 入口层。
 *   R18s 入口层接线静态核查（版本哈希×2、删除期望×2、返回约定×2、外显接线）。
 * v4 相对 v3（应 Tom 10:58 四条）：
 *   [审①-版本] V1/V2 入口缺 expectContentHash → MISSING_EXPECT_VERSION 缺省拒；
 *          V3 请求级旧版本（A 改后 B 带编辑时旧版本到达）→ 锁内实读不符即拒；
 *          I1/I2/I3 改传请求携带版本（竞态注入语义不变）。
 *   [审②-编码] V4 分隔冲突反例（[a\u0001b,c] vs [a,b\u0001c] 旧 join 同串=漏拒；
 *          v4 含分隔符 → hash=null）；V4b 锁内行含分隔符 → 不符期望版本拒。
 *   [审③-分层] V5 flush失败+登记成功 → plLogFailed=false（误报已修）；
 *          V6 flush失败+登记失败 → plLogFailed=true；V7 bizWrite 普通失败 →
 *          PL_UNCERTAIN_BIZ_WRITE_FAILED+plCause（与预检拒绝分层）；R12b/R12b2/R13
 *          断言随新语义更新；R12c 补 plLogFailed=false 断言。
 *   [审④-结构] V8 policy={} → schema-error 收紧；V9 futureOpen 字符串 false → 收紧；
 *          V10 closed 非布尔 → 收紧；V11 初始化哨兵三态（无INIT=首次态；
 *          INIT有+策略键丢失/空串=policy-lost 收紧）。
 * v5 相对 v4（应 Tom 11:27 两条）：
 *   [审⑥] W1/W1b 哨兵读取故障（仅 INIT key 抛错注入）→ sentinel-unknown 收紧，
 *          含「策略键有合法值+哨兵读不到」组合；W3 真首次态保持 futureOpen=true
 *          （与 W1/W1b 对照，证明收紧不是一刀切）；W4 _plSetPolicy 保守写序静态核查。
 *   [审⑦] W5/W6/W7/W8 真实 tsAppendRows 入口输出契约：业务写失败/flush 失败
 *   [审⑧] X1-X6 错误传输接口契约（runbook v3 §2.5）：uncertain 态 message 载荷
 *          序列化（<码>|{"logFailed":bool,"cause":…}）可恢复登记真假与原因；拒绝码
 *          无载荷；前端三档渲染（含「登记状态未知」禁默认 false）从交付件实抽实测。
 *          → plCode+plCause 齐全+登记成功 logFailed=false；登记失败 → logFailed=true
 *          且码/因不丢；辅助 _tsWriteLog 失败 → 原 uncertain 不遮蔽+logFailed=true
 *          +不自动重放业务写（行数基线不变）。
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
const integratedSrc = fs.readFileSync(path.join(__dirname, 'period_lock_integrated_src.gs'), 'utf8');

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
          setValue(v) {
            if (env._writeExplodes) throw new Error('write exploded');
            if (!self._rows[a - 1]) self._rows[a - 1] = new Array(17).fill('');
            self._rows[a - 1][b - 1] = v;
          },
          getValue() { return self._rows[a - 1][b - 1]; }
        };
      }
      return {
        getValues: () => self._rows.slice(a - 1, a - 1 + c).map(r => r.slice(b - 1, b - 1 + d)),
        setValues: (vals) => {
          if (env._writeExplodes) throw new Error('write exploded');
          for (let i = 0; i < vals.length; i++) {
            while (self._rows.length < a - 1 + i + 1) self._rows.push(new Array(17).fill(''));
            for (let j = 0; j < vals[i].length; j++)
              self._rows[a - 1 + i][b - 1 + j] = vals[i][j];
          }
        }
      };
    },
    appendRow(arr) { this._rows.push(arr.slice()); },
    insertSheet(n) { const s = makeSheet(n, []); env._sheets[n] = s; return s; }
  };
  return sheet;
}

const env = {
  _props: new Map(), _propsBroken: false, _propsBrokenKeys: new Set(),
  _lock: { held: false, tryLockCalls: 0 },
  _flushCount: 0, _flushThrows: false,
  _writeExplodes: false,
  _writeLogThrows: false,
  _writeLog: [],
  _sheets: {},
  reset() {
    this._props = new Map(); this._propsBroken = false; this._propsBrokenKeys = new Set();
    this._lock = { held: false, tryLockCalls: 0 };
    this._flushCount = 0; this._flushThrows = false;
    this._writeExplodes = false;
    this._writeLogThrows = false;
    this._writeLog = [];
    this._sheets = {};
  }
};

global.TS_ID = 'MOCK_TS_ID';
let _uuidSeq = 0;
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
  getUuid: () => 'uuid-mock-' + (++_uuidSeq)
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
    // [审⑥-v5] 按 key 故障注入：_propsBrokenKeys 中的 key 抛错，用于区分
    // 「读到 null=确定未初始化」与「读取异常=unknown」两态（哨兵三态测试）。
    getProperty: (k) => {
      if (env._propsBroken) throw new Error('props unavailable');
      if (env._propsBrokenKeys && env._propsBrokenKeys.has(k)) throw new Error('props unavailable: ' + k);
      return env._props.has(k) ? env._props.get(k) : null;
    },
    setProperty: (k, v) => { env._props.set(k, v); }
  })
};

// ============================================================
// 1b. 入口层依赖 mock（ts-manager 既有工具函数，period-lock 不改其语义）
// ============================================================
global.getCurrentUser = (token) => ({ name: '张三', leader: '李经理' });
global.getProjectMap = () => ({});
global.getDbSheet = () => env._sheets['DB_工时流水'];
global.formatPid = (p) => String(p || '');
global._tsDeriveType = (f) => '执行端';
global._tsDupKey = (name, date, pid, hours, stage, notes) => [name, date, pid, hours, stage, notes].join('|');
global.safeGetUuid = (v) => String(v === null || v === undefined ? '' : v).trim();
global._tsIsLeaveRowForGuard = (r) => false;
global._tsWriteLog = (a, b) => {
  if (env._writeLogThrows) throw new Error('write-log exploded');   // [审⑦-v5] 辅助日志故障注入
  env._writeLog.push([String(a), String(b)]);
};

(0, eval)(integratedSrc);

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
  // 登记表属部署前置（部署包显式建表）；freshDb 默认已建
  env._sheets['_TS_WRITE_LOG'] = makeSheet('_TS_WRITE_LOG', [['ts', 'action', 'detail']]);
}
function row14(bizDate, uuid) {
  const a = new Array(14).fill('');
  a[1] = bizDate; a[8] = uuid;
  return a;
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
t('R7', '配置读取失败 → fail-closed（收紧：未来也拒）', () => {
  freshDb();
  env._propsBroken = true;
  const p = _plPolicy();
  assert.strictEqual(p.closed, true); assert.strictEqual(p.source, 'fail-closed');
  assert.strictEqual(_plGuardCheck('2026-09-15', null, p).ok, false);
});
t('R7b', 'v3 收紧登记：读取故障 → 未来写也拒（未知时拒绝受影响写）', () => {
  freshDb();
  env._propsBroken = true;
  const p = _plPolicy();
  const r = _plGuardCheck('2026-10-15', null, p);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'PL_REJECT_FUTURE_CLOSED');
});
t('R7c', '故障不放宽：原 futureClosed 状态下读取故障仍拒未来', () => {
  freshDb();
  _plSetPolicy(true, false, 'rita');           // 原本 futureClosed
  env._propsBroken = true;                      // 读取故障不得把它放开
  const p = _plPolicy();
  assert.strictEqual(p.source, 'fail-closed');
  assert.strictEqual(p.futureOpen, false, '故障不得放开未来');
  assert.strictEqual(_plGuardCheck('2026-10-15', null, p).reason, 'PL_REJECT_FUTURE_CLOSED');
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
// R10 组：锁内重核（行号/版本/唯一性/归属/删除状态）
// ============================================================
t('R10a', '锁内重核返回实际行号+内容哈希', () => {
  freshDb();
  const sh = env._sheets['DB_工时流水'];
  const rc = _plRecheckRow(sh, 'UUID-OCT-NEW', contentHashOf(sh, 3), null);
  assert.strictEqual(rc.found, true); assert.strictEqual(rc.row, 3);
  assert.strictEqual(rc.bizDate, '2026-10-15');
  assert.ok(rc.contentHash && rc.contentHash.length > 0);
});
t('R10a0', '[审①-v4] expectContentHash 缺省 → MISSING_EXPECT_VERSION（请求级版本 fail-closed）', () => {
  freshDb();
  const rc = _plRecheckRow(env._sheets['DB_工时流水'], 'UUID-OCT-NEW', null, null);
  assert.strictEqual(rc.mismatch, true);
  assert.strictEqual(rc.reason, 'PL_REJECT_MISSING_EXPECT_VERSION');
  const rc2 = _plRecheckRow(env._sheets['DB_工时流水'], 'UUID-OCT-NEW', '', null);
  assert.strictEqual(rc2.reason, 'PL_REJECT_MISSING_EXPECT_VERSION', '空串同样缺省拒');
});
t('R10a2', '行消失 → ROW_GONE', () => {
  freshDb();
  const rc = _plRecheckRow(env._sheets['DB_工时流水'], 'UUID-NOPE', 'any-nonempty-hash', null);
  assert.strictEqual(rc.mismatch, true); assert.strictEqual(rc.reason, 'PL_REJECT_ROW_GONE');
});
t('R10a3', '重复 UUID → NOT_UNIQUE（无唯一性即拒）', () => {
  freshDb();
  env._sheets['DB_工时流水']._rows.push(dbRow('2026-10-20', 'UUID-OCT-NEW'));
  const rc = _plRecheckRow(env._sheets['DB_工时流水'], 'UUID-OCT-NEW', 'any-nonempty-hash', null);
  assert.strictEqual(rc.mismatch, true); assert.strictEqual(rc.reason, 'PL_REJECT_UUID_NOT_UNIQUE');
});
t('R10a4', '锁内姓名不符 → OWNER_MISMATCH', () => {
  freshDb();
  const rc = _plRecheckRow(env._sheets['DB_工时流水'], 'UUID-OCT-NEW', 'any-nonempty-hash', '李四');
  assert.strictEqual(rc.mismatch, true); assert.strictEqual(rc.reason, 'PL_REJECT_OWNER_MISMATCH');
});
t('R10a5', '锁内原值未知（B列非法）→ ORIG_UNKNOWN', () => {
  freshDb();
  env._sheets['DB_工时流水'].getRange(3, 2).setValue('garbage-date');
  const rc = _plRecheckRow(env._sheets['DB_工时流水'], 'UUID-OCT-NEW', 'any-nonempty-hash', null);
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
    expectContentHash: contentHashOf(sh, 3),
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
    expectContentHash: contentHashOf(env._sheets['DB_工时流水'], 3),
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
t('R10f', '[审①] 删除幂等：expectDeleted=false 且锁内已删 → ALREADY_DELETED', () => {
  freshDb();
  const sh = env._sheets['DB_工时流水'];
  const h = contentHashOf(sh, 3);
  sh.getRange(3, 15).setValue(true);
  const rc = _plRecheckRow(sh, 'UUID-OCT-NEW', h, null, false);
  assert.strictEqual(rc.mismatch, true);
  assert.strictEqual(rc.reason, 'PL_REJECT_ALREADY_DELETED');
});
t('R10g', '[审①] 内容哈希覆盖 K/M 列：改 K 列 → 版本不符', () => {
  freshDb();
  const sh = env._sheets['DB_工时流水'];
  const h1 = contentHashOf(sh, 3);
  sh.getRange(3, 11).setValue('K-CHANGED');    // K 列（0 基索引 10）进哈希
  const rc = _plRecheckRow(sh, 'UUID-OCT-NEW', h1, null, null);
  assert.strictEqual(rc.mismatch, true);
  assert.strictEqual(rc.reason, 'PL_REJECT_CONTENT_VERSION');
  // 对照：M 列（0 基索引 12）
  const h2 = contentHashOf(sh, 3);
  sh.getRange(3, 13).setValue('M-CHANGED');
  const rc2 = _plRecheckRow(sh, 'UUID-OCT-NEW', h2, null, null);
  assert.strictEqual(rc2.mismatch, true);
  assert.strictEqual(rc2.reason, 'PL_REJECT_CONTENT_VERSION');
});

// ============================================================
// R11/R12 组
// ============================================================
t('R11', '策略持久化往返 + cutoff 坏值收紧（v4：schema-error 整体 fail-closed）', () => {
  freshDb();
  _plSetPolicy(true, true, 'rita');
  const p1 = _plPolicy();
  assert.strictEqual(p1.closed, true); assert.strictEqual(p1.updatedBy, 'rita');
  // cutoff 坏值 → v4 [审④] 判定结构非法 → 整体收紧（fail-closed，cutoff 取内置值）
  env._props.set('PERIOD_LOCK_STATE', JSON.stringify({ closed: true, cutoff: 'garbage', futureOpen: true }));
  const p2 = _plPolicy();
  assert.strictEqual(p2.source, 'fail-closed', '坏 cutoff 属结构非法：收紧而非静默回退');
  assert.strictEqual(p2.cutoff, PL_CUTOFF, '收紧态 cutoff 取内置值，不得改变历史判定');
  assert.strictEqual(p2.futureOpen, false, '结构非法不得默认未来开放');
  const src = fs.readFileSync(path.join(__dirname, 'period_lock_integrated_src.gs'), 'utf8');
  assert.ok(src.indexOf('入口 1/5') >= 0 && src.indexOf('入口 5/5') >= 0, '集成源码须含全部 5 入口');
});
t('R11b', '[审④] cutoff 真实日历校验：假日期收紧+v3 回退语义由 schema 校验接管', () => {
  freshDb();
  assert.strictEqual(_plValidCutoff('2026-10-01'), true);
  assert.strictEqual(_plValidCutoff('2026-00-01'), false, '零月拒');
  assert.strictEqual(_plValidCutoff('2026-13-01'), false, '越界月拒');
  assert.strictEqual(_plValidCutoff('2026-02-30'), false, '不存在的日拒');
  assert.strictEqual(_plValidCutoff('2026-2-30'), false, '短格式假日期同样拒');
  assert.strictEqual(_plValidCutoff('garbage'), false);
  env._props.set('PERIOD_LOCK_STATE', JSON.stringify({ closed: true, cutoff: '2026-02-30', futureOpen: true }));
  const p = _plPolicy();
  assert.strictEqual(p.source, 'fail-closed', '假 cutoff 属结构非法：收紧');
  assert.strictEqual(p.cutoff, PL_CUTOFF, '收紧态 cutoff 取内置值，不得改变历史判定');
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
t('R12b', '[审③] 业务写普通异常 → 统一 PL_UNCERTAIN_BIZ_WRITE_FAILED+plCause（与预检拒绝分层）', () => {
  freshDb();
  const sh = env._sheets['DB_工时流水'];
  const before = logRows();
  let calls = 0;
  const err = expectReject(() => _plGuardedMutation({
    sheet: sh, uuid: 'UUID-OCT-NEW', newDateRaw: '2026-10-20',
    expectContentHash: contentHashOf(sh, 3),
    bizWrite: () => { calls++; throw new Error('Exception: 服务超时'); }   // 普通 Error
  }), 'PL_UNCERTAIN_BIZ_WRITE_FAILED');
  assert.strictEqual(calls, 1, '不得重放');
  assert.strictEqual(err.plCause, 'Exception: 服务超时', '保留原始原因');
  assert.strictEqual(err.plLogFailed, false, '登记成功不误报 plLogFailed');
  assert.strictEqual(env._lock.held, false, 'finally 释放');
  assert.strictEqual(logRows() - before, 1, 'R12b：进入写阶段的任何异常登记一次');
});
t('R12b2', '部分写后普通异常 → 登记（结果不确定）+ uncertain 码', () => {
  freshDb();
  const sh = env._sheets['DB_工时流水'];
  const before = logRows();
  expectReject(() => _plGuardedMutation({
    sheet: sh, uuid: 'UUID-OCT-NEW', newDateRaw: '2026-10-20',
    expectContentHash: contentHashOf(sh, 3),
    bizWrite: (recheck) => {
      sh.getRange(recheck.row, 2).setValue('2026-10-20');   // 前半已写
      throw new Error('Exception: 中途中断');               // 后半失败
    }
  }), 'PL_UNCERTAIN_BIZ_WRITE_FAILED');
  assert.strictEqual(logRows() - before, 1, '部分写后异常必须登记不确定');
});
t('R12c', 'flush 抛错 → PL_UNCERTAIN 且只登记一次（不双登记）+ plLogFailed=false', () => {
  freshDb();
  const sh = env._sheets['DB_工时流水'];
  const before = logRows();
  env._flushThrows = true;
  const err = expectReject(() => _plGuardedMutation({
    sheet: sh, uuid: 'UUID-OCT-NEW', newDateRaw: '2026-10-20',
    expectContentHash: contentHashOf(sh, 3),
    bizWrite: (recheck) => { sh.getRange(recheck.row, 2).setValue('2026-10-20'); return 'SUCCESS'; }
  }), 'PL_UNCERTAIN_FLUSH_FAILED');
  assert.strictEqual(logRows() - before, 1, 'flush 失败只登记一次');
  assert.strictEqual(err.plLogFailed, false, '[审③] 登记成功不得误报 plLogFailed');
  assert.strictEqual(env._lock.held, false);
});
t('R12d', '[审③] 登记表不存在 → 返回 false 且不自动建表（建表=授权动作）', () => {
  freshDb();
  delete env._sheets['_TS_WRITE_LOG'];
  assert.strictEqual(_plLogUncertain('unit', 'detail'), false, '登记失败返回 false');
  assert.ok(!env._sheets['_TS_WRITE_LOG'], '不得自动建表（部署包显式负责）');
});
t('R12e', '[审②] 全重复批次：skippedAll 约定 + bizWrite 零调用 + 零登记', () => {
  freshDb();
  const sh = env._sheets['DB_工时流水'];
  const before = logRows();
  let calls = 0;
  const res = _plGuardedInsert({
    sheet: sh,
    rows: [['ts', '2026-10-16'], ['ts', '2026-10-17']],
    dateOf: (r) => r[1],
    lockPreWrite: () => ({ rows: [], duplicates: 2 }),
    bizWrite: () => { calls++; return 'SUCCESS'; }
  });
  assert.strictEqual(res.wrote, 0);
  assert.strictEqual(res.duplicates, 2);
  assert.strictEqual(res.skippedAll, true);
  assert.strictEqual(calls, 0, '全重复不得进入业务写');
  assert.strictEqual(sh._rows.length, 3, '不得构造高度 0 区域');
  assert.strictEqual(logRows() - before, 0, '全重复不得误登记不确定');
});
t('R13', '[审③] 登记写失败 → PL_UNCERTAIN_BIZ_WRITE_FAILED + plLogFailed 外显（不吞不阻断传播）', () => {
  freshDb();
  env._sheets['_TS_WRITE_LOG'] = { appendRow() { throw new Error('log broken'); }, _rows: [] };
  assert.strictEqual(_plLogUncertain('unit', 'detail'), false, '登记失败返回 false');
  const sh = env._sheets['DB_工时流水'];
  const err = expectReject(() => _plGuardedMutation({
    sheet: sh, uuid: 'UUID-OCT-NEW', newDateRaw: '2026-10-20',
    expectContentHash: contentHashOf(sh, 3),
    bizWrite: () => { throw new Error('Exception: x'); }
  }), 'PL_UNCERTAIN_BIZ_WRITE_FAILED');
  assert.strictEqual(err.plLogFailed, true, '登记失败必须挂标识外显');
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
// R15 组：_plGuardPatch（[审1] 三态全覆盖 + [审⑤] 表头保护/政策统一）
// ============================================================
t('R15-P1', 'ranges O:Q 写9月行 → 拒（[审⑤] 统一期间政策：新=原，新值检查先触发）', () => {
  freshDb();
  const r = _plGuardPatch(env._sheets['DB_工时流水'], [], [{ row: 2, col: 15, values: [[true]] }]);
  assert.strictEqual(r.ok, false);
  assert.ok(r.offenders.some(o => o.reason === 'PL_REJECT_NEW_DATE_CLOSED'),
    'O:Q 删除与 mutation 同一期间政策：9月行的删除标记以新值期间拒');
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
t('R15-P9', '[审⑤] 表头行(第1行) B 列与 O:Q → HEADER_ROW（禁把表头当新增行）', () => {
  freshDb();
  const r1 = _plGuardPatch(env._sheets['DB_工时流水'], [[1, 2, '2026-10-20']], []);
  assert.strictEqual(r1.ok, false);
  assert.ok(r1.offenders.some(o => o.reason === 'PL_REJECT_HEADER_ROW'));
  const r2 = _plGuardPatch(env._sheets['DB_工时流水'], [[1, 15, true]], []);
  assert.strictEqual(r2.ok, false);
  assert.ok(r2.offenders.some(o => o.reason === 'PL_REJECT_HEADER_ROW'));
  // ranges 落到表头行同样拒
  const r3 = _plGuardPatch(env._sheets['DB_工时流水'], [], [{ row: 1, col: 2, values: [['2026-10-20']] }]);
  assert.strictEqual(r3.ok, false);
  assert.ok(r3.offenders.some(o => o.reason === 'PL_REJECT_HEADER_ROW'));
});
t('R15-P10', '[审⑤] O:Q 删除走同一期间政策：futureOpen=false 时10月删 → FUTURE_CLOSED', () => {
  freshDb();
  _plSetPolicy(true, false, 'test');
  const r = _plGuardPatch(env._sheets['DB_工时流水'], [[3, 15, true]], []);
  assert.strictEqual(r.ok, false);
  assert.ok(r.offenders.some(o => o.reason === 'PL_REJECT_FUTURE_CLOSED'),
    'O:Q 删除与 mutation 必须同一期间政策（含 futureOpen）');
});

// ============================================================
// R16/R17：解析完整锚定 + 回退保留 + 入口接线静态核查
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
t('R17', '回退保留：集成源码含全部5入口+无省略号', () => {
  const src = fs.readFileSync(path.join(__dirname, 'period_lock_integrated_src.gs'), 'utf8');
  ['submitBatch', 'updateTimesheet', 'softDeleteRecord', 'tsAppendRows', 'tsPatchCells'].forEach(fn => {
    assert.ok(src.indexOf('function ' + fn + '(') >= 0, '集成源码须含 ' + fn);
  });
  assert.ok(!/\.\.\./.test(src.replace(/\/\/.*$/gm, '')), '集成源码不得含省略号（可完整核对）');
});
t('R18s', '入口层接线静态核查（[审①-v4][审②][审③]）', () => {
  const src = fs.readFileSync(path.join(__dirname, 'period_lock_integrated_src.gs'), 'utf8');
  assert.strictEqual((src.match(/expectContentHash: expectVersion/g) || []).length, 2,
    'updateTimesheet 与 softDeleteRecord 都须将请求携带版本传入 guard');
  assert.strictEqual((src.match(/new Error\('PL_REJECT_MISSING_EXPECT_VERSION'\)/g) || []).length, 2,
    '两个 mutation 入口缺期望版本都须缺省拒（构造点计数）');
  assert.strictEqual((src.match(/expectDeleted: false/g) || []).length, 2,
    '两个 mutation 入口都须传删除幂等期望');
  assert.strictEqual((src.match(/return \{ rows: kept, duplicates: skipped(?:Dup)? \};/g) || []).length, 2,
    'submitBatch 与 tsAppendRows 的 lockPreWrite 统一返回 {rows,duplicates}');
  assert.ok(src.indexOf('plLogFailed') >= 0, '登记失败外显须接线到入口');
  assert.ok(src.indexOf('plCause') >= 0, '结果不确定须保留原原因并透出');
  assert.ok(src.indexOf('skippedAll') >= 0, '全重复返回约定须接线到入口');
  assert.ok(src.indexOf('PL_UNCERTAIN_PATCH_WRITE_FAILED') >= 0, 'patch 入口写阶段失败须有统一 uncertain 码');
  // guard 层的 PL_UNCERTAIN_BIZ_WRITE_FAILED 由 V7/R12b 动态用例实证（不在集成源码构造）
  assert.ok(/PL_UNCERTAIN_BIZ_WRITE_FAILED/.test(guardSrc), 'guard 须统一包装写阶段失败');
  assert.ok(!/expectContentHash: _plRowContentHash/.test(src),
    'v4 起不得再用「请求到达后新读的行」充当期望版本（请求级绑定）');
});

// ============================================================
// I1-I8 组：5 个真实入口端到端（Node mock GAS）
// ============================================================
t('I1', 'updateTimesheet 版本绑定：锁内发现内容被外部写者改 → CONTENT_VERSION', () => {
  freshDb();
  const sh = env._sheets['DB_工时流水'];
  const reqVersion = contentHashOf(sh, 3);      // 请求携带的期望版本（编辑依据）
  // 竞态注入：锁外读（第1次 getDataRange）后、锁内重核（第2次）前，外部写者改了 G 列
  let dataCalls = 0;
  const origGDR = sh.getDataRange.bind(sh);
  sh.getDataRange = function () {
    dataCalls++;
    const mutate = (dataCalls === 2);
    return { getValues: () => {
      const d = origGDR().getValues();
      if (mutate) d[2][6] = 99;                  // 锁内视图：G 列被外部改
      return d;
    }};
  };
  let err = null;
  try {
    updateTimesheet('tok', { uuid: 'UUID-OCT-NEW', date: '2026-10-20', stage: '1.1', project: 'PRJ-1', hours: 8, notes: '', expectContentHash: reqVersion });
  } catch (e) { err = e; }
  assert.ok(err, '必须拒');
  assert.strictEqual(err.plCode, 'PL_REJECT_CONTENT_VERSION', '入口须传版本哈希并保留拒绝码');
  assert.strictEqual(sh._rows[2][6], 8, '不自动回滚：真实表值未被入口改写');
});
t('I2', 'updateTimesheet 删除幂等：锁内发现行已删 → ALREADY_DELETED', () => {
  freshDb();
  const sh = env._sheets['DB_工时流水'];
  const reqVersion = contentHashOf(sh, 3);
  let dataCalls = 0;
  const origGDR = sh.getDataRange.bind(sh);
  sh.getDataRange = function () {
    dataCalls++;
    const mutate = (dataCalls === 2);
    return { getValues: () => {
      const d = origGDR().getValues();
      if (mutate) d[2][14] = true;               // 锁内视图：已删
      return d;
    }};
  };
  let err = null;
  try {
    updateTimesheet('tok', { uuid: 'UUID-OCT-NEW', date: '2026-10-20', stage: '1.1', project: 'PRJ-1', hours: 8, notes: '', expectContentHash: reqVersion });
  } catch (e) { err = e; }
  assert.ok(err, '必须拒');
  assert.strictEqual(err.plCode, 'PL_REJECT_ALREADY_DELETED');
});
t('I3', 'softDeleteRecord 再删已删行 → ALREADY_DELETED（删除幂等）', () => {
  freshDb();
  const sh = env._sheets['DB_工时流水'];
  const reqVersion = contentHashOf(sh, 3);
  sh.getRange(3, 15).setValue(true);             // 行3 已删
  let err = null;
  try { softDeleteRecord('tok', 'UUID-OCT-NEW', reqVersion); } catch (e) { err = e; }
  assert.ok(err, '必须拒');
  assert.strictEqual(err.plCode, 'PL_REJECT_ALREADY_DELETED');
});
t('I4', 'submitBatch 全重复（10分钟内同内容）→ 跳过期数回报，零写零登记', () => {
  freshDb();
  const sh = env._sheets['DB_工时流水'];
  sh.getRange(3, 1).setValue(new Date());        // 行3 A 列＝刚刚
  sh.getRange(3, 2).setValue('2026-10-20');      // 同日期同内容
  const before = logRows();
  const res = submitBatch('tok', [{ project: 'PRJ-1', date: '2026-10-20', hours: 8, stage: '1.1', notes: '' }]);
  assert.strictEqual(res, 'SUCCESS (skipped 1 duplicate)');
  assert.strictEqual(sh._rows.length, 3, '不得写入新行');
  assert.strictEqual(logRows() - before, 0, '全重复不得误登记不确定');
});
t('I4b', 'submitBatch 正常写 → SUCCESS 且落表（对照）', () => {
  freshDb();
  const sh = env._sheets['DB_工时流水'];
  const res = submitBatch('tok', [{ project: 'PRJ-1', date: '2026-10-20', hours: 8, stage: '1.1', notes: '' }]);
  assert.strictEqual(res, 'SUCCESS');
  assert.strictEqual(sh._rows.length, 4);
  assert.strictEqual(sh._rows[3][1], '2026-10-20');
});
t('I5', 'tsAppendRows 全重复（UUID 已存在）→ wrote=0 allDuplicates，零写', () => {
  freshDb();
  const sh = env._sheets['DB_工时流水'];
  const before = sh._rows.length;
  const out = JSON.parse(tsAppendRows({ postBody: { rows: [row14('2026-10-15', 'UUID-OCT-NEW')] } }));
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.wrote, 0);
  assert.strictEqual(out.allDuplicates, true);
  assert.strictEqual(out.duplicatesSkipped, 1);
  assert.strictEqual(sh._rows.length, before, '不得写入新行');
});
t('I5b', 'tsAppendRows 新 UUID → wrote=1 落表（对照）', () => {
  freshDb();
  const sh = env._sheets['DB_工时流水'];
  const out = JSON.parse(tsAppendRows({ postBody: { rows: [row14('2026-10-16', 'UUID-NEW-1')] } }));
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.wrote, 1);
  assert.strictEqual(sh._rows.length, 4);
  assert.strictEqual(sh._rows[3][8], 'UUID-NEW-1');
});
t('I6', 'tsPatchCells 表头行(第1行)B列 → 拒（禁把表头当新增行）', () => {
  freshDb();
  const out = JSON.parse(tsPatchCells({ postBody: { cells: [[1, 2, '2026-10-20']] } }));
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.plCode, 'PL_REJECT_PATCH_OFFENDERS');
  assert.ok(out.error.indexOf('PL_REJECT_HEADER_ROW') >= 0);
  assert.strictEqual(env._sheets['DB_工时流水']._rows[0][1], 'fillDate', '表头未被改动');
});
t('I6b', 'tsPatchCells 10月行 B 列改合法日期 → ok（对照）', () => {
  freshDb();
  const sh = env._sheets['DB_工时流水'];
  const out = JSON.parse(tsPatchCells({ postBody: { cells: [[3, 2, '2026-10-25']] } }));
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.patched, 1);
  assert.strictEqual(sh._rows[2][1], '2026-10-25');
});
t('I7', '[审③] 登记失败外显：写阶段异常 + 登记表不存在 → logFailed=true 且不自动建表', () => {
  freshDb();
  delete env._sheets['_TS_WRITE_LOG'];           // 部署前置未建表
  env._writeExplodes = true;                     // 写阶段爆炸
  const out = JSON.parse(tsPatchCells({ postBody: { cells: [[3, 2, '2026-10-25']] } }));
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.logFailed, true, '登记失败必须外显，不得吞');
  assert.ok(out.error.indexOf('登记失败') >= 0, '错误文案须含人工核查提示');
  assert.ok(!env._sheets['_TS_WRITE_LOG'], '不得自动建表');
});
t('I8', '[审⑤] tsPatchCells O:Q 与 futureOpen=false → FUTURE_CLOSED（期间政策一致）', () => {
  freshDb();
  _plSetPolicy(true, false, 'test');
  const out = JSON.parse(tsPatchCells({ postBody: { cells: [[3, 15, true]] } }));
  assert.strictEqual(out.ok, false);
  assert.ok(out.error.indexOf('PL_REJECT_FUTURE_CLOSED') >= 0,
    'O:Q 删除与 mutation 必须同一期间政策');
  assert.strictEqual(env._sheets['DB_工时流水']._rows[2][14], '', '未被误删');
});

// ============================================================
// V1-V12 组：v4 专项（Tom 10:58 四条）
// ============================================================
t('V1', '[审①-v4] updateTimesheet 请求缺 expectContentHash → MISSING_EXPECT_VERSION（缺省拒）', () => {
  freshDb();
  const err = expectReject(() => updateTimesheet('tok', {
    uuid: 'UUID-OCT-NEW', date: '2026-10-20', stage: '1.1', project: 'PRJ-1', hours: 8, notes: ''
  }), 'PL_REJECT_MISSING_EXPECT_VERSION');
  assert.strictEqual(err.plCode, 'PL_REJECT_MISSING_EXPECT_VERSION');
  assert.strictEqual(env._sheets['DB_工时流水']._rows[2][1], '2026-10-15', '零写');
});
t('V2', '[审①-v4] softDeleteRecord 请求缺 expectContentHash → MISSING_EXPECT_VERSION（缺省拒）', () => {
  freshDb();
  const err = expectReject(() => softDeleteRecord('tok', 'UUID-OCT-NEW'),
    'PL_REJECT_MISSING_EXPECT_VERSION');
  assert.strictEqual(err.plCode, 'PL_REJECT_MISSING_EXPECT_VERSION');
  assert.strictEqual(env._sheets['DB_工时流水']._rows[2][14], '', '未被删');
});
t('V3', '[审①-v4] 请求级旧版本：A 改完后 B 带编辑时旧版本到达 → 锁内实读不符即拒', () => {
  freshDb();
  const sh = env._sheets['DB_工时流水'];
  const v1 = contentHashOf(sh, 3);            // B 打开表单时服务端下发的版本
  // A 先完成一次合法修改（改 G 列工时，表内容变为 v2）
  _plGuardedMutation({
    sheet: sh, uuid: 'UUID-OCT-NEW', newDateRaw: '2026-10-15', expectContentHash: v1,
    bizWrite: (recheck) => { sh.getRange(recheck.row, 7).setValue(5); return 'SUCCESS'; }
  });
  // B 随后带旧版本 v1 的编辑请求到达：服务端锁外新读已是 v2，但请求携带 v1 → 拒
  const err = expectReject(() => updateTimesheet('tok', {
    uuid: 'UUID-OCT-NEW', date: '2026-10-20', stage: '1.1', project: 'PRJ-1', hours: 8, notes: '',
    expectContentHash: v1
  }), 'PL_REJECT_CONTENT_VERSION');
  assert.strictEqual(err.plCode, 'PL_REJECT_CONTENT_VERSION');
  assert.strictEqual(sh._rows[2][6], 5, 'A 的修改保留，B 的陈旧表单被拒');
});
t('V4', '[审②-编码] 分隔冲突反例：相邻列 [a\\u0001b,c] 与 [a,b\\u0001c] 旧 join 同串（漏拒）；v4 含分隔符 → hash=null', () => {
  const base = new Array(15).fill('');
  base[1] = '2026-10-15'; base[2] = '张三'; base[8] = 'UUID-1';
  // 相邻两列（G=索引6, H=索引7）分别放入两种分布
  const rA = base.slice(); rA[6] = 'a\u0001b'; rA[7] = 'c';
  const rB = base.slice(); rB[6] = 'a'; rB[7] = 'b\u0001c';
  // 反例前提（Tom 指摘的旧行为）：两行 join 后同串 → 版本冲突检测失效
  const joinA = rA.slice(1, 15).map(v => (v === null || v === undefined) ? '' : String(v)).join('\u0001');
  const joinB = rB.slice(1, 15).map(v => (v === null || v === undefined) ? '' : String(v)).join('\u0001');
  assert.strictEqual(joinA, joinB, '反例前提：旧 String+join 方案两行同串');
  // v4 行为：两行均不可无歧义定版 → null（调用方按 PL_REJECT_CONTENT_ENCODING 拒）
  assert.strictEqual(_plRowContentHash(rA), null, '含分隔符行不得产出哈希');
  assert.strictEqual(_plRowContentHash(rB), null);
  // 对照：无分隔符行正常产出
  assert.ok(_plRowContentHash(base) && _plRowContentHash(base).length > 0);
});
t('V4b', '[审②-编码] 锁内行含分隔符 → contentHash=null ≠ 期望版本 → 拒（fail-closed）', () => {
  freshDb();
  const sh = env._sheets['DB_工时流水'];
  sh.getRange(3, 8).setValue('bad\u0001val');          // H 列（col 8）注入分隔符
  const err = expectReject(() => updateTimesheet('tok', {
    uuid: 'UUID-OCT-NEW', date: '2026-10-20', stage: '1.1', project: 'PRJ-1', hours: 8, notes: '',
    expectContentHash: 'some-nonnull-version'
  }), 'PL_REJECT_CONTENT_VERSION');
  assert.strictEqual(err.plCode, 'PL_REJECT_CONTENT_VERSION');
});
t('V5', '[审③] flush 失败+登记成功 → PL_UNCERTAIN_FLUSH_FAILED 且 plLogFailed=false（误报已修）', () => {
  freshDb();
  const sh = env._sheets['DB_工时流水'];
  env._flushThrows = true;
  const err = expectReject(() => _plGuardedMutation({
    sheet: sh, uuid: 'UUID-OCT-NEW', newDateRaw: '2026-10-20',
    expectContentHash: contentHashOf(sh, 3),
    bizWrite: (recheck) => { sh.getRange(recheck.row, 2).setValue('2026-10-20'); return 'SUCCESS'; }
  }), 'PL_UNCERTAIN_FLUSH_FAILED');
  assert.strictEqual(err.plLogFailed, false, '登记成功不得误报 plLogFailed');
  assert.ok(err.plCause && err.plCause.length > 0, '保留原始原因');
});
t('V6', '[审③] flush 失败+登记失败（无登记表）→ plLogFailed=true', () => {
  freshDb();
  const sh = env._sheets['DB_工时流水'];
  delete env._sheets['_TS_WRITE_LOG'];
  env._flushThrows = true;
  const err = expectReject(() => _plGuardedMutation({
    sheet: sh, uuid: 'UUID-OCT-NEW', newDateRaw: '2026-10-20',
    expectContentHash: contentHashOf(sh, 3),
    bizWrite: (recheck) => { sh.getRange(recheck.row, 2).setValue('2026-10-20'); return 'SUCCESS'; }
  }), 'PL_UNCERTAIN_FLUSH_FAILED');
  assert.strictEqual(err.plLogFailed, true, '登记失败必须外显');
});
t('V7', '[审③] bizWrite 普通失败+登记成功 → PL_UNCERTAIN_BIZ_WRITE_FAILED+plCause+plLogFailed=false', () => {
  freshDb();
  const sh = env._sheets['DB_工时流水'];
  const err = expectReject(() => _plGuardedMutation({
    sheet: sh, uuid: 'UUID-OCT-NEW', newDateRaw: '2026-10-20',
    expectContentHash: contentHashOf(sh, 3),
    bizWrite: () => { throw new Error('Exception: 服务超时'); }
  }), 'PL_UNCERTAIN_BIZ_WRITE_FAILED');
  assert.strictEqual(err.plCause, 'Exception: 服务超时', '保留原原因');
  assert.strictEqual(err.plLogFailed, false, '登记成功不误报');
});
t('V8', '[审④] policy={} → schema-error 收紧（不得默认未来开放）', () => {
  freshDb();
  env._props.set('PERIOD_LOCK_STATE', '{}');
  const p = _plPolicy();
  assert.strictEqual(p.source, 'fail-closed');
  assert.strictEqual(p.updatedBy, 'fail-closed-schema-error');
  assert.strictEqual(p.closed, true);
  assert.strictEqual(p.futureOpen, false, '空对象不得默认未来开放');
});
t('V9', '[审④] futureOpen 为字符串 false → schema-error 收紧', () => {
  freshDb();
  env._props.set('PERIOD_LOCK_STATE', JSON.stringify({ closed: true, cutoff: '2026-10-01', futureOpen: 'false' }));
  const p = _plPolicy();
  assert.strictEqual(p.source, 'fail-closed', '字符串 false 不是布尔：结构非法');
  assert.strictEqual(p.futureOpen, false);
});
t('V10', '[审④] closed 非布尔 → schema-error 收紧', () => {
  freshDb();
  env._props.set('PERIOD_LOCK_STATE', JSON.stringify({ closed: 'true', cutoff: '2026-10-01', futureOpen: true }));
  assert.strictEqual(_plPolicy().source, 'fail-closed', 'closed 必须为布尔');
  // 缺 futureOpen 字段同样拒
  env._props.set('PERIOD_LOCK_STATE', JSON.stringify({ closed: true, cutoff: '2026-10-01' }));
  assert.strictEqual(_plPolicy().source, 'fail-closed', '缺必需字段：结构非法');
});
t('V11', '[审④] 初始化哨兵三态：无INIT=首次态；INIT有+策略键丢失/空串=policy-lost 收紧', () => {
  freshDb();
  // 场景1：从未初始化（无 INIT 无 key）→ 真首次态
  const p1 = _plPolicy();
  assert.strictEqual(p1.source, 'unset');
  assert.strictEqual(p1.futureOpen, true, '真首次态未来放行');
  // 场景2：曾初始化 → 策略键丢失（保留 INIT）→ policy-lost 收紧
  _plSetPolicy(true, false, 'rita');
  assert.strictEqual(env._props.get('PERIOD_LOCK_POLICY_INIT'), '1', '_plSetPolicy 须写哨兵');
  env._props.delete('PERIOD_LOCK_STATE');
  const p2 = _plPolicy();
  assert.strictEqual(p2.source, 'fail-closed');
  assert.strictEqual(p2.updatedBy, 'fail-closed-policy-lost');
  assert.strictEqual(p2.futureOpen, false, '策略丢失不得放开未来（≠首次态）');
  // 场景3：空串同样收敛
  env._props.set('PERIOD_LOCK_STATE', '');
  assert.strictEqual(_plPolicy().updatedBy, 'fail-closed-policy-lost', '空串=丢失');
  // 场景4：恢复合法策略 → 正常读回（不受哨兵影响）
  _plSetPolicy(true, false, 'rita2');
  const p4 = _plPolicy();
  assert.strictEqual(p4.source, 'props');
  assert.strictEqual(p4.futureOpen, false);
  assert.strictEqual(p4.updatedBy, 'rita2');
});
t('V12', '[审③] tsPatchCells 写阶段失败 → PL_UNCERTAIN_PATCH_WRITE_FAILED+plCause 透出 JSON', () => {
  freshDb();
  env._writeExplodes = true;
  const out = JSON.parse(tsPatchCells({ postBody: { cells: [[3, 2, '2026-10-25']] } }));
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.plCode, 'PL_UNCERTAIN_PATCH_WRITE_FAILED', '写阶段失败统一 uncertain 码');
  assert.ok(out.plCause && out.plCause.indexOf('write exploded') >= 0, '保留原原因');
  assert.strictEqual(out.logFailed, false, '登记成功不误报');
});

// ============================================================
// W1-W8：[审⑥][审⑦] v5 新增——哨兵三态 + append 输出契约
// ============================================================
t('W1', '[审⑥] 哨兵读取故障+策略键无值 → 收紧（不得当首次态放开）', () => {
  freshDb();
  env._propsBrokenKeys.add('PERIOD_LOCK_POLICY_INIT');      // 仅哨兵 key 抛错
  const p = _plPolicy();
  assert.strictEqual(p.source, 'fail-closed');
  assert.strictEqual(p.updatedBy, 'fail-closed-sentinel-unknown');
  assert.strictEqual(p.futureOpen, false, '哨兵 unknown 时未来也不放行');
  assert.strictEqual(p.closed, true);
});
t('W1b', '[审⑥] 哨兵读取故障+策略键有合法值 → 仍收紧（初始化状态整体未知）', () => {
  freshDb();
  env._props.set('PERIOD_LOCK_STATE', JSON.stringify({ closed: true, cutoff: '2026-10-01', futureOpen: true }));
  env._propsBrokenKeys.add('PERIOD_LOCK_POLICY_INIT');
  const p = _plPolicy();
  assert.strictEqual(p.source, 'fail-closed', '策略有值但哨兵读不到 → 收紧');
});
t('W2', '[审④] 哨兵=1+策略键丢失 → policy-lost 收紧（回归）', () => {
  freshDb();
  env._props.set('PERIOD_LOCK_POLICY_INIT', '1');           // 无策略键
  const p = _plPolicy();
  assert.strictEqual(p.updatedBy, 'fail-closed-policy-lost');
  assert.strictEqual(p.futureOpen, false);
});
t('W3', '真首次态（哨兵确定未初始化+策略无值）→ futureOpen=true（部署前语义保持）', () => {
  freshDb();                                                // 两 key 均不存在，读取正常
  const p = _plPolicy();
  assert.strictEqual(p.source, 'unset');
  assert.strictEqual(p.futureOpen, true);
  assert.strictEqual(p.closed, true, '首次态仍保护历史');
});
t('W4', '[审⑥] _plSetPolicy 保守写序静态核查：哨兵 setProperty 先于策略', () => {
  const src = fs.readFileSync(path.join(__dirname, 'PeriodLockGuard.gs'), 'utf8');
  const body = src.slice(src.indexOf('function _plSetPolicy'));
  const iInit = body.indexOf("setProperty(PL_POLICY_INIT_KEY");
  const iKey = body.indexOf("setProperty(PL_POLICY_KEY");
  assert.ok(iInit >= 0 && iKey >= 0, '两个 setProperty 都须存在');
  assert.ok(iInit < iKey, '必须先写哨兵后写策略（中间残留收敛到收紧侧）');
});
t('W5', '[审⑦] append 业务写失败 → PL_UNCERTAIN_BIZ_WRITE_FAILED+plCause+logFailed=false', () => {
  freshDb();
  env._writeExplodes = true;                                // setValues 抛普通 Error
  let calls = 0;
  const out = JSON.parse(tsAppendRows({ postBody: { rows: [row14('2026-10-16', 'UUID-NEW-W5')] } }));
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.plCode, 'PL_UNCERTAIN_BIZ_WRITE_FAILED');
  assert.ok(String(out.plCause).indexOf('write exploded') >= 0, 'plCause 须保留原始原因');
  assert.strictEqual(out.logFailed, false, '登记成功不得误报 logFailed');
  assert.strictEqual(env._sheets['_TS_WRITE_LOG']._rows.length, 2, 'guard 登记落 _TS_WRITE_LOG 表（表头+1 行）');
});
t('W6', '[审⑦] append flush 失败 → PL_UNCERTAIN_FLUSH_FAILED+plCause', () => {
  freshDb();
  env._flushThrows = true;
  const out = JSON.parse(tsAppendRows({ postBody: { rows: [row14('2026-10-16', 'UUID-NEW-W6')] } }));
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.plCode, 'PL_UNCERTAIN_FLUSH_FAILED');
  assert.ok(String(out.plCause).length > 0, 'flush 失败也须透出原因');
  assert.strictEqual(out.logFailed, false);
});
t('W7', '[审⑦] append 登记失败（无 _TS_WRITE_LOG）→ logFailed=true 且码/因不丢', () => {
  freshDb();
  delete env._sheets['_TS_WRITE_LOG'];                      // 登记表不存在 → _plLogUncertain=false
  env._writeExplodes = true;
  const out = JSON.parse(tsAppendRows({ postBody: { rows: [row14('2026-10-16', 'UUID-NEW-W7')] } }));
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.plCode, 'PL_UNCERTAIN_BIZ_WRITE_FAILED');
  assert.ok(String(out.plCause).indexOf('write exploded') >= 0);
  assert.strictEqual(out.logFailed, true, '登记失败必须外显');
  assert.ok(String(out.error).indexOf('登记失败') >= 0, '错误文案含人工核查提示');
});
t('W8', '[审⑦] append 辅助日志失败 → 不遮蔽原 uncertain（码/因保留+logFailed=true+不重放）', () => {
  freshDb();
  env._writeExplodes = true;                                // 业务写失败（第一次）
  env._writeLogThrows = true;                               // 所有 _tsWriteLog 抛错（登记+辅助都失败）
  const out = JSON.parse(tsAppendRows({ postBody: { rows: [row14('2026-10-16', 'UUID-NEW-W8')] } }));
  assert.strictEqual(out.ok, false, '辅助日志失败不得把结果翻成 ok 或抛出 JSON 外');
  assert.strictEqual(out.plCode, 'PL_UNCERTAIN_BIZ_WRITE_FAILED', '原 plCode 不丢');
  assert.ok(String(out.plCause).indexOf('write exploded') >= 0, '原 plCause 不丢');
  assert.strictEqual(out.logFailed, true, '辅助日志失败亦属登记失败，外显');
  assert.strictEqual(env._sheets['DB_工时流水']._rows.length, 3, '不自动重放业务写（表头+2 数据行基线不变）');
});

// ============================================================
// X1-X6：[审⑧-v6] 错误传输接口契约（runbook v3 §2.5，Tom 13:57 衔接问题 2）
// ============================================================
t('X1', '[审⑧-v6] updateTimesheet uncertain → message 载荷序列化，logFailed=false 可恢复', () => {
  freshDb();
  const sh = env._sheets['DB_工时流水'];
  const reqVersion = contentHashOf(sh, 3);
  env._writeExplodes = true;                       // 业务写失败 → uncertain（登记成功）
  let err = null;
  try {
    updateTimesheet('tok', { uuid: 'UUID-OCT-NEW', date: '2026-10-20', stage: '1.1', project: 'PRJ-1', hours: 8, notes: '', expectContentHash: reqVersion });
  } catch (e) { err = e; }
  assert.ok(err, '必须抛');
  const i = err.message.indexOf('|');
  assert.ok(i > 0, 'uncertain message 须含载荷分隔符');
  assert.strictEqual(err.message.slice(0, i), 'PL_UNCERTAIN_BIZ_WRITE_FAILED', '码在第一个 | 前');
  const payload = JSON.parse(err.message.slice(i + 1));
  assert.strictEqual(payload.logFailed, false, '登记成功 → logFailed=false（前端得「已登记」档）');
  assert.ok(String(payload.cause).indexOf('write exploded') >= 0, '原始原因可恢复（不再只活在属性里）');
  assert.strictEqual(err.plLogFailed, undefined, '登记成功不误报属性');
});
t('X2', '[审⑧-v6] 登记失败 → 载荷 logFailed=true（前端得「未能登记」档，不猜不默认）', () => {
  freshDb();
  env._sheets['_TS_WRITE_LOG'] = { appendRow() { throw new Error('log broken'); }, _rows: [] };
  const sh = env._sheets['DB_工时流水'];
  const reqVersion = contentHashOf(sh, 3);
  env._writeExplodes = true;
  let err = null;
  try {
    updateTimesheet('tok', { uuid: 'UUID-OCT-NEW', date: '2026-10-20', stage: '1.1', project: 'PRJ-1', hours: 8, notes: '', expectContentHash: reqVersion });
  } catch (e) { err = e; }
  const i = err.message.indexOf('|');
  assert.strictEqual(err.message.slice(0, i), 'PL_UNCERTAIN_BIZ_WRITE_FAILED');
  assert.strictEqual(JSON.parse(err.message.slice(i + 1)).logFailed, true, '登记失败必须真实透出');
});
t('X3', '[审⑧-v6] softDeleteRecord uncertain → 同一载荷契约（删入口不特殊）', () => {
  freshDb();
  const sh = env._sheets['DB_工时流水'];
  const reqVersion = contentHashOf(sh, 3);
  env._writeExplodes = true;
  let err = null;
  try { softDeleteRecord('tok', 'UUID-OCT-NEW', reqVersion); } catch (e) { err = e; }
  const i = err.message.indexOf('|');
  assert.strictEqual(err.message.slice(0, i), 'PL_UNCERTAIN_BIZ_WRITE_FAILED', '删入口同一契约');
  assert.strictEqual(JSON.parse(err.message.slice(i + 1)).logFailed, false);
});
t('X4', '[审⑧-v6] 拒绝码无载荷：message 恰为码本身（拒绝时不登记，无状态可传）', () => {
  freshDb();
  let err = null;
  try {
    updateTimesheet('tok', { uuid: 'UUID-OCT-NEW', date: '2026-10-20', stage: '1.1', project: 'PRJ-1', hours: 8, notes: '' });
  } catch (e) { err = e; }
  assert.strictEqual(err.message, 'PL_REJECT_MISSING_EXPECT_VERSION', '拒绝码 message 不得带载荷');
  assert.ok(err.message.indexOf('|') < 0);
});
t('X5', '[审⑧-v6] 普通错误（无 plCode）message 原样保留，不套契约', () => {
  freshDb();
  let err = null;
  try {
    updateTimesheet('tok', { uuid: 'UUID-NOPE', date: '2026-10-20', stage: '1.1', project: 'PRJ-1', hours: 8, notes: '', expectContentHash: 'deadbeef' });
  } catch (e) { err = e; }
  assert.ok(String(err.message).indexOf('Record not found') >= 0, '原 message 保留');
  assert.ok(err.message.indexOf('|') < 0, '无码错误不载荷');
});
t('X6', '[审⑧-v6] 前端三档渲染：plParseErr/plHumanMsg 从交付件 Index.html 实抽实测', () => {
  const clientHtml = fs.readFileSync(path.join(__dirname, '..', '_client_diff_work', 'Index.html'), 'utf8');
  const parser = clientHtml.match(/function plParseErr\(msg\) \{[\s\S]*?\n {8}\}/);
  const map = clientHtml.match(/var PL_MSG_MAP = \[[\s\S]*?\n {8}\];/);
  const human = clientHtml.match(/function plHumanMsg\(msg\) \{[\s\S]*?\n {8}\}/);
  assert.ok(parser && map && human, '交付件须含 plParseErr/PL_MSG_MAP/plHumanMsg');
  // 同一 indirect eval：函数声明落全局作用域，plHumanMsg 内部方可解析 plParseErr
  (0, eval)(parser[0] + '\n' + map[0] + '\n' + human[0]);
  // 档1：拒绝码无载荷
  var p1 = plParseErr('PL_REJECT_MISSING_EXPECT_VERSION');
  assert.strictEqual(p1.code, 'PL_REJECT_MISSING_EXPECT_VERSION');
  assert.strictEqual(p1.logFailed, null);
  // 档2：不确定态载荷可得 → 真假两档
  var p2 = plParseErr('PL_UNCERTAIN_BIZ_WRITE_FAILED|{"logFailed":false,"cause":"Exception: x"}');
  assert.strictEqual(p2.code, 'PL_UNCERTAIN_BIZ_WRITE_FAILED');
  assert.strictEqual(p2.logFailed, false);
  assert.strictEqual(p2.cause, 'Exception: x');
  assert.strictEqual(plParseErr('PL_UNCERTAIN_FLUSH_FAILED|{"logFailed":true,"cause":"y"}').logFailed, true);
  // 档3：载荷缺失/不可解析/非布尔 → null（禁默认 false）
  assert.strictEqual(plParseErr('PL_UNCERTAIN_BIZ_WRITE_FAILED').logFailed, null, '缺载荷不得默认 false');
  assert.strictEqual(plParseErr('PL_UNCERTAIN_BIZ_WRITE_FAILED|not-json').logFailed, null, '不可解析不得默认 false');
  assert.strictEqual(plParseErr('PL_UNCERTAIN_BIZ_WRITE_FAILED|{"logFailed":"false"}').logFailed, null, '非布尔不得默认 false');
  // cause 含 | 不影响切分（只切第一个）
  var p3 = plParseErr('PL_UNCERTAIN_BIZ_WRITE_FAILED|{"logFailed":false,"cause":"a|b"}');
  assert.strictEqual(p3.code, 'PL_UNCERTAIN_BIZ_WRITE_FAILED');
  assert.strictEqual(p3.cause, 'a|b');
  // 人话三档
  assert.ok(plHumanMsg('PL_UNCERTAIN_BIZ_WRITE_FAILED|{"logFailed":false,"cause":"x"}').indexOf('已登记待核查') >= 0);
  assert.ok(plHumanMsg('PL_UNCERTAIN_BIZ_WRITE_FAILED|{"logFailed":true,"cause":"x"}').indexOf('未能登记') >= 0);
  var unk = plHumanMsg('PL_UNCERTAIN_BIZ_WRITE_FAILED');
  assert.ok(unk.indexOf('登记状态未知') >= 0, '载荷缺失 → 未知档');
  assert.ok(unk.indexOf('已登记') < 0, '未知档禁称已登记');
  assert.strictEqual(plHumanMsg('PL_REJECT_LOCK_BUSY'), '系统繁忙，请稍候重试（不要连续点击）');
  assert.strictEqual(plHumanMsg('Record not found or no permission'), null, '无码错误回落通用提示');
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
console.log('R1-R17 + I1-I8 + V1-V12 + W1-W8 + X1-X6: ' + pass + '/' + results.length + ' 通过' + (fail.length ? '，' + fail.length + ' 失败' : '（fail-closed 全绿）'));
process.exit(fail.length ? 1 : 0);
