// T1-B 生产表 Step1「填报页请假提示」· 阶段三部署包装（STAGING · 未推生产）
//
// v3 —— 回应 Tom 2026-10-24 11:58 复核函六点阻塞的二次修复：
//   Pt1: 两入口(getLeaveTipSafe / handleRequestSafe)统一经 enterControlled()，同一受控路径；
//        不再有"直接 core.handleRequest(req)"绕过 bindPrincipal/白名单/镜像过滤/身份绑定的入口。
//   Pt2: ① 整个受控处理包在单一 try（含 resolvePrincipal 与 coreOpts 构造），resolver 抛错/属性访问异常均→可用性回退，不外逃；
//        ② resolvePrincipal 显式校验 employeeId 非空；③ 主体【只解析一次】(wrapper 解析→frozenResolver 固化给核心，杜绝双解析不一致)。
//   Pt3: 对外响应【只】含固定状态码；原始异常 message / resolver 内部 status 一律不外传，仅经 _log 落受控日志(服务端)。
//   (Pt4/5/6 由 stage4_hash_check.js v3 与负例测试 v3 负责)
//
// 设计目标不变：① 一键关闭开关 FEATURE_ENABLED 默认 false（fail-safe）；
//               ② 复用已验证核心 ts_leave_tip_core.js（同步纯函数，零线上写入）；
//               ③ 受控时钟注入（now 必须经入参）；
//               ④ principal【仅】来自模块级 TRUSTED_RESOLVER（服务端一次性注入可信 session）；
//                  任何客户端请求体里的 identityResolver/employeeId/who 一律忽略（结构上杜绝自报身份）。

'use strict';

// ===== Block2 修复：依赖惰性加载 + 加载失败不致命 =====
// 模块初始化时【不】require；首次使用时才加载，且包在 try/catch —— 即使依赖缺失，默认关的开关与可用性回退仍能生效。
let _CORE = undefined;   // undefined=尚未尝试; null=加载失败; 否则=核心 API
let _CORE_ERR = null;
let _FORCE_LOAD_THROW = false; // 测试接缝：模拟真实 require 失败路径（验证 catch 分支，而非仅注入 null）
function loadCore() {
  if (_CORE !== undefined) return _CORE;
  if (_FORCE_LOAD_THROW) { _CORE_ERR = 'simulated-load-failure'; _CORE = null; return _CORE; }
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

// ===== 受控日志（脱敏通道：仅固定码 + 内部诊断落服务端日志，绝不进入对外响应）=====
function _log() { try { if (typeof console !== 'undefined' && console.error) console.error.apply(console, arguments); } catch (_) {} }

// ===== 对外响应构造：固定码，无原始异常 / 内部 status =====
function availabilityFallback() { return { status: 'FETCH_FAILED', tip: null, submitAllowed: true }; }
function privacyBlocked() { return { status: 'PRIVACY_BLOCKED', tip: null, submitAllowed: true, privacyBlocked: true, reason: 'identity-unresolved' }; }
function featureDisabled() { return { status: 'DISABLED', tip: null, submitAllowed: true }; }

// ===== 主体可信解析器（服务端受控，模块级单点注入）=====
// principal【仅】来自 TRUSTED_RESOLVER —— 由服务端在初始化时一次性注入（读取可信 session）。
// 任何客户端请求 opts 里的 identityResolver / employeeId / who 一律被忽略（见 enterControlled 白名单构造）。
// 未配置解析器（null）→ 一律隐私封闭（fail-closed），绝不落到任何人数据。
let TRUSTED_RESOLVER = null;
function setTrustedResolver(fn) { TRUSTED_RESOLVER = (typeof fn === 'function') ? fn : null; return TRUSTED_RESOLVER; }

// Pt2B + Pt2A：解析主体（仅用模块级可信解析器）；校验 employeeId 非空；resolver 抛错也被捕获为隐私封闭，不外逃。
function resolvePrincipal(opts) {
  const resolver = TRUSTED_RESOLVER;
  if (!resolver) return { principal: null, block: privacyBlocked() };
  let pr;
  try {
    pr = resolver((opts && opts.session) || {});
  } catch (e) {
    _log('[leave-tip] resolver threw:', e && e.message);
    return { principal: null, block: privacyBlocked() };
  }
  if (!pr || pr.status !== 'OK') return { principal: null, block: privacyBlocked() };
  if (!pr.employeeId) return { principal: null, block: privacyBlocked() }; // 显式校验 employeeId 非空唯一（核心 DEFAULT_MAP 已保证唯一）
  return { principal: pr, block: null };
}

// Pt2C：镜像行级过滤（纵深防御）。包装层先把镜像行过滤到仅本人，再交核心（核心亦会再过滤一次）。
function filterMirrorToSelf(mirror, employeeId) {
  if (!mirror || !Array.isArray(mirror.rows)) return mirror;
  return Object.assign({}, mirror, { rows: mirror.rows.filter(r => r && r.who === employeeId) });
}

// Pt3：响应字段最小化 + 隐私/可用性分离（剥离 who/镜像原始对象；对外不含任何原始异常或内部 status 文本）。
function wrapResponse(res, principal) {
  if (!res || typeof res !== 'object') return availabilityFallback();
  if (res.status === 'AUTH_REQUIRED' || res.status === 'UNAUTHORIZED') {
    _log('[leave-tip] privacy-blocked due to', res.status); // 内部状态仅落受控日志，不进对外响应(Pt3)
    return privacyBlocked();
  }
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

// Block1 修复：把"核心返回 / 可能异步 reject"统一兜底为可用性回退（原始 message 仅落 _log，不进响应）。
function settle(res) {
  if (res && typeof res.then === 'function') {
    return res.then(r => r).catch(e => { _log('[leave-tip] async rejected:', e && e.message); return availabilityFallback(); });
  }
  return res;
}

// ===== 统一受控入口（Pt1 修复核心：两入口共用同一路径）=====
function enterControlled(method, opts) {
  if (!FEATURE_ENABLED) {
    return featureDisabled(); // fail-safe：开关关 → 不触碰任何逻辑、不读镜像、不解析身份、不绑主体
  }
  try {
    const core = loadCore();
    if (!core || typeof core[method] !== 'function') return availabilityFallback();
    // 主体【仅解析一次】(Pt2C)：先解析并校验，再固化给核心，杜绝核心二次解析不一致。
    const { principal, block } = resolvePrincipal(opts);
    if (block) return block;
    const now = (opts && opts.now !== undefined) ? opts.now : undefined; // 0 为合法受控时钟值
    const filteredMirror = filterMirrorToSelf(opts && opts.mirror, principal.employeeId);
    // 固化解析结果：frozenResolver 永远返回 wrapper 已解析的 principal；核心收到的是受控主体，而非客户端传入的 resolver。
    const frozenResolver = () => principal;
    // 白名单构造核心入参：仅透传展示所需字段，【显式不复制】任何客户端可控的 identityResolver/employeeId/who（核心只收到 frozenResolver）。
    const coreOpts = {
      session: (opts && opts.session) || {},
      fillDate: opts && opts.fillDate,
      fromDate: opts && opts.fromDate,
      toDate: opts && opts.toDate,
      now: now,
      mirror: filteredMirror,
      identityResolver: frozenResolver,
    };
    const out = settle(core[method](coreOpts));
    if (out && typeof out.then === 'function') return out.then(r => wrapResponse(r, principal)).catch(e => availabilityFallback());
    return wrapResponse(out, principal);
  } catch (e) {
    _log('[leave-tip] controlled entry unexpected:', e && e.message);
    return availabilityFallback(); // Pt2A：任何意外异常（含 resolver 抛错/属性访问）不外逃
  }
}

// Pt1：两入口统一经 enterControlled，不再有绕过 bindPrincipal 的直接核心调用。
function getLeaveTipSafe(opts) { return enterControlled('getLeaveTip', opts); }
function handleRequestSafe(req) { return enterControlled('handleRequest', req); }

// 测试接缝
function __test_setCore(coreOrNull) { _CORE = coreOrNull; _CORE_ERR = coreOrNull ? null : 'injected-missing'; }
function __test_forceLoadThrow(on) { _FORCE_LOAD_THROW = !!on; if (!on) { _CORE = undefined; _CORE_ERR = null; } }

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    setFeatureEnabled, isFeatureEnabled,
    setTrustedResolver, getLeaveTipSafe, handleRequestSafe,
    resolvePrincipal, filterMirrorToSelf, wrapResponse, privacyBlocked, availabilityFallback,
    __test_setCore, __test_forceLoadThrow, _loadCore: loadCore, _log,
  };
}
