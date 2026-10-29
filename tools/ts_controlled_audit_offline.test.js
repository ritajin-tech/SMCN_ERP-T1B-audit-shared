#!/usr/bin/env node
// ts_controlled_audit_offline.test.js
// 分类边界与失败关闭条件负例测试（回应 Tom 🅐 点①"分类边界与失败关闭条件"的可验证证据）。
// 纯本地、零 IO、零网络：仅校验 classifyGroup 的归类与结构，不依赖哈希具体值。
'use strict';
const { classifyGroup, HEADER_KEY } = require('./ts_controlled_audit_offline.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  [PASS] ' + name); }
  else { fail++; console.log('  [FAIL] ' + name + (detail ? ' :: ' + detail : '')); }
}

// 构造条目：cells 至少 15 列；soft 为 O 列终态标志
const E = (row, cells, soft) => ({ row, cells: cells.concat(), soft: soft || 'FALSE' });
const base = (cells) => cells.concat(); // 底稿行（已 normCells）

console.log('=== classifyGroup 分类边界与失败关闭条件负例 ===');

// 1) exact A 级（组内全同，底稿恰 1 行）→ safeExactA
{
  const cells = ['2026-03-31T16:00:00Z','2026-03','P0015','精确重复','8','6893','10299','u1','u1','x','y','z','w','v','FALSE'];
  const entries = [E(10, cells), E(20, cells)];
  const c = classifyGroup('TS-EXACT-A', entries, [base(cells)]);
  check('exact A → safeExactA', c && c.bucket === 'safeExactA', JSON.stringify(c && c.bucket));
  check('exact A · targets=1', c && c.rec && c.rec.targets.length === 1);
  check('exact A · baseCount=1', c && c.rec && c.rec.baseCount === 1);
  check('exact A · keeper=最低行(10)', c && c.rec && c.rec.targets[0].keeperRow === 10);
}

// 2) timeonly A 级（仅 col0 不同，底稿恰 1 行）→ safeTimeOnlyA
{
  const a = ['2026-03-31T16:00:00Z','2026-03','P0015','精确重复','8','6893','10299','u2','u2','x','y','z','w','v','FALSE'];
  const b = ['2026-03-31T17:00:00Z','2026-03','P0015','精确重复','8','6893','10299','u2','u2','x','y','z','w','v','FALSE'];
  const entries = [E(10, a), E(20, b)];
  const c = classifyGroup('TS-TIMEONLY-A', entries, [base(a)]);
  check('timeonly A → safeTimeOnlyA', c && c.bucket === 'safeTimeOnlyA', JSON.stringify(c && c.bucket));
}

// 3) notInBase（组内全同，底稿 0 行）→ notInBase (B 级)
{
  const cells = ['2026-03-31T16:00:00Z','2026-03','P0015','精确重复','8','6893','10299','u3','u3','x','y','z','w','v','FALSE'];
  const entries = [E(10, cells), E(20, cells)];
  const c = classifyGroup('TS-NOTINBASE', entries, []);
  check('底稿0行 exact → notInBase', c && c.bucket === 'notInBase', JSON.stringify(c && c.bucket));
}

// 4) timeonly B 级（仅 col0 不同，底稿 0 行）→ timeonlyB（需另行授权）
{
  const a = ['2026-03-31T16:00:00Z','2026-03','P0015','精确重复','8','6893','10299','u4','u4','x','y','z','w','v','FALSE'];
  const b = ['2026-03-31T17:00:00Z','2026-03','P0015','精确重复','8','6893','10299','u4','u4','x','y','z','w','v','FALSE'];
  const entries = [E(10, a), E(20, b)];
  const c = classifyGroup('TS-TIMEONLY-B', entries, []);
  check('底稿0行 timeonly → timeonlyB（待另授权）', c && c.bucket === 'timeonlyB', JSON.stringify(c && c.bucket));
}

// 5) 失败关闭①：payload 不一致（col1..13 任一不同）→ unsafe PAYLOAD_DIFF
{
  const a = ['2026-03-31T16:00:00Z','2026-03','P0015','精确重复','8','6893','10299','u5','u5','x','y','z','w','v','FALSE'];
  const b = ['2026-03-31T16:00:00Z','2026-04','P0015','精确重复','8','6893','10299','u5','u5','x','y','z','w','v','FALSE']; // col1 不同
  const entries = [E(10, a), E(20, b)];
  const c = classifyGroup('TS-MIXED', entries, [base(a)]);
  check('payload 不一致 → unsafe/PAYLOAD_DIFF（绝不动）', c && c.bucket === 'unsafe' && c.reason === 'PAYLOAD_DIFF', JSON.stringify(c));
}

// 6) 失败关闭②：底稿非唯一（>=2 行）→ unsafe BASE_NOT_UNIQUE
{
  const cells = ['2026-03-31T16:00:00Z','2026-03','P0015','精确重复','8','6893','10299','u6','u6','x','y','z','w','v','FALSE'];
  const entries = [E(10, cells), E(20, cells)];
  const c = classifyGroup('TS-BASE-AMBIG', entries, [base(cells), base(cells)]);
  check('底稿歧义(>=2行) → unsafe/BASE_NOT_UNIQUE（绝不动）', c && c.bucket === 'unsafe' && c.reason === 'BASE_NOT_UNIQUE', JSON.stringify(c));
}

// 7) 失败关闭③：组内已有任一副本 O=TRUE → alreadyHandled（排除，不纳入 candidate）
{
  const cells = ['2026-03-31T16:00:00Z','2026-03','P0015','精确重复','8','6893','10299','u7','u7','x','y','z','w','v','FALSE'];
  const entries = [E(10, cells), E(20, cells, 'TRUE')];
  const c = classifyGroup('TS-ALREADY', entries, [base(cells)]);
  check('组内已有软标 → alreadyHandled（排除）', c && c.bucket === 'alreadyHandled', JSON.stringify(c));
}

// 8) 边界：不足 2 行 → null（跳过）
{
  const cells = ['2026-03-31T16:00:00Z','2026-03','P0015','精确重复','8','6893','10299','u8','u8','x','y','z','w','v','FALSE'];
  const c = classifyGroup('TS-SINGLE', [E(10, cells)], [base(cells)]);
  check('不足 2 行 → null（跳过）', c === null, JSON.stringify(c));
}

// 9) 边界：表头键 → null（跳过）
{
  const cells = ['2026-03-31T16:00:00Z','2026-03','P0015','精确重复','8','6893','10299','u9','u9','x','y','z','w','v','FALSE'];
  const c = classifyGroup(HEADER_KEY, [E(10, cells), E(20, cells)], [base(cells)]);
  check('表头键 → null（跳过）', c === null, JSON.stringify(c));
}

// 10) keeper 选择：targets 的 keeperRow 为最低行号（与行序无关）
{
  const cells = ['2026-03-31T16:00:00Z','2026-03','P0015','精确重复','8','6893','10299','u10','u10','x','y','z','w','v','FALSE'];
  const entries = [E(50, cells), E(11, cells)]; // 故意乱序
  const c = classifyGroup('TS-KEEPER', entries, [base(cells)]);
  check('keeper=最低行号(11)（与传入顺序无关）', c && c.rec && c.rec.targets[0].keeperRow === 11, JSON.stringify(c && c.rec && c.rec.targets[0]));
}

console.log('\n=== 结果：%d PASS / %d FAIL ===', pass, fail);
process.exit(fail ? 1 : 0);
