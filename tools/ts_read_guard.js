'use strict';
// ts_read_guard.js —— 读取期间"版本/内容"守卫（纯函数，零 IO / 零网络，可独立单测）。
// 回应 Tom 🅐 点②：hktool 不再返回 revision 时，仅比 lastRow 会漏检"同 lastRow 内容变化"；
// 故以【完整规范化快照内容指纹(SHA-256)】绑定读取期间一致性，revision 缺失时仍 fail-closed 有效。
const crypto = require('crypto');

function normCell(c) {
  return (c === null || c === undefined) ? '' : String(c).trim();
}

// 完整规范化快照内容指纹：行号 + 各列规范化值拼接后 SHA-256（与行序一致，反映"内容"而非仅"行数"）
function contentFingerprint(rows) {
  const s = (rows || []).map(r => r.row + ':' + (r.cells || []).map(normCell).join('|')).join('\n');
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

// 读取守卫裁决：lastRow 漂移 / revision 不一致 / 内容指纹不一致，任一即 fail-closed。
// 当两端 revision 均为 null（hktool 退化）时，只要内容指纹一致即判定守卫有效（CONTENT_FINGERPRINT）。
function verifyReadGuard(g) {
  if (g.startLast !== g.endLast) return { ok: false, reason: 'DRIFT_DURING_READ' };
  if (g.startRev != null && g.endRev != null && g.startRev !== g.endRev) {
    return { ok: false, reason: 'REVISION_MISMATCH' };
  }
  if (g.startFp !== g.endFp) return { ok: false, reason: 'CONTENT_DRIFT' }; // 同 lastRow 不同内容 → 检出
  let guard;
  if (g.startRev == null && g.endRev == null) guard = 'CONTENT_FINGERPRINT'; // 退化但由指纹绑定（有效）
  else guard = 'REVISION+CONTENT';
  return { ok: true, guard };
}

module.exports = { normCell, contentFingerprint, verifyReadGuard };
