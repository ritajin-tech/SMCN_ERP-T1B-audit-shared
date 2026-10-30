// ts-manager RemoteActions.gs — SMCN 手机远程触发动作注册
// 配套 RemoteTrigger.gs 使用。本文件【不含 doGet】（Code.js 已有 doGet，返回填报网页），
// 请在 Code.js 的 doGet 首行加：var r = _rtMaybeHandle(e); if (r) return r;
// 👇 部署后的真实 Web App URL（菜单显示用；可随时用 ?action=_seturl&url= 热更新）
var REMOTE_WEBAPP_URL = "<PROD_WEBAPP_URL: 见部署配置（公开仓不内嵌端点）>";
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
  statusQuery:   function(e) { return tsSoftDelGuarded(e); },   // V4.3.87 状态查询：复用同一受控入口（核心内按 action 分流到 tsSoftDelStatus），不另开入口
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

// ============================================================
// A1d-v4 入口绑定：以下为【唯一】的 tsSoftDelGuarded 定义来源。
// 已删除旧实现及其旧 djb2 助手：function _isFalse(, function _isTrue(, function _sdBuildMasterMap(, function _sdIsClearance(, function _sdNorm(, function _sdNormHash(, function _sdSoftDel(, var _SD_ROW_KEYS。
// 本段由 tools/gen_gas_softdel.py 从单一可信源生成，勿手改。
// ============================================================

// ============================================================
// GAS 端 tsSoftDelGuarded —— 由 gen_gas_softdel.py 从单一可信源生成
// 源：ts_softdel_core.js + ts_softdel_norm.js + period_lock_port.js
// 与 Node 模块【逐字一致】的业务逻辑，仅依赖装配（下方 GAS 包装器）不同。
// ============================================================
'use strict';

var norm = (function() {
// ts_softdel_norm.js — 字段规范化 / 类型保全 / SHA-256 指纹（单一可信源）
//
// 设计目标（回应 Tom 2026-10-27 复审，条件 #2/#3/#4）：
//  - 类型保全：绝不把"看起来像数字的字符串"统一 coercion 成数字（否则前导零 ID/工号/备注
//    "007" 会被并成 7，导致哈希误判）。用显式类型标签 num/bool/date/str/null。
//  - 业务日期（列1）纳入指纹，规范为显式时区 ISO（YYYY-MM-DDTHH:mm:ss+08:00）。
//  - 录入时间（列0）默认纳入指纹；仅当显式 timeOnly 时排除出哈希，但仍由调用方分别绑定
//    （expectEntryTime / keeperEntryTime），绝不"放掉"校验。
//  - 审计列 O（列14）纳入指纹，保全原审计版本：预期 O=FALSE（未软标）由哈希约束。
//  - 不使用裸分隔符拼接（避免内容碰撞），改用 JSON 定长数组（自带转义）。
//  - 用 SHA-256（密码学）而非 djb2 32 位弱哈希。
//  - 双环境：Node 走 crypto；GAS 走 Utilities.computeDigest。代码由 v4_genpatches 同文生成，
//    保证 GAS 内联副本与 Node 模块逐字一致（见 harness 的「跨环境一致性」断言）。
//
// 本文件是「单一可信源」：GAS RemoteActions 的对应函数由 v4_genpatches.py 从本文件文本生成，
// 不另写一份逻辑，避免漂移。

'use strict';

// ---- 显式时区 ISO：把 Date / 日期串规范为 GMT+8 墙面时钟 ----
// 约定（与 ts_softdel.js 既有约定一致）：日期串按 UTC 解析后 +8h 再取墙面时钟；
// GAS 原生 Date 用 Utilities.formatDate(...,'GMT+8',...) 得到同一墙面时钟。
function _sdIsoTz(v) {
  var d = null;
  if (v instanceof Date) {
    d = v;
  } else if (typeof v === 'string') {
    var s = v.trim();
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
    if (!m) return null;
    var y = +m[1], mo = +m[2], da = +m[3];
    if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
    var hh = m[4] !== undefined ? +m[4] : 0;
    var mi = m[5] !== undefined ? +m[5] : 0;
    var ss = m[6] !== undefined ? +m[6] : 0;
    if (hh > 23 || mi > 59 || ss > 59) return null;
    d = new Date(Date.UTC(y, mo - 1, da, hh, mi, ss));
  }
  if (!d || isNaN(d.getTime())) return null;
  var t = d.getTime() + 8 * 3600 * 1000;     // 墙面时钟 = 该瞬时的 GMT+8
  var u = new Date(t);
  var p = function (n) { return (n < 10 ? '0' + n : '' + n); };
  return u.getUTCFullYear() + '-' + p(u.getUTCMonth() + 1) + '-' + p(u.getUTCDate()) +
    'T' + p(u.getUTCHours()) + ':' + p(u.getUTCMinutes()) + ':' + p(u.getUTCSeconds()) + '+08:00';
}

// ---- 类型保全 token：绝不把数字串 coercion 成数字 ----
function _sdCellTok(v) {
  if (v === null || v === undefined) return ['null'];
  if (typeof v === 'number') return ['num', String(v)];
  if (typeof v === 'boolean') return ['bool', v ? 'true' : 'false'];
  // GAS 原生 Date —— 规范为显式时区 ISO
  if (typeof v === 'object' && typeof v.getFullYear === 'function') {
    var iso = _sdIsoTz(v);
    return iso ? ['date', iso] : ['null'];
  }
  // 字符串：逐字保留（含前导零 ID/工号/备注），不做任何数字 coercion
  return ['str', String(v)];
}

// ---- 纳入指纹的列：timeOnly 时排除录入时间列0，但仍由调用方绑定 ----
function _sdHashCols(timeOnly) {
  var cols = [1];                       // 业务日期（列1，显式时区 ISO）
  for (var c = 2; c <= 13; c++) cols.push(c);  // 负载列 2..13
  if (!timeOnly) cols.push(0);          // 录入时间（列0）：仅非 timeOnly 纳入哈希
  cols.push(14);                        // 审计列 O（列14）：保全原审计版本
  return cols;
}

// ---- 定长 JSON 数组（自带转义，避免裸分隔符碰撞）----
function _sdCanonRow(cells, cols) {
  var arr = [];
  for (var i = 0; i < cols.length; i++) {
    arr.push(_sdCellTok(cells ? cells[cols[i]] : undefined));
  }
  return JSON.stringify(arr);
}

// ---- SHA-256：双环境 ----
function _sdSha256(s) {
  if (typeof Utilities !== 'undefined') {
    var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
    var hex = '';
    for (var i = 0; i < bytes.length; i++) {
      var b = (bytes[i] < 0) ? (bytes[i] + 256) : bytes[i];
      hex += (b < 16 ? '0' : '') + b.toString(16);
    }
    return 'sha256:' + hex;
  }
  // Node
  var crypto = require('crypto');
  return 'sha256:' + crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

// ---- 行指纹 ----
function _sdRowHash(cells, timeOnly) {
  return _sdSha256(_sdCanonRow(cells, _sdHashCols(timeOnly)));
}

// ---- 兼容旧代码的轻量归一（数值字符串规范化、不含 Date）：保留以维持既有比对 ----
function _sdNorm(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  var s = String(v).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return String(Number(s));
  return s;
}
// ---- O 列归一化（v5，Tom 第 6 项）----
// 真实返回的 O 值可能是布尔 true（GAS getValues 对勾选框/布尔单元格）、字符串 'TRUE'/'true'、
// 空值或别的类型。此前用 _sdNorm(true) 会得到小写 'true'，与 'TRUE' 比较必然失败，
// 并把一次**已经成功**的写入误记为 REJECTED（谎报未写）。统一入口：一律归一为大写串。
function _sdNormO(v) {
  if (v === undefined || v === null) return '';
  if (v === true) return 'TRUE';
  if (v === false) return 'FALSE';
  if (typeof v === 'number') return String(v);
  return String(v).trim().toUpperCase();
}
function _sdSoftDel(r) {
  return _sdNormO(r) === 'TRUE';
}

// ---- 固定测试向量（跨 GAS/Node 一致性证据）----
// 这些向量在 v4_genpatches 生成 GAS 副本、harness 自检时都用同一组输入；
// EXPECTED 为作者期（Node 运行）固化的已知 SHA-256，任何算法漂移都会让断言失败。
function _sdTestVectors() {
  function blank() { return new Array(15).fill(''); }
  var v = [];
  // V1: 全空行（timeOnly=false）
  v.push({ name: 'V1_empty', cells: blank(), timeOnly: false,
    EXPECTED: 'sha256:40ad38542f0328c17fc8f23265eefe2abee16f55c7b46cf2ae335a407a84941a' });
  // V2: 前导零工号（timeOnly=false）—— 必须保留 "007"，不能并成 7
  var a2 = blank(); a2[2] = 'Name007'; a2[8] = '007'; a2[6] = 8;
  v.push({ name: 'V2_leadingzero', cells: a2, timeOnly: false,
    EXPECTED: 'sha256:7b51833a117f87b87a5a9dd51093da410b2538730545162866998cd0ae73d08e' });
  // V3: 业务日期（列1）纳入、显式时区
  var a3 = blank(); a3[1] = '2026-10-15'; a3[8] = 'UUID-A';
  v.push({ name: 'V3_bizdate', cells: a3, timeOnly: false,
    EXPECTED: 'sha256:f546e8f9c0da6596d5eb780bbff5d62f34bf3b155991286ab249d21691c82350' });
  // V4: timeOnly=true —— 列0 录入时间排除出哈希，但列1/2..13/14 仍在
  var a4 = blank(); a4[0] = '2026-10-01 09:00'; a4[1] = '2026-11-02'; a4[8] = 'UUID-B';
  v.push({ name: 'V4_timeonly', cells: a4, timeOnly: true,
    EXPECTED: 'sha256:0770cd3897dcb0742cf5b55b39ec1627f286534cc4b4139c54b5081f4341d4b2' });
  return v;
}

// ---- 自检：返回每个向量的 实际/期望 是否一致 ----
function _sdSelfTest() {
  var vecs = _sdTestVectors();
  var out = [];
  for (var i = 0; i < vecs.length; i++) {
    var got = _sdRowHash(vecs[i].cells, vecs[i].timeOnly);
    out.push({ name: vecs[i].name, expected: vecs[i].EXPECTED, got: got, ok: (got === vecs[i].EXPECTED) });
  }
  return out;
}

// ---- Node 导出（GAS 侧由 genpatches 内联，不依赖 require）----
  return { _sdIsoTz: _sdIsoTz,
  _sdCellTok: _sdCellTok,
  _sdHashCols: _sdHashCols,
  _sdCanonRow: _sdCanonRow,
  _sdSha256: _sdSha256,
  _sdRowHash: _sdRowHash,
  _sdNorm: _sdNorm,
  _sdNormO: _sdNormO,
  _sdSoftDel: _sdSoftDel,
  _sdTestVectors: _sdTestVectors,
  _sdSelfTest: _sdSelfTest };
})();

var pl = (function() {
// period_lock_port.js — 真实期锁适配器的「纯逻辑」副本（单一可信源）
//
// 由 PeriodLockGuard.A0_PeriodLockGuard_cleanupGuard.js 的判定逻辑移植而来，
// 去掉 GAS 专属存储（PropertiesService）、保留纯判定函数，供 Node 核心与 GAS 共用。
// 与 GAS 端 _plParseBizDate / _plGuardCheck / _plPolicy 逐字对应（由 v4_genpatches 同文生成）。
//
// 设计目标（Tom 条件 #3）：期锁必须跑真实适配器，而非字符串比较 mock；
//   依赖缺失 → 拒绝（不静默放行）；覆盖 Date/字符串/时区/非法日期/锁定期/未来放开 组合。

'use strict';

var PL_CUTOFF = '2026-10-01';             // 与 PeriodLockGuard 默认一致
var PL_UNKNOWN = '__PL_UNKNOWN__';
// 真实策略键名（与 PeriodLockGuard.js:74-75 逐字一致）—— v5 B2 起由 GAS 侧真实读取。
var PL_POLICY_KEY = 'PERIOD_LOCK_STATE';
var PL_POLICY_INIT_KEY = 'PERIOD_LOCK_POLICY_INIT';

// M7：业务日解析（完整匹配 Date | yyyy-MM-dd | yyyy-MM-ddTHH:mm[:ss] | yyyy-MM-dd HH:mm[:ss] | yyyy/M/d）
// 尾缀垃圾/非法时分秒/越界/假日期 → null。一律 GMT+8 归日。
function _plParseBizDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'object' && typeof v.getFullYear === 'function') {
    if (isNaN(v.getTime())) return null;
    return _plFmtDate(v);
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
function _plFmtDate(d) {
  // GAS 端用 Utilities.formatDate(d,'GMT+8',...)；Node 端用 +8h 墙面时钟（与 _sdIsoTz 约定一致）
  if (typeof Utilities !== 'undefined') {
    return Utilities.formatDate(d, 'GMT+8', 'yyyy-MM-dd');
  }
  var t = d.getTime() + 8 * 3600 * 1000;
  var u = new Date(t);
  var p = function (n) { return (n < 10 ? '0' + n : '' + n); };
  return u.getUTCFullYear() + '-' + p(u.getUTCMonth() + 1) + '-' + p(u.getUTCDate());
}
function _plIsClosedBizDate(bizDate, cutoff) {
  return String(bizDate) < String(cutoff);
}

// 写网关双向门禁（原值三态）：用真实策略判定
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

// 真实日历校验（回验 cutoff 本身是合法日期，拒 '2026-00-01' 之类假日期）
function _plValidCutoff(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  var b = _plParseBizDate(s);
  return b === s;
}
function _plFailClosedPolicy(reason) {
  return { closed: true, cutoff: PL_CUTOFF, futureOpen: false,
           updatedBy: 'fail-closed-' + reason, updatedAt: '', source: 'fail-closed' };
}

// ---- v5 B2（Tom 第 4 项）：真实策略读取 ----
// 此前 GAS 侧 policy 固定调 _plPolicy()，返回 source:'unset'，**从未**读生产
// PropertiesService 策略 —— 等于生产策略（损坏 / futureOpen=false / 关账调整）
// 根本没有被执行入口遵守。此处按 PeriodLockGuard._plPolicy 逐字移植判定逻辑，
// 但 softdel 修复入口的**保守契约**比日常 PeriodLockGuard 更严（Tom #5）：
//   · 读取异常 → fail-closed（'read-error'）
//   · 哨兵三态：'1'=已初始化；确定值('0'/null/''/undefined)=未初始化；**读取异常=unknown → fail-closed**
//   · 哨兵非 '1'（未初始化 / 非法哨兵）→ fail-closed（'no-policy-unset' / 'sentinel-illegal'）
//     —— 不再沿用原实现的「首态开放默认」，没有运维显式初始化的策略即拒写，不自动初始化。
//   · 哨兵='1' 而策略键丢失/空 → fail-closed（'policy-lost'，曾初始化过又丢失 ≠ 首次部署）
//   · JSON 坏 / 结构非法（含 'false' 字符串、缺字段、cutoff 非法）→ fail-closed
// 边界：本函数**只读**，不初始化、不改写生产策略。
// propsGetter(key) 由调用方注入（GAS 侧注入 PropertiesService，Node 侧注入内存/测试替身）。
function _plPolicyFromProps(propsGetter) {
  if (typeof propsGetter !== 'function') return _plFailClosedPolicy('no-props-getter');
  var raw = null;
  try { raw = propsGetter(PL_POLICY_KEY); }
  catch (e) { return _plFailClosedPolicy('read-error'); }

  var sentinel = null, sentinelOk = false;
  try { sentinel = propsGetter(PL_POLICY_INIT_KEY); sentinelOk = true; }
  catch (e2) { sentinelOk = false; }
  if (!sentinelOk) return _plFailClosedPolicy('sentinel-unknown');

  // softdel 修复入口契约（Tom #5）：比日常 PeriodLockGuard 更保守——
  //   仅在 sentinel==='1'（运维已显式初始化）且 raw 合法时按策略放行；
  //   其余（未初始化 / 非法哨兵 / 策略缺失 / 读取故障）一律 fail-closed 拒写，
  //   不沿用原实现的「首态开放默认」，也不自动初始化策略。
  if (sentinel !== '1') {
    // 区分「确定未初始化」('0'/null/''/undefined) 与「非法哨兵值」：两者都收紧，
    //   reason 不同便于审计（非法哨兵不应被误判为首次部署开放）。
    var isLegalUnset = (sentinel === null || sentinel === undefined || sentinel === '' || sentinel === '0');
    return _plFailClosedPolicy(isLegalUnset ? 'no-policy-unset' : 'sentinel-illegal');
  }
  if (!raw) {
    // 哨兵已初始化但策略键缺失/空 → 曾初始化过又丢失 ≠ 首次部署 → 拒写
    return _plFailClosedPolicy('policy-lost');
  }
  try {
    var p = JSON.parse(raw);
    if (!p || typeof p !== 'object' || Array.isArray(p)) return _plFailClosedPolicy('parse-error');
    if (typeof p.closed !== 'boolean' || typeof p.futureOpen !== 'boolean') return _plFailClosedPolicy('schema-error');
    if (typeof p.cutoff !== 'string' || !_plValidCutoff(p.cutoff)) return _plFailClosedPolicy('schema-error');
    return { closed: p.closed, cutoff: p.cutoff, futureOpen: p.futureOpen,
      updatedBy: String(p.updatedBy || ''), updatedAt: String(p.updatedAt || ''), source: 'props' };
  } catch (e) {
    return _plFailClosedPolicy('parse-error');
  }
}

// 默认策略（镜像 PeriodLockGuard _plPolicy 的「initial-unset」态：closed=true 保护历史，
// futureOpen=true 允许未来正常写入；fail-closed 的 _plFailClosedPolicy 才是 futureOpen=false）。
// 真实部署由 PropertiesService 显式初始化；Node 核心经 deps.policy() 注入，未注入时回退到此。
function _plPolicy() {
  return { closed: true, cutoff: PL_CUTOFF, futureOpen: true, source: 'unset' };
}

// ---- Node 导出（GAS 侧由 genpatches 内联）----
  return { PL_CUTOFF: PL_CUTOFF,
  PL_UNKNOWN: PL_UNKNOWN,
  PL_POLICY_KEY: PL_POLICY_KEY,
  PL_POLICY_INIT_KEY: PL_POLICY_INIT_KEY,
  _plParseBizDate: _plParseBizDate,
  _plIsClosedBizDate: _plIsClosedBizDate,
  _plValidCutoff: _plValidCutoff,
  _plFailClosedPolicy: _plFailClosedPolicy,
  _plGuardCheck: _plGuardCheck,
  _plPolicy: _plPolicy,
  _plPolicyFromProps: _plPolicyFromProps };
})();

// ts_softdel_core.js — 软标动作【真实服务端业务核心】（v4 + v5 分批落地中：回应 Tom 2026-10-27 复审 6 项阻断 + 23:39 的 6 项剩余）
// v5 批次进度：B1「完整请求身份 + 持久恢复状态」已落（见下方 B1 段注释）；B2/B3 待落。
//   VERSION 将在 v5 三批全部落地后统一升至 ts_softdel_core/5，避免中间态版本号与内容不自洽。
// v4 相对 v3 的实质改动（均为行为改动，非措辞）：
//   T#4 日志身份：不再按 jobId+itemId 取「最后一条」，改为按【请求身份】检索完成凭据
//       （requestHash + subBatchId + uuid 逐项绑定）；冲突记录以 REJECTED 追加，绝不覆盖原完成凭据；
//       幂等命中也必须先复核实时 O 列仍为 TRUE 才能声称 wrote:true。
//   T#4 dry 语义：dry 不写任何业务恢复日志（无写入即无「待恢复」凭据）。
//   T#4 写结果诚实：writeProdO 返回 false 只表示「未确认」，登记 UNKNOWN 而非 REJECTED。
//   T#6 主库版本前后绑定：支持 expectMasterVersion 声明；写后复核主库版本，漂移 → 已写行记 UNKNOWN。
//   T#5 状态查询：逐项绑定原 manifest（jobId+subBatchId+requestHash+uuid），身份不符/读失败一律 UNKNOWN。
// 单一可信源：GAS 部署（RemoteActions）与原生 Node 隔离 harness 共用同一份逻辑，
// 仅通过 deps 注入存储/锁/网络/期锁/日志依赖，不在测试替身里另写一份更强的服务端逻辑。
//
// 7 项条件落地：
//  #1 锁内原值：主库全量读取（readAllMaster）与写入同处一把锁内；底稿读不完整 → 整批拒绝
//  #2 字段规范化契约：业务日期(列1)纳入指纹并规范为显式时区 ISO；SHA-256（非 djb2）；
//      类型保全（前导零 ID 不 coercion）；O 审计列纳入；timeOnly 仅排除录入时间列0但仍分别绑定。
//  #3 真实期锁适配器：要求 deps.guardCheck 为真实函数（来自 period_lock_port），缺失 → 整批拒绝；
//      跑真实 _plGuardCheck/_plParseBizDate/_plPolicy，typeof 守卫；业务日期以原始值（含 Date）传入，
//      由 _plParseBizDate 原生处理 Date/字符串，不再经 _sdNorm 把 Date 污损成整段 ISO 串。
//  #4 严格响应契约 + 强制日志：信封含 version；ok/dry 严格布尔；逐项 ok/wrote 严格布尔；
//      日志为强制依赖（缺失 → 整批拒绝）；PREPARED 落盘前必须成功，日志写失败 → 阻断写（UNKNOWN）；
//      COMMITTED 与回读 O 矛盾 → UNKNOWN；同身份 (jobId+itemId+requestHash) 复用冲突 → 拒绝。
//  #5 批次日志（journal）：PREPARED/COMMITTED/REJECTED/UNKNOWN；--status 验同一身份/请求；
//      读取失败留 UNKNOWN；O=TRUE 来源不明 ≠ 本请求完成。
//  #6 参数/keeper 类型闭合：用解析后 zrow===zk（非 '2'===2 绕过）；严格 JSON 类型；拒绝 null/未知 dry、
//      非数组 rows、越界/表头、空/非法 uuid、未知顶层字段、重复/循环依赖（先建 keeper 图）；
//      flush 异常区分"已写未确认"与"未写"（非一律 ROW_READ_FAIL）。
//  #7 分页版本闭合：主库读取返回 version（真实内容指纹），缺失/空 → 整批拒绝；读依赖缺失 → 整批拒绝。
//
// 锁作用域的诚实声明（更正 v3 的过度主张）：GAS 的 LockService.getScriptLock() 按 Google 官方说明
//   **仅作用于脚本**（同一脚本项目内的并发执行），不提供跨项目/跨文档/跨用户的互斥。
//   因此本核心的 acquireMasterLock 只能序列化【本项目内】的并发执行，
//   **不声称**跨项目写协调或跨文档互斥；跨项目协调须另设外部协调器，本版本未实现、未声称。

'use strict';

var _sdRowHash = norm._sdRowHash;
var _sdCellTok = norm._sdCellTok;
var _sdSoftDel = norm._sdSoftDel;
var _sdSha256 = norm._sdSha256;

var VERSION = 'ts_softdel_core/4';
var ROW_KEYS = ['row', 'uuid', 'keeperRow', 'level', 'timeOnly', 'expectHash',
  'keeperHash', 'expectBaseHash', 'clearance', 'expectEntryTime', 'keeperEntryTime'];
// 说明：'payload' 是【传输信封字段】而非业务字段 —— RemoteTrigger._rtMaybeHandlePost 允许
//   调用方用 ?payload=<JSON> 递交请求体，解析后仍把原始 payload 键留在 parameter 里透传给动作函数；
//   本核心若把它当"未知业务字段"整批拒绝，等于把 RemoteTrigger 明文支持的装配形态废掉
//   （GAS 适配器隔离 harness S31 实测：ok=false / unknown top-level fields: payload）。
//   故列入白名单，但它不承载任何业务语义：rows 仍只认 postBody（见 _validateInput）。
var TOP_KEYS = ['batchId', 'rows', 'dry', 'sheet', 'clearance', 'jobId', 'action', 'token',
  'expectMasterVersion', 'payload'];

// 单格规范化 token（用于 timeOnly 的录入时间绑定，单格）
function _sdCellHash(v) { return _sdSha256(JSON.stringify(_sdCellTok(v))); }

function _res(ok, extra) {
  var o = { ok: !!ok, version: VERSION };
  for (var k in extra) if (extra.hasOwnProperty(k)) o[k] = extra[k];
  return JSON.stringify(o);
}

// 请求身份指纹（单一可信源）：客户端执行器与服务端核心【共用本函数】计算 requestHash，
// 杜绝两侧各写一份导致键序/类型/undefined 省略规则不一致、身份绑定永久失配。
// 注：JSON.stringify 会省略值为 undefined 的键，故 B 级（无 expectBaseHash）与非 timeOnly
// （无录入时间）会自然少键 —— 两侧必须走同一函数才能保证逐字一致。
function _requestHashOf(it) {
  return _sdSha256(JSON.stringify({
    row: Number(it.row), uuid: String(it.uuid || ''), keeperRow: Number(it.keeperRow),
    level: String(it.level || ''), timeOnly: (it.timeOnly === true),
    expectHash: it.expectHash, keeperHash: it.keeperHash, expectBaseHash: it.expectBaseHash,
    expectEntryTime: it.expectEntryTime, keeperEntryTime: it.keeperEntryTime
  }));
}

// ---- S1-8 clearance 严格判定契约（Tom 第十轮缺陷 #1 + Tom 2101 #1）----
// deps.isClearance 的实现（tools/ts_clearance.consumeClearance）返回【结构化对象】
//   {ok:false, reason:'REVOKED'} —— 该对象在 JS 中仍是 truthy；
//   若用 !! 强转，拒绝结果会被当成「授权通过」，直接绕过期锁守卫。
// 因此定义唯一判定口径：**严格形态**
//   · STRICT（默认，GAS 无 process ⇒ 恒走此路）：仅接受对象 {ok:true, nonce:<非空串>}。
//     理由（Tom 2101 #1「建议生产接口仅接受明确结构化 {ok:true}，禁止不明形态和异常放行」）：
//       - 裸布尔 true 不携带被消费 nonce ⇒ 无法与账本对照，\"谁授权了什么\"不可追溯；
//       - ok:'true'（字符串）等不明形态一律 false；
//       - 返回值含 scenario=throw 的情况在调用侧已 try/catch ⇒ 绝不按放行处理。
//   · PROTOTYPE：兼容旧测试替身返回裸 true；仅当显式设置
//     TS_CLEARANCE_SHAPE_MODE=prototype 生效（测试逃生口，默认关闭）。
function _clearanceShapeMode() {
  if (typeof process !== 'undefined' && process.env &&
      process.env.TS_CLEARANCE_SHAPE_MODE === 'prototype') return 'prototype';
  return 'strict';
}

function _clearanceStrictOk(raw) {
  const mode = _clearanceShapeMode();
  if (mode === 'prototype') {
    if (raw === true) return true;
    if (raw && typeof raw === 'object' && raw.ok === true) return true;
    return false;
  }
  // STRICT：只接受「明确结构化 {ok:true, nonce} 」
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  if (raw.ok !== true) return false;
  if (typeof raw.nonce !== 'string' || !raw.nonce) return false;
  return true;
}

// Tom 第十轮缺陷 #3：rowSetDigest 必须由【本次受保护的真实批次】计算，不接受客户端自报。
//   规范形态：逐 target 取 (row:uuid:keeperRow) 后字典序排序，再 SHA-256 —— 与行顺序无关、可独立复算。
//   ⚠️ V1 仅绑定行身份，**不绑定每行的内容指纹** ⇒ Tom 2101 #3 判定其不足以约束内容。
function _rowSetDigestOf(rows) {
  var ids = rows.map(function (it) {
    return String(Number(it && it.row)) + ':' + String((it && it.uuid) || '') + ':' + String(Number(it && it.keeperRow));
  });
  ids.sort();
  return _sdSha256(JSON.stringify(ids));
}

// ---- Tom 2101 #3：V2 行集指纹（绑定【逐行内容】+ 行数 + 规范形态）----
//   · 逐行内容指纹 = _requestHashOf(it)（与 centers 请求身份同一函数，杜绝二次重写）；
//   · 规范形态：按 (row, uuid, keeperRow) 字典序排序后拼接，行顺序无关；
//   · 行数参与摘要：防止「删掉一行但身份串仍可对齐」的类漂移；
//   · 任一行为非法形态（NaN row / 空 uuid）→ 返回 null ⇒ 调用方整批拒绝（fail-closed）。
function _rowSetDigestV2Of(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  var parts = [];
  for (var i = 0; i < rows.length; i++) {
    var it = rows[i] || {};
    var row = Number(it.row), keeperRow = Number(it.keeperRow);
    if (!isFinite(row) || row <= 0) return null;
    if (!isFinite(keeperRow) || keeperRow <= 0) return null;
    var uuid = String(it.uuid || '');
    if (!uuid) return null;
    parts.push(row + ':' + keeperRow + ':' + uuid + ':' + _requestHashOf(it));
  }
  parts.sort();
  return _sdSha256(JSON.stringify({ alg: 'rowset-v2', n: parts.length, rows: parts }));
}

// ---- Tom 2101 #3：V2 快照指纹（绑定【生产目标 + 动作 + job + 版本】）----
//   旧版仅 _sdSha256({v: masterVersion}) —— 不绑定目标表身份、动作、jobId、批次与行集，
//   换个目标或换个批次仍可能拿到同一指纹 ⇒ 令牌可被挪用到别的写目标。
//   现版把全部身份要素纳入；缺值/空值 → 返回 null ⇒ 调用方整批拒绝（不得静默降级）。
//   键序固定展开（不依赖 JSON.stringify 的对象遍历顺序）。
function _snapshotFingerprintV2(o) {
  o = o || {};
  var req = {
    targetSpreadsheetId: o.targetSpreadsheetId,
    targetSheetName: o.targetSheetName,
    action: o.action,
    jobId: o.jobId,
    batchId: o.batchId,
    masterVersion: o.masterVersion,
    baselineVersion: o.baselineVersion,
    rowCount: o.rowCount,
    rowSetDigestV2: o.rowSetDigestV2,
  };
  var keys = ['targetSpreadsheetId', 'targetSheetName', 'action', 'jobId', 'batchId',
    'masterVersion', 'baselineVersion', 'rowCount', 'rowSetDigestV2'];
  for (var i = 0; i < keys.length; i++) {
    var v = req[keys[i]];
    if (v === null || v === undefined || v === '') return null;   // 缺值 ⇒ 拒绝，不得回退旧版
    if (typeof v === 'number' && !isFinite(v)) return null;
  }
  return _sdSha256(JSON.stringify({
    alg: 'snapshot-v2',
    targetSpreadsheetId: String(req.targetSpreadsheetId),
    targetSheetName: String(req.targetSheetName),
    action: String(req.action),
    jobId: String(req.jobId),
    batchId: String(req.batchId),
    masterVersion: String(req.masterVersion),
    baselineVersion: String(req.baselineVersion),
    rowCount: Number(req.rowCount),
    rowSetDigestV2: String(req.rowSetDigestV2),
  }));
}

// 结构化校验（输入形态 + 逐行 + keeper 图）；返回 {error} 或 {rows}
function _validateInput(e, deps) {
  var p = e.parameter || {};
  var body = e.postBody || {};
  var top = Object.keys(body).concat(Object.keys(p));
  var unknownTop = top.filter(function (k) { return TOP_KEYS.indexOf(k) < 0; });
  if (unknownTop.length) return { error: 'unknown top-level fields: ' + unknownTop.join(',') };

  var rows = body.rows || p.rows;
  if (!Array.isArray(rows)) return { error: 'rows must be an array' };
  if (!rows.length) return { error: 'no rows provided' };
  if (rows.length > 2000) return { error: 'too many rows: ' + rows.length };

  // dry 严格：接受布尔或约定字符串 0/1/true/false（GAS/运输层惯例）；拒绝 null/未知/数字/其它字符串
  var dryExplicit = (p.dry !== undefined) ? p.dry : body.dry;
  if (dryExplicit !== undefined) {
    var dryOk = (dryExplicit === true || dryExplicit === false ||
                 dryExplicit === '0' || dryExplicit === '1' ||
                 dryExplicit === 'true' || dryExplicit === 'false');
    if (!dryOk) return { error: 'dry must be boolean or 0/1 string, got: ' + JSON.stringify(dryExplicit) };
  }

  var sheetName = String(p.sheet || body.sheet || deps.PL_DB_SHEET);
  if (sheetName !== deps.PL_DB_SHEET) {
    return { error: 'sheet not allowed: ' + sheetName + ' (must be ' + deps.PL_DB_SHEET + ')' };
  }

  var seenTarget = {};
  var keeperOf = {};   // row -> keeperRow（用于循环/依赖检测）
  for (var z = 0; z < rows.length; z++) {
    var zr = rows[z] || {};
    var unknown = Object.keys(zr).filter(function (k) { return ROW_KEYS.indexOf(k) < 0; });
    if (unknown.length) return { error: 'row#' + z + ' unknown fields: ' + unknown.join(',') };

    var zrow = Number(zr.row), zk = Number(zr.keeperRow);
    if (!Number.isInteger(zrow) || zrow < 2) return { error: 'row#' + z + ' bad row: ' + JSON.stringify(zr.row) };
    if (!Number.isInteger(zk) || zk < 2) return { error: 'row#' + z + ' bad keeperRow: ' + JSON.stringify(zr.keeperRow) };
    // 条件 #6：用解析后比较，避免 '2' === 2 绕过
    if (zrow === zk) return { error: 'row#' + z + ' row==keeperRow (self-reference)' };

    if (!zr.uuid || typeof zr.uuid !== 'string' || !zr.uuid.trim()) {
      return { error: 'row#' + z + ' missing/invalid uuid' };
    }
    if (zr.level !== 'A' && zr.level !== 'B') return { error: 'row#' + z + ' bad level: ' + JSON.stringify(zr.level) };
    if (!zr.expectHash || !zr.keeperHash) return { error: 'row#' + z + ' missing expectHash/keeperHash' };
    if (zr.level === 'A' && !zr.expectBaseHash) return { error: 'row#' + z + ' A-level missing expectBaseHash' };
    if (zr.timeOnly != null && typeof zr.timeOnly !== 'boolean') {
      return { error: 'row#' + z + ' bad timeOnly (must be boolean)' };
    }
    // timeOnly 时须绑定双方录入时间（条件 #2）
    if (zr.timeOnly === true) {
      if (!zr.expectEntryTime || !zr.keeperEntryTime) {
        return { error: 'row#' + z + ' timeOnly requires expectEntryTime & keeperEntryTime' };
      }
    }
    if (seenTarget[zrow]) return { error: 'duplicate target row: ' + zrow };
    seenTarget[zrow] = true;
    keeperOf[zrow] = zk;
  }

  // 条件 #6：先建 keeper 图，拒绝"目标是他人 keeper"与循环依赖
  var targets = {};
  rows.forEach(function (r) { if (r && r.row != null) targets[Number(r.row)] = true; });
  for (var z2 = 0; z2 < rows.length; z2++) {
    var krow = Number(rows[z2].keeperRow);
    if (targets[krow]) {
      return { error: 'row#' + z2 + ' keeperRow=' + krow + ' is also a target in this batch (dependency conflict)' };
    }
  }
  // 循环检测：keeper 链最终必须落在非目标的保留行
  for (var z3 = 0; z3 < rows.length; z3++) {
    var cur = Number(rows[z3].keeperRow), seen = {};
    while (cur != null && targets[cur] && !seen[cur]) { seen[cur] = true; cur = keeperOf[cur]; }
    if (cur != null && seen[cur]) return { error: 'row#' + z3 + ' cyclic keeper dependency' };
  }

  return { rows: rows };
}

// 主入口
function tsSoftDelGuardedCore(e, deps) {
  e = e || {};
  // 只读状态查询（条件 #5）
  // v5 B3（Tom 第 5 项）：分发器 _rtMaybeHandle 会把 action 统一 toLowerCase，
  //   而此处原本按 'statusQuery' 精确比较 ⇒ 经真实分发进来的请求永远分流不到 statusQuery
  //   （实测：REMOTE_ACTIONS 无 statusQuery 键 + 大小写不匹配 ⇒ 返回 unknown action）。
  //   改为大小写不敏感判定。
  var _act = String((e.postBody && e.postBody.action) || (e.parameter && e.parameter.action) || '').toLowerCase();
  if (_act === 'statusquery') {
    return tsSoftDelStatus(e, deps);
  }

  var p = e.parameter || {};
  var body = e.postBody || {};
  var dryExplicit = (p.dry !== undefined) ? p.dry : body.dry;
  var dry = !(dryExplicit === false || dryExplicit === '0' || dryExplicit === 'false');   // 默认 true（fail-closed）
  var batchId = body.batchId || p.batchId || null;
  var jobId = body.jobId || p.jobId || batchId || ('J' + Date.now().toString(36));

  var v = _validateInput(e, deps);
  if (v.error) return _res(false, { error: v.error, batchId: batchId, jobId: jobId });
  var rows = v.rows;

  var clearanceToken = body.clearance || p.clearance || null;
  // S1-8（Tom 第八轮·实现方待办）：clearance 校验原在取锁前（锁外授权窗口，TOCTOU），已下移至取锁后锁区间内（见本函数 ~212 行后）。

  // 条件 #3：真实期锁依赖缺失 → 整批拒绝（不静默放行）
  if (typeof deps.guardCheck !== 'function') {
    return _res(false, { error: 'PERIOD_DEP_MISSING', batchId: batchId, jobId: jobId });
  }
  // 条件 #4：强制日志依赖缺失 → 整批拒绝（日志不是可选装饰，是幂等/对账凭证）
  if (typeof deps.journalAppend !== 'function') {
    return _res(false, { error: 'JOURNAL_DEP_MISSING', batchId: batchId, jobId: jobId });
  }
  var policy = (typeof deps.policy === 'function') ? deps.policy() : pl._plPolicy();

  // 条件 #1/#7：锁获取（固定顺序：master 先，prod 后）。
  // Tom #3：两次取锁都必须处在受保护的释放路径下 —— 第二把锁获取失败时，第一把锁必须被释放，
  //   否则留下永不释放的悬挂锁。v3 把两次取锁写在 try 之外，正是该缺陷；v4 显式闭合，
  //   且取锁失败返回结构化响应（不再向外抛出，避免调用方拿到非 JSON 的崩溃）。
  var _mlock = null, _lock = null;
  try {
    _mlock = deps.acquireMasterLock ? deps.acquireMasterLock() : null;
  } catch (me1) {
    return _res(false, { error: 'MASTER_LOCK_BUSY', detail: String(me1 && me1.message || me1), batchId: batchId, jobId: jobId });
  }
  try {
    _lock = deps.acquireLock();
  } catch (le1) {
    // 第二把锁失败 → 立刻释放第一把锁，闭合悬挂路径
    if (deps.releaseMasterLock && _mlock) { try { deps.releaseMasterLock(_mlock); } catch (x1) {} }
    return _res(false, { error: 'LOCK_BUSY', detail: String(le1 && le1.message || le1), batchId: batchId, jobId: jobId });
  }
  var results = [], patched = 0, anyFail = false, wroteRows = [], masterVersionAfter = null;
  // S1-8 clearance 判定（Tom 第八轮·实现方待办 + Tom 第十轮缺陷 #2 修正）：
  //   · #2：本判定原先写在下面的 try 之外 —— 一旦 isClearance 抛错即绕过 468 行的 finally 释放路径，
  //     留下永不释放的悬挂锁。现整个判定移入 try/finally 受保护区，并对异常 fail-closed（异常 ≠ 放行）。
  //   · #3：rowSetDigest / snapshotFingerprint 在锁内由真实批次与真实主库版本计算，不接受客户端自报。
  var clearanceOk = false;
  var _clearanceReason = null;
  try {
    // 条件 #1/#7：主库全量读取必须在锁内（消除 build-masterMap-before-lock 的 TOCTOU）；
    //         读依赖缺失/读不完整/版本缺失 → 整批拒绝，B 级不会再被"误判底稿0行"放行。
    if (typeof deps.readAllMaster !== 'function') {
      return _res(false, { error: 'MASTER_READ_DEP_MISSING', batchId: batchId, jobId: jobId });
    }
    var master = deps.readAllMaster();
    if (!master.complete) {
      return _res(false, { error: 'BASE_READ_INCOMPLETE', detail: master.error || '', version: master.version || null, batchId: batchId, jobId: jobId });
    }
    if (!master.version) {
      return _res(false, { error: 'MASTER_VERSION_MISSING', batchId: batchId, jobId: jobId });
    }
    var masterMap = master.map || {};

    // Tom #6 + v5 B2（Tom 第 3 项）：主库版本【端到端必需】，不再是可选 truthy 回退。
    //   · 非 dry（真写）：expectMasterVersion 缺失 → **整批拒绝** MASTER_VERSION_REQUIRED；
    //     不符 → MASTER_VERSION_MISMATCH。此前 `body.x || p.x || null` 的 truthy 回退
    //     会让「未声明」静默通过，等于前后绑定形同虚设。
    //   · dry（探测）：允许缺失并**回显** masterVersion —— 客户端据此取得版本写入 manifest，
    //     再用于后续真写批次的声明。dry 不产生写入，放行不构成风险。
    //   写后再复核（见响应 masterVersion / masterVersionAfter），漂移 → 已写行 VOIDED。
    var expectMasterVersion = (body.expectMasterVersion != null) ? body.expectMasterVersion
      : ((p.expectMasterVersion != null) ? p.expectMasterVersion : null);
    if (expectMasterVersion === null || expectMasterVersion === undefined || expectMasterVersion === '') {
      if (!dry) {
        return _res(false, { error: 'MASTER_VERSION_REQUIRED', batchId: batchId, jobId: jobId,
          hint: '真写必须声明 expectMasterVersion；可先发一次 dry 探测取得 masterVersion' });
      }
    } else if (String(expectMasterVersion) !== String(master.version)) {
      return _res(false, { error: 'MASTER_VERSION_MISMATCH', expect: String(expectMasterVersion), actual: String(master.version), batchId: batchId, jobId: jobId });
    }

    // ===== S1-8 clearance 判定（Tom 第十轮 #1/#2/#3 修正后：锁内、严格布尔、服务端派生作用域）=====
    if (clearanceToken) {
      if (typeof deps.isClearance !== 'function') {
        // 缺失依赖 → 整批拒绝（不静默放行）
        return _res(false, { error: 'CLEARANCE_DEP_MISSING', batchId: batchId, jobId: jobId });
      }
      // #3 + Tom 2101 #3：作用域在锁内由真实对象派生 —— 行集取自本次受保护批次（含逐行内容指纹），
      //     快照指纹绑定【生产目标 + 动作 + job/batch + 主库版本 + 底稿版本 + 行集】，
      //     全部取自服务端依赖，**无任何一项来自客户端自报**。
      // Tom 2101 #3 具体修正：
      //   · 指纹 V1 仅哈希 master.version ⇒ 换个目标/换批仍可能同指纹，令牌可被挪用到别的写目标；
      //   · rowSetDigest V1 只含 (row:uuid:keeperRow) ⇒ 不绑定逐行内容，改行内容仍可过。
      //   现一律改用 V2；任一项缺值/非法 → 整批拒绝（CLEARANCE_*_UNKNOWN，fail-closed）。
      var _rsDigest = _rowSetDigestV2Of(rows);
      if (!_rsDigest) {
        return _res(false, { error: 'CLEARANCE_ROWSET_UNKNOWN', batchId: batchId, jobId: jobId });
      }
      if (typeof deps.targetIdentity !== 'function' || typeof deps.baselineVersion !== 'function') {
        return _res(false, { error: 'CLEARANCE_SCOPE_DEP_MISSING', batchId: batchId, jobId: jobId });
      }
      var _tgt = null;
      try { _tgt = deps.targetIdentity(); } catch (te) { _tgt = null; }
      if (!_tgt || String(_tgt.spreadsheetId || '') === '' || String(_tgt.sheetName || '') === '') {
        return _res(false, { error: 'CLEARANCE_TARGET_UNKNOWN', batchId: batchId, jobId: jobId });
      }
      var _baseVer = null;
      try { _baseVer = deps.baselineVersion(); } catch (be) { _baseVer = null; }
      if (String(_baseVer || '') === '') {
        return _res(false, { error: 'CLEARANCE_BASELINE_UNKNOWN', batchId: batchId, jobId: jobId });
      }
      var _fp = _snapshotFingerprintV2({
        targetSpreadsheetId: _tgt.spreadsheetId,
        targetSheetName: _tgt.sheetName,
        action: 'softDelGuarded',
        jobId: jobId,
        batchId: batchId,
        masterVersion: master.version,
        baselineVersion: _baseVer,
        rowCount: rows.length,
        rowSetDigestV2: _rsDigest,
      });
      if (!_fp) {
        return _res(false, { error: 'CLEARANCE_FINGERPRINT_UNKNOWN', batchId: batchId, jobId: jobId });
      }
      try {
        var _raw = deps.isClearance(clearanceToken, rows, {
          jobId: jobId, rows: rows, rowSetDigest: _rsDigest, snapshotFingerprint: _fp, lock: _lock,
          // Tom 2101 #2：锁 **id 必填**（与句柄一致）+ 声明锁域（防止别处的锁句柄被当成本期锁）
          lockId: _lock ? _lock.id : null,
          lockDomain: 'period-lock/guard',
          scopeVersion: 'v2', rowsCount: rows.length,
          masterVersion: master.version, baselineVersion: _baseVer,
          targetSpreadsheetId: _tgt.spreadsheetId, targetSheetName: _tgt.sheetName,
        });
        // #1：严格布尔契约 —— {ok:false, reason:...} 对象不得被判为通过。
        clearanceOk = _clearanceStrictOk(_raw);
        if (!clearanceOk) {
          _clearanceReason = (typeof _raw === 'object' && _raw && _raw.reason) ? String(_raw.reason) : 'REJECTED';
        }
      } catch (cErr) {
        // #2：异常 fail-closed —— 判定异常视同未授权，且仍在 finally 保护区内（锁必被释放）。
        clearanceOk = false;
        _clearanceReason = 'CLEARANCE_CHECK_THREW';
      }
    }

    // ===== Tom V→W 批·A点① + 点③：独立预检阶段（全体目标 + 底稿完整性 + 版本守卫）=====
    // 批次语义（逐条对齐 Tom 2026-10-30 03:46Z 点③）：
    //   · Phase A 预检【纯函数、零写、零日志】：对【每个】目标运行全部校验，【不落任何 journal、不写生产】；
    //     失败目标登记 PRECHECK_REJECTED（仅写入响应 results，不写 journal，不写生产），整批标记 preFail；
    //     通过目标仅标记"待写"。—— 回应 Tom"Phase A 仍有日志写入/非所有副作用为零"：本批 Phase A 已无任何 journal 写。
    //   · Phase B 裁决：仅当 preFail=false（全体预检通过）才进入生产写；否则整批拒绝、零生产写
    //     （通过目标记 BATCH_REJECTED_PRECHECK，未写、无日志）。
    //   · 写阶段首次失败/UNKNOWN 即停止后续业务写入（writeStopped 闸门）：保留已确认成功(CONFIRMED_SUCCESS)、
    //     未确认(UNKNOWN)、未尝试(NOT_ATTEMPTED)的逐项状态；不得回滚式猜测或盲目重试。
    //   · 已写行若结果不明，按 UNKNOWN 登记（绝不谎称 REJECTED/COMMITTED）；崩溃窗口恢复为 UNKNOWN，
    //     禁止自动重写；必须先按原 job/目标身份（jobId+itemId+requestHash+keeperRow）查证、对账，再裁定恢复。
    var preRecs = [];     // 每个目标的预检结论 {row,uuid,keeperRow,level,timeOnly,itemId,requestHash,ok,wrote,idempotent}
    var preFail = false;
    for (var i = 0; i < rows.length; i++) {
      var it = rows[i] || {};
      var row = Number(it.row), uuid = String(it.uuid || '');
      var keeperRow = Number(it.keeperRow), level = String(it.level || '');
      var timeOnly = (it.timeOnly === true);
      var itemId = row;
      var requestHash = _requestHashOf(it);
      var pr = { row: row, uuid: uuid, keeperRow: keeperRow, level: level, timeOnly: timeOnly,
                 itemId: itemId, requestHash: requestHash, ok: false, wrote: false, idempotent: false };
      try {
        // 同身份复用检测（Tom #4）：按【请求身份】检索完成凭据，不再只看「最后一条」。
        var _recs = _journalRecords(deps, jobId, itemId);
        if (_isReadError(_recs)) {
          results.push({ row: row, ok: false, wrote: false, reason: 'JOURNAL_READ_ERROR', state: 'PRECHECK_REJECTED', detail: _recs.detail });
          anyFail = true; preFail = true; preRecs.push(pr); continue;
        }
        var _commit = _findCommit(_recs, requestHash, batchId, uuid);
        if (_commit && _commit.__voided) {
          results.push({ row: row, ok: false, wrote: false, reason: 'PRIOR_VOIDED', state: 'PRECHECK_REJECTED', priorState: _commit.record.state, priorReason: _commit.record.reason || null });
          anyFail = true; preFail = true; preRecs.push(pr); continue;
        }
        if (_commit) {
          var oNow = null, oErr = null;
          try { oNow = deps.readProdO ? deps.readProdO(row) : null; } catch (oe) { oErr = String(oe && oe.message || oe); }
          if (oErr || oNow === null || oNow === undefined) {
            results.push({ row: row, ok: false, wrote: false, reason: 'IDEMPOTENT_RECHECK_UNAVAILABLE', state: 'PRECHECK_REJECTED', error: oErr || '' });
            anyFail = true; preFail = true; preRecs.push(pr); continue;
          }
          if (!_sdSoftDel(oNow)) {
            results.push({ row: row, ok: false, wrote: false, reason: 'IDEMPOTENT_O_DRIFT', state: 'PRECHECK_REJECTED', expect: 'TRUE', actual: String(oNow) });
            anyFail = true; preFail = true; preRecs.push(pr); continue;
          }
          var idRow = null, idErr = null;
          try { idRow = deps.readProdRow ? deps.readProdRow(row) : null; } catch (ie) { idErr = String(ie && ie.message || ie); }
          var idKeeper = null;
          try { idKeeper = deps.readProdRow ? deps.readProdRow(keeperRow) : null; } catch (ke) { idKeeper = null; }
          if (idErr || !idRow || !idKeeper) {
            results.push({ row: row, ok: false, wrote: false, reason: 'IDEMPOTENT_IDENTITY_UNAVAILABLE', state: 'PRECHECK_REJECTED', error: idErr || '' });
            anyFail = true; preFail = true; preRecs.push(pr); continue;
          }
          var liveKHashIdem = _sdRowHash(idKeeper, timeOnly);
          if (norm._sdNorm(idRow[8]) !== uuid || _sdSoftDel(idKeeper[14]) || liveKHashIdem !== it.keeperHash) {
            results.push({ row: row, ok: false, wrote: false, reason: 'IDEMPOTENT_IDENTITY_DRIFT', state: 'PRECHECK_REJECTED', uuidActual: norm._sdNorm(idRow[8]), keeperO: String(idKeeper[14]), keeperHashActual: liveKHashIdem, keeperHashExpect: it.keeperHash });
            anyFail = true; preFail = true; preRecs.push(pr); continue;
          }
          // 幂等成功：已在前次作业写入；预检通过、不写、不阻塞整批（仅读取判定，零写、零日志）
          results.push({ row: row, ok: true, wrote: true, level: level, idempotent: true });
          patched++;
          pr.ok = true; pr.wrote = true; pr.idempotent = true;
          preRecs.push(pr); continue;
        }
        var _anyCommit = _findAnyCommit(_recs);
        if (_anyCommit) {
          results.push({ row: row, ok: false, reason: 'KEY_REUSE_CONFLICT', state: 'PRECHECK_REJECTED', priorHash: _anyCommit.requestHash });
          anyFail = true; preFail = true; preRecs.push(pr); continue;
        }
        var vals = deps.readProdRow(row);
        if (!vals) { results.push({ row: row, ok: false, reason: 'ROW_NOT_FOUND', state: 'PRECHECK_REJECTED' }); anyFail = true; preFail = true; preRecs.push(pr); continue; }
        var kVals = deps.readProdRow(keeperRow);
        if (norm._sdNorm(vals[8]) !== uuid) { results.push({ row: row, ok: false, reason: 'UUID_DRIFT', state: 'PRECHECK_REJECTED', actual: norm._sdNorm(vals[8]) }); anyFail = true; preFail = true; preRecs.push(pr); continue; }
        if (_sdSoftDel(vals[14])) { results.push({ row: row, ok: false, wrote: false, reason: 'ALREADY_SOFTDEL', state: 'PRECHECK_REJECTED' }); anyFail = true; preFail = true; preRecs.push(pr); continue; }
        if (!kVals || _sdSoftDel(kVals[14])) { results.push({ row: row, ok: false, reason: 'KEEPER_INVALID', state: 'PRECHECK_REJECTED' }); anyFail = true; preFail = true; preRecs.push(pr); continue; }
        var liveHash = _sdRowHash(vals, timeOnly);
        var liveKHash = _sdRowHash(kVals, timeOnly);
        if (liveHash !== it.expectHash) { results.push({ row: row, ok: false, reason: 'TARGET_DRIFT', state: 'PRECHECK_REJECTED', expect: it.expectHash, actual: liveHash }); anyFail = true; preFail = true; preRecs.push(pr); continue; }
        if (liveKHash !== it.keeperHash) { results.push({ row: row, ok: false, reason: 'KEEPER_DRIFT', state: 'PRECHECK_REJECTED', expect: it.keeperHash, actual: liveKHash }); anyFail = true; preFail = true; preRecs.push(pr); continue; }
        if (timeOnly) {
          var liveEntry = _sdCellHash(vals[0]);
          var liveKEntry = _sdCellHash(kVals[0]);
          if (liveEntry !== it.expectEntryTime || liveKEntry !== it.keeperEntryTime) { results.push({ row: row, ok: false, reason: 'ENTRY_TIME_DRIFT', state: 'PRECHECK_REJECTED' }); anyFail = true; preFail = true; preRecs.push(pr); continue; }
        }
        var diffs = [];
        for (var c = 0; c <= 13; c++) {
          var tA = JSON.stringify(_sdCellTok(vals[c]));
          var tB = JSON.stringify(_sdCellTok(kVals[c]));
          if (tA !== tB) diffs.push(c);
        }
        var allowed = timeOnly && diffs.length > 0 && diffs.every(function (x) { return x === 0; });
        if (diffs.length > 0 && !allowed) { results.push({ row: row, ok: false, reason: 'PAYLOAD_DIFF', state: 'PRECHECK_REJECTED', cols: diffs }); anyFail = true; preFail = true; preRecs.push(pr); continue; }
        var bizDate = vals[1];
        var g = deps.guardCheck(bizDate, null, policy);
        if (!g.ok && !clearanceOk) { results.push({ row: row, ok: false, reason: 'PERIOD_LOCKED', state: 'PRECHECK_REJECTED', date: norm._sdNorm(bizDate), detail: g.reason || '', clearanceReason: (clearanceToken ? (_clearanceReason || 'NOT_GRANTED') : null) }); anyFail = true; preFail = true; preRecs.push(pr); continue; }
        if (level === 'A') {
          var mMatches = masterMap[uuid] || [];
          if (mMatches.length !== 1) { results.push({ row: row, ok: false, reason: (mMatches.length === 0 ? 'BASE_NOT_FOUND' : 'BASE_NOT_UNIQUE'), state: 'PRECHECK_REJECTED', count: mMatches.length }); anyFail = true; preFail = true; preRecs.push(pr); continue; }
          var mHash = _sdRowHash(mMatches[0].cells, false);
          if (mHash !== it.expectBaseHash) { results.push({ row: row, ok: false, reason: 'BASE_DRIFT', state: 'PRECHECK_REJECTED', expect: it.expectBaseHash, actual: mHash }); anyFail = true; preFail = true; preRecs.push(pr); continue; }
        } else {
          var mB = masterMap[uuid] || [];
          if (mB.length !== 0) { results.push({ row: row, ok: false, reason: 'BASE_HAS_MATCH', state: 'PRECHECK_REJECTED', count: mB.length }); anyFail = true; preFail = true; preRecs.push(pr); continue; }
        }
        // 预检通过（不含任何写、不含任何日志）：标记待写
        pr.ok = true; preRecs.push(pr);
      } catch (rerr) {
        results.push({ row: row, ok: false, reason: 'ROW_READ_FAIL', state: 'PRECHECK_REJECTED', error: String(rerr && rerr.message || rerr) });
        anyFail = true; preFail = true; preRecs.push(pr);
      }
    }

    // ===== Phase B：整批裁决 + 写阶段（Tom W 批·点③：首次失败/UNKNOWN 即停，保留逐项状态）=====
    if (preFail) {
      // 整批拒绝：零生产写。通过目标记 BATCH_REJECTED_PRECHECK（未写、无日志）。
      for (var bi = 0; bi < preRecs.length; bi++) {
        var bpr = preRecs[bi];
        if (bpr.ok && !bpr.idempotent) {
          results.push({ row: bpr.row, ok: false, wrote: false, reason: 'BATCH_REJECTED_PRECHECK', state: 'NOT_ATTEMPTED',
            detail: '整批预检存在失败项，本目标未写（零副作用）' });
        }
      }
    } else {
      // 全体预检通过 -> 进入生产写（PREPARED + writeProdO + 回读）。
      // writeStopped 闸门（Tom W 批·点③）：一旦任一目标发生写入失败/结果不明，后续未尝试目标一律 NOT_ATTEMPTED，
      // 不得继续写、不得回滚式猜测或盲目重试；须按原 job/目标身份查证对账后再裁定恢复。
      var writeStopped = false;
      for (var bi2 = 0; bi2 < preRecs.length; bi2++) {
        var wpr = preRecs[bi2];
        if (wpr.idempotent) continue;   // 已在 Phase A 计入（幂等成功）
        var wRow = wpr.row, wUuid = wpr.uuid, wKeeper = wpr.keeperRow, wLevel = wpr.level,
            wTimeOnly = wpr.timeOnly, wItemId = wpr.itemId, wReqHash = wpr.requestHash;
        if (writeStopped) {
          // 前序目标写失败/UNKNOWN -> 本目标未尝试，保留 NOT_ATTEMPTED（不写、不重试）
          results.push({ row: wRow, ok: false, wrote: false, reason: 'BATCH_STOPPED_NOT_ATTEMPTED', state: 'NOT_ATTEMPTED',
            detail: '前序目标写失败/结果不明，已停止后续业务写入；须按 job/目标身份对账裁定恢复（禁止盲目重试）' });
          continue;
        }
        // Tom X 批·三(2)：PREPARED 必须明确传 null reason + keeperRow —— 原调用把 wKeeper 错当 reason，
        // keeperRow 实际缺失，崩溃恢复时 PREPARED 不能保存所宣称的完整 keeper 身份。
        var prepOk = _jrn(deps, jobId, batchId, wItemId, wReqHash, wUuid, dry, 'PREPARED', null, wKeeper);
        if (!prepOk) { results.push({ row: wRow, ok: false, wrote: false, reason: 'PREPARED_LOG_FAILED', state: 'UNCONFIRMED' }); anyFail = true; writeStopped = true; continue; }
        if (!dry) {
          var wroteOk = false;
          try {
            wroteOk = deps.writeProdO(wRow, 'TRUE');
          } catch (we) {
            _jrn(deps, jobId, batchId, wItemId, wReqHash, wUuid, dry, 'UNKNOWN', null, wKeeper);
            results.push({ row: wRow, ok: false, wrote: false, reason: 'WRITE_FLUSH_EXCEPTION', state: 'UNKNOWN', error: String(we && we.message || we) });
            anyFail = true; writeStopped = true; continue;
          }
          if (!wroteOk) {
            _jrn(deps, jobId, batchId, wItemId, wReqHash, wUuid, dry, 'UNKNOWN', null, wKeeper);
            results.push({ row: wRow, ok: false, wrote: false, reason: 'WRITE_FAILED_UNCONFIRMED', state: 'UNKNOWN' });
            anyFail = true; writeStopped = true; continue;
          }
          var wrAfter = null;
          try { wrAfter = deps.readProdO(wRow); } catch (re) {
            _jrn(deps, jobId, batchId, wItemId, wReqHash, wUuid, dry, 'UNKNOWN', null, wKeeper);
            results.push({ row: wRow, ok: false, wrote: true, reason: 'WRITE_UNCONFIRMED', state: 'UNKNOWN', error: String(re && re.message || re) });
            anyFail = true; writeStopped = true; continue;
          }
          if (norm._sdNormO(wrAfter) !== 'TRUE') {
            _jrn(deps, jobId, batchId, wItemId, wReqHash, wUuid, dry, 'UNKNOWN', 'WRITE_NOT_CONFIRMED', wKeeper);
            results.push({ row: wRow, ok: false, wrote: true, reason: 'WRITE_NOT_CONFIRMED', state: 'UNKNOWN', actual: String(wrAfter) });
            anyFail = true; writeStopped = true; continue;
          }
          var _rr = { row: wRow, ok: true, wrote: true, level: wLevel, requestHash: wReqHash, uuid: wUuid, keeperRow: wKeeper, state: 'CONFIRMED_SUCCESS' };
          results.push(_rr);
          patched++; wroteRows.push(_rr);
        } else {
          // Tom X 批·三(2)：dry 成功必须明确为 DRY_SUCCESS（预检/探测成功，非写成功）；
          // 不得与真写成功的 CONFIRMED_SUCCESS 混淆 —— wrote:false 已表明未写，状态再显式区分。
          results.push({ row: wRow, ok: true, wrote: false, level: wLevel, state: 'DRY_SUCCESS' });
        }
      }
    }
    // 写后主库版本复核（Tom #6：读前后绑定）—— 本批次只写生产 O 列，主库版本必须不变；
    //   若前后不一致，说明快照在读期间已被改动，已写行的归属不能确认为本请求所为 → UNKNOWN。
    // v6（Tom #3）：完成协议状态机。复核通过后才逐行落 COMMITTED；复核漂移则 VOID 已写行，
    //   绝不产生「写已发生但无/错凭证」的可被误读为最终成功的 COMMITTED。
    //   崩溃窗口（写后/复核前进程终止）恢复为 UNKNOWN（无 COMMITTED 日志），禁止自动重写。
    if (wroteRows.length) {
      var mAfter = null;
      try { mAfter = (typeof deps.readAllMaster === 'function') ? deps.readAllMaster() : null; } catch (ma) { mAfter = null; }
      var mAfterV = (mAfter && mAfter.version) ? String(mAfter.version) : null;
      var _drift = !mAfter || !mAfter.complete || !mAfterV || mAfterV !== String(master.version);
      if (_drift) {
        for (var w = 0; w < wroteRows.length; w++) {
          wroteRows[w].ok = false;
          wroteRows[w].wrote = true;
          wroteRows[w].state = 'UNKNOWN';
          wroteRows[w].reason = 'MASTER_VERSION_DRIFT_POST_WRITE';
          // 持久化失效：逐行追加 VOIDED，按 _findCommit 的 VOIDED > COMMITTED 优先级覆盖后续查询结论。
          // v2（Tom #3）：必须检查 VOIDED 日志返回值 —— 若追加失败，显式保持 UNKNOWN（不得当已持久失效），
          //   且状态查询不得恢复成 COMMITTED（见 tsSoftDelStatus 的 PREPARED→UNKNOWN 与 _findCommit）。
          var _vOk = journal(deps, jobId, batchId, wroteRows[w].row, wroteRows[w].requestHash,
            'VOIDED', wroteRows[w].uuid, 'MASTER_VERSION_DRIFT_POST_WRITE', wroteRows[w].keeperRow);
          if (!_vOk) wroteRows[w].reason = 'VOIDED_LOG_FAILED';
        }
        anyFail = true;
      } else {
        // 复核通过 → 仅此刻落 COMMITTED；若某行 COMMITTED 落盘失败，标记 UNKNOWN（写可能已发生），不谎称 COMMITTED。
        for (var w2 = 0; w2 < wroteRows.length; w2++) {
          var _cOk = journal(deps, jobId, batchId, wroteRows[w2].row, wroteRows[w2].requestHash,
            'COMMITTED', wroteRows[w2].uuid, null, wroteRows[w2].keeperRow);
          if (!_cOk) {
            wroteRows[w2].ok = false; wroteRows[w2].state = 'UNKNOWN'; wroteRows[w2].reason = 'COMMITTED_LOG_FAILED';
            anyFail = true;
          } else {
            wroteRows[w2].state = 'COMMITTED';
          }
        }
      }
      masterVersionAfter = mAfterV;
    }
  } finally {
    try { if (deps.releaseLock) deps.releaseLock(_lock); } catch (rl) {}
    try { if (deps.releaseMasterLock && _mlock) deps.releaseMasterLock(_mlock); } catch (rl2) {}
  }
  // 诚实上报：任一失败 → 批次 ok=false（不暗示原子回滚）
  // v6（Tom #1）：写响应显式带 action，使真实客户端（经 RemoteTrigger 透传后）可校验 action 必填且等于 softDelGuarded。
  return _res(!anyFail, { action: 'softDelGuarded', batchId: batchId, jobId: jobId, dry: dry, patched: patched, total: rows.length, results: results,
    masterVersion: String(master.version || ''), masterVersionAfter: masterVersionAfter });
}

// 条件 #4 强制日志：返回布尔。缺失依赖或写抛异常 → false（调用方据此阻断写）。
// 记录中持久保存【原请求身份】：jobId + subBatchId + itemId + requestHash + uuid，供状态查询逐项绑定。
// v6（Tom #4）：日志持久化【完整身份】，含 keeperRow —— 状态查询可据 entry.keeperRow 复核
//   当前 keeper 行仍有效（未被软标/未被换），不能仅凭「原日志 + 当前 O=TRUE」就归属本请求。
function journal(deps, jobId, subBatchId, itemId, requestHash, state, uuid, reason, keeperRow) {
  if (typeof deps.journalAppend !== 'function') return false;
  // v2（Tom #4）：把 keeper 当前 UUID + 负载指纹绑定进日志 —— 供 status 实时比对 drift。
  //   从 keeperRow 实时读取（与核心 it.keeperHash 同算法，timeOnly=false 全量指纹；status 侧同口径比对）。
  var keeperUuid = null, keeperHash = null;
  if (keeperRow != null && typeof deps.readProdRow === 'function') {
    try {
      var _kr = deps.readProdRow(Number(keeperRow));
      if (_kr && Array.isArray(_kr)) {
        keeperUuid = norm._sdNorm(_kr[8]);
        keeperHash = (_sdRowHash ? _sdRowHash(_kr, false) : null);
      }
    } catch (_ke) {}
  }
  try {
    // Tom X 批·三(2) 根因修复：此前仅捕获「异常」却**无视 journalAppend 的布尔返回值**，
    // 导致"日志写失败但返回 false（非抛异常）"被当成成功 —— COMMITTED 失败永不触发 UNKNOWN。
    // 现显式接收返回值：false ⇒ 写失败 ⇒ journal 返回 false（调用方据此标记 UNKNOWN，不谎称 COMMITTED）；
    // 仅当显式 false 才判失败，其余真值（含旧式无返回值）保持成功语义，不破坏现有契约。
    var _appended = deps.journalAppend({ jobId: jobId, subBatchId: subBatchId, itemId: itemId, requestHash: requestHash,
      state: state, uuid: uuid == null ? null : String(uuid),
      reason: reason == null ? null : String(reason),
      keeperRow: keeperRow == null ? null : Number(keeperRow),
      keeperUuid: keeperUuid, keeperHash: keeperHash,
      ts: Date.now() });
    return _appended !== false;
  } catch (e) {
    return false;   // 日志写抛异常 → 返回 false，绝不吞掉后假装成功
  }
}

// v5（Tom 第 2 项）：dry 不写【任何】业务恢复日志 —— 含全部拒绝分支，不只是 PREPARED 路径。
//   理由：dry 不产生任何写入，也就没有「待恢复」状态；若 dry 也留 REJECTED 痕，
//   后续状态查询会把一次 dry 的拒绝误读成「本请求已落盘待裁定」。
//   dry 时返回 true（=无需日志，不阻断流程）；非 dry 时与 journal 等价。
function _jrn(deps, jobId, subBatchId, itemId, requestHash, uuid, dry, state, reason, keeperRow) {
  if (dry) return true;
  return journal(deps, jobId, subBatchId, itemId, requestHash, state, uuid, reason, keeperRow);
}

// ---- 日志身份检索（Tom #4：不得只取「最后一条」，必须按 requestHash/subBatchId/uuid 绑定）----
// 返回该 jobId+itemId 下的全部日志（append 顺序）。deps.journalList 为权威；缺失则退化为单条 journalGet。
// v5（Tom 第 2 项）：日志【不可读取】必须可与「无记录」区分 —— 读失败返回哨兵 {__readError:true}，
//   绝不再退化为 []（否则调用方会把「读不到」当成「没有历史 ⇒ 允许新写」，正是被指出的缺陷）。
function _journalRecords(deps, jobId, itemId) {
  if (typeof deps.journalList === 'function') {
    try {
      var recs = deps.journalList(jobId, itemId);
      if (Array.isArray(recs)) return recs;
      return { __readError: true, detail: 'JOURNAL_LIST_NOT_ARRAY' };
    } catch (e) {
      return { __readError: true, detail: String(e && e.message || e) };
    }
  }
  if (typeof deps.journalGet === 'function') {
    try {
      var one = deps.journalGet(jobId, itemId);
      return one ? [one] : [];
    } catch (e2) {
      return { __readError: true, detail: String(e2 && e2.message || e2) };
    }
  }
  return { __readError: true, detail: 'NO_JOURNAL_READ_DEP' };
}
function _isReadError(recs) { return !!(recs && recs.__readError); }
// 按【完整请求身份】定位完成凭据（v5，Tom 第 1 项）：
//   requestHash / subBatchId / uuid 三字段【全部相等】才算命中；
//   记录在任一声明字段上为 null/undefined ⇒ 视为不可用（不再「缺失即跳过」）。
// v5（Tom 第 2 项）：**先扫失效记录**（VOIDED / UNKNOWN），优先级 **VOIDED > COMMITTED** ——
//   此前写后漂移只在内存里标记、不落日志，导致 COMMITTED 被后续查询优先命中、漂移被永久遗忘。
//   命中失效记录时返回 {__voided:true, record}，调用方须据此拒绝，不得再走幂等成功路径。
function _findCommit(records, requestHash, subBatchId, uuid) {
  for (var v = records.length - 1; v >= 0; v--) {
    var rv = records[v];
    if (!rv || rv.dry === true) continue;
    if (rv.state !== 'VOIDED' && rv.state !== 'UNKNOWN') continue;
    if (rv.requestHash !== requestHash) continue;
    if (subBatchId != null && rv.subBatchId != null && String(rv.subBatchId) !== String(subBatchId)) continue;
    if (uuid != null && rv.uuid != null && String(rv.uuid) !== String(uuid)) continue;
    return { __voided: true, record: rv };
  }
  for (var i = records.length - 1; i >= 0; i--) {
    var r = records[i];
    if (!r || r.state !== 'COMMITTED' || r.dry === true) continue;
    if (r.requestHash !== requestHash) continue;
    if (subBatchId != null && (r.subBatchId == null || String(r.subBatchId) !== String(subBatchId))) continue;
    if (uuid != null && (r.uuid == null || String(r.uuid) !== String(uuid))) continue;
    return r;
  }
  return null;
}
// 任一完成凭据（不论 requestHash）—— 用于「同键复用冲突」判定
function _findAnyCommit(records) {
  for (var j = records.length - 1; j >= 0; j--) {
    var q = records[j];
    if (q && q.state === 'COMMITTED' && q.dry !== true) return q;
  }
  return null;
}
function _lastRecord(records) {
  for (var k = records.length - 1; k >= 0; k--) if (records[k]) return records[k];
  return null;
}

// 条件 #5：只读批次日志查询 —— 逐项绑定原 manifest（jobId + subBatchId + requestHash + uuid）；
//   身份不符 / 读失败一律 UNKNOWN；O=TRUE 来源不明 ≠ 完成；COMMITTED 与回读 O 矛盾 → UNKNOWN。
function tsSoftDelStatus(e, deps) {
  var p = e.parameter || {};
  var body = e.postBody || {};
  var jobId = body.jobId || p.jobId || null;
  var defBatch = (body.batchId != null) ? body.batchId : ((p.batchId != null) ? p.batchId : null);
  var rows = body.rows || p.rows || [];
  if (!Array.isArray(rows)) rows = [];
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var rq = rows[i] || {};
    var itemId = (rq && rq.row != null) ? Number(rq.row) : Number(rq);
    var wantHash = (rq.requestHash != null) ? String(rq.requestHash) : null;
    var wantBatch = (rq.subBatchId != null) ? String(rq.subBatchId)
      : ((rq.batchId != null) ? String(rq.batchId) : (defBatch != null ? String(defBatch) : null));
    var wantUuid = (rq.uuid != null) ? String(rq.uuid) : null;

    var recs = _journalRecords(deps, jobId, itemId);
    if (_isReadError(recs)) {
      out.push({ jobId: jobId, itemId: itemId, subBatchId: null, requestHash: null, uuid: null,
        state: 'UNKNOWN', journalState: null, identity: 'JOURNAL_READ_ERROR',
        oValue: null, oReadError: recs.detail });
      continue;
    }
    var _fc = wantHash ? _findCommit(recs, wantHash, wantBatch, wantUuid) : null;
    // 命中失效记录 ⇒ 状态即 VOIDED/UNKNOWN，优先级高于 COMMITTED
    var entry = _fc ? ((_fc.__voided ? _fc.record : _fc) || _lastRecord(recs)) : _lastRecord(recs);

    // 身份绑定校验（v5，Tom 第 1 项）：改为【必需字段白名单】。
    //   ① 查询方本身必须声明完整身份（jobId/subBatchId/requestHash/uuid），缺任一即不可判定；
    //   ② 日志记录上这些字段为 null/undefined/'' 即判失败（不再「字段缺失就跳过比较」）；
    //   ③ 声明值与记录值逐一严格相等。
    var identityOk = true, identityWhy = '';
    if (!wantHash || !wantBatch || !wantUuid || !jobId) {
      identityOk = false; identityWhy = 'INCOMPLETE_QUERY_IDENTITY';
    } else if (entry) {
      var REQ_FIELDS = [['requestHash', entry.requestHash], ['subBatchId', entry.subBatchId],
        ['uuid', entry.uuid], ['jobId', entry.jobId], ['itemId', entry.itemId]];
      for (var fi = 0; fi < REQ_FIELDS.length; fi++) {
        var fv = REQ_FIELDS[fi][1];
        if (fv === null || fv === undefined || fv === '') {
          identityOk = false; identityWhy = 'MISSING_' + REQ_FIELDS[fi][0].toUpperCase(); break;
        }
      }
      if (identityOk) {
        if (String(entry.requestHash) !== wantHash) { identityOk = false; identityWhy = 'REQUEST_HASH_MISMATCH'; }
        else if (String(entry.subBatchId) !== wantBatch) { identityOk = false; identityWhy = 'SUBBATCH_MISMATCH'; }
        else if (String(entry.uuid) !== wantUuid) { identityOk = false; identityWhy = 'UUID_MISMATCH'; }
        else if (String(entry.itemId) !== String(itemId)) { identityOk = false; identityWhy = 'ITEM_MISMATCH'; }
        else if (String(entry.jobId) !== String(jobId)) { identityOk = false; identityWhy = 'JOB_MISMATCH'; }
      }
    }

    // v6（Tom #4）：状态查询也须复核【当前】keeper 行仍有效（未被软标/未被换）。
    //   原 COMMITTED 日志只证明「当时」keeper 有效；若后续 keeper 行被改写/软标，凭据失效，不能归属本请求。
    if (identityOk && entry && entry.keeperRow != null) {
      var _kRow = null, _kErr = null;
      try { _kRow = deps.readProdRow ? deps.readProdRow(Number(entry.keeperRow)) : null; } catch (ke2) { _kErr = String(ke2 && ke2.message || ke2); }
      if (_kErr || !_kRow || _sdSoftDel(_kRow[14])) {
        identityOk = false; identityWhy = 'KEEPER_DRIFT_ON_STATUS';
      } else {
        // v2（Tom #4）：当前 keeper UUID / 负载指纹与【日志绑定值】比对，任一漂移即失效（不可归属本请求）。
        var _kUuid = norm._sdNorm(_kRow[8]);
        var _kHash = (_sdRowHash ? _sdRowHash(_kRow, false) : null);
        if (String(_kUuid) !== String(entry.keeperUuid)) { identityOk = false; identityWhy = 'KEEPER_UUID_DRIFT_ON_STATUS'; }
        else if (entry.keeperHash != null && String(_kHash) !== String(entry.keeperHash)) { identityOk = false; identityWhy = 'KEEPER_HASH_DRIFT_ON_STATUS'; }
      }
    }

    var oVal = null, oErr = null;
    try { oVal = deps.readProdO ? deps.readProdO(itemId) : null; }
    catch (re) { oErr = String(re && re.message || re); }
    var oTrue = (norm._sdNormO(oVal) === 'TRUE');

    var state;
    if (oErr) {
      state = 'UNKNOWN';                       // 读失败 → 不明，绝不乐观断言
    } else if (!entry) {
      state = oTrue ? 'O_TRUE_SOURCE_UNKNOWN' : 'UNKNOWN';
    } else if (!identityOk) {
      state = 'UNKNOWN';                       // 身份不符 → 不能归属本请求
    } else if (entry.state === 'COMMITTED') {
      state = oTrue ? 'COMMITTED' : 'UNKNOWN';
    } else if (entry.state === 'UNKNOWN') {
      state = 'UNKNOWN';
    } else if (entry.state === 'REJECTED') {
      state = 'REJECTED';
    } else if (entry.state === 'PREPARED') {
      // v2（Tom #3）：PREPARED 仅表示「计划写/已占位」，不可读作成功；未落 COMMITTED/VOIDED 必须 UNKNOWN，
      //   杜绝「写发生但无凭证」被误判为最终成功（VOIDED 日志失败亦落此路径）。
      state = 'UNKNOWN';
    } else {
      state = entry.state;
    }
    out.push({ jobId: jobId, itemId: itemId, subBatchId: entry ? entry.subBatchId : null,
      requestHash: entry ? entry.requestHash : null, uuid: entry ? entry.uuid : null,
      state: state, journalState: entry ? entry.state : null,
      identity: identityOk ? 'BOUND' : identityWhy, oValue: oVal, oReadError: oErr });
  }
  // v6（Tom #1）：状态查询响应显式带 action + jobId + 精确 version（_res 已注入 version），客户端据此校验身份契约。
  return _res(true, { action: 'statusQuery', jobId: jobId, batchId: jobId, rows: out });
}

// ============================================================
// GAS 包装器（依赖注入）：把 GAS 原生 API 适配成 tsSoftDelGuardedCore 的 deps。
// 这是 GAS 端【唯一】与 Node 不同的代码（仅依赖装配，不含任何业务判定）。
// 业务判定全部在上方内联的 tsSoftDelGuardedCore 中，与 Node 模块逐字一致。
// ============================================================
var TS_ID = '1Pi5u9fEawgp7yICWPMMyQCT_LbwTZthQDW-H05xYdVI';
var PL_DB_SHEET = 'DB_工时流水';
var MASTER_ID = '1oxPj0mzN8poP2vQ7Bm-YKXuU49p9b0c1asyrZn4Py44';
var BASE_TAB = '工时_候选0824';

// 强制日志（持久化到 _TS_SOFTDEL_LOG 页签）；写失败向上抛出（由核心判 UNKNOWN/阻断）。
function _sdGasJournalAppend(rec) {
  var ss = SpreadsheetApp.openById(TS_ID);
  var js = ss.getSheetByName('_TS_SOFTDEL_LOG');
  // v5：新增 reason 列 —— VOIDED 记录必须能说明「为什么失效」，否则失效只有状态没有依据。
  if (!js) { js = ss.insertSheet('_TS_SOFTDEL_LOG'); js.appendRow(['ts', 'jobId', 'subBatchId', 'itemId', 'requestHash', 'uuid', 'state', 'reason']); }
  js.appendRow([Utilities.formatDate(new Date(), 'GMT+8', 'yyyy-MM-dd HH:mm:ss'),
    rec.jobId, rec.subBatchId, rec.itemId, rec.requestHash, rec.uuid, rec.state, rec.reason]);
}
function _sdGasJournalGet(jobId, itemId) {
  try {
    var ss = SpreadsheetApp.openById(TS_ID);
    var js = ss.getSheetByName('_TS_SOFTDEL_LOG');
    if (!js) return null;
    var g = js.getDataRange().getValues();
    for (var i = g.length - 1; i >= 1; i--) {
      if (String(g[i][1] || '') === String(jobId) && String(g[i][3] || '') === String(itemId)) {
        return { jobId: g[i][1], subBatchId: g[i][2], itemId: g[i][3], requestHash: g[i][4], uuid: g[i][5], state: g[i][6], reason: g[i][7] };
      }
    }
  } catch (e) {}
  return null;
}
// 全量日志（Tom #4）：状态查询/幂等检索必须能看到该 jobId+itemId 下的【全部】记录，
// 不能只取「最后一条」—— 否则不同 requestHash 的冲突记录会遮蔽原完成凭据。
function _sdGasJournalList(jobId, itemId) {
  try {
    var ss = SpreadsheetApp.openById(TS_ID);
    var js = ss.getSheetByName('_TS_SOFTDEL_LOG');
    if (!js) return [];
    var g = js.getDataRange().getValues();
    var out = [];
    for (var i = 1; i < g.length; i++) {
      if (String(g[i][1] || '') === String(jobId) && String(g[i][3] || '') === String(itemId)) {
        out.push({ jobId: g[i][1], subBatchId: g[i][2], itemId: g[i][3], requestHash: g[i][4], uuid: g[i][5], state: g[i][6], reason: g[i][7] });
      }
    }
    return out;
  } catch (e) { return []; }
}

function _sdGasLock() {
  var lk = LockService.getScriptLock();
  if (!lk.tryLock(30000)) throw new Error('LOCK_BUSY');
  return lk;
}

function tsSoftDelGuarded(e) {
  e = e || {};
  var p = e.parameter || {};
  var body = e.postBody || {};
  try {
    var sheetName = String(p.sheet || body.sheet || PL_DB_SHEET);
    var prodSs = SpreadsheetApp.openById(TS_ID);
    var sh = prodSs.getSheetByName(sheetName);
    if (!sh) return JSON.stringify({ ok: false, error: 'sheet not found: ' + sheetName });
    var mss = SpreadsheetApp.openById(MASTER_ID);
    var msh = mss.getSheetByName(BASE_TAB);

    // 真实策略读取（v5 B2）：把 PropertiesService 注入 pl._plPolicyFromProps。
    // propsGetter 抛错时由 _plPolicyFromProps 内部收敛为 fail-closed，此处不再额外吞异常。
    function _sdGasPolicy() {
      return pl._plPolicyFromProps(function (k) {
        return PropertiesService.getScriptProperties().getProperty(k);
      });
    }

    var deps = {
      PL_DB_SHEET: PL_DB_SHEET,
      isClearance: function (tok, rows) { return false; },          // 默认不放开门禁
      guardCheck: function (bizDate, origBiz, policy) { return pl._plGuardCheck(bizDate, origBiz, policy || _sdGasPolicy()); },
      // v5 B2（Tom 第 4 项）：policy 改为【真实读取生产 PropertiesService 策略】。
      //   此前固定返回 pl._plPolicy()（source:'unset'），等于生产策略从未被执行入口遵守。
      //   _plPolicyFromProps 内部 fail-closed：读取异常 / 哨兵未知 / 策略丢失 /
      //   JSON 损坏 / schema 非法 一律收紧（closed=true, futureOpen=false）。
      //   边界：**只读**，不初始化、不改写生产策略。
      policy: _sdGasPolicy,
      // 诚实声明：LockService.getScriptLock() 按 Google 官方说明【仅作用于脚本】，
      // 只能序列化本项目内的并发执行；不提供跨项目/跨文档互斥，本处不声称跨项目写协调。
      acquireMasterLock: _sdGasLock,                                  // 本项目内并发串行化（先取）
      acquireLock: _sdGasLock,                                        // 同锁可重入（后取）
      releaseLock: function (lk) { try { lk.releaseLock(); } catch (e) {} },
      releaseMasterLock: function (lk) { try { lk.releaseLock(); } catch (e) {} },
      readProdRow: function (row) { try { return sh.getRange(row, 1, 1, 15).getValues()[0]; } catch (e) { return null; } },
      // Tom #4：读失败必须向上抛出（让核心登记 UNKNOWN），不能吞成 null 冒充「读到了空值」。
      readProdO: function (row) { return sh.getRange(row, 15).getValue(); },
      // Tom #4：区分「未写」与「已写但未确认」—— setValue 失败 = 未写（false）；
      //   setValue 成功但 flush 失败 = 写可能已发生、无法确认 → 抛出，由核心记 UNKNOWN，
      //   绝不返回 false 让核心误判为「已确认未写」。
      writeProdO: function (row, val) {
        try { sh.getRange(row, 15).setValue(val); }
        catch (e) { return false; }
        try { SpreadsheetApp.flush(); }
        catch (fe) { throw new Error('FLUSH_FAILED: ' + (fe && fe.message || fe)); }
        return true;
      },
      readAllMaster: function () {
        try {
          if (!msh) return { map: {}, complete: false, error: 'MASTER_TAB_MISSING', version: null };
          var last = msh.getLastRow();
          var map = {}, vals = [];
          if (last > 1) {
            vals = msh.getRange(1, 1, last, 15).getValues();
            for (var r = 0; r < vals.length; r++) {
              var u = norm._sdNorm(vals[r][8]);
              if (u) (map[u] = map[u] || []).push({ row: r + 1, cells: vals[r] });
            }
          }
          // version：主库内容指纹（真实快照，内容变则版本变）。
          // Tom #6：指纹必须覆盖【全部相关列 0..14】并绑定 rowCount ——
          //   只覆盖 1..9 列会让 0/10..14 列的改动（含同 rowCount 改值）不触发版本变化。
          var allCols = []; for (var ci = 0; ci <= 14; ci++) allCols.push(ci);
          var fp = norm._sdSha256(JSON.stringify({
            rowCount: vals.length,
            rows: vals.map(function (row) { return norm._sdCanonRow(row, allCols); })
          }));
          return { map: map, complete: true, version: fp };
        } catch (e) { return { map: {}, complete: false, error: String(e && e.message || e), version: null }; }
      },
      journalAppend: _sdGasJournalAppend,                              // 强制日志依赖
      journalGet: _sdGasJournalGet,
      journalList: _sdGasJournalList                                   // 全量日志（身份检索用）
    };
    return tsSoftDelGuardedCore(e, deps);
  } catch (err) {
    return JSON.stringify({ ok: false, error: String(err && err.message || err), patched: 0 });
  }
}

