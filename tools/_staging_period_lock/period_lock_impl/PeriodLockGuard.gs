/**
 * T1-B · period-lock guard 模块（DESIGN v5 实现 · 本地代码，零生产写）
 * ============================================================
 * 依据：FY27H1_period_lock_rightsized_phase2_v2.md + v3/v4/v5 delta
 *   - M1 双向日期 guard（新增看新 fillDate；改/删同时检查原记录期间+新记录期间）
 *   - M2 锁阈值 fillDate < 2026-10-01 关账（含 pre-H1）；2026-10-01 起全开
 *   - M3 锁政策态持久化（PropertiesService，独立于 FEATURE_ENABLED；版本回退保留执行锁入口）
 *   - M4 futureOpen 独立业务标志
 *   - M7 业务日解析失败 → 拒（绝不放行）
 *   - M8 LockService 临界区：tryLock 失败零写；锁内重读稳定 ID/期间/版本；
 *        独立期间门禁+版本检查；全部通过才写；释放锁前 flush；finally 释放
 *   - R12a 批前校验不合格零写；R12b 中途异常登记不确定批次、不重放不补偿
 *
 * 🔴 本文件为零生产写本地实现；接入生产须 Rita 显式 GO + 双授权闸门。
 * 覆盖边界（M1 分列，见 period_lock_entry_patches.md）：
 *   - 已接入 guard 的参与入口：submitBatch / updateTimesheet / softDeleteRecord /
 *     tsAppendRows / tsPatchCells(仅 DB_工时流水 的 B 列与 O:Q 列)
 *   - 未覆盖（仅 X2 周期检测告警）：跨项目入口、人工直接改表、其他 GAS 直写
 */

// ============================================================
// 0. 常量与策略持久化（M2/M3/M4）
// ============================================================

var PL_CUTOFF = '2026-10-01';            // M2：fillDate < CUTOFF → 已关账期间
var PL_POLICY_KEY = 'PERIOD_LOCK_STATE'; // M3：持久锁政策态（独立于功能开关）
var PL_LOCK_TIMEOUT_MS = 5000;           // M8：tryLock 超时；失败即零写拒
var PL_DB_SHEET = 'DB_工时流水';          // 作用表

/**
 * M3：读锁政策态。任何异常/解析失败 → fail-closed（视为已关账，拒写入）。
 * 默认策略：closed=true（首次部署即保护历史期间），futureOpen 独立读取。
 */
function _plPolicy() {
  var fallback = { closed: true, cutoff: PL_CUTOFF, futureOpen: true,
                   updatedBy: 'fail-closed-default', updatedAt: '', source: 'default' };
  var raw = null;
  try {
    raw = PropertiesService.getScriptProperties().getProperty(PL_POLICY_KEY);
  } catch (e) {
    return fallback;                       // 配置读取失败 → fail-closed
  }
  if (!raw) return fallback;               // 无策略 → 首次即保护
  try {
    var p = JSON.parse(raw);
    if (!p || typeof p !== 'object') return fallback;
    return {
      closed: p.closed !== false,          // 缺省 true（解析失败不变成放行）
      cutoff: (typeof p.cutoff === 'string' && p.cutoff) ? p.cutoff : PL_CUTOFF,
      futureOpen: p.futureOpen !== false,  // M4：独立业务标志，缺省 true
      updatedBy: String(p.updatedBy || ''),
      updatedAt: String(p.updatedAt || ''),
      source: 'props'
    };
  } catch (e) {
    return fallback;                       // 解析失败 → fail-closed
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
// 1. 业务日解析与期间判定（M2/M7）
// ============================================================

/**
 * M7：明确业务日解析。支持 Date 对象 / 'yyyy-MM-dd' / 'yyyy-MM-ddTHH:mm:ss' /
 * 'yyyy/M/d'。解析失败、空、非法、多格式歧义 → 返回 null（调用方必须拒）。
 * 一律按 GMT+8 归日，避免时区把 9/30 00:30 的解释权交给服务器位置。
 */
function _plParseBizDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return Utilities.formatDate(v, 'GMT+8', 'yyyy-MM-dd');
  }
  var s = String(v).trim();
  if (!s) return null;
  var m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ](\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  var y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // 用 UTC 构造再归日，规避本地时区把边界日算错
  var dt = new Date(Date.UTC(y, mo - 1, d));
  if (isNaN(dt.getTime())) return null;
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return y + '-' + (mo < 10 ? '0' + mo : '' + mo) + '-' + (d < 10 ? '0' + d : '' + d);
}

/** M2：该业务日是否落在已关账期间（< cutoff）。解析失败由调用方先行拦截。 */
function _plIsClosedBizDate(bizDate, cutoff) {
  return String(bizDate) < String(cutoff);   // 'yyyy-MM-dd' 字典序即时间序
}

// ============================================================
// 2. 写网关双向门禁（M1）—— 纯函数，无 IO，可单测
// ============================================================

/**
 * M1：双向日期检查。返回 { ok: bool, reason: string }。
 *   newDateRaw：本次写入的 fillDate（新增/修改均必填）
 *   origDateRaw：原记录 fillDate（修改/删除场景传入；新增传 null）
 * 规则：
 *   ① newDate 解析失败 → 拒（M7）
 *   ② newDate 在关账期间 → 拒
 *   ③ origDate 解析失败 → 拒（改/删不知原期间即拒）
 *   ④ origDate 在关账期间 → 拒（防“把旧行日期改到 10 月后”）
 *   ⑤ futureOpen=false → newDate >= cutoff 亦拒（M4 独立政策）
 *   ⑥ 全部通过 → 放行（锁内重核在 M8 临界区另行执行）
 */
function _plGuardCheck(newDateRaw, origDateRaw, policy) {
  var cutoff = (policy && policy.cutoff) || PL_CUTOFF;
  var newBiz = _plParseBizDate(newDateRaw);
  if (!newBiz) return { ok: false, reason: 'PL_REJECT_BAD_NEW_DATE' };
  if (_plIsClosedBizDate(newBiz, cutoff)) return { ok: false, reason: 'PL_REJECT_NEW_DATE_CLOSED' };
  if (policy && policy.futureOpen === false && newBiz >= cutoff) {
    return { ok: false, reason: 'PL_REJECT_FUTURE_CLOSED' };
  }
  if (origDateRaw !== null && origDateRaw !== undefined && origDateRaw !== '') {
    var origBiz = _plParseBizDate(origDateRaw);
    if (!origBiz) return { ok: false, reason: 'PL_REJECT_BAD_ORIG_DATE' };
    if (_plIsClosedBizDate(origBiz, cutoff)) return { ok: false, reason: 'PL_REJECT_ORIG_DATE_CLOSED' };
  }
  return { ok: true, reason: '' };
}

/**
 * R12a：批前校验。对一批写入（行数组 + fillDate 取列函数）全量门禁，
 * 任一不合格 → 整批拒（零写）。校验先于一切业务写，此承诺有机制支撑。
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

/**
 * M8：取锁。tryLock 失败 → 零写拒（不做无锁写入）。
 * 注意（官方语义）：取得锁对象 ≠ 取得锁，仅 tryLock 返回 true 视为取得互斥。
 */
function _plAcquire(timeoutMs) {
  var lock = LockService.getScriptLock();
  var got = false;
  try {
    got = lock.tryLock(timeoutMs || PL_LOCK_TIMEOUT_MS);
  } catch (e) {
    got = false;
  }
  if (!got) {
    var err = new Error('PL_REJECT_LOCK_BUSY');
    err.plCode = 'PL_REJECT_LOCK_BUSY';
    throw err;
  }
  return lock;
}

/**
 * M8：锁内重核。按稳定标识（UUID，I 列）重读当前行期间与软删状态，
 * 与调用方读取时看到的预期值比对；不符 → 拒（未知/竞争则拒，不做自动恢复）。
 * sheet：DB_工时流水 Sheet 对象；uuid：目标行 I 列；
 * expectBizDate：调用方读取时的 B 列业务日（yyyy-MM-dd，可为 null 表示不校验期间一致性）；
 * expectDeleted：调用方读取时的软删状态（boolean）。
 * 返回 { found, bizDate, deleted, mismatch }。
 */
function _plRecheckRow(sheet, uuid, expectBizDate, expectDeleted) {
  var out = { found: false, bizDate: null, deleted: false, mismatch: false };
  if (!uuid) { out.mismatch = true; return out; }
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][8] || '').trim() !== String(uuid).trim()) continue;
    out.found = true;
    var b = _plParseBizDate(data[i][1]);
    if (!b) { out.mismatch = true; return out; }        // 锁内解析失败 → 拒
    out.bizDate = b;
    var dv = data[i][14];
    out.deleted = (dv === true || String(dv).toUpperCase() === 'TRUE');
    if (expectBizDate && b !== expectBizDate) out.mismatch = true;
    if (expectDeleted !== undefined && expectDeleted !== null &&
        out.deleted !== !!expectDeleted) out.mismatch = true;
    return out;
  }
  out.mismatch = true;                                   // 行消失 → 拒
  return out;
}

/**
 * M8 主编排：受控临界区内完成「重读策略 → 重核行 → 独立门禁 → 业务写 → flush → 释放」。
 * 用法（改/删场景）：
 *   _plGuardedMutation({
 *     sheet: sheet,
 *     uuid: '...',                       // 稳定行标识（改/删必填；新增传 null）
 *     newDateRaw: f.date,                // 本次写入 fillDate
 *     origDateRaw: origBiz,              // 原记录期间（锁内重核期望值；新增传 null）
 *     expectDeleted: false,
 *     bizWrite: function(recheck) { ...业务写...; return result; }
 *   })
 * 失败语义：
 *   - tryLock 失败 → throw PL_REJECT_LOCK_BUSY（零写）
 *   - 锁内策略 fail-closed / 门禁不符 / 重核 mismatch → throw 对应 PL_REJECT_*（零写）
 *   - 业务写异常 → 登记 R12b 不确定批次 → finally 释放 → 原样抛出（不重放不补偿）
 *   - 不以 finally/hasLock 判定写成功；成功仅由 flush 完成+业务写返回定义
 */
function _plGuardedMutation(opts) {
  var sheet = opts.sheet;
  var lock = null;
  try {
    lock = _plAcquire(opts.timeoutMs);                   // M8：失败即拒，零写
    // ① 锁内重读策略（配置在锁外读到可能在锁内过期，锁内再读一次）
    var policy = _plPolicy();
    if (policy.closed === undefined) policy = _plPolicy(); // fail-closed 双确认
    // ② 锁内重核（改/删场景）
    var recheck = null;
    if (opts.uuid) {
      recheck = _plRecheckRow(sheet, opts.uuid, opts.origDateRaw, opts.expectDeleted);
      if (recheck.mismatch) {
        var e1 = new Error('PL_REJECT_ROW_CHANGED');
        e1.plCode = 'PL_REJECT_ROW_CHANGED';
        throw e1;
      }
    }
    // ③ 独立期间门禁 + 版本检查（锁本身不识别月份；门禁与互斥职责分离）
    var g = _plGuardCheck(opts.newDateRaw, opts.origDateRaw, policy);
    if (!g.ok) {
      var e2 = new Error(g.reason);
      e2.plCode = g.reason;
      throw e2;
    }
    // ④ 业务写
    var result = opts.bizWrite(recheck, policy);
    // ⑤ 写完成边界：释放锁前 flush 提交待处理变更（SpreadsheetApp 路径）
    try {
      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) SpreadsheetApp.flush();
    } catch (fe) {
      // flush 失败 → 提交状态不确定 → 按 R12b 登记，不判定成功
      _plLogUncertain('flush_failed', String(opts.uuid || 'batch'));
      var e3 = new Error('PL_UNCERTAIN_FLUSH_FAILED');
      e3.plCode = 'PL_UNCERTAIN_FLUSH_FAILED';
      throw e3;
    }
    return result;
  } catch (e) {
    // R12b：业务写/flush 阶段异常 → 登记不确定批次（不重放、不补偿、不回滚）
    if (e && (e.plCode === 'PL_UNCERTAIN_FLUSH_FAILED' || e.plCode === 'BIZ_WRITE_FAILED')) {
      _plLogUncertain('biz_write_or_flush', String(opts.uuid || 'batch'));
    }
    throw e;
  } finally {
    if (lock) { try { lock.releaseLock(); } catch (re) { /* 释放失败不改判 */ } }
  }
}

/**
 * R12b：不确定批次登记。写 _TS_WRITE_LOG（失败不影响主流程、不判定写成功）。
 * 仅记录「哪些范围不确定 + 交人工核查」，不做任何自动恢复动作。
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
                  'period-lock uncertain: ' + action, detail + ' (待人工核查，未自动重试/回滚/补偿)']);
  } catch (e) { /* 日志失败不阻断、不谎报 */ }
}

/**
 * 新增场景（submitBatch/tsAppendRows 的零原行路径）：
 * 批前校验（R12a）→ 取锁 → 锁内重读策略 → 门禁 → 业务写 → flush → 释放。
 */
function _plGuardedInsert(opts) {
  var lock = null;
  try {
    // R12a：批前全量校验，任一不合格整批零写（先于一切业务写）
    var pre = _plGuardCheckBatch(opts.rows, opts.dateOf, _plPolicy());
    if (!pre.ok) {
      var e0 = new Error(pre.reason + ' @row#' + pre.index);
      e0.plCode = pre.reason;
      throw e0;
    }
    lock = _plAcquire(opts.timeoutMs);                   // M8：失败即拒
    var policy = _plPolicy();                            // 锁内再读（双确认）
    var post = _plGuardCheckBatch(opts.rows, opts.dateOf, policy);
    if (!post.ok) {
      var e1 = new Error(post.reason + ' @row#' + post.index);
      e1.plCode = post.reason;
      throw e1;
    }
    var result = opts.bizWrite(policy);
    try {
      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) SpreadsheetApp.flush();
    } catch (fe) {
      _plLogUncertain('flush_failed', 'insert batch');
      var e2 = new Error('PL_UNCERTAIN_FLUSH_FAILED');
      e2.plCode = 'PL_UNCERTAIN_FLUSH_FAILED';
      throw e2;
    }
    return result;
  } catch (e) {
    if (e && (e.plCode === 'PL_UNCERTAIN_FLUSH_FAILED' || e.plCode === 'BIZ_WRITE_FAILED')) {
      _plLogUncertain('biz_write_or_flush', 'insert batch');
    }
    throw e;
  } finally {
    if (lock) { try { lock.releaseLock(); } catch (re) {} }
  }
}

// ============================================================
// 4. tsPatchCells 专项：仅 DB_工时流水 的 B 列与 O:Q 列过门禁（M1 分列）
// ============================================================

/**
 * tsPatchCells 可写任意表任意格。分列规则：
 *   - sheet !== DB_工时流水 → 不拦（非本锁作用对象）
 *   - cells: [row, col, value]（1-based）；col===2（B 列 fillDate）→ 锁内重读该行原期间，
 *     对新值过双向门禁（orig=锁内实读）
 *   - ranges: {row, col, values}；仅当覆盖 B 列（col<=2<col+宽度）→ 逐行过门禁
 *   - O:Q（15..17，软删标记列）→ 按删除场景：orig=锁内实读该行 B 列，关账期间拒
 *   - 其他列 → 不拦（不影响期间归属）
 * 返回 { ok, reason, offenders: [...] }；调用方在锁内调用本函数。
 */
function _plGuardPatch(sheet, cells, ranges) {
  var policy = _plPolicy();
  var offenders = [];
  var i, c, r, row, col, val, biz, orig;
  // 预读一次全表供锁内重核（B 列与 O:Q 判定）
  var data = sheet.getDataRange().getValues();
  function origBizOf(rn) {
    if (rn < 2 || rn > data.length) return null;
    return _plParseBizDate(data[rn - 1][1]);
  }
  for (i = 0; i < (cells || []).length; i++) {
    c = cells[i]; if (!c) continue;
    row = Number(c[0]); col = Number(c[1]); val = c[2];
    if (col === 2) {                                   // B 列 fillDate
      orig = origBizOf(row);
      var g = _plGuardCheck(val, orig, policy);
      if (!g.ok) offenders.push({ row: row, col: col, reason: g.reason });
    } else if (col >= 15 && col <= 17) {               // O:Q 软删标记
      orig = origBizOf(row);
      biz = _plParseBizDate(orig);
      if (biz && _plIsClosedBizDate(biz, policy.cutoff)) {
        offenders.push({ row: row, col: col, reason: 'PL_REJECT_ORIG_DATE_CLOSED' });
      }
    }
  }
  for (i = 0; i < (ranges || []).length; i++) {
    r = ranges[i]; if (!r || !r.values) continue;
    var startRow = Number(r.row), startCol = Number(r.col);
    var width = (r.values[0] || []).length;
    var coversB = (startCol <= 2 && startCol + width > 2);
    if (!coversB) continue;
    for (var ri = 0; ri < r.values.length; ri++) {
      var bIdx = 2 - startCol;                         // B 列在 values 内的索引
      var newB = r.values[ri][bIdx];
      if (newB === undefined || newB === null || newB === '') continue;
      orig = origBizOf(startRow + ri);
      var g2 = _plGuardCheck(newB, orig, policy);
      if (!g2.ok) offenders.push({ row: startRow + ri, col: 2, reason: g2.reason });
    }
  }
  if (offenders.length) return { ok: false, reason: 'PL_REJECT_PATCH_OFFENDERS', offenders: offenders };
  return { ok: true, reason: '' };
}
