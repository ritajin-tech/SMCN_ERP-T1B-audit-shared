/**
 * 提案代码（PROPOSED，未应用于现网固定版本 pin 412f3db）：
 * T1-B 请求级耐久账本 + N3 收敛（消除"不确定写"依赖）
 * ============================================================================
 * 对应文档：docs/T1-B_系统大局梳理_v47_*.md
 * 设计要点（回应 Tom 16:57Z N3）：
 *   - 账本写（PENDING/DONE）使用 PropertiesService.setProperty，语义 = 同步提交即抛
 *     （commit-or-throw），**不存在"不确定返回"**——GAS 文档保证的耐久原语。
 *   - 业务写（appendRow）才是唯一可能不确定的环节；其不确定时**保留 PENDING 并
 *     暂停（SUSPEND），绝不自动重尝预留、绝不翻转、绝不写第二个不确定标记**。
 *   - 由此根除 N2 的"POISONED 写入本身结果不明"隐患：不再写第二个可能不确定的标记。
 *   - 跨进程/崩溃一致由耐久账本（所有写者共享同一 PropertiesService 实例）保证。
 *
 * 落地位置（锚定固定版本 code/live_snapshot_20261102/PeriodLockGuard.js）：
 *   - _plLedgerGet / _plLedgerSet：新增于 §0 持久化区（现 :70-183 之后）。
 *   - _plGuardedInsert：在现有 :479-543 内嵌 reserve / hold / flip 三步（见下）。
 *   - _plGuardedMutation（:411-473）：W2/W3 同构嵌入（缺口①收敛）。
 *   - _plGuardPatch（:557-619）：W5 改格同构嵌入（缺口②收敛）。
 */

// ============================================================
// 0b. 请求级耐久账本（N3 收敛；同步提交即抛，无 uncertain 返回）
// ============================================================
var PL_LEDGER_KEY = 'TS_WRITE_LEDGER';   // PropertiesService key，存 JSON {requestId: {state,payloadHash,ts}}

/**
 * 读账本状态。失败 → 返回 null（保守视为 absent，将走预留路径）。
 * 注意：必须在 _plAcquire 锁内调用，保证与并发写者一致视图。
 */
function _plLedgerGet(requestId) {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(PL_LEDGER_KEY);
    if (!raw) return null;
    var m = JSON.parse(raw);
    return (m && m[requestId]) ? m[requestId] : null;
  } catch (e) { return null; }
}

/**
 * 写账本状态（同步提交即抛）。任何 IO 失败直接抛异常 → 调用方 catch → SUSPEND。
 * 绝不以"返回不确定"方式结束；因此不存在"写入本身结果不明"的中间态。
 * 读写在 _plAcquire 锁内串行化（LockService 脚本锁），并发安全。
 */
function _plLedgerSet(requestId, state, payloadHash) {
  var props = PropertiesService.getScriptProperties();
  var m = {};
  var raw = props.getProperty(PL_LEDGER_KEY);
  if (raw) { try { m = JSON.parse(raw) || {}; } catch (e) { m = {}; } }
  m[requestId] = {
    state: state,
    payloadHash: payloadHash,
    ts: Utilities.formatDate(new Date(), 'GMT+8', 'yyyy-MM-dd HH:mm:ss')
  };
  props.setProperty(PL_LEDGER_KEY, JSON.stringify(m));   // 同步，无 uncertain 返回
}

// ============================================================
// 3b. _plGuardedInsert 集成（锚定现 :479-543，三处嵌入）
// ============================================================
/*
 * 现有 _plGuardedInsert(opts) 流程（节选）：
 *   :490  lock = _plAcquire(opts.timeoutMs)
 *   :491  var policy = _plPolicy()
 *   ...   lockPreWrite 去重
 *   :508  enteredWrite = true
 *   :509  var result = opts.bizWrite(rows, policy)   // ← 唯一不确定环节
 *   :510-523 flush / PL_UNCERTAIN_FLUSH_FAILED
 *   :524  return result
 *
 * 集成（均在 lock 内，保证账本读写串行化）：
 *
 *  (A) 在 :491 之后、:508 enteredWrite 之前，插入"读账本 + 预留"：
 *      var ledger = _plLedgerGet(opts.requestId);
 *      if (ledger && ledger.state === 'DONE') {
 *        if (ledger.payloadHash === opts.payloadHash) return { wrote: 0, replay: true };
 *        var em = new Error('PL_REJECT_REQUEST_ID_MISMATCH'); em.plCode = 'PL_REJECT_REQUEST_ID_MISMATCH'; throw em;
 *      }
 *      if (ledger && ledger.state === 'PENDING') {
 *        // 在途 / 业务结果不明 → 挂起，绝不重执行
 *        var ep = new Error('PL_SUSPEND_PENDING_INFLIGHT'); ep.plCode = 'PL_SUSPEND_PENDING_INFLIGHT'; throw ep;
 *      }
 *      // absent → 预留 PENDING（同步提交即抛；若抛则未落库、不进业务写）
 *      try { _plLedgerSet(opts.requestId, 'PENDING', opts.payloadHash); }
 *      catch (le) {
 *        var el = new Error('PL_SUSPEND_LEDGER_IO'); el.plCode = 'PL_SUSPEND_LEDGER_IO'; throw el;
 *      }
 *
 *  (B) 在 :509 opts.bizWrite 之后、:510 flush 之前，业务写若抛 uncertain（已进入 catch，
 *      且 enteredWrite && !logAttempted）→ 已是 PL_UNCERTAIN_BIZ_WRITE_FAILED：
 *      此时**不翻转账本、不写第二标记**，PENDING 保留，异常原样抛出 → 调用方 SUSPEND。
 *      （现有 :525-538 的 catch 已正确：bizWrite 失败 → PL_UNCERTAIN_BIZ_WRITE_FAILED，
 *        我们只需确保该路径**不**调用 _plLedgerSet(DONE)，当前代码确实未调用 → 已满足。）
 *
 *  (C) 在 :509 opts.bizWrite 成功返回、:524 return result 之前，翻转 DONE：
 *      try { _plLedgerSet(opts.requestId, 'DONE', opts.payloadHash); }
 *      catch (le) {
 *        // 行已落库，PENDING 仍在 → 重试读 PENDING 挂起；人工对账翻 DONE，无重复写
 *        var ed = new Error('PL_SUSPEND_LEDGER_IO'); ed.plCode = 'PL_SUSPEND_LEDGER_IO'; throw ed;
 *      }
 *
 *  结论：_plGuardedInsert 经此三处嵌入后，恰为 proof/ts_insert_proof.js 所证状态机。
 */

// ============================================================
// 3c. _plGuardedMutation（W2/W3，:411-473）同构嵌入（缺口①收敛）
// ============================================================
/*
 * updateTimesheet / softDeleteRecord 走 _plGuardedMutation。其流程与 _plGuardedInsert 同构：
 *   lock → _plPolicy → _plRecheckRow → _plGuardCheck → enteredWrite → opts.bizWrite → flush → return。
 * 在 enteredWrite 之前插入 (A) 读账本+预留（requestId 由 opts.requestId 携带）；
 * 在 opts.bizWrite 成功返回后、return 之前插入 (C) 翻转 DONE；
 * (B) 业务 uncertain 路径保持"保留 PENDING + 抛 PL_UNCERTAIN_*"，不翻转。
 * 即可使 W2/W3 与 W1/W4 享有同等幂等保护。
 */

// ============================================================
// 4b. _plGuardPatch（W5，:557-619）同构嵌入（缺口②收敛）
// ============================================================
/*
 * tsPatchCells 改格路径：_plGuardPatch 在锁内（由集成源码 _plAcquire 后调用）校验单元格。
 * 嵌入方式：在 _plGuardPatch 入口或集成源码调用点，按 requestId 执行 (A) 读账本+预留，
 * 校验通过后执行单元格写，成功执行 (C) 翻转 DONE；业务 uncertain（cells 写入异常）保持
 * 保留 PENDING + SUSPEND。使 W5 改格路径亦具备幂等保护。
 */
