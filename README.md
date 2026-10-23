# SMCN_ERP-T1B-audit-shared

T1-B 工时对账审计共享材料（外部技术审阅只读通道）。本仓库只放**无 PII** 材料：合同/测试/fixture/方向文档/应用报告。全新历史，不含密钥、不含业务原始数据、不含登记表（含真实 UUID）、不含去标识冻结副本（自由文本未认证零 PII）——后两者走邮件通道。

## 目录

```
README.md                                  本文件
docs/
  T1B_调整方向与两天行动计划_20261023.md      本轮调整方向+两天计划+需拍板项（先读这个）
contract/
  T1B_主键契约与离线设计_v2p6.md              现行主键契约（PKC-v2p6，按 Tom 22:18 立场修订，待复核）
  t1b_offline_fixture_v2p6.json              离线 fixture（姓名为 P-#### 假名受控样例）
  t1b_offline_test_v2p6.py                   离线测试（只读、零生产、无网络依赖）
  t1b_v2p6_manifest.json                     四件套 SHA 绑定 + dependencies + 换算表摘要
  T1B_v2p6_差异矩阵_20261023.md               v2p5 默认建议 vs Tom 22:18 立场 vs v2p6 采纳 逐条对照
  t1b_layer_conversion_v2p6.json             T4 互斥完备换算表（archives 同一冻结定位 L0-L4，只读真算）
  t1b_layer_conversion_v2p6.py               换算表脚本（EXIT=0 = 提交方自洽）
  build_fixture_v2p6.py                      fixture 生成脚本（供复现）
  t1b_schema_registry_v2p6.json              19 档逐档 schema 登记（§0.10；真实 UUID 列已掩码）【已下架，转邮件通道】
  t1b_schema_registry_v2p6.py                登记表生成脚本（只读真算，EXIT=0；需冻结副本）
  T1B_主键契约与离线设计_v2p7.md              PKC-v2p7 现行主键契约（按 Tom 23:58 合并审核五点+源级/隐私边界修订；待复核）
  t1b_offline_fixture_v2p7.json              离线 fixture（23 正+34 负=57；state 17；projection 15）
  t1b_offline_test_v2p7.py                   离线测试（只读、零生产、无网络依赖；canon_date 单一实现）
  t1b_v2p7_manifest.json                     十一件套 SHA 绑定 + dependencies + 换算表摘要 + 必需集合
  T1B_v2p7_差异矩阵_20261024.md              Tom 23:58 立场 → v2p7 采纳 逐条对照
  t1b_layer_conversion_v2p7.json             T4 互斥完备换算表（v2p7 口径）
  t1b_layer_conversion_v2p7.py               换算表脚本（EXIT=0）
  build_fixture_v2p7.py                      fixture 生成脚本（供复现）
  t1b_schema_registry_v2p7.py                登记表生成脚本（只读真算，EXIT=0；**不输出首行逐列值**）
  t1b_schema_registry_v2p7.json             19 档逐档 schema 登记（仅列宽+字节摘要；五形态互斥完备）
  t1b_canon_date_v2p7.py                     日期规范化单一实现（三产物统一 import；补时间分量范围校验）
  T1B_主键契约与离线设计_v2p5.md              v2p5 草案（默认建议版；T1 硬口径已被 v2p6 按 Tom 立场撤回）
  t1b_offline_fixture_v2p5.json              v2p5 草案 fixture
  t1b_offline_test_v2p5.py                   v2p5 草案测试
  t1b_v2p5_manifest.json                     v2p5 草案 manifest
  T1B_主键契约与离线设计_v2p4.md              v2p4 合同（Tom 22:17 已确认三项整改关闭）
  t1b_offline_fixture_v2p4.json              v2p4 fixture
  t1b_offline_test_v2p4.py                   v2p4 测试
  t1b_v2p4_manifest.json                     v2p4 manifest
  apply_pkc_to_real_data_v2p4.py             真实数据应用脚本（只读；提交方运行，v2p4 口径）
  t1b_real_data_application_20261023.json    应用报告（纯计数，无行级数据）
```

## 试跑（Tom 的 AI 可自跑，只读、零生产）

```bash
git clone https://github.com/ritajin-tech/SMCN_ERP-T1B-audit-shared
cd SMCN_ERP-T1B-audit-shared/contract

# 完整运行需去标识冻结副本（随邮件分发，不入公开仓库）：
#   解压 t1b_scrub_package_20261014.zip 到本目录的同级目录 20261014_frozen_scrubbed/
#   副本自洽校验：python offline_recompute_scrubbed.py  -> EXIT=0（10 项聚合复现）

python t1b_offline_test_v2p6.py
# 预期：A 段边界链常量全 OK；A2a 投影字面 13/13 + A2b 投影后路由 13/13；B 段 15/15；
#       B2 三条实现边界登记；C 段 57/57（含 P21/P22 移入负例、N22 E1、N23/N23b 坐标诊断、
#       N24/N24b 阶段差异折叠）；C2 并列测量层 + 投影折叠差异诊断；
#       D 段严格验收（manifest 四件 + supporting 四件 + 依赖全绑定，缺即 FAIL）；
#       F 段例数绑定（25+32=57+15+13）；EXIT=0

python t1b_layer_conversion_v2p6.py
# 预期：L0-L4 全链真算 + 互斥完备断言（L1/L2 各类和=102723；L4 链式恒等）；EXIT=0

python t1b_schema_registry_v2p6.py
# 预期：19 档列宽分布全 9、错位 4568 行 100% 归 20260831 档、前两列空 3166 三分解；EXIT=0

# ---- v2p7（按 Tom 23:58 合并审核五点 + 源级/隐私边界修订；2026-10-24）----
python t1b_offline_test_v2p7.py
# 预期：A 段边界链常量全 OK；A2a 投影字面 15/15 + A2b 投影后路由 15/15；B 段 17/17；
#       B2 边界②断言 E1-correct-v1d==idempotent 且 v1f==rejected；
#       C 段 57/57（含 N24/N24b 改 source_conflict 负例、PJ14/PJ15、v1d/v1f）；
#       C2 测量层 normalized_view_equal（不宣称原行相等）；
#       D 段严格验收（4+7+1 固定必需集合 + live 字节比对 + 三类负向自检全 OK）；
#       F 段例数绑定（23+34=57+17+15）；EXIT=0（需 CSV 就位，否则 D 段判 FAIL）

python t1b_layer_conversion_v2p7.py
# 预期：L0-L4 全链真算 + 互斥完备断言；L3 测量层 duplicate_entry 3084 组 12322 行 + normalized_view_equal 3 组 6 行；EXIT=0

python t1b_schema_registry_v2p7.py
# 预期：19 档列宽全 9、错位 4568 行 100% 归 20260831；五形态互斥完备（normal 91844/collapse 4568/auto_leave 3353/blank2_sid_empty 2367/blank2_sid_present 591）；**不输出首行逐列值**；EXIT=0

python t1b_offline_test_v2p5.py   # 草案版（G1 硬口径为 biz，已被 v2p6 撤回）EXIT=0
python t1b_offline_test_v2p4.py   # 前版 EXIT=0
```

无数据副本时 A 段会以 MISSING 退出（exit 2）——B/C/D/F 段需数据就位后运行。

## 版本链（勿混引）

| 版本 | 合同文档 SHA(16) | 状态 |
|---|---|---|
| PKC-v1 | — | 首版，已被取代 |
| v2 | 见邮件登记 | 4568 根因矩阵+规范 schema+边界链 |
| v2p2 | 见邮件登记 | 回应 16:33 六点 |
| v2p3 | 见邮件登记 | 回应 17:33 两阻断项 |
| v2p4 | 9d5cf5fe | 回应 18:03 三项；Tom 22:17 确认三项整改关闭 |
| v2p5 | a531fcf8 | 五议题默认建议草案；T1 硬口径已被 v2p6 按 Tom 立场撤回 |
| **v2p6** | **9911615f** | 按 Tom 22:18 立场 + 22:17 边界 + 22:22 四项修订；23:3x 补 §0.10 十九档 schema 登记（同版本内修订，非新轮次）；v2p6 registry json 已下架本仓库、转邮件通道 |
| **v2p7** | **e36942e8** | 按 Tom 23:58「v2p6 合并审核」五点 + 源级/隐私边界修订；**待 Tom 复核**；非新轮次，是 v2p6 同版本内二次修订 |

PKC 版本链以 fixture `meta.rule_version` 为准：608 = v2 ≠ v2p2 ≠ v2p3 ≠ v2p4 ≠ v2p5 ≠ v2p6 ≠ v2p7（七份各自独立）；241 基准未锁定。
**版本指纹说明（Tom 22:18 修正）**：`724fef64` / `ad3788f0` / `9bd8bb74` 为此前**冻结/对账材料指纹**，非 PKC 测试版本轮次，勿与版本链串线。

## v2p6 交付物 SHA（2026-10-23）

| 文件 | SHA-256(16) | 字节 |
|---|---|---|
| T1B_主键契约与离线设计_v2p6.md | 9911615f | 25937 |
| t1b_offline_fixture_v2p6.json | 20b9a6b5 | 62090 |
| t1b_offline_test_v2p6.py | e56a0035 | 34898 |
| t1b_v2p6_manifest.json | 26913565 | 7210 |
| T1B_v2p6_差异矩阵_20261023.md | 81c836f0 | 11068 |
| t1b_layer_conversion_v2p6.json | e4c6494c | 2526 |
| t1b_layer_conversion_v2p6.py | e5863e93 | 10528 |
| build_fixture_v2p6.py | 8c8a60aa | 17639 |
| t1b_schema_registry_v2p6.json | c0bb162e | 21529 |
| t1b_schema_registry_v2p6.py | 1751bb92 | 9919 |

> 严格验收模式（Tom 22:22）：`python t1b_offline_test_v2p6.py` 在缺 manifest / 缺依赖 / 缺交付物时**判 FAIL**（EXIT≠0），不输出同一验收 PASS；EXIT=0 才同时证明外部绑定完整。
> 注：`t1b_key_registry_v2p3.csv`（含真实 UUID，manifest `deliverables`）与去标识冻结副本**走邮件通道**，不在本仓库；仅用本仓库文件跑 D 段会因缺少该件而判 FAIL（严格模式的预期行为），完整绑定需邮件通道件就位。
> **v2p6 registry json 下架说明（2026-10-24）**：`t1b_schema_registry_v2p6.json`（含真实 UUID 列，仅掩码前 8 位）已**移出公开仓库**（`git rm`），转邮件通道分发；v2p7 起登记表改为仅输出列宽+字节摘要、不输出首行逐列值，故 v2p7 registry json 仍留仓库。

### v2p6 §0.10 十九档 schema 登记要点（2026-10-23 23:3x 补做）

| 项 | 结果 |
|---|---|
| 19 档列宽分布（102723 行） | 全 9 列，**无列宽异构** |
| 行级 schema 路由 | 19 档全部 `project_P`；未知列宽行 0 |
| 错位 4568 行档级归属 | **100% 落在 20260831 单档**（占该档 12583 行的 36.3%）；其余 18 档均为 0 |
| 前两列空 3166 行三分解 | sid 空 2367 + AUTO_LEAVE 208 + 其余 591（= v2p4 口径 799 = 591 + 208） |
| 明确不主张 | 列宽一致 ≠ 字段语义一致；PJ10-PJ13 在本副本未触发属防御性覆盖；表头来源/源码身份仍**未持有、未核验** |

## v2p7 交付物 SHA（2026-10-24，按 Tom 23:58 合并审核五点 + 源级/隐私边界修订）

| 文件 | SHA-256(16) | 字节 |
|---|---|---|
| T1B_主键契约与离线设计_v2p7.md | e36942e8 | 33501 |
| t1b_offline_fixture_v2p7.json | fc7f452f | 63551 |
| t1b_offline_test_v2p7.py | 5390c494 | 43271 |
| t1b_v2p7_manifest.json | 2f443f7b | 6538 |
| T1B_v2p7_差异矩阵_20261024.md | 266e60d8 | 5934 |
| t1b_layer_conversion_v2p7.json | faef30cf | 2538 |
| t1b_layer_conversion_v2p7.py | 04bfa490 | 10834 |
| build_fixture_v2p7.py | 45c3d24c | 15048 |
| t1b_schema_registry_v2p7.json | 77d49fc7 | 18693 |
| t1b_schema_registry_v2p7.py | 865050f5 | 11645 |
| t1b_canon_date_v2p7.py | b1292cf4 | 2934 |

> 严格验收模式（Tom 22:22 延续）：`python t1b_offline_test_v2p7.py` 在缺 manifest / 缺依赖 / 缺交付物时**判 FAIL**（EXIT≠0）。完整绑定需邮件通道件就位：`t1b_key_registry_v2p3.csv`（SHA 62d463ce，含真实 UUID）、去标识冻结副本 `archives_scrubbed.json` / `live_scrubbed.json`（及依赖 `offline_recompute_scrubbed.py`）置 `20261014_frozen_scrubbed/` 后跑；仅用本仓库 11 件文件跑 D 段会因缺少 CSV 而判 FAIL（严格模式预期行为，EXIT=0 需 CSV 就位）。
> 提交方本地已带齐全套跑通：**EXIT=0**（23 正 + 34 负 = 57；state 17；projection 15；D 段固定必需集合 4+7+1 + live 字节比对 + 三类负向自检全 OK；覆盖矩阵 11 implemented / 5 doc_only / 2 uncovered）。

### v2p7 §0.11 逐条回应 Tom 23:58「v2p6 合并审核」

| # | Tom 立场 | v2p7 采纳 |
|---|---|---|
| 一 | 原行 full 与规范视图 full 须分名；N24/N24b 原行阶段不同却断言 normal/ok | ✅ `payload_of`→`normalized_view_full`（规范视图）；新增 `source_full`（原行摘要）；硬判定加原行差异：规范视图相同但原行不同→`isolated/source_conflict`；N24/N24b 改负例 |
| 二 | 同一版本日期规则不一致 | ✅ 抽 `t1b_canon_date_v2p7.py` 单一实现（三产物统一 import）；补时间分量范围校验（HH≤23/MM≤59/SS≤59；PJ14 99:99→illegal_calendar、PJ15 23:59:59 截断） |
| 三 | 严格绑定非完整必需集合 | ✅ D 段固定必需条目集合（4 deliverables + 7 supporting + 1 依赖）+ live 字节比对 + 三类负向自检（删清单键/删 supporting/替换 live SHA 均判 FAIL） |
| 四 | accepted tag 边界文字与实现差异 | ✅ 前驱按稳定版本坐标 `(se,rv,ns,ver)` 绑定 + 别名规范化：v1d→`idempotent`、新增 v1f（异身份前驱）→`rejected`；文字二选一并写清 |
| 五 | 文字混版（"四件未变"与哈希矛盾） | ✅ §0.10 修正（23 正+34 负=57 / state 17 / projection 15）；合同与 manifest 修订、fixture/test 沿用 CSV 见下；覆盖矩阵残留 55/8/旧 biz 硬放行已清 |
| 六（源级/隐私） | 档名日期非采集时刻；"2937 均真实 GUID"自相矛盾；登记 JSON 含首行业务自由文本 | ✅ §0.10 改"副本内嵌标签"非采集时刻；20260831 五形态分别称谓；登记 JSON 不再输出首行逐列值，仅列宽+字节摘要 |

> 不主张边界：逻辑来源提取规则（候选非唯一身份）、业务字段清单裁定（source_conflict 最终裁决）、Rita 拍板项（982/7/233、D241、主库启用、公开范围）——均待拍板，v2p7 不预占。

## v2p5 草案交付物 SHA（2026-10-23）

| 文件 | SHA-256(16) | 字节 |
|---|---|---|
| T1B_主键契约与离线设计_v2p5.md | a531fcf8 | 15632 |
| t1b_offline_fixture_v2p5.json | 4b3f666b | 50938 |
| t1b_offline_test_v2p5.py | f093f346 | 26442 |
| t1b_v2p5_manifest.json | f2a3ab8f | 2945 |
| build_fixture_v2p5.py | ea17b007 | 13735 |

## v2p4 交付物 SHA（2026-10-23）

| 文件 | SHA-256(16) | 字节 |
|---|---|---|
| T1B_主键契约与离线设计_v2p4.md | 9d5cf5fe | 10763 |
| t1b_offline_fixture_v2p4.json | bebca9fc | 39737 |
| t1b_offline_test_v2p4.py | 27583faa | 21537 |
| t1b_v2p4_manifest.json | 4c9c5914 | 2066 |
| apply_pkc_to_real_data_v2p4.py | fbdc4e96 | 19910 |
| t1b_real_data_application_20261023.json | 1bac00d8 | 8232 |

## 边界与纪律

- 零生产操作、零新增授权、不索取生产权限；本仓库所有脚本均为只读。
- 应用报告与换算表为提交方只读运行产物，非复核方独立运行；复核方独立结论以自跑测试为准。
- EXIT=0 = 提交方断言自洽，非 Tom 独立运行/非全部契约验收；阶段一 PASS 暂缓。
- 106 HOLD、历史 23 行、D241、HOLD/NO-GO、事故安全 OPEN 不变。
- 不为完成时间表开启生产校验、补键、迁移、去重或修复写入（Tom 22:18）。
- 登记表（含真实 UUID）与去标识冻结副本走邮件通道，不入本仓库。
