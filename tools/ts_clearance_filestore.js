#!/usr/bin/env node
'use strict';
//
// 【跨进程】clearance 消费台账原型（回应 Tom 2101 #2 / #4）
//
// 为什么要有这个文件（Tom 2101 #2 的具体批评）：
//   tools/ts_clearance.js 默认台账是【内存 Map】，进程重启即丢失，跨进程互不可见，
//   因此「同一个 nonce 只能被消费一次」在真实多进程/重启场景下**没有任何证据**。
//   本文件提供【文件级持久 + 互斥写】参考实现，让下列两件事可以被真正跑出来：
//     · 重启一致性：进程 A 写入 → 进程 B（全新进程）仍能读到同一记录；
//     · 竞态互斥：N 个进程同时消费同一 token → 恰好 1 个成功，其余 CONSUME_RACE_REJECTED。
//
// 诚实边界（不得夸大）：
//   · 这是【本地文件系统】实现，**不等于** GAS PropertiesService 的服务端持久账本；
//   · 互斥靠【锁文件 O_EXCL + 原子 rename】实现，仅在本机文件系统语义下成立；
//     网络文件系统/不同挂载点的语义差异未评估 ⇒ 生产落地前不得以本文件充当服务器端证据；
//   · PROTOTYPE_ONLY = true：不得在生产路径启用。
//
// 本文件只写 _tmp 下的本地目录，零生产写、零网络写、不触碰 GAS。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROTOTYPE_ONLY = true;
const STALE_LOCK_MS = 5000;

function _sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

function _safe(key) { return _sha256(String(key)).slice(0, 40); }

function _canon(o) {
  if (o === null || o === undefined) return 'null';
  if (typeof o !== 'object') return JSON.stringify(o);
  const keys = Object.keys(o).sort();
  const out = {};
  for (const k of keys) out[k] = o[k];
  return JSON.stringify(out);
}

function makeFileStore(dir, opts) {
  opts = opts || {};
  fs.mkdirSync(dir, { recursive: true });
  const staleMs = opts.staleLockMs != null ? opts.staleLockMs : STALE_LOCK_MS;

  const recPath = (k) => path.join(dir, _safe(k) + '.json');
  const lockPath = (k) => path.join(dir, _safe(k) + '.lock');

  function _acquire(k) {
    const lp = lockPath(k);
    const deadline = Date.now() + (opts.lockWaitMs != null ? opts.lockWaitMs : 3000);
    for (;;) {
      try {
        const fd = fs.openSync(lp, 'wx');
        try { fs.writeSync(fd, String(process.pid) + '|' + Date.now()); } finally { fs.closeSync(fd); }
        return true;
      } catch (e) {
        if (e && (e.code === 'EEXIST' || e.code === 'EACCES')) {
          // stale lock 回收：仅限明确超过 stale 窗口的锁文件（防止崩溃残留导致永久死锁）
          try {
            const st = fs.statSync(lp);
            if (Date.now() - st.mtimeMs > staleMs) { fs.unlinkSync(lp); continue; }
          } catch (e2) { /* 锁文件在此瞬间消失 → 下一轮重试 */ }
          if (Date.now() > deadline) return false;
          continue;
        }
        throw e;
      }
    }
  }

  function _release(k) {
    try { fs.unlinkSync(lockPath(k)); } catch (e) { /* 已释放 */ }
  }

  function _read(k) {
    try { return JSON.parse(fs.readFileSync(recPath(k), 'utf8')); }
    catch (e) { return null; }
  }

  function _writeAtomic(k, rec) {
    const rp = recPath(k);
    const tmp = rp + '.tmp.' + process.pid + '.' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(rec));
    fs.renameSync(tmp, rp);
  }

  return {
    PROTOTYPE_ONLY,
    dir,
    get: (k) => _read(k),
    set: (k, v) => {
      if (!_acquire(k)) throw new Error('FILESTORE_LOCK_TIMEOUT');
      try { _writeAtomic(k, v); } finally { _release(k); }
      return true;
    },
    // 原子 compare-and-set：读数 / 比对 / 落盘全在同一把文件锁内；不同则 false
    cas: (k, expect, next) => {
      if (!_acquire(k)) return false;
      try {
        const cur = _read(k);
        const curCanon = cur === null ? 'null' : _canon(cur);
        const expCanon = expect === null || expect === undefined ? 'null' : _canon(expect);
        if (curCanon !== expCanon) return false;
        _writeAtomic(k, next);
        return true;
      } finally { _release(k); }
    },
    keys: () => fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')),
    raw: { recPath, lockPath, _canon },
  };
}

module.exports = { PROTOTYPE_ONLY, makeFileStore, _canon, _sha256 };
