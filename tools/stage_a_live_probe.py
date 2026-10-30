#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Stage-A live read-only probe (GO-S4) — v2（回应 Tom 2026-10-30 16:21:38Z 第十一轮）

约束（违反即事故）：
  - 只调用 hktool 的 inspectWorkbook（读），绝不调用任何写函数
  - 不翻 TS_WRITE_FREEZE、不放 clearance、不换链接、不 push/deploy
  - 只向本地 evidence/ 写证据文件；对生产零写

v2 相对 v1 的实质改动（均为行为改动，非措辞）：
  Tom #2 不再静默回退/折叠：
      · values 读取失败、返回裂 Shape、缺失再也不折叠成空数组或 0；
      · 日期解析失败显式计 date_parse_fail 并记录行号，不计入“空日期”；
      · 非数值工时显式计 hours_non_numeric 并记录行号，不计入 0；
      · 逐行宽度完整性与请求行数一致性做机器校验（width_histogram / row_count_match）。
  Tom #2 原子性：B/G/O 不再分列分时读取，单次读全表 A2:Qn 得全字段规范快照，
      统计与 SHA-256 全部从同一份快照派生（消除跨列非原子）。
  Tom #1 不再声称“写者稳定”：删除 stable 语义，改为多份独立样本的观测记录 +
      not_proven 清单；明确“不存在凭等待秒数即可证明稳定的阈值”。
  Tom #3 freeze 明确 UNKNOWN：CONFIG 探路只作辅助，不得据其未出现 FREEZE 字样推断冻结；
      列出须由部署管理员以授权只读管理渠道核证的事项清单。
  Tom #4 写日志分类：按动作/目标/时间拆分为「目标表写 / 其它页签 / 主库 / 提醒停用」四类，
      逐类给条数与末次时间；不再把停用提醒与主库活动统称“生产目标表写入”。

7 个 live 探针（全部只读）：
  L1 sheets 实名                                (S1-1)
  L2 lastRow t0 / 表头 + 样本行                   (S1-1)
  L3 全字段原子快照：统计 + 全列 SHA-256 + 完整性校验   (S1-1/S1-4)
  L4 多份独立全字段样本（不声称稳定）                (写者观测，非 Stable 证明)
  L5 CONFIG 辅助读数 + freeze=UNKNOWN 清单        (冻结核证路径，非冻结证明)
  L6 _TS_WRITE_LOG 分类读写者盘点                  (S1-7)
  L7 主库 lastRow                                (S1-3 ②)
"""
import json, io, os, sys, time, hashlib, urllib.request, urllib.error, datetime

# Tom #4 + #1: 黑名单与被扫文件分离 —— 使「本体 0 命中」成为可独立复算的命题，
# 而非探针在自己的输出里写死 hits: 0。
try:
    from _stage_a_write_verbs import WRITE_VERBS
except ImportError:  # 允许从任意 cwd 运行
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from _stage_a_write_verbs import WRITE_VERBS

HK_URL = 'https://script.google.com/macros/s/AKfycbyq9RYrH1n7DKkoYBVi2cBmsgQLT51i3yaqVP_xF7twQYW0--r39ryu7rJfj1Wn4dTHVA/exec'

def _load_key():
    for p in ('C:/Users/rita.jin/WorkBuddy/SMCN_ERP/tools/.hktool_remote.json',
              'D:/AI_DATA/WorkBuddy/SMCN_ERP/tools/.hktool_remote.json'):
        if os.path.exists(p):
            return json.load(io.open(p, encoding='utf-8'))['key']
    raise SystemExit('hktool key not found')

HK_KEY = _load_key()
TS_ID = '1Pi5u9fEawgp7yICWPMMyQCT_LbwTZthQDW-H05xYdVI'
MASTER_ID = '1oxPj0mzN8poP2vQ7Bm-YKXuU49p9b0c1asyrZn4Py44'
PROD_TAB = 'DB_工时流水'
# Tom #1：等待时长不证明稳定；改为多份独立样本 + 间隔
SAMPLES = int(os.environ.get('STAGE_A_SAMPLES', '3'))
INTERVAL_SEC = int(os.environ.get('STAGE_A_INTERVAL_SEC', '30'))
CUT = datetime.date(2026, 10, 1)

EVIDENCE = {}

def _self_write_scan():
    """对本探针源码做真实正则扫描 —— hits 由机器算出，不写死。

    口径（如实登记）：只证明【本文件未出现】这些写动词文本；
    不证明远端 inspectWorkbook 实现无副作用，后者须对实际部署的服务端
    代码与调用身份作独立只读核证。
    """
    import re as _re
    myself = os.path.abspath(__file__)
    raw = io.open(myself, encoding='utf-8').read()
    rb = raw.encode('utf-8')
    hits = {}
    for v in WRITE_VERBS:
        m = [n + 1 for n, l in enumerate(raw.split('\n')) \
             if _re.search(r'\b' + _re.escape(v) + r'\b', l)]
        if m:
            hits[v] = m
    return {
        'scanned_file': os.path.basename(myself),
        'scanned_bytes': len(rb),
        'scanned_sha256': hashlib.sha256(rb).hexdigest(),
        'blacklist_module': '_stage_a_write_verbs.py (与本文件分离，故清单不自命中)',
        'verbs_count': len(WRITE_VERBS),
        'verbs': list(WRITE_VERBS),
        'hits': hits,
        'total_hits': sum(len(v) for v in hits.values()),
        'call_sites': _extract_calls(raw),
        'scope_note': 'Tom #4：静态无写动词只证明本文件未写这些动词，'
                      '不证明远端 inspectWorkbook 实现无副作用 —— 后者须对实际部署的'
                      '服务端实现与调用身份作独立只读核证。',
    }


def _extract_calls(raw):
    """抽出全部实际发起的远端调用点，供机器核验只读。"""
    import re as _re
    out = []
    for n, l in enumerate(raw.split('\n')):
        if 'hk(' in l and 'def ' not in l:
            fns = _re.findall(r"hk\(\s*'([^']+)'", l)
            modes = _re.findall(r"'mode'\s*:\s*'([^']+)'", l)
            out.append({'line': n + 1, 'fn': fns, 'mode': modes})
    return out


def now_utc():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())

def hk(fn, args, timeout=300):
    payload = {'action': 'hkRemoteRun', 'key': HK_KEY, 'fn': fn, 'args': args}
    req = urllib.request.Request(HK_URL, data=json.dumps(payload).encode('utf-8'),
                                 headers={'Content-Type':'application/json'})
    t = time.time()
    raw = urllib.request.urlopen(req, timeout=timeout).read().decode('utf-8', 'replace')
    ms = int((time.time() - t) * 1000)
    return json.loads(raw), ms

def values_strict(ssId, tab, a1, timeout=300):
    """Tom #2：保留原始错误与原始响应形态，不再把缺失/异常折叠成空数组。"""
    out = {'a1': a1, 'ok': False, 'error': None, 'rows': None, 'lastRow': None,
           'ms': 0, 'raw_top_keys': []}
    try:
        j, ms = hk('inspectWorkbook', {'ssId': ssId, 'sheet': tab, 'mode': 'values', 'a1': a1}, timeout)
    except Exception as e:
        out['error'] = 'TRANSPORT_FAIL: %s' % e
        return out
    out['ms'] = ms
    r = j.get('result') if j.get('ok') else j
    if not isinstance(r, dict):
        out['error'] = 'NON_DICT_RESPONSE: %s' % str(r)[:200]
        return out
    out['raw_top_keys'] = sorted(list(r.keys()))
    if r.get('error'):
        out['error'] = 'SERVER_ERROR: %s' % str(r['error'])[:300]
        return out
    v = r.get('values')
    if v is None:
        out['error'] = 'NO_VALUES_FIELD'
        return out
    out['rows'] = v
    out['lastRow'] = r.get('lastRow')
    out['ok'] = True
    return out

def sheets(ssId):
    try:
        j, ms = hk('inspectWorkbook', {'ssId': ssId, 'mode': 'sheets'}, 180)
        r = j.get('result') if j.get('ok') else j
        return (r.get('sheets') or []), ms, None
    except Exception as e:
        return [], 0, 'TRANSPORT_FAIL: %s' % e

def full_snapshot_sha256(rows):
    """全字段规范快照指纹：所有列参与，逐行用单元分隔符连接，与行序无关性不做假设的裸指纹。"""
    h = hashlib.sha256()
    for row in rows:
        h.update(('\x1f'.join('' if c is None else str(c) for c in row) + '\x1e').encode('utf-8'))
    return h.hexdigest()

def col(rows, idx):
    return [ (r[idx] if idx < len(r) else None) for r in rows ]

def parse_date_strict(v):
    """返回 (date|None, status)，status ∈ OK / EMPTY / PARSE_FAIL。"""
    s = '' if v is None else str(v).strip()
    if not s:
        return None, 'EMPTY'
    for fmt in ('%Y-%m-%d', '%Y/%m/%d', '%d/%m/%Y', '%Y-%m-%d %H:%M:%S'):
        try:
            return datetime.datetime.strptime(s[:19], fmt).date(), 'OK'
        except ValueError:
            continue
    try:
        return datetime.datetime.fromisoformat(s[:10]).date(), 'OK'
    except Exception:
        return None, 'PARSE_FAIL'

def parse_hours_strict(v):
    """返回 (float|None, status)，status ∈ OK / EMPTY / NON_NUMERIC。"""
    s = '' if v is None else str(v).strip()
    if not s:
        return None, 'EMPTY'
    try:
        return float(s), 'OK'
    except ValueError:
        return None, 'NON_NUMERIC'

def truthy_soft(v):
    s = '' if v is None else str(v).strip().upper()
    return s in ('TRUE', '1', 'YES', 'Y', 'T')

def integrity_of(rows, expected_rows, expected_width):
    """Tom #2：返回请求的 Shape 完整性机器校验结论。"""
    widths = {}
    for r in rows:
        widths[len(r)] = widths.get(len(r), 0) + 1
    return {
        'requested_rows': expected_rows,
        'returned_rows': len(rows),
        'row_count_match': (len(rows) == expected_rows),
        'expected_width': expected_width,
        'width_histogram': widths,
        'width_match': all(k == expected_width for k in widths.keys()),
    }

def main():
    EVIDENCE['meta'] = {
        'stage': 'A', 'probe': 'stage_a_live_probe', 'probe_version': 'v2',
        'responds_to': 'Tom 2026-10-30 16:21:38Z 第十一轮',
        'start_utc': now_utc(),
        'zero_write': True,
        'freeze_flipped': False, 'clearance_released': False, 'link_changed': False,
        'channel': 'hktool inspectWorkbook (read-only)',
        'static_scan': _self_write_scan(),
        'note': '提交方 live 读取报告，非独立复核方验证',
    }

    # ---------- L1 sheets 实名 ----------
    s, ms, err = sheets(TS_ID)
    EVIDENCE['L1_sheets'] = {'tables': s, 'ms': ms, 'error': err,
                             'tab_present': PROD_TAB in s}
    print('[L1] sheets=%d  %s present=%s  err=%s  (%dms)'
          % (len(s), PROD_TAB, EVIDENCE['L1_sheets']['tab_present'], err, ms))

    # ---------- L2 lastRow t0 + 表头/样本 ----------
    head_r = values_strict(TS_ID, PROD_TAB, 'A1:Q1', 120)
    last_r = values_strict(TS_ID, PROD_TAB, 'A1:A1', 120)
    sample_r = values_strict(TS_ID, PROD_TAB, 'A2:Q7', 120)
    head = head_r['rows'] or []
    width = len(head[0]) if head else 0
    last0 = last_r['lastRow'] or (last_r['rows'] and len(last_r['rows'])) or 0
    sample = sample_r['rows'] or []
    EVIDENCE['L2_schema'] = {
        'header': head, 'header_width': width,
        'lastRow_t0': last0,
        'header_err': head_r['error'], 'lastRow_err': last_r['error'],
        'sample_rows': len(sample),
        'sample_row_widths': sorted({len(r) for r in sample}),
        'ms_head': head_r['ms'], 'ms_last': last_r['ms'], 'ms_sample': sample_r['ms'],
    }
    print('[L2] lastRow_t0=%s header_cols=%s sample_rows=%s  err(head/last)=%s/%s'
          % (last0, width, len(sample), head_r['error'], last_r['error']))

    last = last0 or 0
    if last < 2 or not width:
        print('[FATAL] lastRow/header insufficient, abort'); return 1
    data_rows = last - 1

    # ---------- L3 全字段原子快照（单次读取，不再分列分时） ----------
    snap = values_strict(TS_ID, PROD_TAB, 'A2:Q%d' % last, 300)
    if not snap['ok'] or snap['rows'] is None:
        print('[FATAL] full snapshot read failed: %s' % snap['error']); return 1
    rows = snap['rows']
    integ = integrity_of(rows, data_rows, width)

    dflags = [parse_date_strict(v) for v in col(rows, 1)]
    hflags = [parse_hours_strict(v) for v in col(rows, 6)]
    oflags = [truthy_soft(v) for v in col(rows, 14)]

    date_fail_rows = [i + 2 for i, (d, st) in enumerate(dflags) if st == 'PARSE_FAIL']
    blank_date_rows = [i + 2 for i, (d, st) in enumerate(dflags) if st == 'EMPTY']
    hours_bad_rows = [i + 2 for i, (h, st) in enumerate(hflags) if st == 'NON_NUMERIC']
    hours_blank_rows = [i + 2 for i, (h, st) in enumerate(hflags) if st == 'EMPTY']

    ok_dates = [d for d, st in dflags if st == 'OK']
    ok_hours = [h for h, st in hflags if st == 'OK']
    n_before = sum(1 for d in ok_dates if d < CUT)
    n_after = sum(1 for d in ok_dates if d >= CUT)

    EVIDENCE['L3_full_snapshot'] = {
        'a1': snap['a1'], 'ms': snap['ms'],
        'integrity': integ,
        'sha256_full': full_snapshot_sha256(rows),
        'sha256_B': full_snapshot_sha256([[v] for v in col(rows, 1)]),
        'sha256_G': full_snapshot_sha256([[v] for v in col(rows, 6)]),
        'sha256_O': full_snapshot_sha256([[v] for v in col(rows, 14)]),
        'atomicity_note': 'B/G/O 与全表指纹均由同一次读取派生，不存在跨列/跨时刻非原子',
        'data_rows': data_rows,
        'rows_bizdate_lt_2026_10_01': n_before,
        'rows_bizdate_ge_2026_10_01': n_after,
        'date_parse_fail': len(date_fail_rows),
        'date_parse_fail_rows_sample': date_fail_rows[:20],
        'blank_date': len(blank_date_rows),
        'hours_non_numeric': len(hours_bad_rows),
        'hours_non_numeric_rows_sample': hours_bad_rows[:20],
        'hours_blank': len(hours_blank_rows),
        'hours_sum_parsed_only': round(sum(ok_hours), 2),
        'hours_scope_caveat': 'sum 仅统计可解析为数值的行；'+'不计入 %d 行非数值、%d 行空值'
                              % (len(hours_bad_rows), len(hours_blank_rows)),
        'soft_deleted_flagged': sum(1 for f in oflags if f),
        'read_utc': now_utc(),
    }
    L3 = EVIDENCE['L3_full_snapshot']
    print('[L3] rows=%d/%d width_ok=%s  sha256_full=%s  (%dms)'
          % (integ['returned_rows'], integ['requested_rows'], integ['width_match'],
             L3['sha256_full'][:16], snap['ms']))
    print('[L3] <cut=%d >=cut=%d  soft_flagged=%d  hours_sum(parsed)=%.1f  date_fail=%d  hours_nonnum=%d'
          % (n_before, n_after, L3['soft_deleted_flagged'], L3['hours_sum_parsed_only'],
             L3['date_parse_fail'], L3['hours_non_numeric']))

    # ---------- L4 多份独立全字段样本（不声称“稳定”） ----------
    print('[L4] taking %d full-field samples, interval=%ds (this does NOT prove stability)'
          % (SAMPLES, INTERVAL_SEC))
    samples = [{'seq': 0, 'utc': L3['read_utc'], 'lastRow': last, 'sha256_full': L3['sha256_full']}]
    for i in range(1, SAMPLES):
        time.sleep(INTERVAL_SEC)
        lr = values_strict(TS_ID, PROD_TAB, 'A1:A1', 120)
        sp = values_strict(TS_ID, PROD_TAB, 'A2:Q%d' % (lr['lastRow'] or last), 300)
        if not sp['ok'] or sp['rows'] is None:
            samples.append({'seq': i, 'utc': now_utc(), 'error': sp['error'] or lr['error']})
            print('[L4] sample %d ERROR %s' % (i, sp['error'] or lr['error']))
            continue
        samples.append({'seq': i, 'utc': now_utc(), 'lastRow': lr['lastRow'],
                        'sha256_full': full_snapshot_sha256(sp['rows'])})
        print('[L4] sample %d lastRow=%s sha256=%s'
              % (i, lr['lastRow'], samples[-1]['sha256_full'][:16]))
    hashes = {s['sha256_full'] for s in samples if s.get('sha256_full')}
    EVIDENCE['L4_writer_samples'] = {
        'samples': samples,
        'distinct_snapshot_count': len(hashes),
        'observed_no_change_across_samples': (len(hashes) == 1),
        'claim': 'NONE',   # Tom #1：删除 stable 语义
        'not_proven': [
            '不证明窗口内没有写（other columns/other sheets/已读稍即被改写入都可能）',
            '单次抽样不证明其它列未变化；v2 已扩为全字段，但仍不覆盖读取之间的瞬时写',
            '不证明全体写者或触发器已停止 —— 须由被授权管理员完整盘点并协调全部写者/触发器',
            '不证明实际冻结覆盖“采集→授权决策”整个窗口 —— 冻结核证见 L5',
            '不存在“通用最小等待秒数即可证明稳定”的阈值；本探针的 SAMPLES/INTERVAL_SEC 仅为采样密度，非证明手段',
            '两次/多次采集均非独立控制通道，全部经由同一 hktool 只读端点',
        ],
        'required_by_admin': [
            '完整盘点全部写者/触发器/GAS 工程/其它脚本',
            '协调并保持实际冻结覆盖整个采集→授权决策窗口',
            '绑定全字段规范快照 + 版本/范围 + 时间 + 异常记录',
            '任何漂移或采集不完整 → 立即停止',
        ],
    }
    print('[L4] distinct_snapshots=%d  observed_no_change=%s  (claim=NONE, see not_proven)'
          % (len(hashes), EVIDENCE['L4_writer_samples']['observed_no_change_across_samples']))

    # ---------- L5 freeze：不得由 CONFIG 推断 ----------
    cfg = values_strict(TS_ID, 'CONFIG', 'A1:C40', 180)
    cfg_rows = cfg['rows'] or []
    flat = ' | '.join(' '.join(str(c) for c in r) for r in cfg_rows)
    EVIDENCE['L5_freeze'] = {
        'config_read': {'a1': cfg['a1'], 'ok': cfg['ok'], 'error': cfg['error'],
                        'rows_returned': len(cfg_rows), 'ms': cfg['ms']},
        'config_rowcount_match_requested': (len(cfg_rows) == 40),
        'config_mentions_freeze': ('FREEZE' in flat.upper()) if cfg_rows else None,
        'config_flat_snippet': flat[:400],
        'TS_WRITE_FREEZE_value': 'UNKNOWN',
        'freeze_status': 'UNKNOWN',
        'inference_prohibition': 'Tom #3：CONFIG 未出现 FREEZE 字样不得据以推断冻结现状；'
                                 '该表可能并非 freeze 的配置来源。',
        'required_from_deployment_admin': [
            '实际执行部署的身份（scriptId/版本/部署号）',
            'freeze 值的配置来源（Script Properties / 其它表 / 环境变量）',
            '值的含义（含“0/1/null/缺失”各代表什么）',
            '读取时间 + 读取主体身份',
            '由独立复核人核验；不公开凭证',
        ],
        'fallback': '无授权只读管理通道 → 维持 UNKNOWN，不作任何越级推断',
    }
    print('[L5] TS_WRITE_FREEZE=UNKNOWN  CONFIG rows=%d mentions_freeze=%s err=%s'
          % (len(cfg_rows), EVIDENCE['L5_freeze']['config_mentions_freeze'], cfg['error']))

    # ---------- L6 写日志：分类盘点 ----------
    wl = values_strict(TS_ID, '_TS_WRITE_LOG', 'A1:A1', 120)
    wl_last = wl['lastRow'] or 0
    start = max(1, wl_last - 40)
    tail = values_strict(TS_ID, '_TS_WRITE_LOG', 'A%d:H%d' % (start, max(start, wl_last)), 180)
    tail_rows = tail['rows'] or []
    cats = {}
    for r in tail_rows:
        joined = ' '.join(str(c) for c in r)
        action = None
        for token in ('softDelGuarded', 'attendance_rebuild_live', 'master_views_live',
                      'period_lock', 'reminder', 'import', 'archive'):
            if token.lower() in joined.lower():
                action = token; break
        action = action or 'other/unclassified'
        target_table = joined
        is_target = PROD_TAB.lower() in joined.lower()
        key = 'target_DB_工时流水' if is_target else ('reminder_disabled' if action == 'reminder' else ('master_activity' if 'master' in joined.lower() or '主库' in joined else 'other_sheets_or_unknown'))
        e = cats.setdefault(key, {'count': 0, 'last_seen_token': None, 'sample': None})
        e['count'] += 1
        e['last_seen_token'] = joined[:160]
        if e['sample'] is None:
            e['sample'] = r
    EVIDENCE['L6_write_log'] = {
        'lastRow': wl_last, 'scanned_from': start, 'scanned_rows': len(tail_rows),
        'read_error': tail['error'] or wl['error'],
        'categories': cats,
        'classification_note': 'Tom #4：写日志末尾含停用提醒与其它页面/主库活动，'
                               '不能全部称为生产目标表写入；此处按动作/目标/时间逐类拆分。',
        'evidence_limit': '分类依据为日志文本关键词匹配，属提交方启发式归类；'
                          '每条原始证据已存本 JSON 的 sample 字段，供逐条独立复核。',
    }
    print('[L6] _TS_WRITE_LOG lastRow=%s scanned=%d categories=%s'
          % (wl_last, len(tail_rows), {k: v['count'] for k, v in cats.items()}))

    # ---------- L7 主库 ----------
    msheets, ms_ms, merr = sheets(MASTER_ID)
    mlast = values_strict(MASTER_ID, '工时', 'A1:A1', 120)
    EVIDENCE['L7_master'] = {'sheets': msheets, 'sheets_error': merr,
                             '工时_lastRow': mlast['lastRow'], 'error': mlast['error'],
                             'ms': ms_ms}
    print('[L7] master sheets=%d  工时_lastRow=%s err=%s'
          % (len(msheets), mlast['lastRow'], mlast['error'] or merr))

    EVIDENCE['meta']['end_utc'] = now_utc()
    EVIDENCE['meta']['zero_write'] = True
    outdir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                          'evidence', 'stage_a')
    os.makedirs(outdir, exist_ok=True)
    stamp = now_utc().replace(':', '').replace('-', '')
    out = os.path.join(outdir, 'stageA_v2_%sZZ.json' % stamp)
    io.open(out, 'w', encoding='utf-8').write(json.dumps(EVIDENCE, ensure_ascii=False, indent=2))
    print('\n[OUT] %s' % out)
    print('[CLAIM] zero_write=True / freeze 未翻 / clearance 未放行 / 未换链接 / 未 push')
    print('[SCOPE] 全部为提交方 live 读取报告，非独立复核方验证')
    return 0

if __name__ == '__main__':
    sys.exit(main())
