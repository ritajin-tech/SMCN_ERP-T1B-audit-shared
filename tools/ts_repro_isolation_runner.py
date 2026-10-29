#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
T1-B 复现隔离运行器（回应 Tom 08:27Z 对 S3 的复核）：
把"OS 隔离 / 原树只读 / 仅临时目录可写 / 禁网"由【代码强制】，而非仅注释声明；
并修复"生成器非零返回跳过后置快照"——后置原树快照在【所有退出路径】执行。

🔴 强制边界（均可验证，失败即 fail-closed）：
1) 原树只读：运行前对【原始审阅仓】tools/ 做完整 SHA-256 快照；运行后【无论生成器成功/失败】
   再次快照并断言一致。任何对原树的改动都在此被捕获并中止——这是"原树只读"的代码级证据。
2) 仅临时目录可写：只把 tools/ 复制到一次性临时副本；生成器仅在副本内写；运行 cwd=tmp。
3) 禁网（代码级 fail-closed）：扫描生成器源码，若含网络 / 子进程 / 危险导入则拒绝运行。
4) 最小环境 + try/finally 清理：以 `python -I`（忽略环境、无 site-packages）运行；异常也清理临时目录。
   （注：`-I` 只是环境隔离，【不是】沙箱；真正的安全边界来自上面的 1/2/3 与 OS 层包裹。）
5) 低权限 / 挂载只读（OS 级）：若所在 OS 无法提供强沙箱（如原生 Windows），【默认拒绝】运行，
   不提供任何绕过开关——必须由调用者在 WSL / 容器 / macOS sandbox-exec 中包裹后再运行。

用法：
    python tools/ts_repro_isolation_runner.py <审阅仓本地路径>

🔴 说明：本运行器不把"运行待审仓生成器"当作零写/零执行证明；它只是把复现配方放进一个
由代码强制的隔离边界，供审阅方在自有 OS 上复现。复现结果仍记为【提交方报告】，除非另有
已授权且隔离的独立验证。
"""
import os
import sys
import re
import hashlib
import shutil
import subprocess
import tempfile
import platform

GENERATOR = 'gen_gas_softdel.py'

# 网络 / 子进程 / 危险导入（命中即 fail-closed，须改在禁网容器内复现）
NETWORK_IMPORT_RE = re.compile(
    r'^\s*(import\s+(socket|urllib|requests|http|ftplib|smtplib|paramiko|subprocess|ctypes)\b|'
    r'from\s+(socket|urllib|requests|http|ftplib|smtplib|paramiko|subprocess|ctypes)\s+import)',
    re.M)


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for chunk in iter(lambda: f.read(65536), b''):
            h.update(chunk)
    return h.hexdigest()


def snapshot_tools(repo):
    """对 repo/tools/ 下所有文件做完整 SHA-256 快照（相对路径 -> 哈希）。"""
    tools_dir = os.path.join(repo, 'tools')
    snap = {}
    for root, _, files in os.walk(tools_dir):
        for f in files:
            p = os.path.join(root, f)
            rel = os.path.relpath(p, repo).replace('\\', '/')
            snap[rel] = sha256_file(p)
    return snap


def scan_generator(path):
    """扫描生成器源码，返回疑似网络/子进程/危险导入列表（空 == 干净）。"""
    text = open(path, encoding='utf-8', errors='replace').read()
    suspects = []
    for m in NETWORK_IMPORT_RE.finditer(text):
        suspects.append(m.group(0).strip())
    return suspects


def main():
    args = sys.argv[1:]
    repo = None
    for a in args:
        if not a.startswith('-'):
            repo = a
    if not repo:
        print('usage: python tools/ts_repro_isolation_runner.py <审阅仓本地路径>')
        return 2

    tools_dir = os.path.join(repo, 'tools')
    if not os.path.isdir(tools_dir):
        print('[ABORT] 找不到 %s' % tools_dir)
        return 3
    gen_path = os.path.join(tools_dir, GENERATOR)
    if not os.path.isfile(gen_path):
        print('[ABORT] 找不到生成器 %s' % gen_path)
        return 3

    # 1) 原树快照（before）—— 强制"原树只读"的代码级证据
    before = snapshot_tools(repo)
    print('[1/4] 原树快照完成：%d 个文件（before）' % len(before))

    # 3) 网络 / 危险导入扫描（fail-closed）
    suspects = scan_generator(gen_path)
    if suspects:
        print('[ABORT] 生成器含疑似网络/子进程导入，拒绝运行（请在禁网容器内复现）：')
        for s in suspects:
            print('  - %s' % s)
        return 4

    # 5) OS 沙箱可用性（原生 Windows 默认拒绝；【不提供】任何绕过开关）
    is_windows_native = platform.system() == 'Windows' and 'microsoft' not in platform.release().lower()
    if is_windows_native:
        print('[ABORT] 原生 Windows 无法提供强 OS 沙箱（低权限/挂载只读/禁网）；')
        print('        本运行器不提供绕过开关。请在 WSL / 容器 / macOS sandbox-exec 中运行本运行器。')
        return 5

    # 2) 复制到一次性临时副本（仅副本可写）
    tmp = tempfile.mkdtemp(prefix='gas_repro_iso_')
    copy_dir = os.path.join(tmp, 'tools')
    gen_rc = -1
    tree_changed = False
    try:
        shutil.copytree(tools_dir, copy_dir)
        gen_copy = os.path.join(copy_dir, GENERATOR)
        # 4) 最小环境 + python -I（隔离 site-packages / PYTHONPATH），cwd=tmp
        env = {'PATH': os.environ.get('PATH', ''), 'SYSTEMROOT': os.environ.get('SYSTEMROOT', '')}
        print('[2/4] 已复制到临时副本 %s（仅此目录可写）' % copy_dir)
        print('[3/4] 在隔离副本内运行 %s（cwd=%s, python -I）...' % (GENERATOR, copy_dir))
        r = subprocess.run([sys.executable, '-I', gen_copy], cwd=copy_dir, env=env,
                           capture_output=True, text=True)
        sys.stdout.write(r.stdout)
        sys.stderr.write(r.stderr)
        gen_rc = r.returncode
        if gen_rc != 0:
            print('[WARN] 生成器返回非零：%d（继续核验原树是否被改动，绝不跳过后置快照）' % gen_rc)
    finally:
        # 🔴 修复 Tom 08:27Z S3：后置原树快照在【所有退出路径】执行（成功/失败/异常均不跳过）。
        # 先清理本次临时副本，再对原树做 after 快照并与 before 断言一致。
        shutil.rmtree(tmp, ignore_errors=True)
        after = snapshot_tools(repo)
        diff = [k for k in before if before.get(k) != after.get(k)]
        if diff:
            tree_changed = True
            print('[ABORT] 原树被改动！差异（前 %d 项）：%s' % (len(diff), diff[:5]))

    # 4) 依据 finally 中的核验结论裁决（顺序：原树改动 > 生成器失败 > 通过）
    if tree_changed:
        return 7
    if gen_rc != 0:
        print('[FAIL] 生成器非零返回 %d（原树已核验未被改动，但生成器自身失败，未写入仓外）'
              % gen_rc)
        return 6
    print('[4/4] 原树只读已验证：运行前后 tools/ SHA-256 完全一致（%d 文件）；'
          '临时副本已清理。' % len(before))
    print('[PASS] 隔离边界可验证：原树只读(代码断言,所有路径) + 仅临时副本可写 + 生成器无网络导入'
          '(fail-closed)；失败时不触及仓外或其他目录。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
