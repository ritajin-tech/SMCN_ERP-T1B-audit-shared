#!/usr/bin/env node
'use strict';
//
// S1-8 clearance 原型实现（Tom 第八轮·实现方待办）+ Tom 第十轮缺陷 #1/#3/#4 修正。
//
// ⚠️⚠️ 非生产原型（Tom 第十轮缺陷 #4 明确要求显式标注）：
//   · 台账为【内存 Map】（模拟 GAS PropertiesService）—— 进程重启即丢失，**不构成持久原子账本**；
//   · signer / secret 由调用方注入 —— 无法证明【独立身份】与生产鉴权；
//   · 未实现embedded/FINAL 同步 —— 因此**不得声称端到端闭合或可部署**；
//   · 恢复状态机仅到「拒绝盲重试 + 按 nonce 对账」，未实现 Tom 要求的
//     按原 job/item/request/keeper 的持久对账与完整恢复状态机（列为 Stage-1 未完成项）。
//   本文件零生产写、不激活任何 clearance 令牌（仅提供函数，由调用方注入 deps.isClearance）。
//
// ✳️ Tom 2026-10-30 18:21:56Z 第十三轮追加收紧（对应本文件内标注「Tom 2102 #N」）：
//   #1 形态不等于真实消费 —— 单纯的 {ok:true} 不能替代【账本消费事实】，签发者/nonce/job/batch/
//      作用域必须与 journal 绑定；本模块因此把 signer/kid/jobId/nonce/consumedAt 全部作为返回值
//      交回调用方（core），由 core 在同锁区写入 journal（见 ts_softdel_core.js 的 binding 步骤）。
//   #2 锁句柄：签名之外还须【服务端登记表事实】（ctx.lockVerify），
//      → 处理 Tom 指出「复制或重启后的旧签名不能证明当前持锁」。
//   #3 略（在 core 侧）。
//   #4 密钥版本/轮换/撤销 + 签发与消费必须同互斥域 + 禁止自动重放。
//
// 设计依据：contract/clearance_and_baseread_design.md §1.5.1–§1.5.5
//   · 作用域绑定：token.jobId/rowSetDigest/snapshotFingerprint 三者全等才允许消费；
//     【Tom 第十轮 #3】rowSetDigest / snapshotFingerprint 必须由调用方（core）在锁内
//     从真实受保护批次与真实主库版本派生；本模块**拒绝客户端自报**——缺失即拒绝。
//   · 锁所有权【Tom 第十轮 #3】：本模块**不再自行 acquire**。
//     传入的 ctx.lock 必须是调用方【已持有】的锁句柄；原因：
//       (a) 缺失时用无操作锁 → 无锁消费，原子性形同虚设；
//       (b) 传入锁再 acquire → 无法证明与 guardCheck 是同一把锁，且有重入风险。
//     现在改为：缺锁/非句柄/已释放/id 不匹配 → 一律拒绝（fail-closed）。
//     消费与撤销串行化：两者走同一套所有权校验，配合调用方持有的同一把锁实现串行。

const crypto = require('crypto');

// 非生产原型标记（供调用方/测试断言：不得在生产路径启用）
const PROTOTYPE_ONLY = true;
// TTL 上限（Tom 第十轮 #4：ttlMinutes 未见上限校验；Tom 2101 #4：60 分钟是原型设定，
//   审核方建议 <=15 分钟）。
//   【硬上限，无 env 逃生口】：任何放宽必须改本常量并重新走完整复审/授权，
//   避免"运营态环境变量一改就拉长授权窗口"这类静默绕过。最终值仍归有权方按风险与批次裁定。
const MAX_TTL_MINUTES = 15;
const DEFAULT_TTL_MINUTES = 15;

// ---- 本地台账（测试间隔离；模拟 PropertiesService 三态账本）----
// Tom 2101 #2/#4：原 set() 是"读-改-写"三步，并发下后写覆盖前写 ⇒ 同 nonce 可被重复消费。
//   现台账原生支持 **CAS（compare-and-set）**：只有当前记录仍严格等于 expect 才落 next，
//   否则返回 false ⇒ 调用方报 CONSUME_RACE_REJECTED（fail-closed）。
//   注：Map 的 CAS 只在【单进程】内成立；跨进程/重启的 CAS 必须落到服务端持久账本
//   （见 tools/ts_clearance_filestore.js 的跨进程参考实现，仍非生产）。
function makeStore() {
  const m = new Map(); // key('tok:'+nonce) -> record
  return {
    get: (k) => (m.has(k) ? m.get(k) : null),
    set: (k, v) => m.set(k, v),
    // 严格相等比较：以规范化 JSON 串比对，避免引用相等造成的假同值
    cas: (k, expect, next) => {
      const _canon = (o) => (o == null ? 'null' : JSON.stringify(o, Object.keys(o || {}).sort()));
      const cur = m.has(k) ? m.get(k) : null;
      if (cur === null || expect === null) { if (cur !== expect) return false; }
      else if (_canon(cur) !== _canon(expect)) return false;
      m.set(k, next);
      return true;
    },
    _raw: m,
  };
}

const _defaultStore = makeStore();
const _TEST_SECRET = 'test-secret-non-production';
let _injectedSecret = null;

// ---- 受信签发方 + 密钥版本登记表（Tom 2101 #4 / Tom 2102 #4）----
//   Tom 2101 #4：「signer 字符串不证明独立身份」⇒ 验签密钥必须由 signer id 索引。
//   Tom 2102 #4：「签名者信任配置须由独立管理员在服务端管控身份、密钥版本/轮换/撤销与审计；
//                 不公开密钥」⇒ 进一步要求 **密钥版本（kid）化**：
//     · trustSigner(id, secret, {kid})      —— 登记签发方并登记首个密钥版本；
//     · rotateSignerKey(id, newSecret)      —— 轮换：新增密钥版本，旧版在撤销/过期前仍可验旧令牌；
//     · revokeSignerKey(id, kid)            —— 撤销单个版本（历史上的旧令牌立即失效）；
//     · revokeSigner(id)                    —— 撤销该签发方全部版本（身份被停用）；
//     · _keyStatus(id, kid, now)            —— 单一判定口径：未登记/未知/已撤销/未生效/已过期。
//   形态：signerId -> { keys: Map<kid, {secret, kid, revoked, notBefore, notAfter, createdAt, revokedAt}> }
//   诚实边界：本文件的内存实现仅为原型，**不构成独立身份或生产鉴权证明**；
//   生产路径必须换为服务端受信配置（由独立管理员管控），且不对外暴露密钥。
const _signerRegistry = new Map();

// clearance 签发/消费/撤销必须落在【同一真实互斥域】；域必须从服务端来，不接受请求携带。
const CLEARANCE_LOCK_DOMAIN = 'period-lock/guard';

function _signerEntry(signerId) {
  if (!_signerRegistry.has(signerId)) {
    _signerRegistry.set(signerId, { signerId: signerId, keys: new Map() });
  }
  return _signerRegistry.get(signerId);
}
function _nextKid(entry) { return 'k' + (entry.keys.size + 1); }

function trustSigner(signerId, secret, opts) {
  opts = opts || {};
  if (!signerId || typeof signerId !== 'string') return { ok: false, reason: 'SIGNER_ID_INVALID' };
  if (!secret || typeof secret !== 'string') return { ok: false, reason: 'SIGNER_KEY_INVALID' };
  const entry = _signerEntry(signerId);
  const kid = opts.kid || _nextKid(entry);
  const now = opts.now != null ? opts.now : Date.now();
  entry.keys.set(kid, {
    secret: secret, kid: kid, revoked: false, revokedAt: null,
    notBefore: opts.notBefore != null ? opts.notBefore : now,
    notAfter: opts.notAfter != null ? opts.notAfter : null,
    createdAt: now,
  });
  return { ok: true, signerId: signerId, kid: kid };
}

// 轮换：新增一个密钥版本（旧版本在未被撤销/未过期前仍可验证历史令牌）
function rotateSignerKey(signerId, newSecret, opts) {
  opts = opts || {};
  if (!_signerRegistry.has(signerId)) return { ok: false, reason: 'SIGNER_NOT_TRUSTED', signer: String(signerId) };
  if (!newSecret || typeof newSecret !== 'string') return { ok: false, reason: 'SIGNER_KEY_INVALID' };
  const entry = _signerRegistry.get(signerId);
  return trustSigner(signerId, newSecret, opts);
}

// 撤销单个密钥版本；kid 省略 => 撤销该签发方全部版本
function revokeSignerKey(signerId, kid, opts) {
  opts = opts || {};
  if (!_signerRegistry.has(signerId)) return { ok: false, reason: 'SIGNER_NOT_TRUSTED', signer: String(signerId) };
  const entry = _signerRegistry.get(signerId);
  const now = opts.now != null ? opts.now : Date.now();
  const targets = kid ? [kid] : Array.from(entry.keys.keys());
  let n = 0;
  targets.forEach(function (k) {
    const rec = entry.keys.get(k);
    if (rec && !rec.revoked) { rec.revoked = true; rec.revokedAt = now; n++; }
  });
  return { ok: true, signerId: signerId, revokedCount: n };
}
function revokeSigner(signerId, opts) { return revokeSignerKey(signerId, null, opts || {}); }

function activeSignerKeys(signerId) {
  if (!_signerRegistry.has(signerId)) return [];
  const entry = _signerRegistry.get(signerId);
  const out = [];
  entry.keys.forEach(function (v, k) {
    out.push({ kid: k, revoked: !!v.revoked, notBefore: v.notBefore, notAfter: v.notAfter, revokedAt: v.revokedAt });
  });
  return out;
}
function clearTrustedSigners() { _signerRegistry.clear(); }
function trustedSignerIds() { return Array.from(_signerRegistry.keys()); }

// 单一判定口径（Tom 2102 #4）：返回 {ok:true,key} 或 {ok:false, reason}
function _keyStatus(signerId, kid, now) {
  if (!signerId || typeof signerId !== 'string') return { ok: false, reason: 'SIGNER_ID_INVALID' };
  if (!_signerRegistry.has(signerId)) return { ok: false, reason: 'SIGNER_NOT_TRUSTED', signer: String(signerId) };
  const entry = _signerRegistry.get(signerId);
  const k = entry.keys.get(String(kid || ''));
  if (!k) return { ok: false, reason: 'SIGNER_KEY_UNKNOWN', kid: String(kid || '') };
  if (k.revoked) return { ok: false, reason: 'SIGNER_KEY_REVOKED', kid: k.kid };
  if (k.notBefore != null && now < k.notBefore) return { ok: false, reason: 'SIGNER_KEY_NOT_YET_VALID', kid: k.kid };
  if (k.notAfter != null && now > k.notAfter) return { ok: false, reason: 'SIGNER_KEY_EXPIRED', kid: k.kid };
  return { ok: true, key: k };
}

// 「当前应当用于签发」的密钥版本：取最新且当前有效的那个
function _currentSigningKey(signerId, now) {
  if (!_signerRegistry.has(signerId)) return { ok: false, reason: 'SIGNER_NOT_TRUSTED', signer: String(signerId) };
  const entry = _signerRegistry.get(signerId);
  const kids = Array.from(entry.keys.keys());
  for (let i = kids.length - 1; i >= 0; i--) {
    const st = _keyStatus(signerId, kids[i], now);
    if (st.ok) return st;
  }
  return { ok: false, reason: 'SIGNER_NO_VALID_KEY', signer: String(signerId) };
}

function _resolveSecret(secret, signerId) {
  // 锁句柄 attestation 用的服务端密钥：**仅**来自服务端注入/调用方显式提供，
  // 与签发方密钥表解耦（避免"拿签发密钥去验锁句柄"造成的作用域混淆）。
  if (secret) return secret;
  if (_injectedSecret) return _injectedSecret;
  // Tom 第十轮 #4：默认测试密钥无法证明独立身份/生产鉴权 ——
  //   仅当显式设置 TS_CLEARANCE_ALLOW_TEST_SECRET=1 才允许回退（测试用），否则拒绝。
  if (process.env.TS_CLEARANCE_ALLOW_TEST_SECRET === '1') return _TEST_SECRET;
  return null; // → 由调用方报 MISSING_SECRET
}

function _hmac(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

// Tom 2102 #4：kid（密钥版本）参与签名负载 ⇒ 换版本即换签名空间，
//   防止"拿着旧版本签发的令牌，用新版本的密钥也能验过"这类跨版本复用。
function _sign(tok, secret) {
  const p = [
    tok.signer, String(tok.kid || ''), tok.jobId, tok.rowSetDigest, tok.snapshotFingerprint,
    String(tok.issuedAt), String(tok.ttl), tok.nonce,
  ].join('|');
  return _hmac(secret, p);
}

function _scopeEqual(a, b) {
  return a && b && a.jobId === b.jobId &&
    a.rowSetDigest === b.rowSetDigest && a.snapshotFingerprint === b.snapshotFingerprint;
}

// ---- 锁所有权校验（Tom 第十轮 #3 + Tom 2101 #2，返回 null 表示通过）----
// 契约：ctx.lock 必须是【调用方已持有】的句柄 { id, held:true, released:false, attest }。
//   禁止传入「锁工厂」（带 acquire 方法的对象）—— 那意味着调用方并未持锁，
//   本模块若代为 acquire 既无法证明与 guardCheck 同锁，又会引入重入。
//
// Tom 2101 #2 的具体修正（原缺陷：held/id/released 是调用方可任意构造的普通对象，
//   lockId 还是可选 ⇒ 任何人拼一个 {id, held:true} 都能声称"我持锁"）：
//   (1) ctx.lockId 改为【必填】，且与 lock.id 必须严格相等（原来不传就跳过校验）；
//   (2) lock.id 必须为非空字符串（原来可以是任意非字符串值）；
//   (3) 句柄必须携带服务端【受信锁适配器】签署的 attestation：
//         attest = { alg:'HMAC-SHA256', dom:<锁域>, sig: HMAC(secret, id|dom) }
//       校验不过 → LOCK_ATTEST_MISSING / LOCK_ATTEST_BAD；调用方声明的 ctx.lockDomain
//       必须与 attest.dom 一致 → 否则 LOCK_DOMAIN_MISMATCH（防止把别处的锁句柄当本批次的期锁用）；
//   (4) 诚实边界：签名过也只能证明"持有同一把密钥的适配器签发过它"，
//       **真实服务端 LockService 串行的证明必须由 GAS 适配器落地**（tools/ts_lock_adapter.js 骨架），
//       本原型不声称已完成、不充当生产同锁证据。
//
// Tom 2102 #2 追加收紧（原缺陷：只验签名 ⇒ 复制出来的旧句柄、或重启后登记表为空时的旧签名
//   依然能通过 —— Tom 原文「签名仅证明持密钥者签过 id/domain，
//   复制或重启后的旧签名不能证明当前持锁」）：
//   (5) attestation 必须携带 epoch，且 epoch 参与签名负载；
//   (6) 除验签外，还必须通过 **服务端登记表事实** ctx.lockVerify(id, dom, epoch)：
//         - 未提供 lockVerify ⇒ LOCK_REGISTRY_MISSING（fail-closed，无 env 逃生口）；
//         - 登记表显示非 HELD / epoch 不一致 ⇒ LOCK_NOT_REGISTERED|LOCK_RELEASED|LOCK_EPOCH_MISMATCH。
//       即校验 = 验签 ∧ 登记表 HELD ∧ epoch 一致（三项合取，缺一即拒）。
function _signLockHandle(handle, secret, dom, epoch) {
  return _hmac(secret, String(handle.id) + '|' + String(dom) + '|' + String(epoch == null ? '' : epoch));
}

function _lockError(ctx, secret) {
  const lock = ctx && ctx.lock;
  if (!lock || typeof lock !== 'object') return 'LOCK_MISSING';
  if (typeof lock.acquire === 'function') return 'LOCK_NOT_HELD'; // 传了工厂而非句柄
  if (lock.held !== true) return 'LOCK_NOT_HELD';
  if (lock.released === true) return 'LOCK_RELEASED';
  if (typeof lock.id !== 'string' || !lock.id) return 'LOCK_ID_MISSING';
  // (1) lockId 必填且与句柄一致
  if (!ctx.lockId) return 'LOCK_ID_MISSING';
  if (String(ctx.lockId) !== String(lock.id)) return 'LOCK_ID_MISMATCH';
  // (3) 服务端 attestation 校验
  const at = lock.attest;
  // 无 attestation / 形态不对 ⇒ 一律拒绝。
  //   **刻意不设任何 env 逃生口**（与 TS_CLEARANCE_ALLOW_TEST_SECRET 不同）：
  //   此处一旦可放行，"任何人都能自造持锁凭据"的缺陷就整体回归，故必须无条件 fail-closed。
  if (!at || typeof at !== 'object') return 'LOCK_ATTEST_MISSING';
  if (at.alg !== 'HMAC-SHA256' || !at.dom || typeof at.dom !== 'string') return 'LOCK_ATTEST_BAD';
  // (5) epoch 必填（Tom 2102 #2 乙：无 epoch ⇒ 无法区分"本次持锁"与"历史遗留签名"）
  if (at.epoch === undefined || at.epoch === null || at.epoch === '') return 'LOCK_ATTEST_BAD';
  if (!secret) return 'LOCK_ATTEST_BAD'; // 无密钥则无法验签 ⇒ fail-closed
  const expectSig = _signLockHandle(lock, secret, at.dom, at.epoch);
  if (!at.sig || String(at.sig) !== expectSig) return 'LOCK_ATTEST_BAD';
  // 声明域与实际签名域必须一致
  if (!ctx.lockDomain) return 'LOCK_DOMAIN_MISSING';
  if (String(ctx.lockDomain) !== String(at.dom)) return 'LOCK_DOMAIN_MISMATCH';
  // (6) 服务端登记表事实（Tom 2102 #2）：签名只证明"签过"，必须再查服务端当前持锁状态
  if (typeof ctx.lockVerify !== 'function') return 'LOCK_REGISTRY_MISSING';
  let vf;
  try { vf = ctx.lockVerify(lock.id, at.dom, at.epoch); } catch (e) { vf = null; }
  if (!vf || vf.held !== true) {
    return (vf && vf.reason) ? String(vf.reason) : 'LOCK_NOT_HELD_BY_SERVER';
  }
  return null;
}

// 构造一个【受信适配器签发】的已持有锁句柄（模拟 LockService.getScriptLock() 已 acquire 的状态）
//   · 生产／真实 GAS 路径应由 tools/ts_lock_adapter.js 在 acquire 成功瞬间签发；
//   · opts.epoch 必填：与 ts_lock_adapter 登记表对齐；缺失 ⇒ 句柄不带 epoch ⇒ 校验必拒。
//   · 本函数用于测试与本地复现，仍【不证明】真实服务端串行。
function makeHeldLock(id, opts) {
  opts = opts || {};
  const dom = opts.domain || CLEARANCE_LOCK_DOMAIN;
  const handle = { id: id || 'HELD_LOCK_1', held: true, released: false };
  const secret = opts.secret || _resolveSecret(opts.secret, opts.signerId);
  const epoch = (opts.epoch === undefined || opts.epoch === null) ? 1 : opts.epoch;
  handle._attestDom = dom;
  if (secret) {
    handle.attest = { alg: 'HMAC-SHA256', dom: dom, epoch: epoch, sig: _signLockHandle(handle, secret, dom, epoch) };
  }
  return handle;
}

// ---- 签发 ----
function issueClearance(opts) {
  opts = opts || {};
  const store = opts.store || _defaultStore;
  // 注：签发密钥不再来自 _resolveSecret（已与 signer 登记表解耦），而来自 _currentSigningKey(opts.signer, now)（见下方第 305 行）。
  // 此处【不再】要求传入 opts.secret —— 签发方是受信管理员，密钥由登记表按 kid 版本提供；传入 secret 反而是冗余且会误拒。
  const now = opts.now != null ? opts.now : Date.now();
  const ttlMinutes = opts.ttlMinutes != null ? opts.ttlMinutes : DEFAULT_TTL_MINUTES;
  // Tom 第十轮 #4：TTL 必须有上限，避免签发长期有效的授权窗口
  // Tom 2101 #4：上限由 60 收紧为 15（审核方建议值；最终归有权方按风险与批次裁定）
  if (!(ttlMinutes > 0) || ttlMinutes > MAX_TTL_MINUTES) {
    return { ok: false, reason: 'TTL_EXCEEDS_CAP', maxMinutes: MAX_TTL_MINUTES, got: ttlMinutes };
  }
  if (!opts.signer) return { ok: false, reason: 'MISSING_SIGNER' };
  // Tom 2102 #4：signer 必须是【已登记的受信签发方】且持有**当前有效密钥版本**
  if (!_signerRegistry.has(opts.signer)) {
    return { ok: false, reason: 'SIGNER_NOT_TRUSTED', signer: String(opts.signer) };
  }
  const _ks = _currentSigningKey(opts.signer, now);
  if (!_ks.ok) return { ok: false, reason: _ks.reason, signer: String(opts.signer) };
  const _key = _ks.key;
  // Tom 2102 #4：签发须落在【同一真实互斥域】—— 缺失 lockDomain ⇒ 拒绝（不做无域签发）。
  //   注意：签发方是受信管理员（不持 worker 的 guard 锁），故此处【只校验 lockDomain 已声明并记录】，
  //   真正的「持锁 + 服务端登记表」核验发生在消费/撤销时（见 _lockError 的 lockVerify 三态合取）。
  if (!opts.lockDomain || typeof opts.lockDomain !== 'string') {
    return { ok: false, reason: 'ISSUE_LOCK_DOMAIN_MISSING' };
  }
  const ttl = ttlMinutes * 60 * 1000;
  const nonce = crypto.randomBytes(16).toString('hex');
  const tok = {
    signer: opts.signer,
    kid: _key.kid,
    jobId: opts.jobId,
    rowSetDigest: opts.rowSetDigest,
    snapshotFingerprint: opts.snapshotFingerprint,
    issuedAt: now,
    ttl: ttl,
    nonce: nonce,
  };
  tok.alg = 'HMAC-SHA256';
  tok.ttlMinutes = ttlMinutes;
  tok.sig = _sign(tok, _key.secret);
  const token = Buffer.from(JSON.stringify(tok)).toString('base64');
  store.set('tok:' + nonce, {
    state: 'issued',
    issuedAt: now,
    ttl: ttl,
    signer: opts.signer,
    kid: _key.kid,
    // Tom 2102 #4：记录签发时的互斥域 ⇒ 消费/撤销时必须是同一域
    lockId: String(opts.lockId),
    lockDomain: String(opts.lockDomain || CLEARANCE_LOCK_DOMAIN),
    scope: {
      jobId: opts.jobId,
      rowSetDigest: opts.rowSetDigest,
      snapshotFingerprint: opts.snapshotFingerprint,
    },
    consumedAt: null,
    consumer: null,
    revokedAt: null,
  });
  return { ok: true, token, nonce, kid: _key.kid, signer: opts.signer, issuedAt: now, ttl };
}

// ---- 消费（Tom 第十轮 #1 严格布尔契约：一律返回 {ok, reason}，绝不返回裸布尔或裸对象）----
// ctx 必填：{ jobId, rowSetDigest, snapshotFingerprint, lock, lockId, lockDomain?, store?, secret?, consumer?, now? }
function consumeClearance(token, ctx) {
  ctx = ctx || {};
  const store = ctx.store || _defaultStore;
  // Tom 2101 #2/#4：账本必须提供原子 cas；无 cas ⇒ 读-改-写可被并发覆盖 ⇒ fail-closed
  if (typeof store.cas !== 'function') return { ok: false, reason: 'STORE_NOT_ATOMIC' };
  const secret = _resolveSecret(ctx.secret, null);
  if (!secret) return { ok: false, reason: 'MISSING_SECRET' };
  const now = ctx.now != null ? ctx.now : Date.now();

  // 锁所有权（先于一切账本操作）
  const le = _lockError(ctx, secret);
  if (le) return { ok: false, reason: le };

  let tok;
  try {
    tok = JSON.parse(Buffer.from(String(token), 'base64').toString('utf8'));
  } catch (e) {
    return { ok: false, reason: 'MALFORMED' };
  }
  if (!tok || !tok.sig || !tok.nonce) return { ok: false, reason: 'MALFORMED' };
  // 验签密钥按 (signer, kid) 选取（Tom 2102 #4：版本化的独立验签）
  const ks = _keyStatus(tok.signer, tok.kid, now);
  if (!ks.ok) return { ok: false, reason: ks.reason, signer: String(tok.signer) };
  if (_sign(tok, ks.key.secret) !== tok.sig) return { ok: false, reason: 'BAD_SIGNATURE' };

  // Tom 第十轮 #3：作用域字段缺失/为空 → 拒绝，绝不接受客户端自报后放宽
  if (!ctx.jobId) return { ok: false, reason: 'SCOPE_JOBID_MISSING' };
  if (!ctx.rowSetDigest) return { ok: false, reason: 'SCOPE_DIGEST_MISSING' };
  if (!ctx.snapshotFingerprint) return { ok: false, reason: 'SCOPE_FINGERPRINT_MISSING' };
  if (!_scopeEqual(tok, {
    jobId: ctx.jobId,
    rowSetDigest: ctx.rowSetDigest,
    snapshotFingerprint: ctx.snapshotFingerprint,
  })) return { ok: false, reason: 'SCOPE_MISMATCH' };

  if (now > tok.issuedAt + tok.ttl) return { ok: false, reason: 'EXPIRED' };

  const key = 'tok:' + tok.nonce;
  // 注意：此处【不 acquire】。调用方（core）已持有 ctx.lock，
  // 「读-校验-标记消费」在调用方的锁区间内完成，保证与 guardCheck 同锁串行。
  const rec = store.get(key);
  if (!rec) return { ok: false, reason: 'UNKNOWN_TOKEN' };
  if (rec.revokedAt) return { ok: false, reason: 'REVOKED' };
  if (rec.state === 'consumed') return { ok: false, reason: 'REPLAY_REJECTED' };
  // Tom 2102 #4：签发与消费必须落在【同一真实互斥域】，否则视为跨域挪用的票据
  if (!rec.lockDomain || String(rec.lockDomain) !== String(ctx.lockDomain || '')) {
    return { ok: false, reason: 'LOCK_DOMAIN_MISMATCH', issueDomain: String(rec.lockDomain || null), consumeDomain: String(ctx.lockDomain || null) };
  }
  // Tom 2102 #2：复制/回放已经在别处消费过的记录 ⇒ 即使 hex Approval 也应被拒（此处由 CAS 保障）
  // Tom 2101 #2/#4：**CAS 原子标记**——只有记录仍与刚读到的完全一致才允许落 consumed。
  //   并发/跨进程下第二名必被判 CONSUME_RACE_REJECTED，不再出现"两个消费者都成功"。
  const casOk = store.cas(key, rec, {
    state: 'consumed',
    issuedAt: rec.issuedAt,
    ttl: rec.ttl,
    signer: rec.signer,
    kid: rec.kid || null,
    lockId: rec.lockId || null,
    lockDomain: rec.lockDomain || null,
    scope: rec.scope,
    consumedAt: now,
    consumer: ctx.consumer || 'unknown',
    revokedAt: rec.revokedAt || null,
  });
  if (!casOk) return { ok: false, reason: 'CONSUME_RACE_REJECTED', nonce: tok.nonce };
  // Tom 2102 #1：把【账本真实消费事实】完整回传，供 core 在同锁区写入 journal 绑定：
  //   signer / kid / nonce / jobId / consumedAt —— 缺一即说明"形态过了但账本没消费"。
  return { ok: true, nonce: tok.nonce, jobId: tok.jobId, signer: tok.signer,
    kid: String(tok.kid || ''), consumedAt: now };
}

// ---- 撤销（Tom 第十轮 #3：与消费同锁串行；返回结构化结果）----
function revokeClearance(token, opts) {
  opts = opts || {};
  const store = opts.store || _defaultStore;
  if (typeof store.cas !== 'function') return { ok: false, reason: 'STORE_NOT_ATOMIC' };
  const secret = _resolveSecret(opts.secret, null);
  if (!secret) return { ok: false, reason: 'MISSING_SECRET' };
  const le = _lockError(opts, secret);
  if (le) return { ok: false, reason: le };
  let tok;
  try { tok = JSON.parse(Buffer.from(String(token), 'base64').toString('utf8')); } catch (e) { return { ok: false, reason: 'MALFORMED' }; }
  if (!tok || !tok.nonce) return { ok: false, reason: 'MALFORMED' };
  const rs = _keyStatus(tok.signer, tok.kid, (opts.now != null ? opts.now : Date.now()));
  if (!rs.ok) return { ok: false, reason: rs.reason, signer: String(tok.signer) };
  if (_sign(tok, rs.key.secret) !== tok.sig) return { ok: false, reason: 'BAD_SIGNATURE' };
  const rec = store.get('tok:' + tok.nonce);
  if (!rec) return { ok: false, reason: 'UNKNOWN_TOKEN' };
  if (rec.state === 'consumed') return { ok: false, reason: 'ALREADY_CONSUMED' };
  if (rec.revokedAt) return { ok: false, reason: 'ALREADY_REVOKED' };
  // Tom 2102 #4：撤销同样必须与签发同域
  if (!rec.lockDomain || String(rec.lockDomain) !== String(opts.lockDomain || '')) {
    return { ok: false, reason: 'LOCK_DOMAIN_MISMATCH', issueDomain: String(rec.lockDomain || null), consumeDomain: String(opts.lockDomain || null) };
  }
  const casOk = store.cas('tok:' + tok.nonce, rec, Object.assign({}, rec, {
    revokedAt: (opts.now != null ? opts.now : Date.now()),
  }));
  if (!casOk) return { ok: false, reason: 'REVOKE_RACE_REJECTED', nonce: tok.nonce };
  return { ok: true, nonce: tok.nonce };
}

// ---- UNKNOWN 状态的对账入口（Tom 2101 #4：要求按原 job/item/request/keeper 持久对账与恢复状态机）----
// 语义：本函数【只读 + 零写 + 零自动重试】。它不裁定 job/item/request/keeper 的最终状态，
//   而是把"必须人工裁决的事实"结构化登记出来，交给有权方按底稿/journal 裁决。
//   诚实边界：**状态机本身仍未实现**（Stage-1 未完成项），本函数只提供"不得静默重试"的强制入口。
// Tom 2102 #4 追加：除"判定契约"外，额外登记
//   (a) replayAllowed=false / autoRetry=false —— 明令禁止任何自动重放入口；
//   (b) 每个请求项登记的四个原身份：jobId / itemId / requestHash / uuid / keeperRow；
//   (c) ledgerState —— 该项在账本里的最后已知状态（UNKNOWN 需人工裁决，不得推断）。
// 参数：{ jobId, rows, journalRead(jobId,itemId)->records[] }
// 返回：{ ok:true, requires:[{ jobId, itemId, requestHash, uuid, keeperRow, witness, ledgerState, requires }] }
function reconcileUnknown(ctx) {
  ctx = ctx || {};
  const rows = Array.isArray(ctx.rows) ? ctx.rows : [];
  const jr = ctx.journalRead;
  const requires = [];
  for (let i = 0; i < rows.length; i++) {
    const it = rows[i] || {};
    const itemId = Number(it.row);
    const req = {
      jobId: ctx.jobId == null ? null : String(ctx.jobId),
      itemId: itemId,
      requestHash: it.requestHash == null ? null : String(it.requestHash),
      uuid: String(it.uuid || ''),
      keeperRow: Number(it.keeperRow) || null,
      witness: null,
      ledgerState: 'UNKNOWN',
      requires: 'REQUIRES_ADMIN_ADJUDICATION',
    };
    if (typeof jr === 'function') {
      let recs = null;
      try { recs = jr(ctx.jobId, itemId); } catch (e) { recs = null; }
      if (Array.isArray(recs) && recs.length) {
        req.witness = recs.map((r) => ({
          state: r.state || null, reason: r.reason || null, ts: r.ts || null,
        }));
        const last = recs[recs.length - 1] || {};
        req.ledgerState = last.state ? String(last.state) : 'UNKNOWN';
      }
    }
    requires.push(req);
  }
  return {
    ok: true,
    admit: 'RECOVERY_STATE_MACHINE_NOT_IMPLEMENTED',
    autoRetry: false,
    replayAllowed: false,
    requires: requires,
  };
}

module.exports = {
  PROTOTYPE_ONLY,
  MAX_TTL_MINUTES,
  DEFAULT_TTL_MINUTES,
  CLEARANCE_LOCK_DOMAIN,
  issueClearance,
  consumeClearance,
  revokeClearance,
  reconcileUnknown,
  makeStore,
  makeHeldLock,
  trustSigner,
  rotateSignerKey,
  revokeSignerKey,
  revokeSigner,
  activeSignerKeys,
  clearTrustedSigners,
  trustedSignerIds,
  _keyStatus,
  _currentSigningKey,
  _sign,
  _lockError,
  _setDefaultSecret: (s) => { _injectedSecret = s; },
};
