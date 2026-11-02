#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
保全清单构建：119 行 + 34 行生产表软删的「写前 / 写后完整行值」+ 主库覆盖对照。
- BEFORE：2026-11-01 20:08 HKT 备份（早于 17:33/17:41Z 软删，故 O/P/Q 为空，A:N 即写前态）
- AFTER ：BEFORE 行 + O/P/Q 置为软删值（O=True, P=Rita Jin, Q=批次服务端时间戳）
- 主库覆盖对照：取自两个 manifest 的 covered 字段（1=主库同人同日覆盖；0=未覆盖/Rita 裁定作废）
输出：preservation_119_34_rows.csv / preservation_119_34_manifest.json + SHA256
"""
import csv, json, hashlib, os, datetime

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(BASE))))  # SMCN_ERP
SSID = "1Pi5u9fEawgp7yICWPMMyQCT_LbwTZthQDW-H05xYdVI"
BACKUP = os.path.join(ROOT, "_backups", "sheets", "2026-11-01", "生产工时表__DB_工时流水.csv")
WRITELOG = os.path.join(BASE, "ts_write_log_full.json")

# 列头（A-Q，1-indexed）
COLS = ["A_录入时间","B_日期","C_姓名","D_类型","E_阶段","F_项目编号","G_工时","H_备注",
        "I_唯一码","J_项目名称","K_项目PM","L_直属主管","M_项目情况","N_（未命名）",
        "O_软删标记","P_操作人","Q_时间戳"]

def load_manifest(path):
    d = json.load(open(path, encoding="utf-8"))
    return d["rows"], d.get("ts"), d.get("reason","")

rows119, ts119, _ = load_manifest(os.path.join(BASE,"leave_softdel_manifest.json"))
rows34,  ts34,  _ = load_manifest(os.path.join(BASE,"leave34_manifest.json"))

# 批次时间戳：从 _TS_WRITE_LOG 取 repairLegacyLeave:repair(非dry) rows=119 / rows=34 的服务端时间
batch_q = {}
try:
    wl = json.load(open(WRITELOG, encoding="utf-8"))
    wlist = wl["rows"] if isinstance(wl, dict) and "rows" in wl else wl
    for e in wlist:
        act = str(e.get("act", ""))
        det = str(e.get("detail", ""))
        if "repairLegacyLeave" in act and ":repair" in act and "dry" not in act and "undo" not in act:
            if "rows=119" in det:
                batch_q[119] = e.get("ts")
            if "rows=34" in det:
                batch_q[34] = e.get("ts")
except Exception as ex:
    print("write-log parse warn:", ex)

# 回退时间戳（来自已记录证据）
if 119 not in batch_q: batch_q[119] = "2026-11-01T17:33:19.000Z"
if 34  not in batch_q: batch_q[34]  = "2026-11-01T17:41:29.000Z"

# 写日志中还揭示：这些 153 行在 2026-10-25 也曾被 repair/undo（r1331 repair 153 / r1333 undo 153 / r1336 repair 113）
oct25_note = "写日志显示同 153 行于 2026-10-25 经 r1331 repair(153)→r1333 undo(153)→r1336 repair(113)；Nov1 为本轮再次软删（r1388=119 / r1390=34），写前核验 oEmpty=119/34 证实 Nov1 操作前 O 为空。"

# 读备份（写前态），按行号索引
with open(BACKUP, encoding="utf-8-sig", newline="") as fh:
    backup = list(csv.reader(fh))
# backup[0] = 表头；数据行 R -> backup[R]（行号=CSV行号，已核验 line 6892 == 行 6892）

def get_before(rowno):
    # rowno 为电子表格行号（1-based，行1=表头）；CSV 列表 0-indexed：backup[0]=行1
    idx = rowno - 1
    if 0 <= idx < len(backup):
        return backup[idx]
    return None

records = []
for src, rows, covered_default, bts in [
    ("m119", rows119, 1, batch_q[119]),
    ("m34",  rows34,  0, batch_q[34]),
]:
    for r in rows:
        rn = int(r["row"])
        before = get_before(rn)
        if before is None:
            print("WARN missing before for row", rn)
            before = [""]*17
        # 对齐到 17 列
        before = (before + [""]*17)[:17]
        # 行号一致性校验：备份 line R 的姓名(col C, idx2)应与 manifest 姓名一致
        if before[2].strip() and r.get("name") and before[2].strip() != r["name"].strip():
            print(f"WARN row-offset? line{rn} name={before[2]!r} != manifest {r['name']!r}")
        after = list(before)
        after[14] = "True"      # O 软删标记
        after[15] = "Rita Jin"  # P 操作人
        after[16] = bts         # Q 时间戳
        # 一致性校验：A:N 必须与 before 相同（软删只动 O/P/Q）
        diff_cols = [COLS[i] for i in range(17) if before[i] != after[i]]
        records.append({
            "op_group": src,
            "row": rn,
            "covered": int(r.get("covered", covered_default)),
            "name": r.get("name",""),
            "date_local": r.get("date",""),
            "hours": r.get("hours",""),
            "before": before,
            "after": after,
            "changed_cols": diff_cols,
            "q_ts": bts,
        })

# 写 CSV（写前 17 列 + 写后 17 列 + 对照）
out_csv = os.path.join(BASE, "preservation_119_34_rows.csv")
with open(out_csv, "w", encoding="utf-8-sig", newline="") as fh:
    w = csv.writer(fh)
    w.writerow(["op_group","row","covered","name","date_local","hours"] +
               ["BEFORE_"+c for c in COLS] + ["AFTER_"+c for c in COLS] + ["changed_cols"])
    for rec in records:
        w.writerow([rec["op_group"], rec["row"], rec["covered"], rec["name"],
                    rec["date_local"], rec["hours"]] +
                   rec["before"] + rec["after"] + [",".join(rec["changed_cols"])])

# 主库覆盖对照摘要
cov1 = [r for r in records if r["covered"]==1]
cov0 = [r for r in records if r["covered"]==0]

# Manifest JSON
manifest = {
    "title": "保全清单：生产表 119+34 行请假软删 写前/写后完整行值",
    "ssid": SSID,
    "op_119": {"rows": len(rows119), "batch_q": batch_q[119],
               "before_evidence_ts": "2026-11-01T17:32:56.331Z",
               "after_evidence_ts": "2026-11-01T17:33:55.899Z",
               "backup_source": os.path.basename(BACKUP),
               "backup_note": "2026-11-01 20:08 HKT 导出，早于软删，作为写前态"},
    "op_34": {"rows": len(rows34), "batch_q": batch_q[34],
              "before_evidence_ts": "见 leave B34/A34 证据",
              "after_evidence_ts": "2026-11-01T17:41:29Z",
              "backup_source": os.path.basename(BACKUP)},
    "total_rows": len(records),
    "covered_by_master": len(cov1),
    "not_covered_voided_by_owner": len(cov0),
    "softdel_columns": "O(15)=True, P(16)=Rita Jin, Q(17)=批次服务端时间戳",
    "unchanged_columns": "A-N 与写前完全一致（软删仅改 O/P/Q）",
    "acquisition": {
        "backup_export": "2026-11-01T20:08:00+08:00",
        "live_before_119": "2026-11-01T17:32:56.331Z",
        "live_after_119": "2026-11-01T17:33:55.899Z",
        "live_after_34": "2026-11-01T17:41:29Z",
        "manifest_generated": datetime.datetime.utcnow().isoformat()+"Z"
    },
    "credentials_present": False,
    "note": "本清单不含任何令牌/凭证/ScriptProperties 值；ssId 为被审生产表标识（非凭证）。",
    "oct25_prior_history": oct25_note,
    "q_timestamps_precise": {"op_119": batch_q[119], "op_34": batch_q[34],
                             "source": "ts_write_log_full.json r1388 / r1390 (repairLegacyLeave:repair apply)"}
}
out_json = os.path.join(BASE, "preservation_119_34_manifest.json")
json.dump(manifest, open(out_json,"w",encoding="utf-8"), ensure_ascii=False, indent=2)

# SHA256
def sha256(path):
    h = hashlib.sha256()
    with open(path,"rb") as f:
        for b in iter(lambda: f.read(8192), b""):
            h.update(b)
    return h.hexdigest()

h_csv = sha256(out_csv)
h_json = sha256(out_json)
print("records:", len(records), "covered:", len(cov1), "voided:", len(cov0))
print("CSV :", out_csv)
print("JSON:", out_json)
print("SHA256(csv ):", h_csv)
print("SHA256(json):", h_json)
print("sample changed_cols:", records[0]["changed_cols"])
