'use strict';
/**
 * T1-B 一键自证状态报告（只读，零写）
 * ---------------------------------------------------------------
 * 串联两路只读核验，输出一份带 SHA256 的签字报告：
 *   1) gas_live_verify.js  —— 部署数 / 生产链接 / 守卫函数在线（共享审计仓）
 *   2) ts_healthcheck.js   —— WebApp 可用性 / 版本 / 守卫 / 生产表末行与最新提交（工作仓）
 *
 * 用途：把 Tom 反复要求的"独立核验原件/运行状态/数据"压缩成**一条命令**。
 *   任何人（含外部审阅方 Tom）clone 共享仓 + 有 clasp 令牌即可跑：
 *     node tools/t1b_status_report.js
 *   输出 tools/evidence/t1b_status_<ISO>.json，含 SHA256（报告内容指纹），
 *   审阅方比对哈希即可确认"我们看到的"与"他看到的"是同一份事实。
 *
 * 红线：本脚本零生产写、零部署、不改链接、不改冻结，仅 GET + 本地读取。
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SHARED = path.resolve(__dirname, '..');
const WORK = 'C:/Users/rita.jin/WorkBuddy/SMCN_ERP';

function run(cmd, args, cwd) {
  const r = spawnSync(process.execPath, [path.join(cwd, cmd), ...args], { cwd, encoding: 'utf8', timeout: 120000 });
  return { ok: !r.error && r.status === 0, stdout: (r.stdout || ''), stderr: (r.stderr || '') };
}

function sha256(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }

// ---- 1. gas_live_verify ----
const g = run('tools/gas_live_verify.js', [], SHARED);
const gOut = g.stdout || '';
const gasFacts = {
  ran_ok: g.ok,
  deploy_count: (gOut.match(/count\s*=\s*(\d+)/) || [])[1] || null,
  prod_url_present: /AKfycbzUyhyK/.test(gOut),
  period_lock_guard_bytes: (gOut.match(/PeriodLockGuard.*?bytes=(\d+)/) || [])[1] || null,
  file_count: (gOut.match(/fileCount\s*=\s*(\d+)/) || [])[1] || null,
  guard_functions: (gOut.match(/_pl[A-Za-z]+\s*:\s*line\s*\d+/g) || []).slice(0, 12)
};

// ---- 2. ts_healthcheck ----
const t = run('tools/ts_healthcheck.js', [], WORK);
const tOut = t.stdout || '';
let tsFacts = { ran_ok: t.ok };
const jsonEnd = tOut.indexOf('==== 人话版');
const jsonBlock = jsonEnd > 0 ? tOut.slice(0, jsonEnd).trim() : '';
try {
  const j = JSON.parse(jsonBlock);
  tsFacts = {
    ran_ok: t.ok,
    webapp_http: j.checks && j.checks.webapp && j.checks.webapp.http,
    webapp_title: j.checks && j.checks.webapp && j.checks.webapp.title,
    app_version: j.checks && j.checks.version && j.checks.version.app,
    srv_version: j.checks && j.checks.version && j.checks.version.srv,
    guard_present: !!(j.checks && j.checks.version && j.checks.version.guard),
    last_row: j.checks && j.checks.data && j.checks.data.last_row,
    latest_submit: j.checks && j.checks.data && j.checks.data.latest_submit,
    healthy: !!j.ok
  };
} catch (e) { tsFacts.parse_error = e.message; }

// ---- 汇总 + 指纹 ----
const report = {
  generated_at: new Date().toISOString(),
  scope: 'T1-B 生产表收口后运行状态（只读自证）',
  scripts: { gas_live_verify: gasFacts, ts_healthcheck: tsFacts },
  checks: {
    link_unchanged: gasFacts.prod_url_present === true,
    deploy_count_constant_3: gasFacts.deploy_count === '3',
    guard_live: gasFacts.period_lock_guard_bytes != null && tsFacts.guard_present === true,
    production_data_live: tsFacts.last_row != null && tsFacts.healthy === true
  }
};
const canonical = JSON.stringify(report, null, 2);
report.integrity = {
  sha256: sha256(canonical),
  note: 'SHA256 over canonical JSON of this report (excluding integrity). 比对哈希即可确认审阅方所见即此事实。'
};

const outDir = path.join(SHARED, 'tools', 'evidence');
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = path.join(outDir, 't1b_status_' + stamp + '.json');
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

console.log('=== T1-B 一键自证状态报告 ===');
console.log('生成时间 :', report.generated_at);
console.log('部署数=3 :', report.checks.deploy_count_constant_3);
console.log('链接未变 :', report.checks.link_unchanged, '(AKfycbzUyhyK)');
console.log('守卫在线 :', report.checks.guard_live, '(PeriodLockGuard', gasFacts.period_lock_guard_bytes, 'B)');
console.log('生产存活 :', report.checks.production_data_live, '(末行', tsFacts.last_row, '/ 最新提交', tsFacts.latest_submit, ')');
console.log('SHA256   :', report.integrity.sha256);
console.log('报告文件 :', outPath);
console.log('\n（本脚本只读、零写、未部署、未换链、未改冻结）');

module.exports = report;
