// ts-manager RemoteActions.gs — SMCN 手机远程触发动作注册
// 配套 RemoteTrigger.gs 使用。本文件【不含 doGet】（Code.js 已有 doGet，返回填报网页），
// 请在 Code.js 的 doGet 首行加：var r = _rtMaybeHandle(e); if (r) return r;
// 👇 部署后的真实 Web App URL（菜单显示用；可随时用 ?action=_seturl&url= 热更新）
var REMOTE_WEBAPP_URL = "https://script.google.com/a/macros/spacematrix.com/s/AKfycbwlxB2z9IDDo7pBv4sr0pu6-1ywvYBuRyqTwfjgl_o/exec";
var REMOTE_ACTIONS = {
  repairLegacyLeave: function(e) { return repairLegacyLeave(e); }, // V4.3.83 软删指定行「遗留活跃请假」标记（GET 可触发，O/P/Q，零物理删，幂等）
  setupPeriodLock: function(e) { return setupPeriodLock(e); }, // V4.3.84 初始化 period-lock 策略态 + 建 _TS_WRITE_LOG 审计页（GET 可触发，幂等，零业务写）
  plVerifyHash: function(e) { return plVerifyHash(e); },
  plGuardTest: function(e) { return plGuardTest(e); },      // V4.3.86 只读诊断：门禁行为实证（过去拒/未来放行）      // V4.3.85 只读诊断：实证 _plRowContentHash 可用 + 统计不可定版行（rowHash=null）
  masterException: function(e) { var ym = (e && e.parameter && e.parameter.month) || Utilities.formatDate(new Date(), "GMT+8", "yyyy-MM"); return refreshMasterException(ym); },  // V4.3.80 刷考勤表(主库)「月度异常」矩阵（?month=yyyy-MM，默认当月；每日07:00自动刷新）
  refreshqs:     function() { refreshQSBoard(); return "QS看板已刷新"; },
  exception:     function(e) { var ym = (e && e.parameter && e.parameter.month) || Utilities.formatDate(new Date(), "GMT+8", "yyyy-MM"); return refreshMonthlyExceptions(ym); },  // V4.3.66: 支持 &month=yyyy-MM 远程重刷指定月份
  archive:       function() { return archiveCurrentSpreadsheet(); },
  setup:         function() { setupAllTriggers(); return "触发器已重建"; },
  setupAmy:      function() { setupAmyMonthlyReminder(); return "Amy 间接成本月度提醒触发器已开启（每日09:00检查，最后一个工作日发）"; },
  testAmySelf:   function() { testSendAmySelf(); return "已给本人发送一封相同内容的测试邮件（验证发件人=你的 Gmail）"; },
  cleanupLeaves: function() { return cleanupDuplicateLeavesInternal(); },
  syncLeaves:    function() { return syncLeavesFromCalendar(1, 2); },
  checkLeaves:   function(e) { return tsCheckLeaves(e); },
  readRange:     function(e) { return tsReadRange(e); },
  appendRows:    function(e) { return tsAppendRows(e); },   // V4.3.62 写入端（幂等，恢复数据用）
  patchCells:    function(e) { return tsPatchCells(e); },   // V4.3.62 批量改格（补类型列用）
  softDelGuarded: function(e) { return tsSoftDelGuarded(e); },   // V4.3.87 软标动作，CAS 在服务端锁内闭环
  createSheet:   function(e) { return tsCreateSheet(e); },   // V4.3.73 建 sheet（受 REMOTE_TOKEN 门控；对称 tsPatchCells 的 ssid 约定）
  snapshot:      function(e) { return tsSnapshot(e); },     // V4.3.62 每日指纹（差异告警用）
  trimblank:     function(e) { return tsTrimBlank(e); },     // V4.3.63 删尾部空白行（表格膨胀自愈）
  dupreport:     function(e) { return tsDupReport(e); },      // V4.3.63 连点重复提交体检报告
  driveList:     function(e) { return tsDriveList(e); },      // V4.3.65 列出周存档文件夹里的备份文件（只读）
  purgeSoftLeaves: function(e) { return tsPurgeSoftLeaves(e); }, // V4.3.68 清「软删+休假类」假条行
  purgeRows:      function(e) { return tsPurgeRows(e); },      // V4.3.69 物理删「指定UUID集合」或软删行（清理过量恢复残留）
  probeCalendar: function(e) { return tsProbeCalendar(e); },   // V4.3.72 只读读 China Employee Leave Calendar，核对表里请假行 vs 日历真值
  masterCreate:   function(e) { return masterCreate(e); },     // V4.3.74 建独立主库 T1B_主库_工时与请假
  masterLeaves:   function(e) { return masterLeaves(e); },     // V4.3.74 只读读 China Employee Leave Calendar 真值(去重)
  pruneDead:     function(e) { return tsPruneDead(e); },     // V4.3.74 物理删「整行空白 OR 软删」死行（回收活表预算）
  fixBDates:     function(e) { return tsFixBDates(e); },     // V4.3.75 受护栏批量还原被 pruneDead 静默改坏的 B 列业务日期
  delBlankRows:  function(e) { return tsDelBlankRows(e); },   // V4.3.76 删除活表内全部整行空白行(含中部)，回收活表预算
  sheetMeta:    function(e) { return tsSheetMeta(e); },     // V4.3.77 只读读任意 sheet 数据区域的「值+呈现格式」(背景色/字体/浮窗/合并/冻结/列宽/条件格式/数字格式)，用于 1:1 复刻样式
  applyFormat:  function(e) { return tsApplyFormat(e); },    // V4.3.78 写格式管道（哑管道：ops 参数驱动）：文本化写入/背景/字色/加粗/字号/对齐/浮窗/列宽行高/冻结/追加条件格式；支持 dry
  masterCondFormat: function(e) { return tsSetCondFormat(e); },  // V4.3.81 重设条件格式(全量替换;修 cfAppend 只会 LESS_THAN 缺陷);🔴护栏:只准主库 SSID
  alert: function(e) { return tsSendAlert(e); },  // V4.3.82 本机失败告警→邮件(token门控;不碰表格数据)
  listTriggers: function() { return listTriggers() },                          // V4.3.86 只读：本项目触发器覆盖表
  syncMaster: function(e) { return syncProdToMaster(_malOptFromE(e)) },         // V4.3.86 生产表→主库底稿增量（dry 默认；apply=1 才写）
  rebuildLive: function(e) { return rebuildAttendanceLive(_malOptFromE(e)) },   // V4.3.86 实时重算「按月考勤」（取代硬编码 REBUILD_GRID）
  viewsLive: function(e) { return refreshMasterViews(_malOptFromE(e)) },        // V4.3.86 实时重算「月度视图」
  malAll: function(e) { return malRunAll(_malOptFromE(e)) },                    // V4.3.86 一键跑三件事
  ensureMalTriggers: function() { return ensureMasterSyncTriggers() }           // V4.3.86 建每日收割/重算触发器（幂等）
};

// ============================================================
// V4.3.62 【写入端哑管道】
// 设计意图：与 readRange 对称 —— 这是最后一次需要重新部署的改动。
//   之后任何「恢复数据 / 批量修字段」都由本地脚本经本通道完成，逻辑全在本地，零重部署。
// 幂等：按 I 列 UUID 去重，同一批重复提交不会产生重复行。
// 护栏：单次上限 3000 行；默认拒绝写入请假行（LEAVE-/系统同步请假），需 force=1 才放行。
// 审计：每次写入在 _TS_WRITE_LOG 页签留痕（时间/动作/请求数/写入数/跳过数）。
// 调用：POST <WEBAPP>  body: {"action":"appendRows","token":"...","rows":[[...14列...], ...]}
// ============================================================
var TS_APPEND_MAX_ROWS = 3000;

function _tsIsLeaveRowForGuard(r) {
  var s = (String(r[7] || '') + ' ' + String(r[8] || '') + ' ' + String(r[5] || '')).toUpperCase();
  return /LEAVE-/.test(s) || /系统同步请假/.test(String(r[7] || '')) || /OFF-WORK/.test(s);
}

function _tsWriteLog(action, detail) {
  try {
    var ss = SpreadsheetApp.openById(TS_ID);
    var sh = ss.getSheetByName('_TS_WRITE_LOG');
    if (!sh) {
      sh = ss.insertSheet('_TS_WRITE_LOG');
      sh.appendRow(['时间', '动作', '明细']);
      sh.getRange(1, 1, 1, 3).setFontWeight('bold');
    }
    sh.appendRow([Utilities.formatDate(new Date(), 'GMT+8', 'yyyy-MM-dd HH:mm:ss'), action, detail]);
  } catch (e) { /* 日志失败不影响主流程 */ }
}

/**
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
}

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
}

/**
 * V4.3.62 批量改单元格 —— 补类型列等「字段级修复」用。
 * POST body: {"action":"patchCells","token":"...","cells":[[row, col, value], ...]}（row/col 均为 1-based）
 * 护栏：单次 ≤ 5000 格；只写值不动格式。
 */
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
    // V4.3.66：加 ssid 参数 → 可写任意电子表格（对称 readRange V4.3.65）。不给 ssid 就写本表，行为不变。
    var _ssid = String(p.ssid || body.ssid || TS_ID);
    var sh = SpreadsheetApp.openById(_ssid).getSheetByName(sheetName);
    if (!sh) return JSON.stringify({ ok: false, error: 'sheet not found: ' + sheetName });
    var n = 0;
    if (!dry) {
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
    }
    _tsWriteLog('patchCells' + (dry ? '(dry)' : ''), 'ss=' + _ssid + ' sheet=' + sheetName + ' cells=' + cells.length + ' ranges=' + ranges.length + ' done=' + n);
    return JSON.stringify({ ok: true, dry: dry, patched: dry ? 0 : n, requested: cells.length + ranges.length, ssid: SpreadsheetApp.openById(_ssid).getId(), sheet: sheetName });
  } catch (err) {
    return JSON.stringify({ ok: false, error: String((err && err.message) || err) });
  }
}

/**
 * V4.3.73 建 sheet（受 REMOTE_TOKEN 门控）—— 给「写管道」补足「建表」能力，
 * 与 tsPatchCells/tsReadRange 对称：支持 ssid 参数写任意电子表格。
 * 幂等：sheet 已存在则返回 existed:true，不重复建、不报错（重跑安全）。
 * 用法：POST body {"action":"createSheet","token":"...","ssid":"<表ID>","sheet":"<新tab名>","dry":0}
 */
function tsCreateSheet(e) {
  e = e || {};
  var p = e.parameter || {};
  var body = e.postBody || {};
  var dry = ['1', 'true', 'TRUE', 'yes'].indexOf(String(p.dry || body.dry || '')) >= 0;
  var sheetName = String(p.sheet || body.sheet || '').trim();
  var _ssid = String(p.ssid || body.ssid || TS_ID);
  if (!sheetName) return JSON.stringify({ ok: false, error: 'missing sheet name' });
  try {
    var ss = SpreadsheetApp.openById(_ssid);
    var existing = ss.getSheetByName(sheetName);
    if (existing) {
      return JSON.stringify({ ok: true, existed: true, ssid: ss.getId(), sheet: sheetName,
                              url: ss.getUrl() + '#gid=' + existing.getSheetId() });
    }
    if (dry) {
      _tsWriteLog('createSheet(dry)', 'ss=' + _ssid + ' sheet=' + sheetName + ' wouldCreate=true');
      return JSON.stringify({ ok: true, dry: true, existed: false, wouldCreate: true, ssid: ss.getId(), sheet: sheetName });
    }
    var sh = ss.insertSheet(sheetName);
    _tsWriteLog('createSheet', 'ss=' + _ssid + ' sheet=' + sheetName + ' created=true');
    return JSON.stringify({ ok: true, existed: false, created: true, ssid: ss.getId(), sheet: sheetName,
                            url: ss.getUrl() + '#gid=' + sh.getSheetId() });
  } catch (err) {
    return JSON.stringify({ ok: false, error: String((err && err.message) || err) });
  }
}

/**
 * V4.3.62 每日指纹快照 —— 写一行到 _TS_SNAPSHOT（总行/有效行/总工时/按人时数）。
 * 用途：本地每日对比，行数或工时异常下跌立刻告警（9/11 事故若能早发现可少丢 1000 行）。
 */
function tsSnapshot(e) {
  e = e || {};
  try {
    var sh = SpreadsheetApp.openById(TS_ID).getSheetByName('DB_工时流水');
    var data = sh.getDataRange().getValues();
    var live = 0, hours = 0, byName = {};
    for (var i = 1; i < data.length; i++) {
      if (!String(data[i][2] || '').trim()) continue;
      if (String(data[i][14] || '').toString().toUpperCase() === 'TRUE') continue;
      live++;
      var h = parseFloat(data[i][6]) || 0;
      hours += h;
      var nm = String(data[i][2]).trim();
      byName[nm] = (byName[nm] || 0) + h;
    }
    var ss = SpreadsheetApp.openById(TS_ID);
    var snap = ss.getSheetByName('_TS_SNAPSHOT');
    if (!snap) {
      snap = ss.insertSheet('_TS_SNAPSHOT');
      snap.appendRow(['日期', '总行数', '有效行', '总工时', '人数', '按人时数JSON']);
      snap.getRange(1, 1, 1, 6).setFontWeight('bold');
    }
    var d = Utilities.formatDate(new Date(), 'GMT+8', 'yyyy-MM-dd');
    snap.appendRow([d, data.length, live, Math.round(hours * 10) / 10, Object.keys(byName).length,
                    JSON.stringify(byName)]);
    return JSON.stringify({ ok: true, date: d, totalRows: data.length, live: live,
                            hours: Math.round(hours * 10) / 10, people: Object.keys(byName).length });
  } catch (err) {
    return JSON.stringify({ ok: false, error: String((err && err.message) || err) });
  }
}

/**
 * 通用只读数据管道 —— 读任意 sheet 的任意 A1 区域，返回原始二维数组。
 * 设计意图：本函数**永远不需要修改**（哑管道），所有分析逻辑放在调用端（本地 Python），
 * 因此 Web App 部署一次之后，改分析逻辑不再需要重新部署。
 * 用法：?action=readRange&token=...&sheet=DB_工时流水&range=B1:I
 */
function tsReadRange(e) {
  e = e || {};
  var p = e.parameter || {};
  var sheetName = String(p.sheet || 'DB_工时流水');
  var a1 = String(p.range || 'A1:O');
  try {
    // V4.3.65：加 ssid 参数 → 可读任意电子表格（周存档备份）。不给 ssid 就读本表，行为不变。
    var ss = p.ssid ? SpreadsheetApp.openById(String(p.ssid)) : SpreadsheetApp.openById(TS_ID);
    var sh = ss.getSheetByName(sheetName);
    if (!sh) return JSON.stringify({ ok: false, error: 'sheet not found: ' + sheetName });
    // FIX 2026-10-13 (P2-21): rows 上限保护。A1:O 这类开区间会一次性拉全表
    //   （DB_工时流水约 4 万行），既容易把 Web App 打到超时，回包也会大到被截断。
    //   超限时按原起点/列宽截断到 MAX_READ_ROWS 行，并在回包里标记 truncated。
    //   现有调用方最大分块 14000 行，20000 上限不影响任何在用的读法。
    var MAX_READ_ROWS = 20000;
    var rg = sh.getRange(a1);
    var truncated = false;
    if (rg.getNumRows() > MAX_READ_ROWS) {
      rg = sh.getRange(rg.getRow(), rg.getColumn(), MAX_READ_ROWS, rg.getNumColumns());
      truncated = true;
    }
    // fmt=raw 取原始值(日期会变成 ISO UTC 串，有+8时区偏移风险)；默认 display 取表格显示值(日期即 2026-08-20 形态)
    var useRaw = String(p.fmt || 'display').toLowerCase() === 'raw';
    var vals = useRaw ? rg.getValues() : rg.getDisplayValues();
    return JSON.stringify({
      ok: true, sheet: sheetName, range: a1, fmt: useRaw ? 'raw' : 'display',
      ssid: ss.getId(), name: ss.getName(),
      rows: vals.length, cols: (vals[0] ? vals[0].length : 0), truncated: truncated,
      values: vals
    });
  } catch (err) {
    return JSON.stringify({ ok: false, error: String((err && err.message) || err) });
  }
}

/**
 * V4.3.77 只读格式管道 —— 读任意 sheet 数据区域的「值 + 呈现格式」。
 * 设计意图：readRange 只返回值，看不到颜色/浮窗/合并/冻结/条件格式；本动作补齐，
 *   用于把一张表的样式 1:1 复刻到另一张表（如生产表 Sheet1 → 主库考勤看板）。
 * 永远只读，不写任何东西。规模护栏：默认 60 行 × 30 列，硬顶 200 × 60，
 *   超出返回 truncated + 实际尺寸，调用方可传 maxR/maxC 分区读。
 * 用法：?action=sheetMeta&token=...&ssid=...&sheet=Sheet1
 */
function tsSheetMeta(e) {
  e = e || {};
  var p = e.parameter || {};
  var ssid = String(p.ssid || TS_ID);
  var sheetName = String(p.sheet || '');
  var HARD_R = 200, HARD_C = 60;
  var maxR = Math.min(parseInt(p.maxR || '60', 10) || 60, HARD_R);
  var maxC = Math.min(parseInt(p.maxC || '30', 10) || 30, HARD_C);
  function safe(fn, dflt) { try { var v = fn(); return v == null ? dflt : v; } catch (err) { return dflt; } }
  function hexOf(c) {
    if (c == null) return null;
    if (typeof c === 'string') return c;
    try {
      if (c.getRgbColor) {
        var rgb = c.getRgbColor();
        function h(x) { return ('0' + Math.round(x * 255).toString(16)).slice(-2); }
        return '#' + h(rgb.red) + h(rgb.green) + h(rgb.blue);
      }
    } catch (e2) {}
    return null;
  }
  try {
    var ss = SpreadsheetApp.openById(ssid);
    var sh = sheetName ? ss.getSheetByName(sheetName) : ss.getActiveSheet();
    if (!sh) return JSON.stringify({ ok: false, error: 'sheet not found: ' + sheetName });
    var dr = sh.getDataRange();
    var r0 = dr.getRow(), c0 = dr.getColumn(), nr = dr.getNumRows(), nc = dr.getNumColumns();
    var rr = Math.min(nr, maxR), cc = Math.min(nc, maxC);
    var rg = sh.getRange(r0, c0, rr, cc);
    var out = {
      ok: true, ssid: ss.getId(), name: ss.getName(), sheet: sh.getName(),
      area: {
        row0: r0, col0: c0, rows: nr, cols: nc, readRows: rr, readCols: cc,
        truncated: (nr > maxR || nc > maxC),
        maxRows: sh.getMaxRows(), maxCols: sh.getMaxColumns()
      },
      values: rg.getDisplayValues(),
      backgrounds: safe(function () { return rg.getBackgrounds(); }, null),
      fontColors: safe(function () { return rg.getFontColors(); }, null),
      fontWeights: safe(function () { return rg.getFontWeights(); }, null),
      fontSizes: safe(function () { return rg.getFontSizes(); }, null),
      fontFamilies: safe(function () { return rg.getFontFamilies(); }, null),
      horizontalAlignments: safe(function () { return rg.getHorizontalAlignments(); }, null),
      numberFormats: safe(function () { return rg.getNumberFormats(); }, null),
      notes: safe(function () { return rg.getNotes(); }, null),
      dataValidations: safe(function () {
        var dv = rg.getDataValidations(); var o = [];
        for (var i = 0; i < dv.length; i++) {
          var row = [];
          for (var j = 0; j < dv[i].length; j++) {
            var v = dv[i][j];
            if (!v) { row.push(null); continue; }
            row.push({ type: safe(function () { return v.getCriteriaType(); }, null),
                       values: safe(function () { return v.getCriteriaValues(); }, null),
                       allowInvalid: safe(function () { return v.getAllowInvalid(); }, null) });
          }
          o.push(row);
        }
        return o;
      }, null)
    };
    // 列宽 / 行高（仅数据区域涉及的列/行）
    var colW = [], rowH = [];
    for (var c = c0; c < c0 + cc; c++) colW.push(safe((function (cc2) { return function () { return sh.getColumnWidth(cc2); }; })(c), null));
    for (var r = r0; r < r0 + rr; r++) rowH.push(safe((function (rr2) { return function () { return sh.getRowHeight(rr2); }; })(r), null));
    out.columnWidths = colW;
    out.rowHeights = rowH;
    // 合并单元格
    var merges = [];
    try {
      sh.getMergedRanges().forEach(function (m) {
        merges.push({ r1: m.getRow(), c1: m.getColumn(), r2: m.getLastRow(), c2: m.getLastColumn() });
      });
    } catch (e3) {}
    out.merges = merges;
    // 冻结
    out.frozen = { rows: safe(function () { return sh.getFrozenRows(); }, 0), cols: safe(function () { return sh.getFrozenColumns(); }, 0) };
    // 条件格式规则
    var cf = [];
    try {
      sh.getConditionalFormatRules().forEach(function (rule) {
        var item = { ranges: [] };
        try {
          rule.getRanges().forEach(function (rg2) {
            item.ranges.push({ r1: rg2.getRow(), c1: rg2.getColumn(), r2: rg2.getLastRow(), c2: rg2.getLastColumn() });
          });
        } catch (e4) {}
        try {
          var bc = rule.getBooleanCondition();
          if (bc) {
            item.criteria = safe(function () { return bc.getCriteriaType(); }, null);
            item.args = safe(function () { return bc.getCriteriaArguments(); }, null);
            item.bg = safe(function () { return hexOf(bc.getBackgroundObject ? bc.getBackgroundObject() : bc.getBackground()); }, null);
            item.fontColor = safe(function () { return hexOf(bc.getFontColorObject ? bc.getFontColorObject() : bc.getFontColor()); }, null);
            item.bold = safe(function () { return bc.getBold(); }, null);
          }
        } catch (e5) {}
        cf.push(item);
      });
    } catch (e6) {}
    out.conditionalFormats = cf;
    // Tab 色
    out.tabColor = safe(function () { return sh.getTabColorObject() ? sh.getTabColorObject().getRgbColor() : null; }, null);
    return JSON.stringify(out);
  } catch (err) {
    return JSON.stringify({ ok: false, error: String((err && err.message) || err) });
  }
}

/**
 * V4.3.78 写格式管道（哑管道）—— patchCells 只写值，本动作补「呈现格式」。
 * 设计意图：所有写格式需求由调用端以 ops 描述，后端不写任何业务逻辑；
 *   与 patchCells 对称：同 ssid/sheet 约定，同 ranges 风格。
 * 支持 ops（每项独立 try，任一失败即中止并报告执行到第几项）：
 *   setText      {r1,c1,r2,c2,values:[[..]]}   先把区域设为文本格式(@)再写值——避开 "06/01" 被自动转日期
 *   numberFormat {r1,c1,r2,c2,format:'@'|'mm/dd'|'0.###############'}
 *   background   {r1,c1,r2,c2,color:'#f4cccc'}
 *   fontColor    {r1,c1,r2,c2,color:'#cc0000'}
 *   bold         {r1,c1,r2,c2,value:true|false}
 *   fontSize     {r1,c1,r2,c2,size:10}
 *   fontFamily   {r1,c1,r2,c2,family:'Arial'}
 *   hAlign       {r1,c1,r2,c2,align:'left'|'right'|'center'}
 *   note         {r1,c1,r2,c2,text:'..'}        整区域同一浮窗文本（单格用 r1==r2&&c1==c2）
 *   colWidth     {col,width}                   单列宽
 *   colWidths    {col1,widths:[..]}            从 col1 起批量列宽
 *   rowHeight    {row,height}
 *   rowHeights   {row1,heights:[..]}
 *   freeze       {rows,cols}
 *   cfAppend     {ranges:[{r1,c1,r2,c2}],criteria:'NUMBER_LESS_THAN',args:[8],bg:'#f4cccc',fontColor:'#cc0000',bold:false}
 *                读现有规则→追加一条→整体写回（不覆盖已有规则）
 * 护栏：ops≤300；单 op 区域≤20000 格；dry=1 只回计划不执行；每次执行写 _TS_WRITE_LOG 审计。
 * 用法：POST body {"action":"applyFormat","token":"...","ssid":"...","sheet":"...","dry":0,"ops":[...]}
 */
function tsApplyFormat(e) {
  e = e || {};
  var p = e.parameter || {};
  var body = e.postBody || {};
  var dry = ['1', 'true', 'TRUE', 'yes'].indexOf(String(p.dry || body.dry || '')) >= 0;
  var ssid = String(p.ssid || body.ssid || TS_ID);
  var sheetName = String(p.sheet || body.sheet || '').trim();
  var ops = body.ops || p.ops || [];
  if (typeof ops === 'string') { try { ops = JSON.parse(ops); } catch (e0) { ops = []; } }
  if (!sheetName) return JSON.stringify({ ok: false, error: 'missing sheet name' });
  if (!ops || !ops.length) return JSON.stringify({ ok: false, error: 'no ops' });
  if (ops.length > 300) return JSON.stringify({ ok: false, error: 'too many ops: ' + ops.length });
  var MAX_CELLS = 20000;
  // 预检：区域合法性 + 规模上限
  for (var i = 0; i < ops.length; i++) {
    var op = ops[i] || {};
    if (op.r1 != null) {
      var r1 = Math.floor(+op.r1), c1 = Math.floor(+op.c1), r2 = Math.floor(+op.r2 || op.r1), c2 = Math.floor(+op.c2 || op.c1);
      if (!(r1 >= 1 && c1 >= 1 && r2 >= r1 && c2 >= c1)) return JSON.stringify({ ok: false, error: 'op#' + i + ' 非法区域', op: op.type });
      if ((r2 - r1 + 1) * (c2 - c1 + 1) > MAX_CELLS) return JSON.stringify({ ok: false, error: 'op#' + i + ' 区域超上限 ' + MAX_CELLS, op: op.type });
    }
  }
  if (dry) {
    var plan = ops.map(function (op, idx) {
      var d = { i: idx, type: op.type };
      if (op.r1 != null) d.area = [op.r1, op.c1, op.r2 || op.r1, op.c2 || op.c1];
      if (op.type === 'setText') d.cells = (op.values || []).reduce(function (n, row) { return n + row.length; }, 0);
      return d;
    });
    return JSON.stringify({ ok: true, dry: true, ssid: ssid, sheet: sheetName, opCount: ops.length, plan: plan });
  }
  try {
    var ss = SpreadsheetApp.openById(ssid);
    var sh = ss.getSheetByName(sheetName);
    if (!sh) return JSON.stringify({ ok: false, error: 'sheet not found: ' + sheetName });
    var done = 0;
    for (var j = 0; j < ops.length; j++) {
      var o = ops[j] || {};
      var type = String(o.type || '');
      var r1 = o.r1 != null ? Math.floor(+o.r1) : null, c1 = o.c1 != null ? Math.floor(+o.c1) : null;
      var r2 = o.r2 != null ? Math.floor(+o.r2) : r1, c2 = o.c2 != null ? Math.floor(+o.c2) : c1;
      if (type === 'setText') {
        var rg = sh.getRange(r1, c1, r2 - r1 + 1, c2 - c1 + 1);
        rg.setNumberFormat('@');
        rg.setValues(o.values || []);
      } else if (type === 'numberFormat') {
        sh.getRange(r1, c1, r2 - r1 + 1, c2 - c1 + 1).setNumberFormat(String(o.format || '@'));
      } else if (type === 'background') {
        sh.getRange(r1, c1, r2 - r1 + 1, c2 - c1 + 1).setBackground(String(o.color || '#ffffff'));
      } else if (type === 'fontColor') {
        sh.getRange(r1, c1, r2 - r1 + 1, c2 - c1 + 1).setFontColor(String(o.color || '#000000'));
      } else if (type === 'bold') {
        sh.getRange(r1, c1, r2 - r1 + 1, c2 - c1 + 1).setFontWeight(o.value === false ? 'normal' : 'bold');
      } else if (type === 'fontSize') {
        sh.getRange(r1, c1, r2 - r1 + 1, c2 - c1 + 1).setFontSize(Math.floor(+o.size || 10));
      } else if (type === 'fontFamily') {
        sh.getRange(r1, c1, r2 - r1 + 1, c2 - c1 + 1).setFontFamily(String(o.family || 'Arial'));
      } else if (type === 'hAlign') {
        sh.getRange(r1, c1, r2 - r1 + 1, c2 - c1 + 1).setHorizontalAlignment(String(o.align || 'left'));
      } else if (type === 'note') {
        sh.getRange(r1, c1, r2 - r1 + 1, c2 - c1 + 1).setNote(String(o.text == null ? '' : o.text));
      } else if (type === 'colWidth') {
        sh.setColumnWidth(Math.floor(+o.col), Math.floor(+o.width));
      } else if (type === 'colWidths') {
        var ws = o.widths || [];
        for (var w = 0; w < ws.length; w++) sh.setColumnWidth(Math.floor(+o.col1) + w, Math.floor(+ws[w]));
      } else if (type === 'rowHeight') {
        sh.setRowHeight(Math.floor(+o.row), Math.floor(+o.height));
      } else if (type === 'rowHeights') {
        var hs = o.heights || [];
        for (var h = 0; h < hs.length; h++) sh.setRowHeight(Math.floor(+o.row1) + h, Math.floor(+hs[h]));
      } else if (type === 'freeze') {
        sh.setFrozenRows(Math.floor(+o.rows || 0));
        sh.setFrozenColumns(Math.floor(+o.cols || 0));
      } else if (type === 'cfAppend') {
        var rules = sh.getConditionalFormatRules();
        var args = o.args || [];
        var rl = [];
        (o.ranges || []).forEach(function (rr) { rl.push(sh.getRange(rr.r1, rr.c1, (rr.r2 || rr.r1) - rr.r1 + 1, (rr.c2 || rr.c1) - rr.c1 + 1)); });
        var finalRule = SpreadsheetApp.newConditionalFormatRule().setRanges(rl).whenNumberLessThan(args[0] == null ? 8 : args[0]);
        if (o.bg) finalRule = finalRule.setBackground(String(o.bg));
        if (o.fontColor) finalRule = finalRule.setFontColor(String(o.fontColor));
        if (o.bold) finalRule = finalRule.setBold(true);
        rules.push(finalRule);
        sh.setConditionalFormatRules(rules);
      } else {
        return JSON.stringify({ ok: false, error: 'op#' + j + ' 未知类型 ' + type, executed: done });
      }
      done++;
    }
    _tsWriteLog('applyFormat', 'ss=' + ssid + ' sheet=' + sheetName + ' ops=' + ops.length);
    return JSON.stringify({ ok: true, ssid: ss.getId(), sheet: sheetName, executed: done });
  } catch (err) {
    return JSON.stringify({ ok: false, error: String((err && err.message) || err), executed: done });
  }
}

/**
 * V4.3.65 列出周存档文件夹里的备份文件（只读，不写任何东西）。
 * 用法：?action=driveList&token=...   可选 &folder=<folderId>（默认周存档文件夹）
 * 返回 [{name, id, created}]，配合 readRange&ssid=... 就能读任意一份历史备份。
 */
function tsDriveList(e) {
  e = e || {};
  var p = e.parameter || {};
  var fid = String(p.folder || ARCHIVE_FOLDER_ID);
  try {
    var it = DriveApp.getFolderById(fid).getFiles();
    var out = [];
    while (it.hasNext() && out.length < 100) {
      var f = it.next();
      out.push({ name: f.getName(), id: f.getId(),
                 created: Utilities.formatDate(f.getDateCreated(), 'GMT+8', 'yyyy-MM-dd HH:mm') });
    }
    out.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
    return JSON.stringify({ ok: true, folder: fid, count: out.length, files: out });
  } catch (err) {
    return JSON.stringify({ ok: false, error: String((err && err.message) || err) });
  }
}

/** 最小探针：确认 clasp run（Apps Script API）能执行，且不触碰任何表格。 */
function tsPing() {
  return JSON.stringify({ ok: true, pong: true, ts: Utilities.formatDate(new Date(), 'GMT+8', 'yyyy-MM-dd HH:mm:ss') });
}

/**
 * 远程只读体检 — 按 (姓名,日期) 分组统计请假行，输出重复组 + 可选按人明细。
 * 供自治 Agent 远程调：?action=checkLeaves&token=...  可选 &name=lucia
 * 返回 JSON 串（dispatcher 把它包进 result.message，调用端 JSON.parse 一次）。
 */
function tsCheckLeaves(e) {
  e = e || {};
  var nameFilter = String((e.parameter && e.parameter.name) || (e.parameter && e.parameter.q) || "").trim().toLowerCase();
  var sheet = getDbSheet();
  var data = sheet.getDataRange().getValues();
  var groups = {};
  var detail = [];
  var totalLeave = 0;
  for (var i = 1; i < data.length; i++) {
    var nm = String(data[i][2] || '').trim();
    if (!nm) continue;
    var type = String(data[i][3] || '').trim();
    var f = String(data[i][5] || '').trim();
    var h = String(data[i][7] || '') + ' ' + String(data[i][6] || '') + ' ' + String(data[i][8] || '');
    var isLeave = /(系统同步请假|LEAVE-)/i.test(h) || /^(休假|OFF-WORK)$/i.test(type) || /^OFF-WORK$/i.test(f);
    if (!isLeave) continue;
    totalLeave++;
    var b = data[i][1];
    var ds = (b instanceof Date) ? Utilities.formatDate(b, 'GMT+8', 'yyyy-MM-dd') : String(b || '').substring(0, 10);
    var key = nm + '|' + ds;
    groups[key] = (groups[key] || 0) + 1;
    if (nameFilter && nm.toLowerCase().indexOf(nameFilter) >= 0) {
      detail.push({ row: i + 1, date: ds, type: type, hours: data[i][6], note: String(data[i][7] || '').substring(0, 60) });
    }
  }
  var dups = [];
  for (var k in groups) {
    if (groups[k] > 1) {
      var p = k.split('|');
      dups.push({ name: p[0], date: p[1], count: groups[k] });
    }
  }
  dups.sort(function (a, b) { return b.count - a.count; });
  return JSON.stringify({
    ok: true, action: 'checkLeaves',
    nameFilter: nameFilter || '(all)',
    totalLeaveRows: totalLeave,
    leaveGroups: Object.keys(groups).length,
    duplicateGroups: dups.length,
    duplicates: dups.slice(0, 200),
    detail: detail
  });
}

// ============================================================
// V4.3.72 【只读 · 请假日历核对】
// 直接读 China Employee - Leave Calendar，返回指定月份/姓名的休假事件列表。
// 只读，不写任何库；供本地脚本核对「表里请假行 vs 日历真值」。
// 用法：?action=probeCalendar&month=2026-08&name=allen  （name 留空=全部）
// ============================================================
function tsProbeCalendar(e) {
  e = e || {};
  var p = e.parameter || {};
  var month = String(p.month || '').trim();
  var nameFilter = String(p.name || '').trim().toLowerCase();
  var CAL_ID = 'c_b9432c84c439fafa5948d1e7ae7eed3eb43aa6781340d326c151e1452661ea57@group.calendar.google.com';
  try {
    var cal = CalendarApp.getCalendarById(CAL_ID);
    if (!cal) return JSON.stringify({ ok: false, error: '日历为null(无访问权)', calId: CAL_ID });
    // 诊断：宽窗口 2026-07-01 ~ 2026-09-30，确认 Web App 上下文能否读日历
    var probeStart = new Date(2026, 6, 1);
    var probeEnd = new Date(2026, 9, 0, 23, 59, 59);
    var allEvs = cal.getEvents(probeStart, probeEnd);
    var out = [];
    allEvs.forEach(function (ev) {
      var t = String(ev.getTitle() || '').trim();
      if (nameFilter && t.toLowerCase().indexOf(nameFilter) < 0) return;
      if (month && String(_lsFmt(ev.getStartTime())).indexOf(month) < 0) return;
      out.push({ title: t, start: _lsFmt(ev.getStartTime()), allDay: ev.isAllDayEvent() });
    });
    return JSON.stringify({
      ok: true, action: 'probeCalendar',
      calName: cal.getName(), calId: cal.getId(),
      totalAll: allEvs.length,
      nameFilter: nameFilter || '(all)', month: month || '(all)',
      count: out.length, events: out.slice(0, 80)
    });
  } catch (err) {
    return JSON.stringify({ ok: false, error: err.message, calId: CAL_ID });
  }
}

// ============================================================
// V4.3.63 【表格膨胀自愈】删除 DB_工时流水 尾部的空白行
// 背景：历史上多次「全表重写 / setValues 到很靠后的行」在表尾留下 19,000+ 空行，
//       让 getMaxRows() 虚高、任何全量读取都变慢，也容易让「最后一行」判断失真。
// 安全：只删 lastRow(有内容的最后一行) 之后的空行，绝不碰有数据的行。
// 用法：?action=trimblank[&dry=1]
// ============================================================
function tsTrimBlank(e) {
  e = e || {};
  var p = e.parameter || {};
  var body = e.postBody || {};
  // V4.3.63a 修正：原来读 e.dry，GAS 事件里查询参数在 e.parameter，导致 dry 永远失效（真删）
  var dry = ['1', 'true', 'TRUE', 'yes'].indexOf(String(p.dry || body.dry || '')) >= 0;
  var sheet = getDbSheet();
  var last = sheet.getLastRow();
  var max = sheet.getMaxRows();
  if (max - last < 50) {
    return JSON.stringify({ ok: true, action: 'trimblank', dry: dry, deleted: 0, lastRow: last, maxRows: max, msg: '无需清理' });
  }
  var n = max - last;
  if (!dry) sheet.deleteRows(last + 1, n);
  return JSON.stringify({
    ok: true, action: 'trimblank', dry: dry,
    deleted: dry ? 0 : n,          // dry 时实际删除 0 行
    wouldDelete: n,
    lastRow: last, maxRows: max,
    msg: (dry ? '【dry-run】将删除' : '已删除') + ' 第 ' + (last + 1) + ' ~ ' + max + ' 行（共 ' + n + ' 行空白）'
  });
}

// ============================================================
// V4.3.63 【连点重复提交体检】
// 同一人 + 同业务日期 + 同项目 + 同工时 + 同备注，且录入时间跨度 <= 2 小时 → 判为连点重复。
// 返回 dry 版清单；?action=dupreport&fix=1 则把多余份软删（O=TRUE，可恢复）。
// ============================================================
function tsDupReport(e) {
  e = e || {};
  var fix = String(e.parameter.fix || '') === '1';
  var windowMs = 2 * 60 * 60 * 1000;
  var sheet = getDbSheet();
  var data = sheet.getDataRange().getValues();
  var groups = {};
  for (var i = 1; i < data.length; i++) {
    var dv = data[i][14];
    if (dv === true || String(dv).toUpperCase() === 'TRUE') continue;
    var nm = String(data[i][2] || '').trim();
    var bd = data[i][1];
    if (!nm || !bd) continue;
    var pid = String(data[i][5] || '').trim();
    if (/OFF[-_]?WORK/i.test(pid)) continue;
    var ds = (bd instanceof Date) ? Utilities.formatDate(bd, 'GMT+8', 'yyyy-MM-dd') : String(bd).substring(0, 10);
    var hrs = Number(parseFloat(data[i][6]) || 0).toFixed(2);
    var k = nm + '|' + ds + '|' + pid + '|' + hrs + '|' + String(data[i][7] || '').trim().substring(0, 30);
    if (!groups[k]) groups[k] = [];
    var t = (data[i][0] instanceof Date) ? data[i][0].getTime() : new Date(data[i][0]).getTime();
    groups[k].push({ row: i + 1, t: t });
  }
  var kill = [];
  var grpOut = [];
  for (var key in groups) {
    var arr = groups[key];
    if (arr.length < 2) continue;
    var ok = true, minT = Infinity, maxT = -Infinity;
    arr.forEach(function (x) { if (!x.t) ok = false; if (x.t < minT) minT = x.t; if (x.t > maxT) maxT = x.t; });
    if (!ok || (maxT - minT) > windowMs) continue;
    arr.sort(function (a, b) { return a.t - b.t; });
    for (var j = 1; j < arr.length; j++) kill.push(arr[j].row);
    grpOut.push({ key: key, count: arr.length, spanMin: Math.round((maxT - minT) / 60000) });
  }
  grpOut.sort(function (a, b) { return b.count - a.count; });
  // [A0d][Tom Q8] fix=1 默认拒绝。2 小时窗口口径不适用于本批跨天跨月候选，
  // 且自动软标属生产写入。保留只读报告能力；写入须走 _tsGuardedCleanup + CAS。
  if (fix) {
    return JSON.stringify({ ok: false, error: 'DUP_FIX_DISABLED',
                            reason: '两小时窗口口径与本次跨天跨月候选不匹配；自动软标已禁用',
                            hint: '如需清理，请走 purgeRows 并附 {uuid,payloadHash} CAS 清单',
                            duplicateGroups: grpOut.length, extraRows: kill.length,
                            rows: kill.slice(0, 500) });
  }
    return JSON.stringify({
      ok: true, action: 'dupreport', fixed: fix ? kill.length : 0,
      duplicateGroups: grpOut.length, extraRows: kill.length,
      groups: grpOut.slice(0, 100),
      rows: kill.slice(0, 500)
    });
  }

/**
 * V4.3.68 【物理清掉已软删的重复假条行】
 * 背景：cleanupDuplicateLeavesInternal 在生成月视图时会把「同一人+同天」的重复请假行软删(O=TRUE)，
 *       历史累计了 1,900+ 条已软删假条残留在 DB_工时流水里 —— 不进任何逻辑，但占行、看着乱。
 * 做法（与 syncLeavesFromCalendar 同一套已验证的安全模式）：读全部 → 保留「非(软删且请假)」的行
 *       → 先 setValues 写回保留行 → 再 deleteRows 删尾部多余行。先写回再删尾，中途失败原数据仍在。
 * 护栏：只删「已软删 AND 请假行」两类同时命中，绝不碰有效行；?dry=1 先报会删多少。
 */
/**
 * V4.3.71 日期护栏（事故级修复）
 * 背景：9/12 一次 purgeRows 的「读全表 → 过滤 → setValues 整表写回 → deleteRows 删尾」把
 *       2,055 行的 B 列业务日期改坏（9 月的行被搬到 8/7/6/5/4 月），事后靠回滚才救回。
 * 机制：写回前按 UUID 存一份 B 列原值快照；写回后立即回读 B 列，凡与原值不符就地改回。
 * 这样无论底层是时区/格式/列宽哪种原因，都不会再静默改坏业务日期。
 */
function _tsDateKey(v) {
  try {
    if (v instanceof Date && !isNaN(v.getTime())) {
      return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    }
  } catch (err) { /* fall through */ }
  var s = String((v === null || v === undefined) ? '' : v).trim();
  var m = s.match(/(20\d{2})[-\/年.](\d{1,2})[-\/日.]?(\d{1,2})?/);
  if (m) {
    return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + (m[3] || '1')).slice(-2);
  }
  return s;
}

/**
 * 受保护的整表写回：setValues 之后自动校验并还原 B 列。
 * @param {Sheet} sh
 * @param {Array[]} retained 保留行（含表头）
 * @param {Array[]} dataBefore 写回前的原始全表（含表头，用于取 B 列原值）
 * @return {number} 被自动还原的格数
 */
function _tsSetValuesGuarded(sh, retained, dataBefore) {
  if (!retained.length) return 0;
  var w = retained[0].length;
  for (var i = 0; i < retained.length; i++) {
    while (retained[i].length < w) retained[i].push('');
    if (retained[i].length > w) retained[i] = retained[i].slice(0, w);
  }
  var bBefore = {};
  for (var j = 1; j < dataBefore.length; j++) {
    var u = String(dataBefore[j][8] === null || dataBefore[j][8] === undefined ? '' : dataBefore[j][8]);
    if (u && !bBefore.hasOwnProperty(u)) bBefore[u] = dataBefore[j][1];
  }
  sh.getRange(1, 1, retained.length, w).setValues(retained);

  var n = retained.length;
  if (n < 2) return 0;
  var afterB = sh.getRange(2, 2, n - 1, 1).getValues();
  var afterU = sh.getRange(2, 9, n - 1, 1).getValues();
  var fixed = 0;
  for (var r = 0; r < afterB.length; r++) {
    var u2 = String(afterU[r][0] === null || afterU[r][0] === undefined ? '' : afterU[r][0]);
    if (!u2 || !bBefore.hasOwnProperty(u2)) continue;
    if (_tsDateKey(afterB[r][0]) !== _tsDateKey(bBefore[u2])) {
      sh.getRange(r + 2, 2).setValue(bBefore[u2]);
      fixed++;
    }
  }
  return fixed;
}

function tsPurgeSoftLeaves(e) {
  e = e || {};
  var p = e.parameter || {};
  var dry = ['1', 'true', 'TRUE', 'yes'].indexOf(String(p.dry || (e.postBody && e.postBody.dry) || '')) >= 0;
  try {
    var sh = getDbSheet();
    var data = sh.getDataRange().getValues();
    var retained = [];
    var removed = 0;
    for (var i = 0; i < data.length; i++) {
      if (i === 0) { retained.push(data[i]); continue; }   // 表头
      var dv = data[i][14];
      var isDeleted = (dv === true || String(dv).toUpperCase() === 'TRUE');
      if (isDeleted && _lsIsLeaveRow(data[i])) { removed++; continue; }
      retained.push(data[i]);
    }
    if (dry) {
      return JSON.stringify({ ok: true, dry: true, action: 'purgeSoftLeaves', removed: removed, wouldKeep: retained.length });
    }
    var dateFixed = 0;
    if (retained.length > 1) {
      dateFixed = _tsSetValuesGuarded(sh, retained, data);
    }
    var last = sh.getLastRow();
    if (last > retained.length) sh.deleteRows(retained.length + 1, last - retained.length);
    return JSON.stringify({ ok: true, dry: false, action: 'purgeSoftLeaves', removed: removed, kept: retained.length, dateFixed: dateFixed });
  } catch (err) {
    return JSON.stringify({ ok: false, error: String((err && err.message) || err) });
  }
}

/**
 * V4.3.69 purgeRows —— 物理删除「指定 UUID 集合」或「软删行」，沿用 tsPurgeSoftLeaves 的
 * 「读保留行 → setValues 写回 → deleteRows 删尾」安全模式（中途失败原数据仍在）。
 * 护栏：仅删 (UUID 在 delUuids 集合) 或 (软删 O=TRUE 且 delSoft=true) 的行；
 *       绝不碰任何非软删、UUID 不在集合的有效行。
 * 入参（POST body）：
 *   uuids: string[]  —— 要删的 UUID 集合（本场景全是 TS-R 注入行）
 *   soft:  bool      —— true 时额外删所有软删(O=TRUE)行
 *   dry:   1/true    —— 先报会删多少，不真删
 */
function tsPurgeRows(e) {
  e = e || {};
  var p = e.parameter || {};
  var body = (e.postBody && typeof e.postBody === 'object') ? e.postBody : {};
  var dry = ['1', 'true', 'TRUE', 'yes'].indexOf(String(p.dry || body.dry || '')) >= 0;
  var delUuids = (body.uuids && body.uuids.length) ? body.uuids : [];
  var delSoft = ['1', 'true', 'TRUE', 'yes'].indexOf(String(body.soft || p.soft || '')) >= 0;
  try {
    var sh = getDbSheet();
    var data = sh.getDataRange().getValues();
    var retained = [];
    var removed = 0;
    for (var i = 0; i < data.length; i++) {
      if (i === 0) { retained.push(data[i]); continue; }   // 表头
      var uid = data[i][8];                                 // I 列 UUID
      var dv = data[i][14];                                 // O 列软删
      var isSoft = (dv === true || String(dv).toUpperCase() === 'TRUE');
      var del = false;
      if (delUuids.length && delUuids.indexOf(String(uid)) >= 0) del = true;
      if (delSoft && isSoft) del = true;
      if (del) { removed++; continue; }
      retained.push(data[i]);
    }
    if (dry) {
      return JSON.stringify({ ok: true, dry: true, action: 'purgeRows', removed: removed, wouldKeep: retained.length });
    }
    var dateFixed = 0;
    if (retained.length > 1) {
      dateFixed = _tsSetValuesGuarded(sh, retained, data);
    }
    var last = sh.getLastRow();
    if (last > retained.length) sh.deleteRows(retained.length + 1, last - retained.length);
    return JSON.stringify({ ok: true, dry: false, action: 'purgeRows', removed: removed, kept: retained.length, dateFixed: dateFixed });
  } catch (err) {
    return JSON.stringify({ ok: false, error: String((err && err.message) || err) });
  }
}

// ============================================================
// V4.3.81 重设条件格式（全量替换）—— 修 cfAppend 只能造 LESS_THAN 的缺陷。
// 🔴 护栏：只允许操作主库 SSID，拒绝其他 ssid（尤其生产表 TS_ID），防误伤/越权。
// 用法：POST body {"action":"masterCondFormat","token":"...","sheet":"月度异常","rules":[
//   {"ranges":[{"r1":2,"c1":2,"r2":14,"c2":18}],"op":"gt","args":[12],"bg":"#f4cccc","fontColor":"#cc0000"}]}
//   op ∈ gt|gte|lt|lte|eq|neq|between ; rules 为空数组 = 清空该 sheet 全部条件格式规则。
// ============================================================
function tsSetCondFormat(e) {
  e = e || {};
  var p = e.parameter || {};
  var body = e.postBody || {};
  var ssid = String(body.ssid || p.ssid || '');
  var sheetName = String(body.sheet || p.sheet || '').trim();
  var _GUARD_MASTER = '1oxPj0mzN8poP2vQ7Bm-YKXuU49p9b0c1asyrZn4Py44';
  if (ssid !== _GUARD_MASTER) return JSON.stringify({ ok: false, error: 'guard: only MASTER ssid allowed' });
  if (!sheetName) return JSON.stringify({ ok: false, error: 'missing sheet name' });
  var rules = body.rules;
  if (typeof rules === 'string') { try { rules = JSON.parse(rules); } catch (e0) { rules = null; } }
  if (!Array.isArray(rules)) return JSON.stringify({ ok: false, error: 'rules must be an array' });
  try {
    var ss = SpreadsheetApp.openById(ssid);
    var sh = ss.getSheetByName(sheetName);
    if (!sh) return JSON.stringify({ ok: false, error: 'sheet not found: ' + sheetName });
    var out = [];
    rules.forEach(function (rule) {
      var rl = [];
      (rule.ranges || []).forEach(function (rr) {
        rl.push(sh.getRange(rr.r1, rr.c1, (rr.r2 || rr.r1) - rr.r1 + 1, (rr.c2 || rr.c1) - rr.c1 + 1));
      });
      var cr = SpreadsheetApp.newConditionalFormatRule().setRanges(rl);
      var op = String(rule.op || 'gt');
      var a = rule.args || [];
      if (op === 'gt') cr = cr.whenNumberGreaterThan(a[0]);
      else if (op === 'gte') cr = cr.whenNumberGreaterThanOrEqualTo(a[0]);
      else if (op === 'lt') cr = cr.whenNumberLessThan(a[0]);
      else if (op === 'lte') cr = cr.whenNumberLessThanOrEqualTo(a[0]);
      else if (op === 'eq') cr = cr.whenNumberEqualTo(a[0]);
      else if (op === 'neq') cr = cr.whenNumberNotEqualTo(a[0]);
      else if (op === 'between') cr = cr.whenNumberBetween(a[0], a[1]);
      else return;
      if (rule.bg) cr = cr.setBackground(String(rule.bg));
      if (rule.fontColor) cr = cr.setFontColor(String(rule.fontColor));
      if (rule.bold) cr = cr.setBold(true);
      out.push(cr);
    });
    sh.setConditionalFormatRules(out);
    _tsWriteLog('masterCondFormat', 'ss=' + ssid + ' sheet=' + sheetName + ' rules=' + out.length);
    return JSON.stringify({ ok: true, ssid: ss.getId(), sheet: sheetName, rulesSet: out.length });
  } catch (err) {
    return JSON.stringify({ ok: false, error: String((err && err.message) || err) });
  }
}
// V4.3.82 本机自动任务失败告警 → 邮件到 Rita QQ 邮箱
// 调用：POST {"action":"alert","token":"...","task":"泛微同步","level":"FAIL|TEST|WARN","msg":"错误摘要"}
// 红线：只发信，不读/不写任何表格数据；token 由 RemoteTrigger 统一门控。
function tsSendAlert(e) {
  try {
    var p = (e && e.parameter) || {};
    var task = String(p.task || '未命名任务').slice(0, 80);
    var level = String(p.level || 'FAIL').toUpperCase().slice(0, 10);
    var msg = String(p.msg || '(无详细内容，请人工核查)').slice(0, 4000);
    var now = Utilities.formatDate(new Date(), 'Asia/Shanghai', 'yyyy-MM-dd HH:mm');
    var isTest = (level === 'TEST');
    var subj = (isTest ? '【SMCN 测试】' : '【SMCN 告警】') + task + ' ' +
               (isTest ? '通道测试' : '失败') + '（' + now + '）';
    var body = [
      '哪个任务：' + task,
      '什么时候：' + now + '（北京时间）',
      isTest
        ? '说明：这是一封测试邮件，用来确认告警通道可用。系统本身没有故障。'
        : '出了什么事：' + msg,
      '',
      isTest
        ? '看到这封邮件＝真出事时你也能收到。'
        : '怎么办：把这封邮件转发给我（AI），我来处理；你不需要做任何操作。',
      '—— SMCN ERP 自动告警'
    ].join('\n');
    MailApp.sendEmail('ritajin.muraya@qq.com', subj, body);
    return JSON.stringify({ ok: true, sent: subj });
  } catch (err) {
    return JSON.stringify({ ok: false, error: String((err && err.message) || err) });
  }
}

// ============================================================
// repairLegacyLeave — V4.3.83 软删指定行的「遗留活跃请假」标记（GET 可触发，零物理删除）
// ------------------------------------------------------------
// 背景：DB_工时流水 里有一批「类型=休假 / 项目编号=OFF-WORK / 备注=系统同步请假 / UUID=LEAVE-」
//   且尚未软删的历史行（主库已有对应=重复，或早于锁阈值=噪音）。主库是请假权威源，
//   这些生产表重复/噪音行应在 period-lock 上线前清掉，但只能用【软删】——打 O/P/Q 标记，绝物理删。
// 调用（GET，受 REMOTE_TOKEN 门控，与 status 同机制）：
//   软删：?action=repairLegacyLeave&token=<REMOTE_TOKEN>&rows=6795,6796,...,11244[&sheet=DB_工时流水][&ssid=<id>][&op=Rita Jin][&dry=1]
//   撤销：&mode=undo  —— 清空 O/P/Q 三列（恢复软删前状态），用于回滚。
// 安全：幂等——软删模式跳过 O 已 TRUE 的行；撤销模式跳过 O 已空的行；script lock 防并发；_TS_WRITE_LOG 留痕。
// 返回：{ok, dry, mode, requested, done, skipped, ssid, sheet}
// ============================================================
function repairLegacyLeave(e) {
  e = e || {};
  var p = e.parameter || {};
  var dry = ['1', 'true', 'TRUE', 'yes'].indexOf(String(p.dry || '')) >= 0;
  var undo = String(p.mode || '').toLowerCase() === 'undo';
  var rowsRaw = String(p.rows || '').trim();
  if (!rowsRaw) return JSON.stringify({ ok: false, error: 'no rows provided' });
  var rows = rowsRaw.split(/[,\s]+/).map(function (x) { return parseInt(x, 10); })
    .filter(function (x) { return x > 1; });
  if (!rows.length) return JSON.stringify({ ok: false, error: 'no valid rows' });
  var _ssid = String(p.ssid || TS_ID);
  var sheetName = String(p.sheet || 'DB_工时流水');
  var OP = String(p.op || 'Rita Jin');
  try {
    var sh = SpreadsheetApp.openById(_ssid).getSheetByName(sheetName);
    if (!sh) return JSON.stringify({ ok: false, error: 'sheet not found: ' + sheetName });
    var now = new Date();
    var data = sh.getDataRange().getValues();
    var done = 0, skipped = 0;
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      for (var i = 0; i < data.length; i++) {
        var rn = i + 1;
        if (rows.indexOf(rn) < 0) continue;
        var ov = data[i][14];
        if (undo) {
          if (!(ov === true || String(ov).toUpperCase() === 'TRUE')) { skipped++; continue; }
          if (dry) { done++; continue; }
          sh.getRange(rn, 15, 1, 3).setValues([['', '', '']]);  // 恢复：清空 O/P/Q
          done++;
        } else {
          if (ov === true || String(ov).toUpperCase() === 'TRUE') { skipped++; continue; }
          if (dry) { done++; continue; }
          sh.getRange(rn, 15, 1, 3).setValues([[true, OP, now]]);
          done++;
        }
      }
    } finally { lock.releaseLock(); }
    var tag = (undo ? 'undo' : 'repair') + (dry ? '(dry)' : '');
    _tsWriteLog('repairLegacyLeave:' + tag, 'ss=' + _ssid + ' sheet=' + sheetName + ' rows=' + rows.length + ' done=' + done + ' skipped=' + skipped);
    return JSON.stringify({ ok: true, dry: dry, mode: undo ? 'undo' : 'repair', requested: rows.length, done: done, skipped: skipped, ssid: SpreadsheetApp.openById(_ssid).getId(), sheet: sheetName });
  } catch (err) {
    return JSON.stringify({ ok: false, error: String((err && err.message) || err) });
  }
}

// ============================================================
// setupPeriodLock — V4.3.84 初始化 period-lock 策略 + 建审计页（GET 可触发，幂等，零业务写）
// ------------------------------------------------------------
// 仅做两件事：
//   ① _plSetPolicy(true, true, 'rita-deploy') 写 PERIOD_LOCK_STATE（closed=true, futureOpen=true, cutoff=2026-10-01）
//   ② 确保 _TS_WRITE_LOG 页签存在（_tsWriteLog 内部自动建表，仅追加一行初始化标记，不碰业务数据）
// 调用：?action=setupPeriodLock&token=<REMOTE_TOKEN>
// 返回：{ok, policy, logSheetExists}
// 安全：幂等——重复调用只是重写相同策略 + 追加一行日志；不修改任何工时业务行。
// ============================================================
function setupPeriodLock(e) {
  e = e || {};
  try {
    _plSetPolicy(true, true, 'rita-deploy');
    _tsWriteLog('setup', 'period-lock initialized (closed=true, futureOpen=true, cutoff=2026-10-01) by rita-deploy');
    var policy = _plPolicy();
    var ss = SpreadsheetApp.openById(TS_ID);
    var logSheet = ss.getSheetByName('_TS_WRITE_LOG');
    return JSON.stringify({ ok: true, policy: policy, logSheetExists: !!logSheet });
  } catch (err) {
    return JSON.stringify({ ok: false, error: String((err && err.message) || err) });
  }
}

// ============================================================
// plVerifyHash — V4.3.85 只读诊断：实证 _plRowContentHash 在生产工程上下文可用（Stage 2 读路径）
// ------------------------------------------------------------
// 背景：Stage 2 给 getDashboardData/getDetailLogsByMonth 加了 rowHash 下发，该函数
//   位于 PeriodLockGuard.js。若调用有误，明早填报/看板页会直接崩——必须实证而非推断。
// 行为：读 DB_工时流水 前 N 行（A:O 15 列），逐行算 _plRowContentHash，返回统计。
//   nullCount = 含 \u0001 分隔符、无法无歧义定版的行数（这类行前端须禁编辑）。
// 调用：?action=plVerifyHash&token=<REMOTE_TOKEN>[&limit=200]
// 返回：{ok, checked, nullCount, sampleLen}
// 只读：不写任何单元格；不改任何业务数据。
// ============================================================
function plVerifyHash(e) {
  e = e || {};
  var p = e.parameter || {};
  var limit = parseInt(p.limit || '200', 10);
  if (!(limit > 0)) limit = 200;
  try {
    var sh = SpreadsheetApp.openById(TS_ID).getSheetByName('DB_工时流水');
    if (!sh) return JSON.stringify({ ok: false, error: 'sheet not found: DB_工时流水' });
    var last = sh.getLastRow();
    var n = Math.max(0, Math.min(limit, last - 1));
    var data = n > 0 ? sh.getRange(2, 1, n, 15).getValues() : [];
    var nullCount = 0, sampleLen = 0;
    for (var i = 0; i < data.length; i++) {
      var h = _plRowContentHash(data[i]);
      if (h === null) nullCount++;
      else if (sampleLen === 0) sampleLen = String(h).length;
    }
    return JSON.stringify({ ok: true, checked: data.length, nullCount: nullCount,
                            sampleLen: sampleLen, source: 'plVerifyHash' });
  } catch (err) {
    return JSON.stringify({ ok: false, error: String((err && err.message) || err) });
  }
}


// ============================================================
// plGuardTest — V4.3.86 只读诊断：实证 period-lock 期间门禁行为（零写）
// ------------------------------------------------------------
// 用途：不改任何数据，仅用当前策略跑 _plGuardCheck 两次——
//   ① 关账期日期（默认 2026-09-15，早于 cutoff 2026-10-01）→ 预期 ok=false（拒）；
//   ② 未来日期（默认 2026-10-20，晚于 cutoff）→ 预期 ok=true（放行）。
// 用来证明「锁真的按政策拦截过去、放行未来」，而不是仅凭策略值声称。
// 调用：?action=plGuardTest&token=<REMOTE_TOKEN>
// 返回：{ok, policy, pastEdit:{date,ok,reason}, futureInsert:{date,ok,reason}}
// ============================================================
function plGuardTest(e) {
  e = e || {};
  var p = e.parameter || {};
  try {
    var policy = _plPolicy();
    var pastNew = String(p.pastNew || '2026-09-15');
    var pastOrig = String(p.pastOrig || pastNew);
    var futureNew = String(p.futureNew || '2026-10-20');
    var g1 = _plGuardCheck(pastNew, pastOrig, policy);
    var g2 = _plGuardCheck(futureNew, null, policy);
    return JSON.stringify({ ok: true, policy: policy,
      pastEdit: { date: pastNew, ok: !!g1.ok, reason: g1.reason || '' },
      futureInsert: { date: futureNew, ok: !!g2.ok, reason: g2.reason || '' } });
  } catch (err) {
    return JSON.stringify({ ok: false, error: String((err && err.message) || err) });
  }
}

// ---- V4.3.87 软标动作：CAS 在服务端锁内闭合（加固版，回应 Tom 复审）----
// 客户端只负责“提出候选 + 把校验条件一起发来”，真正的判定在锁内用锁内重读的实时值做。
// 加固项（Tom 点2/3/6 + 分阶段方案）：
//  - 期锁：锁内对目标行业务日期跑 _plGuardCheck；锁定期默认拒（PERIOD_LOCKED），仅独立授权 clearance 放行（默认不放开门禁）。
//  - CAS 绑定到已审计原值：请求须携带 target/keeper 规范化 14 列 hash 与 A 级底稿 hash；锁内重读实时 hash 与预期比对，目标+keeper 一起漂移也会因 hash 不符被拒（DRIFT）。
//  - fail-closed：默认 dry（不写，除非显式 dry='0'）；sheet 锁定 PL_DB_SHEET（拒绝调用方覆盖）；结构化校验拒绝 row==keeperRow/重复目标/越界/非法 level/未知字段；timeOnly 严格布尔；部分写后诚实返回 ok=false 并逐行标明。
//  - 批次 journal：返回逐项 {row,ok,wrote,reason}；提供只读状态查询（按 row 回读真实 O）。
// 逻辑与 tools/ts_softdel_core.js 单一可信源保持一致（GAS 端内联副本）。
function _sdNorm(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  var s = String(v).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return String(Number(s));
  return s;
}
function _sdSoftDel(r) {
  return (r === true || String(r || '').toUpperCase() === 'TRUE');
}
// 规范化 hash：对 2..13 列（排除 0=录入时间、1=业务日期两个日期列）做内容指纹。
// 排除日期列：列0 是 timeOnly 允许差异列；列1 是 Date，GAS 原生与 hktool 序列化不同，避免跨格式误判；
// 其正确性由服务端 _plGuardCheck（期锁）与 PAYLOAD_DIFF（目标vs keeper，同格式）兜底。
function _sdNormHash(cells) {
  var s = '';
  for (var c = 2; c <= 13; c++) s += '\x1f' + _sdNorm(cells ? cells[c] : '');
  var h = 5381;
  for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return 'h' + h.toString(16);
}
function _isTrue(v) { return v === true || v === 'true' || v === 1 || v === '1'; }
function _isFalse(v) { return v === false || v === 'false' || v === 0 || v === '0' || v == null; }
var _SD_ROW_KEYS = ['row', 'uuid', 'keeperRow', 'level', 'timeOnly', 'expectHash', 'keeperHash', 'expectBaseHash', 'clearance'];

function _sdBuildMasterMap(msh) {
  var map = {};
  if (!msh) return map;
  var last = msh.getLastRow();
  if (!last) return map;
  var vals = msh.getRange(1, 1, last, 15).getValues();
  for (var r = 0; r < vals.length; r++) {
    var u = _sdNorm(vals[r][8]);
    if (u) { (map[u] = map[u] || []).push({ row: r + 1, cells: vals[r] }); }
  }
  return map;
}
// 历史清理放行：默认 false（不放开门禁）。确需对锁定期行软标，须由 Rita 明确授权单独的 clearance 机制。
function _sdIsClearance(tok) { return false; }

function tsSoftDelGuarded(e) {
  e = e || {};
  var p = e.parameter || {};
  var body = e.postBody || {};
  var rows = body.rows || p.rows || [];
  var dry = true;                                  // fail-closed：默认不写
  var dryExplicit = (p.dry !== undefined) ? p.dry : body.dry;
  if (dryExplicit !== undefined && _isFalse(dryExplicit)) dry = false;
  var batchId = body.batchId || p.batchId || null;
  var sheetName = String(p.sheet || body.sheet || PL_DB_SHEET);
  var MASTER_ID = '1oxPj0mzN8poP2vQ7Bm-YKXuU49p9b0c1asyrZn4Py44';
  var BASE_TAB = '工时_候选0824';

  if (!rows.length) return JSON.stringify({ ok: false, error: 'no rows provided' });
  if (rows.length > 2000) return JSON.stringify({ ok: false, error: 'too many rows: ' + rows.length });
  if (sheetName !== PL_DB_SHEET) {
    return JSON.stringify({ ok: false, error: 'sheet not allowed: ' + sheetName + ' (must be ' + PL_DB_SHEET + ')' });
  }
  // 结构化校验：字段白名单 + 合法值（fail-closed）
  var seenTarget = {};
  for (var z = 0; z < rows.length; z++) {
    var zr = rows[z] || {};
    var unknown = Object.keys(zr).filter(function (k) { return _SD_ROW_KEYS.indexOf(k) < 0; });
    if (unknown.length) return JSON.stringify({ ok: false, error: 'row#' + z + ' unknown fields: ' + unknown.join(',') });
    var zrow = Number(zr.row), zk = Number(zr.keeperRow);
    if (!Number.isInteger(zrow) || zrow < 2) return JSON.stringify({ ok: false, error: 'row#' + z + ' bad row: ' + zr.row });
    if (!Number.isInteger(zk) || zk < 2) return JSON.stringify({ ok: false, error: 'row#' + z + ' bad keeperRow: ' + zr.keeperRow });
    if (!zr.uuid) return JSON.stringify({ ok: false, error: 'row#' + z + ' missing uuid' });
    if (zr.row === zr.keeperRow) return JSON.stringify({ ok: false, error: 'row#' + z + ' row==keeperRow (self-reference)' });
    if (zr.level !== 'A' && zr.level !== 'B') return JSON.stringify({ ok: false, error: 'row#' + z + ' bad level: ' + zr.level });
    if (!zr.expectHash || !zr.keeperHash) return JSON.stringify({ ok: false, error: 'row#' + z + ' missing expectHash/keeperHash' });
    if (zr.level === 'A' && !zr.expectBaseHash) return JSON.stringify({ ok: false, error: 'row#' + z + ' A-level missing expectBaseHash' });
    if (zr.timeOnly != null && !_isTrue(zr.timeOnly) && !_isFalse(zr.timeOnly)) {
      return JSON.stringify({ ok: false, error: 'row#' + z + ' bad timeOnly' });
    }
    if (seenTarget[zrow]) return JSON.stringify({ ok: false, error: 'duplicate target row: ' + zrow });
    seenTarget[zrow] = true;
  }

  var clearanceToken = body.clearance || p.clearance || null;
  var clearanceOk = clearanceToken ? !!_sdIsClearance(clearanceToken) : false;

  try {
    var ss = SpreadsheetApp.openById(TS_ID);
    var sh = ss.getSheetByName(sheetName);
    if (!sh) return JSON.stringify({ ok: false, error: 'sheet not found: ' + sheetName });
    var mss = SpreadsheetApp.openById(MASTER_ID);
    var msh = mss.getSheetByName(BASE_TAB);
    var masterMap = _sdBuildMasterMap(msh);
    var _lock = _plAcquire();
    var results = [], patched = 0, anyFail = false;
    try {
      for (var i = 0; i < rows.length; i++) {
        var it = rows[i] || {};
        var row = Number(it.row), uuid = String(it.uuid || '');
        var keeperRow = Number(it.keeperRow), level = String(it.level || '');
        var timeOnly = _isTrue(it.timeOnly);
        try {
          var vals = sh.getRange(row, 1, 1, 15).getValues()[0];   // 锁内重读
          if (!vals) { results.push({ row: row, ok: false, reason: 'ROW_NOT_FOUND' }); anyFail = true; continue; }
          var kVals = sh.getRange(keeperRow, 1, 1, 15).getValues()[0];

          if (_sdNorm(vals[8]) !== uuid) { results.push({ row: row, ok: false, reason: 'UUID_DRIFT', actual: _sdNorm(vals[8]) }); anyFail = true; continue; }
          if (_sdSoftDel(vals[14])) { results.push({ row: row, ok: false, wrote: false, reason: 'ALREADY_SOFTDEL' }); anyFail = true; continue; }
          if (!kVals || _sdSoftDel(kVals[14])) { results.push({ row: row, ok: false, reason: 'KEEPER_INVALID' }); anyFail = true; continue; }

          // CAS 绑定到已审计原值：实时规范化 hash 必须与请求携带的预期 hash 一致
          var liveHash = _sdNormHash(vals);
          var liveKHash = _sdNormHash(kVals);
          if (liveHash !== it.expectHash) { results.push({ row: row, ok: false, reason: 'TARGET_DRIFT', expect: it.expectHash, actual: liveHash }); anyFail = true; continue; }
          if (liveKHash !== it.keeperHash) { results.push({ row: row, ok: false, reason: 'KEEPER_DRIFT', expect: it.keeperHash, actual: liveKHash }); anyFail = true; continue; }

          var diffs = [];
          for (var c = 0; c <= 13; c++) if (_sdNorm(vals[c]) !== _sdNorm(kVals[c])) diffs.push(c);
          var allowed = timeOnly && diffs.length > 0 && diffs.every(function (x) { return x === 0; });
          if (diffs.length > 0 && !allowed) { results.push({ row: row, ok: false, reason: 'PAYLOAD_DIFF', cols: diffs }); anyFail = true; continue; }

          // 期锁：锁内对目标行业务日期跑 _plGuardCheck；锁定期默认拒，除非独立授权 clearance
          var bizDate = _sdNorm(vals[1]);
          if (typeof _plGuardCheck === 'function') {
            var g = _plGuardCheck(bizDate, null, _plPolicy());
            if (!g.ok && !clearanceOk) { results.push({ row: row, ok: false, reason: 'PERIOD_LOCKED', date: bizDate, detail: g.reason || '' }); anyFail = true; continue; }
          }

          // 等级与底稿核对（A：底稿恰 1 行且 hash/状态相符；B：底稿 0 行）
          if (level === 'A') {
            var mMatches = masterMap[uuid] || [];
            if (mMatches.length !== 1) { results.push({ row: row, ok: false, reason: (mMatches.length === 0 ? 'BASE_NOT_FOUND' : 'BASE_NOT_UNIQUE'), count: mMatches.length }); anyFail = true; continue; }
            var mHash = _sdNormHash(mMatches[0].cells);
            if (mHash !== it.expectBaseHash) { results.push({ row: row, ok: false, reason: 'BASE_DRIFT', expect: it.expectBaseHash, actual: mHash }); anyFail = true; continue; }
          } else {
            var mB = masterMap[uuid] || [];
            if (mB.length !== 0) { results.push({ row: row, ok: false, reason: 'BASE_HAS_MATCH', count: mB.length }); anyFail = true; continue; }
          }

          var wrote = false;
          if (!dry) {
            sh.getRange(row, 15).setValue('TRUE');
            SpreadsheetApp.flush();
            var after = sh.getRange(row, 15).getValue();   // 锁内回读确认
            if (_sdNorm(after) !== 'TRUE') { results.push({ row: row, ok: false, reason: 'WRITE_NOT_CONFIRMED', actual: String(after) }); anyFail = true; continue; }
            wrote = true;
          }
          results.push({ row: row, ok: true, wrote: wrote, level: level });
          if (wrote) patched++;
        } catch (rerr) {
          results.push({ row: row, ok: false, reason: 'ROW_READ_FAIL', error: String(rerr && rerr.message || rerr) });
          anyFail = true;
        }
      }
    } finally {
      try { _lock.releaseLock(); } catch (rl) {}
    }
    // 诚实上报：任一失败 → 批次 ok=false（不暗示原子回滚）
    return JSON.stringify({ ok: !anyFail, batchId: batchId, dry: dry, patched: patched, total: rows.length, results: results });
  } catch (err) {
    return JSON.stringify({ ok: false, error: String(err && err.message || err), patched: 0 });
  }
}
