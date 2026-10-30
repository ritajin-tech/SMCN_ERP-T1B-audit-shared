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
// TTL 上限（Tom 第十轮 #4：ttlMinutes 未见上限校验）
const MAX_TTL_MINUTES = 60;
const DEFAULT_TTL_MINUTES = 15;

// ---- 本地台账（测试间隔离；模拟 PropertiesService 三态账本）----
function makeStore() {
  const m = new Map(); // key('tok:'+nonce) -> record
  return {
    get: (k) => (m.has(k) ? m.get(k) : null),
    set: (k, v) => m.set(k, v),
    _raw: m,
  };
}

const _defaultStore = makeStore();
const _TEST_SECRET = 'test-secret-non-production';
let _injectedSecret = null;

function _resolveSecret(secret) {
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

function _sign(tok, secret) {
  const p = [
    tok.signer, tok.jobId, tok.rowSetDigest, tok.snapshotFingerprint,
    String(tok.issuedAt), String(tok.ttl), tok.nonce,
  ].join('|');
  return _hmac(secret, p);
}

function _scopeEqual(a, b) {
  return a && b && a.jobId === b.jobId &&
    a.rowSetDigest === b.rowSetDigest && a.snapshotFingerprint === b.snapshotFingerprint;
}

// ---- 锁所有权校验（Tom 第十轮 #3，返回 null 表示通过）----
// 契约：ctx.lock 必须是【调用方已持有】的句柄 { id, held:true, released:false }。
//   禁止传入「锁工厂」（带 acquire 方法的对象）—— 那意味着调用方并未持锁，
//   本模块若代为 acquire 既无法证明与 guardCheck 同锁，又会引入重入。
function _lockError(ctx) {
  const lock = ctx && ctx.lock;
  if (!lock || typeof lock !== 'object') return 'LOCK_MISSING';
  if (typeof lock.acquire === 'function') return 'LOCK_NOT_HELD'; // 传了工厂而非句柄
  if (lock.held !== true) return 'LOCK_NOT_HELD';
  if (lock.released === true) return 'LOCK_RELEASED';
  if (ctx.lockId != null && ctx.lockId !== lock.id) return 'LOCK_ID_MISMATCH';
  return null;
}

// 测试用：构造一个「已持有」的锁句柄（模拟 LockService.getScriptLock() 已 acquire 的状态）
function makeHeldLock(id) {
  return { id: id || 'HELD_LOCK_1', held: true, released: false };
}

// ---- 签发 ----
function issueClearance(opts) {
  opts = opts || {};
  const store = opts.store || _defaultStore;
  const secret = _resolveSecret(opts.secret);
  if (!secret) return { ok: false, reason: 'MISSING_SECRET' };
  const now = opts.now != null ? opts.now : Date.now();
  const ttlMinutes = opts.ttlMinutes != null ? opts.ttlMinutes : DEFAULT_TTL_MINUTES;
  // Tom 第十轮 #4：TTL 必须有上限，避免签发长期有效的授权窗口
  if (!(ttlMinutes > 0) || ttlMinutes > MAX_TTL_MINUTES) {
    return { ok: false, reason: 'TTL_EXCEEDS_CAP', maxMinutes: MAX_TTL_MINUTES, got: ttlMinutes };
  }
  if (!opts.signer) return { ok: false, reason: 'MISSING_SIGNER' };
  const ttl = ttlMinutes * 60 * 1000;
  const nonce = crypto.randomBytes(16).toString('hex');
  const tok = {
    signer: opts.signer,
    jobId: opts.jobId,
    rowSetDigest: opts.rowSetDigest,
    snapshotFingerprint: opts.snapshotFingerprint,
    issuedAt: now,
    ttl: ttl,
    nonce: nonce,
  };
  tok.sig = _sign(tok, secret);
  const token = Buffer.from(JSON.stringify(tok)).toString('base64');
  store.set('tok:' + nonce, {
    state: 'issued',
    issuedAt: now,
    ttl: ttl,
    signer: opts.signer,
    scope: {
      jobId: opts.jobId,
      rowSetDigest: opts.rowSetDigest,
      snapshotFingerprint: opts.snapshotFingerprint,
    },
    consumedAt: null,
    consumer: null,
    revokedAt: null,
  });
  return { ok: true, token, nonce, issuedAt: now, ttl };
}

// ---- 消费（Tom 第十轮 #1 严格布尔契约：一律返回 {ok, reason}，绝不返回裸布尔或裸对象）----
// ctx 必填：{ jobId, rowSetDigest, snapshotFingerprint, lock, lockId?, store?, secret?, consumer?, now? }
function consumeClearance(token, ctx) {
  ctx = ctx || {};
  const store = ctx.store || _defaultStore;
  const secret = _resolveSecret(ctx.secret);
  if (!secret) return { ok: false, reason: 'MISSING_SECRET' };
  const now = ctx.now != null ? ctx.now : Date.now();

  // 锁所有权（先于一切账本操作）
  const le = _lockError(ctx);
  if (le) return { ok: false, reason: le };

  let tok;
  try {
    tok = JSON.parse(Buffer.from(String(token), 'base64').toString('utf8'));
  } catch (e) {
    return { ok: false, reason: 'MALFORMED' };
  }
  if (!tok || !tok.sig || !tok.nonce) return { ok: false, reason: 'MALFORMED' };
  if (_sign(tok, secret) !== tok.sig) return { ok: false, reason: 'BAD_SIGNATURE' };

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
  rec.state = 'consumed';
  rec.consumedAt = now;
  rec.consumer = ctx.consumer || 'unknown';
  store.set(key, rec);
  return { ok: true, nonce: tok.nonce, jobId: tok.jobId };
}

// ---- 撤销（Tom 第十轮 #3：与消费同锁串行；返回结构化结果）----
function revokeClearance(token, opts) {
  opts = opts || {};
  const store = opts.store || _defaultStore;
  const secret = _resolveSecret(opts.secret);
  if (!secret) return { ok: false, reason: 'MISSING_SECRET' };
  const le = _lockError(opts);
  if (le) return { ok: false, reason: le };
  let tok;
  try { tok = JSON.parse(Buffer.from(String(token), 'base64').toString('utf8')); } catch (e) { return { ok: false, reason: 'MALFORMED' }; }
  if (!tok || !tok.nonce) return { ok: false, reason: 'MALFORMED' };
  if (_sign(tok, secret) !== tok.sig) return { ok: false, reason: 'BAD_SIGNATURE' };
  const rec = store.get('tok:' + tok.nonce);
  if (!rec) return { ok: false, reason: 'UNKNOWN_TOKEN' };
  if (rec.state === 'consumed') return { ok: false, reason: 'ALREADY_CONSUMED' };
  if (rec.revokedAt) return { ok: false, reason: 'ALREADY_REVOKED' };
  rec.revokedAt = (opts.now != null ? opts.now : Date.now());
  store.set('tok:' + tok.nonce, rec);
  return { ok: true, nonce: tok.nonce };
}

module.exports = {
  PROTOTYPE_ONLY,
  MAX_TTL_MINUTES,
  DEFAULT_TTL_MINUTES,
  issueClearance,
  consumeClearance,
  revokeClearance,
  makeStore,
  makeHeldLock,
  _sign,
  _lockError,
  _setDefaultSecret: (s) => { _injectedSecret = s; },
};
