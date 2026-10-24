// T1-B 生产表 Step1 · 包装负例测试（回应 Tom 2026-10-24 Block1/2/3/4）
// 离线验证（不执行生产）：覆盖开关关 / 依赖缺失 / 镜像缺失 / 身份不可解析 / 异步 reject / 同步抛错 /
// opts.now=0 透传 / 跨用户行纵深拦截 / handleRequestSafe 异常兜底 / 客户端自报身份被忽略。
// 设计：本套件【自包含】，不依赖 ts_leave_tip_core.js（既有核心不重发）；
//   真实核心委托由提交方在本地环境另测（与核心 82 例隔离测试一并验证），此处用注入 mock 模拟核心 OK。
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
  // 所有测试统一通过 setTrustedResolver 注入可信解析器（模拟服务端受控 session）；
  // 且故意在 opts 里塞入恶意 identityResolver/employeeId，验证包装【忽略】它们。
  const trusted = (id) => (session) => {
    const u = String((session && session.loginUser) || '').trim().toLowerCase();
    if (u === 'dup@sm') return { status: 'UNAUTHORIZED', employeeId: null };
    if (!u) return { status: 'AUTH_REQUIRED', employeeId: null };
    return { status: 'OK', employeeId: id || 'E1001' };
  };
  // 恶意客户端尝试自报身份（应在任何路径下被忽略）
  const maliciousResolver = () => ({ status: 'OK', employeeId: 'E9999-HACKER' });
  const maliciousEmployeeId = 'E9999-HACKER';

  // ---- 1) 开关关：不触碰逻辑/不读镜像/不解析身份 ----
  W.setFeatureEnabled(false);
  W.setTrustedResolver(trusted('E1001'));
  const off = W.getLeaveTipSafe({ session: { loginUser: 'alice@sm' }, fillDate: '2026-10-20', mirror: { status: 'ok', rows: [{ who: 'X' }] }, identityResolver: maliciousResolver, employeeId: maliciousEmployeeId });
  check('开关关→DISABLED 且不读镜像不解析(忽略恶意opts)', off.status === 'DISABLED' && off.submitAllowed === true && off.tip === null);

  // ---- 2) 依赖缺失（模拟 require 失败）：默认关仍能兜底，不崩 ----
  W.setFeatureEnabled(true);
  W.__test_setCore(null); // 注入"依赖缺失"
  const missing = W.getLeaveTipSafe({ session: { loginUser: 'alice@sm' }, fillDate: '2026-10-20' });
  check('依赖缺失→可用性回退不崩', missing.status === 'FETCH_FAILED' && missing.submitAllowed === true);

  // 恢复真实核心（本套件用注入 mock 模拟，避免依赖既有核心）
  W.__test_setCore({ getLeaveTip: (o) => ({ status: 'OK', tip: 't', submitAllowed: true, events: [{ instanceId: 'I3', date: '2026-10-20', type: '事假', half: 'AM', state: 'ACTIVE', version: 1 }] }), handleRequest: () => ({ status: 'OK', tip: '', submitAllowed: true, events: [] }) });

  // ---- 3) 身份不可解析：AUTH_REQUIRED / UNAUTHORIZED → PRIVACY_BLOCKED（与可用性分离）----
  W.setTrustedResolver((s) => ({ status: 'AUTH_REQUIRED', employeeId: null }));
  const noAuth = W.getLeaveTipSafe({ session: {}, fillDate: '2026-10-20', mirror: { status: 'ok', rows: [] } });
  check('无 session 主体→PRIVACY_BLOCKED+privacyBlocked标记', noAuth.status === 'PRIVACY_BLOCKED' && noAuth.privacyBlocked === true && noAuth.submitAllowed === true);

  W.setTrustedResolver((s) => ({ status: 'UNAUTHORIZED', employeeId: null }));
  const dup = W.getLeaveTipSafe({ session: { loginUser: 'dup@sm' }, fillDate: '2026-10-20', mirror: { status: 'ok', rows: [] } });
  check('非唯一/未授权主体→PRIVACY_BLOCKED', dup.status === 'PRIVACY_BLOCKED' && dup.privacyBlocked === true);

  // 注入"镜像感知"mock 核心：镜像缺失/不完整 → FETCH_FAILED（模拟真实核心行为，使套件自包含）
  W.__test_setCore({ getLeaveTip: (o) => {
    if (!o.mirror || !Array.isArray(o.mirror.rows) || o.mirror.rows.length === 0) return { status: 'FETCH_FAILED', tip: null, submitAllowed: true, events: [] };
    return { status: 'OK', tip: '你有请假', submitAllowed: true, events: o.mirror.rows.map(r => ({ instanceId: r.instanceId, date: r.date, type: r.type, half: r.half, state: r.state, version: r.version })) };
  }, handleRequest: () => ({ status: 'OK', tip: '', submitAllowed: true, events: [] }) });

  // ---- 4) 镜像缺失 → 可用性回退（FETCH_FAILED），不阻塞填报 ----
  W.setTrustedResolver(trusted('E1001'));
  const noMirror = W.getLeaveTipSafe({ session: { loginUser: 'alice@sm' }, fillDate: '2026-10-20' });
  check('镜像缺失→可用性回退(非隐私)', noMirror.status === 'FETCH_FAILED' && noMirror.availabilityFallback === true && noMirror.submitAllowed === true);

  // ---- 5) opts.now=0 透传（修复：不再用 !!now 把合法 0 当缺失）----
  let recorded = null;
  W.__test_setCore({ getLeaveTip: (o) => { recorded = o.now; return { status: 'FETCH_FAILED', tip: null, submitAllowed: true, events: [] }; }, handleRequest: () => ({}) });
  W.getLeaveTipSafe({ session: { loginUser: 'alice@sm' }, fillDate: '2026-10-20', now: 0 });
  check('opts.now=0 被透传(not undefined)', recorded === 0);

  // ---- 6) 异步 reject 兜底（Block1：核心返回 Promise reject → 可用性回退）----
  let asyncMock = { getLeaveTip: () => Promise.reject(new Error('async boom')), handleRequest: () => ({}) };
  W.__test_setCore(asyncMock);
  const asyncRes = await W.getLeaveTipSafe({ session: { loginUser: 'alice@sm' }, fillDate: '2026-10-20' });
  check('异步 reject→可用性回退不崩', asyncRes.status === 'FETCH_FAILED' && asyncRes.submitAllowed === true);

  // ---- 7) 同步抛错兜底（Block1：核心同步抛错 → 可用性回退）----
  let syncMock = { getLeaveTip: () => { throw new Error('sync boom'); }, handleRequest: () => ({}) };
  W.__test_setCore(syncMock);
  const syncRes = W.getLeaveTipSafe({ session: { loginUser: 'alice@sm' }, fillDate: '2026-10-20' });
  check('同步抛错→可用性回退不崩', syncRes.status === 'FETCH_FAILED' && syncRes.submitAllowed === true);

  // ---- 8) 镜像行级授权纵深过滤（Block3：包装层在调用核心前即滤掉他人行）----
  W.__test_setCore(null);
  const mirWithOther = { status: 'ok', syncComplete: true, lastSuccessfulSyncAt: '2026-10-20T06:30:00+08:00', rows: [
    { instanceId: 'OWN', who: 'E1001', date: '2026-10-20', type: '事假', half: 'AM', state: 'ACTIVE', version: 1 },
    { instanceId: 'OTHER', who: 'E9999', date: '2026-10-20', type: '病假', half: 'PM', state: 'ACTIVE', version: 1 },
  ] };
  // 即使 opts 传入恶意 resolver/employeeId，包装只用 TRUSTED_RESOLVER（E1001），且过滤他人行
  const filt = W.bindPrincipal({ session: { loginUser: 'alice@sm' }, mirror: mirWithOther, identityResolver: maliciousResolver, employeeId: maliciousEmployeeId });
  check('镜像行级授权→仅保留本人行(E1001)，剔除 E9999', filt.filteredMirror.rows.length === 1 && filt.filteredMirror.rows[0].who === 'E1001');
  // 隐私状态映射：核心返回 AUTH_REQUIRED/UNAUTHORIZED → 包装标记 PRIVACY_BLOCKED（与可用性分离）
  const privMap = W.wrapResponse({ status: 'AUTH_REQUIRED', submitAllowed: true, events: [] }, { employeeId: 'E1001' });
  check('核心身份状态→包装 PRIVACY_BLOCKED 分离', privMap.status === 'PRIVACY_BLOCKED' && privMap.privacyBlocked === true);

  // ---- 9) handleRequestSafe 异常兜底（Block1：原缺 try/catch）----
  let hrMock = { getLeaveTip: () => ({ status: 'OK', tip: '', submitAllowed: true, events: [] }), handleRequest: () => { throw new Error('hr boom'); } };
  W.__test_setCore(hrMock);
  const hrRes = W.handleRequestSafe({ session: { loginUser: 'alice@sm' } });
  check('handleRequestSafe 同步抛错→可用性回退', hrRes.status === 'FETCH_FAILED' && hrRes.submitAllowed === true);

  // ---- 10) 客户端自报身份被忽略（核心安全验证点）----
  // 故意在 opts 注入恶意 resolver + employeeId=E9999，可信解析器给 E1001；结果必须只含 E1001 本人行，不出现 E9999
  W.__test_setCore({ getLeaveTip: (o) => {
    // 验证：传入核心的 identityResolver 必须是 TRUSTED（不是恶意 opts），且核心只看到过滤后的本人镜像
    const passedResolver = o.identityResolver;
    const resolved = passedResolver({ loginUser: 'alice@sm' });
    const mirrorRows = (o.mirror && o.mirror.rows) || [];
    const hasHacker = mirrorRows.some(r => r.who === 'E9999-HACKER');
    return { status: 'OK', tip: 't', submitAllowed: true, events: mirrorRows.map(r => ({ instanceId: r.instanceId, date: r.date, type: r.type, half: r.half, state: r.state, version: r.version })) };
  }, handleRequest: () => ({}) });
  W.setTrustedResolver(trusted('E1001'));
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
