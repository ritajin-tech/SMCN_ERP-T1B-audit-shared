# -*- coding: utf-8 -*-
"""
GAS 单源可复现校验器（回应 Tom #1「源码/生成物/输出错配」+ ce058ba 一.3 dispatch manifest）

断言五件事，任一件不成立即以非 0 退出：
  1) 【逐字内联】三个规范源文件（core / norm / period_lock）去掉 'use strict' 与
     module.exports 包装后的正文，必须是生成物 ts_softdel_gas_embedded.js 的【连续子串】。
     —— 这条直接证伪/证实"GAS 副本是另一份手抄逻辑"的怀疑。
  2) 【生成可复现】连跑两次生成器，产出文件（embedded + FINAL_FILE）SHA-256 必须完全相同。
  3) 【版本自洽】生成物里的 VERSION 常量必须与规范源 ts_softdel_core.js 的 VERSION 相同。
  4) 【FINAL_FILE 内联核心区逐字一致】FINAL_FILE 内联核心区必须与 embedded 内联核心区逐字一致，
     杜绝 FINAL_FILE（实际部署入口）二次漂移。
  5) 【dispatch/entrypoint manifest】FINAL_FILE 前缀 dispatch 映射中，softDelGuarded 与 statusQuery
     必须各唯一存在且统一路由到 tsSoftDelGuarded，不得有其它键路由到该受控入口（防前缀漂移假通过）。

输出逐件源码的 SHA-256 与 git blob 哈希，供固定提交比对；结论写入证据文件。
"""
import hashlib
import io
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


def sha256_file(p):
    with open(p, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


def git_blob(p):
    try:
        out = subprocess.run(['git', 'hash-object', p], capture_output=True, text=True, cwd=HERE)
        return out.stdout.strip() or '(n/a)'
    except Exception:
        return '(n/a)'


def load_generator():
    """直接加载生成器模块，复用它的【同一套】去壳函数 —— 校验器不再另写一份变换逻辑。"""
    import importlib.util
    spec = importlib.util.spec_from_file_location('gen_gas_softdel', GEN)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    rep = []
    ok = True

    emb_src = io.open(EMB, encoding='utf-8').read()

    rep.append('=== GAS 单源可复现校验（回应 Tom #1）===')
    rep.append('生成物：%s  SHA-256=%s' % (os.path.relpath(EMB, HERE), sha256_file(EMB)))
    rep.append('')

    # 1) 逐字内联
    rep.append('--- 断言1：规范源正文必须是生成物的连续子串（逐字内联）---')
    gg = load_generator()
    for name, path in SOURCES:
        src = io.open(path, encoding='utf-8').read()
        if name == 'ts_softdel_core.js':
            # 核心：生成器用 strip_core_export(strip_core_requires(src)) 后直接内联
            body = gg.strip_core_export(gg.strip_core_requires(src)).rstrip()
        else:
            # norm / period_lock：包成 IIFE，正文 = strip_leading_strict(strip_module_export(src))
            body = gg.strip_leading_strict(gg.strip_module_export(src)).rstrip()
        # 生成物里是缩进过的？逐字内联不做缩进变换，直接用 strip 后的正文比对
        found = body in emb_src
        rep.append('  %-20s 正文长度=%6d  连续子串命中=%s  SHA-256=%s  git-blob=%s'
                   % (name, len(body), 'YES' if found else 'NO', sha256_file(path)[:16] + '…', git_blob(path)[:12]))
        if not found:
            ok = False
            # 给出首个不匹配的片段，便于定位
            for k in range(0, min(len(body), 4000), 200):
                if body[k:k + 200] not in emb_src:
                    rep.append('    首个未命中片段 @%d: %r' % (k, body[k:k + 200]))
                    break
    rep.append('')

    # 2) 生成可复现
    rep.append('--- 断言2：连跑两次生成器，产出 SHA-256 必须相同 ---')
    before = sha256_file(EMB)
    before_f = sha256_file(FINAL)
    r1 = subprocess.run([sys.executable, GEN], capture_output=True, text=True, cwd=HERE)
    mid = sha256_file(EMB)
    mid_f = sha256_file(FINAL)
    r2 = subprocess.run([sys.executable, GEN], capture_output=True, text=True, cwd=HERE)
    after = sha256_file(EMB)
    after_f = sha256_file(FINAL)
    stable = (before == mid == after)
    stable_f = (before_f == mid_f == after_f)
    rep.append('  生成器退出码：%s / %s' % (r1.returncode, r2.returncode))
    rep.append('  [embedded] 第0次(现有)=%s' % before)
    rep.append('  [embedded] 第1次       =%s' % mid)
    rep.append('  [embedded] 第2次       =%s' % after)
    rep.append('  [embedded] 三次一致=%s' % ('YES' if stable else 'NO'))
    rep.append('  [FINAL_FILE] 第0次(现有)=%s' % before_f)
    rep.append('  [FINAL_FILE] 第1次       =%s' % mid_f)
    rep.append('  [FINAL_FILE] 第2次       =%s' % after_f)
    rep.append('  [FINAL_FILE] 三次一致=%s' % ('YES' if stable_f else 'NO'))
    if not stable or not stable_f or r1.returncode != 0 or r2.returncode != 0:
        ok = False
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

    # 5) FINAL_FILE 前缀 dispatch/entrypoint manifest 断言（Tom ce058ba 一.3：杜绝前缀漂移假通过）
    rep.append('--- 断言5：FINAL_FILE 前缀 dispatch manifest —— softDelGuarded/statusQuery 必须唯一存在且统一路由到 tsSoftDelGuarded ---')
    fin_src5 = io.open(FINAL, encoding='utf-8').read()
    fin_prefix = fin_src5[:fin_src5.find(ANCHOR)] if ANCHOR in fin_src5 else fin_src5
    entries = re.findall(r'^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*function\s*\([^)]*\)\s*\{\s*return\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(', fin_prefix, re.M)
    entry_map = {}
    for k, t in entries:
        entry_map.setdefault(k, []).append(t)
    req = ['softDelGuarded', 'statusQuery']
    manifest_ok = True
    for key in req:
        cnt = len(entry_map.get(key, []))
        routes = set(entry_map.get(key, []))
        rep.append('  %s 出现次数=%d 路由目标=%s' % (key, cnt, sorted(routes)))
        if cnt != 1 or routes != {'tsSoftDelGuarded'}:
            manifest_ok = False
            rep.append('    [FAIL] %s 必须唯一且唯一路由到 tsSoftDelGuarded' % key)
    # 反向：除这两个键外，不得有其它键路由到 tsSoftDelGuarded（防前缀漂移出第二入口）
    rogue = [k for k, ts in entry_map.items() if 'tsSoftDelGuarded' in ts and k not in req]
    if rogue:
        manifest_ok = False
        rep.append('  [FAIL] 以下键非法路由到 tsSoftDelGuarded（应仅 softDelGuarded/statusQuery）：%s' % rogue)
    rep.append('  manifest 一致=%s' % ('YES' if manifest_ok else 'NO'))
    if not manifest_ok:
        ok = False
    rep.append('')

    rep.append('=== 结论：%s ===' % ('全部断言通过' if ok else '存在失败断言（见上）'))

    text = '\n'.join(rep) + '\n'
    os.makedirs(os.path.dirname(EVID), exist_ok=True)
    io.open(EVID, 'w', encoding='utf-8', newline='\n').write(text)
    print(text)
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
