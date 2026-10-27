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

## 隔离测试（行为证据，回应 Tom 第1/2/3/4/5条）

### 测试台一：`tools/patch_harness.js`（GAS 补丁链单元行为）
GAS 补丁链单元行为（去重/锁序/幂等/护栏/CAS/挂起行可见/A1d 服务端 CAS）：**T1–T14 → 14/14 通过**。
证据存档：`evidence/patch_harness_20261027.txt`（另 `_tmp/evidence/` 亦存）。

### 测试台二：`tools/ts_softdel_harness.js`（**忠实隔离 harness，36/0**）
**真实** `ts_softdel.js` 执行器 + **真实** `ts_post.py` 运输层，经 `127.0.0.1` 隔离端点，服务端用**真实** `ts_softdel_core.js` 业务核心；mock 仅替换存储/锁/网络。不加载任何生产地址/密钥。
> 本 harness **取代**此前 commit `f43f910` 的 expanded `ts_softdel_harness`（旧版因 mock 装配缺陷未能真实证明核心）；旧版 `patch_harness.js`（T14 14/14）保留作 GAS 补丁链单元证据。

结果：**36 通过 / 0 失败**（场景 A–I + J–S + Core-Unit 8 项类型闭合 + Tom 7 项负例）。证据存档：`evidence/ts_softdel_harness_20261027.txt`。

忠实 harness 场景 ↔ Tom 复审规格映射：

| Tom 规格 | 场景 | 行为证据 |
|---|---|---|
| 端到端 happy path（默认 dry-run 失败封闭） | A | 退出 0；载荷携带 batchId + 每行 expectHash/keeperHash/expectBaseHash |
| 真实写 + 独立回读确认（闭环点1/3） | B | apply 退出 0；apply 后该行 O=TRUE（**独立回读确认**） |
| 已软标行诚实拒（不虚构 ok:true） | C | ALREADY_SOFTDEL，O 仍 TRUE |
| 分页完整性·生产表中间页失败（点4） | D | 整批 ABORT 且退出 1 |
| 分页完整性·末页截短 | E | 整批 ABORT 且退出 1 |
| 分页完整性·lastRow 漂移 | F | 整批 ABORT 且退出 1 |
| 分页完整性·底稿漏页 | G | 整批 ABORT 且退出 1 |
| 期锁拦截（无 clearance） | H | PERIOD_LOCKED，ok=false，O 仍非 TRUE |
| 响应丢失+副作用已发生+状态回读（点2/3） | I | FAIL/登记不明、不盲重试；核心仍真实写入 O=TRUE；`--status` 回读确认 WROTE_OR_ALREADY_APPLIED |
| 主库锁内读取/缺页→整批拒（点1 服务端守卫） | J | BASE_READ_INCOMPLETE，整批拒且未写 |
| 缺期锁依赖→整批拒（点3） | K | PERIOD_DEP_MISSING，整批拒且未写 |
| 客户端预筛拦截异负载（与核心 TARGET_DRIFT 互补） | L | 端到端：异负载行被预筛拒（0 写入，未误写） |
| 跨页版本变更/读期间漂移→整批拒（点7） | M | re-probe 变化→ABORT 且退出 1 |
| 缺 batchId / dry 响应 / 状态读失败（点4/#5） | N1/N2/N3 | 缺 batchId 拒；dry 响应拒（不得计为已写）；响应丢失+状态读失败→`--status` 留 UNKNOWN 不自动重试 |
| 缺 master 表 B 级（点1 服务端守卫，单独列示 B 级） | O | BASE_READ_INCOMPLETE，B 级整批拒（不再误判底稿0行放行） |
| null 参数（rows 非数组）→ 直接拒（点6 经运输层） | P | 服务端拒绝 |
| APPLY 严格响应契约正向（version/ok/wrote 布尔） | Q | 退出 0；响应含 version=ts_softdel_core/2 且模式 APPLY |
| 参数/keeper 类型闭合（点6，Core-Unit 8 项） | CU | 自指混合类型/null dry/非数组/未知字段/依赖冲突/缺期锁/主库不完整/drift 均拒 |
| 跨环境一致性（GAS 内联副本 == Node 模块） | S | SHA-256 固定向量全部命中 |

证据存档：`evidence/ts_softdel_harness_20261027.txt`。

## 本 commit（在 `f43f910` 之上）新增/变更交付物

| 文件 | 状态 | 说明 |
|---|---|---|
| `tools/ts_softdel_core.js` | **新增** | 软标【真实服务端业务核心】，单一可信源：GAS `tsSoftDelGuarded` 与 Node 隔离 harness 共用同一套 `_sdNorm/_sdNormHash/CAS/期锁/fail-closed` 逻辑，仅经 deps 注入存储/锁/网络。 |
| `tools/ts_softdel.js` | 变更 | 软标执行器：分页完整性（任一页失败/截短/lastRow 漂移→ABORT 退出1）、结构化三级 hash 载荷、批量严格响应校验（batchId+逐行一一对应+ok=false 拒+独立 rereadO 后验）、防降级（safe→A / notInBase→B）。 |
| `tools/ts_post.py` | 变更 | 写入端运输层：`TS_WRITE_FREEZE` 默认冻结；GAS 302→GET 取回响应体；stdout 仅 JSON 信封、诊断走 stderr。 |
| `tools/ts_softdel_harness.js` | **替换** | 忠实隔离 harness（36/0），取代旧 expanded harness（旧版 mock 装配缺陷已修正）。 |
| `tools/ts_softdel_verify.js` | **新增** | 执行后只读复核器：O 全 TRUE / keeper 零误伤 / 主库底稿零变化。 |
| `tools/forensics/base_uuid_audit.js` | 变更 | 底稿侧取证：发 per-row 三级 hash（与核心一致），供执行器绑定审计原值。 |
| `docs/T1-B_复审交付说明_20261027.md` | **新增** | 本次复审交付说明：实际调用链 + 契约 + 完整性 + 真实核心隔离证据 + 分层对账 + 逐项回应 Tom 6 点。 |
| `evidence/ts_softdel_harness_20261027.txt` | 新增 | 忠实 harness 36/0 原始输出。 |

> 注：`patch_harness.js`（T14 14/14）、`pseudonymize_evidence.py`、`v4_genpatches.py` 已于先前 commit 入库，本次随镜像保持一致。

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
git -c core.autocrlf=false apply A1d_RemoteActions_tsSoftDelGuarded.patch
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
