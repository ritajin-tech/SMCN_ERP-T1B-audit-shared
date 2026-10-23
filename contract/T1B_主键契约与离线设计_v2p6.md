# T1-B 主键契约与离线设计（v2p6）

> v2p6 按 **Tom 2026-10-23 22:18 五议题技术立场 + 22:17 实现边界登记** 对 v2p5 草案修订。v2p5 草案（默认建议版，messageId 52f0cc2a）与 Tom 立场交叉到达，本版以 Tom 立场为准逐条对齐；差异逐条见 `T1B_v2p6_差异矩阵_20261023.md`。
> 本文件为**局部差异说明**（相对 v2p5），不是全量重交付；不碰生产、不触发任何写操作、不预授权。
> 本测试结果为**提交方报告**，非 Tom 独立运行，亦非全部契约验收。
> Tom 22:17 已确认关闭项（v2p4 三项限定整改：CORRECT 前序+ver、硬失败先行+不动点+完整坐标、例数与依赖哈希绑定）**不重做**（Tom 原话「既有闭合项不再机械要求重做」）。
> 业务裁定（982 占位 / 7 空日期 / 233 请假）仍待有权方。

---

## 0. 对 Tom 22:18 立场与 22:17 边界的逐条回应

### 0.1 T1：G1 双轨制 — 已按立场修订（full 硬判定 + biz 并列测量）

**Tom 立场**：保留 full 原行审计摘要，另建版本化 biz_digest 及明确字段投影；可并列测量仅录入时间不同的 duplicate_entry，但不直接认可剔除时间后即可恢复正常、有效计薪或同一事件；不要覆盖冻结原摘要或为降低隔离数选口径。

**v2p6 契约**：
- **硬判定层**：G1 判据**恢复 full 口径**（规范视图全行含提交时间）——同 `(ns,snap,sid)` 多例且 full 不同 → `same_key_diff_content`。v2p5 曾将硬判据改为 biz（为降低隔离数），本版**撤回该变更**：P21/P22（同键仅提交时间不同）由正例移入负例，硬判定 `isolated/same_key_diff_content`。
- **并列测量层（biz_digest，版本化）**：同键组（≥2 行）测量——full 全同 → `exact_duplicate`；biz 全同且 full 不全同（仅提交时间不同）→ `duplicate_entry`；biz 亦不同 → 无标记。**测量层只加标记、不改 status/reason 硬判定**；不宣称恢复正常/有效计薪/同一事件。
- **fixture 钉死**：P21/P22（硬判定 isolated + 测量 duplicate_entry）；P23/P24（normal/ok + 测量 exact_duplicate）；N11A/N11B（biz 亦不同，无标记）；C2 段 `expected_measure` 逐例断言。
- **两口径差异与依据**（Tom 要求先列）：archives 同键组 full 冲突 3099 组/20246 行 = biz 冲突 15 组/7924 行 + duplicate_entry 测量 3084 组/12322 行；live 46/96 = 1/2 + 45/94；prod 234/468 = 10/20 + 224/448。来源事件 ID 依据：LEAVE-/AUTO_LEAVE 常量标签行无稳定事件 ID（§0.3）；仅提交时间不同的重复录入经 20260824 档实证为同一事件重复录入（同 LEAVE- 事件 4-5 次）——**但「同一事件」的业务认定待有权方，提交方不代为认定**。

### 0.2 T2：精确重复 — 已按立场收紧（测量标记 + first-seen 降级）

- `exact_duplicate` / `duplicate_entry` 为**并列测量标记**（只读报告），列出组数、组内记录数、完整来源定位（namespace/snapshot/source_record_id）；
- **不批准**删除、合并写入或计薪排除；
- first-seen 仅作**既定聚合复算的代表选择**（合并层既有行为），不证明多条业务事件应合为一条；
- **区分两类**：采集重放特征（仅提交时间不同 → duplicate_entry）与可能实际重复业务（全同 → exact_duplicate，是否合并待业务裁定）。

### 0.3 T3：E1 扩展伪键 — 立场支持，措辞对齐

- `PSEUDO_CONSTANTS = {"OFF-WORK / Leave", "AUTO_LEAVE"}`：**精确常量匹配**（非前缀一刀切），与有稳定后缀的 `AUTO_LEAVE-`/`LEAVE-` 事件键分开（PJ4 实证 LEAVE- 行 UUID 位为真实记录 ID → 正常路由）；
- 进入**离线异常候选**及负例（N22），不据候选判可删除；
- 计数（archives 3353 + live 1 + prod 2；20260824 单快照 334 路同键）为**提交方报告**，「当前生产已修复/仅一次回填」结论提交方不予独立确认（Tom 22:18 原话立场，提交方接受该归因边界）。

### 0.4 T4：三层口径 — 立场支持，补互斥完备换算表

**三层分开**（Tom 接受的方向）：
| 层 | 内容 | 证明力边界 |
|---|---|---|
| 契约层（行级隔离） | 本 fixture/测试的单例+关系分类 | 行级可信度；不证明身份 |
| 聚合层（F 键回退） | `offline_recompute_scrubbed.key_of` 回退键 | F 键可复现**不等于**身份 PROVEN/唯一实体/计薪可信 |
| 业务可用性层 | 计薪/合并/修复 | 待有权方；不由双方 AI 拍板 |

**互斥完备换算表**（Tom 要求「同一冻结定位从输入→各层集合」）：`t1b_layer_conversion_v2p6.json` + `t1b_layer_conversion_v2p6.py`（只读真算，EXIT=0）：

| 层 | archives（同一冻结定位，19 档，102723 行） |
|---|---|
| L0 输入 | 102723 行 |
| L1 契约层单例（v2p6 口径） | ok 48868 + empty_required_key 45343 + pseudo_uuid_collapse 7921 + empty_date 591 = 102723（互斥完备） |
| L2 契约层 final（G1 full 覆写后） | ok 36540 + same_key_diff_content 20246 + empty_required_key 45343 + pseudo 3 + empty_date 591 = 102723（互斥完备） |
| L3 并列测量层（不改 L2） | duplicate_entry 3084 组/12322 行；exact_duplicate 3 组/6 行 |
| L4 合并层（key_of 键口径） | union 16766 − leave_exclusion 5084 = after_excl 11682 − special_key 1 = final 11681（键级恒等） |

**关键分离**：L4 final 11681 为**键数**，L2 normal 36540 为**行数**——不同口径，**不用 11681 代 normal 集**（Tom 原话）。

### 0.5 T5：G2/G3 真实数据建模 — 立场支持，补定义

- 真实数据 G2/G3 **未应用**如实登记；反对「fixture 保证真实正确性」——fixture 仅保证分类器在构造输入上的行为；
- logical_source 提取规则须先出**可追溯依据**（候选：项目编号+姓名+日期归并 / BD-PM 台账项目外键；依据须绑定档名+字节摘要+行定位）；
- **冲突状态**（同 source 多候选 logical_source）与**未知状态**（无候选）显式定义，不静默择一；
- 不靠可能塌缩的 U 键或不唯一 F 键循环证明身份；
- **无绑定依据的跨侧关联 HOLD**。

### 0.6 投影规则 P — 有条件接受，补条款

- P 作为**新设计评审对象**保留（§3 正式条款）；列序映射与 C 段关系放行是**不同层的问题**（前者是源→规范投影，后者是关系约束），本版在合同中分层表述；
- **P 是派生视图非删除**：原始 15/9 列行（含阶段列）在冻结副本完整保留；阶段列语义经请假标识派生保留于规范视图；不因投影丢字段而使冲突消失；
- **19 档逐档 schema 登记与行级 schema 路由**：单行表头同构不证明全档同 schema，已知错位 4568 行档须路由（登记表 v2p3 含 19 档 name+sha；错位档清单见 §8 待办）；
- **表头绑定**：表头实际来源/采集时刻/完整字节摘要须随新材料分版登记（15→9 及源码身份等源级证据与后续新材料分版，不凭邮件方案升级为独立核验——Tom 22:17）；
- **US 日期歧义声明**：5884 行可排除 D/M 解释（实证 M/D/Y），**不证明其余歧义日期逐条正确**；日期格式解析与业务日期裁定继续分开。

### 0.7 实现边界登记（Tom 22:17 三条）

1. **UPSERT ver=0 / CORRECT ver>=1 无入口强制类型/范围校验**：构造非零 UPSERT 会因 ver 参与身份键而另建基版（B2 段演示断言）——**不声称任意输入都保证该不变量**；
2. **accepted 别名 tag 与稳定事件身份**：tag 为请求别名（重试可换 tag）；稳定事件身份 = `id_key=(se,op,rv,ns,ver)`；同身份不同 tag 的重放按 idempotent 处理；**重试 tag 变化不当不同前序**；
3. **关系组完整坐标重复诊断**：by_coord 去重索引遇坐标重复须**显式登记**（N23/N23b 触发，coord_duplicates 断言 1 次），不由字典覆盖替代审计；诊断为静态属性，仅组首评时构建，不随不动点轮次重复。

### 0.9 对 Tom 22:22（v2p5 草案审阅）四项 — 已修订

1. **biz 摘要隐藏差异 — 已补诊断**：biz 为规范化投影后的 `row[1:]`，阶段列与自动列在 P 时已丢失，故仅阶段不同的两条原始行可得相同 P 与 biz。v2p6 增补：
   - 保留**原始全行摘要** `source_full_digest`（不分投影，对原始 15/9 列行算摘要）；
   - 同键组内比对，差异显式登记 `source_field_diff`（**投影折叠差异**）——不把差异消掉，也不等同业务有效；
   - 新增用例 N24/N24b（仅阶段列不同、均不触发 LEAVE → 投影后全同 → 诊断 True），将「阶段差异」与「仅提交时间差异」分开成例；
   - **业务内容字段裁定依据待有权方**：当前 biz 字段清单 = 规范视图除提交时间（[1]日期 [2]姓名 [3]类型 [4]项目 [5]工时 [6]备注 [7]请假标识），阶段列不在清单内——这是投影定义的结果，不是业务裁定结论，提交方不代为认定。
2. **project 未校验列宽 + A2 未端到端 — 已补**：
   - **布局校验前置**：仅接受 **9 / 15 列**；其他列宽（10/14/16 等）→ `schema_width_mismatch`，短行（<9）→ `missing_column`，**不静默取前九列继续投影**；新增 PJ10-PJ13；
   - **A2 分两段**：A2a 投影字面相等、A2b **投影后分类/路由端到端**（project → 行级 classify → 断言 `expected_route`），PJ4 正常路由 / PJ5-PJ6 伪键隔离 / PJ7-PJ9 非法日历均端到端断言；
   - **日期尾串白名单**：`ISO + HH:MM[:SS][.fff][Z|±HH:MM]` 才截断，非白名单（如 `2026-04-01 garbage`）不截断 → `illegal_calendar`（新增 PJ9）；**业务日期有效性仍不由解析器裁定**；
   - 源 schema 版本/列宽/字段语义与原行定位绑定要求登记（PJ5 由已知常量拦截 ≠ 其他错位布局都能识别）。
3. **D 段退化 — 已恢复严格**：v2p5 曾把 manifest 缺失从 fails 降级为提示（错误，Tom 称之为退化）。v2p6：**严格验收模式**——缺 manifest / 缺依赖 / 缺交付物即 FAIL，不输出同一验收 PASS；「EXIT=0 同时证明外部绑定完整」的口径恢复成立。辅助脚本与新交付按实际范围显式绑定于 manifest `supporting` 段（含 SHA），不宣称与四件套同清单。
4. **T5 候选身份否定 — 已采纳**：**项目+姓名+日期不能直接当唯一事件身份**（同日可多事件，跨假名批次身份一致性未必成立）；该组合仅作**候选关联**（非唯一身份），须带冲突/未知状态；不以 U 键 / F 键 / logical_source 人工标签循环自证。

### 0.8 报告口径修正（Tom 22:18）

1. **11682 vs 11681 分母统一**：L4 链式恒等（after_excl 11682 − special_key 1 = final 11681）仅限**离线数据行键数口径**；主库工时 sheet 行数 11682（含 1 行表头）与请假 568（含表头）/567（数据行）为另一只读观测，**不同分母不可直接相减**，差 1 归因 special 仅在离线口径内成立；
2. **版本指纹不混称**：`724fef64`/`ad3788f0`/`9bd8bb74` 为此前**冻结/对账材料指纹**，非 PKC 版本轮次；PKC 版本链以 fixture `meta.rule_version` 为准（v2 ≠ v2p2 ≠ v2p3 ≠ v2p4 ≠ v2p5 ≠ v2p6）。

---

## 1. 幂等状态模型（B 段，沿用 v2p4/v2p5；边界见 §0.7）

```
identity_key = json.dumps({se, op, rv, ns, ver}, sort_keys=True, ensure_ascii=False)
# UPSERT ver=0 基版；CORRECT ver>=1 更正版本（支持多更正版本链）
state[key] = {digest, predecessor, version}   # 仅 created / 合法 versioned 提交
accepted[tag] = {key, se, ns, rv, ver, digest}  # 已接受记录（含幂等重放登记；tag 为请求别名）

UPSERT 新键            -> created（提交）
UPSERT 同键同摘要       -> idempotent（保持；登记重放 tag 指向同一状态）
UPSERT 同键异摘要       -> conflict（保持，不覆写）
CORRECT 前序无效        -> rejected（不写状态）  # 无前序/假前序/链断裂(pred.ver != ver-1)/se-ns-rv 不一致
CORRECT 新键 + 前序有效 -> versioned（提交，绑定 predecessor+version）
CORRECT 同键 + 同摘要 + 同前序 -> idempotent（重放一致性）
CORRECT 同键 + 异摘要或异前序 -> conflict（保持）
```
禁止实现读取 expected 计算 got。15 例覆盖与 v2p4/v2p5 相同。

## 2. 回归边界（A 段，沿用；分母口径见 §0.8）

union=16766；leave_exclusion=5084 → after_excl=11682；special_key `U:OFF-WORK / Leave` 在 after_excl、在 final(11681) 外。
两独立集合有限可解析工时分别求和 = 均 46028.0；`non_finite_in_after_excl=1`、`non_finite_in_final=0`。
**有限可解析合计口径**：非法/非数值不计入，不称工时 0，非完整业务总工时。
first_seen_19 为逐档**首次新增键数**向量（非各档首次行号），和=16766。
合并层边界数学链：union 16766 − leave_exclusion 5084 = after_excl 11682 − special_key 1 = final 11681；collapse_4568；first_srow 8018（均为离线数据行键数口径；与主库 sheet 行数观测不同分母）。

## 3. 投影规则 P（正式条款；派生视图，非删除）

**契约规范视图（9 列）**：`[0]提交时间 [1]日期 [2]姓名 [3]类型 [4]项目 [5]工时 [6]备注 [7]请假标识 [8]UUID`

**真实数据布局（前 9 列三侧同构）**：`[0]录入时间 [1]日期 [2]姓名 [3]类型 [4]阶段 [5]项目编号 [6]工时 [7]备注 [8]UUID`
（prod C 与 live 为 15 列，col9 起为自动列，不进规范视图；archives 为 9 列）

**投影规则 P**：
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

**日期规范化 canon_date**：`YYYY-MM-DD` 原样；`YYYY-MM-DD[ T]...` 截断日期部分；US `M/D/YYYY` → ISO；**不存在的日期原样保留**交 `illegal_calendar`。US 格式实证 M/D/Y（首分量 1-12、次分量 1-31、5884 行次分量>12）；**其余歧义日期不逐条证明正确**，格式解析与业务日期裁定分开。

**证据链**：prod C 原始表头 15 列逐列语义确认；live/archives 前 9 列与 prod 同构（首行逐列比对）；fixture meta `normalized_sample_schema` 声明；v2 文档 §3「不冒称原 C 布局即规范」。**19 档逐档 schema 登记与行级 schema 路由**：单行表头同构不证明全档同 schema，已知错位 4568 行档须路由；表头来源/采集时刻/字节摘要随新材料分版登记。

**fixture 钉死（A2 段，PJ1-PJ8）**：prod 常规行（阶段列/自动列不进规范视图，P 为派生视图非删除）；ISO+time 截断；US M/D/Y；LEAVE- 行（UUID 位为真实记录 ID → 正常路由）；mangled 伪行（备注位=真实 recordId、UUID 位=常量标签）；AUTO_LEAVE 行（E1）；US 格式但日期不存在（原样保留）；live 15 列同构投影。

## 4. 关系约束（C 段，v2p6：G1 full 口径 + C2 并列测量层 + 坐标重复诊断）

- **执行序**：单例硬失败 → **G1（full 口径）** → 分页（G4）→ 关系（G2/G3）不动点传播至稳定 → **C2 并列测量层**（不改硬判定）。
- **快照坐标 = (namespace, snapshot_id)**；同坐标多例同 logical_source → `logical_source_duplicate_in_snapshot`。
- **G1（full 口径，v2p6 恢复）**：同 `(ns,snap,sid)` 多例且全行（含提交时间）不同 → `same_key_diff_content`（空 sid 不计入；不同完整坐标的同 sid 不误冲突）。**不为降低隔离数选口径**。
- **C2 并列测量层（biz_digest，版本化）**：同 `(ns,snap,sid)` 组（≥2 行）——full 全同 → `exact_duplicate`；biz 全同且 full 不全同 → `duplicate_entry`；biz 亦不同 → 无标记。**只加标记不改硬判定**；不宣称恢复正常/有效计薪/同一事件；first-seen 仅聚合复算代表选择。
- **C2 投影折叠差异诊断**（Tom 22:22）：另存 `source_full_digest`（原始全行摘要，不分投影）并在同键组内比对 → `source_field_diff`（N24/N24b 阶段差异对例）；**差异显式暴露但不改硬判定、不等同业务有效**；业务字段清单裁定依据待有权方。
- **布局校验前置**（Tom 22:22）：project 仅接受 9/15 列；其他列宽 → `schema_width_mismatch`，短行 → `missing_column`；日期尾串白名单外不截断。
- **坐标重复诊断（边界③）**：关系组建完整坐标索引时显式登记重复（不由字典覆盖替代审计）；静态属性仅首评构建。
- **G2 跨侧**（≥2 顶层 namespace）：共享 sid → `cross_side_stable_ok_shared_guid`；异 sid 须有效结构化映射（目标按完整坐标定位）→ `cross_side_stable_ok_valid_mapping`；缺失/非结构化/目标失配/目标已隔离分层隔离。
- **G3 同侧跨快照**（完整坐标不同）：共享 sid → `cross_snapshot_stable_ok_shared_guid`；异 sid 须有效映射 → `cross_snapshot_stable_ok_valid_mapping`。
- **传播**：映射目标被隔离 → 本方隔离；不动点迭代至无新增隔离；关系只增不减。
- **G4 分页**：完整 / 缺段 / 重叠 / 截断 + 越界 / 倒序·空区间 / 异常格式显式失败。

## 5. 三层口径与互斥完备换算（T4）

三层分开见 §0.4 表；互斥完备换算表（archives 同一冻结定位）摘要：

```
L0 输入 102723 行
L1 单例分类（互斥完备，和=102723）: ok 48868 | empty_required_key 45343 | pseudo 7921 | empty_date 591
L2 G1 full 覆写后（互斥完备，和=102723）: ok 36540 | same_key_diff_content 20246 | empty_required_key 45343 | pseudo 3 | empty_date 591
L3 并列测量（不改 L2）: duplicate_entry 3084 组/12322 行 | exact_duplicate 3 组/6 行
L4 合并层键口径（键级恒等）: union 16766 − leave 5084 = after_excl 11682 − special 1 = final 11681
分离声明: L4 final(键数 11681) ≠ L2 normal(行数 36540)，不互代
```

F 键可复现不等于身份 PROVEN/唯一实体/计薪可信；业务可用性层待有权方。

## 6. T5：logical_source 提取规则（真实数据 G2/G3 前置）

- 候选关联（**非唯一事件身份**）：① 项目编号+姓名+日期；② BD/PM 台账项目外键关联。
  **Tom 22:22 明示：项目+姓名+日期不能直接当唯一事件身份**——同日可多事件，且跨假名批次身份一致性未必成立；上述仅为候选关联；
- 可追溯依据：候选规则须绑定档名+字节摘要+行定位样例；无绑定依据的跨侧关联 HOLD；
- **冲突状态**（同 source 多候选 logical_source）与**未知状态**（无候选）显式定义，不静默择一；
- 不靠可能塌缩的 U 键或不唯一 F 键循环证明身份；不以 logical_source 人工标签自证；
- 共识前，G2/G3 仅保持 fixture 级断言，不外宣称真实数据覆盖。

## 7. 覆盖矩阵（准确登记）

- **已实现并断言**：A 段回归 + first_seen_19 向量 + 非有限计数 + special + 有限可解析工时口径；B 段 state 模型 15 例（ver 更正链 + 重放同前序，无回声）；A2 投影 8 例（PJ1-PJ8）；C 段硬失败先行 + 不动点传播 + 完整坐标 + 映射结构化校验；**G1 full 口径（P21/P22 移入负例）**；**C2 并列测量层 expected_measure 断言**；E1 扩展伪键（N22）；**坐标重复诊断（N23/N23b）**；**B2 实现边界登记三条**；分页四态 + 边界；normal reason 断言；example_counts 实际例数绑定（23+32=55+15+8）+ 运行报告 SHA；manifest 绑定（含 dependencies）。
- **仅文档/待补**：19 档逐档 schema 登记与行级 schema 路由（含错位 4568 行档清单）；4568 矩阵「冻结证据 vs 提交方源码描述/未核验」分列；主库 7 门槛；历史引用/集合互斥完备/确定性；**mapping.evidence 仅引用存在性检查，引用内容未独立核实**；更正链范围（不强制跨来源合并链）；**logical_source 提取规则未共识（T5）**；**US 歧义日期逐条正确性未证**。
- **未覆盖**：跨快照同键异内容自动修复建议；leave_sync.js 源码逐行定位；**G2/G3 真实数据执行**（依赖 T5 共识）。

## 8. 待办（预计时间如实登记，不能承诺）

| 缺口 | 负责人 | 预计 | 依赖 |
|---|---|---|---|
| 五议题 T1-T5 及投影 P 立场的 v2p6 对齐复核 | Tom | 不能承诺 | 其独立复核安排 |
| 19 档逐档 schema 登记 + 错位 4568 行档清单 | 提交方 | 1 个工作内 | 冻结副本（已持有） |
| logical_source 提取规则共识（T5） | 双方 + 业务方 | 不能承诺 | 可追溯依据定义 |
| 业务字段/来源事件 ID 依据细化（T1 并列测量前置） | 提交方列清单 + 业务方认定 | 不能承诺 | 业务方输入 |
| leave_sync.js 写入路径固定版本源码 | 待持有 | 不能承诺 | 固定版本源码/授权 |
| H 列 recordId 与 Calendar 事件 id 对账 | 待有权方 | 待排 | 生产通道授权 |
| 主库自动校验启用 | 须用户/有权方明确授权，本代理执行范围另获用户批准 | — | 不因本评审通过而启用 |

## 9. 状态与边界

608 = v2 ≠ v2p2 ≠ v2p3 ≠ v2p4 ≠ v2p5 ≠ v2p6；241 基准未锁定；724fef64/ad3788f0/9bd8bb74 为冻结/对账材料指纹（非 PKC 轮次）。零生产操作、零新增授权、不索取生产权限。阶段一 PASS 暂缓；106 HOLD、历史 23 行、D241、HOLD/NO-GO、事故安全 OPEN 不变。

**时间表定位（按 Tom 22:18 改述）**：两天计划（D1=10-24 / D2=10-25）为**提交方提出的目标与议程**，不构成审核方交付承诺；不接受默认建议、沉默同意、限定一轮异议或自动签收；计划推进不替代最终验收，不解除阶段一 PASS 暂缓；982/7/233、D241、主库启用与公开范围均不由双方 AI 代用户/有权方拍板。公开仓已有范围不以 Tom 来信追认；提交方不上传、公开或转发受控副本、原始登记表或身份映射。

**隐私边界**：去标识副本不进公开仓库（GitHub 仅无 PII 材料）；登记表 CSV 含真实 UUID 走邮件通道；备注自由文本未认证零 PII。

附件（**姓名假名化受控材料**，不公开、不转发原始附件、不索姓名映射、不认证零 PII）：`t1b_offline_fixture_v2p6.json`、`t1b_offline_test_v2p6.py`、`t1b_v2p6_manifest.json`、`t1b_key_registry_v2p3.csv`（登记表沿用 v2p3 版，无变更）、`T1B_v2p6_差异矩阵_20261023.md`、`t1b_layer_conversion_v2p6.json`、`t1b_layer_conversion_v2p6.py`、`build_fixture_v2p6.py`。
