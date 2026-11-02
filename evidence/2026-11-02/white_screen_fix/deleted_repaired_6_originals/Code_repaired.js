/**
 * 👑 TimeSheet Manager V4.0 RC (Release Candidate)
 * 核心升级：并发锁、软删除审计、全局抽象句柄、12位 Record ID、Token 深度清理
 */

var TS_ID = '1Pi5u9fEawgp7yICWPMMyQCT_LbwTZthQDW-H05xYdVI'; 
var BD_ID = '122GRtBPsk1KyEwFJ3QeolYO9jmyT1SmEB47cuohclKc'; 
var HR_ID = '1XZy2gxHEZAbWKW_BoBHkUd--Ozmv5uqcC6Uw6wJDWoQ'; 

function getDbSheet() { return SpreadsheetApp.openById(TS_ID).getSheetByName('DB_工时流水'); }
function getHrSpreadsheet() { return SpreadsheetApp.openById(HR_ID); }
function getProjectSpreadsheet() { return SpreadsheetApp.openById(BD_ID); }

var _hrNameCache = null;
function getExactName(rawName) {
  if (!rawName) return "";
  if (!_hrNameCache) {
    _hrNameCache = {};
    try {
      const ss = getHrSpreadsheet();
      ['员工通讯录', '离职名单'].forEach(sheetName => {
        const sheet = ss.getSheetByName(sheetName);
        if (sheet) {
          const data = sheet.getDataRange().getValues();
          for (let i = 4; i < data.length; i++) {
            const exact = data[i][4] ? String(data[i][4]).trim() : ""; 
            if (exact) {
              const searchKey = exact.toLowerCase().replace(/[._-]/g, ' ').replace(/\s+/g, ' ').trim();
              if (!_hrNameCache[searchKey]) _hrNameCache[searchKey] = exact;
            }
          }
        }
      });
    } catch(e) {}
  }
  let lookupKey = String(rawName).replace(/on leave/i, '').trim().toLowerCase().replace(/[._-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (_hrNameCache[lookupKey]) return _hrNameCache[lookupKey];
  // V4.3.29: 容错——日历/外部姓名常只填 handle 或名(如 "aien")，而 HR 名册列存全名("Aien Wang")，
  // 精确键缺失会令该员工请假/工时记录被出勤自检·看板按姓名过滤时静默丢失（如 aien 请假不进出勤自检）。
  // 退化为「首词前缀唯一命中」：lookupKey 等于某 HR 键的首词且唯一时，回退到该全名；多命中/无命中保持原 raw(保守，避免跨人误判)。
  const _kList = Object.keys(_hrNameCache);
  const _hits = [];
  for (let _k = 0; _k < _kList.length; _k++) {
    const _c = _kList[_k];
    if (_c.indexOf(lookupKey + ' ') === 0) _hits.push(_hrNameCache[_c]);
  }
  if (_hits.length === 1) return _hits[0];
  return String(rawName).replace(/on leave/i, '').trim();
}

function getHrMap() {
  const cache = CacheService.getScriptCache();
  let cachedMap = cache.get('SYS_HR_MAP');
  if (cachedMap) return JSON.parse(cachedMap);

  const lock = LockService.getScriptLock();
  lock.waitLock(5000); 
  try {
    cachedMap = cache.get('SYS_HR_MAP');
    if (cachedMap) return JSON.parse(cachedMap);

    const ss = getHrSpreadsheet();
    const userMap = {};
    ['员工通讯录', '离职名单'].forEach(sheetName => {
      const sheet = ss.getSheetByName(sheetName);
      if (sheet) {
        const data = sheet.getDataRange().getValues();
        for (let i = 4; i < data.length; i++) {
          const emailKey = data[i][9] ? String(data[i][9]).toLowerCase().replace(/\s+/g, '').trim() : ""; 
          if (emailKey && emailKey.length > 5 && !userMap[emailKey]) {
            userMap[emailKey] = { name: data[i][4] ? String(data[i][4]).trim() : "", leader: data[i][10] || "TBD", dept: data[i][5] ? String(data[i][5]).trim() : "" };
          }
        }
      }
    });
    cache.put('SYS_HR_MAP', JSON.stringify(userMap), 1800);
    return userMap;
  } finally {
    lock.releaseLock();
  }
}

function formatPid(id) { 
  if (!id) return ""; 
  let v = String(id).trim().toUpperCase(); 
  if (/^\d{5}$/.test(v)) return v.substring(0, 2) + "-" + v.substring(2); 
  return v; 
}

function getProjectMap() {
  const cache = CacheService.getScriptCache();
  let cachedPMap = cache.get('SYS_PROJECT_MAP');
  if (cachedPMap) return JSON.parse(cachedPMap);

  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    cachedPMap = cache.get('SYS_PROJECT_MAP');
    if (cachedPMap) return JSON.parse(cachedPMap);

    const data = getProjectSpreadsheet().getSheets()[0].getDataRange().getValues();
    const pMap = { "OFF-WORK": "OFF-WORK / Leave", "INTERNAL": "INTERNAL / Internal" }; 
    for (let i = 1; i < data.length; i++) {
      let id = formatPid(data[i][0]);
      if (id && !pMap[id]) pMap[id] = data[i][1] || "Unnamed / 未命名"; 
    }
    cache.put('SYS_PROJECT_MAP', JSON.stringify(pMap), 1800);
    return pMap;
  } catch (e) { 
    return { "OFF-WORK": "OFF-WORK / Leave", "INTERNAL": "INTERNAL / Internal" }; 
  } finally {
    lock.releaseLock();
  }
}

function safeGetUuid(cellValue) {
  if (cellValue === null || cellValue === undefined) return "";
  if (cellValue instanceof Date) return cellValue.getTime().toString();
  return String(cellValue).trim();
}

// 前端自动版本检测用：每次发版改这个数字，旧版 HTML 加载时会发现不匹配并自动重载
const TS_APP_VERSION = '4.3.44';

function getAppVersion() {
  return { version: TS_APP_VERSION };
}

function doGet(e) { 
  var r = _rtMaybeHandle(e); if (r) return r;
  return HtmlService.createTemplateFromFile('Index')
         .evaluate()
         .setTitle('TimeSheet Manager V4.0 RC')
         .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
         .addMetaTag('viewport', 'width=device-width, initial-scale=1'); 
}

function verifyUserAndGetToken(email) {
  if (!email) throw new Error("Email required / 邮箱不能为空");
  const cleanEmail = email.toLowerCase().replace(/\s+/g, '').trim();
  const hr = getHrMap()[cleanEmail];
  
  if (!hr || !hr.name) throw new Error("Email not authorized in HR directory / 该邮箱未授权");

  const token = "TS-" + Utilities.getUuid().replace(/-/g, '').substring(0, 16);
  const tokenData = { email: cleanEmail, expire: Date.now() + 7 * 24 * 60 * 60 * 1000 };
  
  CacheService.getScriptCache().put(token, JSON.stringify(tokenData), 21600);
  PropertiesService.getScriptProperties().setProperty('AUTH_' + token, JSON.stringify(tokenData));
  
  return { token: token, name: hr.name };
}

function getCurrentUser(token) {
  if (!token) throw new Error("AUTH_FAILED:Unauthorized access / 未授权访问");
  
  const cache = CacheService.getScriptCache();
  const props = PropertiesService.getScriptProperties();
  let tokenStr = cache.get(token) || props.getProperty('AUTH_' + token);
  
  if (!tokenStr) throw new Error("AUTH_FAILED:Session expired. Please logout and verify again. / 登录已过期");
  
  const tokenData = JSON.parse(tokenStr);
  
  if (Date.now() > tokenData.expire) {
    props.deleteProperty('AUTH_' + token);
    cache.remove(token);
    throw new Error("AUTH_FAILED:Session exceeded 7 days. Please login again. / 登录会话已过期");
  }

  cache.put(token, JSON.stringify(tokenData), 21600); 

  const hr = getHrMap()[tokenData.email];
  if (!hr || !hr.name) throw new Error("AUTH_FAILED:Account permission error / 账号权限异常");
  
  return hr;
}

function cleanupExpiredTokens() {
  const props = PropertiesService.getScriptProperties();
  const cache = CacheService.getScriptCache();
  const keys = props.getKeys();
  const now = Date.now();
  let deletedCount = 0;

  keys.forEach(key => {
    if (key.startsWith('AUTH_')) {
      try {
        const tokenData = JSON.parse(props.getProperty(key));
        if (now > tokenData.expire) {
          props.deleteProperty(key);
          cache.remove(key.replace('AUTH_', '')); 
          deletedCount++;
        }
      } catch (e) {
        props.deleteProperty(key); 
      }
    }
  });
  console.log(`[Nightly Audit] Token 清理完毕，移除了 ${deletedCount} 个过期令牌。`);
}

function getDashboardData(token, timeRange) {
  const user = getCurrentUser(token);
  const myName = user.name;
  const today = new Date();
  
  let startOfRange, endOfRange, dateRangeStr;
  if (timeRange === 'month') {
    startOfRange = new Date(today.getFullYear(), today.getMonth(), 1);
    endOfRange = new Date(today.getFullYear(), today.getMonth() + 1, 0, 23, 59, 59, 999); 
    dateRangeStr = "This Month / 本月";
  } else {
    let weekOffset = parseInt(timeRange) || 0;
    const dayOfWeek = today.getDay() === 0 ? 7 : today.getDay(); 
    startOfRange = new Date(today.getFullYear(), today.getMonth(), today.getDate() - dayOfWeek + 1 - (weekOffset * 7));
    endOfRange = new Date(startOfRange.getFullYear(), startOfRange.getMonth(), startOfRange.getDate() + 6, 23, 59, 59, 999); 
    dateRangeStr = "Week / 周概览 (" + Utilities.formatDate(startOfRange, "GMT+8", "MM/dd") + " - " + Utilities.formatDate(endOfRange, "GMT+8", "MM/dd") + ")";
  }

  const tsData = getDbSheet().getDataRange().getValues();
  let logs = [], matrix = {}; 
  
  for (let i = 1; i < tsData.length; i++) {
    const dv = tsData[i][14];
    if (dv === true || String(dv).toUpperCase() === "TRUE") continue;
    
    if (getExactName(tsData[i][2]) !== myName) continue;
    const rowProject = String(tsData[i][5] || "").trim();
    const rowNotes = String(tsData[i][7] || "").trim().toLowerCase();
    const isLeaveRecord = /^(OFF[-_]?WORK|OFF|休假|LEAVE|ANNUAL\s*LEAVE|SICK\s*LEAVE|PERSONAL\s*LEAVE|请假|调休|年假|病假|事假|婚假|产假|陪产假|丧假)$/i.test(rowProject) ||
                          rowNotes.includes("系统同步请假") || rowNotes.includes("on leave");
    if (isLeaveRecord) continue; // V4.3.11: 请假/休假不计入本月看板与明细列表，避免与出勤自检页重复且易混淆（如 07-31 8h/0h 混杂）
    let rowDate = new Date(tsData[i][1]); 
    if (isNaN(rowDate.getTime()) || rowDate < startOfRange || rowDate > endOfRange) continue;
    
    let log = { uuid: safeGetUuid(tsData[i][8]), date: Utilities.formatDate(rowDate, "GMT+8", "yyyy-MM-dd"), stage: tsData[i][4], project: tsData[i][5], hours: parseFloat(tsData[i][6]) || 0, notes: tsData[i][7] };
    logs.push(log);
    if (!matrix[log.project]) matrix[log.project] = [0,0,0,0,0,0,0];
    let logDay = rowDate.getDay() === 0 ? 6 : rowDate.getDay() - 1; 
    matrix[log.project][logDay] += log.hours;
  }
  logs.sort((a, b) => new Date(b.date) - new Date(a.date));
  return { pMap: getProjectMap(), matrix: matrix, logs: logs, range: dateRangeStr, userName: myName };
}

/**
 * V4.0: 明细补录页 - 按指定年月查询当前用户的工时日志（用于跨月批量补录/行内编辑）
 * 复用 getDashboardData 的读取与过滤逻辑（按姓名+软删过滤），只返回该月 logs。
 * 返回 {pMap, logs, userName}，不返回 matrix（日历用不到）。
 */
function getDetailLogsByMonth(token, year, month) {
  const user = getCurrentUser(token);
  const myName = user.name;
  const y = parseInt(year), m = parseInt(month);
  if (isNaN(y) || isNaN(m) || m < 1 || m > 12) throw new Error("Invalid year/month / 年月参数无效");
  const startOfRange = new Date(y, m - 1, 1);
  const endOfRange = new Date(y, m, 0, 23, 59, 59, 999);
  const tsData = getDbSheet().getDataRange().getValues();
  let logs = [];
  for (let i = 1; i < tsData.length; i++) {
    const dv = tsData[i][14];
    if (dv === true || String(dv).toUpperCase() === "TRUE") continue;
    if (getExactName(tsData[i][2]) !== myName) continue;
    const rowProject = String(tsData[i][5] || "").trim();
    const rowNotes = String(tsData[i][7] || "").trim().toLowerCase();
    const isLeaveRecord = /^(OFF[-_]?WORK|OFF|休假|LEAVE|ANNUAL\s*LEAVE|SICK\s*LEAVE|请假|调休|年假|病假|事假|婚假|产假|陪产假|丧假)$/i.test(rowProject) ||
                          rowNotes.includes("系统同步请假") ||
                          rowNotes.includes("on leave");
    if (isLeaveRecord) continue; // 休假/请假记录不在明细补录页展示，避免与系统同步请假重复
    let rowDate = new Date(tsData[i][1]);
    if (isNaN(rowDate.getTime()) || rowDate < startOfRange || rowDate > endOfRange) continue;
    logs.push({
      uuid: safeGetUuid(tsData[i][8]),
      date: Utilities.formatDate(rowDate, "GMT+8", "yyyy-MM-dd"),
      stage: tsData[i][4],
      project: tsData[i][5],
      hours: parseFloat(tsData[i][6]) || 0,
      notes: tsData[i][7]
    });
  }
  logs.sort((a, b) => new Date(b.date) - new Date(a.date));
  return { pMap: getProjectMap(), logs: logs, userName: myName };
}

/**
 * V4.3.6: 出勤自检 —— 返回指定年月当前用户「每日工时」与「请假日」，供前端日历热力图渲染漏填/少填。
 * - 工作日(周一~周五)且过去：0h → 漏填；<8h → 少填；>=8h → 达标。
 * - 请假日(项目=OFF-WORK/休假 或 备注含"系统同步请假/on leave") 标记为请假。
 * - 周末、未来日期不计入考核。
 * 返回 { year, month, dayHours:{date:hours}, leaveDays:{date:true}, standard, today }
 */
function getMonthAttendance(token, year, month) {
  const user = getCurrentUser(token);
  const myName = user.name;
  const y = parseInt(year), m = parseInt(month);
  if (isNaN(y) || isNaN(m) || m < 1 || m > 12) throw new Error("Invalid year/month / 年月参数无效");
  const startOfRange = new Date(y, m - 1, 1);
  const endOfRange = new Date(y, m, 0, 23, 59, 59, 999);
  const tsData = getDbSheet().getDataRange().getValues();
  const dayHours = {};   // dateStr -> 工作工时合计
  const leaveDays = {};  // dateStr -> 请假工时合计（数值，用于半天识别）
  const leaveDetailMap = {}; // V13.39/#560: 同日去重，ds -> {date, hours, note}，保留最大工时 + 合并不同备注
  const holidaySet = {}; // dateStr -> true（法定节假日，来自全局 HOLIDAYS）
  (typeof HOLIDAYS !== 'undefined' ? HOLIDAYS : []).forEach(function(d){ holidaySet[d] = true; });
  for (let i = 1; i < tsData.length; i++) {
    const dv = tsData[i][14];
    if (dv === true || String(dv).toUpperCase() === "TRUE") continue;
    if (getExactName(tsData[i][2]) !== myName) continue;
    const rowProject = String(tsData[i][5] || "").trim();
    const rowNotes = String(tsData[i][7] || "").trim().toLowerCase();
    const isLeave = /^(OFF[-_]?WORK|OFF|休假|LEAVE|ANNUAL\s*LEAVE|SICK\s*LEAVE|PERSONAL\s*LEAVE|请假|调休|年假|病假|事假|婚假|产假|陪产假|丧假)$/i.test(rowProject) ||
                      rowNotes.includes("系统同步请假") || rowNotes.includes("on leave");
    const rowDate = new Date(tsData[i][1]);
    if (isNaN(rowDate.getTime()) || rowDate < startOfRange || rowDate > endOfRange) continue;
    const ds = Utilities.formatDate(rowDate, "GMT+8", "yyyy-MM-dd");
    if (isLeave) {
      const lvH = (parseFloat(tsData[i][6]) || 0);
      leaveDays[ds] = (leaveDays[ds] || 0) + lvH;
      // V13.39/#560: 同日多源（如手动 OFF-WORK 行 + 日历同步请假行）去重，保留最大工时 + 合并不同备注
      const _note = String(tsData[i][7] || "").trim();
      if (!leaveDetailMap[ds]) {
        leaveDetailMap[ds] = { date: ds, hours: lvH, note: _note };
      } else {
        if (lvH > leaveDetailMap[ds].hours) leaveDetailMap[ds].hours = lvH;
        if (_note && leaveDetailMap[ds].note.indexOf(_note) === -1) {
          leaveDetailMap[ds].note = leaveDetailMap[ds].note ? (leaveDetailMap[ds].note + "; " + _note) : _note;
        }
      }
    }
    else { dayHours[ds] = (dayHours[ds] || 0) + (parseFloat(tsData[i][6]) || 0); }
  }
  // V13.39/#560: 由去重 map 生成请假清单（日期升序，yyyy-MM-dd 字符序即正确时序）
  const leaveDetails = Object.keys(leaveDetailMap).sort().map(function(k){ return leaveDetailMap[k]; });
  const today = Utilities.formatDate(new Date(), "GMT+8", "yyyy-MM-dd");
  return { year: y, month: m, dayHours: dayHours, leaveDays: leaveDays, leaveDetails: leaveDetails, holidays: holidaySet, standard: 8, today: today };
}

function submitBatch(token, tasks) {
  const user = getCurrentUser(token);
  const pMap = getProjectMap();
  const newRows = [];

  tasks.forEach(f => {
    const pid = formatPid(f.project);
    const recordId = "TS-" + Utilities.getUuid().replace(/-/g, '').substring(0, 12).toUpperCase();
    const pName = pMap[pid] || "Other / 其他";
    const yearMonth = f.date.substring(0, 7); 
    
    newRows.push([
      new Date(), f.date, String(user.name), "", String(f.stage), pid, parseFloat(f.hours)||0, String(f.notes), recordId, pName, "", user.leader, "", yearMonth
    ]);
  });

  if (newRows.length === 0) return "SUCCESS";

  const lock = LockService.getScriptLock();
  lock.waitLock(30000); 
  try {
    const sheet = getDbSheet();
    const startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, newRows.length, 14).setValues(newRows);
    return "SUCCESS";
  } catch (e) { 
    throw new Error(e.message || "Batch write failed. Please retry. / 批量写入失败"); 
  } finally {
    lock.releaseLock();
  }
}

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
        let row = i + 1;
        sheet.getRange(row, 2, 1, 9).setValues([[
          f.date, String(user.name), "", String(f.stage), formatPid(f.project), parseFloat(f.hours) || 0, String(f.notes), safeGetUuid(data[i][8]), pMap[formatPid(f.project)] || "Other / 其他"
        ]]);
        return "SUCCESS";
      }
    }
    throw new Error("Record not found or no permission to edit. / 记录未找到或无权限修改");
  } catch (e) { throw new Error(e.message || "Update failed / 更新失败"); }
}

function softDeleteRecord(token, uuid) {
  try {
    const user = getCurrentUser(token);
    const sheet = getDbSheet();
    const data = sheet.getDataRange().getValues();
    
    for (let i = 1; i < data.length; i++) {
      if (safeGetUuid(data[i][8]) == String(uuid).trim() && String(data[i][2]) === String(user.name)) { 
        sheet.getRange(i + 1, 15, 1, 3).setValues([[true, user.name, new Date()]]); 
        return "SUCCESS"; 
      }
    }
    throw new Error("Record not found or no permission to delete. / 记录未找到或无权限删除");
  } catch (e) { throw new Error(e.message || "Delete failed / 删除失败"); }
}

/**
 * V4.3.5: 幂等清理 DB_工时流水 中重复的请假/休假记录。
 * 匹配项目编号为 OFF-WORK / OFF / 休假 / leave 等，或备注含"系统同步请假"/"on leave"的记录。
 * 按 姓名+日期 分组，每组只保留一条（优先保留工时最大的），其余做软删除（O列=TRUE）。
 * 返回清理统计字符串。
 */
function cleanupDuplicateLeavesInternal() {
  const LEAVE_PATTERN = /^(OFF[-_]?WORK|OFF|休假|LEAVE|ANNUAL\s*LEAVE|SICK\s*LEAVE|PERSONAL\s*LEAVE|请假|调休|年假|病假|事假|婚假|产假|陪产假|丧假)$/i;
  const sheet = getDbSheet();
  const data = sheet.getDataRange().getValues();
  const seen = {}; // key: name|date -> { rowIndex(0-based), hours }
  let kept = 0, removed = 0;

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    for (let i = 1; i < data.length; i++) {
      const dv = data[i][14];
      if (dv === true || String(dv).toUpperCase() === "TRUE") continue;

      const project = String(data[i][5] || "").trim();
      const notes = String(data[i][7] || "").trim().toLowerCase();
      if (!LEAVE_PATTERN.test(project) && !notes.includes("系统同步请假") && !notes.includes("on leave")) continue;

      const name = String(data[i][2] || "").trim();
      const dateVal = data[i][1];
      if (!name || !dateVal) continue;
      const dateObj = (dateVal instanceof Date) ? dateVal : new Date(dateVal);
      if (isNaN(dateObj.getTime())) continue;
      const dateStr = Utilities.formatDate(dateObj, "GMT+8", "yyyy-MM-dd");
      const hours = parseFloat(data[i][6]) || 0;
      const key = name + "|" + dateStr;

      if (!seen[key]) {
        seen[key] = { row: i, hours: hours };
        kept++;
      } else {
        // 保留工时更大的一条；相同时保留先出现的那条
        if (hours > seen[key].hours) {
          sheet.getRange(seen[key].row + 1, 15).setValue(true);
          removed++;
          seen[key] = { row: i, hours: hours };
        } else {
          sheet.getRange(i + 1, 15).setValue(true);
          removed++;
        }
      }
    }
  } finally {
    lock.releaseLock();
  }

  return "请假去重完成：保留 " + kept + " 条，软删除重复 " + removed + " 条";
}

// 供你测试手动触发
function testCleanup() { cleanupExpiredTokens(); }