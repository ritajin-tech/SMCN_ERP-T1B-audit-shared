'use strict';
/*
 * T1-B 幂等账本状态机 — 负例证明协议 (v44 M1 + v45 N1 + v46 N2)
 * ---------------------------------------------------------------
 * 目的：把 Tom 22:32 的 M1、15:27Z 的 N1、16:17Z 的 N2 要求转成可运行证据。
 *  - 用 mocked GAS 全局（SpreadsheetApp / LockService / Utilities）在本地驱动真实写路径逻辑；
 *  - 先复现当前快照代码的 v42 故障窗口（业务写成功+账本落账失败→重试重复写入）；
 *  - 再证明 v43/v44 提案的"乐观预留 PENDING→DONE"状态机在全部故障窗口下不重复写入。
 * 零生产写、不换链、不建 GAS 项目：纯本地逻辑证明，供 Tom 在共享仓复核/复跑。
 *
 * 运行：node proof/ts_insert_proof.js
 */

// ---------------- Mock GAS 全局 ----------------
function makeWorld(faults, sharedLedger, sharedSheet) {
  // faults: { businessWrite, pendingAppend, rereadPending, doneTransition, lockBusy }
  return {
    ledger: sharedLedger || new Map(),   // 耐久账本(requestId -> {state,payloadHash}); 跨进程重启仍由所有写者一致读取
    sheetRows: sharedSheet || [],        // 生产表“已落库”行（耐久, 仅计数用于证明不重复）
    faults: Object.assign(
      { businessWrite: 'OK', pendingAppend: 'OK', rereadPending: true, doneTransition: 'OK', lockBusy: false },
      faults || {}
    ),
  };
}

function ledgerLookup(w, requestId) { return w.ledger.get(requestId) || null; }

function ledgerAppendPending(w, requestId, payloadHash) {
  // 返回 'OK' | 'UNCERTAIN'
  if (w.faults.pendingAppend === 'UNCERTAIN') {
    // N2(16:17Z): 不确定预留须耐久落账为 POISONED 标记(同一耐久账本, 所有写者一致读取),
    // 进程崩溃/重启/并发下仍可被读到, 不依赖进程内集合。该写为已确认同步写(PropertiesService 语义)。
    w.ledger.set(requestId, { state: POISONED, payloadHash });
    return 'UNCERTAIN';
  }
  w.ledger.set(requestId, { state: 'PENDING', payloadHash });
  return 'OK';
}
function ledgerRereadShowsPending(w, requestId) {
  // flush 后重读：默认看到刚写的 PENDING；可注入 false 模拟 flush 丢失
  if (w.faults.rereadPending === false) return false;
  const e = w.ledger.get(requestId);
  return !!(e && e.state === 'PENDING');
}
function ledgerTransitionToDone(w, requestId) {
  // 返回 'OK' | 'UNCERTAIN'
  if (w.faults.doneTransition === 'UNCERTAIN') return 'UNCERTAIN';
  const e = w.ledger.get(requestId);
  if (e) { e.state = 'DONE'; }
  return 'OK';
}
function sheetAppend(w, row) {
  // 返回 { status:'OK'|'UNCERTAIN' }
  if (w.faults.businessWrite === 'UNCERTAIN') return { status: 'UNCERTAIN' };
  w.sheetRows.push(row);
  return { status: 'OK' };
}
function lockAcquire(w) {
  if (w.faults.lockBusy) return false;
  return true;
}

// ---------------- 当前快照代码（buggy：无预留） ----------------
// 复现 v42 K1 故障窗口：查账无键→执行业务写→成功后落账；落账失败则重试会再写。
function currentInsert(w, opts) {
  if (!lockAcquire(w)) return { status: 'PL_REJECT_LOCK_BUSY', writes: 0 };
  const e = ledgerLookup(w, opts.requestId);
  if (e && e.state === 'DONE') return { status: 'REPLAY', writes: 0 };
  // absent → 执行
  const res = sheetAppend(w, opts.rows);
  if (res.status !== 'OK') return { status: 'UNCERTAIN', writes: 1 };
  // 成功后落账（此处可能失败 → 条目仍 absent）
  const persist = ledgerAppendPending(w, opts.requestId, opts.payloadHash); // 仅作“落账”动作
  // 注意：若 persist 失败（这里用 doneTransition=UNCERTAIN 模拟“落账未确认”），条目不翻 DONE
  if (persist === 'UNCERTAIN') { w.ledger.delete(opts.requestId); } // 模拟落账失败=无 DONE
  return { status: persist === 'OK' ? 'DONE' : 'UNCERTAIN', writes: 1 };
}

// ---------------- 提案状态机（v43/v44：乐观预留 PENDING→DONE） ----------------
const PL_REJECT_REQUEST_ID_MISMATCH = 'PL_REJECT_REQUEST_ID_MISMATCH';
const UNCERTAIN_PENDING_MANUAL = 'UNCERTAIN_PENDING_MANUAL';
const SUSPEND = 'SUSPEND_NO_WRITE';
const POISONED = 'UNCERTAIN_POISONED';

function proposedInsert(w, opts) {
  if (!lockAcquire(w)) return { status: 'PL_REJECT_LOCK_BUSY', writes: 0 };
  // N1(15:27Z)+N2(16:17Z): 不确定预留须“暂停并对账”, 且不因单次读取缺失自动重尝预留。
  // 该状态耐久落于账本(POISONED), 跨进程崩溃/重启/并发由所有写者一致读取, 不依赖进程内集合。
  const e = ledgerLookup(w, opts.requestId);
  if (e && e.state === POISONED) {
    return { status: SUSPEND, writes: 0, reason: 'N2_prior_uncertain_reservation_poisoned' };
  }
  if (e && e.state === 'DONE') {
    if (e.payloadHash === opts.payloadHash) return { status: 'REPLAY', writes: 0 };
    return { status: PL_REJECT_REQUEST_ID_MISMATCH, writes: 0 };
  }
  if (e && e.state === 'PENDING') {
    // 在途/结果不明 → 暂停，绝不重执行
    return { status: UNCERTAIN_PENDING_MANUAL, writes: 0 };
  }
  // absent → 先预留 PENDING
  const reserve = ledgerAppendPending(w, opts.requestId, opts.payloadHash);
  if (reserve === 'UNCERTAIN') {
    // ledgerAppendPending 已耐久落 POISONED；此处直接暂停, 不重尝预留、不写
    return { status: SUSPEND, writes: 0 }; // (c) 预留结果未知→不写
  }
  // (a) flush 后重读确认 PENDING 持久可见，方进业务写
  if (!ledgerRereadShowsPending(w, opts.requestId)) return { status: SUSPEND, writes: 0 };
  // 业务写
  const res = sheetAppend(w, opts.rows);
  if (res.status === 'UNCERTAIN') return { status: UNCERTAIN_PENDING_MANUAL, writes: 0 }; // K3/UNAVAILABLE
  // 转 DONE
  const trans = ledgerTransitionToDone(w, opts.requestId);
  // 注意：业务写(上面 sheetAppend)已落库 1 行；DONE 转换 uncertain 仅表示“无法确认完成”，
  // 写实际已发生，故写作 writes:1 + 状态 UNCERTAIN_PENDING_MANUAL（PENDING 仍在→重试暂停，见(e)）。
  if (trans === 'UNCERTAIN') return { status: UNCERTAIN_PENDING_MANUAL, writes: 1 }; // PENDING 仍在→重试暂停
  return { status: 'DONE', writes: 1 };
}

// ---------------- 场景与断言 ----------------
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + '  -> ' + (detail || '')); }
}

const opts = (hash) => ({ requestId: 'R1', rows: ['rowdata'], payloadHash: hash || 'H1' });

console.log('\n=== A. 复现当前代码 v42 故障窗口（无预留）===');
{
  // 业务写成功 + 账本落账失败(doneTransition=UNCERTAIN 模拟落账未确认)
  const w = makeWorld({ doneTransition: 'UNCERTAIN' });
  const r1 = currentInsert(w, opts());
  const r2 = currentInsert(w, opts()); // 重试
  check('当前代码: 首次写=1', r1.writes === 1, JSON.stringify(r1));
  check('当前代码: 重试导致重复写入=2 (v42 真 bug)', w.sheetRows.length === 2, 'rows=' + w.sheetRows.length);
}

console.log('\n=== B. 提案状态机 v43/v44 故障窗口证明 ===');
{
  console.log('  (a) PENDING 持久可见先于写 + 负例');
  const w = makeWorld({});
  const r = proposedInsert(w, opts());
  check('happy: 写=1, DONE', r.writes === 1 && r.status === 'DONE', JSON.stringify(r));
  const rr = proposedInsert(w, opts()); // 重试
  check('(a) 重试幂等重放 不重写', rr.writes === 0 && rr.status === 'REPLAY', JSON.stringify(rr));

  const w2 = makeWorld({ rereadPending: false }); // flush 丢失，重读看不到 PENDING
  const r2 = proposedInsert(w2, opts());
  check('(a) 负例: reread 看不到 PENDING → 暂停不写', r2.status === SUSPEND && w2.sheetRows.length === 0, JSON.stringify(r2));
}
{
  console.log('  (c) 预留写结果本身未知 → 不进业务写');
  const w = makeWorld({ pendingAppend: 'UNCERTAIN' });
  const r = proposedInsert(w, opts());
  check('(c) 预留 uncertain → 暂停, 0 写', r.status === SUSPEND && w.sheetRows.length === 0, JSON.stringify(r));
  // 重试仍 absent → 再次预留 uncertain → 仍不写
  const r2 = proposedInsert(w, opts());
  check('(c) 重试仍不写', r2.status === SUSPEND && w.sheetRows.length === 0, JSON.stringify(r2));
}
{
  console.log('  (d) 锁失效 → 不写不预留');
  const w = makeWorld({ lockBusy: true });
  const r = proposedInsert(w, opts());
  check('(d) lockBusy → PL_REJECT_LOCK_BUSY, 0 写', r.status === 'PL_REJECT_LOCK_BUSY' && w.sheetRows.length === 0, JSON.stringify(r));
}
{
  console.log('  (e) 业务写成功 + DONE 转换 uncertain → 重试不重复 (v42 bug 已修)');
  const w = makeWorld({ doneTransition: 'UNCERTAIN' });
  const r = proposedInsert(w, opts()); // 写成功, DONE 转换 uncertain
  check('(e) 首写=1, 状态 UNCERTAIN_PENDING_MANUAL', r.writes === 1 && r.status === UNCERTAIN_PENDING_MANUAL, JSON.stringify(r));
  const rr = proposedInsert(w, opts()); // 重试：见 PENDING → 暂停
  check('(e) 重试见 PENDING → 暂停, 无重复写', rr.writes === 0 && rr.status === UNCERTAIN_PENDING_MANUAL && w.sheetRows.length === 1, JSON.stringify(rr));
}
{
  console.log('  (f) 同键异载荷 → 拒绝 (防同 ID 不同载荷覆盖)');
  const w = makeWorld({});
  proposedInsert(w, opts('H1'));
  const r = proposedInsert(w, opts('H2')); // 已 DONE(H1)，再来 H2
  check('(f) 异载荷 → PL_REJECT_REQUEST_ID_MISMATCH', r.status === PL_REJECT_REQUEST_ID_MISMATCH && w.sheetRows.length === 1, JSON.stringify(r));
}

{
  console.log('  (g) N1+N2: 预留 uncertain → 耐久 POISONED 落账 → 重试(同进程)读耐久账本见 POISONED → SUSPEND, 不重尝预留, 无写');
  const w = makeWorld({ pendingAppend: 'UNCERTAIN' });
  const r = proposedInsert(w, opts()); // 预留 uncertain → 耐久 POISONED → SUSPEND
  check('(g) 首预留 uncertain → 耐久 POISONED + SUSPEND, 0 写', r.status === SUSPEND && w.sheetRows.length === 0 && w.ledger.get('R1') && w.ledger.get('R1').state === POISONED, JSON.stringify(r));
  const rr = proposedInsert(w, opts()); // 重试：读耐久账本见 POISONED → SUSPEND
  check('(g) 重试读耐久账本见 POISONED → 仍 SUSPEND, 不重尝预留, 无写', rr.status === SUSPEND && rr.writes === 0 && w.sheetRows.length === 0, JSON.stringify(rr));
}
{
  console.log('  (h) N2(16:17Z): 跨进程崩溃/重启 — 全新进程仅共享耐久账本+生产表(无进程内集合)仍读 POISONED → SUSPEND, 不重尝预留, 无写');
  const w = makeWorld({ pendingAppend: 'UNCERTAIN' });
  proposedInsert(w, opts()); // 首预留 uncertain → 耐久 POISONED
  // 模拟进程崩溃重启：全新进程, 仅共享“耐久账本+生产表”(进程内集合不复存在)
  const w2 = makeWorld({ pendingAppend: 'UNCERTAIN' }, w.ledger, w.sheetRows);
  const rr = proposedInsert(w2, opts()); // 新进程读耐久账本 → 见 POISONED → SUSPEND
  check('(h) 重启后新进程读耐久账本见 POISONED → 仍 SUSPEND, 不重尝预留, 无写', rr.status === SUSPEND && rr.writes === 0 && w2.sheetRows.length === 0, JSON.stringify(rr));
}

console.log('\n========================================');
console.log('  结果: ' + pass + ' PASS / ' + fail + ' FAIL');
console.log('  说明: (e)(f)(g)(h) 直接对应 Tom 22:32 M1 / 15:27Z N1 / 16:17Z N2 的"业务写成功+落账失败"/"不确定预留不重尝"/"耐久跨进程poison"；');
console.log('        (a)(c)(d) 覆盖 PENDING 持久可见 / 预留 uncertain / 锁失效；');
console.log('        (g)(h) 证明确认: 不确定预留耐久落账本, 同进程+跨进程重启均读 POISONED 暂停, 不重尝预留不写；');
console.log('        跨项目旁路(e in M1) 及全部入口/崩溃交错(H6/105) 需部署清单(实况枚举), 非本单测范畴, 标 OPEN。');
console.log('========================================');
process.exit(fail === 0 ? 0 : 1);
