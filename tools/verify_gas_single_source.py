# -*- coding: utf-8 -*-
"""
GAS 单源可复现校验器（回应 Tom #1「源码/生成物/输出错配」+ ce058ba 一.3 dispatch manifest）

断言五件事，任一件不成立即以非 0 退出：
  1) 【逐字内联】三个规范源文件（core / norm / period_lock）去掉 'use strict' 与
     module.exports 包装后的正文，必须是生成物 ts_softdel_gas_embedded.js 的【连续子串】。
     —— 这条直接证伪/证实"GAS 副本是另一份手抄逻辑"的怀疑。
  2) 【生成可复现】连跑两次生成器，产出文件（embedded + FINAL_FILE）SHA-256 必须完全相同。
  3) 【版本自洽】生成物里的 VERSION 常量必须与规范源 ts_softdel_core.js 的 VERSION 相同。
  4) 【FINAL_FILE 内联核心区逐字一致】FINAL_FILE 内联核心区必须与 embedded 内联核心区逐字一致，
     杜绝 FINAL_FILE（实际部署入口）二次漂移。
  5) 【dispatch/entrypoint manifest】FINAL_FILE 前缀 dispatch 映射中，softDelGuarded 与 statusQuery
     必须各唯一存在且统一路由到 tsSoftDelGuarded，不得有其它键路由到该受控入口（防前缀漂移假通过）。
  6) 【运行时语义 manifest】用 Node 真实执行 dispatch 区块（Recording Stub 沙箱：任何自由标识符
     都解析为"会自报名字"的 Proxy 桩），取得【有效运行期映射】——成员集合 + 每个成员实际调用的
     目标标识序列，并与冻结基线逐条比对。这是语义层校验：增键 / 重复键覆盖 / 计算属性键 /
     对象展开 / getter / 别名等任何"改变有效映射"的注入都会被捕获，不再逐条补语法形态。

输出逐件源码的 SHA-256 与 git blob 哈希，供固定提交比对；结论写入证据文件。
"""
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = HERE
EMB = os.path.join(HERE, 'v4_patches', 'full', 'ts_softdel_gas_embedded.js')
GEN = os.path.join(HERE, 'gen_gas_softdel.py')
FINAL = os.path.join(HERE, 'v4_patches', 'full', 'RemoteActions.A1d_v4_FINAL_entry_bound.js')
ANCHOR = "var norm = (function() {"
EVID = os.path.join(HERE, '..', '_tmp', 'evidence', 'gen_single_source_20261027.txt')

SOURCES = [
    ('ts_softdel_core.js', os.path.join(TOOLS, 'ts_softdel_core.js')),
    ('ts_softdel_norm.js', os.path.join(TOOLS, 'ts_softdel_norm.js')),
    ('period_lock_port.js', os.path.join(TOOLS, 'period_lock_port.js')),
]


def sha256_file(p):
    with open(p, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


def git_blob(p):
    try:
        out = subprocess.run(['git', 'hash-object', p], capture_output=True, text=True, cwd=HERE)
        return out.stdout.strip() or '(n/a)'
    except Exception:
        return '(n/a)'


def load_generator():
    """直接加载生成器模块，复用它的【同一套】去壳函数 —— 校验器不再另写一份变换逻辑。"""
    import importlib.util
    spec = importlib.util.spec_from_file_location('gen_gas_softdel', GEN)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    rep = []
    ok = True

    emb_src = io.open(EMB, encoding='utf-8').read()

    rep.append('=== GAS 单源可复现校验（回应 Tom #1）===')
    rep.append('生成物：%s  SHA-256=%s' % (os.path.relpath(EMB, HERE), sha256_file(EMB)))
    rep.append('')

    # 1) 逐字内联
    rep.append('--- 断言1：规范源正文必须是生成物的连续子串（逐字内联）---')
    gg = load_generator()
    for name, path in SOURCES:
        src = io.open(path, encoding='utf-8').read()
        if name == 'ts_softdel_core.js':
            # 核心：生成器用 strip_core_export(strip_core_requires(src)) 后直接内联
            body = gg.strip_core_export(gg.strip_core_requires(src)).rstrip()
        else:
            # norm / period_lock：包成 IIFE，正文 = strip_leading_strict(strip_module_export(src))
            body = gg.strip_leading_strict(gg.strip_module_export(src)).rstrip()
        # 生成物里是缩进过的？逐字内联不做缩进变换，直接用 strip 后的正文比对
        found = body in emb_src
        rep.append('  %-20s 正文长度=%6d  连续子串命中=%s  SHA-256=%s  git-blob=%s'
                   % (name, len(body), 'YES' if found else 'NO', sha256_file(path)[:16] + '…', git_blob(path)[:12]))
        if not found:
            ok = False
            # 给出首个不匹配的片段，便于定位
            for k in range(0, min(len(body), 4000), 200):
                if body[k:k + 200] not in emb_src:
                    rep.append('    首个未命中片段 @%d: %r' % (k, body[k:k + 200]))
                    break
    rep.append('')

    # 2) 生成可复现
    rep.append('--- 断言2：连跑两次生成器，产出 SHA-256 必须相同 ---')
    before = sha256_file(EMB)
    before_f = sha256_file(FINAL)
    r1 = subprocess.run([sys.executable, GEN], capture_output=True, text=True, cwd=HERE)
    mid = sha256_file(EMB)
    mid_f = sha256_file(FINAL)
    r2 = subprocess.run([sys.executable, GEN], capture_output=True, text=True, cwd=HERE)
    after = sha256_file(EMB)
    after_f = sha256_file(FINAL)
    stable = (before == mid == after)
    stable_f = (before_f == mid_f == after_f)
    rep.append('  生成器退出码：%s / %s' % (r1.returncode, r2.returncode))
    rep.append('  [embedded] 第0次(现有)=%s' % before)
    rep.append('  [embedded] 第1次       =%s' % mid)
    rep.append('  [embedded] 第2次       =%s' % after)
    rep.append('  [embedded] 三次一致=%s' % ('YES' if stable else 'NO'))
    rep.append('  [FINAL_FILE] 第0次(现有)=%s' % before_f)
    rep.append('  [FINAL_FILE] 第1次       =%s' % mid_f)
    rep.append('  [FINAL_FILE] 第2次       =%s' % after_f)
    rep.append('  [FINAL_FILE] 三次一致=%s' % ('YES' if stable_f else 'NO'))
    if not stable or not stable_f or r1.returncode != 0 or r2.returncode != 0:
        ok = False
    rep.append('')

    # 3) 版本自洽
    rep.append('--- 断言3：生成物 VERSION 必须与规范源 ts_softdel_core.js 一致 ---')
    emb_src2 = io.open(EMB, encoding='utf-8').read()
    m_emb = re.search(r"var VERSION = '([^']+)'", emb_src2)
    core_src = io.open(SOURCES[0][1], encoding='utf-8').read()
    m_core = re.search(r"var VERSION = '([^']+)'", core_src)
    v_emb = m_emb.group(1) if m_emb else None
    v_core = m_core.group(1) if m_core else None
    same = (v_emb is not None and v_emb == v_core)
    rep.append('  规范源 VERSION = %s' % v_core)
    rep.append('  生成物 VERSION = %s' % v_emb)
    rep.append('  一致=%s' % ('YES' if same else 'NO'))
    if not same:
        ok = False
    rep.append('')
    # 4) FINAL_FILE 内联核心区必须与 embedded 内联核心区【逐字一致】（杜绝 FINAL_FILE 二次漂移）
    rep.append('--- 断言4：FINAL_FILE 内联核心区 必须与 embedded 内联核心区 逐字一致 ---')
    emb_src3 = io.open(EMB, encoding='utf-8').read()
    fin_src4 = io.open(FINAL, encoding='utf-8').read()
    if ANCHOR not in emb_src3:
        rep.append('  [FAIL] embedded 找不到锚点 %s' % ANCHOR); ok = False
    elif ANCHOR not in fin_src4:
        rep.append('  [FAIL] FINAL_FILE 找不到锚点 %s' % ANCHOR); ok = False
    else:
        emb_region = emb_src3[emb_src3.find(ANCHOR):]
        fin_region = fin_src4[fin_src4.find(ANCHOR):]
        region_ok = (emb_region == fin_region)
        rep.append('  embedded 内联区长度=%d  FINAL_FILE 内联区长度=%d  逐字一致=%s'
                   % (len(emb_region), len(fin_region), 'YES' if region_ok else 'NO'))
        if not region_ok:
            ok = False
            n = min(len(emb_region), len(fin_region))
            for k in range(0, n, 200):
                if emb_region[k:k + 200] != fin_region[k:k + 200]:
                    rep.append('    首个差异片段 @%d:' % k)
                    rep.append('      embedded: %r' % emb_region[k:k + 200])
                    rep.append('      FINAL   : %r' % fin_region[k:k + 200])
                    break
    rep.append('')

    # 5) 完整 dispatch 区块解析 + 顶层成员完整清单 fail-closed（Tom 本轮 一/二：真实 manifest 路径必须受保护）
    rep.append('--- 断言5：FINAL_FILE 完整 dispatch 区块解析 + 顶层成员完整清单 fail-closed ---')
    fin_src5 = io.open(FINAL, encoding='utf-8').read()
    anchor_pos = fin_src5.find(ANCHOR)
    fin_prefix = fin_src5[:anchor_pos] if anchor_pos >= 0 else fin_src5
    # 5a) 平衡花括号截取整个 dispatch 区块（REMOTE_ACTIONS = { ... };）
    m_block = re.search(r'var\s+REMOTE_ACTIONS\s*=\s*\{(.*?)\n?\};', fin_prefix, re.S)
    block = m_block.group(1) if m_block else ''
    # 5b) 受控入口（路由到 tsSoftDelGuarded）仍按 ENTRY_RE 解析（仅作受控集合核对）
    ENTRY_RE = re.compile(r'([A-Za-z_][A-Za-z0-9_]*)\s*:\s*function\s*\([^)]*\)\s*\{\s*return\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(', re.M)
    WHITELIST = {'softDelGuarded', 'statusQuery'}
    # 5c) 顶层成员完整清单：深度感知解析（覆盖含前置语句/字符串返回/复杂函数体的 42 个既有成员）
    #     真实 REMOTE_ACTIONS 共 42 个顶层成员；ENTRY_RE 仅命中 36（只匹配“function(){ return TARGET(}”紧返回形态，
    #     其余 6 个含 var 前置语句或字符串返回不命中）。报告的“成员总数”必须是完整顶层解析(42)，而非 ENTRY_RE 命中(36)。
    BASELINE_KEYS = {
        'repairLegacyLeave','setupPeriodLock','plVerifyHash','plGuardTest','masterException',
        'refreshqs','exception','archive','setup','setupAmy','testAmySelf','cleanupLeaves',
        'syncLeaves','checkLeaves','readRange','appendRows','patchCells','softDelGuarded',
        'statusQuery','createSheet','snapshot','trimblank','dupreport','driveList',
        'purgeSoftLeaves','purgeRows','probeCalendar','masterCreate','masterLeaves','pruneDead',
        'fixBDates','delBlankRows','sheetMeta','applyFormat','masterCondFormat','alert',
        'listTriggers','syncMaster','rebuildLive','viewsLive','malAll','ensureMalTriggers',
    }
    # 冻结的【有效运行期路由指纹】：成员名 → 该成员被以探针调用时实际调用到的目标标识序列。
    # 由 Node Recording Stub 沙箱执行规范区块测得（42 条）。任何改变有效映射的注入都会使其失配。
    BASELINE_ROUTING = {
        "alert": ["tsSendAlert"], "appendRows": ["tsAppendRows"], "applyFormat": ["tsApplyFormat"],
        "archive": ["archiveCurrentSpreadsheet"], "checkLeaves": ["tsCheckLeaves"],
        "cleanupLeaves": ["cleanupDuplicateLeavesInternal"], "createSheet": ["tsCreateSheet"],
        "delBlankRows": ["tsDelBlankRows"], "driveList": ["tsDriveList"], "dupreport": ["tsDupReport"],
        "ensureMalTriggers": ["ensureMasterSyncTriggers"],
        "exception": ["Date", "Utilities.formatDate", "refreshMonthlyExceptions"],
        "fixBDates": ["tsFixBDates"], "listTriggers": ["listTriggers"],
        "malAll": ["_malOptFromE", "malRunAll"], "masterCondFormat": ["tsSetCondFormat"],
        "masterCreate": ["masterCreate"],
        "masterException": ["Date", "Utilities.formatDate", "refreshMasterException"],
        "masterLeaves": ["masterLeaves"], "patchCells": ["tsPatchCells"], "plGuardTest": ["plGuardTest"],
        "plVerifyHash": ["plVerifyHash"], "probeCalendar": ["tsProbeCalendar"], "pruneDead": ["tsPruneDead"],
        "purgeRows": ["tsPurgeRows"], "purgeSoftLeaves": ["tsPurgeSoftLeaves"], "readRange": ["tsReadRange"],
        "rebuildLive": ["_malOptFromE", "rebuildAttendanceLive"], "refreshqs": ["refreshQSBoard"],
        "repairLegacyLeave": ["repairLegacyLeave"], "setup": ["setupAllTriggers"],
        "setupAmy": ["setupAmyMonthlyReminder"], "setupPeriodLock": ["setupPeriodLock"],
        "sheetMeta": ["tsSheetMeta"], "snapshot": ["tsSnapshot"], "softDelGuarded": ["tsSoftDelGuarded"],
        "statusQuery": ["tsSoftDelGuarded"], "syncLeaves": ["syncLeavesFromCalendar"],
        "syncMaster": ["_malOptFromE", "syncProdToMaster"], "testAmySelf": ["testSendAmySelf"],
        "trimblank": ["tsTrimBlank"], "viewsLive": ["_malOptFromE", "refreshMasterViews"],
    }

    def _parse_top_level_keys(b):
        """深度感知解析 REMOTE_ACTIONS 区块的顶层成员键（跳过注释/字符串/嵌套花括号）。
        返回 (keys, computed_keys, spreads, unsupported)：
          computed_keys —— depth==0 的计算属性键（形如 ['x']: …），运行期绑定动态，调用方必须 fail-closed
          spreads       —— depth==0 的对象展开（...{…} / ...expr），合法 JS 且运行期可覆盖既有成员
          unsupported   —— depth==0 键位上出现的未支持语法字符（Tom 15:17Z 要求"对未支持语法 fail-closed"）"""
        keys = []
        computed_keys = []
        spreads = []
        unsupported = []
        depth = 0
        expect_key = True     # 顶层：当前处于"键位"（True）还是"值位"（False）
        i = 0
        n = len(b)
        while i < n:
            c = b[i]
            if depth == 0 and c == '.' and b[i:i+3] == '...':
                # 顶层对象展开（Tom 2026-10-28 15:17Z 第四类绕过）：
                # ...{ setup: function(e){ return otherAction(e); } } 是【合法 JS】，运行期展开
                # 会用后面的同名键覆盖原映射；展开内容静态不可确定，一律 fail-closed（不尝试解析）。
                spreads.append(b[i:i+3])
                i += 3
                continue
            if c == '/' and i + 1 < n and b[i+1] == '/':
                j = b.find('\n', i);  i = (j + 1) if j != -1 else n;  continue
            if c == '/' and i + 1 < n and b[i+1] == '*':
                j = b.find('*/', i + 2);  i = (j + 2) if j != -1 else n;  continue
            if (c == '"' or c == "'") and depth == 0:
                # 顶层（depth==0）字符串字面量：若紧跟 ':' 则为【带引号顶层键】，须归一化
                # （去引号）后入键集合，交由顶层清单比对 fail-closed。
                # （Tom 本轮 K1-a：原代码整串跳过，引号键不进 top_keys，可绕过集合比对。）
                q = c;  i += 1;  start = i
                while i < n:
                    if b[i] == '\\': i += 2; continue
                    if b[i] == q: break
                    i += 1
                content = b[start:i]
                i += 1  # 跳过闭合引号
                k = i
                while k < n and b[k] in ' \t\n\r': k += 1
                if k < n and b[k] == ':':
                    keys.append(content)   # 归一化为去引号键，交由集合比对 fail-closed
                    i = k + 1
                    expect_key = False     # 进入值位
                continue
            if c == '"' or c == "'":
                # 非顶层（depth>0）字符串字面量：照旧跳过
                q = c;  i += 1
                while i < n:
                    if b[i] == '\\': i += 2; continue
                    if b[i] == q: i += 1; break
                    i += 1
                continue
            if c == '[' and depth == 0:
                # 顶层计算属性键（['x']: …）或数组值。先用括号匹配扫到匹配 ']'，
                # 再判其后是 ':'（键）还是 ','/'}'（值）。仅当后是 ':' 才算计算键 → 记入并 fail-closed。
                j = i + 1
                bal = 1
                while j < n and bal > 0:
                    ch = b[j]
                    if ch == '\\' and j + 1 < n and b[j+1] in '"\'':
                        j += 2; continue
                    if ch == '"' or ch == "'":
                        q = ch; j += 1
                        while j < n:
                            if b[j] == '\\': j += 2; continue
                            if b[j] == q: j += 1; break
                            j += 1
                        continue
                    if ch == '[': bal += 1
                    elif ch == ']': bal -= 1
                    j += 1
                k = j
                while k < n and b[k] in ' \t\n\r': k += 1
                if k < n and b[k] == ':':
                    computed_keys.append(b[i:j+1])   # 计算属性键，运行期动态绑定，强制 fail-closed
                    i = k + 1
                    expect_key = False     # 进入值位
                else:
                    i = j   # 数组值（如 key: [1,2,3] 或 key: [{…}]），整体跳过
                continue
            if c == '{': depth += 1; i += 1; continue
            if c == '}':
                depth -= 1; i += 1
                if depth == 0: expect_key = True   # 该成员函数体结束，回到键位
                continue
            if depth == 0 and (c.isalpha() or c == '_' or c == '$'):
                j = i
                while j < n and (b[j].isalnum() or b[j] in '_$'):
                    j += 1
                k = j
                while k < n and b[k] in ' \t':
                    k += 1
                if k < n and b[k] == ':':
                    keys.append(b[i:j]);  i = k + 1;  expect_key = False;  continue
                i = j;  continue
            if depth == 0:
                if c == ',':
                    expect_key = True     # 顶层分隔符 → 回到键位
                    i += 1;  continue
                if expect_key and not (c.isalpha() or c in '_$"' or c == "'" or c == '[' or c in ' \t\n\r'):
                    # 键位上出现既非键起始、也非分隔符的字符 = 未支持语法 → fail-closed（Tom 15:17Z）
                    unsupported.append(c)
            i += 1
        return keys, computed_keys, spreads, unsupported

    def _real_manifest_ok(b, baseline):
        """真实 dispatch 路径的完整校验（main() 与负例共用同一函数，杜绝 fixture 与真实路径不一致）。
        返回 (ok, rep_lines, top_keys)。"""
        lines = []
        ok = True
        top, computed, spreads, unsupported = _parse_top_level_keys(b)
        # 防顶层对象展开绕过（Tom 2026-10-28 15:17Z 第四类）：...{ setup: … } 是【合法 JS】，
        # 运行期展开会用后面的同名键覆盖原映射；既不是重复键也不是计算键，既有正则/计数全不命中。
        # 展开内容静态不可确定 → 任何顶层展开一律 fail-closed（不尝试解析求值）。
        if spreads:
            ok = False
            lines.append('  [FAIL] 存在顶层对象展开 ...（合法 JS，运行期可覆盖既有成员；静态无法确定展开内容，强制 fail-closed）：%d 处' % len(spreads))
        # 防未支持语法绕过（Tom 15:17Z 要求）：键位上出现既非键起始、也非分隔符的字符 → fail-closed
        if unsupported:
            ok = False
            lines.append('  [FAIL] 顶层键位存在未支持语法字符（强制 fail-closed）：%s' % sorted(set(unsupported)))
        # 防计算属性键绕过（Tom 本轮 L3）：['setup']: function… 是合法 JS，运行时会覆盖同名原键，
        # 但静态无法确知运行期绑定，故任何顶层计算键一律 fail-closed（不尝试解析求值）。
        if computed:
            ok = False
            lines.append('  [FAIL] 存在计算属性键（动态键，无法静态确定运行期绑定，强制 fail-closed）：%s' % computed)
        # 防重复顶层键绕过：JavaScript 同名后定义覆盖先定义，
        # 故“集合相同”不能证明“有效映射相同”；必须显式拒绝任何重复顶层键。
        if len(top) != len(set(top)):
            ok = False
            dup_keys = sorted(set(k for k in top if top.count(k) > 1))
            lines.append('  [FAIL] 存在重复顶层键（JS 后定义覆盖先定义，可绕过集合比对）：%s' % dup_keys)
        top_set = set(top)
        if top_set != baseline:
            ok = False
            extra = sorted(top_set - baseline)
            missing = sorted(baseline - top_set)
            lines.append('  [FAIL] 顶层成员清单与基线不一致：额外=%s 缺失=%s（任何注入/删改即 fail-closed）' % (extra, missing))
        # 受控入口（路由到 tsSoftDelGuarded）必须恰好为 WHITELIST 且各唯一一次
        em = {}
        for k, t in ENTRY_RE.findall(b):
            em.setdefault(k, []).append(t)
        controlled = {k: ts[0] for k, ts in em.items() if ts == ['tsSoftDelGuarded']}
        if set(controlled.keys()) != WHITELIST:
            ok = False
            lines.append('  [FAIL] 路由到 tsSoftDelGuarded 的入口必须为且仅为 %s，实际=%s' % (sorted(WHITELIST), sorted(controlled.keys())))
        for k in ('softDelGuarded', 'statusQuery'):
            cnt = len(em.get(k, [])); tgt = em.get(k, [None])[0]
            lines.append('  %s 入口次数=%d 路由目标=%s' % (k, cnt, tgt))
            if cnt != 1 or tgt != 'tsSoftDelGuarded':
                ok = False
                lines.append('    [FAIL] %s 必须唯一且路由 tsSoftDelGuarded' % k)
        rogue = [k for k in controlled if k not in WHITELIST]
        if rogue:
            ok = False
            lines.append('  [FAIL] 以下键非法路由到 tsSoftDelGuarded：%s' % rogue)
        # 后援：return tsSoftDelGuarded( 出现次数必须恰为 2（防非简单形态 rogue）
        n_ts = b.count('return tsSoftDelGuarded(')
        if n_ts != 2:
            ok = False
            lines.append('  [FAIL] return tsSoftDelGuarded( 出现 %d 次（须恰为 2）' % n_ts)
        return ok, lines, top

    def _runtime_manifest(b, baseline_keys, baseline_routing):
        """【运行时语义校验 · 断言6】用 Node 真实执行 dispatch 区块（Recording Stub 沙箱：
        区块内任何自由标识符都预声明为"会自报名字"的 Proxy 桩，故执行零副作用、不会抛错），
        逐成员以探针调用并记录其实际调用到的目标标识序列，得到【有效运行期映射】。

        与冻结基线比对两件事：①有效成员集合 == 基线键集合；②每个成员的有效路由 == BASELINE_ROUTING。
        这是语义层而非语法层校验：增键 / 重复键覆盖 / 计算属性键 / 对象展开 / getter / 别名等
        任何"改变有效映射"的注入都会被捕获，不再逐条补语法形态（终结 Tom 连续四类语法绕过）。

        返回 (ok, lines)。node 缺失或执行失败一律 fail-closed（不做静默跳过）。"""
        lines = []
        node = shutil.which('node')
        if not node:
            lines.append('  [FAIL] 运行时语义校验不可用：未找到 node 可执行文件（按 fail-closed 处理）')
            return False, lines
        RESERVED = set('''break case catch class const continue debugger default delete do else enum
            export extends false finally for function if implements import in instanceof interface let
            new null package private protected public return static super switch this throw true try
            typeof var void while with yield await async of get set arguments undefined NaN Infinity'''.split())
        idents = set()
        for mm in re.finditer(r'[A-Za-z_$][A-Za-z0-9_$]*', b):
            t = mm.group(0)
            if t not in RESERVED:
                idents.add(t)
        for n in ('REMOTE_ACTIONS', '__rec', 'mk', 'keys', 'routing', 'i', 'k', 'r', 'v', 'err'):
            idents.discard(n)
        decls = ',\n  '.join('%s = mk(%r)' % (n, n) for n in sorted(idents))
        node_tpl = r'''
var __rec = [];
function mk(name){
  var f = function(){ __rec.push(name); return mk(name + '()'); };
  return new Proxy(f, {
    get: function(t, p){ if (typeof p === 'symbol') return t[p]; return mk(name + '.' + String(p)); },
    apply: function(){ __rec.push(name); return mk(name + '()'); },
    construct: function(){ __rec.push(name); return mk(name + '()'); }
  });
}
var __DECLS__;
var REMOTE_ACTIONS = {
__BLOCK__
};
var keys = Object.keys(REMOTE_ACTIONS);
var routing = {};
for (var i = 0; i < keys.length; i++) {
  var k = keys[i];
  __rec.length = 0;
  var r;
  try {
    var v = REMOTE_ACTIONS[k];
    if (typeof v === 'function') { v({__probe: 1}); }
    r = __rec.slice();
  } catch (err) { r = ['THREW:' + String(err && err.message)]; }
  routing[k] = r;
}
console.log(JSON.stringify({keys: keys, routing: routing}));
'''
        src = node_tpl.replace('__DECLS__', decls).replace('__BLOCK__', b)
        fd, pth = tempfile.mkstemp(suffix='.js')
        try:
            with io.open(pth, 'w', encoding='utf-8') as fh:
                fh.write(src)
            p = subprocess.run([node, pth], capture_output=True, text=True, timeout=30)
        except subprocess.TimeoutExpired:
            lines.append('  [FAIL] 运行时语义校验超时（30s；可能含不可终止循环）→ fail-closed')
            return False, lines
        finally:
            try:
                os.unlink(pth)
            except OSError:
                pass
        if p.returncode != 0:
            lines.append('  [FAIL] 运行时语义校验执行失败（区块不是可执行的合法 JS）rc=%d：%s'
                         % (p.returncode, (p.stderr or '').strip().splitlines()[-1:]))
            return False, lines
        try:
            d = json.loads(p.stdout.strip())
        except Exception as e:
            lines.append('  [FAIL] 运行时语义校验输出不可解析：%s' % e)
            return False, lines
        keys = d.get('keys', [])
        routing = d.get('routing', {})
        ok = True
        lines.append('  运行时有效成员数=%d（冻结基线=%d）' % (len(keys), len(baseline_keys)))
        if set(keys) != set(baseline_keys):
            ok = False
            lines.append('  [FAIL] 运行时有效成员集合与基线不一致：额外=%s 缺失=%s'
                         % (sorted(set(keys) - baseline_keys), sorted(baseline_keys - set(keys))))
        if routing != baseline_routing:
            ok = False
            diffs = sorted([k for k in set(list(routing.keys()) + list(baseline_routing.keys()))
                            if routing.get(k) != baseline_routing.get(k)])
            lines.append('  [FAIL] 运行时有效路由与冻结基线不一致（成员=%d 处失配）：%s'
                         % (len(diffs), diffs[:10]))
            for k in diffs[:5]:
                lines.append('      %s：基线=%s 实际=%s' % (k, baseline_routing.get(k), routing.get(k)))
        else:
            lines.append('  运行时有效路由逐条比对：%d/%d 一致' % (len(routing), len(baseline_routing)))
        for k in ('softDelGuarded', 'statusQuery'):
            tgt = routing.get(k)
            lines.append('  %s 运行时路由=%s' % (k, tgt))
            if tgt != ['tsSoftDelGuarded']:
                ok = False
                lines.append('    [FAIL] %s 运行时必须路由到 tsSoftDelGuarded' % k)
        return ok, lines

    # 5d) 对真实区块跑真实路径校验
    real_ok, real_lines, real_top = _real_manifest_ok(block, BASELINE_KEYS)
    rep.extend(real_lines)
    rep.append('  dispatch 顶层成员总数（完整解析，深度感知）= %d；ENTRY_RE 命中（简单 return 形态）= %d' % (len(real_top), len(ENTRY_RE.findall(block))))
    rep.append('  manifest 一致=%s' % ('YES' if real_ok else 'NO'))
    if not real_ok:
        ok = False

    # 5e) 负例自测：把各类绕过注入【真实区块】，真实路径必须 fail-closed（Tom 本轮 一/二 核心）
    # 🔴 注入体必须是【合法 JS】才构成真实绕过：block 末行以 '//' 注释结尾，
    #    若直接拼 ',…' 则逗号被注释吞掉 → 产物是语法错误而非合法注入（此前四类负例即此缺陷，
    #    抓到的是"语法垃圾"而非"合法 JS 绕过"）。故统一以 '\n,\n' 起头，确保逗号落在注释之后。
    INJ = '\n,\n  %s\n'
    tamper_cases = {
        '额外未引号成员 evil→otherAction':
            block.rstrip() + INJ % 'evil: function(e){ return otherAction(e); }',
        '引号键 "evil"→otherAction（Tom 本轮 K1-a：原解析器跳过字符串字面量，引号键不进 top_keys 绕过集合比对）':
            block.rstrip() + INJ % '"evil": function(e){ return otherAction(e); }',
        '重复基线键 setup→otherAction（Tom 本轮 K1-b：set() 丢弃重复项，JS 后定义覆盖先定义绕过集合比对）':
            block.rstrip() + INJ % 'setup: function(e){ return otherAction(e); }',
        '计算属性键 [\'setup\']→otherAction（Tom 本轮 L3：解析器未解析/拒绝方括号计算键，运行期覆盖原 setup 绕过集合比对）':
            block.rstrip() + INJ % '[\'setup\']: function(e){ return otherAction(e); }',
        '对象展开 ...{setup:otherAction}（Tom 2026-10-28 15:17Z 第四类：合法 JS，运行期展开覆盖原 setup；'
        '既非重复键亦非计算键，既有正则/计数全不命中）':
            block.rstrip() + INJ % '...{ setup: function(e){ return otherAction(e); } }',
    }
    rep.append('--- 断言5 负例：真实区块注入各类绕过 → 真实路径必须 fail-closed ---')
    for label, tam in tamper_cases.items():
        tam_ok, tam_lines, _ = _real_manifest_ok(tam, BASELINE_KEYS)
        rep.extend(tam_lines)
        if tam_ok:
            ok = False
            rep.append('  [FAIL] 真实区块注入[%s] 未被识别（真实路径缺口仍在）' % label)
        else:
            rep.append('  真实区块注入[%s] → fail-closed=YES' % label)

    # 6) 【运行时语义 manifest】Node 真实执行有效映射，与冻结基线逐条比对（终结语法形态打地鼠）
    rep.append('--- 断言6：运行时语义 manifest（Node 真实执行 + Recording Stub 沙箱）---')
    rt_ok, rt_lines = _runtime_manifest(block, BASELINE_KEYS, BASELINE_ROUTING)
    rep.extend(rt_lines)
    rep.append('  运行时语义 manifest 一致=%s' % ('YES' if rt_ok else 'NO'))
    if not rt_ok:
        ok = False
    # 6b) 负例：五类注入经【运行时语义校验】必须全部 fail-closed（合法 JS 注入，非语法垃圾）
    rep.append('--- 断言6 负例：合法 JS 注入 → 运行时语义校验必须 fail-closed ---')
    for label, tam in tamper_cases.items():
        t_ok, t_lines = _runtime_manifest(tam, BASELINE_KEYS, BASELINE_ROUTING)
        if t_ok:
            ok = False
            rep.append('  [FAIL] 运行时语义校验未能识别注入[%s]' % label)
        else:
            rep.append('  运行时语义校验：注入[%s] → fail-closed=YES' % label)

    # 5c'') 顶层键扫描器（供后续 fixture 的 _ctrl_set_of 使用）
    MEMBER_KEY_RE = re.compile(r'([A-Za-z_$][\w$]*|\[[^\]]+\])\s*:')
    rep.append('')

    # 5f) 负例自测：解析器必须识别各类未授权/未识别成员并 fail-closed（Tom 本轮#5a）
    rep.append('--- 断言5 负例自测（完整区块解析覆盖边界）---')
    def _ctrl_set_of(src):
        mb = re.search(r'var\s+REMOTE_ACTIONS\s*=\s*\{(.*?)\n?\};', src, re.S)
        blk = mb.group(1) if mb else ''
        em = {}
        for k, t in ENTRY_RE.findall(blk):
            em.setdefault(k, []).append(t)
        # 修正（Tom 本轮-J2）：t 是列表，须与 ['tsSoftDelGuarded'] 比较（原 `t == 'tsSoftDelGuarded'`
        # 列表≠字符串 恒为 False → ctrl 恒为空 → 负例只因 helper 恒 false 而“通过”，rogue 分支空转）。
        # 同时须校验成员集合恰好为 WHITELIST 且无任何无法解析的顶层成员（覆盖 evil→otherAction 等额外成员原例）。
        ctrl = {k for k, t in em.items() if t == ['tsSoftDelGuarded']}
        declared_keys = MEMBER_KEY_RE.findall(blk)
        unparsed = [k for k in declared_keys if k not in em]
        return (ctrl == WHITELIST
                and set(em.keys()) == WHITELIST
                and not unparsed)
    # 正向夹具（Tom 本轮-J2：补合法 manifest，确认不被误杀）+ 负例自测（覆盖 evil→otherAction 原例）
    neg_ok = True
    POSITIVE = "var REMOTE_ACTIONS = { softDelGuarded: function(e){ return tsSoftDelGuarded(e); }, statusQuery: function(e){ return tsSoftDelGuarded(e); } };"
    pos_ok = _ctrl_set_of(POSITIVE)
    rep.append('  正向夹具[合法manifest] 判为受控(不被误杀)=%s' % ('YES' if pos_ok else 'NO'))
    if not pos_ok:
        neg_ok = False
        rep.append('    [FAIL] 合法 manifest 被误判为非法（helper 过紧）')
    neg_cases = {
        'rogue alias 路由到受控入口': "var REMOTE_ACTIONS = { softDelGuarded: function(e){ return tsSoftDelGuarded(e); }, statusQuery: function(e){ return tsSoftDelGuarded(e); }, evil: function(e){ return tsSoftDelGuarded(e); } };",
        '额外成员路由到 otherAction（Tom 本轮未覆盖原例）': "var REMOTE_ACTIONS = { softDelGuarded: function(e){ return tsSoftDelGuarded(e); }, statusQuery: function(e){ return tsSoftDelGuarded(e); }, evil: function(e){ return otherAction(e); } };",
        'computed key 路由到受控入口': "var REMOTE_ACTIONS = { softDelGuarded: function(e){ return tsSoftDelGuarded(e); }, statusQuery: function(e){ return tsSoftDelGuarded(e); }, [someKey]: function(e){ return tsSoftDelGuarded(e); } };",
        '替代表达式（无 return/function）': "var REMOTE_ACTIONS = { softDelGuarded: tsSoftGuarded, statusQuery: function(e){ return tsSoftDelGuarded(e); } };",
        '白名单外键路由到受控入口（Tom #5a 未识别成员）': "var REMOTE_ACTIONS = { softDelGuarded: function(e){ return tsSoftDelGuarded(e); }, statusQuery: function(e){ return tsSoftDelGuarded(e); }, evil: function(e){ return tsSoftDelGuarded(e); } };",
    }
    for label, snippet in neg_cases.items():
        detected = not _ctrl_set_of(snippet)
        rep.append('  负例[%s] 识别为非法=fail-closed=%s' % (label, 'YES' if detected else 'NO'))
        if not detected:
            neg_ok = False
            rep.append('    [FAIL] 负例未被识别')
    # 5g) 真实区块插入未识别成员（evil 路由到受控入口）→ 必须 fail-closed
    tampered = fin_prefix + "\nvar REMOTE_ACTIONS = { softDelGuarded: function(e){ return tsSoftDelGuarded(e); }, statusQuery: function(e){ return tsSoftDelGuarded(e); }, evil: function(e){ return tsSoftDelGuarded(e); } };\n"
    real_detected = not _ctrl_set_of(tampered)
    rep.append('  真实区块插入 evil→受控入口 负例 fail-closed=%s' % ('YES' if real_detected else 'NO'))
    if not real_detected:
        neg_ok = False
        rep.append('    [FAIL] 真实区块插入未识别成员未 fail-closed')
    if not neg_ok:
        ok = False
        rep.append('  [FAIL] 断言5 负例自测未通过（解析器覆盖不足）')
    rep.append('')

    rep.append('=== 结论：%s ===' % ('全部断言通过' if ok else '存在失败断言（见上）'))

    text = '\n'.join(rep) + '\n'
    os.makedirs(os.path.dirname(EVID), exist_ok=True)
    io.open(EVID, 'w', encoding='utf-8', newline='\n').write(text)
    print(text)
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
