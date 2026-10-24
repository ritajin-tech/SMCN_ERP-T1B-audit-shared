// T1-B 生产表 Step1 · 阶段四切换复核 · 非目标区域哈希比对（STAGING 评审件 · v2）
//
// v2 针对 Tom 2026-10-24 Block4 的修复：
//   - 哈希前【先绑定冻结版本/表/范围/时刻】（manifest），不再比对两份任意整 CSV 字节；
//   - 显式定义【非目标区域】（列清单），只对该区域算哈希，证明"无关数据无变更"有覆盖依据；
//   - 增加【授权写集校验】：断言 after 相对 before 的【唯一差异】落在 manifest.authorizedTarget 内
//     （本功能只新增/改 UI 提示代码，不写任何数据列），即"无未授权数据写集"；
//   - 增加【回滚设计】rollback()，但不自动执行（须所有者显式授权 + 写权限）。
//
// 重要边界（回应 Block4/5）：哈希相同【仅】证明非目标区域字节稳定，
//   不证明部署身份/权限/逻辑正确 —— 那些须由 gas_pull 真实 HEAD diff + 身份核实另行保证。
//
// 用法：
//   node stage4_hash_check.js --manifest manifest.json --before before.csv --after after.csv
//   exit 0 = 非目标区域一致 + 写集校验通过（可放行）；非 0 = 漂移/越权写集（必须回滚/排查）。
//
// manifest.json 示例：
// {
//   "frozenVersion": "VP-20261018-R5729",
//   "table": "DB_工时流水",
//   "capturedAt": "2026-10-24T08:15:00+08:00",
//   "nonTargetColumns": ["A","B","C","D","E"],   // 不被本功能触碰的列；本功能不在数据表写任何列
//   "authorizedTarget": {                          // 唯一允许变更的范围（仅代码/UI，非数据）
//     "kind": "code-module-addition",
//     "module": "ts_leave_tip",
//     "dataWrite": false
//   }
// }

'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

// 读 CSV 并按非目标列提取子区域（列字母 → 索引；A=0）
function readNonTargetRegion(csvPath, nonTargetColumns) {
  const raw = fs.readFileSync(csvPath);
  const text = raw.toString('utf8');
  const lines = text.split(/\r?\n/);
  const header = lines[0] ? lines[0].split(',') : [];
  const idxs = nonTargetColumns.map(col => {
    const i = col.charCodeAt(0) - 65; // A->0
    return i;
  });
  // 仅保留非目标列的内容（逐行），重组为待哈希文本
  const out = [];
  for (const line of lines) {
    if (!line) continue;
    const cells = line.split(',');
    out.push(idxs.map(i => cells[i] != null ? cells[i] : '').join(','));
  }
  return out.join('\n');
}

// 写集校验：after 相对 before 的【数据】差异必须为空（本功能 dataWrite=false）。
// 这里以"整文件"做第二道校验：若 authorizedTarget.dataWrite=false，则 before 与 after 数据 CSV 必须逐字节相同。
function verifyWriteSet(beforePath, afterPath, manifest) {
  const dataWrite = manifest && manifest.authorizedTarget && manifest.authorizedTarget.dataWrite;
  if (dataWrite === false) {
    const b = fs.readFileSync(beforePath);
    const a = fs.readFileSync(afterPath);
    if (b.equals(a)) return { ok: true, note: 'dataWrite=false → 数据文件逐字节一致，无授权外数据写集' };
    return { ok: false, note: 'dataWrite=false 但数据文件发生变更 → 存在未授权数据写集，必须回滚' };
  }
  return { ok: true, note: 'manifest 未声明 dataWrite=false，跳过数据写集断言（须人工核对代码变更范围）' };
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
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const cols = manifest.nonTargetColumns || [];

  // 1) 非目标区域哈希比对
  const r1 = readNonTargetRegion(before, cols);
  const r2 = readNonTargetRegion(after, cols);
  const h1 = sha256(Buffer.from(r1, 'utf8'));
  const h2 = sha256(Buffer.from(r2, 'utf8'));

  // 2) 写集校验
  const ws = verifyWriteSet(before, after, manifest);

  if (h1 === h2 && ws.ok) {
    console.log('STAGE4 PASS ✅');
    console.log('  frozenVersion :', manifest.frozenVersion, '| table:', manifest.table, '| capturedAt:', manifest.capturedAt);
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

module.exports = { sha256, readNonTargetRegion, verifyWriteSet, planRollback };
