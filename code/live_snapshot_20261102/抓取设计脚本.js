/**
 * 🔄 抓取设计脚本.gs (V3.5.4 智能兼容版)
 * 修复说明：升级获取目标表为智能模糊匹配，彻底解决因标签页名称含有隐藏空格而报错找不到的问题。
 */
function fetchArchiveData() {
  var sourceSpreadsheetId = '1UT1ySw3ByHd1BGUAq1FquJNg4dliwhd8VhhEak_W0IQ';
  var sourceSheetName = 'Archive_归档'; 
  
  var sourceSpreadsheet = SpreadsheetApp.openById(sourceSpreadsheetId);
  var sourceSheet = sourceSpreadsheet.getSheetByName(sourceSheetName);
  if (!sourceSheet) { SpreadsheetApp.getUi().alert('错误：找不到源文件中的“Archive_归档”工作表。'); return; }

  var sourceData = sourceSheet.getDataRange().getValues();
  var destSpreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var destSheetName = '抓取设计的工时流水';
  
  // 【智能兼容修复】：遍历所有标签页，自动去除首尾空格并支持关键词模糊匹配，防止因肉眼看不见的空格报错
  var sheets = destSpreadsheet.getSheets();
  var destSheet = null;
  for (var s = 0; s < sheets.length; s++) {
    var currentTabName = sheets[s].getName().trim();
    if (currentTabName === destSheetName.trim() || currentTabName.indexOf('抓取设计') > -1) {
      destSheet = sheets[s];
      break;
    }
  }
  
  // 如果还是找不到，给出更具引导性的提示
  if (!destSheet) { 
    SpreadsheetApp.getUi().alert('错误：当前文件中找不到包含“抓取设计”的目标工作表，请检查该标签页是否被不小心删除了。'); 
    return; 
  }

  var destData = [];
  for (var i = 1; i < sourceData.length; i++) {
    var row = sourceData[i];
    if (!row[0] && !row[13]) continue;
    destData.push([
      row[13], row[13], getExactName(row[2]), "", "", row[0], row[12], row[4], "", row[1]
    ]);
  }

  if (destData.length > 0) {
    var lastRow = destSheet.getLastRow();
    if (lastRow > 1) {
      var lastColumn = destSheet.getLastColumn();
      // 清空旧数据时动态兼容列宽，防止清除范围越界
      destSheet.getRange(2, 1, lastRow, lastColumn > 10 ? lastColumn : 10).clearContent();
    }
    
    // 批量写入新抓取的数据
    destSheet.getRange(2, 1, destData.length, 10).setValues(destData);
    SpreadsheetApp.getActiveSpreadsheet().toast('已成功抓取 ' + destData.length + ' 条数据');
  } else {
    SpreadsheetApp.getUi().alert('源表中未发现有效数据。');
  }
}