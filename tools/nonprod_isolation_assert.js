'use strict';
/**
 * 非生产环境隔离断言（只读 · 零依赖 · 不连任何生产系统）
 *
 * 背景：Tom 2026-11-01T17:09:15Z 要求「非生产环境须先证明 项目/数据/凭证/触发器/外发/生产资源
 *       均隔离，不将邮件转述视为授权创建或测试」。本脚本把「隔离」从陈述变为可运行断言：
 *       创建非生产项目后运行，A1–A10 任一项 FAIL 即停，不测试、不放行。
 *
 * 用法：
 *   node tools/nonprod_isolation_assert.js \
 *     --src <非生产源码目录> \
 *     --scriptid <非生产 scriptId> --prod-scriptid <生产 scriptId> \
 *     --copies <副本表ID,逗号分隔> \
 *     [--prod-ids prod_identifiers.json] [--triggers triggers.json] \
 *     [--prod-token <生产令牌字面量>] [--prod-recipients <收件人清单文件>] [--no-outgoing]
 *
 * 说明：--prod-ids 与 --prod-recipients 为本地文件（不入仓），缺失时仅用内置最小集
 *       （生产表/主库 ssId），其余断言判为 UNKNOWN 而非 PASS —— 不因缺输入而声称隔离。
 *
 * EXIT: 0=全部 PASS / 1=存在 FAIL / 2=存在 UNKNOWN(或输入不足)
 */
const fs = require('fs');
const path = require('path');

const args = {};
process.argv.slice(2).forEach((a, i, arr) => {
  if (a.startsWith('--')) args[a.slice(2)] = (arr[i + 1] && !arr[i + 1].startsWith('--')) ? arr[i + 1] : 'true';
});

const NL = String.fromCharCode(10);
// 生产表 / 主库 ssId（仓内既有公开标识，非凭证）
const BUILTIN_PROD_IDS = [
  '1Pi5u9fEawgp7yICWPMMyQCT_LbwTZthQDW-H05xYdVI',  // DB_工时流水（生产表）
  '1oxPj0mzN8poP2vQ7Bm-YKXuU49p9b0c1asyrZn4Py44'   // T1B_主库_工时与请假
];
const WEBAPP_URL_RE = /macros\/s\/AKfycb[A-Za-z0-9_-]{10,}/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}
function walk(dir) {
  const out = [];
  if (!dir || !fs.existsSync(dir)) return out;
  const st = fs.statSync(dir);
  if (st.isFile()) { out.push(dir); return out; }
  fs.readdirSync(dir).forEach(f => {
    const fp = path.join(dir, f);
    if (fs.statSync(fp).isDirectory()) out.push(...walk(fp));
    else if (/\.(js|gs|html|json)$/i.test(f)) out.push(fp);
  });
  return out;
}

const srcDir = args.src;
const files = walk(srcDir);
const blob = files.map(f => fs.readFileSync(f, 'utf8')).join(NL);
const fileCount = files.length;

const prodIds = BUILTIN_PROD_IDS.slice();
const prodIdCfg = args['prod-ids'] ? readJsonSafe(args['prod-ids']) : null;
if (prodIdCfg && Array.isArray(prodIdCfg.ids)) prodIds.push(...prodIdCfg.ids);

const results = [];
function add(id, name, verdict, detail) { results.push({ id, name, verdict, detail }); }

// A1 项目隔离
const npSid = args.scriptid, pSid = args['prod-scriptid'];
if (!npSid || !pSid) add('A1', '项目隔离(scriptId)', 'UNKNOWN', '缺少 --scriptid 或 --prod-scriptid');
else if (String(npSid) === String(pSid)) add('A1', '项目隔离(scriptId)', 'FAIL', '非生产 scriptId 与生产相同');
else add('A1', '项目隔离(scriptId)', 'PASS', 'np=' + npSid.slice(0, 12) + '… ≠ prod');

// A2 源码零命中生产部署/脚本
const urls = (blob.match(WEBAPP_URL_RE) || []);
const sidHit = pSid ? blob.split(pSid).length - 1 : 0;
if (!fileCount) add('A2', '源码零生产部署', 'UNKNOWN', '--src 未取到文件');
else if (urls.length || sidHit) add('A2', '源码零生产部署', 'FAIL', 'webappURL=' + urls.length + ' prodScriptIdHit=' + sidHit);
else add('A2', '源码零生产部署', 'PASS', 'webappURL=0 prodScriptIdHit=0');

// A3 数据隔离：源码零命中生产 ssId
const hits = prodIds.map(id => ({ id, n: blob.split(id).length - 1 })).filter(x => x.n > 0);
if (!fileCount) add('A3', '源码零生产表ID', 'UNKNOWN', '--src 未取到文件');
else if (hits.length) add('A3', '源码零生产表ID', 'FAIL', hits.map(h => h.id.slice(0, 12) + '…×' + h.n).join(', '));
else add('A3', '源码零生产表ID', 'PASS', '检查 ' + prodIds.length + ' 个生产 ID，零命中');

// A4 副本表独立
const copies = (args.copies || '').split(',').map(s => s.trim()).filter(Boolean);
if (!copies.length) add('A4', '副本表独立', 'UNKNOWN', '缺少 --copies');
else {
  const bad = copies.filter(c => prodIds.indexOf(c) >= 0);
  add('A4', '副本表独立', bad.length ? 'FAIL' : 'PASS', bad.length ? ('副本指向生产: ' + bad.join(',')) : (copies.length + ' 个副本均非生产 ID'));
}

// A5 凭证隔离：源码不得硬编码令牌字面量
const tokenLit = /(["'])([A-Za-z0-9_\-]{24,})\1/g;
const lits = (blob.match(tokenLit) || []).map(s => s.slice(1, -1));
const prodTok = args['prod-token'];
const litBad = prodTok ? lits.filter(s => s === prodTok) : [];
if (prodTok && litBad.length) add('A5', '凭证隔离(令牌)', 'FAIL', '源码含生产令牌字面量 ×' + litBad.length);
else if (!prodTok) add('A5', '凭证隔离(令牌)', 'UNKNOWN', '未提供 --prod-token，无法比对字面量；已检查长字面量 ' + lits.length + ' 个');
else add('A5', '凭证隔离(令牌)', 'PASS', '零命中生产令牌字面量');

// A6 令牌存放独立于生产
const store = args['token-store'];
if (!store) add('A6', '令牌存放独立', 'UNKNOWN', '缺少 --token-store');
else if (/_secrets[\\/]/.test(store) && /prod/i.test(store)) add('A6', '令牌存放独立', 'FAIL', '令牌路径指向生产');
else add('A6', '令牌存放独立', 'PASS', store);

// A7 触发器隔离
const trig = args.triggers ? readJsonSafe(args.triggers) : null;
if (!trig) add('A7', '触发器隔离', 'UNKNOWN', '缺少 --triggers（非生产项目 listTriggers 输出）');
else {
  const list = Array.isArray(trig) ? trig : (trig.triggers || []);
  const badT = list.filter(t => {
    const s = JSON.stringify(t);
    return prodIds.some(id => s.indexOf(id) >= 0);
  });
  add('A7', '触发器隔离', badT.length ? 'FAIL' : 'PASS',
    badT.length ? ('触发器指向生产资源 ×' + badT.length) : ('触发器 ' + list.length + ' 个，零指向生产'));
}

// A8 外发隔离：收件人不得命中生产分发清单
const mails = Array.from(new Set((blob.match(EMAIL_RE) || [])));
const recipientsCfg = args['prod-recipients']
  ? fs.readFileSync(args['prod-recipients'], 'utf8').split(/\r?\n/).map(s => s.trim().toLowerCase()).filter(Boolean)
  : [];
if (args['no-outgoing'] && /MailApp\.|GmailApp\.|sendEmail\s*\(/.test(blob)) {
  add('A8', '外发隔离', 'FAIL', '已指定 --no-outgoing 但源码存在 MailApp/GmailApp 调用');
} else if (!recipientsCfg.length) {
  add('A8', '外发隔离', 'UNKNOWN', '未提供 --prod-recipients；源码内邮箱 ' + mails.length + ' 个未比对');
} else {
  const bad = mails.filter(m => recipientsCfg.indexOf(m.toLowerCase()) >= 0);
  add('A8', '外发隔离', bad.length ? 'FAIL' : 'PASS', bad.length ? ('命中生产分发: ' + bad.join(',')) : '零命中生产分发清单');
}

// A9 外发默认 dry
const hasDry = /MAIL_DRY|mailDry|DRY_RUN|dry\s*===?\s*['"]?1/.test(blob);
add('A9', '外发默认 dry', hasDry ? 'PASS' : 'WARN', hasDry ? '检出 dry 开关' : '未检出 dry 开关（WARN，不阻断）');

// A10 生产资源隔离（日历/Drive 等）
const extra = (prodIdCfg && Array.isArray(prodIdCfg.resources)) ? prodIdCfg.resources : [];
const resHits = extra.map(id => ({ id, n: blob.split(id).length - 1 })).filter(x => x.n > 0);
if (!extra.length) add('A10', '生产资源隔离', 'UNKNOWN', '未提供 prod_identifiers.json 的 resources 列表');
else if (resHits.length) add('A10', '生产资源隔离', 'FAIL', resHits.map(h => h.id.slice(0, 12) + '…×' + h.n).join(', '));
else add('A10', '生产资源隔离', 'PASS', '检查 ' + extra.length + ' 个生产资源 ID，零命中');

// 输出
const out = [];
out.push('非生产隔离断言  src=' + (srcDir || '(未指定)') + '  文件数=' + fileCount);
results.forEach(r => out.push('  ' + r.id.padEnd(4) + r.verdict.padEnd(8) + r.name + '  — ' + r.detail));
const fails = results.filter(r => r.verdict === 'FAIL');
const unknowns = results.filter(r => r.verdict === 'UNKNOWN');
const warns = results.filter(r => r.verdict === 'WARN');
out.push('汇总: PASS=' + results.filter(r => r.verdict === 'PASS').length +
         ' FAIL=' + fails.length + ' UNKNOWN=' + unknowns.length + ' WARN=' + warns.length);
out.push('结论: ' + (fails.length ? 'ISOLATION_NOT_PROVEN（存在 FAIL，禁止在其上测试）'
  : (unknowns.length ? 'INSUFFICIENT_INPUT（存在 UNKNOWN，不得视为已证明隔离）'
    : 'ISOLATION_ASSERTED（全部 PASS，可进入 N1 与 Edit D 诊断）')));
const txt = out.join(NL);
console.log(txt);
process.exit(fails.length ? 1 : (unknowns.length ? 2 : 0));
