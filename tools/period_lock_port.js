// period_lock_port.js — 真实期锁适配器的「纯逻辑」副本（单一可信源）
//
// 由 PeriodLockGuard.A0_PeriodLockGuard_cleanupGuard.js 的判定逻辑移植而来，
// 去掉 GAS 专属存储（PropertiesService）、保留纯判定函数，供 Node 核心与 GAS 共用。
// 与 GAS 端 _plParseBizDate / _plGuardCheck / _plPolicy 逐字对应（由 v4_genpatches 同文生成）。
//
// 设计目标（Tom 条件 #3）：期锁必须跑真实适配器，而非字符串比较 mock；
//   依赖缺失 → 拒绝（不静默放行）；覆盖 Date/字符串/时区/非法日期/锁定期/未来放开 组合。

'use strict';

var PL_CUTOFF = '2026-10-01';             // 与 PeriodLockGuard 默认一致
var PL_UNKNOWN = '__PL_UNKNOWN__';
// 真实策略键名（与 PeriodLockGuard.js:74-75 逐字一致）—— v5 B2 起由 GAS 侧真实读取。
var PL_POLICY_KEY = 'PERIOD_LOCK_STATE';
var PL_POLICY_INIT_KEY = 'PERIOD_LOCK_POLICY_INIT';

// M7：业务日解析（完整匹配 Date | yyyy-MM-dd | yyyy-MM-ddTHH:mm[:ss] | yyyy-MM-dd HH:mm[:ss] | yyyy/M/d）
// 尾缀垃圾/非法时分秒/越界/假日期 → null。一律 GMT+8 归日。
function _plParseBizDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'object' && typeof v.getFullYear === 'function') {
    if (isNaN(v.getTime())) return null;
    return _plFmtDate(v);
  }
  var s = String(v).trim();
  if (!s) return null;
  var m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  var y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (m[4] !== undefined) {
    var hh = +m[4], mi = +m[5], ss = (m[6] === undefined) ? 0 : +m[6];
    if (hh > 23 || mi > 59 || ss > 59) return null;
  }
  var dt = new Date(Date.UTC(y, mo - 1, d));
  if (isNaN(dt.getTime())) return null;
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return y + '-' + (mo < 10 ? '0' + mo : '' + mo) + '-' + (d < 10 ? '0' + d : '' + d);
}
function _plFmtDate(d) {
  // GAS 端用 Utilities.formatDate(d,'GMT+8',...)；Node 端用 +8h 墙面时钟（与 _sdIsoTz 约定一致）
  if (typeof Utilities !== 'undefined') {
    return Utilities.formatDate(d, 'GMT+8', 'yyyy-MM-dd');
  }
  var t = d.getTime() + 8 * 3600 * 1000;
  var u = new Date(t);
  var p = function (n) { return (n < 10 ? '0' + n : '' + n); };
  return u.getUTCFullYear() + '-' + p(u.getUTCMonth() + 1) + '-' + p(u.getUTCDate());
}
function _plIsClosedBizDate(bizDate, cutoff) {
  return String(bizDate) < String(cutoff);
}

// 写网关双向门禁（原值三态）：用真实策略判定
function _plGuardCheck(newDateRaw, origBiz, policy) {
  var cutoff = (policy && policy.cutoff) || PL_CUTOFF;
  var newBiz = _plParseBizDate(newDateRaw);
  if (!newBiz) return { ok: false, reason: 'PL_REJECT_BAD_NEW_DATE' };
  if (policy && policy.closed === false) {
    if (policy.futureOpen === false && newBiz >= cutoff) {
      return { ok: false, reason: 'PL_REJECT_FUTURE_CLOSED' };
    }
    return { ok: true, reason: '' };
  }
  if (_plIsClosedBizDate(newBiz, cutoff)) return { ok: false, reason: 'PL_REJECT_NEW_DATE_CLOSED' };
  if (policy && policy.futureOpen === false && newBiz >= cutoff) {
    return { ok: false, reason: 'PL_REJECT_FUTURE_CLOSED' };
  }
  if (origBiz === PL_UNKNOWN) return { ok: false, reason: 'PL_REJECT_ORIG_UNKNOWN' };
  if (origBiz !== null && origBiz !== undefined && origBiz !== '') {
    if (_plIsClosedBizDate(origBiz, cutoff)) return { ok: false, reason: 'PL_REJECT_ORIG_DATE_CLOSED' };
  }
  return { ok: true, reason: '' };
}

// 真实日历校验（回验 cutoff 本身是合法日期，拒 '2026-00-01' 之类假日期）
function _plValidCutoff(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  var b = _plParseBizDate(s);
  return b === s;
}
function _plFailClosedPolicy(reason) {
  return { closed: true, cutoff: PL_CUTOFF, futureOpen: false,
           updatedBy: 'fail-closed-' + reason, updatedAt: '', source: 'fail-closed' };
}

// ---- v5 B2（Tom 第 4 项）：真实策略读取 ----
// 此前 GAS 侧 policy 固定调 _plPolicy()，返回 source:'unset'，**从未**读生产
// PropertiesService 策略 —— 等于生产策略（损坏 / futureOpen=false / 关账调整）
// 根本没有被执行入口遵守。此处按 PeriodLockGuard._plPolicy 逐字移植读取逻辑：
//   · 读取异常 → fail-closed（'read-error'）
//   · 哨兵三态：'1'=已初始化；确定值=未初始化；**读取异常=unknown → fail-closed**
//     （不得与「确定未初始化」混淆，否则故障反而放宽未知状态）
//   · 有哨兵而策略键丢失 → fail-closed（'policy-lost'）
//   · 真首次态 → closed=true + futureOpen=true + source:'unset'
//   · JSON 坏 / 结构非法（含 'false' 字符串、缺字段、cutoff 非法）→ fail-closed
// 边界：本函数**只读**，不初始化、不改写生产策略。
// propsGetter(key) 由调用方注入（GAS 侧注入 PropertiesService，Node 侧注入内存/测试替身）。
function _plPolicyFromProps(propsGetter) {
  if (typeof propsGetter !== 'function') return _plFailClosedPolicy('no-props-getter');
  var raw = null;
  try { raw = propsGetter(PL_POLICY_KEY); }
  catch (e) { return _plFailClosedPolicy('read-error'); }

  var sentinel = null, sentinelOk = false;
  try { sentinel = propsGetter(PL_POLICY_INIT_KEY); sentinelOk = true; }
  catch (e2) { sentinelOk = false; }
  if (!sentinelOk) return _plFailClosedPolicy('sentinel-unknown');

  var initialized = (sentinel === '1');
  if (!raw) {
    if (initialized) return _plFailClosedPolicy('policy-lost');
    return { closed: true, cutoff: PL_CUTOFF, futureOpen: true,
             updatedBy: 'initial-unset', updatedAt: '', source: 'unset' };
  }
  try {
    var p = JSON.parse(raw);
    if (!p || typeof p !== 'object' || Array.isArray(p)) return _plFailClosedPolicy('parse-error');
    if (typeof p.closed !== 'boolean' || typeof p.futureOpen !== 'boolean') return _plFailClosedPolicy('schema-error');
    if (typeof p.cutoff !== 'string' || !_plValidCutoff(p.cutoff)) return _plFailClosedPolicy('schema-error');
    return { closed: p.closed, cutoff: p.cutoff, futureOpen: p.futureOpen,
      updatedBy: String(p.updatedBy || ''), updatedAt: String(p.updatedAt || ''), source: 'props' };
  } catch (e) {
    return _plFailClosedPolicy('parse-error');
  }
}

// 默认策略（镜像 PeriodLockGuard _plPolicy 的「initial-unset」态：closed=true 保护历史，
// futureOpen=true 允许未来正常写入；fail-closed 的 _plFailClosedPolicy 才是 futureOpen=false）。
// 真实部署由 PropertiesService 显式初始化；Node 核心经 deps.policy() 注入，未注入时回退到此。
function _plPolicy() {
  return { closed: true, cutoff: PL_CUTOFF, futureOpen: true, source: 'unset' };
}

// ---- Node 导出（GAS 侧由 genpatches 内联）----
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PL_CUTOFF: PL_CUTOFF, PL_UNKNOWN: PL_UNKNOWN,
    PL_POLICY_KEY: PL_POLICY_KEY, PL_POLICY_INIT_KEY: PL_POLICY_INIT_KEY,
    _plParseBizDate: _plParseBizDate, _plIsClosedBizDate: _plIsClosedBizDate,
    _plValidCutoff: _plValidCutoff, _plFailClosedPolicy: _plFailClosedPolicy,
    _plGuardCheck: _plGuardCheck, _plPolicy: _plPolicy,
    _plPolicyFromProps: _plPolicyFromProps
  };
}
