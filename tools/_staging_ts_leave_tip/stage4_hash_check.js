// T1-B 生产表 Step1 · 阶段四切换复核 · 非目标区域哈希比对（STAGING 评审件 · v4）
//
// v4 针对 Tom 2026-10-24 12:27 复核函 Pt4 / Pt5 的第三轮修复：
//   Pt4: capturedAt 收紧为 ISO-8601 格式；新增显式 SCOPE 声明——本工具【仅】验证两个指定证据 CSV 的
//        非目标区域字节稳定 + dataWrite=false 逐字节一致，【不】验证数据来源(provenance)，
//        不承载"现场完整性/覆盖全部非目标"的门槛（那属部署期 owner 受控采集步骤，超出本件范围）。
//   Pt5: parseCsv 拒绝畸形输入——未闭合引号 / 字段起始位置外的引号 / 闭合引号后非法字符，均抛错；
//        readNonTargetRegion 逐记录校验宽度(须等于表头宽)，不等即失败关闭；
//        非目标投影改用 JSON 逐行序列化(逗号/引号转义)，消除 join(',')/join('\n') 的碰撞歧义；
//        同时重申 dataWrite=false 的逐字节比较仍是有效的第二道拦截，本件不夸大格式/覆盖完整性已验证。
//
// 用法：
//   node stage4_hash_check.js --manifest manifest.json --before before.csv --after after.csv
//   exit 0 = manifest 合法 + 证据 SHA 绑定 + 非目标区域一致 + 写集校验通过；非 0 = 漂移/越权/缺件（必须回滚/排查）。

'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

// Pt4：诚实范围声明（供测试与评审核验——本工具不验证数据来源/现场完整性门槛）。
const SCOPE = '本工具仅验证两个指定证据 CSV（before/after）的非目标区域字节稳定与 dataWrite=false 逐字节一致；不验证数据来源(provenance)、不承载"覆盖全部非目标/现场完整性"的门槛；provenance 须由部署期 owner 受控采集步骤另行保证。';

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

// ===== Pt5：列字母 → 索引（支持多字母：A=0, Z=25, AA=26, AB=27…）=====
function colToIndex(letters) {
  const s = String(letters == null ? '' : letters).toUpperCase();
  if (!/^[A-Z]+$/.test(s)) return null; // 非法（含数字/小写/空）
  let n = 0;
  for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// ===== Pt5：RFC4180 风格 CSV 解析（支持引号内逗号/换行、转义引号 ""；拒绝畸形）=====
// 畸形一律抛错（调用方 fail-close）：未闭合引号 / 非字段起始位置的引号 / 闭合引号后非法字符。
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
        inQuotes = false; i++; // 闭合
        // 闭合后紧跟字符必须为空/逗号/回车/换行，否则畸形
        const next = text[i];
        if (next !== undefined && next !== ',' && next !== '\r' && next !== '\n') {
          throw new Error('CSV_MALFORMED: 闭合引号后存在非法字符');
        }
        continue;
      }
      field += c; i++; continue;
    } else {
      if (c === '"') {
        if (field.length !== 0) throw new Error('CSV_MALFORMED: 引号出现在非字段起始位置');
        inQuotes = true; i++; continue;
      }
      if (c === ',') { row.push(field); field = ''; i++; continue; }
      if (c === '\r') { i++; continue; } // CRLF：跳过 \r，由 \n 结束行
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += c; i++; continue;
    }
  }
  if (inQuotes) throw new Error('CSV_MALFORMED: 引号未闭合');
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); } // 收尾最后一行
  return rows;
}

// ===== Pt4：manifest 合法性校验（失败关闭）=====
function validateManifest(m) {
  const errors = [];
  if (!m || typeof m !== 'object') { errors.push('manifest 缺失或非对象'); return { ok: false, errors, cols: [] }; }
  if (!m.frozenVersion || typeof m.frozenVersion !== 'string' || !m.frozenVersion.trim()) errors.push('frozenVersion 必填且非空');
  if (!m.table || typeof m.table !== 'string' || !m.table.trim()) errors.push('table 必填且非空');
  // Pt4：capturedAt 收紧为 ISO-8601 日期/时间（'C' 这类占位不再合法）
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)?)?$/.test(String(m.capturedAt || '').trim())) {
    errors.push('capturedAt 须为 ISO-8601 日期/时间(如 2026-10-24 或 2026-10-24T08:15:00+08:00)');
  }
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

// ===== Pt5：按非目标列提取子区域（解析后按索引取列；逐记录宽度校验 + 无歧义 JSON 序列化）=====
function readNonTargetRegion(rows, cols) {
  if (!rows || rows.length === 0) return ''; // 空（main 单独判空投影）
  const idxs = cols.map(colToIndex).filter(i => i !== null && i >= 0);
  const headerWidth = rows[0].length; // 表头宽 = 期望每记录宽
  const out = [];
  for (let ri = 0; ri < rows.length; ri++) {
    const r = rows[ri];
    if (!r || r.length === 0) continue; // 跳过零字段空行（两端一致处理）
    if (r.length !== headerWidth) throw new Error('CSV_MALFORMED: 第 ' + ri + ' 行字段数 ' + r.length + ' ≠ 表头宽 ' + headerWidth);
    // 无歧义序列化：每行 JSON（逗号/引号已转义），行间 \n —— 杜绝 join(',')/join('\n') 的碰撞
    out.push(JSON.stringify(idxs.map(i => (r[i] != null ? r[i] : ''))));
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
    process.exit(1);
  }
  if (aSha !== manifest.afterSha256.toLowerCase()) {
    console.error('STAGE4 FAIL ❌ after 文件 SHA 与 manifest.afterSha256 不符（证据文件非预期）');
    process.exit(1);
  }

  // 3) 列边界校验（Pt5：最大索引须 < 文件表头列数）
  let rowsB, rowsA;
  try {
    rowsB = parseCsv(beforeBuf.toString('utf8'));
    rowsA = parseCsv(afterBuf.toString('utf8'));
  } catch (e) {
    console.error('STAGE4 FAIL ❌ CSV 解析异常(畸形):', e && e.message);
    process.exit(1);
  }
  const colCount = Math.max(rowsB[0] ? rowsB[0].length : 0, rowsA[0] ? rowsA[0].length : 0);
  const maxIdx = v.validIdxs.length ? Math.max.apply(null, v.validIdxs) : -1;
  if (maxIdx >= colCount) {
    console.error('STAGE4 FAIL ❌ 非目标列索引越界：maxIdx=' + maxIdx + ' >= 文件列数 ' + colCount);
    process.exit(1);
  }

  // 4) 非目标区域哈希比对（逐记录宽度校验 + 无歧义序列化，畸形即 fail-close）
  let r1, r2;
  try {
    r1 = readNonTargetRegion(rowsB, v.cols);
    r2 = readNonTargetRegion(rowsA, v.cols);
  } catch (e) {
    console.error('STAGE4 FAIL ❌ 非目标区域提取异常(宽度不一致/畸形):', e && e.message);
    process.exit(1);
  }
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
    console.log('  note          :', SCOPE);
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

module.exports = { SCOPE, sha256, colToIndex, parseCsv, validateManifest, readNonTargetRegion, verifyWriteSet, planRollback };
