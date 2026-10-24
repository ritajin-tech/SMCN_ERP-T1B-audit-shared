# 生产工时表 FY27H1 关账 — 离线设计交付件（证据矩阵 v1）

> 配套：`FY27H1_closeout_plan.md`（commit `2aa260c3f6f19a017c1231f33fa7fa9511017d76`，文档 SHA-256 `2df9d9ed3c189f1e6b186407ae3e09cb1e503711416095125f290ca461b41cea`）
> 目的：响应 Tom 2026-10-24 15:58 复核函（msg_WLx25pd…）对「执行 clearance」的 4 项待办——本件为**纯规划/设计交付，零生产写、零权限变更**。实现证据在 Phase 1 身份核验完成后方可补齐。
> 状态：仅规划方向 + 文档整改接受；非阶段一 PASS、非生产写许可、非 GO。

---

## 0. 范围与诚实分层

- 本件不触碰生产表、不拉 GAS、不改任何权限、不现场扫描。
- §8（七条设计约束）与 §8.1（四项已确认业务参数）维持不变，本件在其下展开**可验证对象/入口/状态/并发边界**。
- 凡标注「⏳待 Phase 1 核验」者，系因 `gas_pull` 真实 HEAD 仍 HTTP 400（身份未验证），实际代码未读，仅基于设计推断，须 Phase 1 完成后补实算 SHA/行号。

---

## 1. 写入口清单（Write Entry Inventory）

关账软锁的所有写入口须枚举并逐一挂防护。当前基于设计推断（⏳待 Phase 1 核验真实函数名/行号）：

| # | 写入口 | 拦截层 | 锁生效条件 | 备注 |
|---|---|---|---|---|
| W1 | 工时行提交函数（`onSubmitTimesheet` 类） | 提交前 guard | `fillDate < 2026-10-01` 且非解锁窗口 → 拒 | 主拦截层 |
| W2 | 单元格直接编辑（`onEdit` 简易绑定） | 保护+change 事件 | 锁区只读+灰 | 次层，防绕过 W1 |
| W3 | 批量导入/回填接口 | 入库前校验 | 同上 | ⏳待 Phase 1 确认是否存在 |
| W4 | 解锁申请提交 | 双签校验 | 仅 Rita+sysadmin 签名有效 | 见 §5 |
| W5 | 锁状态写（`lockState` 持久化） | 自身原子写 | — | 见 §4 |
| W6 | 审计 tab 追加 | 与业务写同事务 | — | 见 §3 补偿 |

> Phase 1 须从 `1FPAwV50…` 真实 HEAD 实读上述函数，回填真实函数名、行号、入口参数，并各给文件 SHA-256。

---

## 2. Phase 1 身份诊断计划（HTTP 400 处理）

- **事实**：`tools/gas_pull.py` 拉 `1FPAwV50VdpI2AGT42rfn6JhU0assY1QaARbhTQeiUKS0mZ66yf_JRb8R8` 返 HTTP 400。
- **Tom 要求**：正文须将「浏览器重授权」澄清为**待诊断可能性之一**，非既定解法；§8「不主动扩权限」有效，该动作不由 Tom 方发起，亦不由我方擅自执行。
- **诊断清单（待办，不执行）**：
  1. 确认 400 是凭据范围不足 / token 过期 / 脚本绑定 ID 错位（ReparsePoint 类）。
  2. 若确为 Rita 浏览器授权缺失 → 由 Rita 本人在浏览器打开部署 URL 授权一次（属既有恢复流程，非新增权限）。
  3. 若为本机 clasp 路径/绑定问题 → 用真实路径重跑 `gas_pull`，不扩权。
- **结论**：HTTP 400 解除路径在 Phase 1 仅为**诊断项**；未核真实 HEAD 前，所有写入口（§1）状态标记为「⏳未核」。

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

| 约束 | 设计落点 | 当前证据 | 待补证据（Phase 1 后） |
|---|---|---|---|
| 写入口拦截 | §1 W1–W6 | 设计枚举 | 真实函数名/行号 + SHA |
| 身份核验 | §2 | HTTP400 已记录 | 真实 HEAD 读取 + 诊断结论 |
| 原子写+补偿 | §3 | 序列设计 | `atomic_write_tests.js` + 结果 |
| 锁持久化+恢复 | §4 | 存储设计 | `lockstate_persist_tests.js` |
| 限时例外 | §5 | 双签+7天设计 | `exception_tests.js` |
| 九类反例 | §6 | 场景列表 | 9 例 exit0 + SHA |
| 解耦 | — | A 包装独立 staging | 维持独立 commit 树 |

---

## 8. 与 Tom 15:58 函的逐条对应

- ✅ 接受「规划方向 + 文档整改，实现证据未就绪」定位。
- ✅ §8.1 业务确认按受控通道保存（本件与计划同仓固定 commit，不公开人员资料）。
- ✅ Phase 1 HTTP400 澄清为诊断项，非浏览器重授权既定解；§8 不扩权有效。
- ✅ 本件给出对象/入口/状态/并发边界（§1/4/5/6）与证据矩阵（§7），不以「无技术问题」覆盖。
- ⏳ 实现/测试证据待 Phase 1 身份核验完成后补齐，再请 Tom 对实现件做执行 clearance 复验。

---
*文档性质：离线设计交付（规划），零生产写、零权限变更。固定 commit 与文档 SHA-256 随提交补记。*
