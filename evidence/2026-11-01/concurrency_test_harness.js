#!/usr/bin/env node
'use strict';
/*
 * concurrency_test_harness.js — T1-B 并发重放负例（只读 / 自包含 / 零依赖）
 *
 * 目的：用可复现的方式证明事故根因，并验证 Edit A 修复：
 *   根因 = tsAppendRows 在锁外读 exist(:96-105) + 锁外定 toWrite(:108-117)，
 *         进 _plGuardedInsert(:127) 后未传 lockPreWrite → :494-498 锁内重核跳过
 *         → 两并发写者读到同一空 exist → 都判定可写 → 重复行。
 *   修复 = 传入 lockPreWrite 闭包，在锁内(:490 之后)重读 exist 并重判 toWrite，
 *         bizWrite(:509) 只写「锁内重判后」的行。
 *
 * 运行：node concurrency_test_harness.js   （仅需 Node.js，无需 npm install，零网络）
 * 安全：纯内存模拟 GAS 关键时序，不连接任何生产/线上系统。
 *
 * 说明：本脚本证明「进程内」锁语义（Edit A 充分）。Edit B（getDocumentLock 跨项目互斥）
 *       需要两个独立 GAS 项目 + 同表的真实实验，无法在 Node 单进程内证明，
 *       实验规范见 VERIFY_GUIDE.md §3。
 */

// ---------- 内存版「生产表」 ----------
function makeSheet() {
  return {
    rows: [],
    readExisting() { return new Set(this.rows.map(r => r.uuid)); },
    append(batch) { for (const r of batch) this.rows.push({ uuid: r.uuid }); }
  };
}

// ---------- 真实异步互斥锁（模拟 LockService 临界区语义） ----------
function makeMutex() {
  let locked = false;
  const waiters = [];
  return {
    async acquire() {
      if (!locked) { locked = true; return; }
      await new Promise(res => waiters.push(res));
    },
    release() {
      if (waiters.length) { const r = waiters.shift(); r(); }
      else locked = false;
    }
  };
}

// ========== 当前（有缺陷）tsAppendRows ==========
async function tsAppendRows_current(sheet, mutex, batch) {
  const exist = sheet.readExisting();          // :96-105 锁外读
  const toWrite = [];
  for (const r of batch) {
    if (exist.has(r.uuid)) continue;            // :111 锁外判定
    toWrite.push(r);
  }
  await mutex.acquire();                        // :490 锁内（但 exist 已是锁外快照）
  try {
    sheet.append(toWrite);                      // :509 bizWrite（写锁外的 toWrite）
  } finally { mutex.release(); }
  return toWrite.length;
}

// ========== 修复后（Edit A）tsAppendRows ==========
async function tsAppendRows_fixed(sheet, mutex, batch) {
  const exist0 = sheet.readExisting();
  let toWrite = [];
  for (const r of batch) {
    if (exist0.has(r.uuid)) continue;
    toWrite.push(r);
  }
  await mutex.acquire();                        // :490 锁内
  let wrote = 0;
  try {
    // lockPreWrite 闭包（:494-498）：锁内重读 exist 并重判 toWrite
    const existInside = sheet.readExisting();
    const finalWrite = [];
    for (const r of toWrite) {
      if (existInside.has(r.uuid)) continue;    // 锁内重判：并发者已写的行判为重放
      finalWrite.push(r);
    }
    sheet.append(finalWrite);                   // :509 bizWrite（写锁内 finalWrite）
    wrote = finalWrite.length;
  } finally { mutex.release(); }
  return { wrote };
}

// ---------- 测试 1：确定性交错（展示竞态时序） ----------
function testInterleave() {
  console.log('--- 测试1：确定性交错（两并发写者，同批新 UUID A,B） ---');
  const batch = [{ uuid: 'A' }, { uuid: 'B' }];

  // 当前代码时序：T1读→T1算→T2读→T2算→T1写→T2写
  const s1 = makeSheet();
  const e1 = s1.readExisting(); const t1 = batch.filter(r => !e1.has(r.uuid));
  const e2 = s1.readExisting(); const t2 = batch.filter(r => !e2.has(r.uuid));
  s1.append(t1); s1.append(t2);
  console.log('  当前代码 → 行数', s1.rows.length, '(期望 4 = 含 2 重复)');

  // 修复代码时序：T1读→算→锁内重读→写；T2读→算→锁内重读(见A,B已存在)→写0
  const s2 = makeSheet();
  let w1 = batch.filter(r => !s2.readExisting().has(r.uuid));
  w1 = w1.filter(r => !s2.readExisting().has(r.uuid)); s2.append(w1);
  let w2 = batch.filter(r => !s2.readExisting().has(r.uuid));
  w2 = w2.filter(r => !s2.readExisting().has(r.uuid)); s2.append(w2);
  console.log('  修复代码 → 行数', s2.rows.length, '(期望 2 = 0 重复)');

  return s1.rows.length === 4 && s2.rows.length === 2;
}

// ---------- 测试 2：真实并发压力（50 并发写同一 UUID） ----------
async function testStress(impl, label) {
  const sheet = makeSheet();
  const mutex = makeMutex();
  const uuid = 'SAME-UUID';
  const N = 50;
  const batches = Array.from({ length: N }, () => [{ uuid }]);
  await Promise.all(batches.map(b => impl(sheet, mutex, b)));
  const uniq = new Set(sheet.rows.map(r => r.uuid));
  console.log(`  [${label}] 50 并发写同 UUID → 写入行数 ${sheet.rows.length}，唯一UUID ${uniq.size}`);
  return sheet.rows.length;
}

(async () => {
  console.log('=== T1-B 并发重放负例测试 (concurrency_test_harness) ===');
  const t1 = testInterleave();
  const cur = await testStress(tsAppendRows_current, '当前代码');
  const fix = await testStress(tsAppendRows_fixed, '修复(Edit A)');

  console.log('--- 结论 ---');
  const bugShown = cur > 1;                 // 当前：同 UUID 出现 >1 行 = 竞态存在
  const fixShown = fix === 1;               // 修复：仅 1 行 = 重放消除
  console.log('  当前代码产生重复行(竞态存在):', bugShown ? 'YES ✅' : 'NO ❌');
  console.log('  Edit A 修复消除重复(锁内重读):', fixShown ? 'YES ✅' : 'NO ❌');

  const pass = t1 && bugShown && fixShown;
  console.log('\nRESULT:', pass ? 'PASS ✅ (根因与修复均可复现)' : 'FAIL ❌');
  process.exit(pass ? 0 : 1);
})();
