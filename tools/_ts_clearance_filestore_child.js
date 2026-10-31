#!/usr/bin/env node
'use strict';
// 跨进程消费子进程（供 ts_clearance.filestore.test.js 调用）
//   argv[2] = job json：{ dir, token, scope, secret, lockId, lockSecret }
//   argv[3] = 输出文件名
// 本文件仅读写操作系统临时目录，零生产写、零网络写。
const fs = require('fs');
const path = require('path');
const os = require('os');
const cl = require('./ts_clearance.js');
const fsStore = require('./ts_clearance_filestore.js');

const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const store = fsStore.makeFileStore(cfg.dir, { lockWaitMs: 5000 });

// 每个进程独立登记 signer 密钥（模拟：各进程从服务端配置各自装载，不得由请求携带）
cl.clearTrustedSigners();
cl.trustSigner('rita', cfg.secret, { now: cfg.now });
cl._setDefaultSecret(cfg.secret);

const lock = cl.makeHeldLock(cfg.lockId, { secret: cfg.secret, domain: 'period-lock/guard' });
let out;
try {
  out = cl.consumeClearance(cfg.token, {
    jobId: cfg.scope.jobId,
    rowSetDigest: cfg.scope.rowSetDigest,
    snapshotFingerprint: cfg.scope.snapshotFingerprint,
    lockId: cfg.lockId,
    lockDomain: 'period-lock/guard',
    lock: lock,
    lockVerify: (id, dom, epoch) => ({ held: true, epoch: epoch }),
    store: store,
    consumer: 'pid' + process.pid,
    // 注入时钟必须与签发时钟同源（否则按 IssuedAt+ttl 判定已过期 ⇒ 掩盖真实竞态语义）
    now: cfg.now != null ? cfg.now : Date.now(),
  });
} catch (e) {
  out = { ok: false, reason: 'CHILD_THREW', detail: String(e && e.message || e) };
}

const outPath = path.join(os.tmpdir(), process.argv[3]);
fs.writeFileSync(outPath, JSON.stringify({ pid: process.pid, out: out }));
process.stdout.write('child-done');
