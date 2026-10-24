# 生产工时表 FY27H1 关账 — 离线设计交付件（证据矩阵 v1.4）

> 配套：`FY27H1_closeout_plan.md`（commit `2aa260c3f6f19a017c1231f33fa7fa9511017d76`，文档 SHA-256 `2df9d9ed3c189f1e6b186407ae3e09cb1e503711416095125f290ca461b41cea`）
> 目的：响应 Tom 2026-10-24 15:58 复核函（msg_WLx25pd…）4 项待办 + **16:57 复核函（msg_Pl7JcoN…）6 条设计收敛**——本件为**纯规划/设计交付，零生产写、零权限变更**。**Phase 1 身份与写入口已于 2026-10-24 16:48 经 `gas_auth` 只读实读 HEAD 解开**（HTTP 200，非 400），§1/§2/§7 为**实时 HEAD 只读核验产物（提交方报告，HEAD 与实际部署分列，非执行验收）**。
> 状态：规划方向 + 文档整改接受 + Phase1 写入口/身份只读核验完成 + **v1.2 按 16:57 六条收敛** + **v1.3 按 17:29 收敛（stage/隔离前置/删除并入矩阵/400 归因降级）** + **v1.4 按 17:57 收敛（写入↔记stage 崩溃窗口消除/副作用不确定性建模/文档内部一致性修正）**；**非阶段一 PASS、非执行 clearance、非生产写许可、非 GO**。

---

## 0. 范围与诚实分层

- 本件不触碰生产表、不做任何生产写、不改任何权限、不现场扫描。
- §8（七条设计约束）与 §8.1（四项已确认业务参数）维持不变，本件在其下展开**可验证对象/入口/状态/并发边界**。
- §1/§2 已基于实时 HEAD 只读核验填充真实函数名/行号（非设计推断）；§3/§4/§5 的实现测试仍须 **Rita GO + 双闸门**后方可编写并实跑。

---

## 1. 写入口清单（Write Entry Inventory）

> ✅ **本节已基于实时 HEAD 只读核验（2026-10-24 16:48，HTTP 200 via `gas_auth`）填充真实函数名/行号**。源码快照存于 `tools/_staging_period_lock/_ts_head_live/`（16 文件）。**仅只读分析，无任何生产写/推送/部署。**

**路由链**：`doPost`(Code.gs L135) → `_rtMaybeHandlePost`(RemoteTrigger.gs) → `REMOTE_ACTIONS` 分发表(RemoteActions.gs L6) → 具体写函数；Web UI 经 `Index.html` 直接调 `submitBatch/updateTimesheet/softDeleteRecord`（带 `currentToken`）。

| # | 写入口（实时函数 / 位置） | 拦截层 | 锁生效条件 | 备注 |
|---|---|---|---|---|
| W1 | `submitBatch`(Code.gs L386) | 函数入口 guard（逐 task 校验 `f.date`） | `fillDate < 2026-10-01` 且非解锁窗口 → 拒整批/该行 | **主拦截层**（Web 填报 + 移动端） |
| W2 | `updateTimesheet`(Code.gs L460) | 函数入口 guard（校验 `f.uuid` 所在行 `f.date`） | 同上 | 行内编辑/补录页 |
| W3 | `tsAppendRows`(RemoteActions.gs，action `appendRows`) | 「写入端哑管道」入库前校验 | 校验每行 B 列（业务日期） | **批量回填/恢复入口，须同挂锁** |
| W3b | `tsPatchCells`(RemoteActions.gs，action `patchCells`) | 批量改格前校验 | 校验目标行 B 列 | 补类型列等批量改 |
| W4 | 解锁申请提交 | 双签校验（Rita+sysadmin） | 仅双签生效 | 见 §5 |
| W5 | 锁状态写（`lockState` 持久化，ScriptProperties） | 自身原子写 | — | 见 §4 |
| W6 | 审计 tab 追加（`_TS_WRITE_LOG`，已有） | 与业务写同事务（**待证明设计目标**，见 §3.3 确定性恢复） | — | 见 §3 补偿 |

**W3/W3b 关键**：`tsAppendRows` 已有护栏（限 3000 行、默认拒请假行 `force=1` 才放行、`_tsIsLeaveRowForGuard`、幂等 UUID 去重、`_TS_WRITE_LOG` 留痕）——锁 guard 应叠加在现有护栏之后，按 B 列业务日期拦截 `fillDate < 2026-10-01`。`tsPatchCells` 同理。

**入口覆盖总表（v1.2，含显式未覆盖项）**：

| 路径 | 是否前置拒绝 | 状态 | 说明 |
|---|---|---|---|
| W1 `submitBatch` / W2 `updateTimesheet`（Web/移动端） | ✅ 服务端函数入口 guard，提交前拒绝 | **拟实现**（guard 待挂） | 主拦截层，非已生效 |
| W3 `tsAppendRows` / W3b `tsPatchCells`（脚本/远程批量） | ✅ 入库前逐行校验 | **拟实现** | 批量回填/恢复，非已生效 |
| `softDeleteRecord`（软删历史行） | ❌ 现状锁不覆盖（仅软删标记） | **拟实现**（guard 待挂，**目标 REJECT**，见 §6 T-delete） | 删除用例并入本矩阵，不脱节 |
| 既有直接编辑（有编辑权者在 Sheet 界面手改） | ❌ **不覆盖** | 现状（无前置拦截） | onEdit/change 事后事件，**不作拦截证据**；mitigation=Sheet 保护+灰标威慑+事后审计；上线说明显式声明未前置拦截 |
| 其他脚本/触发器/API/管理员（非 W3/W3b） | ❌ **不覆盖** | 现状 | 显式声明未覆盖；脚本锁仅约束同锁路径，不能据此覆盖外部写者；依赖所有者侧纪律，列 Phase 3 核对清单 |
| W7 物理删类（purgeRows 等） | ❌ 锁不覆盖 | 现状（token 门控） | 维护动作，维持现有门控 |

> 灰标/保护/监听**不是**统一授权网关；凡无前置拦截能力的入口一律标「未覆盖」，不以事后监听冒称拦截。修改/删除校验均核原记录期间 + 目标期间 + 稳定行 UUID/版本。

**W7（物理删类，超出"填"范围但须关注）**：`purgeRows`/`pruneDead`/`delBlankRows`/`purgeSoftLeaves` 为 token 门控的维护动作，可物理删行——关账锁不拦它们（锁语义=禁填/禁改历史行），但 Phase 3 上线说明须点明：锁仅覆盖 W1–W3b 的"写"，删类动作仍按现有 token 门控，不依赖锁。

**现成可复用护栏**（勿重复造）：`_tsSetValuesGuarded`(Code.gs，V4.3.71 B 列日期护栏：写后回读+自动还原，杜绝静默改坏业务日期)、`_TS_WRITE_LOG` 审计 tab、`masterCreate` 的生产表禁用清单（masterCreate.gs `_masterForbiddenIds`）。

**部署身份**（appsscript.json，须 Tom/所有者复核）：`webapp.access = "ANYONE_ANONYMOUS"`、`executeAs = "USER_DEPLOYING"`、`executionApi.access = "MYSELF"`。→ Tom 关注的「匿名不默认安全」在此为**真实部署配置**；写函数均经 `getCurrentUser(token)` 校验 HR 授权令牌，但匿名访问本身存在，guard 必须**服务端强制**而非依赖前端。

---

## 2. Phase 1 身份诊断 — 只读核验产物（提交方报告，2026-10-24 16:48）

- **实测结论（提交方报告）**：经 `tools/gas_auth.py`（`~/.clasprc.json` 默认令牌）对 `1FPAwV50…` 调 `script.googleapis.com/v1/projects/{sid}/content` → **HTTP 200，返回正确 scriptId 与完整源码**。身份与项目**匹配**（HEAD 与实际部署分列，非执行验收）。
- **400 根因定位（保留待证归因）**：此前 `pull_ts_code.js` / `ts_healthcheck.js`（node，用另一套令牌 `j.access_token`）报 400；`gas_auth` 通道 200 能证明「可只读实读」，但**不能单独证明原 node 400 必为令牌过期/scope 不足**——在缺对应错误与令牌诊断证据时，本件将其**保留为待证归因，不要求提供任何令牌**，亦不据其断言授权结论。修复建议（Rita 回电脑后可选）：让 node 脚本改走 `gas_auth` 通道或刷新 node 令牌；**非浏览器重授权、非新增权限**（符合 §8 不主动扩权）。
- **已核验项（提交方报告，待降级证据层级）**：
  1. 真实项目身份：`scriptId` 匹配 `1FPAwV50…`（TimeSheet 正式填报页 / 生产工时系统）——据 HEAD 断言，实际服务部署另列。
  2. 部署身份：据 HEAD `appsscript.json` manifest 断言 `ANYONE_ANONYMOUS` + `USER_DEPLOYING`（§1）；**实际服务中的部署版本/访问配置须所有者侧受控诊断单另列，读到 HEAD 不自动断言生产部署身份已闭合**。
  3. 全部写入口函数名 + 行号（§1 W1–W7，实时 HEAD）——HEAD 源码，非实时生产部署。
  4. 现有护栏模式可复用（`_tsSetValuesGuarded` / `_TS_WRITE_LOG` / `masterCreate` 禁用清单）。
- **未变铁律**：本节及 §1 均为**只读核验产物**；未做任何生产写、未 push、未 deploy。Phase 3 执行 clearance 仍须 **Tom clearance + Rita GO 双闸门**。
- **生产部署身份闭合声明边界**：本件以读到实时 HEAD + 其 `appsscript.json` manifest 字段断言「部署身份配置」真实存在；但**实际服务中的部署版本/访问配置须由 Rita/所有者侧受控诊断单另列**，读到 HEAD 不自动断言当前生产部署身份已闭合。HTTP200/16 文件/行号/`4.3.72`/组合指纹均为**提交方报告**，你未持有该快照、组合 SHA 不可由你独立复算——归为待降级证据层级，非执行验收（v1.3 按 17:29 函）。
- **实时 HEAD 指纹**：版本 `TS_APP_VERSION='4.3.72'`(Code.gs L123)；源码快照 `tools/_staging_period_lock/_ts_head_live/`（16 文件）；**组合 SHA-256 = `26471b4103c569851391ae3f70058b06c2828b8916674a0bd8dd3d3f72693c18`**（计算方法见 §9：按文件名升序拼接 16 文件原始字节后取 SHA-256，可复现）。

---

## 3. 原子检查→写→审计→异常补偿（v1.2 具体化）

> v1 的 BEGIN/COMMIT 为伪序列；本节改为 **GAS/Sheets 无跨区域事务前提下可落地的机制**：操作ID + 预写意图 + 读回校验 + 恢复状态机，并**不声称「当然不丢数据不丢审计」**——每一步的失败/崩溃恢复状态显式定义，补偿失败走 OPEN_BROKEN 隔离，不静默。

### 3.1 前提机制
- **串行边界**：整个 check→intent→write→verify→audit 序列包在 `LockService.getScriptLock()`（tryLock，超时=拒绝重试提示）内，同一时刻仅一个写序列在跑；跨实例并发由脚本锁 + 3.4 的行级 opId 校验双保险。
- **稳定行 ID**：以生产表现有行级 UUID（`f.uuid` 所在列，submitBatch/updateTimesheet 已在用）为稳定行 ID；**一切锁判定、例外授权、审计引用均绑定 UUID 集合，不用行号/rowRange**（行号可漂移）。
- **旧值快照**：写前整行读出（值+UUID），存入意图记录 `oldValues`。

### 3.2 写序列（每入口 W1/W2/W3/W3b 适用）— 含副作用不确定性与隔离前置
> v1.4 关键修正：**业务写入与 stage 持久化是两个独立外部副作用，任一可在其间崩溃**；且「写请求返回错误」≠「服务端必未落盘」。故每一步均**标 UNCERTAIN（不确定）而非假定成功/失败**，恢复扫描据可观测状态封禁后续写入。另区分**写前版本 baselineVersion / 预期写后版本 expectedVersion / 实际当前版本**三者，避免把本次正常写入误判为并发、也不覆盖未知中间值。
```
1. check    行锁态 + 例外状态 + 双签 + expiresAt（服务端时钟）→ 不满足即 REJECT（零写）；**并查操作日志：本 UUID 集合存在任一非终态/UNCERTAIN INTENT → 立即 REJECT（隔离在进入新写之前生效）**。
2. opId     生成持久操作ID（UUID）；预写意图行 {opId, stage:INTENT, uuidSet, baselineVersion(写前版本指纹), oldValues, expectedValues(预期写后), newValues, ts}。**意图写请求返回错误 → 标记 op 为 UNCERTAIN（非终端）；REJECT 仅表本次返回结果，不能追溯撤销可能已落盘的服务端副作用**。
3. write    业务单元格写入。**写请求返回错误 → stage 标记 WRITTEN_ATTEMPTED（不确定），不假定已写或已回滚**。
4. verify   写后回读比对当前值/当前版本 vs {baselineVersion(写前), expectedValues(预期写后), newValues}：
         - 当前==expectedValues 且版本已推进 → 正常路径, stage=VERIFIED；
         - 当前==oldValues 且版本==baselineVersion → 本次写未生效（被并发还原/未落盘）, stage=ROLLED_BACK；
         - 当前既≠oldValues 也≠newValues（未知中间值）→ OPEN_BROKEN（不清不覆盖）;
         - 版本已变但值非预期（外部并发新值）→ OPEN_BROKEN（不覆盖并发新值）。
5. audit    审计 tab 追加（opId/操作人/旧值/新值/锁态/例外引用）→ stage=AUDITED（审计 tab 已有该 opId → 视为 AUDITED，去重不重追加；审计写请求错误 → UNCERTAIN）。
6. mark     stage=COMMITTED（终态）。
```
> 补偿（回滚写）本身也是外部副作用：若回滚写后、ROLLED_BACK 标记前崩溃，恢复时按 §3.3 WRITTEN 行处理（当前==oldValues→ROLLED_BACK；中间值→OPEN_BROKEN）。

### 3.3 失败/崩溃恢复状态机（确定性恢复决策函数）
> v1.4 修正：**stage 不是唯一事实源**。恢复决策仅依赖**可观测状态**（持久 stage + 单元格当前值/版本 + 审计 tab 是否有 opId），结合可信意图（oldValues / baselineVersion / expectedValues）做确定性恢复；**凡状态组合无法安全区分「已发生 / 未发生」→ 判 UNCERTAIN → OPEN_BROKEN 隔离，不假定未写、不自动回滚、不自动提交**。覆盖「审计已追加但 COMMITTED 标记前崩溃」（审计 tab 已有 opId → 直接 COMMITTED，去重不重追加）。

| 持久 stage | 当前单元格（值/版本）vs 意图 | 判定 | 恢复动作 | 终态 |
|---|---|---|---|---|
| INTENT | == oldValues（值+版本==baseline） | 本次写未生效 | 无需动作 | ROLLED_BACK |
| INTENT | == newValues（值+版本已推进） | 业务已写但 stage 未记 → 不确定已落盘/是否重复 | **OPEN_BROKEN（隔离），不自动回滚/提交** | OPEN_BROKEN |
| INTENT | 既≠oldValues 也≠newValues（未知中间值） | 外部并发/部分写 | OPEN_BROKEN | OPEN_BROKEN |
| WRITTEN | == newValues | 业务新值在、待 verify/回滚 | 按意图：需回滚→版本==baseline 才写回 oldValues，否则 OPEN_BROKEN；正常→VERIFIED | ROLLED_BACK / VERIFIED / OPEN_BROKEN |
| VERIFIED | == newValues | 待补审计 | 补审计；成功→COMMITTED，失败→OPEN_BROKEN | COMMITTED / OPEN_BROKEN |
| AUDITED | 审计 tab 已有 opId 行 | 审计已落 | 直接 COMMITTED（去重不重追加） | COMMITTED |
| UNCERTAIN | 任一 | 写/状态/审计请求返回错误，服务端可能已落盘 | 封禁该 UUID 集合后续写入，受控重试或人工处置 | OPEN_BROKEN |

### 3.4 补偿失败 = OPEN_BROKEN（不冒称恢复）
- OPEN_BROKEN 的 UUID 集合由 §3.2 step1 的 check **在进入新写之前**强制拦截（不依赖 dailyWatchdog 跑成功）：凡涉及隔离行的写入一律 REJECT，等待人工处置；处置动作本身也走 opId 流程。
- **「REJECT」仅表本次调用返回结果，不追溯撤销可能已发生的服务端副作用**：写请求/状态写请求返回错误 ≠ 服务端必未落盘，也 ≠ 业务零写。故恢复判定一律以**可观测状态**（非终态/UNCERTAIN 的 stage、审计 tab 是否有 opId）为准——只要该 UUID 集合存在未决 op，即持续封禁后续写入，不因「客户端曾收到错误」而假定已干净回滚。
- 审计 tab 追加 `{opId, stage:OPEN_BROKEN, reason}` 仅作留痕；审计写失败不改写意图行，恢复扫描再次发现。
- **显式不承诺**：补偿失败 / 不确定性场景下数据可能停中间态直至人工介入——系统保证「不再接受新写 + 全程留痕 + 人工可判定」，不是自动无损；前述闭环**未实现、未测试前不宣称原子迁移或全程留痕已保证**。

---

## 4. 锁状态持久化 + 恢复

- **存储**：锁态（`lockState`：`{locked:bool, threshold:'2026-10-01', futureOpen:bool, exceptions:[...]}`）存 `ScriptProperties`（非随开关 false 全开，独立于 `FEATURE_ENABLED`）。
- **持久化原子性**：单 key `JSON` 写入，失败即整体失败，不部分生效；写后回读校验。
- **恢复**：**每次写入口 check 均实时读取** `lockState`（不缓存跨请求）；读取异常/缺失/JSON 损坏 → 默认 **fail-closed = 锁定**（不默认放行）。
- **到期检查不依赖触发器**：`expiresAt` 由**每次写入时的 check 步骤**按服务端可信时间即时判定（见 §5.4），dailyWatchdog 仅作兜底巡检，不是到期生效的依赖路径；到期巡检本身失败不影响逐次 check 的拦截。
- **证据**：⏳待 Rita GO 后给 `lockstate_persist_tests.js`（写入→重启读取一致性、半写恢复、缺失/损坏默认锁、到期逐次拦截不依赖触发器）。

---

## 5. 限时例外（7 天封顶）+ 审计（v1.2 状态机化）

### 5.1 授权对象与绑定
- **对象标识**：例外绑定**稳定行 UUID 集合** + 允许字段清单（`allowedFields`）+ 基线版本（授权时读到的行内容指纹）；**不用 rowRange**（可漂移）。写入时逐行核验 UUID ∈ 例外集合、目标字段 ∈ allowedFields、行当前内容指纹 == 基线版本（否则说明行已被他人改过，REJECT 需重新申请）。
- **范围**：仅误填历史行（`fillDate < 2026-10-01`）的更正，不含新业务填报。

### 5.2 双签 = 两个独立可信主体
- 签名主体集合 = {Rita, sysadmin}；**首签人与次签人必须为不同身份**（同一人第二签 → REJECT，防同人双角色）。
- 防重放：每次签名携带 `reqId`+单调序号；同一 reqId 的重复签名请求 REJECT。

### 5.3 原子状态机（修复 v1 中 C4「首签胜」与双签生效的矛盾）
```
APPLIED ──首签(≠申请人)──▶ FIRST_SIGNED(待第二签)
FIRST_SIGNED ──次签(≠首签人)──▶ ACTIVE(解锁生效, 记 activatedAt/expiresAt=+7d)
ACTIVE ──更正完成──▶ COMPLETED（更正完成即失效，不必等 7 天）
ACTIVE ──主动关闭/撤销──▶ CLOSED
ACTIVE/任意态 ──expiresAt 过──▶ EXPIRED_AUTO_RELOCK
任意非 ACTIVE 态 ──任何写入──▶ REJECT
```
- 状态迁移全部走 §3 的 opId 序列（检查→写状态→写审计），**迁移本身原子（待证明设计目标）**；并发双签竞争由脚本锁串行化，不存在「首签即胜出放行写入」——**双签齐备前例外不生效，写入一律拒**。

### 5.4 到期语义
- `expiresAt` 在**每次写入 check**按服务端时钟判定；过期即拒，即使 ACTIVE 未手动关闭。
- 到期/完成迁移若审计写失败 → 按 §3.4 处理（状态不变、写入保持拒、标记 OPEN_BROKEN），**绝不因审计失败继续放行**。
- 反例覆盖：撤销/重复操作/时钟异常（服务端时间回拨或跳变超阈值 → fail-closed 拒写并告警，不信任客户端时间）。

### 5.5 审计字段（更新）
`reqId, requester, firstSigner, secondSigner, uuidSet, allowedFields, baselineFingerprint, reason, openedAt, activatedAt, expiresAt, closedAt, status`。

- **证据**：⏳待 Rita GO 后给 `exception_tests.js`（双签生效、单签/同人双签拒、防重放、7 天到期逐次拦截、完成即失效、撤销、时钟异常、基线漂移拒）。

---

## 6. 九类反例（v1.2 显式映射，替代 v1 的 C1–C9 列表）

> v1 的 C1–C9 不是九类的等价覆盖；本表按 Tom 点名的类别逐类给出：锁行为、入口归属、测试用例 ID。**不以有九个编号即称齐备——每类须有对应测试（exit0）+ SHA；⏳待 Rita GO 后随 §3/4/5 测试件交付。**

| # | 反例类别 | 锁期望行为 | 归属入口/机制 | 测试 ID |
|---|---|---|---|---|
| 1 | **旧改新**（历史行 fillDate 改到 ≥10-01） | REJECT：行基线 fillDate<阈值即锁，改期不改锁 | W1/W2 guard（入口前置拒绝，非事后事件） | T-old-to-new |
| 2 | **新改旧**（十月行日期改回九月） | REJECT：目标日期 <阈值即拒，含行内编辑 | W1/W2 guard 校验目标值 | T-new-to-old |
| 3 | **删除**（历史行 softDelete/物理删） | softDeleteRecord REJECT；purgeRows 等 token 门控维护动作**显式声明不在锁覆盖内**（§1 W7） | W-del guard + W7 声明 | T-delete |
| 4 | **批量**（append/patch 混含新旧行） | 整批 fail-closed：任一行违规→整批拒，零部分写 | W3/W3b 批前逐行校验 | T-batch-mixed |
| 5 | **身份/配置失败**（token 无效/lockState 读异常/JSON 损坏） | fail-closed REJECT，默认锁定 | §4 恢复语义 | T-identity-config |
| 6 | **例外到期**（ACTIVE 过 expiresAt 仍写入） | REJECT + EXPIRED_AUTO_RELOCK；到期审计失败仍拒写 | §5.4 逐次 check | T-expiry |
| 7 | **中途崩溃**（check/intent/write/verify/audit 任意点崩） | 按 §3.3 状态机恢复，不静默 | §3.3 恢复扫描 | T-crash-*（按崩溃点分例） |
| 8 | **审计失败+补偿失败** | OPEN_BROKEN 隔离，行写入封禁，人工介入；不冒称自动恢复 | §3.4 | T-comp-fail |
| 9 | **重放**（同 opId/同 reqId 重复提交） | 幂等拒绝：行级 opId 校验 + reqId 去重 | §3.2/§5.2 | T-replay |

> 全部先在**合成 fixture** 上设计并测试（不为补测试读现场/执行仓库脚本）；修改/删除类另须核原记录期间 + 新期间 + 稳定 ID/版本。

---

## 7. 证据矩阵（Evidence Matrix）

| 约束 | 设计落点 | 当前证据（2026-10-24 只读核验） | 待补证据（Rita GO 后实现） |
|---|---|---|---|
| 写入口拦截 | §1 W1–W7 + 覆盖总表 | ✅ 实时 HEAD 函数名+行号（`submitBatch` L386 / `updateTimesheet` L460 / `tsAppendRows` / `tsPatchCells` 等）+ 组合 SHA `26471b4…` + 未覆盖项显式声明；**§1 前置 guard 标「拟实现」，非已生效** | 挂锁代码 + SHA |
| 身份核验 | §2 | 提交方报告：HTTP200 实读 HEAD；scriptId 匹配；部署身份据 HEAD manifest 断言（实际服务部署另列，待降级） | —（提交方报告，非执行验收） |
| 原子写+补偿 | §3 | opId+预写意图+恢复状态机+OPEN_BROKEN（具体机制设计，非伪序列） | `atomic_write_tests.js` + 结果 |
| 锁持久化+恢复 | §4 | 存储设计（ScriptProperties，独立于 `FEATURE_ENABLED`，逐次 check 实时读） | `lockstate_persist_tests.js` |
| 限时例外 | §5 | 双签状态机 + UUID集合+allowedFields+基线版本 + 逐次到期 check | `exception_tests.js` |
| 九类反例 | §6 | 九类逐类映射（T-old-to-new … T-replay） | 9 类 exit0 + SHA |
| 解耦 | — | A 包装独立 staging | 维持独立 commit 树 |

---

## 8. 与 Tom 15:58 / 16:57 两函的逐条对应

**15:58 函（4 项待办）**：
- ✅ 接受「规划方向 + 文档整改，实现证据未就绪」定位。
- ✅ Phase 1 **已只读解开**：经 `gas_auth` 实读 HEAD HTTP200，身份/写入口/部署身份（`ANYONE_ANONYMOUS`）均据 HEAD 核验；node 400 归因**保留为待证**（见 §2），不据其断言授权结论；非浏览器重授权、非新增权限；§8 不扩权有效。
- ✅ 本件给出对象/入口/状态/并发边界（§1/3/4/5/6）与证据矩阵（§7）。
- ⏳ 实现/测试证据仍须 **Rita GO + 双闸门** 后方可编写并实跑。

**16:57 函（6 条设计收敛）→ v1.2 对应**：
1. 原子机制非伪序列 → §3 重写：opId 预写意图 + 脚本锁串行 + 写后回读 + **恢复状态机（§3.3 表格按崩溃点判定）**；补偿失败 = OPEN_BROKEN 隔离（§3.4），**不声称「不丢数据不丢审计」**；oldValues 不可靠时不清不覆盖（§3.3）。
2. 事后事件非前置拒绝 → §1 增入口覆盖总表：W1–W3b 为前置拒绝；**直接编辑/其他脚本/管理员路径显式标「未覆盖」**，不以灰标/保护/监听冒称网关；修改/删除核原期间+新期间+稳定ID/版本。
3. 例外 rowRange 可漂移 → §5.1 改 UUID 集合 + allowedFields + 基线版本指纹；§5.2 双签两独立主体+防同人双角色+防重放；§5.3 原子状态机（APPLIED→FIRST_SIGNED→ACTIVE→COMPLETED/CLOSED/EXPIRED），消除 v1 C4「首签胜」与双签生效的矛盾。
4. 到期语义 → §5.4：**每次写入按服务端可信时间 check expiresAt**，不依赖 dailyWatchdog/触发器；完成即 COMPLETED 失效；到期审计失败仍拒写；含撤销/重复/时钟异常反例。
5. C1–C9 非等价覆盖 → §6 重写为九类逐类映射表（旧改新/新改旧/删除/批量/身份配置失败/例外到期/中途崩溃/审计失败+补偿失败/重放），各配测试 ID；先在合成 fixture 上设计，不为补测试读现场。
6. **归因更正**：15:39「好」为 **Rita 本人**对 §8.1 四项参数的业务确认，由我方（提交方）转述；此前函件如出现主语错置（将该确认表述为与 Tom 相关），**特此更正**。该确认按你登记口径维持为「提交方报告」；公开仓固定 commit **不构成**受控非公开通道，亦不供你独立核验原确认上下文——不公开原始确认或人员资料，维持。

**17:29 函（合并复 v1.1+v1.2）→ v1.3 对应**：
- ✅ v1.2 六条设计整改**采纳**（撤回无损承诺、opId/预写意图/旧值回写/OPEN_BROKEN、未覆盖入口诚实列出、UUID 集合+双签状态机、逐次到期、九类映射、15:39 归因更正）——不再重复要求同项说明。
- ⏳ 恢复状态机 stage 歧义 → §3.2 写序列增**持久 stage 字段**（INTENT→WRITTEN→VERIFIED→AUDITED→COMMITTED）+ §3.3 以 stage 为唯一事实源区分「已写未verify」与「已verify未audit」两类中间态；补审计前崩溃由 opId 去重直接 COMMITTED；旧值还原核版本、不覆盖并发新值。
- ⏳ 隔离前置拦截 → §3.2 step1 在**进入新写之前**查非终态 INTENT 即拒（不等 watchdog）；§3.4 明确「隔离元数据写失败」也有确定拒写路径（意图/状态行写失败即整 op REJECT）。
- ⏳ 入口矩阵 → §1 增「状态」列：W1–W3b/softDeleteRecord guard 标**拟实现（非已生效）**，直接编辑/其他脚本/管理员/W7 标「现状（未覆盖）」；softDeleteRecord 已并入矩阵（§6 T-delete 不脱节）；明确未覆盖≠「全部历史已冻结」证明。
- ⏳ 归因降级 → §2 将 node 400 归因**保留为待证**（gas_auth 200 不能单独证明原 400 必为令牌过期/scope 不足，不要求提供令牌）；HTTP200/16文件/行号/`4.3.72`/组合指纹均标为**提交方报告、待降级证据层级**；实际服务部署版本/访问配置须由所有者侧受控诊断单另列，读到 HEAD 不断言生产部署身份已闭合。
- 结论（Tom）：设计整改实质进展，但**实现与执行 clearance 未就绪**；阶段一最终 PASS 继续暂缓，HOLD/NO-GO、事故安全 OPEN、零生产操作边界不变；本函不授权执行仓库测试/现场读取/编码部署/任何生产动作。

**17:57 函（复 v1.3）→ v1.4 对应**：
- ⏳ **写入↔记 stage 崩溃窗口** → §3.2 明确业务写入与 stage 持久化为两个独立外部副作用，任一可其间崩溃；每步标 UNCERTAIN（不假定成功/失败）；区分写前版本 baselineVersion / 预期写后 expectedVersion / 实际当前版本三者，避免误判正常写入为并发、不覆盖未知中间值。§3.3 重写为**确定性恢复决策函数**：stage 非唯一事实源，仅依可观测状态（stage + 值/版本 + 审计 opId）+ 可信意图判定；**INTENT 但 cell==newValues（写成功但 stage 未记）→ 判 UNCERTAIN→OPEN_BROKEN 隔离，不自动回滚/提交**；补「补偿写后、ROLLED_BACK 标记前崩溃」由 WRITTEN 行覆盖。
- ⏳ **REJECT 过度声明** → §3.4 改写：「REJECT 仅表本次返回结果，不追溯撤销可能已发生的服务端副作用」；写/状态请求错误 ≠ 服务端必未落盘、≠ 业务零写；恢复判定一律以可观测状态（非终态/UNCERTAIN 的 stage、审计 opId）为准，不因客户端曾收错误而假定已干净回滚。
- ⏳ **文档内部一致性** → 标题/§2 标题/§2 已核验项/§7 身份行去掉「已坐实/已只读闭合」等旧断言，改标「提交方报告、HEAD 与实际部署分列、待降级」；§8 15:58 段「400 确为 node 令牌」改为「保留待证（与 §2 一致）」；§1 softDeleteRecord 行统一「现状锁不覆盖 + 目标 REJECT（拟实现）」；W6「与业务写同事务」、§5.3「迁移本身原子」标为**待证明设计目标**。
- 结论（Tom）：文档有实质收敛，但**恢复闭环与内部一致性尚未完成**；实现/测试证据及执行 clearance 仍未就绪；阶段一 PASS 暂缓、106 HOLD、历史 23 行/D241、HOLD/NO-GO、事故安全 OPEN、零生产操作不变；本函非上线/写入/执行测试/现场读取授权。

---
## 9. 附录 — 实时 HEAD 快照指纹（可复现）

- **计算环境**：本地只读快照 `tools/_staging_period_lock/_ts_head_live/`（16 文件），经 `gas_auth` 通道 HTTP200 实拉，仅只读分析，零生产写。
- **组合 SHA-256 计算方法**：`SHA256( b''.join( open(f,'rb').read() for f in sorted(os.listdir(dir)) ) )`（按文件名升序拼接原始字节）。**组合值 = `26471b4103c569851391ae3f70058b06c2828b8916674a0bd8dd3d3f72693c18`**。
- **逐文件 SHA-256**（供 Tom 逐件核验；完整快照文件可经 Rita 审批闸门索取，本公开仓不推送生产源码）：

| 文件 | SHA-256 |
|---|---|
| Code.gs | 67e9c749a5467694396cfc0a394c1db11f74b2a1bbff907a611b5202d3ada704 |
| FixBDates.gs | 1b1f98bbb8fd52ce9140a60b2a4a4723b4d3856267b594b8c2d783584a149fcb |
| Index.html | 19a88cd12c09a1562236addc8ac4974cfb71bec4159b5ac0b40c36373ad1fb46 |
| PruneDead.gs | f81e1f5c059344f48768510e93a6b395fd5e0a9b2ed9fecd7fb63a50095910ff |
| RemoteActions.gs | b5ca1607c47d618c1638bfe324b72d7413c7cab7ee2a8da2a202079ba05a5dac |
| RemoteTrigger.gs | 0f7cb43b2c31f9787adcf0b9bf937f463ca992909013978edff6dbd3a9926328 |
| amy_indirect_cost.gs | f69d5e583f4d91e2b6185acee802d1806683901593ca9d84bb8c16529aac61ef |
| appsscript | e7485992b05754d79da8feb5b16505adf94dcdd6fb7e155042f5fe6867bc1a20 |
| leave_sync.gs | 410e0e46110f292e3318c305ad40835a37bbfb9613c87cf64ea365b6b3b4e644 |
| masterCreate.gs | a571132b60c0a5fe5d4e7ff15085c452981e32e79b928017ce281e2f1bdf1f19 |
| masterException.gs | c2c8a7d4e616c3f6b39b18c3ff2faf113bb82a172d7cc936e09160334a54aac2 |
| masterLeaves.gs | e4844cc7fa34ba2b7bd0386c8d9765884999c13bfaab918544866cb445072b4b |
| onOpen.gs | 047aaebac4bf4c2c7077f6ab79eab041499f55371d2007258fb6967e26372186 |
| rebuildAttendance.gs | 26d6a3cffc916377eee131f0a06774743e5ad9bc41dc4fa1d674304a3820ae09 |
| 抓取设计脚本.gs | a85da049747d7dab2d0b41e75a77221f3e70fffaa159169c27e3909eacee8130 |
| 每天自动提醒.gs | 7bfc0feb9c415ea9b713203c1a6fa73cd2e25b71ffb946d84d66a395c764a2b1 |

- **修正记录**：初版（commit `8f574bd`）曾误列组合 SHA `46cbfa8c…`（快照重取后字节归一所致）；本版以当前 16 文件实算值 `26471b41…` 为准，并补逐文件哈希。文档 SHA 见提交记录。

*文档性质：离线设计交付（规划），零生产写、零权限变更。固定 commit 与文档 SHA-256 随提交补记。*
