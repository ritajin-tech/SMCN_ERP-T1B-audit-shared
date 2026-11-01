/**
 * V4.3.74 物理删除「整行空白 OR 软删」的死行（清理 3.2 万废行，回收活表预算）。
 * 复用 tsPurgeRows / tsPurgeSoftLeaves 的「读全表 → 过滤 → _tsSetValuesGuarded 写回(带B列日期护栏) → deleteRows 删尾」安全模式。
 * 死行定义：①整行全空（所有单元格 trim 后为空） ② O列(索引14) == TRUE（软删）。
 *   两类并集 ≈ 31844 空白 + 585 软删 = 32429（与 _archive_full_meta.json 一致）。
 * 护栏：?dry=1 先报会删多少，不真删；写后回读 B 列日期护栏防静默改坏；中途失败原数据仍在（先写回再删尾）。
 * 用法：?action=pruneDead[&dry=1]
 */
function tsPruneDead(e) {
  e = e || {};
  var p = e.parameter || {};
  var dry = ['1', 'true', 'TRUE', 'yes'].indexOf(String(p.dry || '')) >= 0;
  try {
    var sh = getDbSheet();
    var data = sh.getDataRange().getValues();
    var retained = [data[0]];           // 表头始终保留
    var removed = 0, removedBlank = 0, removedSoft = 0;
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      var isSoft = (row[14] === true || String(row[14]).toUpperCase() === 'TRUE');
      var isBlank = true;
      for (var c = 0; c < row.length; c++) {
        if (String(row[c] === null || row[c] === undefined ? '' : row[c]).trim() !== '') { isBlank = false; break; }
      }
      if (isBlank) { removed++; removedBlank++; continue; }
      if (isSoft) { removed++; removedSoft++; continue; }
      retained.push(row);
    }
    var keptData = retained.length - 1;
    if (dry) {
      return JSON.stringify({ ok: true, dry: true, action: 'pruneDead', total: data.length,
        removed: removed, removedBlank: removedBlank, removedSoft: removedSoft, wouldKeep: retained.length });
    }
    var dateFixed = 0;
    if (retained.length > 1) {
      dateFixed = _tsSetValuesGuarded(sh, retained, data);
    }
    var last = sh.getLastRow();
    if (last > retained.length) sh.deleteRows(retained.length + 1, last - retained.length);
    return JSON.stringify({ ok: true, dry: false, action: 'pruneDead', total: data.length,
      removed: removed, removedBlank: removedBlank, removedSoft: removedSoft, kept: retained.length, dateFixed: dateFixed });
  } catch (err) {
    return JSON.stringify({ ok: false, error: String((err && err.message) || err) });
  }
}
