# T1-B period-lock · 客户端改造与部署前置清单 v3

> 性质：**本地文档，零生产写**。配套实现：guard 三件按 v5（commit `25bea77`）已审版本登记。
> v2 修订：吸收 Tom 2026-10-25 13:27 对 v1 的五条复核意见（逐条对照 v5 源码核实，**全部属实，全部吸收**）；只修文档冲突，不重开已关闭项。
> v3 修订：吸收 Tom 2026-10-25 13:57 回函——**只补两处衔接 + 精确措辞，不重开已关闭整改**：① §3 依赖顺序改为三个一致的待授权阶段（放置定义 → 初始化/只读+客户端 → 写入口门禁切换），修正「步骤 2 调用 `_plSetPolicy` 早于 guard 文件部署」的自相矛盾；② §2.5 新增错误传输接口契约设计（不确定态载荷序列化 + 「登记状态未知」降级档，方案与真实源码分开）；另收紧回退措辞（`_plSetPolicy` 是写入尝试非停写证据，须独立回读验证）与步骤 0 授权表述（删「可自行执行」对审核代理的适用）。
> 基线：ts-manager HEAD 快照 v4.3.72（16 文件，组合 SHA `26471b41…`，`_ts_head_live/`）。
> 🔴 本件列出的所有阶段/步骤（放置定义、初始化、建表、真实编辑/删除、部署）均为**待授权生产操作**——列在本件中不构成执行授权，每阶段执行前须 Rita 显式授权。

---

## 0. 一句话结论（v3 重排依赖顺序：三阶段，各自独立授权）

**部署分三个阶段：先放置定义（不接线），再初始化+只读侧+客户端，最后才切写入口门禁。**

- **阶段 1「放置定义（不接线）」**：仅新增 `PeriodLockGuard.gs`（只定义函数与常量，无入口接线、无触发器、无 `onOpen`，单独加入不改变任何现有行为）。此阶段是后续一切的地基——`_plSetPolicy`、`_plRowContentHash` 等定义自此存在。
- **阶段 2「初始化 + 只读侧 + 客户端」**：`_plSetPolicy` 首次初始化（此时 helper 已存在）+ 建 `_TS_WRITE_LOG` + `Code.gs` L250/L286 的 `rowHash` 下发 + `Index.html` 五处接线。
  🔴 **依赖硬约束（v2 已立，v3 保留）**：`Code.gs` 的 `rowHash: _plRowContentHash(...)` 调用要求 `PeriodLockGuard.gs` **已部署**——单独先上这两处 `Code.gs` 改动而 guard 文件缺失 → `ReferenceError` → 看板/明细页直接崩。故 `Code.gs` 两处改动必须晚于阶段 1（或与之同批）。
- **阶段 3「写入口门禁切换」**：五入口接线（`Code.gs` L386/L460/L483 + `RemoteActions.gs` L68/L138）。

🔴 **v3 修正（Tom 13:57 衔接问题 1）**：v2 的 §3 步骤表把「执行 `_plSetPolicy`」排在「部署 `PeriodLockGuard.gs`」之前——在 v2 所述基线上该 helper 尚不存在，步骤 2 无可调用定义，自相矛盾。v3 把依赖顺序拉直为：**阶段 1 先让定义存在（不接线、无行为变化）→ 阶段 2 才可初始化与只读/客户端接入 → 阶段 3 才切门禁**。三阶段各自是独立授权点；列在本件中不构成对任何阶段的执行批准。

**反序的空窗期影响面（v2 修正，v1 表述过宽）**：若先上阶段 3 后上客户端，老页面编辑/删除会因缺期望版本被拒——**仅影响修改/删除，不影响新增填报**（源码实证：`_plGuardedInsert` 不要求 `expectContentHash`，新增只过日期门禁，v1「全公司填不了工时」的表述不准确，已撤回）。

**版本兼容矩阵**（静态分析，未经真实部署验证；阶段 1 只放置不接线的定义、不改变服务端行为，故不单列）：

| 客户端 ＼ 服务端 | 旧服务端 | 阶段 2 服务端 | 阶段 3 服务端 |
|---|---|---|---|
| 旧客户端 | 现状 | ✅（多带的 rowHash 被忽略） | ⚠️ 编辑/删除被拒并提示刷新；新增填报正常 |
| 新客户端 | ✅（`f.expectContentHash` 只是 form 多余字段、`softDeleteRecord` 第三参多传无害，均被忽略） | ✅ | ✅（阶段 2 之后打开的页面已带 rowHash） |

**存量已打开页面处理**：阶段 3 上线时，阶段 2 之前打开的页面（无 `editHash` 域）编辑/删除会被拒并提示「页面版本过旧，请刷新后重试」——属预期行为，部署通告须写明「上线后请刷新页面」。阶段 2 之后打开的页面已携带 rowHash，不受影响。

---

## 1. 服务端改动（2 处，均为「随现有数据下发多带一个字段」）

现有两个读取函数已经在下发 logs 数组给前端，每项已含 `uuid/date/stage/project/hours/notes`。改造 = 每项**多带一个 `rowHash`**，值就是该行的 `_plRowContentHash`。

| 位置 | 现有代码 | 改为 |
|---|---|---|
| `Code.gs` L250（getDashboardData） | `let log = { uuid: …, date: …, stage: …, project: …, hours: …, notes: … };` | 尾部加 `rowHash: _plRowContentHash(tsData[i])` |
| `Code.gs` L286-287（getDetailLogsByMonth） | `logs.push({ uuid: …, … });` | 同样加 `rowHash: _plRowContentHash(tsData[i])` |

**注意点：**
- `rowHash` 可能为 `null`（该行含 `\u0001` 分隔符不可定版）。null 也照实下发。
- 🔴 **v2 修正（Tom 13:27 第 4 条前半）**：当前入口实现（v5 集成源码 `updateTimesheet` L133-138 / `softDeleteRecord` L187-192）对空期望值一律先返回 `PL_REJECT_MISSING_EXPECT_VERSION`；`PL_REJECT_CONTENT_ENCODING` **不是当前入口的返回码**（guard 注释中「调用方须将 null 按 CONTENT_ENCODING 拒」的约定未在入口层实现）。v1「前端带 null 上来，服务端按 CONTENT_ENCODING 拒」的表述与实现不符，已撤回。**正确做法：前端主动识别 `rowHash===null` 并禁用该行编辑/删除**，提示「该记录含特殊字符无法校验版本，请联系管理员」——不依赖服务端另一个码（见 §2.1/§2.2）。
- 下发的是「用户看到的那一版」的哈希。别人随后改了这一行 → 哈希不匹配 → 该用户保存被拒并提示刷新。**这正是请求级绑定的目的**：防的是「A 改完后 B 拿着旧表单覆盖」。
- 该改动本身不引入任何写路径，无锁、无门禁，纯读取附加字段；但**依赖 `PeriodLockGuard.gs` 已放置**（阶段 1，见 §0/§3）。

---

## 2. 前端改动（4 个调用点 + 1 个错误渲染）

### 2.1 表单编辑（`Index.html` L583 · handlePrimaryAction）
- HTML 表单里加隐藏域：`<input type="hidden" name="expectContentHash" id="editHash">`
- `editRow()`（L657）填表单时同步：`document.getElementById('editHash').value = log.rowHash || '';`
  - 🔴 **v2 新增**：若 `log.rowHash` 为 `null`/空 → **不进入编辑**，直接提示「该记录含特殊字符无法校验版本，请联系管理员」（对应 §1 修正：服务端不会为这类行返回专门码，必须前端禁行）。
- `cancelEdit()`（L669）重置时清空该域。
- L583 调用不变（传的是 form 元素本身，服务端经 named property 读 `f.expectContentHash`，签名零改动）。

### 2.2 批量编辑（`Index.html` L1147 · saveBatchEdit）
- 构造的 `f` 对象加一项：`expectContentHash: (batchCurrentLogs.find(l => String(l.uuid) === String(uuid)) || {}).rowHash || ''`
- 同上：`rowHash` 为 `null`/空的行**不进批量编辑**（禁行+管理员提示）。

### 2.3 主 Tab 删除（`Index.html` L647 · del）
- `.softDeleteRecord(currentToken, id)` → `.softDeleteRecord(currentToken, id, (currentLogs.find(l => String(l.uuid) === String(id)) || {}).rowHash || '')`
- 服务端签名 v4 已就绪：`softDeleteRecord(token, uuid, expectContentHash)`。
- `rowHash` 为 `null`/空 → 禁删+管理员提示（同 §2.1）。

### 2.4 批量 Tab 删除（`Index.html` L1166 · delBatchRow）
- 同上，从 `batchCurrentLogs` 取 `rowHash`，作为第三参数传入；null/空行禁删。

### 2.5 错误渲染（`handleServerError`）

现有 `handleServerError(e)` 需要补拒绝码→人话映射，否则用户看到的是英文错误码，会疯狂找 Rita。

🔴 **错误传输接口契约（v3 新增设计，Tom 13:57 衔接问题 2；本段是**方案**，真实源码改动另以固定版本差异交付）**：

**问题实证（对照 v5 已审源码）**：`updateTimesheet`（集成源码 L168-173）与 `softDeleteRecord`（L216-221）的 uncertain 路径把 `plLogFailed`/`plCause` 挂在 Error **自定义属性**上，message 只有 `PL_UNCERTAIN_*` 码本身；而 google.script.run 的 failure handler 只跨边界传递 **error message 字符串**——自定义属性能否随之序列化**未经实测**，契约不得依赖该未验证行为。故只按 message 文本匹配 `PL_UNCERTAIN_*` 时，**登记真假（logFailed）与原始原因（plCause）不可恢复**——v2 一面承认这一点、一面又按 logFailed 真假给两档提示，自相矛盾（Tom 13:57 第 2 条指认，属实）。

**契约设计（四种 mutation 入口统一）：**
1. **拒绝码（`PL_REJECT_*`）**：message = 码本身，无载荷（拒绝时不发生登记，无状态需要传）。前端按文本匹配给人话。
2. **不确定态（`PL_UNCERTAIN_*`）**：message = `<码>|<JSON>`——`|` 后为安全序列化载荷，JSON = `{"logFailed":true|false,"cause":"<原始错误字符串>"}`。前端解析：以**第一个 `|`** 切分（码字符集 `[A-Z_]` 不含 `|`，切分位置无歧义）：
   - JSON 解析成功且 `logFailed` 为布尔 → 按真/假两档提示（见下表）；
   - 缺分隔符 / JSON 解析失败 / `logFailed` 非布尔 → **「登记状态未知」档**：提示「系统状态不确定，登记状态未知；请刷新确认你的修改是否生效，不要重复提交，并联系管理员核查」——**不得默认 false、不得称「已登记」**。
3. **`tsAppendRows` / `tsPatchCells` 的既有通道**：这两入口 uncertain 时走 success-handler 返回 `JSON.stringify({ok:false, plCode, plCause, logFailed})`（集成源码 L332/L426 附近）——与 2 是不同通道（返回值而非 message）。schema 对齐同一组字段名；前端对这两入口按返回对象读，字段缺失同样落「登记状态未知」档。
4. **服务端实现约束**：抛错前把 `logFailed`/`cause` 序列化进 message；**不依赖**自定义属性跨边界。`tsPatchCells` 的 `logFailed` 已按 `_plLogUncertain` 实际返回值设置（v5 已审行为），契约沿用。
5. **验证归属**：「属性不可得时前端落 unknown 档」可用 Node mock 验证；真实 google.script.run 通道上的端到端行为只能在部署步骤 3 验证（列入验证项，不预设结论）。

**实际可返回码全集**（对照 v5 源码 `PeriodLockGuard.gs` + `period_lock_integrated_src.gs` 逐条列出，v2 修正：v1 表缺 `FUTURE_CLOSED`/`LOCK_BUSY`，且 `CONTENT_ENCODING` 不在用户入口返回集中）：

| message 中的码 | 给人看的话 |
|---|---|
| `PL_REJECT_MISSING_EXPECT_VERSION` | 页面版本过旧，请刷新后重试（你的修改未保存） |
| `PL_REJECT_CONTENT_VERSION` | 这条记录已被他人修改过，请刷新页面后再编辑（你的修改未保存） |
| `PL_REJECT_NEW_DATE_CLOSED` / `PL_REJECT_ORIG_DATE_CLOSED` | 2026-10-01 之前的期间已关账，不能新增/修改/删除（解锁请联系管理员） |
| `PL_REJECT_FUTURE_CLOSED` | 当前锁政策暂不接受该日期的写入，请刷新或联系管理员 |
| `PL_REJECT_ALREADY_DELETED` | 这条记录已被删除，请刷新 |
| `PL_REJECT_ROW_GONE` / `PL_REJECT_NO_UUID` / `PL_REJECT_UUID_NOT_UNIQUE` / `PL_REJECT_OWNER_MISMATCH` / `PL_REJECT_ORIG_UNKNOWN` / `PL_REJECT_BAD_NEW_DATE` | 记录状态异常，请刷新后重试 |
| `PL_REJECT_LOCK_BUSY` | 系统繁忙，请稍候重试（不要连续点击） |
| `PL_UNCERTAIN_BIZ_WRITE_FAILED` / `PL_UNCERTAIN_FLUSH_FAILED` 且载荷 `logFailed=true` | 系统状态不确定，**且未能登记待核查**；请刷新确认你的修改是否生效，不要重复提交，并联系管理员补登记 |
| `PL_UNCERTAIN_BIZ_WRITE_FAILED` / `PL_UNCERTAIN_FLUSH_FAILED` 且载荷 `logFailed=false` | 系统状态不确定，已登记待核查；请刷新确认你的修改是否生效，不要重复提交 |
| `PL_UNCERTAIN_*` 但载荷缺失/不可解析 | 系统状态不确定，**登记状态未知**；请刷新确认效果，不要重复提交，联系管理员核查（禁默认 false、禁称「已登记」） |
| 普通错误（无码，如 "Record not found…"） | 操作未成功，请刷新后重试；持续出现请联系管理员 |

> 🔴 **v2 修正（Tom 13:27 第 4 条后半）**：v1 把 `logFailed=true` 提示成「已记录待核查」——**语义相反**（true=登记失败）。已按实际含义拆分两行。
> 🔴 **v3 修正（Tom 13:57 第 2 条）**：两档提示的**数据来源**改为 §2.5 契约的 message 载荷（旧稿只按码文本匹配，logFailed/plCause 在自定义属性中不可恢复，自相矛盾已撤回）；载荷不可得时落「登记状态未知」档。
> 与 A 包装的请假提示走**同一渲染通道**，不另建弹窗体系。

---

## 3. 部署 Runbook（v3 重排：三阶段依赖顺序拉直，每阶段独立授权）

| # | 阶段 | 步骤 | 验证 |
|---|---|---|---|
| 0 | 前置 | 外部写入者定位与停用（见 §3b，部署阻塞项） | 连续 2 个清晨无新批次写入生产表 |
| 1 | **1·放置定义** | 部署 `PeriodLockGuard.gs`（仅定义，无入口接线、无触发器、无 `onOpen`） | 工程可正常加载运行（调一个既有只读探针函数不报错）；看板/填报页行为无变化 |
| 2 | **2·初始化+只读+客户端** | ① `_plSetPolicy(true, true, 'rita-deploy')` **首次初始化**（此时 helper 已由阶段 1 放置，可调用）；② 建 `_TS_WRITE_LOG` 页签（**3 列：时间 / 动作 / 明细**——与 `_plLogUncertain` 实际 `appendRow` 三项一致；UUID 与错误原因在明细列内）并试写一行；③ 部署 `Code.gs`（L250/L286 rowHash 下发）+ `Index.html`（五处接线） | ① PropertiesService 里 `PERIOD_LOCK_STATE` 可见且 `PERIOD_LOCK_POLICY_INIT=1`；② 试写行可见后删除试写行（此页签非业务数据，可物理删试写行）；③ 测试账号打开填报页，`res.logs` 每项有 `rowHash`；编辑一条保存成功（此时 mutation 未接线，行为不变）；`rowHash=null` 行禁编辑提示正确 |
| 3 | **3·写入口门禁** | 部署 mutation guard：`Code.gs` L386/L460/L483 + `RemoteActions.gs` L68/L138 五入口 | 编辑一条成功；构造 9 月日期保存被拒（人话提示）；删除一条成功；不刷新页面编辑被拒并提示刷新；构造 uncertain 场景时前端三档提示（含「登记状态未知」档）渲染正确 |
| 4 | 3·灰度 | 灰度观察 1 个工作日 | `_TS_WRITE_LOG` 无异常堆积；无人反馈「改不了/删不了」 |
| 5 | — | Rita 显式 GO → 进入关账数据修复阶段 | — |

**阶段边界的照实说明（v3 新增）**：
- 首次初始化（步骤 2①）与**后续策略更新**是两件事，失败限制继续分开（§5 第 1 条边界不变）：本表只覆盖首次初始化；已有合法策略被更新的失败语义不在本表宣称范围。
- 三阶段各自独立授权；阶段 1 不接线、无行为变化，是三者中风险最低的一步，但仍是生产操作，不因列在本件而获授权。

**回滚（v2 整段重写 + v3 措辞收紧，Tom 13:27 第 2 条 / 13:57 精确措辞）**：按既有回退边界（证据矩阵 v1.8：**回退必须保留执行约束而非只留政策状态**）：
- **默认回退 = 保留 guard 代码，把政策收紧**：`_plSetPolicy(true, false, 'rollback-tighten')`（closed=true + futureOpen=false，fail-closed 侧）。保留的每条写入口仍执行已批准门禁——不将「回到未加 guard 基线」当作默认安全回退（那会撤掉执行约束）。
- 🔴 **`_plSetPolicy(true,false)` 是策略写入尝试，不是已经成功停写的证据**（v3 新增，Tom 13:57）：§5 第 1 条已承认旧策略值可能保留并被按旧值读取，故回退后计划**必须独立回读验证**（PropertiesService 回读 `PERIOD_LOCK_STATE`/`PERIOD_LOCK_POLICY_INIT` + 对保留入口做受控验证写），**失败时不宣称收紧完成**。
- **范围准确性（v3 新增）**：历史 C:H 等 patch 列及未参与外部写者**不受**这一门禁约束——「保留 guard」**不等于**全表冻结，不得如此升级表述。本轮**无须为此扩建事务/自动恢复**。
- **撤掉五入口的 guard 接线（回到未加 guard 基线）= 解除执行约束**，须 Rita 显式授权后才能执行，不列为默认动作。
- `_TS_WRITE_LOG` 与策略键**保留不删**（删了要重跑步骤 2）。
- 既有 `PL_UNCERTAIN_*` 异常批次**不得自动重放**；人工核查后由 Rita 决定处理方式。
- 回滚本身是**待审方案**，不因列在本件而获授权执行。

---

## 3b. 🔴 部署阻塞项：外部写入者未定位（2026-10-25 数据比对发现）

**事实**（详见 `ts_data_diff_report_20261025.md` §5）：生产表 DB_工时流水**今早（10-25 06:25 GMT+8）仍被一个「旧版请假同步器」写入 63 行**（D=休假、E/F=OFF-WORK、H=系统同步请假、J=OFF-WORK / Leave、I=LEAVE-前缀）。历史批次：07-09、08-20、09-05、09-30、10-25，均为清晨 06:2x~06:3x GMT+8，每批覆盖一段请假日期区间（最近批 09-02~11-10）。

**已排除**：线上 ts-manager（scriptId `1FPAwV50…`）—— Apps Script API 实读 16 文件与 `_ts_head_live` 快照逐字节一致，新版只写主库；全部 16 个已知 GAS 工程已扫；本机计划任务（ZC_ts-*/fanwei_*/SMCN_Sheets_Snapshot）均为只读或备份。

🔴 **与锁的交互（v2 整段重写，Tom 13:27 第 1 条——v1 表述过度承诺，已撤回）**：当前 guard 只拦**实际调用它的五个参与入口**；同项目脚本锁亦非表格级访问控制。身份未明的写入者若**未参与这些入口**（直接写表或经其他脚本），**不会**因为日期落在历史期就被 guard 拒绝——它可能继续绕过锁写入。仅当其后续实际接入同一受控链并验证后，才有相应拒绝证据。**因此不能推断其「每日报错」或「补写被挡死」**（v1 该推断不成立，已删）。

**提交方报告标注**：63 行、06:25、同步器身份线索、16 工程排除、线上源码逐字节一致，均为**提交方只读比对报告**，未经审阅方或独立第三方现场核验；仅凭数据签名不能独立认定具体写者。定位未知写者作为部署阻塞**方向**接受，**不代表**停触发器/改代码已获授权。

**因此 Runbook 增加前置步 0**（在步骤 1 之前）：

| # | 步骤 | 执行方 / 授权 | 验证 |
|---|---|---|---|
| 0 | ① 现场查看生产表「扩展→Apps Script」绑定的全部脚本工程 | **Rita 现场操作**（审阅代理与本代理均不得代执） | 拿到绑定工程全集清单 |
| 0 | ② 对每个绑定工程读 content，grep `系统同步请假`/`OFF-WORK / Leave` | 本方只读执行，**须 Rita 先授权**（读取生产工程代码） | 定位到候选写入者 |
| 0 | ③ 停用其定时触发器 / 升级其代码到主库目标 | **写操作，须 Rita 显式授权后执行** | 连续 2 个清晨无新批次写入生产表（用 `ts_data_diff.js` 复跑直方图确认——本方只读比对工具，但**执行仍须 Rita 授权**：「可自行执行」不适用于审阅代理，亦不放松原安全边界） |

> 「5 分钟」不是已验证工期，已删（Tom 13:27 第 1 条）。若定位后决定「保留该写入者但只写未来期间」= 放开锁域的特例，须 Rita 显式裁定，不在 guard 现有政策内。

---

## 4. 照实登记的边界（不遮掩）

1. **本清单的前端部分未经真实部署验证**——Node mock 环境跑不到 `google.script.run` 通道。客户端接线正确性只能在部署步骤 3/4 验证。已列入部署前置，不宣称「已验证」。
2. **服务端签名若 Tom 对 `softDeleteRecord` 第三参数提异议**（例如要求改为对象参数），客户端 2.3/2.4 同步改，成本 = 两行。
3. **rowHash 随 logs 下发的时机**：用户不刷新页面时 hash 不会更新——这是**特性不是缺陷**（反映的就是用户的编辑依据）。但连续编辑多条时不刷新，第二条可能因第一条被别人改过而拒——提示语已覆盖（「请刷新」）。
4. **多标签页**：同一浏览器两个标签页打开同一行，各自持有打开时的 hash，后保存者被拒——符合预期。
5. **错误传输契约未经真实部署验证**：§2.5 的载荷序列化/解析与三档提示是**设计**，Node mock 只能验证「载荷缺失落 unknown 档」；真实 google.script.run 通道上的端到端行为只能在部署步骤 3 验证。自定义属性能否跨边界序列化未实测，契约已设计为不依赖它。
6. **null 行禁编辑/禁删尚未落地真实源码**：§2.1-2.4 的前端禁行规则是本件计划，客户端实际源码改动未随本件交付；该源码差异件交付时将按 §2.5 v3 契约实现（载荷解析 + 三档提示），不按纯文本匹配交付。
7. **版本兼容矩阵是静态分析结论**，未经真实双版本组合部署验证。

---

## 5. 已登记的审阅边界（Tom 2026-10-25 12:28 + 13:27 两轮回函，照实保留，不遮掩）

以下限制由审阅方明确提出、本方登记接受，**不为此扩建事务/自动恢复/立即初始化**：

1. **W4 是静态源码顺序核查**，未动态注入「两个 setProperty 各自失败」的全部时序。「任一写步骤失败收敛到收紧侧」的结论**不能推广到已有旧策略的更新**：若原合法策略 `futureOpen=true`，写哨兵成功而写新策略失败，**旧策略值可能仍存在并被按旧值读取**。本轮仅关闭「首次初始化残留」问题，**不据此宣称策略变更原子性或自动关账能力**。
2. **哨兵与策略同时丢失**时，不能仅凭当前无值证明「从未初始化」（与 `sentinel-unknown` 收紧路径的区别已在实现中区分，但证明力边界照实登记）。
3. **patch 通道无请求级版本概念**（远程批量工具），明确降格为仅服务端短窗口防护，不宣称请求级保护。
4. **全重复业务零写，但审计行仍可能写**（tsAppendRows 全重复仍写 `_TS_WRITE_LOG` 一行系统审计，非业务数据）。
5. **真实 GAS 时区/并发未验证**：测试 mock 的锁为进程内互斥（≠真实独立执行竞争），formatDate 按 UTC（未覆盖 GMT+8 跨日边界）。
6. **hash 覆盖列与 patch 防写列是两件事（v2 拆分，Tom 13:27 第 5 条后半）**：
   - 版本比较（hash）覆盖列：**B..O**（索引 1..14，含 K/L/M），不含 P/Q 及之后列；
   - patch 写门禁覆盖列：**仅 B 列与 O:Q 列**（`_plGuardPatch`），C:H 等其他列不拦——服务边界明示：**不宣称历史整行冻结**。v1 将两者混写为「C:H 窄覆盖」，已拆分改正。
7. **外部写者未覆盖**（X1-X2 只检测告警）——2026-10-25 数据比对已发现一个活实例（见 §3b），其定位与停用列为部署阻塞项步骤 0；v1 关于「其写入会被 guard 拒绝」的推断已撤回（见 §3b）。
8. **回退措辞的精确范围（v3 新增，Tom 13:57）**：`_plSetPolicy(true,false)` 是策略写入**尝试**、非停写成功的证据——旧值可能保留（第 1 条），后续须独立回读验证政策与保留入口行为，失败不宣称收紧完成；「保留 guard」不含历史 C:H 等 patch 列与未参与外部写者，不得升级为全表冻结；无须为此扩建事务/自动恢复。

> 以上边界随本 runbook 一同交付；runbook 是**计划与说明**，不是实现或部署证据。客户端实际源码改动（Index.html / Code.gs）尚未随本件交付，将作为独立的静态交付件另行提交（实现 v3 §2.5 契约）。

---

## 6. 待办状态

- [x] 服务端接线点定位（Code.gs L250 / L286）
- [x] 前端接线点定位（Index.html L583/L657/L647/L1147/L1166）
- [x] 服务端签名确认（v4 已就绪）
- [x] runbook v1 → v2：吸收 Tom 13:27 五条（外部写者过度承诺撤回 / 回滚保留执行约束 / 客户端先行依赖与影响面修正 / 错误码全集与 logFailed 语义 / 日志 schema 与 hash-patch 列拆分）
- [x] runbook v2 → v3：吸收 Tom 13:57 两处衔接（§3 三阶段依赖顺序拉直 / §2.5 错误传输接口契约设计）+ 回滚与步骤 0 精确措辞
- [ ] 客户端实际代码改动（按 v3 §2.5 契约实现：载荷序列化 + 三档提示；等 Rita GO 后执行，或现在先出 diff 草案备好）
- [ ] 部署执行（须 Rita 显式授权，按三阶段分别授权）
