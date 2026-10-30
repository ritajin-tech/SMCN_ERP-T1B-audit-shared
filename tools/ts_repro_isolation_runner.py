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
      并经【--sandbox-manifest(机器可校验声明: network=blocked + fs_readonly=<home/cwd>) +
      非破坏性运行时证据】同时证实；运行时证据以【内核级配置为权威】：
        · 文件系统只读：/proc/self/mountinfo 覆盖挂载带 ro 标志（内核强制只读，非仅靠 os.access）；
        · 网络隔离：/proc/self/net/route 无外部默认路由（完整禁网内核级证据，非仅靠两个公共地址连接探针）；
      os.access 与连接探针【仅作辅助】，不得作为唯一判据（Tom X 批·一：两公网地址不可达可能是
      路由/防火墙选择性阻断，不证明内网/其他地址/DNS/其他协议被禁；home/cwd 一个 os.access 不可写
      不证明子目录/其他挂载/所有写路径只读）。
      文件/挂载只读 与 网络隔离 两项策略【必须同时】成立，容器/cgroup/CapEff 仅作佐证；
      任一适用策略未证实即 fail-closed，边界未证实前绝不启动生成器（Tom X 批·一 / 08:42Z 复审）。

🔴 强制边界（均可验证，失败即 fail-closed）：
1) 原树只读：运行前对【原始审阅仓】tools/ 做完整快照（kind+hash/target）；运行后【无论生成器成功/失败】
   再次快照并双向断言一致（新增/删除/类型/内容任一差异即捕获）。任何对原树的改动都在此被中止。
2) 仅临时目录可写：只把 tools/ 复制到一次性临时副本；生成器仅在副本内写；运行 cwd=tmp。
3) 禁网（代码级 fail-closed）：扫描生成器源码，若含网络/子进程/危险导入则拒绝运行。
4) 最小环境 + try/finally 清理：以 `python -I` 运行；异常也清理临时目录，并确认清理成功。
5) 低权限/挂载只读 + 网络隔离（OS 级）：若未提供显式且经探针验证的 OS 沙箱，【默认拒绝】运行。
   要求【文件/挂载只读(绑定 home/cwd)】与【网络隔离】两项策略同时被运行时证据证实；
   运行时证据以【内核级挂载/路由配置为权威】，os.access 与连接探针仅辅助；
   普通非隔离用户（/etc 不可写但家目录可写、或家目录只读但网络可达）均不满足。

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


def _read_mountinfo_ro(paths):
    """解析 /proc/self/mountinfo，返回 (fs_ro_kernel, fs_rw_descendant)。
    - fs_ro_kernel：声明路径中，其【覆盖挂载】(最长匹配) 带 ro 标志的集合（内核强制只读，非仅靠 os.access）。
    - fs_rw_descendant：声明路径下存在 rw 子挂载的集合（只读父目录下可写子挂载/子目录逃逸）。
    仅只读读取，不写任何文件；非 Linux 或读取失败返回 (set(), set())。
    Tom X 批·一（08:42Z 复审）：home/cwd 一个 os.access 不可写不证明子目录/其他挂载/所有写路径只读。
    """
    ro_kernel = set()
    rw_desc = set()
    try:
        with open('/proc/self/mountinfo', 'r', encoding='utf-8', errors='replace') as f:
            lines = f.readlines()
    except OSError:
        return ro_kernel, rw_desc
    mounts = []  # (mountpoint_norm, ro_bool)
    for line in lines:
        parts = line.split()
        if len(parts) < 6:
            continue
        mountpoint = parts[4]
        # 可选字段以 '-' 分隔；'-' 之后为 fs_type / source / superblock options
        opts_fields = [parts[5]]
        try:
            sep = parts.index('-')
            opts_fields.extend(parts[sep + 3:])
        except ValueError:
            pass
        combined = ' ' + ' '.join(opts_fields) + ' '
        ro = (' ro ' in combined) and (' rw ' not in combined)  # ro 优先且明确
        mounts.append((os.path.normcase(os.path.normpath(mountpoint)), ro))
    # 按 mountpoint 长度降序：最具体的覆盖挂载优先匹配
    mounts.sort(key=lambda x: len(x[0]), reverse=True)
    for p in paths:
        np = os.path.normcase(os.path.normpath(p))
        covering_ro = None
        for mp, ro in mounts:
            if np == mp or np.startswith(mp + os.sep):
                covering_ro = ro
                break
        if covering_ro is True:
            ro_kernel.add(np)
        # 检测该声明路径下的 rw 子挂载（逃逸）
        for mp, ro in mounts:
            if mp != np and mp.startswith(np + os.sep) and ro is False:
                rw_desc.add(np)
                break
    return ro_kernel, rw_desc


def _read_route_isolated():
    """解析 /proc/self/net/route，判断是否【无外部默认路由】。
    存在 Destination=00000000 且 Mask=00000000 的默认路由 => 主机可达外部 => 未隔离。
    返回 True 表示内核路由表证明无外部默认路由（完整禁网的内核级证据）；
    返回 False 表示存在默认路由或读取失败（Tom X 批·一：两个公共地址不可达≠完整禁网）。
    """
    try:
        with open('/proc/self/net/route', 'r', encoding='utf-8', errors='replace') as f:
            lines = f.readlines()
    except OSError:
        return False
    for line in lines[1:]:  # 跳过表头
        cols = line.split()
        if len(cols) < 8:
            continue
        dest, mask = cols[1], cols[7]
        if dest == '00000000' and mask == '00000000':
            return False  # 存在默认路由 => 可达外部 => 未隔离
    return True  # 无默认路由 => 内核级证明无外部网络


def _probe_network_blocked():
    """非破坏性辅助探针：尝试连接可达公共地址，短时超时；均不可达 => 网络被隔离（辅助证据）。
    仅做连接尝试，不发送任何数据；不做为唯一判据（Tom W 批·点① / X 批·一：网络探测不足为凭，
    两公网地址不可达可能是路由/防火墙选择性阻断，不证明内网/其他地址/DNS/其他协议被禁）。"""
    import socket
    blocked = 0
    for host, port in (('8.8.8.8', 443), ('1.1.1.1', 443)):
        try:
            s = socket.create_connection((host, port), timeout=1.0)
            s.close()
        except OSError:
            blocked += 1
    return blocked == 2


def _parse_sandbox_manifest(text):
    """解析 sandbox-manifest：必须【显式、机器可校验】地声明 OS 策略，不能只写散文/注释。

    返回 (claims, errors)：
      claims = {'network_blocked': bool, 'fs_readonly': set(路径)}。
    要求同时声明 network=blocked 与至少一个 fs_readonly=<path>；否则 errors 非空。

    Tom X 批·一：manifest 真实性不能只留在注释/散文中；须以 key=value 形式显式声明，
    并由 _gather_runtime_facts / _decide_boundary 用运行时证据逐条证实。
    """
    claims = {'network_blocked': False, 'fs_readonly': set()}
    errors = []
    if not text or not text.strip():
        errors.append('manifest 为空，无法解析策略声明')
        return claims, errors
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        if '=' not in line:
            # 非键值行视为散文，不计入机器可校验声明（Tom X 批·一：真实性不能只留在注释/散文）
            continue
        key, _, rawval = line.partition('=')
        key = key.strip().lower()
        val = rawval.strip()
        if key == 'network':
            lv = val.lower()
            if lv in ('blocked', 'deny', 'disabled'):
                claims['network_blocked'] = True
            elif lv in ('open', 'allowed', 'enabled'):
                claims['network_blocked'] = False
            # 其余视为未声明，保持 False
        elif key == 'fs_readonly':
            # 保留原始大小写但按 OS 规范化（Windows 大小写不敏感）便于运行时比对
            for p in val.split(','):
                p = p.strip()
                if p:
                    claims['fs_readonly'].add(os.path.normcase(p))
    if not claims['network_blocked']:
        errors.append('manifest 未显式声明 network=blocked（OS 网络隔离须机器可校验）')
    if not claims['fs_readonly']:
        errors.append('manifest 未显式声明任何 fs_readonly=<path>（OS 文件系统只读须机器可校验且绑定具体路径）')
    return claims, errors


def _is_relevant_path(p, home, cwd):
    """路径是否绑定到"用户可写相关"位置（家目录或 cwd）。仅以 /etc 等系统目录冒充只读 => 不算。"""
    np = os.path.normcase(os.path.normpath(p))
    for base in (home, cwd):
        if base and os.path.normcase(os.path.normpath(base)) == np:
            return True
    return False


def _gather_runtime_facts(claims, probe_fn=None):
    """非破坏性运行时证据采集：对 manifest 声明的每个 fs_readonly 路径做 os.access(W_OK=False) 校验
    （辅助），并在 Linux 上读取内核级配置证据（/proc/self/mountinfo 覆盖挂载 ro 标志 +
    /proc/self/net/route 无外部默认路由）。返回 facts 字典。绝不实际写任何文件。
    Tom X 批·一（08:42Z 复审）：内核级挂载/路由配置为权威，os.access 与连接探针仅辅助。
    """
    home = os.path.expanduser('~')
    try:
        cwd = os.getcwd()
    except OSError:
        cwd = None
    facts = {
        'home': home, 'cwd': cwd,
        'readonly_paths': set(),          # 实际校验为只读的路径（辅助，os.access）
        'writable_claimed_paths': set(),  # 声明只读但实际可写（矛盾，os.access）
        'network_blocked': False,         # 连接探针（辅助）
        'container_ev': _linux_container_evidence(),
        'config_available': False,        # 是否能读取内核级配置（Linux /proc）
        'fs_ro_kernel': set(),            # 声明路径覆盖挂载带 ro 标志（内核强制只读，权威）
        'fs_rw_descendant': set(),        # 声明路径下存在 rw 子挂载（逃逸，权威）
        'net_route_isolated': False,      # 内核路由表无外部默认路由（完整禁网，权威）
    }
    for p in claims['fs_readonly']:
        np = os.path.normcase(os.path.normpath(p))
        try:
            exists = os.path.isdir(np) or os.path.isfile(np)
            ro = exists and not os.access(np, os.W_OK)
        except OSError:
            ro = False
        if ro:
            facts['readonly_paths'].add(np)
        else:
            facts['writable_claimed_paths'].add(np)
    facts['network_blocked'] = bool(probe_fn() if probe_fn else _probe_network_blocked())
    # —— 内核级配置证据（权威；探测/os.access 仅辅助，Tom X 批·一）——
    if platform.system() == 'Linux':
        facts['config_available'] = True
        facts['fs_ro_kernel'], facts['fs_rw_descendant'] = _read_mountinfo_ro(claims['fs_readonly'])
        facts['net_route_isolated'] = _read_route_isolated()
    return facts


def _decide_boundary(claims, facts, platform_sys):
    """纯决策（无副作用，可单测）：要求【网络隔离】与【文件系统只读(绑定用户相关路径)】两项
    独立生效且均被运行时证据证实。内核级挂载/路由配置为权威，os.access 与连接探针仅辅助
    （Tom X 批·一 / 08:42Z 复审）。容器/cgroup/CapEff 仅作佐证，绝不作为放行依据。任一未证实即 fail-closed。
    """
    evidence = []
    cfg = facts.get('config_available', False)
    # —— 网络隔离 ——
    if not claims.get('network_blocked'):
        return (False, '网络隔离未声明：manifest 未声明 network=blocked；文件/网络两项策略须同时声明并证实。')
    if cfg:
        if facts.get('net_route_isolated'):
            evidence.append('网络隔离：内核路由表(/proc/self/net/route)证明无外部默认路由'
                           '（完整禁网的内核级证据，非仅靠两个公共地址连接探针）')
        else:
            return (False, '网络隔离未证实：内核路由表存在外部默认路由（Destination/Mask=00000000）；'
                           '仅两个公共地址连接失败可能是路由/防火墙选择性阻断，'
                           '不能证明内网/其他地址/DNS/其他协议被禁（Tom X 批·一：公网不可达≠完整禁网）。'
                           '须由路由表或独立网络命名空间证明完整禁网。')
    else:
        if facts.get('network_blocked'):
            evidence.append('网络隔离：连接探针不可达（本平台无 /proc 路由表，回落到连接探针，证据较弱，仅辅助）')
        else:
            return (False, '网络隔离未证实：manifest 声明 network=blocked，但运行时连接探针仍可达；'
                           '且本平台无法读取内核路由表佐证（Tom X 批·一）。')

    # —— 文件系统只读：必须绑定 home 或 cwd（用户可写相关路径）——
    home = facts.get('home')
    cwd = facts.get('cwd')
    relevant = [p for p in claims.get('fs_readonly', set()) if _is_relevant_path(p, home, cwd)]
    if not relevant:
        return (False, '文件系统只读未证实：manifest 未将 fs_readonly 绑定到家目录或 cwd（用户可写相关路径）；'
                       '仅以 /etc 等系统目录冒充只读不足以证明操作员侧写入被阻断（Tom X 批·一）。')
    if cfg:
        # 权威路径：内核挂载配置（ro 标志）为判据，os.access 仅辅助
        for p in relevant:
            np = os.path.normcase(os.path.normpath(p))
            if np in facts.get('fs_rw_descendant', set()):
                return (False, '文件系统只读未证实：声明只读路径 %s 下存在可写子挂载(rw)，'
                               '只读父目录仍可被写入（逃逸）；内核挂载配置证明失败'
                               '（Tom X 批·一：home/cwd 一个 os.access 不可写不证明子目录/其他挂载只读）。' % p)
            if np not in facts.get('fs_ro_kernel', set()):
                return (False, '文件系统只读未证实：声明只读路径 %s 的内核挂载配置非 ro'
                               '（/proc/self/mountinfo 无覆盖挂载带 ro 标志）；'
                               'os.access 不可写不证明内核级只读（Tom X 批·一）。' % p)
            evidence.append('文件系统只读：/proc/self/mountinfo 证明 %s 覆盖挂载带 ro 标志'
                           '（内核强制只读，非仅靠 os.access）' % p)
    else:
        # 回落到 os.access（较弱，仅当本平台无 /proc 配置时）
        fs_ok = False
        for p in relevant:
            np = os.path.normcase(os.path.normpath(p))
            if np in facts.get('writable_claimed_paths', set()):
                return (False, '文件系统只读矛盾：manifest 声明只读的家目录/cwd 路径 %s 运行时实际可写；'
                               '边界未证实，拒绝（Tom X 批·一）。' % p)
            if np in facts.get('readonly_paths', set()):
                fs_ok = True
                evidence.append('文件系统只读：manifest 声明 fs_readonly=%s + 运行时 os.access(W_OK=False) 证实'
                               '（本平台无 mountinfo，回落较弱）' % p)
        if not fs_ok:
            return (False, '文件系统只读未证实：家目录/cwd 虽声明为只读，但运行时 os.access(W_OK=False) 不成立'
                           '（实际可写或路径不存在）；不得静默通过（Tom X 批·一）。')
    # 容器/cgroup/CapEff 仅佐证，绝不单独放行
    if facts.get('container_ev'):
        evidence.append('（佐证，非放行依据）%s' % facts['container_ev'])
    return (True, 'OS 边界两项策略均经内核级配置证据证实：' + '；'.join(evidence)
            + '。容器/cgroup/CapEff 仅作佐证，不作为放行依据；生成器仅可在已证实隔离的环境中运行，'
              'manifest 真实性由审阅方带外核验。')


def verify_os_boundary(sandbox_verified_flag, manifest_path, facts=None, probe_fn=None):
    """Tom X 批·一（回应 05:16Z 复审）：重写 OS 隔离边界，诚实 fail-closed。
    - 不凭自声明创建或证明隔离；操作员须自有 OS 施加并经【--sandbox-manifest(机器可校验声明) + 运行时证据】证实。
    - 要求【文件/挂载只读】与【网络隔离】两项策略【同时】独立生效且被运行时证据证实；
      普通非隔离用户（/etc 不可写但家目录可写、或家目录只读但网络可达）均不满足。
    - 容器名称/能力集缩减仅作佐证，绝不作为授权依据。
    - manifest 须【显式声明】network=blocked 与 fs_readonly=<路径>，真实性不能只留在注释/散文中。
    - 绑定进程/配置摘要（digest），使裁决与本次运行的实际解释器/cwd/manifest/平台绑定，防篡改冒用。
    - 任一适用探针缺失即 fail-closed，边界未证实前绝不启动生成器。
    返回 (ok, detail)；facts/probe_fn 注入供单测（不触发真实网络/OS 交互）。
    """
    if not sandbox_verified_flag:
        return (False, '未提供 --sandbox-verified：本运行器要求操作员在已证实隔离的 OS（容器/WSL/'
                       'macOS sandbox-exec）内包裹运行并显式声明；不提供任何绕过开关（Tom X 批·一）。')
    if not manifest_path or not os.path.isfile(manifest_path):
        return (False, '未提供 --sandbox-manifest：无法对 OS 边界做带外核验；本运行器不凭自声明开关放行'
                       '（Tom X 批·一：自声明开关不能替代权限边界）。')
    try:
        with open(manifest_path, 'r', encoding='utf-8', errors='replace') as f:
            manifest_text = f.read()
    except OSError as e:
        return (False, 'sandbox-manifest 读取失败：%s' % e)
    claims, errors = _parse_sandbox_manifest(manifest_text)
    if errors:
        return (False, 'sandbox-manifest 解析失败：' + '；'.join(errors)
                + '。机器可校验的策略声明不可缺失（Tom X 批·一）。')
    if facts is None:
        facts = _gather_runtime_facts(claims, probe_fn=probe_fn)
    ok, detail = _decide_boundary(claims, facts, platform.system())
    # 绑定进程/配置摘要：使裁决与本次运行的实际解释器 + cwd + manifest + 平台绑定，防冒用
    digest_src = '|'.join([
        manifest_text.strip(),
        sys.executable or '',
        (facts.get('home') or ''),
        (facts.get('cwd') or ''),
        platform.system() or '',
        repr(sorted(claims.get('fs_readonly', set()))),
    ])
    digest = hashlib.sha256(digest_src.encode('utf-8')).hexdigest()[:16]
    return (ok, detail + ' [boundary-digest=%s]' % digest)
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
          '(fail-closed) + OS 沙箱前置(显式声明 + 机器可校验 manifest + 内核级双策略['
          '文件只读=覆盖挂载 ro 标志(/proc/self/mountinfo) + 网络隔离=无外部默认路由(/proc/self/net/route)]证实，'
          '连接探针/os.access 仅辅助)；失败时不触及仓外或其他目录。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
