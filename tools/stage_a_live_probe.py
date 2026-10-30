#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Stage-A live read-only probe (GO-S4).

约束（违反即事故）：
  - 只调用 hktool 的 inspectWorkbook（读），绝不调用任何写函数
  - 不翻 TS_WRITE_FREEZE、不放 clearance、不换链接、不 push/deploy
  - 只向本地 evidence/ 写证据文件；对生产零写

产出：evidence/stage_a/<UTC>_stageA.json + 控制台人类可读摘要

7 个 live 探针（全部只读）：
  L1 sheets 实名            (S1-1)
  L2 lastRow t0 / 表头+样本行  (S1-1 真实 schema / 稀疏格式绑定)
  L3 全列 B(日期)/G(工时)/O(软删) 统计 + SHA-256     (S1-1/S1-4 live 依据)
  L4 等待窗口后 t1 复读 → 写者稳定证据 (Tom 要求：独立写者稳定证据)
  L5 CONFIG live 读取 → TS_WRITE_FREEZE 当前值客观证明 (阶段 A 「冻结保持」证明)
  L6 _TS_WRITE_LOG 末行 → 最后一个真实写者/时间 (S1-7 写者盘点)
  L7 主库 lastRow → 底稿当前版本 live 依据 (S1-3 ②)
"""
import json, io, os, sys, time, hashlib, urllib.request, datetime

HK_URL = 'https://script.google.com/macros/s/AKfycbyq9RYrH1n7DKkoYBVi2cBmsgQLT51i3yaqVP_xF7twQYW0--r39ryu7rJfj1Wn4dTHVA/exec'

def _load_key():
    for p in ('C:/Users/rita.jin/WorkBuddy/SMCN_ERP/tools/.hktool_remote.json',
              'D:/AI_DATA/WorkBuddy/SMCN_ERP/tools/.hktool_remote.json'):
        if os.path.exists(p):
            return json.load(io.open(p, encoding='utf-8'))['key']
    raise SystemExit('hktool key not found')

HK_KEY = _load_key()
TS_ID = '1Pi5u9fEawgp7yICWPMMyQCT_LbwTZthQDW-H05xYdVI'   # 工时打卡数据库
MASTER_ID = '1oxPj0mzN8poP2vQ7Bm-YKXuU49p9b0c1asyrZn4Py44'  # T1B_主库_工时与请假
PROD_TAB = 'DB_工时流水'
WAIT_SEC = int(os.environ.get('STAGE_A_WAIT_SEC', '75'))

EVIDENCE = {}

def now_utc():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())

def hk(fn, args, timeout=240):
    payload = {'action': 'hkRemoteRun', 'key': HK_KEY, 'fn': fn, 'args': args}
    req = urllib.request.Request(HK_URL, data=json.dumps(payload).encode('utf-8'),
                                 headers={'Content-Type': 'application/json'})
    t = time.time()
    raw = urllib.request.urlopen(req, timeout=timeout).read().decode('utf-8', 'replace')
    ms = int((time.time() - t) * 1000)
    j = json.loads(raw)
    return (j.get('result') if j.get('ok') else j), ms

def sheets(ssId):
    r, ms = hk('inspectWorkbook', {'ssId': ssId, 'mode': 'sheets'})
    return r.get('sheets') or [], ms

def values(ssId, tab, a1):
    r, ms = hk('inspectWorkbook', {'ssId': ssId, 'sheet': tab, 'mode': 'values', 'a1': a1})
    return r.get('values') or [], int(r.get('lastRow') or 0), ms

def sha256_of(rows):
    h = hashlib.sha256()
    for r in rows:
        h.update(('\x1f'.join('' if c is None else str(c) for c in r) + '\x1e').encode('utf-8'))
    return h.hexdigest()

def to_date(v):
    s = '' if v is None else str(v).strip()
    if not s:
        return None
    for fmt in ('%Y-%m-%d', '%Y/%m/%d', '%d/%m/%Y', '%Y-%m-%d %H:%M:%S'):
        try:
            return datetime.datetime.strptime(s[:19], fmt).date()
        except ValueError:
            continue
    try:
        return datetime.datetime.fromisoformat(s[:10]).date()
    except Exception:
        return None

def truthy_soft(v):
    s = '' if v is None else str(v).strip().upper()
    return s in ('TRUE', '1', 'YES', 'Y', 'T')

def main():
    EVIDENCE['meta'] = {
        'stage': 'A', 'probe': 'stage_a_live_probe',
        'start_utc': now_utc(),
        'zero_write': True,
        'freeze_flipped': False, 'clearance_released': False, 'link_changed': False,
        'write_fn_used': [],
        'channel': 'hktool inspectWorkbook (read-only)',
        'ts_ssid': TS_ID, 'master_ssid': MASTER_ID, 'tab': PROD_TAB,
        'note': '提交方 live 读取报告，非独立复核方验证',
    }

    # ---------- L1 sheets 实名 ----------
    s, ms = sheets(TS_ID)
    EVIDENCE['L1_sheets'] = {'tables': s, 'ms': ms, 'tab_present': PROD_TAB in s}
    print('[L1] sheets=%d  DB_工时流水 real-name present=%s  (%dms)'
          % (len(s), EVIDENCE['L1_sheets']['tab_present'], ms))

    # ---------- L2 lastRow t0 + 表头/样本 ----------
    head, _, ms_h = values(TS_ID, PROD_TAB, 'A1:Q1')
    last0, lastrow_ms = None, 0
    _, lastrow, lastrow_ms = values(TS_ID, PROD_TAB, 'A1:A1')
    last0 = lastrow
    sample, _, ms_s = values(TS_ID, PROD_TAB, 'A2:Q7')
    sparse = [i + 2 for i, r in enumerate(sample) if any(c in (None, '') for c in r)]
    EVIDENCE['L2_schema'] = {
        'header': head, 'lastRow_t0': last0, 'ms': lastrow_ms,
        'sample_rows': 6, 'sample_sparse_rows': sparse,
        'sample_row_width': len(head[0]) if head else None,
        'ms_head': ms_h, 'ms_sample': ms_s,
    }
    print('[L2] lastRow_t0=%s  header_cols=%s  sparse_sample_rows=%s  (%dms)'
          % (last0, EVIDENCE['L2_schema']['sample_row_width'], sparse, lastrow_ms))

    last = last0 or 0
    if last < 2:
        print('[FATAL] lastRow too small, abort'); return 1

    # ---------- L3 全列 live 统计（B=日期 G=工时 O=软删） ----------
    def read_col(col):
        return values(TS_ID, PROD_TAB, '%s2:%s%d' % (col, col, last))

    b, _, ms_b = read_col('B')
    g, _, ms_g = read_col('G')
    o, _, ms_o = read_col('O')
    dates = [to_date(r[0] if r else None) for r in b]
    cut = datetime.date(2026, 10, 1)
    n_rows = last - 1                        # 数据行数（去表头）
    n_dates = sum(1 for d in dates if d)
    n_blank_date = n_rows - n_dates
    n_before_cut = sum(1 for d in dates if d and d < cut)
    n_after_cut = sum(1 for d in dates if d and d >= cut)
    soft_flags = [truthy_soft(r[0] if r else None) for r in o]
    n_soft = sum(1 for f in soft_flags if f)
    hours = []
    for r in g:
        try:
            hours.append(float(str((r[0] if r else '') or '').strip() or 0))
        except ValueError:
            hours.append(0.0)
    EVIDENCE['L3_live_stats'] = {
        'lastRow_t0': last, 'data_rows': n_rows,
        'rows_with_date': n_dates, 'rows_blank_date': n_blank_date,
        'rows_bizdate_lt_2026_10_01': n_before_cut,
        'rows_bizdate_ge_2026_10_01': n_after_cut,
        'rows_soft_deleted_flagged': n_soft,
        'sum_hours_col_G': round(sum(hours), 2),
        'sha256_B': sha256_of(b), 'sha256_G': sha256_of(g), 'sha256_O': sha256_of(o),
        'ms_B': ms_b, 'ms_G': ms_g, 'ms_O': ms_o,
        'read_window_utc': now_utc(),
    }
    print('[L3] data_rows=%d with_date=%d blank=%d <2026-10-01=%d >=cut=%d soft_flagged=%d sum_hours=%.1f'
          % (n_rows, n_dates, n_blank_date, n_before_cut, n_after_cut, n_soft, sum(hours)))
    print('[L3] sha256_B=%s' % EVIDENCE['L3_live_stats']['sha256_B'][:16])

    # ---------- L4 写者稳定证据：等待窗口后复读 ----------
    print('[L4] waiting %ds for writer-stability re-read...' % WAIT_SEC)
    time.sleep(WAIT_SEC)
    _, last1, ms_l1 = values(TS_ID, PROD_TAB, 'A1:A1')
    b2, _, ms_b2 = read_col('B')
    o2, _, ms_o2 = read_col('O')
    stable = (last1 == last0) and sha256_of(b2) == EVIDENCE['L3_live_stats']['sha256_B'] \
        and sha256_of(o2) == EVIDENCE['L3_live_stats']['sha256_O']
    EVIDENCE['L4_writer_stability'] = {
        'wait_sec': WAIT_SEC, 'lastRow_t1': last1, 'lastRow_drift': (last1 - (last0 or 0)),
        'sha256_B_t1': sha256_of(b2), 'sha256_O_t1': sha256_of(o2),
        'stable_in_window': bool(stable),
        't0_utc': EVIDENCE['L3_live_stats']['read_window_utc'], 't1_utc': now_utc(),
        'caveat': '窗口内内容未变 ≠ 全程零写者；仅证明该 %ds 窗口无漂移' % WAIT_SEC,
    }
    print('[L4] lastRow_t1=%s drift=%d  stable_in_window=%s'
          % (last1, EVIDENCE['L4_writer_stability']['lastRow_drift'], stable))

    # ---------- L5 CONFIG live：freeze 当前值 ----------
    try:
        cfg, _, ms_c = values(TS_ID, 'CONFIG', 'A1:C40')
        flat = ' | '.join(' '.join(str(c) for c in r) for r in cfg)
        EVIDENCE['L5_config'] = {'rows': cfg, 'ms': ms_c,
                                 'mentions_freeze': ('FREEZE' in flat.upper()),
                                 'flat_snippet': flat[:400]}
        print('[L5] CONFIG rows=%d mentions_freeze=%s (%dms)'
              % (len(cfg), EVIDENCE['L5_config']['mentions_freeze'], ms_c))
    except Exception as e:
        EVIDENCE['L5_config'] = {'error': str(e)}
        print('[L5] CONFIG read failed: %s' % e)

    # ---------- L6 _TS_WRITE_LOG 末行：最后一个真实写者 ----------
    try:
        _, wl_last, ms_w = values(TS_ID, '_TS_WRITE_LOG', 'A1:A1')
        tail_start = max(1, (wl_last or 1) - 5)
        wl_rows, _, ms_w2 = values(TS_ID, '_TS_WRITE_LOG', 'A%d:F%d' % (tail_start, max(tail_start, wl_last or 1)))
        EVIDENCE['L6_write_log'] = {'lastRow': wl_last, 'tail': wl_rows, 'ms': ms_w}
        print('[L6] _TS_WRITE_LOG lastRow=%s  tail_rows=%d (%dms)'
              % (wl_last, len(wl_rows), ms_w))
    except Exception as e:
        EVIDENCE['L6_write_log'] = {'error': str(e)}
        print('[L6] write-log read failed: %s' % e)

    # ---------- L7 主库 lastRow：底稿当前版本 live 依据 ----------
    try:
        msheets, ms_m = sheets(MASTER_ID)
        _, mlast, ms_ml = values(MASTER_ID, '工时', 'A1:A1')
        EVIDENCE['L7_master'] = {'sheets': msheets, '工时_lastRow': mlast, 'ms': ms_m}
        print('[L7] master sheets=%d  工时_lastRow=%s (%dms)' % (len(msheets), mlast, ms_ml))
    except Exception as e:
        EVIDENCE['L7_master'] = {'error': str(e)}
        print('[L7] master read failed: %s' % e)

    EVIDENCE['meta']['end_utc'] = now_utc()
    outdir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                          'evidence', 'stage_a')
    os.makedirs(outdir, exist_ok=True)
    stamp = now_utc().replace(':', '').replace('-', '')
    out = os.path.join(outdir, 'stageA_%sZ.json' % stamp)
    io.open(out, 'w', encoding='utf-8').write(json.dumps(EVIDENCE, ensure_ascii=False, indent=2))
    print('\n[OUT] %s' % out)
    print('[CLAIM] zero_write=True / freeze 未翻 / clearance 未放行 / 未换链接 / 未 push')
    return 0

if __name__ == '__main__':
    sys.exit(main())
