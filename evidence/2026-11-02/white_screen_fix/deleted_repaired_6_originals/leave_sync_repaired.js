/**
 * 🩹 V4.3.44 请假日历同步修复
 * 读取 China Employee - Leave Calendar，按事件实际时长写工时，按事件 ID 幂等去重。
 * V4.3.44：紧急回滚 V4.3.43。用户最新截图确认线上 DB_工时流水 表头仍是 F=工时/G=备注；V4.3.43 误改成 F=备注/G=工时，会把工时写到备注列。本版改回 F=工时/G=备注，与真实表头对齐。
 */

const LEAVE_CALENDAR_ID = 'c_b9432c84c439fafa5948d1e7ae7eed3eb43aa6781340d326c151e1452661ea57@group.calendar.google.com';
const LEAVE_SYNC_SOURCE = '系统同步请假';
const LEAVE_SYNC_EVENT_PREFIX = 'LEAVE-';
const LEAVE_SYNC_TZ = 'GMT+8';
const LEAVE_SYNC_LOCK_TOKEN = 'LEAVE_SYNC_LOCK';

/**
 * V4.3.30: 请假同步触发器自愈 —— 确保每日 06:30 syncLeavesFromCalendar 触发器存在。
 * 从已授权的安装型触发器（syncLeavesFromCalendar 自身 / sendAmyIndirectCostReminder）调用；
 * 简单 onOpen 无授权无法建立定时触发器，故不依赖 onOpen。
 */
function ensureLeaveSyncTrigger() {
  try {
    const triggers = ScriptApp.getProjectTriggers();
    const exists = triggers.some(t => t.getHandlerFunction() === 'syncLeavesFromCalendar' && t.getEventType() === ScriptApp.EventType.CLOCK);
    if (!exists) {
      ScriptApp.newTrigger('syncLeavesFromCalendar').timeBased().everyDays(1).atHour(6).nearMinute(30).create();
      console.log('[ensureLeaveSyncTrigger] 已重建 syncLeavesFromCalendar 每日06:30触发器');
    }
  } catch (e) {
    console.log('[ensureLeaveSyncTrigger] 跳过：' + e.message);
  }
}

/**
 * 主入口：同步请假日历到 DB_工时流水。
 * @param {number} monthsBack  往前同步几个月（默认 1）
 * @param {number} monthsAhead 往后同步几个月（默认 2）
 * @returns {string} 结果摘要
 */
function syncLeavesFromCalendar(monthsBack, monthsAhead) {
  monthsBack = monthsBack || 1;
  monthsAhead = monthsAhead || 2;

  // V4.3.30: 从已授权触发器上下文自愈安装本触发器
  ensureLeaveSyncTrigger();

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('同步请假正在运行，请稍后再试');

  try {
    const cal = CalendarApp.getCalendarById(LEAVE_CALENDAR_ID);
    if (!cal) throw new Error('无法访问请假日历：' + LEAVE_CALENDAR_ID);

    const now = new Date();
    const startDate = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);
    const endDate = new Date(now.getFullYear(), now.getMonth() + monthsAhead + 1, 0);
    const startStr = _lsFmt(startDate);
    const endStr = _lsFmt(endDate);

    const events = cal.getEvents(startDate, endDate);

    const sheet = getDbSheet();
    const data = sheet.getDataRange().getValues();

    // 1. V4.3.35: 物理删除目标区间内旧的系统同步请假记录 (不再软删留垃圾导致表膨胀)
    // 用"读保留行 + 重写"方式物理移除, 避免逐行 deleteRows 超时; clearContent 只清值保留格式/列宽
    const retained = [];
    let deletedCount = 0;
    for (let i = 0; i < data.length; i++) {
      const notes = String(data[i][6] || ''); // V4.3.45: 系统同步标记写在G列(index6)，此前误读H列(index7=recordId)导致旧记录永不被清理→重复累积
      const dateStr = String(data[i][1] || '');
      if (i > 0 && notes.indexOf(LEAVE_SYNC_SOURCE) >= 0 && dateStr >= startStr && dateStr <= endStr) {
        deletedCount++; // 区间内旧系统同步请假, 物理移除(不再软删留 O=TRUE 垃圾)
      } else {
        retained.push(data[i]);
      }
    }
    const lastRow = sheet.getLastRow();
    const lastCol = Math.max(14, sheet.getLastColumn());
    sheet.getRange(1, 1, lastRow, lastCol).clearContent();
    sheet.getRange(1, 1, retained.length, retained[0].length).setValues(retained);
    const actualLast = sheet.getLastRow();
    if (actualLast > retained.length) {
      sheet.deleteRows(retained.length + 1, actualLast - retained.length);
    }

    // 2. 按日历事件生成新记录
    const newRows = [];
    const seen = {}; // 本次运行内去重：eventId|date|name

    events.forEach(e => {
      const title = String(e.getTitle() || '').trim();
      if (!title) return;

      const rawName = _lsExtractName(title);
      if (!rawName) return;

      const name = getExactName(rawName);
      if (!name) return;

      const eventId = e.getId();
      const allDay = e.isAllDayEvent();
      const startTime = e.getStartTime();
      const endTime = e.getEndTime();

      const days = _lsSplitEventToWorkdays(startTime, endTime, allDay);
      days.forEach(d => {
        const key = eventId + '|' + d.dateStr + '|' + name;
        if (seen[key]) return;
        seen[key] = true;

        const recordId = LEAVE_SYNC_EVENT_PREFIX + _lsSanitizeId(eventId).substring(0, 32) + '-' + d.dateStr;
        const yearMonth = d.dateStr.substring(0, 7);
        // V4.3.44: 线上 DB_工时流水 真实表头 F=工时/G=备注；recordId 放 I 列便于追溯。
        newRows.push([
          new Date(),          // A 提交时间
          d.dateStr,           // B 日期
          name,                // C 姓名
          'OFF-WORK',          // D 阶段
          'OFF-WORK',          // E 项目编号
          d.hours,             // F 工时
          LEAVE_SYNC_SOURCE + ' | ' + title, // G 备注
          recordId,            // H recordId
          'OFF-WORK / Leave',  // I 项目名称
          '',                  // J
          '',                  // K
          '',                  // L
          '',                  // M
          yearMonth            // N yearMonth
        ]);
      });
    });

    if (newRows.length > 0) {
      const startRow = sheet.getLastRow() + 1;
      sheet.getRange(startRow, 1, newRows.length, 14).setValues(newRows);
    }

    _recordTimeSheetHeartbeat('🟢', '');
    return '请假同步完成：物理删除旧记录 ' + deletedCount + ' 条，新增 ' + newRows.length + ' 条（区间 ' + startStr + ' ~ ' + endStr + '）';
  } catch (e) {
    _recordTimeSheetHeartbeat('🔴', e.message);
    throw e;
  } finally {
    lock.releaseLock();
  }
}

/** 从事件标题提取姓名（取第一个 '-' 前面的内容）。 */
function _lsExtractName(title) {
  const m = title.match(/^([^\-–—]+)/);
  if (m) return m[1].trim();
  return title.trim();
}

/** 把事件拆成按工作日的记录。全天事件跨天每天 8h；定时事件按实际时长，单日最多 8h。 */
function _lsSplitEventToWorkdays(start, end, allDay) {
  const days = [];
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const tz = LEAVE_SYNC_TZ;
  // V4.3.32: 请假同步应跳过中国法定节假日(定义在 onOpen.js 全局 HOLIDAYS)，避免节假日被计为工作日
  const holidaySet = {};
  (typeof HOLIDAYS !== 'undefined' ? HOLIDAYS : []).forEach(function(h) { holidaySet[h] = true; });

  if (allDay) {
    let d = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const endDate = new Date(end.getFullYear(), end.getMonth(), end.getDate());
    while (d < endDate) {  // Google Calendar 全天事件结束日期为 exclusive，应使用 < 而非 <=
      const day = d.getDay();
      const ds = Utilities.formatDate(d, tz, 'yyyy-MM-dd');
      if (day !== 0 && day !== 6 && !holidaySet[ds]) {
        days.push({ dateStr: ds, hours: 8 });
      }
      d = new Date(d.getTime() + MS_PER_DAY);
    }
  } else {
    const startDate = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const endDate = new Date(end.getFullYear(), end.getMonth(), end.getDate());

    if (startDate.getTime() === endDate.getTime()) {
      const hours = Math.min(8, Math.max(0.5, (end - start) / (1000 * 60 * 60)));
      const ds = Utilities.formatDate(startDate, tz, 'yyyy-MM-dd');
      if (!holidaySet[ds]) {
        days.push({ dateStr: ds, hours: _lsRoundHalf(hours) });
      }
    } else {
      let d = new Date(startDate);
      while (d <= endDate) {
        const day = d.getDay();
        const ds = Utilities.formatDate(d, tz, 'yyyy-MM-dd');
        if (day !== 0 && day !== 6 && !holidaySet[ds]) {
          days.push({ dateStr: ds, hours: 8 });
        }
        d = new Date(d.getTime() + MS_PER_DAY);
      }
    }
  }

  return days;
}

function _lsFmt(d) {
  return Utilities.formatDate(d, LEAVE_SYNC_TZ, 'yyyy-MM-dd');
}

function _lsRoundHalf(n) {
  return Math.round(n * 2) / 2;
}

function _lsSanitizeId(id) {
  return String(id || '').replace(/[^a-zA-Z0-9]/g, '');
}

// V4.3.31: 请假同步健康度上报到 pmlist 心跳看板（复用 pmlist 表格 ID）
// Project No/Module 固定为 "TimeSheet"，每次同步更新同一行，便于一眼看全员请假同步是否健康
function _recordTimeSheetHeartbeat(status, errMsg) {
  try {
    var PMLIST_ID = '1XVvgruEU8nIUjTgLP4x13e7h-Ua7zHrsohoryzwUifQ';
    var ss = SpreadsheetApp.openById(PMLIST_ID);
    var sheet = ss.getSheetByName('Sync Heartbeat / 同步心跳');
    if (!sheet) {
      sheet = ss.insertSheet('Sync Heartbeat / 同步心跳');
      sheet.appendRow(['Project No', 'Module', 'Last Sync', 'Status', 'Last Error']);
      sheet.getRange(1, 1, 1, 5).setFontWeight('bold');
    }
    var pNo = 'TimeSheet';
    var module = 'TimeSheet';
    var now = Utilities.formatDate(new Date(), 'GMT+8', 'yyyy-MM-dd HH:mm:ss');
    var data = sheet.getDataRange().getValues();
    var foundRow = -1;
    for (var r = 1; r < data.length; r++) {
      if (data[r][0] && String(data[r][0]).trim() === pNo && String(data[r][1] || '').trim() === module) { foundRow = r + 1; break; }
    }
    if (foundRow === -1) {
      sheet.appendRow([pNo, module, now, status, errMsg || '']);
    } else {
      sheet.getRange(foundRow, 3).setValue(now);
      sheet.getRange(foundRow, 4).setValue(status);
      sheet.getRange(foundRow, 5).setValue(errMsg || '');
    }
  } catch (e) {
    console.error('TimeSheet heartbeat write failed: ' + e.message);
  }
}
