# W4 — 生产工时表（DB_工时流水, ssId `1Pi5u9fE`）写者穷尽枚举与共同守卫分析

> 目标：回答 Tom 10:11 邮件中「W4：实际写者穷尽、旁路和共同守卫证据待核」。
> 范围：部署版生产后端项目 `finance_dss_backend`（ts-manager 后端，版本 TS_APP_VERSION=4.3.72）。
> 方法：对 `code_pull/finance_dss_backend/` 全量静态枚举所有 `setValues`/`appendRow` 写入点，按目标表归类，标注守卫类型。

## 一、写者全景（精确 file:line）

| # | 函数 | 文件:行 | 写入目标表 | 写入列 | 守卫类型 | 是否业务新增行 |
|---|------|---------|-----------|--------|----------|----------------|
| 1 | `submitBatch` | `Code.js:464` → `_plGuardedInsert` | DB_工时流水 | A–N (14列) | **PeriodLockGuard._plGuardedInsert** | ✅ 是 |
| 2 | `tsAppendRows` | `RemoteActions.js:127` → `_plGuardedInsert` | DB_工时流水 | A–N (14列) | **PeriodLockGuard._plGuardedInsert** | ✅ 是（**含 Edit A 竞态**） |
| 3 | `updateTimesheet` | `Code.js:500` → `_plGuardedMutation` | DB_工时流水 | B–J (改一行) | PeriodLockGuard._plGuardedMutation | 改（非新增） |
| 4 | `softDeleteRecord` | `Code.js:530` → `_plGuardedMutation` | DB_工时流水 | O/P/Q (软标) | PeriodLockGuard._plGuardedMutation | 软标 |
| 5 | `repairLegacyLeave` | `RemoteActions.js:1011` → `getScriptLock` | DB_工时流水 | O/P/Q (软标) | **LockService.getScriptLock（绕过守卫）** | 软标 |
| 6 | `cleanupDuplicateLeavesInternal` | `Code.js:564` → `getScriptLock` | DB_工时流水 | 全行重写（保留非请假行） | **getScriptLock（绕过守卫）** | 重写（请假去重） |
| 7 | `tsPurgeSoftLeaves` / `purgeRows` | `RemoteActions.js:836/868` | DB_工时流水 | 全行重写（删除软标行） | getScriptLock（由调用方） | 物理删（仅软标行） |
| 8 | `syncLeavesFromCalendar`（部署版） | `leave_sync.js:216` | **主库 MASTER_LEAVE_SHEET** | A–N | getScriptLock | ❌ 不写 DB_工时流水 |

**草稿夹 `_dss_verify/leave_sync.js`**（写 `DB_工时流水` @ `:108`）**不在部署项目内**，属验证期残留，不计入生产写者。

## 二、关键结论

1. **业务新增行仅 2 个入口**（#1 submitBatch、#2 tsAppendRows），均经 `_plGuardedInsert`。**唯一并发重放缺陷在 #2 tsAppendRows**：其在锁外读 `exist{}`（RemoteActions.js:96–105）、锁外定 `toWrite`（:107–117），入锁后未传 `lockPreWrite` → 锁内重核跳过。Edit A 即修此点。
   - #1 submitBatch 从请求体直接构造 `newRows`（无锁外回表读），竞态面不同（两标签页并发同提交可经 recentSeen 10 分钟窗漏检，但属有界、非历史重放根因）。**Edit A 修复（`lockPreWrite` 锁内重读）对 #1 同样加固**，建议一并应用。

2. **维护类写者 #5/#6/#7 绕过 PeriodLockGuard，仅用 `getScriptLock`（脚本级锁）**。它们只动 O/P/Q 标记列或重写请假行，**不新增业务工时行**，且以单例每日触发器（06:30 leave_sync、手动菜单）形式运行，与人工提交（#1/#2）时间不重叠。
   - 这正是 Tom「旁路/共同守卫」顾虑点。两种闭环方式：
     - **(b) 范围化（推荐，够用）**：Edit B（getDocumentLock）只覆盖业务新增入口 #1/#2；维护写者 #5/#6/#7 维持 `getScriptLock` 单例语义，因不新增业务行、不与提交并发，非双写风险源。在 `fix_T1-B_concurrency_window.md §0` 显式标注范围。
     - **(a) 强化（可选）**：将 #5/#6/#7 也迁入 `_plGuardedMutation`/`_plGuardedInsert`，统一守卫。非本次事故必需，列为准后加固项。

3. **写者穷尽性证据**：对 `code_pull/` 全仓（`finance_dss_backend`、`_dss_verify`、其余项目）grep 凡写 `DB_工时流水` 者已尽数列入；`finance_salary_api`（`工时照妖镜`）、`_dss_verify/onOpen.js`（报告）、`masterAttendanceLive.js`（主库考勤）均为**读取或写其他表**，已排除。

## 三、判定路径（给 Tom 逐项勾选）

- W4-① 写者穷尽：**证据见上表 8 项 + 全仓排除说明** → 可勾「已核」。
- W4-② 旁路：`#5/#6/#7` 用 `getScriptLock` 绕过守卫 → **承认存在旁路，但范围非业务新增行** → 建议采 (b) 范围化闭环。
- W4-③ 共同守卫：Edit A 给 #1/#2 统一 `lockPreWrite`；Edit B 用 `getDocumentLock` 覆盖 #1/#2 跨项目互斥 → 维护写者按 (b) 维持。

请 Tom 就「(a) 强化迁移 / (b) 范围化」二选一裁定，并回填 W4 三项状态（已接受/进行中-卡点/需我方补充）。
