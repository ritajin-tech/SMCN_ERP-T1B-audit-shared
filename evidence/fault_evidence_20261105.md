# T1-B 故障证据与 E3‴ 状态机设计（v63 配套，只读）

> 生成时间：2026-11-05 00:55 GMT+8（00:55 UTC 偏移见各文件）。本件为只读设计文档 + 真实故障实证，**不含任何生产写入、部署或代码变更**。目的：服务 Tom 在 00:22Z 函中要求的「故障证据」核验项，并把他指出的 PREPARE 三类边界（写入结果未知 / 读取失败 / 全写者一致遵守）落到可落码的状态机。

## 一、真实故障实证（已发生，非假设）

### F1 — 2026-11-03 purge 零日志（源码根因已定位）
- 现象：`_TS_WRITE_LOG` 在 A1397（2026-11-03T09:18:02Z）与 A1398（2026-11-03T22:27:25Z）之间**无任何条目**；期间发生了 `purgeSoftLeaves` 批量软删。
- 源码根因（HEAD live 快照 `RemoteActions.js`，SHA256 见 `evidence/v61_head_live_source_anchors.json`）：
  - `_tsWriteLog` 的 `catch(e){ /* log failure ignored */ }` 在 `:67-76` **吞掉日志失败**；
  - 两条 purge 路径 `:836-866`（purgeSoftLeaves）与 `:895-914`（purgeRows）**零 `_tsWriteLog` 调用**（全文件 10 处日志调用集中在 appendRows/patchCells/createSheet/applyFormat/repairLegacyLeave/setup）。
- 结论：这正是 Tom 在 21:53Z 函中指出的「不能保证自动逐格回滚」的源码级证据。v59 E3′ 曾过度声称「自动逐格回滚一定成功」，v61 已主动撤回，本件再次确认。

### F2 — 整表写回无锁（并发重放风险）
- 源码实证：`RemoteActions.js` 全文件唯一 `LockService.getScriptLock()` 在 `:1032`（repairLegacyLeave）；两个整表写回点 `:859` / `:907` **完全无锁**。
- 含义：若两请求同时整表写回，检查→重排窗口无互斥，可能后者覆盖前者。

## 二、Tom 在 00:22Z 指出的 PREPARE 三类边界（E3‴ 须覆盖）

| 边界 | Tom 原话 | E3‴ 如何覆盖 | 是否承认此前不足 |
|---|---|---|---|
| B1 PREPARE 写入结果未知 | 「PREPARE 作为冻结信号仍需覆盖 PREPARE 写入结果未知」 | PREPARE 写入后**立即读回确认**；若写失败/未落盘 → 中止业务写，不进入 COMMIT；永不假定 PREPARE 已持久 | 承认：v62 仅说「PREPARE 即冻结信号」，未明确 PREPARE 自身写入须读回验证 |
| B2 读取失败 | 「读取失败」 | 读 PREPARE/状态表失败 → 按「未知」处理，**保守拒绝**新写（fail-closed），不乐观放行 | 承认：v62 未明言读取失败的处理 |
| B3 所有写者一致遵守 | 「所有写者一致遵守的情况」 | 冻结由**网关同步检查**强制执行（每个写入口开局即查该 range 是否有未完成 PREPARE），不依赖各写者自觉；配合 ACL 锁定（E1‴/E5‴）使越界写者物理无权 | 承认：v62 把「看门狗」当作主保证，实际须以同步网关检查为主、看门狗为辅 |

## 三、E3‴ 状态机（修订版，采纳 Tom 三点）

```
状态集合：
  IDLE          初始/无未完成 PREPARE
  PREPARE       业务写之前已落盘 PREPARE 日志（读回确认成功）
  WRITING       业务写进行中
  COMMIT        业务写成功，落盘 COMMIT
  UNKNOWN       任何不确定终态（PREPARE 无对应 COMMIT 超 timeout / 进程中断 / 读回不符 / 读状态失败）
  ABORTED       显式中止

转移规则（fail-closed）：
  IDLE → PREPARE   仅当：拿 LockService 成功 + PREPARE 写后读回确认成功；否则停留 IDLE，零业务写
  PREPARE → WRITING 仅当：该 range 无其它未完成 PREPARE（网关同步检查）
  WRITING → COMMIT  业务写 + 写后回读值+类型一致
  WRITING → UNKNOWN 业务写后读回不符 / 进程中断
  PREPARE → UNKNOWN 超 timeout 无 COMMIT（看门狗，次级）
  * → UNKNOWN      读取 PREPARE/状态表失败（fail-closed，保守拒绝）
  UNKNOWN → (冻结)  该 range 禁止任何新写，须先做独立逐格对账，再由所有者裁定；禁止自动重试/自动回滚
  ABORTED          仅允许显式、人工、带审计的回滚

禁止项（硬约束）：
  ✗ 自动重试业务写
  ✗ 自动逐格回滚（v59 E3′ 已撤回该过强声称）
  ✗ 在 UNKNOWN 状态下宣称已恢复
  ✗ 依赖看门狗作为唯一冻结保证
```

## 四、与 11-03 事故的对应
- F1（零日志）由 E3‴ 两阶段 write-ahead + PREPARE 读回确认直接消除：今后任何维护写**先落 PREPARE 并读回**，日志失败不再被静默吞掉（E3′ 的 catch 改为显式失败处理）。
- F2（无锁）由 E1‴ 锁域 + E4‴ 守卫覆盖：整表写回必须持锁并经守卫。

## 五、独立核验入口（Tom 可只读复跑，无需运行我方写脚本）
- `evidence/v61_head_live_source_anchors.json`：9 处 file:line + 片段 + 3 文件 SHA256（含 `:67-76` 日志吞掉、`:836-914` 零日志、`:1032` 唯一锁）。
- `config/writer_matrix.json`：10 条写者通道 + 当前门控 + 拟议门控（含 W7/W8/W9 越界通道须靠 ACL 锁定）。
- `evidence/v62_deployments_20261105_0012.json` / `v63_deployments_20261105_0046.json`：部署 3 条 HTTP200。
- `_backups/sheets/2026-11-04_before_v2_final/` 与 `after_v2_final/`：原始前后快照。
- `tools/probe_v59_live_state.py`：两表只读探针（生产表 11279/18、主库 596/15，零写入）。
