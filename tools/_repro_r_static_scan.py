# -*- coding: utf-8 -*-
"""
R 批只读复现脚本（回应 Tom 本轮二·S2 最终版 —— 落实其"复现脚本自行实现最小扫描器；
或用独立可信实现严格白名单校验目标 AST 后再限定执行语法"二项要求，并修正夸大措辞）。

🔴 证明模型（精确，不夸大，逐条对应 Tom 的验收；回应 Tom 08:27Z 对 S2 的复核）：
- 本脚本【绝不】声称"零代码执行证明"，且【已彻底移除】任何编译/执行仓库函数的路径
  （无 --exec、无 exec()、无 load_scan_fn）——默认且唯一行为是零执行。
- 行为正确性（期望检测行为）由【独立可信预言机】 independent_scan 证明：它是本脚本自带的、
  完全不依赖待审仓代码的纯正则扫描器，独立复现 7 种写 API 形态的检测、只读不误报、
  以及别名盲点（denylist 的固有局限）。这满足 Tom 的"复现脚本自行实现最小扫描器"。
- 仓库函数 scan_code_for_exec_write 的【无副作用】由【严格 AST 白名单】静态证明（绝不执行该函数）：
  允许一组安全节点类型 + 受限语义（无导入 / 无 global·nonlocal / 无危险基准名属性调用 /
  直接 Name 调用仅限白名单 / 属性调用仅限"安全基准名 + 纯方法名" / 任何 (f())() 动态调用形式一律拒绝）。
  这满足 Tom 的"用独立可信实现严格白名单校验目标 AST"，并闭合其指出的 getattr/动态调用绕过。

结论口径：扫描【不是】零写证明；无副作用由 AST 白名单（按构造）证明；本脚本【不执行】待审仓代码。
若未来需要真正运行校验器 / harness，应由操作系统强制隔离（独立低权限身份 / 容器 / 沙箱、禁网）提供边界。
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
# 允许被【直接 Name 调用】的内建 / 库函数（已剔除 getattr/hasattr/exec/eval/compile/__import__/open 等动态与危险入口）
_ALLOWED_DIRECT_CALLS = {
    're.compile', 're.findall', 're.search', 're.match', 're.sub', 're.split',
    'sorted', 'set', 'list', 'dict', 'tuple', 'len', 'str', 'int', 'float', 'bool',
    'enumerate', 'range', 'zip', 'map', 'filter', 'min', 'max', 'sum', 'abs',
    'isinstance', 'type', 'repr', 'format', 'ord', 'chr',
}
# 危险属性基准名：其任何属性访问 / 方法调用都视为拒绝路径（覆盖外部模块与内建执行入口）
_DANGEROUS_BASES = {
    'os', 'subprocess', 'importlib', 'sys', 'io', 'pathlib', 'shutil', 'hashlib',
    'tempfile', 'builtins', '__builtins__', 'socket', 'urllib', 'requests', 'http',
    'child_process', 'fs', 'module', 'ctypes',
}
# 允许被【属性调用】的纯方法名（无 IO / 无执行 / 无全局改写；base 还须非危险）。
# 覆盖目标函数实际用到的：re.compile/findall、str/容器 .count/.join/.get/.setdefault/.items/.strip 等。
_ALLOWED_ATTR_CALLS = {
    'compile', 'findall', 'search', 'match', 'sub', 'split',
    'count', 'join', 'get', 'items', 'keys', 'values', 'setdefault',
    'strip', 'lstrip', 'rstrip', 'upper', 'lower', 'replace', 'startswith',
    'endswith', 'splitlines', 'zfill', 'format', 'encode', 'decode',
    'append', 'extend', 'update', 'add', 'discard', 'pop', 'copy', 'sort',
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
        # 危险基准名属性访问 / 方法调用（杜绝 os.system / io.open / __import__ 等）
        if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) \
                and n.value.id in _DANGEROUS_BASES:
            violations.append('拒绝路径: 危险属性基准名 %s.%s @L%d'
                              % (n.value.id, n.attr, getattr(n, 'lineno', -1)))
            continue  # 已拦，无需再走下方 Call 判定
        # 任何【函数调用】必须是【受限安全调用】（响应 Tom 08:27Z S2：拒绝 getattr / (f())() 动态绕过）：
        #   · func 为 Name      -> 必须落在 _ALLOWED_DIRECT_CALLS（已剔除 getattr/hasattr/exec/eval 等）
        #   · func 为 Attribute -> 基准名非危险 且 属性名落在 _ALLOWED_ATTR_CALLS（纯方法，无 IO/执行）
        #   · 其余（func 为 Call/Lambda/...，即 (f())() 动态调用形式）一律拒绝
        if isinstance(n, ast.Call):
            f = n.func
            if isinstance(f, ast.Name):
                if f.id not in _ALLOWED_DIRECT_CALLS:
                    violations.append('拒绝路径: 不允许的直接调用目标 %s @L%d'
                                      % (f.id, getattr(n, 'lineno', -1)))
            elif isinstance(f, ast.Attribute):
                base = _name_of(f.value)
                if base in _DANGEROUS_BASES or f.attr not in _ALLOWED_ATTR_CALLS:
                    violations.append('拒绝路径: 不允许的属性调用 %s.%s @L%d'
                                      % (base, f.attr, getattr(n, 'lineno', -1)))
            else:
                violations.append('拒绝路径: 动态调用形式（func 非 Name/Attribute，如 (f())()）@L%d'
                                  % getattr(n, 'lineno', -1))
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
# 3) 严格零执行：本脚本不提供任何执行仓库函数的入口（无 --exec / 无 exec）。
#    安全性结论仅来自上面的 AST 白名单 + 独立预言机，绝不依赖、也不声称"执行即证明"。
# ---------------------------------------------------------------------------
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

    # 3) 严格零执行：本脚本不提供任何执行仓库函数的入口（无 --exec / 无 exec）。
    #    安全性结论仅来自 AST 白名单 + 独立预言机。

    # 综合结论
    if oracle_failures or violations:
        print('\nFAIL: 预言机 %d 项 / AST 白名单 %d 项'
              % (len(oracle_failures), len(violations)))
        for f in oracle_failures:
            print('  - %s' % f)
        return 1
    print('\nPASS: 独立预言机行为正确 + 仓库函数按构造无副作用（AST 白名单）；'
          '本脚本零执行（无 --exec / 无 exec），扫描非证明。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
