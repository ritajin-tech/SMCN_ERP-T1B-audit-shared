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


# ===== Tom 2026-10-30 10:13Z 复审：明确威胁模型 / 禁止条件 / 受控写目录 =====
THREAT_MODEL = (
    "威胁模型 / 禁止条件 / 受控写目录（Tom 2026-10-30 10:13Z 复审要求明确）：\n"
    "- 威胁模型：生成器须运行在真正隔离的 OS 环境（容器/专用 netns/WSL 带 sandbox），使：\n"
    "  (a) 网络：除显式声明的受控写目录所在主机本地地址外，不能路由到互联网、不能路由到生产/内网其他网段；\n"
    "  (b) 文件系统：除显式声明的可写卷（writable_volumes）与临时副本目录外，不能向 home/cwd 或任何未声明挂载写入。\n"
    "- 禁止条件（任一成立即 fail-closed，绝不启动生成器）：\n"
    "  · 内核路由表存在 IPv4 或 IPv6 默认路由（仅核对主表，故要求运行于专用 netns 使主表为权威；策略路由/多表须由 netns 隔离保证）；\n"
    "  · 内核路由表存在经网关的出网路由（非默认、非直连；Tom 10:43Z：IPv4 经非零网关的具体路由未核，一律拒绝）；\n"
    "  · 任何 on-link 子网不在声明的 allowed_subnets 白名单（默认仅 loopback + link-local）；\n"
    "  · 策略路由/多表未显式声明 policy_routing=absent（本运行器仅核对主表，须由专用 netns 隔离保证并显式声明；Tom 10:43Z）；\n"
    "  · 策略路由 UNKNOWN：`ip rule` 缺失/执行失败/无 lookup 表，无法独立证明策略路由=absent => 显式 UNKNOWN 并拒绝（Tom 11:45Z：不得回落 manifest 自声明 absent 放行）；\n"
    "  · 内核挂载表(/proc/self/mountinfo)为空/畸形（短行/无分隔符/转义后越界）或存在任何未解析条目 => 无法确认覆盖与可写卷边界 => 显式 UNKNOWN 并拒绝（Tom 11:45Z）；\n"
    "  · 声明路径含符号链接(symlink)或挂载点含转义字符，解析真实路径后越出声明卷/只读边界 => 拒绝（Tom 11:45Z：symlink 与 mountinfo 转义防御）；\n"
    "  · 沙箱内可达危险 Unix socket 本地 side-channel（如 docker.sock）=> 拒绝（Tom 11:45Z：两公网地址连接探针无法覆盖 Unix socket）；\n"
    "  · 对白名单外地址的真实连接尝试成功；\n"
    "  · 声明只读的 home/cwd 覆盖挂载非内核 ro、或其下存在 rw 子挂载、或存在未声明的宿主可写父挂载；\n"
    "  · 除声明的 writable_volumes 外，遍历全部挂载发现任何未声明可写挂载（Tom 10:43Z：未遍历拒绝其他未声明可写挂载）；\n"
    "  · 实际 mkdtemp 临时副本位置不在声明的 writable_volumes 内（Tom 10:43Z：临时目录须绑定到受控写目录）；\n"
    "  · 路由表/挂载表为空或畸形（解析异常一律拒绝，不默认放行）；\n"
    "  · 非 Linux 平台（无 /proc 内核级配置可作证据，连接探针/os.access 无法覆盖 Unix socket/其他协议/其他网段/策略路由，按'未知即拒绝'原则拒绝；Tom 10:43Z）。\n"
    "- 受控写目录：仅 writable_volumes 声明的路径 + 临时副本目录可写；其余一律只读。生成器无网络导入、不触生产端点。\n"
)


def _covering_ro(mounts, np):
    """返回 np 的【最具体覆盖挂载】的 (mountpoint, ro_bool)，无则 None。
    - 精确匹配优先；根挂载 '/' 视为覆盖所有绝对路径（子挂载更具体时由排序压制，修复根挂载 '/' 前缀拼接成 '//' 误判）。
    Tom 10:13Z：根挂载路径 '/' 的前缀拼接会变成 '//'，可能误判覆盖关系。
    """
    best = None  # (len, mp, ro)
    for mp, ro in mounts:
        mpn = os.path.normcase(mp)
        covers = (mpn == np) \
            or (mpn == os.sep and np != os.sep and np.startswith(os.sep)) \
            or (mpn != os.sep and np.startswith(mpn + os.sep))
        if covers:
            L = len(mpn)
            if best is None or L > best[0]:
                best = (L, mpn, ro)
    return (best[1], best[2]) if best else None


def _mount_opts_ro(opts_fields):
    """挂载选项分词（逗号 + 空格），精确判定 ro/rw。
    Tom 10:13Z：原实现把逗号分隔选项当空格词匹配（如 'ro,noexec' 漏判 ro）。
    """
    tokens = set()
    for field in opts_fields:
        tokens.update(field.split(','))
    return ('ro' in tokens) and ('rw' not in tokens)


def _unescape_mountinfo_field(s):
    r"""解 mountinfo 的八进制/转义（空格=\040、tab=\t、换行=\n、反斜杠=\\，其他 \xxx 八进制）。
    Tom 11:45Z：mountinfo 挂载点含转义字符（如 '/vol\040x'）若不反转义会误判覆盖/越界 => 须反转义后比对。"""
    if '\\' not in s:
        return s
    out = []
    i = 0
    n = len(s)
    mapping = {'t': '\t', 'n': '\n', 'r': '\r', '\\': '\\', 's': ' ', 'a': '\a', 'b': '\b', 'f': '\f', 'v': '\v'}
    while i < n:
        c = s[i]
        if c == '\\' and i + 1 < n:
            nx = s[i + 1]
            if nx in mapping:
                out.append(mapping[nx]); i += 2; continue
            if nx.isdigit():  # \xxx 八进制
                j = i + 1; val = 0; cnt = 0
                while j < n and s[j].isdigit() and cnt < 3:
                    val = val * 8 + int(s[j]); j += 1; cnt += 1
                out.append(chr(val) if 0 <= val < 0x110000 else '?')
                i = j; continue
            out.append(nx); i += 2; continue
        out.append(c); i += 1
    return ''.join(out)


def _read_mountinfo_ro(paths):
    """解析 /proc/self/mountinfo，返回 (fs_ro_kernel, fs_rw_descendant, malformed)（Tom 10:13Z 改写 + 11:45Z 反例）。
    - fs_ro_kernel：声明路径中，其【覆盖挂载】(最长匹配) 带 ro 标志的集合（内核强制只读，非仅靠 os.access）。
    - fs_rw_descendant：声明路径下存在 rw 子挂载的集合（只读父目录下可写子挂载/子目录逃逸）。
    - malformed：是否出现无法解析的挂载行（短行/无分隔符/转义越界）。任一 malformed => 决策显式 UNKNOWN 并拒绝
      （Tom 11:45Z：挂载解析对短行/无分隔符 continue 跳过 => 改为显式 UNKNOWN 拒绝，不得静默放行）。
    仅只读读取，不写任何文件；非 Linux 或读取失败返回 (set(), set(), False)。
    Tom X 批·一（08:42Z 复审）：home/cwd 一个 os.access 不可写不证明子目录/其他挂载/所有写路径只读。
    """
    ro_kernel = set()
    rw_desc = set()
    malformed = False
    try:
        with open('/proc/self/mountinfo', 'r', encoding='utf-8', errors='replace') as f:
            lines = f.readlines()
    except OSError:
        return ro_kernel, rw_desc, malformed
    mounts = []  # (mountpoint_norm, ro_bool)
    for line in lines:
        parts = line.split()
        if len(parts) < 6:
            malformed = True   # 短行/无分隔符 => 无法解析 => 标记 malformed（Tom 11:45Z）
            continue
        mountpoint = _unescape_mountinfo_field(parts[4])
        # 可选字段以 '-' 分隔；'-' 之后为 fs_type / source / superblock options
        opts_fields = [parts[5]]
        try:
            sep = parts.index('-')
            opts_fields.extend(parts[sep + 3:])
        except ValueError:
            malformed = True   # 缺少 '-' 分隔符 => 挂载表畸形（Tom 12:51Z：原实现静默 pass，现 fail-closed）
            continue
        ro = _mount_opts_ro(opts_fields)
        mounts.append((os.path.normcase(os.path.normpath(mountpoint)), ro))
    # 按 mountpoint 长度降序：最具体的覆盖挂载优先匹配
    mounts.sort(key=lambda x: len(x[0]), reverse=True)
    for p in paths:
        np = os.path.normcase(os.path.normpath(p))
        cov = _covering_ro(mounts, np)
        if cov is not None and cov[1] is True:
            ro_kernel.add(np)
        # 检测该声明路径下的 rw 子挂载（逃逸）
        for mp, ro in mounts:
            if mp != np and mp.startswith(np + os.sep) and ro is False:
                rw_desc.add(np)
                break
    return ro_kernel, rw_desc, malformed


def _read_mountinfo_all():
    """解析 /proc/self/mountinfo，返回【全部挂载】(mountpoint_norm, ro_bool) 列表 + malformed 标志（Tom 10:13Z 新增 + 11:45Z 反例）。
    用于核对"未声明的宿主可写挂载"：除 writable_volumes 声明外，home/cwd 下不得存在未声明的 rw 挂载。
    malformed：出现无法解析的挂载行（短行/无分隔符/转义越界）=> 决策显式 UNKNOWN 并拒绝。
    仅只读读取，不写任何文件；非 Linux 或读取失败返回 ([], False)。
    """
    mounts = []
    malformed = False
    try:
        with open('/proc/self/mountinfo', 'r', encoding='utf-8', errors='replace') as f:
            lines = f.readlines()
    except OSError:
        return mounts, malformed
    for line in lines:
        parts = line.split()
        if len(parts) < 6:
            malformed = True   # 短行/无分隔符 => 标记 malformed（Tom 11:45Z）
            continue
        mountpoint = _unescape_mountinfo_field(parts[4])
        opts_fields = [parts[5]]
        try:
            sep = parts.index('-')
            opts_fields.extend(parts[sep + 3:])
        except ValueError:
            malformed = True   # 缺少 '-' 分隔符 => 挂载表畸形（Tom 12:51Z：原实现静默 pass，现 fail-closed）
            continue
        ro = _mount_opts_ro(opts_fields)
        mounts.append((os.path.normcase(os.path.normpath(mountpoint)), ro))
    return mounts, malformed


def _cidr_contains(allowed_cidr, sub_bytes, sub_prefix):
    """判断 allowed_cidr('ip/prefix') 是否包含 (sub_bytes, sub_prefix) 这一子网（v4/v6 通用）。"""
    import socket as _sock
    try:
        af = _sock.AF_INET6 if ':' in allowed_cidr else _sock.AF_INET
        ip, prefix = allowed_cidr.split('/')
        ab = _sock.inet_pton(af, ip)
        ap = int(prefix)
    except (OSError, ValueError):
        return False
    if sub_prefix < ap:
        return False
    nbytes = ap // 8
    nbits = ap % 8
    if sub_bytes[:nbytes] != ab[:nbytes]:
        return False
    if nbits:
        mask = (0xFF << (8 - nbits)) & 0xFF
        if (sub_bytes[nbytes] & mask) != (ab[nbytes] & mask):
            return False
    return True


def _fmt_subnet(sub_bytes, sub_prefix):
    """将 (bytes, prefix) 子网格式化为可读 CIDR 字符串（v4/v6）。"""
    import socket as _sock
    try:
        if len(sub_bytes) == 16:
            return '%s/%d' % (_sock.inet_ntop(_sock.AF_INET6, sub_bytes), sub_prefix)
        return '%s/%d' % (_sock.inet_ntop(_sock.AF_INET, sub_bytes), sub_prefix)
    except (OSError, ValueError):
        return '(%d bytes)/%d' % (len(sub_bytes), sub_prefix)


def _resolve_path(p):
    """按真实路径归一（解析符号链接 + 规范化），用于比对真实 OS 授权边界（Tom 11:45Z：symlink/转义越界防御）。"""
    try:
        rp = os.path.realpath(p)
    except (OSError, ValueError):
        rp = os.path.normpath(p)
    return os.path.normcase(rp)


def _covered_by_volumes(mp, volumes):
    """判断挂载点 mp 是否落在声明的受控写目录(volumes)之内（含相等）。（Tom 10:43Z + 11:45Z：realpath 解析 symlink/转义越界）"""
    mpn = _resolve_path(mp)
    for v in volumes:
        vn = _resolve_path(v)
        if mpn == vn or mpn.startswith(vn + os.sep):
            return True
    return False


def _verify_temp_in_volume(tmp_path, volumes):
    """验证实际 mkdtemp 位置 tmp_path 落在声明的 writable_volumes 之内（Tom 10:43Z：须绑定实际临时目录到该卷）。
    返回 bool；不在任何卷内 => False（运行器须 fail-closed 拒绝）。realpath 解析符号链接（Tom 11:45Z symlink 防御）。"""
    if not tmp_path:
        return False
    return _covered_by_volumes(tmp_path, volumes or set())


def _detect_policy_routing():
    """尽力探测策略路由/多表（Tom 10:43Z + 11:45Z 第四轮：须独立证明，不能凭缺失/失败回落放行）。
    仅做只读 `ip rule` 探测；返回三态字符串：
      'detected' = 检出自定义策略规则（主表之外还有路由决策）=> 决策时拒绝；
      'absent'   = ip 可用且仅有 local/main/default 默认表 => 可声明 absent；
      'unknown'  = ip 缺失/执行失败/无输出/无 lookup 表 => 无法独立证明策略路由=absent
                   => 决策时显式 UNKNOWN 并拒绝（Tom 11:45Z：ip 命令缺失/失败、策略规则无
                    lookup 须显式 UNKNOWN 并拒绝，不得回落到 manifest 自声明 absent 放行）。
    绝不写任何文件。"""
    try:
        r = subprocess.run(['ip', 'rule'], capture_output=True, text=True, timeout=2.0)
    except (OSError, ValueError, subprocess.SubprocessError):
        return 'unknown'          # ip 不可用 => 无法证明策略路由状态
    if r.returncode != 0:
        return 'unknown'          # ip 执行失败 => 无法证明
    lines = [ln.strip() for ln in r.stdout.splitlines() if ln.strip()]
    if not lines:
        return 'unknown'          # 无输出 => 无法证明
    for ln in lines:
        low = ln.lower()
        if 'lookup' in low:
            # 允许的默认表：local / main / default；其余（含数字表/自定义名）即策略路由
            after = low.split('lookup', 1)[1]
            table = after.strip().split()[0] if after.strip() else ''
            if table not in ('local', 'main', 'default', ''):
                return 'detected'  # 自定义 lookup 表 => 策略路由
    return 'absent'              # 仅有默认表 => 可声明 absent


def _read_routes():
    """解析 /proc/net/route(IPv4) 与 /proc/net/ipv6_route(IPv6)，返回结构化路由证据（Tom 10:13Z 重写）。
    返回 dict: {ok, default_v4, default_v6, onlink_v4:set((bytes,prefix)), onlink_v6:set((bytes,prefix))}。
    - ok=False 表示读取/解析失败（空/畸形/非 Linux）=> 须 fail-closed（Tom 10:13Z：解析异常必须拒绝，不得默认放行）。
    - default_v4/v6：存在 IPv4/IPv6 默认路由 => 可路由到外部/内网其他网段 => 未隔离。
    - onlink_v4/v6：直连子网（网关为 0 的路由）→ 实际可达子网，须落在 allowed_subnets 白名单内。
    Tom 10:13Z：仅查 IPv4 主表默认路由不足以证"完整禁网"——须核 IPv6、直连子网、且解析异常必须拒绝。
    注：/proc 仅暴露主表；策略路由/多表须经专用 netns 隔离使主表为权威（见 THREAT_MODEL）。
    """
    result = {'ok': False, 'default_v4': False, 'default_v6': False,
              'onlink_v4': set(), 'onlink_v6': set(),
              'egress_v4': set(), 'egress_v6': set(), 'malformed': False}
    if platform.system() != 'Linux':
        return result  # 非 Linux 由调用方回落到连接探针（较弱）
    try:
        with open('/proc/net/route', 'r', encoding='utf-8', errors='replace') as f:
            v4 = f.readlines()
        if len(v4) < 2:
            return result  # 空表 => 解析异常 => 拒（Tom 10:13Z：空/畸形表被跳过后也可能返回 True）
        for line in v4[1:]:
            cols = line.split()
            # Tom 10:43Z：route 文件固定 11 列；不足即视为畸形行，须拒绝（非空但全畸形不能置 ok=True）
            if len(cols) < 11:
                result['malformed'] = True
                continue
            dest, gw, mask = cols[1], cols[2], cols[7]
            try:
                ab = bytes(reversed(bytes.fromhex(dest)))
                mp = bin(int(mask, 16)).count('1') if int(mask, 16) else 0
            except ValueError:
                result['malformed'] = True
                continue
            if dest == '00000000' and mask == '00000000':
                result['default_v4'] = True
            elif gw == '00000000' and dest != '00000000':
                # 直连子网：网关为 0，主机可路由到该子网；记录 (bytes, prefix)
                result['onlink_v4'].add((ab, mp))
            elif gw != '00000000' and dest != '00000000':
                # 经网关的出网路由（非默认、非直连）：存在网关即潜在出网/内网其他网段路径
                # （Tom 10:43Z：IPv4 经非零网关的具体路由不进入 onlink 集合，未核 => 须拒绝）
                result['egress_v4'].add((ab, mp))
        with open('/proc/net/ipv6_route', 'r', encoding='utf-8', errors='replace') as f:
            v6 = f.readlines()
        if not v6:
            return result
        for line in v6:
            cols = line.split()
            if len(cols) < 6:
                result['malformed'] = True
                continue
            dst, dst_len = cols[0], cols[1]
            try:
                ab = bytes.fromhex(dst)
                mp = int(dst_len, 16)
            except ValueError:
                result['malformed'] = True
                continue
            if dst == '00000000000000000000000000000000' and dst_len == '00':
                result['default_v6'] = True
            elif dst != '00000000000000000000000000000000':
                # IPv6 非默认路由：若 next_hop(col[4]) 非零，即经网关出网 => 记入 egress
                nh = cols[4] if len(cols) > 4 else '00000000000000000000000000000000'
                if nh != '00000000000000000000000000000000':
                    result['egress_v6'].add((ab, mp))
                else:
                    result['onlink_v6'].add((ab, mp))
        if result['malformed']:
            # 任一畸形行 => 解析异常 => 一律拒绝，不得默认放行（Tom 10:43Z：非空但全畸形仍可置 ok=True）
            return result
        result['ok'] = True
    except OSError:
        return result
    return result


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


def _probe_unix_socket_blocked():
    """非破坏性探针：探测沙箱内是否可达危险 Unix socket 本地 side-channel（如 docker.sock）。
    返回 True = 检出可达/存在的危险 Unix socket（隔离不完整，决策须拒绝）；False = 未发现。
    仅做存在性 + 连接尝试，不发送任何数据；Tom 11:45Z：两公网地址连接探针无法覆盖 Unix socket
    等本地 side-channel，故显式补此探针并由决策层拒。绝不写任何文件。"""
    candidates = ['/var/run/docker.sock', '/run/docker.sock']
    import socket as _sock
    af_unix = getattr(_sock, 'AF_UNIX', None)
    for c in candidates:
        try:
            if not os.path.exists(c):
                continue
            if af_unix is None:
                return True  # 平台不支持 Unix socket 探测但 socket 存在 => 保守标记（决策层按 manifest 处理）
            try:
                s = _sock.socket(af_unix, _sock.SOCK_STREAM)
                s.settimeout(0.5)
                s.connect(c)
                s.close()
                return True
            except (OSError, ValueError):
                return True  # 存在但连接失败：存在本身即提示 side-channel 风险，保守标记
        except OSError:
            continue
    return False


def _parse_sandbox_manifest(text):
    """解析 sandbox-manifest：必须【显式、机器可校验】地声明 OS 策略，不能只写散文/注释。

    返回 (claims, errors)：
      claims = {'network_blocked': bool, 'fs_readonly': set(路径)}。
    要求同时声明 network=blocked 与至少一个 fs_readonly=<path>；否则 errors 非空。

    Tom X 批·一：manifest 真实性不能只留在注释/散文中；须以 key=value 形式显式声明，
    并由 _gather_runtime_facts / _decide_boundary 用运行时证据逐条证实。
    """
    claims = {'network_blocked': False, 'fs_readonly': set(),
              'allowed_subnets': set(), 'writable_volumes': set(), 'probe_targets': set(),
              'temp_dir': None, 'policy_routing_absent': False}
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
        elif key == 'allowed_subnets':
            # 实际可达子网白名单（CIDR）；network=blocked 时，on-link 子网必须落在其中
            for p in val.split(','):
                p = p.strip()
                if p:
                    claims['allowed_subnets'].add(p)
        elif key == 'writable_volumes':
            # 受控写目录白名单（生成器临时副本唯一可写位置）
            for p in val.split(','):
                p = p.strip()
                if p:
                    claims['writable_volumes'].add(os.path.normcase(p))
        elif key == 'probe_targets':
            # 真实连接尝试目标（host:port），验证白名单外不可达
            for p in val.split(','):
                p = p.strip()
                if p:
                    claims['probe_targets'].add(p)
        elif key == 'temp_dir':
            # 实际临时副本目录：生成器临时副本须创建于此；须落在 writable_volumes 内（Tom 10:43Z：须绑定实际 mkdtemp 位置到该卷）
            v = val.strip()
            claims['temp_dir'] = os.path.normcase(os.path.normpath(v)) if v else None
        elif key == 'policy_routing':
            # 策略路由/多表声明：仅当显式声明 absent 才被接受（否则视为未声明 => 决策时拒绝）
            # （Tom 10:43Z：本运行器仅核对主表，策略路由/多表须经专用 netns 隔离保证并显式声明）
            lv = val.lower()
            if lv == 'absent':
                claims['policy_routing_absent'] = True
    if not claims['network_blocked']:
        errors.append('manifest 未显式声明 network=blocked（OS 网络隔离须机器可校验）')
    if not claims['fs_readonly']:
        errors.append('manifest 未显式声明任何 fs_readonly=<path>（OS 文件系统只读须机器可校验且绑定具体路径）')
    return claims, errors


def _is_relevant_path(p, home, cwd):
    """路径是否绑定到"用户可写相关"位置（家目录或 cwd）。仅以 /etc 等系统目录冒充只读 => 不算。
    Tom 11:45Z：以真实路径（解析 symlink）比对，避免软链接伪造相关路径。"""
    np = _resolve_path(p)
    for base in (home, cwd):
        if base and _resolve_path(base) == np:
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
        'all_mounts': [],                 # 全部挂载 (mountpoint, ro)（核对未声明可写挂载）
        'routes': {'ok': False, 'default_v4': False, 'default_v6': False,
                   'onlink_v4': set(), 'onlink_v6': set()},  # 结构化路由证据（权威）
        'allowed_subnets': claims.get('allowed_subnets', set()),    # 可达子网白名单
        'writable_volumes': claims.get('writable_volumes', set()),  # 受控写目录白名单
        'temp_dir': claims.get('temp_dir'),                        # 实际临时副本目录（须落在 writable_volumes 内）
        'policy_routing_detected': False,                          # 检出策略路由/多表 => 拒绝
        'policy_routing_unknown': False,                           # 无法独立证明策略路由=absent(ip缺失/失败/无lookup) => 拒绝
        'mountinfo_malformed': False,                              # 挂载表畸形(短行/无分隔符/转义越界) => 拒绝
        'unix_socket_reachable': False,                            # 沙箱可达危险 Unix socket side-channel => 拒绝
    }
    for p in claims['fs_readonly']:
        np = _resolve_path(p)
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
    # —— 内核级配置证据（权威；探测/os.access 仅辅助，Tom X 批·一 / 10:13Z 复审）——
    if platform.system() == 'Linux':
        facts['config_available'] = True
        ro_k, rw_d, mi_mal_1 = _read_mountinfo_ro([_resolve_path(p) for p in claims['fs_readonly']])
        facts['fs_ro_kernel'], facts['fs_rw_descendant'] = ro_k, rw_d
        facts['all_mounts'], mi_mal_2 = _read_mountinfo_all()
        facts['mountinfo_malformed'] = bool(mi_mal_1 or mi_mal_2)
        facts['routes'] = _read_routes()
        pr_state = _detect_policy_routing()
        facts['policy_routing_detected'] = (pr_state == 'detected')
        facts['policy_routing_unknown'] = (pr_state == 'unknown')
        facts['unix_socket_reachable'] = _probe_unix_socket_blocked()
    return facts


def _decide_boundary(claims, facts, platform_sys):
    """纯决策（无副作用，可单测）：要求【网络隔离】与【文件系统只读(绑定用户相关路径)】两项
    独立生效且均被运行时证据证实。内核级挂载/路由配置为权威，os.access 与连接探针仅辅助
    （Tom X 批·一 / 08:42Z 复审）。容器/cgroup/CapEff 仅作佐证，绝不作为放行依据。任一未证实即 fail-closed。
    """
    evidence = []
    cfg = facts.get('config_available', False)
    # —— 网络隔离（Tom 10:13Z 重写：IPv4/IPv6 默认路由 + on-link 子网白名单 + 解析异常拒绝 + 连接探针兜底）——
    if not claims.get('network_blocked'):
        return (False, '网络隔离未声明：manifest 未声明 network=blocked；文件/网络两项策略须同时声明并证实。')
    if cfg:
        routes = facts.get('routes', {})
        if not routes.get('ok'):
            return (False, '网络隔离未证实：内核路由表(/proc/net/route 或 /proc/net/ipv6_route)读取/解析失败'
                           '（空表或畸形）；解析异常一律拒绝，不得默认放行（Tom 10:13Z：空/畸形表被跳过可能误判 True）。'
                           '须由运行于专用 netns 的权威路由表证明完整禁网。')
        if routes.get('default_v4') or routes.get('default_v6'):
            which = []
            if routes.get('default_v4'):
                which.append('IPv4')
            if routes.get('default_v6'):
                which.append('IPv6')
            return (False, '网络隔离未证实：内核路由表存在%s默认路由（Destination/Mask=00000000 或 IPv6 dst 全 0/len 00）；'
                           '存在默认路由即可路由到互联网/内网其他网段（Tom 10:13Z：未核 IPv6/策略路由/直连子网）。'
                           '须由网络命名空间/过滤策略证明完整禁网。' % '/'.join(which))
        # on-link 子网白名单：实际可达子网必须落在 allowed_subnets 内（默认仅 loopback + link-local）
        allowed = facts.get('allowed_subnets') or {
            '127.0.0.0/8', '::1/128', '169.254.0.0/16', 'fe80::/10'}
        for sub_bytes, sub_prefix in (routes.get('onlink_v4', set()) | routes.get('onlink_v6', set())):
            if not any(_cidr_contains(a, sub_bytes, sub_prefix) for a in allowed):
                return (False, '网络隔离未证实：内核路由表存在 on-link 子网（网关为 0 的直连路由）%s'
                               '不在声明的 allowed_subnets 白名单内；无默认路由仍可经直连子网/更具体路由访问内网/生产'
                               '（Tom 10:13Z）。须将实际可达子网显式声明为允许，或证明其无法路由到生产。'
                               % _fmt_subnet(sub_bytes, sub_prefix))
        # 经网关的出网路由（非默认、非直连）：存在网关即潜在出网/内网其他网段路径（Tom 10:43Z：非默认网关路由未核）
        egress = (routes.get('egress_v4') or set()) | (routes.get('egress_v6') or set())
        if egress:
            es = next(iter(egress))
            return (False, '网络隔离未证实：内核路由表存在经网关的出网路由 %s（非默认、非直连）；'
                           '存在网关即存在潜在出网/内网其他网段路径（Tom 10:43Z：IPv4 经非零网关的具体路由未核）。'
                           '须由网络命名空间/过滤策略证明完整禁网。' % _fmt_subnet(es[0], es[1]))
        # 策略路由/多表：主表之外还有路由决策 => 本运行器仅核对主表无法证明完整禁网（Tom 10:43Z）
        if facts.get('policy_routing_detected'):
            return (False, '网络隔离未证实：检测到策略路由/多表（主表之外还有路由决策）；'
                           '本运行器仅核对 /proc/net/route 主表，无法证明完整禁网（Tom 10:43Z）。'
                           '须在专用 netns 内使其为权威并显式声明 policy_routing=absent。')
        # 策略路由 UNKNOWN（ip 缺失/失败/无 lookup）=> 无法独立证明策略路由=absent => 显式拒绝（Tom 11:45Z）
        if facts.get('policy_routing_unknown'):
            return (False, '网络隔离未证实：策略路由/命名空间未独立证明（`ip rule` 缺失/执行失败/无 lookup 表，'
                           '无法确认策略路由=absent）；按"未知即拒绝"原则拒绝（Tom 11:45Z）。'
                           '须由专用 netns 内使其为权威并显式声明 policy_routing=absent。')
        # 危险 Unix socket side-channel（Tom 11:45Z：两公网地址连接探针无法覆盖 Unix socket）
        if facts.get('unix_socket_reachable'):
            return (False, '网络隔离未证实：沙箱内可达危险 Unix socket side-channel（如 docker.sock），'
                           '可能为完整隔离逃逸路径；两公网地址连接探针无法覆盖 Unix socket（Tom 11:45Z）。'
                           '须移除/隔离该 side-channel 后重测。')
        if not claims.get('policy_routing_absent'):
            return (False, '网络隔离未证实：manifest 未显式声明 policy_routing=absent；'
                           '本运行器仅核对主表，策略路由/多表须经专用 netns 隔离保证并显式声明（Tom 10:43Z）。')
        if not facts.get('network_blocked'):
            return (False, '网络隔离未证实：内核路由表无默认路由/无出网路由，但运行时对白名单外地址的真实连接尝试仍可达'
                           '（连接探针证实存在其他出网路径，如策略路由/Unix socket）；'
                           'Tom 10:43Z：须对白名单中每个地址做真实连接尝试并确认仅白名单可达。')
        evidence.append('网络隔离：内核路由表证实无 IPv4/IPv6 默认路由 + 无经网关出网路由 + 全部 on-link '
                       '子网落在 allowed_subnets 白名单 + 策略路由已显式声明 absent（专用 netns 内主表为权威）'
                       ' + 白名单外真实连接尝试不可达（完整禁网的内核级证据，非仅靠两个公共地址连接探针）')
    else:
        # 非 Linux：无 /proc 内核级配置证据；连接探针/os.access 不能证明完整禁网
        # （Unix socket、其他协议、其他网段、策略路由均无法覆盖）=> 按"未知即拒绝"原则拒绝
        # （Tom 10:43Z：非Linux分支回落两个公网探针与 os.access 仍可能放行）。
        return (False, '网络隔离/文件只读未证实：本平台无 /proc 内核级配置（mountinfo/route）可核，'
                       '连接探针与 os.access 无法证明 Unix socket/其他协议/其他网段/策略路由被禁，'
                       '按"未知即拒绝"原则拒绝（Tom 10:43Z）；请在 Linux 专用 netns 内运行以获内核级证据。')
    home = facts.get('home')
    cwd = facts.get('cwd')
    relevant = [p for p in claims.get('fs_readonly', set()) if _is_relevant_path(p, home, cwd)]
    if not relevant:
        return (False, '文件系统只读未证实：manifest 未将 fs_readonly 绑定到家目录或 cwd（用户可写相关路径）；'
                       '仅以 /etc 等系统目录冒充只读不足以证明操作员侧写入被阻断（Tom X 批·一）。')
    if cfg:
        # 畸形挂载表：无法确认覆盖与可写卷边界 => 显式 UNKNOWN 拒绝（Tom 11:45Z）
        if facts.get('mountinfo_malformed'):
            return (False, '文件系统只读未证实：内核挂载表(/proc/self/mountinfo)存在无法解析的条目'
                           '（短行/无分隔符/转义越界）；无法确认覆盖与可写卷边界，按"未知即拒绝"原则拒绝'
                           '（Tom 11:45Z）。须提供完整可解析的挂载表或声明专用 netns。')
        # 权威路径：内核挂载配置（ro 标志）为判据，os.access 仅辅助；以真实路径（解析 symlink）比对
        for p in relevant:
            np = _resolve_path(p)
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

    # —— 受控写目录 / 未声明宿主可写挂载（Tom 10:13Z）——
    # 威胁模型要求：生成器仅能写入显式声明的 writable_volumes（临时副本目录），其余一律只读。
    # 故须强制声明 writable_volumes，并验证其覆盖挂载内核级可写（生成器确能写入临时副本）。
    writable_volumes = claims.get('writable_volumes', set())
    if not writable_volumes:
        return (False, '受控写目录未声明：manifest 未声明 writable_volumes=<路径>（生成器临时副本/受控写目录）；'
                       '不声明即无法证明"除声明可写卷外 home/cwd 均无未声明宿主可写挂载"，'
                       '须显式枚举唯一允许写入的位置（Tom 10:13Z：声明 home/cwd 不覆盖未声明的宿主可写挂载）。')
    for wv in writable_volumes:
        np = os.path.normcase(os.path.normpath(wv))
        if facts.get('config_available'):
            cov = _covering_ro(facts.get('all_mounts', []), np)
            if cov is None or cov[1] is not False:
                return (False, '受控写目录未证实：%s 的覆盖挂载非 rw（内核级），生成器无法写入临时副本；'
                               'writable_volumes 须指向真实可写的受控目录（Tom 10:13Z）。' % wv)
        evidence.append('受控写目录：%s 已声明且内核级可写（生成器临时副本唯一允许写入位置）' % wv)

    # Tom 10:43Z：遍历全部挂载，拒绝任何未声明可写挂载（除声明的 writable_volumes 外，其余挂载须全部内核 ro）
    if facts.get('config_available'):
        for mp, ro in facts.get('all_mounts', []):
            if ro is False and not _covered_by_volumes(mp, writable_volumes):
                return (False, '文件系统只读未证实：存在未声明的可写挂载 %s（不在 writable_volumes 内）；'
                               '除显式声明的受控写目录外，其余挂载须全部内核 ro'
                               '（Tom 10:43Z：未遍历拒绝其他未声明可写挂载）。' % mp)
    # Tom 10:43Z：须将实际 mkdtemp 位置绑定到声明的 writable_volumes（防止临时副本落在未声明可写位置）
    temp_dir = claims.get('temp_dir')
    if temp_dir:
        if not _verify_temp_in_volume(temp_dir, writable_volumes):
            return (False, '受控写目录未证实：声明的 temp_dir=%s 不在 writable_volumes 之内；'
                           '实际临时副本目录须落在声明的受控写目录内（Tom 10:43Z：临时目录绑定）。' % temp_dir)
        evidence.append('受控写目录：声明的 temp_dir=%s 已绑定到 writable_volumes（实际临时副本位置受控）' % temp_dir)

    # 容器/cgroup/CapEff 仅佐证，绝不单独放行
    if facts.get('container_ev'):
        evidence.append('（佐证，非放行依据）%s' % facts['container_ev'])
    return (True, 'OS 边界两项策略均经内核级配置证据证实：' + '；'.join(evidence)
            + '。容器/cgroup/CapEff 仅作佐证，不作为放行依据；生成器仅可在已证实隔离的环境中运行，'
              'manifest 真实性由审阅方带外核验。')


def verify_os_boundary(sandbox_verified_flag, manifest_path, facts=None, probe_fn=None):
    """Tom X 批·一 + 10:13Z 复审：重写 OS 隔离边界，诚实 fail-closed。
    - 不凭自声明创建或证明隔离；操作员须自有 OS 施加并经【--sandbox-manifest(机器可校验声明) + 运行时证据】证实。
    - 要求【文件/挂载只读】与【网络隔离】两项策略【同时】独立生效且被运行时证据证实；
      普通非隔离用户（/etc 不可写但家目录可写、或家目录只读但网络可达）均不满足。
    - 网络隔离内核级证据（Tom 10:13Z）：无 IPv4/IPv6 默认路由 + 全部 on-link 子网落在 allowed_subnets 白名单
      + 白名单外真实连接尝试不可达；解析异常（空/畸形表）一律拒绝，不默认放行；仅核对主表故须运行于专用 netns。
    - 文件只读内核级证据：覆盖挂载带 ro 标志（/proc/self/mountinfo，逗号选项分词 + 根挂载覆盖修正）；
      并强制声明 writable_volumes（生成器临时副本唯一可写位置），除之其外 home/cwd 均须内核 ro。
    - 容器名称/能力集缩减仅作佐证，绝不作为授权依据。
    - manifest 须【显式声明】network=blocked、fs_readonly=<路径>、writable_volumes=<路径>
      （allowed_subnets / probe_targets 可选），真实性不能只留在注释/散文中。
    - 威胁模型/禁止条件/受控写目录见模块常量 THREAT_MODEL（Tom 10:13Z 明确要求明确化）。
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


def main(argv=None):
    args = list(argv) if argv is not None else sys.argv[1:]
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

    # 2) 复制到一次性临时副本（仅副本可写）—— Tom 10:43Z：须将实际 mkdtemp 位置绑定到声明的 writable_volumes
    tmp = None
    try:
        with open(manifest_path, 'r', encoding='utf-8', errors='replace') as f:
            mtext = f.read()
        mclaims, _ = _parse_sandbox_manifest(mtext)  # Tom 12:51Z：返回值 (claims, errors)；claims 为字典、errors 为列表，须取第一个
        tdir = mclaims.get('temp_dir')
        if tdir and os.path.isdir(tdir):
            tmp = tempfile.mkdtemp(prefix='gas_repro_iso_', dir=tdir)
        else:
            tmp = tempfile.mkdtemp(prefix='gas_repro_iso_')
        tmp = _resolve_path(tmp)  # 解析真实路径，确保与 OS 授权边界（writable_volumes）一致（Tom 11:45Z）
        vols = mclaims.get('writable_volumes', set())
        if vols and not _verify_temp_in_volume(tmp, vols):
            print('[ABORT] 实际临时副本目录 %s 不在声明的 writable_volumes 内（Tom 10:43Z：临时目录绑定）；'
                  '请在 manifest 声明 temp_dir 并使其落在 writable_volumes。' % tmp)
            return 9
    except OSError as e:
        print('[ABORT] 读取 manifest 失败：%s' % e)
        return 9
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
    print('[PASS] 隔离边界可验证：原树只读(双向代码断言,所有路径) + 仅临时副本可写(writable_volumes 显式声明) + 生成器无网络导入'
          '(fail-closed) + OS 沙箱前置(显式声明 + 机器可校验 manifest + 内核级双策略证实)；'
          '文件只读 = 覆盖挂载 ro 标志(/proc/self/mountinfo，逗号选项分词 + 根挂载覆盖修正)；'
          '网络隔离 = 无 IPv4/IPv6 默认路由 + 全部 on-link 子网落在 allowed_subnets 白名单 + 白名单外真实连接尝试不可达'
          '(/proc/net/route + /proc/net/ipv6_route，解析异常一律拒绝)；'
          '连接探针/os.access 仅辅助；失败时不触及仓外或其他目录。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
