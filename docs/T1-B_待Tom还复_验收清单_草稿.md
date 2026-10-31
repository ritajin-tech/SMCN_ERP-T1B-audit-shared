# T1-B · 待 Tom 还复 · 第十四轮验收清单（草稿 / 提前准备）

> 背景：第十三轮（Tom 2102，2026-10-30 18:21:56Z）已系统还复并邮件发出（审计仓 `21b9fbb`，
> 2026-10-31 08:56 北京时间，to `1252293966@qq.com` / cc `332721759@qq.com`）。
> 邮件末尾请 Tom 按「file:line:问题:改法:验收」系统还复 **8 项**（非 Yes/No）。
> 本文件为**提交方提前准备的验收清单**：Tom 一回复即可逐项核验、秒级接手第十四轮，不重复排查。
>
> 状态：PRE-GO / 零生产写 / 未翻 TS_WRITE_FREEZE / 未放行 clearance / 未换链接。
> 本清单不构成任何写授权；所有判定以「Tom 独立复跑 + 提交方独立复算」双验证为据。

---

## 一、还复格式硬要求（不接受空回复 / Yes-No）
Tom 的回复须对每个 item 给出 **`文件:行:问题:改法:验收`** 四元组；纯评论、无编辑、无 file:line 一律退回。

---

## 二、8 项验收判据（accepted iff）

### ① journal 绑定（core:567–621 / clearance:353–423）
- **accepted iff**：Tom 确认「形态通过 ≠ 账本真消费了」已被闭环，且给出
  - 是否要求把 `snapshotFingerprintV3` 回写 journal 的具体 `Logger` 行号与字段（file:line:改法:验收）；
  - 或明确声明「无需回写，理由 X」。
- **我方复算**：重跑 `ts_softdel_core.clearance.test.js` 集成 3d/2/8，断言绑定成功写 1、二次重放零写。

### ② 锁释放诚实性 + 进程内登记表（lock_adapter:105–235 / clearance:235–268）
- **accepted iff**：Tom 就「`ts_lock_adapter.js` 取锁→签发→释放三态→登记表」是否足以为其环境当服务端持锁证据，给出
  - 缺哪部分（file:line:改法:验收）；或声明「足以，附独立负例证据」。
- **我方复算**：`ts_clearance.test.js` 2102#2 全段须 PASS；诚实标注「进程内 Map 重启即空、GAS LockService 仅同脚本串行」。

### ③ 指纹 V3 作用域（core:185–293,496–566）
- **accepted iff**：Tom 给出「键集合还缺哪些身份要素」的**键列表**（不接受「够/不够」二字）；
  - 若列新增要素，须给 `file:line:改法:验收`。
- **我方复算**：`ts_clearance.test.js` 2102#3 + core.clearance.test 集成 11/11b/11c/12/13 全零写拒绝。

### ④ 密钥版本化 + 同互斥域 + 禁自动重放（clearance:85–174,288–349,353–423,425–470,459–503）
- **4a 内存 signer 登记表换服务端**：Tom 给最小形态（ScriptProperty 结构 / 轮换 / 失效）的 `file:line:改法:验收`；或声明沿用内存版。
- **4b 同互斥域**：`lockDomain='period-lock/guard'` 是否可接受；须分段则给域清单与原则。
- **4c 持久账本**：文件账本作跨进程原型是否可登记；到 GAS `PropertiesService` 需哪些额外不变量（CAS 不可用时怎么办）。
- **我方复算**：`ts_clearance.test.js` 2102#4 全段 PASS；`reconcileUnknown` 仍 `replayAllowed:false` / `ledgerState:'UNKNOWN'`。

### ⑤ 真实隔离负例（#2/#5 联带）
- **accepted iff**：Tom 能否在其独立环境出具三类负例——`netns` 隔离 / `tryLock` 超时 / 重启残留；
  - 若不能，须指明「缺什么、需我方先给什么复跑配方」。
- **我方复算**：`ts_repro_isolation_runner.py` 跨进程 10/0 仍绿；新增负例须附可独立复算脚本。

### ⑥ §0.3 责任分工（GO_S4_evidence_runbook.md:36–71 §0.3.1）
- **accepted iff**：Tom 按 `file:line:改法:验收` 给出分工表修订（准备方/核证方），不接受空回复；
  - 明确 ①–④ 未清零前不得当服务端持久互斥域 / 独立签发 / 真实隔离证明。

### ⑦ 本轮实测复算（提交方本地）
- clearance 113/0、core 集成全 PASS、跨进程 10/0、GAS harness 43/43、单源 EXIT=0。
- **accepted iff**：Tom 复跑上述任一项并给出版本/环境/结果与差异说明；或声明采信提交方结果。

### ⑧ 刷新受控候选底稿（提前做，见 `evidence/controlled_rederive_2026-10-31/`）
- 提交方已用 2026-10-31 08:27 备份本地重派生（零 live 读）：
  A 精确 67 组/67 行 · A 仅col0差 40 组/40 行 · B 底稿0行 1422 组/1422 行 · B 仅col0差 249 组 · **UNSAFE=0**。
- **accepted iff**：Tom 确认该草稿口径（备份 CSV 不含软标 O 列 → alreadyHandled 未计，GO 时须 live 重跑）；
  - 或指出派生逻辑错误（file:line:改法:验收）。

---

## 三、第十四轮接手 SOP（Tom 回复后自动执行）
1. 解析 Tom 回复，按本清单 ①–⑧ 逐项比对。
2. 凡 Tom 给 `file:line:改法:验收` → 落码 + 补单测 + 跑对应回归。
3. 凡 Tom 仅评论无编辑 → 退回要求补编辑（不进入下一轮）。
4. 全部 accepted → 更新合订版 doc + 邮件 confirm（仍 NO-GO，除非 Rita 翻 freeze/放行 clearance）。
5. 全程维持零生产写 / 未换链接 / 证供非写授权。

---

*本文件为提交方内部提前准备物，非对 Tom 的对外邮件。Tom 回复到达后由提交方据此秒级接手。*
