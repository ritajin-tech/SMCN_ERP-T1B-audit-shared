'use strict';
// ts_read_guard.js —— 读取期间"版本/内容"守卫（纯函数，零 IO / 零网络，可独立单测）。
// 回应 Tom 🅐 点②：hktool 不再返回 revision 时，仅比 lastRow 会漏检"同 lastRow 内容变化"；
// 故以【完整规范化快照内容指纹(SHA-256)】绑定读取期间一致性，revision 缺失时仍 fail-closed 有效。
const crypto = require('crypto');

function normCell(c) {
  return (c === null || c === undefined) ? '' : String(c).trim();
}

// 完整规范化快照内容指纹：以【无歧义结构化编码】生成 SHA-256（响应 Tom 08:27Z A点② 的拼接碰撞）。
// 旧实现用 ':' / '|' / '\n' 拼接，['a|b','c'] 与 ['a','b|c'] 会生成同一串导致哈希碰撞；
// 现改用 JSON 结构化序列化（行号 + 各列规范化值的数组），结构天然消歧，杜绝拼接碰撞。
function contentFingerprint(rows) {
  const s = JSON.stringify((rows || []).map(r => [r.row, (r.cells || []).map(normCell)]));
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

// 读取守卫裁决（响应 Tom 08:27Z A点②：revision 单侧缺失也须 fail-closed）。
// 规则：lastRow 漂移 / revision 单侧缺失 / revision 双侧不一致 / 内容指纹不一致，任一即 fail-closed。
// 仅当：两端 revision 均存在且相等（REVISION+CONTENT），或两端 revision 均缺失且内容指纹一致
// （CONTENT_FINGERPRINT，hktool 退化下的有效降级）才放行。
function verifyReadGuard(g) {
  if (g.startLast !== g.endLast) return { ok: false, reason: 'DRIFT_DURING_READ' };
  // revision 单侧缺失即视为不一致（不得放行）—— 回应 Tom 的"单侧缺失仍放行"漏洞
  if ((g.startRev == null) !== (g.endRev == null)) {
    return { ok: false, reason: 'REVISION_INCONSISTENT' };
  }
  if (g.startRev != null && g.endRev != null && g.startRev !== g.endRev) {
    return { ok: false, reason: 'REVISION_MISMATCH' };
  }
  if (g.startFp !== g.endFp) return { ok: false, reason: 'CONTENT_DRIFT' }; // 同 lastRow 不同内容 → 检出
  let guard;
  if (g.startRev == null && g.endRev == null) guard = 'CONTENT_FINGERPRINT'; // 双侧缺失但由指纹绑定（有效降级）
  else guard = 'REVISION+CONTENT';
  return { ok: true, guard };
}

module.exports = { normCell, contentFingerprint, verifyReadGuard };
