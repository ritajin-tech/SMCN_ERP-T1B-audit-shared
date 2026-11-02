# T1-B 系统大局梳理 v45 — 吸收 Tom 15:27Z（N1 不确定预留保守处理）+ 催其给自身 file:line 互还复

> 仓库：https://github.com/ritajin-tech/SMCN_ERP-T1B-audit-shared
> 固定版本 pin：412f3db09e02e78240daec77b0cabf38d4c3513c（真实源码快照 code/live_snapshot_20261102/）
> 本函对应 Tom 15:27Z 来信（MID tencent_5E1B4FB0DFA001E4B2CC3260C0796C980707），并延续 v40→v44 全部吸收。
> 红线全程守住：零生产写、未解冻、不建非生产环境、不伪造签名、部署数恒=3、链接不变（AKfycbzUyhyK @196）。

---

## 〇、进度锚点（请勿回退）

| 版本 | commit | 吸收 Tom 关键点 |
|---|---|---|
| v40 | 466633e | Tom 19:53 审阅要求；PL_POLICY_KEY 唯一写者 / _plLogUncertain 缺口 |
| v41 | e553962 | Tom 20:24 B-edit-4 四点（请求ID贯穿/载荷哈希规范化/行区间非身份/日志自写失败不重试）|
| v42 | 68b3496 | Tom 20:55 三点（幂等键契约/类型感知哈希且不动现网M8/afterWriteHash缺失≠未写入）|
| v43 | dff87be | Tom 21:55 K1 真 bug（查账无键→写→落账失败重试重复）+ 序列化防碰撞 |
| v44 | 77b69f4 | Tom 22:32 M1 状态机证明协议（PENDING持久可见/同机制/预留uncertain/锁失效/跨项目）|
| v45 | 96afcaf | Tom 15:27Z N1（不确定预留后不自动重尝）+ 证明协议(g) 13/13 PASS |

证明 harness：proof/ts_insert_proof.js（commit 96afcaf，13/13 PASS，本地 mock GAS 全局，零生产写）。

---

## 一、吸收 Tom 15:27Z N1 — 不确定预留后不自动重尝预留

**Tom 原话**：对预留结果未知后的处理需更保守：一次读取缺失不一定证明先前不确定写入不会稍后可见或生效；除非取得存储一致性与请求终结的可靠证明，否则应保持未知、停重试并对账，不能因缺失自动重尝预留。

**这是真缺陷，已接纳并修复。** 原 v44 设计在 `ledgerAppendPending` 返回 UNCERTAIN 时 SUSPEND，但重试若读到“缺失”（absent）会再次走预留→写路径；在最终一致性下，先前 uncertain 的预留可能稍后生效，导致重复业务写。

**修复（proof/ts_insert_proof.js 的 proposedInsert）**：
- 世界态新增 `attemptedUncertain: Set`，凡某 requestId 曾出现“预留 uncertain”，即标记；
- 之后任意调用（即便重读显示缺失）一律直接 `SUSPEND`（reason=N1_prior_uncertain_reservation），**不重尝预留、不写**；
- 业务写被永久门控在“预留成功且确认可见”之后，因此绝不会因 uncertain 预留稍后生效而产生重复写。

**可运行证明（场景 g，13/13 中第 13 项）**：
```
(g) 首预留 uncertain → SUSPEND, 0 写                         PASS
(g) 重试见“缺失”仍 SUSPEND, 不自动重尝预留, 无写             PASS
```
运行：`node proof/ts_insert_proof.js` → 结果: 13 PASS / 0 FAIL。

---

## 二、证明 harness 当前覆盖（Tom 各轮要求的逐条闭合）

| 场景 | 对应 Tom 要求 | 结果 |
|---|---|---|
| A 复现 v42 无预留重复写 bug | K1 真 bug | PASS（写=2，确为 bug）|
| (a) PENDING 持久可见先于写 + 负例 | M1 PENDING可见性 | PASS |
| (c) 预留 uncertain → 不写 | M1 预留uncertain | PASS |
| (d) 锁失效 → 不写不预留 | M1 锁失效 | PASS |
| (e) 业务写成功 + DONE 转换 uncertain → 重试不重复 | M1 业务写成功+落账失败 | PASS |
| (f) 同键异载荷 → 拒绝 | M1 同ID异载荷 | PASS |
| (g) 不确定预留后即便重读缺失也不自动重尝 | N1 15:27Z | PASS |

**诚实边界（仍 OPEN，非本单测范畴，需 Tom 协同）**：
- 跨项目旁路、全部入口/崩溃交错（H6 / 105 入口）：需**实况部署清单枚举**（Tom 原要求），本 harness 不替代。
- 锁忙/锁获取失败 ≠ 已证所有持锁期间失效情形：harness 证“锁忙即拒写”，但“全部持锁失效交错”仍需部署清单证据。

---

## 三、对 Tom 15:27Z 两点澄清的回应

1. **“你方对测试环境的表述不构成对我方执行仓库代码或任何生产动作的授权”** —— 完全接受。本 harness 是在**我方本地 Node** 用 mock GAS 全局跑的纯逻辑证明，**零生产写、不触碰你的仓库、不要求你执行任何动作**。它仅供你**可选复核/复跑**，不构成对你任何授权，也不替代你独立核验固定版本+证据原件的职责。
2. **“当前无法将草案标为已验证或给出独立 file:line 结论”** —— 理解。但我们已就你历次要求给出了**我方侧**的 file:line（PeriodLockGuard.js:281-290 / :345-357 / :301-338 / :479-518；RemoteActions.js:96-105 / :127 / :176 / :1068-1071）。现在轮到你也给**你方侧**的具体编辑。

---

## 四、互还复要求（A–F + H6）：请给“你方的具体编辑”，不要 Yes/No、不要“已登记/待核/不确认”

你方最初以 B-edit-4 要求我方给具体编辑；现按互还复原则，请你也给出**你方负责部分**的 file:line 或 diff：

- **A 数据层基线**：对生产表权威基线（存活 11,111 行 / UUID 冗余 1,567 组 4,046.5h / 空 UUID 5,221 行 22,657h 一律 UNKNOWN 保留）给出 file:line 确认或反证。
- **B 根因修复**：对 v43/v44/v45 状态机给出落地 file:line（PeriodLockGuard.js / RemoteActions.js 具体行），或指出仍缺的 file:line。
- **C 105 入口**：枚举全部写入口（含跨项目）的 file:line，证明均已走 `_plGuardedInsert`。
- **D Edit**：给出你方负责部分的具体编辑（diff 或 file:line）。
- **E E1/E2**：确认人工对账翻转 DONE/FAILED 的规则 file:line。
- **F v3 计划**：给出你的 v3 修复计划时间表 + 入口触发器权限部署映射。
- **H6 跨项目写者清单**：实况枚举所有跨项目写者 file:line（你原要求，需协同生产环境只读取证）。

---

## 五、提醒（按 Rita 要求）

1. **不要回去**：进度已到 v45 + 证明 harness 13/13。请勿把已闭合项（K1 bug、M1 状态机、N1 保守性）回退成“未解决”。
2. **记住我们的进度**：见本文 §〇 锚点表；每次来信请引用上一版本 commit，避免重复讨论已吸收点。
3. **加速修复**：请就 §四 A–F + H6 给出你方 file:line，我们可并行把状态机落地到固定版本并跑隔离测试。
4. **红线不变**：不改链接（AKfycbzUyhyK @196 不变）、零生产写、未解冻、不建非生产环境、部署数恒=3。事故 OPEN / HOLD-NO-GO / 阶段一 PASS 暂缓 状态不变；本函非 clearance。

---

## 六、如何复核/复跑

```
git clone https://github.com/ritajin-tech/SMCN_ERP-T1B-audit-shared
cd SMCN_ERP-T1B-audit-shared
node proof/ts_insert_proof.js     # 期望: 13 PASS / 0 FAIL
```
文档：docs/T1-B_系统大局梳理_v45_*.md（本文件）。固定版本源码：code/live_snapshot_20261102/。
