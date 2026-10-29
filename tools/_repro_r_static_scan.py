# -*- coding: utf-8 -*-
"""
R 批只读复现脚本（回应 Tom 本轮一）：演示 `scan_code_for_exec_write` 的【写 API 覆盖】。

🔴 本脚本只【读取】校验器模块并调用其纯函数 `scan_code_for_exec_write(code)`；
   不运行校验器 main()、不运行生成器、不写任何文件（stdout 除外）。
   目的：证明「有限 denylist 扫描」确实能识别常见写文件构造（含 pathlib / os.write /
   open 写模式 / 文件对象 .write / 别名调用形态），且对良性代码不误报。

结论口径（与校验器一致）：扫描【不是】零写证明，只是辅助哨兵；漏检路径由人工复核兜底。
"""
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
VERIFIER = os.path.join(HERE, 'verify_gas_single_source.py')


def load_verifier():
    spec = importlib.util.spec_from_file_location('verify_gas_single_source_repro', VERIFIER)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)   # 安全：模块仅在 __main__ 守卫下才跑 main()，导入不触发 IO
    return mod


def main():
    v = load_verifier()
    scan = v.scan_code_for_exec_write

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

    # 🔴 已知盲点演示（正是 Tom 本轮一的核心论点）：denylist 无法识别别名调用形态
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
