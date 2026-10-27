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
function _sdSoftDel(r) {
  return (r === true || String(r || '').toUpperCase() === 'TRUE');
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

// 默认策略（镜像 PeriodLockGuard _plPolicy 的「initial-unset」态：closed=true 保护历史，
// futureOpen=true 允许未来正常写入；fail-closed 的 _plFailClosedPolicy 才是 futureOpen=false）。
// 真实部署由 PropertiesService 显式初始化；Node 核心经 deps.policy() 注入，未注入时回退到此。
function _plPolicy() {
  return { closed: true, cutoff: PL_CUTOFF, futureOpen: true, source: 'unset' };
}

// ---- Node 导出（GAS 侧由 genpatches 内联）----
  return { PL_CUTOFF: PL_CUTOFF,
  PL_UNKNOWN: PL_UNKNOWN,
  _plParseBizDate: _plParseBizDate,
  _plIsClosedBizDate: _plIsClosedBizDate,
  _plGuardCheck: _plGuardCheck,
  _plPolicy: _plPolicy };
})();

// ts_softdel_core.js — 软标动作【真实服务端业务核心】（v4：回应 Tom 2026-10-27 复审 6 项阻断）
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
var TOP_KEYS = ['batchId', 'rows', 'dry', 'sheet', 'clearance', 'jobId', 'action', 'token', 'expectMasterVersion'];

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
  if ((e.postBody && e.postBody.action === 'statusQuery') || (e.parameter && e.parameter.action === 'statusQuery')) {
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
  var clearanceOk = clearanceToken ? !!deps.isClearance(clearanceToken, rows) : false;

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

    // Tom #6：主库版本【前后绑定】—— 调用方可显式声明预期版本，不符即整批拒绝；
    //   未声明时也记录 version，并在写后再复核（见响应 masterVersion / masterVersionAfter）。
    var expectMasterVersion = body.expectMasterVersion || p.expectMasterVersion || null;
    if (expectMasterVersion != null && String(expectMasterVersion) !== String(master.version)) {
      return _res(false, { error: 'MASTER_VERSION_MISMATCH', expect: String(expectMasterVersion), actual: String(master.version), batchId: batchId, jobId: jobId });
    }

    for (var i = 0; i < rows.length; i++) {
      var it = rows[i] || {};
      var row = Number(it.row), uuid = String(it.uuid || '');
      var keeperRow = Number(it.keeperRow), level = String(it.level || '');
      var timeOnly = (it.timeOnly === true);
      var itemId = row;
      var requestHash = _requestHashOf(it);
      var wrote = false, writtenUnconfirmed = false;
      try {
        // 同身份复用检测（Tom #4）：按【请求身份】检索完成凭据，不再只看「最后一条」；
        //   且幂等命中也必须复核实时 O 列仍为 TRUE，否则不能声称 wrote:true。
        var _recs = _journalRecords(deps, jobId, itemId);
        var _commit = _findCommit(_recs, requestHash);
        if (_commit) {
          var oNow = null, oErr = null;
          try { oNow = deps.readProdO ? deps.readProdO(row) : null; }
          catch (oe) { oErr = String(oe && oe.message || oe); }
          if (oErr || oNow === null || oNow === undefined) {
            results.push({ row: row, ok: false, wrote: false, reason: 'IDEMPOTENT_RECHECK_UNAVAILABLE', state: 'UNKNOWN', error: oErr || '' });
            anyFail = true; continue;
          }
          if (!_sdSoftDel(oNow)) {
            journal(deps, jobId, batchId, itemId, requestHash, 'UNKNOWN');
            results.push({ row: row, ok: false, wrote: false, reason: 'IDEMPOTENT_O_DRIFT', expect: 'TRUE', actual: String(oNow) });
            anyFail = true; continue;
          }
          results.push({ row: row, ok: true, wrote: true, level: level, idempotent: true });
          patched++;
          continue;
        }
        var _anyCommit = _findAnyCommit(_recs);
        if (_anyCommit) {
          // 同 jobId+itemId 但不同 requestHash → 复用冲突，拒绝（防串批/重放）。
          // 冲突记录以 REJECTED 追加，绝不覆盖/替换原完成凭据（Tom #4）。
          journal(deps, jobId, batchId, itemId, requestHash, 'REJECTED', uuid);
          results.push({ row: row, ok: false, reason: 'KEY_REUSE_CONFLICT', priorHash: _anyCommit.requestHash });
          anyFail = true; continue;
        }

        // 锁内重读实时值
        var vals = deps.readProdRow(row);
        if (!vals) { journal(deps, jobId, batchId, itemId, requestHash, 'REJECTED'); results.push({ row: row, ok: false, reason: 'ROW_NOT_FOUND' }); anyFail = true; continue; }
        var kVals = deps.readProdRow(keeperRow);

        if (norm._sdNorm(vals[8]) !== uuid) { journal(deps, jobId, batchId, itemId, requestHash, 'REJECTED'); results.push({ row: row, ok: false, reason: 'UUID_DRIFT', actual: norm._sdNorm(vals[8]) }); anyFail = true; continue; }
        if (_sdSoftDel(vals[14])) { journal(deps, jobId, batchId, itemId, requestHash, 'REJECTED'); results.push({ row: row, ok: false, wrote: false, reason: 'ALREADY_SOFTDEL' }); anyFail = true; continue; }
        if (!kVals || _sdSoftDel(kVals[14])) { journal(deps, jobId, batchId, itemId, requestHash, 'REJECTED'); results.push({ row: row, ok: false, reason: 'KEEPER_INVALID' }); anyFail = true; continue; }

        // 条件 #2：CAS 绑定到已审计原值（SHA-256 指纹，含列1业务日期/排除列0当 timeOnly/含列14审计）
        var liveHash = _sdRowHash(vals, timeOnly);
        var liveKHash = _sdRowHash(kVals, timeOnly);
        if (liveHash !== it.expectHash) { journal(deps, jobId, batchId, itemId, requestHash, 'REJECTED'); results.push({ row: row, ok: false, reason: 'TARGET_DRIFT', expect: it.expectHash, actual: liveHash }); anyFail = true; continue; }
        if (liveKHash !== it.keeperHash) { journal(deps, jobId, batchId, itemId, requestHash, 'REJECTED'); results.push({ row: row, ok: false, reason: 'KEEPER_DRIFT', expect: it.keeperHash, actual: liveKHash }); anyFail = true; continue; }

        // 条件 #2：timeOnly 时录入时间分别绑定（双方），差异被接受但必须"被声明且匹配"
        if (timeOnly) {
          var liveEntry = _sdCellHash(vals[0]);
          var liveKEntry = _sdCellHash(kVals[0]);
          if (liveEntry !== it.expectEntryTime || liveKEntry !== it.keeperEntryTime) {
            journal(deps, jobId, batchId, itemId, requestHash, 'REJECTED');
            results.push({ row: row, ok: false, reason: 'ENTRY_TIME_DRIFT' }); anyFail = true; continue;
          }
        }

        // 负载一致性（冗余保险，timeOnly 仅允许列0差异）：以【类型保全】token 比较，
        // 不沿用 _sdNorm（后者会把 "007" 合并成 7，与指纹哈希口径不一致，Tom #3）。
        var diffs = [];
        for (var c = 0; c <= 13; c++) {
          var tA = JSON.stringify(_sdCellTok(vals[c]));
          var tB = JSON.stringify(_sdCellTok(kVals[c]));
          if (tA !== tB) diffs.push(c);
        }
        var allowed = timeOnly && diffs.length > 0 && diffs.every(function (x) { return x === 0; });
        if (diffs.length > 0 && !allowed) { journal(deps, jobId, batchId, itemId, requestHash, 'REJECTED'); results.push({ row: row, ok: false, reason: 'PAYLOAD_DIFF', cols: diffs }); anyFail = true; continue; }

        // 条件 #3：真实期锁（锁内对目标行业务日期跑真实 _plGuardCheck）。
        //   业务日期以【原始值】传入（可能是 Date 或字符串），由 _plParseBizDate 原生处理；
        //   不再经 _sdNorm 把 Date 污损成一长串 ISO 串导致解析失败被整体拒掉。
        var bizDate = vals[1];
        var g = deps.guardCheck(bizDate, null, policy);
        if (!g.ok && !clearanceOk) { journal(deps, jobId, batchId, itemId, requestHash, 'REJECTED'); results.push({ row: row, ok: false, reason: 'PERIOD_LOCKED', date: norm._sdNorm(bizDate), detail: g.reason || '' }); anyFail = true; continue; }

        // 等级与底稿核对（A：底稿恰 1 行且哈希/状态相符；B：底稿 0 行）
        if (level === 'A') {
          var mMatches = masterMap[uuid] || [];
          if (mMatches.length !== 1) { journal(deps, jobId, batchId, itemId, requestHash, 'REJECTED'); results.push({ row: row, ok: false, reason: (mMatches.length === 0 ? 'BASE_NOT_FOUND' : 'BASE_NOT_UNIQUE'), count: mMatches.length }); anyFail = true; continue; }
          var mHash = _sdRowHash(mMatches[0].cells, false);
          if (mHash !== it.expectBaseHash) { journal(deps, jobId, batchId, itemId, requestHash, 'REJECTED'); results.push({ row: row, ok: false, reason: 'BASE_DRIFT', expect: it.expectBaseHash, actual: mHash }); anyFail = true; continue; }
        } else {
          var mB = masterMap[uuid] || [];
          if (mB.length !== 0) { journal(deps, jobId, batchId, itemId, requestHash, 'REJECTED'); results.push({ row: row, ok: false, reason: 'BASE_HAS_MATCH', count: mB.length }); anyFail = true; continue; }
        }

        // PREPARED 日志：落盘前必须成功；日志失败 → 阻断写，记为 UNKNOWN（Tom #4）。
        // dry 不写业务恢复日志（Tom #4）：dry 不产生任何写入，也就不该产生「待恢复」凭据，
        // 否则状态查询会把一次 dry 的 PREPARED 误读成「本请求已落盘待确认」。
        if (!dry) {
          var prepOk = journal(deps, jobId, batchId, itemId, requestHash, 'PREPARED', uuid);
          if (!prepOk) { results.push({ row: row, ok: false, wrote: false, reason: 'PREPARED_LOG_FAILED' }); anyFail = true; continue; }
        }

        // 写 O 列（仅非 dry 且上述全过）
        if (!dry) {
          var wroteOk = false;
          try {
            wroteOk = deps.writeProdO(row, 'TRUE');
          } catch (we) {
            // 条件 #6：flush 异常 —— 已尝试写但无法确认落盘，区分"已写未确认"
            journal(deps, jobId, batchId, itemId, requestHash, 'UNKNOWN');
            results.push({ row: row, ok: false, wrote: false, reason: 'WRITE_FLUSH_EXCEPTION', error: String(we && we.message || we) });
            anyFail = true; continue;
          }
          if (!wroteOk) {
            // Tom #4：writeProdO 返回 false 只说明「未确认」，不说明「未写」（GAS flush 异常被吞时尤其如此）。
            // 因此登记 UNKNOWN（写可能已发生），绝不记 REJECTED 以免被误读为「已确认未写」。
            journal(deps, jobId, batchId, itemId, requestHash, 'UNKNOWN', uuid);
            results.push({ row: row, ok: false, wrote: false, reason: 'WRITE_FAILED_UNCONFIRMED', state: 'UNKNOWN' });
            anyFail = true; continue;
          }
          var after = null;
          try { after = deps.readProdO(row); }
          catch (re) {
            // 写了但回读失败 → 已写未确认（非"未写"），留 UNKNOWN
            journal(deps, jobId, batchId, itemId, requestHash, 'UNKNOWN');
            results.push({ row: row, ok: false, wrote: true, reason: 'WRITE_UNCONFIRMED', error: String(re && re.message || re) });
            anyFail = true; continue;
          }
          if (norm._sdNorm(after) !== 'TRUE') { journal(deps, jobId, batchId, itemId, requestHash, 'REJECTED'); results.push({ row: row, ok: false, reason: 'WRITE_NOT_CONFIRMED', actual: String(after) }); anyFail = true; continue; }
          wrote = true;
          // COMMITTED 日志：若落盘失败 → 已写但无凭证，记 UNKNOWN（不谎称 COMMITTED）
          var commitOk = journal(deps, jobId, batchId, itemId, requestHash, 'COMMITTED');
          if (!commitOk) {
            results.push({ row: row, ok: false, wrote: true, reason: 'COMMITTED_LOG_FAILED', state: 'UNKNOWN' });
            anyFail = true; continue;
          }
        }
        var _rr = { row: row, ok: true, wrote: wrote, level: level };
        results.push(_rr);
        if (wrote) { patched++; wroteRows.push(_rr); }
      } catch (rerr) {
        // 读类异常 → 行未读/未写（非 flush）；flush 已在上面单独区分
        journal(deps, jobId, batchId, itemId, requestHash, 'REJECTED');
        results.push({ row: row, ok: false, reason: 'ROW_READ_FAIL', error: String(rerr && rerr.message || rerr) });
        anyFail = true;
      }
    }
    // 写后主库版本复核（Tom #6：读前后绑定）—— 本批次只写生产 O 列，主库版本必须不变；
    //   若前后不一致，说明快照在读期间已被改动，已写行的归属不能确认为本请求所为 → UNKNOWN。
    //   注意：此处不追加日志，避免用「后见 UNKNOWN」覆盖既有的 COMMITTED 完成凭据（Tom #4）。
    if (wroteRows.length) {
      var mAfter = null;
      try { mAfter = (typeof deps.readAllMaster === 'function') ? deps.readAllMaster() : null; } catch (ma) { mAfter = null; }
      var mAfterV = (mAfter && mAfter.version) ? String(mAfter.version) : null;
      if (!mAfter || !mAfter.complete || !mAfterV || mAfterV !== String(master.version)) {
        for (var w = 0; w < wroteRows.length; w++) {
          wroteRows[w].ok = false;
          wroteRows[w].wrote = true;
          wroteRows[w].state = 'UNKNOWN';
          wroteRows[w].reason = 'MASTER_VERSION_DRIFT_POST_WRITE';
        }
        anyFail = true;
      }
      masterVersionAfter = mAfterV;
    }
  } finally {
    try { if (deps.releaseLock) deps.releaseLock(_lock); } catch (rl) {}
    try { if (deps.releaseMasterLock && _mlock) deps.releaseMasterLock(_mlock); } catch (rl2) {}
  }
  // 诚实上报：任一失败 → 批次 ok=false（不暗示原子回滚）
  return _res(!anyFail, { batchId: batchId, jobId: jobId, dry: dry, patched: patched, total: rows.length, results: results,
    masterVersion: String(master.version || ''), masterVersionAfter: masterVersionAfter });
}

// 条件 #4 强制日志：返回布尔。缺失依赖或写抛异常 → false（调用方据此阻断写）。
// 记录中持久保存【原请求身份】：jobId + subBatchId + itemId + requestHash + uuid，供状态查询逐项绑定。
function journal(deps, jobId, subBatchId, itemId, requestHash, state, uuid) {
  if (typeof deps.journalAppend !== 'function') return false;
  try {
    deps.journalAppend({ jobId: jobId, subBatchId: subBatchId, itemId: itemId, requestHash: requestHash, state: state, uuid: uuid == null ? null : String(uuid), ts: Date.now() });
    return true;
  } catch (e) {
    return false;   // 日志写失败 → 返回 false，绝不吞掉后假装成功
  }
}

// ---- 日志身份检索（Tom #4：不得只取「最后一条」，必须按 requestHash/subBatchId/uuid 绑定）----
// 返回该 jobId+itemId 下的全部日志（append 顺序）。deps.journalList 为权威；缺失则退化为单条 journalGet。
function _journalRecords(deps, jobId, itemId) {
  var recs = null;
  if (typeof deps.journalList === 'function') {
    try { recs = deps.journalList(jobId, itemId); } catch (e) { recs = null; }
  }
  if (Array.isArray(recs)) return recs;
  if (typeof deps.journalGet === 'function') {
    try {
      var one = deps.journalGet(jobId, itemId);
      return one ? [one] : [];
    } catch (e2) { return []; }
  }
  return [];
}
// 按【请求身份】定位完成凭据：必须 requestHash 相同 且 state==='COMMITTED' 且非 dry 记录。
function _findCommit(records, requestHash) {
  for (var i = records.length - 1; i >= 0; i--) {
    var r = records[i];
    if (r && r.state === 'COMMITTED' && r.requestHash === requestHash && r.dry !== true) return r;
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
    var entry = wantHash ? (_findCommit(recs, wantHash) || _lastRecord(recs)) : _lastRecord(recs);

    // 身份绑定校验：日志记录的身份必须与本次查询声明一致，否则不可归属本请求
    var identityOk = true, identityWhy = '';
    if (entry) {
      if (wantHash && entry.requestHash != null && String(entry.requestHash) !== wantHash) {
        identityOk = false; identityWhy = 'REQUEST_HASH_MISMATCH';
      } else if (wantBatch && entry.subBatchId != null && String(entry.subBatchId) !== wantBatch) {
        identityOk = false; identityWhy = 'SUBBATCH_MISMATCH';
      } else if (wantUuid && entry.uuid != null && String(entry.uuid) !== wantUuid) {
        identityOk = false; identityWhy = 'UUID_MISMATCH';
      }
    }

    var oVal = null, oErr = null;
    try { oVal = deps.readProdO ? deps.readProdO(itemId) : null; }
    catch (re) { oErr = String(re && re.message || re); }
    var oTrue = (oVal === true || String(oVal || '').toUpperCase() === 'TRUE');

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
    } else {
      state = entry.state;                     // PREPARED 等
    }
    out.push({ jobId: jobId, itemId: itemId, subBatchId: entry ? entry.subBatchId : null,
      requestHash: entry ? entry.requestHash : null, uuid: entry ? entry.uuid : null,
      state: state, journalState: entry ? entry.state : null,
      identity: identityOk ? 'BOUND' : identityWhy, oValue: oVal, oReadError: oErr });
  }
  return _res(true, { action: 'statusQuery', batchId: jobId, rows: out });
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
  if (!js) { js = ss.insertSheet('_TS_SOFTDEL_LOG'); js.appendRow(['ts', 'jobId', 'subBatchId', 'itemId', 'requestHash', 'uuid', 'state']); }
  js.appendRow([Utilities.formatDate(new Date(), 'GMT+8', 'yyyy-MM-dd HH:mm:ss'),
    rec.jobId, rec.subBatchId, rec.itemId, rec.requestHash, rec.uuid, rec.state]);
}
function _sdGasJournalGet(jobId, itemId) {
  try {
    var ss = SpreadsheetApp.openById(TS_ID);
    var js = ss.getSheetByName('_TS_SOFTDEL_LOG');
    if (!js) return null;
    var g = js.getDataRange().getValues();
    for (var i = g.length - 1; i >= 1; i--) {
      if (String(g[i][1] || '') === String(jobId) && String(g[i][3] || '') === String(itemId)) {
        return { jobId: g[i][1], subBatchId: g[i][2], itemId: g[i][3], requestHash: g[i][4], uuid: g[i][5], state: g[i][6] };
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
        out.push({ jobId: g[i][1], subBatchId: g[i][2], itemId: g[i][3], requestHash: g[i][4], uuid: g[i][5], state: g[i][6] });
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

    var deps = {
      PL_DB_SHEET: PL_DB_SHEET,
      isClearance: function (tok, rows) { return false; },          // 默认不放开门禁
      guardCheck: function (bizDate, origBiz, policy) { return pl._plGuardCheck(bizDate, origBiz, policy || pl._plPolicy()); },
      policy: function () { return pl._plPolicy(); },
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

