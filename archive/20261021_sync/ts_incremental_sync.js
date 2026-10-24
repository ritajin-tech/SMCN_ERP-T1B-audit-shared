// T1-B 主库 · 增量同步 + 体检工具（默认 dry-run 只读；--apply 才写底稿）
// 用法：node tools/ts_incremental_sync.js [--apply]
// 逻辑：生产表新行(录入时间>水位线) → 去重(UUID+内容键) → 剔除(请假/软删/非2026/无名) → 追加到底稿「工时_候选0824」
// 🔴 日期口径：业务日期 = raw ISO +8h(上海)；禁用 UTC 前缀（2026-10-16 底稿日期 bug 的根因）
// 凭证：tools/.ts_sync_config.json（gitignored，含 ts-manager v166 匿名通道 url+token）
const fs = require('fs');
const ROOT = 'C:/Users/rita.jin/WorkBuddy/SMCN_ERP';
const CFG = JSON.parse(fs.readFileSync(ROOT + '/tools/.ts_sync_config.json', 'utf8'));
const APPLY = process.argv.includes('--apply');

// strict=true：HTTP 非 2xx 或响应非 JSON 一律抛错（用于读路径与写路径，避免「吞成空对象」被当成成功）
// strict=false：沿用旧的宽松行为（仅用于可选的探测型调用）
// 🔴 2026-10-19：Google Web App 偶发返回 HTML 错误页（冷启动/限流）⇒ strict 模式必须重试，
//    否则一次坏响应会被当成「空表」，2026-10-19 00:40 的「新增 6520 条」误报就是这么来的。
const sleep = ms => new Promise(r => setTimeout(r, ms));
function callOnce(a, b, strict) {
  const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), 90000);
  const body = Object.assign({ action: a, token: CFG.token }, b);
  return fetch(CFG.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'follow', signal: ctrl.signal })
    .then(r => {
      if (strict && !r.ok) throw new Error('HTTP ' + r.status + ' @' + a);
      return r.text();
    })
    .then(t => {
      let o = null;
      try { o = JSON.parse(t); }
      catch (e) {
        if (strict) throw new Error('非 JSON 响应 @' + a + ': ' + String(t).slice(0, 80).replace(/\s+/g, ' '));
        return {};
      }
      // 🔴 2026-10-19：HTTP 200 + {"ok":false} 也是失败（如表格服务超时）。旧代码把它 parse 成 {}，
      //    外层再取 .values 得到 []，于是「读取失败」被当成「读到空表」——正是 00:40 误报的真因。
      if (strict && o && o.ok === false) throw new Error('GAS 返回失败 @' + a + ': ' + String(o.message == null ? '' : o.message).slice(0, 120).replace(/\s+/g, ' '));
      let m = null; if (o && typeof o.message === 'string') { try { m = JSON.parse(o.message); } catch (e) {} } return m || {};
    });
}
async function call(a, b, opts) {
  const strict = !!(opts && opts.strict);
  const tries = strict ? 3 : 1;
  let lastErr = null;
  for (let i = 1; i <= tries; i++) {
    try { return await callOnce(a, b, strict); }
    catch (e) {
      lastErr = e;
      if (i < tries) {
        console.error('[' + a + '] 第 ' + i + ' 次失败，' + (i === 1 ? 2 : 6) + 's 后重试：' + e.message.slice(0, 100));
        await sleep(i === 1 ? 2000 : 6000);
      }
    }
  }
  throw lastErr;
}
// 业务日期：raw ISO-Z → +8h；纯日期串/Date 显示值 → 取前10位
function bizDate(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (/T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s)) { const d = new Date(s); if (!isNaN(d.getTime())) return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10); }
  const p = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (p) return p[1] + '-' + p[2] + '-' + p[3];
  const d = new Date(s); if (!isNaN(d.getTime())) return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  return '';
}
// 录入时间 → instant(ms)。支持 raw ISO-Z、'2026-10-16 01:29:00'、'10/16/2026 01:29:00'(M/D/YYYY, 按上海)
function enterInstant(v) {
  const s = String(v == null ? '' : v).trim(); if (!s) return null;
  if (/T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s)) { const d = new Date(s); return isNaN(d.getTime()) ? null : d.getTime(); }
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +(m[6] || 0));
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[ ]+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) return Date.UTC(+m[3], +m[1] - 1, +m[2], +m[4] - 8, +m[5], +(m[6] || 0));
  const d = new Date(s); return isNaN(d.getTime()) ? null : d.getTime();
}
async function readAll(ssid, sheet, cols) {
  // strict：读失败必须中止 —— 否则空结果会让「水位线=null」进而把全量生产行误判为新增
  const meta = await call('sheetMeta', { ssid, sheet }, { strict: true });
  const maxR = (meta.area && meta.area.rows) || 20000; let out = []; let lastRow = 1;
  for (let s = 2; s <= Math.min(maxR, 60000); s += 5000) {
    const v = (await call('readRange', { sheet, ssid, range: 'A' + s + ':' + cols + (s + 4999), fmt: 'raw' }, { strict: true })).values || [];
    v.forEach((r, i) => { if (r.some(c => String(c == null ? '' : c).trim() !== '')) { out.push(r); lastRow = s + i; } });
    if (v.length < 5000) break;
  }
  out.lastRow = lastRow;   // 物理末行（1-based，含表头行计数起点=1）
  return out;
}
const isLeaveRow = r => /休假|请假/.test(String(r[3] || '')) || String(r[4] || '').trim() === 'OFF-WORK' || String(r[5] || '').trim() === 'OFF-WORK';
const isSoftDel = r => String(r[14] || '').trim().toUpperCase() === 'TRUE';
(async () => {
  console.log('模式:', APPLY ? 'APPLY(写入)' : 'DRY-RUN(只读体检)');
  const base = await readAll(CFG.ssidMaster, CFG.baseTab, 'K');
  const prod = await readAll(CFG.ssidProd, CFG.prodTab, 'O');
  console.log('底稿行 =', base.length, '| 生产表非空行 =', prod.length);
  // 底稿索引（内容键含备注；键3=人+项目+日期+工时，不含备注，用于识别重复变体；键2=人+项目+工时→日期集合，用于识别日期漂移变体）
  const baseU = new Set(), baseC = new Set(), baseK3 = new Set(); const baseK2 = new Map(); let watermark = null;
  base.forEach(r => {
    const u = String(r[8] || '').trim(); if (u) baseU.add(u);
    const nm = String(r[2] || '').trim(), dt = bizDate(r[1]);
    if (nm && dt) {
      baseC.add([nm, String(r[5] || '').trim().toLowerCase(), String(r[6] || '').trim(), dt, String(r[7] || '').trim()].join('\u0002'));
      baseK3.add([nm, String(r[5] || '').trim().toLowerCase(), String(r[6] || '').trim(), dt].join('\u0002'));
      const k2 = [nm, String(r[5] || '').trim().toLowerCase(), String(r[6] || '').trim()].join('\u0002');
      if (!baseK2.has(k2)) baseK2.set(k2, new Set()); baseK2.get(k2).add(dt);
    }
    const ei = enterInstant(r[0]); if (ei != null && (watermark == null || ei > watermark)) watermark = ei;
  });
  const wmStr = watermark == null ? '(无)' : new Date(watermark + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  console.log('水位线(底稿最大录入时间, 上海) =', wmStr);
  // 生产表分类
  const add = [], dups = [], missed = [], noEnter = [], shifted = []; let excluded = 0;
  const prodU = new Set();
  prod.forEach(r => {
    const nm = String(r[2] || '').trim(); if (!nm) { excluded++; return; }
    if (isLeaveRow(r) || isSoftDel(r)) { excluded++; return; }
    const dt = bizDate(r[1]); if (!dt || !dt.startsWith('2026')) { excluded++; return; }
    const u = String(r[8] || '').trim(); if (u) prodU.add(u);
    const ck = [nm, String(r[5] || '').trim().toLowerCase(), String(r[6] || '').trim(), dt, String(r[7] || '').trim()].join('\u0002');
    const k3 = [nm, String(r[5] || '').trim().toLowerCase(), String(r[6] || '').trim(), dt].join('\u0002');
    const ei = enterInstant(r[0]);
    const known = (u && baseU.has(u)) || baseC.has(ck);
    if (known) return;
    // 不在底稿：分三类
    if (ei == null) { noEnter.push(r); return; }                       // 无录入时间：异常，不自动加
    if (ei <= watermark) {                                              // 录入≤水位线
      if (baseK3.has(k3)) { dups.push(r); return; }                     // 同人同项目同日同工时(备注不同)=重复变体，良性
      const k2 = [nm, String(r[5] || '').trim().toLowerCase(), String(r[6] || '').trim()].join('\u0002');
      const ds = baseK2.get(k2);
      if (ds) { for (const d of ds) { if (Math.abs((new Date(dt) - new Date(d)) / 86400000) <= 3) { shifted.push(r); return; } } }
      missed.push(r);                                                   // 内容确实不在底稿：疑似漏报/后补
      return;
    }
    add.push({ r, dt, u, ei });
  });
  // 去重(新增内部): 同 UUID 或同内容键只取第一条
  const seenU = new Set(), seenC = new Set(); const addFinal = [];
  add.forEach(x => {
    const ck = [String(x.r[2] || '').trim(), String(x.r[5] || '').trim().toLowerCase(), String(x.r[6] || '').trim(), x.dt, String(x.r[7] || '').trim()].join('\u0002');
    if (x.u && seenU.has(x.u)) return; if (seenC.has(ck)) return;
    if (x.u) seenU.add(x.u); seenC.add(ck); addFinal.push(x);
  });
  // 体检：底稿有、生产表没了（8/24 后被删）
  const deleted = base.filter(r => { const u = String(r[8] || '').trim(); return u && !prodU.has(u); });
  console.log('\n--- 体检结果 ---');
  console.log('生产表剔除行(请假/软删/非2026/无名) =', excluded);
  console.log('🆕 新增待入底稿(录入>水位线) =', addFinal.length, '条 | 工时 =', addFinal.reduce((s, x) => s + (parseFloat(x.r[6]) || 0), 0));
  console.log('♻ 重复变体(同人同项目同日同工时、备注不同，良性) =', dups.length);
  console.log('↔ 日期漂移变体(同人同项目同工时、日期差≤3天，两快照口径差异) =', shifted.length);
  console.log('⚠ 疑似漏报/后补(录入≤水位线且内容不在底稿) =', missed.length);
  console.log('❓ 无录入时间行(异常，不自动加) =', noEnter.length);
  console.log('🗑 底稿有但生产表已删(8/24后删) =', deleted.length);
  if (missed.length) { console.log(' 漏报样本(前8):'); missed.slice(0, 8).forEach(r => console.log('   ', bizDate(r[1]), r[2], r[5], r[6] + 'h', '| 录入:', String(r[0] || '').slice(0, 19), '| UUID:', String(r[8] || '').slice(0, 18))); }
  if (shifted.length) { console.log(' 漂移样本(前5):'); shifted.slice(0, 5).forEach(r => console.log('   ', bizDate(r[1]), r[2], r[5], r[6] + 'h', '| 录入:', String(r[0] || '').slice(0, 19))); }
  if (noEnter.length) { console.log(' 无录入样本(前8):'); noEnter.slice(0, 8).forEach(r => console.log('   ', bizDate(r[1]), r[2], r[5], r[6] + 'h', '| UUID:', String(r[8] || '').slice(0, 18))); }
  if (deleted.length) { console.log(' 已删样本(前8):'); deleted.slice(0, 8).forEach(r => console.log('   ', bizDate(r[1]), r[2], r[5], r[6] + 'h', '| UUID:', String(r[8] || '').slice(0, 18))); }
  if (addFinal.length) {
    addFinal.slice(0, 10).forEach(x => console.log('   +', x.dt, x.r[2], x.r[5], x.r[6] + 'h', '| 录入:', String(x.r[0] || '').slice(0, 19), '| UUID:', (x.u || '(无)').slice(0, 18)));
    if (addFinal.length > 10) console.log('    …其余', addFinal.length - 10, '条');
  }
  if (!APPLY) { console.log('\n(dry-run 不写。加 --apply 执行追加)'); return; }
  if (!addFinal.length) { console.log('\n无新增，不写。'); return; }
  // 🔴🔴 写前自守卫（2026-10-19 加）：写入这一跑会自己重读一次表格，若那次读坏了（返回空表），
  //     会把整张生产表当成新增灌进底稿。所以「读到的底稿行数」和「新增条数」两道闸都必须在写入前过硬。
  const MIN_BASE_APPLY = 5000, MAX_ADD_APPLY = 300;
  if (base.length < MIN_BASE_APPLY) {
    console.error('❌ 已中止写入：底稿只读到 ' + base.length + ' 行（低于 ' + MIN_BASE_APPLY + '），疑似读取失败。零写入。');
    process.exit(3);
  }
  if (addFinal.length > MAX_ADD_APPLY && !process.argv.includes('--force')) {
    console.error('❌ 已中止写入：本次新增 ' + addFinal.length + ' 条（高于 ' + MAX_ADD_APPLY + '），疑似异常。零写入；确认无误请加 --force 重跑。');
    process.exit(4);
  }
  // 追加到底稿末尾
  const rows = addFinal.map(x => { const r = x.r; return [r[0], x.dt, String(r[2] || '').trim(), r[3], r[4], r[5], r[6], r[7], x.u, r[9], '增量同步']; });
  // 🔴 起始行必须按「物理末行」算，不能按「非空行计数」算：
  //    底稿中间只要存在空行，base.length 就小于物理末行，用 base.length+2 会覆盖已有业务行。
  //    取两者较大值 —— 正常情况两者一致；有空行时往后让，宁可留空行也不覆盖。
  const naiveRow = base.length + 2;
  const physRow = (base.lastRow || (base.length + 1)) + 1;
  const startRow = Math.max(naiveRow, physRow);
  if (startRow !== naiveRow) {
    console.log('⚠️ 检测到底稿存在空行：计数法起始行=' + naiveRow + '，物理末行+1=' + physRow + ' → 采用 ' + startRow + '（避免覆盖已有行）');
  }
  const B = 500;
  for (let i = 0; i < rows.length; i += B) {
    const blk = rows.slice(i, i + B);
    const res = await call('patchCells', { sheet: CFG.baseTab, ssid: CFG.ssidMaster, ranges: [{ row: startRow + i, col: 1, values: blk }] }, { strict: true });
    // 严格判定：只有明确 ok===true 才算写入成功（旧写法把解析失败的 {} 也当成成功）
    if (!res || res.ok !== true) { console.log('写失败 @', startRow + i, JSON.stringify(res).slice(0, 150)); process.exit(1); }
  }
  // 写后复读
  const after = await readAll(CFG.ssidMaster, CFG.baseTab, 'K');
  console.log('\n追加', rows.length, '条 → 底稿行 =', after.length, '(期望', base.length + rows.length, ')', after.length === base.length + rows.length ? 'PASS' : '❌FAIL');
  const newU = new Set(after.map(r => String(r[8] || '').trim()));
  const lost = addFinal.filter(x => x.u && !newU.has(x.u)).length;
  console.log('新增 UUID 复读丢失 =', lost, lost === 0 ? 'PASS' : '❌FAIL');
})().catch(e => { console.error('ERR', e.message); process.exit(2); });
