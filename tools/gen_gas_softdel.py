#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gen_gas_softdel.py — 由【单一可信源】生成 GAS 端软标动作实际文件（回应 Tom #1）

设计要点（Tom 2026-10-27 复审条件 #1）：
  - GAS 端 tsSoftDelGuarded 与 Node 端 tsSoftDelGuardedCore 必须是【同一份逻辑】，
    不允许各写一份再声称"等价"。本脚本从下列源文件逐字内联，保证 GAS 副本 == Node 模块文本一致：
        ts_softdel_core.js   （业务核心；Node 端 require norm/pl）
        ts_softdel_norm.js   （字段规范化/SHA-256，环境自适应）
        period_lock_port.js  （真实期锁适配器纯逻辑）
  - 生成物：
        1) ts_softdel_gas_embedded.js  —— 自包含 GAS 文件（含 norm/pl IIFE + 核心 + GAS 包装器），
           既用于隔离 harness 加载"真实交付文件"做跨环境等价证明，也可作为注入 RemoteActions.js 的蓝本。
        2) gen_gas_softdel.map.md       —— 逐函数对照表（源函数 → 生成物函数，命名一致）。
  - 隔离 harness（ts_softdel_gas_harness.js）随后加载 (1) 在 GAS shim 下运行，与 Node 核心跑同样输入，
    比对 Date/字符串/前导零/布尔/审计指纹/期锁结果/响应，给出行为等价证据（回应 Tom #2）。

用法：python tools/gen_gas_softdel.py
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CORE = os.path.join(HERE, 'ts_softdel_core.js')
NORM = os.path.join(HERE, 'ts_softdel_norm.js')
PL = os.path.join(HERE, 'period_lock_port.js')
OUT_DIR = os.path.join(HERE, 'v4_patches', 'full')
MAP_PATH = os.path.join(HERE, 'gen_gas_softdel.map.md')
# 实际部署入口绑定文件：其末尾内联的 norm/pl/core/wrapper 必须【逐字等同】embedded，
# 否则 makeDispatch 加载的“真实部署入口”会偏离单源（此前即因此漂移：写了 3 条日志、未触发期锁）。
FINAL_PATH = os.path.join(OUT_DIR, 'RemoteActions.A1d_v4_FINAL_entry_bound.js')
FINAL_ANCHOR = "var norm = (function() {"


def read(p):
    with open(p, 'r', encoding='utf-8') as f:
        return f.read()


def strip_module_export(src):
    """去掉 Node 专属的 module.exports 守卫块（GAS 端不需要）。"""
    idx = src.find('if (typeof module')
    if idx >= 0:
        # 截到该行起，但保留其之前的换行
        return src[:idx].rstrip() + '\n'
    return src


def strip_leading_strict(src):
    """去掉开头的 'use strict';（内联到 IIFE 后会重复，去掉更干净）。"""
    return re.sub(r"^\s*'use strict';\s*\n", '', src)


def parse_exports(src, name):
    """从源文件的 module.exports = { ... } 自动解析导出名（单一可信源）。

    此前导出名是**硬编码列表**，新增函数忘了同步 → GAS 侧 `pl.新函数` 为 undefined，
    运行时才炸（本次 _plPolicyFromProps 即因此静默失败）。改为自动解析，杜绝再漏。
    """
    m = re.search(r'module\.exports\s*=\s*\{(.*?)\n\s*\};', src, re.S)
    if not m:
        raise SystemExit('[FATAL] 无法解析 %s 的 module.exports 块' % name)
    # 支持一行多个键（name: value, name: value）
    # 末尾一项后面可能既无逗号也无换行（直接接 }），故 lookahead 需含 $ 与空白边界
    names = re.findall(r'(?<!\w)(\w+)\s*:\s*(\w+)\s*(?=,|\n|\}|$)', m.group(1))
    names = [a for a, b in names]
    if not names:
        raise SystemExit('[FATAL] %s 的 module.exports 解析结果为空' % name)
    for nm in names:
        if not re.search(r'(?m)^(function|var)\s+%s\b' % re.escape(nm), src):
            raise SystemExit('[FATAL] %s 导出的 %s 在源文件中未找到定义' % (name, nm))
    return names


def build_iife(src, name, exports):
    """
    把一个源文件（已去掉 module.exports）包成 IIFE，返回 { name: {...exports} }。
    这样 norm/pl 的真实函数体逐字进入 GAS 文件，与 Node 模块同源。
    """
    inner = strip_leading_strict(strip_module_export(src))
    ret = ',\n  '.join('%s: %s' % (e, e) for e in exports)
    return 'var %s = (function() {\n%s\n  return { %s };\n})();' % (name, inner.rstrip(), ret)


def strip_core_requires(src):
    """去掉 Node 的 require('./ts_softdel_norm.js') / require('./period_lock_port.js') 两行。"""
    out = []
    for line in src.splitlines():
        if "require('./ts_softdel_norm.js')" in line or "require('./period_lock_port.js')" in line:
            continue
        out.append(line)
    return '\n'.join(out)


def strip_core_export(src):
    idx = src.find('\nmodule.exports = {')
    if idx >= 0:
        return src[:idx].rstrip() + '\n'
    return src


def build_gas_wrapper():
    """
    GAS 包装器：把 GAS 原生 API（SpreadsheetApp / LockService / Utilities / PropertiesService）
    适配成核心所需的 deps。这是 GAS 端【唯一】与 Node 不同的部分（依赖注入），业务逻辑零差别。
    """
    return r'''
// ============================================================
// GAS 包装器（依赖注入）：把 GAS 原生 API 适配成 tsSoftDelGuardedCore 的 deps。
// 这是 GAS 端【唯一】与 Node 不同的代码（仅依赖装配，不含任何业务判定）。
// 业务判定全部在上方内联的 tsSoftDelGuardedCore 中，与 Node 模块逐字一致。
// ============================================================
var TS_ID = '1Pi5u9fEawgp7yICWPMMyQCT_LbwTZthQDW-H05xYdVI';
var PL_DB_SHEET = 'DB_工时流水';
var MASTER_ID = '1oxPj0mzN8poP2vQ7Bm-YKXuU49p9b0c1asyrZn4Py44';
var BASE_TAB = '工时_候选0824';

// 强制日志（持久化到 _TS_SOFTDEL_LOG 页签）；写失败向上抛出（由核心判 UNKNOWN/阻断）。
function _sdGasJournalAppend(rec) {
  var ss = SpreadsheetApp.openById(TS_ID);
  var js = ss.getSheetByName('_TS_SOFTDEL_LOG');
  // v5：新增 reason 列 —— VOIDED 记录必须能说明「为什么失效」，否则失效只有状态没有依据。
  if (!js) { js = ss.insertSheet('_TS_SOFTDEL_LOG'); js.appendRow(['ts', 'jobId', 'subBatchId', 'itemId', 'requestHash', 'uuid', 'state', 'reason']); }
  js.appendRow([Utilities.formatDate(new Date(), 'GMT+8', 'yyyy-MM-dd HH:mm:ss'),
    rec.jobId, rec.subBatchId, rec.itemId, rec.requestHash, rec.uuid, rec.state, rec.reason]);
}
function _sdGasJournalGet(jobId, itemId) {
  try {
    var ss = SpreadsheetApp.openById(TS_ID);
    var js = ss.getSheetByName('_TS_SOFTDEL_LOG');
    if (!js) return null;
    var g = js.getDataRange().getValues();
    for (var i = g.length - 1; i >= 1; i--) {
      if (String(g[i][1] || '') === String(jobId) && String(g[i][3] || '') === String(itemId)) {
        return { jobId: g[i][1], subBatchId: g[i][2], itemId: g[i][3], requestHash: g[i][4], uuid: g[i][5], state: g[i][6], reason: g[i][7] };
      }
    }
  } catch (e) {}
  return null;
}
// 全量日志（Tom #4）：状态查询/幂等检索必须能看到该 jobId+itemId 下的【全部】记录，
// 不能只取「最后一条」—— 否则不同 requestHash 的冲突记录会遮蔽原完成凭据。
function _sdGasJournalList(jobId, itemId) {
  try {
    var ss = SpreadsheetApp.openById(TS_ID);
    var js = ss.getSheetByName('_TS_SOFTDEL_LOG');
    if (!js) return [];
    var g = js.getDataRange().getValues();
    var out = [];
    for (var i = 1; i < g.length; i++) {
      if (String(g[i][1] || '') === String(jobId) && String(g[i][3] || '') === String(itemId)) {
        out.push({ jobId: g[i][1], subBatchId: g[i][2], itemId: g[i][3], requestHash: g[i][4], uuid: g[i][5], state: g[i][6], reason: g[i][7] });
      }
    }
    return out;
  } catch (e) { return []; }
}

function _sdGasLock() {
  var lk = LockService.getScriptLock();
  if (!lk.tryLock(30000)) throw new Error('LOCK_BUSY');
  return lk;
}

function tsSoftDelGuarded(e) {
  e = e || {};
  var p = e.parameter || {};
  var body = e.postBody || {};
  try {
    var sheetName = String(p.sheet || body.sheet || PL_DB_SHEET);
    var prodSs = SpreadsheetApp.openById(TS_ID);
    var sh = prodSs.getSheetByName(sheetName);
    if (!sh) return JSON.stringify({ ok: false, error: 'sheet not found: ' + sheetName });
    var mss = SpreadsheetApp.openById(MASTER_ID);
    var msh = mss.getSheetByName(BASE_TAB);

    // 真实策略读取（v5 B2）：把 PropertiesService 注入 pl._plPolicyFromProps。
    // propsGetter 抛错时由 _plPolicyFromProps 内部收敛为 fail-closed，此处不再额外吞异常。
    function _sdGasPolicy() {
      return pl._plPolicyFromProps(function (k) {
        return PropertiesService.getScriptProperties().getProperty(k);
      });
    }

    var deps = {
      PL_DB_SHEET: PL_DB_SHEET,
      isClearance: function (tok, rows) { return false; },          // 默认不放开门禁
      guardCheck: function (bizDate, origBiz, policy) { return pl._plGuardCheck(bizDate, origBiz, policy || _sdGasPolicy()); },
      // v5 B2（Tom 第 4 项）：policy 改为【真实读取生产 PropertiesService 策略】。
      //   此前固定返回 pl._plPolicy()（source:'unset'），等于生产策略从未被执行入口遵守。
      //   _plPolicyFromProps 内部 fail-closed：读取异常 / 哨兵未知 / 策略丢失 /
      //   JSON 损坏 / schema 非法 一律收紧（closed=true, futureOpen=false）。
      //   边界：**只读**，不初始化、不改写生产策略。
      policy: _sdGasPolicy,
      // 诚实声明：LockService.getScriptLock() 按 Google 官方说明【仅作用于脚本】，
      // 只能序列化本项目内的并发执行；不提供跨项目/跨文档互斥，本处不声称跨项目写协调。
      acquireMasterLock: _sdGasLock,                                  // 本项目内并发串行化（先取）
      acquireLock: _sdGasLock,                                        // 同锁可重入（后取）
      releaseLock: function (lk) { try { lk.releaseLock(); } catch (e) {} },
      releaseMasterLock: function (lk) { try { lk.releaseLock(); } catch (e) {} },
      readProdRow: function (row) { try { return sh.getRange(row, 1, 1, 15).getValues()[0]; } catch (e) { return null; } },
      // Tom #4：读失败必须向上抛出（让核心登记 UNKNOWN），不能吞成 null 冒充「读到了空值」。
      readProdO: function (row) { return sh.getRange(row, 15).getValue(); },
      // Tom #4：区分「未写」与「已写但未确认」—— setValue 失败 = 未写（false）；
      //   setValue 成功但 flush 失败 = 写可能已发生、无法确认 → 抛出，由核心记 UNKNOWN，
      //   绝不返回 false 让核心误判为「已确认未写」。
      writeProdO: function (row, val) {
        try { sh.getRange(row, 15).setValue(val); }
        catch (e) { return false; }
        try { SpreadsheetApp.flush(); }
        catch (fe) { throw new Error('FLUSH_FAILED: ' + (fe && fe.message || fe)); }
        return true;
      },
      readAllMaster: function () {
        try {
          if (!msh) return { map: {}, complete: false, error: 'MASTER_TAB_MISSING', version: null };
          var last = msh.getLastRow();
          var map = {}, vals = [];
          if (last > 1) {
            vals = msh.getRange(1, 1, last, 15).getValues();
            for (var r = 0; r < vals.length; r++) {
              var u = norm._sdNorm(vals[r][8]);
              if (u) (map[u] = map[u] || []).push({ row: r + 1, cells: vals[r] });
            }
          }
          // version：主库内容指纹（真实快照，内容变则版本变）。
          // Tom #6：指纹必须覆盖【全部相关列 0..14】并绑定 rowCount ——
          //   只覆盖 1..9 列会让 0/10..14 列的改动（含同 rowCount 改值）不触发版本变化。
          var allCols = []; for (var ci = 0; ci <= 14; ci++) allCols.push(ci);
          var fp = norm._sdSha256(JSON.stringify({
            rowCount: vals.length,
            rows: vals.map(function (row) { return norm._sdCanonRow(row, allCols); })
          }));
          return { map: map, complete: true, version: fp };
        } catch (e) { return { map: {}, complete: false, error: String(e && e.message || e), version: null }; }
      },
      journalAppend: _sdGasJournalAppend,                              // 强制日志依赖
      journalGet: _sdGasJournalGet,
      journalList: _sdGasJournalList                                   // 全量日志（身份检索用）
    };
    return tsSoftDelGuardedCore(e, deps);
  } catch (err) {
    return JSON.stringify({ ok: false, error: String(err && err.message || err), patched: 0 });
  }
}
'''


def main():
    core_src = read(CORE)
    norm_src = read(NORM)
    pl_src = read(PL)

    # 1) norm / pl 内联为 IIFE（与 Node 模块同源）
    # 导出名自动解析（不再硬编码）—— 见 parse_exports 说明
    norm_iife = build_iife(norm_src, 'norm', parse_exports(norm_src, 'norm'))
    pl_iife = build_iife(pl_src, 'pl', parse_exports(pl_src, 'pl'))

    # 2) 核心：去掉 require + module.exports
    core_clean = strip_core_export(strip_core_requires(core_src))

    # 3) 拼装 GAS 文件
    gas = []
    gas.append('// ============================================================')
    gas.append('// GAS 端 tsSoftDelGuarded —— 由 gen_gas_softdel.py 从单一可信源生成')
    gas.append('// 源：ts_softdel_core.js + ts_softdel_norm.js + period_lock_port.js')
    gas.append('// 与 Node 模块【逐字一致】的业务逻辑，仅依赖装配（下方 GAS 包装器）不同。')
    gas.append('// ============================================================')
    gas.append("'use strict';")
    gas.append('')
    gas.append(norm_iife)
    gas.append('')
    gas.append(pl_iife)
    gas.append('')
    # 核心源码（已去 require / module.exports）；其内部对 norm./pl. 的引用由上面 IIFE 提供
    gas.append(core_clean.rstrip())
    gas_wrapper = build_gas_wrapper()
    gas.append(gas_wrapper)

    out = '\n'.join(gas) + '\n'
    os.makedirs(OUT_DIR, exist_ok=True)
    out_path = os.path.join(OUT_DIR, 'ts_softdel_gas_embedded.js')
    with open(out_path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(out)

    # 4.5) 同步 FINAL_FILE 的【内联核心区】到单源（回应 Tom #1 单源铁律的漏洞）：
    #   此前 FINAL_FILE 末尾持有一份【独立】内联副本（旧 v4_genpatches.py 生成），
    #   与 embedded 文本不一致 → makeDispatch 加载的“真实部署入口”行为偏离单源。
    #   现改为：FINAL_FILE 的「var norm = (function() {」起至文件末尾，整体替换为
    #   与 embedded 内联区【逐字一致】的 norm/pl/core/wrapper 块（同一套生成逻辑）。
    #   前置 dispatch 区（含 softDelGuarded/statusQuery → tsSoftDelGuarded 的映射）保持不变。
    fin_src = read(FINAL_PATH)
    ai = fin_src.find(FINAL_ANCHOR)
    if ai < 0:
        raise SystemExit('[FATAL] 在 FINAL_FILE 找不到锚点 %s' % FINAL_ANCHOR)
    fin_prefix = fin_src[:ai]                      # 保留前置 dispatch + 哨兵注释 + 其 'use strict'
    # 直接复用 embedded 的内联区（从锚点到 EOF），保证 FINAL_FILE 与 embedded【逐字一致】，
    # 杜绝任何重建拼接带来的空白差异（verifier 断言4 要求精确相等）。
    emb_region = out[out.find(FINAL_ANCHOR):]
    if not emb_region.startswith(FINAL_ANCHOR):
        raise SystemExit('[FATAL] embedded 找不到锚点 %s' % FINAL_ANCHOR)
    fin_out = fin_prefix + emb_region
    with open(FINAL_PATH, 'w', encoding='utf-8', newline='\n') as f:
        f.write(fin_out)

    # 4) 逐函数对照表
    map_lines = []
    map_lines.append('# GAS 生成物 ↔ Node 单一可信源 逐函数对照')
    map_lines.append('')
    map_lines.append('> 生成物：`tools/v4_patches/full/ts_softdel_gas_embedded.js`（自包含，可直接注入 RemoteActions.js 替换旧 tsSoftDelGuarded）。')
    map_lines.append('> 本文件由 `gen_gas_softdel.py` 自动生成：norm/pl 以 IIFE 逐字内联，核心逻辑与 Node `ts_softdel_core.js` 文本一致。')
    map_lines.append('')
    map_lines.append('## 规范化 / 期锁（来自 ts_softdel_norm.js / period_lock_port.js，内联为 `norm` / `pl` 对象）')
    map_lines.append('')
    map_lines.append('| 函数 | GAS 内联名 | 说明 |')
    map_lines.append('|------|-----------|------|')
    for fn in ['_sdIsoTz', '_sdCellTok', '_sdHashCols', '_sdCanonRow', '_sdSha256', '_sdRowHash',
               '_sdNorm', '_sdSoftDel', '_sdTestVectors', '_sdSelfTest']:
        map_lines.append('| `%s` | `norm.%s` | 类型保全规范化 / SHA-256 指纹（环境自适应） |' % (fn, fn))
    for fn in ['_plParseBizDate', '_plIsClosedBizDate', '_plGuardCheck', '_plPolicy']:
        map_lines.append('| `%s` | `pl.%s` | 真实期锁适配器纯逻辑 |' % (fn, fn))
    map_lines.append('')
    map_lines.append('## 业务核心（来自 ts_softdel_core.js，文本一致）')
    map_lines.append('')
    map_lines.append('| Node 导出/函数 | GAS 对应 | 说明 |')
    map_lines.append('|---------------|-----------|------|')
    map_lines.append('| `tsSoftDelGuardedCore(e, deps)` | 同函数（内联） | 主入口：锁内 CAS + 写 + 回读闭环 |')
    map_lines.append('| `_validateInput(e, deps)` | 同函数（内联） | 结构化校验 / keeper 图 |')
    map_lines.append('| `journal(deps, ...)` | 同函数（内联） | 强制日志（返回布尔） |')
    map_lines.append('| `tsSoftDelStatus(e, deps)` | 同函数（内联） | 只读状态查询 |')
    map_lines.append('| `VERSION=\'ts_softdel_core/3\'` | 同常量（内联） | 响应契约版本 |')
    map_lines.append('')
    map_lines.append('## 依赖装配（GAS 端唯一差异：仅注入，无业务判定）')
    map_lines.append('')
    map_lines.append('| deps 键 | GAS 实现 |')
    map_lines.append('|---------|-----------|')
    map_lines.append('| `readProdRow/readProdO/writeProdO` | `sh.getRange(...)` 直读生产表 |')
    map_lines.append('| `readAllMaster` | 读主库底稿 + 内容指纹作为 `version` |')
    map_lines.append('| `acquireLock/acquireMasterLock` | `LockService.getScriptLock().tryLock(30000)`（LOCK_BUSY fail-closed） |')
    map_lines.append('| `journalAppend/journalGet/journalList` | `_TS_SOFTDEL_LOG` 页签持久化（journalList 供身份检索） |')
    map_lines.append('| `guardCheck/policy` | 调用内联 `pl._plGuardCheck`；policy 经 `pl._plPolicyFromProps` **真实读 PropertiesService**（fail-closed） |')
    map_lines.append('')
    with open(MAP_PATH, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(map_lines) + '\n')

    print('[OK] 生成 GAS 文件：' + out_path)
    print('[OK] 生成对照表：' + MAP_PATH)
    print('[OK] 同步 FINAL_FILE 内联核心区：' + FINAL_PATH)
    print('[INFO] GAS 文件行数：%d' % out.count('\n'))
    print('[INFO] FINAL_FILE 行数：%d' % fin_out.count('\n'))


if __name__ == '__main__':
    main()
