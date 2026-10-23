# SMCN_ERP-T1B-audit-shared

T1-B 工时对账审计共享材料（外部技术审阅只读通道）。本仓库只放**无 PII** 材料：合同/测试/fixture/方向文档/应用报告。全新历史，不含密钥、不含业务原始数据、不含登记表（含真实 UUID）、不含去标识冻结副本（自由文本未认证零 PII）——后两者走邮件通道。

## 目录

```
README.md                                  本文件
docs/
  T1B_调整方向与两天行动计划_20261023.md      本轮调整方向+两天计划+需拍板项（先读这个）
contract/
  T1B_主键契约与离线设计_v2p5.md              现行主键契约草案（PKC-v2p5，五议题默认建议，待确认）
  t1b_offline_fixture_v2p5.json              离线 fixture（姓名为 P-#### 假名受控样例）
  t1b_offline_test_v2p5.py                   离线测试（只读、零生产、无网络依赖）
  t1b_v2p5_manifest.json                     四件套 SHA 绑定 + dependencies
  build_fixture_v2p5.py                      fixture 生成脚本（供复现）
  T1B_主键契约与离线设计_v2p4.md              前一版主键契约（PKC-v2p4）
  t1b_offline_fixture_v2p4.json              前一版离线 fixture
  t1b_offline_test_v2p4.py                   前一版离线测试
  t1b_v2p4_manifest.json                     前一版四件套 SHA 绑定
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

python t1b_offline_test_v2p5.py
# 预期：A 段边界链常量全 OK；A2 段投影 8/8；B 段 15/15；C 段 53/53（含 P21-P24 软标记、N22 E1）；
#       D 段 manifest 七项绑定；F 段例数绑定（25+28=53+15+8）；EXIT=0

python t1b_offline_test_v2p4.py
# 预期：A 段边界链常量全 OK；B 段 15/15；C 段 48/48；D 段含 dependencies；F 段例数绑定；EXIT=0
```

无数据副本时 A 段会以 MISSING 退出（exit 2）——B/C/D/F 段需数据就位后运行。

## 版本链（勿混引）

| 版本 | 合同文档 SHA(16) | 状态 |
|---|---|---|
| PKC-v1 | — | 首版，已被取代 |
| v2 | 见邮件登记（724fef64 轮） | 4568 根因矩阵+规范 schema+边界链 |
| v2p2 | 见邮件登记（ad3788f0 轮） | 回应 16:33 六点 |
| v2p3 | 见邮件登记（9bd8bb74 轮） | 回应 17:33 两阻断项 |
| v2p4 | 9d5cf5fe | 回应 18:03 三项；已被 v2p5 草案取代 |
| **v2p5** | **a531fcf8** | 五议题默认建议草案（投影 P/E1/biz 口径/C2 软标记/两层口径）；**待 Tom D1 立场确认或反对后定稿** |

608 = v2 ≠ v2p2 ≠ v2p3 ≠ v2p4 ≠ v2p5（五份各自独立）；241 基准未锁定；前三个邮件轮次文件不重送。

## v2p5 交付物 SHA（2026-10-23）

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
- 应用报告为提交方只读运行产物，非复核方独立运行；复核方独立结论以自跑测试为准。
- 阶段一 PASS 暂缓；106 HOLD、历史 23 行、D241、HOLD/NO-GO、事故安全 OPEN 不变。
- 登记表（含真实 UUID）与去标识冻结副本走邮件通道，不入本仓库。
