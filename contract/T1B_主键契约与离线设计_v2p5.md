# T1-B 主键契约与离线设计（v2p5）

> v2p5 是**五议题默认建议草案**：把 2026-10-23 方向信（20:52 发出）中 T1-T5 的默认建议落地为可执行契约变更，逐条附实证与代价，待 Tom D1 立场确认或反对后定稿。
> 本文件为**局部差异说明**（相对 v2p4），不是全量重交付；不碰生产、不触发任何写操作、不预授权。
> 本测试结果为**提交方报告**，非 Tom 独立运行，亦非全部契约验收。
> v2p4 已关闭项（UPSERT 冲突不覆写、CORRECT 更正链+重放前序绑定、硬失败先行+不动点传播、完整快照坐标、分页边界、normal reason、登记列名/未判/工时/权限表述）不重开。
> 业务裁定（982 占位 / 7 空日期 / 233 请假）仍待有权方。

---

## 0. 本轮范围：五议题默认建议（T1-T5）

### 0.1 T1：G1 payload 口径 — 默认 biz（剔除提交时间）+ duplicate_entry 软标记

**实证**（三侧真实数据，投影 P 后、v2p4 测试字面 full 口径）：同 `(ns,snap,sid)` 多例且 full payload 不同的组/行数——archives 3099 组/20246 行、live 46 组/96 行、prod 234 组/468 行；改 biz 口径后 archives 15 组/7924 行、live 1 组/2 行、prod 10 组/20 行。**差量主体是「同一事件重复录入」**：20260824 档同 LEAVE- 事件重复 4-5 次仅录入时间不同；334 个不同请假事件共享常量 UUID `AUTO_LEAVE`。

**v2p5 契约变更**：
- G1 硬失败判据改 **biz 口径**：payload 剔除提交时间（`row[0]`），仅业务内容不同才 `same_key_diff_content`。
- **新增软标记 `duplicate_entry`**（C2 段）：同键 ≥2 行仍 `normal/ok` 且 biz 相同、full 不同（仅提交时间不同）→ 软标记，不改变 isolated/normal 硬判定，聚合层 first-seen 去重。
- **fixture 钉死**：P21/P22（同键同业务仅 ts 不同 → `duplicate_entry`；v2p4 full 口径会误判 `same_key_diff_content`）。v2p4 fixture 未构造仅-ts-不同用例，该口径此前由定义继承、未经用例钉死——v2p5 补齐。

**代价（若 Tom 反对 biz 口径）**：回到 full 口径则 archives 20246 行同键行的主体全部升级为 `same_key_diff_content` 硬隔离，需先由业务裁定「重复录入算不算内容冲突」；提交方默认「不算」（录入时间是系统行为，不是业务内容差异）。

### 0.2 T2：精确重复 — 默认软标记 exact_duplicate + first-seen 去重

**实证**：prod 同键同内容（full 口径全同）1778 组中 1544 组为全同；live/archives 亦存在同类。

**v2p5 契约变更**：
- **新增软标记 `exact_duplicate`**（C2 段）：同键 ≥2 行仍 `normal/ok` 且 full 全同（含提交时间）→ 软标记；聚合层 first-seen 去重（首见行计入，其余仅登记）。
- **fixture 钉死**：P23/P24（全同 → `exact_duplicate`）。

**代价（若 Tom 要求硬隔离）**：prod 1544 组中的后见行全部 `isolated`，prod 单例 ok 计数 5802 将下降；提交方默认「软标记+去重」而非硬隔离——精确重复是数据产生过程问题（重复录入/重复同步），不是单行内容缺陷，硬隔离会把「一行合法数据」判死。

### 0.3 T3：E1 扩展伪键 — 默认纳入 AUTO_LEAVE

**实证**：UUID 位为常量标签 `AUTO_LEAVE` 的行：archives 3353 + live 1 + prod 2（应用报告 E1 extra 段）。

**v2p5 契约变更**：伪键判据由单常量 `"OFF-WORK / Leave"` 扩展为常量集合 `PSEUDO_CONSTANTS = {"OFF-WORK / Leave", "AUTO_LEAVE"}`——UUID 位是常量标签而非真实记录 ID 的行，一律 `pseudo_uuid_collapse`（不构成稳定身份键）。
- **fixture 钉死**：N22（`AUTO_LEAVE` → `pseudo_uuid_collapse`）。

**代价（计数变化预告）**：若采纳 v2p5 口径，三侧应用计数中 archives ok 52013、live ok 4219、prod ok 5802 将分别减少约 3353/1/2（这些行在 v2p4 口径下因日期/工时有效被判 ok）。这是**口径收紧**，不是数据变化。

### 0.4 T4：契约视图 vs 合并层口径 — 默认分层声明，禁混用

**实证**：空 UUID 行三侧合计 55464（archives 45343 + live 3931 + prod 6190，其中 prod 6190 = empty_required_key 5208 + placeholder 982）。

**v2p5 契约声明**：
- **契约层**（本 fixture/测试）：`source_record_id` = 真实数据 UUID 位列**原值**；原值为空 → `empty_required_key`（fixture N3 字面）。
- **合并层**（`offline_recompute_scrubbed.py` 的 `key_of` 回退键）：另一套口径（空 UUID 时按日期+姓名+类型等回退构造合并键），服务跨档合并去重，**不属于契约视图**。
- 两套口径分层禁混用：契约层分类不读合并层键；合并层统计（union 16766 等 A 段常量）不解释为契约层 sid 语义。

### 0.5 T5：G2/G3 真实数据建模 — 默认先定义 logical_source 提取规则

**现状**：fixture 的 G2/G3 用例（logical_source_id + mapping_basis）是**构造字段**；三侧真实数据均无 `logical_source_id` / `mapping_basis` 列，G2/G3 目前**无法在真实数据上执行**。

**v2p5 默认动作**：先由双方约定真实数据的 `logical_source` 提取规则（候选：按 `项目编号+姓名+日期` 归并，或按 BD/PM 台账的项目外键），再跑真实数据 G2/G3；在提取规则共识前，G2/G3 仅保持 fixture 级断言，不外宣称真实数据覆盖。**这是待 Tom/业务方输入项，不预设结论。**

---

## 1. 投影规则 P（正式条款；正面回应 Tom v2p3 阻断项「C 段映射放行」）

**契约规范视图（9 列）**：
```
[0]提交时间 [1]日期 [2]姓名 [3]类型 [4]项目 [5]工时 [6]备注 [7]请假标识 [8]UUID
```

**真实数据布局（前 9 列三侧同构）**：
```
[0]录入时间 [1]日期 [2]姓名 [3]类型 [4]阶段 [5]项目编号 [6]工时 [7]备注 [8]UUID
```
prod C 与 live 为 15 列（col9 起为自动列：客户/PM/供应商/状态/年月等，**不进规范视图**）；archives 为 9 列。

**投影规则 P**（真实行 → 规范行）：
```
P[0] = real[0]                                   # 提交时间原值
P[1] = canon_date(real[1])                       # 日期规范化
P[2] = real[2]                                   # 姓名
P[3] = real[3]                                   # 类型
P[4] = real[5]                                   # 项目编号（阶段列 real[4] 不进规范视图）
P[5] = real[6]                                   # 工时
P[6] = real[7]                                   # 备注
P[7] = "LEAVE" if (real[4]=="休假" or real[5].upper()=="OFF-WORK") else ""   # 请假标识派生
P[8] = real[8]                                   # UUID 原值
```

**日期规范化 canon_date**：`YYYY-MM-DD` 原样；`YYYY-MM-DD[ T]...` 截断日期部分（实证 archives 18327 + prod 4729 + live 4383 行）；US `M/D/YYYY` → ISO（实证：首分量 1-12、次分量 1-31、5884 行次分量>12 → M/D/Y，archives 9605 行）；**不存在的日期原样保留**，交 `illegal_calendar`（格式问题与历法问题分离）。

**证据链**：① prod C 原始表头 15 列逐列语义确认（`prod_DB_工时流水_20261015_2325.json`）；② live/archives 前 9 列与 prod 同构（首行逐列比对）；③ fixture meta `normalized_sample_schema` 声明；④ v2 文档 §3「不冒称原 C 布局即规范」。

**fixture 钉死（A2 段，PJ1-PJ8）**：PJ1 prod 常规行（阶段列/自动列丢弃）；PJ2 ISO+time 截断；PJ3 US M/D/Y；PJ4 LEAVE- 行（UUID 位为真实记录 ID → 正常路由；请假标识派生）；PJ5 mangled 伪行（备注位=真实 recordId、UUID 位=常量标签；请假标识两条件均不满足故空——该行由 pseudo 规则隔离不经 leave 路由）；PJ6 AUTO_LEAVE 行（UUID 位常量 → E1；请假标识由阶段=='休假' 派生）；PJ7 US 格式但日期不存在 → 原样保留；PJ8 live 15 列同构投影。

**真实数据应用互证**（`apply_pkc_to_real_data_v2p4.py`，v2p4 口径全量）：archives single {ok 52013, empty_required_key 45343, empty_date 799, pseudo 4568}；live {ok 4219, empty_required_key 3931, empty_date 7}；prod {ok 5802, empty_required_key 5208, empty_date 7, placeholder 982}；G1 full {archives 3099 组/20246 行, live 46/96, prod 234/468}；biz {archives 15 组/7924 行, live 1/2, prod 10/20}；prod dup_structure {1778 组 = 234 异内容 + 1544 同内容}；交叉验证 7/7 通过（prod 空 UUID 6190=5208+982；prod 空日期 989=7+982；prod 非法日历 0=0；prod 重复键 1778=1778；live 3931=3931；live 空日期 7=7；archives 空日期 3166=799+2367）。

> 注：应用报告为 v2p4 口径（PSEUDO_CONSTANTS 仅含 `OFF-WORK / Leave`）；若 T3 默认建议被采纳，archives/live/prod 的 ok 计数按 §0.3 代价段下调，pseudo 计数相应上调。应用脚本的 v2p5 口径重跑列为定稿后动作（依赖 Tom 对五议题的立场）。

---

## 2. 幂等状态模型（B 段，v2p5 沿用 v2p4，无变更）

```
identity_key = json.dumps({se, op, rv, ns, ver}, sort_keys=True, ensure_ascii=False)
# UPSERT ver=0 基版；CORRECT ver>=1 更正版本（支持多更正版本链）
state[key] = {digest, predecessor, version}   # 仅 created / 合法 versioned 提交
accepted[tag] = {key, se, ns, rv, ver, digest}  # 已接受记录（含幂等重放登记）

UPSERT 新键            -> created（提交）
UPSERT 同键同摘要       -> idempotent（保持；登记重放 tag 指向同一状态）
UPSERT 同键异摘要       -> conflict（保持，不覆写）
CORRECT 前序无效        -> rejected（不写状态）  # 无前序/假前序/链断裂(pred.ver != ver-1)/se-ns-rv 不一致
CORRECT 新键 + 前序有效 -> versioned（提交，绑定 predecessor+version）
CORRECT 同键 + 同摘要 + 同前序 -> idempotent（重放一致性）
CORRECT 同键 + 异摘要或异前序 -> conflict（保持）
```
禁止实现读取 expected 计算 got。15 例覆盖与 v2p4 相同（E1-upsert-1..4、E1-correct-v1-0/-0b/-fake/-1/-1b/-1c/-1d/-1e/-2/-2b/-2c）。

## 3. 回归边界（A 段，v2p5 沿用，无变更）

union=16766；leave_exclusion=5084 → after_excl=11682；special_key `U:OFF-WORK / Leave` 在 after_excl、在 final(11681) 外。
两独立集合有限可解析工时分别求和 = 均 46028.0；`non_finite_in_after_excl=1`、`non_finite_in_final=0`。
**有限可解析合计口径**：非法/非数值不计入，不称工时 0，非完整业务总工时。
first_seen_19 为逐档**首次新增键数**向量（非各档首次行号），和=16766。
合并层边界数学链：union 16766 − leave_exclusion 5084 = after_excl 11682 − special_key 1 = final 11681；collapse_4568；first_srow 8018。

## 4. 关系约束（C 段，v2p5：G1 改 biz 口径 + C2 重复软标记）

- **执行序**：单例硬失败 → **G1（biz 口径）** → 分页（G4）→ 关系（G2/G3）不动点传播至稳定 → **C2 重复软标记**。
- **快照坐标 = (namespace, snapshot_id)**；同坐标多例同 logical_source → `logical_source_duplicate_in_snapshot`。
- **G1（biz 口径）**：同 `(ns,snap,sid)` 多例且 **biz payload**（剔除提交时间）不同 → `same_key_diff_content`（空 sid 不计入；不同完整坐标的同 sid 不误冲突）。
- **C2 重复软标记**（T1/T2 默认建议）：同 `(ns,snap,sid)` 组内 ≥2 行仍 `normal/ok`：
  - full 口径全同（含提交时间）→ `exact_duplicate`；
  - 仅提交时间不同 → `duplicate_entry`。
  - 软标记**不改变** isolated/normal 硬判定，不覆盖关系段 reason（cross_side/cross_snapshot/pagination 等）；聚合层按 first-seen 去重。
- **G2 跨侧**（≥2 顶层 namespace）：共享 sid → `cross_side_stable_ok_shared_guid`；异 sid 须有效结构化映射（目标按完整坐标定位）→ `cross_side_stable_ok_valid_mapping`；缺失/非结构化/目标失配/目标已隔离分层隔离。
- **G3 同侧跨快照**（完整坐标不同）：共享 sid → `cross_snapshot_stable_ok_shared_guid`；异 sid 须有效映射 → `cross_snapshot_stable_ok_valid_mapping`。
- **传播**：映射目标被隔离 → 本方隔离；不动点迭代至无新增隔离；关系只增不减。
- **G4 分页**：完整 / 缺段 / 重叠 / 截断 + 越界 / 倒序·空区间 / 异常格式显式失败。

## 5. 两层口径（T4 分层声明）

| 层 | sid 语义 | 空 UUID 处理 | 服务对象 |
|---|---|---|---|
| 契约层（本 fixture/测试） | UUID 位列原值 | `empty_required_key`（N3 字面） | 单行身份与分类 |
| 合并层（`offline_recompute_scrubbed.key_of`） | 回退键（空 UUID 时按日期+姓名+类型等构造） | 回退构造合并键 | 跨档合并去重（A 段常量） |

两套口径分层禁混用（见 §0.4）。

## 6. 覆盖矩阵（准确登记）

- **已实现并断言**：A 段回归 + first_seen_19 向量 + 非有限计数 + special + 有限可解析工时口径；B 段 state 模型 15 例（ver 更正链 + 重放同前序，无回声）；**A2 投影规则 P 8 例（PJ1-PJ8）**；C 段硬失败先行 + 不动点传播 + 完整坐标 + 映射结构化校验；**G1 biz 口径**；**C2 重复软标记（P21-P24）**；**E1 扩展伪键（N22）**；分页四态 + 边界；normal reason 断言；**example_counts 实际例数绑定（25+28=53+15+8）+ 运行报告 SHA**；manifest 绑定（含 dependencies）。
- **仅文档/待补**：**prod_C 15→9 映射已移出本档**（v2p5 落地为投影规则 P，A2 段断言）；4568 矩阵「提交方源码描述/未核验」层；主库 7 门槛；历史引用/集合互斥完备/确定性；**mapping.evidence 仅引用存在性检查，引用内容未独立核实**；更正链范围（不强制跨来源合并链）；**T5 logical_source 真实数据提取规则未共识**。
- **未覆盖**：跨快照同键异内容自动修复建议；leave_sync.js 源码逐行定位；**G2/G3 真实数据执行**（依赖 T5 提取规则共识）。

## 7. 待办（预计时间如实登记，不能承诺）

| 缺口 | 负责人 | 预计 | 依赖 |
|---|---|---|---|
| 五议题 T1-T5 立场（确认/反对默认建议） | Tom（审核方 AI） | D1=10-24 内回复 | — |
| T5 logical_source 真实数据提取规则共识 | 双方 + 业务方 | 不能承诺 | 提取规则定义 |
| 应用脚本 v2p5 口径重跑（T3 采纳后） | 提交方 | 立场到达后 1 个工作内 | Tom 五议题立场 |
| leave_sync.js 写入路径固定版本源码 | 待持有 | 不能承诺 | 固定版本源码/授权 |
| H 列 recordId 与 Calendar 事件 id 对账 | 待有权方 | 待排 | 生产通道授权 |
| 主库自动校验启用 | 须用户/有权方明确授权，本代理执行范围另获用户批准 | — | 不因本评审通过而启用 |

## 8. 状态与边界

608 = v2 ≠ v2p2 ≠ v2p3 ≠ v2p4 ≠ v2p5；241 基准未锁定；Tom 已有 724fef64/ad3788f0/9bd8bb74 三份不重送。零生产操作、零新增授权、不索取生产权限。阶段一 PASS 暂缓；106 HOLD、历史 23 行、D241、HOLD/NO-GO、事故安全 OPEN。

**隐私边界**：去标识副本不进公开仓库（GitHub 仅无 PII 材料）；登记表 CSV 含真实 UUID 走邮件通道；备注自由文本未认证零 PII。

附件（**姓名假名化受控材料**，不公开、不转发原始附件、不索姓名映射、不认证零 PII）：`t1b_offline_fixture_v2p5.json`、`t1b_offline_test_v2p5.py`、`t1b_key_registry_v2p3.csv`（登记表沿用 v2p3 版，无变更）、`t1b_v2p5_manifest.json`。
