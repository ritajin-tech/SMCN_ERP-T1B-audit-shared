// masterAttendanceLive.gs —— 主库考勤「实时化」改造（2026-10-26）
// ============================================================================
// 背景（根因）：主库「按月考勤」页由 rebuildAttendance.gs 的 REBUILD_GRID 写成，
//   那是一个 2026-10-15 时点【硬编码的静态网格】，不是从数据算出来的；
//   因此它永远停在 10-15，10/16 之后全公司打卡在主库里一个都看不到。
//   「月度视图」同理（年-月/人/工时合计）也停留在快照口径。
// 本文件的改造目标：把「生产表 → 主库底稿 → 主库考勤视图」整条链做成
//   【每日自动、幂等、可回滚、dry 默认】的长期通道，取代手工脚本 + 硬编码网格。
//
// 三件事：
//   ① syncProdToMaster()      生产表(DB_工时流水) 新增 → 追加到主库底稿(工时_候选0824)（增量、幂等）
//   ② rebuildAttendanceLive() 底稿 + 主库请假页 → 实时重算「按月考勤」矩阵（取代 REBUILD_GRID）
//   ③ refreshMasterViews()    底稿 + 主库请假页 → 实时重算「月度视图」
//   ④ listTriggers()          只读：输出本项目全部触发器清单（给 Tom 的触发器覆盖表）
//
// 口径铁律：
//   - 业务日期 = 原始值 +8h（GMT+8）；禁止取 UTC 日期前缀（10-16 整体早一天的历史 bug 根因）
//   - 请假行（休假/OFF-WORK/系统同步请假/LEAVE-）不计入工时聚合，在考勤矩阵里显示「假」
//     ⇒ 这就是 Q7 的答案：不靠删数据解决，靠【聚合口径】解决，零数据改动、可回滚
//   - 软删行（O 列 TRUE）一律排除
//   - 写入前两道闸：底稿行数下限 5000、单次新增上限 300（防读坏表被当新增灌爆）
// ============================================================================

var MAL_BASE_TAB = '工时_候选0824';   // 主库底稿
var MAL_PROD_TAB = 'DB_工时流水';     // 生产表
var MAL_ATTEND_TAB = '按月考勤';      // 主库考勤矩阵
var MAL_VIEW_TAB = '月度视图';        // 主库月度汇总

var MAL_MIN_BASE_ROWS = 5000;   // 底稿读到的行数下限（低于此视为读失败，禁止写）
var MAL_MAX_ADD_ROWS = 300;     // 单次追加上限
// [A7] 挂起行（录入时间 ≤ 水位线但底稿没有）摘要的保留上限，防止超大表把内存/日志撑爆
var ORPHAN_MAX_KEEP = 5000;

// ---------- 基础工具 ----------
function _malBizDate(v) {
  if (!v) return '';
  if (v instanceof Date) return Utilities.formatDate(v, 'GMT+8', 'yyyy-MM-dd');
  var s = String(v).trim();
  var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
  var t = new Date(s).getTime();
  if (isNaN(t)) return s.substring(0, 10);
  return Utilities.formatDate(new Date(t), 'GMT+8', 'yyyy-MM-dd');
}
function _malIsLeave(r) {
  var d = String(r[3] || ''), e = String(r[4] || ''), f = String(r[5] || '');
  var g = String(r[6] || ''), h = String(r[7] || ''), i = String(r[8] || '');
  return /休假|请假/.test(d) || /OFF-WORK/i.test(e) || /OFF-WORK/i.test(f) ||
         /系统同步请假|LEAVE-|AUTO_LEAVE/i.test(g + ' ' + h + ' ' + i);
}
function _malIsSoftDel(r) { return String(r[14] || '').trim().toUpperCase() === 'TRUE'; }
function _malNum(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }

// 读整页（返回二维数组，含表头行）；lastCol 为列字母
function _malReadAll(ss, tab, lastCol) {
  var sh = ss.getSheetByName(tab);
  if (!sh) throw new Error('缺少分页: ' + tab);
  return _malReadSheet(sh, lastCol);
}
function _malReadSheet(sh, lastCol) {
  var lr = sh.getLastRow();
  if (lr < 1) return [];
  return sh.getRange(1, 1, lr, _malColNum(lastCol)).getValues();
}
function _malColNum(letter) {
  var n = 0;
  for (var i = 0; i < letter.length; i++) n = n * 26 + (letter.charCodeAt(i) - 64);
  return n;
}
function _malContentKey(nm, proj, hrs, dt, note) {
  return [nm, String(proj || '').toLowerCase(), String(hrs || ''), dt, String(note || '')].join(String.fromCharCode(2));
}
function _malOpt(opt) {
  opt = opt || {};
  var dry = (opt.dry === undefined) ? true : !!opt.dry;
  return { dry: dry, maxAdd: opt.maxAdd || MAL_MAX_ADD_ROWS, months: opt.months || null };
}

// ============================================================================
// ① 生产表 → 主库底稿（增量追加，幂等）
//    判定：录入时间 > 底稿水位线 且 UUID/内容键均不在底稿 ⇒ 新增
//    剔除：请假行 / 软删行 / 无姓名 / 非 2026 / 无业务日期
// ============================================================================
// [A7] 把挂起行数量拼进返回值，让调用方与邮件正文都能看见（不再静默）
function _malOrphanSuffix(count, hours) {
  if (!count) return '';
  return '；[A7] 另有 ' + count + ' 条挂起行 / ' + (Math.round(hours * 10) / 10)
    + 'h 未进底稿（录入早于水位线且底稿无匹配，按 Rita 2026-10-27 决定不补录，请人工裁）';
}

function syncProdToMaster(opt) {
  opt = _malOpt(opt);
  var t0 = Date.now();
  try {
    var master = _lsGetMasterSs();
    var prod = SpreadsheetApp.openById(TS_ID);
    var base = _malReadAll(master, MAL_BASE_TAB, 'K');
    var rows = _malReadAll(prod, MAL_PROD_TAB, 'O');

    // 底稿索引 + 水位线
    var baseU = {}, baseC = {};
    var watermark = null;
    for (var i = 1; i < base.length; i++) {
      var r = base[i];
      var u = String(r[8] || '').trim();
      if (u) baseU[u] = true;
      var nm = String(r[2] || '').trim();
      var dt = _malBizDate(r[1]);
      if (nm && dt) baseC[_malContentKey(nm, r[5], r[6], dt, r[7])] = true;
      var ts = r[0] ? new Date(r[0]).getTime() : NaN;
      if (!isNaN(ts) && (watermark === null || ts > watermark)) watermark = ts;
    }
    if (base.length - 1 < MAL_MIN_BASE_ROWS) {
      return '[ABORT] 底稿只读到 ' + (base.length - 1) + ' 行（低于 ' + MAL_MIN_BASE_ROWS + '），疑似读取失败，零写入。';
    }

    // 生产表 → 新增候选
    var add = [], seenU = {}, seenC = {}, excluded = 0;
    var badTime = 0;                                   // [A7] 无录入时间的异常行计数
    var orphan = [], orphanCount = 0, orphanHours = 0; // [A7] 挂起行：不写入，但必须可见
    for (var j = 1; j < rows.length; j++) {
      var p = rows[j];
      var name = String(p[2] || '').trim();
      if (!name) { excluded++; continue; }
      if (_malIsLeave(p) || _malIsSoftDel(p)) { excluded++; continue; }
      var pd = _malBizDate(p[1]);
      if (!pd || pd.indexOf('2026') !== 0) { excluded++; continue; }
      var pu = String(p[8] || '').trim();
      var ck = _malContentKey(name, p[5], p[6], pd, p[7]);
      if ((pu && baseU[pu]) || baseC[ck]) continue;
      var pts = p[0] ? new Date(p[0]).getTime() : NaN;
      if (isNaN(pts)) { badTime++; continue; }                  // 无录入时间：异常行，不自动加（与本地体检口径一致）
      // [A7] 录入时间 ≤ 水位线但底稿没有 = 「挂起行」。原先这里是裸 continue，
      // 既不写也不报，导致长期静默悬空（2026-10 实测已达 1612 行 / 7238.5h，
      // 录入时间全部在 4-8 月，9/10 月为零，主库四个月来无人发现）。
      // Rita 2026-10-27 决定：主库已定稿 ⇒ 这里【仍然不写入】，但必须【可见】：
      // 计入 orphan 计数与摘要，由 dry 返回值、日志与调用方显式报出。
      if (watermark !== null && pts <= watermark) {
        if (orphan.length < ORPHAN_MAX_KEEP) {
          orphan.push([p[0], pd, name, p[3], p[4], p[5], p[6], pu, p[7]]);
        }
        orphanCount++;
        orphanHours += _malNum(p[6]);
        continue;
      }
      if (pu && seenU[pu]) continue;
      if (seenC[ck]) continue;
      if (pu) seenU[pu] = true;
      seenC[ck] = true;
      add.push([p[0], pd, name, p[3], p[4], p[5], p[6], p[7], pu, p[9], '增量同步']);
    }
    var addHours = 0;
    add.forEach(function (a) { addHours += _malNum(a[6]); });

    if (add.length > opt.maxAdd) {
      return '[ABORT] 本次新增 ' + add.length + ' 条（>' + opt.maxAdd + '），疑似异常，零写入。';
    }
    if (opt.dry) {
      return JSON.stringify({
        dry: true, baseRows: base.length - 1, prodRows: rows.length - 1,
        watermark: watermark ? _malBizDate(new Date(watermark)) + ' ' + Utilities.formatDate(new Date(watermark), 'GMT+8', 'HH:mm:ss') : '(无)',
        excluded: excluded, badTime: badTime,
        addCount: add.length, addHours: Math.round(addHours * 10) / 10,
        sample: add.slice(0, 5).map(function (a) { return a[1] + ' ' + a[2] + ' ' + a[5] + ' ' + a[6] + 'h'; }),
        // [A7] 挂起行：按 Rita 决定不补录，但必须报出来
        orphanCount: orphanCount, orphanHours: Math.round(orphanHours * 10) / 10,
        orphanSample: orphan.slice(0, 5).map(function (o) {
          return o[1] + ' ' + o[2] + ' ' + o[4] + ' ' + o[6] + 'h';
        })
      });
    }
    if (!add.length) {
      try {
        _tsWriteLog('sync_prod_to_master', '无新增，零写入；剔除 ' + excluded + ' 行'
          + '；[A7] 挂起行 ' + orphanCount + ' 条 / ' + (Math.round(orphanHours * 10) / 10) + 'h（录入早于水位线且底稿无匹配，按 Rita 决定不补录）');
      } catch (eL) {}
      return '[OK] 无新增，零写入。' + _malOrphanSuffix(orphanCount, orphanHours);
    }
    var sh = master.getSheetByName(MAL_BASE_TAB);
    var startRow = Math.max(sh.getLastRow() + 1, base.length + 1);
    sh.getRange(startRow, 1, add.length, 11).setValues(add);
    try {
      _tsWriteLog('sync_prod_to_master', '追加 ' + add.length + ' 行到主库底稿（' + addHours + 'h）；起始行 ' + startRow
        + '；剔除 ' + excluded + '；[A7] 挂起行 ' + orphanCount + ' 条 / ' + (Math.round(orphanHours * 10) / 10) + 'h');
    } catch (eL2) {}
    return '[OK] 已追加 ' + add.length + ' 条 / ' + addHours + 'h 到主库底稿，起始行 ' + startRow
      + '，耗时 ' + (Date.now() - t0) + 'ms' + _malOrphanSuffix(orphanCount, orphanHours);
  } catch (err) {
    try { _tsWriteLog('sync_prod_to_master_error', String(err && err.message || err)); } catch (eL3) {}
    return '[ERROR] ' + (err && err.message ? err.message : err);
  }
}

// ============================================================================
// ② 实时重算「按月考勤」矩阵（取代硬编码 REBUILD_GRID）
//    数据源：主库底稿(工时) + 主库请假页(假)
//    结构：每月一块 —— 第1行「2026年MM月」、第2行 姓名+全自然日(Date)、第3行起 每人一行
//    取值：当天有请假 ⇒「假」；否则底稿工时合计（无数据留空）
// ============================================================================
function _malBuildAttendData(months) {
  var master = _lsGetMasterSs();
  var baseSh = master.getSheetByName(MAL_BASE_TAB);
  if (!baseSh) throw new Error('主库缺少底稿分页: ' + MAL_BASE_TAB);
  var base = _malReadSheet(baseSh, 'K');
  var leaveSh = master.getSheetByName(MASTER_LEAVE_SHEET_NAME);
  var leaves = leaveSh ? _malReadSheet(leaveSh, 'N') : [];

  // 请假集合：姓名|日期
  var leaveSet = {};
  var leaveHours = {};   // 姓名|年-月 → 请假工时
  var leaveTimes = {};   // 姓名|年-月 → 请假次数（按去重键计）
  var seenLeaveKey = {};
  for (var i = 1; i < leaves.length; i++) {
    var L = leaves[i];
    var nm = String(L[0] || '').trim();
    var d = _malBizDate(L[1]);
    if (!nm || !d) continue;
    leaveSet[nm + '|' + d] = true;
    var ym = d.substring(0, 7);
    leaveHours[nm + '|' + ym] = (leaveHours[nm + '|' + ym] || 0) + _malNum(L[5]);
    var lk = String(L[7] || '').trim() || (nm + '|' + d);
    if (!seenLeaveKey[lk]) { seenLeaveKey[lk] = true; leaveTimes[nm + '|' + ym] = (leaveTimes[nm + '|' + ym] || 0) + 1; }
  }

  // 工时：姓名|日期 → 合计；姓名|年-月 → 合计
  var hoursByDay = {}, hoursByMonth = {}, names = {}, monthsSeen = {};
  for (var j = 1; j < base.length; j++) {
    var b = base[j];
    var name = String(b[2] || '').trim();
    var dt = _malBizDate(b[1]);
    if (!name || !dt) continue;
    if (_malIsLeave(b)) continue;          // Q7 口径：请假行工时不计入产出工时
    var h = _malNum(b[6]);
    hoursByDay[name + '|' + dt] = (hoursByDay[name + '|' + dt] || 0) + h;
    var m = dt.substring(0, 7);
    hoursByMonth[name + '|' + m] = (hoursByMonth[name + '|' + m] || 0) + h;
    names[name] = true;
    monthsSeen[m] = true;
  }
  // 请假也要出现在名单里
  Object.keys(leaveSet).forEach(function (k) {
    var parts = k.split('|');
    names[parts[0]] = true;
    monthsSeen[parts[1].substring(0, 7)] = true;
  });
  return {
    hoursByDay: hoursByDay, hoursByMonth: hoursByMonth, leaveSet: leaveSet,
    leaveHours: leaveHours, leaveTimes: leaveTimes,
    names: Object.keys(names).sort(),
    months: months || Object.keys(monthsSeen).sort()
  };
}

function _malMonthGrid(y, m) {
  // 返回 {title, days:[Date], mdList:[mm-dd]}
  var days = [], mdList = [];
  var last = new Date(y, m, 0).getDate();
  for (var d = 1; d <= last; d++) {
    var dt = new Date(y, m - 1, d);
    days.push(dt);
    mdList.push(('0' + m).slice(-2) + '-' + ('0' + d).slice(-2));
  }
  return { title: y + '年' + ('0' + m).slice(-2) + '月', days: days, mdList: mdList };
}

function rebuildAttendanceLive(opt) {
  opt = _malOpt(opt);
  try {
    var data = _malBuildAttendData(opt.months);
    var months = data.months.filter(function (mm) { return /^\d{4}-\d{2}$/.test(mm); });
    var master = _lsGetMasterSs();
    var sh = master.getSheetByName(MAL_ATTEND_TAB);
    if (!sh) return '[ABORT] 缺少分页: ' + MAL_ATTEND_TAB;

    var grid = [];
    for (var mi = 0; mi < months.length; mi++) {
      var y = parseInt(months[mi].substring(0, 4), 10);
      var mo = parseInt(months[mi].substring(5, 7), 10);
      var g = _malMonthGrid(y, mo);
      var blanks = [];
      for (var bi = 0; bi < g.days.length; bi++) blanks.push('');
      grid.push([g.title].concat(blanks));
      grid.push(['姓名'].concat(g.days));
      for (var ni = 0; ni < data.names.length; ni++) {
        var nm = data.names[ni];
        var row = [nm];
        for (var di = 0; di < g.mdList.length; di++) {
          var dayStr = y + '-' + g.mdList[di];
          var key = nm + '|' + dayStr;
          if (data.leaveSet[key]) { row.push('假'); continue; }
          var hv = data.hoursByDay[key];
          row.push(hv ? (Math.round(hv * 100) / 100) : '');
        }
        grid.push(row);
      }
    }
    // 各月天数不同（28/29/30/31）→ 行宽不齐，setValues 要求矩形，统一补到最大列数
    var nRows = grid.length, nCols = 0;
    for (var ri = 0; ri < grid.length; ri++) if (grid[ri].length > nCols) nCols = grid[ri].length;
    for (var rj = 0; rj < grid.length; rj++) while (grid[rj].length < nCols) grid[rj].push('');
    if (opt.dry) {
      return JSON.stringify({
        dry: true, months: months.length, names: data.names.length,
        gridRows: nRows, gridCols: nCols,
        firstMonth: grid[0] ? grid[0][0] : '', lastMonth: months[months.length - 1]
      });
    }
    // 备份（幂等：同名已存在则跳过）
    var bakName = '按月考勤_重算前_' + Utilities.formatDate(new Date(), 'GMT+8', 'yyyyMMdd');
    var bakMsg = '[SKIP]';
    try {
      if (!master.getSheetByName(bakName)) {
        var cp = sh.copyTo(master); cp.setName(bakName); bakMsg = '[OK] ' + bakName;
      }
    } catch (eB) { bakMsg = '[WARN] ' + eB.message; }
    if (sh.getMaxRows() < nRows) sh.insertRowsAfter(sh.getMaxRows(), nRows - sh.getMaxRows());
    if (sh.getMaxColumns() < nCols) sh.insertColumnsAfter(sh.getMaxColumns(), nCols - sh.getMaxColumns());
    sh.getRange(1, 1, nRows, nCols).setValues(grid);
    if (sh.getMaxRows() > nRows) sh.getRange(nRows + 1, 1, sh.getMaxRows() - nRows, nCols).clearContent();
    try { _tsWriteLog('attendance_rebuild_live', '实时重算「按月考勤」：' + nRows + '×' + nCols + '，月=' + months.length + '，人=' + data.names.length + '，备份=' + bakMsg); } catch (eL) {}
    return '[OK] 实时重算完成：' + nRows + '×' + nCols + '（' + months.length + ' 个月块 / ' + data.names.length + ' 人）；备份=' + bakMsg;
  } catch (err) {
    return '[ERROR] ' + (err && err.message ? err.message : err);
  }
}

// ============================================================================
// ③ 实时重算「月度视图」
//    列：年-月 / 姓名 / 工时合计 / 请假次数 / 请假工时
// ============================================================================
function refreshMasterViews(opt) {
  opt = _malOpt(opt);
  try {
    var data = _malBuildAttendData(opt.months);
    var out = [['年-月', '姓名', '工时合计', '请假次数', '请假工时']];
    var months = data.months.filter(function (mm) { return /^\d{4}-\d{2}$/.test(mm); });
    for (var i = 0; i < months.length; i++) {
      var ym = months[i];
      var label = ym.substring(0, 4) + '年' + ym.substring(5, 7) + '月';
      for (var j = 0; j < data.names.length; j++) {
        var nm = data.names[j];
        var h = data.hoursByMonth[nm + '|' + ym] || 0;
        var lh = data.leaveHours[nm + '|' + ym] || 0;
        var lt = data.leaveTimes[nm + '|' + ym] || 0;
        if (!h && !lh && !lt) continue;
        out.push([label, nm, Math.round(h * 100) / 100, lt, Math.round(lh * 100) / 100]);
      }
    }
    if (opt.dry) {
      return JSON.stringify({ dry: true, rows: out.length - 1, sample: out.slice(1, 4) });
    }
    var master = _lsGetMasterSs();
    var sh = master.getSheetByName(MAL_VIEW_TAB);
    if (!sh) return '[ABORT] 缺少分页: ' + MAL_VIEW_TAB;
    var bakName = '月度视图_重算前_' + Utilities.formatDate(new Date(), 'GMT+8', 'yyyyMMdd');
    var bakMsg = '[SKIP]';
    try {
      if (!master.getSheetByName(bakName)) { var cp = sh.copyTo(master); cp.setName(bakName); bakMsg = '[OK] ' + bakName; }
    } catch (eB) { bakMsg = '[WARN] ' + eB.message; }
    if (sh.getMaxRows() < out.length) sh.insertRowsAfter(sh.getMaxRows(), out.length - sh.getMaxRows());
    sh.getRange(1, 1, out.length, 5).setValues(out);
    if (sh.getMaxRows() > out.length) sh.getRange(out.length + 1, 1, sh.getMaxRows() - out.length, 5).clearContent();
    try { _tsWriteLog('master_views_live', '实时重算「月度视图」：' + (out.length - 1) + ' 行；备份=' + bakMsg); } catch (eL2) {}
    return '[OK] 实时重算「月度视图」' + (out.length - 1) + ' 行；备份=' + bakMsg;
  } catch (err) {
    return '[ERROR] ' + (err && err.message ? err.message : err);
  }
}

// ============================================================================
// ④ 只读：触发器与部署覆盖表（Tom 2026-10-25 合并函要求「各有效部署及触发器覆盖表」）
// ============================================================================
function listTriggers() {
  try {
    var ts = ScriptApp.getProjectTriggers();
    var out = ts.map(function (t) {
      var src = '', type = '';
      try { src = String(t.getTriggerSource()); } catch (e1) {}
      try { type = String(t.getEventType()); } catch (e2) {}
      return { handler: t.getHandlerFunction(), source: src, eventType: type, uid: t.getUniqueId() };
    });
    return JSON.stringify({
      scriptId: ScriptApp.getScriptId(),
      count: out.length,
      triggers: out,
      now: Utilities.formatDate(new Date(), 'GMT+8', 'yyyy-MM-dd HH:mm:ss')
    });
  } catch (err) {
    return '[ERROR] ' + (err && err.message ? err.message : err);
  }
}

// 建每日自动通道（幂等）：08:00 收割、08:15 重算考勤与视图
function ensureMasterSyncTriggers() {
  var want = [
    { fn: 'malDailySync', hour: 8, minute: 0 },
    { fn: 'malDailyRebuild', hour: 8, minute: 15 }
  ];
  var res = [];
  try {
    var have = {};
    ScriptApp.getProjectTriggers().forEach(function (t) { have[t.getHandlerFunction()] = true; });
    for (var i = 0; i < want.length; i++) {
      var w = want[i];
      if (have[w.fn]) { res.push(w.fn + ': [SKIP] 已存在'); continue; }
      ScriptApp.newTrigger(w.fn).timeBased().everyDays(1).atHour(w.hour).nearMinute(w.minute).create();
      res.push(w.fn + ': [OK] 已建 ' + w.hour + ':' + ('0' + w.minute).slice(-2));
    }
  } catch (err) {
    return '[ERROR] ' + (err && err.message ? err.message : err);
  }
  return '[OK] ' + res.join(' | ');
}

// 定时入口 1：每日 08:00 生产表 → 主库底稿（真写）
function malDailySync() {
  try { return syncProdToMaster({ dry: false }); } catch (e) { return '[ERROR] ' + e.message; }
}
// 定时入口 2：每日 08:15 重算考勤矩阵 + 月度视图（真写）
function malDailyRebuild() {
  var a, b;
  try { a = rebuildAttendanceLive({ dry: false }); } catch (e1) { a = '[ERROR] ' + e1.message; }
  try { b = refreshMasterViews({ dry: false }); } catch (e2) { b = '[ERROR] ' + e2.message; }
  return '考勤=' + a + '；视图=' + b;
}
// 一键全跑（本地/远程手动触发；dry 默认）
function malRunAll(opt) {
  opt = _malOpt(opt);
  var r = {};
  try { r.sync = syncProdToMaster(opt); } catch (e1) { r.sync = '[ERROR] ' + e1.message; }
  try { r.attend = rebuildAttendanceLive(opt); } catch (e2) { r.attend = '[ERROR] ' + e2.message; }
  try { r.views = refreshMasterViews(opt); } catch (e3) { r.views = '[ERROR] ' + e3.message; }
  return JSON.stringify(r);
}

// 从 Web App 请求参数构造选项：默认 dry（安全），只有显式 apply=1 或 dry=0 才真写
function _malOptFromE(e) {
  var p = (e && e.parameter) || {};
  var apply = (p.apply === '1' || p.dry === '0' || String(p.apply).toLowerCase() === 'true');
  var months = null;
  if (p.months) months = String(p.months).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  var maxAdd = parseInt(p.maxAdd, 10);
  return { dry: !apply, months: months, maxAdd: isNaN(maxAdd) ? MAL_MAX_ADD_ROWS : maxAdd };
}
