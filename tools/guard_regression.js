'use strict';
/**
 * T1-B 守卫回归闸门（R5 总入口）
 * ---------------------------------------------------------------
 * 串联：① 线上守卫不变量静态检查（guard_invariant_check.js，只读 GET）② 21/21 逻辑 proof（proof/ts_insert_proof.js）
 * 任一失败 → 退出码非 0，阻断提交/上线。
 *
 * 运行：
 *   node tools/guard_regression.js            # 完整（含线上拉取）
 *   node tools/guard_regression.js --offline # 仅跑逻辑 proof（pre-commit 用，免网络）
 *
 * 红线：只读、零写、不部署、不改链接、不改冻结。
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TOOLS = __dirname;                       // .../tools
const REPO = path.resolve(TOOLS, '..');          // 仓库根（proof/ 在此）
const offline = process.argv.includes('--offline');

function run(absPath, cwd) {
  const r = spawnSync(process.execPath, [absPath], { cwd: cwd, encoding: 'utf8', timeout: 180000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const log = [];
let fail = 0;

// ② 逻辑 proof（始终跑）—— 位于仓库根 proof/
const h = run(path.join(REPO, 'proof', 'ts_insert_proof.js'), REPO);
log.push('[2] 21/21 logic proof: ' + (h.code === 0 ? 'PASS' : 'FAIL (exit ' + h.code + ')'));
if (h.code !== 0) fail++;

// ① 线上守卫不变量（非 offline 时跑）
if (!offline) {
  const v = run(path.join(TOOLS, 'guard_invariant_check.js'), TOOLS);
  log.push('[1] live guard invariants: ' + (v.code === 0 ? 'PASS' : 'FAIL (exit ' + v.code + ')'));
  if (v.code !== 0) fail++;
} else {
  log.push('[1] live guard invariants: SKIPPED (offline mode)');
}

const report = {
  generated_at: new Date().toISOString(),
  mode: offline ? 'offline' : 'full',
  pass: fail === 0,
  steps: log,
  sha256: crypto.createHash('sha256').update(log.join('\n'), 'utf8').digest('hex')
};

console.log('\n=== T1-B 守卫回归闸门 ===');
log.forEach(l => console.log('  ' + l));
console.log('总体     : ' + (report.pass ? 'PASS ✅' : 'FAIL ❌'));
console.log('指纹     : ' + report.sha256.slice(0, 16) + '...');

const dir = path.join(TOOLS, 'evidence'); fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.writeFileSync(path.join(dir, 'guard_regression_' + stamp + '.json'), JSON.stringify(report, null, 2));

process.exit(report.pass ? 0 : 1);
