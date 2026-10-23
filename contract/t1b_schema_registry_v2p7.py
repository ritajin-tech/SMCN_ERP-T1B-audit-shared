# -*- coding: utf-8 -*-
"""T1-B v2p7 19 档 schema 登记与行级 schema 路由（Tom 22:18 / 22:22 要求；23:58 修订）。

Tom 22:18：「单行表头正常不能证明 19 档所有行同 schema，尤其已知错位 4568 行；
请绑定表头实际来源/采集时刻/完整字节摘要及行级 schema 路由；对未知布局先隔离」。
Tom 22:22：「PJ5 恰好由已知常量拦截不等于其他错位布局都能识别」。
Tom 23:58 三（源级与隐私边界）：
  - 「档名日期不是经独立验证的采集时间」→ 本表改称「档名日期为副本内嵌标签」，不作采集时刻证据；
  - 「20260831『2937 均真实GUID（含2367空sid）』文字自相矛盾」→ 按 UUID 位为空 / AUTO_LEAVE /
    有值非伪键**分别称谓**，不升级身份有效；
  - 「登记 JSON 含真实来源首行的业务自由文本，即使 UUID 只留 8 位、姓名是假名也不能自动视为
    公开无 PII」→ 本表**不再输出首行逐列值**，仅保留列宽与首行字节摘要（持有冻结副本者可本地复算）。

本脚本只读真算，输出逐档登记：
  - 档名 / 行数 / 列宽分布（是否异构）
  - 首行列宽 + 首行规范化字节摘要（不含逐列值：避免真实业务自由文本外泄）
  - 路由结论（9 列 → 投影 P；非 9/15 → schema_width_mismatch 隔离）
  - 互斥完备形态分解：normal / collapse(UUID 位常量 OFF-WORK / Leave) / auto_leave(AUTO_LEAVE) /
    blank2_sid_empty(前两列空且 UUID 位空) / blank2_sid_present(前两列空且 UUID 位有值非伪键)
互斥完备断言：逐档五形态之和 == 档行数；全档塌缩 == 4568；前两列空 3166 = 2367+208+591。
"""
import sys, os, json, hashlib, collections

HERE = os.path.dirname(os.path.abspath(__file__))
SCRUB = os.path.join(HERE, "..", "20261014_frozen_scrubbed")
sys.path.insert(0, os.path.abspath(SCRUB))
sys.path.insert(0, HERE)
import offline_recompute_scrubbed as O
import t1b_canon_date_v2p7 as CD   # 日期规范化单一实现（Tom 23:58 二）

PSEUDO = ("OFF-WORK / Leave", "AUTO_LEAVE")
ALLOWED_WIDTHS = (9, 15)

def row_digest(row):
    return hashlib.sha256(json.dumps([O.s(x) for x in row], ensure_ascii=False, sort_keys=True).encode()).hexdigest()

def form_of(r):
    """互斥完备形态分类（顺序即优先级，五类互不相交、合计 == 档行数）。"""
    u = O.s(r[8]) if len(r) > 8 else ""
    b2 = (O.s(r[0]) == "" and O.s(r[1]) == "")
    if u == "OFF-WORK / Leave": return "collapse"
    if u == "AUTO_LEAVE": return "auto_leave"
    if b2 and u == "": return "blank2_sid_empty"
    if b2: return "blank2_sid_present"
    return "normal"

arch = O.load("archives_scrubbed.json")
fails = []
def check(name, got, exp):
    if got != exp: fails.append("%s got=%r exp=%r" % (name, got, exp))

snapshots = []
tot = collections.Counter()
for a in arch:
    rows = [r for _s, r in a["rows"]]
    widths = collections.Counter(len(r) for r in rows)
    forms = collections.Counter(form_of(r) for r in rows)
    check("forms_sum:%s" % a["name"], sum(forms.values()), len(rows))   # 互斥完备
    # 前两列空的细分（独立于五形态，用于全档 3166 分解）
    b2 = [r for r in rows if O.s(r[0]) == "" and O.s(r[1]) == ""]
    b2_forms = collections.Counter(form_of(r) for r in b2)
    unknown = sum(v for w, v in widths.items() if w not in ALLOWED_WIDTHS)
    route = ("project_P" if all(w in ALLOWED_WIDTHS for w in widths) else "isolate_unknown_width")
    first = rows[0] if rows else []
    snapshots.append({
        "snapshot": a["name"],
        "rows": len(rows),
        "width_distribution": {str(w): v for w, v in sorted(widths.items())},
        "route": route,
        "unknown_width_rows": unknown,
        "first_row_width": len(first),
        "first_row_digest": row_digest(first[:9]),
        "first_row_digest_note": "对**未掩码原始**前 9 列计算（持有冻结副本者可用本脚本本地复算比对）；"
                                 "v2p7 起不再输出首行逐列值（真实来源业务自由文本不进入公开副本）",
        "forms": {k: int(v) for k, v in sorted(forms.items())},
        "forms_sum_equals_rows": sum(forms.values()) == len(rows),
        "blank_first_two_cols": len(b2),
        "blank2_breakdown": {k: int(v) for k, v in sorted(b2_forms.items())},
    })
    tot.update(forms)
    tot["rows"] += len(rows); tot["blank2"] += len(b2)
    tot.update({"b2_" + k: v for k, v in b2_forms.items()})

# ---------- 全档互斥完备断言 ----------
check("total_rows", tot["rows"], 102723)
check("collapse_4568", tot["collapse"], 4568)
check("blank2_3166", tot["blank2"], 3166)
check("blank2_sid_empty_2367", tot["b2_blank2_sid_empty"], 2367)
check("blank2_auto_leave_208", tot["b2_auto_leave"], 208)
check("blank2_sid_present_591", tot["b2_blank2_sid_present"], 591)
check("blank2_decomposition", tot["b2_blank2_sid_empty"] + tot["b2_auto_leave"] + tot["b2_blank2_sid_present"], 3166)

# 错位行档级归属：塌缩行全部落在哪些档
collapse_by_snapshot = {s["snapshot"]: s["forms"].get("collapse", 0)
                        for s in snapshots if s["forms"].get("collapse", 0) > 0}
check("collapse_single_snapshot", sorted(collapse_by_snapshot), ["20260831"])

S31 = [s for s in snapshots if s["snapshot"] == "20260831"][0]
check("s20260831_rows", S31["rows"], 12583)
check("s20260831_normal_4746", S31["forms"].get("normal"), 4746)
check("s20260831_collapse_4568", S31["forms"].get("collapse"), 4568)
check("s20260831_auto_leave_332", S31["forms"].get("auto_leave"), 332)
check("s20260831_blank2_sid_empty_2367", S31["forms"].get("blank2_sid_empty"), 2367)
check("s20260831_blank2_sid_present_570", S31["forms"].get("blank2_sid_present"), 570)
# 前两列空 3166 的档级分布（20260831 内 208 行 UUID 位为 AUTO_LEAVE，另有 124 行非前两列空）
sid_present_by_snapshot = {s["snapshot"]: s["blank2_breakdown"].get("blank2_sid_present", 0)
                           for s in snapshots if s["blank2_breakdown"].get("blank2_sid_present", 0) > 0}

report = {
    "report": "T1-B v2p7 19 档 schema 登记与行级 schema 路由（提交方只读真算，非 Tom 独立运行）",
    "generated": "2026-10-24",
    "source": "archives_scrubbed.json（19 档去标识冻结副本）",
    "binding_note": "Tom 22:18 要求「绑定表头实际来源/采集时刻/完整字节摘要及行级 schema 路由」。"
                    "逐档字节摘要见 t1b_key_registry_v2p3.csv（19 档 name+sha），本表补列宽分布/首行字节摘要/"
                    "路由结论/互斥完备形态分解。**档名日期为副本内嵌标签，非经独立验证的采集时间**（Tom 23:58 三）；"
                    "表头实际来源/源码身份未持有，保持未核验。",
    "totals": {
        "rows": int(tot["rows"]),
        "collapse_4568": int(tot["collapse"]),
        "blank_first_two_cols_3166": int(tot["blank2"]),
        "blank2_breakdown": {
            "uuid_position_empty_2367": int(tot["b2_blank2_sid_empty"]),
            "uuid_position_AUTO_LEAVE_208": int(tot["b2_auto_leave"]),
            "uuid_position_present_non_pseudo_591": int(tot["b2_blank2_sid_present"]),
        },
        "forms_all_snapshots": {k: int(v) for k, v in sorted(tot.items())
                                if k in ("normal", "collapse", "auto_leave", "blank2_sid_empty", "blank2_sid_present")},
    },
    "key_findings": [
        "19 档列宽全部为 9（无列宽异构）：archives 侧不存在 15 列档，投影 P 对全档统一适用；"
        "未知列宽隔离能力（PJ10-PJ13）在本冻结副本未被触发——属防御性覆盖，不能据此声称全档同 schema。",
        "错位 4568 行（UUID 位为常量 'OFF-WORK / Leave'）100% 归属 20260831 单档，占该档 12583 行的 36.3%；"
        "其余 18 档该**已定义常量形态**计数均为 0（Tom 23:58：此处只针对已定义常量形态，不认证没有其他语义错位）。",
        "20260831 档内五形态互斥完备（合计 12583）：正常 4746 / 塌缩 4568 / UUID 位 AUTO_LEAVE 332 / "
        "前两列空且 UUID 位空 2367 / 前两列空且 UUID 位有值非伪键 570；"
        "其中 AUTO_LEAVE 332 行内有 208 行同时属前两列空（另 124 行前两列非空）——分别称谓，不升级身份有效。",
        "全档前两列空 3166 行分解（v2p7 口径）：UUID 位空 2367（全在 20260831）+ UUID 位 AUTO_LEAVE 208"
        "（全在 20260831）+ UUID 位有值非伪键 591（20260831 570、20260914/20260921/20260928 各 7）。"
        "与 v2p4 口径 799 = 591 + 208 一致（E1 采纳后 208 行由 empty_date 转 pseudo）。",
        "v2p6 补证信中「2937 均真实 GUID（含 2367 空 sid）」表述自相矛盾，已按上述三分类分别称谓并撤回"
        "（Tom 23:58 三）；不因 UUID 位有值而宣称其身份有效。",
    ],
    "misalignment_snapshot_attribution": collapse_by_snapshot,
    "blank2_sid_present_by_snapshot": sid_present_by_snapshot,
    "snapshot_20260831": S31,
    "snapshots": snapshots,
    "route_rules": {
        "9_or_15_cols": "经投影 P 生成规范 9 列视图后分类",
        "other_widths": "schema_width_mismatch 先隔离（不静默取前九列）",
        "short_rows_lt9": "missing_column",
        "note": "列宽一致 ≠ 字段语义一致；错位档（20260831）须按形态路由，"
                "其塌缩行由 pseudo 规则拦截（PJ5 同构），不据列宽放行。"
    },
    "invariants": {
        "total_rows_102723": int(tot["rows"]) == 102723,
        "collapse_4568": int(tot["collapse"]) == 4568,
        "blank2_decomposition_3166": int(tot["b2_blank2_sid_empty"] + tot["b2_auto_leave"] + tot["b2_blank2_sid_present"]) == 3166,
        "per_snapshot_forms_complete": all(s["forms_sum_equals_rows"] for s in snapshots),
    },
    "privacy": "v2p7：本 JSON **不再输出首行逐列值**（真实来源业务自由文本不进入公开副本）；"
               "仅保留列宽与首行字节摘要，持有去标识冻结副本者可用本脚本本地复算。"
               "去标识冻结副本与键登记表 CSV（含真实 UUID）走邮件通道，不入公开仓库。",
    "disclaimer": "提交方只读运行产物；表头来源/源码身份未持有、保持未核验；不为赶 D1/D2 造证或请求生产权限。"
}

out = os.path.join(HERE, "t1b_schema_registry_v2p7.json")
with open(out, "w", encoding="utf-8") as f:
    json.dump(report, f, ensure_ascii=False, indent=2)

print("wrote", out)
print("档数:", len(snapshots), "| 全档行数:", int(tot["rows"]), "| 塌缩 4568:", int(tot["collapse"]))
print("列宽分布汇总:", {str(w): sum(s["width_distribution"].get(str(w), 0) for s in snapshots)
                        for w in sorted({int(x) for s in snapshots for x in s["width_distribution"]})})
print("塌缩行档级归属:", collapse_by_snapshot)
print("全档形态:", {k: int(v) for k, v in sorted(tot.items())
                   if k in ("normal", "collapse", "auto_leave", "blank2_sid_empty", "blank2_sid_present")})
print("前两列空分解: UUID位空=%d AUTO_LEAVE=%d 有值非伪键=%d 合计=%d" %
      (tot["b2_blank2_sid_empty"], tot["b2_auto_leave"], tot["b2_blank2_sid_present"], tot["blank2"]))
print("20260831 形态:", S31["forms"], "前两列空细分:", S31["blank2_breakdown"])
if fails:
    print("INVARIANT FAIL:")
    for x in fails: print("  -", x)
    sys.exit(1)
print("互斥完备断言全过（EXIT=0 = 提交方自洽，非 Tom 独立运行）")
