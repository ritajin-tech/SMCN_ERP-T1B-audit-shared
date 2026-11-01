# M1 技术裁定验收矩阵（结构化 · 非裸布尔）

> 目的：把闸门 `ts_unfreeze_gate.js` 的 M1 项从「Tom 一句话 granted=true」升级为「Tom 逐项技术确认 C1–C7，每项带可核验证据」。
> 这样 M1 不再是含糊的 yes/no，而是**可审计、可复核、缺一项即 BLOCKED** 的硬标准。
> 对应 Rita 2026-11-01 指令「把 M1 彻查看怎么改准确，让 Tom 技术层面确认」。

## 1. M1 现在怎么判（升级后）

`_tmp/evidence/unfreeze_approvals.json` 的 `tom_technical_clearance` 必须形如：

```json
{
  "tom_technical_clearance": {
    "granted": true,
    "ref": "Tom 邮件 msg_XXX / commit / 文档路径",
    "note": "……",
    "criteria": [
      {"id":"C1_data_baseline",      "confirm":true, "evidence":"<commit/文件+sha256>", "ref":"<msg_id/commit>"},
      {"id":"C2_identity_contract",   "confirm":true, "evidence":"verify_mapping.js L3 PASS", "ref":"..."},
      {"id":"C3_retention_basis",     "confirm":true, "evidence":"映射CSV keeperRow", "ref":"..."},
      {"id":"C4_writer_enumeration",  "confirm":true, "evidence":"W4_writer_enumeration.md", "ref":"..."},
      {"id":"C5_bypass_block",        "confirm":true, "evidence":"W4 §旁路 + gas_test_EditA_real.gs", "ref":"..."},
      {"id":"C6_recovery_idempotent", "confirm":true, "evidence":"recovery_idempotency_drill.js PASS + 快照", "ref":"..."},
      {"id":"C7_editA_fix",           "confirm":true, "evidence":"concurrency_test_harness.js v2 + gas_test_EditA_real.gs", "ref":"..."}
    ]
  }
}
```

闸门 `checkM1_tom()` 新逻辑：`granted===true` **且** `criteria[]` 含全部 C1–C7 且每项 `confirm===true` + 非空 `evidence` ⇒ M1 PASS；否则 **BLOCKED 并精确点名缺哪一项**。C8 为 fix-track，并行不阻塞 M1。

## 2. C1–C7 逐项证据（均在共享仓 `evidence/2026-11-01/`，可 Tom 独立复验）

### C1 · 数据基线候选集（候选集正确）
- **主张**：冗余集 = 1,340 EXACT（866 SAFE + 474 NOT_IN_BASE）+ 227 TIMEONLY；MIXED=0；空UUID池 5,221 行保留原状。
- **证据**：`controlled_audit_EXACT_ALL_2026-11-01.json`（866/474 明细，targetHash==keeperHash 1340/1340）、`T1-B_候选保留映射_可核查_2026-11-01.csv`（sha256 d517d4d8…）、`prod_scan_LIVE_2026-11-01-14-56-27.json`（源快照）。
- **复验**：`node verify_mapping.js` → L1 表内一致、L2 审计↔CSV、L3 源快照重算，全部 PASS。

### C2 · 同一性契约（同UUID+字段一致=同业务记录）
- **主张**：`_sdRowHash`（tools/ts_softdel_norm.js，单一可信源）逐行哈希，同值即同记录。
- **证据**：`verify_mapping.js` 内联逐字同文 `_sdRowHash`；L3 从源快照 `byUuid[uuid][].cells` 重算比对 → target/keeper 各 1340/1340 相等。
- **复验**：同上 `node verify_mapping.js`。

### C3 · 保留依据（每个 SAFE 有 keeperRow 业务依据）
- **主张**：866 SAFE 行各有 `keeperRow`（保留对象行）；474 NOT_IN_BASE = 无 base 匹配的新记录，按「保留原状」处理（不软标）。
- **证据**：映射 CSV `keeperRow` 列 + `base_候选0824_LIVE_2026-11-01-14-57-15.csv`。
- **复验**：抽取任意 SAFE 行，对照 keeperRow 在 prod_scan 源快照中是否存在且字段一致。

### C4 · 写者穷尽枚举（仅 2 业务插入点、均经守卫）
- **主张**：部署版 `finance_dss_backend`（v4.3.72）写 `DB_工时流水` 的入口全 8 个；**业务新增行仅 2 个**（`submitBatch` Code.js:464 / `tsAppendRows` RemoteActions.js:127），均经 `_plGuardedInsert`（PeriodLockGuard.js:479）。
- **证据**：`W4_writer_enumeration.md`（8 入口精确 file:line + 守卫/旁路分类）。
- **复验**：静态读 `code_pull/finance_dss_backend/` 全量 grep 写入口。

### C5 · 旁路封堵（维护写者只动 O/P/Q、单例、非业务双写源）
- **主张**：3 个维护写者（`repairLegacyLeave` RemoteActions.js:1011 / `cleanupDuplicateLeavesInternal` Code.js:564 / `tsPurgeSoftLeaves`）用 `getScriptLock` 绕过守卫，但只动 O/P/Q 标记列、单例触发器运行、**非业务双写源**——即 Tom 点名「旁路」。
- **闭合方案（二选一，请 Tom 裁定）**：
  - (a) 强化迁移：把维护写者也纳入 `_plGuardedInsert` 守卫（改 `getScriptLock`→`getDocumentLock` + 传 `lockPreWrite`）。
  - (b) 范围化：明确维护写者只改标记列、禁止改业务列，载入 `PeriodLockGuard` 的列范围白名单。
- **证据**：`W4_writer_enumeration.md` §旁路；`gas_test_EditA_real.gs` 在真实 LockService 下复现竞争。
- **复验**：部署 `gas_test_EditA_real.gs` 跑 `test_EditA()` → BUGGY 2 行 / FIXED 1 行。

### C6 · 恢复幂等（软标幂等、一键可回滚）
- **主张**：软标 = O 列 TRUE（幂等）；恢复 = 清 O 列（幂等）；整集重跑安全 → `ts_recover.js` 一键回滚成立。
- **证据**：`recovery_idempotency_drill.js` PASS（软标→重跑一致→恢复→再恢复仍空）；`_backups/sheets/2026-11-01/生产工时表__DB_工时流水.csv`（11,380 行全量，O 列已捕获）。
- **复验**：`node recovery_idempotency_drill.js`；`node tools/ts_recover.js --dry` 验证快照可定位且被冻结闸拦下。

### C7 · Edit A 修复正确（lockPreWrite 锁内重读消除重放）
- **主张**：根因 = `tsAppendRows` 在锁外读 `exist`（RemoteActions.js:96-105）、`:127` 进 `_plGuardedInsert` 未传 `lockPreWrite` → 锁内重核跳过 → 并发重放。修复 = 新增 `lockPreWrite` 闭包在锁内重读 `exist` 并重判 `toWrite`。
- **证据**：`concurrency_test_harness.js` v2（7 项 PASS：50 并发→50 重复，修复后→1 行；空锁 fail-closed 中止）；`gas_test_EditA_real.gs`（真实 LockService 复现）；`fix_T1-B_concurrency_window.md` §1（完整 diff）。
- **复验**：`node concurrency_test_harness.js`；部署 `gas_test_EditA_real.gs` 跑 `test_EditA()`。

## 3. C8 · 并发窗口修复轨（fix-track · 并行 · 不阻塞 M1）

- **主张**：Edit B（`getScriptLock`→`getDocumentLock` 跨项目互斥）需在**真实 GAS 环境**两独立项目+同表实证（进程内 harness 不可证）。
- **证据**：`gas_test_EditB_crossproject.gs`（N1–N4 落成可运行代码：两项目 + `checkNoInterleave` + 超时 `PL_REJECT_NO_LOCK`）。
- **复验（Tom 待交）**：部署两独立 GAS 项目 → 填 ID → 跑 `coordinator()` → `USE_DOCUMENT_LOCK=true` 应 NO_INTERLEAVE ✅；改 false（getScriptLock）应 INTERLEAVED ❌；超时任抛 `PL_REJECT_NO_LOCK`。
- **状态**：与 C1–C7 清理正确性解耦，可**并行**推进；C8 未完成不阻塞 1,340 行清理（属「复发防护」而非「本次改动不可逆性」）。

## 4. 与 Tom 自身 W1–W6 框架的映射（让他看到自己的待核项已被闭合）

| Tom 的 W 项 | 对应 M1 准则 | 状态 |
|---|---|---|
| W1 数据基线 | C1 + C3 | 工件齐，待 Tom 确认 |
| W2 同一性契约 | C2 | `verify_mapping.js` 已证 |
| W3 keeper 业务依据 | C3 | 映射 CSV keeperRow |
| W4 写者穷尽+旁路 | C4 + C5 | `W4_writer_enumeration.md` 已证，(a)/(b) 待裁定 |
| W5 恢复幂等 | C6 | drill PASS + 快照就位 |
| W6 Edit A/B | C7 + C8 | C7 已证，C8 fix-track 待 Tom 跑 |

## 5. Tom 的签署方式（非 Yes/No）

请在 `unfreeze_approvals.json` 的 `tom_technical_clearance` 中：
1. 把 `granted` 置 `true`；
2. 填 `criteria[]`，对 C1–C7 每项给 `confirm:true` + `evidence`（文件+commit/sha256）+ `ref`（邮件/commit）；
3. 对 C5 给 (a) 或 (b) 裁定；对 C8 给「已跑实证 / 并行推进」状态。
4. 任一项无法确认 → 在该项 `confirm:false` + `note` 写明具体 file:line 反驳或缺失，闸门口会精确点名。

模板见 `_tmp/evidence/unfreeze_approvals_template.json`。
