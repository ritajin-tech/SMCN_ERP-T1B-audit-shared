/**
 * T1-B · period-lock 集成源码 v3（5 写入口完整改后函数 · 本地代码，零生产写）
 * ============================================================
 * 基线：ts-manager HEAD 快照 v4.3.72（_ts_head_live/，16 文件，组合 SHA 26471b41…）
 * 依据：Tom 09:27 五条 + 09:59 五条（逐条核实全部属实，全部吸收）。
 * 本文件为**完整函数替换版**，无省略号，可逐行与基线核对；部署时以本文件函数
 * 替换基线同名函数，并新增 PeriodLockGuard.gs。
 *
 * v2(00d00ba) → v3 修订（Tom 09:59 五条中入口层部分）：
 *  [审①] updateTimesheet/softDeleteRecord 接版本绑定：锁外读行算 _plRowContentHash
 *         传 expectContentHash；两入口均传 expectDeleted=false（删除幂等：锁内发现
 *         已删 → PL_REJECT_ALREADY_DELETED，已删行的更新/再删一律拒）。
 *  [审②] lockPreWrite 统一返回 {rows, duplicates} 约定；全重复批次 guard 直接返回
 *         {wrote:0, duplicates, skippedAll:true}，入口据此回报跳过期数，
 *         不构造高度 0 区域、不误登记不确定。
 *  [审③] 登记失败外显：_plLogUncertain 返回 false（_TS_WRITE_LOG 不存在或写失败）时，
 *         错误对象挂 plLogFailed；Code.gs 两入口重抛时保留 plCode/plLogFailed，
 *         RemoteActions 两入口在 JSON 中显式带 logFailed:true 与人工核查提示。
 *         登记表不存在属部署前置（部署包显式含建表步骤），guard 不自动建表。
 *  [审④] cutoff 假日期校验与双 fallback 收紧均在 PeriodLockGuard.gs v3 内生效
 *         （_plValidCutoff / _plFailClosedPolicy），入口无需改动即受益。
 *  [审⑤] 表头行保护与 O:Q 期间政策统一在 _plGuardPatch v3 内生效
 *         （row<2 → PL_REJECT_HEADER_ROW；O:Q 走 _plGuardCheck 同一期间政策）。
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
  // ===== ② 近 10 分钟幂等：判定移入锁内（[审5] v2），此处仅备Key =====
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
  const res = _plGuardedInsert({
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
      return { rows: kept, duplicates: skipped };   // [审②] v3 统一返回约定
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
  // [审②] 全重复（锁内幂等复核后无新增）：无写、无高度0区域、无误报不确定
  if (res && typeof res === 'object' && res.skippedAll) {
    return "SUCCESS (skipped " + (res.duplicates || 0) + " duplicate)";
  }
  return res;
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

    // [审①-v4] 请求级版本绑定：期望版本必须由请求携带（客户端表单加载时服务端
    // 下发的行版本），不再用「请求到达后新读的行」充当用户编辑依据——否则
    // A 改完后 B 带旧表单到达，服务端读到 A 的新内容再算 hash，锁内同值仍会
    // 放行，旧表单可覆盖 A。缺省拒绝（fail-closed），不继续称已解决请求级
    // last-write-wins。
    const expectVersion = (f && f.expectContentHash) ? String(f.expectContentHash).trim() : '';
    if (!expectVersion) {
      const em = new Error('PL_REJECT_MISSING_EXPECT_VERSION');
      em.plCode = 'PL_REJECT_MISSING_EXPECT_VERSION';
      throw em;
    }

    for (let i = 1; i < data.length; i++) {
      const dv = data[i][14];
      if (dv === true || String(dv).toUpperCase() === "TRUE") continue;

      if (safeGetUuid(data[i][8]) == String(f.uuid).trim() && String(data[i][2]) === String(user.name)) {
        // period-lock（M1/M8）：锁内唯一定位+行号+归属重核+双向门禁
        // [审①-v4] 版本绑定：锁外读到的内容哈希传入，锁内重核不符即拒（last-write-wins 防护）；
        //       expectDeleted=false：锁外循环已跳过已删行，锁内发现已删 → 拒（删除幂等）
        return _plGuardedMutation({
          sheet: sheet,
          uuid: safeGetUuid(data[i][8]),
          newDateRaw: f.date,
          expectContentHash: expectVersion,
          expectName: String(user.name),            // [审2] 锁内归属重核
          expectDeleted: false,                     // [审①] 删除幂等
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
  } catch (e) {
    // [审③] 重抛保留 plCode/plLogFailed/plCause，供调用方分层识别（拒绝码 vs 登记失败外显）
    var ne = new Error(e.message || "Update failed / 更新失败");
    if (e && e.plCode) ne.plCode = e.plCode;
    if (e && e.plLogFailed) ne.plLogFailed = true;
    if (e && e.plCause) ne.plCause = e.plCause;
    throw ne;
  }
}

// ============================================================
// 入口 3/5：softDeleteRecord（Code.gs L483 替换）
// ============================================================
function softDeleteRecord(token, uuid, expectContentHash) {
  try {
    const user = getCurrentUser(token);
    const sheet = getDbSheet();
    const data = sheet.getDataRange().getValues();

    // [审①-v4] 请求级版本绑定（同 updateTimesheet）：缺省拒绝
    const expectVersion = expectContentHash ? String(expectContentHash).trim() : '';
    if (!expectVersion) {
      const em = new Error('PL_REJECT_MISSING_EXPECT_VERSION');
      em.plCode = 'PL_REJECT_MISSING_EXPECT_VERSION';
      throw em;
    }

    for (let i = 1; i < data.length; i++) {
      if (safeGetUuid(data[i][8]) == String(uuid).trim() && String(data[i][2]) === String(user.name)) {
        // period-lock（M1/M8）：删除场景以锁内实读原期间过门禁
        // [审①-v4] 版本绑定 + 删除幂等：删除入口恒定期望目标行未删；已删行的再删一律拒
        return _plGuardedMutation({
          sheet: sheet,
          uuid: safeGetUuid(data[i][8]),
          newDateRaw: data[i][1],                   // 删除不产生新日期：以原期间过门禁
          expectContentHash: expectVersion,
          expectName: String(user.name),            // [审2] 锁内归属重核
          expectDeleted: false,                     // [审①] 已删即拒（删除幂等）
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
  } catch (e) {
    // [审③] 重抛保留 plCode/plLogFailed/plCause
    var ne = new Error(e.message || "Delete failed / 删除失败");
    if (e && e.plCode) ne.plCode = e.plCode;
    if (e && e.plLogFailed) ne.plLogFailed = true;
    if (e && e.plCause) ne.plCause = e.plCause;
    throw ne;
  }
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
        return { rows: kept, duplicates: skippedDup };   // [审②] v3 统一返回约定
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
    // [审②] 全重复：无新增、无写、无误报不确定
    if (res && res.skippedAll) {
      _tsWriteLog('appendRows', 'req=' + rows.length + ' wrote=0 allDuplicates=' + (res.duplicates || 0) +
                  ' skipLeave=' + skippedLeave);
      return JSON.stringify({ ok: true, requested: rows.length, wrote: 0, verified: 0,
                              duplicatesSkipped: res.duplicates || 0, skippedLeave: skippedLeave,
                              allDuplicates: true });
    }
    _tsWriteLog('appendRows', 'req=' + rows.length + ' wrote=' + res.wrote + ' verified=' + res.verified +
                ' skipLeave=' + skippedLeave);
    return JSON.stringify({ ok: true, requested: rows.length, wrote: res.wrote, verified: res.verified,
                            skippedLeave: skippedLeave, startRow: res.startRow });
  } catch (err) {
    // [审③] 登记失败外显：plLogFailed 时 JSON 显式带出，提示人工核查，不得吞
    var msg = String((err && err.message) || err);
    var lf = !!(err && err.plLogFailed);
    if (lf) {
      msg += '（⚠ 不确定批次登记失败：_TS_WRITE_LOG 不存在或不可写，请人工核查后补登记；本错误不得吞）';
    }
    _tsWriteLog('appendRows(ERR)', msg);
    return JSON.stringify({ ok: false, error: msg, plCode: (err && err.plCode) || '', logFailed: lf });
  }
}

// ============================================================
// 入口 5/5：tsPatchCells（RemoteActions.gs L138 替换 · [审1]/[审3]/[审⑤]）
// ============================================================
// [审①-v4] 覆盖边界明示：本通道为直接改格子的远程批量工具，**无请求级版本概念**，
// 明确降格为「仅服务端短窗口防护」（锁内实读+门禁），不宣称请求级 last-write-wins
// 保护；用户表单编辑必须走 updateTimesheet（强请求级版本绑定）。
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
          var chk = _plGuardPatch(sh, cells, ranges);   // [审1] 三态+全覆盖；[审⑤] 表头保护+O:Q 政策统一
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
          // [审3][审③-v4] 进入写阶段后的任何异常=结果不确定：登记一次 + 统一
          // PL_UNCERTAIN_PATCH_WRITE_FAILED 码与 plCause（与预检拒绝分层）；
          // plLogFailed 按实际登记结果设置（登记成功=false，不误报）
          if (enteredWrite) {
            var loggedP = _plLogUncertain('patch_write_or_flush',
                            'cells=' + cells.length + ' ranges=' + ranges.length +
                            ' err=' + String((err2 && err2.message) || err2));
            if (err2 && err2.plCode) throw err2;    // 已结构化不双包
            var ue = new Error('PL_UNCERTAIN_PATCH_WRITE_FAILED');
            ue.plCode = 'PL_UNCERTAIN_PATCH_WRITE_FAILED';
            ue.plCause = String((err2 && err2.message) || err2);
            ue.plLogFailed = !loggedP;
            throw ue;
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
    // [审③] 登记失败外显；plCause 一并透出（结果不确定时保留原始原因）
    var msg2 = String((err && err.message) || err);
    var lf2 = !!(err && err.plLogFailed);
    if (lf2) {
      msg2 += '（⚠ 不确定批次登记失败：_TS_WRITE_LOG 不存在或不可写，请人工核查后补登记；本错误不得吞）';
    }
    return JSON.stringify({ ok: false, error: msg2, plCode: (err && err.plCode) || '',
                            plCause: (err && err.plCause) || '', logFailed: lf2 });
  }
}
