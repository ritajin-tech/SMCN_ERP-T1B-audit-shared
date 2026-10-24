// T1-B 生产表 Step1「填报页请假提示」· 阶段三部署包装（STAGING · 未推生产）
//
// v2 —— 针对 Tom 2026-10-24 五项技术阻塞的修复版：
//   Block1: 两入口均加 try/catch，并兜底异步（Promise）reject；不再声称"四路径全不阻塞"未证。
//   Block2: 依赖在开关判断【之后】惰性加载，加载失败不致命（默认关仍能兜底）。
//   Block3: 显式本人身份绑定 + 镜像行级授权（纵深防御）+ 响应字段最小化；
//           隐私封闭失败(PRIVACY_BLOCKED) 与 填报可用性回退(FETCH_FAILED) 分离；opts.now 修正（0 为合法值）。
//   Block4/5: 由 stage4_hash_check.js v2 负责（见该文件）。
//
// 设计目标不变：① 一键关闭开关 FEATURE_ENABLED 默认 false（fail-safe）；
//               ② 复用已验证核心 ts_leave_tip_core.js（同步纯函数，零线上写入）；
//               ③ 受控时钟注入（now 必须经入参，不依赖系统全局时钟）；
//               ④ 请求边界：principal【仅】来自模块级 TRUSTED_RESOLVER（服务端一次性注入可信 session）；
//                  任何客户端请求体里的 identityResolver/employeeId/who 一律忽略（结构上杜绝自报身份）。

'use strict';

// ===== Block2 修复：依赖惰性加载 + 加载失败不致命 =====
// 模块初始化时【不】require；首次使用时才加载，且包在 try/catch —— 即使依赖缺失，
// 默认关的开关与可用性回退仍能生效，不会因 require 抛错导致整个模块加载失败。
let _CORE = undefined;   // undefined=尚未尝试; null=加载失败; 否则=核心 API
let _CORE_ERR = null;
function loadCore() {
  if (_CORE !== undefined) return _CORE;
  try {
    const CORE = require('../ts_leave_tip_core.js');
    _CORE = (CORE && CORE.getLeaveTip) ? CORE : (CORE && CORE.API ? CORE.API : CORE);
  } catch (e) {
    _CORE_ERR = String((e && e.message) || e);
    _CORE = null;
  }
  return _CORE;
}

// ===== 一键关闭开关（fail-safe 默认关）=====
let FEATURE_ENABLED = false;
function setFeatureEnabled(on) { FEATURE_ENABLED = !!on; return FEATURE_ENABLED; }
function isFeatureEnabled() { return FEATURE_ENABLED; }

// 可用性回退（任何取数/未知异常 → 不弹提示、填报按钮照常可用）
function availabilityFallback(error) {
  return { status: 'FETCH_FAILED', tip: null, submitAllowed: true, error: error == null ? undefined : String(error) };
}
// 隐私封闭失败（与可用性回退【分离】，Block3）：身份无法解析/不唯一时，
// 不静默落入任何人数据，也不与"填报可用"混为一谈；调用方可据此区分两类失败。
function privacyBlocked(reason) {
  return { status: 'PRIVACY_BLOCKED', tip: null, submitAllowed: true, privacyBlocked: true, reason: reason || 'identity-unresolved' };
}

// ===== 主体可信解析器（服务端受控，模块级单点注入）=====
// Block3 安全加固（回应 Tom 验证点「主体来自可信会话而非客户端自报 employeeId」）：
//   principal【仅】来自 TRUSTED_RESOLVER —— 由服务端在初始化时一次性注入（读取可信 session，
//   例如 GAS Session.getActiveUser().getEmail() → 唯一 employeeId）。
//   任何客户端请求 opts 里的 identityResolver / employeeId / who 一律被忽略（见 getLeaveTipSafe 白名单构造），
//   从结构上杜绝「客户端自报身份」的攻击面。
//   未配置解析器（null）→ 一律隐私封闭（fail-closed），绝不落到任何人数据。
let TRUSTED_RESOLVER = null;
function setTrustedResolver(fn) { TRUSTED_RESOLVER = (typeof fn === 'function') ? fn : null; return TRUSTED_RESOLVER; }

// Block3：显式本人身份绑定 + 镜像行级授权（纵深防御）
function bindPrincipal(opts) {
  const resolver = TRUSTED_RESOLVER; // 仅用模块级可信解析器；忽略 opts 传入的任何 resolver/employeeId
  if (!resolver) return { principal: null, filteredMirror: null, block: privacyBlocked('resolver-not-configured') };
  const pr = resolver((opts && opts.session) || {});
  if (!pr || pr.status !== 'OK') return { principal: null, filteredMirror: null, block: privacyBlocked(pr ? pr.status : 'AUTH_REQUIRED') };
  // 纵深防御：镜像行级授权 —— 包装层先把镜像行过滤到仅本人，再交核心（核心亦会再过滤一次）。
  const mirror = opts && opts.mirror;
  let filteredMirror = mirror;
  if (mirror && Array.isArray(mirror.rows)) {
    filteredMirror = Object.assign({}, mirror, { rows: mirror.rows.filter(r => r && r.who === pr.employeeId) });
  }
  return { principal: pr, filteredMirror, block: null };
}

// Block3：响应字段最小化 + 隐私/可用性分离
// 注：核心 getLeaveTip 返回的 events 已不含 who（核心内部已按本人过滤并最小化），
//     跨用户行级授权在 bindPrincipal 调用核心【前】已完成（见 filteredMirror 过滤），无需事后断言 who。
function wrapResponse(res, principal) {
  if (!res || typeof res !== 'object') return availabilityFallback('empty-core-response');
  // 隐私封闭失败：核心返回的身份类状态，显式标记为 PRIVACY_BLOCKED（与可用性回退区分）
  if (res.status === 'AUTH_REQUIRED' || res.status === 'UNAUTHORIZED') {
    return Object.assign({}, privacyBlocked(res.status), { rawStatus: res.status });
  }
  // 字段最小化：剥离 mirror 原始对象，仅保留最小必要字段；submitAllowed 恒 true（仅提示、不阻断）
  const minimal = {
    status: res.status,
    tip: res.tip,
    submitAllowed: res.submitAllowed !== false,
    events: Array.isArray(res.events) ? res.events.map(e => ({
      instanceId: e.instanceId, date: e.date, type: e.type, half: e.half, state: e.state, version: e.version,
    })) : [],
  };
  if (['FETCH_FAILED', 'CLOCK_INVALID', 'MIRROR_INCOMPLETE', 'MIRROR_STALE', 'INSTANCE_CONFLICT', 'INVALID_DATE'].includes(res.status)) {
    minimal.availabilityFallback = true; // 显式标注这是可用性回退，便于与隐私封闭区分
  }
  return minimal;
}

// Block1 修复：把"核心返回 / 可能异步 reject"统一兜底为可用性回退
function settle(res) {
  if (res && typeof res.then === 'function') {
    return res.then(r => r).catch(e => availabilityFallback((e && e.message) || e));
  }
  return res;
}

// ===== 受控入口 getLeaveTipSafe =====
// opts: { session, fillDate, fromDate, toDate, mirror, now, identityResolver }
function getLeaveTipSafe(opts) {
  if (!FEATURE_ENABLED) {
    // fail-safe：开关关 → 不触碰任何逻辑、不读镜像、不解析身份、按钮行为不变
    return { status: 'DISABLED', tip: null, submitAllowed: true };
  }
  const core = loadCore();
  if (!core) return availabilityFallback(_CORE_ERR || 'core-not-loaded'); // Block2：依赖缺失也不崩
  // Block3：先显式绑定本人身份（纵深）；身份不可解析 → 隐私封闭，不进入取数
  const bind = bindPrincipal(opts);
  if (bind.block) return bind.block;
  // Block3 修复 opts.now：0 是合法受控时钟值，必须用 !== undefined 判断，不能 !!now
  const now = (opts && opts.now !== undefined) ? opts.now : undefined;
  // 白名单构造核心入参：仅透传展示所需字段，【显式剔除】任何客户端可控的 identityResolver/employeeId/who；
  // 核心只收到模块级 TRUSTED_RESOLVER —— 客户端无法自报身份（回应 Tom 验证点）。
  const coreOpts = {
    session: (opts && opts.session) || {},
    fillDate: opts && opts.fillDate,
    fromDate: opts && opts.fromDate,
    toDate: opts && opts.toDate,
    now: now,
    mirror: bind.filteredMirror,
    identityResolver: TRUSTED_RESOLVER,
  };
  try {
    // 传入过滤后的本人镜像（纵深防御）；核心会再过滤一次
    const out = settle(core.getLeaveTip(coreOpts));
    if (out && typeof out.then === 'function') return out.then(r => wrapResponse(r, bind.principal)).catch(e => availabilityFallback((e && e.message) || e));
    return wrapResponse(out, bind.principal);
  } catch (e) {
    return availabilityFallback((e && e.message) || e);
  }
}

// ===== 受控入口 handleRequestSafe（Block1 修复：补 try/catch + 异步兜底）=====
function handleRequestSafe(req) {
  if (!FEATURE_ENABLED) {
    return { status: 'DISABLED', tip: null, submitAllowed: true };
  }
  const core = loadCore();
  if (!core) return availabilityFallback(_CORE_ERR || 'core-not-loaded');
  try {
    const out = settle(core.handleRequest(req));
    if (out && typeof out.then === 'function') return out.then(r => wrapResponse(r, null)).catch(e => availabilityFallback((e && e.message) || e));
    return wrapResponse(out, null);
  } catch (e) {
    return availabilityFallback((e && e.message) || e);
  }
}

// 测试接缝：允许负例测试模拟"依赖缺失"（仅测试用，不影响生产行为）
function __test_setCore(coreOrNull) { _CORE = coreOrNull; _CORE_ERR = coreOrNull ? null : 'injected-missing'; }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      FEATURE_ENABLED, setFeatureEnabled, isFeatureEnabled,
      setTrustedResolver, getLeaveTipSafe, handleRequestSafe,
      bindPrincipal, wrapResponse, privacyBlocked, availabilityFallback,
      __test_setCore, _loadCore: loadCore,
    };
  }
