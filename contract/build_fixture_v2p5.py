# -*- coding: utf-8 -*-
"""构建 t1b_offline_fixture_v2p5.json（v2p4 之后的全盘核查 + 五议题决议草案）。

v2p5 变更（相对 v2p4）——全部来自真实数据全量应用的实证（apply_pkc_to_real_data_v2p4.py）：
1. **投影规则 P 入合同**（Tom v2p3 阻断项「C 段映射放行」的正面回应）：新增
   projection_cases（PJ1-PJ8）——源行（prod/live 15 列与 archives 9 列前 9 列同构）
   → 规范 9 列视图逐列断言；日期多格式规范化（ISO / ISO+time 截断 / US M/D/Y，
   不存在日期原样保留交由 illegal_calendar）；请假标识派生；UUID 位原值。
   entities_versions.prod_C.schema_15_to_9_mapping 由 PENDING 改为 P 全文。
2. **E1 扩展伪键**（T3）：UUID 位常量标签 {'OFF-WORK / Leave', 'AUTO_LEAVE'} 一律
   pseudo_uuid_collapse——实证：AUTO_LEAVE 常量占 UUID 位 archives 3353 + live 1 +
   prod 2 行（20260824 单快照 334 路同键）；新增负例 N22。
3. **G1 payload 改业务内容口径**（T1）：冲突判定剔除提交时间（biz 口径）；同键同业务
   内容不硬隔离，改软标记——仅提交时间不同 → duplicate_entry（P21/P22），全同 →
   exact_duplicate（P23/P24）；同键异业务内容仍硬隔离（N11A/B 不变）。
4. P4 更名 AL-9（请假行带真实记录 ID → 正常路由），与常量 'AUTO_LEAVE' 区分。
5. example_counts：25 正 + 28 负 = 53；state model 15；projection_cases 8。
"""
import json, hashlib, os

HERE = os.path.dirname(os.path.abspath(__file__))
fx = json.load(open(os.path.join(HERE, "t1b_offline_fixture_v2p4.json"), encoding="utf-8"))

# ---------- 1. meta ----------
fx["meta"]["doc"] = ("T1-B 主键契约离线 fixture v2p5（v2p4 之后全盘核查+五议题决议草案："
                     "投影规则 P 入合同 + E1 扩展伪键 + G1 业务内容口径与软标记）")
fx["meta"]["rule_version"] = "PKC-v2p5"
fx["meta"]["algorithm"] = (
    "operation_identity_key = 结构化 JSON(source_event_id,op_type,rule_version,namespace,ver)；"
    "UPSERT ver=0 基版，CORRECT ver>=1 更正版本；payload_digest 单独存/比；state 仅在 created 或合法 "
    "versioned 时提交，conflict/rejected/idempotent 保持原状态；CORRECT 前序须为已接受记录且 ver 严格前驱"
    "(pred.ver=ver-1)+se/ns/rv 一致；重放须同身份+同摘要+同前序；硬失败(单例/G1/分页)先行确定，关系(G2/G3)"
    "随后不动点传播至稳定；投影 P：源行(前 9 列同构)→规范视图 [0]提交时间 [1]日期(canon_date 多格式规范化) "
    "[2]姓名 [3]类型 [4]项目编号(阶段列不进规范视图) [5]工时 [6]备注 [7]请假标识(派生) [8]UUID 原值；"
    "pseudo 扩展 E1：UUID 位常量标签 {'OFF-WORK / Leave','AUTO_LEAVE'} → pseudo_uuid_collapse；"
    "G1 payload 取业务内容(剔除提交时间)：同键同业务内容→软标记 duplicate_entry(仅提交时间不同)/"
    "exact_duplicate(全同) 不隔离，同键异业务内容→same_key_diff_content 硬隔离；"
    "boundary: union 16766 - leave_exclusion 5084 = 11682 - special_key1 = 11681")
fx["meta"]["expected_output_note"] = (
    "exit0 = 全部回归常量可复算 + 投影用例逐列相等 + 全部正/负例（含成组关系、映射校验、分页边界、更正链、"
    "软标记）分类与定位符合 PKC-v2p5 + 实际例数与 example_counts 声明一致；标注为提交方报告，非 Tom 独立运行")
fx["meta"]["example_counts"] = {"positive": 25, "negative": 28, "total": 53,
                                "state_model_cases": 15, "projection_cases": 8}

# ---------- 2. prod_C 15→9 映射：PENDING → P 全文 ----------
fx["entities_versions"]["prod_C"]["schema_15_to_9_mapping"] = (
    "P（v2p5 投影，待 Tom 确认后生效）：[0]=real[0] 提交时间；[1]=canon_date(real[1])（ISO / ISO+time 截断 / "
    "US M/D/Y → YYYY-MM-DD；不存在日期原样保留交由 illegal_calendar）；[2]=real[2] 姓名；[3]=real[3] 类型；"
    "[4]=real[5] 项目编号（真实布局的阶段列 real[4] 不进规范视图）；[5]=real[6] 工时；[6]=real[7] 备注；"
    "[7]=请假标识派生（real[4]=='休假' 或 real[5].upper()=='OFF-WORK' → 'LEAVE'，沿用既定 leave 语义保证边界链可复算）；"
    "[8]=real[8] UUID/来源记录键原值（空 → empty_required_key）。证据：prod_C 原始表头 15 列逐列确认 + live 15 列与 "
    "archives 9 列前 9 列同构首行比对 + 三侧全量应用交叉验证 7/7（见 t1b_real_data_application_20261023.json）")

# ---------- 3. 正例：P4 更名 + 新增 P21-P24 ----------
for ex in fx["positive_examples"]:
    if ex["id"] == "P4":
        ex["source_record_id"] = "AL-9"
        ex["row"][8] = "AL-9"
        ex["note"] = "请假行带真实记录 ID（非常量标签）→ 正常路由（与常量 'AUTO_LEAVE' 区分）"
fx["positive_examples"] += [
    {"id": "P21", "namespace": "prod", "source_record_id": "TS-DUP", "snapshot_id": "C-v20261015",
     "row": ["2026-10-10T09:00", "2026-10-10", "P-41", "WORK", "PRJ-D1", "8.0", "ok", "", "TS-DUP"],
     "expected_status": "normal", "expected_reason": "duplicate_entry",
     "note": "与 P22 同键同业务内容、仅提交时间不同 → 软标记 duplicate_entry（v2p4 full 口径会误判 same_key_diff_content）"},
    {"id": "P22", "namespace": "prod", "source_record_id": "TS-DUP", "snapshot_id": "C-v20261015",
     "row": ["2026-10-10T09:30", "2026-10-10", "P-41", "WORK", "PRJ-D1", "8.0", "ok", "", "TS-DUP"],
     "expected_status": "normal", "expected_reason": "duplicate_entry",
     "note": "重复录入（同一事件两次录入，业务内容全同）——实证：live 46 组中 45 组、prod 234 组中 224 组属此类"},
    {"id": "P23", "namespace": "prod", "source_record_id": "TS-EXACT", "snapshot_id": "C-v20261015",
     "row": ["2026-10-10T09:00", "2026-10-10", "P-42", "WORK", "PRJ-D2", "6.0", "ok", "", "TS-EXACT"],
     "expected_status": "normal", "expected_reason": "exact_duplicate",
     "note": "与 P24 全同（含提交时间）→ 软标记 exact_duplicate；聚合层 first-seen 去重（实证：prod 1544 组同键同内容）"},
    {"id": "P24", "namespace": "prod", "source_record_id": "TS-EXACT", "snapshot_id": "C-v20261015",
     "row": ["2026-10-10T09:00", "2026-10-10", "P-42", "WORK", "PRJ-D2", "6.0", "ok", "", "TS-EXACT"],
     "expected_status": "normal", "expected_reason": "exact_duplicate"}
]

# ---------- 4. 负例：新增 N22（E1 AUTO_LEAVE 伪键）----------
fx["negative_examples"] += [
    {"id": "N22", "namespace": "prod", "source_record_id": "AUTO_LEAVE", "snapshot_id": "C-v20261015",
     "row": ["2026-09-01T00:00", "2026-09-01", "P-40", "", "OFF-WORK", "8.0", "系统同步请假", "LEAVE", "AUTO_LEAVE"],
     "expected_status": "isolated", "expected_reason": "pseudo_uuid_collapse",
     "note": "E1：UUID 位为常量标签 'AUTO_LEAVE'（与 'OFF-WORK / Leave' 同类）→ pseudo；实证 archives 3353 + live 1 + prod 2 行"}
]

# ---------- 5. 投影用例（源→规范，逐列断言）----------
fx["projection_cases"] = [
    {"id": "PJ1", "side": "prod(15列)", "raw": ["2026-04-01 13:05:14", "2026-04-01", "P-1", "执行端", "2. 设计阶段",
      "24-074-SZ", "4", "招标答疑", "GUID:pj1", "Siemens | SZ", "PM-1", "SUP-1", "Signed", "2026-4", ""],
     "expected": ["2026-04-01 13:05:14", "2026-04-01", "P-1", "执行端", "24-074-SZ", "4", "招标答疑", "", "GUID:pj1"],
     "note": "prod 常规行 ISO 日期；阶段列丢弃；自动列丢弃"},
    {"id": "PJ2", "side": "prod(15列)", "raw": ["2026-04-02 09:00:00", "2026-04-01 0:00:00", "P-2", "执行端", "1. 投标",
      "26-045-BJ", "8", "效果图", "TS-pj2", "NOV | BJ", "", "SUP-2", "", "", ""],
     "expected": ["2026-04-02 09:00:00", "2026-04-01", "P-2", "执行端", "26-045-BJ", "8", "效果图", "", "TS-pj2"],
     "note": "ISO+time 日期截断为 YYYY-MM-DD（实证 archives 18327 + prod 4729 + live 4383 行）"},
    {"id": "PJ3", "side": "archives(9列)", "raw": ["4/1/2026 13:05:14", "8/2/2024", "P-3", "执行端", "2. 设计阶段",
      "24-074-SZ", "4", "备注", "GUID:pj3"],
     "expected": ["4/1/2026 13:05:14", "2024-08-02", "P-3", "执行端", "24-074-SZ", "4", "备注", "", "GUID:pj3"],
     "note": "US M/D/Y → ISO（实证：首分量 1-12、次分量 1-31、5884 行次分量>12 → M/D/Y；archives 9605 行）"},
    {"id": "PJ4", "side": "prod(15列)", "raw": ["2026-09-05 06:29:37", "2026-07-24", "P-4", "休假", "OFF-WORK",
      "OFF-WORK", "8.0", "系统同步请假", "LEAVE-pj4", "OFF-WORK / Leave", "", "", "", "2026-7", ""],
     "expected": ["2026-09-05 06:29:37", "2026-07-24", "P-4", "休假", "OFF-WORK", "8.0", "系统同步请假", "LEAVE", "LEAVE-pj4"],
     "note": "LEAVE- 行：UUID 位为真实记录 ID（非常量）→ 正常路由；请假标识派生；自动列常量标签不进规范视图"},
    {"id": "PJ5", "side": "archives(9列)", "raw": ["8/29/2026 06:30:23", "2023-07-27", "P-5", "OFF-WORK",
      "OFF-WORK", "8", "系统同步请假 | P-5 on leave", "LEAVE-pj5", "OFF-WORK / Leave"],
     "expected": ["8/29/2026 06:30:23", "2023-07-27", "P-5", "OFF-WORK", "8", "系统同步请假 | P-5 on leave", "LEAVE-pj5", "", "OFF-WORK / Leave"],
     "note": "mangled 伪行（备注位=真实 recordId、UUID 位=常量标签）；请假标识按既定 leave 语义两条件均不满足故为空——该行由 pseudo 规则隔离不经 leave 路由"},
    {"id": "PJ6", "side": "prod(15列)", "raw": ["2026-07-09 21:16:27", "2026-05-01", "P-6", "", "休假", "OFF-WORK",
      "8.0", "系统同步请假", "AUTO_LEAVE", "休假/非工作", "", "SUP-6", "", "2026-5", ""],
     "expected": ["2026-07-09 21:16:27", "2026-05-01", "P-6", "", "OFF-WORK", "8.0", "系统同步请假", "LEAVE", "AUTO_LEAVE"],
     "note": "AUTO_LEAVE 行：UUID 位为常量标签 → 投影后由 E1 判 pseudo；请假标识由阶段=='休假' 派生"},
    {"id": "PJ7", "side": "archives(9列)", "raw": ["4/1/2026 13:05:14", "2/30/2026", "P-7", "执行端", "2. 设计阶段",
      "24-074-SZ", "4", "备注", "GUID:pj7"],
     "expected": ["4/1/2026 13:05:14", "2/30/2026", "P-7", "执行端", "24-074-SZ", "4", "备注", "", "GUID:pj7"],
     "note": "US 格式但日期不存在 → canon_date 原样保留，下游 valid_calendar 判 illegal_calendar（格式问题与历法问题分离）"},
    {"id": "PJ8", "side": "live(15列)", "raw": ["2026-04-01 13:05:14", "2026-04-01 0:00:00", "P-8", "执行端", "2. 设计阶段",
      "24-074-SZ", "4", "招标答疑、建筑答疑", "70a16c63-e559-4db0-9f95-30e2158f3ca1", "Siemens Healthineers | Shenzhen | Design",
      "PM-8", "SUP-8", "Signed", "", ""],
     "expected": ["2026-04-01 13:05:14", "2026-04-01", "P-8", "执行端", "24-074-SZ", "4", "招标答疑、建筑答疑", "", "70a16c63-e559-4db0-9f95-30e2158f3ca1"],
     "note": "live 15 列与 prod 同构投影（PM/主管列已假名化；自动列丢弃）"}
]

# ---------- 6. state model 的 rule_version 对齐 v2p5 ----------
for c in fx["idempotency_state_model"]["cases"]:
    c["rule_version"] = "PKC-v2p5"
fx["idempotency_state_model"]["note"] = fx["idempotency_state_model"]["note"].replace("PKC-v2p4", "PKC-v2p5")

# ---------- 7. 覆盖矩阵 ----------
cov = fx["coverage_matrix"]
cov["implemented_and_asserted"] = cov["implemented_and_asserted"] + [
    "projection: 源→规范 9 列映射逐列断言（PJ1-PJ8：prod/live 15 列与 archives 9 列前 9 列同构；日期多格式规范化 ISO/ISO+time/US M/D/Y，不存在日期原样保留；请假标识派生；UUID 位原值；自动列与阶段列丢弃）",
    "pseudo E1: UUID 位常量标签 {'OFF-WORK / Leave','AUTO_LEAVE'} → pseudo_uuid_collapse（N5/N22；实证另覆盖 AUTO_LEAVE 3356 行）",
    "G1 payload 业务内容口径（biz，剔除提交时间）：同键同业务内容不判冲突；软标记 duplicate_entry（仅提交时间不同 P21/P22）/ exact_duplicate（全同 P23/P24）；同键异业务内容仍硬隔离（N11A/B）；软标记不改变 status（仍 normal），聚合层 first-seen 去重",
    "请假路由: LEAVE-/AL- 真实记录 ID 行正常路由（P3/P4），常量标签行 pseudo（N5/N22）——两条路径互斥"
]
cov["doc_only_or_pending"] = [x for x in cov["doc_only_or_pending"]
                              if not x.startswith("prod_C 15→9 字段映射")] + [
    "两层口径（T4）：契约视图管行级可信度（空 UUID → empty_required_key 隔离），合并层 key_of F: 键管聚合复算（union 16766 含 F: 键）；换算表见合同，禁混用——文档声明",
    "软标记的聚合语义（first-seen 去重）属合并层既定行为，合同仅声明不重复实现",
    "跨侧 logical_source 提取规则（T5）：文档定义；真实数据应用标注「未应用」，G2/G3 正确性由 fixture 保证"
]

# ---------- meta.sha256 自洽（置空后 ensure_ascii=False, indent=2 重序列化）----------
fx["meta"]["sha256"] = ""
rec = hashlib.sha256(json.dumps(fx, ensure_ascii=False, indent=2).encode("utf-8")).hexdigest()
fx["meta"]["sha256"] = rec

out = os.path.join(HERE, "t1b_offline_fixture_v2p5.json")
with open(out, "w", encoding="utf-8") as f:
    json.dump(fx, f, ensure_ascii=False, indent=2)
print("wrote", out)
print("meta.sha256 =", rec)
print("counts: positive=%d negative=%d total=%d state_cases=%d projection_cases=%d" % (
    len(fx["positive_examples"]), len(fx["negative_examples"]),
    len(fx["positive_examples"]) + len(fx["negative_examples"]),
    len(fx["idempotency_state_model"]["cases"]), len(fx["projection_cases"])))
