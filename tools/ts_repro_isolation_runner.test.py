# -*- coding: utf-8 -*-
# ts_repro_isolation_runner.py 独立单测（Tom X 批·一：OS 隔离边界诚实 fail-closed，
# 要求【文件/挂载只读(绑定 home/cwd)】与【网络隔离】两项策略【同时】被运行时证据证实；
# 容器名称/能力集缩减仅作佐证，绝不作为放行依据；不静默通过）。
import os
import sys
import unittest
from unittest import mock

import ts_repro_isolation_runner as M


def _facts(home='C:\\Users\\x', cwd='C:\\repo', home_readonly=True, cwd_readonly=False,
           network_blocked=True, container_ev=None, extra_readonly=None, extra_writable=None):
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
    return {'home': home, 'cwd': cwd, 'readonly_paths': ro,
            'writable_claimed_paths': wr, 'network_blocked': network_blocked,
            'container_ev': container_ev}


class TestVerifyOsBoundary(unittest.TestCase):
    def _mount(self, manifest_text):
        m = mock.patch.object(M.os.path, 'isfile', return_value=True)
        mm = mock.patch('builtins.open', mock.mock_open(read_data=manifest_text))
        m.start(); mm.start()
        self.addCleanup(m.stop); self.addCleanup(mm.stop)

    def test_no_flag_fails(self):
        # 未提供 --sandbox-verified => 拒绝（不凭自声明放行）
        ok, detail = M.verify_os_boundary(False, 'manifest.txt', facts=_facts())
        self.assertFalse(ok, detail)
        self.assertIn('sandbox-verified', detail)

    def test_no_manifest_fails(self):
        ok, detail = M.verify_os_boundary(True, None, facts=_facts())
        self.assertFalse(ok, detail)

    def test_manifest_empty_fails(self):
        # manifest 文件存在但为空 => 解析失败
        self._mount('')
        ok, detail = M.verify_os_boundary(True, 'manifest.txt', facts=_facts())
        self.assertFalse(ok, detail)
        self.assertIn('空', detail)

    def test_manifest_prose_only_fails(self):
        # 只有散文、无 key=value 机器可校验声明 => 解析失败（真实性不能只留在注释/散文）
        self._mount('container: read-only rootfs + network namespace')
        ok, detail = M.verify_os_boundary(True, 'manifest.txt', facts=_facts())
        self.assertFalse(ok, detail)
        self.assertIn('未显式声明', detail)

    def test_manifest_but_home_writable_fails(self):
        # W 批逻辑曾因 /etc 不可写即放行；本例 manifest 仅声明 /etc 只读（非用户相关路径），
        # 家目录实际可写 => 仍拒绝（未绑定 home/cwd）。
        self._mount('network=blocked\nfs_readonly=C:\\Windows')
        ok, detail = M.verify_os_boundary(True, 'manifest.txt',
                                         facts=_facts(home_readonly=False))
        self.assertFalse(ok, detail)
        self.assertIn('家目录或 cwd', detail)

    def test_pass_home_readonly_and_network_blocked(self):
        # 两项策略同时成立：manifest 声明 network=blocked + fs_readonly=<home>，运行时 home 只读且网络不可达 => 放行
        self._mount('network=blocked\nfs_readonly=C:\\Users\\x')
        ok, detail = M.verify_os_boundary(True, 'manifest.txt',
                                         facts=_facts(home_readonly=True, network_blocked=True))
        self.assertTrue(ok, detail)
        self.assertIn('两项策略均经运行时证据证实', detail)
        self.assertIn('boundary-digest=', detail)

    def test_readonly_home_but_network_allowed_fails(self):
        # 家目录只读但网络可达 => 网络隔离未证实 => 拒绝（Tom X 批·一：两项须同时）
        self._mount('network=blocked\nfs_readonly=C:\\Users\\x')
        ok, detail = M.verify_os_boundary(True, 'manifest.txt',
                                         facts=_facts(home_readonly=True, network_blocked=False))
        self.assertFalse(ok, detail)
        self.assertIn('网络隔离未证实', detail)

    def test_container_but_host_writable_fails(self):
        # 容器/cgroup 证据存在，但声明的 home 实际可写 => 文件系统只读矛盾 => 拒绝；
        # 容器证据不得替代用户侧写入阻断。
        self._mount('network=blocked\nfs_readonly=C:\\Users\\x')
        ok, detail = M.verify_os_boundary(True, 'manifest.txt',
                                         facts=_facts(home_readonly=False,
                                                     container_ev='cgroup 含容器运行时证据'))
        self.assertFalse(ok, detail)
        self.assertIn('文件系统只读矛盾', detail)

    def test_container_evidence_alone_not_sufficient(self):
        # 仅有容器证据、manifest 只声明系统目录只读(非 home/cwd)、家目录可写 => 拒绝；
        # 证明容器名称/CapEff 不能单独授权。
        self._mount('network=blocked\nfs_readonly=C:\\Windows')
        ok, detail = M.verify_os_boundary(True, 'manifest.txt',
                                         facts=_facts(home_readonly=False,
                                                     container_ev='进程能力集(CapEff)已缩减'))
        self.assertFalse(ok, detail)

    def test_arbitrary_nonempty_manifest_fails(self):
        # 任意非空但无机器可校验声明的 manifest => 解析失败（Tom X 批·一 反例）
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


if __name__ == '__main__':
    unittest.main(verbosity=2)
