#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""只读取证：_TS_WRITE_LOG 全量结构 + appendRows 批次溯源能力评估。

目的：验证 L1「可追到写入日志」这一判据是否成立 —— 即日志是否逐行记录了 UUID，
     能否据此把 A 类（同 UUID + 逐列一致）重复行归因到具体某次 appendRows。

零写入：只用 readRange GET。受 TS_WRITE_FREEZE 无关（本脚本不写）。

用法:
  python -X utf8 tools/ts_writelog_forensics.py            # 全量分析
  python -X utf8 tools/ts_writelog_forensics.py --dump      # 另存原始 JSON
"""
import json, os, sys, time, urllib.parse, urllib.request
from collections import defaultdict, Counter

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG_PATH = os.path.join(BASE, 'tools', '.ts_selfcheck.json')
PROD_SS = '1Pi5u9fEawgp7yICWPMMyQCT_LbwTZthQDW-H05xYdVI'


def load_cfg():
    with open(CFG_PATH, encoding='utf-8') as f:
        return json.load(f)


def read_sheet(cfg, sheet, a1, retries=4):
    q = urllib.parse.urlencode({'action': 'readRange', 'token': cfg['token'],
                                'sheet': sheet, 'range': a1, 'fmt': 'display'})
    for _ in range(retries):
        try:
            outer = json.loads(urllib.request.urlopen(
                urllib.request.Request(cfg['url'] + '?' + q), timeout=180).read().decode('utf-8'))
            if outer.get('ok'):
                return json.loads(outer['message']).get('values') or []
        except Exception as e:
            sys.stderr.write('retry: %s\n' % e)
            time.sleep(3)
    return None


def main():
    dump = '--dump' in sys.argv
    cfg = load_cfg()
    vals = read_sheet(cfg, '_TS_WRITE_LOG', 'A1:J')
    if not vals:
        print('[FAIL] 读取 _TS_WRITE_LOG 失败')
        return 1
    header = vals[0]
    rows = [r for r in vals[1:] if any(str(x).strip() for x in r)]
    print('=== _TS_WRITE_LOG 结构 ===')
    print('列头 (%d 列): %s' % (len(header), header))
    print('总行数(含头): %d  非空数据行: %d' % (len(vals), len(rows)))
    if rows:
        print('首条: %s' % (rows[0],))
        print('末条: %s' % (rows[-1],))

    # 是否含 UUID：UUID 形态判定（32 位 hex，或 带前缀的 md5 形）
    import re
    uuid_re = re.compile(r'\b[0-9a-fA-F]{32}\b')
    all_blob = '\n'.join(' '.join(str(x) for x in r) for r in rows)
    uuid_hits = uuid_re.findall(all_blob)
    print('\n=== 溯源能力评估（关键）===')
    print('日志内出现 32位hex(UUID形态) 次数: %d  去重: %d' % (len(uuid_hits), len(set(uuid_hits))))

    # 生产表相关条目
    prod_rows = [r for r in rows if PROD_SS in ' '.join(str(x) for x in r)]
    print('含生产表 SS_ID 的条目: %d' % len(prod_rows))

    # 按 action 聚合（假定 col1 是 action；若不是则按实际列头定位）
    act_idx = None
    for i, h in enumerate(header):
        if 'action' in str(h).lower():
            act_idx = i
            break
    if act_idx is None:
        act_idx = 1
    print('\n=== 按 action 聚合（生产表）===')
    by_act = Counter()
    for r in prod_rows:
        by_act[str(r[act_idx] if act_idx < len(r) else '')] += 1
    for a, c in by_act.most_common(30):
        print('  %-24s %d' % (a, c))

    # appendRows 按日批次
    print('\n=== appendRows 按日批次（生产表）===')
    ap = [r for r in prod_rows if str(r[act_idx] if act_idx < len(r) else '').lower().startswith('append')]
    by_day = defaultdict(list)
    for r in ap:
        by_day[str(r[0] or '')[:10]].append(r)
    for d in sorted(by_day):
        print('  %s  %d 批次' % (d, len(by_day[d])))
    print('  appendRows 总批次: %d' % len(ap))

    # 2026-09-11 ~ 09-13 窗口（我上一轮声称的"16 批次"）
    win = [r for r in ap if '2026-09-11' <= str(r[0] or '')[:10] <= '2026-09-13']
    print('\n=== 2026-09-11~13 窗口 appendRows 实况 ===')
    print('  批次实测: %d  （上一轮报告声称 16 批次 -> %s）'
          % (len(win), '吻合' if len(win) == 16 else '❌ 不吻合，需更正'))
    for r in win:
        print('   ', ' | '.join(str(x)[:60] for x in r[:6]))

    if dump:
        out = os.path.join(BASE, '_tmp', 'evidence', 'writelog_full_%s.json' % time.strftime('%Y%m%d_%H%M%S'))
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with open(out, 'w', encoding='utf-8') as f:
            json.dump({'header': header, 'rows': rows}, f, ensure_ascii=False, indent=1)
        print('\n已转储: %s' % out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
