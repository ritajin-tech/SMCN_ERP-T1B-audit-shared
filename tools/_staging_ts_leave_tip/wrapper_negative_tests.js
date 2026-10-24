// T1-B 生产表 Step1 · 包装负例测试（回应 Tom 2026-10-24 Pt1/2/3/4/6）
// 离线验证（不执行生产）：覆盖开关关 / 依赖缺失(含真实加载失败路径) / 镜像缺失 / 身份不可解析 /
// 异步 reject / 同步抛错 / opts.now=0 透传 / 跨用户行纵深拦截 / handleRequestSafe 同路径 /
// 客户端自报身份被忽略(显式断言) / 开关关不读取不解析(抛错 getter 验证) / 异常不外泄原始 message。
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

  // ---- 1) 开关关：不触碰逻辑/不读镜像/不解析身份（且即使这些会抛错也不被调用）----
  W.setFeatureEnabled(false);
  W.setTrustedResolver(() => { throw new Error('resolver-should-not-run'); });
  const throwingMirror = {};
  Object.defineProperty(throwingMirror, 'rows', { get() { throw new Error('rows-getter-should-not-run'); } });
  const off = W.getLeaveTipSafe({ session: { loginUser: 'alice@sm' }, fillDate: '2026-10-20', mirror: throwingMirror, identityResolver: maliciousResolver, employeeId: maliciousEmployeeId });
  check('开关关→DISABLED 且不读镜像不解析(恶意 getter/resolver 未触发抛错)', off.status === 'DISABLED' && off.submitAllowed === true && off.tip === null);

  // ---- 2) 依赖缺失（注入 null）：默认关仍能兜底，不崩 ----
  W.setFeatureEnabled(true);
  W.setTrustedResolver(trusted('E1001'));
  W.__test_setCore(null);
  const missing = W.getLeaveTipSafe({ session: { loginUser: 'alice@sm' }, fillDate: '2026-10-20' });
  check('依赖缺失(注入null)→可用性回退不崩', missing.status === 'FETCH_FAILED' && missing.submitAllowed === true);

  // ---- 2b) 真实加载失败路径（模拟 require 抛错，验证 catch 分支而非仅注入 null）----
  W.__test_forceLoadThrow(true);
  const loadFail = W.getLeaveTipSafe({ session: { loginUser: 'alice@sm' }, fillDate: '2026-10-20' });
  check('真实加载失败路径→可用性回退不崩(FETCH_FAILED)', loadFail.status === 'FETCH_FAILED' && loadFail.submitAllowed === true);
  W.__test_forceLoadThrow(false); // 复位

  // 恢复真实核心（本套件用注入 mock 模拟，避免依赖既有核心）
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
  check('employeeId 为空→仍 PRIVACY_BLOCKED(Pt2B 显式校验非空)', emptyId.status === 'PRIVACY_BLOCKED' && emptyId.privacyBlocked === true);

  // 注入"镜像感知"mock 核心：镜像缺失/不完整 → FETCH_FAILED
  W.setTrustedResolver(trusted('E1001'));
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

  // ---- 8) 镜像行级授权纵深过滤（Block3）+ 隐私状态映射 ----
  W.__test_setCore(null);
  const filt = W.filterMirrorToSelf(mirWithOther, 'E1001');
  check('镜像行级授权→仅保留本人行(E1001)，剔除 E9999', filt.rows.length === 1 && filt.rows[0].who === 'E1001');
  const privMap = W.wrapResponse({ status: 'AUTH_REQUIRED', submitAllowed: true, events: [] }, { employeeId: 'E1001' });
  check('核心身份状态→包装 PRIVACY_BLOCKED 分离', privMap.status === 'PRIVACY_BLOCKED' && privMap.privacyBlocked === true);
  check('隐私响应不含内部 status 文本', !JSON.stringify(privMap).includes('AUTH_REQUIRED'));

  // ---- 9) handleRequestSafe 同受控路径：未授权 → PRIVACY_BLOCKED（Pt1 统一入口）----
  // 恢复 mock 核心（前一步 filterMirrorToSelf 测试注入了 null，这里需还原，否则入口会先因缺核心短路）
  W.__test_setCore({ getLeaveTip: (o) => ({ status: 'OK', tip: 't', submitAllowed: true, events: [] }), handleRequest: () => ({ status: 'OK', tip: '', submitAllowed: true, events: [] }) });
  W.setTrustedResolver((s) => ({ status: 'AUTH_REQUIRED', employeeId: null }));
  const hrUnauth = W.handleRequestSafe({ session: {}, fillDate: '2026-10-20', mirror: { status: 'ok', rows: [] } });
  check('handleRequestSafe 未授权→PRIVACY_BLOCKED(同路径)', hrUnauth.status === 'PRIVACY_BLOCKED' && hrUnauth.privacyBlocked === true);

  // ---- 9b) handleRequestSafe 客户端自报身份被忽略（恶意 req.identityResolver 不生效）----
  W.setTrustedResolver(trusted('E1001'));
  const hrHackCore = {
    getLeaveTip: (o) => {
      const passedResolver = o.identityResolver;
      const resolved = passedResolver({ loginUser: 'alice@sm' });
      const mirrorRows = (o.mirror && o.mirror.rows) || [];
      const hasHacker = mirrorRows.some(r => r.who === 'E9999-HACKER');
      // 若包装未剔除恶意身份/未过滤他人行，这里直接抛错使测试失败
      assert.strictEqual(resolved.employeeId, 'E1001', '传给核心的解析器必须是 TRUSTED，而非恶意 opts');
      assert.strictEqual(hasHacker, false, '核心不得收到 E9999 他人行');
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

  // ---- 10) getLeaveTipSafe 客户端自报身份被忽略（核心安全验证点，显式断言）----
  W.setTrustedResolver(trusted('E1001'));
  W.__test_setCore({ getLeaveTip: (o) => {
    const passedResolver = o.identityResolver;
    const resolved = passedResolver({ loginUser: 'alice@sm' });
    const mirrorRows = (o.mirror && o.mirror.rows) || [];
    const hasHacker = mirrorRows.some(r => r.who === 'E9999-HACKER');
    assert.strictEqual(resolved.employeeId, 'E1001', '传给核心的解析器必须是 TRUSTED');
    assert.strictEqual(hasHacker, false, '核心不得收到 E9999 他人行');
    return { status: 'OK', tip: 't', submitAllowed: true, events: mirrorRows.map(r => ({ instanceId: r.instanceId, date: r.date, type: r.type, half: r.half, state: r.state, version: r.version })) };
  }, handleRequest: () => ({}) });
  const hackAttempt = W.getLeaveTipSafe({ session: { loginUser: 'alice@sm' }, fillDate: '2026-10-20', mirror: mirWithOther, now: new Date('2026-10-20T08:00:00+08:00'), identityResolver: maliciousResolver, employeeId: maliciousEmployeeId });
  check('客户端自报身份被忽略→仅 E1001 本人事件(无 E9999)', hackAttempt.status === 'OK' && Array.isArray(hackAttempt.events) && hackAttempt.events.length === 1 && hackAttempt.events[0].instanceId === 'OWN');

  // ---- 11) 合法本人+新鲜镜像 → 正常产出（端到端，用注入核心模拟）----
  W.__test_setCore({ getLeaveTip: (o) => ({ status: 'OK', tip: '你有 1 条请假', submitAllowed: true, events: [{ instanceId: 'I3', date: '2026-10-20', type: '事假', half: 'AM', state: 'ACTIVE', version: 1 }] }), handleRequest: () => ({}) });
  const okRes = W.getLeaveTipSafe({ session: { loginUser: 'alice@sm' }, fillDate: '2026-10-20', mirror: { status: 'ok', syncComplete: true, lastSuccessfulSyncAt: '2026-10-20T06:30:00+08:00', rows: [{ instanceId: 'I3', who: 'E1001', date: '2026-10-20', type: '事假', half: 'AM', state: 'ACTIVE', version: 1 }] }, now: new Date('2026-10-20T08:00:00+08:00') });
  check('合法本人+新鲜镜像→OK 且仅 1 条本人事件(who 已最小化剔除)', okRes.status === 'OK' && Array.isArray(okRes.events) && okRes.events.length === 1 && okRes.submitAllowed === true);

  W.setFeatureEnabled(false);
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch(e => { console.error('测试运行异常:', e); process.exit(2); });
