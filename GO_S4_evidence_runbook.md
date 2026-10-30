# GO-S4 证据跑批包（runbook）

> 用途：把"GO-S4 五前置"从"设计/承诺"变成"可一键执行、可核验的证据采集流程"。
> 本文件为【执行预案，非已执行报告】。分两层闸：Stage-0（安全层：零生产写、不触碰生产端点、tracked 树零改动；运行机 pycache 等预期派生物不计入副作用；可在 `TS_WRITE_FREEZE` 锁定下立即跑）与 Stage-1（需治理授权：翻 `TS_WRITE_FREEZE` + 放行 clearance 令牌，当前 BLOCKED）。
> 关联：权威页 `22_NextPhase/T1-B_大局梳理与收敛方案_20261027.md` §六-v7（X批复审）+ 本 runbook。
> 当前 HEAD：见 `git rev-parse HEAD`（本批提交 `97bbd5c` 之后）。

---

## 0. 现状闸门（不可跳过）

| 闸门 | 状态 | 谁解锁 |
|---|---|---|
| `TS_WRITE_FREEZE`（写冻结，默认锁） | 锁定 | Rita 显式治理授权翻闸 |
| 期锁 clearance 令牌 | 未发放 | Rita 授权 + Tom 放行（非 `isClearance` 桩） |
| GO-S4 五前置 | ①–④ NO-GO；⑤ 已授权 | 见各条 |

**铁律**：Stage-1 任何脚本在 `TS_WRITE_FREEZE!=1`（未获授权）或缺少有效 clearance 时，`guardCheck` 必须 `PERIOD_LOCKED`/`CLEARANCE_REQUIRED` fail-closed，**绝不静默写生产**。本 runbook 的 Stage-0 已通过代码保证零生产写（运行机 pycache 等预期派生不计入副作用）；Stage-1 的 fail-closed 由 `tools/ts_softdel.js` 守卫强制。

### 0.1 GO-S4 五前置 = 须独立核证的「证据缺口」（非"翻 freeze / 放 clearance / 真写"）

> 回应 Tom 2026-10-30 13:23:10Z 第六轮点④：五前置是**待清零的证据缺口**，不是"先翻冻结、放行 clearance、真写"这类授权动作本身。翻 freeze / 放行 clearance / GO 放行属于下方「§0.2 授权决策闸」，在①–④证据核证完成后、由有权方单独裁定；二者不可混淆，亦不因五前置被"列出"而自动解锁。

| # | GO-S4 五前置（须独立核证之证据缺口） | 对应 Stage-1 证据采集步骤 | 当前状态 |
|---|---|---|---|
| ① | 真实入口 / 生成物 / 客户端 / 部署身份、权限与契约绑定（未经独立核证） | S1-1、S1-2 | 待独立核证（提交方报告非独立验证） |
| ② | 目标 / keeper / 底稿（当前版本）/ 期锁 / 业务工时依据（未清） | S1-3、S1-4 | 待独立核证 |
| ③ | 版本绑定稳定快照 / 全批失败停止 / 独立回读 / 中断恢复证据（未清） | S1-5、S1-6 | 待独立核证 |
| ④ | 全部写者 / 跨项目权限 / 实际隔离 / 独立身份签发 / 范围绑定 / 同锁消费 / 撤销恢复（未完成独立验证；含 474 缺读根因 + override 未授权且禁止启用） | S1-7、S1-8 | 待独立核证；X4 实现缺项属 Stage-1 S1-8 待实现 |
| ⑤ | 业务 owner 独立明确授权（已收 Rita 授权，不推定其他；原始凭据与适用范围由有权方核实） | —（授权动作本身） | ⑤ 已授权；①–④ 未清零 |

### 0.2 授权决策闸（核证完成后、由有权方单独裁定，非前置本身）

> 翻 `TS_WRITE_FREEZE`、放行 clearance 令牌、GO 放行、业务 owner 授权（⑤）是**授权决策闸**，须在①–④证据核证完成后，由 Rita 显式治理授权 + Tom 放行（非 `isClearance` 桩）后逐项裁定；它们不是"五前置"的内容。本 runbook §3 阶段 C 已明确：实际生产写不是必然动作，须 Rita 对具体目标/版本/副作用独立授权后另行决策（先核验、再授权决策）。

---

## 1. Stage-0（安全层 · 零生产写 · 现在即可跑）

目标：在不动生产、不改 freeze 的前提下，产出 Tom 可独立核验的"代码正确性 + 零写保证 + 单源一致"证据。

| # | 证据项 | 命令（在仓库根） | 验收 |
|---|---|---|---|
| S0-1 | 隔离内核级证据 | `python tools/ts_repro_isolation_runner.test.py` | 41 项（40 通过、1 跳过；symlink best-effort 跳过）；含 mountinfo ro + route 无默认/无出网路由 + 畸形表拒 + 策略路由 UNKNOWN 拒 + 未声明可写挂载拒 + temp_dir 绑定 + 非Linux默认拒 + 其他反例 + main 解包 bug 修复集成测试（Tom 2026-10-30 12:51Z 第五轮复审补强） |
| S0-2 | 读取守卫 | `node tools/ts_read_guard.test.js` | 17/17 PASS |
| S0-3 | 受控读取（去伪装 + 终点 probe） | `node tools/ts_controlled_audit.test.js` | 11/11 PASS |
| S0-4 | 写入失败停止 + journal 返回值 | `node tools/ts_softdel_core.precheck.test.js` | 9/9 PASS（含 COMMITTED 失败→UNKNOWN） |
| S0-5 | 单源逐字一致（两份 GAS 产物 = core） | `python tools/verify_gas_single_source.py` | 全部断言通过 |
| S0-6 | GAS↔Node 等价 | `node tools/ts_softdel_gas_harness.js` | 43/43 PASS |
| S0-7 | 生成器幂等 | `python tools/gen_gas_softdel.py && python tools/verify_gas_single_source.py` | 重跑后产物 SHA-256 不变 |
| S0-8 | JS 语法（逐文件） | `for f in tools/*.js; do node --check "$f"; done`（逐文件命令与 EXIT 见 `evidence/run_2026-10-30T10UTC.log` §9） | 16/16 逐文件 EXIT=0（含 ts_softdel.js 修复重复 let KEY；Tom 12:51Z 要求与日志逐文件一致） |

**产出**：`evidence/run_<UTC日期>.log`（本批已捕获，见 `evidence/`）。审阅方可用 GitHub 只读连接器自行复跑 S0-1…S0-8 验证，无需我方代为"证明"。

---

## 2. Stage-1（治理授权层 · 需翻 freeze + clearance · BLOCKED）

> 下列每条均设"双闸门自检"：脚本首行读 `TS_WRITE_FREEZE` 与 clearance，不满足即 exit(2) 不执行任何写。

### ① 真实入口 / 生成物 / 客户端 / 部署身份绑定
- **S1-1 真实接口契约**：以**隔离测试适配器**先核真实 schema、空行/缺列与源版本（Tom 10:43Z：revision/lastRow 与 CAS 不足证明全程零变化，须有独立写者稳定证据）；为 `tools/ts_controlled_audit.js:75 readAll` 注入真实 `inspectWorkbook` 适配器，绑定生产表 `DB_工时流水` 实际返回的空行/稀疏格式；复跑 `readAll` 单测并新增断言：
  - 源版本绑定（记录实际 API 版本号 + 契约字段）；
  - 写者稳定：采集期零变化，由 `revision`/`lastRow` 漂移断言 + 服务端 CAS 重读兜底，并补充**独立写者稳定证据**（不止 revision/lastRow+CAS）。
  - 文件:行：`tools/ts_controlled_audit.js:75` + 新增 `tools/ts_controlled_audit_realif.test.js`。
  - 验收：适配器绑定真实源版本、漂移断言通过、**独立写者稳定证据齐备**、零生产写。
- **S1-2 客户端/部署身份**：**只读**核实际部署 URL 与 `developmentMode` 状态、版本、源码哈希、权限与入口（Tom 10:43Z：不公开会话 URL）；核对"不换链接"不变量（部署数/版本与推前一致）。

### ② 目标/keeper/底稿 + 期锁 + 时长当前版本与业务证据
- **S1-3 候选集重派生（离线）**：从**经授权、版本绑定且脱敏**的快照离线重算受控候选（phase1 精确A 1230 组/3061h、phase2 col0 差 225 组/385.5h、phase2 B 级 259 组仅为参考核对，非验收目标；Tom 10:43Z：不能把旧行数工时当验收目标）。
  - 验收：受控候选集 = **离线重算结果**（不预设旧行数/工时，仅作参考核对）、UNSAFE=0、0 mixed load、复用 `_sdRowHash` 单一可信源、**版本绑定 + 脱敏**。
- **S1-4 期锁依据**：记录 `bizDate<2026-10-01` 的 100% 历史重复行清单，作为"已锁账期需 clearance"的治理依据（Tom 10:43Z：不能据清单放行，须附期锁 + 业务有效性依据）。

### ③ 真实路径批次停止 / 独立回读 / 中断恢复 / 稳定快照
- **S1-5 全批停止 + 独立回读**：在真实环境以 `--dry-run` 跑（Tom 10:43Z：dry-run 不执行实际写，不能证明"写后抛错零残留"）；用**隔离替身/测试环境注入写后异常、回读不明**并核逐项状态，**不声称事务回滚**；`tools/ts_softdel.js` + `tools/ts_softdel_core.js:384–386,491–501`。
  - 验收：precheck 9/9 在真实入口复跑通过并导出日志 + **注入写后异常的逐项状态核**。
- **S1-6 中断恢复状态机**：核原 job 持久身份、客户端枚举及中断对账（Tom 10:43Z：不盲重试）；提供 `core` 状态枚举导出（`PREPARED→UNCONFIRMED/UNKNOWN`）+ 客户端轮询契约测试。
  - 验收：状态枚举端到端统一，对账结论写入撤销/重放台账。

### ④ 全部写者/触发器/跨项目协调/部署权限/隔离/clearance
- **S1-7 写者稳定 + 部署权限基线**：盘点**全部项目/触发器/写者**与跨项目协调，并核实际权限基线（Tom 10:43Z：部署数量相同不足证明版本一致）；核对 `@HEAD` 部署清单（`clasp list-deployments`）与推前一致、导出 webapp/脚本调用方清单。
- **S1-8 clearance 落地（替换桩）**：**先完成**独立身份、作用域、锁内消费、撤销及恢复实现 + 非生产负例，**禁止以替换桩直接放行**（Tom 10:43Z）；将 `core:183 isClearance`（当前取锁前）+ `embedded:1101 return false` 桩替换为真实实现。
  - 文件:行：`tools/ts_softdel_core.js:182`、`ts_softdel_gas_embedded.js:1101`、设计 `contract/clearance_and_baseread_design.md` §1.5–§1.6。
  - 验收：TOCTOU 修正（校验移入 `guardCheck` 同锁区间），nonce 重放拒绝，撤销恢复状态机测试通过，**非生产负例齐备**。

---

## 3. 先核验后授权（冻结保持，验证前置，授权决策与执行解耦）

🔴 铁律（回应 Tom 2026-10-30 10:43Z）：**禁止"先翻 freeze、放 clearance、逐步 apply 后才核完①–④"的先写后验收顺序**；逐步 apply 可能产生生产副作用。改为三阶段：

**阶段 A — 冻结保持下的非生产核验**（`TS_WRITE_FREEZE` 维持 =1，不清算 clearance，零生产写）：
1. 跑 S0-1…S0-8（Stage-0，零生产写，已实跑留痕）。
2. 跑 S1-1…S1-8 的【非生产】部分：用隔离替身 / 测试环境 / 注入写后异常、回读不明并核逐项状态；所有核对均在**不触碰生产表、不翻 freeze、不放 clearance** 前提下以 dry-run / 只读 / 测试替身完成。
3. 每步产出 `evidence/s1_<n>_<UTC>.log`，明确标注"零生产写 / 零副作用"及所用环境（隔离替身 or 真实但只读）。

**阶段 B — 独立只读证据采集 + 授权裁定**（由业务 owner Rita 在收到阶段 A 完整证据后逐项裁定）：
- 不凭单句"授权执行"替代完整治理授权；授权须明确：**①–④ 各自放行范围 + 执行环境 + 回滚预案 + 独立复核人**。
- 期锁 clearance 令牌仍须 Tom 放行（非 `isClearance` 桩），并以 §1.5 完整实现为前提。
- 阶段 A 任意一项未通过 / 证据不足 → 不进入阶段 C。

**阶段 C — 生产授权执行闸（仅当阶段 A+B 全部通过且授权明确后，另行决策）**：
🔴 关键修正（回应 Tom 2026-10-30 11:45Z）：阶段 C **不**内置"依次 apply、后认定 ①–④ 接受再 GO"的先写后验收顺序；实际生产写**不是**阶段 C 的必然动作，而是须由业务 owner Rita 在收到阶段 A+B 完整证据、确认 GO、并对**具体目标/版本/执行副作用**作出**独立授权**后，**另行决策是否允许任何生产写**。
1. Rita 收到阶段 A+B 证据，逐项裁定 ①–④（范围 + 执行环境 + 回滚预案 + 独立复核人），确认 GO。
2. Rita 指定**执行账户**（非 Tom 审阅账户；Tom 已明确"本账号不接任执行"）显式授权翻 `TS_WRITE_FREEZE`（留痕）+ Tom 放行 clearance 令牌（非桩）。
3. 仅当上述独立授权齐备，才**另行**决定是否执行实际 soft mark（R10807 A级 SAFE 候选）；每步先 `--dry-run` 零写确认，再 `--apply` 才写，并产出 `evidence/s1_<n>_<UTC>.log`。
4. 任何一步授权缺失 / 证据不足 → 停在本文件 + `evidence/`，不触碰生产。

---

## 4. 待 Rita 拍板的治理授权（须按阶段 B 逐项裁定，不凭单句授权执行）

> 红线要求：生产写 / 翻 freeze / 放行 clearance 属不可逆治理动作，须 Rita 显式授权。
> 本 runbook 已备齐 Stage-0 证据 + Stage-1 非生产核验方案；**授权须按 §3 阶段 B 的"具体范围 + 环境 + 副作用清单 + 独立审查"逐项裁定，不凭单句"授权执行"替代完整治理授权**（回应 Tom 10:43Z）。
> 说"只备不跑"则停在本文件 + `evidence/`（已含 Stage-0）。
