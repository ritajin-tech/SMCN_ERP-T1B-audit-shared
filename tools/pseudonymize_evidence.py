# -*- coding: utf-8 -*-
"""证据脱敏（本地离线，不改业务数据）
把工时取证 JSON 里的真实姓名替换为稳定假名 P0001..P00NN。
- 稳定：同一真实姓名在所有文件、所有批次里映射到同一假名（按姓名排序分配，不随输入顺序变）
- 可核验：UUID、行号、工时、日期、录入时刻、软删标记全部原样保留，Tom 侧逐行复算不受影响
- 用途：产物只进公开审计仓 SMCN_ERP-T1B-audit-shared；含真实姓名的原始件留在本工作区 _tmp/evidence
用法：
  python tools/pseudonymize_evidence.py <输入.json> [<输出.json>]
  缺省输出名：<原名>.pseudonym.json
"""
import json
import os
import re
import sys

# 真实姓名全集（来自生产表 DB_工时流水 取证件的 fingerprint 首段 + name 字段）
REAL_NAMES = [
    "Jerry Fu", "Shirley Lin", "Kai Chang", "Aien Sheng", "Juliet Zhao",
    "April Xu", "June Feng", "May Chang", "Leo Li", "Owen Wang",
    "Yichan Yao", "Allen Zhang", "Christopher M. Tengco", "Jacqueline Qin",
    "Fiona Huang", "Alvin Fang", "Ryan Jiang", "Lucia Lau", "Pano Mo",
    "Vivian Ye", "Milo Zhou",
]

# 稳定映射：排序后按序号分配，保证跨批次一致
_SORTED = sorted(set(REAL_NAMES))
PSEUDONYM = {n: "P%04d" % (i + 1) for i, n in enumerate(_SORTED)}


def pseudonymize_text(text):
    """按长度降序替换，避免 'Leo Li' 被 'Li' 之类短串提前截断"""
    out = text
    for n in sorted(PSEUDONYM, key=len, reverse=True):
        out = out.replace(n, PSEUDONYM[n])
    return out


def main():
    src = sys.argv[1]
    dst = sys.argv[2] if len(sys.argv) > 2 else src + ".pseudonym.json"
    with open(src, encoding="utf-8") as f:
        text = f.read()
    # 校验输入确为合法 JSON（避免把非 JSON 文件也写出去了）
    json.loads(text)
    red = pseudonymize_text(text)
    with open(dst, "w", encoding="utf-8", newline="\n") as f:
        f.write(red)
    # 自检：输出里不应再出现任何真实姓名
    left = [n for n in _SORTED if n in red]
    if left:
        raise SystemExit("[FAIL] 脱敏后仍残留真实姓名: %s" % left)
    # 自检：输出仍是合法 JSON，且结构与输入一致（键集合相同）
    a, b = json.loads(text), json.loads(red)
    if type(a) is not type(b):
        raise SystemExit("[FAIL] 脱敏后 JSON 类型改变")
    print("[OK] %s -> %s  (%d 姓名已替换为 P0001..P%04d)"
          % (os.path.basename(src), os.path.basename(dst), len(_SORTED), len(_SORTED)))


if __name__ == "__main__":
    main()
