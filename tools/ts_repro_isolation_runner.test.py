# -*- coding: utf-8 -*-
# ts_repro_isolation_runner.py 独立单测（Tom X 批·一 + 10:13Z 复审：OS 隔离边界诚实 fail-closed）。
import os
import sys
import shutil
import unittest
from unittest import mock

import ts_repro_isolation_runner as M


def _facts(home='C:\\Users\\x', cwd='C:\\repo', home_readonly=True, cwd_readonly=False,
           network_blocked=True, container_ev=None, extra_readonly=None, extra_writable=None,
           config_available=False, fs_ro_kernel=None, fs_rw_descendant=None,
           routes=None, allowed_subnets=None, writable_volumes=None, all_mounts=None,
           policy_routing_detected=None, policy_routing_unknown=None,
           mountinfo_malformed=None, unix_socket_reachable=None):
    ro = set()
    wr = set()
    hn = os.path.normcase(os.path.normpath(home))
    if home_readonly:
        ro.add(hn)
    else:
        wr.add(hn)
    cn = os.path.normcase(os.path.normpath(cwd))
    if cwd_readonly:
        ro.add(cn)
    for p in (extra_readonly or []):
        ro.add(os.path.normcase(os.path.normpath(p)))
    for p in (extra_writable or []):
        wr.add(os.path.normcase(os.path.normpath(p)))
    if routes is None:
        routes = {'ok': True, 'default_v4': False, 'default_v6': False,
                  'onlink_v4': set(), 'onlink_v6': set(),
                  'egress_v4': set(), 'egress_v6': set()}
    return {'home': home, 'cwd': cwd, 'readonly_paths': ro,
            'writable_claimed_paths': wr, 'network_blocked': network_blocked,
            'container_ev': container_ev,
            'config_available': config_available,
            'fs_ro_kernel': set(os.path.normcase(os.path.normpath(p)) for p in (fs_ro_kernel or [])),
            'fs_rw_descendant': set(os.path.normcase(os.path.normpath(p)) for p in (fs_rw_descendant or [])),
            'all_mounts': [],
            'routes': routes,
            'allowed_subnets': set(allowed_subnets or []),
            'writable_volumes': set(os.path.normcase(os.path.normpath(p)) for p in (writable_volumes or [])),
            'all_mounts': all_mounts or [],
            'policy_routing_detected': policy_routing_detected,
            'policy_routing_unknown': policy_routing_unknown,
            'mountinfo_malformed': mountinfo_malformed,
            'unix_socket_reachable': unix_socket_reachable}


class TestVerifyOsBoundary(unittest.TestCase):
    def _mount(self, manifest_text):
        # Tom 10:43Z：manifest 须显式声明 policy_routing=absent（策略路由/多表须经专用 netns 保证）；
        # 对含 network=blocked 且未声明 policy_routing 的合法 manifest 自动补声明，避免重复样板。
        if manifest_text and 'network=blocked' in manifest_text and 'policy_routing' not in manifest_text:
            manifest_text = manifest_text + '\npolicy_routing=absent'
        m = mock.patch.object(M.os.path, 'isfile', return_value=True)
        mm = mock.patch('builtins.open', mock.mock_open(read_data=manifest_text))
        m.start(); mm.start()
        self.addCleanup(m.stop); self.addCleanup(mm.stop)

    def test_no_flag_fails(self):
        ok, detail = M.verify_os_boundary(False, 'manifest.txt', facts=_facts())
        self.assertFalse(ok, detail)
        self.assertIn('sandbox-verified', detail)

    def test_no_manifest_fails(self):
        ok, detail = M.verify_os_boundary(True, None, facts=_facts())
        self.assertFalse(ok, detail)

    def test_manifest_empty_fails(self):
        self._mount('')
        ok, detail = M.verify_os_boundary(True, 'manifest.txt', facts=_facts())
        self.assertFalse(ok, detail)
        self.assertIn('空', detail)

    def test_manifest_prose_only_fails(self):
        self._mount('container: read-only rootfs + network namespace')
        ok, detail = M.verify_os_boundary(True, 'manifest.txt', facts=_facts())
        self.assertFalse(ok, detail)
        self.assertIn('未显式声明', detail)

    def test_manifest_but_home_writable_fails(self):
        self._mount('network=blocked\nfs_readonly=C:\\Windows\nwritable_volumes=C:\\tmp')
        ok, detail = M.verify_os_boundary(True, 'manifest.txt',
                                         facts=_facts(home_readonly=False, config_available=True))
        self.assertFalse(ok, detail)
        self.assertIn('家目录或 cwd', detail)

    def test_non_linux_rejected_by_default(self):
        # Tom 10:43Z：非 Linux 平台无 /proc 内核级配置，连接探针/os.access 不能证明完整禁网
        # （Unix socket/其他协议/其他网段/策略路由无法覆盖）=> 按"未知即拒绝"原则默认拒绝
        # （不再回落到可能被绕过的两个公网探针 + os.access）
        self._mount('network=blocked\nfs_readonly=C:\\Users\\x\nwritable_volumes=C:\\tmp')
        ok, detail = M.verify_os_boundary(True, 'manifest.txt',
                                         facts=_facts(home_readonly=True, network_blocked=True))
        self.assertFalse(ok, detail)
        self.assertIn('未知即拒绝', detail)

    def test_readonly_home_but_network_allowed_fails(self):
        self._mount('network=blocked\nfs_readonly=C:\\Users\\x\nwritable_volumes=C:\\tmp')
        ok, detail = M.verify_os_boundary(True, 'manifest.txt',
                                         facts=_facts(home_readonly=True, network_blocked=False,
                                                      config_available=True))
        self.assertFalse(ok, detail)
        self.assertIn('网络隔离未证实', detail)

    def test_container_but_host_writable_fails(self):
        # 容器/cgroup 证据存在，但 home 实际可写 => 内核 ro 检查失败 => 拒绝（容器证据不作放行依据）
        self._mount('network=blocked\nfs_readonly=C:\\Users\\x\nwritable_volumes=C:\\tmp')
        ok, detail = M.verify_os_boundary(True, 'manifest.txt',
                                         facts=_facts(home_readonly=False, config_available=True,
                                                     container_ev='cgroup 含容器运行时证据'))
        self.assertFalse(ok, detail)
        self.assertIn('内核挂载配置非 ro', detail)

    def test_container_evidence_alone_not_sufficient(self):
        self._mount('network=blocked\nfs_readonly=C:\\Users\\x\nwritable_volumes=C:\\tmp')
        ok, detail = M.verify_os_boundary(True, 'manifest.txt',
                                         facts=_facts(home_readonly=False, config_available=True,
                                                     container_ev='进程能力集(CapEff)已缩减'))
        self.assertFalse(ok, detail)
        self.assertIn('内核挂载配置非 ro', detail)

    def test_arbitrary_nonempty_manifest_fails(self):
        self._mount('I solemnly declare this is isolated.')
        ok, detail = M.verify_os_boundary(True, 'manifest.txt', facts=_facts())
        self.assertFalse(ok, detail)

    def test_linux_container_evidence(self):
        with mock.patch.object(M.platform, 'system', return_value='Linux'), \
             mock.patch('builtins.open', mock.mock_open(read_data='12:cpu:/docker/abc')):
            ev = M._linux_container_evidence()
        self.assertIsNotNone(ev)
        self.assertIn('cgroup', ev)

    def test_linux_capability_reduced(self):
        status = 'Name:\tpython\nCapEff:\t0000000000000001\n'
        with mock.patch.object(M.platform, 'system', return_value='Linux'), \
             mock.patch('builtins.open', mock.mock_open(read_data=status)):
            ev = M._linux_container_evidence()
        self.assertIsNotNone(ev)
        self.assertIn('能力集', ev)

    # ===== Tom 08:42Z 复审：内核级配置为权威，连接探针/os.access 仅辅助；补充三个反例 =====

    def test_config_pass_kernel_ro_and_route_isolated(self):
        self._mount('network=blocked\nfs_readonly=C:\\Users\\x\nwritable_volumes=C:\\tmp')
        ok, detail = M.verify_os_boundary(True, 'manifest.txt',
                                         facts=_facts(home_readonly=True, network_blocked=True,
                                                      config_available=True,
                                                      fs_ro_kernel=['C:\\Users\\x'],
                                                      all_mounts=[('C:\\tmp', False)],
                                                      routes={'ok': True, 'default_v4': False,
                                                              'default_v6': False, 'onlink_v4': set(),
                                                              'onlink_v6': set()}))
        self.assertTrue(ok, detail)
        self.assertIn('mountinfo', detail)
        self.assertIn('内核路由表', detail)

    def test_intranet_reachable_while_public_blocked_fails(self):
        # 反例(a)：连接探针 blocked，但内核路由表存在 IPv4 默认路由 => 内网/其他地址仍可达 => 拒绝
        self._mount('network=blocked\nfs_readonly=C:\\Users\\x\nwritable_volumes=C:\\tmp')
        ok, detail = M.verify_os_boundary(True, 'manifest.txt',
                                         facts=_facts(home_readonly=True, network_blocked=True,
                                                      config_available=True,
                                                      fs_ro_kernel=['C:\\Users\\x'],
                                                      routes={'ok': True, 'default_v4': True,
                                                              'default_v6': False, 'onlink_v4': set(),
                                                              'onlink_v6': set()}))
        self.assertFalse(ok, detail)
        self.assertIn('默认路由', detail)

    def test_ro_parent_with_writable_subdir_fails(self):
        # 反例(b)：声明只读的 home 覆盖挂载带 ro，但其下存在 rw 子挂载(可写子目录逃逸) => 拒绝
        self._mount('network=blocked\nfs_readonly=C:\\Users\\x\nwritable_volumes=C:\\tmp')
        ok, detail = M.verify_os_boundary(True, 'manifest.txt',
                                         facts=_facts(home_readonly=True, network_blocked=True,
                                                      config_available=True,
                                                      fs_ro_kernel=['C:\\Users\\x'],
                                                      fs_rw_descendant=['C:\\Users\\x'],
                                                      routes={'ok': True, 'default_v4': False,
                                                              'default_v6': False, 'onlink_v4': set(),
                                                              'onlink_v6': set()}))
        self.assertFalse(ok, detail)
        self.assertIn('可写子挂载', detail)

    def test_other_mount_writable_fails(self):
        # 反例(c)：声明只读的 cwd 覆盖挂载带 ro，但其下存在其他可写挂载 => 逃逸 => 拒绝
        self._mount('network=blocked\nfs_readonly=C:\\repo\nwritable_volumes=C:\\tmp')
        ok, detail = M.verify_os_boundary(True, 'manifest.txt',
                                         facts=_facts(cwd='C:\\repo', cwd_readonly=True,
                                                      network_blocked=True, config_available=True,
                                                      fs_ro_kernel=['C:\\repo'],
                                                      fs_rw_descendant=['C:\\repo'],
                                                      routes={'ok': True, 'default_v4': False,
                                                              'default_v6': False, 'onlink_v4': set(),
                                                              'onlink_v6': set()}))
        self.assertFalse(ok, detail)
        self.assertIn('可写子挂载', detail)

    def test_config_fs_ro_kernel_missing_fails(self):
        self._mount('network=blocked\nfs_readonly=C:\\Users\\x\nwritable_volumes=C:\\tmp')
        ok, detail = M.verify_os_boundary(True, 'manifest.txt',
                                         facts=_facts(home_readonly=True, network_blocked=True,
                                                      config_available=True,
                                                      fs_ro_kernel=[],
                                                      routes={'ok': True, 'default_v4': False,
                                                              'default_v6': False, 'onlink_v4': set(),
                                                              'onlink_v6': set()}))
        self.assertFalse(ok, detail)
        self.assertIn('内核挂载配置非 ro', detail)

    # ===== Tom 10:13Z 复审：路由/挂载证据仍须补齐（新增反例）=====

    def test_route_ipv6_default_fails(self):
        # 反例(d)：IPv4 无默认路由，但存在 IPv6 默认路由 => 仍可通过 IPv6 出网 => 拒绝
        self._mount('network=blocked\nfs_readonly=C:\\Users\\x\nwritable_volumes=C:\\tmp')
        ok, detail = M.verify_os_boundary(True, 'manifest.txt',
                                         facts=_facts(home_readonly=True, network_blocked=True,
                                                      config_available=True,
                                                      fs_ro_kernel=['C:\\Users\\x'],
                                                      routes={'ok': True, 'default_v4': False,
                                                              'default_v6': True, 'onlink_v4': set(),
                                                              'onlink_v6': set()}))
        self.assertFalse(ok, detail)
        self.assertIn('IPv6', detail)

    def test_route_onlink_not_allowlisted_fails(self):
        # 反例(e)：无默认路由，但存在 on-link 子网（网关为 0 的直连路由）不在 allowed_subnets
        # => 可经直连子网访问内网/生产 => 拒绝
        # 10.0.0.0/8 直连子网（小端 hex 0000000A，prefix 8）
        onlink = {(b'\x0a\x00\x00\x00', 8)}
        self._mount('network=blocked\nfs_readonly=C:\\Users\\x\nwritable_volumes=C:\\tmp')
        ok, detail = M.verify_os_boundary(True, 'manifest.txt',
                                         facts=_facts(home_readonly=True, network_blocked=True,
                                                      config_available=True,
                                                      fs_ro_kernel=['C:\\Users\\x'],
                                                      routes={'ok': True, 'default_v4': False,
                                                              'default_v6': False,
                                                              'onlink_v4': onlink,
                                                              'onlink_v6': set()}))
        self.assertFalse(ok, detail)
        self.assertIn('on-link', detail)

    def test_route_empty_or_malformed_fails(self):
        # 反例(f)：路由表读取/解析失败（空/畸形）=> 解析异常一律拒绝，不得默认放行
        self._mount('network=blocked\nfs_readonly=C:\\Users\\x\nwritable_volumes=C:\\tmp')
        ok, detail = M.verify_os_boundary(True, 'manifest.txt',
                                         facts=_facts(home_readonly=True, network_blocked=True,
                                                      config_available=True,
                                                      fs_ro_kernel=['C:\\Users\\x'],
                                                      routes={'ok': False, 'default_v4': False,
                                                              'default_v6': False, 'onlink_v4': set(),
                                                              'onlink_v6': set()}))
        self.assertFalse(ok, detail)
        self.assertIn('读取/解析失败', detail)

    def test_route_onlink_allowed_passes(self):
        # on-link 子网落在默认白名单（loopback/link-local）内 => 放行
        onlink = {(b'\x7f\x00\x00\x01', 8)}  # 127.0.0.1/8
        self._mount('network=blocked\nfs_readonly=C:\\Users\\x\nwritable_volumes=C:\\tmp')
        ok, detail = M.verify_os_boundary(True, 'manifest.txt',
                                         facts=_facts(home_readonly=True, network_blocked=True,
                                                      config_available=True,
                                                      fs_ro_kernel=['C:\\Users\\x'],
                                                      all_mounts=[('C:\\tmp', False)],
                                                      routes={'ok': True, 'default_v4': False,
                                                              'default_v6': False,
                                                              'onlink_v4': onlink,
                                                              'onlink_v6': set()}))
        self.assertTrue(ok, detail)

    def test_writable_volumes_missing_fails(self):
        # 反例(g)：声明 network + fs_readonly 但未声明 writable_volumes => 受控写目录未声明 => 拒绝
        self._mount('network=blocked\nfs_readonly=C:\\Users\\x')
        ok, detail = M.verify_os_boundary(True, 'manifest.txt',
                                         facts=_facts(home_readonly=True, network_blocked=True,
                                                      config_available=True,
                                                      fs_ro_kernel=['C:\\Users\\x'],
                                                      routes={'ok': True, 'default_v4': False,
                                                              'default_v6': False, 'onlink_v4': set(),
                                                              'onlink_v6': set()}))
        self.assertFalse(ok, detail)
        self.assertIn('受控写目录未声明', detail)

    def test_writable_volumes_not_rw_fails(self):
        # 反例(h)：writable_volumes 指向的路径覆盖挂载非 rw（内核级）=> 生成器无法写入临时副本 => 拒绝
        self._mount('network=blocked\nfs_readonly=C:\\Users\\x\nwritable_volumes=C:\\tmp')
        ok, detail = M.verify_os_boundary(True, 'manifest.txt',
                                         facts=_facts(home_readonly=True, network_blocked=True,
                                                      config_available=True,
                                                      fs_ro_kernel=['C:\\Users\\x'],
                                                      all_mounts=[('C:\\tmp', True)],  # C:\tmp 覆盖挂载为 ro
                                                      routes={'ok': True, 'default_v4': False,
                                                              'default_v6': False, 'onlink_v4': set(),
                                                              'onlink_v6': set()}))
        self.assertFalse(ok, detail)
        self.assertIn('受控写目录未证实', detail)

    def test_mount_comma_option_ro_and_rw(self):
        # 反例(i)：挂载选项逗号分隔（如 'ro,noexec' / 'rw,relatime'）须被精确分词
        # col[5] 为挂载选项；ro,noexec => 判定 ro；rw,relatime => 判定 rw
        mi_ro = '123 456 7:8 / /home/x ro,noexec shared:1 - ext4 /dev/sda1 ro\n'
        mi_rw = '123 456 7:8 / /home/x rw,relatime shared:1 - ext4 /dev/sda1 rw\n'
        with mock.patch.object(M.platform, 'system', return_value='Linux'), \
             mock.patch('builtins.open', mock.mock_open(read_data=mi_ro)):
            ro_k, rw_d, mal = M._read_mountinfo_ro(['/home/x'])
        self.assertIn(os.path.normcase('/home/x'), ro_k, 'ro,noexec 应判定为 ro（修复逗号选项漏判）')
        with mock.patch.object(M.platform, 'system', return_value='Linux'), \
             mock.patch('builtins.open', mock.mock_open(read_data=mi_rw)):
            ro_k2, rw_d2, mal2 = M._read_mountinfo_ro(['/home/x'])
        self.assertNotIn(os.path.normcase('/home/x'), ro_k2, 'rw,relatime 应判定为非 ro')

    def test_root_mount_coverage(self):
        # 反例(j)：根挂载 '/' 带 ro 时，其子路径（如 /home/x）应被判定为 ro
        # （修复根挂载 '/' 前缀拼接成 '//' 误判覆盖关系的 bug）
        mi = '123 456 7:8 / / ro,relatime shared:1 - ext4 /dev/sda1 ro\n'
        with mock.patch.object(M.platform, 'system', return_value='Linux'), \
             mock.patch('builtins.open', mock.mock_open(read_data=mi)):
            ro_k, rw_d, mal = M._read_mountinfo_ro(['/home/x'])
        self.assertIn(os.path.normcase('/home/x'), ro_k, '根挂载 ro 应覆盖其子路径 /home/x')

    # ===== Tom 2026-10-30 10:43Z 复审（第三轮）：补充 6 类验收反例 =====

    def test_egress_route_while_probes_blocked_fails(self):
        # 反例(k·公网失败内网可达)：连接探针 blocked（公网不可达），但内核路由表存在经网关的出网路由
        # (10.0.0.0/8 via 网关) => 内网/其他地址仍可达 => 拒绝（Tom 10:43Z：非默认网关路由未核）
        egress = {(b'\x0a\x00\x00\x00', 8)}
        self._mount('network=blocked\nfs_readonly=C:\\Users\\x\nwritable_volumes=C:\\tmp')
        ok, detail = M.verify_os_boundary(True, 'manifest.txt',
                                         facts=_facts(home_readonly=True, network_blocked=True,
                                                      config_available=True,
                                                      fs_ro_kernel=['C:\\Users\\x'],
                                                      all_mounts=[('C:\\tmp', False)],
                                                      routes={'ok': True, 'default_v4': False,
                                                              'default_v6': False, 'onlink_v4': set(),
                                                              'onlink_v6': set(), 'egress_v4': egress,
                                                              'egress_v6': set()}))
        self.assertFalse(ok, detail)
        self.assertIn('出网路由', detail)

    def test_policy_routing_detected_fails(self):
        # 反例(l·策略路由)：检测到策略路由/多表（主表之外还有路由决策）=> 仅核对主表无法证明完整禁网 => 拒绝
        self._mount('network=blocked\nfs_readonly=C:\\Users\\x\nwritable_volumes=C:\\tmp')
        ok, detail = M.verify_os_boundary(True, 'manifest.txt',
                                         facts=_facts(home_readonly=True, network_blocked=True,
                                                      config_available=True,
                                                      fs_ro_kernel=['C:\\Users\\x'],
                                                      all_mounts=[('C:\\tmp', False)],
                                                      routes={'ok': True, 'default_v4': False,
                                                              'default_v6': False, 'onlink_v4': set(),
                                                              'onlink_v6': set(), 'egress_v4': set(),
                                                              'egress_v6': set()},
                                                      policy_routing_detected=True))
        self.assertFalse(ok, detail)
        self.assertIn('策略路由', detail)

    def test_other_rw_mount_undeclared_fails(self):
        # 反例(m·其他未声明可写挂载)：除声明的 writable_volumes 外，还存在未声明的可写挂载 C:\other => 逃逸 => 拒绝
        self._mount('network=blocked\nfs_readonly=C:\\Users\\x\nwritable_volumes=C:\\tmp')
        ok, detail = M.verify_os_boundary(True, 'manifest.txt',
                                         facts=_facts(home_readonly=True, network_blocked=True,
                                                      config_available=True,
                                                      fs_ro_kernel=['C:\\Users\\x'],
                                                      all_mounts=[('C:\\tmp', False), ('C:\\other', False)],
                                                      routes={'ok': True, 'default_v4': False,
                                                              'default_v6': False, 'onlink_v4': set(),
                                                              'onlink_v6': set(), 'egress_v4': set(),
                                                              'egress_v6': set()}))
        self.assertFalse(ok, detail)
        self.assertIn('未声明的可写挂载', detail)

    def test_temp_dir_not_in_whitelist_fails(self):
        # 反例(n·临时目录不在白名单)：实际临时副本目录不在声明的 writable_volumes 内 => 拒绝
        self.assertFalse(M._verify_temp_in_volume('C:\\tmp\\gas_repro_iso_xxx', {'C:\\tmp2'}),
                         '临时目录不在白名单内应返回 False')
        self.assertFalse(M._verify_temp_in_volume('C:\\tmp', {'C:\\tmp2'}),
                         '临时目录与白名单不相等/不含应返回 False')

    def test_temp_dir_in_whitelist_passes(self):
        # 实际临时副本目录落在声明的 writable_volumes 内 => 通过（Tom 10:43Z：临时目录绑定）
        self.assertTrue(M._verify_temp_in_volume('C:\\tmp\\gas_repro_iso_xxx', {'C:\\tmp'}),
                        '临时目录应被 writable_volumes 覆盖')
        self.assertTrue(M._verify_temp_in_volume('C:\\tmp', {'C:\\tmp'}),
                        '临时目录与 writable_volumes 相等应通过')

    def test_read_routes_malformed_nonempty_fails(self):
        # 反例(o·畸形非空表)：路由表非空但含畸形行（合法 hex 缺列 / 非法 hex）=> ok=False（解析异常一律拒绝）
        # Tom 10:43Z：原实现短行/非法行 continue，非空但全畸形仍可能置 ok=True。
        rt = ('Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT\n'
              'eth0 00000000 00000000 0001 0 0 0 00000000 0 0 0\n'
              'eth0 THISISNOTHEX 00000000 0001 0 0 0 00000000 0 0 0\n')
        with mock.patch.object(M.platform, 'system', return_value='Linux'), \
             mock.patch('builtins.open', mock.mock_open(read_data=rt)):
            r = M._read_routes()
        self.assertFalse(r['ok'], '畸形非空表应置 ok=False')
        self.assertTrue(r['malformed'], '应标记 malformed')


    # ===== Tom 2026-10-30 11:45Z 第四轮复审：补齐"不可读取/无法解析/未确认即 UNKNOWN 拒绝"反例 =====

    def test_policy_routing_unknown_rejects(self):
        # 反例(p·策略路由 UNKNOWN)：ip rule 缺失/失败/无 lookup => 无法独立证明策略路由=absent => 显式拒绝
        # （Tom 11:45Z：原实现 ip 缺失/失败回落 manifest 自声明 absent 放行，现改为 UNKNOWN 拒绝）
        self._mount('network=blocked\nfs_readonly=C:\\Users\\x\nwritable_volumes=C:\\tmp')
        ok, detail = M.verify_os_boundary(True, 'manifest.txt',
                                         facts=_facts(home_readonly=True, network_blocked=True,
                                                      config_available=True,
                                                      fs_ro_kernel=['C:\\Users\\x'],
                                                      all_mounts=[('C:\\tmp', False)],
                                                      routes={'ok': True, 'default_v4': False,
                                                              'default_v6': False, 'onlink_v4': set(),
                                                              'onlink_v6': set(), 'egress_v4': set(),
                                                              'egress_v6': set()},
                                                      policy_routing_unknown=True))
        self.assertFalse(ok, detail)
        self.assertIn('未知即拒绝', detail)

    def test_policy_routing_detected_still_rejects(self):
        # 反例(q·策略路由检出)：主表之外还有路由决策 => 仅核对主表无法证明完整禁网 => 拒绝（三态 detected）
        self._mount('network=blocked\nfs_readonly=C:\\Users\\x\nwritable_volumes=C:\\tmp')
        ok, detail = M.verify_os_boundary(True, 'manifest.txt',
                                         facts=_facts(home_readonly=True, network_blocked=True,
                                                      config_available=True,
                                                      fs_ro_kernel=['C:\\Users\\x'],
                                                      all_mounts=[('C:\\tmp', False)],
                                                      routes={'ok': True, 'default_v4': False,
                                                              'default_v6': False, 'onlink_v4': set(),
                                                              'onlink_v6': set(), 'egress_v4': set(),
                                                              'egress_v6': set()},
                                                      policy_routing_detected=True))
        self.assertFalse(ok, detail)
        self.assertIn('策略路由', detail)

    def test_mountinfo_malformed_rejects(self):
        # 反例(r·畸形挂载表)：内核挂载表存在无法解析的条目（短行/无分隔符/转义越界）=> 显式 UNKNOWN 拒绝
        # （Tom 11:45Z：原实现对短行/无分隔符 continue 跳过，现改为标记 malformed 拒绝）
        self._mount('network=blocked\nfs_readonly=C:\\Users\\x\nwritable_volumes=C:\\tmp')
        ok, detail = M.verify_os_boundary(True, 'manifest.txt',
                                         facts=_facts(home_readonly=True, network_blocked=True,
                                                      config_available=True,
                                                      fs_ro_kernel=['C:\\Users\\x'],
                                                      all_mounts=[('C:\\tmp', False)],
                                                      routes={'ok': True, 'default_v4': False,
                                                              'default_v6': False, 'onlink_v4': set(),
                                                              'onlink_v6': set(), 'egress_v4': set(),
                                                              'egress_v6': set()},
                                                      mountinfo_malformed=True))
        self.assertFalse(ok, detail)
        self.assertIn('无法解析', detail)

    def test_unix_socket_reachable_rejects(self):
        # 反例(s·Unix socket side-channel)：沙箱内可达危险 Unix socket（docker.sock 等）=> 隔离逃逸 => 拒绝
        # （Tom 11:45Z：两公网地址连接探针无法覆盖 Unix socket）
        self._mount('network=blocked\nfs_readonly=C:\\Users\\x\nwritable_volumes=C:\\tmp')
        ok, detail = M.verify_os_boundary(True, 'manifest.txt',
                                         facts=_facts(home_readonly=True, network_blocked=True,
                                                      config_available=True,
                                                      fs_ro_kernel=['C:\\Users\\x'],
                                                      all_mounts=[('C:\\tmp', False)],
                                                      routes={'ok': True, 'default_v4': False,
                                                              'default_v6': False, 'onlink_v4': set(),
                                                              'onlink_v6': set(), 'egress_v4': set(),
                                                              'egress_v6': set()},
                                                      unix_socket_reachable=True))
        self.assertFalse(ok, detail)
        self.assertIn('Unix socket', detail)

    def test_unescape_mountinfo_field(self):
        # 单元：mountinfo 转义反转义（Tom 11:45Z：挂载点含转义字符须反转义后比对）
        self.assertEqual(M._unescape_mountinfo_field('/vol\\040x'), '/vol x')
        self.assertEqual(M._unescape_mountinfo_field('a\\040b\\040c'), 'a b c')
        self.assertEqual(M._unescape_mountinfo_field('tab\\tend'), 'tab\tend')
        self.assertEqual(M._unescape_mountinfo_field('bs\\\\end'), 'bs\\end')
        # 转义后越界的挂载点（如 '/vol\\040x' 实为 '/vol x'）应能被真实覆盖/越界判定捕获
        self.assertEqual(M._unescape_mountinfo_field('/home\\040x'), '/home x')

    def test_escaped_mount_path_not_allowlisted(self):
        # 反例(t·转义挂载路径)：挂载点含转义空格，反转义后实为 '/vol x'，落在声明卷之外 => 拒绝
        # （Tom 11:45Z：mountinfo 转义路径须反转义后比对，否则转义可绕过覆盖/越界判定）
        self._mount('network=blocked\nfs_readonly=C:\\Users\\x\nwritable_volumes=C:\\tmp')
        ok, detail = M.verify_os_boundary(True, 'manifest.txt',
                                         facts=_facts(home_readonly=True, network_blocked=True,
                                                      config_available=True,
                                                      fs_ro_kernel=['C:\\Users\\x'],
                                                      all_mounts=[('/vol x', False), ('C:\\tmp', False)],
                                                      routes={'ok': True, 'default_v4': False,
                                                              'default_v6': False, 'onlink_v4': set(),
                                                              'onlink_v6': set(), 'egress_v4': set(),
                                                              'egress_v6': set()}))
        self.assertFalse(ok, detail)
        self.assertIn('未声明的可写挂载', detail)

    def test_malicious_symlink_escapes_volume_fails(self):
        # 反例(u·恶意软链接)：声明的 writable_volumes 为指向卷外的符号链接，临时目录经 realpath 解析后
        # 真实越出声明卷 => 拒绝（Tom 11:45Z：symlink 须按真实路径比对，不可按字符串归一放行）
        import tempfile as _tf
        base = _tf.mkdtemp(prefix='iso_symlink_')
        try:
            real_vol = os.path.join(base, 'real_volume')
            outside = os.path.join(base, 'outside')
            os.makedirs(real_vol); os.makedirs(outside)
            link = os.path.join(base, 'link_to_outside')
            try:
                os.symlink(outside, link)
            except (OSError, NotImplementedError, ValueError):
                self.skipTest('当前平台不支持创建符号链接，跳过真实 symlink 反例')
            # 声明卷为符号链接 link(指向 outside)；真实临时目录在 outside 内
            tmp_inside = os.path.join(link, 'gas_repro_iso_xxx')
            self.assertFalse(M._verify_temp_in_volume(tmp_inside, {link}),
                             '临时目录经 symlink 解析后真实越出声明卷应被拒绝')
            # 对照：真实卷内应放行
            tmp_real = os.path.join(real_vol, 'gas_repro_iso_xxx')
            self.assertTrue(M._verify_temp_in_volume(tmp_real, {real_vol}),
                            '真实卷内临时目录应放行')
        finally:
            shutil.rmtree(base, ignore_errors=True)


    # ===== Tom 2026-10-30 12:51Z 第五轮复审：main 临时目录段解包 bug + mountinfo 缺 '-' fail-closed =====

    def test_parse_sandbox_manifest_returns_claims_dict_first(self):
        # 契约守卫（Tom 12:51Z）：_parse_sandbox_manifest 返回 (claims, errors)，
        # claims 为字典（含 temp_dir/writable_volumes），errors 为列表。
        # main 临时目录段曾误写为 `_, mclaims = ...`，把 errors(列表) 当成 claims(字典) => mclaims.get 抛 AttributeError。
        # 本测试锁定"第一个返回值是字典、含 temp_dir/writable_volumes"的契约。
        text = 'network=blocked\nfs_readonly=C:\\Users\\x\nwritable_volumes=C:\\tmp\ntemp_dir=C:\\tmp'
        claims, errors = M._parse_sandbox_manifest(text)
        self.assertIsInstance(claims, dict, '第一个返回值必须是 claims 字典')
        self.assertIsInstance(errors, list, '第二个返回值必须是 errors 列表')
        self.assertEqual(claims.get('temp_dir'), os.path.normcase(os.path.normpath('C:\\tmp')),
                         'claims 应含 temp_dir（字典取值，非列表）')
        self.assertIn(os.path.normcase('C:\\tmp'), claims.get('writable_volumes', set()),
                       'claims 应含 writable_volumes（字典取值，非列表）')

    def test_mountinfo_missing_dash_malformed(self):
        # 反例(v·缺 '-' 分隔符)：挂载行 >=6 列但无 '-' 分隔符（内核挂载表畸形）=> 标记 malformed => 拒绝
        # （Tom 12:51Z：原实现 parts.index('-') 抛 ValueError 被静默 pass，畸形长行被当作合法解析）
        # 真实 mountinfo 必有 '-' 分隔符，缺之即畸形；两解析函数均须 fail-closed。
        mi = '123 456 7:8 /home/x ro,relatime shared:1 ext4 /dev/sda1 ro\n'  # 9 列，无 '-'
        with mock.patch.object(M.platform, 'system', return_value='Linux'), \
             mock.patch('builtins.open', mock.mock_open(read_data=mi)):
            ro_k, rw_d, mal1 = M._read_mountinfo_ro(['/home/x'])
            mounts, mal2 = M._read_mountinfo_all()
        self.assertTrue(mal1, '_read_mountinfo_ro 应标记 malformed（缺 - 分隔符）')
        self.assertTrue(mal2, '_read_mountinfo_all 应标记 malformed（缺 - 分隔符）')

    def test_main_temp_dir_binding_integration(self):
        # 贯穿 main() 的非生产集成测试（Tom 12:51Z：要求核临时目录实际位置与授权卷，且不抛 AttributeError）。
        # 不触碰真实生成器/生产：用哑生成器 + mock 边界前置（非 Linux 平台会在 OS 边界前置即拒绝，到不了临时目录段）
        # + mock subprocess.run（避免真实拉起解释器）。核验：main 返回 0（PASS）且临时副本被清理。
        import tempfile as _tf
        repo = _tf.mkdtemp(prefix='iso_main_repo_')
        tools_dir = os.path.join(repo, 'tools')
        os.makedirs(tools_dir)
        gen_path = os.path.join(tools_dir, M.GENERATOR)
        with open(gen_path, 'w', encoding='utf-8') as f:
            f.write('import sys\n')
            f.write('sys.exit(0)\n')  # 哑生成器：无网络/子进程导入，scan_generator 应放行
        vol_base = _tf.mkdtemp(prefix='iso_vol_')  # 声明卷 + 实际临时基目录（须存在）
        manifest_path = os.path.join(repo, 'sandbox.manifest')
        with open(manifest_path, 'w', encoding='utf-8') as f:
            f.write('network=blocked\n')
            f.write('fs_readonly=C:\\Users\\x\n')
            f.write('writable_volumes=%s\n' % vol_base)
            f.write('temp_dir=%s\n' % vol_base)
        fake_run = mock.MagicMock(returncode=0, stdout='', stderr='')
        try:
            with mock.patch.object(M, 'verify_os_boundary', return_value=(True, 'mock boundary ok')), \
                 mock.patch.object(M.subprocess, 'run', return_value=fake_run):
                rc = M.main([repo, '--sandbox-verified', '--sandbox-manifest', manifest_path])
            self.assertEqual(rc, 0, 'main 应贯穿临时目录绑定并 PASS（非生产哑生成器），不应抛 AttributeError')
            leaked = [n for n in os.listdir(vol_base) if n.startswith('gas_repro_iso_')]
            self.assertEqual(leaked, [], '临时副本应被清理，不应遗留 gas_repro_iso_ 目录')
        finally:
            shutil.rmtree(repo, ignore_errors=True)
            shutil.rmtree(vol_base, ignore_errors=True)


if __name__ == '__main__':
    unittest.main(verbosity=2)
