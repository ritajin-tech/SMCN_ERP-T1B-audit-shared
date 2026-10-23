# -*- coding: utf-8 -*-
"""构建 t1b_offline_fixture_v2p6.json（按 Tom 2026-10-23 22:18 五议题技术立场修订）。

v2p6 变更（相对 v2p5）——全部来自 Tom 22:18 立场信 + 22:17 实现边界登记：
1. **T1 双轨制（本版核心修订）**：G1 硬失败判据**恢复 full 口径**（规范视图全行含提交时间）
   ——Tom 明示「不要覆盖冻结原摘要或为降低隔离数选口径」；**另建版本化 biz_digest 并列测量层**：
   同键组按 biz（剔除提交时间）测量 duplicate_entry / exact_duplicate，仅作并列测量标记，
   **不改变 isolated/normal 硬判定**，不宣称「恢复正常/有效计薪/同一事件」。
   - P21/P22（同键同业务仅提交时间不同）：由正例移入负例——full 口径硬判定
     isolated/same_key_diff_content（v2p5 曾误放行），并列测量 expected_measure=duplicate_entry。
   - P23/P24（全同含提交时间）：保持正例 normal/ok，并列测量 expected_measure=exact_duplicate。
   - N11A/N11B（同键异业务内容）：full/biz 均不同，硬隔离不变，无测量标记。
2. **T3 措辞对齐**：N22 note 改为「离线异常候选」口径（进入隔离分类，不据此判可删除）。
3. **投影 P 补充声明**：P 是派生视图非删除——原始行（15/9 列含阶段列）在冻结副本完整保留，
   阶段列语义经请假标识派生保留于规范视图；单行表头正常不证明 19 档所有行同 schema，
   19 档逐档 schema 登记与行级 schema 路由见合同 §1.4（错位 4568 行档特殊处理）。
4. example_counts：23 正 + 32 负 = 55；state model 15；projection_cases 8。
5. **实现边界③**（Tom 22:17）：新增 N23/N23b（同 logical_source 同完整坐标重复对）——
   关系组 by_coord 去重索引遇坐标重复须显式登记诊断，不由字典覆盖替代审计。
"""
import json, hashlib, os

HERE = os.path.dirname(os.path.abspath(__file__))
fx = json.load(open(os.path.join(HERE, "t1b_offline_fixture_v2p5.json"), encoding="utf-8"))

# ---------- 1. meta ----------
fx["meta"]["doc"] = ("T1-B 主键契约离线 fixture v2p6（按 Tom 22:18 五议题技术立场修订："
                     "T1 双轨制——G1 恢复 full 口径硬判定 + biz_digest 版本化并列测量层；"
                     "T3 异常候选措辞；投影 P 派生视图声明）")
fx["meta"]["rule_version"] = "PKC-v2p6"
fx["meta"]["algorithm"] = (
    "operation_identity_key = 结构化 JSON(source_event_id,op_type,rule_version,namespace,ver)；"
    "UPSERT ver=0 基版，CORRECT ver>=1 更正版本；payload_digest 单独存/比；state 仅在 created 或合法 "
    "versioned 时提交，conflict/rejected/idempotent 保持原状态；CORRECT 前序须为已接受记录且 ver 严格前驱"
    "(pred.ver=ver-1)+se/ns/rv 一致；重放须同身份+同摘要+同前序；硬失败(单例/G1/分页)先行确定，关系(G2/G3)"
    "随后不动点传播至稳定；投影 P：源行(前 9 列同构)→规范视图 [0]提交时间 [1]日期(canon_date 多格式规范化) "
    "[2]姓名 [3]类型 [4]项目编号(阶段列不进规范视图) [5]工时 [6]备注 [7]请假标识(派生) [8]UUID 原值——P 为派生视图，"
    "原始行在冻结副本完整保留；pseudo E1：UUID 位常量标签 {'OFF-WORK / Leave','AUTO_LEAVE'} → 离线异常候选 "
    "pseudo_uuid_collapse（不据此判可删除）；"
    "**G1 双轨（v2p6，T1）**：硬判定层 payload_digest 取 full（规范视图全行含提交时间）——同键多例且 full 不同 → "
    "same_key_diff_content 硬隔离（不为降低隔离数选口径）；并列测量层 biz_digest（版本化，剔除提交时间）对同键组测量："
    "full 全同 → exact_duplicate；biz 全同且 full 不全同（仅提交时间不同）→ duplicate_entry——测量标记不改变硬判定，"
    "不宣称恢复正常/有效计薪/同一事件；first-seen 仅作聚合复算既定代表选择；"
    "**投影折叠差异诊断**：biz 是规范化投影后的 row[1:]（阶段列与自动列在 P 时已丢失），故仅阶段不同的两条原始行"
    "可得相同 P 与 biz 摘要——另存 source_full_digest（原始全行摘要，不分投影）并在同键组内比对，"
    "差异显式登记 source_field_diff（不把差异消掉，也不等同业务有效；业务字段清单裁定依据待有权方）；"
    "**project 布局校验**：仅接受 9 / 15 列；其他列宽（10/14/16 等）→ schema_width_mismatch，短行（<9）→ "
    "missing_column，不静默取前九列；canon_date 时间尾串为白名单（ISO + HH:MM[:SS][.fff][Z|±HH:MM]），"
    "非白名单格式不截断（不把格式错误悄然合法化），业务日期有效性不由解析器裁定；"
    "boundary: union 16766 - leave_exclusion 5084 = 11682 - special_key1 = 11681")
fx["meta"]["expected_output_note"] = (
    "exit0 = 全部回归常量可复算 + 投影用例逐列相等 + 全部正/负例（含成组关系、映射校验、分页边界、更正链）"
    "分类与定位符合 PKC-v2p6 + 并列测量层 expected_measure 断言一致 + 实际例数与 example_counts 声明一致；"
    "标注为提交方报告，非 Tom 独立运行")
fx["meta"]["example_counts"] = {"positive": 25, "negative": 32, "total": 57,
                                "state_model_cases": 15, "projection_cases": 13}

# ---------- 2. T1 双轨：P21/P22 移入负例；P23/P24 改 normal/ok + expected_measure ----------
pos = [ex for ex in fx["positive_examples"] if ex["id"] not in ("P21", "P22")]
for ex in pos:
    if ex["id"] in ("P23", "P24"):
        ex["expected_status"] = "normal"
        ex["expected_reason"] = "ok"
        ex["expected_measure"] = "exact_duplicate"
        ex["note"] = ("与同组全同（含提交时间）→ 硬判定 normal/ok；并列测量层标记 exact_duplicate"
                      "（v2p6 双轨：测量不改变硬判定；实证 prod 1544 组同键同内容——是否属实际重复业务"
                      "待业务裁定，first-seen 仅聚合复算代表选择）")
fx["positive_examples"] = pos
fx["negative_examples"] += [
    {"id": "P21", "namespace": "prod", "source_record_id": "TS-DUP", "snapshot_id": "C-v20261015",
     "row": ["2026-10-10T09:00", "2026-10-10", "P-41", "WORK", "PRJ-D1", "8.0", "ok", "", "TS-DUP"],
     "expected_status": "isolated", "expected_reason": "same_key_diff_content", "expected_measure": "duplicate_entry",
     "note": "T1 双轨（v2p6）：与 P22 同键仅提交时间不同——full 口径硬判定 same_key_diff_content（Tom：不为降低隔离数选口径，v2p5 曾误放行为 normal）；并列测量层（biz 剔除提交时间）标记 duplicate_entry，不改变硬判定"},
    {"id": "P22", "namespace": "prod", "source_record_id": "TS-DUP", "snapshot_id": "C-v20261015",
     "row": ["2026-10-10T09:30", "2026-10-10", "P-41", "WORK", "PRJ-D1", "8.0", "ok", "", "TS-DUP"],
     "expected_status": "isolated", "expected_reason": "same_key_diff_content", "expected_measure": "duplicate_entry",
     "note": "同一事件两次录入（业务内容全同、仅录入时间不同）——实证 live 46 组中 45 组、prod 234 组中 224 组属此类；硬判定 isolated，并列测量 duplicate_entry"},
    {"id": "N23", "namespace": "prod", "source_record_id": "COORD-DUP", "snapshot_id": "C-v20261015",
     "logical_source_id": "LS-COORD",
     "row": ["2026-10-11T09:00", "2026-10-11", "P-43", "WORK", "PRJ-D3", "8.0", "ok", "", "COORD-DUP"],
     "expected_status": "isolated", "expected_reason": "logical_source_duplicate_in_snapshot",
     "expected_measure": "exact_duplicate",
     "note": "实现边界③（Tom 22:17）：与 N23b 同 logical_source 且完整坐标 (prod,C-v20261015,COORD-DUP) 相同 → logical_source_duplicate_in_snapshot；by_coord 去重索引遇坐标重复须单独登记诊断（不由字典覆盖替代审计）；两行全同，测量层并列标记 exact_duplicate"},
    {"id": "N23b", "namespace": "prod", "source_record_id": "COORD-DUP", "snapshot_id": "C-v20261015",
     "logical_source_id": "LS-COORD",
     "row": ["2026-10-11T09:00", "2026-10-11", "P-43", "WORK", "PRJ-D3", "8.0", "ok", "", "COORD-DUP"],
     "expected_status": "isolated", "expected_reason": "logical_source_duplicate_in_snapshot",
     "expected_measure": "exact_duplicate",
     "note": "同 N23（完整坐标重复对例）；证明坐标重复被显式诊断而非静默覆盖"}
]

# ---------- 3. T3：N22 note 对齐「离线异常候选」 ----------
for ex in fx["negative_examples"]:
    if ex["id"] == "N22":
        ex["note"] = ("E1：UUID 位为常量标签 'AUTO_LEAVE'（与 'OFF-WORK / Leave' 同类）→ 离线异常候选 "
                      "pseudo_uuid_collapse（Tom：支持加入候选及负例，与有稳定后缀的 AUTO_LEAVE-/LEAVE- 事件键分开，"
                      "不按前缀一刀切，不据候选判可删除；实证 archives 3353 + live 1 + prod 2 行，计数仍为提交方报告）")

# ---------- 4b. 投影补充：未知列宽 + 日期白名单（Tom 22:22 二）----------
# PJ9：日期非白名单尾串（"2026-04-01 garbage"）→ 不截断，交 illegal_calendar
# PJ10-PJ13：未知列宽（10/14/16）与短行（8）→ 隔离，不静默取前九列
fx["projection_cases"] += [
    {"id": "PJ9", "side": "archives(9列)", "raw": ["4/1/2026 13:05:14", "2026-04-01 garbage", "P-9", "执行端",
      "2. 设计阶段", "24-074-SZ", "4", "备注", "GUID:pj9"],
     "expected": ["4/1/2026 13:05:14", "2026-04-01 garbage", "P-9", "执行端", "24-074-SZ", "4", "备注", "", "GUID:pj9"],
     "expected_route": "illegal_calendar",
     "note": "canon_date 时间尾串改白名单（ISO+HH:MM[:SS] 等），非白名单格式不截断——不把格式错误悄然合法化（Tom 22:22）；业务日期有效性仍不由解析器裁定"},
    {"id": "PJ10", "side": "未知(10列)", "raw": ["2026-04-01 13:05:14", "2026-04-01", "P-10", "执行端", "2. 设计阶段",
      "24-074-SZ", "4", "备注", "GUID:pj10", "EXTRA-10"],
     "expected": None, "expected_route": "schema_width_mismatch",
     "note": "未知列宽 10：project 不静默取前九列，先隔离（Tom 22:22：不能声称未知布局失败关闭）"},
    {"id": "PJ11", "side": "未知(14列)", "raw": ["2026-04-01 13:05:14", "2026-04-01", "P-11", "执行端", "2. 设计阶段",
      "24-074-SZ", "4", "备注", "GUID:pj11"] + ["X"] * 5,
     "expected": None, "expected_route": "schema_width_mismatch",
     "note": "未知列宽 14：隔离；PJ5 由已知常量拦截不等于其他错位布局都能识别"},
    {"id": "PJ12", "side": "未知(16列)", "raw": ["2026-04-01 13:05:14", "2026-04-01", "P-12", "执行端", "2. 设计阶段",
      "24-074-SZ", "4", "备注", "GUID:pj12"] + ["X"] * 7,
     "expected": None, "expected_route": "schema_width_mismatch",
     "note": "未知列宽 16：隔离；源 schema 版本/列宽/字段语义与原行定位须绑定，这里仅登记不声称全档同 schema"},
    {"id": "PJ13", "side": "短行(8列)", "raw": ["2026-04-01 13:05:14", "2026-04-01", "P-13", "执行端",
      "2. 设计阶段", "24-074-SZ", "4", "备注"],
     "expected": None, "expected_route": "missing_column",
     "note": "短行 8 列：missing_column（短行索引异常不得被投影吞掉）"}
]
# 已有 PJ 补 expected_route（投影后分类/路由端到端断言）
ROUTE = {"PJ1": "ok", "PJ2": "ok", "PJ3": "ok", "PJ4": "ok", "PJ5": "pseudo_uuid_collapse",
         "PJ6": "pseudo_uuid_collapse", "PJ7": "illegal_calendar", "PJ8": "ok"}
for pj in fx["projection_cases"]:
    if pj["id"] in ROUTE:
        pj["expected_route"] = ROUTE[pj["id"]]

# ---------- 4c. 阶段差异折叠诊断（Tom 22:22 一）：N24/N24b ----------
# 两条原始行仅阶段列不同（均不触发 LEAVE）→ 投影 P 后规范视图全同（阶段列不进规范视图）
# → full/biz 摘要均相同，差异被投影折叠；须以原始全行摘要 source_full_digest 显式暴露。
fx["positive_examples"] += [
    {"id": "N24", "namespace": "prod", "source_record_id": "STAGE-DIFF", "snapshot_id": "C-v20261015",
     "row": ["2026-10-12T09:00", "2026-10-12", "P-44", "WORK", "PRJ-D4", "8.0", "ok", "", "STAGE-DIFF"],
     "source_row": ["2026-10-12T09:00", "2026-10-12", "P-44", "WORK", "2. 设计阶段", "PRJ-D4", "8.0", "ok", "STAGE-DIFF"],
     "expected_status": "normal", "expected_reason": "ok", "expected_measure": "exact_duplicate",
     "expected_source_field_diff": True,
     "note": "阶段差异折叠诊断（Tom 22:22）：与 N24b 原始行仅阶段列不同（2. 设计阶段 vs 3. 施工阶段，均不触发 LEAVE）→ 投影后规范视图全同，biz 摘要亦同，差异被折叠；以 source_full_digest 显式暴露（保留原始全行摘要与字段清单），登记为『投影折叠差异』，不等同业务有效、不据此判合并"},
    {"id": "N24b", "namespace": "prod", "source_record_id": "STAGE-DIFF", "snapshot_id": "C-v20261015",
     "row": ["2026-10-12T09:00", "2026-10-12", "P-44", "WORK", "PRJ-D4", "8.0", "ok", "", "STAGE-DIFF"],
     "source_row": ["2026-10-12T09:00", "2026-10-12", "P-44", "WORK", "3. 施工阶段", "PRJ-D4", "8.0", "ok", "STAGE-DIFF"],
     "expected_status": "normal", "expected_reason": "ok", "expected_measure": "exact_duplicate",
     "expected_source_field_diff": True,
     "note": "同 N24（阶段差异对例）；证明『biz 相同』不等于『原始行相同』——不得凭减少隔离面证明口径正确"}
]

# ---------- 4. 投影 P：PJ1 note 补「派生视图非删除」声明 ----------
for pj in fx["projection_cases"]:
    if pj["id"] == "PJ1":
        pj["note"] = ("prod 常规行 ISO 日期；阶段列/自动列不进规范视图。P 为派生视图非删除：原始 15 列行（含阶段列）"
                      "在冻结副本完整保留，阶段列语义经请假标识派生保留；单行表头正常不证明 19 档所有行同 schema")

# ---------- 5. state model 的 rule_version 对齐 v2p6 ----------
for c in fx["idempotency_state_model"]["cases"]:
    c["rule_version"] = "PKC-v2p6"
fx["idempotency_state_model"]["note"] = fx["idempotency_state_model"]["note"].replace("PKC-v2p5", "PKC-v2p6")

# ---------- 6. 覆盖矩阵 ----------
cov = fx["coverage_matrix"]
cov["implemented_and_asserted"] = cov["implemented_and_asserted"] + [
    "G1 双轨（v2p6 T1）：硬判定层 full 口径（同键多例且全行含提交时间不同 → same_key_diff_content；P21/P22 已移入负例，v2p5 误放行已修正）；并列测量层 biz_digest（版本化、剔除提交时间）对同键组测量 duplicate_entry（仅提交时间不同）/ exact_duplicate（全同）——expected_measure 逐例断言，测量不改变硬判定、不宣称恢复/计薪/同一事件",
    "实现边界登记（Tom 22:17）：UPSERT ver=0/CORRECT ver>=1 无入口强制类型/范围校验（不声称任意输入保证该不变量）；accepted 别名 tag 与稳定事件身份须明确定义（重试 tag 变化不当不同前序）；关系组完整坐标去重索引须单独保留坐标重复诊断（不由字典覆盖替代审计）——测试含对应断言/登记",
    "报告口径修正：union 16766/after_excl 11682/final 11681 均为离线数据行键数口径；主库工时 sheet 11682 含 1 行表头，与离线 11681 不同分母不可直接相减（差 1 归因 special 仅限离线口径内）；724fef64/ad3788f0/9bd8bb74 为此前冻结/对账材料指纹，非 PKC 版本轮次",
    "T4 三层分开：契约行级隔离（本 fixture）/ 聚合 F 键回退（offline_recompute_scrubbed.key_of）/ 业务可用性（待有权方）——同一冻结定位互斥完备换算表见合同，F 键可复现不等于身份 PROVEN/唯一实体/计薪可信"
]
cov["doc_only_or_pending"] = [x for x in cov["doc_only_or_pending"]
                              if not x.startswith("prod_C 15→9 字段映射")] + [
    "19 档逐档 schema 登记与行级 schema 路由（投影 P 配套）：单行表头同构不证明全档同 schema，已知错位 4568 行档须路由——合同 §1.4 定义，逐档字节摘要绑定见登记表",
    "logical_source 提取规则（T5）：先出可追溯依据及冲突/未知状态；无绑定依据的跨侧关联 HOLD；不能靠可能塌缩的 U 键或不唯一 F 键循环证明身份",
    "US 格式日期：5884 行可排除 D/M 解释（实证 M/D/Y），不证明其余歧义日期逐条正确；日期格式解析与业务日期裁定分开"
]

# ---------- meta.sha256 自洽（置空后 ensure_ascii=False, indent=2 重序列化）----------
fx["meta"]["sha256"] = ""
rec = hashlib.sha256(json.dumps(fx, ensure_ascii=False, indent=2).encode("utf-8")).hexdigest()
fx["meta"]["sha256"] = rec

out = os.path.join(HERE, "t1b_offline_fixture_v2p6.json")
with open(out, "w", encoding="utf-8") as f:
    json.dump(fx, f, ensure_ascii=False, indent=2)
print("wrote", out)
print("meta.sha256 =", rec)
print("counts: positive=%d negative=%d total=%d state_cases=%d projection_cases=%d" % (
    len(fx["positive_examples"]), len(fx["negative_examples"]),
    len(fx["positive_examples"]) + len(fx["negative_examples"]),
    len(fx["idempotency_state_model"]["cases"]), len(fx["projection_cases"])))
# 自检：expected_measure 分布
from collections import Counter
mc = Counter(ex.get("expected_measure") for ex in fx["positive_examples"] + fx["negative_examples"])
print("expected_measure:", dict(mc))
