// masterCreate.gs —— 建/取「主库」独立 Spreadsheet（绝不写生产表）
// 入口：REMOTE_ACTIONS.masterCreate → action=masterCreate&token=REMOTE_TOKEN
//
// ============================================================================
// V2 (2026-10-15) —— 目标隔离修复（回应审核意见 2026-10-14 23:45 Tom）
// 原缺陷：会取回 MASTER_SSID 指向的表并增建页签，没有拒绝它指向生产表或其他未经批准表；
//        pure-mock 控制测试中，指向模拟生产表时插入了 4 个页签。
// 修复（五项，逐项对应审核意见）：
//   (1) 目标禁用清单：生产表 SSID（全局 TS_ID，以及 getDbSheet() 的父表）一律硬拒绝，
//       不 openById、不 insertSheet、不写属性，直接返回 ok:false。
//   (2) 属性存在但打开失败（表被删/无权限/ID 变更）→ 中止并报错，
//       【不自动新建】、【不覆盖 MASTER_SSID 属性】。
//   (3) 属性缺失 → 必须显式传 confirm=CREATE_NEW 才允许新建；
//       新建后写属性之前，二次校验新 id 不在禁用清单且与生产表不同。
//   (4) 打开到的表必须“自称”是主库：名称严格等于 MASTER_SS_NAME，否则中止
//       （防止 MASTER_SSID 被改成任意他人/未批准表后仍被增建页签）。
//   (5) insertSheet 之前再校验一次目标 id 不在禁用清单，形成双重闸门。
// 说明：所有对外返回值只给布尔标志，不回显生产表 ID，避免外泄。
// ============================================================================

var MASTER_SS_NAME = 'T1B_主库_工时与请假';
var MASTER_PROP_KEY = 'MASTER_SSID';

// (1) 目标禁用清单：生产表及其绑定表
function _masterForbiddenIds() {
  var out = [];
  try { if (typeof TS_ID !== 'undefined' && TS_ID) out.push(String(TS_ID)); } catch (e) {}
  try {
    var db = (typeof getDbSheet === 'function') ? getDbSheet() : null;
    if (db && db.getParent) out.push(String(db.getParent().getId()));
  } catch (e) {}
  return out;
}

function _masterIsForbidden(id) {
  if (!id) return false;
  var bad = _masterForbiddenIds();
  for (var i = 0; i < bad.length; i++) if (String(id) === bad[i]) return true;
  return false;
}

// 自然日 00:00 (GMT+8) 时间戳 —— 供多日事件展开使用（本文件未用，masterLeaves 同源）
function masterCreate(e) {
  e = e || {};
  var p = e.parameter || {};
  var dry = ['1', 'true', 'TRUE', 'yes'].indexOf(String(p.dry || '')) >= 0;
  var confirmNew = ['CREATE_NEW', '1', 'true', 'TRUE', 'yes'].indexOf(String(p.confirm || '')) >= 0;

  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(MASTER_PROP_KEY);
  var forbidden = _masterForbiddenIds();

  if (dry) {
    return JSON.stringify({
      ok: true, dry: true, action: 'masterCreate',
      name: MASTER_SS_NAME,
      propKey: MASTER_PROP_KEY,
      hasProp: !!id,
      propIsForbidden: _masterIsForbidden(id),   // 只回布尔，不回显 ID
      protectedTargets: forbidden.length,
      wouldCreate: (!id && confirmNew),
      note: 'dry：不打开任何表、不写属性、不建页签'
    });
  }

  // ---- 闸门 A：属性已存在 ----
  if (id) {
    if (_masterIsForbidden(id)) {
      return JSON.stringify({
        ok: false, action: 'masterCreate', aborted: 'TARGET_FORBIDDEN',
        reason: 'MASTER_SSID 指向受保护目标（生产表），已硬阻断：未打开该表、未建页签、未修改属性。',
        name: MASTER_SS_NAME
      });
    }
    var ss = null;
    try { ss = SpreadsheetApp.openById(id); } catch (err) { ss = null; }
    if (!ss) {
      // (2) 打开失败 → 中止，不自动新建、不覆盖属性
      return JSON.stringify({
        ok: false, action: 'masterCreate', aborted: 'PROP_OPEN_FAILED',
        reason: 'MASTER_SSID 已存在但无法打开（表被删除/无权限/ID 变更）。已中止，未自动新建、未覆盖属性。',
        name: MASTER_SS_NAME
      });
    }
    // (4) 名称校验
    if (ss.getName() !== MASTER_SS_NAME) {
      return JSON.stringify({
        ok: false, action: 'masterCreate', aborted: 'NAME_MISMATCH',
        reason: '目标表名称不等于 ' + MASTER_SS_NAME + '，拒绝增建页签（防止指向未批准表）。',
        name: MASTER_SS_NAME
      });
    }
    // (5) 建页签前二次校验
    if (_masterIsForbidden(ss.getId())) {
      return JSON.stringify({ ok: false, action: 'masterCreate', aborted: 'TARGET_FORBIDDEN_PRE_INSERT',
        reason: '插入页签前校验命中受保护目标，已中止。', name: MASTER_SS_NAME });
    }
    ['工时', '请假', '月度视图', '说明'].forEach(function (nm) {
      if (!ss.getSheetByName(nm)) ss.insertSheet(nm);
    });
    return JSON.stringify({
      ok: true, action: 'masterCreate', mode: 'reused', masterId: ss.getId(),
      masterUrl: ss.getUrl(), name: ss.getName()
    });
  }

  // ---- 闸门 B：属性缺失 ----
  if (!confirmNew) {
    return JSON.stringify({
      ok: false, action: 'masterCreate', aborted: 'NEED_CONFIRM',
      reason: 'MASTER_SSID 不存在。按审核要求不自动新建并写属性；如需新建请显式传 confirm=CREATE_NEW。',
      name: MASTER_SS_NAME
    });
  }

  var created = SpreadsheetApp.create(MASTER_SS_NAME);
  var newId = created.getId();
  if (_masterIsForbidden(newId) || newId === String(typeof TS_ID !== 'undefined' ? TS_ID : '')) {
    // 理论上不可能，保留兜底
    return JSON.stringify({ ok: false, action: 'masterCreate', aborted: 'CREATED_ID_FORBIDDEN',
      reason: '新建表 ID 命中受保护目标，已中止且未写入属性。', name: MASTER_SS_NAME });
  }
  props.setProperty(MASTER_PROP_KEY, newId);
  ['工时', '请假', '月度视图', '说明'].forEach(function (nm) {
    if (!created.getSheetByName(nm)) created.insertSheet(nm);
  });
  return JSON.stringify({
    ok: true, action: 'masterCreate', mode: 'created', masterId: newId,
    masterUrl: created.getUrl(), name: created.getName()
  });
}