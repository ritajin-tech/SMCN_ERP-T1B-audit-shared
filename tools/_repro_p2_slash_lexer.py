# -*- coding: utf-8 -*-
"""一键复现：Tom 2026-10-28 18:50Z 一（P1）的斜杠词法误判，以及 P1 前后的对照。

用法：  python tools/_repro_p2_slash_lexer.py
只读、零执行待审代码：只做纯文本词法扫描（新实现直接 import 校验器的模块级 _js_mask；
旧实现以「历史副本」形式内嵌于本文件，仅供对照，不参与任何判定）。

输出三段：
  A. 旧实现（字符级启发式 prev_sig）对 Tom 反例 / 正例的分类
  B. 新实现（记号级 prev = value/operator）对同一批输入的分类
  C. 结论：旧实现在 Tom 反例上是否掩掉真实代码、在正例上是否吃掉真实代码
"""

import io
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from verify_gas_single_source import _js_mask as new_mask   # noqa: E402


# ------------------------------------------------------------------
# 旧实现【历史副本 · 仅供对照】：O 批（Tom 17:49Z 二 之后）的 _js_mask
# 判定依据：上一个非空白【字符】是否在 '_$)]}' 或字母数字 → 否则当作正则起始
# ------------------------------------------------------------------
def old_mask(s, mask_strings=True):
    out = list(s)
    unsupported = []
    i, n = 0, len(s)
    prev_sig = ''

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


TOKEN = 'return tsSoftDelGuarded('

CASES = [
    ('Tom 18:50Z 反例 · 单行（e++ 后除法）',
     'setup: function(e) { e++ / (function() { return {shadow: function(x) { return tsSoftDelGuarded(x); }}; })().shadow(e) / 3; },'),
    ('Tom 18:50Z 反例 · 多行（同一攻击的换行形态）',
     'setup: function(e) {\n  e++ / (function() {\n    return {shadow: function(x) { return tsSoftDelGuarded(x); }};\n  })().shadow(e) / 3;\n},'),
    ('正例 · 后置 ++ 除法',
     'setup: function(e) { var n = e.n++ / 2; var m = 4 / 2; return n + m; },'),
    ('正例 · 真实正则字面量',
     'setup: function(e) { var re = /return tsSoftDelGuarded\\(/; return re.test(String(e)); },'),
]


def show(title, fn):
    print('===== %s =====' % title)
    for label, snip in CASES:
        m, u = fn(snip, mask_strings=True)
        print('  %-34s 掩码后 %s 出现 %d 次   unsupported=%s'
              % (label, TOKEN, m.count(TOKEN), u or '[]'))
        blanked = (m.replace('\n', '') != snip.replace('\n', ''))
        if '正例 · 后置' in label:
            print('      真实代码是否仍保留 "var m = 4 / 2;"：%s'
                  % ('YES' if 'var m = 4 / 2;' in m else 'NO ← 真实代码被吃掉'))
        if '反例' in label:
            print('      真实 IIFE 是否被掩掉（导致计数不增、校验放行）：%s'
                  % ('YES ← 漏报' if m.count(TOKEN) == 0 else 'NO'))
    print()


def main():
    print('一键复现：Tom 2026-10-28 18:50Z 一 · 斜杠词法分类（只读，零执行）\n')
    show('A. 旧实现（字符级启发式 prev_sig）', old_mask)
    show('B. 新实现（记号级 prev = value / operator）', new_mask)
    print('===== C. 结论 =====')
    om, _ = old_mask(CASES[0][1], mask_strings=True)
    nm, _ = new_mask(CASES[0][1], mask_strings=True)
    print('  Tom 单行反例：旧实现掩掉真实调用=%s → 计数 %d（校验放行）；新实现=%s → 计数 %d（fail-closed）'
          % (om.count(TOKEN) == 0, om.count(TOKEN), nm.count(TOKEN) == 0, nm.count(TOKEN)))
    om2, _ = old_mask(CASES[2][1], mask_strings=True)
    nm2, _ = new_mask(CASES[2][1], mask_strings=True)
    print('  合法 postfix 除法：旧实现吃掉真实代码=%s；新实现保留真实代码=%s'
          % ('var m = 4 / 2;' not in om2, 'var m = 4 / 2;' in nm2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
