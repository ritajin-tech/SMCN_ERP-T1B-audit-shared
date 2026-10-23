# -*- coding: utf-8 -*-
"""
T1-B 主键契约离线测试 v2p7（只读，不碰生产）— 提交方报告（非 Tom 独立运行）

相对 v2p6 的变更（按 Tom 2026-10-23 23:58「v2p6 合并审核」五点 + 源级/隐私边界修订）：
  1) 原行 full 与规范视图 full 分名（Tom 一）：G1 与测量层此前只取**投影后**规范视图 row；
     N24/N24b 原始阶段不同却仍断言 normal/ok 及 exact_duplicate，source_field_diff 仅诊断、
     不改硬判定——「保留原行只是可追溯，不等于原行差异未被放行」。v2p7：
     - payload_of 更名为 normalized_view_full（规范视图全行，含提交时间）；
     - 新增 source_full（原始行摘要）；**硬判定加入原行摘要差异**：规范视图相同但原始行不同
       -> status=isolated, reason=source_conflict（待业务裁定，不宣称精确重复、不宣称恢复正常）；
     - 测量层 exact_duplicate 更名为 normalized_view_equal（规范视图相等，不宣称原行相等）；
       原行不同时改标 source_conflict。N24/N24b 期望由 normal/ok 改为 isolated/source_conflict。
  2) 日期规则统一（Tom 二）：canon_date 抽为单一实现 t1b_canon_date_v2p7.py（主测试 /
     layer_conversion / schema_registry 统一 import），并补**时间分量范围校验**
     （HH<=23 / MM<=59 / SS<=59）——形状匹配不等于时间有效，`99:99` 不截断 -> illegal_calendar
     （新增负例 PJ14）。
  3) D 段完整必需集合校验（Tom 三）：除「清单列出的文件缺失即失败」外，新增
     固定必需条目集合断言（deliverables 4 + supporting 6 + 依赖 1，多/少/缺整段均 FAIL）、
     live_scrubbed.json 实际字节比对（此前 live 参与 A 段读取但无 SHA 校验），
     并加三类**负向自检**（删清单键 / 删 supporting 段 / 替换 live SHA）证明校验真的会失败。
  4) accepted tag 边界一致化（Tom 四）：采用「前驱按稳定版本坐标绑定 + 别名规范化」——
     CORRECT 重放比较前驱的**稳定版本坐标 (se,rv,ns,ver)** 而非字面 tag；v1d（同 UPSERT
     身份的别名 E1-upsert-2）期望由 conflict 改为 idempotent，另补异身份前驱负例 v1f。
  5) 文字/混版修正（Tom 五）：覆盖矩阵数字按实际 25+32=57 / state 15 / projection 13 统一，
     移除旧 biz 硬放行与 23+32=55、projection 8 等残留；manifest amendment 改为
     「fixture/test/沿用 CSV 未变，合同与 manifest 已修订」并保留两组哈希。
  6) 源级与隐私边界（Tom 三/六）：档名日期为副本内嵌标签，**非经独立验证的采集时间**；
     20260831 形态按「UUID 位为空 / AUTO_LEAVE / 有值非伪键」分别称谓，不升级身份有效；
     登记 JSON 不再输出真实来源首行的业务自由文本（改由持有冻结副本者用脚本本地复算）。
退出码：0 = 提交方断言全过；1 = 有不符；2 = 输入缺失。
"""
import sys, os, json, hashlib, math, datetime, copy, re
HERE = os.path.dirname(os.path.abspath(__file__))
SCRUB = os.path.join(HERE, "..", "20261014_frozen_scrubbed")
sys.path.insert(0, os.path.abspath(SCRUB))
sys.path.insert(0, HERE)
import offline_recompute_scrubbed as O
import t1b_canon_date_v2p7 as CD      # 日期规范化单一实现（Tom 23:58 二：统一函数/版本）

FIX = json.load(open(os.path.join(HERE, "t1b_offline_fixture_v2p7.json"), encoding="utf-8"))
RA = FIX["regression_assertions"]

fails = []
def check(name, got, exp):
    ok = (got == exp)
    if not ok: fails.append("%s got=%r exp=%r" % (name, got, exp))
    return ok

def ph(v):
    try:
        f = float(v)
        if math.isnan(f) or math.isinf(f): return None
        return f
    except (TypeError, ValueError): return None

def valid_calendar(s):
    s = O.s(s)
    if not s: return False
    try:
        datetime.datetime.strptime(s, "%Y-%m-%d")
        return True
    except ValueError:
        return False

def normalized_view_full(ex):
    """规范视图 full：**投影后**规范 9 列全行（含提交时间 row[0]）——G1 硬判定口径。
    v2p7 更名（原 payload_of）：明确这是**规范视图**的摘要，不是原始行摘要，
    不因规范视图相同而宣称原始行相同。"""
    return hashlib.sha256(json.dumps(ex.get("row", []), sort_keys=True).encode()).hexdigest()

def source_full(ex):
    """原始行 full：未经投影 P 的原始布局行摘要（含阶段列/自动列）。
    v2p7 新增并**进入硬判定**：规范视图相同但原始行不同 -> source_conflict（Tom 23:58 一）。
    用例未携带 source_row 时返回 None（信息缺失，不猜测、不比较）。"""
    sr = ex.get("source_row")
    if sr is None: return None
    return hashlib.sha256(json.dumps(sr, sort_keys=True).encode()).hexdigest()

def payload_of(ex):
    """向后兼容别名（= 规范视图 full）。保留仅为旧引用不破，新代码请用 normalized_view_full。"""
    return normalized_view_full(ex)

def payload_biz(ex):
    """biz 口径：剔除提交时间（row[0]）后的业务内容——v2p6 并列测量层 biz_digest（版本化）。
    仅作并列测量（duplicate_entry/exact_duplicate），不改变硬判定、不宣称恢复/计薪/同一事件。"""
    return hashlib.sha256(json.dumps(ex.get("row", [])[1:], sort_keys=True).encode()).hexdigest()

def top_ns(ns):
    return (ns or "").split(":")[0]

print("=" * 72)
print("提交方报告：T1-B PKC-v2p7 只读离线测试（EXIT 仅表示提交方断言自洽）")
print("=" * 72)

# ---------- A. 回归常量 + 逐档 first_seen 向量 + 非有限计数 + special ----------
arch = O.load("archives_scrubbed.json")
live = O.load("live_scrubbed.json")
recs = {}
for a in arch:
    for srow, r in a["rows"]:
        r = tuple(r); k = O.key_of(r)
        if k not in recs:
            recs[k] = [O.bizdate(r[1]), O.s(r[2]), O.s(r[3]), O.s(r[4]), O.s(r[5]), O.s(r[6]), O.s(r[7]), O.s(r[8]), srow, a["name"]]
live_rows = [list(r) for _, r in live["rows"]]

def is_leave(k):
    return recs[k][3] == "休假" or recs[k][4].upper() == "OFF-WORK"
leave_keys = {k for k in recs if is_leave(k)}
union = len(recs)
after_excl = {k for k in recs if k not in leave_keys}
special = RA["special_key"]
final = {k for k in after_excl if k != special}

# 有限可解析工时合计（非法/非数值不计入，不称工时 0，非完整业务总工时）
hsum_after = sum(v for v in (ph(recs[k][5]) for k in after_excl) if v is not None)
hsum_final = sum(v for v in (ph(recs[k][5]) for k in final) if v is not None)
collapse = sum(1 for a in arch for srow, r in a["rows"] if O.s(r[8]) == "OFF-WORK / Leave")
first_srow = min((srow for a in arch for srow, r in a["rows"] if O.s(r[8]) == "OFF-WORK / Leave"), default=None)
nonfinite_after = sum(1 for k in after_excl if ph(recs[k][5]) is None)
nonfinite_final = sum(1 for k in final if ph(recs[k][5]) is None)

# first_seen_19 逐档向量（每档首次新增键数，非各档首次行号）
seen = set(); vec = []
for a in arch:
    cnt = 0
    for srow, r in a["rows"]:
        k = O.key_of(tuple(r))
        if k not in seen:
            seen.add(k); cnt += 1
    vec.append(cnt)

print("=== A. 冻结副本复算 + 逐档向量 ===")
check("union", union, RA["union"])
check("leave_exclusion_5084", len(leave_keys), RA["leave_exclusion_5084"])
check("after_exclusion_11682", len(after_excl), RA["after_exclusion_11682"])
check("final_11681", len(final), RA["final_11681"])
check("finite_parseable_hours_11682", round(hsum_after, 1), RA["finite_parseable_hours_11682"])
check("finite_parseable_hours_11681", round(hsum_final, 1), RA["finite_parseable_hours_11681"])
check("hours_diff_indep", round(hsum_after - hsum_final, 1), RA["hours_diff_indep"])
check("special_in_after_excl", special in after_excl, RA["special_in_after_excl"])
check("special_not_in_final", special not in final, RA["special_not_in_final"])
check("special_hours_nonfinite", ph(recs[special][5]) is None, RA["special_hours_nonfinite"])
check("non_finite_in_after_excl", nonfinite_after, RA["non_finite_in_after_excl"])
check("non_finite_in_final", nonfinite_final, RA["non_finite_in_final"])
check("collapse_4568", collapse, RA["collapse_4568"])
check("first_srow_8018", first_srow, RA["first_srow_8018"])
check("live_eff", len(live_rows), RA["live_eff"])
check("first_seen_19_vector", vec, RA["first_seen_19_vector"])
# 去除恒真自检：prod/master 行数归提交方报告，不充独立断言
dn = RA["declared_not_asserted"]
print("  [提交方报告，非独立断言] prod_rows=%d master_ts=%d master_leave=%d" % (dn["prod_rows"], dn["master_ts_rows"], dn["master_leave_rows"]))

# ---------- A2. 投影规则 P（真实 15/9 列布局 -> 规范 9 列视图）----------
# 契约规范视图 = [0]提交时间 [1]日期 [2]姓名 [3]类型 [4]项目 [5]工时 [6]备注 [7]请假标识 [8]UUID
# 真实布局    = [0]录入时间 [1]日期 [2]姓名 [3]类型 [4]阶段 [5]项目编号 [6]工时 [7]备注 [8]UUID
# prod/live 为 15 列（前 9 列与 archives 同构，col9 起为自动列，不进规范视图）。
PSEUDO_CONSTANTS = ("OFF-WORK / Leave", "AUTO_LEAVE")

# 时间尾串白名单与 canon_date 由单一实现模块提供（Tom 23:58 二：统一函数/版本，
# 并补时间分量范围校验——形状匹配不等于时间有效）。
TIME_TAIL = CD.TIME_TAIL
canon_date = CD.canon_date

def project(real):
    """投影规则 P：真实布局 -> 规范 9 列视图（阶段列/自动列丢弃；请假标识派生；UUID 原值）。"""
    real = [O.s(x) for x in real]
    leave = "LEAVE" if (real[4] == "休假" or real[5].upper() == "OFF-WORK") else ""
    return [real[0], canon_date(real[1]), real[2], real[3], real[5], real[6], real[7], leave, real[8]]

ALLOWED_WIDTHS = (9, 15)
def project_checked(real):
    """布局校验前置（Tom 22:22）：仅接受 9/15 列；其他列宽 -> schema_width_mismatch，
    短行（<9）-> missing_column——不静默取前九列继续投影。"""
    if len(real) < 9: return "missing_column", None
    if len(real) not in ALLOWED_WIDTHS: return "schema_width_mismatch", None
    return None, project(real)

def classify_row_reason(row9, sid):
    """投影后分类/路由判定（行级规则，无 ns/snap 上下文）——供 A2b 端到端断言。
    与 classify_single 同一规则集，仅省去 ns/snap 检查（投影用例不携带命名空间坐标）。"""
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

print("=== A2. 投影规则 P（15/9 列真实布局 -> 规范 9 列视图；Tom v2p3「C 段映射放行」正面回应）===")
print("  -- A2a 投影字面相等（project(raw) == expected）--")
for pj in FIX["projection_cases"]:
    route_hint, got = project_checked(pj["raw"])
    if pj["expected"] is None:
        # 未知布局/短行：不投影，expected 为空，改由 A2b 断言路由
        ok = (route_hint == pj.get("expected_route"))
        if not ok: fails.append("A2a.%s route=%r exp=%r" % (pj["id"], route_hint, pj.get("expected_route")))
        print("  %-5s %-14s %s  %s" % (pj["id"], pj["side"], "OK" if ok else "DIFF", pj["note"]))
        continue
    exp = [O.s(x) for x in pj["expected"]]
    ok = (got == exp)
    if not ok: fails.append("A2a.%s got=%r exp=%r" % (pj["id"], got, exp))
    print("  %-5s %-14s %s  %s" % (pj["id"], pj["side"], "OK" if ok else "DIFF", pj["note"]))
print("  -- A2b 投影后分类/路由端到端（project -> classify_single 的 reason；Tom 22:22 要求分列）--")
for pj in FIX["projection_cases"]:
    route_hint, got = project_checked(pj["raw"])
    act = route_hint if route_hint else classify_row_reason(got, O.s(got[8]))
    exp_r = pj.get("expected_route")
    ok = (act == exp_r)
    if not ok: fails.append("A2b.%s route=%r exp=%r" % (pj["id"], act, exp_r))
    print("  %-5s %-14s -> %-24s exp=%-24s %s" % (pj["id"], pj["side"], act, exp_r, "OK" if ok else "DIFF"))
print("  [注] 规范视图由真实布局经 P 投影得到；契约不冒称原 C 15 列布局即规范视图（v2 文档 §3）。")
print("  [注] P 为派生视图非删除：原始行（含阶段列）在冻结副本完整保留；biz 摘要为投影后 row[1:]，"
      "故仅阶段不同的原始行可得相同 biz——另由 source_full_digest 显式暴露差异（见 C2 诊断）。")

# ---------- B. 幂等 state 模型（结构化键含显式 ver + 更正链 + 重放前序绑定）----------
def id_key(d):
    return json.dumps({"se": d["source_event_id"], "op": d["op"], "rv": d["rule_version"],
                       "ns": d["namespace"], "ver": d.get("ver", 0)},
                      sort_keys=True, ensure_ascii=False)

print("=== B. 幂等 state 模型（v2p7：更正链 ver + 重放须同前序；前序按稳定版本坐标绑定）===")
state = {}      # identity_key -> {digest, pred, version}（仅 created/合法 versioned 提交）
accepted = {}   # tag -> {key, se, ns, rv, ver, digest}（已接受记录，供前序校验）
EX = FIX["idempotency_state_model"]["cases"]
EXPECT = {c["tag"]: c["expected"] for c in EX}

def pred_coord(tag):
    """前驱的**稳定版本坐标** (se, rv, ns, ver) —— v2p7（Tom 23:58 四）：
    前序按稳定身份绑定、别名规范化，重放**不再比较字面 tag**。
    不含 op：更正链跨 op（UPSERT ver=0 -> CORRECT ver=1），版本坐标才是前驱定位依据。
    tag 未登记（未被接受）时返回 None。"""
    p = accepted.get(tag)
    if not p: return None
    return (p["se"], p["rv"], p["ns"], p["ver"])

def pred_valid(pred_tag, c):
    """前序校验：tag 必须已被接受；ver 严格前驱(pred.ver = c.ver-1)；se/ns/rv 一致"""
    p = accepted.get(pred_tag)
    if not p:
        return False
    return (p["ver"] == c.get("ver", 0) - 1
            and p["se"] == c["source_event_id"] and p["ns"] == c["namespace"] and p["rv"] == c["rule_version"])

for c in EX:
    k = id_key(c)
    if c["op"] == "UPSERT":
        if k not in state:
            state[k] = {"digest": c["payload_digest"], "pred": None, "version": c.get("ver", 0)}
            accepted[c["tag"]] = {"key": k, "se": c["source_event_id"], "ns": c["namespace"],
                                  "rv": c["rule_version"], "ver": c.get("ver", 0), "digest": c["payload_digest"]}
            got = "created"
        elif state[k]["digest"] == c["payload_digest"]:
            accepted[c["tag"]] = {"key": k, "se": c["source_event_id"], "ns": c["namespace"],
                                  "rv": c["rule_version"], "ver": c.get("ver", 0), "digest": c["payload_digest"]}
            got = "idempotent"                      # 状态保持；重放亦为已接受事件，登记 tag 指向同一状态
        else:
            got = "conflict"                        # 状态保持，不覆写
    elif c["op"] == "CORRECT":
        if not pred_valid(c.get("predecessor"), c):
            got = "rejected"                        # 无前序/假前序/链断裂：不写状态
        elif k not in state:
            state[k] = {"digest": c["payload_digest"], "pred": c["predecessor"], "version": c.get("ver", 0)}
            accepted[c["tag"]] = {"key": k, "se": c["source_event_id"], "ns": c["namespace"],
                                  "rv": c["rule_version"], "ver": c.get("ver", 0), "digest": c["payload_digest"]}
            got = "versioned"
        elif state[k]["digest"] == c["payload_digest"] and pred_coord(state[k]["pred"]) == pred_coord(c.get("predecessor")):
            # v2p7：比较前驱的**稳定版本坐标**而非字面 tag（别名规范化；Tom 23:58 四）
            accepted[c["tag"]] = {"key": k, "se": c["source_event_id"], "ns": c["namespace"],
                                  "rv": c["rule_version"], "ver": c.get("ver", 0), "digest": c["payload_digest"]}
            got = "idempotent"                      # 重放须同身份+同摘要+同前序；重放亦登记 tag
        else:
            got = "conflict"                        # 异摘要或异前序**身份**：状态保持
    else:
        got = "unknown_op"
    check("idempotency:%s" % c["tag"], got, EXPECT[c["tag"]])
    print("  %-16s -> %-18s exp=%-18s %s" % (c["tag"], got, EXPECT[c["tag"]], "OK" if got == EXPECT[c["tag"]] else "DIFF"))

# ---------- B2. 实现边界登记（Tom 22:17；登记不断言失败，证明边界真实存在）----------
print("=== B2. 实现边界登记（Tom 22:17 三条；提交方如实登记，不声称任意输入保证不变量）===")
# 边界①：UPSERT ver=0 / CORRECT ver>=1 无入口强制类型/范围校验。
# 构造「非零 UPSERT」（ver=1）会因 id_key 含 ver 而另建基版——证明不变量依赖入口约束。
b1 = {"source_event_id": "BND-1", "op": "UPSERT", "rule_version": "PKC-v2p7", "namespace": "prod", "ver": 1,
      "snapshot_id": "C-v20261015", "source_record_id": "BND-1", "payload_digest": "dX"}
k_upsert0 = id_key({"source_event_id": "BND-1", "op": "UPSERT", "rule_version": "PKC-v2p7", "namespace": "prod", "ver": 0})
k_upsert1 = id_key(b1)
bnd1_new_base = (k_upsert0 != k_upsert1)  # ver 参与身份键 → 非零 UPSERT 是另一基版
check("B2.boundary1_nonzero_upsert_is_new_base", bnd1_new_base, True)
print("  边界① UPSERT ver=1 与 ver=0 身份键不同（另建基版）-> 已登记：%s"
      % ("成立，不变量依赖入口强制校验（当前未实现，不声称任意输入保证）" if bnd1_new_base else "不成立"))
# 边界②：accepted 别名 tag 与稳定事件身份定义——v2p7 起**文字与实现一致**（Tom 23:58 四）：
#   accepted[tag] 为请求别名（重试可换 tag）；稳定事件身份 = id_key=(se,op,rv,ns,ver)；
#   **前序按稳定版本坐标 (se,rv,ns,ver) 绑定并规范化别名**（不含 op：更正链跨 op），
#   重放比较版本坐标而非字面 tag -> 同身份别名 E1-upsert-2 重放为 idempotent（B 段 v1d）；
#   异身份前驱由前序存在性/se/ns/rv 校验拦截为 rejected（v1f），不当 conflict。
bnd2_ok = (EXPECT.get("E1-correct-v1d") == "idempotent" and EXPECT.get("E1-correct-v1f") == "rejected")
check("B2.boundary2_pred_by_stable_identity", bnd2_ok, True)
print("  边界② 前序按稳定版本坐标绑定 + 别名规范化：v1d(同身份别名)=%s / v1f(异身份前驱)=%s -> %s"
      % (EXPECT.get("E1-correct-v1d"), EXPECT.get("E1-correct-v1f"),
         "文字与实现一致（v2p6 曾比较字面 tag 判 conflict，与『tag 为请求别名』矛盾）" if bnd2_ok else "不一致"))
# 边界③：关系组完整坐标重复诊断——由 C 段 by_coord 构建时显式登记（见 C 段 coord_duplicates）。
print("  边界③ 关系组 by_coord 坐标重复诊断 -> 由 C 段 eval_ls_group 显式登记（N23/N23b 触发）")

# ---------- C. 索引自建分类（不带 group 标签；硬失败先行；关系只增不减）----------
def classify_single(ex):
    row = ex.get("row", [])
    ns, sid, snap = ex.get("namespace", ""), ex.get("source_record_id", ""), ex.get("snapshot_id", "")
    if len(row) < 9: return "isolated", "missing_column"
    if len(row) > 9: return "isolated", "schema_width_mismatch"
    if all(O.s(x) == "" for x in row): return "isolated", "placeholder_empty_row"
    if not (ns and sid and snap): return "isolated", "empty_required_key"
    if O.s(row[8]) in PSEUDO_CONSTANTS: return "isolated", "pseudo_uuid_collapse"
    cal = O.s(row[1])
    if cal == "": return "isolated", "empty_date"
    if not valid_calendar(cal): return "isolated", "illegal_calendar"
    hv = O.s(row[5])
    if hv.upper() in ("NAN",): return "isolated", "non_finite_nan"
    if hv.upper() in ("INFINITY", "INF"): return "isolated", "non_finite_inf"
    if O.s(row[4]).upper() != "OFF-WORK" and ph(row[5]) is None: return "isolated", "non_finite_hours"
    return "normal", "ok"

def parse_segments(s):
    segs = []
    for part in s.split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-"); segs.append((int(a), int(b)))
        else:
            segs.append((int(part), int(part)))
    return segs

def classify_pagination(declared, present):
    lo, hi = declared
    if not isinstance(lo, int) or not isinstance(hi, int) or lo > hi:
        return "pagination_invalid_range"
    try:
        segs = parse_segments(present)
    except (ValueError, AttributeError):
        return "pagination_invalid_format"
    if not segs:
        return "pagination_invalid_range"
    for a, b in segs:
        if a > b:
            return "pagination_invalid_range"
        if a < lo or b > hi:
            return "pagination_out_of_bounds"     # 越界显式失败，不静默裁剪
    segs = sorted(segs)
    for i in range(len(segs) - 1):
        if segs[i][1] >= segs[i + 1][0]:
            return "pagination_overlap"
    covered = set()
    for a, b in segs:
        covered.update(range(a, b + 1))
    full = set(range(lo, hi + 1))
    if covered == full: return "pagination_complete"
    max_cov = max(b for a, b in segs)
    return "pagination_truncated" if max_cov < hi else "pagination_missing_segment"

def parse_mapping(mb):
    """结构化映射校验：必须为 dict，含 maps_to{namespace,source_record_id,snapshot_id} + evidence"""
    if mb is None or mb == "":
        return ("mapping_missing", None)
    if not isinstance(mb, dict):
        return ("mapping_not_structured", None)     # 任意非空字符串不接受
    tgt = mb.get("maps_to"); ev = mb.get("evidence")
    if not isinstance(tgt, dict) or not ev:
        return ("mapping_not_structured", None)
    if not all(isinstance(tgt.get(f), str) and tgt.get(f) for f in ("namespace", "source_record_id", "snapshot_id")):
        return ("mapping_not_structured", None)
    return (None, tgt)

results = {}
for ex in FIX["positive_examples"] + FIX["negative_examples"]:
    st, rsn = classify_single(ex)
    results[ex["id"]] = {"status": st, "reason": rsn, "ex": ex}

def isolate(eid, reason):
    results[eid]["status"] = "isolated"
    results[eid]["reason"] = reason

# G1（硬失败）：同 (namespace, snapshot, source_record_id) 多例且 full payload 不同
# （v2p6 起：恢复 full 口径——Tom 明示「不为降低隔离数选口径」；biz 口径降级为 C2 并列测量层；
#   v2p7 起：规范视图相同但原行不同 -> source_conflict 硬判定，原行差异不得被放行）
key_index = {}
for eid, rec in results.items():
    ex = rec["ex"]
    sid = ex.get("source_record_id", "")
    if not sid:  # 空键不能构成真实同键冲突，跳过
        continue
    k = (ex.get("namespace", ""), ex.get("snapshot_id", ""), sid)
    key_index.setdefault(k, []).append(eid)
for k, ids in key_index.items():
    if len(ids) < 2:
        continue
    nvs = {normalized_view_full(results[i]["ex"]) for i in ids}
    if len(nvs) > 1:
        # 规范视图内容不同 -> 既有硬判定（Tom 22:18：full 口径，不为降低隔离数选口径）
        for i in ids:
            isolate(i, "same_key_diff_content")
        continue
    # 规范视图相同：**原行差异不得被放行**（Tom 23:58 一）——保留原行只是可追溯，
    # 不等于原行差异未被放行。v2p7 将其纳入硬判定：原行不同 -> source_conflict（待业务裁定）。
    srcs = [source_full(results[i]["ex"]) for i in ids]
    if any(s is None for s in srcs):
        continue                       # 缺原始行信息：不猜测、不比较，维持既有判定
    if len(set(srcs)) > 1:
        for i in ids:
            if results[i]["status"] != "isolated":
                isolate(i, "source_conflict")     # 不宣称精确重复、不宣称恢复正常

# G4 分页（硬失败先行：四态 + 越界/倒序/异常格式显式失败）
for eid, rec in results.items():
    pg = rec["ex"].get("pagination")
    if pg:
        verdict = classify_pagination(pg["declared_range"], pg["present"])
        if verdict == "pagination_complete":
            if results[eid]["status"] != "isolated":
                results[eid]["status"] = "normal"; results[eid]["reason"] = "pagination_complete"
        else:
            isolate(eid, verdict)

# G2/G3（关系校验：硬失败全部确定后，不动点传播至稳定；只增不减；不依赖 group 标签）
ls_index = {}
for eid, rec in results.items():
    ls = rec["ex"].get("logical_source_id")
    if ls: ls_index.setdefault(ls, []).append(eid)

# 跨组完整坐标索引 + 坐标重复诊断登记（Tom 22:17 边界③：不由字典覆盖替代审计）
# 诊断为静态属性：仅在组首次评估时构建/登记，不随不动点轮次重复
by_coord_global = {}
coord_duplicates = []
evaluated_groups = set()

def eval_ls_group(ids):
    """评估一个 logical_source 组；返回新增隔离的 eid 集合（关系只增不减）。"""
    newly = set()
    exs = {i: results[i]["ex"] for i in ids}
    tops = {top_ns(exs[i].get("namespace", "")) for i in ids}
    # 完整坐标重复诊断（Tom 22:17 边界③）：按 (namespace, source_record_id, snapshot_id)
    # 建索引时显式登记重复，不由字典覆盖替代审计；仅组首次评估时构建（不随不动点轮次重复）
    gkey = tuple(sorted(ids))
    if gkey not in evaluated_groups:
        evaluated_groups.add(gkey)
        for i in ids:
            c = (exs[i].get("namespace", ""), exs[i].get("source_record_id", ""), exs[i].get("snapshot_id", ""))
            if c in by_coord_global:
                coord_duplicates.append((c, by_coord_global[c], i))
            else:
                by_coord_global[c] = i
    # 快照坐标 = (namespace, snapshot_id)：同 ns 不同 snapshot 是不同快照，不是同快照重复
    coords = {(exs[i].get("namespace", ""), exs[i].get("snapshot_id", "")) for i in ids}
    if len(coords) < 2:
        for i in ids:
            if results[i]["status"] != "isolated":
                isolate(i, "logical_source_duplicate_in_snapshot"); newly.add(i)
        return newly
    side = "cross_side" if len(tops) >= 2 else "same_side"
    sids = {exs[i].get("source_record_id", "") for i in ids}
    if len(sids) == 1:
        # 键未变：共享稳定来源 ID（跨侧/跨快照）
        if any(results[i]["status"] == "isolated" for i in ids):
            for i in ids:
                if results[i]["status"] != "isolated":
                    isolate(i, "linked_record_isolated"); newly.add(i)
        else:
            for i in ids:
                if results[i]["status"] != "isolated":
                    results[i]["status"] = "normal"
                    results[i]["reason"] = ("cross_side_stable_ok_shared_guid" if side == "cross_side"
                                            else "cross_snapshot_stable_ok_shared_guid")
        return newly
    # 异键：须有效映射（结构化 + 目标按完整坐标实际存在于组内 + 证据引用存在）
    by_coord = {(exs[i].get("namespace", ""), exs[i].get("source_record_id", ""), exs[i].get("snapshot_id", "")): i for i in ids}
    valid_map = {}
    for i in ids:
        rsn, tgt = parse_mapping(exs[i].get("mapping_basis"))
        if rsn:
            if results[i]["status"] != "isolated":
                isolate(i, rsn); newly.add(i)
            continue
        j = by_coord.get((tgt["namespace"], tgt["source_record_id"], tgt["snapshot_id"]))
        if (not j) or j == i:
            if results[i]["status"] != "isolated":
                isolate(i, "mapping_target_mismatch"); newly.add(i)
            continue
        valid_map[i] = j
    # 传播：映射目标被隔离 -> 本方也隔离（含目标因分页等硬失败被隔离的情形）
    for i in ids:
        j = valid_map.get(i)
        if j and results[i]["status"] != "isolated" and results[j]["status"] == "isolated":
            isolate(i, "mapping_target_isolated"); newly.add(i)
    for i in ids:
        j = valid_map.get(i)
        if j and results[i]["status"] != "isolated":
            results[i]["status"] = "normal"
            results[i]["reason"] = ("cross_side_stable_ok_valid_mapping" if side == "cross_side"
                                    else "cross_snapshot_stable_ok_valid_mapping")
    return newly

# 不动点：重复评估所有组直到无新增隔离（跨组传播闭合）
changed = True
rounds = 0
while changed:
    changed = False
    rounds += 1
    for ls, ids in ls_index.items():
        if len(ids) >= 2 and eval_ls_group(ids):
            changed = True
print("  [关系不动点传播] 收敛轮数=%d" % rounds)

# ---------- C2. 并列测量层（biz_digest 版本化；T1 双轨——只加标记不改硬判定）----------
# 同 (namespace, snapshot, sid) 组（>=2 行）按 biz（剔除提交时间）测量：
#   full 全同 -> exact_duplicate；biz 全同且 full 不全同（仅提交时间不同）-> duplicate_entry；
#   biz 亦不同 -> 无标记（内容冲突已由 G1 full 口径硬判定）。
# 测量层不改变 status/reason 硬判定、不宣称恢复正常/有效计薪/同一事件；
# first-seen 仅聚合复算既定代表选择（合并层行为，不证明多条业务事件应合为一条）。
# 测量层命名（v2p7，Tom 23:58 一）：
#   normalized_view_equal = **规范视图**相等（不宣称原始行相等；原行信息缺失时亦用此名，不作原行认证）
#   source_conflict       = 规范视图相等但**原始行不同**（原行差异未被放行的并列测量标记）
#   duplicate_entry       = 仅提交时间不同（biz 相等、规范视图不等）
measures = {}   # (ns,snap,sid) -> measure or None
for k, ids in key_index.items():
    if len(ids) < 2:
        continue
    nvs = {normalized_view_full(results[i]["ex"]) for i in ids}
    bizs = {payload_biz(results[i]["ex"]) for i in ids}
    srcs = [source_full(results[i]["ex"]) for i in ids]
    src_conflict = None if any(s is None for s in srcs) else len(set(srcs)) > 1
    if len(nvs) == 1:
        m = "source_conflict" if src_conflict else "normalized_view_equal"
    elif len(bizs) == 1:
        m = "duplicate_entry"
    else:
        m = None
    measures[k] = m
    print("  [并列测量] %-44s %s" % ("%s/%s/%s" % k, m or "(无标记：biz 亦不同)"))
# 投影折叠差异诊断（Tom 22:22 一）：biz 是投影后 row[1:]（阶段列/自动列已丢失），
# 仅阶段不同的两条原始行可得相同 P 与 biz —— 另存原始全行摘要显式暴露差异。
# 仅对组内全部用例均带 source_row 的组计算（否则 None，不比较）。
source_diff = {}
for k, ids in key_index.items():
    if len(ids) < 2:
        continue
    srcs = [results[i]["ex"].get("source_row") for i in ids]
    if any(s is None for s in srcs):
        source_diff[k] = None
    else:
        digests = {hashlib.sha256(json.dumps(s, sort_keys=True).encode()).hexdigest() for s in srcs}
        source_diff[k] = len(digests) > 1
# expected_measure 逐例断言：有声明必须相符；无声明其组必须无标记
for ex in FIX["positive_examples"] + FIX["negative_examples"]:
    sid = ex.get("source_record_id", "")
    k = (ex.get("namespace", ""), ex.get("snapshot_id", ""), sid) if sid else None
    got = measures.get(k) if k else None
    exp = ex.get("expected_measure")
    if exp is not None:
        check("C2.measure:%s" % ex["id"], got, exp)
    else:
        check("C2.measure_none:%s" % ex["id"], got, None)
    # 投影折叠差异：仅对声明了 expected_source_field_diff 的用例断言
    esd = ex.get("expected_source_field_diff")
    if esd is not None:
        check("C2.source_field_diff:%s" % ex["id"], source_diff.get(k) if k else None, esd)
for k, v in sorted(source_diff.items()):
    if v is not None:
        print("  [投影折叠差异诊断] %-42s source_field_diff=%s（原始行不同但规范视图相同，须业务裁定）"
              % ("%s/%s/%s" % k, v))
# 坐标重复诊断断言（N23/N23b 应触发一次登记；其余组不触发）
check("C2.coord_dup_count", len(coord_duplicates), 1)
if coord_duplicates:
    c0 = coord_duplicates[0][0]
    check("C2.coord_dup_coord", c0, ("prod", "COORD-DUP", "C-v20261015"))
    print("  [坐标重复诊断] %s 涉及 %s/%s（显式登记，非字典静默覆盖）" % (c0, coord_duplicates[0][1], coord_duplicates[0][2]))

print("=== C. PKC-v2p7 索引自建分类（硬失败先行 + 关系不动点 + C2 并列测量层 + 原行冲突硬判定）===")
for ex in FIX["positive_examples"] + FIX["negative_examples"]:
    r = results[ex["id"]]
    if ex["expected_status"] == "isolated":
        ok = (r["status"] == "isolated" and r["reason"] == ex["expected_reason"])
    else:
        ok = (r["status"] == "normal" and r["reason"] == ex.get("expected_reason"))  # normal reason 也断言
    if not ok: fails.append("C.%s status=%s reason=%s exp=%s/%s" % (ex["id"], r["status"], r["reason"], ex["expected_status"], ex.get("expected_reason", "")))
    print("  %-6s -> %-10s %-36s exp=%-10s %-36s %s" % (ex["id"], r["status"], r["reason"], ex["expected_status"], ex.get("expected_reason", ""), "OK" if ok else "DIFF"))

# ---------- D. fixture meta 自洽（独立）+ 外置 manifest 绑定校验 + 依赖 SHA ----------
print("=== D. fixture meta 自洽 + 外置 manifest 绑定校验 ===")
# fixture meta 自洽：sha256 字段为空串时重算应等于声明值（always 断言，不依赖 manifest）
fp = os.path.join(HERE, "t1b_offline_fixture_v2p7.json")
fxj = json.load(open(fp, encoding="utf-8"))
fxb = copy.deepcopy(fxj); fxb["meta"]["sha256"] = ""
fx_rec = hashlib.sha256(json.dumps(fxb, ensure_ascii=False, indent=2).encode()).hexdigest()
ok = (fx_rec == fxj["meta"]["sha256"])
if not ok: fails.append("D.fixture_meta act=%s exp=%s" % (fx_rec, fxj["meta"]["sha256"]))
print("  %-40s %s" % ("fixture meta.sha256(self)", "OK" if ok else "DIFF"))
ok = (fxj["meta"]["rule_version"] == "PKC-v2p7")
if not ok: fails.append("D.rule_version act=%s exp=PKC-v2p7" % fxj["meta"]["rule_version"])
print("  %-40s %s" % ("meta.rule_version == PKC-v2p7", "OK" if ok else "DIFF"))

mp = os.path.join(HERE, "t1b_v2p7_manifest.json")
# 固定必需条目集合（Tom 23:58 三）：不仅「列出的文件要匹配」，还断言**必须具备**这些条目——
# 多/少/缺整段均 FAIL；不把「仅列出的文件均匹配」扩写为「全部输入已绑定」。
REQUIRED_DELIVERABLES = {
    "T1B_主键契约与离线设计_v2p7.md",
    "t1b_offline_fixture_v2p7.json",
    "t1b_offline_test_v2p7.py",
    "t1b_key_registry_v2p3.csv",
}
REQUIRED_SUPPORTING = {
    "T1B_v2p7_差异矩阵_20261024.md",
    "t1b_layer_conversion_v2p7.json",
    "t1b_layer_conversion_v2p7.py",
    "build_fixture_v2p7.py",
    "t1b_schema_registry_v2p7.json",
    "t1b_schema_registry_v2p7.py",
    "t1b_canon_date_v2p7.py",
}
REQUIRED_DEPS = {"offline_recompute_scrubbed.py"}

def sha_of(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest() if os.path.exists(p) else None

def verify_binding(man):
    """外置绑定校验（可复用：既用于真实 manifest，也用于负向自检）。返回问题列表（空=通过）。"""
    bad = []
    dl = man.get("deliverables", {})
    sp = man.get("supporting", {})
    dp = man.get("dependencies", {})
    if set(dl) != REQUIRED_DELIVERABLES: bad.append("deliverables_set")
    if set(sp) != REQUIRED_SUPPORTING: bad.append("supporting_set")
    if set(dp) != REQUIRED_DEPS: bad.append("dependencies_set")
    for fn, exp in dl.items():
        if sha_of(os.path.join(HERE, fn)) != exp: bad.append("deliverable:%s" % fn)
    for fn, exp in sp.items():
        if sha_of(os.path.join(HERE, fn)) != exp: bad.append("supporting:%s" % fn)
    d = dp.get("offline_recompute_scrubbed.py")
    if not d or sha_of(os.path.join(SCRUB, "offline_recompute_scrubbed.py")) != d:
        bad.append("dependency")
    er = man.get("externally_referenced", {})
    arc = er.get("archives_scrubbed.json", {}).get("copy_sha256")
    if not arc or sha_of(os.path.join(SCRUB, "archives_scrubbed.json")) != arc:
        bad.append("archives_copy")
    # live 实际参与 A 段读取 —— v2p7 起对其声明 SHA 执行字节比对（此前只读未校验）
    lv = er.get("live_scrubbed.json", {}).get("sha256_scrubbed")
    if not lv or sha_of(os.path.join(SCRUB, "live_scrubbed.json")) != lv:
        bad.append("live_scrubbed")
    return bad

if os.path.exists(mp):
    man = json.load(open(mp, encoding="utf-8"))
    for fn, exp_sha in man["deliverables"].items():
        act = sha_of(os.path.join(HERE, fn))
        ok = (act == exp_sha)
        if not ok: fails.append("D.manifest:%s act=%s exp=%s" % (fn, act, exp_sha))
        print("  %-40s %s" % (fn, "OK" if ok else "DIFF"))
    # supporting（辅助脚本/新交付，按实际范围显式绑定：Tom 22:22 要求「显式绑定其 SHA 或说明仅辅助脚本」）
    for fn, exp_sha in man.get("supporting", {}).items():
        act = sha_of(os.path.join(HERE, fn))
        ok = (act == exp_sha)
        if not ok: fails.append("D.supporting:%s act=%s exp=%s" % (fn, act, exp_sha))
        print("  %-40s %s" % (fn + "(supporting)", "OK" if ok else "DIFF"))
    # 依赖（offline_recompute_scrubbed.py）SHA 绑定
    dep_sha = man.get("dependencies", {}).get("offline_recompute_scrubbed.py")
    if dep_sha:
        act_dep = sha_of(os.path.join(SCRUB, "offline_recompute_scrubbed.py"))
        ok = (act_dep == dep_sha)
        if not ok: fails.append("D.dependency act=%s exp=%s" % (act_dep, dep_sha))
        print("  %-40s %s" % ("offline_recompute_scrubbed.py(dep)", "OK" if ok else "DIFF"))
    else:
        fails.append("D.dependency_missing")
        print("  %-40s %s" % ("offline_recompute_scrubbed.py(dep)", "MISSING"))
    arc_copy = man["externally_referenced"]["archives_scrubbed.json"]["copy_sha256"]
    act_arc = sha_of(os.path.join(SCRUB, "archives_scrubbed.json"))
    ok = (act_arc == arc_copy)
    if not ok: fails.append("D.archives_copy act=%s exp=%s" % (act_arc, arc_copy))
    print("  archives_scrubbed.json(copy) %s" % ("OK" if ok else "DIFF"))
    # live 参与 A 段读取 -> 对其声明 SHA 执行实际字节比对（v2p7，Tom 23:58 三）
    live_exp = man.get("externally_referenced", {}).get("live_scrubbed.json", {}).get("sha256_scrubbed")
    act_live = sha_of(os.path.join(SCRUB, "live_scrubbed.json"))
    ok = (live_exp is not None and act_live == live_exp)
    if not ok: fails.append("D.live_scrubbed act=%s exp=%s" % (act_live, live_exp))
    print("  %-40s %s" % ("live_scrubbed.json(读取依赖)", "OK" if ok else "DIFF"))
    # 完整必需集合断言 + 三类负向自检（证明校验真的会失败，而非恒真）
    bad = verify_binding(man)
    if bad: fails.append("D.binding_set:%s" % ",".join(bad))
    print("  %-40s %s" % ("固定必需条目集合（4+7+1）", "OK" if not bad else "DIFF:" + ",".join(bad)))
    v1 = copy.deepcopy(man); v1["deliverables"].pop("t1b_key_registry_v2p3.csv", None)
    v2 = copy.deepcopy(man); v2.pop("supporting", None)
    v3 = copy.deepcopy(man)
    v3["externally_referenced"]["live_scrubbed.json"]["sha256_scrubbed"] = "0" * 64
    for name, var in (("删清单键", v1), ("删 supporting 段", v2), ("替换 live SHA", v3)):
        got = verify_binding(var)
        ok = len(got) > 0
        if not ok: fails.append("D.negative_selfcheck:%s 未判失败" % name)
        print("  %-40s %s" % ("负向自检：" + name, "判 FAIL（正确）" if ok else "未判失败（缺陷）"))
else:
    # 严格验收模式（Tom 22:22 三）：缺 manifest/缺依赖/缺交付物即失败——
    # 「EXIT=0 同时证明外部绑定完整」的口径才成立；不设「未绑定预览仍 PASS」的同 PASS 输出。
    print("  manifest 缺失 -> 严格验收模式判定 FAIL（EXIT 不为 0）")
    fails.append("D.manifest_missing")

# ---------- F. 实际例数绑定 + 运行报告哈希 ----------
print("=== F. 实际例数绑定（== fixture meta.example_counts）===")
POS = FIX["positive_examples"]; NEG = FIX["negative_examples"]; SM = FIX["idempotency_state_model"]["cases"]
PJ = FIX["projection_cases"]
actual = {"positive": len(POS), "negative": len(NEG), "total": len(POS) + len(NEG),
          "state_model_cases": len(SM), "projection_cases": len(PJ)}
declared = FIX["meta"]["example_counts"]
for kk, vv in declared.items():
    check("example_counts:%s" % kk, actual.get(kk), vv)
print("  实际例数: %d 正 + %d 负 = %d；state model %d 例；projection %d 例（声明值一致）" % (
    actual["positive"], actual["negative"], actual["total"], actual["state_model_cases"], actual["projection_cases"]))
sha_test = hashlib.sha256(open(os.path.abspath(__file__), "rb").read()).hexdigest()
sha_fix = hashlib.sha256(open(os.path.join(HERE, "t1b_offline_fixture_v2p7.json"), "rb").read()).hexdigest()
sha_dep = hashlib.sha256(open(os.path.join(SCRUB, "offline_recompute_scrubbed.py"), "rb").read()).hexdigest()
print("  运行报告绑定 SHA（实际文件）:")
print("    test    t1b_offline_test_v2p7.py      = %s" % sha_test)
print("    fixture t1b_offline_fixture_v2p7.json = %s" % sha_fix)
print("    dep     offline_recompute_scrubbed.py = %s" % sha_dep)
print("  注：C 段正负例各按 status+reason 逐例断言；A2 段投影逐列断言；C2 段 expected_measure 逐例断言。")

# ---------- E. 覆盖矩阵登记 ----------
print("=" * 72)
print("覆盖矩阵（仅登记，不宣称 Tom 独立验收）：")
cov = FIX.get("coverage_matrix", {})
for k in ("implemented_and_asserted", "doc_only_or_pending", "uncovered_pending"):
    print("  [%s] %d 项" % (k, len(cov.get(k, []))))
print("-" * 72)
if fails:
    print("提交方断言 FAIL -> %d 项" % len(fails))
    for f in fails: print("   -", f)
    sys.exit(1)
print("提交方断言全过（EXIT=0 = 提交方自洽，非 Tom 独立运行/非全部契约验收）")
sys.exit(0)
