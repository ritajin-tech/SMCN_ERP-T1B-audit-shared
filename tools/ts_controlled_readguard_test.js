#!/usr/bin/env node
// ts_controlled_readguard_test.js
// 读取期间版本/内容守卫负例测试（回应 Tom 🅐 点②"同 lastRow 内容变化负例证据"）。纯本地、零 IO。
'use strict';
const { contentFingerprint, verifyReadGuard } = require('./ts_read_guard.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  [PASS] ' + name); }
  else { fail++; console.log('  [FAIL] ' + name + (detail ? ' :: ' + detail : '')); }
}

const mk = (row, cells) => ({ row, cells });
const snap = (rows) => rows;

console.log('=== verifyReadGuard 读取期间版本/内容守卫 ===');

// 同 lastRow(3) 但第 2 行内容不同 —— 必须检出 CONTENT_DRIFT（这是 revision 退化的核心漏洞）
{
  const a = snap([mk(1, ['x', 'a']), mk(2, ['y', 'b']), mk(3, ['z', 'c'])]);
  const b = snap([mk(1, ['x', 'a']), mk(2, ['y', 'CHANGED']), mk(3, ['z', 'c'])]); // 仅内容变，lastRow 不变
  const g = verifyReadGuard({
    startFp: contentFingerprint(a), endFp: contentFingerprint(b),
    startLast: 3, endLast: 3, startRev: null, endRev: null
  });
  check('同 lastRow 不同内容 → CONTENT_DRIFT（fail-closed）', !g.ok && g.reason === 'CONTENT_DRIFT', JSON.stringify(g));
}

// 内容一致、revision 缺失（hktool 退化）→ 守卫仍有效（CONTENT_FINGERPRINT）
{
  const a = snap([mk(1, ['x', 'a']), mk(2, ['y', 'b'])]);
  const g = verifyReadGuard({
    startFp: contentFingerprint(a), endFp: contentFingerprint(a),
    startLast: 2, endLast: 2, startRev: null, endRev: null
  });
  check('内容一致+revision缺失 → 守卫有效(CONTENT_FINGERPRINT)', g.ok && g.guard === 'CONTENT_FINGERPRINT', JSON.stringify(g));
}

// 内容一致、revision 存在且相等 → REVISION+CONTENT
{
  const a = snap([mk(1, ['x', 'a'])]);
  const g = verifyReadGuard({
    startFp: contentFingerprint(a), endFp: contentFingerprint(a),
    startLast: 1, endLast: 1, startRev: 'rev-123', endRev: 'rev-123'
  });
  check('内容一致+revision相等 → REVISION+CONTENT', g.ok && g.guard === 'REVISION+CONTENT', JSON.stringify(g));
}

// revision 不一致（两端都非 null）→ REVISION_MISMATCH
{
  const a = snap([mk(1, ['x', 'a'])]);
  const g = verifyReadGuard({
    startFp: contentFingerprint(a), endFp: contentFingerprint(a),
    startLast: 1, endLast: 1, startRev: 'rev-1', endRev: 'rev-2'
  });
  check('revision 不一致 → REVISION_MISMATCH', !g.ok && g.reason === 'REVISION_MISMATCH', JSON.stringify(g));
}

// lastRow 漂移 → DRIFT_DURING_READ（即便 content fingerprint 恰好相同也被 lastRow 拦下）
{
  const a = snap([mk(1, ['x', 'a'])]);
  const b = snap([mk(1, ['x', 'a'])]); // 内容同，但 endLast 不同
  const g = verifyReadGuard({
    startFp: contentFingerprint(a), endFp: contentFingerprint(b),
    startLast: 1, endLast: 2, startRev: null, endRev: null
  });
  check('lastRow 漂移 → DRIFT_DURING_READ', !g.ok && g.reason === 'DRIFT_DURING_READ', JSON.stringify(g));
}

// 拼接碰撞回归（回应 Tom 08:27Z A点②）：['a|b','c'] 与 ['a','b|c'] 必须产生【不同】指纹
{
  const p = snap([mk(1, ['a|b', 'c'])]);
  const q = snap([mk(1, ['a', 'b|c'])]);
  check('拼接碰撞已消除（JSON 结构编码消歧）', contentFingerprint(p) !== contentFingerprint(q),
        contentFingerprint(p) + ' vs ' + contentFingerprint(q));
}

// revision 单侧缺失 → REVISION_INCONSISTENT（fail-closed，回应 Tom 08:27Z A点②"单侧缺失仍放行"）
{
  const a = snap([mk(1, ['x', 'a'])]);
  const g = verifyReadGuard({
    startFp: contentFingerprint(a), endFp: contentFingerprint(a),
    startLast: 1, endLast: 1, startRev: 'rev-1', endRev: null
  });
  check('revision 单侧缺失 → REVISION_INCONSISTENT（fail-closed）',
        !g.ok && g.reason === 'REVISION_INCONSISTENT', JSON.stringify(g));
}

// 内容指纹确定性 + 敏感性
{
  const a = snap([mk(1, ['x', 'a']), mk(2, ['y', 'b'])]);
  const a2 = snap([mk(1, ['x', 'a']), mk(2, ['y', 'b'])]);
  const b = snap([mk(1, ['x', 'a']), mk(2, ['y', 'B-changed'])]);
  check('指纹确定性（同输入同指纹）', contentFingerprint(a) === contentFingerprint(a2));
  check('指纹敏感性（单元格变化→不同指纹）', contentFingerprint(a) !== contentFingerprint(b));
}

console.log('\n=== 结果：%d PASS / %d FAIL ===', pass, fail);
process.exit(fail ? 1 : 0);
