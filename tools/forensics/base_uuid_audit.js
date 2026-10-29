// A6+ 底稿侧取证（只读）：数清「主库底稿里每个 UUID 究竟有几行」，
// 修正 dup_vs_base.js 的判定缺陷 —— 生产行判 inBase 只说明"身份在底稿出现过"，
// 不等于"底稿里有一份独立副本"。软标生产副本会不会让主库少数据，取决于底稿行数。
// 用法：node tools/forensics/base_uuid_audit.js
const https = require('https');
const { URL: NU } = require('url');
const WEBAPP = '<HKTOOL_WEBAPP_URL: 见本地 .hktool_remote.json（公开仓不内嵌端点）>';
const KEY = process.env.TS_HKTOOL_KEY || '<HKTOOL_KEY: 见本地 .hktool_remote.json（公开仓不内嵌）>';

const MASTER_ID = '1oxPj0mzN8poP2vQ7Bm-YKXuU49p9b0c1asyrZn4Py44';
const BASE_TAB = '工时_候选0824';
const TS_ID = '1Pi5u9fEawgp7yICWPMMyQCT_LbwTZthQDW-H05xYdVI';
const PROD_TAB = 'DB_工时流水';

function call(pl) {
  return new Promise(resolve => {
    const b = JSON.stringify(pl); const u = new NU(WEBAPP);
    const r = https.request({ host: u.host, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) } }, res => {
      if (res.statusCode === 302 && res.headers.location) {
        res.resume(); const u2 = new NU(res.headers.location);
        const r2 = https.request({ host: u2.host, path: u2.pathname + (u2.search || ''), method: 'GET' }, res2 => {
          const c = []; res2.on('data', d => c.push(d)); res2.on('end', () => resolve(Buffer.concat(c).toString('utf8')));
        });
        r2.on('error', e => resolve('ERR ' + e.message)); r2.end(); return;
      }
      const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve(Buffer.concat(c).toString('utf8')));
    });
    r.on('error', e => resolve('ERR ' + e.message)); r.write(b); r.end();
  });
}
async function get(args) {
  for (let i = 0; i < 4; i++) {
    const s = await call({ action: 'hkRemoteRun', key: KEY, fn: 'inspectWorkbook', args });
    let j; try { j = JSON.parse(s); } catch (e) {}
    if (j && j.result) return j.result;
    await new Promise(r => setTimeout(r, 1200));
  }
  return {};
}
async function readAll(ssId, sheet, lastCol) {
  const probe = await get({ ssId, sheet, mode: 'values', a1: 'A1:' + lastCol + '2' });
  const last = probe.lastRow || 0;
  const out = [];
  for (let s = 1; s <= last; s += 400) {
    const e = Math.min(s + 399, last);
    const r = await get({ ssId, sheet, mode: 'values', a1: `A${s}:${lastCol}${e}` });
    (r.values || []).forEach((cells, i) => out.push({ row: s + i, cells: cells || [] }));
  }
  return { rows: out.filter(x => x.cells.some(c => String(c ?? '').trim() !== '')), lastRow: last };
}

const norm = v => (v === undefined || v === null) ? '' : String(v).trim();
const num = v => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
function malBizDate(v) {
  if (!v) return '';
  const d = new Date(norm(v)); if (isNaN(d.getTime())) return norm(v).substring(0, 10);
  return new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 10);
}
const contentKey = (nm, proj, hrs, dt, note) =>
  [nm, String(proj || '').toLowerCase(), String(hrs || ''), dt, String(note || '')].join('\u0002');
const softDel = r => (r[14] === true || String(r[14] || '').toUpperCase() === 'TRUE');

// CAS 绑定用：与 ts_softdel_core.js / GAS _sdNorm 完全一致的规范化与 hash。
// 数值字符串规范化（"8.0"→"8"），与 GAS 原生数值对齐；hash 取 2..13 列（排除日期列 0/1）。
const _sdNorm = v => {
  if (v === undefined || v === null) return '';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  var s = String(v).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return String(Number(s));
  return s;
};
function _sdNormHash(cells) {
  var s = '';
  for (var c = 2; c <= 13; c++) s += '\x1f' + _sdNorm(cells ? cells[c] : '');
  var h = 5381;
  for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return 'h' + h.toString(16);
}

(async () => {
  // ---- 底稿侧 ----
  const base = await readAll(MASTER_ID, BASE_TAB, 'O');
  const bRow = base.rows.slice(1);
  const baseUuidCount = {}, baseUuidRows = {};
  const baseByRow = {};
  const baseKeyCount = {};
  let bNoUuid = 0;
  for (const r of bRow) {
    const c = r.cells;
    baseByRow[r.row] = c;
    const u = norm(c[8]);
    if (u) { baseUuidCount[u] = (baseUuidCount[u] || 0) + 1; (baseUuidRows[u] = baseUuidRows[u] || []).push(r.row); }
    else bNoUuid++;
    const nm = norm(c[2]), dt = malBizDate(c[1]);
    if (nm && dt) { const k = contentKey(nm, c[5], c[6], dt, c[7]); baseKeyCount[k] = (baseKeyCount[k] || 0) + 1; }
  }
  process.stderr.write(`[BASE] 底稿数据行 ${bRow.length}，有UUID ${bRow.length - bNoUuid}，无UUID ${bNoUuid}\n`);

  // ---- 生产侧 ----
  const prod = await readAll(TS_ID, PROD_TAB, 'Q');
  const pRow = prod.rows.slice(1);
  const prodUuid = {};
  let pNoUuid = 0;
  for (const r of pRow) {
    const c = r.cells;
    const u = norm(c[8]);
    if (u) (prodUuid[u] = prodUuid[u] || []).push({ row: r.row, cells: c, soft: softDel(c), hours: num(c[6]) });
    else pNoUuid++;
  }
  process.stderr.write(`[PROD] 生产数据行 ${pRow.length}，有UUID ${pRow.length - pNoUuid}，无UUID ${pNoUuid}\n`);

  // ---- 逐 UUID 三态：生产 live 行数 vs 底稿行数 ----
  const verdict = { safe: [], baseAlsoDup: [], orphanInBase: [], notInBase: [] };
  let dupGroups = 0;
  for (const u of Object.keys(prodUuid)) {
    const rows = prodUuid[u];
    const live = rows.filter(x => !x.soft);
    const b = baseUuidCount[u] || 0;
    if (rows.length >= 2 || (rows.length === 1 && b >= 2)) {
      dupGroups++;
      const liveH = +live.reduce((s, x) => s + x.hours, 0).toFixed(1);
      // 逐冗余行 CAS 绑定 hash（绑定到本次冻结审计快照，执行时服务端锁内重读实时值比对）
      const targets = [];
      if (live.length >= 2) {
        const keeper = live[0];
        const baseRowNums = baseUuidRows[u] || [];
        for (let k = 1; k < live.length; k++) {
          const trow = live[k];
          targets.push({
            row: trow.row,
            keeperRow: keeper.row,
            targetHash: _sdNormHash(trow.cells),
            keeperHash: _sdNormHash(keeper.cells),
            baseHash: (b === 1 && baseRowNums[0] != null) ? _sdNormHash(baseByRow[baseRowNums[0]]) : undefined
          });
        }
      }
      const rec = { uuid: u, prodRows: rows.length, prodLive: live.length, prodLiveHours: liveH,
                    baseRows: b, baseRowNums: (baseUuidRows[u] || []).slice(0, 5),
                    prodRowNums: rows.map(x => x.row).slice(0, 5),
                    targets: targets,
                    month: malBizDate(rows[0].cells[1]).slice(0, 7) };
      if (b === 0) verdict.notInBase.push(rec);
      else if (b === 1 && live.length >= 2) verdict.safe.push(rec);          // 底稿 1 份，生产 ≥2 份 → 软标多余份安全
      else if (b === 1 && live.length === 1) verdict.orphanInBase.push(rec); // 生产只剩 1 份且底稿有 → 无需动作
      else if (b >= 2) verdict.baseAlsoDup.push(rec);                        // 底稿自身也多份 → 必须连底稿一起裁
    }
  }

  const sum = a => ({ groups: a.length, prodLiveHours: +a.reduce((s, x) => s + x.prodLiveHours, 0).toFixed(1),
                      baseRows: a.reduce((s, x) => s + x.baseRows, 0) });

  const out = {
    meta: {
      generatedAtBJT: new Date(Date.now() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19),
      readOnly: true,
      logic: '底稿 UUID 行数审计（修正 dup_vs_base 的 inBase 判定缺陷）',
      note: 'baseRows = 主库底稿 工时_候选0824 中该 UUID 的实际行数；判定软标安全性看 baseRows>=2 才需连底稿清理',
      master: { ssId: MASTER_ID, tab: BASE_TAB }, prod: { ssId: TS_ID, tab: PROD_TAB }
    },
    base: { dataRows: bRow.length, withUuid: bRow.length - bNoUuid, noUuid: bNoUuid,
            distinctUuid: Object.keys(baseUuidCount).length,
            uuidHavingMultiRows: Object.values(baseUuidCount).filter(n => n >= 2).length,
            keyHavingMultiRows: Object.values(baseKeyCount).filter(n => n >= 2).length },
    prod: { lastRow: prod.lastRow, dataRows: pRow.length, withUuid: pRow.length - pNoUuid, noUuid: pNoUuid,
            distinctUuid: Object.keys(prodUuid).length },
    dupGroups,
    verdict: {
      SAFE_base1_prodMulti: { ...sum(verdict.safe), meaning: '底稿恰 1 行、生产仍生效 ≥2 行 → 软标生产多余份不丢主库数据', sample: verdict.safe.slice(0, 5) },
      BASE_ALSO_DUP: { ...sum(verdict.baseAlsoDup), meaning: '底稿自身 ≥2 行 → 软标生产不够，主库也要裁，需人工', sample: verdict.baseAlsoDup.slice(0, 5) },
      ORPHAN_base1_prod1: { ...sum(verdict.orphanInBase), meaning: '底稿 1 行、生产剩 1 份生效 → 已一致，无需动作', sample: verdict.orphanInBase.slice(0, 5) },
      NOT_IN_BASE: { ...sum(verdict.notInBase), meaning: '生产有重复但底稿 0 行 → 主库从未收到，软标前先补录还是判冗余需人工', sample: verdict.notInBase.slice(0, 5) }
    },
    detail: { safe: verdict.safe, baseAlsoDup: verdict.baseAlsoDup, orphanInBase: verdict.orphanInBase, notInBase: verdict.notInBase }
  };
  process.stdout.write(JSON.stringify(out, null, 2));
})();
