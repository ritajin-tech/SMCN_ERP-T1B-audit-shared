#!/usr/bin/env node
'use strict';
//
// S1-8 clearance 真实实现（Tom 第八轮·实现方待办）+ 非生产负例支撑。
//
// 设计依据：contract/clearance_and_baseread_design.md §1.5.1–§1.5.5
//   · 独立签发：令牌由 signer（业务 owner 经独立身份通道）签发，HMAC 签名，绝不写死在公开代码。
//   · 作用域绑定：token.jobId === req.jobId 且 token.rowSetDigest === sha256(规范排序目标行集)
//                 且 token.snapshotFingerprint === 本次读取守卫指纹；任一不符即 CLEARANCE_REJECTED。
//   · 同锁原子消费：nonce 的「读-校验-标记消费」在 ctx.lock（与 core guardCheck 同一把锁）区间内原子完成；
//                  同 nonce/jobId 二次请求 → REPLAY_REJECTED，杜绝并发重放。
//   · 撤销/重放台账：issued/consumed/revoked 三态；消费落消费时间戳+消费者身份。
//   · 异常恢复：nonce 已消费但写未完成 → 进入 UNKNOWN，禁止盲重试；须按 jobId+nonce 对账原台账判定。
//
// ⚠️ 非生产实现：台账用内存 Map（模拟 GAS PropertiesService），密钥用注入 secret。
//    真实 GAS 部署须将 _store / secret 换成 PropertiesService + 独立身份密钥（部署前步骤，当前 GO-S4 NO-GO）。
//   本文件零生产写、不激活任何 clearance 令牌（仅提供函数，由调用方注入 deps.isClearance）。

const crypto = require('crypto');

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
let _defaultSecret = process.env.TS_CLEARANCE_TEST_SECRET || 'test-secret-non-production';

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

// ---- 签发 ----
function issueClearance(opts) {
  const store = opts.store || _defaultStore;
  const secret = opts.secret || _defaultSecret;
  const now = opts.now != null ? opts.now : Date.now();
  const ttl = (opts.ttlMinutes || 15) * 60 * 1000;
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
  return { token, nonce, issuedAt: now, ttl };
}

// ---- 消费（同锁原子）----
// ctx: { jobId, rowSetDigest, snapshotFingerprint, lock, store, secret, consumer, now }
function consumeClearance(token, ctx) {
  const store = ctx.store || _defaultStore;
  const secret = ctx.secret || _defaultSecret;
  const now = ctx.now != null ? ctx.now : Date.now();
  let tok;
  try {
    tok = JSON.parse(Buffer.from(String(token), 'base64').toString('utf8'));
  } catch (e) {
    return { ok: false, reason: 'MALFORMED' };
  }
  if (!tok || !tok.sig || !tok.nonce) return { ok: false, reason: 'MALFORMED' };
  // 验签
  if (_sign(tok, secret) !== tok.sig) return { ok: false, reason: 'BAD_SIGNATURE' };
  // 作用域校验
  if (!_scopeEqual(tok, { jobId: ctx.jobId, rowSetDigest: ctx.rowSetDigest, snapshotFingerprint: ctx.snapshotFingerprint })) {
    return { ok: false, reason: 'SCOPE_MISMATCH' };
  }
  // 过期校验
  if (now > tok.issuedAt + tok.ttl) return { ok: false, reason: 'EXPIRED' };

  const key = 'tok:' + tok.nonce;
  const acquire = ctx.lock ? ctx.lock.acquire : (() => ({}));
  const release = ctx.lock ? ctx.lock.release : (() => {});
  const handle = acquire();
  try {
    const rec = store.get(key);
    if (!rec) return { ok: false, reason: 'UNKNOWN_TOKEN' };
    if (rec.revokedAt) return { ok: false, reason: 'REVOKED' };
    if (rec.state === 'consumed') return { ok: false, reason: 'REPLAY_REJECTED' }; // 同 nonce 二次 → 拒绝
    // 标记消费（原子区间结束）
    rec.state = 'consumed';
    rec.consumedAt = now;
    rec.consumer = ctx.consumer || 'unknown';
    store.set(key, rec);
    return { ok: true, nonce: tok.nonce, jobId: tok.jobId };
  } finally {
    release(handle);
  }
}

// ---- 撤销 ----
function revokeClearance(token, opts) {
  const store = (opts && opts.store) || _defaultStore;
  const secret = (opts && opts.secret) || _defaultSecret;
  let tok;
  try { tok = JSON.parse(Buffer.from(String(token), 'base64').toString('utf8')); } catch (e) { return false; }
  if (!tok || !tok.nonce || _sign(tok, secret) !== tok.sig) return false;
  const rec = store.get('tok:' + tok.nonce);
  if (!rec) return false;
  rec.revokedAt = (opts && opts.now) || Date.now();
  store.set('tok:' + tok.nonce, rec);
  return true;
}

module.exports = {
  issueClearance,
  consumeClearance,
  revokeClearance,
  makeStore,
  _sign,
  _setDefaultSecret: (s) => { _defaultSecret = s; },
};
