# -*- coding: utf-8 -*-
"""Q 批复现脚本：验证 dispatch 区域的词法配置（slash_fail_closed + reject_template）。

独立复跑：python tools/_repro_q_lexer.py
对应 Tom 本轮一/二；与 tools/verify_gas_single_source.py 的断言7 单元级一致。

🔴 仅加载待测模块的【函数定义】，不触发其 main()（受 `if __name__== '__main__'` 保护）。
这是审阅方在【自有沙箱】中运行的复现脚本，不是校验器本身 —— 校验器自身零执行、零写。
"""
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location(
    'v', os.path.join(HERE, 'verify_gas_single_source.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

# (label, snippet, want_fail_closed)
cases = [
    ('普通字符串含斜线 → 不 fail-closed', 'function(e){ return "a/b"; }', False),
    ('行注释含斜线 → 不 fail-closed', 'function(e){ /* a/b */ return 1; }', False),
    ('裸除法 → fail-closed', 'var n = a / b;', True),
    ('裸正则 → fail-closed', 'var re = /a/;', True),
    ('后置 ++ 裸除法 → fail-closed', 'a++ / 2;', True),
    ('模板插值含调用 → fail-closed', 'var x = `${f()}`;', True),
    ('空模板 → fail-closed', 'var x = ``;', True),
]

all_ok = True
print('=== Q 批复现：dispatch 区域词法（slash_fail_closed + reject_template）===')
for label, snip, want_unsup in cases:
    _m, _u = m._js_mask(snip, mask_strings=True, slash_fail_closed=True, reject_template=True)
    got = bool(_u)
    ok = (got == want_unsup)
    all_ok = all_ok and ok
    print('  [%s] fail-closed=%s (期望=%s) %s'
          % (label, 'YES' if got else 'NO', 'YES' if want_unsup else 'NO',
             '' if ok else '  ← 不符'))
print('=== %s ===' % ('PASS' if all_ok else 'FAIL'))
sys.exit(0 if all_ok else 1)
