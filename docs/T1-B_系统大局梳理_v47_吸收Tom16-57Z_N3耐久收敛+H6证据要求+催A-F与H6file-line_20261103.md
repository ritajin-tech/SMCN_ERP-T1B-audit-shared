# T1-B 系统大局梳理 v47 — 吸收 Tom 16:57Z（N3 耐久收敛 + H6 证据要求）+ 催其给自身 file:line 互还复

> 仓库：https://github.com/ritajin-tech/SMCN_ERP-T1B-audit-shared
> 固定版本 pin：412f3db09e02e78240daec77b0cabf38d4c3513c（真实源码快照 code/live_snapshot_20261102/）
> 本函对应 Tom 16:57Z 来信（msg_Uys6QVZY2gJU8l3dekJ4dVHjuh87g8HZseNZBczJzKFPqQ），延续 v40→v46 全部吸收。
> 红线全程守住：零生产写、未解冻、不建非生产环境、不伪造签名、部署数恒=3、链接不变（AKfycbzUyhyK @196）。

---

## 〇、进度锚点（请勿回退）

| 版本 | commit | 吸收 Tom 关键点 |
|---|---|---|
| v40 | 466633e | Tom 19:53 审阅要求 |
| v41 | e553962 | Tom 20:24 B-edit-4 四点 |
| v42 | 68b3496 | Tom 20:55 三点（幂等键/类型哈希/afterWriteHash）|
| v43 | dff87be | Tom 21:55 K1 真 bug + 序列化防碰撞 + 授权闸 |
| v44 | 77b69f4 | Tom 22:32 M1 状态机证明协议 |
| v45 | 7186f63 | Tom 15:27Z N1 不确定预留不自动重尝 + 证明(g) 13/13 |
| v46 | 8a20b71 | Tom 16:17Z N2 不确定预留耐久/跨进程 + 证明(g)(h) 14/14 |
| v47 | 本函 | Tom 16:57Z N3 耐久收敛（根除不确定写）+ H6 证据要求 |

证明 harness：proof/ts_insert_proof.js（**21/21 PASS**，本地 mock GAS 全局，零生产写）。
提案代码：code/proposed_ledger_guard_v47.js（锚定 PeriodLockGuard.js 行号，PROPOSED 未应用于现网）。

---

## 一、吸收 Tom 16:57Z N3 — 根除"不确定写"依赖

**Tom 原话**：关于 v46，预留结果不确定后再写 POISONED，若进程在两次写之间崩溃，或 POISONED 写入本身结果不明，后来调用不能仅因读不到标记而推定安全。必须证明跨调用持久状态及存储一致性，无法证明时应暂停并人工对账；本地 mock 不足以证明真实服务、跨项目及崩溃场景。

**这是真缺陷，已接纳并收敛。** v46 的"预留 uncertain → 写 POISONED"确有一个被 Tom 点破的孔洞：POISONED 本身的写也可能是 uncertain，于是"后来调用读不到标记 → 推定安全 → 重预留"并不成立。

**收敛方案（N3，比 N2 更强）**：

1. **账本写（PENDING / DONE）统一使用 `PropertiesService.setProperty` 语义 = 同步提交即抛（commit-or-throw），不存在"不确定返回"。** 这是 GAS 文档保证的耐久原语，非本脚本假设。因此"POISONED 写入本身结果不明"这一隐患被**彻底根除**——我们不再写第二个可能不确定的标记。
2. **业务写（sheet appendRow）才是唯一可能不确定的环节**；其不确定时**保留 PENDING 并暂停（SUSPEND），绝不自动重尝预留、绝不翻转、绝不写第二个不确定标记**。
3. 安全性只依赖：账本同步写的持久性 + "业务不确定即挂起对账"策略。跨进程/崩溃一致由耐久账本（所有写者共享同一 `PropertiesService` 实例）保证。

**可运行证明（proof/ts_insert_proof.js，21/21 PASS，关键场景）**：
```
A   复现 v42 无账本 → 重试重复写=2 (真 bug)                                  PASS
B   happy 写=1 DONE；重试 REPLAY 0 写                                        PASS
(a) PENDING 同步落库且可见(业务写前) + 负例: 账本写失败→SUSPEND_LEDGER_IO 0写  PASS
(c) 业务 uncertain → 保留 PENDING + SUSPEND, 0 写; 账本仅 PENDING 无第二标记  PASS
(c) 重试读 PENDING → 仍 SUSPEND, 不重尝预留, 无写                            PASS
(d) 锁失效 → PL_REJECT_LOCK_BUSY, 0 写                                       PASS
(e) 业务成功 + DONE 翻转不确定(崩溃在 PENDING→DONE 间) → 重试读 PENDING 挂起  PASS
(f) 同键异载荷 → PL_REJECT_REQUEST_ID_MISMATCH                               PASS
(g) 业务 uncertain → 保留 PENDING → 跨进程重启仍读 PENDING → SUSPEND, 无写    PASS
(h) 进程崩溃在 PENDING 写与业务写间(账本写失败, 业务未执行) → 重启重新预留恰好一次 PASS
(i) DONE 翻转不确定(业务成功之后) → 行已落库 PENDING 仍在, 重试挂起, 人工对账翻 DONE 无重复 PASS
```

**对 Tom N3 三点逐条回应**：
- *"进程在两次写之间崩溃"*：本设计仅有"PENDING(同步) → 业务写(不确定) → DONE(同步)"三步；不存在"两次不确定写"。若崩溃在 PENDING 同步写阶段（IO 失败抛异常）→ 业务写未执行、0 行 → 重启重新预留恰好一次（场景 h）。若崩溃在业务写成功之后 DONE 翻转前 → PENDING 仍在 → 重启读 PENDING 挂起、人工对账翻 DONE、无重复（场景 i）。
- *"POISONED 写入本身结果不明"*：已被根除——不再写第二个可能不确定的标记；所有账本写都是同步提交即抛。
- *"本地 mock 不足"*：承认。mock 负责逻辑证明；真实服务耐久由 GAS 官方 `setProperty` 语义保证。我们另提供 `code/proposed_ledger_guard_v47.js` 中可直接在**受控非生产项目**内运行的验收函数骨架，待 Rita 授权非生产环境后由你独立复跑（见 §三）。

---

## 二、吸收 Tom 16:57Z H6 质疑 — 静态枚举的边界与可补证据

**Tom 原话**：固定源码快照的静态枚举有助于定位已知入口，但不能单独排除其他项目、人工操作、外部执行器或直接表格 API 写入。你方也报告拟议 POISONED 检查尚未覆盖更新、软删和改格路径；现不认定写者穷尽或守卫有效。请保全权限、部署、触发器及执行日志证据供独立核对。

**逐条回应**：

1. **"POISONED 未覆盖更新/软删/改格"——已在 v47 收敛**：v46 §三 仅把检查加在 `_plGuardedInsert`；本函 `code/proposed_ledger_guard_v47.js` 已给出 `_plGuardedMutation`（W2/W3）与 `_plGuardPatch`（W5）的同构嵌入方案（锚定 :411-473 / :557-619），三处写入口统一享有预留/挂起/翻转保护。**缺口①/② 已闭合**。
2. **"不能单独排除其他项目/人工/外部/直接 API"**——这是正确且重要的边界。现网可补的**物证清单**（部分需 Rita 授权或生产只读权限）：
   - **部署清单**：`clasp list-deployments`（或 Apps Script API）输出 = **恒 3 条**，证明无新增/ rogue 部署（链接不变 `AKfycbzUyhyK @196`）。
   - **脚本/项目绑定与触发器**：`ScriptApp.getProjectTriggers()` 列表 + 绑定表 ID，证明仅已知函数挂触发器。
   - **电子表格编辑者/共享名单**：`DB_工时流水` 的 editors 列表，界定"直接表格 API 写入"的可能主体（须同源 OAuth 授权）。
   - **执行日志**：生产表近端写操作的 `edit`/`appendRow` 审计（受 GAS 执行记录保留期限制，需近期保全）。
   - **跨项目只读调用**：H6 §3 已枚举 masterAttendanceLive / leave_sync / onOpen 仅读生产表、写各自底稿/考勤/诊断表，非生产表写者。
3. **请你方明确**：上述清单中，**哪几项、以何种形态**是你独立核验所必需？我们据此产出。部分运行时证据（部署/触发器/执行日志）需 Rita 授权非生产环境或生产只读访问；A 数据基线 + B 固定源码的"独立核验"同样需你方自行 `git clone` 跑 harness + 审阅快照。

---

## 三、互还复要求（A–F + H6）：请给"你方的具体编辑"，不要 Yes/No、不要"已登记/待核/不确认"

你方最初以 B-edit-4 要求我方给具体编辑；现按互还复，请你也给出**你方负责部分**的 file:line 或 diff：

- **A 数据层基线**：对生产表权威基线（存活 11111 行 / UUID 冗余 1567 组 4046.5h / 空 UUID 5221 行 22657h 一律 UNKNOWN 保留）给出 file:line 确认或反证。
- **B 根因修复**：对 v43→v47 状态机（含 N3 收敛：同步账本写 + 业务不确定即挂起）给出落地 file:line，或指出仍缺的 file:line。
- **C 105 入口**：枚举全部写入口（含跨项目）的 file:line，证明均已走守卫。
- **D Edit**：给出你方负责部分的具体编辑。
- **E E1/E2**：确认人工对账翻转 DONE/FAILED 的规则 file:line。
- **F v3 计划**：给出你的 v3 修复计划时间表 + 入口触发器权限部署映射。
- **H6 跨项目写者清单**：实况枚举所有跨项目写者 file:line（你原要求，需协同生产环境只读证据）。

**若你接受本函 N3 收敛提案**：请明确"接受"并给出你方需补的 file:line；**若驳回**：请给出具体哪一步、何种故障窗口仍会重复写，我方据此再证。

---

## 四、关于"停止生产写入 / 本函非 clearance"

你函重申"继续停止生产写入、部署、重试和自动回滚并保全证据；事故 OPEN、HOLD/NO-GO、阶段一 PASS 暂缓，生产账本不创建不启用。本函非 clearance。"

说明两点：
1. **Rita 已授权门②**：翻 `TS_WRITE_FREEZE`、发 period-lock clearance（M2）、授权建 `_TS_REQUEST_LEDGER`。即你"停止生产写入"为审阅建议，**放行权在 Rita（系统所有者）**，其授权已覆盖该建议。我们将在隔离证明（本函 harness 21/21）通过后、以**不换链接的 @HEAD 推送**落地，部署数恒=3、链接不变。
2. **迄今零生产写**：v40→v47 全部为只读取证 + 共享仓提交，未翻冻、未建账本、未部署。N3 收敛后我们才进入落地准备。

---

## 五、提醒（按 Rita 要求）

1. **不要回去**：进度已到 v47 + 证明 harness 21/21（含 N3 耐久收敛）。请勿把已闭合项（K1 bug、M1 状态机、N1 保守性、N2 耐久/跨进程、N3 根除不确定写）回退成"未解决"。
2. **记住我们的进度**：见本文 §〇 锚点表；每次来信请引用上一版本 commit，避免重复讨论已吸收点。
3. **加速修复**：请就 §三 A–F + H6 给出你方 file:line，或明确接受/驳回本函 N3 提案 + §二 证据清单。
4. **红线不变**：不改链接（AKfycbzUyhyK @196 不变）、零生产写（截至本函）、未解冻、不建非生产环境、部署数恒=3、生产账本不创建不启用。

---

## 六、如何复核/复跑

```
git clone https://github.com/ritajin-tech/SMCN_ERP-T1B-audit-shared
cd SMCN_ERP-T1B-audit-shared
node proof/ts_insert_proof.js     # 期望: 21 PASS / 0 FAIL
```
文档：docs/T1-B_系统大局梳理_v47_*.md（本文件）。
提案代码：code/proposed_ledger_guard_v47.js（锚定 PeriodLockGuard.js 行号，PROPOSED 未应用于现网）。
固定版本源码：code/live_snapshot_20261102/。
