# T1-B 独立核验指南（VERIFY_GUIDE）

> 目的：让审核方（Tom）**不依赖我方「报告」**、**不触碰生产数据**，自行复算全部结论。
> 所有输入均为只读快照，脚本零依赖（仅 Node.js 内置模块），可离线运行。

## 0 前置条件

- 安装 Node.js（v14+ 任意版本即可，**无需 `npm install`**）。
- 本目录已含全部所需文件：
  - `prod_scan_LIVE_*.json`（源快照：每行原始 15 列 cells）
  - `controlled_audit_EXACT_ALL_*.json`（审计 JSON：target/keeper/base 哈希）
  - `T1-B_候选保留映射_可核查_*.csv`（逐行候选↔保留映射）
  - `verify_mapping.js`（L1/L2/L3 源快照重算）
  - `concurrency_test_harness.js`（Edit A 并发重放负例）
  - `_sdRowHash` 算法以 `tools/ts_softdel_norm.js` 为单一可信源，`verify_mapping.js` 内联逐字同文。

## 1 三级映射核验（L1/L2/L3）

```bash
cd evidence/2026-11-01
node verify_mapping.js
```

预期输出（节选）：

```
=== T1-B 全量映射独立核验报告 ===
L1 表内一致性:
  CSV 数据行 = 1340 (期望 1340)
  SAFE = 866 / NOT_IN_BASE = 474 (期望 866 / 474)
  targetHash==keeperHash 且 同值=TRUE = 1340 / 1340
L2 审计JSON:
  审计JSON 候选目标总数 = 1340 (期望 == CSV 数据行 1340)
L3 源快照重算 (prod_scan -> _sdRowHash):
  target 重算命中 = 1340 / 1340
  keeper 重算命中 = 1340 / 1340
  底稿 baseHash 复核(有底稿组) = 866 / 866

RESULT: PASS ✅
```

退出码 0 = 通过；非 0 = 失败（会打印未命中行号，便于定位）。

**含义**：L3 用「源快照 `prod_scan` 的 `byUuid[uuid][].cells`」按同一 `_sdRowHash` 重算，与审计 JSON 记录的 `targetHash/keeperHash` 逐行比对。命中 = 哈希确实源自源快照，映射可信，非凭空声明。

## 2 算法可独立重算（可选，验证脚本本身没「说谎」）

`_sdRowHash` 规范（与 `tools/ts_softdel_norm.js` 一致）：

- 纳入列：固定 `列1`(业务日期, ISO+08:00) + `列2..13`(负载) + `列14`(审计列O)；`!timeOnly` 时追加 `列0`(录入时间)。
- 每列经 `_sdCellTok` 类型保全规范化：数字→`['num',...]`、布尔→`['bool',...]`、字符串→`['str',...]`、null→`['null']`、日期→`['date',ISO+08:00]`。**前导零 `"007"` 不会变成数字**，杜绝裸分隔符歧义。
- `canon = JSON.stringify(每列token数组)`；`hash = 'sha256:' + SHA256(canon, utf8)`。
- `targetHash == keeperHash` ⇒ 两行业务字段逐列一致 ⇒ 候选是保留行的冗余副本。
- `baseHash`：`hasBase=true` 时底稿行哈希；`hasBase=false` 显式 `NO_BASE`（绝不伪造）。

你可在任意语言中照此重算任意一行的哈希，与 CSV/审计 JSON 中的值比对，确认脚本内联算法与「单一可信源」一致。

## 3 Edit A 并发重放负例（证明根因 & 修复）

```bash
cd evidence/2026-11-01
node concurrency_test_harness.js
```

预期输出：

```
=== T1-B 并发重放负例测试 (concurrency_test_harness) ===
--- 测试1：确定性交错（两并发写者，同批新 UUID A,B） ---
  当前代码 → 行数 4 (期望 4 = 含 2 重复)
  修复代码 → 行数 2 (期望 2 = 0 重复)
  [当前代码] 50 并发写同 UUID → 写入行数 50，唯一UUID 1
  [修复(Edit A)] 50 并发写同 UUID → 写入行数 1，唯一UUID 1
--- 结论 ---
  当前代码产生重复行(竞态存在): YES ✅
  Edit A 修复消除重复(锁内重读): YES ✅

RESULT: PASS ✅ (根因与修复均可复现)
```

**含义**：当前代码在锁外读 `exist`（对应 `RemoteActions.js:96-105`）后在锁内直接写锁外算好的 `toWrite`，两并发写者读到同一空 `exist` → 都判定可写 → 重复行。Edit A 传入 `lockPreWrite` 闭包，在锁内（`:490` 之后）重读 `exist` 并重判 `toWrite`，`bizWrite(:509)` 只写锁内重判后的行 → 消除重放。

> 注：本脚本证明「进程内」锁语义（Edit A 充分）。**Edit B（`getScriptLock`→`getDocumentLock` 跨项目互斥）需要两个独立 GAS 项目 + 同表的真实实验**，Node 单进程无法证明。实验规范见 §4，属 Tom 此前点名的 N1–N4 / 跨项目互斥实证——由审核方在其环境执行。

## 4 Edit B 跨项目互斥实验规范（待审核方执行）

目标：证明两独立 GAS 项目同时写同一生产表时，`getDocumentLock()` 确实互斥，`getScriptLock()` 不互斥。

实验设计（建议）：

1. 建两个独立 Apps Script 项目 P1、P2，均对生产表 `DB_工时流水` 做 `appendRows`（走 `_plGuardedInsert`）。
2. 基线（复现缺陷）：P1/P2 用 `LockService.getScriptLock()`（当前 `PeriodLockGuard.js:260`），并发触发 → 观察是否出现重复行（预期：会，因 script lock 仅锁本脚本实例）。
3. 修复（Edit B）：`:260` 改为 `LockService.getDocumentLock()`，重复实验 → 观察重复行是否消失（预期：消失，因 document lock 锁到文档级、跨所有写同表的脚本共享）。
4. 边界：测试锁超时（默认 30s）与异常释放（脚本抛错时锁是否如期释放，不残留死锁）。
5. 记录：每轮写入行数、唯一 UUID 数、锁等待/超时日志。

交付物：上述 1–5 的数字与日志，作为 Edit B 的接受/驳回依据。

## 5 诚实边界（非缺口）

- 866 SAFE 含 0824 底稿佐证（`baseHash` 可核）；474 NOT_IN_BASE `hasBase=false` 显式 `NO_BASE`，**按原状保留不删**，待 Rita 最终裁定。
- 空 UUID 池（5,221 行 / 22,657h / 47%）一律 `UNKNOWN` 保留原状，不进映射。
- TIMEONLY 227 行保留不删。
- 本目录全部为只读快照与验证脚本，**零生产写、零线上改动**。
