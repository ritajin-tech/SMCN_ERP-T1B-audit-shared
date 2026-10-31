#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
prod_scan_from_backup.py — 从每日 Sheets 备份 CSV 派生
ts_controlled_audit_offline.js 所需的 prod_scan_*.json
（byUuid: { uuid: [{row, cells, soft}] }）。

用途：在 GO-S4 授权前、无需 live 读即可刷新「受控候选底稿」分析基础
      （known-gap: 10-27 快照已过期，须以最新 live 重派生）。

约束（违反即事故）：
  - 纯只读：只读取本地备份 CSV，对生产零读零写，不翻 TS_WRITE_FREEZE / 不 push / 不换链接。
  - 本工具不判定 soft：当前 Sheets 备份导出不含软标 O 列，soft 统一置 'FALSE'
    （保守：不触发 alreadyHandled 排除）。因此本产物为 **PRE-GO DRAFT**：
    alreadyHandled 计数恒为 0，候选含任何已软标组（上限）；GO 时须以含真实 O 列的
    live 快照重跑 ts_controlled_audit_offline.js 做最终裁定。
  - cells 取完整行（UUID=col8）；offline audit 内部 normCells 补齐至>=15，slice(0,14) 做比较。
  - 不落任何执行动作；仅产出供离线器消费的 JSON。

用法：
  python3 tools/prod_scan_from_backup.py \
    --prod <生产工时表__DB_工时流水.csv> \
    --out  <prod_scan_YYYY-MM-DD.json>
"""
import csv, json, os, sys, argparse, datetime

UUID_COL = 8  # ⚙ 唯一码 (UUID)

def _norm_uuid(v):
    return (v or '').strip().lower()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--prod', required=True, help='生产表 DB_工时流水 备份 CSV（UTF-8-SIG）')
    ap.add_argument('--out', required=True, help='输出 prod_scan_*.json 路径')
    args = ap.parse_args()

    with open(args.prod, encoding='utf-8-sig', newline='') as f:
        rows = list(csv.reader(f))

    by_uuid = {}
    skipped = 0
    data_rows = 0
    for idx, row in enumerate(rows):
        if idx == 0:
            continue  # 表头
        if len(row) <= UUID_COL:
            skipped += 1
            continue
        u = _norm_uuid(row[UUID_COL])
        if not u:
            skipped += 1
            continue
        data_rows += 1
        sheet_row = idx + 1  # 1-based；表头=row1，首数据=row2
        by_uuid.setdefault(u, []).append({
            'row': sheet_row,
            'cells': row,          # 完整行（17 列），offline audit 内部 normCells 补齐
            'soft': 'FALSE',       # 备份导出无 O 列 → 保守置 FALSE（PRE-GO DRAFT 口径）
        })

    stamp = datetime.date.today().strftime('%Y-%m-%d')
    meta = {
        'generatedAtBJT': (datetime.datetime.now() + datetime.timedelta(hours=8)).strftime('%Y-%m-%d %H:%M:%S'),
        'source': args.prod,
        'readOnly': True,
        'softColumnPresent': False,
        'note': 'PRE-GO DRAFT：备份 CSV 不含软标 O 列，alreadyHandled 未计算；GO 时须以含 O 列 live 快照重跑',
        'dataRows': data_rows,
        'uuidGroups': len(by_uuid),
    }
    out = {'byUuid': by_uuid, 'meta': meta}
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False)
    print('[OUT] %s' % args.out)
    print('[STAT] dataRows=%d uuidGroups=%d skipped=%d' % (data_rows, len(by_uuid), skipped))
    return 0

if __name__ == '__main__':
    sys.exit(main())
