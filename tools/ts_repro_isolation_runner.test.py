# -*- coding: utf-8 -*-
# ts_repro_isolation_runner.py 独立单测（Tom W 批·点①：OS 隔离边界 fail-closed，无静默通过）。
import os
import sys
import io
import unittest
from unittest import mock

import ts_repro_isolation_runner as M


class TestVerifyOsBoundary(unittest.TestCase):
    def _manifest(self, exists=True, text='container: read-only rootfs + network namespace'):
        m = mock.patch.object(M.os.path, 'isfile', return_value=exists)
        mm = mock.patch('builtins.open', mock.mock_open(read_data=text))
        m.start(); mm.start()
        self.addCleanup(m.stop); self.addCleanup(mm.stop)

    def test_no_manifest_fails(self):
        # 即便显式声明，无 manifest 也拒绝（不凭自声明放行）
        ok, detail = M.verify_os_boundary(True, None)
        self.assertFalse(ok, detail)
        self.assertIn('manifest', detail)

    def test_manifest_but_writable_home_fails(self):
        # manifest 存在，但家目录可写、非容器 => 无运行时边界证据 => 失败关闭（不静默通过）
        self._manifest(exists=True)
        fake_home = 'C:\\Users\\x'
        with mock.patch.object(M.os.path, 'expanduser', return_value=fake_home), \
             mock.patch.object(M.os.path, 'isdir', return_value=True), \
             mock.patch.object(M.os, 'access', return_value=True), \
             mock.patch.object(M.platform, 'system', return_value='Windows'), \
             mock.patch.object(M, '_linux_container_evidence', return_value=None), \
             mock.patch.object(M, '_probe_network_blocked', return_value=True):
            ok, detail = M.verify_os_boundary(True, 'manifest.txt')
        self.assertFalse(ok, detail)
        self.assertIn('未检出', detail)

    def test_manifest_and_readonly_home_passes(self):
        # manifest 存在 + 家目录只读(os.access W_OK=False) => 运行时边界证据成立 => 放行
        self._manifest(exists=True)
        fake_home = 'C:\\Users\\x'
        def access_side(p, mode):
            # 家目录只读 => 对 home 返回 False；其余返回 True
            return p != fake_home
        with mock.patch.object(M.os.path, 'expanduser', return_value=fake_home), \
             mock.patch.object(M.os.path, 'isdir', return_value=True), \
             mock.patch.object(M.os, 'access', side_effect=access_side), \
             mock.patch.object(M.platform, 'system', return_value='Windows'), \
             mock.patch.object(M, '_linux_container_evidence', return_value=None), \
             mock.patch.object(M, '_probe_network_blocked', return_value=False):
            ok, detail = M.verify_os_boundary(True, 'manifest.txt')
        self.assertTrue(ok, detail)
        self.assertIn('家目录只读', detail)

    def test_linux_container_evidence(self):
        # 模拟 Linux + 容器 cgroup => 证据成立
        with mock.patch.object(M.platform, 'system', return_value='Linux'), \
             mock.patch('builtins.open', mock.mock_open(read_data='12:cpu:/docker/abc')):
            ev = M._linux_container_evidence()
        self.assertIsNotNone(ev)
        self.assertIn('cgroup', ev)

    def test_linux_capability_reduced(self):
        # 模拟 Linux + 能力集缩减(CapEff 低位) => 证据成立
        status = 'Name:\tpython\nCapEff:\t0000000000000001\n'
        with mock.patch.object(M.platform, 'system', return_value='Linux'), \
             mock.patch('builtins.open', mock.mock_open(read_data=status)):
            ev = M._linux_container_evidence()
        self.assertIsNotNone(ev)
        self.assertIn('能力集', ev)


if __name__ == '__main__':
    unittest.main(verbosity=2)
