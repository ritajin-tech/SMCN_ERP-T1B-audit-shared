# -*- coding: utf-8 -*-
"""
R 批只读复现脚本（回应 Tom 本轮二·S2）：演示 `scan_code_for_exec_write` 的【写 API 覆盖】。

🔴 修正（回应 Tom 本轮二·S2）：原实现用 `importlib.util.spec_from_file_location` +
`spec.loader.exec_module(mod)` 导入校验器模块——这会【执行】校验器模块的【顶层语句】
（`if __name__ == '__main__'` 只能阻止 main() 自动运行，不能让导入变成"零执行"）。
因此原脚本不能被描述为"零代码执行证明"。

本修正：不导入 / 不执行校验器模块顶层。改为【仅用 AST】提取 `scan_code_for_exec_write`
这一个纯函数定义（它自身不依赖模块顶层状态，只用到标准库 `re`），在独立空命名空间里
编译并执行【该函数定义本身】（不执行任何其它顶层语句），随后调用它。这是真正"不执行
校验器模块顶层"的做法；且本脚本只读取校验器源码、不写任何文件（stdout 除外）。
若未来需要真正运行校验器 / harness，应由操作系统强制隔离（独立低权限身份 / 容器 / 沙箱、
禁网）提供边界，而非声称"导入即零执行"。

结论口径（与校验器一致）：扫描【不是】零写证明，只是辅助哨兵；漏检路径由人工复核兜底。
"""
import ast
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
VERIFIER = os.path.join(HERE, 'verify_gas_single_source.py')


def load_scan_fn():
    """仅用 AST 提取 `scan_code_for_exec_write` 的纯函数定义，在独立命名空间编译执行之；
    绝不执行校验器模块的任何顶层语句。"""
    src = open(VERIFIER, encoding='utf-8').read()
    tree = ast.parse(src)
    target = None
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == 'scan_code_for_exec_write':
            target = node
            break
    if target is None:
        raise RuntimeError('scan_code_for_exec_write 未在校验器源码中找到')
    mod = ast.Module([target], [])
    ast.fix_missing_locations(mod)
    ns = {'re': re}
    exec(compile(mod, VERIFIER, 'exec'), ns)
    return ns['scan_code_for_exec_write']


def main():
    scan = load_scan_fn()

    # 负例：每个都应被扫描识别为"含写/执行构造"
    negatives = [
        ('pathlib.Path.write_bytes', "import pathlib\np = pathlib.Path('/tmp/x')\np.write_bytes(b'data')"),
        ('pathlib.Path.write_text', "import pathlib\npathlib.Path('/tmp/x').write_text('y')"),
        ('open 写模式 w', "open('/tmp/x', 'w').write('y')"),
        ('open 写模式 wb', "with open('/tmp/x','wb') as f:\n    f.write(b'z')"),
        ('io.open 写模式', "import io\nio.open('/tmp/x', 'w').write('y')"),
        ('os.write', "import os\nos.write(fd, b'data')"),
        ('文件对象 .write', "f = open('/tmp/x','rb')\nf.write(b'data')"),
    ]

    # 良性：不应命中任何写/执行构造
    benign = "x = 1\ny = 'hello world'\nprint(x)\nfoo = lambda a: a + 1\nz = [i for i in range(3)]\nf = open('/tmp/x', 'rb')\nd = f.read()"

    failures = []
    for name, snippet in negatives:
        ok, hits = scan(snippet)
        if ok:
            failures.append('负例未识别: %s（hits=%s）' % (name, hits))
        else:
            print('  [负例命中] %-28s hits=%s' % (name, list(hits.keys())))

    b_ok, b_hits = scan(benign)
    if not b_ok:
        failures.append('良性误报: %s' % b_hits)
    else:
        print('  [良性通过] 只读 open/读 API 不误报（hits 为空）')

    # 🔴 已知盲点演示（正是 Tom 本轮二·S2 的核心论点）：denylist 无法识别别名调用形态
    #    `w = io.open; w(path,'w')` 不会被"open( 写模式"模式捕获——这证明本扫描【不是】零写证明。
    blind = "import io\nw = io.open\nw('/tmp/x', 'w')"
    blind_ok, blind_hits = scan(blind)
    if blind_ok:
        print('  [已知盲点·符合预期] 别名写调用 w = io.open; w(path,\'w\') 未被 denylist 捕获'
              '（证明扫描非完整证明，漏检由人工复核兜底）')
    else:
        failures.append('盲点演示异常: 别名写调用竟被捕获 %s' % blind_hits)

    if failures:
        print('FAIL: %d 项' % len(failures))
        for f in failures:
            print('  - %s' % f)
        return 1
    print('PASS: 写 API 覆盖 %d 种形态 + 只读不误报 + 别名盲点已显式演示'
          '（有限 denylist 扫描，非零写证明）' % len(negatives))
    return 0


if __name__ == '__main__':
    sys.exit(main())
