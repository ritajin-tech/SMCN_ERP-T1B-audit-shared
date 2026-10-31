# 复跑索引 · 工时表取证脚本（tools/timesheet_forensics/）

> 目的：响应 Tom 02:07Z「请提供可读取的固定提交源码及脱敏证据索引」「代码存在或自测结果不能代替独立验证」。
> 本目录 4 个脚本均为**只读、零凭据**（经 hktool `inspectWorkbook` / `readRange` 读表，不写、不改、不碰生产写入接口）。你可自行 clone 审计仓后复跑，输出与 `evidence/` 下已提交产物一致。

## 1. ts_l1l2_stratify.js
- **用途**：对生产表全量分层（EXACT / TIMEONLY / MIXED / EMPTY_POOL），产出可机器化软标的候选清单。
- **关键修正**：空 UUID 单独进 EMPTY_POOL，**绝不参与 UUID 冗余统计**（旧诊断 `diag_cleanup_20261101.js:135` 把空 UUID 聚成 `(EMPTY)` 单组，虚增 5,220 行，已被废除）。
- **运行**：`node ts_l1l2_stratify.js`（约 15 分钟，分页只读）
- **输出**：`evidence/l1l2_stratify_2026-10-31.json`（已提交）
- **关键字段**：`layers.EXACT{TIMEONLY,MIXED}.groups/extraRows/extraHours`、`emptyPool`、`alive/aliveHours`、`reconcile`（新旧口径对照）

## 2. ts_writelog_forensics.py
- **用途**：实拉 `_TS_WRITE_LOG` 全量，验证「能否逐行溯源」与 appendRows 批次。
- **关键发现**：日志 3 列（时间/动作/明细），明细只含汇总计数（`req=1519 wouldWrite=575 skipDup=944`），UUID 出现 0 次 → 无法逐行溯源（撤回「16 批次溯源」说法的来源）。
- **运行**：`python -X utf8 ts_writelog_forensics.py --dump`
- **输出**：`evidence/writelog_full_*.json`

## 3. ts_emptyuuid_trend.js
- **用途**：查近 N 天新增行的空 UUID 占比，验证「止血是否闭环 / 清理后是否长回」。
- **关键发现**：近 14 天新增 388 行，空 UUID **0 行（0%）** → 空 UUID 漏洞当前未触发，5,221 行空池为静态历史存量。
- **运行**：`node ts_emptyuuid_trend.js 14`
- **输出**：`evidence/emptyuuid_trend_2026-10-31.json`（已提交）

## 4. ts_unfreeze_gate.js
- **用途**：把 Rita 的「条件性授权」固化为可复跑硬闸门。**只判定、零写入、不改任何开关**；全部 BLOCKING 项 PASS 才 EXIT 0。
- **判定项**：A1 备份 / A2 分层清单 / A3 止血闭环 / A4 冻结状态 / M1 Tom 技术裁定 / M2 期锁 clearance / M3 Rita 授权。
- **运行**：`node ts_unfreeze_gate.js`
- **当前**：A1-A4 PASS，M1/M2 BLOCKED → **EXIT=1，不得解除**（Tom 02:07Z 仍维持 HOLD/NO-GO）。

## 复跑一致性承诺
上述脚本读的是生产表**同一快照窗口**（读前/读后各 probe，不一致整批作废）。你复跑得到的数字应与 `evidence/` 下已提交产物在快照窗口内一致；若不一致，以你本地读到的 live 为准，并请指出差异行——这正是独立验证要发现的。
