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
    _plParseBizDate: _plParseBizDate, _plIsClosedBizDate: _plIsClosedBizDate,
    _plGuardCheck: _plGuardCheck, _plPolicy: _plPolicy
  };
}
