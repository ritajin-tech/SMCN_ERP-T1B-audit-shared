# -*- coding: utf-8 -*-
"""
T1-B 主键契约离线测试 v2p4（只读，不碰生产）— 提交方报告（非 Tom 独立运行）

针对 Tom 18:03 两剩余分支 + 报告数字修正：
  1) B 段更正链 + 重放前序绑定：身份键加入显式 ver（UPSERT ver=0 基版，CORRECT
     ver>=1 更正版本，支持多更正版本链）；前序须为已接受记录且 ver 严格前驱
     (pred.ver=ver-1)+se/ns/rv 一致；重放须同身份+同摘要+同前序才 idempotent；
     删前序 -> rejected；换前序/异摘要 -> conflict；conflict/rejected 不改变状态。
     覆盖 15 例（v2p3 为 10 例）。
  2) C 段硬失败先行 + 不动点传播：所有单例/G1/分页硬失败先确定，关系(G2/G3)
     随后不动点传播至稳定且只增不减；快照坐标=(namespace,snapshot_id)（同 ns
     不同 snapshot 不再误判同快照重复）；映射目标按完整坐标索引（不再按 sid 覆盖）。
     新增正例 P16/P17（同 ns 跨 snapshot 稳定键）、P18/P19/P20（三记录重复 sid
     不同完整坐标）；新增负例 N21A/N21B（目标分页失败 + 映射传播）。
  3) 报告数字绑定：断言实际例数(21 正+27 负=48，state 15)与 fixture
     meta.example_counts 一致；打印测试/fixture/依赖(offline_recompute_scrubbed.py)
     实际 SHA；manifest 绑定 dependencies SHA。
退出码：0 = 提交方断言全过；1 = 有不符；2 = 输入缺失。
"""
import sys, os, json, hashlib, math, datetime, copy
HERE = os.path.dirname(os.path.abspath(__file__))
SCRUB = os.path.join(HERE, "..", "20261014_frozen_scrubbed")
sys.path.insert(0, os.path.abspath(SCRUB))
import offline_recompute_scrubbed as O

FIX = json.load(open(os.path.join(HERE, "t1b_offline_fixture_v2p4.json"), encoding="utf-8"))
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

def payload_of(ex):
    return hashlib.sha256(json.dumps(ex.get("row", []), sort_keys=True).encode()).hexdigest()

def top_ns(ns):
    return (ns or "").split(":")[0]

print("=" * 72)
print("提交方报告：T1-B PKC-v2p4 只读离线测试（EXIT 仅表示提交方断言自洽）")
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

# ---------- B. 幂等 state 模型（结构化键含显式 ver + 更正链 + 重放前序绑定）----------
def id_key(d):
    return json.dumps({"se": d["source_event_id"], "op": d["op"], "rv": d["rule_version"],
                       "ns": d["namespace"], "ver": d.get("ver", 0)},
                      sort_keys=True, ensure_ascii=False)

print("=== B. 幂等 state 模型（v2p4：更正链 ver + 重放须同前序）===")
state = {}      # identity_key -> {digest, pred, version}（仅 created/合法 versioned 提交）
accepted = {}   # tag -> {key, se, ns, rv, ver, digest}（已接受记录，供前序校验）
EX = FIX["idempotency_state_model"]["cases"]
EXPECT = {c["tag"]: c["expected"] for c in EX}

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
        elif state[k]["digest"] == c["payload_digest"] and state[k]["pred"] == c.get("predecessor"):
            accepted[c["tag"]] = {"key": k, "se": c["source_event_id"], "ns": c["namespace"],
                                  "rv": c["rule_version"], "ver": c.get("ver", 0), "digest": c["payload_digest"]}
            got = "idempotent"                      # 重放须同身份+同摘要+同前序；重放亦登记 tag
        else:
            got = "conflict"                        # 异摘要或异前序：状态保持
    else:
        got = "unknown_op"
    check("idempotency:%s" % c["tag"], got, EXPECT[c["tag"]])
    print("  %-16s -> %-18s exp=%-18s %s" % (c["tag"], got, EXPECT[c["tag"]], "OK" if got == EXPECT[c["tag"]] else "DIFF"))

# ---------- C. 索引自建分类（不带 group 标签；硬失败先行；关系只增不减）----------
def classify_single(ex):
    row = ex.get("row", [])
    ns, sid, snap = ex.get("namespace", ""), ex.get("source_record_id", ""), ex.get("snapshot_id", "")
    if len(row) < 9: return "isolated", "missing_column"
    if len(row) > 9: return "isolated", "schema_width_mismatch"
    if all(O.s(x) == "" for x in row): return "isolated", "placeholder_empty_row"
    if not (ns and sid and snap): return "isolated", "empty_required_key"
    if O.s(row[8]) == "OFF-WORK / Leave": return "isolated", "pseudo_uuid_collapse"
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

# G1（硬失败）：同 (namespace, snapshot, source_record_id) 多例且 payload 不同
key_index = {}
for eid, rec in results.items():
    ex = rec["ex"]
    sid = ex.get("source_record_id", "")
    if not sid:  # 空键不能构成真实同键冲突，跳过
        continue
    k = (ex.get("namespace", ""), ex.get("snapshot_id", ""), sid)
    key_index.setdefault(k, []).append(eid)
for k, ids in key_index.items():
    if len(ids) >= 2 and len({payload_of(results[i]["ex"]) for i in ids}) > 1:
        for i in ids:
            isolate(i, "same_key_diff_content")

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

def eval_ls_group(ids):
    """评估一个 logical_source 组；返回新增隔离的 eid 集合（关系只增不减）。"""
    newly = set()
    exs = {i: results[i]["ex"] for i in ids}
    tops = {top_ns(exs[i].get("namespace", "")) for i in ids}
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

print("=== C. PKC-v2p4 索引自建分类（硬失败先行 + 关系不动点传播）===")
for ex in FIX["positive_examples"] + FIX["negative_examples"]:
    r = results[ex["id"]]
    if ex["expected_status"] == "isolated":
        ok = (r["status"] == "isolated" and r["reason"] == ex["expected_reason"])
    else:
        ok = (r["status"] == "normal" and r["reason"] == ex.get("expected_reason"))  # normal reason 也断言
    if not ok: fails.append("C.%s status=%s reason=%s exp=%s/%s" % (ex["id"], r["status"], r["reason"], ex["expected_status"], ex.get("expected_reason", "")))
    print("  %-6s -> %-10s %-36s exp=%-10s %-36s %s" % (ex["id"], r["status"], r["reason"], ex["expected_status"], ex.get("expected_reason", ""), "OK" if ok else "DIFF"))

# ---------- D. 外置 manifest 绑定校验 + 依赖 SHA + fixture meta 自洽 ----------
print("=== D. 外置 manifest 绑定校验 ===")
mp = os.path.join(HERE, "t1b_v2p4_manifest.json")
if os.path.exists(mp):
    man = json.load(open(mp, encoding="utf-8"))
    for fn, exp_sha in man["deliverables"].items():
        p = os.path.join(HERE, fn)
        act = hashlib.sha256(open(p, "rb").read()).hexdigest() if os.path.exists(p) else None
        ok = (act == exp_sha)
        if not ok: fails.append("D.manifest:%s act=%s exp=%s" % (fn, act, exp_sha))
        print("  %-40s %s" % (fn, "OK" if ok else "DIFF"))
    # 依赖（offline_recompute_scrubbed.py）SHA 绑定
    dep_sha = man.get("dependencies", {}).get("offline_recompute_scrubbed.py")
    if dep_sha:
        act_dep = hashlib.sha256(open(os.path.join(SCRUB, "offline_recompute_scrubbed.py"), "rb").read()).hexdigest()
        ok = (act_dep == dep_sha)
        if not ok: fails.append("D.dependency act=%s exp=%s" % (act_dep, dep_sha))
        print("  %-40s %s" % ("offline_recompute_scrubbed.py(dep)", "OK" if ok else "DIFF"))
    arc_copy = man["externally_referenced"]["archives_scrubbed.json"]["copy_sha256"]
    act_arc = hashlib.sha256(open(os.path.join(SCRUB, "archives_scrubbed.json"), "rb").read()).hexdigest()
    ok = (act_arc == arc_copy)
    if not ok: fails.append("D.archives_copy act=%s exp=%s" % (act_arc, arc_copy))
    print("  archives_scrubbed.json(copy) %s" % ("OK" if ok else "DIFF"))
    fp = os.path.join(HERE, "t1b_offline_fixture_v2p4.json")
    fxj = json.load(open(fp, encoding="utf-8"))
    fxb = copy.deepcopy(fxj); fxb["meta"]["sha256"] = ""
    fx_rec = hashlib.sha256(json.dumps(fxb, ensure_ascii=False, indent=2).encode()).hexdigest()
    ok = (fx_rec == fxj["meta"]["sha256"])
    if not ok: fails.append("D.fixture_meta act=%s exp=%s" % (fx_rec, fxj["meta"]["sha256"]))
    print("  fixture meta.sha256(self) %s" % ("OK" if ok else "DIFF"))
else:
    print("  manifest 未生成（先填 SHA 再跑）")
    fails.append("D.manifest_missing")

# ---------- F. 实际例数绑定 + 运行报告哈希 ----------
print("=== F. 实际例数绑定（== fixture meta.example_counts）===")
POS = FIX["positive_examples"]; NEG = FIX["negative_examples"]; SM = FIX["idempotency_state_model"]["cases"]
actual = {"positive": len(POS), "negative": len(NEG), "total": len(POS) + len(NEG), "state_model_cases": len(SM)}
declared = FIX["meta"]["example_counts"]
for kk, vv in declared.items():
    check("example_counts:%s" % kk, actual.get(kk), vv)
print("  实际例数: %d 正 + %d 负 = %d；state model %d 例（声明值一致）" % (
    actual["positive"], actual["negative"], actual["total"], actual["state_model_cases"]))
sha_test = hashlib.sha256(open(os.path.abspath(__file__), "rb").read()).hexdigest()
sha_fix = hashlib.sha256(open(os.path.join(HERE, "t1b_offline_fixture_v2p4.json"), "rb").read()).hexdigest()
sha_dep = hashlib.sha256(open(os.path.join(SCRUB, "offline_recompute_scrubbed.py"), "rb").read()).hexdigest()
print("  运行报告绑定 SHA（实际文件）:")
print("    test    t1b_offline_test_v2p4.py      = %s" % sha_test)
print("    fixture t1b_offline_fixture_v2p4.json = %s" % sha_fix)
print("    dep     offline_recompute_scrubbed.py = %s" % sha_dep)
print("  注：C 段正负例各按 status+reason 逐例断言；上列 SHA 为本次运行时的实际文件摘要。")

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
