// 十月重复组取证（只读）· 2026-10-27
// 用途：为每组重复绑定「两成员稳定标识 + 逐列负载比对」，输出 IDENTICAL / CONFLICT 分类。
// 对应 Tom 要求：不同核心负载必须列 CONFLICT，不得自动裁决；只有完全相同负载且同状态才可提折叠候选。
// 用法：node tools/forensics/oct_dup_evidence.js [月份前缀，默认 2026-10] > out.json
const https = require('https');
const { URL: NU } = require('url');
const WEBAPP = '<HKTOOL_WEBAPP_URL: 见本地 .hktool_remote.json（公开仓不内嵌端点）>';
const KEY = process.env.TS_HKTOOL_KEY || '<HKTOOL_KEY: 见本地 .hktool_remote.json（公开仓不内嵌）>';

const TS_ID = '1Pi5u9fEawgp7yICWPMMyQCT_LbwTZthQDW-H05xYdVI';
const SHEET = 'DB_工时流水';
const MONTH = process.argv[2] || '2026-10';
const INCL_SOFT = (process.argv[3] === 'inclSoft');   // 是否把已软删行也纳入分组
const MAXROW = 6200;

function call(pl) {
  return new Promise(resolve => {
    const b = JSON.stringify(pl);
    const u = new NU(WEBAPP);
    const r = https.request({ host: u.host, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) } }, res => {
      if (res.statusCode === 302 && res.headers.location) {
        res.resume();
        const u2 = new NU(res.headers.location);
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
async function get(fn, args) {
  for (let i = 0; i < 4; i++) {
    const s = await call({ action: 'hkRemoteRun', key: KEY, fn, args });
    let j; try { j = JSON.parse(s); } catch (e) {}
    if (j && j.result) return j.result;
    await new Promise(r => setTimeout(r, 1200));
  }
  return {};
}

const norm = v => (v === undefined || v === null) ? '' : String(v).trim();
// 🔴 关键：执行器返回的是 UTC ISO 串（如 "2026-03-31T16:00:00.000Z"，实为 GMT+8 的 04-01 00:00）。
//   直接 slice(0,10) 会整体偏一天，必须 +8h 再取日期。
function toBJ(v) {
  const d = (v instanceof Date) ? v : new Date(norm(v));
  return isNaN(d.getTime()) ? null : new Date(d.getTime() + 8 * 3600e3);
}
function bizDate(v) {
  const bj = toBJ(v);
  if (bj) return bj.toISOString().slice(0, 10);
  const s = norm(v); if (!s) return '';
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : s.slice(0, 10);
}
const softDel = v => (v === true || String(v).toUpperCase() === 'TRUE');
const ts = v => (v instanceof Date) ? v.getTime()
  : (() => { const t = new Date(norm(v)).getTime(); return isNaN(t) ? 0 : t; })();

const COLS = ['A录入时间', 'B业务日期', 'C姓名', 'D类型', 'E阶段', 'F项目编号', 'G工时',
              'H备注', 'I UUID', 'J项目名', 'K', 'L负责人', 'M', 'N年月'];

(async () => {
  // 1) 先探 lastRow（表会增长，不能写死上限）
  const probe = await get('inspectWorkbook', { ssId: TS_ID, sheet: SHEET, mode: 'values', a1: 'A1:Q2' });
  const lastRow = probe.lastRow || MAXROW;
  process.stderr.write(`[META] lastRow=${lastRow} lastCol=${probe.lastCol}\n`);

  // 2) 全表只读（分块）
  const CHUNK = 400, rows = [];
  for (let s = 1; s <= lastRow; s += CHUNK) {
    const e = Math.min(s + CHUNK - 1, lastRow);
    const r = await get('inspectWorkbook', { ssId: TS_ID, sheet: SHEET, mode: 'values', a1: `A${s}:Q${e}` });
    (r.values || []).forEach((cells, i) => rows.push({ row: s + i, cells: cells || [] }));
  }
  const data = rows.filter(x => x.row > 1 && x.cells.some(c => norm(c) !== ''));
  process.stderr.write(`[READ] 有效数据行 ${data.length}\n`);

  // 2) 分组口径 = I 列 UUID（稳定身份，Tom 要求），内容键只作为附加载荷指纹
  //    （早期 1778/117 的数字正是按 UUID 重复算出来的；按内容键算会因备注差异而漏并）
  const groups = {};
  for (const { row, cells } of data) {
    if (!INCL_SOFT && softDel(cells[14])) continue;   // 默认跳过已软删
    const name = norm(cells[2]), bd = bizDate(cells[1]);
    if (!name || !bd) continue;
    if (MONTH !== 'ALL' && !bd.startsWith(MONTH)) continue;
    const pid = norm(cells[5]);
    if (/OFF[-_]?WORK/i.test(pid)) continue;
    const hrs = (parseFloat(cells[6]) || 0).toFixed(2);
    const uuid = norm(cells[8]);
    const groupKey = uuid || ('__NOUUID__\u0002' + row);   // 空 UUID 各自成组，不合并
    const fingerprint = [name, bd, pid, hrs, norm(cells[7]).slice(0, 50)].join('\u0001');
    (groups[groupKey] = groups[groupKey] || { bd, uuid, members: [] })
      .members.push({ row, cells, fingerprint, noUuid: !uuid });
  }

  const dupKeys = Object.keys(groups).filter(k => groups[k].members.length >= 2);
  process.stderr.write(`[GROUP] ${MONTH} 重复组 ${dupKeys.length}\n`);

  // 3) 逐组：按录入时间升序，首行=keeper，其余=dup；逐列比对 14 列
  const identical = [], conflict = [], multi = [];
  for (const k of dupKeys) {
    const month = (groups[k].bd || '').slice(0, 7);
    // 排序：未软删的优先作 keeper；同为未软删/已软删时按录入时间升序（保留最早）
    const arr = groups[k].members.slice().sort((a, b) => {
      const sa = softDel(a.cells[14]) ? 1 : 0, sb = softDel(b.cells[14]) ? 1 : 0;
      if (sa !== sb) return sa - sb;
      return ts(a.cells[0]) - ts(b.cells[0]);
    });
    if (arr.length > 2) {
      multi.push({ month, key: k.replace(/\u0001/g, ' | '), rows: arr.map(x => x.row),
                   uuids: arr.map(x => norm(x.cells[8])) });
      continue;
    }
    const [k0, d0] = arr;
    const diffs = [];
    for (let c = 0; c < 14; c++) {
      const a = norm(k0.cells[c]), b = norm(d0.cells[c]);
      if (a !== b) diffs.push({ col: COLS[c], keeper: a, dup: b });
    }
    const rec = {
      month,
      uuid: groups[k].uuid || '(空UUID)',
      noUuid: !!k0.noUuid,
      fingerprint: k0.fingerprint.replace(/\u0001/g, ' | '),
      fingerprintSame: k0.fingerprint === d0.fingerprint,
      keeper: { row: k0.row, uuid: norm(k0.cells[8]), loggedAt: norm(k0.cells[0]),
                softDel: softDel(k0.cells[14]), hours: norm(k0.cells[6]) },
      dup:    { row: d0.row,   uuid: norm(d0.cells[8]),  loggedAt: norm(d0.cells[0]),
                softDel: softDel(d0.cells[14]), hours: norm(d0.cells[6]) },
      diffCount: diffs.length, diffs
    };
    (diffs.length === 0 ? identical : conflict).push(rec);
  }

  // 按月汇总，便于与历史口径（1778 组 / 117 组十月）交叉核对
  const byMonth = {};
  const bump = (m, kind, hrs) => {
    byMonth[m] = byMonth[m] || { groups: 0, identical: 0, conflict: 0, multi: 0, dupHours: 0 };
    byMonth[m].groups++; byMonth[m][kind]++;
    byMonth[m].dupHours = +(byMonth[m].dupHours + (parseFloat(hrs) || 0)).toFixed(2);
  };
  identical.forEach(r => bump(r.month, 'identical', r.dup.hours));
  conflict.forEach(r => bump(r.month, 'conflict', r.dup.hours));
  multi.forEach(r => bump(r.month, 'multi', 0));

  const out = {
    meta: { month: MONTH, lastRow, dataRows: data.length,
            generatedAtBJT: new Date(Date.now() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19),
            source: { ssId: TS_ID, sheet: SHEET }, readOnly: true,
            note: '只读取证。IDENTICAL=14列负载完全相同（可折叠候选）；CONFLICT=有列不同（禁止自动裁决，须人工）；MULTI=同键3行以上（一律人工）' },
    summary: { totalGroups: dupKeys.length, identical: identical.length, conflict: conflict.length, multi: multi.length,
               identicalHours: +(identical.reduce((s, r) => s + (parseFloat(r.dup.hours) || 0), 0)).toFixed(2),
               conflictHours: +(conflict.reduce((s, r) => s + (parseFloat(r.dup.hours) || 0), 0)).toFixed(2) },
    byMonth,
    identical, conflict, multi
  };
  process.stdout.write(JSON.stringify(out, null, 2));
})();
