# v189 对账报告 · 相对已审基线 5439a29（period-lock v8）

> 生成：2026-10-26T04:49:03.384Z ｜ 当前 HEAD = ts-manager v189（scriptId 1FPAwV50…）
> 基线 = audit_shared@5439a29（period-lock 实现 v8，已审交付基线，Tom 15:28 收口）

## 1. 19 项目录清单（真实部署 18 项 + 别名说明）

| # | 文件 | 字节 | SHA-256 |
|---|---|---|---|
| 1 | amy_indirect_cost.gs | 4050 | f69d5e583f4d91e2… |
| 2 | appsscript.json | 265 | e7485992b05754d7… |
| 3 | Code.gs | 24756 | 00b89f19c9334a7b… |
| 4 | FixBDates.gs | 3778 | 1b1f98bbb8fd52ce… |
| 5 | Index.html | 97494 | 9016dc297756d3ce… |
| 6 | leave_sync.gs | 19541 | 410e0e46110f292e… |
| 7 | masterAttendanceLive.gs | 17538 | 714fb0fa4d32e0b6… |
| 8 | masterCreate.gs | 4898 | a571132b60c0a5fe… |
| 9 | masterException.gs | 765 | c2c8a7d4e616c3f6… |
| 10 | masterLeaves.gs | 4941 | e4844cc7fa34ba2b… |
| 11 | onOpen.gs | 74707 | 047aaebac4bf4c2c… |
| 12 | PeriodLockGuard.gs | 23727 | 6e771841eb5d28e6… |
| 13 | PruneDead.gs | 2090 | f81e1f5c059344f4… |
| 14 | rebuildAttendance.gs | 34193 | 26d6a3cffc916377… |
| 15 | RemoteActions.gs | 53896 | 81463a9280435862… |
| 16 | RemoteTrigger.gs | 7274 | 0f7cb43b2c31f978… |
| 17 | 抓取设计脚本.gs | 1977 | a85da049747d7dab… |
| 18 | 每天自动提醒.gs | 4778 | 7bfc0feb9c415ea9… |

appsscript（无扩展名）是 appsscript.json 的别名，非独立部署文件；.clasp.json 为本地 clasp 开发配置，不上线。故真实部署文件 = 18 项；若计入别名则 19 项（即 Tom 更正后的目录数，非 20）。

## 2. 关键三文件：基线(5439a29) vs 当前(v189)

| 文件 | 字节一致? | 当前 SHA | 基线 SHA | 函数(当/基) | 新增函数 | 移除函数 |
|---|---|---|---|---|---|---|
| PeriodLockGuard.gs | ✅逐字节相同 | 6e771841eb5d | 6e771841eb5d | 21/21 | 0 | 0 |
| Code.gs | ❌不同 | 00b89f19c933 | 1f4cd1f3e66c | 24/24 | 0 | 0 |
| Index.html | ❌不同 | 9016dc297756 | 0831cfb9c970 | 55/55 | 0 | 0 |

- **PeriodLockGuard.gs：当前 v189 与已审基线 5439a29 逐字节 SHA-256 完全一致（6e771841…），证明 v186 误删后、v189 的恢复把守卫精确还原到审计态。**
- Code.gs / Index.html 有差异（v187/v188 其他修复所致），函数级变动见下。

### Code.gs 行级对照（v189 vs 5439a29）
- 行增/删 = +585 / −609；函数(当/基) = 24/24
- 注：Code.gs 差异来自 v187/v188 后续 bug-fix 版本（非守卫回归）；v189 完整源码见 audit_shared 提交，可逐函数复核。

### Index.html 行级对照（v189 vs 5439a29）
- 行增/删 = +1244 / −1244；函数(当/基) = 55/55
- 注：Index.html 行删=行增（等量），对应 v8 交付件注记的 CR-CR-LF 行尾规范化（1174→1242 行），**非真实内容回归**；客户端八处已于 v189 恢复，完整源码见 audit_shared 提交。

## 3. 153 行软删修复清单（repair_153_manifest.json，精确 153 条）

- 条目数 = 153（= 56+33+63+1，与 Tom 二函可核点一致）
- 捕获基准：`repair_153_before.json` generatedAt = **2026-10-26T01:11:24**（undo 后基准，非 23:52 软删前原值——见卡点说明）
- 软删为标志位翻转（col14=TRUE），行内容不丢失；01:11:24 捕获即还原后状态，含 153 行原值。

## 4. 113 精确漂移清单（oct_dup_manifest.json，精确 113 条）

- 精确清单已具备（非 10804–10938 范围），条目数 = 113
- 配套 `drift_cells_v2_20261026.json`（SHA-256 单元格级对照，total_diff_cells=0）提供每格证据。

## 5. 卡点（真卡点 vs 已交付）

- ✅ 已交付：19 项目录、Guard 字节一致、Code/Index 函数级 diff、153 精确清单、113 精确清单、c337635↔5439a29 关系说明（见下）。
- ⚠️ c337635 与 5439a29 关系：5439a29 = audit_shared 仓库 period-lock v8 已审基线；c337635 = SMCN_ERP 工作仓库 commit「补登 v163-v166 部署证据（GAS 现场取证）」。二者分属**两个独立仓库**，无父子关系；生产 v189 权威源码来自 GAS 工程(scriptId 1FPAwV50)，本报告以其 pulled HEAD 与 5439a29 源码对照。
- ⚠️ 门禁暴露窗口日志（v186→v189 期间有无真实写入）：需 GAS 执行日志（script.processes 权限），本机 token 不含该 scope，无法取执行日志。仅能以**只读扫描**佐证（06:15–06:45 生产表零新增系统同步请假行；v189 远程验证 guard 在线）。如需执行日志，须由有权限方（或授予本工程读权）从 Google 取。
- ⚠️ 153 的 23:52 软删前原值：00:47 快照被 08:26 覆盖，该不可变副本已失；现有 01:11:24 undo 基准含 153 行还原后原值（软删仅翻标志位，行数据完好）。如需 23:52 精确标志位态，可现场重读生产表 153 行当前态。