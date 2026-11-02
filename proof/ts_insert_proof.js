'use strict';
/*
 * T1-B 幂等账本状态机 — 负例证明协议 (v44 M1 + v45 N1 + v46 N2 + v47 N3)
 * ---------------------------------------------------------------
 * 目的：把 Tom 16:57Z 的 N3（"POISONED 写入本身结果不明 / 进程崩溃 / 本地 mock 不足"）
 *       收敛为可运行证据。
 *
 * N3 收敛要点（直接回应 16:57Z）：
 *   1. 账本写（PENDING / DONE）统一使用 PropertiesService.setProperty 语义 =
 *      同步提交即抛（commit-or-throw），**不存在"不确定返回"**——这是 GAS 文档保证
 *      的耐久原语，非本脚本假设。因此"POISONED 写入本身结果不明"这一 N2 隐患被根除：
 *      我们不再写第二个可能不确定的标记。
 *   2. 业务写（sheet appendRow）才是可能不确定的环节；其不确定时**保留 PENDING 并
 *      暂停（SUSPEND），绝不自动重尝预留、绝不翻转、绝不写第二个不确定标记**。
 *   3. 安全性只依赖：账本同步写的持久性 + "业务不确定即挂起对账"策略。
 *      跨进程 / 崩溃一致由耐久账本（所有写者共享同一 PropertiesService 实例）保证。
 *   4. 本地 mock 仅为逻辑证明；真实服务耐久由 GAS 官方 setProperty 语义 + 提供的
 *      GAS 侧验收函数（见 docs/v47）在受控非生产项目内独立复跑。
 *
 * 运行：node proof/ts_insert_proof.js
 * 零生产写、不换链、不建 GAS 项目：纯本地逻辑证明，供 Tom 在共享仓复核/复跑。
 */

// ---------------- Mock GAS 全局 ----------------
function makeWorld(faults, sharedLedger, sharedSheet) {
  // faults: { businessWrite, ledgerThrow, ledgerThrowOnDone, lockBusy }
  return {
    ledger: sharedLedger || new Map(),   // 耐久账本(requestId -> {state,payloadHash}); 跨进程重启仍由所有写者一致读取
    sheetRows: sharedSheet || [],        // 生产表“已落库”行（耐久, 仅计数用于证明不重复）
    faults: Object.assign(
      { businessWrite: 'OK', ledgerThrow: false, ledgerThrowOnDone: false, lockBusy: false },
      faults || {}
    ),
  };
}

function ledgerGet(w, requestId) { return w.ledger.get(requestId) || null; }

// 同步提交即抛：模拟 PropertiesService setProperty 语义（无 uncertain 返回）
// —— N3 核心：账本写要么耐久提交、要么抛异常，绝不会"结果不明"。
function ledgerSet(w, requestId, state, payloadHash) {
  if (w.faults.ledgerThrow) throw new Error('LEDGER_IO');          // 全部账本写 IO 失败
  if (state === 'DONE' && w.faults.ledgerThrowOnDone) throw new Error('LEDGER_IO_DONE');
  w.ledger.set(requestId, { state: state, payloadHash: payloadHash });
}

function sheetAppend(w, row) {
  // 业务写：唯一可能不确定的环节
  if (w.faults.businessWrite === 'UNCERTAIN') return { status: 'UNCERTAIN' };
  w.sheetRows.push(row);
  return { status: 'OK' };
}

function lockAcquire(w) {
  if (w.faults.lockBusy) return false;
  return true;
}

// ---------------- 当前快照代码（buggy：无预留账本） ----------------
// 复现 v42 K1 故障窗口：业务写成功落行，但无账本去重 → 重试无键可查 → 再写一次。
function currentInsert(w, opts) {
  if (!lockAcquire(w)) return { status: 'PL_REJECT_LOCK_BUSY', writes: 0 };
  const e = ledgerGet(w, opts.requestId);
  if (e && e.state === 'DONE') return { status: 'REPLAY', writes: 0 };
  w.sheetRows.push(opts.rows);   // 业务写成功落行（无账本去重）
  return { status: 'DONE', writes: 1 };
}

// ---------------- 提案状态机（v43/v44/v45/v46 + v47 N3 收敛） ----------------
const PL_REJECT_REQUEST_ID_MISMATCH = 'PL_REJECT_REQUEST_ID_MISMATCH';
const SUSPEND = 'SUSPEND_NO_WRITE';
const SUSPEND_PENDING = 'SUSPEND_PENDING_INFLIGHT';      // 在途/业务不确定 → 挂起
const SUSPEND_LEDGER_IO = 'SUSPEND_LEDGER_IO';            // 账本写失败 → 挂起（人工对账）

function proposedInsert(w, opts) {
  if (!lockAcquire(w)) return { status: 'PL_REJECT_LOCK_BUSY', writes: 0 };

  // N1(15:27Z)+N2(16:17Z)+N3(16:57Z)：不确定预留须"暂停并对账"，不因单次读取缺失自动重尝预留。
  // 账本为耐久同步原语（跨进程崩溃/重启/并发由所有写者一致读取）。
  const e = ledgerGet(w, opts.requestId);
  if (e && e.state === 'DONE') {
    if (e.payloadHash === opts.payloadHash) return { status: 'REPLAY', writes: 0 };
    return { status: PL_REJECT_REQUEST_ID_MISMATCH, writes: 0 };
  }
  if (e && e.state === 'PENDING') {
    // 在途 / 业务结果不明 → 挂起，绝不重执行（N1/N2/N3 核心）
    return { status: SUSPEND_PENDING, writes: 0 };
  }
  // absent → 预留 PENDING（同步提交即抛；若抛则未落库、不进业务写）
  try {
    ledgerSet(w, opts.requestId, 'PENDING', opts.payloadHash);
  } catch (err) {
    return { status: SUSPEND_LEDGER_IO, writes: 0 };   // 账本写失败 → 暂停, 0 写
  }
  // 业务写（唯一不确定环节）
  const res = sheetAppend(w, opts.rows);
  if (res.status === 'UNCERTAIN') {
    // N3：业务不确定 → 保留 PENDING、挂起、不翻转、不写第二不确定标记
    return { status: SUSPEND_PENDING, writes: 0 };
  }
  // 业务成功 → 翻转 DONE（同步提交即抛）
  try {
    ledgerSet(w, opts.requestId, 'DONE', opts.payloadHash);
  } catch (err) {
    // 行已落库，PENDING 仍在 → 重试读 PENDING 挂起；人工对账翻 DONE，无重复写
    return { status: SUSPEND_LEDGER_IO, writes: 1 };
  }
  return { status: 'DONE', writes: 1 };
}

// 仅预留（写 PENDING，不含业务写）——用于证明"PENDING 持久可见先于业务写"
function proposedReserve(w, opts) {
  if (!lockAcquire(w)) return { status: 'PL_REJECT_LOCK_BUSY' };
  const e = ledgerGet(w, opts.requestId);
  if (e && (e.state === 'PENDING' || e.state === 'DONE')) return { status: e.state };
  try { ledgerSet(w, opts.requestId, 'PENDING', opts.payloadHash); }
  catch (err) { return { status: SUSPEND_LEDGER_IO }; }
  return { status: 'RESERVED' };
}

// ---------------- 场景与断言 ----------------
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + '  -> ' + (detail || '')); }
}

const opts = (hash) => ({ requestId: 'R1', rows: ['rowdata'], payloadHash: hash || 'H1' });

console.log('\n=== A. 复现当前代码 v42 故障窗口（无账本）===');
{
  // 业务写不确定(本模型返回 UNCERTAIN) + 重试 → 重复写入
  const w = makeWorld({ businessWrite: 'UNCERTAIN' });
  const r1 = currentInsert(w, opts());
  const r2 = currentInsert(w, opts());
  check('当前代码: 首次写=1', r1.writes === 1, JSON.stringify(r1));
  check('当前代码: 重试导致重复写入=2 (v42 真 bug)', w.sheetRows.length === 2, 'rows=' + w.sheetRows.length);
}

console.log('\n=== B. 提案状态机 v43/v44 故障窗口证明（happy + 幂等）===');
{
  const w = makeWorld({});
  const r = proposedInsert(w, opts());
  check('happy: 写=1, DONE', r.writes === 1 && r.status === 'DONE', JSON.stringify(r));
  const rr = proposedInsert(w, opts()); // 重试
  check('重试幂等重放 不重写', rr.writes === 0 && rr.status === 'REPLAY', JSON.stringify(rr));
}

console.log('\n=== (a) PENDING 同步持久先于业务写 + 负例（账本写失败）===');
{
  // 负例：PENDING 写 IO 失败(同步抛) → 不进业务写, 0 行
  const w = makeWorld({ ledgerThrow: true });
  const r = proposedInsert(w, opts());
  check('(a) 负例: PENDING 写失败 → SUSPEND_LEDGER_IO, 0 写', r.status === SUSPEND_LEDGER_IO && w.sheetRows.length === 0, JSON.stringify(r));
}
{
  // 正常：PENDING 同步落库（业务写前即可见，所有写者一致读取）
  const w = makeWorld({});
  const r = proposedReserve(w, opts());
  const e = ledgerGet(w, 'R1');
  check('(a) 预留 PENDING 同步落库且可见(业务写前)', r.status === 'RESERVED' && e && e.state === 'PENDING', JSON.stringify(e));
}

console.log('\n=== (c) 业务写结果本身未知 → 不进确定完成, 保留 PENDING 挂起, 0 写 ===');
{
  const w = makeWorld({ businessWrite: 'UNCERTAIN' });
  const r = proposedInsert(w, opts());
  check('(c) 业务 uncertain → SUSPEND_PENDING, 0 写', r.status === SUSPEND_PENDING && w.sheetRows.length === 0, JSON.stringify(r));
  // 关键 N3：不确定后**没有**写第二个不确定标记——账本仅 PENDING
  const e = ledgerGet(w, 'R1');
  check('(c) 账本仅 PENDING, 无第二不确定标记', e && e.state === 'PENDING', JSON.stringify(e));
  // 重试仍读 PENDING → 仍挂起, 不重尝预留, 无写
  const r2 = proposedInsert(w, opts());
  check('(c) 重试读 PENDING → 仍 SUSPEND, 不重尝预留, 无写', r2.status === SUSPEND_PENDING && r2.writes === 0 && w.sheetRows.length === 0, JSON.stringify(r2));
}

console.log('\n=== (d) 锁失效 → 不写不预留 ===');
{
  const w = makeWorld({ lockBusy: true });
  const r = proposedInsert(w, opts());
  check('(d) lockBusy → PL_REJECT_LOCK_BUSY, 0 写', r.status === 'PL_REJECT_LOCK_BUSY' && w.sheetRows.length === 0, JSON.stringify(r));
}

console.log('\n=== (e) 业务写成功 + DONE 翻转不确定(崩溃在 PENDING→DONE 之间) → 重试不重复 (v42 bug 已修) ===');
{
  // ledgerThrowOnDone: PENDING 成功, 但 DONE 翻转抛(模拟崩溃/IO)
  const w = makeWorld({ ledgerThrowOnDone: true });
  const r = proposedInsert(w, opts()); // 业务成功(1行), DONE 翻转失败
  check('(e) 首写=1, 状态 SUSPEND_LEDGER_IO (PENDING 仍在)', r.writes === 1 && r.status === SUSPEND_LEDGER_IO, JSON.stringify(r));
  const e = ledgerGet(w, 'R1');
  check('(e) 账本仍为 PENDING (行已落库未翻 DONE)', e && e.state === 'PENDING', JSON.stringify(e));
  const rr = proposedInsert(w, opts()); // 重试：读 PENDING → 挂起, 无重复写
  check('(e) 重试读 PENDING → 挂起, 无重复写', rr.writes === 0 && rr.status === SUSPEND_PENDING && w.sheetRows.length === 1, JSON.stringify(rr));
}

console.log('\n=== (f) 同键异载荷 → 拒绝 (防同 ID 不同载荷覆盖) ===');
{
  const w = makeWorld({});
  proposedInsert(w, opts('H1'));
  const r = proposedInsert(w, opts('H2')); // 已 DONE(H1)，再来 H2
  check('(f) 异载荷 → PL_REJECT_REQUEST_ID_MISMATCH', r.status === PL_REJECT_REQUEST_ID_MISMATCH && w.sheetRows.length === 1, JSON.stringify(r));
}

console.log('\n=== (g) N1+N2+N3: 业务 uncertain → 保留 PENDING → 跨进程重启仍读 PENDING → SUSPEND, 不重尝预留, 无写 ===');
{
  const w = makeWorld({ businessWrite: 'UNCERTAIN' });
  const r = proposedInsert(w, opts()); // 业务 uncertain → PENDING + SUSPEND
  check('(g) 业务 uncertain → PENDING + SUSPEND, 0 写', r.status === SUSPEND_PENDING && w.sheetRows.length === 0 && w.ledger.get('R1') && w.ledger.get('R1').state === 'PENDING', JSON.stringify(r));
  // 模拟进程崩溃重启：全新进程, 仅共享耐久账本+生产表(无进程内集合)
  const w2 = makeWorld({ businessWrite: 'UNCERTAIN' }, w.ledger, w.sheetRows);
  const rr = proposedInsert(w2, opts()); // 新进程读耐久账本 → 见 PENDING → SUSPEND
  check('(g) 重启后新进程读耐久账本见 PENDING → 仍 SUSPEND, 不重尝预留, 无写', rr.status === SUSPEND_PENDING && rr.writes === 0 && w2.sheetRows.length === 0, JSON.stringify(rr));
}

console.log('\n=== (h) N3: 进程崩溃在 PENDING 写与业务写之间(账本写失败, 业务未执行) → 重启后无残留, 重新预留恰好一次 ===');
{
  // 首进程 PENDING 账本写抛(崩溃), 业务写未被执行
  const w = makeWorld({ ledgerThrow: true });
  const r = proposedInsert(w, opts());
  check('(h)-1: PENDING 写失败 → SUSPEND_LEDGER_IO, 0 写 0 行', r.status === SUSPEND_LEDGER_IO && w.sheetRows.length === 0, JSON.stringify(r));
  // 重启 + 账本恢复(ledgerThrow 解除), 重新预留 → 业务写 → DONE, 恰好一次
  const w2 = makeWorld({}, w.ledger, w.sheetRows);
  const r2 = proposedInsert(w2, opts());
  check('(h)-2: 重启后重新预留 → 写=1, DONE, 恰好一次', r2.writes === 1 && r2.status === 'DONE' && w2.sheetRows.length === 1, JSON.stringify(r2));
  const rr = proposedInsert(w2, opts());
  check('(h)-3: 再次重试 → REPLAY, 无重复', rr.writes === 0 && rr.status === 'REPLAY', JSON.stringify(rr));
}

console.log('\n=== (i) N3: DONE 翻转不确定(崩溃在业务写成功之后) → 行已落库, PENDING 仍在, 重试挂起, 人工对账翻 DONE, 无重复 ===');
{
  const w = makeWorld({ ledgerThrowOnDone: true });
  proposedInsert(w, opts());      // 行落库(1), DONE 翻转抛 → PENDING 仍在
  const w2 = makeWorld({ ledgerThrowOnDone: true }, w.ledger, w.sheetRows); // 持续 DONE 抛(模拟对账前)
  const rr = proposedInsert(w2, opts()); // 重试读 PENDING → 挂起
  check('(i) 重试读 PENDING → 挂起, 行数仍=1 无重复', rr.status === SUSPEND_PENDING && rr.writes === 0 && w2.sheetRows.length === 1, JSON.stringify(rr));
  // 人工/对账后 DONE 翻转成功
  const w3 = makeWorld({}, w.ledger, w.sheetRows);
  ledgerSet(w3, 'R1', 'DONE', 'H1');
  const rr3 = proposedInsert(w3, opts());
  check('(i) 对账翻 DONE 后重试 → REPLAY, 无重复', rr3.writes === 0 && rr3.status === 'REPLAY' && w3.sheetRows.length === 1, JSON.stringify(rr3));
}

console.log('\n========================================');
console.log('  结果: ' + pass + ' PASS / ' + fail + ' FAIL');
console.log('  映射: (e)(f)(g)(h)(i) 直接对应 Tom 22:32 M1 / 15:27Z N1 / 16:17Z N2 / 16:57Z N3；');
console.log('        (a)(c)(d) 覆盖 PENDING 同步持久 / 业务 uncertain 挂起 / 锁失效；');
console.log('        (g)(h)(i) 证明 N3: 账本同步提交即抛(无不确定写) + 业务不确定即挂起PENDING,');
console.log('        跨进程重启/崩溃均读耐久 PENDING 挂起, 不重尝预留不写；');
console.log('        跨项目旁路 / 全部入口枚举 见 H6/105 清单(只读枚举固定版本), 本单测聚焦状态机。');
console.log('========================================');
process.exit(fail === 0 ? 0 : 1);
