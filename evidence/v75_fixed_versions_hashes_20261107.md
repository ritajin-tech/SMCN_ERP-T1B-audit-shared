# v75 固定版本与哈希登记册（回应 Tom 05:52:52Z「先取得并固定 v74 及对应清单、源数据和原始日志的版本与哈希」）

> 采集时点：2026-11-07 00:1x–00:2x 北京 / 2026-11-06 16:1x–16:2x UTC
> 采集方式：GitHub `get_file_contents`（blob SHA / 字节数）+ 本地 `_tmp/audit_shared/` 副本 `sha256sum`（原始字节），两者逐件并列，供不同工具独立复核。
> 性质：**静态只读登记册**。零生产写、零主库写、零部署、零链接变更、零解冻、零自动回滚。
> 口径说明：GitHub 的 blob SHA 是 Git 对象标识（SHA-1），本地列的是文件原始字节 SHA-256；**两者算法不同、数值不应相等**，请勿据此判断不一致。

---

## 一、版本链（共享库 main，固定点）

| 代 | commit（完整） | 时间（UTC） | 内容 |
|---|---|---|---|
| v70 | `8a7e24d3e44b055821efb1b44dba760065be56a3` | 2026-11-05 12:16:46Z | 收工版 / 模式切换（内容提交 `1b54fcbf3e85d97c691f8afef790db200fd6eeb1`） |
| v71 | `f346a510b3b83770fa3c16f017f70c90f81f97b9` | 2026-11-05 14:17:05Z | 事件驱动首例（内容提交 `89b3db0fab37a273ebe7ac9d424c80a2f6f4eef7`） |
| v72 | `e6c1a5646b527f9f5de95d990fd4721fac1fdf7a` | 2026-11-05 14:45:41Z | 全 18 列 / UUID 四项 / 17 行逐行哈希（内容提交） |
| v73 | `d761fbcf334878921db9e8d1f3096b51563d4905` | 2026-11-05 15:13:32Z | 四种口径复算 / 逐行归因 / 第六轮诚实修正 |
| **v74（当前 main 固定点）** | **`6a296324d05de8e2bd29278e3bb9f2b3bd5d92b2`** | **2026-11-06 05:25:23Z** | **V7 req≠行数澄清 + V9 四方责任清单** |

发布前 main 只有上述 v74 一条 11-06 提交；`list_commits since 2026-11-06` 返回 1 条，PR 0 / Issue 0 / 分支 main + master（master = `7833657cff895c7e3c44fdf58d81f5c796a50046`，2026-10-21 历史，未变）。

---

## 二、v74 正文与对应清单（Tom 点名的「v74 及对应清单」）

| 文件 | 字节 | 本地 SHA256（前 24） | GitHub blob SHA | 用途 |
|---|---|---|---|---|
| `docs/v74_full_review_20261105.md` | 9,189 | `1035e6b8191856cd987f69a4` | `bc4ad2cb4be71108f789b7253bf13be805a40c8d` | v74 正文：V7 澄清 / V8 接受 / V9 责任分工 |
| `evidence/v74_responsibility_checklist.md` | 2,753 | `36b6af2ab116464b667fa03d` | `7ff516ed9c9b25b8db49d7f42db0b4a700f3362e` | R1–R4 四方责任与可达性标注 |

## 三、源数据原始字节（Tom 点名的「源数据」）

| 文件 | 字节 | 本地 SHA256（完整 / 前 24） | GitHub blob SHA | 采集时点 |
|---|---|---|---|---|
| `evidence/v72_preservation/S1_raw_prod_20261104_0835.csv` | 2,388,420 | `4a4d8e190b54bcb8e01e8ac822097ed9a2fb0a1420a60a8842b25eebbd9b7f4d` | `6f895eba46fb64b16f87360be4ececfd86f27b9a` | 11-04 08:35 北京 / 00:35Z |
| `evidence/v72_preservation/S2_raw_prod_20261105_0838.csv` | 2,399,171 | `360c5c1a9c21ffcc1d4e238459ebaf365a03326a8841030d4a3365a4581790d3` | `0c886f862eee399badbc0c7854d4c1dc29d2ee5d` | 11-05 08:38 北京 / 00:38Z |
| `evidence/v71_preservation/_raw_prod_full_20261105_2200.json` | 2,794,032 | `6a649ea7a119f89f20dc7fc8…` | `f627fe3740d76e11366902b2209c5247ec5644c8` | 11-05 22:08 北京 / 14:08Z（S3） |

三快照真实数据行：S1 11,238 / S2 11,264 / S3 11,281；空占位行 14 / 14 / 38。S2→S3 历史 11,264 行零删零改、新增 17 行。

## 四、原始日志（Tom 点名的「原始日志」）

| 文件 | 字节 | 本地 SHA256（前 24） | GitHub blob SHA | 覆盖 |
|---|---|---|---|---|
| `evidence/v71_preservation/write_log_窗口摘录_20261104-05.txt` | 3,465 | `3fb53db2dff954ee4927f711` | `f7a8d184f13193a4969e619fd71248965cb0df9a` | §A 11-04 repairAB 24 批归因 / §B 11-05 全天 4 条零生产表修复写 / §C 请求标识缺口 |
| `evidence/v72_preservation/repairAB_full_write_scope_20261104.txt` | 5,129 | `364f73356a24ae67f9bb76cc` | `b242f87bd5b8142f8df56cc61848f9f3db324bb1` | 11-04 完整写范围 |
| `evidence/v73_preservation/V7_repairAB_log_coverage.md` | 7,397 | `fdc4a06b7811502d107fa75c46f9db1574652fb670bc32f3767903e2aecdb3c0` | `4bbea942de301cc4df0afa0cc86cb6055d5a74e1` | 57 条逐条（表内行号 / UTC / 北京 / 动作 / 明细） |

> 日志已知缺口（v65–v73 六轮已披露，不隐藏）：`_TS_WRITE_LOG` 仅 3 列，无 actor、无 request id；写前快照不可获取。本登记册只固定「已留存的原始字节」，不声称日志完整。

## 五、v73_preservation 9 件（V7 覆盖范围 / V8 歧义键 / V9 原始证据）

| 文件 | 字节 | 本地 SHA256（前 24） | GitHub blob SHA |
|---|---|---|---|
| `MANIFEST_v73.md` | 3,659 | `7caec9401dc6f358e07b8580` | `57bc23bd8f04628bc1aaa4e663aebf5bdb884f2f` |
| `V7_scope_matrix.md` | 3,676 | `0e3eef986aef68ff0ff4c07c6c810b1c986c422d9d35eae848d346cb9acce95c` | `1eb2dc713b99b24d353c5edab3b175120055adc6` |
| `V7_AB_delta_row_by_row.csv` | 294,206 | `e4b85aeaa85285077aa6e17e595d80061c2247b59a850acf32620998a2b7060f` | `984f65785702bbb429a77ddf0ebb6ab1a2675b57` |
| `V7_repairAB_log_coverage.md` | 7,397 | `fdc4a06b7811502d107fa75c46f9db1574652fb670bc32f3767903e2aecdb3c0` | `4bbea942de301cc4df0afa0cc86cb6055d5a74e1` |
| `V8_uuid_by_original_value.md` | 2,835 | `0e65a9b10fbba94d0f7aa9f0b147bc5970b03a49820f32d533b814e6d1a112d3` | `8be41e3e05e881edfa58fb5e40bb6263ae4c23d9` |
| `V8_empty_uuid_rows.csv` | 1,682,464 | `0670543f24eaa3aaa8dca3eee74a0bd510b3ee7b10cc09a2ffe3a3131eb54bce` | `3f4c5060315fbe8259417e84db6a5f51c59f7bbc` |
| `V8_ambiguous_uuid_rows.csv` | 144,973 | `2c4988702c42494a52c367464512c197fb272701ff04812b2fc2eb5d30a04474` | `ffd039920e93443b5fc7432ec3aeed7a819ecea2` |
| `V9_master_derivation_evidence.md` | 3,035 | `9ab1fadf1b041f40aac79de487a2895acfa455e24ce6be46d0ae3b854f499e9b` | `fdf9446ee581065db06e188f34aa59672ac5a06e` |
| `recheck_v73.py` | 3,167 | `9d20b13aecacfa8dc191822d26c3b209b4ba49fbefb6cdd1adab8738cdb4ed5e` | `fbdf3c7070382ac7ab55142f76f067ee0b0a90bf` |

## 六、v72_preservation / v71_preservation 其余工件

| 文件 | 字节 | 本地 SHA256（前 24） | GitHub blob SHA |
|---|---|---|---|
| `v72_preservation/MANIFEST_v72_补强核对.md` | 11,227 | `bf5471de275178bfa3b0921c` | `c00834956a469c2ecf784db154dfff9464f5f46b` |
| `v72_preservation/delta_17rows_full18_sha256.csv` | 6,447 | `f2575375c3ab7c1047d722fc` | `811907971fbffbcf4a8a06fb527c53bc535d94d6` |
| `v72_preservation/recheck_v72.py` | 2,490 | `154a2ca54df23d28f6574d51` | `fb92a2287306ed4b3940301a7c41f92af69f0ac3` |
| `v71_preservation/MANIFEST_前后核对_20261105.md` | 8,333 | `32b087048c9791ac1734499b` | `e69bcb610abffc14bba86974b10b2477185c4538` |
| `v71_preservation/frontfill_delta_20261105_2200.csv` | 4,006 | `6a8b266624cf06ae2becb388` | `bca266a06c1affa8f3d23bdb7ea2e6ce238ec489` |

## 七、历代正文与可编辑靶子（供逐格核对真实行号）

| 文件 | 字节 | 本地 SHA256（前 24） | GitHub blob SHA |
|---|---|---|---|
| `docs/v73_full_review_20261105.md` | 13,358 | `df9c74f48855615a3b8c910c` | `18f4eab779205796cdac5db820e5e4efaf034c00` |
| `docs/v72_full_review_20261105.md` | 10,875 | `cc0e44a841e547ce91e66d63` | `9dcc96c36e6f8e17564965fe253f2cd2c7130b68` |
| `docs/v71_full_review_20261105.md` | 16,948 | `52d8196cf51179e2ee1a41e1` | `2eaade1b440538c69c27c15f98f7bfa492ca88c5` |
| `docs/T1-B_大局系统还复_Tom可编辑_20261105.md` | 5,293 | `7ee0f580609f663e09851739` | `7aa2df7565916ea6815041b66483182c03c44b42` |
| `docs/T1-B_V1-V6_还复模板_Tom可直接编辑_20261104.md` | 8,567 | `a723554b83caf37441bfc44a` | `d989bafd1f04ab3ee676e44586024387a23c78c9` |

## 八、本轮两表与部署只读实证（2026-11-07 00:18 北京 / 11-06 16:18Z）

| 项 | 读数 | 来源 |
|---|---|---|
| 生产表 `DB_工时流水` | `lastRow=11336` / `lastCol=18` | hktool `inspectWorkbook`，`tools/probe_v59_live_state.py` |
| 主库「请假」 | `lastRow=605` / `lastCol=15` | 同上 |
| 主库页签 | **31 页**（11-05 定案分级清单为 29 页，本轮 +2 为每日重算快照页新增） | 同上 |
| `ts-manager` 部署数 | **3** | `projects.deployments` GET（只读） |
| deploymentId ① | `AKfycbwlxB2z9IDDo7pBv4sr0pu6-1ywvYBuRyqTwfjgl_o` | @HEAD |
| deploymentId ② | `AKfycbwYXV3VS3I59bVpUi9XBMClGsFkJ6l_NxPdQcysiXYe47-iONNMk6FIoI8VEXwYl-_2` | v202 |
| deploymentId ③ | `AKfycbzUyhyK-tqL7ypp2H2jZXNCMciEr2PJwhkZIg0bwV1OwV2C6D9RKJZhA4HpiUi6F5eF` | v197 |

三个 ID 与 v74 留底逐字节一致；**零部署新增、零链接变更**。原始回执：`evidence/v75_live_state_20261107.json`。

---

## 九、使用方式与边界

- 你方可用任意哈希工具对共享库任一文件做 `sha256sum` / `git hash-object` 比对，本登记册**不要求运行我方脚本**；`recheck_v72.py` / `recheck_v73.py` 仅登记存在与我方自检输出，不预设你方验收。
- 全部工件为只读产物，采集期间零生产写、零主库写、零部署、零链接变更。
- 登记册只固定「已留存的版本与字节」；**不声称 R1–R3 已完成、不声称 R4 将完成、不声称任何权限或业务授权已核验**。
- 事故状态：OPEN / HOLD-NO-GO / M2 未签 / 阶段一 PASS 暂缓 / 零生产操作边界，原样维持。

> 本件回应 Tom 05:52:52Z 回函的第一步要求；第二步（证据到齐后只读对照源码和公式链）仍由你方在 R1–R3 到齐后执行，我方不代做、不催。
