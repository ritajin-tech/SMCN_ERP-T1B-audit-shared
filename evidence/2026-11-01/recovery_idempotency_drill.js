#!/usr/bin/env node
'use strict';
/*
 * recovery_idempotency_drill.js — T1-B W5 恢复幂等及演练（只读模拟 / 自包含 / 零依赖）
 *
 * 证明：
 *   1) 软标(soft-del) = 置 O 列(索引14) = TRUE，幂等：已 TRUE 再置 TRUE = 无变化。
 *   2) 恢复(recover) = 清 O 列，幂等：已空再清 = 无变化。
 *   3) 对 1,340 候选集整集重跑软标 → 结果与单次一致（可重跑、可一键恢复）。
 *
 * 运行：node recovery_idempotency_drill.js
 */

// 模拟生产表：每行 { uuid, o }，o=true 表示软删
function makeTable(n) {
  const rows = [];
  for (let i = 0; i < n; i++) rows.push({ uuid: 'U' + i, o: false });
  return rows;
}

function softDel(rows, idxs) {            // 软标：置 TRUE（幂等）
  for (const i of idxs) rows[i].o = true;
}
function recover(rows, idxs) {            // 恢复：清 FALSE（幂等）
  for (const i of idxs) rows[i].o = false;
}
function snapshot(rows) {
  return rows.map(r => (r.o ? 1 : 0)).join('');
}

(async () => {
  console.log('=== T1-B W5 恢复幂等演练 (recovery_idempotency_drill) ===');
  const N = 1340;                         // 候选集规模
  const table = makeTable(N);
  const cand = Array.from({ length: N }, (_, i) => i);   // 全部为候选行

  // 第一次软标
  softDel(table, cand);
  const s1 = snapshot(table);
  const cnt1 = table.filter(r => r.o).length;

  // 重复软标（模拟重试/重跑）→ 应完全一致
  softDel(table, cand);
  const s2 = snapshot(table);
  const cnt2 = table.filter(r => r.o).length;

  // 恢复（一键回滚）
  recover(table, cand);
  const s3 = snapshot(table);
  const cnt3 = table.filter(r => r.o).length;

  // 再次恢复（幂等）→ 应仍为空
  recover(table, cand);
  const s4 = snapshot(table);
  const cnt4 = table.filter(r => r.o).length;

  console.log('  软标后 O=TRUE 数:', cnt1, '(期望', N, ')');
  console.log('  重跑软标后 O=TRUE 数:', cnt2, '(期望', N, '，与首次一致)');
  console.log('  一致?', s1 === s2);
  console.log('  恢复后 O=TRUE 数:', cnt3, '(期望 0)');
  console.log('  再恢复后 O=TRUE 数:', cnt4, '(期望 0，幂等)');

  const pass = cnt1 === N && s1 === s2 && cnt3 === 0 && cnt4 === 0;
  console.log('\nRESULT:', pass ? 'PASS ✅ (软标幂等 + 可重跑 + 一键恢复幂等)' : 'FAIL ❌');
  process.exit(pass ? 0 : 1);
})();
