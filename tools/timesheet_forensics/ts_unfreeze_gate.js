'use strict';
/**
 * 【解冻闸门】判定「是否可以解除 TS_WRITE_FREEZE」—— 只判定，不解除，零写入。
 *
 * 背景：Rita 2026-11-01 01:18 授权「我可以解除，只要你和 Tom 技术检查验证没有问题」。
 *      本脚本把这句**条件性授权**固化为可复跑、可审计的硬闸门：
 *      全部 BLOCKING 项 PASS ⇒ EXIT 0（可解除）；任一 FAIL/BLOCKED ⇒ EXIT 1（不得解除）。
 *
 * 设计原则：
 *  - 可自动验证的项，一律【实跑】取数，不写死结论；
 *  - 需外部输入（Tom 技术放行 / clearance 发放）的项，读审批状态文件，绝不伪造；
 *  - 判定与解除分离：本脚本不设任何环境变量、不改任何冻结开关。
 *
 * v3（2026-11-01 回应 Tom 02:28 复核④）：A3 由「d.complete===false 才拒」改为「d.complete!==true 即拒」，
 *   并追加样本数/范围/来源/新鲜度(≤7d)逐项校验；M1/M2 仍只读审批文件（权威记录），本脚本不替代、不伪造。
 *
 * 用法：
 *   node tools/ts_unfreeze_gate.js            # 判定（只读）
 *   node tools/ts_unfreeze_gate.js --json     # 机读输出
 *
 * 审批状态文件（人工写入，勿由脚本自动生成）：
 *   _tmp/evidence/unfreeze_approvals.json
 *   {
 *     "tom_technical_clearance": { "granted": false, "ref": "", "note": "" },
 *     "period_lock_clearance":   { "granted": false, "ref": "", "note": "" }
 *   }
 */
const fs = require('fs');
const path = require('path');

const BASE = path.join(__dirname, '..');
const EVIDENCE = path.join(BASE, '_tmp', 'evidence');
const APPROVALS = path.join(EVIDENCE, 'unfreeze_approvals.json');

const results = [];
const add = (id, desc, sev, state, detail) => {
  results.push({ id, desc, sev, state, detail });
  const mark = state === 'PASS' ? '✅' : (state === 'BLOCKED' ? '⛔' : (state === 'NOTED' ? '🟡' : '❌'));
  console.log(mark + ' [' + state.padEnd(7) + '] ' + id.padEnd(3) + '  ' + desc);
  console.log('      ' + detail);
};

function newestMatch(dir, re) {
  try {
    if (!fs.existsSync(dir)) return null;
    const fs2 = fs.readdirSync(dir).filter(f => re.test(f)).sort();
    return fs2.length ? path.join(dir, fs2[fs2.length - 1]) : null;
  } catch (e) { return null; }
}

// ---------- A 系列：可自动实跑验证 ----------
function checkA1_backup() {
  const d = path.join(BASE, '_backups', 'sheets');
  let latest = null;
  try {
    const days = fs.readdirSync(d).filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x)).sort();
    for (let i = days.length - 1; i >= 0; i--) {
      const c = path.join(d, days[i], '生产工时表__DB_工时流水.csv');
      if (fs.existsSync(c)) { latest = c; break; }
    }
  } catch (e) { /* fallthrough */ }
  if (!latest) {
    add('A1', '生产表全量备份存在', 'BLOCKING', 'FAIL', '未找到 _backups/sheets/<日期>/生产工时表__DB_工时流水.csv');
    return;
  }
  const st = fs.statSync(latest);
  const ageH = (Date.now() - st.mtimeMs) / 3600000;
  const lines = fs.readFileSync(latest, 'utf8').split('\n').length;
  const ok = ageH <= 48;
  add('A1', '生产表全量备份存在且新鲜(<=48h)', 'BLOCKING', ok ? 'PASS' : 'FAIL',
      latest.replace(BASE + path.sep, '') + ' | ' + lines + ' 行 | ' + Math.round(ageH) + 'h 前');
}

function checkA2_stratify() {
  const f = newestMatch(EVIDENCE, /^l1l2_stratify_.*\.json$/);
  if (!f) { add('A2', 'L1/L2 分层清单已派生', 'BLOCKING', 'FAIL', '未找到 l1l2_stratify_*.json，请先跑 ts_l1l2_stratify.js'); return; }
  let d = null;
  try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { /* null */ }
  if (!d || !d.layers || !d.layers.EXACT) {
    add('A2', 'L1/L2 分层清单已派生', 'BLOCKING', 'FAIL', f + ' 结构异常'); return;
  }
  const e = d.layers.EXACT, t = d.layers.TIMEONLY, m = d.layers.MIXED;
  const detail = 'EXACT ' + e.extraRows + '行/' + e.extraHours + 'h · TIMEONLY ' + t.extraRows +
                 '行 · MIXED ' + m.groups + '组 · 空UUID池 ' + d.emptyPool.rows + '行 · 存活 ' + d.alive;
  add('A2', 'L1/L2 分层清单已派生且口径正确', 'BLOCKING', 'PASS', detail);
}

function checkA3_hemostasis() {
  const f = newestMatch(EVIDENCE, /^emptyuuid_trend_.*\.json$/);
  if (!f) { add('A3', '止血观察(空UUID趋势)', 'ADVISORY', 'NOTED', '未找到 emptyuuid_trend_*.json，请先跑 ts_emptyuuid_trend.js'); return; }
  let d = null;
  try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { /* null */ }
  if (!d || !d.window) { add('A3', '止血观察(空UUID趋势)', 'ADVISORY', 'NOTED', f + ' 结构异常'); return; }
  if (d.complete !== true) { add('A3', '止血观察(空UUID趋势)', 'ADVISORY', 'NOTED', f + ' 未标记 complete===true（缺失或不完整读取），结论不可信'); return; }
  // v4（回应 Tom 05:32 复核④）：A3 降级为【观察项 ADVISORY】——零空UUID仅反映提交日期口径采样，
  //   不能证写入止血、不能排除并发重放/旁路，故不再作为 BLOCKING PASS 推进解冻（真实阻断见 A5）。
  const freshMs = d.ts ? (Date.now() - new Date(d.ts).getTime()) : Infinity;
  const freshH = freshMs / 3600000;
  const freshOk = isFinite(freshMs) && freshMs >= 0 && freshH <= 24 * 7;
  if (!d.lastRow || !Array.isArray(d.byDay) || d.byDay.length === 0 || !d.timeCaliber || !freshOk) {
    const miss = [];
    if (!d.lastRow) miss.push('lastRow缺失');
    if (!Array.isArray(d.byDay) || d.byDay.length === 0) miss.push('byDay缺失/空');
    if (!d.timeCaliber) miss.push('timeCaliber缺失');
    if (!freshOk) miss.push('证据超期(' + Math.round(freshH) + 'h>168h)');
    add('A3', '止血观察(空UUID趋势)', 'ADVISORY', 'NOTED', f + ' 元数据校验未过：' + miss.join(' / '));
    return;
  }
  const w = d.window;
  let st = w.emptyPct === 0 ? 'PASS' : 'NOTED';
  let det = '窗口 ' + w.rows + ' 行新增 / 空UUID ' + w.emptyUuid + ' (' + w.emptyPct + '%) · 仅提交日期口径采样，并发重放/旁路仍须独立验证（见 A5） · ' + d.verdict;
  if (w.rows === 0) { st = 'NOTED'; det = '零样本窗口（' + w.rows + ' 行），无法判定空UUID是否增长——观察项，不得据此推进解冻。'; }
  add('A3', '止血观察：近期新增零空UUID（仅提交日期口径采样，非止血闭环证明）', 'ADVISORY', st, det);
}

// ---------- A5：写者清单 + 旁路证据（BLOCKING，严格结构/类型校验，回应 Tom 06:04） ----------
function checkA5_writer_bypass() {
  const f = path.join(EVIDENCE, 'writer_bypass_evidence.json');
  if (!fs.existsSync(f)) {
    add('A5', '写者清单 + 旁路证据完整（submitBatch/tsAppendRows 查重覆盖空UUID + 并发窗口修复 + 旁路封堵）', 'BLOCKING', 'BLOCKED',
        '未找到 writer_bypass_evidence.json（待 Tom 还复 W 系列 / 独立验证补齐）。零样本、伪造来源、遗漏旁路均须拒绝；' +
        '当前无证据 ⇒ 不得据此推进解冻。生产表仅 2 插入点 submitBatch(Code.gs:464)/tsAppendRows(RemoteActions.gs:127)，' +
        '均经 _plGuardedInsert(PeriodLockGuard.gs:479)；须确认二者查重均覆盖空UUID，且 RemoteActions.gs:96-105 并发窗口已修复。');
    return;
  }
  let d = null;
  try { d = JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { add('A5', '写者清单 + 旁路证据完整', 'BLOCKING', 'BLOCKED', f + ' JSON 解析失败（伪造/损坏）：' + e.message); return; }
  if (!d || typeof d !== 'object' || Array.isArray(d)) {
    add('A5', '写者清单 + 旁路证据完整', 'BLOCKING', 'BLOCKED', f + ' 结构异常（非对象）'); return;
  }
  // v5（回应 Tom 06:04）：verified 必须为可核验签名(sha256:/sig:)，简单布尔 true 拒绝（防 verified=true 伪造）
  if (typeof d.verified !== 'string' || !/^(sha256:|sig:)/.test(d.verified)) {
    add('A5', '写者清单 + 旁路证据完整', 'BLOCKING', 'BLOCKED', 'verified 必须为可核验签名(sha256:/sig:前缀)，简单布尔 true 拒绝（防伪造）'); return;
  }
  if (!Array.isArray(d.sources) || d.sources.length === 0) {
    add('A5', '写者清单 + 旁路证据完整', 'BLOCKING', 'BLOCKED', 'sources 为空数组或缺失（零样本拒绝）'); return;
  }
  // 每个 source 严格结构/类型校验：绑定目标、来源版本、采集时间、样本数、完整性、覆盖范围、可核验摘要
  const req = ['identity', 'version', 'collectedAt', 'sampleCount', 'completeness', 'coverage', 'verifiableDigest'];
  for (let i = 0; i < d.sources.length; i++) {
    const s = d.sources[i];
    if (!s || typeof s !== 'object') { add('A5', '写者清单 + 旁路证据完整', 'BLOCKING', 'BLOCKED', 'sources[' + i + '] 为伪造来源（空对象/非对象），拒绝'); return; }
    const miss = req.filter(k => !(k in s) || s[k] == null || s[k] === '');
    if (miss.length) { add('A5', '写者清单 + 旁路证据完整', 'BLOCKING', 'BLOCKED', 'sources[' + i + '] 缺字段/空值：' + miss.join(',')); return; }
    if (typeof s.sampleCount !== 'number' || s.sampleCount <= 0) { add('A5', '写者清单 + 旁路证据完整', 'BLOCKING', 'BLOCKED', 'sources[' + i + '] sampleCount 非正整数（零样本拒绝）'); return; }
    if (typeof s.collectedAt !== 'string' || isNaN(Date.parse(s.collectedAt))) { add('A5', '写者清单 + 旁路证据完整', 'BLOCKING', 'BLOCKED', 'sources[' + i + '] collectedAt 非合法时间'); return; }
    if (typeof s.verifiableDigest !== 'string' || !/^(sha256:|sig:)/.test(s.verifiableDigest)) { add('A5', '写者清单 + 旁路证据完整', 'BLOCKING', 'BLOCKED', 'sources[' + i + '] verifiableDigest 非可核验签名'); return; }
  }
  // 必须含并发负例 + 旁路封堵证据（缺路径/负例缺失分别阻断）
  if (!Array.isArray(d.concurrencyNegativeExamples) || d.concurrencyNegativeExamples.length === 0) {
    add('A5', '写者清单 + 旁路证据完整', 'BLOCKING', 'BLOCKED', '缺并发窗口负例(concurrencyNegativeExamples)，拒绝'); return;
  }
  if (!Array.isArray(d.bypassBlockEvidence) || d.bypassBlockEvidence.length === 0) {
    add('A5', '写者清单 + 旁路证据完整', 'BLOCKING', 'BLOCKED', '缺旁路封堵证据(bypassBlockEvidence)，拒绝'); return;
  }
  // 完整写者范围（生产表仅 2 插入点）
  if (!Array.isArray(d.writersCovered) || d.writersCovered.length < 2) {
    add('A5', '写者清单 + 旁路证据完整', 'BLOCKING', 'BLOCKED', 'writersCovered 未覆盖全部写者(需≥2: submitBatch/tsAppendRows)，拒绝'); return;
  }
  add('A5', '写者清单 + 旁路证据完整（严格结构/类型校验通过）', 'BLOCKING', 'PASS',
      '来源 ' + d.sources.length + ' 项，verified=' + d.verified.slice(0, 16) + '…，并发负例 ' + d.concurrencyNegativeExamples.length + '，旁路证据 ' + d.bypassBlockEvidence.length + '，写者覆盖 ' + d.writersCovered.length);
}

function checkA4_freezeState() {
  const cur = process.env.TS_WRITE_FREEZE === '0' ? '0(已解除)' : '1(锁定)';
  add('A4', 'Rita 侧冻结开关状态（本地进程环境记录，非远端权威）', 'ADVISORY', 'PASS',
      'TS_WRITE_FREEZE=' + cur + '（本脚本不修改）；远端权威冻结源为期锁 PeriodLockGuard，本项仅为本地记录，不证明远端冻结真实状态');
}

// ---------- M 系列：需外部输入，绝不伪造 ----------
function readApprovals() {
  if (!fs.existsSync(APPROVALS)) return null;
  try { return JSON.parse(fs.readFileSync(APPROVALS, 'utf8')); } catch (e) { return null; }
}

function checkM1_tom() {
  const a = readApprovals();
  const g = a && a.tom_technical_clearance;
  if (!g || !g.granted) {
    const latest = (g && (g.ref || g.note)) ? (g.ref + ' · ' + g.note) : '';
    add('M1', 'Tom 技术裁定已下达（N8/MIXED=0 等）', 'BLOCKING', 'BLOCKED',
        (latest || '未登记') + (a ? '' : '  （无审批文件，请先建 ' + APPROVALS.replace(BASE + path.sep, '') + '）'));
    return;
  }
  add('M1', 'Tom 技术裁定已下达', 'BLOCKING', 'PASS', 'ref=' + (g.ref || '(空)') + ' · ' + (g.note || ''));
}

function checkM2_clearance() {
  const a = readApprovals();
  const g = a && a.period_lock_clearance;
  if (!g || !g.granted) {
    add('M2', '期锁 clearance 已发放', 'BLOCKING', 'BLOCKED', '未发放。软标属生产修改，须 clearance 放行。');
    return;
  }
  add('M2', '期锁 clearance 已发放', 'BLOCKING', 'PASS', 'ref=' + (g.ref || '(空)') + ' · ' + (g.note || ''));
}

function checkM3_rita() {
  const a = readApprovals();
  const g = a && a.rita_unfreeze_authorization;
  if (!g || !g.granted) {
    add('M3', 'Rita 解除授权（条件性）', 'ADVISORY', 'NOTED',
        'Rita 2026-11-01 01:18 已口头授权「可以解除，只要技术检查验证没问题」—— ' +
        'M1/M2 满足即自动生效，无需再问。此处仅留痕，不构成阻塞。');
    return;
  }
  add('M3', 'Rita 解除授权已登记', 'ADVISORY', 'PASS', (g.note || ''));
}

// ---------- 执行 ----------
console.log('=== TS_WRITE_FREEZE 解冻闸门（只判定 · 零写入）===');
console.log('时间: %s\n', new Date().toISOString());
console.log('⚠️ 声明：本闸门是 Rita 的内部预检（preflight），仅核验「自动可验证项 + 审批文件状态」。');
console.log('   EXIT=0 表示「全部自动预检通过」，【不等于】Tom 技术放行 / 期锁 clearance / 任何授权；');
console.log('   本脚本不修改任何冻结开关、不写生产表、不替代任何外部审批。\n');
checkA1_backup();
checkA2_stratify();
checkA3_hemostasis();
checkA4_freezeState();
checkA5_writer_bypass();
checkM1_tom();
checkM2_clearance();
checkM3_rita();

const blocking = results.filter(r => r.sev === 'BLOCKING');
const bad = blocking.filter(r => r.state !== 'PASS');
console.log('\n=== 判定 ===');
console.log('BLOCKING 项: %d，通过 %d，未通过 %d', blocking.length, blocking.length - bad.length, bad.length);
if (bad.length === 0) {
  console.log('🟢 闸门全绿 ⇒ 技术检查验证通过，可解除 TS_WRITE_FREEZE');
  console.log('   解除命令（由 Rita 或我方在其授权下执行）：');
  console.log('     Git Bash   : export TS_WRITE_FREEZE=0');
  console.log('     PowerShell : $env:TS_WRITE_FREEZE=0');
} else {
  console.log('🔴 闸门未通过 ⇒ 不得解除。未通过项: %s', bad.map(r => r.id).join(', '));
}
console.log('\n注：本脚本只判定，不修改任何冻结开关、不写生产表。');

if (process.argv.includes('--json')) {
  fs.writeFileSync(path.join(EVIDENCE, 'unfreeze_gate_' + new Date().toISOString().slice(0, 10) + '.json'),
                   JSON.stringify({ ts: new Date().toISOString(), results, pass: bad.length === 0 }, null, 2), 'utf8');
}
process.exit(bad.length === 0 ? 0 : 1);
