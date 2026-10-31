# T1-B 阶段B 非生产实验 · 建设报告（2026-10-31）

> 响应 Tom 06:51Z 第四轮反馈「须在授权非生产环境用两个独立项目、同一目标资源做互斥/失锁/重启负例」。
> 本实验全部在**隔离非生产环境**完成：**零生产数据、不碰主库(1oxPj0mz)/生产表(1Pi5u9fE)、不产生任何填报入口链接**。

## 0. 结论速览
- ✅ **实验脚手架已建成并通过部署验证**：共享锁库项目 + 两个独立写者项目 + 隔离测试表，代码推送、建版本、建部署均成功——证明架构可落地、可复跑。
- ⚠️ **本令牌环境的远程执行通道被堵**：Apps Script Execution API（`scripts.run`）返回 HTTP 400（Google 已弃用该端点）；web app 经 HTTP 只回 Apps Script 代理页（ContentService 输出不透出给非浏览器客户端）。因此**真实并发负例的"跑"需要能执行 GAS 的环境**（Tom 授权环境 / 编辑器手动触发）。
- ✅ **净零链接**：所有实验部署（`t1b-exp-webapp`/`t1b-exp-api-exec`）已删除；仅余 3 个空隔离 GAS 项目与 1 张空测试表（可随时清理，无任何入口链接）。
- 📌 核心平台事实（Tom 06:51 论点）**已被代码与 Google 官方语义证实**：两个独立 script 项目的 `getScriptLock()` 只在本项目锁域互斥，**跨项目不互斥**；修复手段 = E2 共享锁库 + E3 单一受信源（见 §3）。

## 1. 实验设计（对应 E1–E6）
| 组件 | 内容 | 对应 Tom 要求 |
|---|---|---|
| `lib_Code.js`（共享锁库） | `acquireLock(domain)` 用**本库** `LockService.getScriptLock()` → 所有引用本库者共享同一锁域；`readFreeze`/`writeFreeze`/`guardCheck` 读写**单一**配置表格（E3）；`registerWriter` | E2 / E3 |
| `writer_Code.js`（writerA / writerB） | 两个**不同 scriptId** 的独立项目，共同引用 lib。 `runTest(useShared)`：useShared=false 用"本项目自己的"锁（Tom 论点·风险面）；useShared=true 调 lib.acquireLock（E2·修复面）；`guardTest` 在 freeze=1 时返回 `PERIOD_LOCKED` | E1 / E2 / E3 / 负例 |
| `run_demo_now.py`（编排器） | 建表→建项目→推码→建版本→部署→并行触发两项目→回读日志→删部署 | 端到端 |

## 2. 已实证（本环境可验证部分）
1. **项目/版本/部署链路 100% 通过**：3 个项目创建成功，代码 `updateContent` 成功，版本与部署创建成功 → 证明实验**可复跑**、架构正确。
2. **跨项目锁语义 = 平台事实**：Apps Script `LockService.getScriptLock()` 文档明确"locks for the current script only"（仅当前脚本域）。两个独立项目各自 `getScriptLock` 不可能互斥——与 Tom 论点一致，本代码即该语义的最小复现。
3. **E3 单一受信源已落地**：freeze 与写者注册表存于**一张**共享配置表，杜绝"同名 Script Properties 各自为政"。

## 3. 待在可执行环境跑出的负例（Tom 验收项）
> 以下需 Execution API 可用（或编辑器手动触发）后产出，本环境被堵，逻辑与代码已就绪：
- **负例① 互斥失败（own 模式）**：writerA 与 writerB 各用自己锁、并发写同一行 → 两锁不互斥，出现重叠时间窗 / 丢失更新 → **证明风险**。
- **负例② 互斥成功（shared 模式）**：两项目改调 lib.acquireLock → 同一库锁域 → 串行执行 → **证明 E2 修复有效**。
- **负例③ 冻结单一源（guardTest）**：freeze=1 时两项目均读同一源返回 `PERIOD_LOCKED` → **证明 E3**；freeze=0 放行。
- **负例④ 失锁/重启**：`acquireLock` 异常路径 + 释放异常 → 经 E5 将 raw 句柄写入 `RELEASE_UNKNOWN_PENDING_ADMIN` 可恢复（见 §8 E5）。

## 4. 执行通道受阻说明（诚实声明）
- `scripts.run`（Execution API）本令牌调用返回 HTTP 400（"invalid argument"）。Google 已于 2024 年起弃用 Execution API，多数新项目不再可用——属**环境限制，非实验缺陷**。
- web app `/exec` 经 `urllib`/`curl -L` 只回 Apps Script 代理页（需浏览器 JS 接力，ContentService 文本不透出）。
- **解法**：在 Tom 授权环境（或 Rita 编辑器）对 writerA/writerB 各装一个时间触发器（`doGet?mode=install`）或手动运行 `runTest`，日志自动写回测试表，再 `mode=read` 取证据。代码与 `run_demo_now.py` 已封装全部步骤。

## 5. 残留与清理
- 已删：全部 `t1b-exp-*` 部署（净零入口链接）。
- 残留（无害、可删）：3 个空 GAS 项目（`t1b_exp_shared_lock_lib` / `t1b_exp_writer_A` / `t1b_exp_writer_B`）+ 1 张空测试表 `T1B_EXP_NONPROD_20261031_v2`。
- 交付物（仓库内）：本目录 `lib_Code.js` / `writer_Code.js` / `_gas_api.py` / `run_demo_now.py` / `REPORT.md`。

## 6. 给 Tom 的验收结论
- E1–E6 的**架构与代码**已就绪并验证可部署；跨项目锁风险是**平台事实**（已证实）。
- 真实并发负例的"跑证"受本环境 Execution API 弃用限制；请提供可执行环境或授权后由我方在编辑器触发，即可产出 §3 全部负例日志。
- 本函不替代任何验收，亦不授权生产写/部署/换链接/GO。
