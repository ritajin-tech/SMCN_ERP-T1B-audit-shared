// T1-B 生产表 Step1「填报页请假提示」· 阶段三部署包装（STAGING · 未推生产）
//
// v4 —— 回应 Tom 2026-10-24 12:27 复核函六点二次阻塞（第三轮）的修复：
//   Pt1: 依赖加载改为【可注入 loader】+ 缓存复位；真实 require 失败由 try/catch 真正捕获（不再用注入 null 假冒）；
//        OFF 下两入口均不触发加载（测试可断言 loader 零调用 + 缓存未触达）。
//   Pt2: resolvePrincipal 把 employeeId 收紧为【非空 trim 字符串】(空白串/数组/对象均拒)；
//        主体解析一次后固化为 Object.freeze 最小快照(status:'OK' + employeeId) 供核心，杜绝双解析 + 可变引用。
//        （v5 修正：必须保留受控固定 status:'OK' —— 既有核心 getLeaveTip 第191行要求解析器返回 {status:'OK',employeeId}，
//         否则 pr.status 为 undefined !== 'OK' → 永远走"身份未通过校验"，功能整体失效，Tom 13:26 Pt1 残项）
//   Pt3: _log 仅输出【固定诊断码】(JSON{code})，绝不拼接原始异常 message / 内部状态 / 行数据；
//        wrapResponse 的对外 status 限定为白名单枚举，未知/失败/隐私态一律清空 tip/events（fail-closed，Tom 13:26 Pt2 残项）。
//   (Pt4/5/6 由 stage4_hash_check.js v4/v5 与负例测试 v4/v5 负责)
//
// v5 —— 回应 Tom 2026-10-24 13:26 复核函四点残项（非重开已修项）：
//   Pt1: 冻结快照补回受控固定 status:'OK' + 真实核心 resolver 契约兼容性测试。
//   Pt2: wrapResponse 改为 fail-closed（仅 OK 透传业务内容，其余清空）。
//

// 设计目标不变：① 一键关闭开关 FEATURE_ENABLED 默认 false（fail-safe）；
//               ② 复用已验证核心 ts_leave_tip_core.js（同步纯函数，零线上写入）；
//               ③ 受控时钟注入（now 必须经入参）；
//               ④ principal【仅】来自模块级 TRUSTED_RESOLVER（服务端一次性注入可信 session）；
//                  任何客户端请求体里的 identityResolver/employeeId/who 一律忽略（结构上杜绝自报身份）。

'use strict';

// ===== Block2 修复：依赖惰性加载 + 加载失败不致命（可注入 loader 以真实测 require 失败）=====
let _CORE = undefined;   // undefined=尚未尝试; null=加载失败; 否则=核心 API
let _CORE_ERR = null;
// 真实加载器（默认 require 既有核心）；测试可注入确实 throw 的函数，验证 try/catch 分支。
let _REQUIRE_CORE = () => require('../ts_leave_tip_core.js');
function loadCore() {
  if (_CORE !== undefined) return _CORE;
  try {
    const CORE = _REQUIRE_CORE();
    _CORE = (CORE && CORE.getLeaveTip) ? CORE : (CORE && CORE.API ? CORE.API : CORE);
    _CORE_ERR = null;
  } catch (e) {
    _CORE_ERR = String((e && e.message) || e); // 仅内部留存，绝不外泄/不落日志
    _CORE = null; // catch 分支真正生效
    _log('ERR_LOAD'); // 仅发固定码（不含原始 message）
  }
  return _CORE;
}

// ===== 一键关闭开关（fail-safe 默认关）=====
let FEATURE_ENABLED = false;
function setFeatureEnabled(on) { FEATURE_ENABLED = !!on; return FEATURE_ENABLED; }
function isFeatureEnabled() { return FEATURE_ENABLED; }

// ===== 受控日志（脱敏通道：仅固定诊断码，绝不拼接原始异常文本 / 内部状态 / 行数据）=====
// 任何敏感信息（异常 message、行数据、identity）都不得进入日志——日志只承载"发生了哪类错误"的固定码。
function _log(code) {
  try {
    if (typeof console !== 'undefined' && console.error) {
      console.error('[leave-tip]', JSON.stringify({ code: code }));
    }
  } catch (_) {}
}

// ===== 对外响应构造：固定状态码枚举 + 业务内容（tip 为授权用户可见内容，非诊断）=====
function availabilityFallback() { return { status: 'FETCH_FAILED', tip: null, submitAllowed: true }; }
function privacyBlocked() { return { status: 'PRIVACY_BLOCKED', tip: null, submitAllowed: true, events: [], privacyBlocked: true, reason: 'identity-unresolved' }; }
function featureDisabled() { return { status: 'DISABLED', tip: null, submitAllowed: true }; }

// 对外 status 白名单：任何不在枚举内的核心 status 一律降级为 FETCH_FAILED（绝不外泄内部状态文本）。
const OUT_STATUS = new Set(['OK', 'FETCH_FAILED', 'PRIVACY_BLOCKED', 'DISABLED', 'CLOCK_INVALID', 'MIRROR_INCOMPLETE', 'MIRROR_STALE', 'INSTANCE_CONFLICT', 'INVALID_DATE']);

// ===== 主体可信解析器（服务端受控，模块级单点注入）=====
// principal【仅】来自 TRUSTED_RESOLVER —— 由服务端在初始化时一次性注入（读取可信 session）。
// 任何客户端请求 opts 里的 identityResolver / employeeId / who 一律被忽略（见 enterControlled 白名单构造）。
// 未配置解析器（null）→ 一律隐私封闭（fail-closed），绝不落到任何人数据。
let TRUSTED_RESOLVER = null;
function setTrustedResolver(fn) { TRUSTED_RESOLVER = (typeof fn === 'function') ? fn : null; return TRUSTED_RESOLVER; }

// Pt2：解析主体（仅用模块级可信解析器）；employeeId 收紧为非空 trim 字符串；resolver 抛错也被捕获为隐私封闭，不外逃。
function resolvePrincipal(opts) {
  const resolver = TRUSTED_RESOLVER;
  if (!resolver) return { principal: null, block: privacyBlocked() };
  let pr;
  try {
    pr = resolver((opts && opts.session) || {});
  } catch (e) {
    _log('ERR_RESOLVER');
    return { principal: null, block: privacyBlocked() };
  }
  if (!pr || pr.status !== 'OK') return { principal: null, block: privacyBlocked() };
  // Pt2B：employeeId 必须为【非空 trim 字符串】(空白串 / 数组 / 对象 / 数字 均拒)
  if (typeof pr.employeeId !== 'string' || !pr.employeeId.trim()) return { principal: null, block: privacyBlocked() };
  return { principal: pr, block: null };
}

// Pt2C：镜像行级过滤（纵深防御）。包装层先把镜像行过滤到仅本人，再交核心（核心亦会再过滤一次）。
function filterMirrorToSelf(mirror, employeeId) {
  if (!mirror || !Array.isArray(mirror.rows)) return mirror;
  return Object.assign({}, mirror, { rows: mirror.rows.filter(r => r && r.who === employeeId) });
}

// Pt3（v5 强化，回应 Tom 13:26 Pt2）：响应字段最小化 + 隐私/可用性分离（fail-closed）。
//   仅 'OK' 携带授权用户可见业务内容(tip/events)；其余一切状态一律清空 tip/events，
//   杜绝失败/隐私态携敏数据外泄（未知态/失败态不得仅靠"tip 为本人业务内容"声明放行）。
function wrapResponse(res, principal) {
  if (!res || typeof res !== 'object') return availabilityFallback();
  // 隐私/未授权态：直接返回固定隐私封闭，绝不携带任何业务数据（含核心可能误带的 tip/events）
  if (res.status === 'AUTH_REQUIRED' || res.status === 'UNAUTHORIZED' || res.status === 'PRIVACY_BLOCKED') {
    if (res.status !== 'PRIVACY_BLOCKED') _log('ERR_PRIVACY'); // 内部状态仅落受控日志(固定码)，不进对外响应(Pt3)
    return privacyBlocked();
  }
  // 仅 OK 透传业务内容；其他已知失败态与一切未知态一律清空 tip/events（fail-closed）
  if (res.status !== 'OK') {
    const status = OUT_STATUS.has(res.status) ? res.status : 'FETCH_FAILED'; // 未知 status → 降级
    return { status: status, tip: null, submitAllowed: res.submitAllowed !== false, events: [], availabilityFallback: true };
  }
  // OK：返回本人可见业务内容（tip 为授权用户本人请假提示，非诊断；events 已仅含本人最小字段）
  return {
    status: 'OK',
    tip: res.tip,
    submitAllowed: res.submitAllowed !== false,
    events: Array.isArray(res.events) ? res.events.map(e => ({
      instanceId: e.instanceId, date: e.date, type: e.type, half: e.half, state: e.state, version: e.version,
    })) : [],
  };
}

// Block1 修复：把"核心返回 / 可能异步 reject"统一兜底为可用性回退（原始 message 仅落固定码日志，不进响应）。
function settle(res) {
  if (res && typeof res.then === 'function') {
    return res.then(r => r).catch(e => { _log('ERR_ASYNC'); return availabilityFallback(); });
  }
  return res;
}

// ===== 统一受控入口（Pt1 修复核心：两入口共用同一路径）=====
function enterControlled(method, opts) {
  if (!FEATURE_ENABLED) {
    return featureDisabled(); // fail-safe：开关关 → 不触碰任何逻辑、不读镜像、不解析身份、不绑主体、不加载核心
  }
  try {
    const core = loadCore();
    if (!core || typeof core[method] !== 'function') return availabilityFallback();
    // 主体【仅解析一次】(Pt2C)：先解析并校验，再固化给核心，杜绝核心二次解析不一致。
    const { principal, block } = resolvePrincipal(opts);
    if (block) return block;
    const now = (opts && opts.now !== undefined) ? opts.now : undefined; // 0 为合法受控时钟值
    const filteredMirror = filterMirrorToSelf(opts && opts.mirror, principal.employeeId);
    // 固化解析结果：最小冻结快照(status:'OK' + employeeId) 经 frozenResolver 返回核心。
    // v5 修正(Tom 13:26 Pt1)：必须保留受控固定 status:'OK' —— 既有核心 getLeaveTip 第191行要求
    // 解析器返回 {status:'OK', employeeId}，否则 pr.status 为 undefined !== 'OK' → 永远走"身份未通过校验"（功能整体失效）。
    // resolvePrincipal 已在此前校验 pr.status==='OK'，故冻结固定值诚实且必要。
    const principalSnapshot = Object.freeze({ status: 'OK', employeeId: principal.employeeId });
    const frozenResolver = () => principalSnapshot;
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
    _log('ERR_ENTRY');
    return availabilityFallback(); // Pt2A：任何意外异常（含 resolver 抛错/属性访问）不外逃
  }
}

// Pt1：两入口统一经 enterControlled，不再有绕过 bindPrincipal 的直接核心调用。
function getLeaveTipSafe(opts) { return enterControlled('getLeaveTip', opts); }
function handleRequestSafe(req) { return enterControlled('handleRequest', req); }

// 测试接缝
function __test_setCore(coreOrNull) { _CORE = coreOrNull; _CORE_ERR = coreOrNull ? null : 'injected-missing'; }
function __test_setLoader(fn) { _REQUIRE_CORE = (typeof fn === 'function') ? fn : (() => require('../ts_leave_tip_core.js')); }
function __test_resetCache() { _CORE = undefined; _CORE_ERR = null; }
function __test_coreState() { return _CORE; } // 不发加载副作用，仅读缓存

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    setFeatureEnabled, isFeatureEnabled,
    setTrustedResolver, getLeaveTipSafe, handleRequestSafe,
    resolvePrincipal, filterMirrorToSelf, wrapResponse, privacyBlocked, availabilityFallback,
    __test_setCore, __test_setLoader, __test_resetCache, __test_coreState, _loadCore: loadCore, _log,
  };
}
