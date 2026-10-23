# -*- coding: utf-8 -*-
"""T1-B v2p6 互斥完备换算表（T4；同一冻结定位 archives，只读真算）。

按 Tom 22:18 T4 立场：「请给同一冻结定位从输入→各层集合的互斥完备换算，不用 11681 代
normal 集；契约行级隔离、聚合 F 键回退、业务可用性三层分开；F 键可复现不等于身份
PROVEN/唯一实体/计薪可信」。

换算链（archives 去标识冻结副本，19 档，snap=ARCH-v19）：
  L0 输入行数（19 档合计）
  L1 契约层单例分类（v2p6 口径：E1 已采纳——UUID 位常量 {'OFF-WORK / Leave','AUTO_LEAVE'}
     直接判 pseudo_uuid_collapse；优先级 placeholder > empty_required_key > pseudo > empty_date
     > illegal_calendar > non_finite_* > missing/schema > ok）
  L2 契约层 final（G1 full 口径覆写：同 (ns,snap,sid) 多例且全行含提交时间不同 →
     same_key_diff_content；覆写不筛除，各类之和仍 = L0）
  L3 并列测量层（biz_digest：同键组 full 全同 → exact_duplicate；biz 全同且 full 不全同 →
     duplicate_entry；只标记不改 L2 硬判定）
  L4 合并层（既定 key_of 口径，并列展示）：union 16766 − leave_exclusion 5084 = after_excl
     11682 − special_key 1 = final 11681（键级恒等；与 L2 行级口径不可互代）
互斥完备断言：L1 各类之和 == L0；L2 各类之和 == L0；L3 测量组互斥（每组至多一个标记）；
L4 链式恒等；L4 final 键数 11681 ≠ L2 normal 行数（明确分开，不互相代）。
"""
import sys, os, json, hashlib, math, datetime, collections

HERE = os.path.dirname(os.path.abspath(__file__))
SCRUB = os.path.join(HERE, "..", "20261014_frozen_scrubbed")
sys.path.insert(0, os.path.abspath(SCRUB))
import offline_recompute_scrubbed as O

PSEUDO_CONSTANTS = ("OFF-WORK / Leave", "AUTO_LEAVE")   # v2p6：E1 已采纳（Tom 22:18 T3 支持）

def ph(v):
    try:
        f = float(v)
        if math.isnan(f) or math.isinf(f): return None
        return f
    except (TypeError, ValueError): return None

def canon_date(v):
    import re
    s = O.s(v)
    if s == "": return ""
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s): return s
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}[ T].*", s): return s[:10]
    m = re.fullmatch(r"(\d{1,2})/(\d{1,2})/(\d{4})", s)
    if m:
        mo, dy, yr = int(m.group(1)), int(m.group(2)), int(m.group(3))
        try:
            datetime.date(yr, mo, dy); return "%04d-%02d-%02d" % (yr, mo, dy)
        except ValueError: return s
    return s

def valid_calendar(s):
    s = O.s(s)
    if not s: return False
    try:
        datetime.datetime.strptime(s, "%Y-%m-%d"); return True
    except ValueError:
        return False

def project(real):
    real = [O.s(x) for x in real]
    leave = "LEAVE" if (real[4] == "休假" or real[5].upper() == "OFF-WORK") else ""
    return [real[0], canon_date(real[1]), real[2], real[3], real[5], real[6], real[7], leave, real[8]]

def payload_of(row9):
    return hashlib.sha256(json.dumps(row9, sort_keys=True).encode()).hexdigest()

def payload_biz(row9):
    return hashlib.sha256(json.dumps(row9[1:], sort_keys=True).encode()).hexdigest()

def classify_single(row9, sid):
    """v2p6 口径：与 t1b_offline_test_v2p6.py classify_single 一致（E1 采纳）。"""
    if len(row9) < 9: return "missing_column"
    if len(row9) > 9: return "schema_width_mismatch"
    if all(O.s(x) == "" for x in row9): return "placeholder_empty_row"
    if not sid: return "empty_required_key"
    if O.s(row9[8]) in PSEUDO_CONSTANTS: return "pseudo_uuid_collapse"
    cal = O.s(row9[1])
    if cal == "": return "empty_date"
    if not valid_calendar(cal): return "illegal_calendar"
    hv = O.s(row9[5])
    if hv.upper() == "NAN": return "non_finite_nan"
    if hv.upper() in ("INFINITY", "INF"): return "non_finite_inf"
    if O.s(row9[4]).upper() != "OFF-WORK" and ph(row9[5]) is None: return "non_finite_hours"
    return "ok"

fails = []
def check(name, got, exp):
    if got != exp:
        fails.append("%s got=%r exp=%r" % (name, got, exp))
    return got == exp

# ---------- L0/L1/L2/L3：契约层 + 测量层（archives 19 档全量）----------
arch = O.load("archives_scrubbed.json")
single = collections.Counter()
key_full = collections.defaultdict(list)   # (ns,snap,sid) -> [(rsn, payload_full)]
key_biz = collections.defaultdict(list)
n_rows = 0
for a in arch:
    ns = "archive:" + a["name"]; snap = "ARCH-v19"
    for _srow, r in a["rows"]:
        n_rows += 1
        row9 = project(r)
        sid = O.s(r[8])
        rsn = classify_single(row9, sid)
        single[rsn] += 1
        if sid:
            key_full[(ns, snap, sid)].append((rsn, payload_of(row9)))
            key_biz[(ns, snap, sid)].append((rsn, payload_biz(row9)))

# L2：G1 full 口径覆写（不改键集合，覆写 reason）
final = dict(single)
g1_groups = 0; g1_rows = 0; g1_from = collections.Counter()
for k, lst in key_full.items():
    if len(lst) >= 2 and len({p for _, p in lst}) > 1:
        g1_groups += 1; g1_rows += len(lst)
        for rsn, _ in lst: g1_from[rsn] += 1
if g1_rows:
    final["same_key_diff_content"] = final.get("same_key_diff_content", 0) + g1_rows
    for rsn, cnt in g1_from.items():
        final[rsn] = final.get(rsn, 0) - cnt
        if final[rsn] <= 0: del final[rsn]

# L3：并列测量层（每组至多一个标记；互斥）
measure = {}
for k, lst in key_biz.items():
    if len(lst) < 2:
        continue
    fulls = {p for _, p in key_full[k]}
    bizs = {p for _, p in lst}
    if len(fulls) == 1: measure[k] = "exact_duplicate"
    elif len(bizs) == 1: measure[k] = "duplicate_entry"
    else: measure[k] = None
meas_counter = collections.Counter(m for m in measure.values() if m)
meas_rows = collections.Counter()
for k, m in measure.items():
    if m: meas_rows[m] += len(key_biz[k])

# ---------- L4：合并层（既定 key_of 口径；从同一冻结副本复算）----------
recs = {}
for a in arch:
    for srow, r in a["rows"]:
        r = tuple(r); k = O.key_of(r)
        if k not in recs:
            recs[k] = [O.bizdate(r[1]), O.s(r[2]), O.s(r[3]), O.s(r[4]), O.s(r[5]), O.s(r[6]), O.s(r[7]), O.s(r[8]), srow, a["name"]]
def is_leave(k):
    return recs[k][3] == "休假" or recs[k][4].upper() == "OFF-WORK"
leave_keys = {k for k in recs if is_leave(k)}
union = len(recs)
after_excl = {k for k in recs if k not in leave_keys}
special = "U:OFF-WORK / Leave"
final_keys = {k for k in after_excl if k != special}

# ---------- 互斥完备断言 ----------
check("L0==L1_sum", sum(single.values()), n_rows)
check("L1==L2_sum", sum(final.values()), n_rows)
check("L4_union", union, 16766)
check("L4_leave", len(leave_keys), 5084)
check("L4_after_excl", len(after_excl), 11682)
check("L4_special_in_after_excl", special in after_excl, True)
check("L4_special_not_in_final", special not in final_keys, True)
check("L4_final", len(final_keys), 11681)
# L4 键级 final ≠ L2 行级 normal（明确分开，非恒等断言——两者本不同口径）
normal_rows = final.get("ok", 0)
# 测量层互斥：每组至多一个标记（构造上成立）
check("L3_measure_groups", len(measure), sum(1 for m in measure.values() if m) + sum(1 for m in measure.values() if not m))

report = {
    "report": "T1-B v2p6 互斥完备换算表（T4；同一冻结定位 archives；提交方只读运行，非 Tom 独立运行）",
    "generated": "2026-10-23",
    "frozen_position": {"source": "archives_scrubbed.json（19 档去标识冻结副本）",
                        "namespace": "archive:<档名>", "snapshot": "ARCH-v19",
                        "note": "与主库工时 sheet 11682（含 1 行表头）不同定位、不同分母，不可直接相减"},
    "L0_input_rows": n_rows,
    "L1_contract_single_rule_counts": dict(sorted(single.items())),
    "L2_contract_final_after_g1_full_override": {
        "counts": dict(sorted(final.items())),
        "g1_full_override": {"groups": g1_groups, "rows_overridden": g1_rows,
                             "overridden_from_reasons": dict(g1_from),
                             "basis": "full（规范视图全行含提交时间；Tom：不为降低隔离数选口径）"}},
    "L3_measurement_layer_biz_digest": {
        "groups_with_marker": dict(meas_counter),
        "rows_with_marker": dict(meas_rows),
        "groups_no_marker": sum(1 for m in measure.values() if not m),
        "basis": "biz（剔除提交时间）；只标记不改 L2 硬判定；不宣称恢复正常/有效计薪/同一事件",
        "first_seen_note": "first-seen 仅聚合复算既定代表选择，不证明多条业务事件应合为一条"},
    "L4_merged_layer_key_of": {
        "union": union, "leave_exclusion": len(leave_keys), "after_excl": len(after_excl),
        "special_key_excluded": 1, "final": len(final_keys),
        "note": "key_of 回退键口径（含 F: 键）；键级恒等；与 L2 行级口径并列，不可互代"},
    "key_separation": {
        "L4_final_keys": len(final_keys), "L2_normal_rows": normal_rows,
        "statement": "合并层 final 11681 为键数；契约层 normal 为行数——两者不同口径，"
                     "不用 11681 代 normal 集（Tom 22:18 T4）"},
    "invariants": {
        "L0_eq_L1_sum": sum(single.values()) == n_rows,
        "L1_eq_L2_sum": sum(final.values()) == n_rows,
        "L4_chain": len(after_excl) - 1 == len(final_keys),
        "L3_mutually_exclusive": True},
    "disclaimer": "v2p6 口径（E1 采纳：AUTO_LEAVE 行计入 pseudo，不单列 extra）；"
                  "F 键可复现不等于身份 PROVEN/唯一实体/计薪可信；业务可用性层待有权方。"
}

out = os.path.join(HERE, "t1b_layer_conversion_v2p6.json")
with open(out, "w", encoding="utf-8") as f:
    json.dump(report, f, ensure_ascii=False, indent=2)
print("wrote", out)
print("L0 rows        =", n_rows)
print("L1 single      =", dict(sorted(single.items())))
print("L2 final       =", dict(sorted(final.items())))
print("L3 measure     =", dict(meas_counter), "rows:", dict(meas_rows))
print("L4 merged      = union %d - leave %d = after_excl %d - special 1 = final %d" % (
    union, len(leave_keys), len(after_excl), len(final_keys)))
print("L2 normal rows =", normal_rows, "（vs L4 final keys", len(final_keys), "——不同口径，不互代）")
if fails:
    print("INVARIANT FAIL:")
    for x in fails: print("  -", x)
    sys.exit(1)
print("互斥完备断言全过（EXIT=0 = 提交方自洽，非 Tom 独立运行）")
