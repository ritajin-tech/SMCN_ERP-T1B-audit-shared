/**
 * V4.3.80 受护栏的 B 列(业务日期)逐格还原 —— 只用单格 setValue(真实 Date)，避开巨型整块 setValues(已证本 Web App 静默不落盘)。
 * 经验：巨型整块 setValues(7594x26) 会让本次执行的写会话静默失效；单格 setValue 经验证可落盘(tsPatchCells 哨兵测试通过)。
 * 故本函数只做「读 I 列 UUID→行号(只读) → 逐格 setValue(new Date) 写 B → getDisplayValues 回读校验」，全程无巨型写。
 * 入参(GET/POST 均可，token 门控)：?action=fixBDates&token=...&data=uuid1@yyyy-MM-dd;uuid2@yyyy-MM-dd;...[&dry=1]
 * 护栏：仅写 B 列(列2)；UUID 不存在则 skip；日期格式非法则 bad；写后回读实际显示值返回(actualDisplay)供外部校验。
 */
function tsFixBDates(e) {
  e = e || {};
  var p = e.parameter || {};
  var body = (e.postBody && typeof e.postBody === 'object') ? e.postBody : {};
  var dry = ['1', 'true', 'TRUE', 'yes'].indexOf(String(p.dry || body.dry || '')) >= 0;
  var raw = String(p.data || body.data || '');
  var pairs = raw.split(';').filter(function (x) { return x.trim(); });
  try {
    var sh = getDbSheet();
    var last = sh.getLastRow();
    var uuids = sh.getRange(2, 9, Math.max(0, last - 1), 1).getValues();   // 只读 I 列
    var rowByUuid = {};
    for (var i = 0; i < uuids.length; i++) { var u = String(uuids[i][0] || '').trim(); if (u) rowByUuid[u] = i + 2; }
    var plan = [];   // {row, date}
    var skipped = 0, bad = 0, requested = pairs.length;
    for (var k = 0; k < pairs.length; k++) {
      var pa = pairs[k].split('@');
      if (pa.length < 2) { bad++; continue; }
      var uuid = pa[0].trim(), ds = pa[1].trim();
      var m = ds.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) { bad++; continue; }
      var row = rowByUuid[uuid];
      if (!row) { skipped++; continue; }
      plan.push({ row: row, date: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) });
    }
    var done = 0;
    if (!dry) {
      for (var q = 0; q < plan.length; q++) {
        sh.getRange(plan[q].row, 2).setValue(plan[q].date);   // 单格 setValue —— 经验证可落盘
        done++;
      }
    } else { done = plan.length; }
    var actualDisplay = {};
    if (plan.length) {
      var bDisp = sh.getRange(2, 2, Math.max(0, last - 1), 1).getDisplayValues();
      for (var r2 = 0; r2 < plan.length; r2++) { actualDisplay[plan[r2].row] = String(bDisp[plan[r2].row - 2][0]); }
    }
    _tsWriteLog('fixBDates' + (dry ? '(dry)' : ''), 'req=' + requested + ' done=' + done + ' skipped=' + skipped + ' bad=' + bad);
    return JSON.stringify({ ok: true, dry: dry, requested: requested, done: done, skipped: skipped, bad: bad, actualDisplay: actualDisplay });
  } catch (err) {
    return JSON.stringify({ ok: false, error: String((err && err.message) || err) });
  }
}

/**
 * V4.3.76 删除活表内全部「整行空白」行（含中部与尾部），回收活表预算。
 */
function tsDelBlankRows(e) {
  e = e || {};
  var p = e.parameter || {};
  var dry = ['1', 'true', 'TRUE', 'yes'].indexOf(String(p.dry || '')) >= 0;
  try {
    var sh = getDbSheet();
    var data = sh.getDataRange().getValues();
    var blankRows = [];
    for (var i = data.length - 1; i >= 1; i--) {
      var row = data[i];
      var isBlank = true;
      for (var c = 0; c < row.length; c++) { if (String(row[c] === null || row[c] === undefined ? '' : row[c]).trim() !== '') { isBlank = false; break; } }
      if (isBlank) blankRows.push(i + 1);
    }
    if (dry) return JSON.stringify({ ok: true, dry: true, action: 'delBlankRows', found: blankRows.length, rows: blankRows.slice(0, 80) });
    var deleted = 0;
    for (var j = 0; j < blankRows.length; j++) { try { sh.deleteRows(blankRows[j], 1); deleted++; } catch (err) {} }
    _tsWriteLog('delBlankRows', 'found=' + blankRows.length + ' deleted=' + deleted);
    return JSON.stringify({ ok: true, dry: false, action: 'delBlankRows', found: blankRows.length, deleted: deleted });
  } catch (err) { return JSON.stringify({ ok: false, error: String((err && err.message) || err) }); }
}
