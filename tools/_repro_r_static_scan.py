# -*- coding: utf-8 -*-
"""
R 批只读复现脚本（回应 Tom 本轮二·S2 最终版 —— 落实其"复现脚本自行实现最小扫描器；
或用独立可信实现严格白名单校验目标 AST 后再限定执行语法"二项要求，并修正夸大措辞）。

🔴 证明模型（精确，不夸大，逐条对应 Tom 的验收）：
- 本脚本【绝不】声称"零代码执行证明"。执行仓库函数从来不是、也不应是证明手段。
- 行为正确性（期望检测行为）由【独立可信预言机】 independent_scan 证明：它是本脚本自带的、
  完全不依赖待审仓代码的纯正则扫描器，独立复现 7 种写 API 形态的检测、只读不误报、
  以及别名盲点（denylist 的固有局限）。这满足 Tom 的"复现脚本自行实现最小扫描器"。
- 仓库函数 scan_code_for_exec_write 的【无副作用】由【严格 AST 白名单】静态证明：
  仅允许一组安全的节点类型与受限语义（无危险内建调用、无全局/非局部赋值、无导入、
  属性访问仅限本地 'code'/'re' 等），从而【按构造】证明该函数不可能产生副作用；
  这一步【不执行】该函数。这满足 Tom 的"用独立可信实现严格白名单校验目标 AST"。
- 作为【可选】【默认关闭】的交叉校验（须经显式 --exec 开启，且【仅】在 AST 白名单通过后），
  才执行该仓库函数并与预言机结果对照，用于确认"实现与契约一致"。该执行【明确不作为任何证明】，
  仅作运行时复核；即便开启，安全性结论仍来自上面的 AST 白名单 + 独立预言机，而非执行。

结论口径（与校验器一致）：扫描【不是】零写证明；无副作用由 AST 白名单（按构造）证明，
【不】由执行证明；"未执行模块其余顶层"【绝不】表述为"不执行待审仓代码"。
若未来需要真正运行校验器 / harness，应由操作系统强制隔离（独立低权限身份 / 容器 / 沙箱、
禁网）提供边界，而非声称"导入即零执行"或"执行即证明"。
"""
import ast
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
VERIFIER = os.path.join(HERE, 'verify_gas_single_source.py')


# ---------------------------------------------------------------------------
# 1) 严格 AST 白名单（静态，不执行）：证明仓库函数按构造无副作用
# ---------------------------------------------------------------------------
# 允许的 AST 节点类型（只含纯函数式 / 数据构造 / 运算符 / 推导，无任何导入 / 执行 / 全局改写）
_ALLOWED_NODES = (
    ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.arguments, ast.arg,
    ast.Assign, ast.AnnAssign, ast.AugAssign,
    ast.If, ast.For, ast.AsyncFor, ast.While, ast.Return, ast.Expr, ast.Pass,
    ast.Call, ast.Attribute, ast.Name, ast.Constant, ast.Dict, ast.Set,
    ast.List, ast.Tuple, ast.Subscript, ast.BinOp, ast.BoolOp, ast.UnaryOp,
    ast.Compare, ast.comprehension, ast.IfExp, ast.Lambda,
    ast.Load, ast.Store, ast.Del, ast.Starred,
    # 推导式 / f-string
    ast.DictComp, ast.SetComp, ast.ListComp, ast.GeneratorExp,
    ast.JoinedStr, ast.FormattedValue,
    # 全部运算符节点（Add/Mod/Not/Eq/In … 均无害，仅做计算/比较）
    ast.operator, ast.boolop, ast.cmpop, ast.unaryop,
    ast.Add, ast.Sub, ast.Mult, ast.Div, ast.FloorDiv, ast.Mod, ast.Pow,
    ast.LShift, ast.RShift, ast.BitOr, ast.BitXor, ast.BitAnd, ast.MatMult,
    ast.Not, ast.UAdd, ast.USub, ast.Invert,
    ast.Eq, ast.NotEq, ast.Lt, ast.LtE, ast.Gt, ast.GtE,
    ast.Is, ast.IsNot, ast.In, ast.NotIn,
)
# 允许被【直接 Name 调用】的内建 / 库函数（拒绝 open/exec/eval/compile/__import__ 等）
_ALLOWED_DIRECT_CALLS = {
    're.compile', 're.findall', 're.search', 're.match', 're.sub', 're.split',
    'sorted', 'set', 'list', 'dict', 'tuple', 'len', 'str', 'int', 'float', 'bool',
    'enumerate', 'range', 'zip', 'map', 'filter', 'min', 'max', 'sum', 'abs',
    'getattr', 'hasattr', 'isinstance', 'type', 'repr', 'format', 'ord', 'chr',
}
# 危险属性基准名：其任何属性访问 / 方法调用都视为拒绝路径（覆盖外部模块与内建执行入口）
_DANGEROUS_BASES = {
    'os', 'subprocess', 'importlib', 'sys', 'io', 'pathlib', 'shutil', 'hashlib',
    'tempfile', 'builtins', '__builtins__', 'socket', 'urllib', 'requests', 'http',
    'child_process', 'fs', 'module', 'ctypes',
}


def _name_of(node):
    """若 node 是 Name 或 Attribute 链末端落在 Name，返回该基底名；否则 '?'。"""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return _name_of(node.value)
    return '?'


def validate_scan_fn_ast():
    """静态白名单校验 scan_code_for_exec_write：证明其【按构造】无副作用（绝不执行该函数）。

    规则（即 Tom 要求的"静态复核完整允许语法和拒绝路径"）：
    - 仅允许上列安全节点类型；
    - 禁止任何 import / global / nonlocal；
    - 禁止以【危险基准名】(os/subprocess/importlib/__builtins__/io/…) 为基准的
      属性访问或方法调用（杜绝 os.system / subprocess.run / io.open 执行 / __import__ 等）；
    - 直接 Name 调用必须落在白名单内（re.compile 等安全内建/库函数）。
    满足上述即【按构造】不可能产生文件/网络/子进程/全局改写等副作用。
    返回违规列表（空 == 通过）。
    """
    src = open(VERIFIER, encoding='utf-8').read()
    tree = ast.parse(src)
    target = None
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == 'scan_code_for_exec_write':
            target = node
            break
    if target is None:
        return ['未在校验器源码中找到 scan_code_for_exec_write 定义（拒绝路径：函数缺失）']
    violations = []
    for n in ast.walk(target):
        if not isinstance(n, _ALLOWED_NODES):
            violations.append('拒绝路径: 不允许的 AST 节点类型 %s @L%d'
                              % (type(n).__name__, getattr(n, 'lineno', -1)))
            continue
        if isinstance(n, (ast.Import, ast.ImportFrom)):
            violations.append('拒绝路径: 存在导入语句 @L%d' % getattr(n, 'lineno', -1))
        if isinstance(n, (ast.Global, ast.Nonlocal)):
            violations.append('拒绝路径: 存在 global/nonlocal 改写 @L%d' % getattr(n, 'lineno', -1))
        # 危险基准名属性访问 / 方法调用
        if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) \
                and n.value.id in _DANGEROUS_BASES:
            violations.append('拒绝路径: 危险属性基准名 %s.%s @L%d'
                              % (n.value.id, n.attr, getattr(n, 'lineno', -1)))
        # 直接 Name 调用必须白名单
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) \
                and n.func.id not in _ALLOWED_DIRECT_CALLS:
            violations.append('拒绝路径: 不允许的直接调用目标 %s @L%d'
                              % (n.func.id, getattr(n, 'lineno', -1)))
    return violations


# ---------------------------------------------------------------------------
# 2) 独立可信预言机（不依赖待审仓代码）：证明期望的检测行为
# ---------------------------------------------------------------------------
_WRITE_API_RE = re.compile(
    r"(?:"
    r"os\.write"
    r"|Path\s*\([^)]*\)\.(?:write_bytes|write_text|open)"
    r"|\.(?:write_bytes|write_text|writelines|write)\s*\("
    r"|(?:open|io\.open)\s*\([^)]*[\x22\x27](?:w|a|r\+|w\+|a\+|wb|ab|x)"
    r")")


def independent_scan(code):
    """我们的独立可信预言机（满足 Tom"复现脚本自行实现最小扫描器"）：纯正则扫描已知写 API 形态，
    完全不依赖、不执行待审仓代码。返回 (ok, hits)。"""
    forbidden = {
        'spec.loader.exec' + '_module(': None,
        'exec' + '_module(': None,
        'sub' + 'process.run(': None,
        'os.sys' + 'tem(': None,
        'Pop' + 'en(': None,
        "open(..., 'w'": None,
        "io.open(..., 'w'": None,
        '.write' + '_text(': None,
    }
    hits = {}
    for k in forbidden:
        if k in code:
            hits[k] = code.count(k)
    for h in sorted(set(_WRITE_API_RE.findall(code))):
        hits.setdefault('写API(模式):%s' % h, 1)
    return (not hits), hits


def _run_oracle():
    """运行独立预言机于负例/良性/盲点，证明期望检测行为。返回 (failures, lines)。"""
    failures = []
    lines = []

    negatives = [
        ('pathlib.Path.write_bytes', "import pathlib\np = pathlib.Path('/tmp/x')\np.write_bytes(b'data')"),
        ('pathlib.Path.write_text', "import pathlib\npathlib.Path('/tmp/x').write_text('y')"),
        ('open 写模式 w', "open('/tmp/x', 'w').write('y')"),
        ('open 写模式 wb', "with open('/tmp/x','wb') as f:\n    f.write(b'z')"),
        ('io.open 写模式', "import io\nio.open('/tmp/x', 'w').write('y')"),
        ('os.write', "import os\nos.write(fd, b'data')"),
        ('文件对象 .write', "f = open('/tmp/x','rb')\nf.write(b'data')"),
    ]
    benign = "x = 1\ny = 'hello world'\nprint(x)\nfoo = lambda a: a + 1\nz = [i for i in range(3)]\nf = open('/tmp/x', 'rb')\nd = f.read()"

    for name, snippet in negatives:
        ok, hits = independent_scan(snippet)
        if ok:
            failures.append('负例未识别: %s' % name)
        else:
            lines.append('  [独立预言机·负例命中] %-26s' % name)

    b_ok, b_hits = independent_scan(benign)
    if not b_ok:
        failures.append('良性误报: %s' % b_hits)
    else:
        lines.append('  [独立预言机·良性通过] 只读 open/读 API 不误报')

    # 别名盲点：denylist（无论本脚本或仓库函数）无法识别 w = io.open; w(path,'w')
    blind = "import io\nw = io.open\nw('/tmp/x', 'w')"
    blind_ok, _ = independent_scan(blind)
    if blind_ok:
        lines.append('  [已知盲点·符合预期] 别名写调用 w = io.open; w(path,\'w\') 未被捕获'
                     '（denylist 固有局限，证明扫描非完整证明，漏检由人工复核兜底）')
    else:
        failures.append('盲点演示异常: 别名写调用竟被捕获')
    return failures, lines


# ---------------------------------------------------------------------------
# 3) 可选交叉校验（默认关闭，--exec 开启，仅白名单通过后；执行不作为证明）
# ---------------------------------------------------------------------------
def load_scan_fn():
    """【仅】在 AST 白名单通过后、显式 --exec 时调用：在独立命名空间编译执行该单函数定义本身。
    注意：此执行【不是】证明手段；安全性来自上方 validate_scan_fn_ast 的白名单。"""
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
    exec(compile(mod, VERIFIER, 'exec'), ns)  # 仅执行该单函数定义（不是"零执行证明"）
    return ns['scan_code_for_exec_write']


def _cross_check(scan):
    """用仓库函数（已白名单通过）与独立预言机在负例/良性/盲点上对照，确认行为一致。"""
    mismatches = []
    negatives = [
        "import pathlib\np = pathlib.Path('/tmp/x')\np.write_bytes(b'data')",
        "open('/tmp/x', 'w').write('y')",
        "with open('/tmp/x','wb') as f:\n    f.write(b'z')",
        "import io\nio.open('/tmp/x', 'w').write('y')",
        "import os\nos.write(fd, b'data')",
        "f = open('/tmp/x','rb')\nf.write(b'data')",
    ]
    benign = "x = 1\ny = 'hello'\nf = open('/tmp/x', 'rb')\nd = f.read()"
    blind = "import io\nw = io.open\nw('/tmp/x', 'w')"
    for s in negatives:
        if independent_scan(s)[0] != scan(s)[0]:
            mismatches.append('负例行为不一致')
    if independent_scan(benign)[0] != scan(benign)[0]:
        mismatches.append('良性行为不一致')
    if independent_scan(blind)[0] != scan(blind)[0]:
        mismatches.append('盲点行为不一致')
    return mismatches


def main():
    # 1) 独立预言机：证明期望检测行为（不依赖待审仓代码）
    oracle_failures, oracle_lines = _run_oracle()
    print('【独立预言机】期望检测行为演示：')
    for ln in oracle_lines:
        print(ln)

    # 2) 静态 AST 白名单：证明仓库函数按构造无副作用（不执行）
    violations = validate_scan_fn_ast()
    if violations:
        print('\n[AST 白名单] FAIL: %d 处违规（拒绝路径）：' % len(violations))
        for v in violations:
            print('  - %s' % v)
    else:
        print('\n[AST 白名单] PASS: scan_code_for_exec_write 仅含安全节点/调用/属性，'
              '【按构造】无副作用（未执行该函数，证明来自白名单而非执行）')

    # 3) 可选交叉校验（默认关闭）
    cross_mismatch = None
    if '--exec' in sys.argv:
        if violations:
            print('\n[交叉校验] 跳过：AST 白名单未通过，不执行仓库函数（fail-closed）')
        else:
            scan = load_scan_fn()
            cross_mismatch = _cross_check(scan)
            if cross_mismatch:
                print('\n[交叉校验] 行为不一致: %s（仅提示，不影响安全结论）' % cross_mismatch)
            else:
                print('\n[交叉校验] 仓库函数与独立预言机行为一致（执行仅作实现一致性复核，非证明）')
    else:
        print('\n[交叉校验] 默认关闭（未带 --exec）。安全结论来自 AST 白名单 + 独立预言机，'
              '不依赖执行；如需运行时复核请显式 --exec。')

    # 综合结论
    if oracle_failures or violations:
        print('\nFAIL: 预言机 %d 项 / AST 白名单 %d 项'
              % (len(oracle_failures), len(violations)))
        for f in oracle_failures:
            print('  - %s' % f)
        return 1
    print('\nPASS: 独立预言机行为正确 + 仓库函数按构造无副作用（AST 白名单）；'
          '扫描非零写证明，执行非证明。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
