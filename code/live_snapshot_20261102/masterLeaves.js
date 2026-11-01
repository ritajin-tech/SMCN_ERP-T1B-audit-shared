// masterLeaves.gs —— 只读 China Employee - Leave Calendar，返回【日历事件实例按日展开】结果
// 入口：REMOTE_ACTIONS.masterLeaves → action=masterLeaves&token=REMOTE_TOKEN
// 不写任何库（含主库）；只把日历读出来交给调用端去写主库。
// 依赖后端全局 getExactName()（白名单/模糊匹配，与 leaf_sync 同源）。
//
// ============================================================================
// V2 (2026-10-15) —— 事件实例/多日规则修复（回应审核意见 2026-10-14 23:45 Tom）
// 原缺陷（两条，均为审核方实测指出）：
//   (a) 同人同日两个独立 4 小时事件，只返回一条 4 小时
//       → 旧去重键 name|date 把第二个事件折叠掉了。
//   (b) 三日全天事件，只返回开始日一条 8 小时
//       → 旧代码只取 getStartTime()，未按发生日展开。
// 修复：
//   1) 去重键改为【事件实例】级：evId|date|name。同人同日的多个独立事件各占一行，不再折叠。
//   2) 多日事件按自然日（GMT+8）逐日展开，每天一行；全天事件每天 8h。
//   3) 定时事件跨天时按当日实际覆盖时长分段归属，单日上限 8h。
//   4) 返回增加 evId / allDay / evStart / evEnd / dayIndex / dayCount，
//      每行可回溯到源事件与发生日，供独立复算。
//   5) 命名纪律：本函数输出称「日历事件实例按日展开结果」，
//      不称为完整「请假真值」——多日与工时规则须由业务方确认后才可作真值使用。
// ============================================================================

var MASTER_CAL_ID = 'c_b9432c84c439fafa5948d1e7ae7eed3eb43aa6781340d326c151e1452661ea57@group.calendar.google.com';
var MASTER_LEAVE_TZ = 'GMT+8';
var MASTER_LEAVE_DAY_HOURS_CAP = 8;

// 取某时间戳所在自然日 00:00:00（GMT+8）的时间戳
function _mlFloorToDay(t) {
  var sdf = Utilities.formatDate(new Date(t), MASTER_LEAVE_TZ, 'yyyy-MM-dd HH:mm:ss');
  var hh = parseInt(sdf.substr(11, 2), 10);
  var mm = parseInt(sdf.substr(14, 2), 10);
  var ss = parseInt(sdf.substr(17, 2), 10);
  return t - ((hh * 3600 + mm * 60 + ss) * 1000);
}

function masterLeaves(e) {
  e = e || {};
  var p = e.parameter || {};
  var dry = ['1', 'true', 'TRUE', 'yes'].indexOf(String(p.dry || '')) >= 0;

  var cal = CalendarApp.getCalendarById(MASTER_CAL_ID);
  if (!cal) return JSON.stringify({ ok: false, error: '日历为null(无访问权)', calId: MASTER_CAL_ID });

  var now = new Date();
  var start = new Date(2026, 3, 1);                              // 2026-04-01
  var end = new Date(now.getFullYear(), now.getMonth() + 3, 0);  // 今天 + 2 月
  var evs = cal.getEvents(start, end);

  var rows = [];
  var seenInstance = {};   // 实例级去重：evId|date|name
  var eventCount = 0;
  var skippedNoName = 0;

  evs.forEach(function (ev) {
    var raw = String(ev.getTitle() || '').trim();
    if (!raw) return;
    var nm = getExactName(raw);
    if (!nm) { skippedNoName++; return; }

    eventCount++;
    var evId = (ev.getId() || '').split('@')[0];
    var allDay = !!ev.isAllDayEvent();
    var t0 = ev.getStartTime().getTime();
    var t1 = ev.getEndTime().getTime();
    if (!(t1 > t0)) return;

    // 按自然日（GMT+8）逐日展开
    var dayCursor = _mlFloorToDay(t0);
    var dayIdx = 0;
    // 先算总天数，供 dayCount 回溯（上限 400 天防死循环）
    var totalDays = Math.max(1, Math.round((_mlFloorToDay(t1 - 1) - _mlFloorToDay(t0)) / 86400000) + 1);

    while (dayCursor < t1 && dayIdx < 400) {
      var dayStart = Math.max(t0, dayCursor);
      var dayEnd = Math.min(t1, dayCursor + 86400000);
      if (dayEnd > dayStart) {
        var hrs;
        if (allDay) {
          hrs = 8;                                        // 全天事件：每天 8h
        } else {
          hrs = (dayEnd - dayStart) / 3600000;            // 定时事件：当日实际覆盖时长
          if (hrs > MASTER_LEAVE_DAY_HOURS_CAP) hrs = MASTER_LEAVE_DAY_HOURS_CAP;
        }
        var ds = Utilities.formatDate(new Date(dayCursor), MASTER_LEAVE_TZ, 'yyyy-MM-dd');
        var ikey = evId + '|' + ds + '|' + nm;
        if (!seenInstance[ikey]) {
          seenInstance[ikey] = true;
          rows.push({
            name: nm,
            date: ds,
            type: '休假',
            stage: 'OFF-WORK',
            proj: 'OFF-WORK',
            hours: Math.round(hrs * 10) / 10,
            note: '系统同步请假',
            evId: evId,
            allDay: allDay,
            evStart: Utilities.formatDate(new Date(t0), MASTER_LEAVE_TZ, 'yyyy-MM-dd HH:mm'),
            evEnd: Utilities.formatDate(new Date(t1), MASTER_LEAVE_TZ, 'yyyy-MM-dd HH:mm'),
            dayIndex: dayIdx + 1,
            dayCount: totalDays
          });
        }
      }
      dayCursor += 86400000;
      dayIdx++;
    }
  });

  var out = {
    ok: true,
    action: 'masterLeaves',
    resultName: '日历事件实例按日展开结果（非完整请假真值，待业务确认多日与工时规则）',
    rules: {
      dedupKey: 'evId|date|name（实例级；同人同日多事件不折叠）',
      allDay: '全天事件每日计 8h，跨 N 天展开为 N 行',
      timed: '定时事件按当日实际覆盖时长，单日上限 ' + MASTER_LEAVE_DAY_HOURS_CAP + 'h',
      tz: MASTER_LEAVE_TZ,
      windowStart: Utilities.formatDate(start, MASTER_LEAVE_TZ, 'yyyy-MM-dd'),
      windowEnd: Utilities.formatDate(end, MASTER_LEAVE_TZ, 'yyyy-MM-dd')
    },
    eventCount: eventCount,
    instanceCount: rows.length,
    skippedNoName: skippedNoName
  };
  if (dry) return JSON.stringify({
    ok: true, dry: true, action: 'masterLeaves',
    wouldReturn: rows.length, eventCount: eventCount, rules: out.rules
  });
  out.rows = rows;
  return JSON.stringify(out);
}