# -*- coding: utf-8 -*-
"""T1-B PKC-v2p4 真实数据应用报告 v2（只读，不碰生产）。

修正记录（v1→v2）：
- v1 直接把契约测试的 classify_single 套在真实行上，列语义错位：
  契约规范视图 [4]=项目 [5]=工时 [6]=备注 [7]=请假标识，
  而真实布局 [4]=阶段 [5]=项目编号 [6]=工时 [7]=备注（无请假标识）。
- v1 漏掉测试中的 empty_required_key 分支（sid 空 → isolated）。
- v1 日期校验只认 %Y-%m-%d，真实数据存在 ISO+time / US(M/D/YYYY) 格式，
  会把格式差异误判为 illegal_calendar。
v2 定义显式投影 P（源→规范映射，v2 文档 §3 要求的 15→9/9→9 路由），
先投影到规范视图再分类；边界数学链仍按既定定义原样复算（F: 回退键属合并层）。

投影规则 P（证据：prod C 原始表头 + live 同构验证 + archives 规范视图语义一致
+ fixture normalized_sample_schema 声明）：
  P[0]=real[0] 提交时间
  P[1]=canon_date(real[1])             # ISO / ISO+time / US M/D/Y → YYYY-MM-DD
  P[2]=real[2] 姓名
  P[3]=real[3] 类型
  P[4]=real[5] 项目编号                # 真实布局的 阶段(real[4]) 不进规范视图
  P[5]=real[6] 工时
  P[6]=real[7] 备注
  P[7]='LEAVE' if (real[4]=='休假' or real[5].upper()=='OFF-WORK') else ''  # 请假标识（派生，沿用既定 leave 语义）
  P[8]=real[8] UUID/来源记录键（原样；空 → empty_required_key）

分类逻辑逐字复刻 t1b_offline_test_v2p4.py 的 classify_single + G1 既定行为
（G1 同 (ns,snap,sid) 多例且 payload 不同 → 覆写为 same_key_diff_content；
G1 跳过空 sid）。扩展伪键规则 E1（单列计数，不混入合同字面结果）：
UUID 位为常量标签 {'OFF-WORK / Leave', 'AUTO_LEAVE'} → pseudo_uuid_collapse。
"""
import sys, os, json, hashlib, math, re, datetime, collections
HERE = os.path.dirname(os.path.abspath(__file__))
SCRUB = os.path.join(HERE, "..", "20261014_frozen_scrubbed")
sys.path.insert(0, os.path.abspath(SCRUB))
import offline_recompute_scrubbed as O

PSEUDO_CONSTANTS = ("OFF-WORK / Leave", "AUTO_LEAVE")   # UUID 位常量标签（E1 扩展集）

def ph(v):
    try:
        f = float(v)
        if math.isnan(f) or math.isinf(f): return None
        return f
    except (TypeError, ValueError): return None

def canon_date(v):
    """日期规范化：ISO / ISO+time / US(M/D/Y) → YYYY-MM-DD；空 → ''；其余原样返回（将判 illegal）。"""
    s = O.s(v)
    if s == "": return ""
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s): return s
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}[ T].*", s): return s[:10]
    m = re.fullmatch(r"(\d{1,2})/(\d{1,2})/(\d{4})", s)
    if m:
        mo, dy, yr = int(m.group(1)), int(m.group(2)), int(m.group(3))
        try:
            datetime.date(yr, mo, dy); return "%04d-%02d-%02d" % (yr, mo, dy)
        except ValueError:
            return s
    return s

def valid_calendar(s):
    if not s: return False
    try:
        datetime.datetime.strptime(s, "%Y-%m-%d"); return True
    except ValueError:
        return False

def project(real):
    """源行（archives 9 列 / live·prod 15 列，前 9 列同构）→ 契约规范 9 列视图。"""
    return [O.s(real[0]), canon_date(real[1]), O.s(real[2]), O.s(real[3]),
            O.s(real[5]), O.s(real[6]), O.s(real[7]),
            "LEAVE" if (O.s(real[4]) == "休假" or O.s(real[5]).upper() == "OFF-WORK") else "",
            O.s(real[8])]

def payload_of(row9):
    return hashlib.sha256(json.dumps(list(row9), sort_keys=True, ensure_ascii=False).encode()).hexdigest()

def classify_single(row9, sid):
    """逐字复刻 v2p4 测试 classify_single（sid 来自 UUID 位原值）。"""
    if len(row9) < 9: return "missing_column"
    if len(row9) > 9: return "schema_width_mismatch"
    if all(O.s(x) == "" for x in row9): return "placeholder_empty_row"
    if not sid: return "empty_required_key"
    if O.s(row9[8]) == "OFF-WORK / Leave": return "pseudo_uuid_collapse"
    cal = O.s(row9[1])
    if cal == "": return "empty_date"
    if not valid_calendar(cal): return "illegal_calendar"
    hv = O.s(row9[5])
    if hv.upper() == "NAN": return "non_finite_nan"
    if hv.upper() in ("INFINITY", "INF"): return "non_finite_inf"
    if O.s(row9[4]).upper() != "OFF-WORK" and ph(row9[5]) is None: return "non_finite_hours"
    return "ok"

report = {"report": "T1-B PKC-v2p4 真实数据应用 v2（提交方只读运行，非 Tom 独立运行）",
          "generated": "2026-10-23T12:00:00+08:00",
          "projection_P": {
              "rule": "P[0]=real[0]; P[1]=canon_date(real[1]); P[2]=real[2]; P[3]=real[3]; "
                      "P[4]=real[5](项目编号); P[5]=real[6](工时); P[6]=real[7](备注); "
                      "P[7]=请假标识(派生); P[8]=real[8](UUID 原样)",
              "evidence": "prod C 原始表头（15 列，前 9 列与 live/archives 同构）+ live 同构首行比对 "
                          "+ fixture meta.normalized_sample_schema 声明 + v2 文档 §3『不冒称原 C 布局即规范』",
              "status": "投影规则待 v2p5 合同确认（Tom/AI 双方），本报告数值均基于 P"
          },
          "sources": {}}

def apply_side(name, ns, snap, rows_iter, total_hint=None):
    """单侧全量：投影 → 单例分类 → G1（既定行为覆写）→ final 计数。

    G1 双口径并列：
    - full（测试字面）：payload = 规范视图全行（含提交时间）——与 t1b_offline_test_v2p4.py
      的 payload_of 一致；fixture 未构造「仅提交时间不同」用例，口径由定义继承、未经用例显式钉死；
    - biz（业务内容）：payload = 规范视图剔除 P[0] 提交时间——同一事件重复录入（仅时间戳不同）
      不判冲突。两侧口径差异即 v2p5 待明确项。
    """
    single = collections.Counter()
    e1_extra = 0            # 扩展伪键 E1 额外捕获（AUTO_LEAVE 常量标签）
    key_full = collections.defaultdict(list)
    key_biz = collections.defaultdict(list)
    n = 0
    for real in rows_iter:
        n += 1
        row9 = project(real)
        sid = O.s(real[8])
        rsn = classify_single(row9, sid)
        single[rsn] += 1
        if rsn != "pseudo_uuid_collapse" and sid in PSEUDO_CONSTANTS:
            e1_extra += 1
        if sid:
            key_full[(ns, snap, sid)].append((rsn, payload_of(row9)))
            key_biz[(ns, snap, sid)].append((rsn, payload_of(row9[1:])))
    g1_groups = 0; g1_rows = 0; g1_from = collections.Counter()
    for k, lst in key_full.items():
        if len(lst) >= 2 and len({p for _, p in lst}) > 1:
            g1_groups += 1; g1_rows += len(lst)
            for rsn, _ in lst:
                g1_from[rsn] += 1
    biz_groups = 0; biz_rows = 0
    for k, lst in key_biz.items():
        if len(lst) >= 2 and len({p for _, p in lst}) > 1:
            biz_groups += 1; biz_rows += len(lst)
    final = dict(single)
    if g1_rows:
        final["same_key_diff_content"] = final.get("same_key_diff_content", 0) + g1_rows
        for rsn, cnt in g1_from.items():
            final[rsn] = final.get(rsn, 0) - cnt
            if final[rsn] <= 0: del final[rsn]
    multi_rule = sum(g1_from.values())
    return {"rows": n, "single_rule_counts": dict(single),
            "extended_pseudo_E1_extra": e1_extra,
            "g1": {"groups": g1_groups, "rows_overridden": g1_rows,
                   "overridden_from_reasons": dict(g1_from),
                   "payload_basis": "full（规范视图全行含提交时间，测试字面）",
                   "alt_business_content_payload": {"groups": biz_groups, "rows_overridden": biz_rows,
                                                    "payload_basis": "biz（剔除提交时间；同一事件重复录入不判冲突）"}},
            "final_counts_after_g1_override": final,
            "multi_rule_rows": multi_rule}

# ---------- archives（19 档全量，ns=archive:<档名>, snap=ARCH-v19）----------
arch = O.load("archives_scrubbed.json")
# 逐档应用（每档独立快照）
arch_side = {"rows": 0, "single_rule_counts": collections.Counter(),
             "g1_groups": 0, "g1_rows": 0, "g1_from": collections.Counter(),
             "biz_groups": 0, "biz_rows": 0, "e1_extra": 0}
for a in arch:
    part = apply_side("archive:" + a["name"], "archive:" + a["name"], "ARCH-v19",
                      (r for _srow, r in a["rows"]))
    arch_side["rows"] += part["rows"]
    arch_side["single_rule_counts"].update(part["single_rule_counts"])
    arch_side["g1_groups"] += part["g1"]["groups"]
    arch_side["g1_rows"] += part["g1"]["rows_overridden"]
    arch_side["g1_from"].update(part["g1"]["overridden_from_reasons"])
    arch_side["biz_groups"] += part["g1"]["alt_business_content_payload"]["groups"]
    arch_side["biz_rows"] += part["g1"]["alt_business_content_payload"]["rows_overridden"]
    arch_side["e1_extra"] += part["extended_pseudo_E1_extra"]
arch_final = dict(arch_side["single_rule_counts"])
if arch_side["g1_rows"]:
    arch_final["same_key_diff_content"] = arch_final.get("same_key_diff_content", 0) + arch_side["g1_rows"]
    for rsn, cnt in arch_side["g1_from"].items():
        arch_final[rsn] = arch_final.get(rsn, 0) - cnt
        if arch_final[rsn] <= 0: del arch_final[rsn]
report["sources"]["archives"] = {
    "rows": arch_side["rows"], "snapshots": len(arch),
    "single_rule_counts": dict(arch_side["single_rule_counts"]),
    "extended_pseudo_E1_extra": arch_side["e1_extra"],
    "g1": {"groups": arch_side["g1_groups"], "rows_overridden": arch_side["g1_rows"],
           "overridden_from_reasons": dict(arch_side["g1_from"]),
           "payload_basis": "full（规范视图全行含提交时间，测试字面）",
           "alt_business_content_payload": {"groups": arch_side["biz_groups"],
                                            "rows_overridden": arch_side["biz_rows"],
                                            "payload_basis": "biz（剔除提交时间；同一事件重复录入不判冲突）"}},
    "final_counts_after_g1_override": arch_final,
    "multi_rule_rows": sum(arch_side["g1_from"].values()),
    "note": "G1 按交付测试既定行为覆写 reason（含 pseudo 行被覆写为 same_key_diff_content）；"
            "优先级明确建议列入 v2p5"}

# ---------- live（单快照全量）----------
live = O.load("live_scrubbed.json")
report["sources"]["live"] = apply_side("live", "live", "LIVE-v20261014",
                                       (r for _srow, r in live["rows"]))

# ---------- prod C（15 列原始，本地冻结副本，SHA 已绑 manifest）----------
PROD = os.path.join(HERE, "..", "..", "..", "..", "..", "Users", "rita.jin", "AppData", "Local", "Temp", "prod_DB_1015_copy.json")
prod_path = None
for cand in (os.path.join(os.environ.get("TEMP", ""), "prod_DB_1015_copy.json"),
             os.path.expanduser("~/AppData/Local/Temp/prod_DB_1015_copy.json")):
    if os.path.exists(cand):
        prod_path = cand; break
prod_side = None
if prod_path:
    pj = json.load(open(prod_path, encoding="utf-8"))
    prod_side = apply_side("prod", "prod", "C-v20261015",
                           (r for r in pj["values"][1:] if len(r) >= 9))
    # prod 重复键结构：同键同内容（精确重复，合同不隔离）vs 同键异内容（G1）
    dup_same = 0; dup_diff = 0; dup_groups = 0
    ki = collections.defaultdict(list)
    for r in pj["values"][1:]:
        if len(r) < 9: continue
        sid = O.s(r[8])
        if sid: ki[sid].append(payload_of(project(r)))
    for sid, lst in ki.items():
        if len(lst) >= 2:
            dup_groups += 1
            if len(set(lst)) > 1: dup_diff += 1
            else: dup_same += 1
    prod_side["duplicate_structure"] = {
        "dup_key_groups": dup_groups, "same_key_diff_content_groups": dup_diff,
        "same_key_same_content_groups": dup_same,
        "note": "合同 G1 仅隔离同键异内容；同键同内容（精确重复）当前不隔离——v2p5 待明确"}
report["sources"]["prod_C"] = prod_side if prod_side else {
    "status": "prod 原始副本未找到（Temp 清理），仅登记扫描级规则映射"}
if prod_side is None:
    scan = json.load(open(os.path.join(HERE, "..", "scan_all3_result_v2_corrected.json"), encoding="utf-8"))
    p = scan["PROD"]
    report["sources"]["prod_C"] = {
        "rows": p["n"], "cols": 15,
        "status": "prod 原始副本缺失，退回扫描级规则映射登记（15→9 投影待 v2p5 确认后补全量分类）",
        "rule_mapped_from_scan": {
            "empty_required_key(空UUID)": p["uuid_class"]["empty"],
            "empty_date": p["date_empty"], "illegal_calendar": p["date_bad"],
            "LEAVE-/AUTO_LEAVE 行": p["uuid_class"]["LEAVE-"] + p["uuid_class"]["AUTO_LEAVE"],
            "dup_uuid_keys": p["dup_uuid_count"], "dup_uuid_max": p["dup_uuid_max"]}}

# ---------- 边界数学链复算（既定定义，合并层 F: 键；独立于契约分类视图）----------
recs = {}
for a in arch:
    for srow, r in a["rows"]:
        r = tuple(r); k = O.key_of(r)
        if k not in recs:
            recs[k] = [O.bizdate(r[1]), O.s(r[2]), O.s(r[3]), O.s(r[4]), O.s(r[5]), O.s(r[6]), O.s(r[7]), O.s(r[8])]
leave_keys = {k for k in recs if recs[k][3] == "休假" or recs[k][4].upper() == "OFF-WORK"}
after_excl = {k for k in recs if k not in leave_keys}
special = "U:OFF-WORK / Leave"
final = {k for k in after_excl if k != special}
h_after = sum(v for v in (ph(recs[k][5]) for k in after_excl) if v is not None)
h_final = sum(v for v in (ph(recs[k][5]) for k in final) if v is not None)
collapse = sum(1 for a in arch for srow, r in a["rows"] if O.s(r[8]) == "OFF-WORK / Leave")
first_srow = min((srow for a in arch for srow, r in a["rows"] if O.s(r[8]) == "OFF-WORK / Leave"), default=None)
report["boundary_math_merged_layer"] = {
    "union": len(recs), "leave_exclusion": len(leave_keys), "after_excl": len(after_excl),
    "final": len(final), "finite_parseable_hours_after": round(h_after, 1),
    "finite_parseable_hours_final": round(h_final, 1), "diff": round(h_after - h_final, 1),
    "collapse_4568": collapse, "first_srow_8018": first_srow,
    "note": "既定定义原样复算（key_of 含 F: 回退键；leave=阶段=='休假' 或 项目=='OFF-WORK'）；"
            "与契约分类视图并列——两套口径的关系统一待 v2p5"}

# ---------- 主库侧（hktool 只读观测，提交方报告）----------
report["master_observation"] = {
    "ts_rows": 11682, "leave_rows": 568, "ts_collapse_markers": 0, "leave_markers": 567,
    "note": "主库行数来自提交方 hktool 只读观测，归提交方报告，不充独立断言；"
            "leave_markers 567 与 leave_rows 568 差 1、ts_rows 11682 与 final 11681 差 1（special 键）待核"}

# ---------- 扫描交叉验证（独立早前测量；注意规则优先级）----------
scan = json.load(open(os.path.join(HERE, "..", "scan_all3_result_v2_corrected.json"), encoding="utf-8"))
def g(d, *ks):
    for k in ks: d = d[k]
    return d
# archives 空日期 ∩ 空 UUID 拆分（供交叉验证）
arch_ed_total = arch_ed_with_uuid = 0
for a in arch:
    for _srow, r in a["rows"]:
        if canon_date(r[1]) == "":
            arch_ed_total += 1
            if O.s(r[8]): arch_ed_with_uuid += 1
arch_ed_no_uuid = arch_ed_total - arch_ed_with_uuid
ps = report["sources"]["prod_C"].get("single_rule_counts", {})
ls = report["sources"]["live"].get("single_rule_counts", {})
as_ = report["sources"]["archives"]["single_rule_counts"]
report["cross_check_vs_scan"] = {
    "note": "扫描为独立早前测量（扁平计数）；合同分类按优先级顺序（placeholder > "
            "empty_required_key > pseudo > empty_date > …），故须按并集比对：",
    "prod_empty_uuid": {
        "scan": g(scan, "PROD", "uuid_class", "empty"),
        "contract_union(empty_required_key + placeholder_empty_row)":
            ps.get("empty_required_key", 0) + ps.get("placeholder_empty_row", 0),
        "expect_equal": True,
        "why": "空 UUID 行中全空占位行先判 placeholder_empty_row，其余判 empty_required_key"},
    "prod_empty_date": {
        "scan": g(scan, "PROD", "date_empty"),
        "contract_union(empty_date + placeholder_empty_row)":
            ps.get("empty_date", 0) + ps.get("placeholder_empty_row", 0),
        "expect_equal": True,
        "why": "空日期行中全空占位行先判 placeholder_empty_row"},
    "prod_illegal_calendar": {
        "scan": g(scan, "PROD", "date_bad"),
        "contract": ps.get("illegal_calendar", 0), "expect_equal": True,
        "why": "prod 日期仅 ISO/ISO+time 两格式，规范化后无非法日历"},
    "prod_dup_keys": {
        "scan": g(scan, "PROD", "dup_uuid_count"),
        "contract_dup_structure": report["sources"]["prod_C"].get("duplicate_structure", {}).get("dup_key_groups"),
        "expect_equal": True, "why": "同按 UUID 位原值分组"},
    "live_empty_uuid": {"scan": 3931, "contract": ls.get("empty_required_key", 0), "expect_equal": True},
    "live_empty_date": {"scan": 7, "contract": ls.get("empty_date", 0), "expect_equal": True},
    "archives_empty_date": {
        "scan": 3166,
        "contract_union(empty_date + 空日期且空UUID行)":
            as_.get("empty_date", 0) + arch_ed_no_uuid,
        "expect_equal": True,
        "why": "archives 空日期行中 %d 行同时空 UUID，先判 empty_required_key（余 %d 行有 UUID 判 empty_date）"
               % (arch_ed_no_uuid, arch_ed_with_uuid)}
}

# ---------- 关键结构发现（快照内重复录入）----------
report["key_findings"] = {
    "within_snapshot_reimport": {
        "file": "archive:20260824", "rows": 18928,
        "AUTO_LEAVE_group_rows": 334,
        "LEAVE_groups": 2949, "LEAVE_group_sizes": "4-5",
        "evidence": "同一 LEAVE-<hash>-<date> 事件在同一快照内重复 4-5 次（录入时间 8/19、8/20、8/21… 不同）；"
                    "334 个不同请假事件共享常量 UUID 'AUTO_LEAVE'（单快照内 334 路同键）",
        "meaning": "leave-sync 在同一快照内多次追加写入口径；AUTO_LEAVE 常量标签即 E1 扩展伪键的实锤",
        "downstream": "若 G1 采用 biz 口径（剔除提交时间），这些重复录入不再判冲突、以正常行入账——"
                      "口径选择直接改变隔离面，须 v2p5 钉死"},
    "exact_duplicate_gap": {
        "prod_same_key_same_content_groups": report["sources"]["prod_C"].get("duplicate_structure", {}).get("same_key_same_content_groups"),
        "note": "合同 G1 仅隔离同键异内容；同键同内容（精确重复）当前不隔离，v2p5 待明确"},
    "pseudo_rule_gap": {
        "literal": "row[8] == 'OFF-WORK / Leave' → 仅覆盖 archives 4568 行",
        "extended_E1": "UUID 位常量标签 {'OFF-WORK / Leave', 'AUTO_LEAVE'} → 另覆盖 AUTO_LEAVE 3353(arch)+1(live)+2(prod) 行",
        "note": "AUTO_LEAVE 为同一异常类（常量标签占 UUID 位）；字面规则下这些行不判 pseudo，"
                "依赖 G1 兜底隔离（20260824 单档 334 路同键）——v2p5 建议纳入 E1"},
    "two_layers_divergence": {
        "contract_view": "空 UUID 行 → empty_required_key 隔离（fixture N3 字面）：archives 45343 / live 3931 / prod 6190(=5208+982)",
        "merged_layer": "key_of 的 F: 回退键将其纳管（边界数学 union 16766 含 F: 键）",
        "note": "契约分类视图与合并层口径并列，关系统一待 v2p5；本报告两套都报、不混用"}
}

out = os.path.join(HERE, "t1b_real_data_application_20261023.json")
with open(out, "w", encoding="utf-8") as f:
    json.dump(report, f, ensure_ascii=False, indent=2)
print(json.dumps(report, ensure_ascii=False, indent=2))
print("\nwrote", out)
