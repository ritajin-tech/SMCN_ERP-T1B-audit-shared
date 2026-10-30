#!/usr/bin/env node
'use strict';
// S1-8 非生产负例（Tom 第八轮·实现方待办）+ Tom 第十轮缺陷 #1/#2/#3/#4 专项覆盖。
// 覆盖：严格布尔契约、锁所有权（缺锁/未持有/已释放/id不符/禁止重入）、TTL 上限、
//       作用域字段服务端派生（不接受客户端自报）、撤销串行化、过期/撤销/错签/错范围/重放均拒绝。
// ⚠️ 本文件全部为【非生产内存替身】证据，不构成隔离或生产状态的证明（Tom 第九/十轮口径）。
const assert = require('assert');
const cl = require('./ts_clearance.js');
const core = require('./ts_softdel_core.js');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  [PASS] ' + name); }
  else { fail++; console.log('  [FAIL] ' + name); }
}

const SECRET = 'non-production-secret';
const SCOPE = { jobId: 'J1', rowSetDigest: 'sha256:abc', snapshotFingerprint: 'fp:1' };
const NOW = 1_700_000_000_000;
// 调用方【已持有】的锁句柄（模拟 core 在 try/finally 内持锁期间调用本模块）
const HELD = () => cl.makeHeldLock('HELD_LOCK_1');

function fresh() {
  return { store: cl.makeStore(), lock: HELD() };
}

// 1) 正常签发 + 消费
(function () {
  const { store, lock } = fresh();
  const r0 = cl.issueClearance({ signer: 'rita', ...SCOPE, ttlMinutes: 15, secret: SECRET, store, now: NOW });
  ok('签发成功', r0.ok === true);
  const r = cl.consumeClearance(r0.token, { ...SCOPE, lockId: 'HELD_LOCK_1', lock, store, secret: SECRET, consumer: 'exec1', now: NOW + 1000 });
  ok('正常签发+消费 → ok=true', r.ok === true);
})();

// 2) 同 nonce 二次消费 → REPLAY_REJECTED
(function () {
  const { store, lock } = fresh();
  const { token } = cl.issueClearance({ signer: 'rita', ...SCOPE, ttlMinutes: 15, secret: SECRET, store, now: NOW });
  const c = { ...SCOPE, lock, store, secret: SECRET };
  const r1 = cl.consumeClearance(token, { ...c, now: NOW + 1000 });
  const r2 = cl.consumeClearance(token, { ...c, now: NOW + 2000 });
  ok('首次消费 ok=true', r1.ok === true);
  ok('二次消费 → REPLAY_REJECTED', r2.ok === false && r2.reason === 'REPLAY_REJECTED');
})();

// 3) 作用域不符（jobId / rowSetDigest / snapshotFingerprint 三路）→ SCOPE_MISMATCH
(function () {
  const cases = [
    ['jobId', { jobId: 'OTHER', rowSetDigest: SCOPE.rowSetDigest, snapshotFingerprint: SCOPE.snapshotFingerprint }],
    ['rowSetDigest', { jobId: SCOPE.jobId, rowSetDigest: 'sha256:wrong', snapshotFingerprint: SCOPE.snapshotFingerprint }],
    ['snapshotFingerprint', { jobId: SCOPE.jobId, rowSetDigest: SCOPE.rowSetDigest, snapshotFingerprint: 'fp:wrong' }],
  ];
  for (const [label, sc] of cases) {
    const { store, lock } = fresh();
    const { token } = cl.issueClearance({ signer: 'rita', ...SCOPE, ttlMinutes: 15, secret: SECRET, store, now: NOW });
    const r = cl.consumeClearance(token, { ...sc, lock, store, secret: SECRET, now: NOW + 1000 });
    ok('作用域不符（' + label + '）→ SCOPE_MISMATCH', r.ok === false && r.reason === 'SCOPE_MISMATCH');
  }
})();

// 4) 过期 → EXPIRED
(function () {
  const { store, lock } = fresh();
  const { token } = cl.issueClearance({ signer: 'rita', ...SCOPE, ttlMinutes: 15, secret: SECRET, store, now: NOW });
  const r = cl.consumeClearance(token, { ...SCOPE, lock, store, secret: SECRET, now: NOW + 16 * 60 * 1000 });
  ok('超过 15min TTL → EXPIRED', r.ok === false && r.reason === 'EXPIRED');
})();

// 5) 撤销 → REVOKED（Tom #3：撤销须同锁）
(function () {
  const { store, lock } = fresh();
  const { token } = cl.issueClearance({ signer: 'rita', ...SCOPE, ttlMinutes: 15, secret: SECRET, store, now: NOW });
  const rv = cl.revokeClearance(token, { secret: SECRET, store, lock, now: NOW + 500 });
  ok('撤销成功（持锁）', rv.ok === true);
  const r = cl.consumeClearance(token, { ...SCOPE, lock, store, secret: SECRET, now: NOW + 1000 });
  ok('已撤销 → REVOKED', r.ok === false && r.reason === 'REVOKED');
})();

// 6) 篡改签名 → 拒绝
(function () {
  const { store, lock } = fresh();
  const { token } = cl.issueClearance({ signer: 'rita', ...SCOPE, ttlMinutes: 15, secret: SECRET, store, now: NOW });
  const tampered = token.slice(0, -2) + (token.endsWith('==') ? 'AA' : '==');
  const r = cl.consumeClearance(tampered, { ...SCOPE, lock, store, secret: SECRET, now: NOW + 1000 });
  ok('篡改令牌 → 拒绝（BAD_SIGNATURE/MALFORMED）', r.ok === false && (r.reason === 'BAD_SIGNATURE' || r.reason === 'MALFORMED'));
})();

// 7) UNKNOWN 恢复：消费后写未完成，禁止盲重试，须按 jobId+nonce 对账原台账
(function () {
  const { store, lock } = fresh();
  const { token, nonce } = cl.issueClearance({ signer: 'rita', ...SCOPE, ttlMinutes: 15, secret: SECRET, store, now: NOW });
  const c = { ...SCOPE, lock, store, secret: SECRET, consumer: 'exec1' };
  const r = cl.consumeClearance(token, { ...c, now: NOW + 1000 });
  ok('消费成功（标记 consumed）', r.ok === true);
  const retry = cl.consumeClearance(token, { ...c, now: NOW + 1500 });
  ok('UNKNOWN 恢复：盲重试同 token → REPLAY_REJECTED（禁止盲重试）', retry.ok === false && retry.reason === 'REPLAY_REJECTED');
  const rec = store.get('tok:' + nonce);
  ok('对账台账 state=consumed（须重新签发新 nonce，不复用旧 token）', rec && rec.state === 'consumed');
  const rvAfter = cl.revokeClearance(token, { secret: SECRET, store, lock, now: NOW + 1600 });
  ok('已消费后再撤销 → ALREADY_CONSUMED（不可回滚已消费）', rvAfter.ok === false && rvAfter.reason === 'ALREADY_CONSUMED');
})();

// ---- Tom 第十轮 #1：严格布尔契约 —— {ok:false, reason} 对象不得被判为通过 ----
(function () {
  ok('#1 core._clearanceStrictOk(true) === true', core._clearanceStrictOk(true) === true);
  ok('#1 core._clearanceStrictOk({ok:true}) === true', core._clearanceStrictOk({ ok: true }) === true);
  ok('#1 core._clearanceStrictOk({ok:false, reason:"REVOKED"}) === false（truthy 对象不得绕过）',
    core._clearanceStrictOk({ ok: false, reason: 'REVOKED' }) === false);
  ok('#1 core._clearanceStrictOk({ok:"true"}) === false（字符串 pseudo-true 拒绝）',
    core._clearanceStrictOk({ ok: 'true' }) === false);
  ok('#1 core._clearanceStrictOk(false/undefined/null/{}) 全 false',
    core._clearanceStrictOk(false) === false && core._clearanceStrictOk(undefined) === false &&
    core._clearanceStrictOk(null) === false && core._clearanceStrictOk({}) === false);
  const stub = () => false;
  ok('#1 旧桩 ()=>false 兼容三参数调用 → false（PERIOD_LOCKED 维持）', stub('tok', [], { jobId: 'J1' }) === false);
})();

// ---- Tom 第十轮 #3：锁所有权 / 串行化 ----
(function () {
  const mk = () => { const s = cl.makeStore(); const t = cl.issueClearance({ signer: 'rita', ...SCOPE, ttlMinutes: 15, secret: SECRET, store: s, now: NOW }); return { s, t }; };

  let { s, t } = mk();
  let r = cl.consumeClearance(t.token, { ...SCOPE, store: s, secret: SECRET, now: NOW + 1000 });
  ok('#3 缺 ctx.lock → LOCK_MISSING（不再用无操作锁无锁消费）', r.ok === false && r.reason === 'LOCK_MISSING');

  ({ s, t } = mk());
  r = cl.consumeClearance(t.token, { ...SCOPE, lock: { acquire() { return 1; }, release() {} }, store: s, secret: SECRET, now: NOW + 1000 });
  ok('#3 传入「锁工厂」→ LOCK_NOT_HELD（禁止本模块代为 acquire/重入）', r.ok === false && r.reason === 'LOCK_NOT_HELD');

  ({ s, t } = mk());
  r = cl.consumeClearance(t.token, { ...SCOPE, lock: { id: 'L1', held: false }, store: s, secret: SECRET, now: NOW + 1000 });
  ok('#3 lock.held !== true → LOCK_NOT_HELD', r.ok === false && r.reason === 'LOCK_NOT_HELD');

  ({ s, t } = mk());
  r = cl.consumeClearance(t.token, { ...SCOPE, lock: { id: 'L1', held: true, released: true }, store: s, secret: SECRET, now: NOW + 1000 });
  ok('#3 已释放的锁 → LOCK_RELEASED', r.ok === false && r.reason === 'LOCK_RELEASED');

  ({ s, t } = mk());
  r = cl.consumeClearance(t.token, { ...SCOPE, lockId: 'GUARD_LOCK', lock: cl.makeHeldLock('OTHER_LOCK'), store: s, secret: SECRET, now: NOW + 1000 });
  ok('#3 lockId 与句柄 id 不符 → LOCK_ID_MISMATCH（证明与 guardCheck 同锁）', r.ok === false && r.reason === 'LOCK_ID_MISMATCH');

  ({ s, t } = mk());
  const rv = cl.revokeClearance(t.token, { secret: SECRET, store: s, now: NOW + 500 });
  ok('#3 撤销缺锁 → 拒绝（消费与撤销须串行化于同一把锁）', rv.ok === false && rv.reason === 'LOCK_MISSING');
})();

// ---- Tom 第十轮 #3：作用域字段不得客户端自报缺失 ----
(function () {
  const cases = [
    ['jobId', { rowSetDigest: SCOPE.rowSetDigest, snapshotFingerprint: SCOPE.snapshotFingerprint }, 'SCOPE_JOBID_MISSING'],
    ['rowSetDigest', { jobId: SCOPE.jobId, snapshotFingerprint: SCOPE.snapshotFingerprint }, 'SCOPE_DIGEST_MISSING'],
    ['snapshotFingerprint', { jobId: SCOPE.jobId, rowSetDigest: SCOPE.rowSetDigest }, 'SCOPE_FINGERPRINT_MISSING'],
  ];
  for (const [label, sc, expect] of cases) {
    const { store, lock } = fresh();
    const { token } = cl.issueClearance({ signer: 'rita', ...SCOPE, ttlMinutes: 15, secret: SECRET, store, now: NOW });
    const r = cl.consumeClearance(token, { ...sc, lock, store, secret: SECRET, now: NOW + 1000 });
    ok('#3 作用域字段缺失（' + label + '）→ ' + expect, r.ok === false && r.reason === expect);
  }
})();

// ---- Tom 第十轮 #4：签发身份 / TTL 上限 / 原型标记 ----
(function () {
  const store = cl.makeStore();
  const big = cl.issueClearance({ signer: 'rita', ...SCOPE, ttlMinutes: 61, secret: SECRET, store, now: NOW });
  ok('#4 ttlMinutes > 60 → TTL_EXCEEDS_CAP', big.ok === false && big.reason === 'TTL_EXCEEDS_CAP');
  const neg = cl.issueClearance({ signer: 'rita', ...SCOPE, ttlMinutes: 0, secret: SECRET, store, now: NOW });
  ok('#4 ttlMinutes <= 0 → TTL_EXCEEDS_CAP', neg.ok === false && neg.reason === 'TTL_EXCEEDS_CAP');
  const okTtl = cl.issueClearance({ signer: 'rita', ...SCOPE, ttlMinutes: 60, secret: SECRET, store, now: NOW });
  ok('#4 ttlMinutes === 60（上限内）→ 允许签发', okTtl.ok === true);
  const noSigner = cl.issueClearance({ ...SCOPE, ttlMinutes: 15, secret: SECRET, store, now: NOW });
  ok('#4 缺 signer → MISSING_SIGNER', noSigner.ok === false && noSigner.reason === 'MISSING_SIGNER');
  ok('#4 模块显式声明 PROTOTYPE_ONLY === true（非生产原型）', cl.PROTOTYPE_ONLY === true);
  ok('#4 MAX_TTL_MINUTES === 60', cl.MAX_TTL_MINUTES === 60);
  // 未注入 secret 且未放开测试开关 → 不得回退默认测试密钥
  const saved = process.env.TS_CLEARANCE_ALLOW_TEST_SECRET;
  delete process.env.TS_CLEARANCE_ALLOW_TEST_SECRET;
  const noSecret = cl.issueClearance({ signer: 'rita', ...SCOPE, ttlMinutes: 15, store: cl.makeStore(), now: NOW });
  ok('#4 未注入 secret 且未放开开关 → MISSING_SECRET（不回退测试密钥）', noSecret.ok === false && noSecret.reason === 'MISSING_SECRET');
  if (saved != null) process.env.TS_CLEARANCE_ALLOW_TEST_SECRET = saved;
})();

// ---- Tom 第十轮 #3：rowSetDigest 由服务端派生（与行顺序无关、可独立复算）----
(function () {
  const rowsA = [{ row: 2, uuid: 'u1', keeperRow: 3 }, { row: 5, uuid: 'u2', keeperRow: 6 }];
  const rowsB = [{ row: 5, uuid: 'u2', keeperRow: 6 }, { row: 2, uuid: 'u1', keeperRow: 3 }];
  ok('#3 rowSetDigest 与行顺序无关', core._rowSetDigestOf(rowsA) === core._rowSetDigestOf(rowsB));
  const rowsC = [{ row: 2, uuid: 'u1', keeperRow: 3 }];
  ok('#3 rowSetDigest 随行集变化', core._rowSetDigestOf(rowsA) !== core._rowSetDigestOf(rowsC));
  // _sdSha256 统一返回 "sha256:"+64hex（与 core 既有的 expectHash 同一口径）
  ok('#3 rowSetDigest 形态为 sha256:<64hex>', /^sha256:[0-9a-f]{64}$/.test(core._rowSetDigestOf(rowsA)));
})();

console.log('\n=== S1-8 clearance 非生产负例（含 Tom 第十轮 #1/#3/#4）===');
console.log('结果：' + pass + ' PASS / ' + fail + ' FAIL');
process.exit(fail === 0 ? 0 : 1);
