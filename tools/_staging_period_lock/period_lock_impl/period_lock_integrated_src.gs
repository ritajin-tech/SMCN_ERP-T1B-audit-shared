/**
 * T1-B · period-lock 集成源码 v2（5 写入口完整改后函数 · 本地代码，零生产写）
 * ============================================================
 * 基线：ts-manager HEAD 快照 v4.3.72（_ts_head_live/，16 文件，组合 SHA 26471b41…）
 * 依据：Tom 09:27 实现层静态审阅五条（全部吸收）。本文件为**完整函数替换版**，
 *      无省略号，可逐行与基线核对；部署时以本文件函数替换基线同名函数，
 *      并新增 PeriodLockGuard.gs。
 *
 * v1(4d02da8) → v2 修订：
 *  [审1] tsPatchCells：ranges 的 O:Q 纳入门禁；空新 B 拒；原值三态。
 *  [审2] updateTimesheet/softDeleteRecord：锁内重核返回行号，bizWrite 用 recheck.row；
 *        expectName 归属重核；门禁原期间取锁内实读（_plGuardedMutation 内部保证）。
 *  [审3] submitBatch/tsAppendRows：写校验失败文案改「结果不确定，请人工核查」；
 *        写阶段任何异常由 guard 统一登记一次。
 *  [审5] submitBatch/tsAppendRows：近重复幂等判定（recentSeen/exist）移入锁内
 *        （lockPreWrite），串行化后判定，消除并发重复写入；回退须保留全部 5 入口。
 *
 * 🔴 零生产写；接入生产须 Rita 显式 GO + 双授权闸门。
 */

// ============================================================
// 入口 1/5：submitBatch（Code.gs L386 替换）
// ============================================================
function submitBatch(token, tasks) {
  const user = getCurrentUser(token);
  const pMap = getProjectMap();
  const newRows = [];
  const expectIds = [];   // V4.3.62: 写后回读校验用

  // ===== ① 批内去重（纯内存判定，无并发窗口）=====
  const inBatchSeen = {};
  // ===== ② 近 10 分钟幂等：判定移入锁内（[审5]），此处仅备Key =====
  const IDEMPOTENT_WINDOW_MS = 10 * 60 * 1000;

  let skippedDup = 0;
  tasks.forEach(f => {
    const pid = formatPid(f.project);
    const k = _tsDupKey(user.name, f.date, pid, f.hours, f.stage, f.notes);
    if (inBatchSeen[k]) { skippedDup++; return; }
    inBatchSeen[k] = true;

    const recordId = "TS-" + Utilities.getUuid().replace(/-/g, '').substring(0, 12).toUpperCase();
    const pName = pMap[pid] || "Other / 其他";
    const yearMonth = String(f.date).substring(0, 7);

    newRows.push([
      new Date(), f.date, String(user.name), _tsDeriveType(f), String(f.stage), pid, parseFloat(f.hours)||0, String(f.notes), recordId, pName, "", user.leader, "", yearMonth
    ]);
    expectIds.push(recordId);
  });

  if (newRows.length === 0) {
    return skippedDup > 0 ? ("SUCCESS (skipped " + skippedDup + " duplicate)") : "SUCCESS";
  }

  // period-lock（M8/R12a/R12b）：tryLock 失败零写；锁内策略+幂等复核+门禁；flush 后才释放
  return _plGuardedInsert({
    sheet: getDbSheet(),
    rows: newRows,
    dateOf: function (r) { return r[1]; },          // B 列 fillDate
    lockPreWrite: function (rows, policy) {         // [审5] 锁内幂等复核
      var sheet = getDbSheet();
      var last = sheet.getLastRow();
      var recentSeen = {};
      if (last > 1) {
        var from = Math.max(2, last - 799);         // 只回看最后 800 行
        var tail = sheet.getRange(from, 1, last - from + 1, 15).getValues();
        var nowMs = Date.now();
        tail.forEach(function (r) {
          var dv = r[14];
          if (dv === true || String(dv).toUpperCase() === 'TRUE') return;
          if (String(r[2] || '').trim() !== String(user.name).trim()) return;
          var t = (r[0] instanceof Date) ? r[0].getTime() : new Date(r[0]).getTime();
          if (!t || (nowMs - t) > IDEMPOTENT_WINDOW_MS) return;
          recentSeen[_tsDupKey(r[2], r[1], r[5], r[6], r[4], r[7])] = true;
        });
      }
      var kept = [], keptIds = [], skipped = 0;
      rows.forEach(function (r, idx) {
        var k = _tsDupKey(user.name, r[1], r[5], r[6], r[4], r[7]);
        if (recentSeen[k]) { skipped++; return; }
        kept.push(r); keptIds.push(expectIds[idx]);
      });
      expectIds.length = 0;
      Array.prototype.push.apply(expectIds, keptIds);
      return kept;
    },
    bizWrite: function (rows, policy) {
      var sheet = getDbSheet();
      var startRow = sheet.getLastRow() + 1;
      sheet.getRange(startRow, 1, rows.length, 14).setValues(rows);

      // 写后回读校验（V4.3.62 保留）；失败文案按 R12b 不确定语义更正（[审3]）
      var written = sheet.getRange(startRow, 9, rows.length, 1).getValues().map(function (r) { return String(r[0]); });
      var missed = 0;
      expectIds.forEach(function (id) { if (written.indexOf(id) < 0) missed++; });
      if (missed > 0) {
        throw new Error("写入校验未通过：" + missed + "/" + rows.length +
                        " 条未确认落表；结果不确定，请人工核查后重试（未自动重试）");
      }
      return "SUCCESS";
    }
  });
}

// ============================================================
// 入口 2/5：updateTimesheet（Code.gs L460 替换）
// ============================================================
function updateTimesheet(token, f) {
  try {
    const user = getCurrentUser(token);
    const sheet = getDbSheet();
    const data = sheet.getDataRange().getValues();
    const pMap = getProjectMap();

    for (let i = 1; i < data.length; i++) {
      const dv = data[i][14];
      if (dv === true || String(dv).toUpperCase() === "TRUE") continue;

      if (safeGetUuid(data[i][8]) == String(f.uuid).trim() && String(data[i][2]) === String(user.name)) {
        // period-lock（M1/M8）：锁内唯一定位+行号+归属重核+双向门禁
        return _plGuardedMutation({
          sheet: sheet,
          uuid: safeGetUuid(data[i][8]),
          newDateRaw: f.date,
          expectName: String(user.name),            // [审2] 锁内归属重核
          bizWrite: function (recheck, policy) {
            // [审2] 一律用锁内实读行号写入（防行移动「核A写B」）
            var row = recheck.row;
            sheet.getRange(row, 2, 1, 9).setValues([[
              f.date, String(user.name), "", String(f.stage), formatPid(f.project), parseFloat(f.hours) || 0, String(f.notes), safeGetUuid(data[i][8]), pMap[formatPid(f.project)] || "Other / 其他"
            ]]);
            return "SUCCESS";
          }
        });
      }
    }
    throw new Error("Record not found or no permission to edit. / 记录未找到或无权限修改");
  } catch (e) { throw new Error(e.message || "Update failed / 更新失败"); }
}

// ============================================================
// 入口 3/5：softDeleteRecord（Code.gs L483 替换）
// ============================================================
function softDeleteRecord(token, uuid) {
  try {
    const user = getCurrentUser(token);
    const sheet = getDbSheet();
    const data = sheet.getDataRange().getValues();

    for (let i = 1; i < data.length; i++) {
      if (safeGetUuid(data[i][8]) == String(uuid).trim() && String(data[i][2]) === String(user.name)) {
        // period-lock（M1/M8）：删除场景以锁内实读原期间过门禁
        return _plGuardedMutation({
          sheet: sheet,
          uuid: safeGetUuid(data[i][8]),
          newDateRaw: data[i][1],                   // 删除不产生新日期：以原期间过门禁
          expectName: String(user.name),            // [审2] 锁内归属重核
          bizWrite: function (recheck, policy) {
            // [审2] 锁内实读行号；门禁原期间已由 guard 取 recheck.bizDate 执行
            var row = recheck.row;
            sheet.getRange(row, 15, 1, 3).setValues([[true, user.name, new Date()]]);
            return "SUCCESS";
          }
        });
      }
    }
    throw new Error("Record not found or no permission to delete. / 记录未找到或无权限删除");
  } catch (e) { throw new Error(e.message || "Delete failed / 删除失败"); }
}

// ============================================================
// 入口 4/5：tsAppendRows（RemoteActions.gs L68 替换）
// ============================================================
var TS_APPEND_MAX_ROWS = 3000;

function tsAppendRows(e) {
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

    var toWrite = [], skippedLeave = 0;
    for (var j = 0; j < rows.length; j++) {
      var r = rows[j] || [];
      if (!force && _tsIsLeaveRowForGuard(r)) { skippedLeave++; continue; }
      var out = new Array(14);
      for (var k = 0; k < 14; k++) out[k] = (r[k] === undefined || r[k] === null) ? '' : r[k];
      toWrite.push(out);
    }

    if (dry || toWrite.length === 0) {
      _tsWriteLog('appendRows(dry=' + dry + ')', 'req=' + rows.length + ' wouldWrite=' + toWrite.length +
                  ' skipLeave=' + skippedLeave);
      return JSON.stringify({ ok: true, dry: dry, requested: rows.length, wouldWrite: toWrite.length,
                              skippedLeave: skippedLeave });
    }

    // period-lock（M8/R12a/R12b）：远程批量写同样进 guard 临界区；UUID 去重判定移入锁内（[审5]）
    var res = _plGuardedInsert({
      sheet: sh,
      rows: toWrite,
      dateOf: function (r) { return r[1]; },        // B 列 fillDate
      lockPreWrite: function (rowsIn, policy) {
        var last = sh.getLastRow();
        var exist = {};
        if (last > 1) {
          var uuids = sh.getRange(2, 9, last - 1, 1).getValues();
          for (var i = 0; i < uuids.length; i++) {
            var u = String(uuids[i][0] || '').trim();
            if (u) exist[u] = true;
          }
        }
        var kept = [], skippedDup = 0;
        rowsIn.forEach(function (r) {
          var uid = String(r[8] || '').trim();
          if (uid && exist[uid]) { skippedDup++; return; }
          if (uid) exist[uid] = true;               // 同批内也去重
          kept.push(r);
        });
        return kept;
      },
      bizWrite: function (rowsW, policy) {
        var startRow = sh.getLastRow() + 1;
        sh.getRange(startRow, 1, rowsW.length, 14).setValues(rowsW);
        // 写后回读校验；失败按 R12b 不确定语义（[审3]）
        var back = sh.getRange(startRow, 9, rowsW.length, 1).getValues();
        var got = 0;
        for (var m = 0; m < back.length; m++) if (String(back[m][0] || '').trim()) got++;
        if (got !== rowsW.length) {
          throw new Error("写入校验未通过：" + got + "/" + rowsW.length +
                          " 条确认落表；结果不确定，请人工核查后重试（未自动重试）");
        }
        return { wrote: rowsW.length, verified: got, startRow: startRow };
      }
    });
    _tsWriteLog('appendRows', 'req=' + rows.length + ' wrote=' + res.wrote + ' verified=' + res.verified +
                ' skipLeave=' + skippedLeave);
    return JSON.stringify({ ok: true, requested: rows.length, wrote: res.wrote, verified: res.verified,
                            skippedLeave: skippedLeave, startRow: res.startRow });
  } catch (err) {
    _tsWriteLog('appendRows(ERR)', String((err && err.message) || err));
    return JSON.stringify({ ok: false, error: String((err && err.message) || err) });
  }
}

// ============================================================
// 入口 5/5：tsPatchCells（RemoteActions.gs L138 替换 · [审1]/[审3]）
// ============================================================
function tsPatchCells(e) {
  e = e || {};
  var p = e.parameter || {};
  var body = e.postBody || {};
  var cells = body.cells || [];
  var ranges = body.ranges || [];
  var dry = String(p.dry || body.dry || '0') === '1';
  var sheetName = String(p.sheet || body.sheet || 'DB_工时流水');

  if (!cells.length && !ranges.length) return JSON.stringify({ ok: false, error: 'no cells provided' });
  if (cells.length > 5000) return JSON.stringify({ ok: false, error: 'too many cells: ' + cells.length });
  if (ranges.length > 2000) return JSON.stringify({ ok: false, error: 'too many ranges: ' + ranges.length });

  try {
    var _ssid = String(p.ssid || body.ssid || TS_ID);
    var sh = SpreadsheetApp.openById(_ssid).getSheetByName(sheetName);
    if (!sh) return JSON.stringify({ ok: false, error: 'sheet not found: ' + sheetName });
    var n = 0;
    if (!dry) {
      if (sheetName === PL_DB_SHEET) {
        // period-lock：仅 DB_工时流水 的 B 列与 O:Q 列进 guard（M1 分列）
        var _lock = _plAcquire();
        var enteredWrite = false;
        try {
          var chk = _plGuardPatch(sh, cells, ranges);   // [审1] 三态+全覆盖
          if (!chk.ok) {
            var e1 = new Error('period-lock reject: ' + chk.reason + ' ' + JSON.stringify(chk.offenders || []));
            e1.plCode = chk.reason;
            throw e1;                                    // 预检拒绝：不登记不确定
          }
          enteredWrite = true;
          for (var i = 0; i < cells.length; i++) {
            var c = cells[i];
            sh.getRange(Number(c[0]), Number(c[1])).setValue(c[2]);
            n++;
          }
          for (var r = 0; r < ranges.length; r++) {
            var g = ranges[r];
            var vs = g.values || [];
            if (!vs.length || !vs[0] || !vs[0].length) continue;
            sh.getRange(Number(g.row), Number(g.col), vs.length, vs[0].length).setValues(vs);
            n += vs.length * vs[0].length;
          }
          // [审3] 写完成边界：释放锁前 flush
          SpreadsheetApp.flush();
        } catch (err2) {
          // [审3] 进入写阶段后的任何异常登记一次（含普通 Error）
          if (enteredWrite) {
            _plLogUncertain('patch_write_or_flush',
                            'cells=' + cells.length + ' ranges=' + ranges.length +
                            ' err=' + String((err2 && err2.message) || err2));
          }
          throw err2;
        } finally {
          try { _lock.releaseLock(); } catch (re) {}
        }
      } else {
        // 非 DB_工时流水：不拦（§5 覆盖边界）
        for (var i2 = 0; i2 < cells.length; i2++) {
          var c2 = cells[i2];
          sh.getRange(Number(c2[0]), Number(c2[1])).setValue(c2[2]);
          n++;
        }
        for (var r2 = 0; r2 < ranges.length; r2++) {
          var g2 = ranges[r2];
          var vs2 = g2.values || [];
          if (!vs2.length || !vs2[0] || !vs2[0].length) continue;
          sh.getRange(Number(g2.row), Number(g2.col), vs2.length, vs2[0].length).setValues(vs2);
          n += vs2.length * vs2[0].length;
        }
      }
    }
    _tsWriteLog('patchCells' + (dry ? '(dry)' : ''), 'ss=' + _ssid + ' sheet=' + sheetName + ' cells=' + cells.length + ' ranges=' + ranges.length + ' done=' + n);
    return JSON.stringify({ ok: true, dry: dry, patched: dry ? 0 : n, requested: cells.length + ranges.length, ssid: SpreadsheetApp.openById(_ssid).getId(), sheet: sheetName });
  } catch (err) {
    return JSON.stringify({ ok: false, error: String((err && err.message) || err) });
  }
}
