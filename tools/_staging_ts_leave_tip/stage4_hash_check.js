// T1-B 生产表 Step1 · 阶段四切换复核 · 非目标区域哈希比对（STAGING 评审件 · v3）
//
// v3 针对 Tom 2026-10-24 复核函 Pt4 / Pt5 的二次修复：
//   Pt4: manifest 必填校验（frozenVersion/table/capturedAt 非空；nonTargetColumns 非空+合法列字母+唯一；
//        authorizedTarget.dataWrite 必须显式为 false；before/after SHA-256 绑定证据文件）；
//        任一缺失/非法 → 失败关闭（exit 1），不再"只打印"或"缺省 []"或"dataWrite 缺失即跳过写集断言"。
//        空投影（非目标区域两端皆空）亦判失败关闭，杜绝空投影假 PASS。
//   Pt5: CSV 解析改为 RFC4180 风格（支持引号内逗号/换行、转义引号）；列字母支持多字母(AA/AB…)；
//        列合法性/唯一性/边界(索引<文件列数)校验；引号 CSV / AA 列均能正确提取。
//
// 边界（重申）：哈希相同【仅】证明非目标区域字节稳定 + 数据文件未变，不证明部署身份/权限/逻辑正确 ——
//   那些须由 gas_pull 真实 HEAD diff + 身份核实另行保证（部署期验证，不在本件范围）。
//
// 用法：
//   node stage4_hash_check.js --manifest manifest.json --before before.csv --after after.csv
//   exit 0 = manifest 合法 + 证据 SHA 绑定 + 非目标区域一致 + 写集校验通过；非 0 = 漂移/越权/缺件（必须回滚/排查）。

'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

// ===== Pt5：列字母 → 索引（支持多字母：A=0, Z=25, AA=26, AB=27…）=====
function colToIndex(letters) {
  const s = String(letters == null ? '' : letters).toUpperCase();
  if (!/^[A-Z]+$/.test(s)) return null; // 非法（含数字/小写/空）
  let n = 0;
  for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// ===== Pt5：RFC4180 风格 CSV 解析（支持引号内逗号/换行、转义引号 ""）=====
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; } // 转义引号
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    } else {
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ',') { row.push(field); field = ''; i++; continue; }
      if (c === '\r') { i++; continue; } // CRLF：跳过 \r，由 \n 结束行
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += c; i++; continue;
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); } // 收尾最后一行
  return rows;
}

// ===== Pt4：manifest 合法性校验（失败关闭）=====
function validateManifest(m) {
  const errors = [];
  if (!m || typeof m !== 'object') { errors.push('manifest 缺失或非对象'); return { ok: false, errors, cols: [] }; }
  if (!m.frozenVersion || typeof m.frozenVersion !== 'string' || !m.frozenVersion.trim()) errors.push('frozenVersion 必填且非空');
  if (!m.table || typeof m.table !== 'string' || !m.table.trim()) errors.push('table 必填且非空');
  if (!m.capturedAt || typeof m.capturedAt !== 'string' || !m.capturedAt.trim()) errors.push('capturedAt 必填且非空');
  const cols = m.nonTargetColumns;
  const validIdxs = [];
  const seen = {};
  if (!Array.isArray(cols) || cols.length === 0) {
    errors.push('nonTargetColumns 必填且为非空数组');
  } else {
    for (const c of cols) {
      const idx = colToIndex(c);
      if (idx === null) { errors.push('非法列字母: ' + String(c)); continue; }
      if (seen[idx]) { errors.push('重复列: ' + String(c)); continue; }
      seen[idx] = true;
      validIdxs.push(idx);
    }
  }
  const at = m.authorizedTarget;
  if (!at || at.dataWrite !== false) errors.push('authorizedTarget.dataWrite 必须显式为 false');
  if (!m.beforeSha256 || !/^[0-9A-Fa-f]{64}$/.test(m.beforeSha256)) errors.push('beforeSha256 必填且为 64 位 hex');
  if (!m.afterSha256 || !/^[0-9A-Fa-f]{64}$/.test(m.afterSha256)) errors.push('afterSha256 必填且为 64 位 hex');
  return { ok: errors.length === 0, errors, cols: (Array.isArray(cols) ? cols : []), validIdxs };
}

// ===== Pt5：按非目标列提取子区域（解析后按索引取列）=====
function readNonTargetRegion(rows, cols) {
  const idxs = cols.map(colToIndex).filter(i => i !== null);
  const out = [];
  for (const r of rows) {
    if (!r || r.length === 0) continue; // 跳过零字段空行（两端一致处理）
    out.push(idxs.map(i => (r[i] != null ? r[i] : '')).join(','));
  }
  return out.join('\n');
}

// ===== 写集校验：dataWrite===false（已由 manifest 校验保证）→ 数据文件必须逐字节一致 =====
function verifyWriteSet(beforeBuf, afterBuf, manifest) {
  const dataWrite = manifest && manifest.authorizedTarget && manifest.authorizedTarget.dataWrite;
  if (dataWrite !== false) {
    return { ok: false, note: 'dataWrite 未显式为 false → 不得放行（须人工核对代码变更范围）' };
  }
  if (beforeBuf.equals(afterBuf)) return { ok: true, note: 'dataWrite=false → 数据文件逐字节一致，无授权外数据写集' };
  return { ok: false, note: 'dataWrite=false 但数据文件发生变更 → 存在未授权数据写集，必须回滚' };
}

// 回滚设计：仅返回回滚指令，【不】自动执行（须所有者显式授权 + 写权限）。
function planRollback(beforePath, targetPath, manifest) {
  return {
    required: true,
    action: `将 ${targetPath} 恢复为部署前快照 ${beforePath}（frozenVersion=${manifest && manifest.frozenVersion}），并翻转 FEATURE_ENABLED=false`,
    authorizedBy: '系统所有者（Rita）显式授权 + 写权限；非自动执行',
  };
}

function main() {
  const argv = process.argv.slice(2);
  let manifestPath = null, before = null, after = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--manifest') manifestPath = argv[++i];
    else if (argv[i] === '--before') before = argv[++i];
    else if (argv[i] === '--after') after = argv[++i];
  }
  if (!manifestPath || !before || !after) {
    console.error('用法: node stage4_hash_check.js --manifest manifest.json --before before.csv --after after.csv');
    process.exit(2);
  }
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (e) { console.error('STAGE4 FAIL ❌ manifest 解析失败:', e && e.message); process.exit(1); }

  // 1) manifest 合法性（Pt4：缺件即失败关闭）
  const v = validateManifest(manifest);
  if (!v.ok) {
    console.error('STAGE4 FAIL ❌ manifest 非法：');
    for (const e of v.errors) console.error('   -', e);
    process.exit(1);
  }

  const beforeBuf = fs.readFileSync(before);
  const afterBuf = fs.readFileSync(after);

  // 2) 证据 SHA 绑定（Pt4：确保比对的是预期证据文件，而非被替换的任意文件）
  const bSha = sha256(beforeBuf), aSha = sha256(afterBuf);
  if (bSha !== manifest.beforeSha256.toLowerCase()) {
    console.error('STAGE4 FAIL ❌ before 文件 SHA 与 manifest.beforeSha256 不符（证据文件非预期）');
    console.error('   manifest:', manifest.beforeSha256.toLowerCase());
    console.error('   actual  :', bSha);
    process.exit(1);
  }
  if (aSha !== manifest.afterSha256.toLowerCase()) {
    console.error('STAGE4 FAIL ❌ after 文件 SHA 与 manifest.afterSha256 不符（证据文件非预期）');
    process.exit(1);
  }

  // 3) 列边界校验（Pt5：最大索引须 < 文件列数）
  const rowsB = parseCsv(beforeBuf.toString('utf8'));
  const rowsA = parseCsv(afterBuf.toString('utf8'));
  const colCount = Math.max(rowsB[0] ? rowsB[0].length : 0, rowsA[0] ? rowsA[0].length : 0);
  const maxIdx = v.validIdxs.length ? Math.max.apply(null, v.validIdxs) : -1;
  if (maxIdx >= colCount) {
    console.error('STAGE4 FAIL ❌ 非目标列索引越界：maxIdx=' + maxIdx + ' >= 文件列数 ' + colCount);
    process.exit(1);
  }

  // 4) 非目标区域哈希比对
  const r1 = readNonTargetRegion(rowsB, v.cols);
  const r2 = readNonTargetRegion(rowsA, v.cols);
  if ((!r1 || r1.length === 0) && (!r2 || r2.length === 0)) {
    console.error('STAGE4 FAIL ❌ 非目标区域两端皆空（空投影可相等 → 假 PASS 风险），必须声明有效非目标范围');
    process.exit(1);
  }
  const h1 = sha256(Buffer.from(r1, 'utf8'));
  const h2 = sha256(Buffer.from(r2, 'utf8'));

  // 5) 写集校验（dataWrite=false → 逐字节一致）
  const ws = verifyWriteSet(beforeBuf, afterBuf, manifest);

  if (h1 === h2 && ws.ok) {
    console.log('STAGE4 PASS ✅');
    console.log('  frozenVersion :', manifest.frozenVersion, '| table:', manifest.table, '| capturedAt:', manifest.capturedAt);
    console.log('  nonTargetCols :', v.cols.join(','));
    console.log('  nonTargetHash :', h1);
    console.log('  writeSet      :', ws.note);
    console.log('  note          : 哈希相同仅证明非目标区域字节稳定，不证明部署身份/权限/逻辑正确');
    process.exit(0);
  } else {
    console.error('STAGE4 FAIL ❌');
    if (h1 !== h2) {
      console.error('  非目标区域漂移:');
      console.error('    before:', h1);
      console.error('    after :', h2);
    }
    if (!ws.ok) console.error('  写集校验:', ws.note);
    console.error('  回滚方案:', JSON.stringify(planRollback(before, after, manifest)));
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { sha256, colToIndex, parseCsv, validateManifest, readNonTargetRegion, verifyWriteSet, planRollback };
