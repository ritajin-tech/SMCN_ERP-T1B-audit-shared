'use strict';
// ts_read_guard.js 独立单测（Tom V 批·A点② 补强：输入健全性 + 结构化指纹 + revision 单侧 fail-closed）。
const g = require('./ts_read_guard.js');

let fails = 0;
function assert(c, m) { if (!c) { console.log('  FAIL: ' + m); fails++; } else { console.log('  ok: ' + m); } }

console.log('=== validateRows（A点② 补强）===');
assert(g.validateRows([{ row: 2, cells: [1, 2] }, { row: 5, cells: [3, 4] }]).length === 0, '正常行集通过');
assert(g.validateRows([{ row: 2, cells: [] }, { row: 2, cells: [] }]).length === 1, '重复行号被拒');
assert(g.validateRows([{ row: 'x', cells: [] }]).length === 1, '非数字行号被拒');
assert(g.validateRows([{ row: 2, cells: 'no' }]).length === 1, 'cells 非数组被拒');
assert(g.validateRows('nope').length === 1, '非数组整体被拒');

console.log('=== contentFingerprint 结构化无碰撞 ===');
const fp1 = g.contentFingerprint([{ row: 1, cells: ['a|b', 'c'] }]);
const fp2 = g.contentFingerprint([{ row: 1, cells: ['a', 'b|c'] }]);
assert(fp1 !== fp2, "['a|b','c'] 与 ['a','b|c'] 指纹不同（无拼接碰撞）");
assert(/^[0-9a-f]{64}$/.test(fp1), '指纹为 SHA-256');

console.log('=== verifyReadGuard revision 单侧缺失 fail-closed ===');
assert(g.verifyReadGuard({ startLast: 1, endLast: 1, startRev: 'R1', endRev: null, startFp: 'F', endFp: 'F' }).ok === false, 'start 有/end 无 revision → 拒绝');
assert(g.verifyReadGuard({ startLast: 1, endLast: 1, startRev: null, endRev: 'R1', startFp: 'F', endFp: 'F' }).ok === false, 'start 无/end 有 revision → 拒绝');
assert(g.verifyReadGuard({ startLast: 1, endLast: 1, startRev: 'R1', endRev: 'R1', startFp: 'F', endFp: 'F' }).ok === true, '双侧 revision 相等 → 放行');
assert(g.verifyReadGuard({ startLast: 2, endLast: 1, startRev: 'R1', endRev: 'R1', startFp: 'F', endFp: 'F' }).ok === false, 'lastRow 漂移 → 拒绝');
assert(g.verifyReadGuard({ startLast: 1, endLast: 1, startRev: null, endRev: null, startFp: 'F', endFp: 'F' }).ok === true, '双侧均无 revision + 指纹一致 → 放行(CONTENT_FINGERPRINT)');

const total = 15;
console.log('\n' + (fails ? ('FAIL: ' + fails + ' 项') : ('PASS: ts_read_guard ' + total + '/15 全绿（含 A点② validateRows 新增 4 例）')));
process.exit(fails ? 1 : 0);
