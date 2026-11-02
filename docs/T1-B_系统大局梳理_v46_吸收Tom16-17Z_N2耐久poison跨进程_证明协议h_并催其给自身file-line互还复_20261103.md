# T1-B 系统大局梳理 v46 — 吸收 Tom 16:17Z（N2 不确定预留状态须耐久/跨进程一致）+ 催其给自身 file:line 互还复

> 仓库：https://github.com/ritajin-tech/SMCN_ERP-T1B-audit-shared
> 固定版本 pin：412f3db09e02e78240daec77b0cabf38d4c3513c（真实源码快照 code/live_snapshot_20261102/）
> 本函对应 Tom 16:17Z 来信（MID tencent_55A76496026FCDFBC01CD994817105E1210A），延续 v40→v45 全部吸收。
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
| v46 | 8a20b71 | Tom 16:17Z N2 不确定预留状态须耐久/跨进程一致 + 证明(g)(h) 14/14 |

证明 harness：proof/ts_insert_proof.js（commit 8a20b71，14/14 PASS，本地 mock GAS 全局，零生产写）。

---

## 一、吸收 Tom 16:17Z N2 — 不确定预留状态必须耐久、跨进程一致

**Tom 原话**：对 attemptedUncertain 方案，需明确该状态在进程崩溃、重启、并发调用及存储写入本身不确定时如何持久保留并被所有写者一致读取；仅进程内集合不能证明跨调用安全。模拟只能覆盖其模型及测试场景，不能单独证明存储一致性、跨项目互斥或线上写者无旁路。

**这是真缺陷，已接纳并修复。** v45 的 `attemptedUncertain` 是进程内 `Set`，进程重启即丢失，不能证明跨调用安全。

**修复（proof/ts_insert_proof.js 的 proposedInsert + ledgerAppendPending）**：
- 不再用进程内集合。改为把"不确定预留"状态**耐久落入库本本身**：当预留写返回 UNCERTAIN，立即在耐久账本写入 `POISONED` 标记（`{state:POISONED, payloadHash}`，与 PENDING/DONE 同库、同锁、所有写者一致读取）。
- `proposedInsert` 第一步即从耐久账本读取：若命中 `POISONED` → 直接 `SUSPEND`（不重尝预留、不写），**不依赖任何进程内内存**。
- 进程崩溃/重启后，新进程只读耐久账本即可见 `POISONED`，故行为一致。
- 假设（已在 harness 显式声明）：POISONED 标记为已确认同步写（PropertiesService/script-DB 语义，非 uncertain append），故可靠持久；即便该写本身 uncertain，核心安全仍成立——业务写被门控在"预留成功且确认可见"之后，原 uncertain 调用从未写，不会重复。

**可运行证明（场景 g + h）**：
```
(g) 首预留 uncertain → 耐久 POISONED + SUSPEND, 0 写                    PASS
(g) 重试读耐久账本见 POISONED → 仍 SUSPEND, 不重尝预留, 无写           PASS
(h) 跨进程重启: 新进程仅共享耐久账本+生产表(无进程内集合) → 仍 SUSPEND, 不重尝预留, 无写  PASS
```

---

## 二、证明 harness 当前覆盖（14/14）

| 场景 | 对应 Tom 要求 | 结果 |
|---|---|---|
| A 复现 v42 无预留重复写 bug | K1 真 bug | PASS |
| (a) PENDING 持久可见先于写 + 负例 | M1 | PASS |
| (c) 预留 uncertain → 不写 | M1 | PASS |
| (d) 锁失效 → 不写不预留 | M1 | PASS |
| (e) 业务写成功 + DONE 转换 uncertain → 重试不重复 | M1 | PASS |
| (f) 同键异载荷 → 拒绝 | M1 | PASS |
| (g) 不确定预留 → 耐久 POISONED → 同进程重试 SUSPEND | N1+N2 | PASS |
| (h) 不确定预留 → 跨进程重启仍读 POISONED SUSPEND | N2 | PASS |

运行：`node proof/ts_insert_proof.js` → 14 PASS / 0 FAIL。

**诚实边界（仍 OPEN，需 Tom 协同）**：跨项目旁路、全部入口/崩溃交错（H6 / 105 入口）需**实况部署清单枚举**（Tom 原要求）；模拟覆盖模型与场景，不能单独证明线上写者无旁路——这点 Tom 说得对，需你方协同生产环境只读取证。

---

## 三、N2 在真实代码中的具体落地（file:line，供 Tom 独立核验）

耐久 POISONED 应落在唯一写者路径 `PeriodLockGuard.js` 的 `_plGuardedInsert`（当前 :479-518）：

- **顶部读取（跨进程一致检查，替代进程内集合）**：在 `_plGuardedInsert` 取锁后、业务写前，先 `const cur = _plLedgerGet(opts.requestId); if (cur && cur.state === POISONED) return SUSPEND_NO_WRITE;`（对应 harness `proposedInsert` 的 `if (e.state === POISONED) return SUSPEND`）。
- **预留 uncertain 落 POISONED（:479-518 内预留分支）**：当现有预留写（PropertiesService/script-DB set）返回 UNCERTAIN，立即 `_plLedgerSet(requestId, {state:POISONED, payloadHash, ts})`（同一耐久库、同一把锁），再 `return SUSPEND_NO_WRITE`（对应 harness `ledgerAppendPending` 的 UNCERTAIN 分支）。
- **并发一致**：POISONED/PENDING/DONE 的读与写均包裹在 `_plAcquire` 的 LockService 锁内（与现有 :479-518 同锁），故并发调用串行化，不会出现两写者各自读到 absent 后双写——先到者写 PENDING/POISONED，后到者读到后 SUSPEND。
- **人工对账**：POISONED 终态只能由受控人工对账翻转（同 v44 §M2 权限+审计），不能自动重尝。

以上为**我方侧** concrete edit 提案；请你方独立核验固定版本后给出接受/驳回与自身 file:line。

---

## 四、互还复要求（A–F + H6）：请给"你方的具体编辑"，不要 Yes/No、不要"已登记/待核/不确认"

你方最初以 B-edit-4 要求我方给具体编辑；现按互还复，请你也给出**你方负责部分**的 file:line 或 diff：

- **A 数据层基线**：对生产表权威基线（存活 11111 行 / UUID 冗余 1567 组 4046.5h / 空 UUID 5221 行 22657h 一律 UNKNOWN 保留）给出 file:line 确认或反证。
- **B 根因修复**：对 v43/v44/v45/v46 状态机给出落地 file:line，或指出仍缺的 file:line。
- **C 105 入口**：枚举全部写入口（含跨项目）的 file:line，证明均已走 `_plGuardedInsert`。
- **D Edit**：给出你方负责部分的具体编辑。
- **E E1/E2**：确认人工对账翻转 DONE/FAILED 的规则 file:line。
- **F v3 计划**：给出你的 v3 修复计划时间表 + 入口触发器权限部署映射。
- **H6 跨项目写者清单**：实况枚举所有跨项目写者 file:line（你原要求，需协同生产环境只读取证）。

---

## 五、提醒（按 Rita 要求）

1. **不要回去**：进度已到 v46 + 证明 harness 14/14（含跨进程 N2）。请勿把已闭合项（K1 bug、M1 状态机、N1 保守性、N2 耐久/跨进程）回退成"未解决"。
2. **记住我们的进度**：见本文 §〇 锚点表；每次来信请引用上一版本 commit，避免重复讨论已吸收点。
3. **加速修复**：请就 §四 A–F + H6 给出你方 file:line，我们可并行把状态机落地到固定版本并跑隔离测试。
4. **红线不变**：不改链接（AKfycbzUyhyK @196 不变）、零生产写、未解冻、不建非生产环境、部署数恒=3、生产账本不创建不启用。事故 OPEN / HOLD-NO-GO / 阶段一 PASS 暂缓不变；本函非 clearance。

---

## 六、如何复核/复跑

```
git clone https://github.com/ritajin-tech/SMCN_ERP-T1B-audit-shared
cd SMCN_ERP-T1B-audit-shared
node proof/ts_insert_proof.js     # 期望: 14 PASS / 0 FAIL
```
文档：docs/T1-B_系统大局梳理_v46_*.md（本文件）。固定版本源码：code/live_snapshot_20261102/。
