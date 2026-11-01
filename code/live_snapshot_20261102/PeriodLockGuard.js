/**
 * T1-B · period-lock guard 模块 · 实现 v4（本地代码，零生产写）
 * ============================================================
 * 依据：v5 设计 + Tom 09:27 五条 + 09:59 五条 + 10:58 四条
 *（逐条核实全部属实，全部吸收）。
 *
 * v2(00d00ba) → v3 修订：
 *  [审①] _plRecheckRow 增 expectDeleted（删除幂等：锁内已删 → 拒）；
 *         _plRowContentHash 覆盖列明确定义（B..N 全列+O，含 K/M；类型转换与
 *         分隔冲突规则见函数注释）。
 *  [审②] _plGuardedInsert：lockPreWrite 去重结果为空 → 直接返回无新增约定，
 *         不进入 bizWrite、不构造高度 0 区域、不误登记不确定。
 *  [审③] _plLogUncertain 不自动建表（建表＝授权动作，改由部署包显式含建表步骤）；
 *         登记失败以 plLogFailed 标识贯穿（guard 在错误对象上挂标识，入口原样抛出
 *         时调用方可见）；每失败路径仅尝试登记一次。
 *  [审④] _plValidCutoff 真实日历校验（经 _plParseBizDate 回验）；
 *         双 fallback：无策略（首次，部署包负责初始化）＝ closed=true+futureOpen=true；
 *         读取/解析故障 ＝ closed=true+**futureOpen=false**（未知时拒绝受影响写——
 *         失败政策收紧为安全默认；收紧不构成授权扩大，放宽才须 Rita 显式决定）。
 *  [审⑤] _plGuardPatch：row<2（表头）单独状态 header → B/O:Q 写表头一律拒；
 *         O:Q 删除场景统一走 _plGuardCheck（与 mutation 同一期间政策，含 futureOpen）。
 *
 * v4(0534a88) → v5 修订（吸收 Tom 11:27 两条）：
 *  [审⑥] 哨兵三态+保守写序：_plPolicy 中哨兵读取用显式 ok 标志区分三态
 *         （'1'=已初始化 / 确定值=未初始化 / **读取异常=unknown**）；
 *         sentinelOk=false 时无论策略键是否有值一律 fail-closed 收紧
 *         （修掉「策略键无值+哨兵读取故障被当首次态放开」）；
 *         _plSetPolicy 改**先哨兵后策略**——任一写步骤失败的中间残留
 *         （有哨兵无策略）收敛到 policy-lost 收紧侧，不再产生「有策略无哨兵」
 *         后被当首次态放大的残留。不引入事务/自动恢复（按 Tom 指示）。
 *  [审⑦] 错误透出（见集成源码）：tsAppendRows catch JSON 补 plCause；辅助
 *         _tsWriteLog 包 try/catch，日志失败不遮蔽原 uncertain 结果且置
 *         logFailed=true，不自动重放业务写。
 *
 * v3(d214013) → v4 修订（Tom 10:58 四条，逐条核实全部属实）：
 *  [审①-版本] **请求级版本绑定**：期望版本由修改/删除请求携带（客户端表单加载时
 *         服务端下发的行版本），不再用「请求到达后新读的行」充当用户编辑依据；
 *         缺省拒绝 PL_REJECT_MISSING_EXPECT_VERSION（fail-closed，不继续称已解决
 *         请求级 last-write-wins）。服务端锁内重核窗口防护保留为第二层。
 *         tsPatchCells 通道无请求级版本概念，明确降格为「仅服务端短窗口防护」，
 *         供内部批量工具使用，不宣称请求级保护。
 *  [审②-编码] _plRowContentHash 检测业务字段内的分隔符 \u0001：出现即返回 null
 *         （无法无歧义定版），调用方按 PL_REJECT_CONTENT_ENCODING 拒（fail-closed），
 *         消除 [a\u0001b,c] 与 [a,b\u0001c] 同串假阳性漏拒。
 *  [审③-分层] flush 失败：plLogFailed 按 _plLogUncertain 实际返回值设置
 *         （登记成功=false，不再误报）；bizWrite 阶段失败统一包装
 *         PL_UNCERTAIN_BIZ_WRITE_FAILED + plCause（保留原原因），与预检拒绝
 *         PL_REJECT_* 显式分层——调用方可见「结果不确定」而非裸普通错误。
 *  [审④-结构] _plPolicy schema 严格校验：closed/futureOpen 必须为 boolean、
 *         cutoff 必须为合法日历字符串；{}、缺字段、字符串 'false' 等一律
 *         fail-closed（收紧），不再默认未来开放。新增初始化哨兵
 *         PL_POLICY_INIT_KEY：_plSetPolicy 置 '1'；曾有初始化记录而策略键
 *         丢失/空值 → policy-lost 收紧（与「从未初始化」的首次态区分）。
 *
 * v6(ed76a62) → v7 修订（吸收 Tom 14:28 核对清单四条）：
 *  [审⑧-覆盖] 错误传输契约覆盖**全部五个 mutation 入口**：_plUncertainPayloadMsg
 *         由集成源码移入本 guard 定义层（guard 先部署、集成源码后部署，helper 须
 *         在定义层自包含）；_plGuardedInsert 的 flush/bizWrite 两处 uncertain
 *         抛出改用它构造 message——修掉 submitBatch / tsAppendRows 路径
 *         「只抛裸码、登记真假与原因不可恢复」的断链（tsPatchCells 侧见集成源码）。
 *  [审⑧-消毒] _plSanitizeCause：cause 截断至 200 字符 + 连续 24+ 位字母数字串
 *         （token/UUID 形态）打码——不把令牌或潜在敏感串带进 UI/日志。
 *         （员工原始行内容不经 cause 传输：当前全部 cause 来源均为服务端自构造
 *         文案或 GAS 服务异常 message，件中照实登记该边界，不宣称绝对。）
 *
 * 🔴 零生产写本地实现；接入生产须 Rita 显式 GO + 双授权闸门。
 */

// ============================================================
// 0. 常量与策略持久化（M2/M3/M4）
// ============================================================

var PL_CUTOFF = '2026-10-01';
var PL_POLICY_KEY = 'PERIOD_LOCK_STATE';
var PL_POLICY_INIT_KEY = 'PERIOD_LOCK_POLICY_INIT';   // [审④] 初始化哨兵：置 '1' 后策略键丢失=收紧
var PL_LOCK_TIMEOUT_MS = 5000;
var PL_DB_SHEET = 'DB_工时流水';

/** [审④] cutoff 真实日历校验：严格 yyyy-MM-dd 且为真实存在日期。 */
function _plValidCutoff(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  var b = _plParseBizDate(s);
  return b === s;                                   // 回验：'2026-00-01' 等假日期拒
}

/**
 * M3：读锁政策态。[审④] 三态 + schema 严格校验：
 *   - **真首次态**（无初始化哨兵且策略键无值）：closed=true, futureOpen=true
 *     （部署包须显式初始化，见集成部署清单）；
 *   - **策略丢失**（有初始化哨兵但策略键无值/空串）：fail-closed 收紧——
 *     曾初始化过又丢失 ≠ 首次部署，不可仅凭当前空值区分，未知时保守拒；
 *   - 读取异常 / JSON 坏 / 结构非法（{}、缺字段、类型不符、cutoff 非法日历）：
 *     fail-closed 收紧（closed=true, futureOpen=false）——未知时拒绝受影响写
 *     （故障不放宽；原 futureOpen=false 时读取故障不会变成放行未来）；
 *   - 正常：closed/futureOpen 按存储值（布尔严格校验通过）。
 */
function _plPolicy() {
  var raw = null;
  try {
    raw = PropertiesService.getScriptProperties().getProperty(PL_POLICY_KEY);
  } catch (e) {
    return _plFailClosedPolicy('read-error');      // 故障 → 收紧
  }
  // [审⑤-v5] 哨兵三态：'1'=已初始化；确定值（'0'/null）=确定未初始化；
  // **读取异常=unknown**——不得与「确定未初始化」混淆（Tom 11:27 残项1：
  // 策略键无值+哨兵读取故障若当首次态放开，故障反而放宽未知状态）。
  // 注意：GAS getProperty 对不存在的 key 返回 null（不抛错），故必须用显式
  // ok 标志区分「读到 null=确定未初始化」与「抛错=unknown」。
  var sentinel = null, sentinelOk = false;
  try {
    sentinel = PropertiesService.getScriptProperties().getProperty(PL_POLICY_INIT_KEY);
    sentinelOk = true;
  } catch (e2) { sentinelOk = false; }
  var initialized = sentinelOk && (sentinel === '1');
  if (!sentinelOk) {
    // [审⑤-v5] 哨兵读取故障：无论策略键是否有值，初始化状态整体未知——保守拒
    // （Tom 11:27：「将哨兵未知/读取失败与确定未初始化区分并保守拒」）。
    // 注：raw 读取成功而哨兵读取失败虽概率极低（同一 PropertiesService 连续
    // 两次调用），但此时策略值的新鲜度同样不可信，收紧不构成授权扩大。
    return _plFailClosedPolicy('sentinel-unknown');
  }
  if (!raw) {
    if (initialized) {
      // [审④] 曾有初始化记录而策略键丢失/空串：不可当首次态放开
      return _plFailClosedPolicy('policy-lost');
    }
    // 真首次态（非故障）：closed=true 保护历史；futureOpen=true 未来正常放行；
    // 部署包须显式初始化策略（见集成部署清单）。
    return { closed: true, cutoff: PL_CUTOFF, futureOpen: true,
             updatedBy: 'initial-unset', updatedAt: '', source: 'unset' };
  }
  try {
    var p = JSON.parse(raw);
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      return _plFailClosedPolicy('parse-error');
    }
    // [审④] schema 严格校验：必需字段存在且类型正确；字符串 'false'、缺字段、
    // {} 等一律视为结构非法 → 收紧（不默认未来开放）。
    if (typeof p.closed !== 'boolean' || typeof p.futureOpen !== 'boolean') {
      return _plFailClosedPolicy('schema-error');
    }
    if (typeof p.cutoff !== 'string' || !_plValidCutoff(p.cutoff)) {
      return _plFailClosedPolicy('schema-error');
    }
    return {
      closed: p.closed,
      cutoff: p.cutoff,
      futureOpen: p.futureOpen,
      updatedBy: String(p.updatedBy || ''),
      updatedAt: String(p.updatedAt || ''),
      source: 'props'
    };
  } catch (e) {
    return _plFailClosedPolicy('parse-error');
  }
}

function _plFailClosedPolicy(reason) {
  return { closed: true, cutoff: PL_CUTOFF, futureOpen: false,
           updatedBy: 'fail-closed-' + reason, updatedAt: '', source: 'fail-closed' };
}

/** M3：写锁政策态（受控流程调用；部署包初始化亦走此函数）。
 *  [审⑤-v5] 保守写序（Tom 11:27 残项1 第二部分）：**先写哨兵、后写策略**。
 *  旧序（先策略后哨兵）的残留态「有策略无哨兵」会在策略丢失时被当首次态放开；
 *  新序的残留态为「有哨兵无策略」→ _plPolicy 识别为 policy-lost 收紧。
 *  即任一写步骤失败的中间态都收敛到**收紧侧**（安全侧），不放宽未知状态。
 *  不引入事务、不自动恢复（按 Tom 指示：不要求事务或自动恢复）。
 */
function _plSetPolicy(closed, futureOpen, updatedBy) {
  var props = PropertiesService.getScriptProperties();
  // 第一步：初始化哨兵（此后任何策略键缺失都将被识别为 policy-lost 收紧）
  props.setProperty(PL_POLICY_INIT_KEY, '1');
  // 第二步：写策略本体
  props.setProperty(PL_POLICY_KEY, JSON.stringify({
    closed: !!closed,
    cutoff: PL_CUTOFF,
    futureOpen: !!futureOpen,
    updatedBy: String(updatedBy || ''),
    updatedAt: Utilities.formatDate(new Date(), 'GMT+8', 'yyyy-MM-dd HH:mm:ss'),
    source: 'props'
  }));
}

// ============================================================
// 1. 业务日解析与期间判定（M2/M7）
// ============================================================

/**
 * M7：明确业务日解析，完整匹配：
 *   Date 对象 | yyyy-MM-dd | yyyy-MM-ddTHH:mm[:ss] | yyyy-MM-dd HH:mm[:ss] | yyyy/M/d
 * 尾缀垃圾/非法时分秒/越界/假日期 → null。一律 GMT+8 归日。
 */
function _plParseBizDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return Utilities.formatDate(v, 'GMT+8', 'yyyy-MM-dd');
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

function _plIsClosedBizDate(bizDate, cutoff) {
  return String(bizDate) < String(cutoff);
}

// ============================================================
// 2. 写网关双向门禁（M1）—— 原值三态
// ============================================================

var PL_UNKNOWN = '__PL_UNKNOWN__';

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

function _plGuardCheckBatch(rows, dateOf, policy) {
  for (var i = 0; i < rows.length; i++) {
    var r = _plGuardCheck(dateOf(rows[i]), null, policy);
    if (!r.ok) return { ok: false, reason: r.reason, index: i };
  }
  return { ok: true, reason: '', index: -1 };
}

// ============================================================
// 3. LockService 临界区（M8）+ 锁内重核 + 写完成边界
// ============================================================

function _plAcquire(timeoutMs) {
  var lock = LockService.getScriptLock();
  var got = false;
  try { got = lock.tryLock(timeoutMs || PL_LOCK_TIMEOUT_MS); } catch (e) { got = false; }
  if (!got) {
    var err = new Error('PL_REJECT_LOCK_BUSY');
    err.plCode = 'PL_REJECT_LOCK_BUSY';
    throw err;
  }
  return lock;
}

/**
 * [审②-编码] 内容版本哈希。覆盖列明确定义：
 *   B(2) fillDate, C(3) name, D(4) type, E(5) stage, F(6) pid, G(7) hours,
 *   H(8) notes, I(9) uuid, J(10) pname, K(11), L(12) leader, M(13), N(14) ym, O(15) del
 *   ——即索引 1..14（B..O）。类型转换：String(v)（null/undefined → ''）。
 *   **分隔冲突显式拒绝**（v4）：任一字段 String 后含分隔符 \u0001 → 返回 null
 *   （该行无法无歧义定版）。调用方（入口锁外计算时期）必须将 null 按
 *   PL_REJECT_CONTENT_ENCODING 拒之，fail-closed；否则 [a\u0001b,c] 与
 *   [a,b\u0001c] join 后同串会造成假阳性漏拒。
 */
function _plRowContentHash(row) {
  var parts = [];
  for (var i = 1; i <= 14; i++) {
    var v = row[i];
    var s = (v === null || v === undefined) ? '' : String(v);
    if (s.indexOf('\u0001') >= 0) return null;     // [审②-编码] 含分隔符 → 不可定版
    parts.push(s);
  }
  return parts.join('\u0001');
}

/**
 * M8：[审①] 锁内重核。返回实际行号 + 内容版本 + 活动状态。
 *   expectContentHash：**请求级期望版本**（客户端编辑依据的行版本，由请求携带）——
 *     缺省（undefined/null/空串）→ PL_REJECT_MISSING_EXPECT_VERSION（fail-closed，
 *     不继续称已解决请求级 last-write-wins）；与锁内实读不符 →
 *     PL_REJECT_CONTENT_VERSION。
 *   expectDeleted：调用方锁外读到的软删状态（false=锁前未删）；锁内为 true →
 *     PL_REJECT_ALREADY_DELETED（删除幂等：已删行的更新/再删一律拒）。
 */
function _plRecheckRow(sheet, uuid, expectContentHash, expectName, expectDeleted) {
  var out = { found: false, row: 0, bizDate: null, deleted: false,
              contentHash: null, mismatch: false, reason: '' };
  if (!uuid) { out.mismatch = true; out.reason = 'PL_REJECT_NO_UUID'; return out; }
  if (expectContentHash === undefined || expectContentHash === null || expectContentHash === '') {
    out.mismatch = true; out.reason = 'PL_REJECT_MISSING_EXPECT_VERSION'; return out;
  }
  var data = sheet.getDataRange().getValues();
  var hits = 0;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][8] || '').trim() !== String(uuid).trim()) continue;
    hits++;
    if (hits > 1) {
      out.mismatch = true; out.reason = 'PL_REJECT_UUID_NOT_UNIQUE';
      return out;
    }
    out.found = true;
    out.row = i + 1;
    var b = _plParseBizDate(data[i][1]);
    if (!b) { out.mismatch = true; out.reason = 'PL_REJECT_ORIG_UNKNOWN'; return out; }
    out.bizDate = b;
    var dv = data[i][14];
    out.deleted = (dv === true || String(dv).toUpperCase() === 'TRUE');
    if (expectDeleted === false && out.deleted === true) {          // [审①] 删除幂等
      out.mismatch = true; out.reason = 'PL_REJECT_ALREADY_DELETED';
      return out;
    }
    out.contentHash = _plRowContentHash(data[i]);
    if (expectName && String(data[i][2] || '').trim() !== String(expectName).trim()) {
      out.mismatch = true; out.reason = 'PL_REJECT_OWNER_MISMATCH'; return out;
    }
  }
  if (!out.found) { out.mismatch = true; out.reason = 'PL_REJECT_ROW_GONE'; return out; }
  if (out.contentHash !== expectContentHash) {   // expectContentHash 已保证非空（缺省即拒）
    out.mismatch = true; out.reason = 'PL_REJECT_CONTENT_VERSION';
  }
  return out;
}

/**
 * R12b：[审③] 不确定批次登记。
 *   - **不自动建表**（建表＝授权动作）：_TS_WRITE_LOG 不存在 → 返回 false；
 *   - 返回 true=已登记；false=登记失败（调用方须外显，不得吞）。
 */
function _plLogUncertain(action, detail) {
  try {
    var ss = SpreadsheetApp.openById(TS_ID);
    var sh = ss.getSheetByName('_TS_WRITE_LOG');
    if (!sh) return false;                        // [审③] 不自动建表
    sh.appendRow([Utilities.formatDate(new Date(), 'GMT+8', 'yyyy-MM-dd HH:mm:ss'),
                  'period-lock uncertain: ' + action,
                  detail + ' (待人工核查，未自动重试/回滚/补偿)']);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * [审⑧-v7] 错误传输接口契约辅助（runbook v3 §2.5，v7 起为五入口统一实现，
 * 由集成源码移入本 guard 定义层——guard 先部署，helper 不得依赖后部署文件）。
 *
 * 问题：google.script.run 的 failure handler 只跨边界传递 error message 字符串，
 * Error 自定义属性（plLogFailed/plCause）能否随之序列化未经实测——契约不得依赖
 * 该未验证行为。若只按 message 文本匹配 PL_UNCERTAIN_* 码，登记真假与原始原因
 * 不可恢复，前端无法区分「已登记待核查」与「登记失败」。
 *
 * 契约：uncertain 态把状态安全序列化进 message——
 *   <码>|{"logFailed":true|false,"cause":"<消毒后的原始错误字符串>"}
 *   以第一个 '|' 切分（码字符集 [A-Z_] 不含 '|'，切分位置无歧义；cause 中的
 *   '|' 不影响，因为只切第一个）。拒绝码（PL_REJECT_*）不载荷：拒绝时不发生
 *   登记，无状态需要传。属性仍照旧挂在 Error 上（不依赖、不删除）。
 *
 * 适用入口（v7 全覆盖）：submitBatch / tsAppendRows（经 _plGuardedInsert）、
 * tsPatchCells（集成源码调用）、updateTimesheet / softDeleteRecord（集成源码调用）。
 */
function _plUncertainPayloadMsg(e) {
  if (!e || !e.plCode || String(e.plCode).indexOf('PL_UNCERTAIN_') !== 0) return '';
  var payload = { logFailed: !!e.plLogFailed, cause: _plSanitizeCause(e.plCause) };
  return e.plCode + '|' + JSON.stringify(payload);
}

/**
 * [审⑧-v7] cause 消毒（载荷安全，Tom 14:28 清单第 3 条）：
 *  - 截断至 200 字符（诊断必要最小长度，防超长堆栈灌满 UI/日志）；
 *  - 连续 24+ 位字母数字串（token/UUID 等形态）整体打码。
 * 照实边界：当前全部 cause 来源均为服务端自构造文案或 GAS 服务异常 message，
 * 员工原始行内容不经 cause 传输；本函数不宣称绝对防护，仅收窄泄漏面。
 */
function _plSanitizeCause(c) {
  var s = String(c || '');
  if (s.length > 200) s = s.slice(0, 200) + '…[truncated]';
  s = s.replace(/[A-Za-z0-9_\-]{24,}/g, '[redacted]');
  return s;
}

/**
 * [v3 遗留，v4 起弃用] 曾用于把登记失败标识挂到错误对象上；v4 [审③] 改为
 * plLogFailed 一律按 _plLogUncertain 实际返回值设置（防止登记成功仍误报），
 * 本函数不再被调用，保留仅为避免破坏既有引用。
 */
function _plMarkLogFailed(err) {
  if (err && typeof err === 'object') err.plLogFailed = true;
  return err;
}

/**
 * M8 主编排（改/删场景）。门禁原期间取锁内实读。
 * 失败路径仅尝试登记一次（[审③]）；登记失败以 plLogFailed 标识外显。
 */
function _plGuardedMutation(opts) {
  var sheet = opts.sheet;
  var lock = null;
  var enteredWrite = false;
  var logAttempted = false;
  try {
    lock = _plAcquire(opts.timeoutMs);
    var policy = _plPolicy();
    var recheck = null;
    if (opts.uuid) {
      recheck = _plRecheckRow(sheet, opts.uuid, opts.expectContentHash || null,
                              opts.expectName || null, opts.expectDeleted);
      if (recheck.mismatch) {
        var e1 = new Error(recheck.reason);
        e1.plCode = recheck.reason;
        throw e1;
      }
    }
    var origBiz = recheck ? recheck.bizDate : null;
    var g = _plGuardCheck(opts.newDateRaw, origBiz, policy);
    if (!g.ok) {
      var e2 = new Error(g.reason);
      e2.plCode = g.reason;
      throw e2;
    }
    enteredWrite = true;
    var result = opts.bizWrite(recheck, policy);
    try {
      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) SpreadsheetApp.flush();
    } catch (fe) {
      // [审③] plLogFailed 按实际登记结果设置：登记成功=false（不再误报）
      var loggedF = _plLogUncertain('flush_failed', String(opts.uuid || 'batch'));
      logAttempted = true;
      var e3 = new Error('PL_UNCERTAIN_FLUSH_FAILED');
      e3.plCode = 'PL_UNCERTAIN_FLUSH_FAILED';
      e3.plCause = String((fe && fe.message) || fe);   // [审③] 保留原始原因
      e3.plLogFailed = !loggedF;
      // [审⑧-v7] 契约覆盖 updateTimesheet/softDeleteRecord 编排路径：载荷进 message
      e3.message = _plUncertainPayloadMsg(e3);
      throw e3;
    }
    return result;
  } catch (e) {
    if (enteredWrite && !logAttempted) {          // 每失败路径仅一次
      logAttempted = true;
      var logged = _plLogUncertain('biz_write', String(opts.uuid || 'batch') +
                               ' err=' + String((e && e.message) || e));
      if (e && e.plCode) throw e;                 // 已结构化（flush 路径）不双包
      // [审③] 进入写阶段后的失败=结果不确定：统一 uncertain 码 + 原原因 + 登记状态，
      // 与预检拒绝 PL_REJECT_* 显式分层（调用方不得只看到裸普通错误）
      var ue = new Error('PL_UNCERTAIN_BIZ_WRITE_FAILED');
      ue.plCode = 'PL_UNCERTAIN_BIZ_WRITE_FAILED';
      ue.plCause = String((e && e.message) || e);
      ue.plLogFailed = !logged;
      // [审⑧-v7] 契约覆盖 updateTimesheet/softDeleteRecord 编排路径：载荷进 message
      ue.message = _plUncertainPayloadMsg(ue);
      throw ue;
    }
    throw e;
  } finally {
    if (lock) { try { lock.releaseLock(); } catch (re) {} }
  }
}

/**
 * 新增场景。[审②] 去重结果为空 → 直接返回 { duplicates: n, wrote: 0 }，
 * 不进入 bizWrite、不构造高度 0 区域、不登记不确定。
 */
function _plGuardedInsert(opts) {
  var lock = null;
  var enteredWrite = false;
  var logAttempted = false;
  try {
    var pre = _plGuardCheckBatch(opts.rows, opts.dateOf, _plPolicy());
    if (!pre.ok) {
      var e0 = new Error(pre.reason + ' @row#' + pre.index);
      e0.plCode = pre.reason;
      throw e0;
    }
    lock = _plAcquire(opts.timeoutMs);
    var policy = _plPolicy();
    var rows = opts.rows;
    var duplicates = 0;
    if (typeof opts.lockPreWrite === 'function') {
      var pr = opts.lockPreWrite(rows, policy);
      rows = (pr && pr.rows) || [];               // [审②] 约定返回 {rows, duplicates}
      duplicates = (pr && pr.duplicates) || 0;
    }
    if (!rows || rows.length === 0) {             // [审②] 全重复：无新增，不走业务写
      return { wrote: 0, duplicates: duplicates, skippedAll: true };
    }
    var post = _plGuardCheckBatch(rows, opts.dateOf, policy);
    if (!post.ok) {
      var e1 = new Error(post.reason + ' @row#' + post.index);
      e1.plCode = post.reason;
      throw e1;
    }
    enteredWrite = true;
    var result = opts.bizWrite(rows, policy);
    try {
      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) SpreadsheetApp.flush();
    } catch (fe) {
      // [审③] plLogFailed 按实际登记结果设置（登记成功=false，不再误报）
      var loggedF2 = _plLogUncertain('flush_failed', 'insert batch');
      logAttempted = true;
      var e2 = new Error('PL_UNCERTAIN_FLUSH_FAILED');
      e2.plCode = 'PL_UNCERTAIN_FLUSH_FAILED';
      e2.plCause = String((fe && fe.message) || fe);
      e2.plLogFailed = !loggedF2;
      // [审⑧-v7] 契约覆盖 submitBatch/tsAppendRows 路径：载荷进 message
      e2.message = _plUncertainPayloadMsg(e2);
      throw e2;
    }
    return result;
  } catch (e) {
    if (enteredWrite && !logAttempted) {
      logAttempted = true;
      var logged2 = _plLogUncertain('biz_write', 'insert batch err=' + String((e && e.message) || e));
      if (e && e.plCode) throw e;                 // 已结构化（flush 路径）不双包
      // [审③] 写阶段后失败=结果不确定：统一码+原因+登记状态，与预检拒绝分层
      var ue2 = new Error('PL_UNCERTAIN_BIZ_WRITE_FAILED');
      ue2.plCode = 'PL_UNCERTAIN_BIZ_WRITE_FAILED';
      ue2.plCause = String((e && e.message) || e);
      ue2.plLogFailed = !logged2;
      // [审⑧-v7] 契约覆盖 submitBatch/tsAppendRows 路径：载荷进 message
      ue2.message = _plUncertainPayloadMsg(ue2);
      throw ue2;
    }
    throw e;
  } finally {
    if (lock) { try { lock.releaseLock(); } catch (re) {} }
  }
}

// ============================================================
// 4. tsPatchCells 专项门禁（[审⑤] 表头保护 + 政策统一）
// ============================================================

/**
 * [审⑤] 锁内调用。返回 { ok, reason, offenders }。
 *   B 列：新值空/非法 → 拒；**表头行（row<2）→ 拒**（禁把表头当新增行）；
 *         原行不存在 → 新增语义；原值未知 → 拒；原期间关账 → 拒。
 *   O:Q：删除场景统一走 _plGuardCheck（新=原，与 mutation 同一期间政策，
 *         含 futureOpen）；表头行 → 拒；原行不存在 → 拒；原值未知 → 拒。
 *   C:H 等其他列：不拦（服务边界明示：不宣称历史整行冻结）。
 */
function _plGuardPatch(sheet, cells, ranges) {
  var policy = _plPolicy();
  var offenders = [];
  var data = sheet.getDataRange().getValues();
  var lastRow = data.length;

  function rowState(rn) {
    if (rn < 2) return { state: 'header' };                   // [审⑤] 表头
    if (rn > lastRow) return { state: 'absent' };
    var b = _plParseBizDate(data[rn - 1][1]);
    if (!b) return { state: 'unknown' };
    return { state: 'known', biz: b };
  }
  function checkBCell(row, newVal) {
    var st = rowState(row);
    if (st.state === 'header') { offenders.push({ row: row, col: 2, reason: 'PL_REJECT_HEADER_ROW' }); return; }
    var origBiz = (st.state === 'known') ? st.biz
               : (st.state === 'unknown') ? PL_UNKNOWN : null;
    var g = _plGuardCheck(newVal, origBiz, policy);
    if (!g.ok) offenders.push({ row: row, col: 2, reason: g.reason });
  }
  function checkDelCell(row) {
    var st = rowState(row);
    if (st.state === 'header') { offenders.push({ row: row, col: 'O:Q', reason: 'PL_REJECT_HEADER_ROW' }); return; }
    if (st.state === 'absent') { offenders.push({ row: row, col: 'O:Q', reason: 'PL_REJECT_ROW_GONE' }); return; }
    if (st.state === 'unknown') { offenders.push({ row: row, col: 'O:Q', reason: 'PL_REJECT_ORIG_UNKNOWN' }); return; }
    // [审⑤] 统一期间政策：新=原走同一门禁（closed/futureOpen 一致）
    var g = _plGuardCheck(st.biz, st.biz, policy);
    if (!g.ok) offenders.push({ row: row, col: 'O:Q', reason: g.reason });
  }

  var i, c, r, ri;
  for (i = 0; i < (cells || []).length; i++) {
    c = cells[i]; if (!c) continue;
    var row = Number(c[0]), col = Number(c[1]), val = c[2];
    if (col === 2) checkBCell(row, val);
    else if (col >= 15 && col <= 17) checkDelCell(row);
  }
  for (i = 0; i < (ranges || []).length; i++) {
    r = ranges[i]; if (!r || !r.values) continue;
    var startRow = Number(r.row), startCol = Number(r.col);
    var width = (r.values[0] || []).length;
    var height = r.values.length;
    var coversB = (startCol <= 2 && startCol + width > 2);
    var coversDel = (startCol <= 17 && startCol + width > 15);
    if (!coversB && !coversDel) continue;
    for (ri = 0; ri < height; ri++) {
      var rn = startRow + ri;
      if (coversB) {
        var bIdx = 2 - startCol;
        var newB = (r.values[ri] || [])[bIdx];
        if (newB === undefined || newB === null || newB === '') {
          offenders.push({ row: rn, col: 2, reason: 'PL_REJECT_BAD_NEW_DATE' });
        } else {
          checkBCell(rn, newB);
        }
      }
      if (coversDel) checkDelCell(rn);
    }
  }
  if (offenders.length) return { ok: false, reason: 'PL_REJECT_PATCH_OFFENDERS', offenders: offenders };
  return { ok: true, reason: '' };
}
