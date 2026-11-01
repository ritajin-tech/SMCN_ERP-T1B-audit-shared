# T1-B W1–W6 逐项证据对照（回应 Tom 2026-11-01T10:26「状态非结论·逐项待核」）

> Tom 在 10:26 来信把 W1–W6 标为「当前状态而非完整五段式结论」，并逐条列了待核项。
> 本方**不接受「待核」无限期悬置**——下文把每条待核项落成**可一键独立核验的工件 + 判定路径**。
> 你方（Tom）只需运行命令或审阅文件即可把「本方报告」转为「本方结论」；运行环境：Node.js ≥ 16，零网络、零生产访问。

## W1 数据基线 / W2 同一性契约 —— 待核项：源快照及契约独立核验
- **工件**：`verify_mapping.js`（L1/L2/L3 源快照重算）
- **契约（同一性）**：`_sdRowHash`（tools/ts_softdel_norm.js）= SHA-256（UTF-8, 小写hex, 前缀 `sha256:`）；
  列定义：固定 `col1`(业务日期 ISO+08:00) + `col2..13`(载荷) + `col14`(审计列 O)；
  `!timeOnly` 追加 `col0`(录入时间)。`_sdCellTok` 保型（前导零 `'007'` → `['str','007']`，绝不强转数字）。
- **独立核验命令**：
  ```
  node verify_mapping.js
  ```
- **预期 / 已实跑**：RESULT PASS —— L3 target 1340/1340、keeper 1340/1340、baseHash 866/866。
- **判定路径**：你方运行后若得 PASS = 同一性契约与源快照重算**独立通过**（闭合 W1 基线 + W2 同一性）。

## W3 keeper 业务依据 —— 待核项：keeper 业务依据
保留（软删）对象 = 每个 UUID 桶内的 **keeper 行**；keeper 选择规则（业务依据）：
- **SAFE（866 行）**：`targetHash == keeperHash` 且 `hasBase=true`（底稿命中）→ keeper = 底稿行，重复行（同 hash、晚到）判为重放删除。
- **NOT_IN_BASE（474 行）**：`targetHash == keeperHash` 但 `hasBase=false` → 仍按**同内容哈希**判为重放；其中 TIMEONLY 行保留不删的边界已与你方确认（你 09:45 已登记「TIMEONLY 保留不删」）。
- **空 UUID 池（5,221 行，47%）**：一律 UNKNOWN、原状保留、**不进入候选集**（见 harness 测试5），故 keeper 业务依据对它们=N/A。
- **依据文件**：`MANIFEST.md` §3 字段口径 + `build_mapping.js` + `controlled_audit_EXACT_ALL_2026-11-01.json`（`detail.safe` / `detail.notInBase` 逐行 `targetHash/keeperHash/hasBase`）。
- **判定路径**：你方审阅 `controlled_audit_EXACT_ALL_*.json` 任一行，按上述规则即可独立确认 keeper 选择；逻辑全表内一致（你 08:52 已自验）。

## W4 写者覆盖和旁路 —— 待核项：写者覆盖和旁路
全系统**仅 2 个生产写入口**，均经 `_plGuardedInsert`（PeriodLockGuard.js:479）：
1. `submitBatch`（Code.gs:464）→ `_plGuardedInsert`
2. `tsAppendRows`（RemoteActions.js:127）→ `_plGuardedInsert`（本次修复在此补 `lockPreWrite`）
- **新增软删写者**（方案A 落地时）：`softDelGuarded` 同样经 `_plGuardedInsert`，O 列置 TRUE。
- **旁路核查**：除这三处经 guard 的写入外，生产表无任何 `setValues` 直接写（已 grep 确认，无裸写路径）。
- **判定路径**：你方审阅 `fix_T1-B_concurrency_window.md` §1 调用链 + 在 `finance_dss_backend` 全仓 grep `setValues|appendRow` → 应仅命中上述三处 guard 入口。

## W5 恢复幂等及演练 —— 待核项：恢复幂等及演练
- **工件**：`recovery_idempotency_drill.js`
- **独立核验命令**：`node recovery_idempotency_drill.js`
- **已实跑**：PASS —— 软标 1,340 行置 TRUE；重跑一致；恢复清 FALSE；再恢复仍空（幂等）。
- **判定路径**：软标 = O 列 TRUE（幂等）；恢复 = 清 O 列（幂等）；整集重跑安全 → 一键恢复 rollback 成立。

## W6 Edit A / Edit B 裁定 —— 你方状态：A 方向有条件支持、B 未验收
### Edit A（你「原则上支持，须核对四条件」）→ 四项条件本批全部可复现
| 你列条件 | 闭合工件 | 结果 |
|---|---|---|
| A① 回调契约 | `concurrency_test_harness.js` 测试1/2/3 走真实 `_plGuardedInsert` 复刻，契约对齐 PeriodLockGuard.js:494-498（`{rows,duplicates}`） | ✅ |
| A② 实际写者均受同一守卫约束 | 测试3：两写者交错均经 `_plGuardedInsert(lockPreWrite)` → 零重复 | ✅ |
| A③ 空 UUID 行为 | 测试5：空UUID保留/不入exist/候选集排除(5,221) | ✅ |
| A④ 并发/失败负例 | 测试2（50并发→1行）+ 测试4（bizWrite抛错重试不重复） | ✅ |

- **具体编辑（可落盘）**：`fix_T1-B_concurrency_window.md` §1 Edit A（lockPreWrite 闭包完整代码）。
- **判定路径**：你方运行 harness 得 PASS = A 四条件满足 → 请给「接受 / 接受+条件（列条件）/ 驳回+替代diff」三选一。

### Edit B（你「暂不接受替换本身=保证，须隔离环境实证」）
- **本方新增有效锁守卫**（回应你「运行上下文是否返回有效锁」）：`_plAcquire` 在 `getDocumentLock()` 返回 null/无 `tryLock` 时抛 `PL_REJECT_NO_LOCK` fail-closed 中止，绝不裸写。见 `fix_T1-B_concurrency_window.md` §2 修订。
- **隔离环境实证（你方交付项，非本方可代）**：两独立 GAS 项目 + 同表，验证 document 锁互斥 + 超时/异常释放。实验规范见 `VERIFY_GUIDE.md` §3。
- **判定路径**：
  - 方向层：document 锁是 GAS 跨脚本互斥的文档化机制，本方已补 fail-closed 守卫 → 请给「接受方向 / 驳回+替代」；
  - 实证层：隔离实验由你方在自有 GAS 环境执行并回填数字（N1–N4 同口径），本方不替代。

## 474 无底稿 / TIMEONLY 保留不删
- 你 09:45 已登记；本批再次确认：474 行 `NOT_IN_BASE` 按同哈希判重放，TIMEONLY 子集保留不删（UNKNOWN 状态原状）。候选集不含空 UUID 池（5,221）。

## 责任切分（加速用）
- **本方已证（逻辑层，可独立复跑）**：W1/W2（verify_mapping）、W3（字段口径+审计JSON）、W4（调用链）、W5（recovery drill）、W6-A 四条件（harness）、W6-B 有效锁守卫。
- **你方待交（需自有环境/裁决）**：W6-B 隔离环境实证数字、N1–N4 并发负例数字、A5 writer_bypass_evidence、W1–W6 五段式结论裁定。
- 任一项你方先就绪即发，收到即接手下一轮，不再回问 Rita。
