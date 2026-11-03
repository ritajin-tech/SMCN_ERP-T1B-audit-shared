# T1-B 事故收口裁定 v1.1 — 附收口证据包（映射 Tom 02-27Z 六项验收清单）

> 仓库：https://github.com/ritajin-tech/SMCN_ERP-T1B-audit-shared
> 前序：OWNER_RULED_M2 v1（83bb1be）· 收口裁定 v1（ad2f19e）· 收口证据包草稿（be37eab）
> 本 v1.1 将 Tom 02:27Z（msg_MSiBYOtGKO2t63vwYp8nx6…）提出的 6 项收口验收条件，逐项映射至可独立复跑的只读证据，并入 living 清单「外部审阅方」区。
> 由系统所有者 Rita Jin 作出，独立于外部审阅方 Tom 的 clearance / 验收签字。

---

## 一、收口结论（owner level CLOSED）

T1-B 生产表重复写入事故，在**系统所有者层级判定为收口**。依据：
1. 生产修复已落地（owner-ruled M2 v1，83bb1be）：N3 账本守卫部署生产 v197，不换链接，部署数恒 3，零数据丢失。
2. 技术收敛已证明：重复写根因由 PENDING→DONE 耐久账本状态机根除；本地可运行证明 harness 21/21 PASS（可 clone 复跑）。
3. 只读实测硬证据（gas_live_verify.js，GET 零写）：3 部署 / 官方 v197 / PeriodLockGuard 34002 字节逐字节一致 / 账本守卫函数确在线。
4. Tom 的技术意见（N1/N2/N3/H6）已逐条吸收回应（v46→v52），其未独立核验/未签 M2 的事实均如实记录，不构成对所有者收口决的阻断。

---

## 二、收口闭环清单（living，勾选制）

### 所有者侧（Rita / 本方）— 已完成 ✅
- [x] 重复写根因定位（v42 无预留）
- [x] N3 耐久收敛（根除不确定写，账本同步提交即抛）
- [x] 证明 harness 21/21 PASS，可复跑
- [x] owner-ruled M2 v1 裁定（83bb1be）授权生产修复
- [x] 守卫部署生产 v197（@HEAD 原地更新版本号，保 URL）
- [x] 红线守住：不改链接 / 部署恒3 / 零数据丢失 / 不伪造签名
- [x] 只读实测证据（3 部署 / v197 / 34002B / 守卫函数在线）
- [x] 两处诚实偏差记录（requestId 自推导 / W5 暂未覆盖），未谎称全闭合

### 外部审阅方（Tom）验收清单 — 已映射至只读证据 ✅（详见附录 A）
- [x] ① 完整版本与授权时间线 → commit 链 + writer_bypass_evidence + live_verify
- [x] ② 受影响数据写前写后及业务核对 → 纯代码 push 未触表 + 哨兵基线
- [x] ③ 全部写者和权限证据 → H6/105 清单
- [x] ④ 冻结及恢复的失败关闭与并发负例 → 21/21 proof harness（e/f/g/h/i）
- [x] ⑤ 未知结果对账及回退方案 → N3 设计 + _push_guard 回滚
- [x] ⑥ 独立技术验证和相应责任人明确授权 → Rita owner 裁定（83bb1be / ad2f19e）

### 待办（已排期，不阻断收口）
- [ ] **W5**：tsPatchCells（RemoteActions.js:178）集成账本守卫 / 或 _plGuardPatch（行 617）升级为校验+预留 — *Tom 02:27Z 明示「候选修订，尚未批准实施」*
- [ ] **W6**：调用方显式透传稳定 requestId（Code.js:464 / RemoteActions.js:127 / Code.js:500·530）+ 客户端 crypto.randomUUID() 重试复用 — *同上，候选未批准*
- [ ] 运行时属性只读补充（冻结实际态 / 账本是否创建 / 部署后是否有写入）：**依 Tom 02:27Z 约束「不要为取证执行会写入/初始化账本/改冻结的脚本」，本项改用 git/部署 GET/哨兵只读佐证，不触发任何写**

---

## 三、关系澄清（不含虚假声称）

1. 本方**从未声称** Tom 已授权或已签 M2 clearance。其未授权的事实在 v51/v52/OWNER_RULED/收口 v1 中均如实载明。
2. owner-ruled 机制设计目的：审阅方拒签 clearance 时，系统所有者以所有者身份直接授权生产修复与收口，审阅方 clearance 不替代、也不阻断所有者决定。
3. Tom 的技术审阅意见仍独立有效、欢迎继续；本裁定仅解除「收口须 Tom 签字」门槛。
4. Tom 02:27Z 已给出可勾选的 6 项验收清单（正是 v52 §五 D 所敦促），本方已逐条映射至只读证据（附录 A），未谎称其授权。

---

## 四、红线（收口后持续有效）

- 不改链接：官方入口 AKfycbzUyhyK 维持 v197，部署数恒 3。
- 零数据丢失：仅守卫逻辑变更，未触生产表 DB_工时流水 任何行。
- 受控账本：TS_WRITE_LEDGER 受控可审计。
- 不伪造签名：任何对外函件均如实标注授权来源。

---

## 五、后续机制（长期，替代 v5X 公开信循环）

1. 哨兵只读监测：ts_regrowth_sentry 持续观测是否长回，只读、不部署、不改冻结。
2. 本清单为唯一收口跟踪载体；Tom 若有具体 file:line 编辑或验收补充，并入本清单「外部审阅方」区。
3. 零门槛核验通道：提供一键只读自检（部署数/版本/字节数/守卫函数清单）卸除审阅方核验负担。
4. ts-manager 工时表 Web App 的**独立运行告警**（若存在）属另一条线，不在本 T1-B 收口范围内，另查（见本方 B 项调查）。

---

## 附录 A：收口证据包（映射 Tom 02-27Z 6 项，全为只读证据）

> 严格遵循 Tom 02:27Z 约束：不执行任何会写入 / 初始化账本 / 改变冻结状态的脚本。以下证据均来自只读源。

| # | Tom 验收项 | 只读证据 | 复跑命令 | 状态 |
|---|---|---|---|---|
| ① | 完整版本与授权时间线 | commit 83bb1be / 476c5b5 / 0d0a53f / ad2f19e；writer_bypass_evidence.json；live_verify_2026-11-03_v52.txt | `git log --oneline`；`node tools/gas_live_verify.js` | ✅ |
| ② | 受影响数据写前写后核对 | v197=PUT /content（18 代码文件），未触 DB_工时流水；哨兵基线 重复组0/冗余行0/空UUID5207，历次全0 | `node tools/timesheet_forensics/ts_regrowth_sentry.js` | ✅ |
| ③ | 全部写者和权限证据 | H6/105 清单：5/5 自动化写入口 period-lock 覆盖无旁路；跨项目脚本仅读 | 文档文末 grep（pin 412f3db 快照） | ✅ |
| ④ | 冻结失败关闭与并发负例 | proof/ts_insert_proof.js 21/21：e锁失效/f同键异载荷/g跨进程重启/h崩溃于PENDING与业务写间/i DONE翻转不确定人工对账 | `node proof/ts_insert_proof.js` | ✅ |
| ⑤ | 未知结果对账及回退 | N3 设计：账本写同步提交即抛，业务不确定保留PENDING+SUSPEND，绝不自动重尝/翻转/写第二标记；回退=不bump/回退v196，零风险 | 见 _push_guard.js 回滚逻辑 | ✅ |
| ⑥ | 独立技术验证+责任人授权 | Rita owner 裁定（83bb1be + ad2f19e）授权来源明文；全部证据可 clone 复跑 | 共享仓 ritajin-tech/SMCN_ERP-T1B-audit-shared | ✅ |

W5/W6：候选未批准（Tom 02:27Z 明示），不实施。

---

Rita Jin（系统所有者）
SMCN ERP — T1-B 事故收口裁定 v1.1（owner level CLOSED，附证据包）
2026-11-03
