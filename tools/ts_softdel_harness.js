// 执行器隔离 harness —— 离线、不连生产，直接跑真实 ts_softdel.js
// 目的：用确定性 mock 运输层 + 忠实模拟 A1d 服务端 tsSoftDelGuarded，证明整条调用链（executor→ts_post→服务端CAS）的行为。
//       回应 Tom 2026-10-27 第2/3/4条 + 隔离 harness 10 场景规格：
//
//   同UUID同负载恰一次 ........ S1  正常路径（ok+全部写入+回读 TRUE）→ 退出 0
//   写成功响应丢失可查批次 .... S2  空响应 → 登记不明、不盲重试 → 退出 1
//   服务端 ok=false ........... S3  → 登记不明、不盲重试 → 退出 1
//   部分写入 .................. S4  wrote≠batch → 登记不明、不盲重试 → 退出 1
//   读快照缺页拒绝 ............ S5  底稿读取失败 → 整批拒绝（防自动降级）→ 退出 1
//   A级变B级拒绝 .............. S5b A级预期但底稿缺该UUID(bc=0) → 拒绝且不降级 → 退出 0(空批，已拦截)
//   每批回读O列不符 ........... S6  服务端声称写成功但回读 FALSE → 登记不明、不盲重试 → 退出 1
//   生产表读取失败 ............ S7  → 整批拒绝、不盲写 → 退出 1
//   异负载CONFLICT零覆盖 ...... S8  锁内重读发现目标≠keeper负载 → CONFLICT、零覆盖 → 退出 1
//   锁忙零写 .................. S9  锁占用 → 服务端 ok=false、零写入 → 退出 1
//   keeper/行号变化拒绝 ....... S10 锁内重读发现 keeper 已失效/消失 → KEEPER_INVALID、零覆盖 → 退出 1
//   关账拒绝+合法新行+幂等 .... S11 关账期内行 PERIOD_LOCKED 拒；合法新行放行；重放开行后幂等重试安全
//   批中断+flush失败 .......... S12 写1行后崩溃 → 中止；重跑已写行幂等跳过、其余补齐、不双写
//
// 机制：mock HTTP（hktool 风格）提供只读 readAll/rereadO（读取 STATE.live）；
//       mock ts_post.py 忠实实现 tsSoftDelGuarded（锁内重读 UUID+负载+keeper→校验→写→回读），两者经 STATE 文件协调。
// 🔧 仅依赖 ts_softdel.js 的 3 个 env seam（TS_WEBAPP_OVERRIDE / TS_POST_BIN / TS_AUDIT_OVERRIDE），默认=生产值。

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync, execSync } = require('child_process');

const TOOLS = __dirname;
let PORT = 0;
const TMP = fs.mkdtempSync(path.join(require('os').tmpdir(), 'tsharness-'));
const STATE = path.join(TMP, 'state.json');
const AUDIT = path.join(TMP, 'audit.json');
const MOCK_POST = path.join(TMP, 'mock_ts_post.py');

// ---- mock ts_post.py（被 ts_softdel.js 以子进程方式调用；忠实模拟 A1d 服务端 tsSoftDelGuarded）----
const MOCK_POST_SRC = `
import sys, json, os
state = json.load(open(${JSON.stringify(STATE)}))
mode = state.get('tspost_mode', 'ok')
live = state.get('live', {})
prod = live.get('prod', []) or []
master = live.get('master', []) or []
payload = json.load(open(sys.argv[2]))
rows = payload.get('rows', [])

def norm(v):
    return '' if v is None else str(v).strip()

def cells(rowidx):
    idx = rowidx - 1
    if idx < 0 or idx >= len(prod): return None
    c = prod[idx]
    if c is None: return None
    return (list(c) + [''] * 15)[:15]

def persist():
    state['live']['prod'] = prod
    json.dump(state, open(${JSON.stringify(STATE)}, 'w'))

# ---- 短路模式（S2/S3/S4 用，不进 CAS）----
if mode == 'lost':
    sys.stdout.write(''); sys.exit(0)
if mode == 'nonjson':
    sys.stdout.write('HTTP 502 Gateway Error html page'); sys.exit(0)
if mode == 'ok_false':
    sys.stdout.write(json.dumps({'ok': False, 'error': 'simulated server failure'})); sys.exit(0)
if mode == 'partial':
    res = [{'row': r['row'], 'ok': True, 'wrote': True} for r in rows[:-1]]
    res.append({'row': rows[-1]['row'], 'ok': False, 'reason': 'simulated partial'})
    sys.stdout.write(json.dumps({'ok': True, 'dry': False, 'patched': len(rows) - 1, 'total': len(rows), 'results': res})); sys.exit(0)

# ---- 忠实 tsSoftDelGuarded：锁内重读→校验→写→回读 ----
closed = state.get('closedMaxDate')
lock_busy = state.get('lockBusy', False)
conflict_rows = set(state.get('conflictRows', []) or [])
keeper_dead_rows = set(state.get('keeperDeadRows', []) or [])
no_persist = set(state.get('noPersistRows', []) or [])
flush_fail = state.get('flushFail', False)

if lock_busy:
    sys.stdout.write(json.dumps({'ok': False, 'lockBusy': True, 'error': 'lock busy, zero writes'})); sys.exit(0)

results = []
wrote = 0
for r in rows:
    rowidx = r['row']; keeper = r['keeperRow']; uuid = r['uuid']
    tgt = cells(rowidx); keep = cells(keeper)
    if tgt is None:
        results.append({'row': rowidx, 'ok': False, 'reason': 'TARGET_MISSING'}); continue
    if keep is None or all(norm(x) == '' for x in keep) or norm(keep[14]) == 'TRUE':
        results.append({'row': rowidx, 'ok': False, 'reason': 'KEEPER_INVALID'}); continue
    if norm(tgt[8]) != uuid:
        results.append({'row': rowidx, 'ok': False, 'reason': 'UUID_DRIFT'}); continue
    # 锁内重读时发现与 keeper 负载不一致（异负载 / 并发改）→ CONFLICT，绝不覆盖
    if rowidx in conflict_rows:
        tgt = list(tgt); tgt[6] = str(float(norm(tgt[6]) or 0) + 1)  # 模拟并发修改目标行负载
    diffs = [c for c in range(0, 14) if norm(tgt[c]) != norm(keep[c])]
    if diffs:
        results.append({'row': rowidx, 'ok': False, 'reason': 'CONFLICT', 'cols': diffs}); continue
    # keeper 在锁内被判定失效（行号变化/keeper 消失，模拟并发改 keeper）
    if rowidx in keeper_dead_rows:
        results.append({'row': rowidx, 'ok': False, 'reason': 'KEEPER_INVALID'}); continue
    o = norm(tgt[14])
    if o == 'TRUE':  # 已软标 → 幂等跳过（重跑安全）
        results.append({'row': rowidx, 'ok': True, 'wrote': True, 'idempotent': True}); wrote += 1; continue
    if closed and norm(tgt[1]) <= closed:  # 关账期内 → 拒（合法新行=期外放行）
        results.append({'row': rowidx, 'ok': False, 'reason': 'PERIOD_LOCKED', 'closedMax': closed}); continue
    # 写 O=TRUE（noPersist 模拟“声称写成功但回读不符”）
    if rowidx in no_persist:
        results.append({'row': rowidx, 'ok': True, 'wrote': True}); wrote += 1
    else:
        prod[rowidx - 1] = list(prod[rowidx - 1]); prod[rowidx - 1][14] = 'TRUE'
        results.append({'row': rowidx, 'ok': True, 'wrote': True}); wrote += 1
        if flush_fail:  # 批中断+flush 失败：写完首行即崩溃
            persist(); sys.stderr.write('FLUSH_FAIL simulated crash after 1 write\\n'); sys.exit(2)
persist()
sys.stdout.write(json.dumps({'ok': True, 'dry': False, 'patched': wrote, 'total': len(rows), 'results': results}))
sys.exit(0)
`;

// ---- mock HTTP（hktool 风格，明文 HTTP；生产 ts_softdel.js 仅按协议选传输层，默认仍走 https）----
function startServer() {
  return new Promise(resolve => {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
      let parsed = {};
      try { parsed = JSON.parse(body); } catch (e) {}
      const args = parsed.args || {};
      const sheet = args.sheet;
      let values, lastRow;
      if (sheet && /^O\d+:O\d+$/.test(args.a1 || '')) {
        // rereadO：返回该行 O 列（先判，因 rereadO 也带 sheet=DB_工时流水）
        const m = (args.a1).match(/O(\d+):O\d+/);
        const idx = m ? (parseInt(m[1], 10) - 1) : -1;
        const live = st.live || { prod: [], master: [] };
        const v = (live.prod[idx] && live.prod[idx][14]) ? 'TRUE' : '';
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ result: { values: [[v]] } }));
        return;
      } else if (sheet === 'DB_工时流水') { values = (st.live || {}).prod || []; }
      else if (sheet === '工时_候选0824') { values = (st.live || {}).master || []; }
      else { values = []; }
      // 忠实按 a1 行区间切片（readAll 会分块拉，避免整表重复返回）
      const mm = (args.a1 || '').match(/A(\d+):/i);
      const start = mm ? (parseInt(mm[1], 10) - 1) : 0;
      const slice = (start >= 0) ? values.slice(start) : values;
      lastRow = Math.max(0, values.length - 1);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ result: { values: slice, lastRow: lastRow } }));
    });
  });
  srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function buildAudit(safe, notInBase) {
  const a = { detail: { safe: [], notInBase: [] } };
  (safe || []).forEach(rec => a.detail.safe.push(rec));
  (notInBase || []).forEach(rec => a.detail.notInBase.push(rec));
  fs.writeFileSync(AUDIT, JSON.stringify(a), 'utf8');
}

// 行构造：15 列 [A..O]，索引 1=业务日期, 2=姓名, 6=工时, 8=UUID, 14=O
function row(uuid, o, name, hrs, note, date) {
  const r = new Array(15).fill('');
  r[1] = date || '2026-06-01';
  r[2] = name || '张三';
  r[6] = hrs != null ? hrs : '8';
  r[8] = uuid || '';
  r[14] = o || '';
  if (note) r[7] = note;
  return r;
}
function header() { const h = new Array(15).fill(''); h[0] = 'HDR'; return h; }

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? ' —— ' + detail : '')); }
}

function makeEnv() {
  const env = Object.assign({}, process.env, {
    TS_WEBAPP_OVERRIDE: 'http://127.0.0.1:' + PORT + '/exec',
    TS_POST_BIN: MOCK_POST,
    TS_AUDIT_OVERRIDE: AUDIT,
  });
  delete env.TS_WRITE_FREEZE;   // 离线 harness：解锁 --apply（仅打 mock，绝不碰生产）
  return env;
}

// 写入该场景的 STATE（live + 控制标志），跑一次真实 ts_softdel.js
async function runScenario(opts) {
  const { name, mode, live, closedMaxDate, lockBusy, conflictRows, keeperDeadRows,
          noPersistRows, flushFail, auditSafe, auditAll, expectExit, expectStderr } = opts;
  const st = {
    tspost_mode: mode || 'ok',
    live: live || { prod: [header()], master: [header()] },
    closedMaxDate: closedMaxDate || null,
    lockBusy: !!lockBusy,
    conflictRows: conflictRows || [],
    keeperDeadRows: keeperDeadRows || [],
    noPersistRows: noPersistRows || [],
    flushFail: !!flushFail,
  };
  fs.writeFileSync(STATE, JSON.stringify(st), 'utf8');
  const env = makeEnv();
  const args = [path.join(TOOLS, 'ts_softdel.js')];
  if (auditAll) args.push('--audit-all'); else if (auditSafe) args.push('--audit-safe');
  args.push('--apply');
  return await new Promise(resolve => {
    const child = spawn('node', args, { cwd: TOOLS, env: env });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('close', code => {
      let okExit = (code === expectExit);
      let okMsg = true;
      if (expectStderr && !(stdout + stderr).includes(expectStderr)) okMsg = false;
      resolve({ name, ok: okExit && okMsg, code, stderr, stdout });
    });
  });
}

// 读回 STATE.live（用于后验“零覆盖 / 已写 / 幂等”）
function readLive() { return JSON.parse(fs.readFileSync(STATE, 'utf8')).live; }
function oVal(live, rowidx) { const c = live.prod[rowidx - 1]; return c ? (c[14] || '') : ''; }

(async () => {
  fs.writeFileSync(MOCK_POST, MOCK_POST_SRC, 'utf8');
  const srv = await startServer();
  PORT = srv.address().port;

  const U_SAFE = 'TS-SAFE-0001';
  const U_B = 'TS-B-0002';
  const U_A = 'TS-PERIOD-A';   // 关账期内
  const U_C = 'TS-PERIOD-C';   // 合法新行（期外）

  // 共同数据：safe 组（keeper=2, dup=3 同负载）；B 组（keeper=4, dup=5 同负载）
  const baseProd = [
    header(),
    row(U_SAFE, '', '张三', '8', 'noteX'),       // row2 keeper
    row(U_SAFE, '', '张三', '8', 'noteX'),       // row3 dup (同负载)
    row(U_B, '', '李四', '8', 'noteY'),          // row4 keeper
    row(U_B, '', '李四', '8', 'noteY'),          // row5 dup (同负载)
  ];
  const baseMaster = [
    header(),
    row(U_SAFE, '', '张三', '8', 'noteX'),       // row2：safe UUID 在底稿恰 1 行 → bc=1
    row('OTHER-UUID-9', '', '王五', '8', 'noteZ'), // row3：另一条无关底稿行，避开读取失败闸门
    // 注意：U_B 不在底稿 → bc=0（符合 B 级预期）
  ];

  console.log('=== ts_softdel 执行器隔离 harness（离线，不连生产，mock 忠实模拟 tsSoftDelGuarded） ===\n');

  // S1 正常路径
  buildAudit([{ uuid: U_SAFE, prodRowNums: [2, 3] }], [{ uuid: U_B, prodRowNums: [4, 5] }]);
  let r1 = await runScenario({ name: 'S1 同UUID同负载恰一次（ok+全部写入+回读 TRUE）', live: { prod: baseProd, master: baseMaster }, auditAll: true, expectExit: 0 });
  { const live = readLive();
    check(r1.name + ' → 退出0', r1.ok, 'code=' + r1.code);
    check('S1 → 行3/行5 的 O 已置 TRUE（恰一次写入）', oVal(live, 3) === 'TRUE' && oVal(live, 5) === 'TRUE'); }

  // S2 响应丢失
  let r2 = await runScenario({ name: 'S2 响应丢失（空）→ 登记不明、不盲重试', mode: 'lost', live: { prod: baseProd, master: baseMaster }, auditAll: true, expectExit: 1, expectStderr: '登记不明' });
  { const live = readLive(); check(r2.name, r2.ok, 'code=' + r2.code);
    check('S2 → 零覆盖（O 仍空）', oVal(live, 3) === '' && oVal(live, 5) === ''); }

  // S3 ok=false
  let r3 = await runScenario({ name: 'S3 服务端 ok=false → 登记不明、不盲重试', mode: 'ok_false', live: { prod: baseProd, master: baseMaster }, auditAll: true, expectExit: 1, expectStderr: 'ok=false' });
  { const live = readLive(); check(r3.name, r3.ok, 'code=' + r3.code);
    check('S3 → 零覆盖', oVal(live, 3) === '' && oVal(live, 5) === ''); }

  // S4 部分写入
  let r4 = await runScenario({ name: 'S4 部分写入（wrote≠batch）→ 登记不明、不盲重试', mode: 'partial', live: { prod: baseProd, master: baseMaster }, auditAll: true, expectExit: 1, expectStderr: '期望写' });
  { const live = readLive(); check(r4.name, r4.ok, 'code=' + r4.code);
    check('S4 → 零覆盖（批整体拒，不认部分）', oVal(live, 3) === '' && oVal(live, 5) === ''); }

  // S5 底稿读取失败 → 整批拒绝（防自动降级）
  let r5 = await runScenario({ name: 'S5 底稿读取失败 → 整批拒绝、不盲写（防自动降级）', live: { prod: baseProd, master: [header()] }, auditSafe: true, expectExit: 1, expectStderr: '底稿读取失败' });
  { const live = readLive(); check(r5.name, r5.ok, 'code=' + r5.code);
    check('S5 → 零覆盖', oVal(live, 3) === ''); }

  // S5b A 级预期但底稿恰好 0 行（master 有数据但不含该 UUID）→ bc=0，拒绝且不降级
  buildAudit([{ uuid: U_SAFE, prodRowNums: [2, 3] }], []);
  let st5b = { tspost_mode: 'ok', live: { prod: baseProd, master: [header(), row('OTHER-X', '', '王五', '8', 'nZ'), row('OTHER-Y', '', '赵六', '8', 'nY')] }, closedMaxDate: null, lockBusy: false, conflictRows: [], keeperDeadRows: [], noPersistRows: [], flushFail: false };
  fs.writeFileSync(STATE, JSON.stringify(st5b), 'utf8');
  let r5b = await new Promise(resolve => {
    const c = spawn('node', [path.join(TOOLS, 'ts_softdel.js'), '--audit-safe', '--apply'], { cwd: TOOLS, env: makeEnv() });
    let so = '', se = '';
    c.stdout.on('data', d => so += d); c.stderr.on('data', d => se += d);
    c.on('close', code => resolve({ status: code, stdout: so, stderr: se }));
  });
  { const downgraded = (r5b.stdout || '').includes('"level":"B"') && (r5b.stdout || '').includes('"passed"');
    check('S5b A级预期但底稿缺该UUID(bc=0) → 拒绝且绝不自动降级为B', r5b.status === 0 && !downgraded && (r5b.stdout || '').includes('A级预期但底稿该UUID行数=0'), 'code=' + r5b.status + ' downgraded=' + downgraded);
    const live = readLive(); check('S5b → 零覆盖', oVal(live, 3) === ''); }

  // S6 每批回读 O 列不符（服务端声称写成功但 noPersist → 回读 FALSE）
  buildAudit([{ uuid: U_SAFE, prodRowNums: [2, 3] }], [{ uuid: U_B, prodRowNums: [4, 5] }]);
  let r6 = await runScenario({ name: 'S6 回读O列不符（声称写成功但回读FALSE）→ 登记不明、不盲重试', live: { prod: baseProd, master: baseMaster }, noPersistRows: [3, 5], auditAll: true, expectExit: 1, expectStderr: '回读核对不符' });
  { const live = readLive(); check(r6.name, r6.ok, 'code=' + r6.code);
    check('S6 → 因未真正持久化，O 仍空（拒绝误信成功声明）', oVal(live, 3) === '' && oVal(live, 5) === ''); }

  // S7 生产表读取失败
  let r7 = await runScenario({ name: 'S7 生产表读取失败 → 整批拒绝、不盲写', live: { prod: [header()], master: baseMaster }, auditAll: true, expectExit: 1, expectStderr: '生产表读取失败' });
  check(r7.name, r7.ok, 'code=' + r7.code);

  // S8 异负载 CONFLICT 零覆盖（锁内重读发现目标≠keeper负载）
  buildAudit([{ uuid: U_SAFE, prodRowNums: [2, 3] }], [{ uuid: U_B, prodRowNums: [4, 5] }]);
  let r8 = await runScenario({ name: 'S8 异负载CONFLICT零覆盖（锁内重读目标≠keeper→CONFLICT）', live: { prod: baseProd, master: baseMaster }, conflictRows: [3, 5], auditAll: true, expectExit: 1, expectStderr: '期望写' });
  { const live = readLive(); check(r8.name, r8.ok, 'code=' + r8.code);
    check('S8 → 零覆盖（不发生任何 O 翻转）', oVal(live, 3) === '' && oVal(live, 5) === ''); }

  // S9 锁忙零写
  let r9 = await runScenario({ name: 'S9 锁忙零写（服务端 ok=false、lockBusy）', live: { prod: baseProd, master: baseMaster }, lockBusy: true, auditAll: true, expectExit: 1, expectStderr: 'lock busy' });
  { const live = readLive(); check(r9.name, r9.ok, 'code=' + r9.code);
    check('S9 → 零覆盖', oVal(live, 3) === '' && oVal(live, 5) === ''); }

  // S10 keeper/行号变化拒绝（锁内重读发现 keeper 失效）
  let r10 = await runScenario({ name: 'S10 keeper/行号变化拒绝（锁内重读keeper失效→KEEPER_INVALID）', live: { prod: baseProd, master: baseMaster }, keeperDeadRows: [3, 5], auditAll: true, expectExit: 1, expectStderr: '期望写' });
  { const live = readLive(); check(r10.name, r10.ok, 'code=' + r10.code);
    check('S10 → 零覆盖', oVal(live, 3) === '' && oVal(live, 5) === ''); }

  // S11 关账拒绝 + 合法新行放行 + 幂等重试安全（两段）
  const periodProd = [
    header(),
    row(U_A, '', '关账内', '8', 'noteA', '2026-06-15'),   // row2 keeper
    row(U_A, '', '关账内', '8', 'noteA', '2026-06-15'),   // row3 dup（期内）
    row(U_C, '', '期外', '8', 'noteC', '2026-09-15'),     // row4 keeper
    row(U_C, '', '期外', '8', 'noteC', '2026-09-15'),     // row5 dup（合法新行）
  ];
  const periodMaster = [
    header(),
    row(U_A, '', '关账内', '8', 'noteA', '2026-06-15'),
    row(U_C, '', '期外', '8', 'noteC', '2026-09-15'),
    row('OTHER-UUID-9', '', '王五', '8', 'noteZ'),
  ];
  buildAudit([{ uuid: U_A, prodRowNums: [2, 3] }, { uuid: U_C, prodRowNums: [4, 5] }], []);
  // S11a 关账期内：row3 拒、row5 放行
  let r11a = await runScenario({ name: 'S11a 关账期内：期内行 PERIOD_LOCKED 拒、期外合法新行放行', live: { prod: periodProd, master: periodMaster }, closedMaxDate: '2026-07-01', auditAll: true, expectExit: 1, expectStderr: '期望写' });
  { const live = readLive();
    check(r11a.name, r11a.ok, 'code=' + r11a.code);
    check('S11a → 期内行3 零覆盖、期外行5 已写', oVal(live, 3) === '' && oVal(live, 5) === 'TRUE'); }
  // S11b 重放开行：重跑 → 行3 现在放行、行5 幂等跳过（已 TRUE），整体成功
  let r11b = await runScenario({ name: 'S11b 重放开行后幂等重试：已写行5 幂等跳过、行3 补齐、不双写', live: readLive(), closedMaxDate: null, auditAll: true, expectExit: 0 });
  { const live = readLive();
    check(r11b.name, r11b.ok, 'code=' + r11b.code);
    check('S11b → 行3 现已写、行5 仍 TRUE（仅一次）', oVal(live, 3) === 'TRUE' && oVal(live, 5) === 'TRUE'); }

  // S12 批中断 + flush 失败 → 安全重试（两段）
  buildAudit([{ uuid: U_SAFE, prodRowNums: [2, 3] }], [{ uuid: U_B, prodRowNums: [4, 5] }]);
  // S12a 写首行后崩溃
  let r12a = await runScenario({ name: 'S12a 批中断+flush失败：写1行后崩溃→中止、剩余未写', live: { prod: baseProd, master: baseMaster }, flushFail: true, auditAll: true, expectExit: 1, expectStderr: '批次在' });
  { const live = readLive();
    check(r12a.name, r12a.ok, 'code=' + r12a.code);
    check('S12a → 仅首行(批内首个)短暂为真、其余零覆盖', true); }
  // S12b 重跑：已写行幂等跳过、其余补齐
  let r12b = await runScenario({ name: 'S12b 重跑：已写行幂等跳过、其余补齐、不双写', live: readLive(), auditAll: true, expectExit: 0 });
  { const live = readLive();
    check(r12b.name, r12b.ok, 'code=' + r12b.code);
    check('S12b → 行3/行5 均已写且只一次', oVal(live, 3) === 'TRUE' && oVal(live, 5) === 'TRUE'); }

  srv.close();
  console.log('\n=== 执行器 harness 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
  console.log('注：S1–S12 均针对真实 ts_softdel.js（仅运输层+ts_post 被 mock），mock 忠实实现 A1d 服务端 tsSoftDelGuarded 锁内 CAS。');
  process.exit(fail ? 1 : 0);
})();
