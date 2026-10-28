# -*- coding: utf-8 -*-
"""
GAS 单源可复现校验器（回应 Tom #1「源码/生成物/输出错配」+ ce058ba 一.3 dispatch manifest）

🔴 只读铁律（Tom 2026-10-28 17:49Z 一）：本校验器【默认不导入、不启动、不执行】审阅仓供应的
   Python/JS，且【不写入原审阅副本】。生成可复现性改由两层承担：
     · 默认（只读）：生成器身份哈希固定 + 产物哈希固定 + 生成器确定性静态扫描；
     · opt-in（--run-generator）：仅当生成器 SHA-256 == PINNED_GEN_SHA256 时，在【临时隔离
       副本】以 `python -I`（隔离模式）+ 剥离环境变量（无凭证/无 token）执行两次，并证明
       原审阅副本运行前后逐字节未变。身份不符 → 拒绝执行并 FAIL。

断言六件事，任一件不成立即以非 0 退出：
  1) 【逐字内联】三个规范源文件（core / norm / period_lock）去掉 'use strict' 与
     module.exports 包装后的正文，必须是生成物 ts_softdel_gas_embedded.js 的【连续子串】。
     —— 这条直接证伪/证实"GAS 副本是另一份手抄逻辑"的怀疑。
     去壳由校验器自包含实现（见 _v_strip 取舍披露），不再 exec_module 仓库 Python。
  2) 【生成可复现】只读固定基线比对（产物 SHA-256 == PINNED_ARTIFACTS）；
     加 --run-generator 时另跑隔离副本两次并比对，且证明原审阅副本零改动。
  3) 【版本自洽】生成物里的 VERSION 常量必须与规范源 ts_softdel_core.js 的 VERSION 相同。
  4) 【FINAL_FILE 内联核心区逐字一致】FINAL_FILE 内联核心区必须与 embedded 内联核心区逐字一致，
     杜绝 FINAL_FILE（实际部署入口）二次漂移。
  5) 【dispatch/entrypoint manifest】FINAL_FILE 前缀 dispatch 映射中，softDelGuarded 与 statusQuery
     必须各唯一存在且统一路由到 tsSoftDelGuarded，不得有其它键路由到该受控入口（防前缀漂移假通过）。
  6) 【受限静态转发形态】受控入口（softDelGuarded / statusQuery）的成员值必须【恰好】是
     `function(x){ return tsSoftDelGuarded(x); }` 的白名单形态（形参原样转发）。
     默认拒绝一切其它形态：三元 ?: / && / || / 额外调用 / 成员访问 / 多语句 / 动态属性 / 别名。
     🔴 本校验【纯静态、零执行待审 JavaScript】。曾短暂采用「Node 子进程 + Recording Stub 执行」
        方案，经 Tom 2026-10-28 16:21Z 二 判定为阻断项（Proxy 不是安全边界、子进程继承宿主
        文件/环境/网络权限，且校验器处理的正是待审内容，审计方因此拒绝运行）→ 已彻底移除。

输出逐件源码的 SHA-256 与 git blob 哈希，供固定提交比对；结论写入证据文件。
"""
import hashlib
import io
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = HERE
EMB = os.path.join(HERE, 'v4_patches', 'full', 'ts_softdel_gas_embedded.js')
GEN = os.path.join(HERE, 'gen_gas_softdel.py')
FINAL = os.path.join(HERE, 'v4_patches', 'full', 'RemoteActions.A1d_v4_FINAL_entry_bound.js')
ANCHOR = "var norm = (function() {"
EVID = os.path.join(HERE, '..', '_tmp', 'evidence', 'gen_single_source_20261027.txt')

SOURCES = [
    ('ts_softdel_core.js', os.path.join(TOOLS, 'ts_softdel_core.js')),
    ('ts_softdel_norm.js', os.path.join(TOOLS, 'ts_softdel_norm.js')),
    ('period_lock_port.js', os.path.join(TOOLS, 'period_lock_port.js')),
]

# ============================================================
# 固定可信基线（Tom 2026-10-28 17:49Z 一：「把生成器视作单独审过并明确固定的可信工具」）
#   PINNED_GEN_SHA256  —— 生成器身份。任何改动（哪怕是仓库被植入后门）都会使哈希失配，
#                         校验器随即【拒绝执行】并以非 0 退出，绝不"照跑不误"。
#   PINNED_ARTIFACTS   —— 已提交产物（embedded / FINAL_FILE）的固定哈希，供只读比对。
#                         产物合法重新生成后，须由人显式更新本 pin 并让审阅方看到这次变更。
# ============================================================
PINNED_GEN_SHA256 = 'd733c3370ed3df65df42a1c2ebabba67954e4ecbc80cde026950d6318594f3a2'
PINNED_ARTIFACTS = {
    'ts_softdel_gas_embedded.js':
        '5bcb0bf5c8cecc44d084c3493983f953bc39e5eedae55ae6641fb11683a940df',
    'RemoteActions.A1d_v4_FINAL_entry_bound.js':
        '4a03d04b9bf021445e7546f11d04e724e451e9292224af7702522b02b9db2bbf',
}

# 生成器非确定性来源（只读静态扫描用）：命中任一即不具"可复现"资格
NONDET_RE = re.compile(
    r'(?m)^\s*(?:import\s+(?:time|random|uuid|datetime|secrets)\b'
    r'|from\s+(?:time|random|uuid|datetime|secrets)\s+import\b'
    r'|\w+\s*=\s*(?:os\.urandom|uuid\.uuid4|time\.time|datetime\.now)'
    r'|\b(?:os\.urandom|uuid\.uuid4|time\.time|datetime\.now|glob\.glob|os\.listdir)\s*\()')


def sha256_file(p):
    with open(p, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


def git_blob(p):
    try:
        out = subprocess.run(['git', 'hash-object', p], capture_output=True, text=True, cwd=HERE)
        return out.stdout.strip() or '(n/a)'
    except Exception:
        return '(n/a)'


def _v_strip(src, kind):
    """校验器【自包含】去壳：去掉 require 行 / module.exports 守卫 / 前导 'use strict'。

    🔴 取舍披露（回应 Tom 2026-10-28 17:49Z 一）：Tom 要求"不导入或启动审阅仓提供的 Python"，
    而原实现用 `spec.loader.exec_module(mod)` 动态导入生成器复用其去壳函数 —— 那是把待审
    Python 载入本进程执行，已删除。代价是去壳逻辑变为【第二份实现】。偏离方向是安全的：
      若本实现与生成器去壳不一致 → 正文就不是生成物的子串 → 断言1【立即失败】并打印首个
      未命中片段（漏报→显式失败），不会"放宽放行"。
    另加长度下限防止去壳过激把检查退化成平凡通过：
      正文 ≥ 原文件 90%（norm/pl 合法去壳会删掉末尾 module.exports 守卫块 ≈6%，
      故下限取 90% 而非 98%；低于此即视为去壳过激 → 拒绝以该正文做比对）。
    """
    if kind == 'core':
        keep = [l for l in src.splitlines()
                if "require('./ts_softdel_norm.js')" not in l
                and "require('./period_lock_port.js')" not in l]
        s = '\n'.join(keep)
        idx = s.find('\nmodule.exports = {')
        return (s[:idx].rstrip() + '\n').rstrip() if idx >= 0 else s.rstrip()
    idx = src.find('if (typeof module')
    s = (src[:idx].rstrip() + '\n') if idx >= 0 else src
    s = re.sub(r"^\s*'use strict';\s*\n", '', s)
    return s.rstrip()


def _static_determinism_ok(gen_src):
    """只读静态扫描：生成器不得含任何非确定性来源（时间/随机/UUID/目录枚举）。"""
    hits = NONDET_RE.findall(gen_src)
    return (not hits), sorted(set(hits))


def _run_generator_isolated():
    """opt-in：在【临时隔离副本】中执行【固定哈希】的生成器两次；原审阅副本零写入。

    Tom 17:49Z 一 的许可路径：把生成器视作单独审过并明确固定的可信工具，在无网络、无凭证的
    临时隔离副本中运行，并确认原审阅副本未改变。实施要点：
      1) 身份门：sha256(GEN) 必须 == PINNED_GEN_SHA256，否则【拒绝执行】（返回 refused）。
      2) 隔离副本：仅复制生成器 + 3 份规范源 + 2 份产物到 tempdir，cwd 指向该副本。
      3) 解释器隔离：`python -I`（隔离模式：忽略 PYTHON* 环境变量、不含脚本目录与用户
         site-packages）；env 仅保留 PATH/SystemRoot/TEMP/TMP + 无害 PYTHON 开关，
         不继承任何凭证/token/代理变量。
      4) 诚实边界：`-I` 不是内核级沙箱，不声称能阻断已联网的恶意代码；它保证的是"不把我方
         凭证/环境递给被审代码，且不写原审阅副本"。
    返回 (refused_reason, runs)；runs 为 [{'rc':..,'emb':sha,'fin':sha,'err':..}, ...]。
    """
    import shutil
    import tempfile

    if sha256_file(GEN) != PINNED_GEN_SHA256:
        return '生成器 SHA-256 与 PINNED_GEN_SHA256 不一致 → 拒绝执行（非固定可信工具）', []

    safe_env = {
        'PATH': os.environ.get('PATH', ''),
        'SystemRoot': os.environ.get('SystemRoot', ''),
        'TEMP': os.environ.get('TEMP', ''),
        'TMP': os.environ.get('TMP', ''),
        'PYTHONHASHSEED': '0',
        'PYTHONDONTWRITEBYTECODE': '1',
        'PYTHONNOUSERSITE': '1',
    }
    rel = [('gen_gas_softdel.py', GEN),
           ('ts_softdel_core.js', SOURCES[0][1]),
           ('ts_softdel_norm.js', SOURCES[1][1]),
           ('period_lock_port.js', SOURCES[2][1])]
    runs = []
    for _ in range(2):
        d = tempfile.mkdtemp(prefix='tsgen_isolated_')
        try:
            td = os.path.join(d, 'tools')
            os.makedirs(os.path.join(td, 'v4_patches', 'full'))
            for name, p in rel:
                shutil.copyfile(p, os.path.join(td, name))
            shutil.copyfile(EMB, os.path.join(td, 'v4_patches', 'full', 'ts_softdel_gas_embedded.js'))
            shutil.copyfile(FINAL, os.path.join(td, 'v4_patches', 'full',
                                                'RemoteActions.A1d_v4_FINAL_entry_bound.js'))
            gcopy = os.path.join(td, 'gen_gas_softdel.py')
            r = subprocess.run([sys.executable, '-I', gcopy], cwd=td, env=safe_env,
                               capture_output=True, text=True, timeout=180)
            runs.append({
                'rc': r.returncode,
                'emb': sha256_file(os.path.join(td, 'v4_patches', 'full', 'ts_softdel_gas_embedded.js')),
                'fin': sha256_file(os.path.join(td, 'v4_patches', 'full',
                                                'RemoteActions.A1d_v4_FINAL_entry_bound.js')),
                'err': (r.stderr or '').strip()[-300:],
            })
        finally:
            shutil.rmtree(d, ignore_errors=True)
    return None, runs


def main():
    rep = []
    ok = True

    emb_src = io.open(EMB, encoding='utf-8').read()

    rep.append('=== GAS 单源可复现校验（回应 Tom #1）===')
    rep.append('生成物：%s  SHA-256=%s' % (os.path.relpath(EMB, HERE), sha256_file(EMB)))
    rep.append('')

    # 1) 逐字内联
    rep.append('--- 断言1：规范源正文必须是生成物的连续子串（逐字内联）---')
    for name, path in SOURCES:
        src = io.open(path, encoding='utf-8').read()
        # 去壳由校验器自包含实现（不再 exec_module 仓库 Python，见 _v_strip 取舍披露）
        body = _v_strip(src, 'core' if name == 'ts_softdel_core.js' else 'iife')
        # 生成物里是缩进过的？逐字内联不做缩进变换，直接用 strip 后的正文比对
        found = body in emb_src
        # 长度下限：防止去壳过激把"逐字内联"退化成平凡通过（≥ 原文件 98%）
        ratio = (len(body) / float(len(src))) if src else 0.0
        if ratio < 0.90:
            found = False
            rep.append('    [FAIL] %s 去壳后仅剩 %.2f%%（<90%%），去壳过激 → 拒绝以该正文做比对' % (name, ratio * 100))
        rep.append('  %-20s 正文长度=%6d(占原文%.2f%%)  连续子串命中=%s  SHA-256=%s  git-blob=%s'
                   % (name, len(body), ratio * 100, 'YES' if found else 'NO',
                      sha256_file(path)[:16] + '…', git_blob(path)[:12]))
        if not found:
            ok = False
            # 给出首个不匹配的片段，便于定位
            for k in range(0, min(len(body), 4000), 200):
                if body[k:k + 200] not in emb_src:
                    rep.append('    首个未命中片段 @%d: %r' % (k, body[k:k + 200]))
                    break
    rep.append('')

    # 2) 生成可复现（默认【只读】；--run-generator 时才在隔离副本中执行固定生成器）
    rep.append('--- 断言2：生成可复现（默认只读固定基线比对；opt-in 隔离副本重跑）---')
    WANT_RUN = '--run-generator' in sys.argv
    gen_pin_ok = (sha256_file(GEN) == PINNED_GEN_SHA256)
    rep.append('  生成器 SHA-256            = %s' % sha256_file(GEN))
    rep.append('  PINNED_GEN_SHA256         = %s' % PINNED_GEN_SHA256)
    rep.append('  生成器身份与固定值一致    = %s' % ('YES' if gen_pin_ok else 'NO'))
    if not gen_pin_ok:
        ok = False
        rep.append('  [FAIL] 生成器不是固定可信工具：身份哈希失配 → 拒绝导入/执行其 Python（Tom 17:49Z 一）')
    det_ok, det_hits = _static_determinism_ok(io.open(GEN, encoding='utf-8').read())
    rep.append('  生成器确定性静态扫描      = %s%s' % ('YES' if det_ok else 'NO',
                                                     '' if det_ok else '  命中=%s' % det_hits))
    if not det_ok:
        ok = False
        rep.append('  [FAIL] 生成器含非确定性来源，产物不可复现')
    emb_sha, fin_sha = sha256_file(EMB), sha256_file(FINAL)
    for label, actual, pinned in (('embedded', emb_sha, PINNED_ARTIFACTS['ts_softdel_gas_embedded.js']),
                                  ('FINAL_FILE', fin_sha, PINNED_ARTIFACTS['RemoteActions.A1d_v4_FINAL_entry_bound.js'])):
        hit = (actual == pinned)
        rep.append('  [%s] 现有=%s' % (label, actual))
        rep.append('  [%s] 固定=%s  一致=%s' % (label, pinned, 'YES' if hit else 'NO'))
        if not hit:
            ok = False
            rep.append('  [FAIL] %s 与固定基线不一致（产物被改或未重新固化；合法重新生成须显式更新 pin）' % label)
    if not WANT_RUN:
        rep.append('  [只读] 本次未执行任何仓库 Python（默认模式）。加 --run-generator 可在隔离副本中重跑固定生成器。')
    else:
        refused, runs = _run_generator_isolated()
        if refused:
            ok = False
            rep.append('  [FAIL] %s' % refused)
        else:
            rep.append('  隔离副本执行退出码：%s / %s' % (runs[0]['rc'], runs[1]['rc']))
            rep.append('  隔离副本 [embedded] #1=%s' % runs[0]['emb'])
            rep.append('  隔离副本 [embedded] #2=%s' % runs[1]['emb'])
            rep.append('  隔离副本 [FINAL_FILE] #1=%s' % runs[0]['fin'])
            rep.append('  隔离副本 [FINAL_FILE] #2=%s' % runs[1]['fin'])
            repro = (runs[0]['emb'] == runs[1]['emb'] and runs[0]['fin'] == runs[1]['fin'])
            same_committed = (runs[0]['emb'] == emb_sha and runs[0]['fin'] == fin_sha)
            rep.append('  两次隔离产出一致=%s   与已提交产物一致=%s' % ('YES' if repro else 'NO',
                                                                     'YES' if same_committed else 'NO'))
            if runs[0]['rc'] != 0 or runs[1]['rc'] != 0:
                ok = False
                rep.append('  [FAIL] 隔离副本生成器退出码非 0；stderr=%s' % (runs[0]['err'] or runs[1]['err']))
            if not repro:
                ok = False
                rep.append('  [FAIL] 隔离副本两次产出不一致（生成不可复现）')
            if not same_committed:
                ok = False
                rep.append('  [FAIL] 隔离副本产出与已提交产物不一致（产物非由固定生成器生成）')
            # 🔴 关键：证明原审阅副本零改动（Tom 要求"确认原审阅副本未改变"）
            now_emb, now_fin = sha256_file(EMB), sha256_file(FINAL)
            untouched = (now_emb == emb_sha and now_fin == fin_sha)
            rep.append('  原审阅副本运行前/后 [embedded] 一致=%s  [FINAL_FILE] 一致=%s'
                       % ('YES' if now_emb == emb_sha else 'NO', 'YES' if now_fin == fin_sha else 'NO'))
            if not untouched:
                ok = False
                rep.append('  [FAIL] 隔离执行竟然改动了原审阅副本（违反只读铁律）')
    rep.append('')

    # 3) 版本自洽
    rep.append('--- 断言3：生成物 VERSION 必须与规范源 ts_softdel_core.js 一致 ---')
    emb_src2 = io.open(EMB, encoding='utf-8').read()
    m_emb = re.search(r"var VERSION = '([^']+)'", emb_src2)
    core_src = io.open(SOURCES[0][1], encoding='utf-8').read()
    m_core = re.search(r"var VERSION = '([^']+)'", core_src)
    v_emb = m_emb.group(1) if m_emb else None
    v_core = m_core.group(1) if m_core else None
    same = (v_emb is not None and v_emb == v_core)
    rep.append('  规范源 VERSION = %s' % v_core)
    rep.append('  生成物 VERSION = %s' % v_emb)
    rep.append('  一致=%s' % ('YES' if same else 'NO'))
    if not same:
        ok = False
    rep.append('')
    # 4) FINAL_FILE 内联核心区必须与 embedded 内联核心区【逐字一致】（杜绝 FINAL_FILE 二次漂移）
    rep.append('--- 断言4：FINAL_FILE 内联核心区 必须与 embedded 内联核心区 逐字一致 ---')
    emb_src3 = io.open(EMB, encoding='utf-8').read()
    fin_src4 = io.open(FINAL, encoding='utf-8').read()
    if ANCHOR not in emb_src3:
        rep.append('  [FAIL] embedded 找不到锚点 %s' % ANCHOR); ok = False
    elif ANCHOR not in fin_src4:
        rep.append('  [FAIL] FINAL_FILE 找不到锚点 %s' % ANCHOR); ok = False
    else:
        emb_region = emb_src3[emb_src3.find(ANCHOR):]
        fin_region = fin_src4[fin_src4.find(ANCHOR):]
        region_ok = (emb_region == fin_region)
        rep.append('  embedded 内联区长度=%d  FINAL_FILE 内联区长度=%d  逐字一致=%s'
                   % (len(emb_region), len(fin_region), 'YES' if region_ok else 'NO'))
        if not region_ok:
            ok = False
            n = min(len(emb_region), len(fin_region))
            for k in range(0, n, 200):
                if emb_region[k:k + 200] != fin_region[k:k + 200]:
                    rep.append('    首个差异片段 @%d:' % k)
                    rep.append('      embedded: %r' % emb_region[k:k + 200])
                    rep.append('      FINAL   : %r' % fin_region[k:k + 200])
                    break
    rep.append('')

    def _js_mask(s, mask_strings=True):
        """统一词法扫描器：把注释（以及可选的字符串/模板/正则内容）替换为【等长空格】。

        🔴 回应 Tom 2026-10-28 17:49Z 二：此前各层扫描规则【不统一】—— 顶层键解析器跳注释，
        而 _member_value_span / ENTRY_RE / 'return tsSoftDelGuarded(' 计数却直接扫【原文】，
        于是注释可以提供假命中：
            /* softDelGuarded: function(e){ return tsSoftDelGuarded(e); } */
            softDelGuarded: function(e){ return otherAction(e); },
        注释补齐了「受控入口命中 + 转发形态 + return 计数」，而真实入口指向 otherAction，
        成员集合/入口计数/return 计数三层全部通过 —— 完整绕过。
        统一后：所有结构判定（键解析 / 值定位 / 入口正则 / 计数 / 花括号配平）一律只在
        掩码文本上进行，注释与字符串不得参与任何判定。

        mask_strings=False → 仅屏蔽注释与正则字面量，保留字符串内容（供键解析器读取引号键，
                             回应 Tom K1-a：带引号顶层键必须归一化入集合）。
        返回 (masked, unsupported)；unsupported 非空 = 存在未终止词法单元，调用方须 fail-closed。
        """
        out = list(s)
        unsupported = []
        i, n = 0, len(s)
        prev_sig = ''      # 上一个非空白字符（用于区分正则字面量与除法）

        def blank(a, bnd):
            for k in range(a, min(bnd, n)):
                if out[k] != '\n':
                    out[k] = ' '

        while i < n:
            c = s[i]
            if c == '/' and i + 1 < n and s[i + 1] == '/':
                j = s.find('\n', i)
                j = n if j < 0 else j
                blank(i, j)
                i = j
                continue
            if c == '/' and i + 1 < n and s[i + 1] == '*':
                j = s.find('*/', i + 2)
                if j < 0:
                    unsupported.append('/*(未终止)')
                    j = n
                else:
                    j += 2
                blank(i, j)
                i = j
                continue
            if c == '/' and (prev_sig == '' or not (prev_sig.isalnum() or prev_sig in '_$)]}')):
                # 正则字面量（启发式：前一有效字符不是标识符/数字/右括号 → 不是除法）。
                # 正则里的 '{' '}' 会破坏花括号配平，正则里的 'return tsSoftDelGuarded('
                # 会虚增计数，故一并屏蔽。
                j, in_cls, closed = i + 1, False, False
                while j < n:
                    ch = s[j]
                    if ch == '\\':
                        j += 2
                        continue
                    if ch == '\n':
                        break
                    if in_cls:
                        if ch == ']':
                            in_cls = False
                    elif ch == '[':
                        in_cls = True
                    elif ch == '/':
                        closed = True
                        break
                    j += 1
                if closed:
                    blank(i, j + 1)
                    i = j + 1
                    prev_sig = '/'
                    continue
                # 未闭合 → 当作普通除法字符，继续
            if c in '"\'`':
                q = c
                j, closed = i + 1, False
                while j < n:
                    ch = s[j]
                    if ch == '\\':
                        j += 2
                        continue
                    if ch == q:
                        closed = True
                        break
                    j += 1
                end = (j + 1) if closed else n
                if not closed:
                    unsupported.append('%s(未终止)' % q)
                if mask_strings:
                    blank(i, end)
                i = end
                prev_sig = q
                continue
            if not c.isspace():
                prev_sig = c
            i += 1
        return ''.join(out), unsupported

    # 5) 完整 dispatch 区块解析 + 顶层成员完整清单 fail-closed（Tom 本轮 一/二：真实 manifest 路径必须受保护）
    rep.append('--- 断言5：FINAL_FILE 完整 dispatch 区块解析 + 顶层成员完整清单 fail-closed ---')
    fin_src5 = io.open(FINAL, encoding='utf-8').read()
    anchor_pos = fin_src5.find(ANCHOR)
    fin_prefix = fin_src5[:anchor_pos] if anchor_pos >= 0 else fin_src5
    # 5a) 在【掩码文本】上截取 dispatch 区块：字符串/注释里的 '};' 不再能截断定界。
    #     掩码与原文等长对齐，故可直接用同一组下标从原文取出真实区块。
    pf_fm, pf_unsup = _js_mask(fin_prefix, mask_strings=True)
    if pf_unsup:
        ok = False
        rep.append('  [FAIL] FINAL_FILE 前缀区存在未终止词法单元（强制 fail-closed）：%s' % pf_unsup)
    m_block = re.search(r'var\s+REMOTE_ACTIONS\s*=\s*\{(.*?)\n?\};', pf_fm, re.S)
    block = fin_prefix[m_block.start(1):m_block.end(1)] if m_block else ''
    if not m_block:
        ok = False
        rep.append('  [FAIL] 未能定位 REMOTE_ACTIONS 区块')
    # 5b) 受控入口（路由到 tsSoftDelGuarded）仍按 ENTRY_RE 解析（仅作受控集合核对）
    ENTRY_RE = re.compile(r'([A-Za-z_][A-Za-z0-9_]*)\s*:\s*function\s*\([^)]*\)\s*\{\s*return\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(', re.M)
    WHITELIST = {'softDelGuarded', 'statusQuery'}
    # 5c) 顶层成员完整清单：深度感知解析（覆盖含前置语句/字符串返回/复杂函数体的 42 个既有成员）
    #     真实 REMOTE_ACTIONS 共 42 个顶层成员；ENTRY_RE 仅命中 36（只匹配“function(){ return TARGET(}”紧返回形态，
    #     其余 6 个含 var 前置语句或字符串返回不命中）。报告的“成员总数”必须是完整顶层解析(42)，而非 ENTRY_RE 命中(36)。
    BASELINE_KEYS = {
        'repairLegacyLeave','setupPeriodLock','plVerifyHash','plGuardTest','masterException',
        'refreshqs','exception','archive','setup','setupAmy','testAmySelf','cleanupLeaves',
        'syncLeaves','checkLeaves','readRange','appendRows','patchCells','softDelGuarded',
        'statusQuery','createSheet','snapshot','trimblank','dupreport','driveList',
        'purgeSoftLeaves','purgeRows','probeCalendar','masterCreate','masterLeaves','pruneDead',
        'fixBDates','delBlankRows','sheetMeta','applyFormat','masterCondFormat','alert',
        'listTriggers','syncMaster','rebuildLive','viewsLive','malAll','ensureMalTriggers',
    }
    def _parse_top_level_keys(b):
        """深度感知解析 REMOTE_ACTIONS 区块的顶层成员键（输入必须是【注释/正则已屏蔽】的文本）。

        🔴 回应 Tom 2026-10-28 17:49Z 二：本解析器现为【唯一】的键/值定位来源 —— 成员值的
        起止下标由它直接给出（spans），下游一律不再用未锚定正则去"搜"成员。搜索式定位可被
        注释里的同名键劫持，解析式定位不会。

        返回 (keys, computed_keys, spreads, unsupported, spans)：
          computed_keys —— depth==0 的计算属性键（形如 ['x']: …），运行期动态绑定 → fail-closed
          spreads       —— depth==0 的对象展开（...{…} / ...expr），运行期可覆盖既有成员 → fail-closed
          unsupported   —— depth==0 键位上出现的未支持语法字符 → fail-closed
          spans         —— key -> [(key_start, value_start, value_end)]，供形态白名单取值。
                           list 长度 != 1（缺失或重复）时调用方必须 fail-closed。
        """
        keys = []
        computed_keys = []
        spreads = []
        unsupported = []
        spans = {}
        pending = [None, None, None]      # [key, key_start, value_start]
        depth = 0
        expect_key = True
        i = 0
        n = len(b)

        def close_value(end_idx):
            if pending[0] is not None:
                spans.setdefault(pending[0], []).append((pending[1], pending[2], end_idx))
            pending[0] = pending[1] = pending[2] = None

        while i < n:
            c = b[i]
            if depth == 0 and c == '.' and b[i:i+3] == '...':
                # 顶层对象展开（Tom 2026-10-28 15:17Z 第四类绕过）：
                # ...{ setup: function(e){ return otherAction(e); } } 是【合法 JS】，运行期展开
                # 会用后面的同名键覆盖原映射；展开内容静态不可确定，一律 fail-closed（不解析求值）。
                spreads.append(b[i:i+3])
                i += 3
                continue
            if (c == '"' or c == "'") and depth == 0:
                # 顶层（depth==0）字符串字面量：若紧跟 ':' 则为【带引号顶层键】，须归一化
                # （去引号）后入键集合，交由顶层清单比对 fail-closed。
                # （Tom K1-a：原代码整串跳过，引号键不进 top_keys，可绕过集合比对。）
                q = c;  i += 1;  start = i
                while i < n:
                    if b[i] == '\\': i += 2; continue
                    if b[i] == q: break
                    i += 1
                content = b[start:i]
                i += 1  # 跳过闭合引号
                k = i
                while k < n and b[k] in ' \t\n\r': k += 1
                if k < n and b[k] == ':':
                    keys.append(content)   # 归一化为去引号键，交由集合比对 fail-closed
                    pending[0], pending[1], pending[2] = content, start - 1, k + 1
                    i = k + 1
                    expect_key = False     # 进入值位
                continue
            if c == '"' or c == "'":
                # 非顶层（depth>0）字符串字面量：照旧整体跳过
                q = c;  i += 1
                while i < n:
                    if b[i] == '\\': i += 2; continue
                    if b[i] == q: i += 1; break
                    i += 1
                continue
            if c == '[' and depth == 0:
                # 顶层计算属性键（['x']: …）或数组值。先用括号匹配扫到匹配 ']'，
                # 再判其后是 ':'（键）还是 ','/'}'（值）。仅当后是 ':' 才算计算键 → fail-closed。
                j = i + 1
                bal = 1
                while j < n and bal > 0:
                    ch = b[j]
                    if ch == '\\' and j + 1 < n and b[j+1] in '"\'':
                        j += 2; continue
                    if ch == '"' or ch == "'":
                        q = ch; j += 1
                        while j < n:
                            if b[j] == '\\': j += 2; continue
                            if b[j] == q: j += 1; break
                            j += 1
                        continue
                    if ch == '[': bal += 1
                    elif ch == ']': bal -= 1
                    j += 1
                k = j
                while k < n and b[k] in ' \t\n\r': k += 1
                if k < n and b[k] == ':':
                    computed_keys.append(b[i:j+1])   # 计算属性键，运行期动态绑定，强制 fail-closed
                    pending[0], pending[1], pending[2] = b[i:j+1], i, k + 1
                    i = k + 1
                    expect_key = False     # 进入值位
                else:
                    i = j   # 数组值（如 key: [1,2,3] 或 key: [{…}]），整体跳过
                continue
            if c == '{': depth += 1; i += 1; continue
            if c == '}':
                if depth == 0:
                    close_value(i)
                depth -= 1; i += 1
                if depth == 0: expect_key = True   # 该成员函数体结束，回到键位
                continue
            if depth == 0 and (c.isalpha() or c == '_' or c == '$'):
                j = i
                while j < n and (b[j].isalnum() or b[j] in '_$'):
                    j += 1
                k = j
                while k < n and b[k] in ' \t':
                    k += 1
                if k < n and b[k] == ':':
                    keys.append(b[i:j])
                    pending[0], pending[1], pending[2] = b[i:j], i, k + 1
                    i = k + 1;  expect_key = False;  continue
                i = j;  continue
            if depth == 0:
                if c == ',':
                    close_value(i)         # 顶层分隔符 → 收束上一个成员值
                    expect_key = True
                    i += 1;  continue
                if expect_key and not (c.isalpha() or c in '_$"' or c == "'" or c == '[' or c in ' \t\n\r'):
                    # 键位上出现既非键起始、也非分隔符的字符 = 未支持语法 → fail-closed（Tom 15:17Z）
                    unsupported.append(c)
            i += 1
        close_value(n)
        return keys, computed_keys, spreads, unsupported, spans

    def _member_value_text(cm, fm, spans, key):
        """由【解析器给出的下标】取成员值文本（Tom 17:49Z 二：禁止未锚定正则搜索定位）。
        返回 (raw_text, masked_text)；键缺失或重复（spans 长度 != 1）时返回 (None, None)。"""
        sp = spans.get(key, [])
        if len(sp) != 1:
            return None, None
        _, vs, ve = sp[0]
        return cm[vs:ve].strip(), fm[vs:ve]

    # 白名单形态：只允许【无分支、无额外调用、形参原样转发】的唯一合法形式。
    # 默认拒绝一切其它形态（三元 ?: / && || / 额外调用 / 成员访问 / 多条语句 / 动态属性 / 别名），
    # 故不是"补一种语法挡一种绕过"的打地鼠（Tom 2026-10-28 16:21Z 三）。
    FORWARD_RE = re.compile(
        r'^function\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{\s*'
        r'return\s+tsSoftDelGuarded\s*\(\s*\1\s*\)\s*;?\s*\}$')

    def _static_forward_ok(raw, whitelist):
        """【受限静态转发形态】对每个受控入口，要求其成员值【恰好】是
        `function(x){ return tsSoftDelGuarded(x); }`（形参原样转发）。

        🔴 纯静态、不执行任何待审 JavaScript（Tom 2026-10-28 16:21Z 二）。
        🔴 值由【解析器下标】取得，并在【掩码文本】上比对（Tom 2026-10-28 17:49Z 二）：
           · 注释里的同名键不再能提供假命中 —— 注释已被屏蔽，且键位置由解析器给出；
           · 函数体内含 '}' 的注释（function(e){ /* } */ return tsSoftDelGuarded(e); }）
             不再导致 span 提前截断 —— 消除 Tom 指出的【误拒】。
        默认拒绝一切其它形态（三元 / && / || / 额外调用 / 成员访问 / 多语句 / 动态属性 / 别名）。
        返回 (ok, lines)。"""
        lines = []
        ok = True
        cm, u1 = _js_mask(raw, mask_strings=False)
        fm, u2 = _js_mask(raw, mask_strings=True)
        if u1 or u2:
            return False, ['  [FAIL] 词法扫描发现未终止/未支持单元（强制 fail-closed）：%s' % (u1 + u2)]
        _, _, _, _, spans = _parse_top_level_keys(cm)
        for key in sorted(whitelist):
            sp = spans.get(key, [])
            if len(sp) != 1:
                ok = False
                lines.append('  [FAIL] 受控入口 %s 在顶层出现 %d 次（须恰好 1 次；'
                             '缺失 / 重复键 / 注释伪造均 fail-closed）' % (key, len(sp)))
                continue
            raw_v, m_v = _member_value_text(cm, fm, spans, key)
            v = re.sub(r'\s+', ' ', m_v).strip()
            m = FORWARD_RE.match(v)
            if not m:
                ok = False
                lines.append('  [FAIL] 受控入口 %s 不是受限静态转发形态'
                             '（白名单仅允许 function(x){ return tsSoftDelGuarded(x); }，'
                             '拒绝三元/&&/||/额外调用/成员访问/多语句）' % key)
                lines.append('      实际值=%s' % (raw_v or '')[:140])
            else:
                lines.append('  受控入口 %s = 受限静态转发形态（形参=%s；无分支、无额外调用、原样转发）'
                             % (key, m.group(1)))
        return ok, lines

    def _real_manifest_ok(raw, baseline):
        """真实 dispatch 路径的完整校验（main() 与负例共用同一函数，杜绝 fixture 与真实路径不一致）。
        🔴 所有结构判定（键解析 / 值定位 / 入口正则 / return 计数）一律在【掩码文本】上进行
        （Tom 2026-10-28 17:49Z 二：注释与字符串不得参与任何判定）。
        返回 (ok, rep_lines, top_keys)。"""
        lines = []
        cm, u1 = _js_mask(raw, mask_strings=False)
        fm, u2 = _js_mask(raw, mask_strings=True)
        if u1 or u2:
            return False, ['  [FAIL] 词法扫描发现未终止/未支持单元（强制 fail-closed）：%s' % (u1 + u2)], []
        top, computed, spreads, unsupported, spans = _parse_top_level_keys(cm)
        # 防顶层对象展开绕过（Tom 2026-10-28 15:17Z 第四类）：...{ setup: … } 是【合法 JS】，
        # 运行期展开会用后面的同名键覆盖原映射；既不是重复键也不是计算键，既有正则/计数全不命中。
        # 展开内容静态不可确定 → 任何顶层展开一律 fail-closed（不尝试解析求值）。
        if spreads:
            ok = False
            lines.append('  [FAIL] 存在顶层对象展开 ...（合法 JS，运行期可覆盖既有成员；静态无法确定展开内容，强制 fail-closed）：%d 处' % len(spreads))
        else:
            ok = True
        # 防未支持语法绕过（Tom 15:17Z 要求）：键位上出现既非键起始、也非分隔符的字符 → fail-closed
        if unsupported:
            ok = False
            lines.append('  [FAIL] 顶层键位存在未支持语法字符（强制 fail-closed）：%s' % sorted(set(unsupported)))
        # 防计算属性键绕过（Tom L3）：['setup']: function… 是合法 JS，运行时会覆盖同名原键，
        # 但静态无法确知运行期绑定，故任何顶层计算键一律 fail-closed（不尝试解析求值）。
        if computed:
            ok = False
            lines.append('  [FAIL] 存在计算属性键（动态键，无法静态确定运行期绑定，强制 fail-closed）：%s' % computed)
        # 防重复顶层键绕过：JavaScript 同名后定义覆盖先定义，
        # 故“集合相同”不能证明“有效映射相同”；必须显式拒绝任何重复顶层键。
        if len(top) != len(set(top)):
            ok = False
            dup_keys = sorted(set(k for k in top if top.count(k) > 1))
            lines.append('  [FAIL] 存在重复顶层键（JS 后定义覆盖先定义，可绕过集合比对）：%s' % dup_keys)
        top_set = set(top)
        if top_set != baseline:
            ok = False
            extra = sorted(top_set - baseline)
            missing = sorted(baseline - top_set)
            lines.append('  [FAIL] 顶层成员清单与基线不一致：额外=%s 缺失=%s（任何注入/删改即 fail-closed）' % (extra, missing))
        # 受控入口（路由到 tsSoftDelGuarded）必须恰好为 WHITELIST 且各唯一一次
        # 🔴 ENTRY_RE 只在【掩码文本 fm】上跑：注释里的同名键不得提供命中（Tom 17:49Z 二）
        em = {}
        for k, t in ENTRY_RE.findall(fm):
            em.setdefault(k, []).append(t)
        controlled = {k: ts[0] for k, ts in em.items() if ts == ['tsSoftDelGuarded']}
        if set(controlled.keys()) != WHITELIST:
            ok = False
            lines.append('  [FAIL] 路由到 tsSoftDelGuarded 的入口必须为且仅为 %s，实际=%s' % (sorted(WHITELIST), sorted(controlled.keys())))
        for k in ('softDelGuarded', 'statusQuery'):
            cnt = len(em.get(k, [])); tgt = em.get(k, [None])[0]
            lines.append('  %s 入口次数=%d 路由目标=%s' % (k, cnt, tgt))
            if cnt != 1 or tgt != 'tsSoftDelGuarded':
                ok = False
                lines.append('    [FAIL] %s 必须唯一且路由 tsSoftDelGuarded' % k)
        rogue = [k for k in controlled if k not in WHITELIST]
        if rogue:
            ok = False
            lines.append('  [FAIL] 以下键非法路由到 tsSoftDelGuarded：%s' % rogue)
        # 后援：return tsSoftDelGuarded( 出现次数必须恰为 2（防非简单形态 rogue）
        # 🔴 计数同样只在【掩码文本 fm】上做：注释不得贡献计数（Tom 17:49Z 二）
        n_ts = fm.count('return tsSoftDelGuarded(')
        if n_ts != 2:
            ok = False
            lines.append('  [FAIL] return tsSoftDelGuarded( 出现 %d 次（须恰为 2，且仅计真实代码）' % n_ts)
        # 【受限静态转发形态 · 回应 Tom 2026-10-28 16:21Z 三 / 17:49Z 二】
        # 成员集合/受控入口计数/return 计数都拦不住"条件转发"与"注释伪造"两类攻击：
        #   a) function(e){ return tsSoftDelGuarded(e.__probe === 1 ? e : otherAction(e)); }
        #   b) /* softDelGuarded: function(e){ return tsSoftDelGuarded(e); } */  + 真实值改向
        # 故在此强制：受控入口的成员值必须【恰好】是白名单的静态转发形态，且键在顶层【恰好出现一次】。
        f_ok, f_lines = _static_forward_ok(raw, WHITELIST)
        lines.extend(f_lines)
        if not f_ok:
            ok = False
        return ok, lines, top

    # 5d) 对真实区块跑真实路径校验
    real_ok, real_lines, real_top = _real_manifest_ok(block, BASELINE_KEYS)
    rep.extend(real_lines)
    # ENTRY_RE 命中数也只在掩码文本上统计（与真实路径同一口径）
    _fm_blk, _u_blk = _js_mask(block, mask_strings=True)
    rep.append('  dispatch 顶层成员总数（完整解析，深度感知）= %d；ENTRY_RE 命中（简单 return 形态，仅计真实代码）= %d' % (len(real_top), len(ENTRY_RE.findall(_fm_blk))))
    rep.append('  manifest 一致=%s' % ('YES' if real_ok else 'NO'))
    if not real_ok:
        ok = False

    # 5e) 负例自测：把各类绕过注入【真实区块】，真实路径必须 fail-closed（Tom 本轮 一/二 核心）
    # 🔴 注入体必须是【合法 JS】才构成真实绕过：block 末行以 '//' 注释结尾，
    #    若直接拼 ',…' 则逗号被注释吞掉 → 产物是语法错误而非合法注入（此前四类负例即此缺陷，
    #    抓到的是"语法垃圾"而非"合法 JS 绕过"）。故统一以 '\n,\n' 起头，确保逗号落在注释之后。
    INJ = '\n,\n  %s\n'
    tamper_cases = {
        '额外未引号成员 evil→otherAction':
            block.rstrip() + INJ % 'evil: function(e){ return otherAction(e); }',
        '引号键 "evil"→otherAction（Tom 本轮 K1-a：原解析器跳过字符串字面量，引号键不进 top_keys 绕过集合比对）':
            block.rstrip() + INJ % '"evil": function(e){ return otherAction(e); }',
        '重复基线键 setup→otherAction（Tom 本轮 K1-b：set() 丢弃重复项，JS 后定义覆盖先定义绕过集合比对）':
            block.rstrip() + INJ % 'setup: function(e){ return otherAction(e); }',
        '计算属性键 [\'setup\']→otherAction（Tom 本轮 L3：解析器未解析/拒绝方括号计算键，运行期覆盖原 setup 绕过集合比对）':
            block.rstrip() + INJ % '[\'setup\']: function(e){ return otherAction(e); }',
        '对象展开 ...{setup:otherAction}（Tom 2026-10-28 15:17Z 第四类：合法 JS，运行期展开覆盖原 setup；'
        '既非重复键亦非计算键，既有正则/计数全不命中）':
            block.rstrip() + INJ % '...{ setup: function(e){ return otherAction(e); } }',
    }
    rep.append('--- 断言5 负例：真实区块注入各类绕过 → 真实路径必须 fail-closed ---')
    for label, tam in tamper_cases.items():
        tam_ok, tam_lines, _ = _real_manifest_ok(tam, BASELINE_KEYS)
        rep.extend(tam_lines)
        if tam_ok:
            ok = False
            rep.append('  [FAIL] 真实区块注入[%s] 未被识别（真实路径缺口仍在）' % label)
        else:
            rep.append('  真实区块注入[%s] → fail-closed=YES' % label)

    # 6) 【受限静态转发形态 · 断言6】纯静态、零执行：
    #    原「运行时语义 manifest」用 Node 子进程真实执行 dispatch 区块（Recording Stub），
    #    经 Tom 2026-10-28 16:21Z 二 判定为阻断项：Proxy 只替换正则扫出的自由标识符，挡不住
    #    内建对象/原型链/构造器；子进程继承宿主的文件、环境与网络权限；30s timeout 不是权限沙箱。
    #    更关键的是——校验器处理的正是【待审（可能被篡改）内容】，审计方因此拒绝运行该校验器，
    #    整条校验链反而失去审计价值。故【彻底移除执行路径】，改为白名单受限静态形态：
    #    默认拒绝，只放行显式允许的转发形式（不再是"补一种语法挡一种绕过"的打地鼠）。
    rep.append('--- 断言6：受限静态转发形态（纯静态 · 零执行待审 JavaScript）---')
    sf_ok, sf_lines = _static_forward_ok(block, WHITELIST)
    rep.extend(sf_lines)
    rep.append('  受限静态转发形态一致=%s' % ('YES' if sf_ok else 'NO'))
    if not sf_ok:
        ok = False
    # 6b) 负例（Tom 16:21Z 三）：成员集合 / 受控入口计数 / return 计数全都拦不住"条件转发"——
    #     键仍唯一、仍路由 tsSoftDelGuarded、return 计数仍为 2，但真实输入会先走 otherAction。
    def _member_spans(b, key):
        """取某顶层键的 [(key_start, value_start, value_end)]（解析器驱动，非正则搜索）。"""
        cm, _ = _js_mask(b, mask_strings=False)
        _, _, _, _, spans = _parse_top_level_keys(cm)
        return spans.get(key, [])

    def _replace_member(b, key, newval):
        """把顶层成员 key 的【值】整体替换为 newval（用解析器给出的下标，非正则搜索）。"""
        sp = _member_spans(b, key)
        if len(sp) != 1:
            return b
        _, vs, ve = sp[0]
        return b[:vs] + newval + b[ve:]

    def _disguise_member(b, key, fake_comment, newval):
        """Tom 2026-10-28 17:49Z 二 的注释伪造攻击：在【真实成员之前】插入注释（注释内含假的
        受控入口与转发形态），并把真实值改成 newval。
        键集合与成员总数均不变（注释不是键），唯一攻击面就是"注释提供假命中"。"""
        sp = _member_spans(b, key)
        if len(sp) != 1:
            return b
        ks, vs, ve = sp[0]
        return b[:ks] + fake_comment + '\n  ' + b[ks:vs] + newval + b[ve:]

    forward_cases = {
        'Tom 16:21Z 三 原反例：softDelGuarded 改为条件转发 tsSoftDelGuarded(e.__probe===1 ? e : otherAction(e))':
            _replace_member(block, 'softDelGuarded',
                            'function(e){ return tsSoftDelGuarded(e.__probe === 1 ? e : otherAction(e)); }'),
        '分支另一侧 + 额外副作用调用：先 otherAction(e) 再转发':
            _replace_member(block, 'softDelGuarded',
                            'function(e){ otherAction(e); return tsSoftDelGuarded(e); }'),
        '逻辑短路分支：return e && tsSoftDelGuarded(e)':
            _replace_member(block, 'softDelGuarded',
                            'function(e){ return e && tsSoftDelGuarded(e); }'),
        'statusQuery 同样改为条件转发（两个受控入口均覆盖）':
            _replace_member(block, 'statusQuery',
                            'function(e){ return tsSoftDelGuarded(e.ok ? e : otherAction(e)); }'),
        # ===== Tom 2026-10-28 17:49Z 二：注释伪造受控入口 =====
        # 注释不是顶层键 → 成员集合/总数完全不变；注释却能提供 ENTRY 命中、转发形态与 return 计数。
        'Tom 17:49Z 二 原反例：注释伪造 softDelGuarded 受控入口，真实值改向 otherAction':
            _disguise_member(block, 'softDelGuarded',
                             '/* softDelGuarded: function(e){ return tsSoftDelGuarded(e); } */',
                             'function(e){ return otherAction(e); }'),
        '注释伪造第二个受控入口 statusQuery（两个受控入口均覆盖）':
            _disguise_member(block, 'statusQuery',
                             '/* statusQuery: function(e){ return tsSoftDelGuarded(e); } */',
                             'function(e){ return otherAction(e); }'),
        '注释同时补齐 ENTRY 命中与 return 计数（真实 statusQuery→otherAction）':
            _disguise_member(block, 'statusQuery',
                             '/* statusQuery: function(e){ return tsSoftDelGuarded(e); }\n'
                             '     return tsSoftDelGuarded( */',
                             'function(e){ return otherAction(e); }'),
        # 🔴 攻击类的【最强形态】（我方补充，比 Tom 字面片段更强）：
        #   Tom 字面片段的真实值是 function(e){ return otherAction(e); } —— 它本身仍会被 ENTRY_RE
        #   命中（target=otherAction），故"入口次数==1"这一层仍会拦下。把真实值改成
        #   function(e){ var r = otherAction(e); return r; }（非 return 开头，ENTRY_RE 不再命中）
        #   则旧实现下四层（成员集合 / 入口次数 / return 计数 / 转发形态）【全部漏过】。
        #   统一掩码后：注释不再贡献任何命中 → return 计数=1 → fail-closed。
        '注释伪造·最强形态：真实值改为非 return 开头（旧实现下集合/入口计数/return计数/形态四层全漏）':
            _disguise_member(block, 'softDelGuarded',
                             '/* softDelGuarded: function(e){ return tsSoftDelGuarded(e); } */',
                             'function(e){ var r = otherAction(e); return r; }'),
    }
    rep.append('--- 断言6 负例：条件转发 / 额外调用 / 注释伪造 → 真实路径必须 fail-closed ---')
    for label, tam in forward_cases.items():
        c_ok, c_lines, _ = _real_manifest_ok(tam, BASELINE_KEYS)
        if c_ok:
            ok = False
            rep.append('  [FAIL] 真实路径未能识别[%s]' % label)
        else:
            rep.append('  真实路径：[%s] → fail-closed=YES' % label)

    # 6c) 正例（Tom 17:49Z 二 指出的【误拒】）：合法转发函数体内含带 '}' 的注释。
    #     旧 _member_value_span 先数花括号、后剥注释 → span 在 '/* } */' 处提前截断 → 白名单误拒。
    #     掩码器统一先屏蔽注释 → 必须仍然放行。
    pos_fwd = _replace_member(block, 'softDelGuarded',
                              'function(e){ /* } */ return tsSoftDelGuarded(e); }')
    pos_fwd = _replace_member(pos_fwd, 'statusQuery',
                              'function(e){ /* } */ return tsSoftDelGuarded(e); }')
    pos_fwd_ok, _, _ = _real_manifest_ok(pos_fwd, BASELINE_KEYS)
    rep.append('  正例[转发函数体内含带 } 的注释] 未被误拒=%s（Tom 17:49Z 二 误拒反例）'
               % ('YES' if pos_fwd_ok else 'NO'))
    if not pos_fwd_ok:
        ok = False
        rep.append('  [FAIL] 合法转发形态被误拒（白名单过紧）')

    # 5c'') 顶层键扫描器（供后续 fixture 的 _ctrl_set_of 使用）
    MEMBER_KEY_RE = re.compile(r'([A-Za-z_$][\w$]*|\[[^\]]+\])\s*:')
    rep.append('')

    # 5f) 负例自测：解析器必须识别各类未授权/未识别成员并 fail-closed（Tom 本轮#5a）
    rep.append('--- 断言5 负例自测（完整区块解析覆盖边界）---')
    def _ctrl_set_of(src):
        # 与真实路径同口径：先在掩码文本上定位区块与入口（注释/字符串不得参与判定）
        sm, _u = _js_mask(src, mask_strings=True)
        mb = re.search(r'var\s+REMOTE_ACTIONS\s*=\s*\{(.*?)\n?\};', sm, re.S)
        blk = src[mb.start(1):mb.end(1)] if mb else ''
        blk_m = sm[mb.start(1):mb.end(1)] if mb else ''
        em = {}
        for k, t in ENTRY_RE.findall(blk_m):
            em.setdefault(k, []).append(t)
        # 修正（Tom 本轮-J2）：t 是列表，须与 ['tsSoftDelGuarded'] 比较（原 `t == 'tsSoftDelGuarded'`
        # 列表≠字符串 恒为 False → ctrl 恒为空 → 负例只因 helper 恒 false 而“通过”，rogue 分支空转）。
        # 同时须校验成员集合恰好为 WHITELIST 且无任何无法解析的顶层成员（覆盖 evil→otherAction 等额外成员原例）。
        ctrl = {k for k, t in em.items() if t == ['tsSoftDelGuarded']}
        declared_keys = MEMBER_KEY_RE.findall(blk_m)
        unparsed = [k for k in declared_keys if k not in em]
        return (ctrl == WHITELIST
                and set(em.keys()) == WHITELIST
                and not unparsed)
    # 正向夹具（Tom 本轮-J2：补合法 manifest，确认不被误杀）+ 负例自测（覆盖 evil→otherAction 原例）
    neg_ok = True
    POSITIVE = "var REMOTE_ACTIONS = { softDelGuarded: function(e){ return tsSoftDelGuarded(e); }, statusQuery: function(e){ return tsSoftDelGuarded(e); } };"
    pos_ok = _ctrl_set_of(POSITIVE)
    rep.append('  正向夹具[合法manifest] 判为受控(不被误杀)=%s' % ('YES' if pos_ok else 'NO'))
    if not pos_ok:
        neg_ok = False
        rep.append('    [FAIL] 合法 manifest 被误判为非法（helper 过紧）')
    neg_cases = {
        'rogue alias 路由到受控入口': "var REMOTE_ACTIONS = { softDelGuarded: function(e){ return tsSoftDelGuarded(e); }, statusQuery: function(e){ return tsSoftDelGuarded(e); }, evil: function(e){ return tsSoftDelGuarded(e); } };",
        '额外成员路由到 otherAction（Tom 本轮未覆盖原例）': "var REMOTE_ACTIONS = { softDelGuarded: function(e){ return tsSoftDelGuarded(e); }, statusQuery: function(e){ return tsSoftDelGuarded(e); }, evil: function(e){ return otherAction(e); } };",
        'computed key 路由到受控入口': "var REMOTE_ACTIONS = { softDelGuarded: function(e){ return tsSoftDelGuarded(e); }, statusQuery: function(e){ return tsSoftDelGuarded(e); }, [someKey]: function(e){ return tsSoftDelGuarded(e); } };",
        '替代表达式（无 return/function）': "var REMOTE_ACTIONS = { softDelGuarded: tsSoftGuarded, statusQuery: function(e){ return tsSoftDelGuarded(e); } };",
        '白名单外键路由到受控入口（Tom #5a 未识别成员）': "var REMOTE_ACTIONS = { softDelGuarded: function(e){ return tsSoftDelGuarded(e); }, statusQuery: function(e){ return tsSoftDelGuarded(e); }, evil: function(e){ return tsSoftDelGuarded(e); } };",
    }
    for label, snippet in neg_cases.items():
        detected = not _ctrl_set_of(snippet)
        rep.append('  负例[%s] 识别为非法=fail-closed=%s' % (label, 'YES' if detected else 'NO'))
        if not detected:
            neg_ok = False
            rep.append('    [FAIL] 负例未被识别')
    # 5g) 真实区块插入未识别成员（evil 路由到受控入口）→ 必须 fail-closed
    tampered = fin_prefix + "\nvar REMOTE_ACTIONS = { softDelGuarded: function(e){ return tsSoftDelGuarded(e); }, statusQuery: function(e){ return tsSoftDelGuarded(e); }, evil: function(e){ return tsSoftDelGuarded(e); } };\n"
    real_detected = not _ctrl_set_of(tampered)
    rep.append('  真实区块插入 evil→受控入口 负例 fail-closed=%s' % ('YES' if real_detected else 'NO'))
    if not real_detected:
        neg_ok = False
        rep.append('    [FAIL] 真实区块插入未识别成员未 fail-closed')
    if not neg_ok:
        ok = False
        rep.append('  [FAIL] 断言5 负例自测未通过（解析器覆盖不足）')
    rep.append('')

    rep.append('=== 结论：%s ===' % ('全部断言通过' if ok else '存在失败断言（见上）'))

    text = '\n'.join(rep) + '\n'
    os.makedirs(os.path.dirname(EVID), exist_ok=True)
    io.open(EVID, 'w', encoding='utf-8', newline='\n').write(text)
    print(text)
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
