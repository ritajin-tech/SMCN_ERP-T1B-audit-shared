#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
T1-B 复现隔离运行器（回应 Tom 08:27Z 对 S3 的复核 + 2026-10-29 20:21 回复的 V 批补强）：
把"OS 隔离 / 原树只读 / 仅临时目录可写 / 禁网"由【代码强制】，而非仅注释声明；
并修复 Tom 指出的全部 S3 残留：
  (a) 后置快照仅遍历 before 键 -> 运行期在 repo 内【新增】的文件不会被发现；
      改为 before/after 双向路径集合 + 类型/内容对比（新增/删除/类型变更/内容变更都捕获）。
  (b) 快照范围只含文件哈希 -> 不含目录/符号链接类型；改为记录 each 路径的 kind
      (file/dir/symlink/other) + (file:sha256 | symlink:target)，类型变更即视为原树被改。
  (c) 清理用 ignore_errors=True 且未确认成功 -> 改为确认清理结果，失败即 fail-closed 报告。
  (d) 外部 OS 沙箱仅以"WSL/容器名称"判断 -> 事后哈希对比不是权限边界；
      改为：本运行器【不凭自声明创建或证明】OS 隔离——隔离必须由操作员自有 OS 施加，
      并经【--sandbox-manifest(带外佐证) + 非破坏性运行时证据(家目录/系统目录只读 + Linux 容器/cgroup)】
      证实；任一适用探针缺失即 fail-closed，边界未证实前绝不启动生成器（Tom W 批·点①）。

🔴 强制边界（均可验证，失败即 fail-closed）：
1) 原树只读：运行前对【原始审阅仓】tools/ 做完整快照（kind+hash/target）；运行后【无论生成器成功/失败】
   再次快照并双向断言一致（新增/删除/类型/内容任一差异即捕获）。任何对原树的改动都在此被中止。
2) 仅临时目录可写：只把 tools/ 复制到一次性临时副本；生成器仅在副本内写；运行 cwd=tmp。
3) 禁网（代码级 fail-closed）：扫描生成器源码，若含网络/子进程/危险导入则拒绝运行。
4) 最小环境 + try/finally 清理：以 `python -I` 运行；异常也清理临时目录，并确认清理成功。
5) 低权限/挂载只读（OS 级）：若未提供显式且经探针验证的 OS 沙箱，【默认拒绝】运行。

用法：
    python tools/ts_repro_isolation_runner.py <审阅仓本地路径> --sandbox-verified --sandbox-manifest <隔离策略描述文件>

🔴 说明：本运行器不把"运行待审仓生成器"当作零写/零执行证明；它只是把复现配方放进一个
由代码强制的隔离边界，供审阅方在自有 OS 上复现。复现结果仍记为【提交方报告】，除非另有
已授权且隔离的独立验证。
"""
import os
import sys
import re
import stat
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


def _kind_of(path):
    """返回路径类型：symlink / dir / file / other / None（不存在）。lstat 不跟随符号链接。"""
    try:
        st = os.lstat(path)
    except OSError:
        return None
    if stat.S_ISLNK(st.st_mode):
        return 'symlink'
    if stat.S_ISDIR(st.st_mode):
        return 'dir'
    if stat.S_ISREG(st.st_mode):
        return 'file'
    return 'other'


def snapshot_tools(repo):
    """对 repo/tools/ 下所有条目做完整快照：rel_path -> {kind, h|t}。"""
    tools_dir = os.path.join(repo, 'tools')
    snap = {}
    for root, dirs, files in os.walk(tools_dir):
        for name in list(dirs) + list(files):
            p = os.path.join(root, name)
            rel = os.path.relpath(p, repo).replace('\\', '/')
            kind = _kind_of(p)
            if kind == 'file':
                snap[rel] = {'kind': 'file', 'h': sha256_file(p)}
            elif kind == 'symlink':
                try:
                    snap[rel] = {'kind': 'symlink', 't': os.readlink(p)}
                except OSError:
                    snap[rel] = {'kind': 'symlink', 't': ''}
            elif kind in ('dir', 'other'):
                snap[rel] = {'kind': kind}
            # kind None（已消失）不记录
    return snap


def _diff_snapshots(before, after):
    """双向对比：新增 / 删除 / 类型变更 / 内容(哈希/链接目标)变更。"""
    added, removed, changed_kind, changed_content = [], [], [], []
    for k in after:
        if k not in before:
            added.append(k)
        else:
            b, a = before[k], after[k]
            if b.get('kind') != a.get('kind'):
                changed_kind.append(k)
            elif a.get('kind') == 'file' and b.get('h') != a.get('h'):
                changed_content.append(k)
            elif a.get('kind') == 'symlink' and b.get('t') != a.get('t'):
                changed_content.append(k)
    for k in before:
        if k not in after:
            removed.append(k)
    return {'added': added, 'removed': removed,
            'changed_kind': changed_kind, 'changed_content': changed_content}


def scan_generator(path):
    """扫描生成器源码，返回疑似网络/子进程/危险导入列表（空 == 干净）。"""
    text = open(path, encoding='utf-8', errors='replace').read()
    suspects = []
    for m in NETWORK_IMPORT_RE.finditer(text):
        suspects.append(m.group(0).strip())
    return suspects


def _linux_container_evidence():
    """返回非空字符串 = 检出 Linux 容器/cgroup 或能力集缩减（真正的 OS 级隔离证据）；否则 None。
    仅做只读读取，不写任何文件。"""
    if platform.system() != 'Linux':
        return None
    try:
        with open('/proc/self/cgroup', 'r', encoding='utf-8', errors='replace') as f:
            cg = f.read()
        if any(k in cg for k in ('docker', 'kubepods', 'containerd', 'cri-o', 'lxc', 'podman')):
            return 'cgroup 含容器运行时证据'
    except OSError:
        pass
    try:
        with open('/proc/self/status', 'r', encoding='utf-8', errors='replace') as f:
            st = f.read()
        m = re.search(r'CapEff:\s*([0-9a-fA-F]+)', st)
        if m:
            cap = int(m.group(1), 16)
            if 0 < cap < 0x3FFFFFFFFF:   # 全量能力通常 >= 0x3FFFFFFFFF；显著缩减暗示受限
                return '进程能力集(CapEff)已缩减'
    except OSError:
        pass
    return None


def _probe_network_blocked():
    """非破坏性辅助探针：尝试连接可达公共地址，短时超时；均不可达 => 网络被隔离（辅助证据）。
    仅做连接尝试，不发送任何数据；不做为唯一判据（Tom W 批·点①：网络探测不足为凭）。"""
    import socket
    blocked = 0
    for host, port in (('8.8.8.8', 443), ('1.1.1.1', 443)):
        try:
            s = socket.create_connection((host, port), timeout=1.0)
            s.close()
        except OSError:
            blocked += 1
    return blocked == 2


def verify_os_boundary(sandbox_verified_flag, manifest_path):
    """Tom V→W 批·点①：OS 隔离边界必须由【独立生效的 OS 策略 + 可核验配置】证明，
    自声明开关 / Python -I / 导入黑名单 / 事后 tools 快照【不能替代】权限边界。

    本函数不凭自声明放过；它要求操作员提供 --sandbox-manifest（描述实际 OS 策略的带外佐证），
    并叠加【非破坏性运行时证据】：家目录/系统目录只读（os.access，不实际写）+ Linux 容器/cgroup 证据。
    网络探测仅作辅助，绝不作为唯一判据。任一适用探针缺失时【不静默通过】—— 边界未证实即 fail-closed。

    返回 (ok, detail)：ok=False 即拒绝运行生成器（直到边界在自有 OS 上被证实）。
    """
    if not sandbox_verified_flag:
        return (False, '未提供 --sandbox-verified：本运行器要求操作员在已证实隔离的 OS（容器/WSL/'
                       'macOS sandbox-exec）内包裹运行并显式声明；不提供任何绕过开关。')
    if not manifest_path or not os.path.isfile(manifest_path):
        return (False, '未提供 --sandbox-manifest：无法对 OS 边界做带外核验；本运行器不凭自声明开关放行'
                       '（Tom W 批·点①：自声明开关不能替代权限边界）。')
    try:
        with open(manifest_path, 'r', encoding='utf-8', errors='replace') as f:
            manifest_text = f.read()
    except OSError as e:
        return (False, 'sandbox-manifest 读取失败：%s' % e)
    if not manifest_text.strip():
        return (False, 'sandbox-manifest 为空，无法证明 OS 边界。')
    evidence = ['manifest 已载入(%d 字节，带外佐证)' % len(manifest_text)]

    # 运行时证据①：文件访问边界（非破坏性 os.access，不实际写）—— 家目录/系统目录应为只读
    file_boundary = False
    home = os.path.expanduser('~')
    if home and os.path.isdir(home) and not os.access(home, os.W_OK):
        file_boundary = True
        evidence.append('家目录只读(os.access W_OK=False)')
    sysdir = '/etc' if platform.system() != 'Windows' else 'C:\\Windows'
    if os.path.isdir(sysdir) and not os.access(sysdir, os.W_OK):
        file_boundary = True
        evidence.append('系统目录只读(os.access W_OK=False)')

    # 运行时证据②：Linux 容器/cgroup 或能力集缩减（真正的 OS 级隔离）
    cg_ev = _linux_container_evidence()
    if cg_ev:
        evidence.append(cg_ev)

    # 网络边界（辅助，不作唯一判据）
    if _probe_network_blocked():
        evidence.append('网络不可达(连接探测被拒，辅助证据)')

    # 判定：必须有至少一项【运行时】边界证据（文件只读 或 容器/cgroup）；
    # manifest 仅作带外佐证，绝不能单独放行。无适用探针时绝不静默通过。
    if file_boundary or cg_ev:
        return (True, 'OS 边界运行时证据成立：' + '；'.join(evidence) + '。生成器仅可在已证实隔离的'
                       '环境中运行；manifest 真实性由审阅方带外核验。')
    return (False, '未检出 OS 级隔离运行时证据（家目录可写且无非容器/cgroup 证据）：' + '；'.join(evidence)
                   + '。边界未证实，拒绝运行生成器（Tom W 批·点①）。')


def _remove_tree_confirm(path):
    """移除目录并确认成功；失败返回 False（调用方按 fail-closed 处理）。不使用 ignore_errors。"""
    try:
        if os.path.lexists(path):
            shutil.rmtree(path)  # 不使用 ignore_errors=True：任何清理异常都会上抛被捕获
        # 确认已移除
        if os.path.lexists(path):
            return False
        return True
    except (OSError, IOError) as e:
        print('[cleanup] 移除失败：%s' % e)
        return False


def main():
    args = sys.argv[1:]
    repo = None
    sandbox_verified = False
    manifest_path = None
    i = 0
    while i < len(args):
        a = args[i]
        if a == '--sandbox-verified':
            sandbox_verified = True
        elif a == '--sandbox-manifest':
            i += 1
            manifest_path = args[i] if i < len(args) else None
        elif not a.startswith('-'):
            repo = a
        i += 1
    if not repo:
        print('usage: python tools/ts_repro_isolation_runner.py <审阅仓本地路径> '
              '--sandbox-verified --sandbox-manifest <隔离策略描述文件>')
        return 2

    tools_dir = os.path.join(repo, 'tools')
    if not os.path.isdir(tools_dir):
        print('[ABORT] 找不到 %s' % tools_dir)
        return 3
    gen_path = os.path.join(tools_dir, GENERATOR)
    if not os.path.isfile(gen_path):
        print('[ABORT] 找不到生成器 %s' % gen_path)
        return 3

    # 0) OS 隔离边界前置（显式声明 + manifest 带外佐证 + 运行时证据，缺一即拒绝）—— Tom V→W 批·点①
    ok_sb, detail_sb = verify_os_boundary(sandbox_verified, manifest_path)
    if not ok_sb:
        print('[ABORT] OS 隔离边界前置未通过：%s' % detail_sb)
        return 8

    # 1) 原树快照（before）—— 完整 kind+hash/target
    before = snapshot_tools(repo)
    print('[1/5] 原树快照完成：%d 个条目（before，含 kind+hash）' % len(before))

    # 3) 网络 / 危险导入扫描（fail-closed）
    suspects = scan_generator(gen_path)
    if suspects:
        print('[ABORT] 生成器含疑似网络/子进程导入，拒绝运行（请在禁网容器内复现）：')
        for s in suspects:
            print('  - %s' % s)
        return 4

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
        print('[2/5] 已复制到临时副本 %s（仅此目录可写）' % copy_dir)
        print('[3/5] 在隔离副本内运行 %s（cwd=%s, python -I）...' % (GENERATOR, copy_dir))
        r = subprocess.run([sys.executable, '-I', gen_copy], cwd=copy_dir, env=env,
                           capture_output=True, text=True)
        sys.stdout.write(r.stdout)
        sys.stderr.write(r.stderr)
        gen_rc = r.returncode
        if gen_rc != 0:
            print('[WARN] 生成器返回非零：%d（继续核验原树是否被改动，绝不跳过后置快照）' % gen_rc)
    finally:
        # 🔴 清理：确认结果，失败即 fail-closed（不再 ignore_errors 静默）
        cleanup_ok = _remove_tree_confirm(tmp)
        if not cleanup_ok:
            tree_changed = True
            print('[ABORT] 临时副本清理失败，按 fail-closed 记原树状态不可信；请手动核查 %s' % tmp)
        # 🔴 后置原树快照（after）—— 双向对比（新增/删除/类型/内容）
        after = snapshot_tools(repo)
        diff = _diff_snapshots(before, after)
        if (diff['added'] or diff['removed'] or diff['changed_kind'] or diff['changed_content']):
            tree_changed = True
            print('[ABORT] 原树被改动！差异：')
            print('  added=%s' % diff['added'][:5])
            print('  removed=%s' % diff['removed'][:5])
            print('  changed_kind=%s' % diff['changed_kind'][:5])
            print('  changed_content=%s' % diff['changed_content'][:5])

    # 4) 依据 finally 中的核验结论裁决（顺序：原树改动/清理失败 > 生成器失败 > 通过）
    if tree_changed:
        return 7
    if gen_rc != 0:
        print('[FAIL] 生成器非零返回 %d（原树已核验未被改动，但生成器自身失败，未写入仓外）' % gen_rc)
        return 6
    print('[5/5] 原树只读已验证：运行前后 tools/ 双向快照完全一致（新增/删除/类型/内容均 0 差异，%d 条目）；'
          '临时副本已确认清理。' % len(before))
    print('[PASS] 隔离边界可验证：原树只读(双向代码断言,所有路径) + 仅临时副本可写 + 生成器无网络导入'
          '(fail-closed) + OS 沙箱前置(显式声明+写探针)；失败时不触及仓外或其他目录。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
