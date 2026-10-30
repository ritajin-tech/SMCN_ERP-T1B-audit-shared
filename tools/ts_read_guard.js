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

// Tom V 批·A点② 补强 + W 批收紧：读取守卫输入健全性校验。
// 规则（fail-closed，任何一项违规即返回违规列表，调用方须在指纹计算前校验并在失败时拒绝）：
//   · rows 必须是数组；
//   · 每个 row 必须是【安全整数】(Number.isSafeInteger) 且 >=1（拒绝 1.5 / '2' / NaN / Infinity）；
//   · 行号唯一（重复即违规）；
//   · cells 必须是数组（拒绝非数组）；
//   · 列宽规则（Tom X 批·二 收紧）：opts.expectedWidth 给出时，【每一行】cells.length 必须 == expectedWidth——
//     含全空行也必须全宽（接口契约须以完整宽度的空数组表示真实空行；缺列/短空行即判异常缺失）；
//     未给出 expectedWidth 时，所有行（含全空行）cells.length 必须彼此相等（明确列宽，杜绝缺列/结构异常）。
//     【不以 truthy 回退补空掩盖异常】：cells 为 null/非数组即判违规，调用方不得用 `cells||[]` 伪造成空行。
function validateRows(rows, opts) {
  opts = opts || {};
  const expectedWidth = (typeof opts.expectedWidth === 'number') ? opts.expectedWidth : null;
  if (!Array.isArray(rows)) return ['rows 不是数组'];
  const seen = {};
  let implicitWidth = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    if (typeof r.row !== 'number' || !Number.isSafeInteger(r.row) || r.row < 1) {
      return ['rows[' + i + '].row 非安全整数行号(>=1): ' + JSON.stringify(r.row)];
    }
    if (seen[r.row]) return ['rows[' + i + '].row 行号重复: ' + r.row];
    seen[r.row] = true;
    if (!Array.isArray(r.cells)) return ['rows[' + i + '].cells 非数组(null/非数组=异常缺失，不得伪造成空行)'];
    // Tom X 批·二：列宽规则对【每一行】生效（含全空行）——缺列/短空行（长度不符 expectedWidth 或隐性基准）即判异常，
    // 不再以 hasContent 跳过；真实空行须以完整宽度的空数组显式表示。
    if (expectedWidth !== null) {
      if (r.cells.length !== expectedWidth) {
        return ['rows[' + i + '].cells 列宽不符(含全空行须全宽): 期望 ' + expectedWidth + ' 实际 ' + r.cells.length];
      }
    } else {
      if (implicitWidth === null) implicitWidth = r.cells.length;
      else if (r.cells.length !== implicitWidth) {
        return ['rows[' + i + '].cells 列宽不一致: 前 ' + implicitWidth + ' 实际 ' + r.cells.length];
      }
    }
  }
  return [];
}

module.exports = { normCell, contentFingerprint, verifyReadGuard, validateRows };
