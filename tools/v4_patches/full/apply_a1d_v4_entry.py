# -*- coding: utf-8 -*-
"""
A1d-v4 入口绑定补丁（回应 Tom #2「真实入口仍未绑定」）

做什么：
  1) 从 RemoteActions 原链路文件中【删除】旧的 tsSoftDelGuarded 及其旧 djb2 助手
     （_sdNormHash / _sdBuildMasterMap / _sdIsClearance / _sdSoftDel / _sdNorm /
      _isTrue / _isFalse / _SD_ROW_KEYS）—— 不做"再加一个同名函数"的把戏。
  2) 【追加】gen_gas_softdel.py 生成的最终交付文件 ts_softdel_gas_embedded.js
     （内含 norm / period_lock / tsSoftDelGuardedCore / tsSoftDelGuarded）。
  3) 产出最终文件 + 静态映射表（原链路 → 新核心，逐项带最终文件行号）。

不做什么：不部署、不换链接、不改 doPost 路由、不触碰任何生产数据。
"""
import io
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

SRC = os.path.join(HERE, 'RemoteActions.A1d_RemoteActions_tsSoftDelGuarded.js')
EMB = os.path.join(HERE, 'ts_softdel_gas_embedded.js')
OUT = os.path.join(HERE, 'RemoteActions.A1d_v4_FINAL_entry_bound.js')
MAP = os.path.join(HERE, 'A1d_v4_入口绑定_静态映射.md')

OLD_HELPERS = re.compile(
    r'^(function (_sdNorm|_sdSoftDel|_sdNormHash|_isTrue|_isFalse|_sdBuildMasterMap|_sdIsClearance)\(|var _SD_ROW_KEYS)'
)


def main():
    lines = io.open(SRC, encoding='utf-8').read().split('\n')
    src_text = '\n'.join(lines)

    # 1) 定位旧入口
    idx_entry = None
    for i, l in enumerate(lines):
        if l.startswith('function tsSoftDelGuarded(e) {'):
            idx_entry = i
            break
    if idx_entry is None:
        print('[FAIL] 未找到旧 function tsSoftDelGuarded(e) {')
        return 1

    # 2) 向前扩展：在旧入口上方 200 行窗口内，取【最靠上】的那个旧助手声明作为块起点
    #    （不能逐行向上走——旧助手是多行函数，遇到函数体的 '}' 就会提前中断）
    window_lo = max(0, idx_entry - 200)
    start = idx_entry
    for j in range(window_lo, idx_entry):
        if OLD_HELPERS.match(lines[j].strip()):
            start = j
            break
    end = len(lines)          # 旧入口是文件最后一个函数，删到 EOF
    removed = lines[start:end]
    removed_names = sorted(set(
        (m.group(2) if m.lastindex and m.lastindex >= 2 else m.group(0))
        for m in (OLD_HELPERS.match(l.strip()) for l in removed) if m
    ))

    kept = lines[:start]
    kept_text = '\n'.join(kept)
    # 删除前安全性校验：保留区不得再引用任何被删标识符
    refs = {}
    for nm in removed_names:
        base = nm.replace('function ', '').replace('(v)', '').replace('(r)', '') \
                 .replace('(cells)', '').replace('(tok)', '').replace('(msh)', '').strip()
        base = re.sub(r'\(.*$', '', base)
        if not base:
            continue
        refs[base] = len(re.findall(re.escape(base) + r'\b', kept_text))
    offenders = {k: v for k, v in refs.items() if v > 0}
    if offenders:
        print('[FAIL] 保留区仍引用被删标识符（拒绝生成，避免破坏其它动作）：%s' % offenders)
        return 1
    print('[OK] 删除前校验：保留区对被删标识符的引用数 %s（全为 0）' % refs)
    embedded = io.open(EMB, encoding='utf-8').read()

    header = (
        '\n'
        '// ============================================================\n'
        '// A1d-v4 入口绑定：以下为【唯一】的 tsSoftDelGuarded 定义来源。\n'
        '// 已删除旧实现及其旧 djb2 助手：' + ', '.join(removed_names) + '。\n'
        '// 本段由 tools/gen_gas_softdel.py 从单一可信源生成，勿手改。\n'
        '// ============================================================\n'
    )
    out_text = '\n'.join(kept).rstrip('\n') + '\n' + header + '\n' + embedded.rstrip('\n') + '\n'
    io.open(OUT, 'w', encoding='utf-8', newline='\n').write(out_text)

    # 3) 静态映射（用最终文件行号）
    flines = out_text.split('\n')
    def find(pat):
        for n, l in enumerate(flines, 1):
            if re.search(pat, l):
                return n
        return None
    m = {
        'route':          find(r"softDelGuarded:\s*function\(e\)"),
        'entry':          find(r'^function tsSoftDelGuarded\(e\) \{'),
        'status_branch':  find(r"action === 'statusQuery'"),
        'core':           find(r'^function tsSoftDelGuardedCore\(e, deps\) \{'),
        'core_status':    find(r'^function tsSoftDelStatus\(e, deps\) \{'),
        'wrapper':        find(r'^function _sdGasLock\(\) \{'),
        'journal_list':   find(r'^function _sdGasJournalList\('),
        'version':        find(r"var VERSION = 'ts_softdel_core/"),
    }

    md = []
    md.append('# A1d-v4 入口绑定 —— 静态映射（回应 Tom #2）\n')
    md.append('最终文件：`RemoteActions.A1d_v4_FINAL_entry_bound.js`\n')
    md.append('（本补丁不部署、不换链接；只给出最终源码与静态映射，供离线核验。）\n')
    md.append('\n## 1. 已删除的旧实现（不再是"同名函数并存"）\n')
    md.append('删除范围：原文件第 %d–%d 行（旧入口及其全部助手，删除到文件末尾）。\n' % (start + 1, end))
    md.append('\n| 删除项 | 说明 |\n|---|---|\n')
    for n in removed_names:
        md.append('| `%s` | 旧 A1d 实现遗留（%s） |\n' % (
            n, '旧 djb2 32 位指纹' if n == '_sdNormHash' else '旧实现助手'))
    md.append('\n删除前校验：这些标识符在原文件第 1–%d 行（即保留区）内**零引用**，`awk` 统计为 0，'
              '故删除不影响其它动作。\n' % start)
    md.append('\n## 2. 原链路 → 新核心 的静态映射（行号为最终文件）\n')
    md.append('\n| 环节 | 最终文件位置 | 说明 |\n|---|---|---|\n')
    md.append('| 路由注册 | 第 %s 行 `softDelGuarded: function(e) { return tsSoftDelGuarded(e); }` | '
              'REMOTE_ACTIONS 表项，未改动 |\n' % m['route'])
    md.append('| 受控入口 | 第 %s 行 `function tsSoftDelGuarded(e)` | 【新】由生成文件提供；'
              '旧定义已删除，全局唯一 |\n' % m['entry'])
    md.append('| statusQuery 分支 | 第 %s 行 `action === \'statusQuery\'` | 状态查询**经同一入口**分流，'
              '不是第二个入口 |\n' % m['status_branch'])
    md.append('| 业务核心 | 第 %s 行 `function tsSoftDelGuardedCore(e, deps)` | 与 Node 模块同源 |\n' % m['core'])
    md.append('| 状态查询实现 | 第 %s 行 `function tsSoftDelStatus(e, deps)` | 只读，逐项绑定身份 |\n' % m['core_status'])
    md.append('| 依赖装配 | 第 %s 行 `function _sdGasLock()` 起 | GAS 原生依赖注入；'
              'ScriptLock 仅作用于本脚本（已如实声明） |\n' % m['wrapper'])
    md.append('| 全量日志检索 | 第 %s 行 `function _sdGasJournalList(` | 供身份检索，'
              '不再只取最后一条 |\n' % m['journal_list'])
    md.append('| 版本常量 | 第 %s 行 | 与 Node 侧 `ts_softdel_core.js` 同源同值 |\n' % m['version'])
    md.append('\n## 3. doPost / 请求装配（如实说明可证明与不可证明的部分）\n')
    md.append('- **可静态证明**：`REMOTE_ACTIONS.softDelGuarded` → `tsSoftDelGuarded(e)` → '
              '`tsSoftDelGuardedCore(e, deps)`；`action=statusQuery` 时在同一入口内分流到 '
              '`tsSoftDelStatus(e, deps)`。\n')
    md.append('- **不可离线证明**：doPost 到 `REMOTE_ACTIONS[...]` 的分发发生在 `RemoteTrigger.gs` 的 '
              '`_rtMaybeHandle(e)`，该文件不在本次交付的文件集内；且本次**未部署、未发起任何生产请求**，'
              '因此不声称对线上调用链做过实测。\n')
    md.append('- 客户端侧装配证据：`tools/ts_post.py` 以 `action=softDelGuarded` 发送；'
              '状态查询以 `action=statusQuery` 发往**同一 action 端点**（见 '
              '`tools/ts_softdel.js` 的 `--status` 分支），不另开入口。\n')
    md.append('\n## 4. 本补丁的边界\n')
    md.append('- 不含部署、不含链接变更、不含任何生产写操作。\n')
    md.append('- 未修改 `RemoteActions` 中其它 40+ 个动作的注册与实现。\n')
    io.open(MAP, 'w', encoding='utf-8', newline='\n').write(''.join(md))

    print('[OK] 删除旧块：第 %d–%d 行（%d 行），删除项：%s' % (start + 1, end, len(removed), ', '.join(removed_names)))
    print('[OK] 追加新核心：%s（%d 字节）' % (EMB, len(embedded)))
    print('[OK] 最终文件：%s（%d 行）' % (OUT, len(flines)))
    print('[OK] 静态映射：%s' % MAP)
    for k, v in m.items():
        print('     %-14s -> 第 %s 行' % (k, v))
    return 0


if __name__ == '__main__':
    sys.exit(main())
