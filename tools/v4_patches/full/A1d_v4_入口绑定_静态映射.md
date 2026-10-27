# A1d-v4 入口绑定 —— 静态映射（回应 Tom #2）
最终文件：`RemoteActions.A1d_v4_FINAL_entry_bound.js`
（本补丁不部署、不换链接；只给出最终源码与静态映射，供离线核验。）

## 1. 已删除的旧实现（不再是"同名函数并存"）
删除范围：原文件第 1174–1333 行（旧入口及其全部助手，删除到文件末尾）。

| 删除项 | 说明 |
|---|---|
| `function _isFalse(` | 旧 A1d 实现遗留（旧实现助手） |
| `function _isTrue(` | 旧 A1d 实现遗留（旧实现助手） |
| `function _sdBuildMasterMap(` | 旧 A1d 实现遗留（旧实现助手） |
| `function _sdIsClearance(` | 旧 A1d 实现遗留（旧实现助手） |
| `function _sdNorm(` | 旧 A1d 实现遗留（旧实现助手） |
| `function _sdNormHash(` | 旧 A1d 实现遗留（旧实现助手） |
| `function _sdSoftDel(` | 旧 A1d 实现遗留（旧实现助手） |
| `var _SD_ROW_KEYS` | 旧 A1d 实现遗留（旧实现助手） |

删除前校验：这些标识符在原文件第 1–1173 行（即保留区）内**零引用**，`awk` 统计为 0，故删除不影响其它动作。

## 2. 原链路 → 新核心 的静态映射（行号为最终文件）

| 环节 | 最终文件位置 | 说明 |
|---|---|---|
| 路由注册 | 第 24 行 `softDelGuarded: function(e) { return tsSoftDelGuarded(e); }` | REMOTE_ACTIONS 表项，未改动 |
| 受控入口 | 第 1998 行 `function tsSoftDelGuarded(e)` | 【新】由生成文件提供；旧定义已删除，全局唯一 |
| statusQuery 分支 | 第 1590 行 `action === 'statusQuery'` | 状态查询**经同一入口**分流，不是第二个入口 |
| 业务核心 | 第 1587 行 `function tsSoftDelGuardedCore(e, deps)` | 与 Node 模块同源 |
| 状态查询实现 | 第 1882 行 `function tsSoftDelStatus(e, deps)` | 只读，逐项绑定身份 |
| 依赖装配 | 第 1992 行 `function _sdGasLock()` 起 | GAS 原生依赖注入；ScriptLock 仅作用于本脚本（已如实声明） |
| 全量日志检索 | 第 1976 行 `function _sdGasJournalList(` | 供身份检索，不再只取最后一条 |
| 版本常量 | 第 1480 行 | 与 Node 侧 `ts_softdel_core.js` 同源同值 |

## 3. doPost / 请求装配（如实说明可证明与不可证明的部分）
- **可静态证明**：`REMOTE_ACTIONS.softDelGuarded` → `tsSoftDelGuarded(e)` → `tsSoftDelGuardedCore(e, deps)`；`action=statusQuery` 时在同一入口内分流到 `tsSoftDelStatus(e, deps)`。
- **不可离线证明**：doPost 到 `REMOTE_ACTIONS[...]` 的分发发生在 `RemoteTrigger.gs` 的 `_rtMaybeHandle(e)`，该文件不在本次交付的文件集内；且本次**未部署、未发起任何生产请求**，因此不声称对线上调用链做过实测。
- 客户端侧装配证据：`tools/ts_post.py` 以 `action=softDelGuarded` 发送；状态查询以 `action=statusQuery` 发往**同一 action 端点**（见 `tools/ts_softdel.js` 的 `--status` 分支），不另开入口。

## 4. 本补丁的边界
- 不含部署、不含链接变更、不含任何生产写操作。
- 未修改 `RemoteActions` 中其它 40+ 个动作的注册与实现。
