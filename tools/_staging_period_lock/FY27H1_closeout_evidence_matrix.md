# 生产工时表 FY27H1 关账 — 离线设计交付件（证据矩阵 v1）

> 配套：`FY27H1_closeout_plan.md`（commit `2aa260c3f6f19a017c1231f33fa7fa9511017d76`，文档 SHA-256 `2df9d9ed3c189f1e6b186407ae3e09cb1e503711416095125f290ca461b41cea`）
> 目的：响应 Tom 2026-10-24 15:58 复核函（msg_WLx25pd…）对「执行 clearance」的 4 项待办——本件为**纯规划/设计交付，零生产写、零权限变更**。**Phase 1 身份与写入口已于 2026-10-24 16:48 经 `gas_auth` 只读实读 HEAD 解开**（HTTP 200，非 400），§1/§2/§7 已升级为实时核验。
> 状态：规划方向 + 文档整改接受 + Phase1 写入口/身份只读核验完成；**非阶段一 PASS、非生产写许可、非 GO**。

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
- **实时 HEAD 指纹**：版本 `TS_APP_VERSION='4.3.72'`(Code.gs L123)；源码快照 `tools/_staging_period_lock/_ts_head_live/`（16 文件）；组合 SHA-256 `46cbfa8c792dccf7cfde9a675829cfa14b8f7e37de9f3d120b9eac2242bdb436`（按文件名排序拼接 source 计算）。

---

## 3. 原子检查→写→审计→异常补偿

设计序列（每个写入口 W1/W3 适用）：

```
BEGIN
  check: 行锁态 + 解锁窗口 + 签名
  IF 拒绝条件 → return REJECT（不写）
  write: 业务单元格
  write: 审计 tab 追加（操作人/时间/旧值/新值/锁态）
  COMMIT
EXCEPTION e:
  compensate: 回滚业务写（clearContent/restore）
  log: 补偿事件入审计 tab（标记 COMPENSATED）
  return ERROR（fail-closed，绝不静默成功）
```

- **失败模式与补偿**：
  - 业务写成功、审计写失败 → 触发补偿回滚业务写，记录 COMPENSATED，返回 ERROR（不丢数据、不丢审计）。
  - 审计写成功、业务写失败 → 审计标记 ROLLED_BACK，无孤儿记录。
- **证据**：⏳待 Phase 1 后写 `atomic_write_tests.js` 覆盖上述两失败模式，给 SHA + 运行结果（参照 A 包装 82 例 exit0 分层）。

---

## 4. 锁状态持久化 + 恢复

- **存储**：锁态（`lockState`：`{locked:bool, threshold:'2026-10-01', futureOpen:bool, exceptions:[...]}`）存 `ScriptProperties`（非随开关 false 全开，独立于 `FEATURE_ENABLED`）。
- **持久化原子性**：写 `lockState` 单 key，失败即整体失败，不部分生效。
- **恢复**：脚本启动/`dailyWatchdog` 读取 `lockState`；若读取异常/缺失 → 默认 **fail-closed = 锁定**（不默认放行）。
- **证据**：⏳待 Phase 1 后给 `lockstate_persist_tests.js`（写入→重启读取一致性、半写恢复、缺失默认锁）。

---

## 5. 限时例外（7 天封顶）+ 审计

- **申请**：仅 Rita / sysadmin 可发起；双签（两人独立签名）方生效。
- **对象**：仅误填历史行（`fillDate < 2026-10-01`）的更正，不含新业务填报。
- **时限**：解锁起最长 7 天自动过期；到期前可主动关闭。
- **到期处理**：超时未关闭 → 自动重新锁定该范围 + 审计记录 `EXPIRED_AUTO_RELOCK`。
- **审计 tab 字段**：`reqId, requester, coSigner, rowRange, reason, openedAt, expiresAt, closedAt, status`。
- **证据**：⏳待 Phase 1 后给 `exception_tests.js`（双签生效、单签拒、7 天自动重锁、手动关闭）。

---

## 6. 九类反例（锁须覆盖的异常场景）

| # | 反例 | 期望行为 |
|---|---|---|
| C1 | 误填历史行提交 | 拦截 REJECT |
| C2 | 合法十月起新填报 | 放行 |
| C3 | 解锁更正超 7 天未完 | 自动重锁 + 审计 |
| C4 | 解锁窗口内同一行并发双签竞争 | 串行化/首签胜，次签冲突 |
| C5 | 非 Rita/sysadmin 尝试签名解锁 | 拒 |
| C6 | 锁态持久化中途失败 | 恢复为锁定（fail-closed） |
| C7 | 审计写失败但业务写成功 | 补偿回滚 + COMPENSATED |
| C8 | `futureOpen` 误开致历史行放行 | 标志独立校验，历史行仍锁 |
| C9 | 混合状态（部分锁/部分解锁）并发提交 | 按行锁态逐行判定，互不影响 |

> 每类反例须有对应测试用例（exit0）与 SHA；⏳待 Phase 1 后随 §3/4/5 测试件一并交付。

---

## 7. 证据矩阵（Evidence Matrix）

| 约束 | 设计落点 | 当前证据（2026-10-24 只读核验） | 待补证据（Rita GO 后实现） |
|---|---|---|---|
| 写入口拦截 | §1 W1–W7 | ✅ 实时 HEAD 函数名+行号（`submitBatch` L386 / `updateTimesheet` L460 / `tsAppendRows` / `tsPatchCells` 等）+ 组合 SHA `46cbfa…` | 挂锁代码 + SHA |
| 身份核验 | §2 | ✅ HTTP200 实读 HEAD；scriptId 匹配；部署身份 `ANYONE_ANONYMOUS` 已坐实 | —（已只读闭合） |
| 原子写+补偿 | §3 | 序列设计 + 现成 `_tsSetValuesGuarded`/`_TS_WRITE_LOG` 可复用 | `atomic_write_tests.js` + 结果 |
| 锁持久化+恢复 | §4 | 存储设计（ScriptProperties，独立于 `FEATURE_ENABLED`） | `lockstate_persist_tests.js` |
| 限时例外 | §5 | 双签+7天设计 + 复用 `_TS_WRITE_LOG` 审计 | `exception_tests.js` |
| 九类反例 | §6 | 场景列表（C1–C9） | 9 例 exit0 + SHA |
| 解耦 | — | A 包装独立 staging | 维持独立 commit 树 |

---

## 8. 与 Tom 15:58 函的逐条对应

- ✅ 接受「规划方向 + 文档整改，实现证据未就绪」定位。
- ✅ §8.1 业务确认按受控通道保存（本件与计划同仓固定 commit，不公开人员资料）。
- ✅ Phase 1 **已只读解开**：经 `gas_auth` 实读 HEAD HTTP200，身份/写入口/部署身份（`ANYONE_ANONYMOUS`）均核验；400 确为 node 通道令牌问题，非浏览器重授权、非新增权限；§8 不扩权有效。
- ✅ 本件给出对象/入口/状态/并发边界（§1/4/5/6）与证据矩阵（§7），不以「无技术问题」覆盖。
- ⏳ 实现/测试证据仍须 **Rita GO + 双闸门** 后方可编写并实跑，再请 Tom 对实现件做执行 clearance 复验。

---
*文档性质：离线设计交付（规划），零生产写、零权限变更。固定 commit 与文档 SHA-256 随提交补记。*
