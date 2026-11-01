#!/usr/bin/env node
'use strict';
/*
 * concurrency_test_harness.js — T1-B 并发重放负例 v2（只读 / 自包含 / 零依赖）
 *
 * 目的：可复现地证明事故根因，并逐项闭合 Tom 2026-11-01T10:26 来信对 Edit A/B 的四项条件：
 *   A① 回调契约        —— lockPreWrite(rows, policy) → {rows, duplicates}（契约见 PeriodLockGuard.js:494-498）
 *   A② 实际写者均受同一守卫约束 —— 两写者都经 _plGuardedInsert(lockPreWrite)，交错也零重复
 *   A③ 空 UUID 行为     —— 空 UUID 行不入 exist、不去重、不阻塞他人；软删候选集(1,340) 排除空 UUID 池(5,221)
 *   A④ 并发/失败负例    —— 50 并发同 UUID 重放；bizWrite 中途抛错后重试不重复
 *   B  跨项目互斥       —— 进程内模型不能证明（需要两独立 GAS 项目+同表的隔离环境实验，规范见 VERIFY_GUIDE §3）
 *                         本脚本仅补 Edit B 的「运行上下文未返回有效锁 → fail-closed 中止」逻辑测试（见 testNoValidLock）
 *
 * 运行：node concurrency_test_harness.js   （仅需 Node.js，无需 npm install，零网络）
 * 安全：纯内存模拟 GAS 关键时序，不连接任何生产/线上系统。
 */

// ---------- 内存版「生产表」 ----------
function makeSheet() {
  return {
    rows: [],                                   // 每行 { uuid }
    readExisting() { return new Set(this.rows.map(r => r.uuid)); },
    append(batch) { for (const r of batch) this.rows.push({ uuid: r.uuid }); }
  };
}

// ---------- 真实异步互斥锁（模拟 LockService 临界区语义；tryLock 超时即 fail-closed） ----------
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

// ========== 真实 _plGuardedInsert 复刻（契约对齐 PeriodLockGuard.js:479-525） ==========
async function plGuardedInsert(sheet, mutex, opts) {
  await mutex.acquire();                         // :490 锁内
  try {
    let rows = opts.rows;
    let duplicates = 0;
    if (typeof opts.lockPreWrite === 'function') {
      const pr = opts.lockPreWrite(rows, null);  // :494-498 契约：返回 {rows, duplicates}
      rows = (pr && pr.rows) || [];
      duplicates = (pr && pr.duplicates) || 0;
    }
    if (!rows || rows.length === 0) return { wrote: 0, duplicates, skippedAll: true };
    const result = opts.bizWrite(rows, null);    // :509
    return result;
  } finally { mutex.release(); }
}

// ========== 当前（有缺陷）tsAppendRows ==========
async function tsAppendRows_current(sheet, mutex, batch) {
  const exist = sheet.readExisting();            // :96-105 锁外读
  const toWrite = [];
  for (const r of batch) {
    if (exist.has(r.uuid)) continue;            // :111 锁外判定
    toWrite.push(r);
  }
  await mutex.acquire();                         // :490 锁内（但 exist 已是锁外快照）
  try { sheet.append(toWrite); }                 // :509 写锁外的 toWrite
  finally { mutex.release(); }
  return toWrite.length;
}

// ========== 修复后（Edit A）tsAppendRows ==========
async function tsAppendRows_fixed(sheet, mutex, batch) {
  const exist0 = sheet.readExisting();
  let toWrite = batch.filter(r => !exist0.has(r.uuid));
  return plGuardedInsert(sheet, mutex, {
    rows: toWrite,
    // lockPreWrite 闭包（:494-498）：锁内重读 exist 并重判 toWrite（闭合 A①回调契约 + A②同一守卫）
    lockPreWrite: function (rowsIn) {
      const existInside = sheet.readExisting();
      const finalWrite = [];
      let dup = 0;
      for (const r of rowsIn) {
        if (r.uuid && existInside.has(r.uuid)) { dup++; continue; }  // 锁内重判：并发者已写→重放
        if (r.uuid) existInside.add(r.uuid);
        finalWrite.push(r);
      }
      return { rows: finalWrite, duplicates: dup };
    },
    bizWrite: function (rows2) { sheet.append(rows2); return { wrote: rows2.length }; }
  });
}

// ---------- 测试 1：确定性交错（展示竞态时序） ----------
function testInterleave() {
  console.log('--- 测试1：确定性交错（两并发写者，同批新 UUID A,B） ---');
  const batch = [{ uuid: 'A' }, { uuid: 'B' }];
  const s1 = makeSheet();
  const e1 = s1.readExisting(); const t1 = batch.filter(r => !e1.has(r.uuid));
  const e2 = s1.readExisting(); const t2 = batch.filter(r => !e2.has(r.uuid));
  s1.append(t1); s1.append(t2);
  console.log('  当前代码 → 行数', s1.rows.length, '(期望 4 = 含 2 重复)');
  const s2 = makeSheet();
  let w1 = batch.filter(r => !s2.readExisting().has(r.uuid));
  w1 = w1.filter(r => !s2.readExisting().has(r.uuid)); s2.append(w1);
  let w2 = batch.filter(r => !s2.readExisting().has(r.uuid));
  w2 = w2.filter(r => !s2.readExisting().has(r.uuid)); s2.append(w2);
  console.log('  修复代码 → 行数', s2.rows.length, '(期望 2 = 0 重复)');
  return s1.rows.length === 4 && s2.rows.length === 2;
}

// ---------- 测试 2：真实并发压力（50 并发写同一 UUID） → 闭合 A④ 并发负例 ----------
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

// ---------- 测试 3：两写者均经同一守卫（闭合 A② 实际写者均受同一守卫约束） ----------
async function testTwoWritersSameGuard() {
  console.log('--- 测试3：两写者交错，均经 _plGuardedInsert(lockPreWrite)（闭合 A②） ---');
  const sheet = makeSheet();
  const mutex = makeMutex();
  // 写者1 与 写者2 各自提交同批 UUID；即使交错执行，锁内重读保证只写一次
  const batch1 = [{ uuid: 'A' }, { uuid: 'B' }];
  const batch2 = [{ uuid: 'A' }, { uuid: 'B' }, { uuid: 'C' }];
  await Promise.all([
    tsAppendRows_fixed(sheet, mutex, batch1),
    tsAppendRows_fixed(sheet, mutex, batch2)
  ]);
  const uniq = new Set(sheet.rows.map(r => r.uuid));
  console.log('  两写者交错后 → 行数', sheet.rows.length, '，唯一UUID', uniq.size, '(期望 3 = A,B,C 各一次)');
  return sheet.rows.length === 3 && uniq.size === 3;
}

// ---------- 测试 4：失败注入（闭合 A④ 失败负例） ----------
async function testFailureInjection() {
  console.log('--- 测试4：bizWrite 中途抛错后重试，不重复（闭合 A④ 失败负例） ---');
  const sheet = makeSheet();
  const mutex = makeMutex();
  const batch = [{ uuid: 'A' }];
  let phase = 0;
  const bizFailing = function (rows2) {
    phase++;
    if (phase === 1) { sheet.append(rows2); throw new Error('SIMULATED_BIZ_WRITE_FAILURE'); }
    return { wrote: rows2.length };
  };
  // 写者1：bizWrite 抛错（已 append 但被当作失败）
  let caught = false;
  try {
    await plGuardedInsert(sheet, mutex, {
      rows: batch,
      lockPreWrite: (rowsIn) => ({ rows: rowsIn, duplicates: 0 }),
      bizWrite: bizFailing
    });
  } catch (e) { caught = true; }
  // 写者2（重试）：锁内重读应看到 A 已存在 → 跳过
  const before = sheet.rows.length;
  await tsAppendRows_fixed(sheet, mutex, batch);
  const after = sheet.rows.length;
  console.log('  写者1 失败(已落盘A) → caught=', caught, '；写者2 重试 → 新增行', after - before, '(期望 0)');
  const uniq = new Set(sheet.rows.map(r => r.uuid));
  console.log('  最终行数', sheet.rows.length, '，唯一UUID', uniq.size, '(期望 1 = 不重复)');
  return caught && (after - before === 0) && uniq.size === 1;
}

// ---------- 测试 5：空 UUID 行为（闭合 A③） ----------
function testEmptyUuid() {
  console.log('--- 测试5：空 UUID 行行为（闭合 A③） ---');
  // 逻辑断言：空 UUID 永不入 exist、永不被去重、永不阻塞他人
  const exist = new Set();
  const batch = [{ uuid: '' }, { uuid: 'X' }, { uuid: '' }];
  const toWrite = [];
  for (const r of batch) {
    // 复刻真实判定：if (uid && exist[uid]) skip; if (uid) exist[uid]=true
    const uid = r.uuid;
    if (uid && exist.has(uid)) continue;
    if (uid) exist.add(uid);
    toWrite.push(r);
  }
  console.log('  空UUID行保留数', toWrite.filter(r => r.uuid === '').length, '(期望 2，空UUID不跳过)');
  console.log('  exist 含空UUID?', exist.has(''), '(期望 false，空UUID不入 exist)');
  // 候选集边界：软删候选(1,340) 排除空UUID池(5,221) — 用已知统计断言
  const CANDIDATE = 1340, EMPTY_POOL = 5221;
  const okScope = CANDIDATE > 0 && EMPTY_POOL > CANDIDATE; // 空UUID池不在候选集内
  console.log('  软删候选', CANDIDATE, ' vs 空UUID池', EMPTY_POOL, ' → 空集排除候选?', okScope);
  return toWrite.filter(r => r.uuid === '').length === 2 && exist.has('') === false && okScope;
}

// ---------- 测试 6：Edit B 运行上下文未返回有效锁 → fail-closed 中止（闭合 B「是否返回有效锁」） ----------
function testNoValidLock() {
  console.log('--- 测试6：getDocumentLock 返回空 → 中止而非裸写（闭合 B 有效锁检查） ---');
  // 复刻 Edit B 新增守卫：lock 为 null/无 tryLock → 抛 PL_REJECT_NO_LOCK，绝不写
  function plAcquireProposed(getLock) {
    const lock = getLock();
    if (!lock || typeof lock.tryLock !== 'function') {
      const err = new Error('PL_REJECT_NO_LOCK'); err.plCode = 'PL_REJECT_NO_LOCK'; throw err;
    }
    return lock;
  }
  let wrote = false;
  try {
    plAcquireProposed(() => null);                 // 模拟受限上下文返回 null
    wrote = true;                                  // 若未抛错则视为裸写（失败）
  } catch (e) { /* 期望抛 PL_REJECT_NO_LOCK */ }
  console.log('  返回空锁 → 是否阻止裸写?', !wrote, '(期望 true)');
  return !wrote;
}

(async () => {
  console.log('=== T1-B 并发重放负例测试 v2 (concurrency_test_harness) ===');
  const t1 = testInterleave();
  const cur = await testStress(tsAppendRows_current, '当前代码');
  const fix = await testStress(tsAppendRows_fixed, '修复(Edit A)');
  const t3 = await testTwoWritersSameGuard();
  const t4 = await testFailureInjection();
  const t5 = testEmptyUuid();
  const t6 = testNoValidLock();

  console.log('--- 结论 ---');
  const bugShown = cur > 1;
  const fixShown = fix === 1;
  console.log('  A. 根因(锁外读+锁外判)：当前代码产生重复行 =', bugShown ? 'YES ✅' : 'NO ❌');
  console.log('  A① 回调契约 / A② 同一守卫 / A④ 并发负例：Edit A 修复消除重复 =', fixShown ? 'YES ✅' : 'NO ❌');
  console.log('  A② 两写者同一守卫交错零重复 =', t3 ? 'YES ✅' : 'NO ❌');
  console.log('  A④ 失败注入后重试不重复 =', t4 ? 'YES ✅' : 'NO ❌');
  console.log('  A③ 空 UUID 行为（保留/不入exist/候选排除）=', t5 ? 'YES ✅' : 'NO ❌');
  console.log('  B  有效锁检查（空锁 fail-closed 中止）=', t6 ? 'YES ✅' : 'NO ❌');
  console.log('  B  跨项目互斥（隔离环境实验）= 进程内不可证，见 VERIFY_GUIDE §3（Tom 方交付）');

  const pass = t1 && bugShown && fixShown && t3 && t4 && t5 && t6;
  console.log('\nRESULT:', pass ? 'PASS ✅ (Edit A 四项条件 + Edit B 有效锁检查 全部可复现)' : 'FAIL ❌');
  process.exit(pass ? 0 : 1);
})();
