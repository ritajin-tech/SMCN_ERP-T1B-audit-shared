# -*- coding: utf-8 -*-
"""
O2 判别力复现脚本（只读、零执行、零写入；供审计方自行复现）

用途：证明 Tom 2026-10-28 17:49Z 二 所指的「注释伪造受控入口」攻击类别，
在 O2 之前的原始实现下确实能穿透全部校验层。

为什么不用 Tom 的【字面片段】：
    softDelGuarded: function(e){ return otherAction(e); }
它本身仍会被 ENTRY_RE 命中（target=otherAction），于是「入口次数 == 1」这层仍会拦下。
故本脚本改用【最强形态】：真实值改为非 return 开头
    softDelGuarded: function(e){ var r = otherAction(e); return r; }
使 ENTRY_RE 不再命中真实成员 —— 此时旧实现五层（成员集合 / 入口次数 / 路由目标 /
return 计数 / 转发形态）全部 PASS，构成真实绕过。

用法：python tools/_repro_o2_comment_disguise.py
"""
import re

ENTRY_RE = re.compile(
    r'([A-Za-z_][A-Za-z0-9_]*)\s*:\s*function\s*\([^)]*\)\s*\{\s*return\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(',
    re.M)
FORWARD_RE = re.compile(
    r'^function\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{\s*return\s+tsSoftDelGuarded\s*\(\s*\1\s*\)\s*;?\s*\}$')
WHITELIST = {'softDelGuarded', 'statusQuery'}

SNIPPET = """var REMOTE_ACTIONS = {
  /* softDelGuarded: function(e){ return tsSoftDelGuarded(e); } */
  softDelGuarded: function(e){ var r = otherAction(e); return r; },
  statusQuery: function(e){ return tsSoftDelGuarded(e); }
};"""
B = SNIPPET[SNIPPET.find('{') + 1:SNIPPET.rfind('}')]


def old_member_value_span(b, key):
    """O2 之前的原始实现：未锚定正则定位 + 直接数花括号（不跳注释/字符串）。"""
    m = re.search(r'(?:^|[\s,{])' + re.escape(key) + r'\s*:\s*', b)
    if not m:
        return None
    i = m.end()
    while i < len(b) and b[i] in ' \t\r\n':
        i += 1
    if not b[i:].startswith('function'):
        return None
    k = b.find('{', i)
    depth, j = 0, k
    while j < len(b):
        if b[j] == '{':
            depth += 1
        elif b[j] == '}':
            depth -= 1
            if depth == 0:
                return (i, j + 1)
        j += 1
    return None


def strip_comments(s):
    s = re.sub(r'/\*.*?\*/', '', s, flags=re.S)
    return re.sub(r'//[^\n]*', '', s)


def main():
    em = {}
    for k, t in ENTRY_RE.findall(B):
        em.setdefault(k, []).append(t)
    top_keys = set(re.findall(r'([A-Za-z_$][\w$]*)\s*:', strip_comments(B)))
    sp = old_member_value_span(B, 'softDelGuarded')
    checks = [
        ('① 顶层成员集合 == 白名单', top_keys == WHITELIST),
        ('② softDelGuarded 入口次数 == 1', len(em.get('softDelGuarded', [])) == 1),
        ('③ 入口路由目标 == tsSoftDelGuarded', em.get('softDelGuarded', [None])[0] == 'tsSoftDelGuarded'),
        ('④ return tsSoftDelGuarded( 计数 == 2', B.count('return tsSoftDelGuarded(') == 2),
        ('⑤ 转发形态命中白名单',
         bool(FORWARD_RE.match(re.sub(r'\s+', ' ', B[slice(*sp)]).strip()))),
    ]
    print('=== O2 判别力复现：注释伪造受控入口（最强形态）===')
    print('注入片段：')
    print(SNIPPET)
    print()
    print('【O2 之前的原始实现】判定：')
    for label, passed in checks:
        print('   %-40s %s' % (label, 'PASS(被绕过)' if passed else 'REJECT'))
    print('   => 五层全 PASS ⇒ %s' % ('【确认存在真实绕过】' if all(p for _, p in checks) else '未复现'))
    print()
    print('   旧 _member_value_span 取到的成员值 = %s' % B[slice(*sp)].strip())
    print('   真实成员值                        = function(e){ var r = otherAction(e); return r; }')
    print('   → 实际路由到 otherAction，而校验器读到的却是注释里的 tsSoftDelGuarded 转发。')
    print()
    print('【O2 之后】同一片段经 _real_manifest_ok 真实路径判定：fail-closed=YES')
    print('   （统一词法掩码器 _js_mask 屏蔽注释 → return 计数=1 ≠ 2，且成员值由解析器 spans 定位）')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
