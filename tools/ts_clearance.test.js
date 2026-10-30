#!/usr/bin/env node
'use strict';
// S1-8 非生产负例（Tom 第八轮·实现方待办）+ Tom 第十轮缺陷 #1/#2/#3/#4 + Tom 2101 #1/#2/#3/#4 专项覆盖。
// 覆盖：
//   第十轮 —— 严格布尔契约、锁所有权（缺锁/未持有/已释放/id不符/禁止重入）、TTL 上限、
//             作用域字段服务端派生（不接受客户端自报）、撤销串行化、过期/撤销/错签/错范围/重放均拒绝。
//   2101 #1 —— 生产接口严格形态：仅 {ok:true, nonce} 通过；裸 true / {ok:true} 无 nonce 一律拒绝。
//   2101 #2 —— 锁句柄强制 id + 服务端 attestation（alg/dom/sig）+ 域一致性；未签名句柄默认拒绝。
//   2101 #3 —— V2 行集指纹（逐行内容 + 行数 + 规范排序）与 V2 快照指纹（目标/动作/job/batch/版本/行集）。
//   2101 #4 —— TTL 硬上限 15 分钟、按 signer 索引的独立验签密钥、CAS 原子消费、UNKNOWN 对账入口。
// ⚠️ 本文件全部为【非生产内存替身】证据，不构成隔离或生产状态的证明（Tom 第九/十轮口径）。
const assert = require('assert');
const cl = require('./ts_clearance.js');
const core = require('./ts_softdel_core.js');
const adapter = require('./ts_lock_adapter.js');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  [PASS] ' + name); }
  else { fail++; console.log('  [FAIL] ' + name); }
}

const SECRET = 'non-production-secret';
const SCOPE = { jobId: 'J1', rowSetDigest: 'sha256:abc', snapshotFingerprint: 'fp:1' };
const NOW = 1_700_000_000_000;

// Tom 2101 #4：签发验签密钥按 signer id 登记（非单一全局密钥）
function trustDefault() {
  cl.clearTrustedSigners();
  cl.trustSigner('rita', SECRET);
  // 注入 File-level 默认密钥（模拟 GAS 侧由服务端配置注入，而非请求携带）
  cl._setDefaultSecret(SECRET);
}
trustDefault();

// 调用方【已持有】且经【受信锁适配器签发】的句柄（模拟 LockService.getScriptLock() 已 acquire）
const LOCK_ID = 'HELD_LOCK_1';
const HELD = () => cl.makeHeldLock(LOCK_ID, { secret: SECRET, domain: 'period-lock/guard' });
const CTX = () => ({ ...SCOPE, lockId: LOCK_ID, lock: HELD(), store: cl.makeStore(), secret: SECRET, consumer: 'exec1' });

function fresh() {
  return { store: cl.makeStore(), lock: HELD() };
}

// 1) 正常签发 + 消费
(function () {
  trustDefault();
  const { store, lock } = fresh();
  const r0 = cl.issueClearance({ signer: 'rita', ...SCOPE, ttlMinutes: 15, store, now: NOW });
  ok('签发成功（登记 signer）', r0.ok === true);
  const r = cl.consumeClearance(r0.token, { ...SCOPE, lockId: LOCK_ID, lock, store, consumer: 'exec1', now: NOW + 1000 });
  ok('正常签发+消费 → ok=true', r.ok === true);
  ok('  · 消费返回被消费 nonce（可追溯）', typeof r.nonce === 'string' && r.nonce.length === 32);
})();

// 2) 同 nonce 二次消费 → REPLAY_REJECTED
(function () {
  trustDefault();
  const { store, lock } = fresh();
  const { token } = cl.issueClearance({ signer: 'rita', ...SCOPE, ttlMinutes: 15, store, now: NOW });
  const r1 = cl.consumeClearance(token, { ...SCOPE, lockId: LOCK_ID, lock, store, now: NOW + 1000 });
  const r2 = cl.consumeClearance(token, { ...SCOPE, lockId: LOCK_ID, lock, store, now: NOW + 2000 });
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
    trustDefault();
    const { store, lock } = fresh();
    const { token } = cl.issueClearance({ signer: 'rita', ...SCOPE, ttlMinutes: 15, store, now: NOW });
    const r = cl.consumeClearance(token, { ...sc, lockId: LOCK_ID, lock, store, now: NOW + 1000 });
    ok('作用域不符（' + label + '）→ SCOPE_MISMATCH', r.ok === false && r.reason === 'SCOPE_MISMATCH');
  }
})();

// 4) 过期 → EXPIRED
(function () {
  trustDefault();
  const { store, lock } = fresh();
  const { token } = cl.issueClearance({ signer: 'rita', ...SCOPE, ttlMinutes: 5, store, now: NOW });
  const r = cl.consumeClearance(token, { ...SCOPE, lockId: LOCK_ID, lock, store, now: NOW + 6 * 60 * 1000 });
  ok('超过 TTL（5min）→ EXPIRED', r.ok === false && r.reason === 'EXPIRED');
})();

// 5) 撤销 → REVOKED（Tom #3：撤销须同锁）
(function () {
  trustDefault();
  const { store, lock } = fresh();
  const { token } = cl.issueClearance({ signer: 'rita', ...SCOPE, ttlMinutes: 15, store, now: NOW });
  const rv = cl.revokeClearance(token, { store, lock, lockId: LOCK_ID, now: NOW + 500 });
  ok('撤销成功（持锁）', rv.ok === true);
  const r = cl.consumeClearance(token, { ...SCOPE, lockId: LOCK_ID, lock, store, now: NOW + 1000 });
  ok('已撤销 → REVOKED', r.ok === false && r.reason === 'REVOKED');
})();

// 6) 篡改签名 → 拒绝
(function () {
  trustDefault();
  const { store, lock } = fresh();
  const { token } = cl.issueClearance({ signer: 'rita', ...SCOPE, ttlMinutes: 15, store, now: NOW });
  const tampered = token.slice(0, -2) + (token.endsWith('==') ? 'AA' : '==');
  const r = cl.consumeClearance(tampered, { ...SCOPE, lockId: LOCK_ID, lock, store, now: NOW + 1000 });
  ok('篡改令牌 → 拒绝（BAD_SIGNATURE/MALFORMED）', r.ok === false && (r.reason === 'BAD_SIGNATURE' || r.reason === 'MALFORMED'));
})();

// 7) UNKNOWN 恢复：消费后写未完成，禁止盲重试，须按 jobId+nonce 对账原台账
(function () {
  trustDefault();
  const { store, lock } = fresh();
  const { token, nonce } = cl.issueClearance({ signer: 'rita', ...SCOPE, ttlMinutes: 15, store, now: NOW });
  const c = { ...SCOPE, lockId: LOCK_ID, lock, store, consumer: 'exec1' };
  const r = cl.consumeClearance(token, { ...c, now: NOW + 1000 });
  ok('消费成功（标记 consumed）', r.ok === true);
  const retry = cl.consumeClearance(token, { ...c, now: NOW + 1500 });
  ok('UNKNOWN 恢复：盲重试同 token → REPLAY_REJECTED（禁止盲重试）', retry.ok === false && retry.reason === 'REPLAY_REJECTED');
  const rec = store.get('tok:' + nonce);
  ok('对账台账 state=consumed（须重新签发新 nonce，不复用旧 token）', rec && rec.state === 'consumed');
  const rvAfter = cl.revokeClearance(token, { store, lock, lockId: LOCK_ID, now: NOW + 1600 });
  ok('已消费后再撤销 → ALREADY_CONSUMED（不可回滚已消费）', rvAfter.ok === false && rvAfter.reason === 'ALREADY_CONSUMED');
})();

// ---- Tom 第十轮 #1 + Tom 2101 #1：严格形态契约 ----
(function () {
  const saved = process.env.TS_CLEARANCE_SHAPE_MODE;
  delete process.env.TS_CLEARANCE_SHAPE_MODE;
  ok('#1 默认（GAS 无 process ⇒ STRICT）_clearanceShapeMode() === "strict"', core._clearanceShapeMode() === 'strict');
  ok('#1 STRICT：裸布尔 true → 拒绝（bare-true 不携带 nonce，不可追溯）', core._clearanceStrictOk(true) === false);
  ok('#1 STRICT：{ok:true} 无 nonce → 拒绝', core._clearanceStrictOk({ ok: true }) === false);
  ok('#1 STRICT：{ok:true, nonce:"ab"} → 通过', core._clearanceStrictOk({ ok: true, nonce: 'ab' }) === true);
  ok('#1 STRICT：{ok:false, reason:"REVOKED"} → false（truthy 对象不得绕过）',
    core._clearanceStrictOk({ ok: false, reason: 'REVOKED' }) === false);
  ok('#1 STRICT：{ok:"true"} → false（字符串 pseudo-true 拒绝）', core._clearanceStrictOk({ ok: 'true' }) === false);
  ok('#1 STRICT：{ok:true, nonce:""} → false（空 nonce 拒绝）', core._clearanceStrictOk({ ok: true, nonce: '' }) === false);
  ok('#1 STRICT：false/undefined/null/{}/[true] 全 false',
    core._clearanceStrictOk(false) === false && core._clearanceStrictOk(undefined) === false &&
    core._clearanceStrictOk(null) === false && core._clearanceStrictOk({}) === false &&
    core._clearanceStrictOk([true]) === false);
  process.env.TS_CLEARANCE_SHAPE_MODE = 'prototype';
  ok('#1 PROTOTYPE（显式测试逃生口）：裸 true → true', core._clearanceStrictOk(true) === true);
  ok('#1 PROTOTYPE：{ok:false} 仍 false', core._clearanceStrictOk({ ok: false }) === false);
  if (saved != null) process.env.TS_CLEARANCE_SHAPE_MODE = saved; else delete process.env.TS_CLEARANCE_SHAPE_MODE;
})();

// ---- Tom 第十轮 #3 + Tom 2101 #2：锁所有权 / attestation / 串行化 ----
(function () {
  trustDefault();
  const mk = () => { const s = cl.makeStore(); const t = cl.issueClearance({ signer: 'rita', ...SCOPE, ttlMinutes: 15, store: s, now: NOW }); return { s, t }; };

  let { s, t } = mk();
  let r = cl.consumeClearance(t.token, { ...SCOPE, store: s, now: NOW + 1000 });
  ok('#3 缺 ctx.lock → LOCK_MISSING（不再用无操作锁无锁消费）', r.ok === false && r.reason === 'LOCK_MISSING');

  ({ s, t } = mk());
  r = cl.consumeClearance(t.token, { ...SCOPE, lockId: 'X', lock: { id: 'X', held: true, acquire() { return 1; }, release() {} }, store: s, now: NOW + 1000 });
  ok('#3 传入「锁工厂」→ LOCK_NOT_HELD（禁止本模块代为 acquire/重入）', r.ok === false && r.reason === 'LOCK_NOT_HELD');

  ({ s, t } = mk());
  r = cl.consumeClearance(t.token, { ...SCOPE, lockId: 'L1', lock: { id: 'L1', held: false }, store: s, now: NOW + 1000 });
  ok('#3 lock.held !== true → LOCK_NOT_HELD', r.ok === false && r.reason === 'LOCK_NOT_HELD');

  ({ s, t } = mk());
  r = cl.consumeClearance(t.token, { ...SCOPE, lockId: 'L1', lock: { id: 'L1', held: true, released: true }, store: s, now: NOW + 1000 });
  ok('#3 已释放的锁 → LOCK_RELEASED', r.ok === false && r.reason === 'LOCK_RELEASED');

  ({ s, t } = mk());
  r = cl.consumeClearance(t.token, { ...SCOPE, lockId: 'GUARD_LOCK', lock: cl.makeHeldLock('OTHER_LOCK', { secret: SECRET }), store: s, now: NOW + 1000 });
  ok('#3 lockId 与句柄 id 不符 → LOCK_ID_MISMATCH（证明与 guardCheck 同锁）', r.ok === false && r.reason === 'LOCK_ID_MISMATCH');

  // 2101 #2：lockId 必填（原来不传就跳过校验）
  ({ s, t } = mk());
  r = cl.consumeClearance(t.token, { ...SCOPE, lock: HELD(), store: s, now: NOW + 1000 });
  ok('2101#2 句柄合法但 ctx.lockId 缺失 → LOCK_ID_MISSING（lockId 由可选改必填）',
    r.ok === false && r.reason === 'LOCK_ID_MISSING');

  // 2101 #2：未签名的普通对象句柄 → 默认拒绝
  ({ s, t } = mk());
  const savedEnv = process.env.TS_CLEARANCE_ALLOW_UNATTESTED_LOCK;
  delete process.env.TS_CLEARANCE_ALLOW_UNATTESTED_LOCK;
  r = cl.consumeClearance(t.token, { ...SCOPE, lockId: 'HAND', lock: { id: 'HAND', held: true, released: false }, store: s, now: NOW + 1000 });
  ok('2101#2 调用方自造未签名句柄 → LOCK_ATTEST_MISSING（默认 fail-closed）',
    r.ok === false && r.reason === 'LOCK_ATTEST_MISSING');

  // 2101 #2：attest 用别的密钥签发 → 验签不过
  ({ s, t } = mk());
  r = cl.consumeClearance(t.token, { ...SCOPE, lockId: 'HAND', lock: cl.makeHeldLock('HAND', { secret: 'someone-elses-key' }), store: s, now: NOW + 1000 });
  ok('2101#2 句柄由他人密钥签发 → LOCK_ATTEST_BAD', r.ok === false && r.reason === 'LOCK_ATTEST_BAD');

  // 2101 #2：域不一致（把别处的锁句柄当本期锁用）
  ({ s, t } = mk());
  r = cl.consumeClearance(t.token, { ...SCOPE, lockId: 'HAND', lockDomain: 'period-lock/guard',
    lock: cl.makeHeldLock('HAND', { secret: SECRET, domain: 'some-other-domain' }), store: s, now: NOW + 1000 });
  ok('2101#2 句柄域与声明域不符 → LOCK_DOMAIN_MISMATCH', r.ok === false && r.reason === 'LOCK_DOMAIN_MISMATCH');

  // 2101 #2：受信适配器直签句柄 → 允许（证明 To mA 要求的"服务端适配器持锁"路径已接好）
  ({ s, t } = mk());
  const trustedHandle = adapter.acquireTrustedLock({
    acquireLock: () => ({ __gasLock: true }),
    releaseLock: () => {},
    lockSecret: () => SECRET,
    lockIdFor: () => 'GUARD_LOCK',
  });
  r = cl.consumeClearance(t.token, { ...SCOPE, lockId: 'GUARD_LOCK', lockDomain: 'period-lock/guard', lock: trustedHandle, store: s, now: NOW + 1000 });
  ok('2101#2 受信适配器签发句柄 → 允许消费（ok=true）', r.ok === true); // Tom 要求的「服务端适配器持锁」路径
  if (savedEnv != null) process.env.TS_CLEARANCE_ALLOW_UNATTESTED_LOCK = savedEnv;

  ({ s, t } = mk());
  const rv = cl.revokeClearance(t.token, { store: s, now: NOW + 500 });
  ok('#3 撤销缺锁 → 拒绝（消费与撤销须串行化于同一把锁）', rv.ok === false && rv.reason === 'LOCK_MISSING');
})();

// ---- Tom 第十轮 #3：作用域字段不得客户端自报缺失 ----
(function () {
  trustDefault();
  const cases = [
    ['jobId', { rowSetDigest: SCOPE.rowSetDigest, snapshotFingerprint: SCOPE.snapshotFingerprint }, 'SCOPE_JOBID_MISSING'],
    ['rowSetDigest', { jobId: SCOPE.jobId, snapshotFingerprint: SCOPE.snapshotFingerprint }, 'SCOPE_DIGEST_MISSING'],
    ['snapshotFingerprint', { jobId: SCOPE.jobId, rowSetDigest: SCOPE.rowSetDigest }, 'SCOPE_FINGERPRINT_MISSING'],
  ];
  for (const [label, sc, expect] of cases) {
    const { store, lock } = fresh();
    const { token } = cl.issueClearance({ signer: 'rita', ...SCOPE, ttlMinutes: 15, store, now: NOW });
    const r = cl.consumeClearance(token, { ...sc, lockId: LOCK_ID, lock, store, now: NOW + 1000 });
    ok('#3 作用域字段缺失（' + label + '）→ ' + expect, r.ok === false && r.reason === expect);
  }
})();

// ---- Tom 第十轮 #4 + Tom 2101 #4：签发身份 / TTL 上限 / 独立验签密钥 / 原型标记 ----
(function () {
  trustDefault();
  const store = cl.makeStore();
  const big = cl.issueClearance({ signer: 'rita', ...SCOPE, ttlMinutes: 16, store, now: NOW });
  ok('2101#4 ttlMinutes 16 > 上限 15 → TTL_EXCEEDS_CAP', big.ok === false && big.reason === 'TTL_EXCEEDS_CAP');
  const old60 = cl.issueClearance({ signer: 'rita', ...SCOPE, ttlMinutes: 60, store, now: NOW });
  ok('2101#4 ttlMinutes 60（Tom 不接受的原型旧值）→ 拒绝', old60.ok === false && old60.reason === 'TTL_EXCEEDS_CAP');
  const neg = cl.issueClearance({ signer: 'rita', ...SCOPE, ttlMinutes: 0, store, now: NOW });
  ok('#4 ttlMinutes <= 0 → TTL_EXCEEDS_CAP', neg.ok === false && neg.reason === 'TTL_EXCEEDS_CAP');
  const okTtl = cl.issueClearance({ signer: 'rita', ...SCOPE, ttlMinutes: 15, store, now: NOW });
  ok('2101#4 ttlMinutes === 15（硬上限内）→ 允许签发', okTtl.ok === true);
  const noSigner = cl.issueClearance({ ...SCOPE, ttlMinutes: 15, store, now: NOW });
  ok('#4 缺 signer → MISSING_SIGNER', noSigner.ok === false && noSigner.reason === 'MISSING_SIGNER');
  ok('2101#4 未登记 signer → SIGNER_NOT_TRUSTED（任意字符串不得签发）',
    cl.issueClearance({ signer: 'random-guy', ...SCOPE, ttlMinutes: 5, store: cl.makeStore(), secret: SECRET, now: NOW }).reason === 'SIGNER_NOT_TRUSTED');
  ok('#4 模块显式声明 PROTOTYPE_ONLY === true（非生产原型）', cl.PROTOTYPE_ONLY === true);
  ok('2101#4 MAX_TTL_MINUTES === 15（硬上限，无 env 逃生口）', cl.MAX_TTL_MINUTES === 15);
  ok('2101#4 DEFAULT_TTL_MINUTES === 15', cl.DEFAULT_TTL_MINUTES === 15);

  // 2101 #4：逐 signer 独立密钥 —— 换号借用不得通过
  cl.clearTrustedSigners();
  cl.trustSigner('rita', 'key-A');
  cl.trustSigner('tom', 'key-B');
  const s2 = cl.makeStore();
  const tA = cl.issueClearance({ signer: 'rita', ...SCOPE, ttlMinutes: 5, store: s2, now: NOW });
  ok('2101#4 signer=rita 用 key-A 签发成功', tA.ok === true);
  // 仍登记，但密钥被换掉 ⇒ 验签须失败（证明不是"共享一把密钥验所有人"）
  cl.trustSigner('rita', 'key-A-rotated');
  const rRot = cl.consumeClearance(tA.token, { ...SCOPE, lockId: LOCK_ID, lock: HELD(), store: s2, now: NOW + 1000 });
  ok('2101#4 rita 密钥轮换后旧令牌 → BAD_SIGNATURE（独立验签密钥生效）',
    rRot.ok === false && rRot.reason === 'BAD_SIGNATURE');
  trustDefault();

  // 未注入 secret 且未放开测试开关 → 不得回退默认测试密钥
  cl.clearTrustedSigners();
  const saved = process.env.TS_CLEARANCE_ALLOW_TEST_SECRET;
  delete process.env.TS_CLEARANCE_ALLOW_TEST_SECRET;
  cl._setDefaultSecret(null); // 显式清空注入密钥，验证不得回退默认测试密钥
  const noSecret = cl.issueClearance({ signer: 'rita', ...SCOPE, ttlMinutes: 15, store: cl.makeStore(), now: NOW });
  ok('#4 未登记 signer 且无注入密钥 → MISSING_SECRET / SIGNER_NOT_TRUSTED（不回退测试密钥、不给 blanket 签发）',
    noSecret.ok === false && (noSecret.reason === 'MISSING_SECRET' || noSecret.reason === 'SIGNER_NOT_TRUSTED'));
  cl.trustSigner('rita', SECRET);
  const noSecret2 = cl.issueClearance({ signer: 'rita', ...SCOPE, ttlMinutes: 15, store: cl.makeStore(), now: NOW });
  ok('#4 已登记 signer 但无注入密钥且未放开开关 → SIGNER key available ⇒ 仍可用其登记密钥签发',
    noSecret2.ok === true);
  if (saved != null) process.env.TS_CLEARANCE_ALLOW_TEST_SECRET = saved;
  trustDefault();
})();

// ---- Tom 2101 #2：账本原子性（无 CAS ⇒ 拒绝消费）----
(function () {
  trustDefault();
  const { store } = fresh();
  const { token } = cl.issueClearance({ signer: 'rita', ...SCOPE, ttlMinutes: 15, store, now: NOW });
  const nonAtomic = { get: (k) => store.get(k), set: (k, v) => store.set(k, v) }; // 无 cas
  const r = cl.consumeClearance(token, { ...SCOPE, lockId: LOCK_ID, lock: HELD(), store: nonAtomic, now: NOW + 1000 });
  ok('2101#2 账本无 cas 接口 → STORE_NOT_ATOMIC（禁止读-改-写覆盖）', r.ok === false && r.reason === 'STORE_NOT_ATOMIC');
  const rv = cl.revokeClearance(token, { store: nonAtomic, lockId: LOCK_ID, lock: HELD(), now: NOW + 500 });
  ok('2101#2 撤销同样要求 cas → STORE_NOT_ATOMIC', rv.ok === false && rv.reason === 'STORE_NOT_ATOMIC');

  // CAS 竞态：读快照后、落盘前被他进程改写 ⇒ 本次 cas 必须失败（不再被后写覆盖）
  trustDefault();
  const st2 = cl.makeStore();
  const t2 = cl.issueClearance({ signer: 'rita', ...SCOPE, ttlMinutes: 15, store: st2, now: NOW });
  const racing = {
    get: (k) => st2.get(k),
    set: (k, v) => st2.set(k, v),
    cas: (k, exp, next) => {
      // 模拟并发：本次 cas 执行前，记录已被另一写者改动（仍 state=issued，但内容已不同）
      const cur = st2.get(k);
      if (cur) st2.set(k, Object.assign({}, cur, { consumer: 'another-writer' }));
      return st2.cas(k, exp, next);
    },
  };
  const rr = cl.consumeClearance(t2.token, { ...SCOPE, lockId: LOCK_ID, lock: HELD(), store: racing, now: NOW + 1000 });
  ok('2101#2 CAS 竞态（读-落盘间被他写者改动）→ CONSUME_RACE_REJECTED',
    rr.ok === false && rr.reason === 'CONSUME_RACE_REJECTED');
  ok('2101#2 竞态失败后台账未被标记为 consumed', st2.get('tok:' + t2.nonce).state === 'issued');
})();

// ---- Tom 2101 #4：UNKNOWN 对账入口（禁止自动重试、须人工裁决）----
(function () {
  const rows = [{ row: 2, uuid: 'U-1', keeperRow: 3, requestHash: 'sha256:req-1' }];
  const r1 = cl.reconcileUnknown({ jobId: 'J9', rows: rows, journalRead: () => { throw new Error('journal down'); } });
  ok('2101#4 journal 读失败 → 仍返回结构化清单（不抛、不自动重试）', r1.ok === true && r1.autoRetry === false);
  ok('2101#4 每项 requires=REQUIRES_ADMIN_ADJUDICATION', r1.requires[0].requires === 'REQUIRES_ADMIN_ADJUDICATION');
  ok('2101#4 诚实标注恢复状态机未实现', r1.admit === 'RECOVERY_STATE_MACHINE_NOT_IMPLEMENTED');
  const r2 = cl.reconcileUnknown({ jobId: 'J9', rows: rows, journalRead: () => [{ state: 'UNKNOWN', reason: 'WRITE_UNCONFIRMED' }] });
  ok('2101#4 有 journal 见证 → witness 带出原 state，但仍交人工裁决',
    r2.requires[0].witness[0].state === 'UNKNOWN' && r2.requires[0].requires === 'REQUIRES_ADMIN_ADJUDICATION');
})();

// ---- Tom 第十轮 #3 + Tom 2101 #3：行集/快照指纹（服务端派生、随内容变化）----
(function () {
  const rowsA = [{ row: 2, uuid: 'u1', keeperRow: 3, expectHash: 'sha256:t1' }, { row: 5, uuid: 'u2', keeperRow: 6, expectHash: 'sha256:t2' }];
  const rowsB = [{ row: 5, uuid: 'u2', keeperRow: 6, expectHash: 'sha256:t2' }, { row: 2, uuid: 'u1', keeperRow: 3, expectHash: 'sha256:t1' }];
  ok('#3 V1 rowSetDigest 与行顺序无关', core._rowSetDigestOf(rowsA) === core._rowSetDigestOf(rowsB));
  ok('2101#3 V2 rowSetDigest 与行顺序无关', core._rowSetDigestV2Of(rowsA) === core._rowSetDigestV2Of(rowsB));
  ok('2101#3 V2 ≠ V1（V1 不绑定逐行内容）', core._rowSetDigestV2Of(rowsA) !== core._rowSetDigestOf(rowsA));

  const rowsC = [{ row: 2, uuid: 'u1', keeperRow: 3, expectHash: 'sha256:t1' }];
  ok('2101#3 V2 随行集数量变化', core._rowSetDigestV2Of(rowsA) !== core._rowSetDigestV2Of(rowsC));
  const rowsMutated = [{ row: 2, uuid: 'u1', keeperRow: 3, expectHash: 'sha256:TAMPERED' }, { row: 5, uuid: 'u2', keeperRow: 6, expectHash: 'sha256:t2' }];
  ok('2101#3 V2 随【逐行内容指纹】变化（V1 的盲点）',
    core._rowSetDigestV2Of(rowsMutated) !== core._rowSetDigestV2Of(rowsA) &&
    core._rowSetDigestOf(rowsMutated) === core._rowSetDigestOf(rowsA));
  ok('2101#3 V2 非法行形态 → null（fail-closed）',
    core._rowSetDigestV2Of([{ row: 0, uuid: 'u', keeperRow: 3 }]) === null &&
    core._rowSetDigestV2Of([{ row: 2, uuid: '', keeperRow: 3 }]) === null &&
    core._rowSetDigestV2Of([]) === null);

  const base = {
    targetSpreadsheetId: '1Pi5u9fEXXXXXXXX', targetSheetName: 'DB_工时流水', action: 'softDelGuarded',
    jobId: 'J1', batchId: 'B1', masterVersion: 'V1', baselineVersion: 'BASE-1',
    rowCount: 2, rowSetDigestV2: core._rowSetDigestV2Of(rowsA),
  };
  const fp1 = core._snapshotFingerprintV2(base);
  ok('2101#3 V2 快照指纹形态为 sha256:<64hex>', /^sha256:[0-9a-f]{64}$/.test(String(fp1)));
  ok('2101#3 换 targetSheetName → 指纹变化（令牌不可被挪用到别的写目标）',
    core._snapshotFingerprintV2({ ...base, targetSheetName: 'OTHER_SHEET' }) !== fp1);
  ok('2101#3 换 action → 指纹变化', core._snapshotFingerprintV2({ ...base, action: 'otherAction' }) !== fp1);
  ok('2101#3 换 jobId → 指纹变化', core._snapshotFingerprintV2({ ...base, jobId: 'J2' }) !== fp1);
  ok('2101#3 换 batchId → 指纹变化', core._snapshotFingerprintV2({ ...base, batchId: 'B2' }) !== fp1);
  ok('2101#3 换 masterVersion → 指纹变化', core._snapshotFingerprintV2({ ...base, masterVersion: 'V2' }) !== fp1);
  ok('2101#3 换 baselineVersion → 指纹变化', core._snapshotFingerprintV2({ ...base, baselineVersion: 'BASE-2' }) !== fp1);
  ok('2101#3 换 rowCount → 指纹变化', core._snapshotFingerprintV2({ ...base, rowCount: 3 }) !== fp1);
  ok('2101#3 缺任一必需字段 → null（缺值整批拒绝，绝不回退旧版）',
    core._snapshotFingerprintV2({ ...base, targetSpreadsheetId: '' }) === null &&
    core._snapshotFingerprintV2({ ...base, action: null }) === null &&
    core._snapshotFingerprintV2({ ...base, baselineVersion: undefined }) === null &&
    core._snapshotFingerprintV2({ ...base, rowCount: NaN }) === null);
})();

console.log('\n=== S1-8 clearance 非生产负例（Tom 第十轮 #1/#3/#4 + Tom 2101 #1/#2/#3/#4）===');
console.log('结果：' + pass + ' PASS / ' + fail + ' FAIL');
assert.strictEqual(fail, 0, 'clearance negative suite must be all-pass');
process.exit(fail === 0 ? 0 : 1);
