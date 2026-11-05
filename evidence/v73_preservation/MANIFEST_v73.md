# MANIFEST · v73 补强核对工件清单（2026-11-05 23:1x 北京）

> 性质：回应 Tom 14:58:41Z《回复：【生产表】v72补强核验进度》的三项实质审阅条件（V7/V8/V9）。
> 全部工件为**只读计算产物**；零生产写、零主库写、零部署、零链接变更、零解冻、零自动回滚。

## 一、工件清单（字节 / SHA256）

| 工件 | 字节 | SHA256 | 用途 |
|---|---|---|---|
| `V7_AB_delta_row_by_row.csv` | 294,206 | `e4b85aeaa85285077aa6e17e595d80061c2247b59a850acf32620998a2b7060f` | V7 逐行归因：1987 行 A/B 改写，含 S1/S2 原值、归因分类 |
| `V7_repairAB_log_coverage.md` | 7,397 | `fdc4a06b7811502d107fa75c46f9db1574652fb670bc32f3767903e2aecdb3c0` | V7 日志覆盖区间：57 条逐条（表内行号 / UTC / 北京 / 动作 / 明细） |
| `V7_scope_matrix.md` | 3,676 | `0e3eef986aef68ff0ff4c07c6c810b1c986c422d9d35eae848d346cb9acce95c` | V7 五种参数固定 + 四种匹配规则矩阵 + 日志覆盖区间拆分 + 901/898 不可复现结论 |
| `V8_ambiguous_uuid_rows.csv` | 144,973 | `2c4988702c42494a52c367464512c197fb272701ff04812b2fc2eb5d30a04474` | V8 无法唯一匹配的 1781 个键单独列示（含三快照表内行号） |
| `V8_empty_uuid_rows.csv` | 1,682,464 | `0670543f24eaa3aaa8dca3eee74a0bd510b3ee7b10cc09a2ffe3a3131eb54bce` | V8 空 UUID 逐行列示（S1/S2/S3 各 5208 行） |
| `V8_uuid_by_original_value.md` | 2,835 | `0e65a9b10fbba94d0f7aa9f0b147bc5970b03a49820f32d533b814e6d1a112d3` | V8 四类键按原值分组统计（修正 v72「两种格式」误述） |
| `V9_master_derivation_evidence.md` | 3,035 | `9ab1fadf1b041f40aac79de487a2895acfa455e24ce6be46d0ae3b854f499e9b` | V9 主库派生链与权限证据清单（原样接受 Tom 表述，UNKNOWN 项显式标注） |
| `recheck_v73.py` | 3,167 | `9d20b13aecacfa8dc191822d26c3b209b4ba49fbefb6cdd1adab8738cdb4ed5e` | 独立复算脚本（只读；我方已实跑通过；不要求 Tom 运行） |

## 二、固定原始字节（与 v72_preservation 同源，供逐字节核对）

- S1 `S1_raw_prod_20261104_0835.csv` 2,388,420 B / `4a4d8e190b54bcb8e01e8ac822097ed9a2fb0a1420a60a8842b25eebbd9b7f4d`
- S2 `S2_raw_prod_20261105_0838.csv` 2,399,171 B / `360c5c1a9c21ffcc1d4e238459ebaf365a03326a8841030d4a3365a4581790d3`
- S3 `_raw_prod_full_20261105_2200.json`（v71_preservation）

## 三、我方实跑输出（recheck_v73.py，仅自检用；不要求你方运行、不预设验收）

```
S1 sha256 4a4d8e190b54bcb8e01e8ac822097ed9a2fb0a1420a60a8842b25eebbd9b7f4d
S2 sha256 360c5c1a9c21ffcc1d4e238459ebaf365a03326a8841030d4a3365a4581790d3
真实行 S1=11224 S2=11264 S3=11281  空占位 S1=14 S2=14 S3=38
R1 行位置  A=4133 B=4119
R2 UUID键 共同=4292 A=1987 B=1974
R3 键+序号  A=2520 B=2509
R4 全18列差集 仅S1=4203 仅S2=4243
S2->S3 全18列 仅S2=0 仅S3=17
S1 空=5208 格式={'36-GUID': 680, 'TS-RESTORE-*': 1102, 'TS-12HEX': 4178, 'TS-R0907-TS-*': 56} 重复键=1724 额外行=1724
S2 空=5208 格式={'36-GUID': 680, 'TS-RESTORE-*': 1102, 'TS-12HEX': 4218, 'TS-R0907-TS-*': 56} 重复键=1724 额外行=1724
S3 空=5208 格式={'36-GUID': 680, 'TS-RESTORE-*': 1102, 'TS-12HEX': 4235, 'TS-R0907-TS-*': 56} 重复键=1724 额外行=1724
```

## 四、口径与边界

- 所有统计**按 UUID 原值精确匹配**，未做任何归一、去空格、格式转换或丢弃。
- 空 UUID 行不参与键匹配，保留原状。
- 我方不代裁 V7 应采哪一组数字、不代定 V8 键策略、不代签 V9 授权；三者仍待你方逐格落笔。
- 本件不构成生产授权，不改变任何一方独立核验立场。
