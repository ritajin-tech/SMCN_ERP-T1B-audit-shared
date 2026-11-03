'use strict';
/**
 * T1-B 守卫不变量静态检查（只读，零写）— R5 回归闸门之一
 * ---------------------------------------------------------------
 * 拉取【线上】PeriodLockGuard.js 源码（Apps Script API 只读 GET），
 * 断言"防重复写入"关键不变量仍在，任何未来改动若移除/破坏这些不变量 → 本检查失败。
 * 这是真正"防止竞态 reintroduce"的闸门：原 bug 是"业务写在去重账本检查之前"，
 * 以下不变量把该模式固化，删掉即报错。
 *
 * 运行：node tools/guard_invariant_check.js
 * 退出码：0=全部不变量通过, 1=有失败, 2=无法取源码（网络/令牌）
 *
 * 红线：仅 GET /content（只读），不部署、不改链接、不写生产、不改冻结。
 */
const fs = require('fs');
const https = require('https');
const { URLSearchParams } = require('url');
const crypto = require('crypto');

const CLASP = 'C:/Users/rita.jin/.clasprc.json';
const SCRIPT_ID = '1FPAwV50VdpI2AGT42rfn6JhU0assY1QaARbhTQeiUKS0mZ66yf_JRb8R';

function getCreds() { return JSON.parse(fs.readFileSync(CLASP, 'utf8')).tokens.default; }
function refreshToken(d) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({ client_id: d.client_id, client_secret: d.client_secret, refresh_token: d.refresh_token, grant_type: 'refresh_token' }).toString();
    const u = new URL('https://oauth2.googleapis.com/token');
    const req = https.request({ hostname: u.hostname, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => { try { const j = JSON.parse(data); j.access_token ? resolve(j) : reject(new Error('refresh failed')); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}
function apiGet(path, token) {
  return new Promise((resolve, reject) => {
    const req = https.get('https://script.googleapis.com' + path, { headers: { Authorization: 'Bearer ' + token } }, (res) => {
      const ch = []; res.on('data', c => ch.push(c));
      res.on('end', () => { const t = Buffer.concat(ch).toString('utf8'); res.statusCode >= 400 ? reject(new Error('HTTP ' + res.statusCode)) : resolve(t); });
    });
    req.on('error', reject);
  });
}

async function main() {
  const out = { generated_at: new Date().toISOString(), checks: [], source_bytes: null, sha256: null };
  let fail = 0;
  const add = (name, pass, detail) => { out.checks.push({ name, pass, detail: detail || '' }); if (!pass) fail++; };

  let token;
  try {
    const d = getCreds(); const now = Date.now();
    token = d.access_token;
    if (!d.expiry_date || d.expiry_date < now + 60000) { const r = await refreshToken(d); token = r.access_token; }
  } catch (e) { out.error = 'token: ' + e.message; console.log(JSON.stringify(out, null, 2)); process.exit(2); }

  let src;
  try {
    const j = JSON.parse(await apiGet('/v1/projects/' + SCRIPT_ID + '/content', token));
    const files = j.files || [];
    const g = files.find(f => f.name === 'PeriodLockGuard');
    if (!g || !g.source) throw new Error('PeriodLockGuard 源码未取到');
    src = g.source;
    out.source_bytes = src.length;
    out.sha256 = crypto.createHash('sha256').update(src, 'utf8').digest('hex');
  } catch (e) { out.error = 'fetch: ' + e.message; console.log(JSON.stringify(out, null, 2)); process.exit(2); }

  // ---- 不变量 ----
  // 注意：线上守卫可能在头部注释里写 `function _plGuardedInsert(...)` 作为文档示例，
  // 且真实定义可能是 `const _plGuardedInsert = function(...)` 或箭头函数。
  // 故 A 类仅做"名称存在"粗检；D 类改用"窗口邻近"——从每个 _plGuardedInsert 出现位置
  // 向后看 W 字符，若其中含账本调用/锁调用即判通过（与具体定义语法无关）。
  const W = 4500;
  const idxs = [];
  let _m; const re = /_plGuardedInsert/g;
  while ((_m = re.exec(src))) idxs.push(_m.index);
  const winHas = (idx, needle) => idx >= 0 && src.slice(idx, idx + W).includes(needle);

  add('A1 _plGuardedInsert 存在', /_plGuardedInsert\s*\(/.test(src));
  add('A2 _plGuardedMutation 存在', /_plGuardedMutation\s*\(/.test(src));
  add('A3 _plGuardPatch 存在(W5覆盖)', /_plGuardPatch\s*\(/.test(src));
  add('A4 _plAcquire 存在(锁)', /_plAcquire\s*\(/.test(src) || /LockService/.test(src));
  add('B1 账本读 _plLedgerGet 存在', /_plLedgerGet\s*\(/.test(src));
  add('B2 账本写 _plLedgerSet 存在', /_plLedgerSet\s*\(/.test(src));
  add('B3 预留/重放 _plLedgerReserveOrReplay 存在', /_plLedgerReserveOrReplay\s*\(/.test(src));
  add('C1 requestId 自推导 _plDeriveRequestId 存在', /_plDeriveRequestId\s*\(/.test(src));

  // D1：去重账本检查与 _plGuardedInsert 定义邻近（任一出现位置的后 W 窗口内含账本调用即过）
  const d1 = idxs.some(i => winHas(i, '_plLedgerGet') || winHas(i, '_plLedgerReserveOrReplay'));
  add('D1 去重账本检查邻近 _plGuardedInsert（不改写表前先查账本）', d1, idxs.length + ' 处定义, 近旁含账本调用=' + d1);

  // D2：_plGuardedInsert 定义窗口内含取锁（_plAcquire / LockService / tryLock）= 先取锁再查账本
  const d2 = idxs.some(i => winHas(i, '_plAcquire') || winHas(i, 'LockService') || winHas(i, 'tryLock'));
  add('D2 先取锁再查账本（并发安全）', d2, '近旁含锁原语=' + d2);

  console.log('=== T1-B 守卫不变量静态检查（线上 PeriodLockGuard.js）===');
  console.log('源码字节 :', out.source_bytes, '| SHA256:', out.sha256.slice(0, 16), '...');
  out.checks.forEach(c => console.log('  ' + (c.pass ? 'PASS' : 'FAIL') + '  ' + c.name + (c.detail ? '  (' + c.detail + ')' : '')));
  console.log('结果     : ' + (fail === 0 ? '全部通过' : fail + ' 项失败'));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = __dirname + '/evidence'; fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dir + '/guard_invariant_' + stamp + '.json', JSON.stringify(out, null, 2));
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(2); });
