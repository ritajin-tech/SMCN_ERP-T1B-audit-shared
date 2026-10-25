/**
 * T1-B · period-lock guard 模块 · 实现 v3（本地代码，零生产写）
 * ============================================================
 * 依据：v5 设计 + Tom 09:27 五条 + 09:59 五条（逐条核实全部属实，全部吸收）。
 *
 * v2(00d00ba) → v3 修订：
 *  [审①] _plRecheckRow 增 expectDeleted（删除幂等：锁内已删 → 拒）；
 *         _plRowContentHash 覆盖列明确定义（B..N 全列+O，含 K/M；类型转换与
 *         分隔冲突规则见函数注释）。
 *  [审②] _plGuardedInsert：lockPreWrite 去重结果为空 → 直接返回无新增约定，
 *         不进入 bizWrite、不构造高度 0 区域、不误登记不确定。
 *  [审③] _plLogUncertain 不自动建表（建表＝授权动作，改由部署包显式含建表步骤）；
 *         登记失败以 plLogFailed 标识贯穿（guard 在错误对象上挂标识，入口原样抛出
 *         时调用方可见）；每失败路径仅尝试登记一次。
 *  [审④] _plValidCutoff 真实日历校验（经 _plParseBizDate 回验）；
 *         双 fallback：无策略（首次，部署包负责初始化）＝ closed=true+futureOpen=true；
 *         读取/解析故障 ＝ closed=true+**futureOpen=false**（未知时拒绝受影响写——
 *         失败政策收紧为安全默认；收紧不构成授权扩大，放宽才须 Rita 显式决定）。
 *  [审⑤] _plGuardPatch：row<2（表头）单独状态 header → B/O:Q 写表头一律拒；
 *         O:Q 删除场景统一走 _plGuardCheck（与 mutation 同一期间政策，含 futureOpen）。
 *
 * 🔴 零生产写本地实现；接入生产须 Rita 显式 GO + 双授权闸门。
 */

// ============================================================
// 0. 常量与策略持久化（M2/M3/M4）
// ============================================================

var PL_CUTOFF = '2026-10-01';
var PL_POLICY_KEY = 'PERIOD_LOCK_STATE';
var PL_LOCK_TIMEOUT_MS = 5000;
var PL_DB_SHEET = 'DB_工时流水';

/** [审④] cutoff 真实日历校验：严格 yyyy-MM-dd 且为真实存在日期。 */
function _plValidCutoff(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  var b = _plParseBizDate(s);
  return b === s;                                   // 回验：'2026-00-01' 等假日期拒
}

/**
 * M3：读锁政策态。[审④] 双 fallback：
 *   - 无策略值（首次部署态）：closed=true, futureOpen=true（部署包须显式初始化，
 *     见集成部署清单；未初始化时首次即保护历史、未来正常放行）；
 *   - 读取异常/JSON 坏/结构非法：closed=true, futureOpen=false——**未知时拒绝
 *     受影响写**（故障不放宽；原 futureOpen=false 时读取故障不会变成放行未来）。
 *   - cutoff 非法 → 回退内置 PL_CUTOFF。
 */
function _plPolicy() {
  var raw = null;
  try {
    raw = PropertiesService.getScriptProperties().getProperty(PL_POLICY_KEY);
  } catch (e) {
    return _plFailClosedPolicy('read-error');      // 故障 → 收紧
  }
  if (!raw) {
    // 首次态（非故障）：closed=true 保护历史；futureOpen=true 未来正常放行；
    // 部署包须显式初始化策略（见集成部署清单）。
    return { closed: true, cutoff: PL_CUTOFF, futureOpen: true,
             updatedBy: 'initial-unset', updatedAt: '', source: 'unset' };
  }
  try {
    var p = JSON.parse(raw);
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      return _plFailClosedPolicy('parse-error');
    }
    return {
      closed: p.closed !== false,
      cutoff: _plValidCutoff(p.cutoff) ? p.cutoff : PL_CUTOFF,
      futureOpen: p.futureOpen !== false,
      updatedBy: String(p.updatedBy || ''),
      updatedAt: String(p.updatedAt || ''),
      source: 'props'
    };
  } catch (e) {
    return _plFailClosedPolicy('parse-error');
  }
}

function _plFailClosedPolicy(reason) {
  return { closed: true, cutoff: PL_CUTOFF, futureOpen: false,
           updatedBy: 'fail-closed-' + reason, updatedAt: '', source: 'fail-closed' };
}

/** M3：写锁政策态（受控流程调用；部署包初始化亦走此函数）。 */
function _plSetPolicy(closed, futureOpen, updatedBy) {
  var props = PropertiesService.getScriptProperties();
  props.setProperty(PL_POLICY_KEY, JSON.stringify({
    closed: !!closed,
    cutoff: PL_CUTOFF,
    futureOpen: !!futureOpen,
    updatedBy: String(updatedBy || ''),
    updatedAt: Utilities.formatDate(new Date(), 'GMT+8', 'yyyy-MM-dd HH:mm:ss'),
    source: 'props'
  }));
}

// ============================================================
// 1. 业务日解析与期间判定（M2/M7）
// ============================================================

/**
 * M7：明确业务日解析，完整匹配：
 *   Date 对象 | yyyy-MM-dd | yyyy-MM-ddTHH:mm[:ss] | yyyy-MM-dd HH:mm[:ss] | yyyy/M/d
 * 尾缀垃圾/非法时分秒/越界/假日期 → null。一律 GMT+8 归日。
 */
function _plParseBizDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return Utilities.formatDate(v, 'GMT+8', 'yyyy-MM-dd');
  }
  var s = String(v).trim();
  if (!s) return null;
  var m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  var y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (m[4] !== undefined) {
    var hh = +m[4], mi = +m[5], ss = (m[6] === undefined) ? 0 : +m[6];
    if (hh > 23 || mi > 59 || ss > 59) return null;
  }
  var dt = new Date(Date.UTC(y, mo - 1, d));
  if (isNaN(dt.getTime())) return null;
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return y + '-' + (mo < 10 ? '0' + mo : '' + mo) + '-' + (d < 10 ? '0' + d : '' + d);
}

function _plIsClosedBizDate(bizDate, cutoff) {
  return String(bizDate) < String(cutoff);
}

// ============================================================
// 2. 写网关双向门禁（M1）—— 原值三态
// ============================================================

var PL_UNKNOWN = '__PL_UNKNOWN__';

function _plGuardCheck(newDateRaw, origBiz, policy) {
  var cutoff = (policy && policy.cutoff) || PL_CUTOFF;
  var newBiz = _plParseBizDate(newDateRaw);
  if (!newBiz) return { ok: false, reason: 'PL_REJECT_BAD_NEW_DATE' };
  if (policy && policy.closed === false) {
    if (policy.futureOpen === false && newBiz >= cutoff) {
      return { ok: false, reason: 'PL_REJECT_FUTURE_CLOSED' };
    }
    return { ok: true, reason: '' };
  }
  if (_plIsClosedBizDate(newBiz, cutoff)) return { ok: false, reason: 'PL_REJECT_NEW_DATE_CLOSED' };
  if (policy && policy.futureOpen === false && newBiz >= cutoff) {
    return { ok: false, reason: 'PL_REJECT_FUTURE_CLOSED' };
  }
  if (origBiz === PL_UNKNOWN) return { ok: false, reason: 'PL_REJECT_ORIG_UNKNOWN' };
  if (origBiz !== null && origBiz !== undefined && origBiz !== '') {
    if (_plIsClosedBizDate(origBiz, cutoff)) return { ok: false, reason: 'PL_REJECT_ORIG_DATE_CLOSED' };
  }
  return { ok: true, reason: '' };
}

function _plGuardCheckBatch(rows, dateOf, policy) {
  for (var i = 0; i < rows.length; i++) {
    var r = _plGuardCheck(dateOf(rows[i]), null, policy);
    if (!r.ok) return { ok: false, reason: r.reason, index: i };
  }
  return { ok: true, reason: '', index: -1 };
}

// ============================================================
// 3. LockService 临界区（M8）+ 锁内重核 + 写完成边界
// ============================================================

function _plAcquire(timeoutMs) {
  var lock = LockService.getScriptLock();
  var got = false;
  try { got = lock.tryLock(timeoutMs || PL_LOCK_TIMEOUT_MS); } catch (e) { got = false; }
  if (!got) {
    var err = new Error('PL_REJECT_LOCK_BUSY');
    err.plCode = 'PL_REJECT_LOCK_BUSY';
    throw err;
  }
  return lock;
}

/**
 * [审①] 内容版本哈希。覆盖列明确定义（不再跳过 K/M）：
 *   B(2) fillDate, C(3) name, D(4) type, E(5) stage, F(6) pid, G(7) hours,
 *   H(8) notes, I(9) uuid, J(10) pname, K(11), L(12) leader, M(13), N(14) ym, O(15) del
 *   ——即索引 1..14（B..O）。类型转换：String(v)（null/undefined → ''）；
 *   分隔符 \u0001（不出现在业务值中；若未来出现，视为版本冲突即拒，安全侧失效）。
 */
function _plRowContentHash(row) {
  var parts = [];
  for (var i = 1; i <= 14; i++) {
    var v = row[i];
    parts.push((v === null || v === undefined) ? '' : String(v));
  }
  return parts.join('\u0001');
}

/**
 * M8：[审①] 锁内重核。返回实际行号 + 内容版本 + 活动状态。
 *   expectDeleted：调用方锁外读到的软删状态（false=锁前未删）；锁内为 true →
 *     PL_REJECT_ALREADY_DELETED（删除幂等：已删行的更新/再删一律拒）。
 */
function _plRecheckRow(sheet, uuid, expectContentHash, expectName, expectDeleted) {
  var out = { found: false, row: 0, bizDate: null, deleted: false,
              contentHash: null, mismatch: false, reason: '' };
  if (!uuid) { out.mismatch = true; out.reason = 'PL_REJECT_NO_UUID'; return out; }
  var data = sheet.getDataRange().getValues();
  var hits = 0;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][8] || '').trim() !== String(uuid).trim()) continue;
    hits++;
    if (hits > 1) {
      out.mismatch = true; out.reason = 'PL_REJECT_UUID_NOT_UNIQUE';
      return out;
    }
    out.found = true;
    out.row = i + 1;
    var b = _plParseBizDate(data[i][1]);
    if (!b) { out.mismatch = true; out.reason = 'PL_REJECT_ORIG_UNKNOWN'; return out; }
    out.bizDate = b;
    var dv = data[i][14];
    out.deleted = (dv === true || String(dv).toUpperCase() === 'TRUE');
    if (expectDeleted === false && out.deleted === true) {          // [审①] 删除幂等
      out.mismatch = true; out.reason = 'PL_REJECT_ALREADY_DELETED';
      return out;
    }
    out.contentHash = _plRowContentHash(data[i]);
    if (expectName && String(data[i][2] || '').trim() !== String(expectName).trim()) {
      out.mismatch = true; out.reason = 'PL_REJECT_OWNER_MISMATCH'; return out;
    }
  }
  if (!out.found) { out.mismatch = true; out.reason = 'PL_REJECT_ROW_GONE'; return out; }
  if (expectContentHash && out.contentHash !== expectContentHash) {
    out.mismatch = true; out.reason = 'PL_REJECT_CONTENT_VERSION';
  }
  return out;
}

/**
 * R12b：[审③] 不确定批次登记。
 *   - **不自动建表**（建表＝授权动作）：_TS_WRITE_LOG 不存在 → 返回 false；
 *   - 返回 true=已登记；false=登记失败（调用方须外显，不得吞）。
 */
function _plLogUncertain(action, detail) {
  try {
    var ss = SpreadsheetApp.openById(TS_ID);
    var sh = ss.getSheetByName('_TS_WRITE_LOG');
    if (!sh) return false;                        // [审③] 不自动建表
    sh.appendRow([Utilities.formatDate(new Date(), 'GMT+8', 'yyyy-MM-dd HH:mm:ss'),
                  'period-lock uncertain: ' + action,
                  detail + ' (待人工核查，未自动重试/回滚/补偿)']);
    return true;
  } catch (e) {
    return false;
  }
}

/** [审③] 把「登记失败」标识挂到错误对象上，随抛出贯穿到入口返回值。 */
function _plMarkLogFailed(err) {
  if (err && typeof err === 'object') err.plLogFailed = true;
  return err;
}

/**
 * M8 主编排（改/删场景）。门禁原期间取锁内实读。
 * 失败路径仅尝试登记一次（[审③]）；登记失败以 plLogFailed 标识外显。
 */
function _plGuardedMutation(opts) {
  var sheet = opts.sheet;
  var lock = null;
  var enteredWrite = false;
  var logAttempted = false;
  try {
    lock = _plAcquire(opts.timeoutMs);
    var policy = _plPolicy();
    var recheck = null;
    if (opts.uuid) {
      recheck = _plRecheckRow(sheet, opts.uuid, opts.expectContentHash || null,
                              opts.expectName || null, opts.expectDeleted);
      if (recheck.mismatch) {
        var e1 = new Error(recheck.reason);
        e1.plCode = recheck.reason;
        throw e1;
      }
    }
    var origBiz = recheck ? recheck.bizDate : null;
    var g = _plGuardCheck(opts.newDateRaw, origBiz, policy);
    if (!g.ok) {
      var e2 = new Error(g.reason);
      e2.plCode = g.reason;
      throw e2;
    }
    enteredWrite = true;
    var result = opts.bizWrite(recheck, policy);
    try {
      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) SpreadsheetApp.flush();
    } catch (fe) {
      if (!logAttempted) { logAttempted = true; _plMarkLogFailed(fe); _plLogUncertain('flush_failed', String(opts.uuid || 'batch')); }
      var e3 = new Error('PL_UNCERTAIN_FLUSH_FAILED');
      e3.plCode = 'PL_UNCERTAIN_FLUSH_FAILED';
      e3.plLogFailed = fe.plLogFailed || false;
      throw e3;
    }
    return result;
  } catch (e) {
    if (enteredWrite && !logAttempted) {          // 每失败路径仅一次
      logAttempted = true;
      var ok = _plLogUncertain('biz_write_or_flush', String(opts.uuid || 'batch') +
                               ' err=' + String((e && e.message) || e));
      if (!ok) _plMarkLogFailed(e);
    }
    throw e;
  } finally {
    if (lock) { try { lock.releaseLock(); } catch (re) {} }
  }
}

/**
 * 新增场景。[审②] 去重结果为空 → 直接返回 { duplicates: n, wrote: 0 }，
 * 不进入 bizWrite、不构造高度 0 区域、不登记不确定。
 */
function _plGuardedInsert(opts) {
  var lock = null;
  var enteredWrite = false;
  var logAttempted = false;
  try {
    var pre = _plGuardCheckBatch(opts.rows, opts.dateOf, _plPolicy());
    if (!pre.ok) {
      var e0 = new Error(pre.reason + ' @row#' + pre.index);
      e0.plCode = pre.reason;
      throw e0;
    }
    lock = _plAcquire(opts.timeoutMs);
    var policy = _plPolicy();
    var rows = opts.rows;
    var duplicates = 0;
    if (typeof opts.lockPreWrite === 'function') {
      var pr = opts.lockPreWrite(rows, policy);
      rows = (pr && pr.rows) || [];               // [审②] 约定返回 {rows, duplicates}
      duplicates = (pr && pr.duplicates) || 0;
    }
    if (!rows || rows.length === 0) {             // [审②] 全重复：无新增，不走业务写
      return { wrote: 0, duplicates: duplicates, skippedAll: true };
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
      if (!logAttempted) { logAttempted = true; _plMarkLogFailed(fe); _plLogUncertain('flush_failed', 'insert batch'); }
      var e2 = new Error('PL_UNCERTAIN_FLUSH_FAILED');
      e2.plCode = 'PL_UNCERTAIN_FLUSH_FAILED';
      e2.plLogFailed = fe.plLogFailed || false;
      throw e2;
    }
    return result;
  } catch (e) {
    if (enteredWrite && !logAttempted) {
      logAttempted = true;
      var ok = _plLogUncertain('biz_write_or_flush', 'insert batch err=' + String((e && e.message) || e));
      if (!ok) _plMarkLogFailed(e);
    }
    throw e;
  } finally {
    if (lock) { try { lock.releaseLock(); } catch (re) {} }
  }
}

// ============================================================
// 4. tsPatchCells 专项门禁（[审⑤] 表头保护 + 政策统一）
// ============================================================

/**
 * [审⑤] 锁内调用。返回 { ok, reason, offenders }。
 *   B 列：新值空/非法 → 拒；**表头行（row<2）→ 拒**（禁把表头当新增行）；
 *         原行不存在 → 新增语义；原值未知 → 拒；原期间关账 → 拒。
 *   O:Q：删除场景统一走 _plGuardCheck（新=原，与 mutation 同一期间政策，
 *         含 futureOpen）；表头行 → 拒；原行不存在 → 拒；原值未知 → 拒。
 *   C:H 等其他列：不拦（服务边界明示：不宣称历史整行冻结）。
 */
function _plGuardPatch(sheet, cells, ranges) {
  var policy = _plPolicy();
  var offenders = [];
  var data = sheet.getDataRange().getValues();
  var lastRow = data.length;

  function rowState(rn) {
    if (rn < 2) return { state: 'header' };                   // [审⑤] 表头
    if (rn > lastRow) return { state: 'absent' };
    var b = _plParseBizDate(data[rn - 1][1]);
    if (!b) return { state: 'unknown' };
    return { state: 'known', biz: b };
  }
  function checkBCell(row, newVal) {
    var st = rowState(row);
    if (st.state === 'header') { offenders.push({ row: row, col: 2, reason: 'PL_REJECT_HEADER_ROW' }); return; }
    var origBiz = (st.state === 'known') ? st.biz
               : (st.state === 'unknown') ? PL_UNKNOWN : null;
    var g = _plGuardCheck(newVal, origBiz, policy);
    if (!g.ok) offenders.push({ row: row, col: 2, reason: g.reason });
  }
  function checkDelCell(row) {
    var st = rowState(row);
    if (st.state === 'header') { offenders.push({ row: row, col: 'O:Q', reason: 'PL_REJECT_HEADER_ROW' }); return; }
    if (st.state === 'absent') { offenders.push({ row: row, col: 'O:Q', reason: 'PL_REJECT_ROW_GONE' }); return; }
    if (st.state === 'unknown') { offenders.push({ row: row, col: 'O:Q', reason: 'PL_REJECT_ORIG_UNKNOWN' }); return; }
    // [审⑤] 统一期间政策：新=原走同一门禁（closed/futureOpen 一致）
    var g = _plGuardCheck(st.biz, st.biz, policy);
    if (!g.ok) offenders.push({ row: row, col: 'O:Q', reason: g.reason });
  }

  var i, c, r, ri;
  for (i = 0; i < (cells || []).length; i++) {
    c = cells[i]; if (!c) continue;
    var row = Number(c[0]), col = Number(c[1]), val = c[2];
    if (col === 2) checkBCell(row, val);
    else if (col >= 15 && col <= 17) checkDelCell(row);
  }
  for (i = 0; i < (ranges || []).length; i++) {
    r = ranges[i]; if (!r || !r.values) continue;
    var startRow = Number(r.row), startCol = Number(r.col);
    var width = (r.values[0] || []).length;
    var height = r.values.length;
    var coversB = (startCol <= 2 && startCol + width > 2);
    var coversDel = (startCol <= 17 && startCol + width > 15);
    if (!coversB && !coversDel) continue;
    for (ri = 0; ri < height; ri++) {
      var rn = startRow + ri;
      if (coversB) {
        var bIdx = 2 - startCol;
        var newB = (r.values[ri] || [])[bIdx];
        if (newB === undefined || newB === null || newB === '') {
          offenders.push({ row: rn, col: 2, reason: 'PL_REJECT_BAD_NEW_DATE' });
        } else {
          checkBCell(rn, newB);
        }
      }
      if (coversDel) checkDelCell(rn);
    }
  }
  if (offenders.length) return { ok: false, reason: 'PL_REJECT_PATCH_OFFENDERS', offenders: offenders };
  return { ok: true, reason: '' };
}
