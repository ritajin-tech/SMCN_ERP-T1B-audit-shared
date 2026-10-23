# -*- coding: utf-8 -*-
"""构建 t1b_offline_fixture_v2p7.json（按 Tom 2026-10-23 23:58「v2p6 合并审核」修订）。

v2p7 变更（相对 v2p6）——逐条对应 Tom 23:58 五点 + 源级/隐私边界：
1. **原行 full 与规范视图 full 分名**（Tom 一）：
   - 测量层 exact_duplicate 更名 **normalized_view_equal**（规范视图相等，**不宣称原行相等**）；
   - 新增 **source_conflict**：规范视图相同但原始行不同 -> 进入**硬判定** isolated/source_conflict
     （待业务裁定，不宣称精确重复、不宣称恢复正常）。
   - N24/N24b 由正例 normal/ok + exact_duplicate 改为**负例 isolated/source_conflict**
     （此前 source_field_diff 仅诊断不改硬判定 = 原行差异被放行）。
2. **日期规则统一**（Tom 二）：canon_date 抽为单一实现 t1b_canon_date_v2p7.py，
   并补**时间分量范围校验**（HH<=23/MM<=59/SS<=59）——形状匹配不等于时间有效。
   新增负例 PJ14（`2026-04-01 99:99` 不截断 -> illegal_calendar）、边界正例 PJ15（23:59:59 截断）。
3. **accepted tag 边界**（Tom 四）：采用「前驱按稳定版本坐标绑定 + 别名规范化」——
   重放比较前驱的**(se,rv,ns,ver) 版本坐标**而非字面 tag；v1d（同 UPSERT 身份的别名
   E1-upsert-2）期望由 conflict 改为 **idempotent**；新增 E2-upsert-1(created) 与
   E1-correct-v1f（**异身份**前驱 -> rejected，证明异身份由前序校验拦截而非 conflict）。
4. 例数随实际更新：23 正 + 34 负 = 57；state model 17；projection_cases 15。
5. 覆盖矩阵：19 档 schema 登记由 doc_only 移入 implemented（§0.10 已交付）。
"""
import json, hashlib, os

HERE = os.path.dirname(os.path.abspath(__file__))
fx = json.load(open(os.path.join(HERE, "t1b_offline_fixture_v2p6.json"), encoding="utf-8"))

# ---------- 1. meta ----------
fx["meta"]["doc"] = ("T1-B 主键契约离线 fixture v2p7（按 Tom 23:58 合并审核修订："
                     "原行 full 与规范视图 full 分名 + source_conflict 硬判定；"
                     "canon_date 单一实现 + 时间分量范围校验；前驱按稳定版本坐标绑定、别名规范化）")
fx["meta"]["rule_version"] = "PKC-v2p7"
fx["meta"]["algorithm"] = (
    "operation_identity_key = 结构化 JSON(source_event_id,op_type,rule_version,namespace,ver)；"
    "UPSERT ver=0 基版，CORRECT ver>=1 更正版本；payload_digest 单独存/比；state 仅在 created 或合法 "
    "versioned 时提交，conflict/rejected/idempotent 保持原状态；"
    "**前序绑定（v2p7，Tom 23:58 四）**：CORRECT 前序须为已接受记录、ver 严格前驱(pred.ver=ver-1)、"
    "se/ns/rv 一致；**重放比较前驱的稳定版本坐标 (se,rv,ns,ver) 而非字面 tag** —— accepted[tag] 为请求别名，"
    "同身份不同 tag 的重放按 idempotent 处理（v1d：E1-upsert-2 与 E1-upsert-1 同身份）；"
    "异身份前驱由前序校验拦截为 rejected（E1-correct-v1f），不当 conflict；"
    "硬失败(单例/G1/分页)先行确定，关系(G2/G3)随后不动点传播至稳定；"
    "投影 P：源行(前 9 列同构)→规范视图 [0]提交时间 [1]日期(canon_date 多格式规范化) [2]姓名 [3]类型 "
    "[4]项目编号(阶段列不进规范视图) [5]工时 [6]备注 [7]请假标识(派生) [8]UUID 原值——P 为派生视图，"
    "原始行在冻结副本完整保留；pseudo E1：UUID 位常量标签 {'OFF-WORK / Leave','AUTO_LEAVE'} → 离线异常候选 "
    "pseudo_uuid_collapse（不据此判可删除）；"
    "**G1 双轨（v2p6 起）**：硬判定层取 normalized_view_full（规范视图全行含提交时间）——同键多例且规范视图不同 → "
    "same_key_diff_content 硬隔离（不为降低隔离数选口径）；"
    "**原行差异不得被放行（v2p7，Tom 23:58 一）**：规范视图相同但 source_full（原始行摘要）不同 → "
    "硬判定 isolated/source_conflict（待业务裁定；保留原行只是可追溯，不等于原行差异未被放行）；"
    "并列测量层（不改硬判定）：normalized_view_equal（规范视图相等，无原行信息或原行亦同）/ "
    "source_conflict（规范视图同、原行异）/ duplicate_entry（仅提交时间不同）——不宣称恢复正常/有效计薪/同一事件；"
    "first-seen 仅作聚合复算既定代表选择；"
    "**project 布局校验**：仅接受 9 / 15 列；其他列宽（10/14/16 等）→ schema_width_mismatch，短行（<9）→ "
    "missing_column，不静默取前九列；"
    "**canon_date（v2p7 单一实现 t1b_canon_date_v2p7.py）**：ISO / ISO+时间尾串（**且 HH<=23、MM<=59、SS<=59**）/ "
    "US M/D/Y；形状匹配但分量超范围（如 99:99）**不截断**，非白名单尾串不截断——不把格式错误悄然合法化；"
    "业务日期有效性不由解析器裁定；"
    "boundary: union 16766 - leave_exclusion 5084 = 11682 - special_key1 = 11681")
fx["meta"]["expected_output_note"] = (
    "exit0 = 全部回归常量可复算 + 投影用例逐列相等 + 路由端到端 + 全部正/负例（含成组关系、映射校验、分页边界、"
    "更正链、原行冲突）分类与定位符合 PKC-v2p7 + 并列测量层 expected_measure 断言一致 + "
    "实际例数与 example_counts 声明一致 + D 段完整必需集合（4 deliverables + 6 supporting + 1 依赖 + live 字节）"
    "及三类负向自检；标注为提交方报告，非 Tom 独立运行")
fx["meta"]["example_counts"] = {"positive": 23, "negative": 34, "total": 57,
                                "state_model_cases": 17, "projection_cases": 15}

# ---------- 2. 测量层更名：exact_duplicate -> normalized_view_equal ----------
RENAME = {"P23", "P24", "N23", "N23b"}
for sec in ("positive_examples", "negative_examples"):
    for ex in fx[sec]:
        if ex["id"] in RENAME and ex.get("expected_measure") == "exact_duplicate":
            ex["expected_measure"] = "normalized_view_equal"
            ex["note"] = (ex.get("note", "") +
                          "；v2p7 更名：exact_duplicate -> normalized_view_equal（规范视图相等，"
                          "**不宣称原始行相等**；本例未携带 source_row，原行是否相同未核验）").strip("；")

# ---------- 3. N24/N24b：原行差异进入硬判定 -> isolated/source_conflict ----------
moved = [ex for ex in fx["positive_examples"] if ex["id"] in ("N24", "N24b")]
for ex in moved:
    ex["expected_status"] = "isolated"; ex["expected_reason"] = "source_conflict"
    ex["expected_measure"] = "source_conflict"; ex["expected_source_field_diff"] = True
    if ex["id"] == "N24":
        ex["note"] = ("原行差异不得被放行（Tom 23:58 一）：与 N24b 原始行仅阶段列不同（2. 设计阶段 vs 3. 施工阶段，"
                      "均不触发 LEAVE）→ 投影后规范视图全同、biz 亦同，差异被投影折叠。**v2p7 将原行摘要差异纳入硬判定**："
                      "isolated/source_conflict（待业务裁定）——不宣称这两例是原始精确重复、不宣称恢复正常；"
                      "阶段/自动列是否排除尚无业务批准")
    else:
        ex["note"] = ("同 N24（阶段差异对例）：证明『biz 相同』不等于『原始行相同』——不得凭减少隔离面证明口径正确；"
                      "v2p7 起进硬判定 source_conflict")
fx["positive_examples"] = [ex for ex in fx["positive_examples"] if ex["id"] not in ("N24", "N24b")]
fx["negative_examples"] += moved

# ---------- 4. 投影：PJ14（时间分量超范围不截断）/ PJ15（边界合法截断）----------
fx["projection_cases"] += [
    {"id": "PJ14", "side": "archives(9列)",
     "raw": ["2026-04-01 99:99:00", "2026-04-01 99:99", "P-14", "执行端", "2. 设计阶段",
             "24-074-SZ", "4", "备注", "GUID:pj14"],
     "expected": ["2026-04-01 99:99:00", "2026-04-01 99:99", "P-14", "执行端", "24-074-SZ", "4", "备注", "", "GUID:pj14"],
     "expected_route": "illegal_calendar",
     "note": "canon_date 时间尾串白名单**并校验分量范围**（HH<=23/MM<=59/SS<=59）：形状匹配不等于时间有效——"
             "99:99 不被截断，原值交 valid_calendar 判 illegal_calendar（Tom 23:58 二）"},
    {"id": "PJ15", "side": "archives(9列)",
     "raw": ["2026-04-01 23:59:59", "2026-04-01 23:59:59", "P-15", "执行端", "2. 设计阶段",
             "24-074-SZ", "4", "备注", "GUID:pj15"],
     "expected": ["2026-04-01 23:59:59", "2026-04-01", "P-15", "执行端", "24-074-SZ", "4", "备注", "", "GUID:pj15"],
     "expected_route": "ok",
     "note": "分量范围边界正例：23:59:59 合法 -> 截断为 2026-04-01（与 PJ14 对照，证明范围校验有正向接受面）"}
]

# ---------- 5. state model：rv 对齐 v2p7 + v1d 改 idempotent + 异身份前驱负例 ----------
for c in fx["idempotency_state_model"]["cases"]:
    c["rule_version"] = "PKC-v2p7"
    if c["tag"] == "E1-correct-v1d":
        c["expected"] = "idempotent"
        c["note"] = ("同摘要、前序换成**同一稳定身份的别名** E1-upsert-2 -> idempotent（v2p7：前驱按稳定版本坐标 "
                     "(se,rv,ns,ver) 绑定，别名规范化，重放不再比较字面 tag；v2p6 曾比较字面 tag 判 conflict，"
                     "与『tag 为请求别名』表述不一致——Tom 23:58 四）")
fx["idempotency_state_model"]["cases"] += [
    {"tag": "E2-upsert-1", "source_event_id": "E2", "op": "UPSERT", "rule_version": "PKC-v2p7",
     "namespace": "prod", "ver": 0, "payload_digest": "dB", "predecessor": None, "expected": "created",
     "note": "另一事件 E2 的 UPSERT 基版（供异身份前驱负例使用）-> created"},
    {"tag": "E1-correct-v1f", "source_event_id": "E1", "op": "CORRECT", "rule_version": "PKC-v2p7",
     "namespace": "prod", "ver": 1, "payload_digest": "dC", "predecessor": "E2-upsert-1", "expected": "rejected",
     "note": "异身份前驱（E2 的 UPSERT 作为 E1 更正的前序）-> rejected：由前序存在性/se/ns/rv 一致性校验拦截，"
             "**不是** conflict（v2p7 明确：同身份别名 -> idempotent；异身份 -> rejected）"}
]
fx["idempotency_state_model"]["note"] = fx["idempotency_state_model"]["note"].replace("PKC-v2p6", "PKC-v2p7")

# ---------- 6. 覆盖矩阵 ----------
cov = fx["coverage_matrix"]
cov["implemented_and_asserted"] = [
    "G1 双轨（v2p6 T1，沿用）：硬判定层 normalized_view_full（规范视图全行含提交时间）→ 同键多例且规范视图不同 = same_key_diff_content 硬隔离（P21/P22 负例）；不为降低隔离数选口径",
    "**原行 full 与规范视图 full 分名 + source_conflict 硬判定（v2p7，Tom 23:58 一）**：G1/测量层此前只取投影后 row；N24/N24b 原行阶段不同却曾断言 normal/ok + exact_duplicate、source_field_diff 仅诊断不改判定 —— v2p7 将原行摘要差异纳入硬判定 isolated/source_conflict（待业务裁定），测量层 exact_duplicate 更名 normalized_view_equal（不宣称原行相等）",
    "并列测量层（不改硬判定）：normalized_view_equal / source_conflict / duplicate_entry（仅提交时间不同）逐例 expected_measure 断言；不宣称恢复正常/有效计薪/同一事件；first-seen 仅聚合复算代表选择",
    "**日期规则统一 + 时间分量范围校验（v2p7，Tom 23:58 二）**：canon_date 抽为单一实现 t1b_canon_date_v2p7.py（主测试/layer_conversion/schema_registry 统一 import）；HH<=23/MM<=59/SS<=59；99:99 不截断 -> illegal_calendar（PJ14）、23:59:59 截断（PJ15）",
    "**D 段完整必需集合校验（v2p7，Tom 23:58 三）**：固定必需条目集合（4 deliverables + 6 supporting + 1 依赖）多/少/缺整段均 FAIL；live_scrubbed.json 实际字节比对；三类负向自检（删清单键/删 supporting 段/替换 live SHA）证明校验真的会失败",
    "**前驱按稳定版本坐标绑定 + 别名规范化（v2p7，Tom 23:58 四）**：重放比较前驱 (se,rv,ns,ver) 而非字面 tag；v1d 同身份别名 -> idempotent；异身份前驱 -> rejected（E1-correct-v1f）",
    "**19 档逐档 schema 登记与行级 schema 路由（v2p6 §0.10 已交付）**：19 档 102723 行全 9 列、无列宽异构；错位 4568 行 100% 归 20260831 单档；前两列空 3166 三分解 2367+208+591；列宽一致 ≠ 字段语义一致（不升级认证）",
    "投影 P 布局校验前置：仅接受 9/15 列；其他列宽 -> schema_width_mismatch，短行 -> missing_column，不静默取前九列（PJ10-PJ13）",
    "实现边界登记（Tom 22:17）：UPSERT ver=0/CORRECT ver>=1 无入口强制校验；accepted 别名 tag 与稳定身份定义；关系组完整坐标重复诊断（N23/N23b）",
    "T4 三层分开：契约行级隔离（本 fixture）/ 聚合 F 键回退 / 业务可用性（待有权方）——互斥完备换算表见合同；F 键可复现不等于身份 PROVEN",
    "报告口径修正：11682 含表头与 11681 数据行不同分母不可相减；724fef64/ad3788f0/9bd8bb74 为冻结/对账材料指纹，非 PKC 轮次"
]
cov["doc_only_or_pending"] = [
    "业务内容字段清单裁定（原行差异哪些属业务、哪些属采集/自动列）：阶段列不在 biz 清单是投影定义结果，非业务裁定；source_conflict 的最终裁决待有权方",
    "logical_source 提取规则（T5）：先出可追溯依据及冲突/未知状态；无绑定依据的跨侧关联 HOLD",
    "US 格式日期：5884 行可排除 D/M 解释（实证 M/D/Y），不证明其余歧义日期逐条正确；日期格式解析与业务日期裁定分开",
    "表头实际来源 / leave_sync.js 源码身份：未持有，保持未核验；档名日期为副本内嵌标签，非经独立验证的采集时间",
    "4568 矩阵「冻结证据 vs 提交方源码描述/未核验」分列；主库 7 门槛；历史引用/集合互斥完备/确定性"
]

# ---------- meta.sha256 自洽（置空后 ensure_ascii=False, indent=2 重序列化）----------
fx["meta"]["sha256"] = ""
rec = hashlib.sha256(json.dumps(fx, ensure_ascii=False, indent=2).encode("utf-8")).hexdigest()
fx["meta"]["sha256"] = rec

out = os.path.join(HERE, "t1b_offline_fixture_v2p7.json")
with open(out, "w", encoding="utf-8") as f:
    json.dump(fx, f, ensure_ascii=False, indent=2)
print("wrote", out)
print("meta.sha256 =", rec)
print("counts: positive=%d negative=%d total=%d state_cases=%d projection_cases=%d" % (
    len(fx["positive_examples"]), len(fx["negative_examples"]),
    len(fx["positive_examples"]) + len(fx["negative_examples"]),
    len(fx["idempotency_state_model"]["cases"]), len(fx["projection_cases"])))
from collections import Counter
mc = Counter(ex.get("expected_measure") for ex in fx["positive_examples"] + fx["negative_examples"])
print("expected_measure:", dict(mc))
