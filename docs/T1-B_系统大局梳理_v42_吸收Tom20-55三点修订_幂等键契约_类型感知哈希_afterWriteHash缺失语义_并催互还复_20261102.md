# T1-B 系统大局梳理 v42 · 吸收 Tom 20:55 三点修订（幂等键契约 / 类型感知哈希 / afterWriteHash 缺失语义）+ 催其给自身 file:line 互还复

- 仓库：https://github.com/ritajin-tech/SMCN_ERP-T1B-audit-shared
- 文档：docs/T1-B_系统大局梳理_v42_吸收Tom20-55三点修订_幂等键契约_类型感知哈希_afterWriteHash缺失语义_并催互还复_20261102.md
- 时间标注：全文用北京时间（HKT, UTC+8）+ UTC 双标。
- 源码基线：`code/live_snapshot_20261102/`（MANIFEST.json 16 文件 SHA256，拉取时点 2026-11-01 23:48 CST；固定版本 pin `412f3db09e02e78240daec77b0cabf38d4c3513c`）。

---

## 0. 吸收 Tom 20:55 回复（`msg_ERw2004…`，20:55 北京 / 12:55 UTC）

- 已收 v41（20:38，MID `<tencent_7FB8971F4D98599B071FBC23DE0A14A0BF07@qq.com>`）；记录我方请求 ID / 载荷哈希 / 多因子对账 / 日志失败处理修订；源码、行号与实际部署仍待你方独立核验。
- **三点待核（逐点回应见 §1）**：
  1. 首试前生成 ID **不足以保证客户端超时重提时复用**，需明确**持久化**及**同 ID 不同载荷的拒绝契约**；
  2. 将所有值转成字符串**可能丢失类型信息**，应以**版本化、无歧义的序列化**定义哈希，并测试类型、分隔符与空值冲突；
  3. 未知结果时 **afterWriteHash 也可能不可得**，不能把缺失证据当成未写入或自动重试依据。
- 重申：以上为**设计审阅要求，非已审核补丁或数据基线确认**；A 原始复算 / B 固定源码逐行核验 / H6 写者枚举仍待完成；持续四停 + 保全；事故 OPEN / HOLD-NO-GO / 阶段一 PASS 暂缓不变；本函不构成 clearance 或生产授权。

---

## 1. 逐点回应三点修订（源码实证，基于固定快照）

### K1 · 请求 ID 持久化 + 同 ID 不同载荷拒绝契约 → 接受，升级为幂等键（idempotency key）契约
- **原 J1 缺陷（你点中）**：v41 J1 仅「调用方首试前生成、贯穿进程内重试」，但**客户端超时重提是新的 HTTP 调用 / 新 invocation，内存中 `opts.requestId` 已丢失** → 不能保证复用。正确做法是**幂等键模式**。
- **修订设计**：
  - `requestId` = **幂等键，由客户端生成并持有**（客户端跨自身超时重试始终回显同一键）；经 `opts.requestId` 传入。
  - 新增持久化账本 `_TS_REQUEST_LEDGER`（**预置，不运行时自动建表**，遵循 R12b :342-349）；列 = `requestId | payloadHash | businessKey | status | resultRef | ts`。
  - `_plGuardedInsert` 在锁内（或独立 ledger 锁）处理：
    - 账本**无**此 `requestId` → 执行写入，成功后落（`requestId → payloadHash + businessKey + status=done + resultRef`）；
    - 账本**有 + payloadHash 相同** → **返回已存结果，不重跑业务写**（幂等重放）；
    - 账本**有 + payloadHash 不同** → **拒绝 `PL_REJECT_REQUEST_ID_MISMATCH`**（fail-closed：同键不同载荷 = 客户端冲突，不得静默覆盖）。
  - 这覆盖客户端超时重提（键存于账本、跨 invocation 存活，非内存）。
- **源码佐证**：`_plGuardedInsert` 已整体收 `opts`（:479），锁在 `_plAcquire`（:490）；ledger 读写须纳入同一临界区（或独立 ledger mutex）防竞态 —— 列为实现注意点。

### K2 · 类型信息丢失 → 接受，改版本化、类型感知序列化（且不动现网 M8）
- **原 J2 缺陷（你点中）**：v41 称复用 `_plRowContentHash`（:281-290）即满足；但该函数用 `String(v)` 归一：`String(1)='1'`、`String('1')='1'`、`String(true)='true'` → **`1` 与 `'1'` 同哈希，类型信息丢失**；`String(new Date())` 亦非确定。确为缺陷。
- **修订设计**：新增 `_plContentHashV1(row)`（**版本化、类型感知**），**不动现网 `_plRowContentHash`**：
  - 每单元格序列化为 `typeTag|value`：`n|1` / `s|1` / `b|true` / `null|` / `dt|ISO8601` / `arr|<json>`；
  - 整行以 `\u0001` join，**前缀版本 `v1:`** 使哈希格式自描述、可演进；
  - 类型标签字符集固定（n/s/b/null/dt/arr），不与 `\u0001` 冲突；
  - 测试覆盖：类型（number/string/boolean/null/date/array）、分隔符（单元格含 `\u0001` → 返回 null，fail-closed）、空值冲突（`null` vs `''` vs `0` vs `false` 必须哈希相异）。
- **🔴 关键向后兼容（M8 不能静默破坏）**：grep 实证 `_plRowContentHash` 现网有 **4 处调用**：
  - `Code.js:250` / `:293` 审计对象 `rowHash`（只读/诊断，影响小）；
  - **`PeriodLockGuard.js:328` `_plRecheckRow` 的 `out.contentHash`，直接喂 M8 `expectContentHash` 比对（:334 `if (out.contentHash !== expectContentHash)`）** —— 这是**现网生产契约**；
  - `RemoteActions.js:1106` `plVerifyHash` 只读诊断。
  - → 若改 `_plRowContentHash` 格式，M8 已存/在途的 `expectContentHash` 将全部失配，破坏请求级 last-write-wins。故 **B-edit-4 的载荷哈希改用新 `_plContentHashV1`，现网 `_plRowContentHash` 保持不动**；若未来要让 M8 也受益，需协调版本迁移（expectContentHash 契约升版 + 客户端同步）—— 列为 B-edit-4 之外的 follow-up，不在本 edit 范畴。

### K3 · afterWriteHash 缺失语义 → 接受，明确「缺失 ≠ 未写入 ≠ 重试依据」
- **原 J3 缺陷（你点中）**：v41 仅写「flush 不确定则标记 PENDING」，未定义 afterWriteHash **完全不可得**时的语义，易误读为「没读到 = 没写入」或「可据此重试」。
- **修订设计**：
  - afterWriteHash 字段取值：可读 → 实际哈希；**不可得 → 显式哨兵 `UNAVAILABLE`**（非空串/非 null 占位，与「空值行」区分）；
  - **对账铁律**：`UNAVAILABLE` **不证明未写入**、**不作为任何自动重试触发**；条目保持 `UNCERTAIN_PENDING_MANUAL`；
  - 唯有**独立的后续显式读**（如日后 `_plRecheckRow` 以 businessKey + payloadHash 找回该行且 payloadHash 匹配）才能把状态翻为 resolved；在此之前一律人工。
  - 与 J4 不变式一致（日志自写失败不重试业务写），现补「缺失证据」分支。

---

## 2. 修订后 B-edit-4（草案，非补丁、非放行，含具体结构）

- **新增 `_plContentHashV1(row)`**（PeriodLockGuard.js，类型感知 + 版本前缀，如 K2）；现网 `_plRowContentHash` 不动。
- **新增 `_TS_REQUEST_LEDGER` 账本**（预置表，R12b 不自动建）：支撑 K1 幂等键契约。
- **`_plLogUncertain(action, detail, meta)`** 第三参 `meta` 字段定稿：
  1. `requestId`（K1 幂等键，主键）
  2. `businessKey`（行 UUID；空 → `UNKNOWN` 不重放）
  3. `rowRange`（仅提示）
  4. `payloadHash`（K2 用 `_plContentHashV1` before-write）
  5. `beforeWriteHash`（锁内重读，用 `_plContentHashV1`）
  6. `afterWriteHash`（可读 → 哈希；不可得 → `UNAVAILABLE`，K3）
  7. `action` + `detail`
  8. `status = 'UNCERTAIN_PENDING_MANUAL'`
- **`_plGuardedInsert(opts)`** 接线（K1）：
  - 锁内先查 `_TS_REQUEST_LEDGER` by `opts.requestId`：无 → 执行 + 落账；同 payloadHash → 返回已存结果；异 payloadHash → 抛 `PL_REJECT_REQUEST_ID_MISMATCH`；
  - flush 不确定（:514）/ 日志自写失败（:354）→ 调 `_plLogUncertain` 带上述 meta，**不重跑 bizWrite**。
- **调用方**：`tsAppendRows`（RemoteActions.js:127）/ `submitBatch`（Code.gs:464）由**客户端幂等键**注入 `opts.requestId`（首试前生成，跨超时重试回显同一键）。
- **跨项目（H6）**：仍 OPEN，待部署清单枚举。

> 其余 B 草案维持 v40 §2 / v41 §2：B-edit-1（RemoteActions.js:96-105 去重读移入锁内）/ B-edit-2（:490-509 锁内线性化 + 失败码 + retry 仅限已知失败）/ B-edit-3（_plSetPolicy:170-183 改经 _plAcquire，顶层仅 setupPeriodLock 调用防嵌套，锁失败抛码不写）。

---

## 3. 红线与进度（请勿回退）

- **红线不变**：不换链接（官方 URL `AKfycbzUyhyK…` @196 未变）、零生产写、未解冻、不建非生产环境、不伪造签名、部署数恒 = 3。
- **进度锚点（勿回退）**：v28–v42 均已落本仓库；v34 支持包已在 GitHub 可达；v35 白屏证据包、v36–v41 吸收各函与 B 草案、本函 v42（吸收 20:55 三点修订 + 催互还复）均已发布。
- **三项提醒（Rita 原话要求）**：
  1. **不要回去** —— 勿退回到「声称已提交却未落实」的状态；
  2. **记住进度** —— 已核基线：数据层 11,111 行 / 43,431.5h、UUID 冗余 1,567 组 / 4,046.5h、空 UUID 5,221 行 / 22,657h 保留原状；
  3. **加速修复** —— 交付 A 或 B 的首个 file:line 编辑。

---

## 4. 下一步 — 明确要求 Tom 互还复（具体编辑，非 Yes/No，非仅审阅）

你方审阅极深，但**互还复**要求（Rita 原话：「要求他也大局系统还复给我们…要有具体的编辑」）**仍未满足**：截至 v42，你方所有函均为审阅/要求，**未给任一 A–F 自身 file:line 补丁**；你 20:55 再明确「不会凭邮件填入未经核实的 file:line 结论」。理解独立核验立场，但**互还复的诉求是你也产出自身具体制品，而非仅审阅我方**。

**具体请求（任一即可推进）**：
- **A 数据基线**：请给**你方独立复算**（你方数字 + file:line，或确认我方 11,111/43,431.5h、1,567 组/4,046.5h、5,221/22,657h，或给自身复算脚本）；
- **B 根因修复**：请给**你方对 `_plSetPolicy` 锁域 / `_plLogUncertain` 留痕 / 幂等键账本 的具体编辑**（file:line 或 patch），或确认/修正我方 B-edit-1..4；
- **H6 跨项目**：请给**部署清单枚举**（谁对 TS_ID 有写权限、触发器、直接写入路径）。

**球在你方**：下一步必须是 file:line 具体编辑（**含你方自身 patch**），非「将核验 / 待枚举」。我方持续四停 + 零生产写 + 不换链 + 不建非生产环境 + 不伪造签名，待命；收件箱有你新函即续接棒、不再问 Rita。

**本函非技术放行或部署授权。**

— Rita（经由 AI agent 代发）
