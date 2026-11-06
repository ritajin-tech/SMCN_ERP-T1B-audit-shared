# v76 固定版本与哈希登记册（回应 Tom 16:50:22Z「固定并核对 v75 登记册和相应原件的版本及哈希」）

> 采集时点：2026-11-07 01:05–01:1x 北京 / 2026-11-06 17:05–17:1x UTC
> 采集方式：本地 `_tmp/audit_shared/` 副本逐文件读取原始字节算 SHA-256 + `git hash-object` 算 Git blob SHA-1；两表读 hktool `inspectWorkbook`（只读）；部署读 `projects.deployments` GET（只读）。
> 性质：**静态只读登记册**。零生产写、零主库写、零部署、零链接变更、零解冻、零自动回滚、零脚本执行（本轮不运行 `recheck_*.py` 或任何所交脚本）。
> 🔴 口径说明：GitHub blob SHA 是 **Git 对象标识（SHA-1）**，本地列的是**文件原始字节 SHA-256**；两者算法不同、数值不应相等，请勿据此判断不一致。v75 登记册已写过同一句，本件沿用。

---

## 一、版本链（共享库 main，补 v75 固定点）

| 代 | commit（完整） | 时间（UTC） | 内容 |
|---|---|---|---|
| v70 | `8a7e24d3e44b055821efb1b44dba760065be56a3` | 2026-11-05 12:16:46Z | 收工版 / 模式切换 |
| v71 | `f346a510b3b83770fa3c16f017f70c90f81f97b9` | 2026-11-05 14:17:05Z | 事件驱动首例 |
| v72 | `e6c1a5646b527f9f5de95d990fd4721fac1fdf7a` | 2026-11-05 14:45:41Z | 全 18 列 / UUID 四项 / 17 行逐行哈希 |
| v73 | `d761fbcf334878921db9e8d1f3096b51563d4905` | 2026-11-05 15:13:32Z | 四种口径复算 / 逐行归因 / 第六轮诚实修正 |
| v74 | `6a296324d05de8e2bd29278e3bb9f2b3bd5d92b2` | 2026-11-06 05:25:23Z | V7 req≠行数澄清 + V9 四方责任清单 |
| **v75 内容提交** | **`8f0c8b6dcb7a208ae705b8ee09e481714b316754`** | **2026-11-06 16:32:15Z** | v75 正文 + 预填靶子 + v75 登记册 + v75 只读实证（4 files / 588 insertions） |
| **v75 最终 main（发布前固定点）** | **`13bc6ec0e3b1d7f51cbcebb514a5ee8b3519c5d3`** | **2026-11-06 16:33:34Z** | v75 正文回填内容提交哈希 |

发布前核查：`list_commits` 前 6 条如上，11-06 只有 v75 两条且作者均为 `rita.jin`；**PR 0 / Issue 0（含 closed）**；`ls-remote origin main = 13bc6ec…`，与本地 HEAD 一致，本地 `git status` 干净。即 Tom 16:50Z 回函**未伴随任何共享库编辑、PR 或 Issue**。

---

## 二、v75 登记册及相应原件：逐件固定（本轮实测）

Tom 本封点名「v75 登记册和相应原件」。以下四件为 v75 本轮交付物，**按 `13bc6ec` 固定，字节一个未改**：

| 文件 | 字节 | 本地原始字节 SHA-256（完整） | Git blob SHA-1 |
|---|---|---|---|
| `docs/v75_full_review_20261107.md` | 20,934 | `a2817e224cb285ded3fa590e3435b5e3992a25b7183d3dbb4aa9595fa6c21aea` | `93f2628e68962f99c982cacc00132fe751e4ae0d` |
| `docs/T1-B_v75_明确方案与具体编辑_Tom可直接编辑_20261107.md` | 15,509 | `6ecdbf4ca0f4fb82b62877c45f8261a3f3afa95814982b89ef9f63500572625a` | `0d0e00dac486b032740a42dbd2eb2e419af70e3b` |
| `evidence/v75_fixed_versions_hashes_20261107.md` | 9,369 | `7421b206858ba1761413c61f8379fc5c1f654117d3b8d4e30d30babee4b45903` | `65c42d73dc8f00e6eb93013306ec498418624131` |
| `evidence/v75_live_state_20261107.json` | 1,516 | `9370257e02036c7a2bc00e8ffad7b98e5a8cf4ff68f86966843d202b306e6053` | `a1997d87b9a2360c9956281ad25e740d516f2eea` |

> 交叉验证：GitHub `get_file_contents` 列 `docs/` 返回 `v75_full_review_20261107.md` = 20,934 B / blob `93f2628e…`，本地实测一致；v75 靶子 = 15,509 B / blob `0d0e00da…`，一致。
> 🔴 **v76 不修改上述任何一件的字节**：Tom 要求的「固定」若被本轮改写就失去可核性，故 v76 的具体编辑靶子是**新增承接文件**，不改 v75 原文。这是「不回退、记住进度」的技术落地。

---

## 三、v75 登记册所列原件的复算（本轮逐件重算，全部 PASS）

| 文件（v75 登记册声明值） | 声明 SHA-256 前缀 | 本轮重算 | 结论 |
|---|---|---|---|
| `evidence/v72_preservation/S1_raw_prod_20261104_0835.csv` | `4a4d8e190b54bcb8e01e8ac8…` | `4a4d8e190b54bcb8e01e8ac8…` | **PASS** |
| `evidence/v72_preservation/S2_raw_prod_20261105_0838.csv` | `360c5c1a9c21ffcc1d4e2384…` | `360c5c1a9c21ffcc1d4e2384…` | **PASS** |
| `evidence/v73_preservation/V7_scope_matrix.md` | `0e3eef986aef68ff0ff4c07c6…` | `0e3eef986aef68ff0ff4c07c6…` | **PASS** |
| `evidence/v73_preservation/V7_repairAB_log_coverage.md` | `fdc4a06b7811502d107fa75c4…` | `fdc4a06b7811502d107fa75c4…` | **PASS** |
| `evidence/v73_preservation/V8_uuid_by_original_value.md` | `0e65a9b10fbba94d0f7aa9f0…` | `0e65a9b10fbba94d0f7aa9f0…` | **PASS** |
| `evidence/v73_preservation/V9_master_derivation_evidence.md` | `9ab1fadf1b041f40aac79de48…` | `9ab1fadf1b041f40aac79de48…` | **PASS** |

**全量清单**：`evidence/v76_hash_inventory_20261107.json` 收录**以 v75 固定点 `13bc6ec` 为基准**的共享库 main 全部 **327 件** `docs/` + `evidence/` 文件（不含本轮 v76 新增 5 件，避免自引用），逐件给 `bytes` / `sha256` / `git_blob_sha1`，并写明两种算法的区别。你方可任选一件用任意工具 `sha256sum` 或 `git hash-object` 独立比对，**不需要运行我方脚本、不需要我方在场**。

> 诚实边界：本节的 PASS 只说明「v75 登记册声明的字节值与本轮本地副本重算一致」，**不等于**你方已取得并核验原始字节与来源，也**不等于**行数、漂移归因、部署状态或权限边界已被独立证实。你方 16:50Z 的立场我方照单接受，未作反驳。

---

## 四、v76 本轮新增工件（不自嵌自身哈希，避免循环引用）

| 文件 | 用途 |
|---|---|
| `docs/v76_full_review_20261107.md` | 系统大局梳理 v76 正文 |
| `docs/T1-B_v76_明确方案与具体编辑_Tom可直接编辑_20261107.md` | 按 Tom 16:50Z 四条条件逐格改写的**具体编辑靶子**（新增承接版，v75 原件不动） |
| `evidence/v76_fixed_versions_hashes_20261107.md` | 本件 |
| `evidence/v76_live_state_20261107.json` | 本轮两表 + 部署只读实证 |
| `evidence/v76_hash_inventory_20261107.json` | 327 件全量哈希清单 |

v76 五件的字节数 / SHA-256 / Git blob SHA 以及发布后的 main commit，**由回函邮件固定并在共享库 commit 列表可核**；本件不自嵌自身哈希，以免循环引用。

---

## 五、本轮两表与部署只读实证（2026-11-07 01:07 北京 / 11-06 17:07:53Z）

| 项 | 本轮读数 | 与 v75（00:18 北京）差 |
|---|---|---|
| 生产表 `DB_工时流水` | `lastRow=11336` / `lastCol=18` | **0 / 0** |
| 主库「请假」 | `lastRow=605` / `lastCol=15` | **0 / 0** |
| 生产表页签 | 16 页 | — |
| 主库页签 | **31 页**（本轮由 `master_tabs.sheets` 实测，与 v75 修正值一致） | 0 |
| `ts-manager` 部署数 | **3** | **0** |
| deploymentId ① | `AKfycbwlxB2z9IDDo7pBv4sr0pu6-1ywvYBuRyqTwfjgl_o`（@HEAD） | 未变 |
| deploymentId ② | `AKfycbwYXV3VS3I59bVpUi9XBMClGsFkJ6l_NxPdQcysiXYe47-iONNMk6FIoI8VEXwYl-_2`（v202） | 未变 |
| deploymentId ③ | `AKfycbzUyhyK-tqL7ypp2H2jZXNCMciEr2PJwhkZIg0bwV1OwV2C6D9RKJZhA4HpiUi6F5eF`（v197） | 未变 |

三个 deploymentId 与 v74 / v75 留底**逐字节一致**；零新增部署、零链接变更。原始回执：`evidence/v76_live_state_20261107.json`、`_tmp/v76_deployments_20261107.json`（本地中间产物，未发布）。

---

## 六、使用方式与边界

- 你方可对共享库任一文件做 `sha256sum` / `git hash-object` 比对；本登记册**不要求运行我方脚本**，也不预设你方验收。
- 全部工件为只读产物；采集期间零生产写、零主库写、零部署、零链接变更、零解冻、零脚本执行。
- 登记册只固定「已留存的版本与字节」；**不声称 R1–R3 已完成、不声称 R4 将完成、不声称任何权限或业务授权已核验、不宣称你方复算通过**。
- v76 靶子里的「改法」是我方**按你方 16:50Z 审阅建议先行改写的草案**，不是你方逐行核对后的最终 diff，也不是你方确认。
- 事故状态：OPEN / HOLD-NO-GO / M2 未签 / 阶段一 PASS 暂缓 / `TS_WRITE_FREEZE=1`，原样维持。
