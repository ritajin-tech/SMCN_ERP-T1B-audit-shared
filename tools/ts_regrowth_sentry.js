'use strict';
/**
 * 只读取证哨兵：存量清理后，重复还会不会「长回来」？
 *
 * 背景：2026-11-01 23:53 已对生产表 1567 行冗余打软标（O=TRUE）。
 *       但产生重复的根因（RemoteActions.js:96-105 查重在锁外）尚未修复（Edit A 待 Tom 放行）。
 *       在根因修复前，本哨兵是「是否又长回来」的唯一客观判据，每日只读巡检。
 *
 * 监控三类再生信号（口径与 ts_l1l2_stratify.js 一致）：
 *   ① dupGroups   存活行中「同 UUID 出现 >1 次」的组数       ← 刚清掉的 1567 组属此类
 *   ② dupExtraRows 上述组的可去重冗余行数（Σ(count-1)）
 *   ③ emptyUuid   存活行中 UUID 为空的行数（历史遗留池，只报增量）
 *
 * 🔴 聚合铁律：空 UUID 一律不参与分组（不得用 (EMPTY) 当分组键），否则虚增数量级。
 *
 * 用法：
 *   node tools/ts_regrowth_sentry.js          巡检（与基线比对，增量告警）
 *   node tools/ts_regrowth_sentry.js --reset  重设基线（清理后首次运行用）
 *
 * EXIT: 0=无再生 / 1=检出再生或读取不完整 / 2=无法判定
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL: NU } = require('url');

const WEBAPP = 'https://script.google.com/macros/s/AKfycbyq9RYrH1n7DKkoYBVi2cBmsgQLT51i3yaqVP_xF7twQYW0--r39ryu7rJfj1Wn4dTHVA/exec';
const KEY = require('./.hktool_remote.json').key;
const TS_ID = '1Pi5u9fEawgp7yICWPMMyQCT_LbwTZthQDW-H05xYdVI';
const PROD_TAB = 'DB_工时流水';
const BASE_FILE = path.join(__dirname, '..', '_state', 'ts_regrowth_baseline.json');

const RESET = process.argv.includes('--reset');

const agent = new https.Agent({ keepAlive: true, maxSockets: 4 });
function raw(pl) {
  return new Promise(resolve => {
    const b = JSON.stringify(pl); const u = new NU(WEBAPP);
    const r = https.request({ host: u.hostname, port: 443, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }, agent }, res => {
      if (res.statusCode === 302 && res.headers.location) {
        res.resume(); const u2 = new NU(res.headers.location);
        const r2 = https.request({ host: u2.hostname, port: 443, path: u2.pathname + (u2.search || ''), method: 'GET', agent }, res2 => {
          const c = []; res2.on('data', d => c.push(d)); res2.on('end', () => { res2.resume(); resolve(Buffer.concat(c).toString('utf8')); });
        });
        r2.on('error', e => resolve('ERR ' + e.message)); r2.end(); return;
      }
      const c = []; res.on('data', d => c.push(d)); res.on('end', () => { res.resume(); resolve(Buffer.concat(c).toString('utf8')); });
    });
    r.on('error', e => resolve('ERR ' + e.message)); r.write(b); r.end();
  });
}
async function get(fn, args) {
  for (let i = 0; i < 4; i++) {
    const s = await raw({ action: 'hkRemoteRun', key: KEY, fn, args });
    let j = null; try { j = JSON.parse(s); } catch (e) { j = null; }
    if (j && j.result !== undefined && j.result !== null) return j.result;
    await new Promise(r => setTimeout(r, 800 * (i + 1)));
  }
  return null;
}
async function getRange(ssId, sheet, a1) {
  for (let i = 0; i < 5; i++) {
    const r = await get('inspectWorkbook', { ssId, sheet, mode: 'values', a1 });
    if (r && r.values && r.values.length) return r.values;
    await new Promise(res => setTimeout(res, 1200 * (i + 1)));
  }
  return null;
}
const isSoftDel = v => ['TRUE', 'true', 'TRUE ', '✔', '1'].includes(String(v || '').trim());

(async () => {
  // 1) 探总行数
  // 🔴🔴 口径修正（2026-11-02，我方自测发现的真实缺陷，如实记录）：
  //    初版用「读 A1:C12000 的 values 再 trim 尾部空行」确定末行 → 实测只得到 11366，
  //    而服务端权威 lastRow = 11380 ⇒ **漏扫尾部 14 行**（11367-11380，实测为
  //    Shirley Lin / Allen Zhang / Kai Chang / Jerry Fu 的真实数据行）。
  //    原因：hktool inspectWorkbook 对超大 range 的 values 返回会被截断，不能作为末行依据。
  //    修正：改用 **服务端 mode:'meta' 返回的 lastRow** 作为末行（权威、不依赖 values 完整性）。
  const meta = await get('inspectWorkbook', { ssId: TS_ID, sheet: PROD_TAB, mode: 'meta' });
  const last = meta && meta.lastRow ? meta.lastRow : 0;
  if (!last) { console.error('ABORT: 无法确定总行数（meta.lastRow 缺失）'); process.exit(2); }
  if (last < 11000) {
    console.error('ABORT: 末行 ' + last + ' 异常偏小（预期 >=11000），疑似读取失败，不下结论。');
    process.exit(2);
  }
  console.log('末行(服务端 meta.lastRow) = ' + last);

  // 2) 分页全量读 A..O
  const CH = 500;
  let failedPages = 0, shortPages = 0, total = 0, alive = 0, emptyUuid = 0;
  const uuidCount = Object.create(null);
  for (let s = 2; s <= last; s += CH) {
    const e = Math.min(s + CH - 1, last);
    const v = await getRange(TS_ID, PROD_TAB, 'A' + s + ':O' + e);
    if (!v) { failedPages++; continue; }
    if (v.length !== (e - s + 1)) { shortPages++; continue; }
    for (let i = 0; i < v.length; i++) {
      const r = v[i] || [];
      if (!String((r[0] || '')).trim() && !String((r[2] || '')).trim()) continue; // 真空行
      total++;
      if (isSoftDel(r[14])) continue;                       // 软标行不计存活
      alive++;
      const u = String(r[8] || '').trim();
      if (!u) { emptyUuid++; continue; }                    // 🔴 空 UUID 单列，绝不分组
      uuidCount[u] = (uuidCount[u] || 0) + 1;
    }
    process.stderr.write('read: ' + total + '\r');
  }
  process.stderr.write('\n');

  if (failedPages > 0 || shortPages > 0) {
    console.error('ABORT: 读取不完整（失败页 ' + failedPages + ' / 短页 ' + shortPages + '），不下结论。');
    process.exit(1);
  }

  let dupGroups = 0, dupExtraRows = 0;
  const samples = [];
  for (const u in uuidCount) {
    const n = uuidCount[u];
    if (n > 1) { dupGroups++; dupExtraRows += (n - 1); if (samples.length < 5) samples.push(u.slice(0, 12) + '×' + n); }
  }

  const now = new Date().toISOString();
  const cur = { ts: now, total, alive, dupGroups, dupExtraRows, emptyUuid, pages: Math.ceil((last - 1) / CH) };

  // 3) 基线处理
  let base = null;
  if (!RESET && fs.existsSync(BASE_FILE)) {
    try { base = JSON.parse(fs.readFileSync(BASE_FILE, 'utf8')); } catch (e) { base = null; }
  }
  if (!base) {
    fs.mkdirSync(path.dirname(BASE_FILE), { recursive: true });
    fs.writeFileSync(BASE_FILE, JSON.stringify(cur, null, 2), 'utf8');
    console.log('=== 工时表「长回来」哨兵（只读）===');
    console.log('基线已建立 -> ' + BASE_FILE);
    console.log('  存活 ' + alive + ' 行 / 重复组 ' + dupGroups + ' / 冗余行 ' + dupExtraRows + ' / 空UUID ' + emptyUuid + ' / 总行 ' + total);
    console.log('下次起按此基线比对增量。');
    process.exit(0);
  }

  const d = {
    alive: cur.alive - base.alive,
    dupGroups: cur.dupGroups - base.dupGroups,
    dupExtraRows: cur.dupExtraRows - base.dupExtraRows,
    emptyUuid: cur.emptyUuid - base.emptyUuid
  };
  const regrowth = d.dupExtraRows > 0 || d.dupGroups > 0 || d.emptyUuid > 0;

  console.log('=== 工时表「长回来」哨兵（只读）===');
  console.log('基线 ' + base.ts + '  当前 ' + now);
  console.log('  指标        基线      当前      增量');
  console.log('  存活行      ' + String(base.alive).padEnd(9) + String(cur.alive).padEnd(9) + (d.alive >= 0 ? '+' : '') + d.alive);
  console.log('  重复组      ' + String(base.dupGroups).padEnd(9) + String(cur.dupGroups).padEnd(9) + (d.dupGroups >= 0 ? '+' : '') + d.dupGroups);
  console.log('  冗余行      ' + String(base.dupExtraRows).padEnd(9) + String(cur.dupExtraRows).padEnd(9) + (d.dupExtraRows >= 0 ? '+' : '') + d.dupExtraRows);
  console.log('  空UUID      ' + String(base.emptyUuid).padEnd(9) + String(cur.emptyUuid).padEnd(9) + (d.emptyUuid >= 0 ? '+' : '') + d.emptyUuid);
  if (samples.length) console.log('  现存重复样本: ' + samples.join(', '));
  console.log('');
  if (regrowth) {
    console.log('🔴 检出再生：冗余行 +' + d.dupExtraRows + ' / 重复组 +' + d.dupGroups + ' / 空UUID +' + d.emptyUuid);
    console.log('   ⇒ 根因（RemoteActions.js:96-105 锁外查重）未修，Edit A 待 Tom 放行；同期不要解除冻结。');
    process.exit(1);
  }
  console.log('✅ 无再生：三类指标相对基线均未增长。');
  console.log('   注：本哨兵只观测「是否已长回来」，不构成止血证明；根因未修前漏洞仍在。');
  process.exit(0);
})();
