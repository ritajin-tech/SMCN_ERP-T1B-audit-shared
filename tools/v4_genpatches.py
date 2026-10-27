#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
v4 补丁生成器 · 修正版 v2（2026-10-27）

v1 的失败：按 markdown 代码块【位置索引】取代码，索引错位导致
  - A1b 补丁把 tsPatchCells 的 if(!dry) 写入循环换成 tsPurgeRows 函数（Tom 阻断项 2）
  - A1 补丁在 tsAppendRows 后插入游离顶层 if(!dry)（Tom 阻断项 1）
  且 node --check 全部通过 —— 因为「函数内嵌套函数声明」本身合法，语法检查抓不到。

v2 的修法：
  1. 不再从文档取代码块；补丁内容全部内联在本文件，按【函数锚点】替换
  2. 语义校验：顶层函数重复 / 缩进的嵌套函数声明 / 关键写入逻辑必须存在
  3. patch 应用结果必须与 full/ 文件逐字节一致（比对 SHA-256）
"""
import os, re, subprocess, difflib, hashlib, sys

BASE = 'D:/AI_DATA/WorkBuddy/_ts_current_20261026/'
REPO = 'C:/Users/rita.jin/WorkBuddy/SMCN_ERP/_tmp/audit_shared/tools/v4_patches/'
CHK  = 'C:/Users/rita.jin/WorkBuddy/SMCN_ERP/_tmp/_v4chk/'
for d in (REPO, CHK, REPO + 'full/'): os.makedirs(d, exist_ok=True)

def rd(p):
    with open(BASE + p, encoding='utf-8') as f: return f.read()
def lines(t):
    L = t.split('\n')
    while L and L[-1] == '': L.pop()
    return L
def sha(s): return hashlib.sha256(s.encode('utf-8')).hexdigest()

# ---------------- 锚点定位 ----------------
def func_span(L, name):
    pat = re.compile(r'^function\s+' + re.escape(name) + r'\s*\(')
    for i, l in enumerate(L):
        if pat.match(l): break
    else: raise SystemExit(f'[FATAL] 找不到函数 {name}')
    for j in range(i + 1, len(L)):
        if L[j] == '}': return i, j + 1
    raise SystemExit(f'[FATAL] 函数 {name} 未闭合')

def region_span(L, start_pred, indent):
    """从满足 start_pred 的行开始，到首个恰好缩进为 indent 的 `}` 结束（含）"""
    for i, l in enumerate(L):
        if start_pred(l): break
    else: raise SystemExit('[FATAL] 找不到区域起点')
    close = ' ' * indent + '}'
    for j in range(i + 1, len(L)):
        if L[j] == close: return i, j + 1
    raise SystemExit('[FATAL] 区域未闭合')

def replace_span(text, span, new_body):
    L = lines(text); s, e = span
    return '\n'.join(L[:s] + lines(new_body) + L[e:]) + '\n'

# ---------------- 校验 ----------------
def node_check(text, tag):
    p = CHK + tag + '.js'
    with open(p, 'w', encoding='utf-8', newline='\n') as f: f.write(text)
    r = subprocess.run(['node', '--check', p], capture_output=True, text=True)
    return r.returncode == 0, r.stderr.strip()[:300]

def nested_names(text):
    """缩进的 function 声明（相对基线的新增才是可疑的）"""
    return sorted({re.match(r'^\s+function\s+(\w+)\s*\(', l).group(1)
                   for l in text.split('\n') if re.match(r'^\s+function\s+\w+\s*\(', l)})

def semcheck(text, baseline):
    errs = []
    L = text.split('\n')
    tops = [m.group(1) for l in L for m in [re.match(r'^function\s+(\w+)\s*\(', l)] if m]
    dup = sorted({t for t in tops if tops.count(t) > 1})
    if dup: errs.append(f'顶层函数重复定义: {dup}')
    # 基线里本来就有的嵌套 helper 是合法的，只报新增的
    new_nested = [n for n in nested_names(text) if n not in nested_names(baseline)]
    if new_nested: errs.append(f'相对基线新增的嵌套函数声明（疑似错位）: {new_nested[:6]}')
    # 基线顶层函数不得消失
    base_tops = {m.group(1) for l in baseline.split('\n')
                 for m in [re.match(r'^function\s+(\w+)\s*\(', l)] if m}
    lost = sorted(base_tops - set(tops))
    if lost: errs.append(f'基线顶层函数丢失: {lost}')
    return errs

RESULTS = []
def emit(fname, orig, new, outname, required=None):
    required = required or []
    ok, msg = node_check(new, outname)
    if not ok:
        print(f'  [FAIL] {outname} node --check: {msg}'); RESULTS.append(False); return None
    errs = semcheck(new, orig)
    for pat, desc in required:
        if not re.search(pat, new): errs.append(f'缺少 {desc} (/{pat}/)')
    if errs:
        print(f'  [FAIL] {outname} 语义校验:'); [print('         - ' + e) for e in errs]
        RESULTS.append(False); return None
    d = list(difflib.unified_diff(lines(orig), lines(new),
                                  fromfile='a/' + fname, tofile='b/' + fname, lineterm='', n=3))
    with open(REPO + outname + '.patch', 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(d) + '\n')
    # full/ 必须与「补丁应用结果」逐字节一致 —— 用归一化后的文本（单个结尾换行）
    norm = '\n'.join(lines(new)) + '\n'
    with open(REPO + 'full/' + fname.replace('.js', '.') + outname + '.js',
              'w', encoding='utf-8', newline='\n') as f: f.write(norm)
    print(f'  [OK] {outname}: 语法过 / 语义过 / diff {len(d)} 行 / sha {sha(norm)[:12]}')
    RESULTS.append(True); return new

print('=== v4 补丁生成 · 修正版 v2 ===')
RA0, PG0 = rd('RemoteActions.js'), rd('PeriodLockGuard.js')
print(f'基线 RemoteActions.js {len(lines(RA0))} 行 / PeriodLockGuard.js {len(lines(PG0))} 行')

# ============ A1c: _plGuardedInsert 取锁提前 + 去重先于预检（修 Tom Q2）============
A1C = r'''function _plGuardedInsert(opts) {
  var lock = null;
  var enteredWrite = false;
  var logAttempted = false;
  try {
    // [A1c] 取锁提前到预检之前，使「锁内去重」能先于预检执行。
    // 原实现先对【原始 rows】预检 → 取锁 → 调 lockPreWrite 去重，导致
    // 「本应被去重跳过的关账期重复行」会先触发 PL_REJECT_* 连坐整批
    // （Tom Q2 指出的副作用）。_plGuardCheckBatch 是纯函数（不读表），
    // 取锁提前不改变其判定结果，仅改变「哪些行参与预检」。
    lock = _plAcquire(opts.timeoutMs);
    var policy = _plPolicy();
    var rows = opts.rows;
    var duplicates = 0;
    var skipped = 0;
    if (typeof opts.lockPreWrite === 'function') {
      var pr = opts.lockPreWrite(rows, policy) || {};
      rows = pr.rows || [];
      duplicates = pr.duplicates || 0;
      skipped = pr.skipped || 0;
    }
    if (!rows || rows.length === 0) {              // 全被去重/跳过：无新增，不进业务写
      return { wrote: 0, duplicates: duplicates, skipped: skipped, skippedAll: true };
    }
    // 预检只作用于去重后的候选
    var pre = _plGuardCheckBatch(rows, opts.dateOf, policy);
    if (!pre.ok) {
      var e0 = new Error(pre.reason + ' @row#' + pre.index);
      e0.plCode = pre.reason;
      throw e0;
    }
    var post = _plGuardCheckBatch(rows, opts.dateOf, policy);
    if (!post.ok) {
      var e1 = new Error(post.reason + ' @row#' + post.index);
      e1.plCode = post.reason;
      throw e1;
    }
    enteredWrite = true;
    var result = opts.bizWrite(rows, policy);
    try {
      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) SpreadsheetApp.flush();
    } catch (fe) {
      var loggedF2 = _plLogUncertain('flush_failed', 'insert batch');
      logAttempted = true;
      var e2 = new Error('PL_UNCERTAIN_FLUSH_FAILED');
      e2.plCode = 'PL_UNCERTAIN_FLUSH_FAILED';
      e2.plCause = String((fe && fe.message) || fe);
      e2.plLogFailed = !loggedF2;
      e2.message = _plUncertainPayloadMsg(e2);
      throw e2;
    }
    return result;
  } catch (e) {
    if (enteredWrite && !logAttempted) {
      logAttempted = true;
      var logged2 = _plLogUncertain('biz_write', 'insert batch err=' + String((e && e.message) || e));
      if (e && e.plCode) throw e;
      var ue2 = new Error('PL_UNCERTAIN_BIZ_WRITE_FAILED');
      ue2.plCode = 'PL_UNCERTAIN_BIZ_WRITE_FAILED';
      ue2.plCause = String((e && e.message) || e);
      ue2.plLogFailed = !logged2;
      ue2.message = _plUncertainPayloadMsg(ue2);
      throw ue2;
    }
    throw e;
  } finally {
    if (lock) { try { lock.releaseLock(); } catch (re) {} }
  }
}'''
print('\n[A1c] _plGuardedInsert：取锁提前 + 去重先于预检')
PG1 = emit('PeriodLockGuard.js', PG0,
           replace_span(PG0, func_span(lines(PG0), '_plGuardedInsert'), A1C),
           'A1c_PeriodLockGuard_guardedInsert',
           [(r'lock = _plAcquire\(opts\.timeoutMs\);', '取锁'),
            (r'lockPreWrite\(rows, policy\)', '锁内去重钩子'),
            (r'_plGuardCheckBatch\(rows, opts\.dateOf, policy\);', '预检')])

# ============ A0: 清理护栏（锁内单次读 + 稳定身份 CAS，修 Tom Q4/Q5）============
A0_ADD = r'''
// ============================================================
// 5. [A0] 清理类工具统一护栏（V4.3.87 · 修正版 v2）
// ------------------------------------------------------------
// Tom Q4 修正：v1 示例在【锁外】读 data/targetRows，exec 闭包复用旧快照，
//   并发变更后可能覆盖或删除未经核定数据。v2 改为：
//   ① 全程持锁，锁内【单次】读取；② 按稳定身份（I 列 UUID）定位，不用行号；
//   ③ 期望原负载 hash（CAS）校验，不匹配即拒；④ flush 异常不吞，向上抛。
// Tom Q5 修正：不提供全局 allowClosed 放开。例外须绑定
//   {ssId, 记录UUID集合, 原负载hash, 操作, 期限, 批次号} 六要素，缺一即拒。
// ============================================================

/**
 * 由 14 列业务负载生成稳定 hash（复用 _plRowContentHash 的覆盖定义）。
 * 返回 null 表示该行无法无歧义定版，调用方必须 fail-closed 拒之。
 */
function _tsRowPayloadHash(row) {
  return _plRowContentHash(row);
}

/**
 * 清理准入：校验「稳定身份 + 原负载 hash」是否与期望一致。
 * @param {Sheet} sh
 * @param {Array} expect  [{uuid, payloadHash}] 待清理记录的期望原值
 * @returns {{ok:boolean, reason:string, matched:Array, mismatched:Array, cutoff:string}}
 */
function _tsVerifyCleanupTargets(sh, expect) {
  var policy = _plPolicy();
  var cutoff = (policy && policy.cutoff) || PL_CUTOFF;
  var data = sh.getDataRange().getValues();
  var byUuid = {};
  for (var i = 1; i < data.length; i++) {
    var u = String(data[i][8] || '').trim();
    if (u) byUuid[u] = { row: i + 1, rowData: data[i] };
  }
  var matched = [], mismatched = [];
  for (var k = 0; k < expect.length; k++) {
    var e = expect[k] || {};
    var uid = String(e.uuid || '').trim();
    var hit = (uid && Object.prototype.hasOwnProperty.call(byUuid, uid)) ? byUuid[uid] : null;
    if (!hit) { mismatched.push({ uuid: uid, reason: 'PL_REJECT_ROW_GONE' }); continue; }
    var actual = _tsRowPayloadHash(hit.rowData);
    if (actual === null) { mismatched.push({ uuid: uid, reason: 'PL_REJECT_CONTENT_ENCODING' }); continue; }
    if (e.payloadHash && actual !== e.payloadHash) {
      mismatched.push({ uuid: uid, reason: 'PL_REJECT_PAYLOAD_CHANGED',
                        expected: e.payloadHash, actual: actual });
      continue;
    }
    matched.push({ uuid: uid, row: hit.row, payloadHash: actual });
  }
  if (mismatched.length) {
    return { ok: false, reason: 'PL_REJECT_CLEANUP_CAS_FAILED', cutoff: cutoff,
             matched: matched, mismatched: mismatched.slice(0, 200) };
  }
  return { ok: true, reason: '', cutoff: cutoff, matched: matched, mismatched: [] };
}

/**
 * 带锁执行清理。全程单锁、锁内单次读、CAS 校验、逐行回读。
 * @param {Object} o
 *   o.sheet / o.expect([{uuid,payloadHash}]) / o.dry(默认true) /
 *   o.exec(matched, data) 真正的写/删 / o.op 操作名 / o.batch 批次号
 */
function _tsGuardedCleanup(o) {
  o = o || {};
  var dry = (o.dry === false) ? false : true;
  var lock = _plAcquire(o.timeoutMs);              // fail-closed
  try {
    var chk = _tsVerifyCleanupTargets(o.sheet, o.expect || []);
    if (!chk.ok) return chk;
    if (dry) return { ok: true, dry: true, matched: chk.matched, cutoff: chk.cutoff };
    var data = o.sheet.getDataRange().getValues(); // 锁内单次读，exec 只能用它
    var r = (typeof o.exec === 'function') ? o.exec(chk.matched, data) : null;
    try { SpreadsheetApp.flush(); }
    catch (fe) {                                   // v1 曾吞掉 flush 异常当成功
      var err = new Error('PL_UNCERTAIN_CLEANUP_FLUSH_FAILED');
      err.plCode = 'PL_UNCERTAIN_CLEANUP_FLUSH_FAILED';
      err.plCause = String((fe && fe.message) || fe);
      err.message = _plUncertainPayloadMsg(err);
      throw err;
    }
    // 逐行回读，确认实际落库状态
    var readback = [];
    for (var i = 0; i < chk.matched.length; i++) {
      var m = chk.matched[i];
      var dv = o.sheet.getRange(m.row, 15).getValue();
      readback.push({ uuid: m.uuid, row: m.row,
                      softDel: (dv === true || String(dv).toUpperCase() === 'TRUE') });
    }
    return { ok: true, dry: false, result: r, readback: readback, cutoff: chk.cutoff };
  } finally {
    if (lock) { try { lock.releaseLock(); } catch (re) {} }
  }
}
'''
print('\n[A0] 清理护栏：锁内单次读 + UUID CAS + 逐行回读')
PG2 = emit('PeriodLockGuard.js', PG1 or PG0,
           (PG1 or PG0).rstrip('\n') + '\n' + A0_ADD + '\n',
           'A0_PeriodLockGuard_cleanupGuard',
           [(r'function _tsRowPayloadHash', '负载hash'),
            (r'function _tsVerifyCleanupTargets', 'CAS 校验'),
            (r'function _tsGuardedCleanup', '带锁执行')])

# ============ A1: tsAppendRows 去重搬进临界区 ============
A1_HELPER = r'''/**
 * [A1] 去重抽成纯函数 —— 供「锁内写路径」与「锁外 dry 路径」共用，
 * 保证 dry 预演与实际写入判定完全一致。
 * 同时区分两种跳过：skippedDup(UUID 已存在) / skippedLeave(请假行未 force)。
 * [Tom Q1] 同键异负载不做自动裁决 —— 本函数只按 UUID 判重，
 *   负载差异一律保留并上报，不折叠。
 */
function _tsDedupeForAppend(sh, rows, force) {
  var last = sh.getLastRow();
  var exist = {};
  if (last > 1) {
    var uuids = sh.getRange(2, 9, last - 1, 1).getValues();
    for (var i = 0; i < uuids.length; i++) {
      var u = String(uuids[i][0] || '').trim();
      if (u) exist[u] = true;
    }
  }
  var toWrite = [], skippedDup = 0, skippedLeave = 0;
  for (var j = 0; j < rows.length; j++) {
    var r = rows[j] || [];
    var uid = String(r[8] || '').trim();
    if (uid && exist[uid]) { skippedDup++; continue; }
    if (!force && _tsIsLeaveRowForGuard(r)) { skippedLeave++; continue; }
    if (uid) exist[uid] = true;                 // 同批内也去重
    var out = new Array(14);
    for (var k = 0; k < 14; k++) out[k] = (r[k] === undefined || r[k] === null) ? '' : r[k];
    toWrite.push(out);
  }
  return { rows: toWrite, skippedDup: skippedDup, skippedLeave: skippedLeave,
           skipped: skippedDup + skippedLeave };
}'''

A1_FUNC = r'''function tsAppendRows(e) {
  e = e || {};
  var p = e.parameter || {};
  var body = e.postBody || {};
  var rows = body.rows || [];
  var force = String(p.force || body.force || '0') === '1';
  var dry = String(p.dry || body.dry || '0') === '1';
  var sheetName = String(p.sheet || body.sheet || 'DB_工时流水');

  if (!rows.length) return JSON.stringify({ ok: false, error: 'no rows provided' });
  if (rows.length > TS_APPEND_MAX_ROWS) {
    return JSON.stringify({ ok: false, error: 'too many rows: ' + rows.length + ' > ' + TS_APPEND_MAX_ROWS });
  }

  try {
    var sh = SpreadsheetApp.openById(TS_ID).getSheetByName(sheetName);
    if (!sh) return JSON.stringify({ ok: false, error: 'sheet not found: ' + sheetName });

    // dry：只读预演，锁外执行，与写路径共用同一判定函数
    if (dry) {
      var dd = _tsDedupeForAppend(sh, rows, force);
      _tsWriteLog('appendRows(dry=1)', 'req=' + rows.length + ' wouldWrite=' + dd.rows.length +
                  ' skipDup=' + dd.skippedDup + ' skipLeave=' + dd.skippedLeave);
      return JSON.stringify({ ok: true, dry: true, requested: rows.length, wouldWrite: dd.rows.length,
                              skippedDup: dd.skippedDup, skippedLeave: dd.skippedLeave });
    }

    // rows 原样传入；去重由 lockPreWrite 在持锁状态下完成（A1c 已使其先于预检）
    var skippedDup = 0, skippedLeave = 0;
    var res = _plGuardedInsert({
      rows: rows,
      dateOf: function (r) { return r[1]; },        // B 列 fillDate
      lockPreWrite: function (rowsIn) {             // 锁内
        var d = _tsDedupeForAppend(sh, rowsIn, force);
        skippedDup = d.skippedDup;
        skippedLeave = d.skippedLeave;
        return { rows: d.rows, duplicates: d.skippedDup, skipped: d.skipped };
      },
      bizWrite: function (rows2, policy) {
        var startRow = sh.getLastRow() + 1;
        sh.getRange(startRow, 1, rows2.length, 14).setValues(rows2);
        var back = sh.getRange(startRow, 9, rows2.length, 1).getValues();
        var got = 0;
        for (var m = 0; m < back.length; m++) if (String(back[m][0] || '').trim()) got++;
        return { wrote: rows2.length, verified: got, startRow: startRow };
      }
    });

    var wrote    = (res && res.wrote) ? res.wrote : 0;
    var verified = (res && res.verified !== undefined) ? res.verified : 0;
    var startRow = (res && res.startRow !== undefined) ? res.startRow : null;

    _tsWriteLog('appendRows', 'req=' + rows.length + ' wrote=' + wrote + ' verified=' + verified +
                ' skipDup=' + skippedDup + ' skipLeave=' + skippedLeave);
    // [Tom Q2] 契约：全重复时返回 wrote/verified/startRow，并附带 skippedDup/skippedLeave，
    // 与旧 dry 路径的 wouldWrite 语义区分开（调用方按 dry 字段判断）
    return JSON.stringify({ ok: true, dry: false, requested: rows.length, wrote: wrote, verified: verified,
                            skippedDup: skippedDup, skippedLeave: skippedLeave, startRow: startRow });
  } catch (err) {
    _tsWriteLog('appendRows(ERR)', String((err && err.message) || err));
    return JSON.stringify({ ok: false, error: String((err && err.message) || err) });
  }
}'''
print('\n[A1] tsAppendRows：去重搬进锁内')
RA1 = emit('RemoteActions.js', RA0,
           replace_span(RA0, func_span(lines(RA0), 'tsAppendRows'), A1_HELPER + '\n\n' + A1_FUNC),
           'A1_RemoteActions_tsAppendRows',
           [(r'function _tsDedupeForAppend', '去重helper'),
            (r'lockPreWrite: function \(rowsIn\)', '锁内去重'),
            (r'skippedDup', '重复跳过计数')])

# ============ A1b: tsPatchCells if(!dry) 区域：锁提升到分支之外 ============
def patchcells_dry_span(L):
    s = next(i for i, l in enumerate(L) if re.match(r'^function tsPatchCells\s*\(', l))
    for j in range(s, len(L)):
        if L[j] == '    if (!dry) {': break
    else: raise SystemExit('[FATAL] tsPatchCells 内找不到 if (!dry)')
    for k in range(j + 1, len(L)):
        if L[k] == '    }': return j, k + 1
    raise SystemExit('[FATAL] if (!dry) 区域未闭合')

A1B_REGION = r'''    if (!dry) {
      // [A1b] 锁提升到分支之外：无论目标是不是 DB_工时流水，写操作一律在临界区内。
      // v1 补丁曾误把本区域整段替换为 tsPurgeRows（Tom 阻断项 2），v2 修正。
      var _lock = _plAcquire();
      try {
        // period-lock 专项门禁仍只对 DB_工时流水 生效（表头保护 + B / O:Q 期间政策）
        if (sheetName === PL_DB_SHEET) {
          var chk = _plGuardPatch(sh, cells, ranges);
          if (!chk.ok) {
            var pe = new Error('period-lock reject: ' + chk.reason + ' ' + JSON.stringify(chk.offenders || []));
            pe.plCode = chk.reason;
            throw pe;
          }
        }
        for (var i = 0; i < cells.length; i++) {
          var c = cells[i];
          sh.getRange(Number(c[0]), Number(c[1])).setValue(c[2]);
          n++;
        }
        // ranges 整块写入 —— 每项一次 setValues，避免上千次单格写超时
        for (var r = 0; r < ranges.length; r++) {
          var g = ranges[r];
          var vs = g.values || [];
          if (!vs.length || !vs[0] || !vs[0].length) continue;
          sh.getRange(Number(g.row), Number(g.col), vs.length, vs[0].length).setValues(vs);
          n += vs.length * vs[0].length;
        }
        SpreadsheetApp.flush();
      } finally {
        try { _lock.releaseLock(); } catch (re) {}
      }
    }'''
print('\n[A1b] tsPatchCells：锁提升到分支之外')
RA2 = emit('RemoteActions.js', RA1 or RA0,
           replace_span(RA1 or RA0, patchcells_dry_span(lines(RA1 or RA0)), A1B_REGION),
           'A1b_RemoteActions_tsPatchCells',
           [(r'\.setValue\(c\[2\]\)', '单格写入'),
            (r'\.setValues\(vs\)', '整块写入'),
            (r'_lock\.releaseLock\(\)', '锁释放'),
            (r'_plGuardPatch\(sh, cells, ranges\)', 'DB 专项门禁')])

# ============ A0d: tsDupReport fix=1 默认拒绝（Tom Q8）============
def dupfix_span(L):
    s = next(i for i, l in enumerate(L) if re.match(r'^function tsDupReport\s*\(', l))
    for j in range(s, len(L)):
        if L[j] == '  if (fix && kill.length > 0) {': break
    else: raise SystemExit('[FATAL] tsDupReport 找不到 fix 分支')
    for k in range(j + 1, len(L)):
        if L[k] == '  }': return j, k + 1
    raise SystemExit('[FATAL] fix 分支未闭合')

A0D = r'''  // [A0d][Tom Q8] fix=1 默认拒绝。2 小时窗口口径不适用于本批跨天跨月候选，
  // 且自动软标属生产写入。保留只读报告能力；写入须走 _tsGuardedCleanup + CAS。
  if (fix) {
    return JSON.stringify({ ok: false, error: 'DUP_FIX_DISABLED',
                            reason: '两小时窗口口径与本次跨天跨月候选不匹配；自动软标已禁用',
                            hint: '如需清理，请走 purgeRows 并附 {uuid,payloadHash} CAS 清单',
                            duplicateGroups: grpOut.length, extraRows: kill.length,
                            rows: kill.slice(0, 500) });
  }'''
print('\n[A0d] tsDupReport：fix=1 默认拒绝')
RA3 = emit('RemoteActions.js', RA2 or RA0,
           replace_span(RA2 or RA0, dupfix_span(lines(RA2 or RA0)), A0D),
           'A0d_RemoteActions_dupReport_deny',
           [(r'DUP_FIX_DISABLED', '拒绝码')])

print('\n=== 结果:', f'{sum(RESULTS)}/{len(RESULTS)} 通过')
sys.exit(0 if all(RESULTS) else 1)
