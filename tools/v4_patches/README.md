# v4 补丁包（2026-10-27 修正版）—— 主库 + 生产库根治

配套文档：`22_NextPhase/主库与生产库_根治完整方案_v4_终版_20261026.md`（含 §10 主库全程零影响证明与可复算验收步骤）

## 基线源码

`clasp pull` 于 2026-10-26 23:44，18 个文件，目录 `D:/AI_DATA/WorkBuddy/_ts_current_20261026/`（`PeriodLockGuard.js` 619 行 / `RemoteActions.js` 1144 行 / `masterAttendanceLive.js`）。
**应用前请务必对 ts-manager（`1FPAwV50VdpI2AGT42rfn6JhU0assY1QaARbhTQeiUKS0mZ66yf_JRb8R`）重新 `clasp pull` 并核对行数**：
行数对不上说明线上已变，补丁需重新生成。

## 补丁清单（7 份，按应用顺序）

各补丁独立、互不重叠；同一源文件的多份补丁按顺序叠加。

| # | 补丁 | 目标文件 | 作用 | git hash | SHA-256(前12) |
|---|---|---|---|---|---|
| A1c | `A1c_PeriodLockGuard_guardedInsert.patch` | `PeriodLockGuard.js` | `guardedInsert` 取锁提前到预检之前（修 Tom Q2 连坐整批） | `226db9c70250` | `226db9c70250` |
| A0 | `A0_PeriodLockGuard_cleanupGuard.patch` | `PeriodLockGuard.js` | 新增清理类工具统一护栏 `_plGuardCleanup` / `_plGuardedCleanup` | `5c1989689c77` | `5c1989689c77` |
| A1 | `A1_RemoteActions_tsAppendRows.patch` | `RemoteActions.js` | **根因修复**：去重搬进临界区（TOCTOU） | `f6a8596c7ad9` | `f6a8596c7ad9` |
| A1b | `A1b_RemoteActions_tsPatchCells.patch` | `RemoteActions.js` | `tsPatchCells` 非 DB 分支补锁 | `de6dbd9da7ec` | `de6dbd9da7ec` |
| A0d | `A0d_RemoteActions_dupReport_deny.patch` | `RemoteActions.js` | `tsDupReport(fix=1)` 自动改写必须失效 | `8315bd51548a` | `8315bd51548a` |
| A1d | `A1d_RemoteActions_tsSoftDelGuarded.patch` | `RemoteActions.js` | **服务端 CAS 软标**：锁内重读 UUID+负载+keeper+底稿→校验→写→回读（闭环 Tom 第1条） | `bc636ced8f3e` | `bc636ced8f3e` |
| A7 | `A7_masterAttendanceLive_orphanVisible.patch` | `masterAttendanceLive.js` | 挂起行（录入≤水位线且底稿无匹配）可见化、不写入 | `3b69b3ba8dc7` | `3b69b3ba8dc7` |

## full/ —— 逐字节一致的最终源码

`full/` 下 **3 个累计文件**，等于「基线 + 该源文件对应的全部补丁」应用后的结果，已用 `git -c core.autocrlf=false apply` 复算逐字节一致（见下「逐字节验证」）：

| 累计文件 | 对应源文件 | 含补丁 | SHA-256(前12) |
|---|---|---|---|
| `full/PeriodLockGuard.A0_PeriodLockGuard_cleanupGuard.js` | `PeriodLockGuard.js` | A1c + A0 | `fbdbe0c6e06e` |
| `full/RemoteActions.A1d_RemoteActions_tsSoftDelGuarded.js` | `RemoteActions.js` | A1 + A1b + A0d + A1d | `7e23d80d90a7` |
| `full/masterAttendanceLive.A7_masterAttendanceLive_orphanVisible.js` | `masterAttendanceLive.js` | A7 | `3865abb08ea9` |

> 验证方法（可复算）：取基线目录 → `git init` → `git -c core.autocrlf=false apply` 上述对应补丁（同一文件按表内顺序）→ `diff` 与 `full/` 该文件，应无任何差异。

## 逐字节验证（已实测，2026-10-27 11:45）

```
全部 7 份补丁：git apply --check 通过、node --check 通过、CRLF=无
基线 + 7 补丁 → diff 与 full/ 三文件：0 差异（逐字节一致）
```

## 隔离测试（行为证据，回应 Tom 第1/2/3/4/5/6/7条）

| 测试台 | 覆盖 | 结果 |
|---|---|---|
| `tools/patch_harness.js` | GAS 补丁链单元行为（去重/锁序/幂等/护栏/CAS/挂起行可见/A1d 服务端 CAS）：T1–T14 | **14/14 通过** |
| `tools/ts_softdel_gas_harness.js` | **隔离 GAS 适配器**：用 vm 沙箱 + 忠实 GAS shim 加载【生成器产出的真实交付文件 `full/ts_softdel_gas_embedded.js`】，与 Node 核心对【同一份内存表】跑相同输入，比对 Date/字符串/前导零/布尔/审计指纹/期锁/响应（G0 + S1–S19） | **20/20 通过**（GAS ≡ Node 行为等价，由规范源生成、适配器隔离证明） |
| `tools/ts_softdel_harness.js` | 真实执行器 `ts_softdel.js`（运输层+ts_post 被 mock，mock 忠实实现 A1d 服务端 CAS）逐场景：A–I + J–S + Core-Unit + Tom 7 项负例 | **36/0 失败** |

> **GAS ≡ Node 等价证据（回应 Tom #1/#2）**：`gen_gas_softdel.py` 从单一可信源（`ts_softdel_core.js` + `ts_softdel_norm.js` + `period_lock_port.js`）逐字内联生成 `full/ts_softdel_gas_embedded.js`，业务逻辑与 Node 模块文本一致；`ts_softdel_gas_harness.js` 进一步用隔离适配器加载**真实交付文件**在 GAS shim 下运行，与 Node 核心跑同一组种子，20/20 逐项比对一致（含真实 SHA-256 跨环境逐字节一致）。**等价已由两套独立 harness 证明**，非单点声称。

> **逐字性可复现校验（回应 Tom #1「源码/生成物/输出错配」）**：`tools/verify_gas_single_source.py` 断言「核心/规范化/期锁三个规范源文件，去掉 `'use strict'` 与 `module.exports` 包装后的正文」是生成物的**连续子串**，并连跑两次生成器断言输出 SHA-256 不变。运行时每件源码哈希与结论一并归档为证据，避免"固定提交里规范源与生成物不是同一版"再次发生。

> **v3 过度主张的更正**：v3 曾把 `acquireMasterLock` 描述为「跨项目写协调」。按 Google 官方说明，`LockService.getScriptLock()` **仅作用于脚本**（同一脚本项目内的并发执行），不提供跨项目/跨文档互斥。v4 已在代码注释与本文档如实更正，**不再声称**跨项目写协调。


`ts_softdel_harness` 场景 ↔ Tom 10 场景规格映射：

| Tom 规格 | 场景 | 行为证据 |
|---|---|---|
| 同UUID同负载恰一次 | S1 | ok+全写+回读 TRUE → 退出 0 |
| 写成功响应丢失可查批次、不盲重试 | S2 | 空响应 → 登记不明、退出 1、零覆盖 |
| 服务端 ok=false | S3 | 登记不明、退出 1、零覆盖 |
| 部分写入 | S4 | wrote≠batch → 登记不明、退出 1、零覆盖 |
| 读快照缺页拒绝 | S5/S7 | 底稿/生产表读失败 → 整批拒绝、不盲写（防自动降级） |
| A级变B级拒绝 | S5b | A级预期但底稿缺该UUID(bc=0) → 拒绝且绝不降级 |
| 每批回读O列不符 | S6 | 声称写成功但回读 FALSE → 登记不明、退出 1 |
| 异负载CONFLICT零覆盖 | S8 | 锁内重读发现目标≠keeper → CONFLICT、零覆盖 |
| 锁忙零写 | S9 | 锁占用 → ok=false、零写入、退出 1 |
| keeper/行号变化拒绝 | S10 | 锁内重读 keeper 失效 → KEEPER_INVALID、零覆盖 |
| 关账拒绝+合法新行+幂等重试 | S11 | 期内行 PERIOD_LOCKED 拒；期外合法新行放行；重放开行后已写行幂等跳过、补齐、不双写 |
| 批中断+flush失败 | S12 | 写1行后崩溃 → 中止；重跑已写行幂等跳过、其余补齐、不双写 |

证据存档：`_tmp/evidence/patch_harness_20261027.txt`、`_tmp/evidence/ts_softdel_harness_20261028.txt`、`_tmp/evidence/gas_adapter_harness_20261028.txt`、`evidence/gas_adapter_harness_v4_20261027.txt`、`evidence/gen_single_source_20261027.txt`。

**A1d-v4 入口绑定（回应 Tom #2「真实入口仍未绑定」）**：旧 A1d patch（`bc636ced8f3e`）**已废弃**——它在 `RemoteActions.js` 里新增的 `tsSoftDelGuarded` 是另一份旧实现（旧 djb2 指纹、无日志、无请求身份）。v4 改为：

| 产物 | 作用 |
|---|---|
| `full/apply_a1d_v4_entry.py` | 删除旧 `tsSoftDelGuarded` 及其全部旧助手（`_sdNormHash`/`_sdBuildMasterMap`/`_sdIsClearance`/`_sdSoftDel`/`_sdNorm`/`_isTrue`/`_isFalse`/`_SD_ROW_KEYS`），再追加生成物 |
| `full/RemoteActions.A1d_v4_FINAL_entry_bound.js` | 最终文件（全局**唯一** `tsSoftDelGuarded` 定义） |
| `full/A1d_v4_入口绑定_静态映射.md` | 原链路 → 新核心 的逐项静态映射（带最终文件行号）+ doPost 装配说明 + 可证明/不可证明边界 |

## 应用方式

```bash
# 在 clasp pull 出来的目录里
git init -q . && git add -A && git commit -qm base   # 先建基线，便于回滚
# PeriodLockGuard.js：
git -c core.autocrlf=false apply A1c_PeriodLockGuard_guardedInsert.patch
git -c core.autocrlf=false apply A0_PeriodLockGuard_cleanupGuard.patch
# RemoteActions.js：
git -c core.autocrlf=false apply A1_RemoteActions_tsAppendRows.patch
git -c core.autocrlf=false apply A1b_RemoteActions_tsPatchCells.patch
git -c core.autocrlf=false apply A0d_RemoteActions_dupReport_deny.patch
# A1d：**不要用** A1d_RemoteActions_tsSoftDelGuarded.patch（旧实现，已废弃）
#      改用 v4 入口绑定脚本：先删旧 tsSoftDelGuarded 及旧助手，再追加生成物
python full/apply_a1d_v4_entry.py     # 产出 full/RemoteActions.A1d_v4_FINAL_entry_bound.js
# masterAttendanceLive.js：
git -c core.autocrlf=false apply A7_masterAttendanceLive_orphanVisible.patch
node --check PeriodLockGuard.js && node --check RemoteActions.js && node --check masterAttendanceLive.js
```

> ⚠️ 必须 `core.autocrlf=false`，否则补丁上下文因行尾符失配而拒应用。

## 未包含在补丁包里的动作

- **A2**（`tools/ts_post.py` 写入冻结开关）—— 本地脚本，非 GAS，见方案 §A2。
- **A3/A4/A5/A6**（数据清理与对账）—— 属于**生产写操作**，当前处于 NO-GO，待 Tom 评审后再执行。

## 🔴🔴🔴 红线：严禁换链接（2026-10-27 00:57 Rita 明文立规）

**本补丁包不换链接。** 任何 GAS / Web App 修复**永远不得产生新的访问链接**。

- **禁止**：新建部署、删旧部署重建、为图省事另起部署。
- **只允许**：只推 HEAD（`clasp push`），或既有部署**原地更新**到新版本 —— 两者链接都不变。
- **推前**：离线验证（`node --check` + 隔离 harness + dry-run 小样本）。@HEAD 无版本缓冲，推错立刻影响生产。
- **推后必做**：`clasp list-deployments` 复核 —— 必须**仍是 3 条**，`@HEAD` / `@189` / `@192` 三个 ID 与推前**逐字符一致**。多出任何一条即为换链接事故，立刻回滚并上报。
- 不以"更快 / 更干净 / 版本太多"等任何理由破例。

现役基准（2026-10-27 00:4x 实测）：

| 部署 ID | 版本 |
|---|---|
| `AKfycbwlxB2z9IDDo7pBv4sr0pu6-1ywvYBuRyqTwfjgl_o` | @HEAD（生产在用，推码即生效） |
| `AKfycbwYXV3VS3I59bVpUi9XBMClGsFkJ6l_NxPdQcysiXYe47-iONNMk6FIoI8VEXwYl-_2` | @189 |
| `AKfycbzUyhyK-tqL7pp2H2jZXNCMciEr2PJwhkZIg0bwV1OwV3C6D9RKJZhA4HpiUi6F5eF` | @192 |

- 推码前先离线验证；生产 NO-GO 期间不推送。
