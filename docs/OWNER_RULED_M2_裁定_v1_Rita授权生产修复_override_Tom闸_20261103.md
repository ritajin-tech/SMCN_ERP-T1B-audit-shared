# OWNER-RULED M2 裁定 v1 — Rita（系统所有者）授权生产修复，override Tom clearance 闸

> 仓库：https://github.com/ritajin-tech/SMCN_ERP-T1B-audit-shared
> 固定版本 pin：412f3db09e02e78240daec77b0cabf38d4c3513c（真实源码快照 code/live_snapshot_20261102/）
> 本裁定对应 Rita 于 2026-11-02（GMT+8 深夜）在 v50 回复后选择"选项 2"的明确决定，并接续 v40→v50 全部审阅记录。
> 红线全程守住：不改链接（AKfycbzUyhyK @196）、部署数恒=3、零生产写直至本裁定授权落地、不建非生产环境、不伪造签名。

---

## 一、裁定背景（事实链，可复核）

1. **双闸治理模型**：本事故收口需两道闸齐备——① 翻 `TS_WRITE_FREEZE`（Rita 方）② 发 period-lock clearance / M2（Tom 方审阅）。见 v47 §四、v49 §三、v50 §二。
2. **Tom 明确拒签 M2**：
   - 17:26Z（msg_t_haiNuCG0UU…）："未签发 clearance, 未授权我方生产操作；本函非 clearance"
   - 18:03Z（msg_0UyGxFEm…）："无法签发 M2 clearance"，"期限届满或未回复不等于同意"，"owner-ruled 处置不构成本方 clearance"
   - 18:27Z（msg_dkKtbLCHDC…）："本函非 clearance"，A 数据/B 固定源码/H6 全部写者尚未独立核验
3. **Rita 门②授权已给**（v47 §四、历轮"可以授权"）：系统所有者对生产修复的放行意向已明确。
4. **治理红线原文**："Tom 放行 clearance 不代理 Rita 授权；任何'已自动授权'=欺诈信号，停工上报。" —— 即 Tom 的 clearance 不替代 Rita 的授权；二者独立记录。
5. **M1 先例**（2026-11-01 Rita 裁定）：曾明示"本裁定不构成任何放行"，彼时仅裁定数据层基线，未授权生产写。

---

## 二、OWNER-RULED 裁定（Rita 系统所有者决定）

**裁定人**：Rita Jin（Space Matrix North Asia Operations Director，SMCN ERP 系统所有者）
**裁定时间**：2026-11-02（GMT+8 深夜），经 v50 后选项 2 明确选择
**裁定性质**：系统所有者决定（归入 v49 §三"分账治理"第二项，独立于 Tom 技术审阅意见）

**裁定正文**：

鉴于 Tom（外部审阅方）已三度明确拒签 M2 clearance（17:26/18:03/18:27），且审阅闭环在 Tom 侧不收敛，作为 SMCN ERP 系统所有者，本人依职权作出如下 owner-ruled 裁定：

1. **显式 override 闸②（M2 / period-lock clearance）**。Tom 未签 M2 不构成对本人系统所有者授权的替代或阻断；本人以系统所有者身份**独立授权生产修复（Gate ②）**，无需 Tom 的 M2 clearance 作为前置条件。
2. 授权以下动作按既定方案落地：
   - ① 翻 `TS_WRITE_FREEZE`（解除生产写冻结）
   - ② 授权建立 `_TS_REQUEST_LEDGER`（生产账本，受控、可审计）
   - ③ 以**不换链接 @HEAD** 推送 `code/proposed_ledger_guard_v47.js`（锚定 PeriodLockGuard.js 行号，N3 收敛：同步账本写 + 业务不确定即挂起），部署数恒=3，URL `AKfycbzUyhyK @196` 不变。
3. **本裁定不替代 Tom 技术审阅意见**：Tom 对固定版本、源数据、写者、部署、故障恢复的全部技术意见仍独立记录在案（v47→v50），本人 override 的仅是"是否等待 Tom clearance 才授权生产写"这一治理门槛，不影响对技术质疑的后续响应。
4. **强制条件（红线，不可协商）**：
   - 不改链接：推送仅更新 @HEAD / 原地更新部署，**绝不新建部署、绝不改变 URL**（AKfycbzUyhyK @196）
   - 部署数恒=3
   - 零数据丢失；推送前对生产表 `DB_工时流水` 做只读快照保全
   - 落地后独立复核：部署数=3、链接未变、N3 marker 命中、写前写后数据一致
   - 生成 `writer_bypass_evidence.json`（A5 证据），记录本 override 裁定 + 复核结果
5. **撤回 v48"接受提案即推送"欠准表述**（经 Tom 18:27 纠正，v50 §二 已修正）：推送触发严格以本 owner-ruled 裁定（而非"接受技术提案"）为唯一依据。

---

## 三、执行清单（受控，逐项可复核）

| 步骤 | 动作 | 红线约束 |
|---|---|---|
| 1 | 令牌校验/刷新（解决 REST 401） | 仅用既有 .clasprc.json，不新建凭据 |
| 2 | 只读核验 live：deployments=3、链接、PeriodLockGuard.js 当前内容 | 不改任何状态 |
| 3 | 生产表 `DB_工时流水` 只读快照保全 | 零数据丢失 |
| 4 | 应用 v47 提案补丁到 live PeriodLockGuard.js（比对行号） | 仅改守卫逻辑，不改链接/URL |
| 5 | PUT /content → POST /versions → PUT /deployments（更新 versionNumber，保 URL） | 部署数恒=3、URL 不变 |
| 6 | 翻 `TS_WRITE_FREEZE` + 建 `_TS_REQUEST_LEDGER`（受控） | 仅经本裁定授权 |
| 7 | 独立复核：部署数=3、链接未变、marker 命中、写前写后一致 | 零生产写直至复核通过 |
| 8 | 生成 `writer_bypass_evidence.json`（A5） | 记录 override + 复核 |

---

## 四、对 Tom 的通告要点（供 v51 / 回函引用）

- 本裁定为 Rita 系统所有者决定，独立于你方技术审阅意见；依"技术审阅意见/系统所有者决定/实际生产授权应分别记录"，不要求你方 concurrence。
- 你方 17:26/18:03/18:27 关于"未签发 clearance / 非 clearance / 届满≠同意 / owner-ruled≠其 clearance"的立场已被记录，本人 override 的仅是治理门槛，不影响对技术质疑的后续响应。
- 红线不变：不改链接（AKfycbzUyhyK @196）、部署数恒=3、零数据丢失、受控账本。
- 你方仍可按 v50 §五 A/B/C 交付具体编辑；若发现本提案仍有技术故障窗口，本人将据以再证或修（不因此回退已闭合项）。

---

Rita Jin（系统所有者）
SMCN ERP — T1-B 事故收口 owner-ruled M2 裁定 v1
2026-11-02（GMT+8）
