// 受控审计生成器 v2（只读 live，按 UUID 重新推导，SHA-256 哈希）
//
// v1 教训：候选 CSV / 旧 audit JSON 都是「位置指针」，而生产表每日追加新工时行，
// 位置整体漂移 → 旧位置指向错误行 → 全部 UUID 不匹配（CAS 全拒）。
// 故本 v2 完全放弃位置指针，改为【从 LIVE 按 UUID 推导重复组】：
//   - 读 live 生产表，按真实 UUID 聚组；
//   - 只处理「曾入围选（CSV 白名单）且 live 仍是精确重复对」的 UUID；
//   - 用 live 当前位置 + _sdRowHash（SHA-256，与服务端 ts_softdel_core 一致）生成目标；
//   - 仅纳入底稿恰 1 行（A 级安全）；底稿 0 行（B 级）/ 多行（baseAlsoDup）单列排除。
//
// 用法：node tools/ts_controlled_audit.js
// 输出：_tmp/evidence/controlled_audit_<BJT>.json + 汇总
'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL: NU } = require('url');
const norm = require('./ts_softdel_norm.js');
const _sdRowHash = norm._sdRowHash;
const _sdNorm = norm._sdNorm;
const _sdSoftDel = norm._sdSoftDel;
const rg = require('./ts_read_guard.js');   // 读取期间版本/内容守卫（content fingerprint + fail-closed）

const WEBAPP = process.env.TS_WEBAPP_OVERRIDE || '<HKTOOL_WEBAPP_URL: 见本地 .hktool_remote.json / 系统记忆（公开仓不内嵌端点）>';
const KEY = process.env.TS_HKTOOL_KEY || '<HKTOOL_KEY: 见本地 .hktool_remote.json（公开仓不内嵌）>';
const TS_ID = '1Pi5u9fEawgp7yICWPMMyQCT_LbwTZthQDW-H05xYdVI';
const PROD_TAB = 'DB_工时流水';
const MASTER_ID = '1oxPj0mzN8poP2vQ7Bm-YKXU49p9b0c1asyrZn4Py44';
const BASE_TAB = '工时_候选0824';

const _agent = (WEBAPP.startsWith('http://')) ? new (require('http').Agent)({ keepAlive: true, maxSockets: 5 }) : new https.Agent({ keepAlive: true, maxSockets: 5 });
function call(pl) {
  return new Promise(resolve => {
    const b = JSON.stringify(pl); const u = new NU(WEBAPP);
    const transport = (WEBAPP.startsWith('http://')) ? require('http') : https;
    const ropt = { host: u.hostname, port: u.port || (transport === https ? 443 : 80), path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }, agent: _agent };
    const r = transport.request(ropt, res => {
      if (res.statusCode === 302 && res.headers.location) {
        res.resume(); const u2 = new NU(res.headers.location);
        const r2 = transport.request({ host: u2.hostname, port: u2.port || (transport === https ? 443 : 80), path: u2.pathname + (u2.search || ''), method: 'GET', agent: _agent }, res2 => {
          const c = []; res2.on('data', d => c.push(d)); res2.on('end', () => { res2.resume(); resolve(Buffer.concat(c).toString('utf8')); });
        });
        r2.on('error', e => resolve('ERR ' + e.message)); r2.end(); return;
      }
      const c = []; res.on('data', d => c.push(d)); res.on('end', () => { res.resume(); resolve(Buffer.concat(c).toString('utf8')); });
    });
    r.on('error', e => resolve('ERR ' + e.message)); r.write(b); r.end();
  });
}
let _lastCall = 0;
async function get(args) {
  const minGap = 4000;   // hktool 时间窗限流：每两次调用间至少 4s（约 15/min，留足余量）
  const wait = Math.max(0, _lastCall + minGap - Date.now());
  if (wait) await new Promise(r => setTimeout(r, wait));
  for (let i = 0; i < 6; i++) {
    const s = await call({ action: 'hkRemoteRun', key: KEY, fn: 'inspectWorkbook', args });
    _lastCall = Date.now();
    let j; try { j = JSON.parse(s); } catch (e) {}
    if (j && j.result) return j.result;
    await new Promise(r => setTimeout(r, 1500));
  }
  return {};
}
// 🔴 依赖注入：默认 _fetch = get（真实 hktool 通道）；单测用 setFetch 替换为 mock，无需触网。
let _fetch = get;
function setFetch(f) { _fetch = f; }
// 列字母 -> 1-based 宽度（单字母足矣：Q=17, O=15）。用于读取链"明确列宽"fail-closed 校验。
function colIndex(col) {
  let n = 0;
  for (let i = 0; i < col.length; i++) n = n * 26 + (col.charCodeAt(i) - 64);
  return n;
}

async function readAll(ssId, sheet, lastCol) {
  const probe = await _fetch({ ssId, sheet, mode: 'values', a1: 'A1:' + lastCol + '2' });
  const last = probe.lastRow || 0;
  const revision = probe.revision != null ? probe.revision : null;
  if (!last || last < 2) return { rows: [], lastRow: last, ok: false, reason: 'EMPTY_PROBE' };
  const expectedWidth = colIndex(lastCol);   // 读取范围宽度 = 列宽规则基准
  const pages = [], rows = []; let pageFail = false, truncated = false;
  for (let s =1; s <= last; s += 400) {
    const e = Math.min(s + 399, last);
    const r = await _fetch({ ssId, sheet, mode: 'values', a1: `A${s}:${lastCol}${e}` });
    const got = (r && r.values) ? r.values.length : 0;
    const expected = (e - s + 1);
    const ok = got > 0 && got === expected;
    pages.push({ reqStart: s, reqEnd: e, got, expected, ok });
    if (!ok) { if (got === 0) pageFail = true; else truncated = true; }
    // 🔴 Tom X 批·二：不得用 cells||[] 伪造成空行——原始响应行槽直接入列，
    // 让 validateRows 能检出 null/false/非数组（异常缺失）；真实全空行须由接口以完整宽度空数组显式表示。
    (r && r.values ? r.values : []).forEach((cells, i) => { const rr = s + i; if (rr <= last) rows.push({ row: rr, cells: cells }); });
  }

  // 🔴 Tom W 批·点②：读取链接入 validateRows（安全整数行号 + 唯一 + 明确列宽），
  // 在计算内容指纹【及】筛除空行【之前】执行；任何结构异常（非整数行号/重复/缺列/列宽不一致）即 fail-closed。
  const v1 = rg.validateRows(rows, { expectedWidth });
  if (v1.length) return { rows, lastRow: last, pages, ok: false, reason: 'VALIDATE_ROWS_FAILED', detail: v1 };

  // 🔴 内容指纹绑定（回应 Tom 🅐 点②）：revision 缺失时仅靠 lastRow 会漏检"同 lastRow 内容变化"，
  // 故对【完整规范化快照】做 SHA-256 指纹，并重读全量做一次指纹交叉校验（fail-closed）。
  const startFp = rg.contentFingerprint(rows);
  const rows2 = [];
  const pages2 = [];   // 第二遍同样逐页校验期望行数（Tom W 批·点②）
  for (let s = 1; s <= last; s += 400) {
    const e = Math.min(s + 399, last);
    const r = await _fetch({ ssId, sheet, mode: 'values', a1: `A${s}:${lastCol}${e}` });
    const got = (r && r.values) ? r.values.length : 0;
    const expected = (e - s + 1);
    const ok = got > 0 && got === expected;
    pages2.push({ reqStart: s, reqEnd: e, got, expected, ok });
    if (!ok) { if (got === 0) pageFail = true; else truncated = true; }
    (r && r.values ? r.values : []).forEach((cells, i) => { const rr = s + i; if (rr <= last) rows2.push({ row: rr, cells: cells }); });
  }
  // 第二遍同样接入 validateRows（两次取得同样的不完整数据指纹相同也不能证明完整）
  const v2 = rg.validateRows(rows2, { expectedWidth });
  if (v2.length) return { rows, lastRow: last, pages, ok: false, reason: 'VALIDATE_ROWS_FAILED', detail: v2 };

  // 🔴 Tom X 批·二：终点 probe（第二遍【之后】再探），以"起读前 probe1"为起点，
  // 覆盖全读取窗口的 lastRow/revision 漂移比对；probe2 必须在第二遍全量读【之后】，
  // 否则第二遍中途的追加/改版在终点不被检出（旧实现 probe2 在二遍之前，二遍之后无终点 probe）。
  const probe2 = await _fetch({ ssId, sheet, mode: 'values', a1: 'A1:' + lastCol + '2' });
  const rev2 = probe2.revision != null ? probe2.revision : null;

  const endFp = rg.contentFingerprint(rows2);
  const guard = rg.verifyReadGuard({
    startFp, endFp, startLast: last, endLast: probe2.lastRow || 0,
    startRev: revision, endRev: rev2
  });
  if (!guard.ok) return { rows, lastRow: last, pages, ok: false, reason: guard.reason };

  // 两遍原始快照均经 validateRows 校验后再筛除真实空行（按接口契约确认的完整宽度空数组）；
  // 异常缺失（null/false/短行）已在 validateRows 阶段 fail-closed，不至此。
  const data = rows.filter(x => x.cells.some(c => String(c ?? '').trim() !== ''));
  return { rows: data, lastRow: last, pages, ok: !pageFail && !truncated, revision, guard: guard.guard };
}

// 候选白名单：CSV 的 uuid 集合（去重），并剔除 2 个已知异常 uuid
function loadVettedUuidSet(p) {
  const text = fs.readFileSync(p, 'utf8');
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
  const h = lines[0].split(',').map(x => x.trim());
  const ui = h.indexOf('uuid');
  const set = new Set();
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    const u = (c[ui] || '').trim();
    if (u) set.add(u);
  }
  // 2 异常 uuid（候选生成误配 / 无键重复）
  set.delete('TS-CBB5F7A8A965');   // 候选1246 PAIR_BROKEN
  set.delete('TS-A47287A2E9DB');   // 候选324 INCOMPLETE（live 真实UUID为空）
  return set;
}

async function readAllRetry(ssId, sheet, lastCol) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await readAll(ssId, sheet, lastCol);
    if (r.ok) return r;
    lastErr = r.reason;
    process.stderr.write('      [retry ' + attempt + '] ' + sheet + ' 读取未通过(' + r.reason + ')，3s 后重试...\n');
    await new Promise(s => setTimeout(s, 3000));
  }
  return { rows: [], lastRow: 0, ok: false, reason: lastErr || 'READ_FAILED' };
}

// 🔴 主流程：联网只读回读生产表 + 底稿，按 UUID 重新推导受控 A 级软标目标集。
async function run() {
  const stamp = new Date(Date.now() + 8 * 3600e3).toISOString().replace(/[:T]/g, '-').slice(0, 19);
  process.stderr.write('[1/4] 只读回读生产表 ' + PROD_TAB + ' ...\n');
  const prod = await readAllRetry(TS_ID, PROD_TAB, 'Q');
  if (!prod.ok) { process.stderr.write('[ABORT] 生产表读取不完整/漂移：' + prod.reason + '\n'); process.exit(1); }
  const prodUuid = {};
  prod.rows.forEach(x => {
    const u = _sdNorm(x.cells[8]);
    if (u) (prodUuid[u] = prodUuid[u] || []).push({ row: x.row, cells: x.cells, soft: _sdSoftDel(x.cells), hours: parseFloat(_sdNorm(x.cells[6])) || 0 });
  });
  process.stderr.write('      生产数据行 ' + prod.rows.length + '（lastRow=' + prod.lastRow + '），有UUID ' + Object.keys(prodUuid).length + ' 个\n');

  process.stderr.write('[2/4] 只读回读底稿 ' + BASE_TAB + ' ...\n');
  const base = await readAllRetry(MASTER_ID, BASE_TAB, 'O');
  if (!base.ok) { process.stderr.write('[ABORT] 底稿读取不完整/漂移：' + base.reason + '\n'); process.exit(1); }
  const baseUuidCount = {}, baseByRow = {}, baseUuidRows = {};
  base.rows.slice(1).forEach(x => {
    const u = _sdNorm(x.cells[8]);
    if (u) {
      baseUuidCount[u] = (baseUuidCount[u] || 0) + 1;
      (baseUuidRows[u] = baseUuidRows[u] || []).push(x.row);
      baseByRow[x.row] = x.cells;
    }
  });
  process.stderr.write('      底稿数据行 ' + (base.rows.length - 1) + '，有UUID ' + Object.keys(baseUuidCount).length + ' 个\n');

  process.stderr.write('[3/4] 载入候选白名单 + 按 UUID 重新推导重复组 ...\n');
  const white = loadVettedUuidSet(path.join(__dirname, 'candidate_dedupe_LIVE_20261026_pseudonym_v2.csv'));
  process.stderr.write('      白名单（已剔除2异常）' + white.size + ' 个 UUID\n');

  const safe = [], deferred = [];
  let passA = 0, sumH = 0;
  let inWhiteButNotDup = 0, inWhiteButSoft = 0, bLevel = 0, baseDup = 0, loadMismatch = 0, notInWhite = 0;
  for (const u of Object.keys(prodUuid)) {
    if (!white.has(u)) { notInWhite++; continue; }
    const rows = prodUuid[u];
    const live = rows.filter(x => !x.soft);
    if (live.length < 2) { inWhiteButNotDup++; continue; }   // 已不再是重复组（可能被人改过/删过）
    if (rows.some(x => x.soft)) { inWhiteButSoft++; deferred.push({ uuid: u, reason: '存在已软标行（幂等跳过，需人工）' }); continue; }
    const keeper = live[0];
    const bc = baseUuidCount[u] || 0;
    // 逐冗余行：负载必须精确一致（列0..13），否则不得自动裁决
    const targets = [];
    let thisOk = true;
    for (let k = 1; k < live.length; k++) {
      const trow = live[k];
      let diffs = [];
      for (let c = 0; c <= 13; c++) if (_sdNorm(trow.cells[c]) !== _sdNorm(keeper.cells[c])) diffs.push(c);
      if (diffs.length) { thisOk = false; loadMismatch++; deferred.push({ uuid: u, row: trow.row, keeperRow: keeper.row, reason: '负载不一致(列 ' + diffs.join(',') + ')' }); break; }
    }
    if (!thisOk) continue;
    for (let k = 1; k < live.length; k++) {
      const trow = live[k];
      targets.push({
        row: trow.row, keeperRow: keeper.row,
        targetHash: _sdRowHash(trow.cells, false),
        keeperHash: _sdRowHash(keeper.cells, false),
        expectBaseHash: bc === 1 ? _sdRowHash(baseByRow[baseUuidRows[u][0]] || [], false) : undefined
      });
    }
    const rec = { uuid: u, prodRows: rows.length, prodLive: live.length, prodLiveHours: +live.reduce((s, x) => s + x.hours, 0).toFixed(1),
      baseRows: bc, baseRowNums: (baseUuidRows[u] || []).slice(0, 5), prodRowNums: live.map(x => x.row), targets,
      month: (function () { try { return new Date(new Date(_sdNorm(keeper.cells[1])).getTime() + 8 * 3600e3).toISOString().slice(0, 7); } catch (e) { return ''; } })() };
    if (bc === 1) { safe.push(rec); passA += targets.length; sumH += live.reduce((s, x) => s + x.hours, 0) - (keeper.hours); }
    else if (bc === 0) { bLevel++; deferred.push({ uuid: u, reason: 'B级：底稿0行，需人工裁定(不自动软标)', rows: live.length }); }
    else { baseDup++; deferred.push({ uuid: u, reason: '底稿多行(baseAlsoDup=' + bc + ')，需人工连底稿裁', rows: live.length }); }
  }
  process.stderr.write('      A级(可自动软标) ' + passA + ' 行 / ' + sumH.toFixed(1) + 'h；\n      排除：白名单但非重复 ' + inWhiteButNotDup +
    '，含已软标 ' + inWhiteButSoft + '，B级 ' + bLevel + '，底稿多行 ' + baseDup + '，负载不一致 ' + loadMismatch + '\n');

  const out = {
    meta: {
      generatedAtBJT: new Date(Date.now() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19),
      readOnly: true,
      logic: '受控 A 级软标目标集 v2（按 UUID 从 LIVE 重推导 + SHA-256 类型保全哈希）；仅白名单内且底稿恰1行精确重复对',
      master: { ssId: MASTER_ID, tab: BASE_TAB }, prod: { ssId: TS_ID, tab: PROD_TAB },
      vettedSource: 'candidate_dedupe_LIVE_20261026_pseudonym_v2.csv（uuid 白名单，剔除 TS-CBB5F7A8A965/TS-A47287A2E9DB）',
      note: '候选 CSV 位置指针已因生产表增长而漂移，故完全弃用位置，改按 UUID 实时推导'
    },
    summary: {
      vettedUuidWhite: white.size, aLevelAutoRows: passA, aLevelHours: +sumH.toFixed(1),
      deferred: deferred.length, inWhiteButNotDup, inWhiteButSoft, bLevel, baseDup, loadMismatch, notInWhite
    },
    detail: { safe: safe, deferred: deferred, baseAlsoDup: [], orphanInBase: [], notInBase: [] }
  };
  const outPath = path.join(__dirname, '..', '_tmp', 'evidence', 'controlled_audit_' + stamp + '.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
  process.stderr.write('[4/4] 已写出 ' + outPath + '\n');
  process.stdout.write(JSON.stringify(out.summary, null, 2));
}

// 导出（供单测注入 mock 读取通道，无需触网）；仅当直接运行时才执行联网主流程。
module.exports = { setFetch, readAll, readAllRetry, run };
if (require.main === module) { (async () => { await run(); })(); }
