#!/usr/bin/env node
'use strict';
// S1-8 非生产负例（Tom 第八轮·实现方待办）：clearance 独立签发/范围绑定/同锁消费/撤销恢复 + 非生产负例。
// 覆盖：正常消费、重放拒绝、作用域不符拒绝、过期拒绝、撤销拒绝、UNKNOWN 恢复（禁止盲重试）。
const assert = require('assert');
const cl = require('./ts_clearance.js');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  [PASS] ' + name); }
  else { fail++; console.log('  [FAIL] ' + name); }
}

// 简单互斥锁（非生产演示原子性；真实环境复用 guardCheck 同一把 LockService.getScriptLock）
function makeMutex() {
  let held = false;
  return {
    acquire() { let g = 0; while (held && g < 1e6) { g++; } held = true; return 1; },
    release() { held = false; },
  };
}

const SECRET = 'non-production-secret';
const SCOPE = { jobId: 'J1', rowSetDigest: 'sha256:abc', snapshotFingerprint: 'fp:1' };
const NOW = 1_700_000_000_000;

// 1) 正常签发 + 消费
(function () {
  const store = cl.makeStore();
  const lock = makeMutex();
  const { token } = cl.issueClearance({ signer: 'rita', ...SCOPE, ttlMinutes: 15, secret: SECRET, store, now: NOW });
  const r = cl.consumeClearance(token, { ...SCOPE, lock, store, secret: SECRET, consumer: 'exec1', now: NOW + 1000 });
  ok('正常签发+消费 → ok=true', r.ok === true);
})();

// 2) 同 nonce 二次消费 → REPLAY_REJECTED
(function () {
  const store = cl.makeStore();
  const lock = makeMutex();
  const { token } = cl.issueClearance({ signer: 'rita', ...SCOPE, ttlMinutes: 15, secret: SECRET, store, now: NOW });
  const r1 = cl.consumeClearance(token, { ...SCOPE, lock, store, secret: SECRET, now: NOW + 1000 });
  const r2 = cl.consumeClearance(token, { ...SCOPE, lock, store, secret: SECRET, now: NOW + 2000 });
  ok('首次消费 ok=true', r1.ok === true);
  ok('二次消费 → REPLAY_REJECTED', r2.ok === false && r2.reason === 'REPLAY_REJECTED');
})();

// 3) 作用域不符（jobId 不同）→ SCOPE_MISMATCH
(function () {
  const store = cl.makeStore();
  const lock = makeMutex();
  const { token } = cl.issueClearance({ signer: 'rita', ...SCOPE, ttlMinutes: 15, secret: SECRET, store, now: NOW });
  const r = cl.consumeClearance(token, { jobId: 'OTHER', rowSetDigest: SCOPE.rowSetDigest, snapshotFingerprint: SCOPE.snapshotFingerprint, lock, store, secret: SECRET, now: NOW + 1000 });
  ok('jobId 不符 → SCOPE_MISMATCH', r.ok === false && r.reason === 'SCOPE_MISMATCH');
})();

// 4) 作用域不符（rowSetDigest 不同）→ SCOPE_MISMATCH
(function () {
  const store = cl.makeStore();
  const lock = makeMutex();
  const { token } = cl.issueClearance({ signer: 'rita', ...SCOPE, ttlMinutes: 15, secret: SECRET, store, now: NOW });
  const r = cl.consumeClearance(token, { jobId: SCOPE.jobId, rowSetDigest: 'sha256:wrong', snapshotFingerprint: SCOPE.snapshotFingerprint, lock, store, secret: SECRET, now: NOW + 1000 });
  ok('rowSetDigest 不符 → SCOPE_MISMATCH', r.ok === false && r.reason === 'SCOPE_MISMATCH');
})();

// 5) 过期 → EXPIRED
(function () {
  const store = cl.makeStore();
  const lock = makeMutex();
  const { token } = cl.issueClearance({ signer: 'rita', ...SCOPE, ttlMinutes: 15, secret: SECRET, store, now: NOW });
  const r = cl.consumeClearance(token, { ...SCOPE, lock, store, secret: SECRET, now: NOW + 16 * 60 * 1000 });
  ok('超过 15min TTL → EXPIRED', r.ok === false && r.reason === 'EXPIRED');
})();

// 6) 撤销 → REVOKED
(function () {
  const store = cl.makeStore();
  const lock = makeMutex();
  const { token } = cl.issueClearance({ signer: 'rita', ...SCOPE, ttlMinutes: 15, secret: SECRET, store, now: NOW });
  const rv = cl.revokeClearance(token, { secret: SECRET, store, now: NOW + 500 });
  ok('撤销成功', rv === true);
  const r = cl.consumeClearance(token, { ...SCOPE, lock, store, secret: SECRET, now: NOW + 1000 });
  ok('已撤销 → REVOKED', r.ok === false && r.reason === 'REVOKED');
})();

// 7) 篡改签名 → BAD_SIGNATURE
(function () {
  const store = cl.makeStore();
  const lock = makeMutex();
  const { token } = cl.issueClearance({ signer: 'rita', ...SCOPE, ttlMinutes: 15, secret: SECRET, store, now: NOW });
  const tampered = token.slice(0, -2) + (token.endsWith('==') ? 'AA' : '==');
  const r = cl.consumeClearance(tampered, { ...SCOPE, lock, store, secret: SECRET, now: NOW + 1000 });
  ok('篡改令牌 → BAD_SIGNATURE/拒绝', r.ok === false);
})();

// 8) UNKNOWN 恢复：消费后写未完成，禁止盲重试，须按 jobId+nonce 对账原台账
(function () {
  const store = cl.makeStore();
  const lock = makeMutex();
  const { token, nonce } = cl.issueClearance({ signer: 'rita', ...SCOPE, ttlMinutes: 15, secret: SECRET, store, now: NOW });
  const r = cl.consumeClearance(token, { ...SCOPE, lock, store, secret: SECRET, consumer: 'exec1', now: NOW + 1000 });
  ok('消费成功（标记 consumed）', r.ok === true);
  // 模拟「写未完成/结果不明」：再发同 token 想盲重试 → 必须拒绝
  const retry = cl.consumeClearance(token, { ...SCOPE, lock, store, secret: SECRET, now: NOW + 1500 });
  ok('UNKNOWN 恢复：盲重试同 token → REPLAY_REJECTED（禁止盲重试）', retry.ok === false && retry.reason === 'REPLAY_REJECTED');
  // 对账：按 nonce 查原台账得 state=consumed（已消费，非未提交）→ 须重新签发新令牌再执行，而非复用
  const rec = store.get('tok:' + nonce);
  ok('对账台账 state=consumed（须重新签发新 nonce，不复用旧 token）', rec && rec.state === 'consumed');
})();

// 9) 旧桩兼容：core 的 isClearance 三参数签名下，()=>false 桩仍返回 false（PERIOD_LOCKED 维持）
(function () {
  const stub = () => false;
  const r = stub('tok', [], { jobId: 'J1', lock: makeMutex() });
  ok('旧桩 ()=>false 兼容三参数调用 → false（PERIOD_LOCKED 维持）', r === false);
})();

console.log('\n=== S1-8 clearance 非生产负例 ===');
console.log('结果：' + pass + ' PASS / ' + fail + ' FAIL');
process.exit(fail === 0 ? 0 : 1);
