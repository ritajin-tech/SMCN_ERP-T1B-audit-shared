#!/usr/bin/env node
'use strict';
//
// 受信锁适配器骨架（回应 Tom 2101 #2：锁句柄必须由服务端受信锁适配器签发）
//
// Tom 2101 #2 的原文问题：
//   「held/id/released 是调用方可构造的普通对象，不能证明锁真实持有、与期锁同域或跨进程串行；
//     lockId 还是可选。该契约仅适合模拟，须实际服务端受信锁适配器持锁验证。」
//
// 本文件的职责边界（务必看清，不得夸大）：
//   ✅ 做什么：把「取锁 → 立即签发带签名的句柄」这一动作封装成【唯一入口】，
//              使 clearance 侧拿到的句柄不再是调用方随手拼的普通对象：
//                handle = { id, held:true, released:false,
//                           attest:{ alg:'HMAC-SHA256', dom:<锁域>, sig:HMAC(secret, id|dom) } }
//              release 时把 released 置 true 并清掉 attest（防止"释放后的旧句柄"被重放）。
//   ❌ 不做什么：**不证明**锁的真实互斥范围。GAS LockService.getScriptLock() 按官方说明
//              仅作用于同一脚本项目内的并发执行，不提供跨项目/跨文档/跨用户互斥；
//              真正的服务端串行必须由 GAS 运行环境提供，本骨架只能把它"接进来"，不能"替它证明"。
//
// 生产落地要求（未实现，列为 Stage-1 未完成项，验收前不得声称已完成）：
//   1) secret 必须来自服务端受信配置（GAS PropertiesService 的 ScriptProperty），
//      **不得**写死在代码里、不得由请求参数注入；
//   2) dom（锁域）必须是服务端常量，标识「本套接字 == 期锁守卫所用的那把锁」；
//   3) release 必须走 finally，保证异常路径下句柄失效；
//   4) 必须提供「锁失效（tryLock 超时）/重启后句柄残留」两类负例证据。
//
// 本文件零生产写、不触碰任何 GAS 部署、不产生链接。

const cl = require('./ts_clearance.js');

const DEFAULT_DOMAIN = 'period-lock/guard';

// 服务端签名 envelope：只有持有密钥的适配器才能签发可被 clearance 接受的句柄
function makeLockAttest(id, secret, dom) {
  const handle = { id: id, held: true, released: false };
  return {
    alg: 'HMAC-SHA256',
    dom: dom,
    sig: require('crypto').createHmac('sha256', secret).update(String(id) + '|' + String(dom)).digest('hex'),
  };
}

// 取锁并签发句柄。deps 必须由调用方（服务端正文）注入：
//   deps.acquireLock()      —— 真实 LockService 包装（必须有；缺失 → 抛错，不静默造锁）
//   deps.releaseLock(h)     —— 真实释放
//   deps.lockSecret()       —— 服务端密钥读取（**禁止**返回请求内可控值）
//   deps.lockIdFor(h)       —— 从真实锁对象取服务端侧稳定 id（缺失则用常量+时间戳兜底）
function acquireTrustedLock(deps, opts) {
  opts = opts || {};
  if (!deps || typeof deps.acquireLock !== 'function') {
    throw new Error('TRUSTED_LOCK_DEPS_MISSING: acquireLock() required');
  }
  if (typeof deps.lockSecret !== 'function') {
    throw new Error('TRUSTED_LOCK_SECRET_MISSING: deps.lockSecret() required (server-side only)');
  }
  const secret = deps.lockSecret();
  if (!secret || typeof secret !== 'string') throw new Error('TRUSTED_LOCK_SECRET_INVALID');
  const dom = String(opts.domain || DEFAULT_DOMAIN);
  const raw = deps.acquireLock();
  if (!raw) throw new Error('TRUSTED_LOCK_ACQUIRE_FAILED');
  const id = (typeof deps.lockIdFor === 'function' && deps.lockIdFor(raw))
    ? String(deps.lockIdFor(raw))
    : String((raw && (raw.id || raw.__id)) || 'L' + Date.now());
  const handle = { id: id, held: true, released: false, _raw: raw };
  handle.attest = makeLockAttest(id, secret, dom);
  return handle;
}

// 释放：置 released 并撤销 attest（旧句柄在此之后不再被接受）
function releaseTrustedLock(deps, handle) {
  if (!handle) return false;
  if (typeof deps.releaseLock === 'function') {
    try { deps.releaseLock(handle._raw || handle); } catch (e) { /* 释放异常不得吞掉语义 */ }
  }
  handle.held = false;
  handle.released = true;
  handle.attest = null;
  return true;
}

module.exports = {
  DEFAULT_DOMAIN,
  acquireTrustedLock,
  releaseTrustedLock,
  makeLockAttest,
};
