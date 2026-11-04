#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
probe_v59_live_state.py — T1-B v59 用的只读状态探针（生产表 + 主库）。

长期通道：任何一轮「系统大局梳理」发布前，先跑本脚本拿两张表的实时读数，
避免用过期快照描述现状。全程只读，零生产写、零部署、零链接变更。

读源：hktool `inspectWorkbook`（通用执行器，本脚本不修改它）。
用法：python tools/probe_v59_live_state.py [--json 输出路径]
"""
import io, os, sys, json, ssl, time, argparse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
WS = os.path.dirname(HERE)
HK = 'https://script.google.com/macros/s/AKfycbyq9RYrH1n7DKkoYBVi2cBmsgQLT51i3yaqVP_xF7twQYW0--r39ryu7rJfj1Wn4dTHVA/exec'
KEY = json.load(io.open(os.path.join(WS, 'tools', '.hktool_remote.json'), encoding='utf-8'))['key']
TS_ID = '1Pi5u9fEawgp7yICWPMMyQCT_LbwTZthQDW-H05xYdVI'   # 生产表（DB_工时流水）
# 权威 SSID 见 15_TimeSheet/CURRENT.md，工作区 834 处用法一致。
# 🔴 2026-11-04 v59 发现：项目 MEMORY.md 截断 ID 及 diag_cleanup2/3/4_20261101.js 等 23 处
#    误写为 '...YKXU49...'（少一个 u），openById 会报 "Illegal spreadsheet id or key"。
#    本探针以 15_TimeSheet/CURRENT.md 的 '...YKXuU49...' 为准；ID 漂移另列 v59 E6 具体编辑。
MASTER_ID = '1oxPj0mzN8poP2vQ7Bm-YKXuU49p9b0c1asyrZn4Py44'  # 主库（请假权威源）
CTX = ssl.create_default_context()


def hk(fn, args, tries=4, timeout=90):
    body = json.dumps({'action': 'hkRemoteRun', 'key': KEY, 'fn': fn, 'args': args}).encode()
    for i in range(tries):
        try:
            req = urllib.request.Request(HK, data=body, headers={'Content-Type': 'application/json'})
            raw = urllib.request.urlopen(req, timeout=timeout, context=CTX).read().decode('utf-8')
            j = json.loads(raw)
            if j.get('result'):
                return j['result']
            print('  [retry %d] no result: %s' % (i + 1, raw[:160]), file=sys.stderr)
        except Exception as e:
            print('  [retry %d] %s' % (i + 1, e), file=sys.stderr)
        time.sleep(1.2)
    return {}


def probe():
    out = {'probe_time_local': time.strftime('%Y-%m-%d %H:%M:%S'),
           'probe_time_utc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
           'read_only': True, 'ts_ssid': TS_ID, 'master_ssid': MASTER_ID}

    # --- 生产表 ---
    out['ts_tabs'] = hk('inspectWorkbook', {'ssId': TS_ID, 'sheet': '(list)', 'mode': 'list'})
    head = hk('inspectWorkbook', {'ssId': TS_ID, 'sheet': 'DB_工时流水', 'mode': 'values', 'a1': 'A1:Q1'})
    out['ts_header'] = head.get('values') or []
    tail = hk('inspectWorkbook', {'ssId': TS_ID, 'sheet': 'DB_工时流水', 'mode': 'values', 'a1': 'A11270:Q11279'})
    out['ts_tail_rows'] = tail.get('values') or []
    out['ts_tail_meta'] = {k: v for k, v in tail.items() if k != 'values'}
    # 原错位起点附近抽查（A/B 是否为真 Date 由 GAS 侧返回的原始串判断）
    seam = hk('inspectWorkbook', {'ssId': TS_ID, 'sheet': 'DB_工时流水', 'mode': 'values', 'a1': 'A6793:C6800'})
    out['ts_seam_rows'] = seam.get('values') or []

    # --- 主库 ---
    out['master_tabs'] = hk('inspectWorkbook', {'ssId': MASTER_ID, 'sheet': '(list)', 'mode': 'list'})
    leave = hk('inspectWorkbook', {'ssId': MASTER_ID, 'sheet': '请假', 'mode': 'values', 'a1': 'A1:H3'})
    out['master_leave_head'] = leave.get('values') or []
    out['master_leave_meta'] = {k: v for k, v in leave.items() if k != 'values'}
    return out


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--json', dest='out', default=None)
    a = ap.parse_args()
    r = probe()
    s = json.dumps(r, ensure_ascii=False, indent=2)
    print(s)
    if a.out:
        io.open(a.out, 'w', encoding='utf-8').write(s)
        print('\n[saved] ' + a.out, file=sys.stderr)
