# GO-S4 证据跑批包（runbook）

> 用途：把"GO-S4 五前置"从"设计/承诺"变成"可一键执行、可核验的证据采集流程"。
> 本文件为【执行预案，非已执行报告】。分两层闸：Stage-0（安全，零生产写，可在 `TS_WRITE_FREEZE` 锁定下立即跑）与 Stage-1（需治理授权：翻 `TS_WRITE_FREEZE` + 放行 clearance 令牌，当前 BLOCKED）。
> 关联：权威页 `22_NextPhase/T1-B_大局梳理与收敛方案_20261027.md` §六-v7（X批复审）+ 本 runbook。
> 当前 HEAD：见 `git rev-parse HEAD`（本批提交 `97bbd5c` 之后）。

---

## 0. 现状闸门（不可跳过）

| 闸门 | 状态 | 谁解锁 |
|---|---|---|
| `TS_WRITE_FREEZE`（写冻结，默认锁） | 锁定 | Rita 显式治理授权翻闸 |
| 期锁 clearance 令牌 | 未发放 | Rita 授权 + Tom 放行（非 `isClearance` 桩） |
| GO-S4 五前置 | ①–④ NO-GO；⑤ 已授权 | 见各条 |

**铁律**：Stage-1 任何脚本在 `TS_WRITE_FREEZE!=1`（未获授权）或缺少有效 clearance 时，`guardCheck` 必须 `PERIOD_LOCKED`/`CLEARANCE_REQUIRED` fail-closed，**绝不静默写生产**。本 runbook 的 Stage-0 已通过代码保证零生产写；Stage-1 的 fail-closed 由 `tools/ts_softdel.js` 守卫强制。

---

## 1. Stage-0（安全层 · 零生产写 · 现在即可跑）

目标：在不动生产、不改 freeze 的前提下，产出 Tom 可独立核验的"代码正确性 + 零写保证 + 单源一致"证据。

| # | 证据项 | 命令（在仓库根） | 验收 |
|---|---|---|---|
| S0-1 | 隔离内核级证据 | `python tools/ts_repro_isolation_runner.test.py` | 17/17 PASS（含 mountinfo ro + route 无默认路由 + 三反例） |
| S0-2 | 读取守卫 | `node tools/ts_read_guard.test.js` | 17/17 PASS |
| S0-3 | 受控读取（去伪装 + 终点 probe） | `node tools/ts_controlled_audit.test.js` | 11/11 PASS |
| S0-4 | 写入失败停止 + journal 返回值 | `node tools/ts_softdel_core.precheck.test.js` | 9/9 PASS（含 COMMITTED 失败→UNKNOWN） |
| S0-5 | 单源逐字一致（两份 GAS 产物 = core） | `python tools/verify_gas_single_source.py` | 全部断言通过 |
| S0-6 | GAS↔Node 等价 | `node tools/ts_softdel_gas_harness.js` | 43/43 PASS |
| S0-7 | 生成器幂等 | `python tools/gen_gas_softdel.py && python tools/verify_gas_single_source.py` | 重跑后产物 SHA-256 不变 |
| S0-8 | JS 语法 | `node --check tools/*.js` | 全部 OK |

**产出**：`evidence/run_<UTC日期>.log`（本批已捕获，见 `evidence/`）。审阅方可用 GitHub 只读连接器自行复跑 S0-1…S0-8 验证，无需我方代为"证明"。

---

## 2. Stage-1（治理授权层 · 需翻 freeze + clearance · BLOCKED）

> 下列每条均设"双闸门自检"：脚本首行读 `TS_WRITE_FREEZE` 与 clearance，不满足即 exit(2) 不执行任何写。

### ① 真实入口 / 生成物 / 客户端 / 部署身份绑定
- **S1-1 真实接口契约**：为 `tools/ts_controlled_audit.js:75 readAll` 注入【真实 `inspectWorkbook` 适配器】，绑定生产表 `DB_工时流水` 实际返回的空行/稀疏格式；复跑 `readAll` 单测并新增断言：
  - 源版本绑定（记录实际 API 版本号 + 契约字段）；
  - 写者稳定（采集期零变化，由 `revision`/`lastRow` 漂移断言 + 服务端 CAS 重读兜底）。
  - 文件:行：`tools/ts_controlled_audit.js:75` + 新增 `tools/ts_controlled_audit_realif.test.js`。
  - 验收：适配器绑定真实源版本、漂移断言通过、零生产写。
- **S1-2 客户端/部署身份**：导出实际部署 URL 与 `developmentMode` 状态，核对"不换链接"不变量（部署数/版本与推前一致）。

### ② 目标/keeper/底稿 + 期锁 + 时长当前版本与业务证据
- **S1-3 候选集重派生（离线）**：用 `tools/ts_controlled_audit_offline.js` 从生产扫描 + 底稿快照重算受控候选（phase1 精确A 1230 组/3061h、phase2 col0 差 225 组/385.5h、phase2 B 级 259 组），输出候选 CSV + 哈希。
  - 验收：受控 1714 行 + 64 待授权、UNSAFE=0、0 mixed load、复用 `_sdRowHash` 单一可信源。
- **S1-4 期锁依据**：导出 `bizDate<2026-10-01` 的 100% 历史重复行清单，作为"已锁账期需 clearance"的治理依据（非绕过）。

### ③ 真实路径批次停止 / 独立回读 / 中断恢复 / 稳定快照
- **S1-5 全批停止 + 独立回读**：在真实环境以 `--dry-run` 跑 `tools/ts_softdel.js`，断言"预检失败零业务写 / 写后抛错零残留 / 回读不一致即 UNKNOWN"。
  - 文件:行：`tools/ts_softdel.js` + `tools/ts_softdel_core.js:384–386,491–501`。
  - 验收：precheck 9/9 在真实入口复跑通过并导出日志。
- **S1-6 中断恢复状态机**：提供 `core` 状态枚举导出（`PREPARED→UNCONFIRMED/UNKNOWN`）+ 客户端轮询契约测试，任何不明先对账、不盲重放。
  - 验收：状态枚举端到端统一，对账结论写入撤销/重放台账。

### ④ 全部写者/触发器/跨项目协调/部署权限/隔离/clearance
- **S1-7 写者稳定 + 部署权限基线**：核对 `@HEAD` 部署清单（`clasp list-deployments`）与推前一致；导出 webapp/脚本调用方清单。
- **S1-8 clearance 落地（替换桩）**：将 `core:183 isClearance`（当前取锁前）+ `embedded:1101 return false` 桩替换为真实实现（签发/验签/作用域/同锁 nonce 消费/撤销恢复），落码后独立单测 + Tom 复核。
  - 文件:行：`tools/ts_softdel_core.js:182`、`ts_softdel_gas_embedded.js:1101`、设计 `contract/clearance_and_baseread_design.md` §1.5–§1.6。
  - 验收：TOCTOU 修正（校验移入 `guardCheck` 同锁区间），nonce 重放拒绝，撤销恢复状态机测试通过。

---

## 3. 翻闸执行顺序（仅 Rita 授权 + Tom 放行后）

1. Rita 授权 → `TS_WRITE_FREEZE` 翻闸（写环境变量/属性，留痕）。
2. Tom 放行 clearance 令牌（非桩）→ 注入 `tools/ts_softdel.js` 运行参数。
3. 依次跑 S1-1…S1-8（每步先 `--dry-run` 零写，确认后 `--apply` 才写）。
4. 每步产出 `evidence/s1_<n>_<UTC>.log` 供双方核验。
5. 全部 ①–④ 证据被 Tom 接受 → GO-S4 翻 NO-GO 为 GO → 执行实际 soft mark（R10807 A级 SAFE 候选）。

---

## 4. 待 Rita 拍板的唯一治理授权

> 红线要求：生产写 / 翻 freeze / 放行 clearance 属不可逆治理动作，须 Rita 显式授权。
> 本 runbook 已备齐，**说"授权执行"即按 §3 顺序在隔离/真实环境跑出 GO-S4 ①–④ 证据**；说"只备不跑"则停在本文件 + `evidence/`（已含 Stage-0）。
