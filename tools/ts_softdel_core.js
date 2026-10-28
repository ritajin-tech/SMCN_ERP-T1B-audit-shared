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

var norm = require('./ts_softdel_norm.js');
var pl = require('./period_lock_port.js');
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
        // 不可读取 ≠ 允许新写（Tom 第 2 项）
        if (_isReadError(_recs)) {
          results.push({ row: row, ok: false, wrote: false, reason: 'JOURNAL_READ_ERROR',
            state: 'UNKNOWN', detail: _recs.detail });
          anyFail = true; continue;
        }
        var _commit = _findCommit(_recs, requestHash, batchId, uuid);
        if (_commit && _commit.__voided) {
          // 同身份已存在失效记录 ⇒ 不得再声称幂等成功（VOIDED > COMMITTED）
          results.push({ row: row, ok: false, wrote: false, reason: 'PRIOR_VOIDED',
            state: 'VOIDED', priorState: _commit.record.state, priorReason: _commit.record.reason || null });
          anyFail = true; continue;
        }
        if (_commit) {
          var oNow = null, oErr = null;
          try { oNow = deps.readProdO ? deps.readProdO(row) : null; }
          catch (oe) { oErr = String(oe && oe.message || oe); }
          if (oErr || oNow === null || oNow === undefined) {
            results.push({ row: row, ok: false, wrote: false, reason: 'IDEMPOTENT_RECHECK_UNAVAILABLE', state: 'UNKNOWN', error: oErr || '' });
            anyFail = true; continue;
          }
          if (!_sdSoftDel(oNow)) {
            _jrn(deps, jobId, batchId, itemId, requestHash, uuid, dry, 'UNKNOWN', 'IDEMPOTENT_O_DRIFT', keeperRow);
            results.push({ row: row, ok: false, wrote: false, reason: 'IDEMPOTENT_O_DRIFT', expect: 'TRUE', actual: String(oNow) });
            anyFail = true; continue;
          }
          // v5（Tom 第 6 项）：幂等成功除回读 O 外，还必须复核【当前行 UUID 与 keeper 仍匹配】。
          //   只回读 O 会让「行已被换成人家的 UUID / keeper 已被软标」也照样报成功。
          var idRow = null, idErr = null;
          try { idRow = deps.readProdRow ? deps.readProdRow(row) : null; } catch (ie) { idErr = String(ie && ie.message || ie); }
          var idKeeper = null;
          try { idKeeper = deps.readProdRow ? deps.readProdRow(keeperRow) : null; } catch (ke) { idKeeper = null; }
          if (idErr || !idRow || !idKeeper) {
            _jrn(deps, jobId, batchId, itemId, requestHash, uuid, dry, 'UNKNOWN', 'IDEMPOTENT_IDENTITY_UNAVAILABLE', keeperRow);
            results.push({ row: row, ok: false, wrote: false, reason: 'IDEMPOTENT_IDENTITY_UNAVAILABLE', state: 'UNKNOWN', error: idErr || '' });
            anyFail = true; continue;
          }
          // v6（Tom #4）：诚实核【keeper】——除目标 UUID 与 keeper 未软标外，必须复核 keeper 当前负载
          //   仍与原快照一致（liveKHash === it.keeperHash）；否则「keeper 行已被改写/替换」也照样报成功。
          var liveKHashIdem = _sdRowHash(idKeeper, timeOnly);
          if (norm._sdNorm(idRow[8]) !== uuid || _sdSoftDel(idKeeper[14]) || liveKHashIdem !== it.keeperHash) {
            _jrn(deps, jobId, batchId, itemId, requestHash, uuid, dry, 'UNKNOWN', 'IDEMPOTENT_IDENTITY_DRIFT', keeperRow);
            results.push({ row: row, ok: false, wrote: false, reason: 'IDEMPOTENT_IDENTITY_DRIFT',
              state: 'UNKNOWN', uuidActual: norm._sdNorm(idRow[8]), keeperO: String(idKeeper[14]),
              keeperHashActual: liveKHashIdem, keeperHashExpect: it.keeperHash });
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
          _jrn(deps, jobId, batchId, itemId, requestHash, uuid, dry, 'REJECTED', keeperRow);
          results.push({ row: row, ok: false, reason: 'KEY_REUSE_CONFLICT', priorHash: _anyCommit.requestHash });
          anyFail = true; continue;
        }

        // 锁内重读实时值
        var vals = deps.readProdRow(row);
        if (!vals) { _jrn(deps, jobId, batchId, itemId, requestHash, uuid, dry, 'REJECTED', keeperRow); results.push({ row: row, ok: false, reason: 'ROW_NOT_FOUND' }); anyFail = true; continue; }
        var kVals = deps.readProdRow(keeperRow);

        if (norm._sdNorm(vals[8]) !== uuid) { _jrn(deps, jobId, batchId, itemId, requestHash, uuid, dry, 'REJECTED', keeperRow); results.push({ row: row, ok: false, reason: 'UUID_DRIFT', actual: norm._sdNorm(vals[8]) }); anyFail = true; continue; }
        if (_sdSoftDel(vals[14])) { _jrn(deps, jobId, batchId, itemId, requestHash, uuid, dry, 'REJECTED', keeperRow); results.push({ row: row, ok: false, wrote: false, reason: 'ALREADY_SOFTDEL' }); anyFail = true; continue; }
        if (!kVals || _sdSoftDel(kVals[14])) { _jrn(deps, jobId, batchId, itemId, requestHash, uuid, dry, 'REJECTED', keeperRow); results.push({ row: row, ok: false, reason: 'KEEPER_INVALID' }); anyFail = true; continue; }

        // 条件 #2：CAS 绑定到已审计原值（SHA-256 指纹，含列1业务日期/排除列0当 timeOnly/含列14审计）
        var liveHash = _sdRowHash(vals, timeOnly);
        var liveKHash = _sdRowHash(kVals, timeOnly);
        if (liveHash !== it.expectHash) { _jrn(deps, jobId, batchId, itemId, requestHash, uuid, dry, 'REJECTED', keeperRow); results.push({ row: row, ok: false, reason: 'TARGET_DRIFT', expect: it.expectHash, actual: liveHash }); anyFail = true; continue; }
        if (liveKHash !== it.keeperHash) { _jrn(deps, jobId, batchId, itemId, requestHash, uuid, dry, 'REJECTED', keeperRow); results.push({ row: row, ok: false, reason: 'KEEPER_DRIFT', expect: it.keeperHash, actual: liveKHash }); anyFail = true; continue; }

        // 条件 #2：timeOnly 时录入时间分别绑定（双方），差异被接受但必须"被声明且匹配"
        if (timeOnly) {
          var liveEntry = _sdCellHash(vals[0]);
          var liveKEntry = _sdCellHash(kVals[0]);
          if (liveEntry !== it.expectEntryTime || liveKEntry !== it.keeperEntryTime) {
            _jrn(deps, jobId, batchId, itemId, requestHash, uuid, dry, 'REJECTED', keeperRow);
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
        if (diffs.length > 0 && !allowed) { _jrn(deps, jobId, batchId, itemId, requestHash, uuid, dry, 'REJECTED', keeperRow); results.push({ row: row, ok: false, reason: 'PAYLOAD_DIFF', cols: diffs }); anyFail = true; continue; }

        // 条件 #3：真实期锁（锁内对目标行业务日期跑真实 _plGuardCheck）。
        //   业务日期以【原始值】传入（可能是 Date 或字符串），由 _plParseBizDate 原生处理；
        //   不再经 _sdNorm 把 Date 污损成一长串 ISO 串导致解析失败被整体拒掉。
        var bizDate = vals[1];
        var g = deps.guardCheck(bizDate, null, policy);
        if (!g.ok && !clearanceOk) { _jrn(deps, jobId, batchId, itemId, requestHash, uuid, dry, 'REJECTED', keeperRow); results.push({ row: row, ok: false, reason: 'PERIOD_LOCKED', date: norm._sdNorm(bizDate), detail: g.reason || '' }); anyFail = true; continue; }

        // 等级与底稿核对（A：底稿恰 1 行且哈希/状态相符；B：底稿 0 行）
        if (level === 'A') {
          var mMatches = masterMap[uuid] || [];
          if (mMatches.length !== 1) { _jrn(deps, jobId, batchId, itemId, requestHash, uuid, dry, 'REJECTED', keeperRow); results.push({ row: row, ok: false, reason: (mMatches.length === 0 ? 'BASE_NOT_FOUND' : 'BASE_NOT_UNIQUE'), count: mMatches.length }); anyFail = true; continue; }
          var mHash = _sdRowHash(mMatches[0].cells, false);
          if (mHash !== it.expectBaseHash) { _jrn(deps, jobId, batchId, itemId, requestHash, uuid, dry, 'REJECTED', keeperRow); results.push({ row: row, ok: false, reason: 'BASE_DRIFT', expect: it.expectBaseHash, actual: mHash }); anyFail = true; continue; }
        } else {
          var mB = masterMap[uuid] || [];
          if (mB.length !== 0) { _jrn(deps, jobId, batchId, itemId, requestHash, uuid, dry, 'REJECTED', keeperRow); results.push({ row: row, ok: false, reason: 'BASE_HAS_MATCH', count: mB.length }); anyFail = true; continue; }
        }

        // PREPARED 日志：落盘前必须成功；日志失败 → 阻断写，记为 UNKNOWN（Tom #4）。
        // dry 不写业务恢复日志（Tom #4）：dry 不产生任何写入，也就不该产生「待恢复」凭据，
        // 否则状态查询会把一次 dry 的 PREPARED 误读成「本请求已落盘待确认」。
        var prepOk = _jrn(deps, jobId, batchId, itemId, requestHash, uuid, dry, 'PREPARED', keeperRow);
        if (!prepOk) { results.push({ row: row, ok: false, wrote: false, reason: 'PREPARED_LOG_FAILED' }); anyFail = true; continue; }

        // 写 O 列（仅非 dry 且上述全过）
        if (!dry) {
          var wroteOk = false;
          try {
            wroteOk = deps.writeProdO(row, 'TRUE');
          } catch (we) {
            // 条件 #6：flush 异常 —— 已尝试写但无法确认落盘，区分"已写未确认"
            _jrn(deps, jobId, batchId, itemId, requestHash, uuid, dry, 'UNKNOWN', null, keeperRow);
            results.push({ row: row, ok: false, wrote: false, reason: 'WRITE_FLUSH_EXCEPTION', error: String(we && we.message || we) });
            anyFail = true; continue;
          }
          if (!wroteOk) {
            // Tom #4：writeProdO 返回 false 只说明「未确认」，不说明「未写」（GAS flush 异常被吞时尤其如此）。
            // 因此登记 UNKNOWN（写可能已发生），绝不记 REJECTED 以免被误读为「已确认未写」。
            _jrn(deps, jobId, batchId, itemId, requestHash, uuid, dry, 'UNKNOWN', null, keeperRow);
            results.push({ row: row, ok: false, wrote: false, reason: 'WRITE_FAILED_UNCONFIRMED', state: 'UNKNOWN' });
            anyFail = true; continue;
          }
          var after = null;
          try { after = deps.readProdO(row); }
          catch (re) {
            // 写了但回读失败 → 已写未确认（非"未写"），留 UNKNOWN
            _jrn(deps, jobId, batchId, itemId, requestHash, uuid, dry, 'UNKNOWN', null, keeperRow);
            results.push({ row: row, ok: false, wrote: true, reason: 'WRITE_UNCONFIRMED', error: String(re && re.message || re) });
            anyFail = true; continue;
          }
          // v5（Tom 第 6 项）：①用 _sdNormO 统一 O 类型（布尔 true 与 'TRUE' 等价，
          //   此前 _sdNorm(true)='true' 与 'TRUE' 比较必然失败，把已成功的写入误记为 REJECTED）；
          //   ②写已发生但回读不符 ⇒ 只能登记 UNKNOWN，**不能**记 REJECTED
          //   （REJECTED 会被误读为「已确认未写」，而此处写可能已经落盘）。
          if (norm._sdNormO(after) !== 'TRUE') {
            _jrn(deps, jobId, batchId, itemId, requestHash, uuid, dry, 'UNKNOWN', 'WRITE_NOT_CONFIRMED', keeperRow);
            results.push({ row: row, ok: false, wrote: true, reason: 'WRITE_NOT_CONFIRMED', state: 'UNKNOWN', actual: String(after) });
            anyFail = true; continue;
          }
          wrote = true;
          // v6（Tom #3）：COMMITTED 不在本行内落盘 —— 必须等【写后主库版本复核通过】（见下方 post-loop）
          //   统一落 COMMITTED。此处只确认 O 写入成功；崩溃窗口（写后/复核前进程终止）恢复为 UNKNOWN，
          //   禁止自动重写（见 _findCommit 的 VOIDED > COMMITTED 优先级）。
        }
        var _rr = { row: row, ok: true, wrote: wrote, level: level, requestHash: requestHash, uuid: uuid, keeperRow: keeperRow };
        results.push(_rr);
        if (wrote) { patched++; wroteRows.push(_rr); }
      } catch (rerr) {
        // 读类异常 → 行未读/未写（非 flush）；flush 已在上面单独区分
        _jrn(deps, jobId, batchId, itemId, requestHash, uuid, dry, 'REJECTED', keeperRow);
        results.push({ row: row, ok: false, reason: 'ROW_READ_FAIL', error: String(rerr && rerr.message || rerr) });
        anyFail = true;
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
    deps.journalAppend({ jobId: jobId, subBatchId: subBatchId, itemId: itemId, requestHash: requestHash,
      state: state, uuid: uuid == null ? null : String(uuid),
      reason: reason == null ? null : String(reason),
      keeperRow: keeperRow == null ? null : Number(keeperRow),
      keeperUuid: keeperUuid, keeperHash: keeperHash,
      ts: Date.now() });
    return true;
  } catch (e) {
    return false;   // 日志写失败 → 返回 false，绝不吞掉后假装成功
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

module.exports = {
  tsSoftDelGuardedCore: tsSoftDelGuardedCore,
  tsSoftDelStatus: tsSoftDelStatus,
  _validateInput: _validateInput,
  journal: journal,
  _requestHashOf: _requestHashOf,
  _journalRecords: _journalRecords, _isReadError: _isReadError, _findCommit: _findCommit,
  _jrn: _jrn,
  _findAnyCommit: _findAnyCommit, _lastRecord: _lastRecord,
  VERSION: VERSION,
  ROW_KEYS: ROW_KEYS, TOP_KEYS: TOP_KEYS
};
