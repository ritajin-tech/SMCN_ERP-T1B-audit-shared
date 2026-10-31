# 生产表写者覆盖矩阵（DB_工时流水 / TS_ID）

> 只读静态核验来源：`_tmp/tsmanager_pull_20261101/`（线上代码 scriptId `1FPAwV50VdpI2AGT42rfn6JhU0assY1QaARbhTQeiUKS0mZ66yf_JRb8R`，拉取于 2026-11-01 01:1x GMT+8）
> 目的：回答 Tom 02:07Z「请提供同一资源及写者的并发重放、旁路、空UUID、冻结覆盖证据」与「全写者覆盖」。

## 结论（一句话）
**生产表只接收新行的函数恰好 2 个**：`submitBatch`（Code.gs:464）与 `tsAppendRows`（RemoteActions.gs:127），二者均经 `_plGuardedInsert`（PeriodLockGuard.gs:479）期锁临界区。其余函数不插新行（仅 patch / purge / report / 改已存在行）。故"全写者覆盖"可穷举，不存在未知旁路插入点。

## 全函数清单（按是否向生产表插入新行分类）

| # | 函数 | 位置 | 动作 | 守卫 | UUID 处理 | 重复风险 |
|---|------|------|------|------|-----------|----------|
| 1 | **submitBatch** | Code.gs:412→464 | INSERT 新行 | `_plGuardedInsert` :464 | **:425 现场 `Utilities.getUuid()` 生成全新 UUID**；:420-431 近 10 分钟幂等窗口（仅回看末尾 800 行、仅同用户） | **无**（UUID 唯一性由构造保证） |
| 2 | **tsAppendRows** | RemoteActions.gs:78→127 | INSERT 新行 | `_plGuardedInsert` :127 | 用调用方传入 UUID（:107 `r[8]`）；**:96-105 查重在锁外**；:110-112 `if(uid&&exist[uid])` 去重 | **窄窗口**：并发同 UUID 重放（见下） |
| 3 | updateTimesheet | Code.gs:485→500 | 改已存在行 | `_plGuardedMutation` :500 | 按 UUID 定位 | 无（不插新行） |
| 4 | softDeleteRecord | Code.gs:521→530 | 软标已存在行 | `_plGuardedMutation` :530 | 按 UUID 定位 | 无（不插新行） |
| 5 | tsPatchCells | RemoteActions.gs:154 | 补丁单元格 | 未走 guarded（直接 setValues 指定行号） | — | 无（改指定行，非插入） |
| 6 | tsCreateSheet | RemoteActions.gs:229 | 建表 | — | — | 无（schema） |
| 7 | tsApplyFormat | RemoteActions.gs:475 | 格式 | — | — | 无 |
| 8 | tsTrimBlank | RemoteActions.gs:695 | 删空行 | `_tsSetValuesGuarded` :806（**无期间锁**） | — | 删行（反重复） |
| 9 | tsDupReport | RemoteActions.gs:723 | 读/报告 | — | — | 无（只读） |
| 10 | _tsSetValuesGuarded | RemoteActions.gs:806 | 原生 setValues（归一已存在行） | **无期间锁** | — | 仅作用于已读回的已有行，非插入源 |
| 11 | tsPurgeSoftLeaves | RemoteActions.gs:836 | 删软标行 | — | — | 删行 |
| 12 | tsPurgeRows | RemoteActions.gs:877 | 删行 | — | — | 删行 |
| 13 | repairLegacyLeave | RemoteActions.gs:1011 | 修请假行 | — | — | 改请假行，非工时重复源 |
| + | ts_post.py appendRows | 本地 tools/ | 远程调 tsAppendRows | 继承 #2 | 继承 #2 | 同 #2 |

## 主库（主库侧，非生产表）写者（对应 Q5/Q6/Q7，另案处理）
- `masterAttendanceLive.gs`：`syncProdToMaster` :82 / `rebuildAttendanceLive` :232 / `refreshMasterViews` :297 —— 三个写函数无跨函数锁（Q5）
- `leave_sync.gs`：`syncLeavesFromCalendar` :92 等 —— 请假单向同步
- 这些写主库、不写生产表，属另一问题域，不在本次数据层清理范围。

## 并发重放窗口的精确定位（回答 Tom 02:07 第 2 点）
`tsAppendRows`：
- :96-105 在锁**之前**读取全表 UUID 建 `exist{}`
- :110-112 `if (uid && exist[uid]) { skippedDup++; continue; }` 去重判定
- :127 才进入 `_plGuardedInsert` 临界区

⇒ 两个并发请求携带**相同调用方 UUID** 时，可同时在上锁前判定"不存在"并都进入 :127 写入 → 产生重复。这是唯一开放窗口。
触发前提：调用方对同一 UUID 并发重发（正常调用方每次生成新 UUID，故平时不触发；空 UUID 因 `if(uid&&...)` 跳过查重，亦可能无限重复，但实测近 14 天新增 0 空 UUID）。

## 修复（消除窗口）
把 `exist{}` 读取移入 `_plGuardedInsert` 的 `bizWrite` 闭包内，使「读-判-写」在同一临界区原子完成。具体 diff 见 v4 文档 §1.2。该修复按 N10 走部署流程，需 Tom 技术放行 + Rita 授权。
