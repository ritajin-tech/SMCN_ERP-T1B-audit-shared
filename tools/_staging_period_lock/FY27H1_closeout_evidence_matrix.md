# 生产工时表 FY27H1 关账 — 离线设计交付件（证据矩阵 v1.2）

> 配套：`FY27H1_closeout_plan.md`（commit `2aa260c3f6f19a017c1231f33fa7fa9511017d76`，文档 SHA-256 `2df9d9ed3c189f1e6b186407ae3e09cb1e503711416095125f290ca461b41cea`）
> 目的：响应 Tom 2026-10-24 15:58 复核函（msg_WLx25pd…）4 项待办 + **16:57 复核函（msg_Pl7JcoN…）6 条设计收敛**——本件为**纯规划/设计交付，零生产写、零权限变更**。**Phase 1 身份与写入口已于 2026-10-24 16:48 经 `gas_auth` 只读实读 HEAD 解开**（HTTP 200，非 400），§1/§2/§7 已升级为实时核验。
> 状态：规划方向 + 文档整改接受 + Phase1 写入口/身份只读核验完成 + **v1.2 按 16:57 六条收敛原子机制/入口覆盖/例外状态机/到期语义/九类映射/归因更正**；**非阶段一 PASS、非生产写许可、非 GO**。

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
| W6 | 审计 tab 追加（`_TS_WRITE_LOG`，已有） | 与业务写同事务 | — | 见 §3 补偿 |

**W3/W3b 关键**：`tsAppendRows` 已有护栏（限 3000 行、默认拒请假行 `force=1` 才放行、`_tsIsLeaveRowForGuard`、幂等 UUID 去重、`_TS_WRITE_LOG` 留痕）——锁 guard 应叠加在现有护栏之后，按 B 列业务日期拦截 `fillDate < 2026-10-01`。`tsPatchCells` 同理。

**入口覆盖总表（v1.2，含显式未覆盖项）**：

| 路径 | 是否前置拒绝 | 说明 |
|---|---|---|
| W1 `submitBatch` / W2 `updateTimesheet`（Web/移动端） | ✅ 服务端函数入口 guard，提交前拒绝 | 主拦截层 |
| W3 `tsAppendRows` / W3b `tsPatchCells`（脚本/远程批量） | ✅ 入库前逐行校验 | 含批量回填/恢复 |
| 既有直接编辑（有编辑权者在 Sheet 界面手改） | ❌ **不覆盖** | onEdit/change 属事后事件，**不作为拦截证据**； mitigation = Sheet 保护 + 只读灰标为威慑 + 事后审计检测，并在上线说明中**显式声明该入口未前置拦截** |
| 其他脚本/触发器/API/管理员/批量改删（非 W3/W3b 路径） | ❌ **不覆盖** | 显式声明未覆盖；依赖部署身份收敛（executionApi=MYSELF）与所有者侧纪律，逐项列入 Phase 3 上线核对清单 |
| W7 物理删类（purgeRows 等） | ❌ 锁不覆盖 | token 门控维护动作，维持现有门控 |

> 灰标/保护/监听**不是**统一授权网关；凡无前置拦截能力的入口一律标「未覆盖」，不以事后监听冒称拦截。修改/删除校验均核原记录期间 + 目标期间 + 稳定行 UUID/版本。

**W7（物理删类，超出"填"范围但须关注）**：`purgeRows`/`pruneDead`/`delBlankRows`/`purgeSoftLeaves` 为 token 门控的维护动作，可物理删行——关账锁不拦它们（锁语义=禁填/禁改历史行），但 Phase 3 上线说明须点明：锁仅覆盖 W1–W3b 的"写"，删类动作仍按现有 token 门控，不依赖锁。

**现成可复用护栏**（勿重复造）：`_tsSetValuesGuarded`(Code.gs，V4.3.71 B 列日期护栏：写后回读+自动还原，杜绝静默改坏业务日期)、`_TS_WRITE_LOG` 审计 tab、`masterCreate` 的生产表禁用清单（masterCreate.gs `_masterForbiddenIds`）。

**部署身份**（appsscript.json，须 Tom/所有者复核）：`webapp.access = "ANYONE_ANONYMOUS"`、`executeAs = "USER_DEPLOYING"`、`executionApi.access = "MYSELF"`。→ Tom 关注的「匿名不默认安全」在此为**真实部署配置**；写函数均经 `getCurrentUser(token)` 校验 HR 授权令牌，但匿名访问本身存在，guard 必须**服务端强制**而非依赖前端。

---

## 2. Phase 1 身份诊断 — ✅ 已只读解开（2026-10-24 16:48）

- **实测结论**：经 `tools/gas_auth.py`（`~/.clasprc.json` 默认令牌）对 `1FPAwV50…` 调 `script.googleapis.com/v1/projects/{sid}/content` → **HTTP 200，返回正确 scriptId 与完整源码**。身份与项目均确认无误。
- **400 根因定位**：此前 `pull_ts_code.js` / `ts_healthcheck.js`（node，用另一套令牌 `j.access_token`）报 400，**属该 node 通道令牌过期/范围不足，非项目身份或权限真被锁**。→ 修复建议（Rita 回电脑后可选）：让 node 脚本改用 `gas_auth` 通道，或刷新 node 侧令牌；**非浏览器重授权、非新增权限**（符合 §8 不主动扩权）。
- **已核验项（只读）**：
  1. ✅ 真实项目身份：`scriptId` 匹配 `1FPAwV50…`（即 TimeSheet 正式填报页 / 生产工时系统）。
  2. ✅ 部署身份：`ANYONE_ANONYMOUS` + `USER_DEPLOYING`（见 §1，Tom 关注点已坐实）。
  3. ✅ 全部写入口函数名 + 行号（§1 W1–W7，实时 HEAD）。
  4. ✅ 现有护栏模式可复用（`_tsSetValuesGuarded` / `_TS_WRITE_LOG` / `masterCreate` 禁用清单）。
- **未变铁律**：本节及 §1 均为**只读核验产物**；未做任何生产写、未 push、未 deploy。Phase 3 执行 clearance 仍须 **Tom clearance + Rita GO 双闸门**。
- **实时 HEAD 指纹**：版本 `TS_APP_VERSION='4.3.72'`(Code.gs L123)；源码快照 `tools/_staging_period_lock/_ts_head_live/`（16 文件）；**组合 SHA-256 = `26471b4103c569851391ae3f70058b06c2828b8916674a0bd8dd3d3f72693c18`**（计算方法见 §9：按文件名升序拼接 16 文件原始字节后取 SHA-256，可复现）。

---

## 3. 原子检查→写→审计→异常补偿（v1.2 具体化）

> v1 的 BEGIN/COMMIT 为伪序列；本节改为 **GAS/Sheets 无跨区域事务前提下可落地的机制**：操作ID + 预写意图 + 读回校验 + 恢复状态机，并**不声称「当然不丢数据不丢审计」**——每一步的失败/崩溃恢复状态显式定义，补偿失败走 OPEN_BROKEN 隔离，不静默。

### 3.1 前提机制
- **串行边界**：整个 check→intent→write→verify→audit 序列包在 `LockService.getScriptLock()`（tryLock，超时=拒绝重试提示）内，同一时刻仅一个写序列在跑；跨实例并发由脚本锁 + 3.4 的行级 opId 校验双保险。
- **稳定行 ID**：以生产表现有行级 UUID（`f.uuid` 所在列，submitBatch/updateTimesheet 已在用）为稳定行 ID；**一切锁判定、例外授权、审计引用均绑定 UUID 集合，不用行号/rowRange**（行号可漂移）。
- **旧值快照**：写前整行读出（值+UUID），存入意图记录 `oldValues`。

### 3.2 写序列（每入口 W1/W2/W3/W3b 适用）
```
1. check    行锁态 + 例外状态 + 双签 + expiresAt（服务端时钟）→ 不满足即 REJECT（零写）
2. opId     生成持久操作ID（UUID）；向操作日志 tab 预写意图行：
            {opId, uuidSet, oldValues, newValues, state:INTENT, ts}
3. write    业务单元格写入
4. verify   写后回读比对（复用 _tsSetValuesGuarded 模式：回读≠期望 → 用 oldValues 还原 → state=ROLLED_BACK）
5. audit    审计 tab 追加（opId/操作人/旧值/新值/锁态/例外引用）→ state=COMMITTED
```

### 3.3 失败/崩溃恢复状态机（操作日志唯一事实源）
每个 opId 只能处于以下终态之一，启动时与 `dailyWatchdog` 恢复扫描时按**当前单元格实际值 vs 意图记录**判定：

| 崩溃点 | 判定 | 恢复动作 | 终态 |
|---|---|---|---|
| 2 后（仅 intent 落盘） | 单元格值 == oldValues（或未变） | 无需动作 | ROLLED_BACK |
| 3 后 4 前 | 值 == newValues | 用 oldValues 还原（**clearContent 不作还原手段**，必须写回旧值；oldValues 不可靠时不清不覆盖，见 3.4） | ROLLED_BACK |
| 4 后 5 前（业务新值在、审计缺） | 值 == newValues | 先尝试补写审计；**补偿（还原）若也失败** → 见 3.4 | COMMITTED（补审计成功）/ OPEN_BROKEN |
| 还原中途失败 | 值既≠oldValues 也≠newValues，或 oldValues 不可信 | **不清空、不覆盖**；把该 UUID 集合标记隔离 | OPEN_BROKEN |

### 3.4 补偿失败 = OPEN_BROKEN（不冒称恢复）
- OPEN_BROKEN 的 UUID 集合由 check 步骤强制拦截：凡涉及隔离行的写入一律 REJECT（fail-closed），等待人工处置；处置动作本身也走 opId 流程。
- 审计 tab 追加一条 `{opId, state:OPEN_BROKEN, reason}`；若连这条审计都写失败，操作日志 intent 行保留 INTENT 不改写，恢复扫描会再次发现并重试标记。
- **显式不承诺**：补偿失败场景下数据可能停在新旧之间的中间态直至人工介入——系统保证的是「不再接受新写 + 全程留痕 + 人工可判定」，不是自动无损。

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
- 状态迁移全部走 §3 的 opId 序列（检查→写状态→写审计），迁移本身原子；并发双签竞争由脚本锁串行化，不存在「首签即胜出放行写入」——**双签齐备前例外不生效，写入一律拒**。

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
| 写入口拦截 | §1 W1–W7 + 覆盖总表 | ✅ 实时 HEAD 函数名+行号（`submitBatch` L386 / `updateTimesheet` L460 / `tsAppendRows` / `tsPatchCells` 等）+ 组合 SHA `26471b4…` + 未覆盖项显式声明 | 挂锁代码 + SHA |
| 身份核验 | §2 | ✅ HTTP200 实读 HEAD；scriptId 匹配；部署身份 `ANYONE_ANONYMOUS` 已坐实 | —（已只读闭合） |
| 原子写+补偿 | §3 | opId+预写意图+恢复状态机+OPEN_BROKEN（具体机制设计，非伪序列） | `atomic_write_tests.js` + 结果 |
| 锁持久化+恢复 | §4 | 存储设计（ScriptProperties，独立于 `FEATURE_ENABLED`，逐次 check 实时读） | `lockstate_persist_tests.js` |
| 限时例外 | §5 | 双签状态机 + UUID集合+allowedFields+基线版本 + 逐次到期 check | `exception_tests.js` |
| 九类反例 | §6 | 九类逐类映射（T-old-to-new … T-replay） | 9 类 exit0 + SHA |
| 解耦 | — | A 包装独立 staging | 维持独立 commit 树 |

---

## 8. 与 Tom 15:58 / 16:57 两函的逐条对应

**15:58 函（4 项待办）**：
- ✅ 接受「规划方向 + 文档整改，实现证据未就绪」定位。
- ✅ Phase 1 **已只读解开**：经 `gas_auth` 实读 HEAD HTTP200，身份/写入口/部署身份（`ANYONE_ANONYMOUS`）均核验；400 确为 node 通道令牌问题，非浏览器重授权、非新增权限；§8 不扩权有效。
- ✅ 本件给出对象/入口/状态/并发边界（§1/3/4/5/6）与证据矩阵（§7）。
- ⏳ 实现/测试证据仍须 **Rita GO + 双闸门** 后方可编写并实跑。

**16:57 函（6 条设计收敛）→ v1.2 对应**：
1. 原子机制非伪序列 → §3 重写：opId 预写意图 + 脚本锁串行 + 写后回读 + **恢复状态机（§3.3 表格按崩溃点判定）**；补偿失败 = OPEN_BROKEN 隔离（§3.4），**不声称「不丢数据不丢审计」**；oldValues 不可靠时不清不覆盖（§3.3）。
2. 事后事件非前置拒绝 → §1 增入口覆盖总表：W1–W3b 为前置拒绝；**直接编辑/其他脚本/管理员路径显式标「未覆盖」**，不以灰标/保护/监听冒称网关；修改/删除核原期间+新期间+稳定ID/版本。
3. 例外 rowRange 可漂移 → §5.1 改 UUID 集合 + allowedFields + 基线版本指纹；§5.2 双签两独立主体+防同人双角色+防重放；§5.3 原子状态机（APPLIED→FIRST_SIGNED→ACTIVE→COMPLETED/CLOSED/EXPIRED），消除 v1 C4「首签胜」与双签生效的矛盾。
4. 到期语义 → §5.4：**每次写入按服务端可信时间 check expiresAt**，不依赖 dailyWatchdog/触发器；完成即 COMPLETED 失效；到期审计失败仍拒写；含撤销/重复/时钟异常反例。
5. C1–C9 非等价覆盖 → §6 重写为九类逐类映射表（旧改新/新改旧/删除/批量/身份配置失败/例外到期/中途崩溃/审计失败+补偿失败/重放），各配测试 ID；先在合成 fixture 上设计，不为补测试读现场。
6. **归因更正**：15:39「好」为 **Rita 本人**对 §8.1 四项参数的业务确认，由我方（提交方）转述；此前函件如出现主语错置（将该确认表述为与 Tom 相关），**特此更正**。该确认按你登记口径维持为「提交方报告」；公开仓固定 commit **不构成**受控非公开通道，亦不供你独立核验原确认上下文——不公开原始确认或人员资料，维持。

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
