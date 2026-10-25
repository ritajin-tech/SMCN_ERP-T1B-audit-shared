/**
 * T1-B · period-lock guard 模块 · 实现 v2（本地代码，零生产写）
 * ============================================================
 * 依据：v5 设计 + Tom 09:27 实现层静态审阅五条（逐条核实全部属实，全部吸收）。
 *
 * v1(4d02da8) → v2 修订：
 *  [审1] _plGuardPatch 重写：ranges 的 O:Q 覆盖纳入；新 B 为空 → 拒；
 *        原值三态区分：原行不存在（放行）/ 原值已知（比对）/ 原值未知（拒）。
 *        明确服务边界：只锁「期间归属与软删标记」，C:H 历史业务列可经参与入口
 *        更改——不宣称历史整行冻结（见 §5 覆盖边界）。
 *  [审2] _plRecheckRow 返回实际行号 + 内容版本哈希；重复 UUID → mismatch；
 *        锁内姓名/归属重核可选；门禁原期间一律取锁内实读（禁缺省绕开）；
 *        请求绑定业务版本（expectContentHash）防 last-write-wins。
 *  [审3] R12b 语义改「进入业务写阶段」：写/提交阶段任何异常（含普通 Error）
 *        登记一次；预检拒绝不登记；flush 失败不双登记；登记失败不吞。
 *  [审4] 业务日解析完整锚定（拒尾缀/偏移）；cutoff 格式校验。
 *  [审5] 配套 period_lock_integrated_src.md 为可完整核对的集成源码（无省略号）。
 *
 * 🔴 零生产写本地实现；接入生产须 Rita 显式 GO + 双授权闸门。
 */

// ============================================================
// 0. 常量与策略持久化（M2/M3/M4）
// ============================================================

var PL_CUTOFF = '2026-10-01';            // M2：fillDate < CUTOFF → 已关账期间
var PL_POLICY_KEY = 'PERIOD_LOCK_STATE'; // M3：持久锁政策态（独立于功能开关）
var PL_LOCK_TIMEOUT_MS = 5000;           // M8：tryLock 超时；失败即零写拒
var PL_DB_SHEET = 'DB_工时流水';          // 作用表

/** [审4] cutoff 合法性校验：必须严格 yyyy-MM-dd，否则拒绝该策略值。 */
function _plValidCutoff(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/**
 * M3：读锁政策态。失败分级（[审4] 精确边界，不过度声称）：
 *   - 配置读取失败/JSON 坏/结构非法 → fallback：closed=true（历史拒）+
 *     futureOpen=true（**未来放行不因配置故障收紧**——不从配置缺失推导
 *     futureOpen=false 已解除）。故 R7 语义＝「配置故障时历史期间拒」，
 *     不概称「任何写均拒」。
 *   - cutoff 非法 → 回退内置 PL_CUTOFF（不用坏值改历史判定）。
 */
function _plPolicy() {
  var fallback = { closed: true, cutoff: PL_CUTOFF, futureOpen: true,
                   updatedBy: 'fail-closed-default', updatedAt: '', source: 'default' };
  var raw = null;
  try {
    raw = PropertiesService.getScriptProperties().getProperty(PL_POLICY_KEY);
  } catch (e) {
    return fallback;                       // 读取失败 → fail-closed（历史拒/未来放）
  }
  if (!raw) return fallback;               // 无策略 → 首次即保护历史
  try {
    var p = JSON.parse(raw);
    if (!p || typeof p !== 'object' || Array.isArray(p)) return fallback;
    return {
      closed: p.closed !== false,          // 缺省 true（解析失败不变成放行）
      cutoff: _plValidCutoff(p.cutoff) ? p.cutoff : PL_CUTOFF,   // [审4]
      futureOpen: p.futureOpen !== false,
      updatedBy: String(p.updatedBy || ''),
      updatedAt: String(p.updatedAt || ''),
      source: 'props'
    };
  } catch (e) {
    return fallback;
  }
}

/** M3：写锁政策态（仅限受控解锁流程调用；本模块不提供自助开启）。 */
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
// 1. 业务日解析与期间判定（M2/M7）—— [审4] 完整锚定
// ============================================================

/**
 * M7：明确业务日解析。接受且仅接受：
 *   Date 对象 | 'yyyy-MM-dd' | 'yyyy-MM-ddTHH:mm' | 'yyyy-MM-dd HH:mm:ss' | 'yyyy/M/d'
 * 完整匹配：尾缀垃圾（'2026-10-01garbage'）、缺少年月日、越界月日 → 一律 null（拒）。
 * 一律 GMT+8 归日。
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
  if (!m) return null;                                   // [审4] $ 锚定：尾缀/歧义拒
  var y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (m[4] !== undefined) {                              // [审4] 时分秒范围校验
    var hh = +m[4], mi = +m[5], ss = (m[6] === undefined) ? 0 : +m[6];
    if (hh > 23 || mi > 59 || ss > 59) return null;
  }
  var dt = new Date(Date.UTC(y, mo - 1, d));
  if (isNaN(dt.getTime())) return null;
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return y + '-' + (mo < 10 ? '0' + mo : '' + mo) + '-' + (d < 10 ? '0' + d : '' + d);
}

/** M2：该业务日是否落在已关账期间（< cutoff）。字典序即时间序。 */
function _plIsClosedBizDate(bizDate, cutoff) {
  return String(bizDate) < String(cutoff);
}

// ============================================================
// 2. 写网关双向门禁（M1）—— 原值三态（[审1]/[审2]）
// ============================================================

/**
 * M1 双向门禁。原值三态（显式区分，禁缺省绕开——[审2]）：
 *   origBiz === null            → 原行不存在（新增场景）
 *   origBiz === PL_UNKNOWN      → 原值未知（解析失败/行消失）→ 一律拒
 *   origBiz === 'yyyy-MM-dd'    → 原值已知，参与比对
 * newDateRaw 解析失败 → 拒（M7）。返回 { ok, reason }。
 */
var PL_UNKNOWN = '__PL_UNKNOWN__';

function _plGuardCheck(newDateRaw, origBiz, policy) {
  var cutoff = (policy && policy.cutoff) || PL_CUTOFF;
  var newBiz = _plParseBizDate(newDateRaw);
  if (!newBiz) return { ok: false, reason: 'PL_REJECT_BAD_NEW_DATE' };
  if (policy && policy.closed === false) {
    // 锁未关：仅校验新值可解析；futureOpen=false 时未来也拒
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

/**
 * R12a：批前校验（新增场景，原行不存在 → origBiz=null）。
 */
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

/** M8：取锁。tryLock 失败 → 零写拒（不做无锁写入；锁对象 ≠ 锁）。 */
function _plAcquire(timeoutMs) {
  var lock = LockService.getScriptLock();
  var got = false;
  try {
    got = lock.tryLock(timeoutMs || PL_LOCK_TIMEOUT_MS);
  } catch (e) { got = false; }
  if (!got) {
    var err = new Error('PL_REJECT_LOCK_BUSY');
    err.plCode = 'PL_REJECT_LOCK_BUSY';
    throw err;
  }
  return lock;
}

/**
 * M8：[审2] 锁内重核。按稳定标识 UUID 唯一定位，返回**实际行号**+内容版本。
 *   expectContentHash：调用方锁外读取时的内容版本哈希（[审2] 请求绑定业务版本，
 *                     防 last-write-wins；null 表示不绑定内容仅绑期间）。
 *   expectName：调用方读取时的 C 列姓名（null 表示不重核归属）。
 * 返回 { found, row, bizDate, deleted, contentHash, mismatch, reason }。
 * 重复 UUID（多命中）→ mismatch（无唯一性保证即拒）。
 */
function _plRowContentHash(row) {
  // 业务版本 = B..N 业务列 + O 软删标记（不含 A 时间戳）
  return [row[1], row[2], row[3], row[4], row[5], row[6], row[7], row[8], row[9],
          row[11], row[13], row[14]].join('\u0001');
}

function _plRecheckRow(sheet, uuid, expectContentHash, expectName) {
  var out = { found: false, row: 0, bizDate: null, deleted: false,
              contentHash: null, mismatch: false, reason: '' };
  if (!uuid) { out.mismatch = true; out.reason = 'PL_REJECT_NO_UUID'; return out; }
  var data = sheet.getDataRange().getValues();
  var hits = 0;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][8] || '').trim() !== String(uuid).trim()) continue;
    hits++;
    if (hits > 1) {                          // [审2] 重复 UUID：无唯一性即拒
      out.mismatch = true; out.reason = 'PL_REJECT_UUID_NOT_UNIQUE';
      return out;
    }
    out.found = true;
    out.row = i + 1;                         // [审2] 实际行号交 bizWrite 使用
    var b = _plParseBizDate(data[i][1]);
    if (!b) {                                // 锁内原值未知 → 拒
      out.mismatch = true; out.reason = 'PL_REJECT_ORIG_UNKNOWN';
      return out;
    }
    out.bizDate = b;
    var dv = data[i][14];
    out.deleted = (dv === true || String(dv).toUpperCase() === 'TRUE');
    out.contentHash = _plRowContentHash(data[i]);
    if (expectName && String(data[i][2] || '').trim() !== String(expectName).trim()) {
      out.mismatch = true; out.reason = 'PL_REJECT_OWNER_MISMATCH'; return out;
    }
  }
  if (!out.found) { out.mismatch = true; out.reason = 'PL_REJECT_ROW_GONE'; return out; }
  if (expectContentHash && out.contentHash !== expectContentHash) {
    out.mismatch = true; out.reason = 'PL_REJECT_CONTENT_VERSION';   // [审2] 版本绑定
  }
  return out;
}

/**
 * R12b：[审3] 以「是否进入业务写阶段」区分。
 *   enteredWrite=false（预检/取锁/重核/门禁拒绝）→ 不登记；
 *   enteredWrite=true（业务写或 flush 异常）→ 任何异常（含普通 Error）登记一次。
 */
function _plLogUncertain(action, detail) {
  try {
    var ss = SpreadsheetApp.openById(TS_ID);
    var sh = ss.getSheetByName('_TS_WRITE_LOG');
    if (!sh) {
      sh = ss.insertSheet('_TS_WRITE_LOG');
      sh.appendRow(['时间', '动作', '明细']);
    }
    sh.appendRow([Utilities.formatDate(new Date(), 'GMT+8', 'yyyy-MM-dd HH:mm:ss'),
                  'period-lock uncertain: ' + action,
                  detail + ' (待人工核查，未自动重试/回滚/补偿)']);
    return true;
  } catch (e) {
    return false;                            // [审3] 登记失败返回 false，不吞
  }
}

/**
 * M8 主编排（改/删场景）。门禁原期间一律取锁内实读（[审2]，禁缺省绕开）。
 * bizWrite(recheck) 必须用 recheck.row 作为实际写入行号。
 */
function _plGuardedMutation(opts) {
  var sheet = opts.sheet;
  var lock = null;
  var enteredWrite = false;
  var logged = false;
  try {
    lock = _plAcquire(opts.timeoutMs);                   // M8：失败即拒
    var policy = _plPolicy();                            // 锁内重读策略
    // 锁内重核（唯一定位 + 行号 + 版本 + 归属）
    var recheck = null;
    if (opts.uuid) {
      recheck = _plRecheckRow(sheet, opts.uuid, opts.expectContentHash || null,
                              opts.expectName || null);
      if (recheck.mismatch) {
        var e1 = new Error(recheck.reason);
        e1.plCode = recheck.reason;
        throw e1;
      }
    }
    // 独立期间门禁 + 版本检查（原期间用锁内实读；锁本身不识别月份）
    var origBiz = recheck ? recheck.bizDate : null;
    var g = _plGuardCheck(opts.newDateRaw, origBiz, policy);
    if (!g.ok) {
      var e2 = new Error(g.reason);
      e2.plCode = g.reason;
      throw e2;
    }
    // 业务写（进入写阶段）
    enteredWrite = true;
    var result = opts.bizWrite(recheck, policy);
    // 写完成边界：释放锁前 flush 提交待处理变更
    try {
      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) SpreadsheetApp.flush();
    } catch (fe) {
      logged = (_plLogUncertain('flush_failed', String(opts.uuid || 'batch')) || logged);
      var e3 = new Error('PL_UNCERTAIN_FLUSH_FAILED');
      e3.plCode = 'PL_UNCERTAIN_FLUSH_FAILED';
      throw e3;                              // 提交状态不确定，不判定成功
    }
    return result;
  } catch (e) {
    // [审3] 进入写阶段后的任何异常登记一次（不要求底层打自定义码）
    if (enteredWrite && !logged) {
      _plLogUncertain('biz_write_or_flush', String(opts.uuid || 'batch') +
                     ' err=' + String((e && e.message) || e));
    }
    throw e;
  } finally {
    if (lock) { try { lock.releaseLock(); } catch (re) {} }
  }
}

/**
 * 新增场景（submitBatch/tsAppendRows）：
 *   opts.lockPreWrite(recentTail)：可选，锁内回调（[审5] 幂等复核移锁内）。
 */
function _plGuardedInsert(opts) {
  var lock = null;
  var enteredWrite = false;
  var logged = false;
  try {
    // R12a：批前全量校验（先于一切业务写）
    var pre = _plGuardCheckBatch(opts.rows, opts.dateOf, _plPolicy());
    if (!pre.ok) {
      var e0 = new Error(pre.reason + ' @row#' + pre.index);
      e0.plCode = pre.reason;
      throw e0;
    }
    lock = _plAcquire(opts.timeoutMs);                   // M8：失败即拒
    var policy = _plPolicy();                            // 锁内再读
    // [审5] 锁内幂等复核（若调用方提供）
    var rows = opts.rows;
    if (typeof opts.lockPreWrite === 'function') {
      rows = opts.lockPreWrite(rows, policy) || rows;
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
      logged = (_plLogUncertain('flush_failed', 'insert batch') || logged);
      var e2 = new Error('PL_UNCERTAIN_FLUSH_FAILED');
      e2.plCode = 'PL_UNCERTAIN_FLUSH_FAILED';
      throw e2;
    }
    return result;
  } catch (e) {
    if (enteredWrite && !logged) {
      _plLogUncertain('biz_write_or_flush', 'insert batch err=' + String((e && e.message) || e));
    }
    throw e;
  } finally {
    if (lock) { try { lock.releaseLock(); } catch (re) {} }
  }
}

// ============================================================
// 4. tsPatchCells 专项门禁（[审1] 重写）—— 仅 DB_工时流水 的 B 列与 O:Q 列
// ============================================================

/**
 * [审1] 三态 + 全覆盖重写。锁内调用。返回 { ok, reason, offenders }。
 * 规则：
 *   B 列（col 2）写入：
 *     - 新值解析失败/为空 → 拒（禁清空 fillDate）
 *     - 原行不存在 → 按新增过门禁（origBiz=null）
 *     - 原行存在但原值解析失败 → 拒（PL_REJECT_ORIG_UNKNOWN）
 *     - 原期间已关账 → 拒
 *   O:Q（col 15-17）写入：按删除场景
 *     - 原行不存在 → 拒（无处可删）
 *     - 原值未知 → 拒
 *     - 原期间已关账 → 拒
 *   ranges：与 cells 统一判定——覆盖 B 列者逐行按 B 规则；覆盖 O:Q 者逐格按 O:Q 规则；
 *     一个 range 同时覆盖 B 与 O:Q 时两规则都执行。
 *   C:H 等其他列：不拦（服务边界：本 guard 只锁期间归属与软删标记，见 §5）。
 */
function _plGuardPatch(sheet, cells, ranges) {
  var policy = _plPolicy();
  var offenders = [];
  var data = sheet.getDataRange().getValues();
  var lastRow = data.length;

  function origBizOf(rn) {
    if (rn < 2 || rn > lastRow) return { state: 'absent' };
    var b = _plParseBizDate(data[rn - 1][1]);
    if (!b) return { state: 'unknown' };
    return { state: 'known', biz: b };
  }
  function checkBCell(row, newVal) {
    var o = origBizOf(row);
    var origBiz = (o.state === 'known') ? o.biz
               : (o.state === 'unknown') ? PL_UNKNOWN : null;
    var g = _plGuardCheck(newVal, origBiz, policy);
    if (!g.ok) offenders.push({ row: row, col: 2, reason: g.reason });
  }
  function checkDelCell(row) {
    var o = origBizOf(row);
    if (o.state === 'absent') { offenders.push({ row: row, col: 'O:Q', reason: 'PL_REJECT_ROW_GONE' }); return; }
    if (o.state === 'unknown') { offenders.push({ row: row, col: 'O:Q', reason: 'PL_REJECT_ORIG_UNKNOWN' }); return; }
    if (_plIsClosedBizDate(o.biz, policy.cutoff)) {
      offenders.push({ row: row, col: 'O:Q', reason: 'PL_REJECT_ORIG_DATE_CLOSED' });
    }
  }

  var i, c, r, ri;
  for (i = 0; i < (cells || []).length; i++) {
    c = cells[i]; if (!c) continue;
    var row = Number(c[0]), col = Number(c[1]), val = c[2];
    if (col === 2) {
      checkBCell(row, val);                          // [审1] 空新 B 由 _plGuardCheck 拒
    } else if (col >= 15 && col <= 17) {
      checkDelCell(row);                             // [审1] 三态
    }
  }
  for (i = 0; i < (ranges || []).length; i++) {
    r = ranges[i]; if (!r || !r.values) continue;
    var startRow = Number(r.row), startCol = Number(r.col);
    var width = (r.values[0] || []).length;
    var height = r.values.length;
    var coversB = (startCol <= 2 && startCol + width > 2);
    var coversDel = (startCol <= 17 && startCol + width > 15);
    if (!coversB && !coversDel) continue;            // 其他列不拦（§5 边界）
    for (ri = 0; ri < height; ri++) {
      var rn = startRow + ri;
      if (coversB) {
        var bIdx = 2 - startCol;
        var newB = (r.values[ri] || [])[bIdx];
        if (newB === undefined || newB === null || newB === '') {
          offenders.push({ row: rn, col: 2, reason: 'PL_REJECT_BAD_NEW_DATE' });  // [审1] 禁清空
        } else {
          checkBCell(rn, newB);
        }
      }
      if (coversDel) {
        // O:Q 被覆盖的每一列都按删除场景核（软删标记列任一被写即核）
        checkDelCell(rn);
      }
    }
  }
  if (offenders.length) return { ok: false, reason: 'PL_REJECT_PATCH_OFFENDERS', offenders: offenders };
  return { ok: true, reason: '' };
}
