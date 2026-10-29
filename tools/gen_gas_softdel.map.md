# GAS 生成物 ↔ Node 单一可信源 逐函数对照

> 生成物：`tools/v4_patches/full/ts_softdel_gas_embedded.js`（自包含，可直接注入 RemoteActions.js 替换旧 tsSoftDelGuarded）。
> 本文件由 `gen_gas_softdel.py` 自动生成：norm/pl 以 IIFE 逐字内联，核心逻辑与 Node `ts_softdel_core.js` 文本一致。

## 规范化 / 期锁（来自 ts_softdel_norm.js / period_lock_port.js，内联为 `norm` / `pl` 对象）

| 函数 | GAS 内联名 | 说明 |
|------|-----------|------|
| `_sdIsoTz` | `norm._sdIsoTz` | 类型保全规范化 / SHA-256 指纹（环境自适应） |
| `_sdCellTok` | `norm._sdCellTok` | 类型保全规范化 / SHA-256 指纹（环境自适应） |
| `_sdHashCols` | `norm._sdHashCols` | 类型保全规范化 / SHA-256 指纹（环境自适应） |
| `_sdCanonRow` | `norm._sdCanonRow` | 类型保全规范化 / SHA-256 指纹（环境自适应） |
| `_sdSha256` | `norm._sdSha256` | 类型保全规范化 / SHA-256 指纹（环境自适应） |
| `_sdRowHash` | `norm._sdRowHash` | 类型保全规范化 / SHA-256 指纹（环境自适应） |
| `_sdNorm` | `norm._sdNorm` | 类型保全规范化 / SHA-256 指纹（环境自适应） |
| `_sdSoftDel` | `norm._sdSoftDel` | 类型保全规范化 / SHA-256 指纹（环境自适应） |
| `_sdTestVectors` | `norm._sdTestVectors` | 类型保全规范化 / SHA-256 指纹（环境自适应） |
| `_sdSelfTest` | `norm._sdSelfTest` | 类型保全规范化 / SHA-256 指纹（环境自适应） |
| `_plParseBizDate` | `pl._plParseBizDate` | 真实期锁适配器纯逻辑 |
| `_plIsClosedBizDate` | `pl._plIsClosedBizDate` | 真实期锁适配器纯逻辑 |
| `_plGuardCheck` | `pl._plGuardCheck` | 真实期锁适配器纯逻辑 |
| `_plPolicy` | `pl._plPolicy` | 真实期锁适配器纯逻辑 |

## 业务核心（来自 ts_softdel_core.js，文本一致）

| Node 导出/函数 | GAS 对应 | 说明 |
|---------------|-----------|------|
| `tsSoftDelGuardedCore(e, deps)` | 同函数（内联） | 主入口：锁内 CAS + 写 + 回读闭环 |
| `_validateInput(e, deps)` | 同函数（内联） | 结构化校验 / keeper 图 |
| `journal(deps, ...)` | 同函数（内联） | 强制日志（返回布尔） |
| `tsSoftDelStatus(e, deps)` | 同函数（内联） | 只读状态查询 |
| `VERSION='ts_softdel_core/3'` | 同常量（内联） | 响应契约版本 |

## 依赖装配（GAS 端唯一差异：仅注入，无业务判定）

| deps 键 | GAS 实现 |
|---------|-----------|
| `readProdRow/readProdO/writeProdO` | `sh.getRange(...)` 直读生产表 |
| `readAllMaster` | 读主库底稿 + 内容指纹作为 `version` |
| `acquireLock/acquireMasterLock` | `LockService.getScriptLock().tryLock(30000)`（LOCK_BUSY fail-closed） |
| `journalAppend/journalGet/journalList` | `_TS_SOFTDEL_LOG` 页签持久化（journalList 供身份检索） |
| `guardCheck/policy` | 调用内联 `pl._plGuardCheck`；policy 经 `pl._plPolicyFromProps` **真实读 PropertiesService**（fail-closed） |

