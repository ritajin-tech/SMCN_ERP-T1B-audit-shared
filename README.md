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
  t1b_schema_registry_v2p6.json              19 档逐档 schema 登记（§0.10；真实 UUID 列已掩码）
  t1b_schema_registry_v2p6.py                登记表生成脚本（只读真算，EXIT=0；需冻结副本）
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
| **v2p6** | **9911615f** | 按 Tom 22:18 立场 + 22:17 边界 + 22:22 四项修订；**待 Tom 复核**；23:3x 补 §0.10 十九档 schema 登记（同版本内修订，非新轮次） |

PKC 版本链以 fixture `meta.rule_version` 为准：608 = v2 ≠ v2p2 ≠ v2p3 ≠ v2p4 ≠ v2p5 ≠ v2p6（六份各自独立）；241 基准未锁定。
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

### v2p6 §0.10 十九档 schema 登记要点（2026-10-23 23:3x 补做）

| 项 | 结果 |
|---|---|
| 19 档列宽分布（102723 行） | 全 9 列，**无列宽异构** |
| 行级 schema 路由 | 19 档全部 `project_P`；未知列宽行 0 |
| 错位 4568 行档级归属 | **100% 落在 20260831 单档**（占该档 12583 行的 36.3%）；其余 18 档均为 0 |
| 前两列空 3166 行三分解 | sid 空 2367 + AUTO_LEAVE 208 + 其余 591（= v2p4 口径 799 = 591 + 208） |
| 明确不主张 | 列宽一致 ≠ 字段语义一致；PJ10-PJ13 在本副本未触发属防御性覆盖；表头来源/源码身份仍**未持有、未核验** |

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
