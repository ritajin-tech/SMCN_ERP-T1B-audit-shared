# -*- coding: utf-8 -*-
"""T1-B v2p6 19 档 schema 登记与行级 schema 路由（Tom 22:18 / 22:22 要求）。

Tom 22:18：「单行表头正常不能证明 19 档所有行同 schema，尤其已知错位 4568 行；
请绑定表头实际来源/采集时刻/完整字节摘要及行级 schema 路由；对未知布局先隔离」。
Tom 22:22：「PJ5 恰好由已知常量拦截不等于其他错位布局都能识别」。

本脚本只读真算，输出逐档登记：
  - 档名 / 行数 / 列宽分布（是否异构）
  - 首行逐列（表头/首数据行）与规范化字节摘要
  - 路由结论（9 列 → 投影 P；非 9/15 → schema_width_mismatch 隔离）
  - 错位形态：UUID 位为常量标签 'OFF-WORK / Leave'（塌缩）行数；AUTO_LEAVE 行数；
    前两列空（录入时间+日期均空）行数及其 sid 状态分解
互斥完备断言：逐档各类之和 == 档行数；全档塌缩行合计 == collapse_4568。
"""
import sys, os, json, re, math, datetime, collections, hashlib

HERE = os.path.dirname(os.path.abspath(__file__))
SCRUB = os.path.join(HERE, "..", "20261014_frozen_scrubbed")
sys.path.insert(0, os.path.abspath(SCRUB))
import offline_recompute_scrubbed as O

PSEUDO = ("OFF-WORK / Leave", "AUTO_LEAVE")
ALLOWED_WIDTHS = (9, 15)

def canon_date(v):
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

UUID_RE = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")

def mask_uuid(v):
    """公开副本掩码：真实 UUID 不进公开仓库（与『登记表 CSV 含真实 UUID 走邮件通道』同一纪律）。
    原始值摘要 first_row_digest 不受影响（对未掩码原始行计算），持有冻结副本者可复算。"""
    s = O.s(v)
    return (s[:8] + "…<uuid masked in public copy>") if UUID_RE.fullmatch(s) else s

def row_digest(row):
    return hashlib.sha256(json.dumps([O.s(x) for x in row], ensure_ascii=False, sort_keys=True).encode()).hexdigest()

arch = O.load("archives_scrubbed.json")
fails = []
def check(name, got, exp):
    if got != exp: fails.append("%s got=%r exp=%r" % (name, got, exp))

snapshots = []
tot = {"rows": 0, "collapse": 0, "auto_leave": 0, "blank_first2": 0}
for a in arch:
    rows = [r for _s, r in a["rows"]]
    widths = collections.Counter(len(r) for r in rows)
    collapse = sum(1 for r in rows if O.s(r[8] if len(r) > 8 else "") == "OFF-WORK / Leave")
    auto_leave = sum(1 for r in rows if O.s(r[8] if len(r) > 8 else "") == "AUTO_LEAVE")
    leave_pref = sum(1 for r in rows if O.s(r[8] if len(r) > 8 else "").startswith("LEAVE-"))
    blank_first2 = sum(1 for r in rows if O.s(r[0]) == "" and O.s(r[1]) == "")
    # 前两列空行的 sid（UUID 位）状态分解
    bf_sid_empty = sum(1 for r in rows if O.s(r[0]) == "" and O.s(r[1]) == "" and O.s(r[8]) == "")
    bf_sid_ok = sum(1 for r in rows if O.s(r[0]) == "" and O.s(r[1]) == "" and O.s(r[8]) != ""
                    and O.s(r[8]) not in PSEUDO)
    # 未知布局（非 9/15 列）行数
    unknown = sum(v for w, v in widths.items() if w not in ALLOWED_WIDTHS)
    route = ("project_P" if all(w in ALLOWED_WIDTHS for w in widths) else "isolate_unknown_width")
    first = rows[0] if rows else []
    snapshots.append({
        "snapshot": a["name"],
        "rows": len(rows),
        "width_distribution": {str(w): v for w, v in sorted(widths.items())},
        "route": route,
        "unknown_width_rows": unknown,
        "first_row_columns": [O.s(x) for x in first[:8]] + [mask_uuid(first[8]) if len(first) > 8 else ""],
        "first_row_width": len(first),
        "first_row_digest": row_digest(first[:9]),
        "first_row_digest_note": "对未掩码原始前 9 列计算；持有冻结副本者可复算比对",
        "misalignment": {
            "collapse_uuid_const_OFF_WORK_Leave": collapse,
            "auto_leave_const": auto_leave,
            "leave_prefixed_real_id": leave_pref,
            "blank_first_two_cols": blank_first2,
            "blank_first_two_cols_sid_empty": bf_sid_empty,
            "blank_first_two_cols_sid_present": bf_sid_ok,
        },
    })
    tot["rows"] += len(rows); tot["collapse"] += collapse
    tot["auto_leave"] += auto_leave; tot["blank_first2"] += blank_first2

# 互斥完备断言
check("total_rows", tot["rows"], 102723)
check("collapse_4568", tot["collapse"], 4568)
check("auto_leave_3353", tot["auto_leave"], 3353)
check("blank_first2_3166", tot["blank_first2"], 3166)
# 前两列空的三分解（v2p6 口径）：sid 空 → empty_required_key；AUTO_LEAVE → pseudo；其余 → empty_date
bf_sid_empty_all = sum(s["misalignment"]["blank_first_two_cols_sid_empty"] for s in snapshots)
bf_sid_ok_all = sum(s["misalignment"]["blank_first_two_cols_sid_present"] for s in snapshots)
bf_auto_all = sum(1 for a in arch for _s, r in a["rows"]
                  if O.s(r[0]) == "" and O.s(r[1]) == "" and O.s(r[8]) == "AUTO_LEAVE")
check("blank2_decomposition", bf_sid_empty_all + bf_sid_ok_all + bf_auto_all, 3166)
check("blank2_sid_empty_2367", bf_sid_empty_all, 2367)
check("blank2_empty_date_591", bf_sid_ok_all, 591)
check("blank2_auto_leave_208", bf_auto_all, 208)

# 错位行归属：塌缩行全部落在哪些档
collapse_by_snapshot = {s["snapshot"]: s["misalignment"]["collapse_uuid_const_OFF_WORK_Leave"]
                        for s in snapshots if s["misalignment"]["collapse_uuid_const_OFF_WORK_Leave"] > 0}

report = {
    "report": "T1-B v2p6 19 档 schema 登记与行级 schema 路由（提交方只读真算，非 Tom 独立运行）",
    "generated": "2026-10-23",
    "source": "archives_scrubbed.json（19 档去标识冻结副本）",
    "binding_note": "Tom 22:18 要求「绑定表头实际来源/采集时刻/完整字节摘要及行级 schema 路由」；"
                    "逐档字节摘要见 t1b_key_registry_v2p3.csv（19 档 name+sha），本表补列宽分布/首行逐列/路由结论/错位形态。"
                    "采集时刻以档名日期为准（冻结副本内嵌，非实时采集）。",
    "totals": {"rows": tot["rows"], "collapse_4568": tot["collapse"],
               "auto_leave_3353": tot["auto_leave"], "blank_first_two_cols_3166": tot["blank_first2"]},
    "key_findings": [
        "19 档列宽全部为 9（无列宽异构）：archives 侧不存在 15 列档，投影 P 对全档统一适用；"
        "未知列宽隔离能力（PJ10-PJ13）在本冻结副本上未被触发——属防御性覆盖，不能据此声称全档同 schema（Tom 22:22）。",
        "错位 4568 行（UUID 位为常量 'OFF-WORK / Leave'）100% 归属 20260831 单档，占该档 12583 行的 36.3%；"
        "其余 18 档均为 0 —— 精确回答 Tom 22:18「已知错位 4568 行」的档级归属。",
        "20260831 档内部三种形态：正常 4870 行 / 塌缩（UUID 位常量）4568 行 / 前两列空且 UUID 位为真实 GUID 2937 行（含 sid 空 2367）。",
        "全档前两列空 3166 行的三分解（v2p6 口径）：sid 空 2367 → empty_required_key；"
        "AUTO_LEAVE 208 → pseudo；其余 591 → empty_date。"
        "与 v2p4 口径 799 = 591 + 208 一致（E1 采纳后 208 行由 empty_date 转 pseudo）。",
    ],
    "misalignment_snapshot_attribution": collapse_by_snapshot,
    "snapshots": snapshots,
    "route_rules": {
        "9_or_15_cols": "经投影 P 生成规范 9 列视图后分类",
        "other_widths": "schema_width_mismatch 先隔离（不静默取前九列）",
        "short_rows_lt9": "missing_column",
        "note": "列宽一致 ≠ 字段语义一致；错位档（20260831）须按形态路由，"
                "其塌缩行由 pseudo 规则拦截（PJ5 同构），不据列宽放行。"
    },
    "invariants": {
        "total_rows_102723": tot["rows"] == 102723,
        "collapse_4568": tot["collapse"] == 4568,
        "blank2_decomposition_3166": (bf_sid_empty_all + bf_sid_ok_all + bf_auto_all) == 3166,
    },
    "disclaimer": "提交方只读运行产物；未持有源代码/原表头保持未核验；不为赶 D1/D2 造证或请求生产权限。",
    "privacy": "本 JSON 为公开副本：首行第 9 列（真实 UUID）按『含真实 UUID 走邮件通道』纪律掩码为前 8 位；"
               "其余列（含 P-#### 假名与业务自由文本）与已公开 fixture 同级别。first_row_digest 对未掩码原始行计算，"
               "持有去标识冻结副本者可复算；去标识副本本身不入公开仓库。",
    "publication_scope": "公开仓库含本 JSON 与生成脚本 .py；去标识冻结副本、键登记表 CSV 走邮件通道。"
}

out = os.path.join(HERE, "t1b_schema_registry_v2p6.json")
with open(out, "w", encoding="utf-8") as f:
    json.dump(report, f, ensure_ascii=False, indent=2)

print("wrote", out)
print("档数:", len(snapshots), "| 全档行数:", tot["rows"], "| 塌缩 4568:", tot["collapse"])
print("列宽分布汇总:", {str(w): sum(s["width_distribution"].get(str(w), 0) for s in snapshots)
                        for w in sorted({int(x) for s in snapshots for x in s["width_distribution"]})})
print("塌缩行档级归属:", collapse_by_snapshot)
print("前两列空分解: sid空=%d AUTO_LEAVE=%d empty_date=%d 合计=%d" %
      (bf_sid_empty_all, bf_auto_all, bf_sid_ok_all, bf_sid_empty_all + bf_auto_all + bf_sid_ok_all))
if fails:
    print("INVARIANT FAIL:")
    for x in fails: print("  -", x)
    sys.exit(1)
print("互斥完备断言全过（EXIT=0 = 提交方自洽，非 Tom 独立运行）")
