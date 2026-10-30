#!/usr/bin/env node
'use strict';
// Tom 2101 #2 / #4 的【跨进程】负例证据：
//   · 重启一致性：进程 A 写入台账 ⇒ 全新进程 B 仍能读到同一记录（内存 Map 做不到）；
//   · 重放持久性：另一个新进程复用同 token ⇒ 必被拒（消费状态跨进程持久）；
//   · 竞态互斥：N 个进程并行消费同一 token ⇒ 恰好 1 个成功，其余被原子拒绝；
//   · CAS 完整性：持过期快照的 cas 必失败。
// ⚠️ 诚实边界：这是【本机文件系统】实现。**不等于** GAS PropertiesService 服务端持久账本；
//    也不构成生产环境互斥的证据（不同挂载点 / NFS 的语义未评估）。PROTOTYPE_ONLY = true。
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const assert = require('assert');
const cl = require('./ts_clearance.js');
const fsStore = require('./ts_clearance_filestore.js');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  [PASS] ' + name); }
  else { fail++; console.log('  [FAIL] ' + name); }
}

const SECRET = 'cross-process-nonprod-secret';
const NOW = 1_700_000_000_000;
const CHILD = path.join(__dirname, '_ts_clearance_filestore_child.js');
const CHILD_DIR = __dirname;

function mkTmp(tag) {
  const d = path.join(os.tmpdir(), 't1b_fs_' + tag + '_' + Date.now() + '_' + Math.random().toString(16).slice(2));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function issueInto(dir, tag) {
  cl.clearTrustedSigners();
  cl.trustSigner('rita', SECRET);
  cl._setDefaultSecret(SECRET);
  const store = fsStore.makeFileStore(dir);
  const scope = { jobId: 'JP_' + tag, rowSetDigest: 'sha256:rsd-' + tag, snapshotFingerprint: 'sha256:fp-' + tag };
  const r = cl.issueClearance({ signer: 'rita', ...scope, ttlMinutes: 5, store, now: NOW });
  assert.strictEqual(r.ok, true, 'issue must succeed: ' + JSON.stringify(r));
  return { token: r.token, nonce: r.nonce, scope: scope, store: store };
}

function writeCfg(dir, cfg) {
  const p = path.join(dir, 'cfg_' + Math.random().toString(16).slice(2) + '.json');
  fs.writeFileSync(p, JSON.stringify(cfg));
  return p;
}

function runChildSync(cfg) {
  const cfgPath = writeCfg(cfg.dir, cfg);
  const outName = 'out_' + Math.random().toString(16).slice(2) + '.json';
  cp.execFileSync(process.execPath, [CHILD, cfgPath, outName], { cwd: CHILD_DIR, stdio: 'pipe' });
  return JSON.parse(fs.readFileSync(path.join(os.tmpdir(), outName), 'utf8')).out;
}

try {
  // 1) 重启一致性：新进程能消费到旧进程写入的 issued 记录
  const dirA = mkTmp('restart');
  const A = issueInto(dirA, 'A1');
  ok('1) 主进程签发后台账可见（state=issued）',
    A.store.get('tok:' + A.nonce) && A.store.get('tok:' + A.nonce).state === 'issued');
  const r1 = runChildSync({ dir: dirA, token: A.token, scope: A.scope, secret: SECRET, lockId: 'GUARD_LOCK', now: NOW + 1000 });
  ok('1) 全新进程消费成功（台账跨进程持久，内存 Map 做不到）', r1.ok === true, JSON.stringify(r1));

  // 2) 重放持久性：另一个新进程复用同 token ⇒ 必被拒
  const dirB = mkTmp('replay');
  const B = issueInto(dirB, 'A2');
  const b1 = runChildSync({ dir: dirB, token: B.token, scope: B.scope, secret: SECRET, lockId: 'GUARD_LOCK', now: NOW + 1000 });
  const b2 = runChildSync({ dir: dirB, token: B.token, scope: B.scope, secret: SECRET, lockId: 'GUARD_LOCK', now: NOW + 2000 });
  ok('2) 第一次跨进程消费成功', b1.ok === true);
  ok('2) 第二次（另一新进程）被拒：' + JSON.stringify(b2),
    b2.ok === false && (b2.reason === 'REPLAY_REJECTED' || b2.reason === 'CONSUME_RACE_REJECTED'));

  // 3) CAS 完整性：持过期记录的 cas 必须失败
  const dirC = mkTmp('cas');
  const storeC = fsStore.makeFileStore(dirC);
  storeC.set('k1', { v: 1 });
  const stale = { v: 1, extra: 'tampered' };
  ok('3) cas 持过期/篡改 expect → false（不覆盖）', storeC.cas('k1', stale, { v: 2 }) === false);
  ok('3) cas 持精确 expect → true', storeC.cas('k1', { v: 1 }, { v: 2 }) === true);
  ok('3) cas 后值为新值', storeC.get('k1').v === 2);
  ok('3) 文件账本 PROTOTYPE_ONLY === true（不得当生产账本用）', storeC.PROTOTYPE_ONLY === true);

  // 4) 并发竞态：4 个进程同时消费同一 token ⇒ 恰好 1 个成功
  const dirD = mkTmp('race');
  const D = issueInto(dirD, 'A3');
  const cfg = { dir: dirD, token: D.token, scope: D.scope, secret: SECRET, lockId: 'GUARD_LOCK', now: NOW + 1000 };
  const jobs = [0, 1, 2, 3].map(() => {
    const cfgPath = writeCfg(dirD, cfg);
    return { cfgPath: cfgPath, out: 'race_' + Math.random().toString(16).slice(2) + '.json' };
  });
  const procs = jobs.map((c) => cp.spawn(process.execPath, [CHILD, c.cfgPath, c.out], { cwd: CHILD_DIR, stdio: 'pipe' }));
  Promise.all(procs.map((p) => new Promise((res) => p.on('close', () => res())))).then(() => {
    const outs = jobs.map((c) => JSON.parse(fs.readFileSync(path.join(os.tmpdir(), c.out), 'utf8')).out);
    const win = outs.filter((o) => o && o.ok === true).length;
    const losers = outs.filter((o) => o && o.ok === false).map((o) => o.reason);
    ok('4) 4 进程并发消费：恰好 1 个成功（实际 ' + win + '）', win === 1);
    ok('4) 其余 3 个被原子拒绝：' + JSON.stringify(losers), losers.length === 3 &&
      losers.every((r) => r === 'CONSUME_RACE_REJECTED' || r === 'REPLAY_REJECTED'));
    console.log('\n=== Tom 2101 #2/#4 跨进程负例（本机文件系统原型，非 GAS 持久账本）===');
    console.log('结果：' + pass + ' PASS / ' + fail + ' FAIL');
    assert.strictEqual(fail, 0, 'filestore negative suite must be all-pass');
    process.exit(fail === 0 ? 0 : 1);
  });
} catch (e) {
  console.log('  [FAIL] 抛异常：' + (e && e.message || e));
  process.exit(1);
}
