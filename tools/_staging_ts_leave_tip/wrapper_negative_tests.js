// T1-B 生产表 Step1 · 包装负例测试（回应 Tom 2026-10-24 12:27 Pt1/2/3/6 第三轮 + 13:26 Pt1/Pt2 残项）
// 离线验证（不执行生产）：覆盖 开关关(不加载/不读/不解析) / 真实加载失败(require catch) /
// 镜像缺失 / 身份不可解析 / employeeId 恶意值(空白串/数组/对象)+解析器抛错+双入口 /
// 异步 reject / 同步抛错 / opts.now=0 透传 / 跨用户行纵深拦截 / handleRequestSafe 同路径 /
// 客户端自报身份被忽略(显式断言核心仅收本人行) / 日志脱敏(敏感串不出现) / 异常不外泄原始 message。
// 设计：自包含，不依赖 ts_leave_tip_core.js（既有核心不重发）；真实核心委托由提交方另行验证。
// 运行：node wrapper_negative_tests.js   exit 0 = 全部通过

'use strict';
const assert = require('assert');
const W = require('./deploy_wrapper.js');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name); }
}

async function run() {
  // 可信解析器（模拟服务端受控 session）；故意在 opts 塞恶意 identityResolver/employeeId，验证包装忽略它们。
  const trusted = (id) => (session) => {
    const u = String((session && session.loginUser) || '').trim().toLowerCase();
    if (u === 'dup@sm') return { status: 'UNAUTHORIZED', employeeId: null };
    if (!u) return { status: 'AUTH_REQUIRED', employeeId: null };
    return { status: 'OK', employeeId: id || 'E1001' };
  };
  const maliciousResolver = () => ({ status: 'OK', employeeId: 'E9999-HACKER' });
  const maliciousEmployeeId = 'E9999-HACKER';
  const mirWithOther = { status: 'ok', syncComplete: true, lastSuccessfulSyncAt: '2026-10-20T06:30:00+08:00', rows: [
    { instanceId: 'OWN', who: 'E1001', date: '2026-10-20', type: '事假', half: 'AM', state: 'ACTIVE', version: 1 },
    { instanceId: 'OTHER', who: 'E9999', date: '2026-10-20', type: '病假', half: 'PM', state: 'ACTIVE', version: 1 },
  ] };

  // ---- 1) 开关关：两入口均不加载 / 不读镜像 / 不解析身份（恶意 getter/resolver 未触发）----
  W.setFeatureEnabled(false);
  W.__test_resetCache();
  let offLoadCalls = 0;
  W.__test_setLoader(() => { offLoadCalls++; throw new Error('should-not-load'); });
  W.setTrustedResolver(() => { throw new Error('resolver-should-not-run'); });
  const throwingMirror = {};
  Object.defineProperty(throwingMirror, 'rows', { get() { throw new Error('rows-getter-should-not-run'); } });
  const off = W.getLeaveTipSafe({ session: { loginUser: 'alice@sm' }, fillDate: '2026-10-20', mirror: throwingMirror, identityResolver: maliciousResolver, employeeId: maliciousEmployeeId });
  const offHr = W.handleRequestSafe({ session: { loginUser: 'alice@sm' }, fillDate: '2026-10-20', mirror: throwingMirror });
  check('开关关→两入口均 DISABLED', off.status === 'DISABLED' && offHr.status === 'DISABLED' && off.submitAllowed === true && offHr.submitAllowed === true);
  check('开关关→加载器零调用(不读不解析不加载)', offLoadCalls === 0 && W.__test_coreState() === undefined);
  W.__test_resetCache();
  W.__test_setLoader(null);

  // ---- 2) 真实加载失败路径：清空缓存 + 注入确实 throw 的受控 loader，验证 try/catch 真正捕获 ----
  W.setFeatureEnabled(true);
  W.setTrustedResolver(trusted('E1001'));
  W.__test_resetCache();
  let loadCalls = 0;
  W.__test_setLoader(() => { loadCalls++; throw new Error('simulated require failure'); });
  const loadFail = W.getLeaveTipSafe({ session: { loginUser: 'alice@sm' }, fillDate: '2026-10-20' });
  check('真实加载失败路径→可用性回退不崩(FETCH_FAILED)', loadFail.status === 'FETCH_FAILED' && loadFail.submitAllowed === true);
  check('真实加载失败→require 分支确实被调用(loadCalls>=1)', loadCalls >= 1);
  check('真实加载失败→_CORE 被置 null(捕获生效)', W.__test_coreState() === null);
  W.__test_resetCache();
  W.__test_setLoader(null);

  // 恢复 mock 核心（本套件用注入 mock 模拟，避免依赖既有核心）
  W.__test_setCore({ getLeaveTip: (o) => ({ status: 'OK', tip: 't', submitAllowed: true, events: [{ instanceId: 'I3', date: '2026-10-20', type: '事假', half: 'AM', state: 'ACTIVE', version: 1 }] }), handleRequest: () => ({ status: 'OK', tip: '', submitAllowed: true, events: [] }) });

  // ---- 3) 身份不可解析：AUTH_REQUIRED / UNAUTHORIZED → PRIVACY_BLOCKED（与可用性分离）----
  W.setTrustedResolver((s) => ({ status: 'AUTH_REQUIRED', employeeId: null }));
  const noAuth = W.getLeaveTipSafe({ session: {}, fillDate: '2026-10-20', mirror: { status: 'ok', rows: [] } });
  check('无 session 主体→PRIVACY_BLOCKED+privacyBlocked标记', noAuth.status === 'PRIVACY_BLOCKED' && noAuth.privacyBlocked === true && noAuth.submitAllowed === true);

  W.setTrustedResolver((s) => ({ status: 'UNAUTHORIZED', employeeId: null }));
  const dup = W.getLeaveTipSafe({ session: { loginUser: 'dup@sm' }, fillDate: '2026-10-20', mirror: { status: 'ok', rows: [] } });
  check('非唯一/未授权主体→PRIVACY_BLOCKED', dup.status === 'PRIVACY_BLOCKED' && dup.privacyBlocked === true);

  W.setTrustedResolver((s) => ({ status: 'OK', employeeId: null })); // 解析器返回 OK 但 employeeId 为空 → 仍隐私封闭
  const emptyId = W.getLeaveTipSafe({ session: { loginUser: 'alice@sm' }, fillDate: '2026-10-20', mirror: { status: 'ok', rows: [] } });
  check('employeeId 为空→仍 PRIVACY_BLOCKED(Pt2 显式校验非空)', emptyId.status === 'PRIVACY_BLOCKED' && emptyId.privacyBlocked === true);

  // ---- 3b) employeeId 恶意值（Pt2：非空白 trim 字符串一律拒）+ 解析器抛错 + 双入口一致 ----
  W.setTrustedResolver(() => ({ status: 'OK', employeeId: '   ' }));
  check('employeeId 空白字符串→PRIVACY_BLOCKED', W.getLeaveTipSafe({ session: { loginUser: 'a' } }).status === 'PRIVACY_BLOCKED');
  W.setTrustedResolver(() => ({ status: 'OK', employeeId: [] }));
  check('employeeId 数组→PRIVACY_BLOCKED', W.getLeaveTipSafe({ session: { loginUser: 'a' } }).status === 'PRIVACY_BLOCKED');
  W.setTrustedResolver(() => ({ status: 'OK', employeeId: {} }));
  check('employeeId 对象→PRIVACY_BLOCKED', W.getLeaveTipSafe({ session: { loginUser: 'a' } }).status === 'PRIVACY_BLOCKED');
  W.setTrustedResolver(() => { throw new Error('resolver boom'); });
  check('解析器抛错→PRIVACY_BLOCKED(不外逃)', W.getLeaveTipSafe({ session: { loginUser: 'a' } }).status === 'PRIVACY_BLOCKED');
  W.setTrustedResolver(() => ({ status: 'OK', employeeId: '   ' }));
  check('handleRequestSafe employeeId 空白→PRIVACY_BLOCKED(双入口一致)', W.handleRequestSafe({ session: { loginUser: 'a' } }).status === 'PRIVACY_BLOCKED');
  W.setTrustedResolver(trusted('E1001'));

  // 注入"镜像感知"mock 核心：镜像缺失/不完整 → FETCH_FAILED
  W.__test_setCore({ getLeaveTip: (o) => {
    if (!o.mirror || !Array.isArray(o.mirror.rows) || o.mirror.rows.length === 0) return { status: 'FETCH_FAILED', tip: null, submitAllowed: true, events: [] };
    return { status: 'OK', tip: '你有请假', submitAllowed: true, events: o.mirror.rows.map(r => ({ instanceId: r.instanceId, date: r.date, type: r.type, half: r.half, state: r.state, version: r.version })) };
  }, handleRequest: () => ({ status: 'OK', tip: '', submitAllowed: true, events: [] }) });

  // ---- 4) 镜像缺失 → 可用性回退（FETCH_FAILED），不阻塞填报 ----
  const noMirror = W.getLeaveTipSafe({ session: { loginUser: 'alice@sm' }, fillDate: '2026-10-20' });
  check('镜像缺失→可用性回退(非隐私)', noMirror.status === 'FETCH_FAILED' && noMirror.availabilityFallback === true && noMirror.submitAllowed === true);

  // ---- 5) opts.now=0 透传（修复：不再用 !!now 把合法 0 当缺失）----
  let recorded = null;
  W.__test_setCore({ getLeaveTip: (o) => { recorded = o.now; return { status: 'FETCH_FAILED', tip: null, submitAllowed: true, events: [] }; }, handleRequest: () => ({}) });
  W.getLeaveTipSafe({ session: { loginUser: 'alice@sm' }, fillDate: '2026-10-20', now: 0 });
  check('opts.now=0 被透传(not undefined)', recorded === 0);

  // ---- 6) 异步 reject 兜底（Block1：核心返回 Promise reject → 可用性回退）----
  W.__test_setCore({ getLeaveTip: () => Promise.reject(new Error('async boom')), handleRequest: () => ({}) });
  const asyncRes = await W.getLeaveTipSafe({ session: { loginUser: 'alice@sm' }, fillDate: '2026-10-20' });
  check('异步 reject→可用性回退不崩', asyncRes.status === 'FETCH_FAILED' && asyncRes.submitAllowed === true);

  // ---- 7) 同步抛错兜底（Block1）----
  W.__test_setCore({ getLeaveTip: () => { throw new Error('sync boom'); }, handleRequest: () => ({}) });
  const syncRes = W.getLeaveTipSafe({ session: { loginUser: 'alice@sm' }, fillDate: '2026-10-20' });
  check('同步抛错→可用性回退不崩', syncRes.status === 'FETCH_FAILED' && syncRes.submitAllowed === true);

  // ---- 7b) 异常不外泄原始 message（Pt3）：catch 后响应中不得含原始异常文本 ----
  check('响应不含原始异常文本(无 "boom")', !JSON.stringify(syncRes).includes('boom'));

  // ---- 7c) 日志脱敏（Pt3）：捕获 console.error，验证敏感原始异常文本【不】出现在日志中 ----
  const realErr = console.error;
  let logBuf = [];
  console.error = (...a) => { logBuf.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
  W.__test_resetCache();
  W.__test_setLoader(() => { throw new Error('SENSITIVE_EMPLOYEE_X999 leaked into log'); });
  W.setTrustedResolver(() => ({ status: 'OK', employeeId: 'E1001' }));
  const desens = W.getLeaveTipSafe({ session: { loginUser: 'alice@sm' } });
  console.error = realErr;
  check('日志脱敏→日志中仅含固定码(含 ERR_)、不含敏感原始异常文本',
    logBuf.join('').includes('ERR_') && !logBuf.join('').includes('SENSITIVE_EMPLOYEE_X999'));
  check('日志脱敏→响应中亦不含敏感原始异常文本', !JSON.stringify(desens).includes('SENSITIVE_EMPLOYEE_X999'));
  W.__test_resetCache();
  W.__test_setLoader(null);

  // ---- 8) 镜像行级授权纵深过滤（Block3）+ 隐私状态映射 ----
  W.__test_setCore(null);
  const filt = W.filterMirrorToSelf(mirWithOther, 'E1001');
  check('镜像行级授权→仅保留本人行(E1001)，剔除 E9999', filt.rows.length === 1 && filt.rows[0].who === 'E1001');
  const privMap = W.wrapResponse({ status: 'AUTH_REQUIRED', submitAllowed: true, events: [] }, { employeeId: 'E1001' });
  check('核心身份状态→包装 PRIVACY_BLOCKED 分离', privMap.status === 'PRIVACY_BLOCKED' && privMap.privacyBlocked === true);
  check('隐私响应不含内部 status 文本', !JSON.stringify(privMap).includes('AUTH_REQUIRED'));

  // ---- 8b) wrapResponse 未知 status → 降级 FETCH_FAILED（Pt3：status 枚举限制）----
  const unknown = W.wrapResponse({ status: 'SOME_INTERNAL_STATE', tip: 'x', submitAllowed: true, events: [] }, { employeeId: 'E1001' });
  check('wrapResponse 未知 status→降级 FETCH_FAILED(不外泄内部态)', unknown.status === 'FETCH_FAILED');

  // ---- 9) handleRequestSafe 同受控路径：未授权 → PRIVACY_BLOCKED（Pt1 统一入口）----
  W.__test_setCore({ getLeaveTip: (o) => ({ status: 'OK', tip: 't', submitAllowed: true, events: [] }), handleRequest: () => ({ status: 'OK', tip: '', submitAllowed: true, events: [] }) });
  W.setTrustedResolver((s) => ({ status: 'AUTH_REQUIRED', employeeId: null }));
  const hrUnauth = W.handleRequestSafe({ session: {}, fillDate: '2026-10-20', mirror: { status: 'ok', rows: [] } });
  check('handleRequestSafe 未授权→PRIVACY_BLOCKED(同路径)', hrUnauth.status === 'PRIVACY_BLOCKED' && hrUnauth.privacyBlocked === true);

  // ---- 9b) handleRequestSafe 客户端自报身份被忽略（恶意 req.identityResolver 不生效；核心仅收本人行）----
  W.setTrustedResolver(trusted('E1001'));
  const hrHackCore = {
    getLeaveTip: (o) => {
      const passedResolver = o.identityResolver;
      const resolved = passedResolver({ loginUser: 'alice@sm' });
      const mirrorRows = (o.mirror && o.mirror.rows) || [];
      // Pt6：直接断言"核心收到的镜像全部是已绑定主体本人行"(比 hasHacker 更准确，证明纵深过滤已生效)
      assert.strictEqual(resolved.employeeId, 'E1001', '传给核心的解析器必须是 TRUSTED，而非恶意 opts');
      assert.ok(mirrorRows.length >= 1 && mirrorRows.every(r => r.who === 'E1001'), '核心收到的镜像必须全部是已绑定主体本人行(无他人行/无 E9999)');
      return { status: 'OK', tip: 't', submitAllowed: true, events: mirrorRows.map(r => ({ instanceId: r.instanceId, date: r.date, type: r.type, half: r.half, state: r.state, version: r.version })) };
    },
    // 与真实核心一致：handleRequest 委托给 getLeaveTip（验证包装经统一受控路径把受控入参交到委托链）
    handleRequest: (req) => hrHackCore.getLeaveTip({ session: req.session, fillDate: req.fillDate, fromDate: req.fromDate, toDate: req.toDate, mirror: req.mirror, fail: req.fail, now: req.now, identityResolver: req.identityResolver }),
  };
  W.__test_setCore(hrHackCore);
  const hrHack = W.handleRequestSafe({ session: { loginUser: 'alice@sm' }, fillDate: '2026-10-20', mirror: mirWithOther, now: new Date('2026-10-20T08:00:00+08:00'), identityResolver: maliciousResolver, employeeId: maliciousEmployeeId });
  check('handleRequestSafe 客户端自报身份被忽略→仅 E1001 本人事件(无 E9999)', hrHack.status === 'OK' && Array.isArray(hrHack.events) && hrHack.events.length === 1 && hrHack.events[0].instanceId === 'OWN');

  // ---- 9c) handleRequestSafe 异步 reject 兜底 ----
  W.__test_setCore({ getLeaveTip: () => ({ status: 'OK', tip: '', submitAllowed: true, events: [] }), handleRequest: () => Promise.reject(new Error('hr async')) });
  const hrAsync = await W.handleRequestSafe({ session: { loginUser: 'alice@sm' } });
  check('handleRequestSafe 异步 reject→可用性回退', hrAsync.status === 'FETCH_FAILED' && hrAsync.submitAllowed === true);

  // ---- 10) getLeaveTipSafe 客户端自报身份被忽略（核心安全验证点，显式断言仅收本人行）----
  W.setTrustedResolver(trusted('E1001'));
  W.__test_setCore({ getLeaveTip: (o) => {
    const passedResolver = o.identityResolver;
    const resolved = passedResolver({ loginUser: 'alice@sm' });
    const mirrorRows = (o.mirror && o.mirror.rows) || [];
    assert.strictEqual(resolved.employeeId, 'E1001', '传给核心的解析器必须是 TRUSTED');
    assert.ok(mirrorRows.length >= 1 && mirrorRows.every(r => r.who === 'E1001'), '核心收到的镜像必须全部是已绑定主体本人行(无他人行/无 E9999)');
    return { status: 'OK', tip: 't', submitAllowed: true, events: mirrorRows.map(r => ({ instanceId: r.instanceId, date: r.date, type: r.type, half: r.half, state: r.state, version: r.version })) };
  }, handleRequest: () => ({}) });
  const hackAttempt = W.getLeaveTipSafe({ session: { loginUser: 'alice@sm' }, fillDate: '2026-10-20', mirror: mirWithOther, now: new Date('2026-10-20T08:00:00+08:00'), identityResolver: maliciousResolver, employeeId: maliciousEmployeeId });
  check('客户端自报身份被忽略→仅 E1001 本人事件(无 E9999)', hackAttempt.status === 'OK' && Array.isArray(hackAttempt.events) && hackAttempt.events.length === 1 && hackAttempt.events[0].instanceId === 'OWN');

  // ---- 11) 合法本人+新鲜镜像 → 正常产出（端到端，用注入核心模拟）----
  W.__test_setCore({ getLeaveTip: (o) => ({ status: 'OK', tip: '你有 1 条请假', submitAllowed: true, events: [{ instanceId: 'I3', date: '2026-10-20', type: '事假', half: 'AM', state: 'ACTIVE', version: 1 }] }), handleRequest: () => ({}) });
  const okRes = W.getLeaveTipSafe({ session: { loginUser: 'alice@sm' }, fillDate: '2026-10-20', mirror: { status: 'ok', syncComplete: true, lastSuccessfulSyncAt: '2026-10-20T06:30:00+08:00', rows: [{ instanceId: 'I3', who: 'E1001', date: '2026-10-20', type: '事假', half: 'AM', state: 'ACTIVE', version: 1 }] }, now: new Date('2026-10-20T08:00:00+08:00') });
  check('合法本人+新鲜镜像→OK 且仅 1 条本人事件(who 已最小化剔除)', okRes.status === 'OK' && Array.isArray(okRes.events) && okRes.events.length === 1 && okRes.submitAllowed === true);

  // ---- 12) 真实核心 resolver 契约兼容性（Tom 13:26 Pt1 残项修复验证）----
  // 既有核心 getLeaveTip 第191行要求解析器返回 {status:'OK', employeeId}，否则 pr.status 为 undefined
  // !== 'OK' → 永远走"身份未通过校验"分支（功能整体失效）。用真实核心验证修复后冻结快照满足契约。
  // 注：既有核心不随 staging 分发（避免重复分发核心/人员数据，Tom 明示），故本节约在 clone 中
  //     自动跳过并由提交方本地（核心同仓）另行验证；缺失时不得使整套件崩溃（self-contained 契约）。
  let realCore = null;
  try { realCore = require('../ts_leave_tip_core.js'); } catch (e) { realCore = null; }
  if (realCore) {
  W.__test_setCore(realCore);
  W.setFeatureEnabled(true);
  W.setTrustedResolver((s) => ({ status: 'OK', employeeId: 'E1001' })); // 模拟服务端已解析可信主体
  const compatMirror = { status: 'ok', syncComplete: true, lastSuccessfulSyncAt: '2026-10-20T06:30:00+08:00', rows: [
    { instanceId: 'OWN', who: 'E1001', date: '2026-10-20', type: '事假', half: 'AM', state: 'ACTIVE', version: 1 },
  ] };
  const compat = W.getLeaveTipSafe({ session: {}, fillDate: '2026-10-20', mirror: compatMirror, now: new Date('2026-10-20T08:00:00+08:00') });
  check('真实核心兼容：冻结快照含 status:OK → 实际产出本人请假(OK)', compat.status === 'OK' && Array.isArray(compat.events) && compat.events.length === 1 && compat.events[0].instanceId === 'OWN' && compat.events[0].who === undefined);
  // 回归守卫：若冻结快照仅 {employeeId}（修复前形态），真实核心应产出非 OK（证明该 bug 确会失效）
  const coreNoStatus = realCore.getLeaveTip({ session: {}, fillDate: '2026-10-20', mirror: compatMirror, now: new Date('2026-10-20T08:00:00+08:00'), identityResolver: () => ({ employeeId: 'E1001' }) });
  check('回归守卫：缺 status 的解析结果→真实核心非 OK（故修复必须冻结 status:OK）', coreNoStatus.status !== 'OK');
  W.setFeatureEnabled(false);
  } else {
    console.log('  ⏭️ 真实核心契约兼容(第12节)：跳过——既有核心不随 staging 分发，由提交方本地另行验证');
  }

  // ---- 13) wrapResponse fail-closed（Tom 13:26 Pt2）：未知态/失败态/隐私态不得携带敏感 tip/events ----
  const sentinelUnknown = W.wrapResponse({ status: 'INTERNAL_SECRET_STATE', tip: 'SECRET_TIP_SENTINEL', events: [{ instanceId: 'X', who: 'E9999', date: '2026-10-20', type: '病假', half: 'PM', state: 'ACTIVE', version: 1 }] }, { employeeId: 'E1001' });
  check('wrapResponse 未知态→tip/events 清空(无敏感哨兵)', sentinelUnknown.status === 'FETCH_FAILED' && sentinelUnknown.tip === null && sentinelUnknown.events.length === 0 && !JSON.stringify(sentinelUnknown).includes('SECRET_TIP_SENTINEL') && !JSON.stringify(sentinelUnknown).includes('E9999'));
  const sentinelFail = W.wrapResponse({ status: 'MIRROR_STALE', tip: 'SECRET_TIP_SENTINEL', events: [{ instanceId: 'X', who: 'E9999' }] }, { employeeId: 'E1001' });
  check('wrapResponse 失败态(MIRROR_STALE)→tip/events 清空(无敏感哨兵)', sentinelFail.tip === null && sentinelFail.events.length === 0 && !JSON.stringify(sentinelFail).includes('SECRET_TIP_SENTINEL') && !JSON.stringify(sentinelFail).includes('E9999'));
  const privacyResp = W.wrapResponse({ status: 'PRIVACY_BLOCKED', tip: 'SECRET_TIP_SENTINEL', events: [{ instanceId: 'X', who: 'E9999' }] }, { employeeId: 'E1001' });
  check('wrapResponse 隐私态→固定隐私封闭(无敏感数据)', privacyResp.status === 'PRIVACY_BLOCKED' && privacyResp.tip === null && privacyResp.events.length === 0);
  const okResp = W.wrapResponse({ status: 'OK', tip: '你有 1 条请假', submitAllowed: true, events: [{ instanceId: 'OWN', date: '2026-10-20', type: '事假', half: 'AM', state: 'ACTIVE', version: 1 }] }, { employeeId: 'E1001' });
  check('wrapResponse OK→透传本人业务内容(tip/events)', okResp.status === 'OK' && okResp.tip === '你有 1 条请假' && okResp.events.length === 1);

  W.setFeatureEnabled(false);
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch(e => { console.error('测试运行异常:', e); process.exit(2); });
