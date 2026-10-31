#!/usr/bin/env node
'use strict';
//
// 受信锁适配器（回应 Tom 2101 #2 + Tom 2026-10-30 18:21:56Z 第十三轮 #2）
//
// Tom 2101 #2 原文问题：
//   「held/id/released 是调用方可构造的普通对象，不能证明锁真实持有、与期锁同域或跨进程串行；
//     lockId 还是可选。该契约仅适合模拟，须实际服务端受信锁适配器持锁验证。」
//
// Tom 第十三轮 #2 原文问题（本轮新增，逐条对应下方 甲/乙/丙）：
//   甲）「释放异常被 catch 吞掉，却仍标记 released 并返回 true；不能声称成功释放。
//        请保留失败/UNKNOWN、阻断后续操作并记录，不得靠本地句柄变更证明平台锁状态；
//        对取锁后签发异常也须 finally 释放并核验。」
//   乙）「签名仅证明持密钥者签过 id/domain，复制或重启后的旧签名不能证明当前持锁。」
//   丙）「需受信服务端实际锁域、生命周期与失效机制及 tryLock 超时/并发/重启负例独立核证，
//        不能以 Node 模拟或自造句柄替代。」
//
// 【本文件做什么】
//   甲 -> releaseTrustedLock() 返回结构化三态 {ok, state: RELEASED|RELEASE_FAILED|RELEASE_UNKNOWN, detail}；
//        只有平台侧明确成功才算 RELEASED；失败/未知【不】把 handle.released 置 true，
//        并立刻把登记表状态改成非 HELD -> 后续任何 clearance 校验必然被拒（阻断后续操作）。
//        acquireTrustedLock() 在【取锁之后、签发异常】时也必须释放并核验。
//   乙 -> attestation 加入 epoch（单调序号），并由【服务端登记表】记录当前持锁状态；
//        校验因此变成「验签 且 登记表显示 HELD 且 epoch 一致」三项合取，
//        复制出来的旧句柄、或进程重启后登记表为空时的旧签名，都无法再被接受。
//   丙 -> 提供 tryLock(waitMs) 超时路径：超时不留句柄 -> TRUSTED_LOCK_TIMEOUT。
//
// 【本文件不做什么】（务必看清，不得夸大）
//   不证明 GAS LockService 的真实互斥范围（官方说明：仅同一脚本项目内的并发执行，
//      不提供跨项目/跨文档/跨用户互斥）；
//   不证明跨进程/重启后的锁状态持续性 —— 登记表是【进程内 Map】，重启即空
//      （这正是上面乙要防的场景，也正说明本机实现不能替代服务端持久互斥域）；
//   生产落地仍缺：ScriptProperty 服务端只读 domain、真实 LockService 适配器、
//      tryLock 超时/并发/重启三类【真实环境】负例。列为 Stage-1 未完成项，验收前不得声称已完成。
//
// 本文件零生产写、不触碰任何 GAS 部署、不产生链接。

const crypto = require('crypto');

const PROTOTYPE_ONLY = true;
const DEFAULT_DOMAIN = 'period-lock/guard';
const DEFAULT_WAIT_MS = 0; // 0 = 由平台决定（GAS tryLock 默认阻塞）

// 释放三态常量（Tom 第十三轮 #2 甲）：只有 RELEASED 允许继续；其余一律阻断后续操作。
const RELEASE_STATES = {
  RELEASED: 'RELEASED',
  RELEASE_FAILED: 'RELEASE_FAILED',
  RELEASE_UNKNOWN: 'RELEASE_UNKNOWN',
};

// ============================================================================
// 服务端锁登记表（乙：签名之外还必须有「当前是否真的持锁」的服务端事实）
//   键  : `${dom}::${id}`
//   记录: { id, domain, state:'HELD'|'RELEASED'|'RELEASE_UNKNOWN_PENDING_ADMIN',
//           epoch, acquiredAt, releasedAt, releaseDetail }
//   诚实标注：**进程内 Map**。真实生产必须由服务端持久互斥域提供等价事实，
//   本机 Map 只用于把「登记 + epoch + 失效」这套校验逻辑跑通并可被负例覆盖。
// ============================================================================
const _registry = new Map();
let _epochSeq = 0;

function _regKey(id, dom) { return String(dom) + '::' + String(id); }

function _sign(secret, id, dom, epoch) {
  return crypto.createHmac('sha256', secret)
    .update(String(id) + '|' + String(dom) + '|' + String(epoch)).digest('hex');
}

// 供 admin/测试查看登记表当前内容（只读快照，不含密钥）
function registrySnapshot() {
  const out = [];
  _registry.forEach(function (v, k) {
    out.push({ key: k, id: v.id, domain: v.domain, state: v.state, epoch: v.epoch,
      acquiredAt: v.acquiredAt, releasedAt: v.releasedAt || null, releaseDetail: v.releaseDetail || null });
  });
  return out;
}
// 仅测试用：清空登记表（模拟「进程重启 -> 登记表为空」这一 Tom 指出的场景）
function _resetRegistry() { _registry.clear(); _epochSeq = 0; }

// 校验器：交给 clearance 作为 ctx.lockVerify 使用。
//   返回 {held:true, epoch, acquiredAt} 或 {held:false, reason}
function makeRegistryVerifier() {
  return function verify(id, dom, epoch) {
    if (!id || !dom) return { held: false, reason: 'LOCK_IDENTITY_MISSING' };
    const rec = _registry.get(_regKey(id, dom));
    if (!rec) return { held: false, reason: 'LOCK_NOT_REGISTERED' };
    if (rec.state !== 'HELD') {
      // 已释放（RELEASED）或未知待裁定（RELEASE_UNKNOWN_PENDING_ADMIN）一律不许继续
      return { held: false, reason: rec.state === 'RELEASED' ? 'LOCK_RELEASED' : 'LOCK_STATE_' + rec.state };
    }
    if (String(rec.epoch) !== String(epoch)) return { held: false, reason: 'LOCK_EPOCH_MISMATCH' };
    return { held: true, epoch: rec.epoch, acquiredAt: rec.acquiredAt };
  };
}

// ============================================================================
// 取锁并签发句柄
//   deps.acquireLock()   —— 真实 LockService 包装（必须有；缺失 -> 抛错）
//   deps.tryLock(ms)     —— 可选；存在则优先使用以支持超时语义（丙）
//   deps.releaseLock(h)  —— 真实释放（缺失 => 释放结果只能记 RELEASE_UNKNOWN）
//   deps.lockSecret()    —— 服务端密钥读取（禁止请求内可控值）
//   deps.lockIdFor(h)    —— 从真实锁对象取服务端稳定 id
// ============================================================================
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
  const waitMs = opts.waitMs != null ? opts.waitMs : DEFAULT_WAIT_MS;

  // 丙：tryLock 超时路径 —— 超时 => 【不留句柄】并抛错，调用方不得降级继续。
  let raw;
  if (typeof deps.tryLock === 'function') {
    raw = deps.tryLock(waitMs);
    if (!raw) {
      const te = new Error('TRUSTED_LOCK_TIMEOUT');
      te.code = 'TRUSTED_LOCK_TIMEOUT';
      te.detail = { domain: dom, waitMs: waitMs };
      throw te;
    }
  } else {
    raw = deps.acquireLock(); // 此时尚未取到锁，平台抛错直接向上抛
  }
  if (!raw) throw new Error('TRUSTED_LOCK_ACQUIRE_FAILED');

  const id = (typeof deps.lockIdFor === 'function' && deps.lockIdFor(raw))
    ? String(deps.lockIdFor(raw))
    : String((raw && (raw.id || raw.__id)) || 'L' + Date.now());

  let handle = null;
  let epoch = null;
  try {
    _epochSeq += 1;
    epoch = _epochSeq;
    _registry.set(_regKey(id, dom), {
      id: id, domain: dom, state: 'HELD', epoch: epoch,
      acquiredAt: (opts.now != null ? opts.now : Date.now()), releasedAt: null, releaseDetail: null,
    });
    handle = {
      id: id, held: true, released: false,
      releaseState: 'HELD',        // 本句柄自身的释放证明状态；仅 'RELEASED' 可声称成功
      _raw: raw, _attestDom: dom,
    };
    handle.attest = {
      alg: 'HMAC-SHA256',
      dom: dom,
      epoch: epoch,                // 乙：epoch 参与签名 => 旧 epoch 的复制签名与新登记不符
      sig: _sign(secret, id, dom, epoch),
    };
    return handle;
  } catch (e) {
    // 甲：取锁成功但签发异常 => 必须释放平台锁并【核验释放结果】，不得静默留锁。
    let releaseInfo = null;
    try {
      releaseInfo = releaseTrustedLock(deps, handle || { id: id, _attestDom: dom, releaseState: 'HELD' });
    } catch (re) {
      releaseInfo = { ok: false, state: RELEASE_STATES.RELEASE_UNKNOWN, detail: String(re && re.message || re) };
    }
    if (id) _registry.delete(_regKey(id, dom));
    const err = new Error('TRUSTED_LOCK_ATTEST_FAILED: ' + String(e && e.message || e));
    err.code = 'TRUSTED_LOCK_ATTEST_FAILED';
    err.detail = { release: releaseInfo };
    throw err;
  }
}

// ============================================================================
// 释放（甲）：三态诚实返回 + 失败即阻断
//   返回 {ok, state, detail, handleId}
//   · ok=true 仅当平台侧明确释放成功（RELEASED）
//   · 任何失败/未知 => handle.released 保持 false、releaseState='UNKNOWN'，
//     登记表改为 RELEASE_UNKNOWN_PENDING_ADMIN => 后续 clearance 必被拒（阻断后续操作并记录）
// ============================================================================
function releaseTrustedLock(deps, handle) {
  const out = {
    ok: false,
    state: RELEASE_STATES.RELEASE_UNKNOWN,
    detail: null,
    handleId: (handle && handle.id) || null,
  };
  if (!handle) { out.detail = 'NO_HANDLE'; return out; }
  const dom = handle._attestDom || (handle.attest && handle.attest.dom) || DEFAULT_DOMAIN;

  if (!deps || typeof deps.releaseLock !== 'function') {
    out.state = RELEASE_STATES.RELEASE_UNKNOWN;
    out.detail = 'MISSING_RELEASE_DEP';
  } else {
    let threw = null, ret;
    try {
      ret = deps.releaseLock(handle._raw || handle);
    } catch (e) {
      threw = String(e && e.message || e);
    }
    if (threw !== null) {
      out.state = RELEASE_STATES.RELEASE_FAILED;
      out.detail = 'RELEASE_THREW: ' + threw;
    } else if (ret === false) {
      out.state = RELEASE_STATES.RELEASE_FAILED;
      out.detail = 'PLATFORM_RELEASE_RETURNED_FALSE';
    } else if (ret === true) {
      out.state = RELEASE_STATES.RELEASED;
    } else {
      // undefined / null / 其它未知返回 —— 不得当作成功（甲：禁止靠返回值猜测）
      out.state = RELEASE_STATES.RELEASE_UNKNOWN;
      out.detail = 'PLATFORM_RELEASE_UNKNOWN_RESULT: ' + JSON.stringify(ret === undefined ? 'undefined' : ret);
    }
  }

  const rec = _registry.get(_regKey(handle.id, dom));
  if (out.state === RELEASE_STATES.RELEASED) {
    out.ok = true;
    handle.held = false;
    handle.released = true;
    handle.releaseState = RELEASE_STATES.RELEASED;
    handle.attest = null;   // 释放即失效：防止「释放后的旧句柄」被重放
    handle._raw = null;
    if (rec) { rec.state = 'RELEASED'; rec.releasedAt = Date.now(); }
  } else {
    // 【关键】不把 released 置 true；本地句柄变更不证明平台锁状态（甲）
    handle.releaseState = 'UNKNOWN';
    handle.released = false;
    if (rec) {
      rec.state = 'RELEASE_UNKNOWN_PENDING_ADMIN';
      rec.releaseDetail = out.detail;
    }
  }
  return out;
}

// 是否【已取得平台侧释放证明】（供调用方在继续任何敏感操作前断言）
function isReleaseProven(handle) {
  return !!(handle && handle.releaseState === RELEASE_STATES.RELEASED);
}

module.exports = {
  PROTOTYPE_ONLY,
  DEFAULT_DOMAIN,
  RELEASE_STATES,
  acquireTrustedLock,
  releaseTrustedLock,
  makeLockAttest: function (id, secret, dom, epoch) {
    return { alg: 'HMAC-SHA256', dom: dom, epoch: epoch, sig: _sign(secret, id, dom, epoch) };
  },
  makeRegistryVerifier,
  registrySnapshot,
  _resetRegistry,
  isReleaseProven,
  _sign: _sign,
};
