# T1-B 主键契约与离线设计（v2p4）

> v2p4 针对 Tom 2026-10-23 18:03 的 v2p3 限定整改确认。本文件是**局部差异说明**（两剩余分支 + 报告数字绑定），不是全量重交付；不碰生产、不触发任何写操作、不预授权。
> 本测试结果为**提交方报告**，非 Tom 独立运行，亦非全部契约验收。
> v2p3 已关闭项（UPSERT 冲突不覆写、CORRECT 首次创建已核前序、映射结构化与目标传播、关系不撤销隔离、分页边界、normal reason、登记列名/未判/工时/权限表述）不重开。
> 业务裁定（982 占位 / 7 空日期 / 233 请假）仍待有权方。

---

## 0. 逐条回应 18:03

### 0.1 项一：CORRECT 已有键分支绕过前序校验 — 已修复（更正链 + 重放前序绑定）

**Tom 指出的缺陷**：首次更正建立后只按 payload_digest 返回 idempotent/conflict；同摘要请求换/删前序仍可能 idempotent；payload 摘要未绑定前序；version 固定 1 且不参与 id_key，实际只支持一次更正。

**v2p4 修复（明确支持范围：多更正版本链）**：
- **显式版本身份**：身份键加入 `ver`——`UPSERT ver=0`（基版）、`CORRECT ver>=1`（更正版本），`identity_key = JSON(se,op,rv,ns,ver)`；支持 `ver=1,2,...` 多更正版本链，不再是每来源/op/rv/ns 仅一次更正。
- **前序纳入重放一致性**：重放判 idempotent 的条件收紧为**同身份 + 同摘要 + 同前序**三者全同；异摘要或异前序 → conflict（状态保持）。
- **前序校验**：CORRECT 的 predecessor 必须为**已接受记录**（`accepted` 注册表，含幂等重放登记的同状态 tag），且 **ver 严格前驱**（`pred.ver = ver-1`）+ se/ns/rv 一致；无前序 / 假前序 / 链断裂 → rejected，不写状态。
- **状态提交不变**：仅 created 或合法 versioned 提交；conflict/rejected/idempotent 保持原状态。
- **回归覆盖（15 例）**：

| 用例 | 动作 | 期望 | 证明点 |
|---|---|---|---|
| E1-upsert-1/2/3/4 | UPSERT dA 新建/重放/dB 冲突/重放 dA | created/idempotent/conflict/idempotent | conflict 不污染状态 |
| E1-correct-v1-0/-0b | CORRECT v1 无前序 ×2 | rejected/rejected | rejected 不写状态 |
| E1-correct-v1-fake | CORRECT v1 假前序 | rejected | 前序须已接受 |
| E1-correct-v1 | CORRECT v1 dC 前序=UPSERT(ver0) | versioned | 首次更正（链：0→1） |
| E1-correct-v1b | 同身份+同摘要+同前序重放 | idempotent | 重放一致性 |
| E1-correct-v1c | 同摘要**删前序**重放 | rejected | **v2p3 此处误判 idempotent，已修** |
| E1-correct-v1d | 同摘要**换前序**（改指另一已接受 tag） | conflict | **v2p3 此处误判 idempotent，已修** |
| E1-correct-v1e | 同更正身份 v1 异摘要 | conflict | 不反复 versioned |
| E1-correct-v2 | CORRECT v2 dG 前序=更正 v1 | versioned | **合法第二更正（链：1→2）** |
| E1-correct-v2b | v2 同身份+同摘要+同前序重放 | idempotent | 重放一致性 |
| E1-correct-v2c | 第二更正身份 v2 异摘要 | conflict | 状态保持 |

- 范围声明：前序须为已接受记录且 ver 严格前驱；不强制跨来源合并链；离线模型纠错，不授权真实落库。

### 0.2 项二：最终隔离传播不闭合 — 已修复（硬失败先行 + 不动点传播 + 完整坐标）

**Tom 指出的缺陷**：G2/G3 在 G4 分页之前传播，目标因分页被隔离后不再传播；同 namespace 不同 snapshot 被 `len(nss)<2` 误判同快照重复；`by_id` 仅按 source_record_id 会跨坐标覆盖；mapping.evidence 只查非空。

**v2p4 修复**：
- **执行序重排**：单例硬失败 → G1 → **分页（G4）全部硬失败先行确定** → 关系（G2/G3）**不动点传播至稳定**（重复评估所有 logical_source 组直到无新增隔离；跨组传播闭合）。
- **快照坐标 = (namespace, snapshot_id)**：同 namespace 不同 snapshot_id 是不同快照，不再误判 `logical_source_duplicate_in_snapshot`；只有完整坐标相同才算同快照。
- **映射目标按完整坐标索引**：`by_coord[(namespace, source_record_id, snapshot_id)]`，不再按 sid 覆盖，跨快照/跨 namespace 同 sid 目标可精确定位。
- **传播闭合**：映射目标被隔离（无论硬失败或关系失败）→ 本方也隔离（`mapping_target_isolated`）；不动点循环保证经分页失败的目标也向后传播。
- **新增正例**：P16/P17（同 namespace `prod`、不同 snapshot `C-v20261014`/`C-v20261015`、共享 GUID → `cross_snapshot_stable_ok_shared_guid`，证明坐标修复）；P18/P19/P20（三记录组：P18/P19 重复 sid `DUP-1` 但完整坐标不同 + 有效映射、P20 异 sid + 有效映射 → 全部 normal，证明 G1 不误冲突 + 完整坐标索引 + 三记录传播）。
- **新增负例**：N21A（分页截断 + 有效映射 → 保持 `pagination_truncated`，硬失败先行不被映射撤销）；N21B（干净 + 有效映射指向 N21A → `mapping_target_isolated`，**证明分页失败经关系传播闭合**）。
- **mapping.evidence 登记**：仅校验证据引用存在性（非空字符串），**不宣称引用内容已经独立核实**（已入覆盖矩阵 doc_only）。

### 0.3 项三：报告数字修正 — 已绑定实际例数与哈希

- **更正**：v2p3 正文"C 段 30/30"与文档"15 正例"数字有误；实际为 **16 正 + 25 负 = 41 例**（B 段 10 条）。该数字错误是提交方报告笔误，不影响断言结果（v2p3 全部 41 例实际均通过）。
- **v2p4 绑定**：fixture `meta.example_counts` 声明 `{positive:21, negative:27, total:48, state_model_cases:15}`；测试 F 段**断言实际例数 == 声明值**（任一不符即 FAIL）；测试打印本次运行的 test/fixture/依赖（`offline_recompute_scrubbed.py`）实际 SHA；manifest 增加 `dependencies` 段绑定依赖 SHA（`4342c240…`）。
- v2p4 实际例数：**21 正 + 27 负 = 48 例；state model 15 例**（运行报告与 manifest 绑定）。

---

## 1. 幂等状态模型（B 段，v2p4：更正链 + 重放前序绑定）
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
禁止实现读取 expected 计算 got。

## 2. 回归边界（A 段，独立两集合）

union=16766；leave_exclusion=5084 → after_excl=11682；special_key `U:OFF-WORK / Leave` 在 after_excl、在 final(11681) 外。
两独立集合有限可解析工时分别求和 = 均 46028.0；`non_finite_in_after_excl=1`、`non_finite_in_final=0`。
**有限可解析合计口径**：非法/非数值不计入，不称工时 0，非完整业务总工时。
first_seen_19 为逐档**首次新增键数**向量（非各档首次行号），和=16766。

## 3. 关系约束（C 段，v2p4：硬失败先行 + 不动点传播）

- **执行序**：单例硬失败 → G1 → 分页（G4）→ 关系（G2/G3）不动点传播至稳定。
- **快照坐标 = (namespace, snapshot_id)**；同坐标多例同 logical_source → `logical_source_duplicate_in_snapshot`。
- **G1**：同 `(ns,snap,sid)` 多例且 payload 不同 → `same_key_diff_content`（空 sid 不计入；不同完整坐标的同 sid 不误冲突）。
- **G2 跨侧**（≥2 顶层 namespace）：共享 sid → `cross_side_stable_ok_shared_guid`；异 sid 须有效结构化映射（目标按完整坐标定位）→ `cross_side_stable_ok_valid_mapping`；缺失/非结构化/目标失配/目标已隔离分层隔离。
- **G3 同侧跨快照**（完整坐标不同）：共享 sid → `cross_snapshot_stable_ok_shared_guid`；异 sid 须有效映射 → `cross_snapshot_stable_ok_valid_mapping`。
- **传播**：映射目标被隔离 → 本方隔离；不动点迭代至无新增隔离；关系只增不减。
- **G4 分页**：完整 / 缺段 / 重叠 / 截断 + 越界 / 倒序·空区间 / 异常格式显式失败。

## 4. 覆盖矩阵（准确登记）

- **已实现并断言**：A 段回归 + first_seen_19 向量 + 非有限计数 + special + 有限可解析工时口径；B 段 state 模型 15 例（ver 更正链 + 重放同前序，无回声）；C 段硬失败先行 + 不动点传播 + 完整坐标 + 映射结构化校验；分页四态 + 边界；normal reason 断言；**example_counts 实际例数绑定 + 运行报告 SHA**；manifest 绑定（含 dependencies）。
- **仅文档/待补**：prod_C 15→9 映射；4568 矩阵「提交方源码描述/未核验」层；主库 7 门槛；历史引用/集合互斥完备/确定性；**mapping.evidence 仅引用存在性检查，引用内容未独立核实**；更正链范围（不强制跨来源合并链）。
- **未覆盖**：跨快照同键异内容自动修复建议；leave_sync.js 源码逐行定位。

## 5. 待办（预计时间如实登记，不能承诺）

| 缺口 | 负责人 | 预计 | 依赖 |
|---|---|---|---|
| prod_C 15→9 schema 映射 | 待提供 prod_C 原始 schema | 不能承诺，待输入 | prod_C 15 列布局 |
| leave_sync.js 写入路径固定版本源码 | 待持有 | 不能承诺 | 固定版本源码/授权 |
| H 列 recordId 与 Calendar 事件 id 对账 | 待有权方 | 待排 | 生产通道授权 |
| 主库自动校验启用 | 须用户/有权方明确授权，本代理执行范围另获用户批准 | — | 不因本评审通过而启用 |

## 6. 状态与边界

608 = v2 ≠ v2p2 ≠ v2p3 ≠ v2p4；241 基准未锁定；Tom 已有 724fef64/ad3788f0/9bd8bb74 三份不重送。零生产操作、零新增授权、不索取生产权限。阶段一 PASS 暂缓；106 HOLD、历史 23 行、D241、HOLD/NO-GO、事故安全 OPEN。

附件（**姓名假名化受控材料**，不公开、不转发原始附件、不索姓名映射、不认证零 PII）：`t1b_offline_fixture_v2p4.json`、`t1b_offline_test_v2p4.py`、`t1b_key_registry_v2p3.csv`（登记表沿用 v2p3 版，无变更）、`t1b_v2p4_manifest.json`。
