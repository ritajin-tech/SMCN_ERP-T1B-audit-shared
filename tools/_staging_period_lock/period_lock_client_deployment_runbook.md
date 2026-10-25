# T1-B period-lock · 客户端改造与部署前置清单 v1

> 性质：**本地文档，零生产写**。配套实现 v4（commit `0534a88`）。
> 目的：把「请求级版本绑定」从服务端半边接完整——客户端不下发 `expectContentHash`，服务端一律 `PL_REJECT_MISSING_EXPECT_VERSION` 拒，编辑功能整体不可用。**这是上线前必须闭环的第一前置**，与 Tom 后续对 guard 的审阅意见无关（除非他对服务端签名提异议，按异议再改）。
> 基线：ts-manager HEAD 快照 v4.3.72（16 文件，组合 SHA `26471b41…`，`_ts_head_live/`）。

---

## 0. 一句话结论

**客户端必须先上线，服务端 guard 后上线。** 顺序反了会出现「空窗期」：老客户端不带期望版本 → 所有编辑/删除被拒 → 全公司当天填不了工时。客户端先行则平滑：老服务端忽略多带的参数（`f.expectContentHash` 只是 form 上一个多余字段，`softDeleteRecord` 第三参数多传无害），新客户端配旧服务端照常工作。

---

## 1. 服务端改动（2 处，均为「随现有数据下发多带一个字段」）

现有两个读取函数已经在下发 logs 数组给前端，每项已含 `uuid/date/stage/project/hours/notes`。改造 = 每项**多带一个 `rowHash`**，值就是该行的 `_plRowContentHash`。

| 位置 | 现有代码 | 改为 |
|---|---|---|
| `Code.gs` L250（getDashboardData） | `let log = { uuid: …, date: …, stage: …, project: …, hours: …, notes: … };` | 尾部加 `rowHash: _plRowContentHash(tsData[i])` |
| `Code.gs` L286-287（getDetailLogsByMonth） | `logs.push({ uuid: …, … });` | 同样加 `rowHash: _plRowContentHash(tsData[i])` |

**注意点：**
- `rowHash` 可能为 `null`（该行含 `\u0001` 分隔符不可定版）。null 也照实下发——前端带 null 上来，服务端按 `PL_REJECT_CONTENT_ENCODING` 拒，fail-closed 语义一致。
- 下发的是「用户看到的那一版」的哈希。别人随后改了这一行 → 哈希不匹配 → 该用户保存被拒并提示刷新。**这正是请求级绑定的目的**：防的是「A 改完后 B 拿着旧表单覆盖」。
- 该改动本身不引入任何写路径，无锁、无门禁，纯读取附加字段。

## 2. 前端改动（4 个调用点 + 1 个错误渲染）

### 2.1 表单编辑（`Index.html` L583 · handlePrimaryAction）
- HTML 表单里加隐藏域：`<input type="hidden" name="expectContentHash" id="editHash">`
- `editRow()`（L657）填表单时同步：`document.getElementById('editHash').value = log.rowHash || '';`
- `cancelEdit()`（L669）重置时清空该域。
- L583 调用不变（传的是 form 元素本身，服务端经 named property 读 `f.expectContentHash`，签名零改动）。

### 2.2 批量编辑（`Index.html` L1147 · saveBatchEdit）
- 构造的 `f` 对象加一项：`expectContentHash: (batchCurrentLogs.find(l => String(l.uuid) === String(uuid)) || {}).rowHash || ''`

### 2.3 主 Tab 删除（`Index.html` L647 · del）
- `.softDeleteRecord(currentToken, id)` → `.softDeleteRecord(currentToken, id, (currentLogs.find(l => String(l.uuid) === String(id)) || {}).rowHash || '')`
- 服务端签名 v4 已就绪：`softDeleteRecord(token, uuid, expectContentHash)`。

### 2.4 批量 Tab 删除（`Index.html` L1166 · delBatchRow）
- 同上，从 `batchCurrentLogs` 取 `rowHash`，作为第三参数传入。

### 2.5 错误渲染（`handleServerError`）
现有 `handleServerError(e)` 需要补拒绝码→人话映射，否则用户看到的是英文错误码，会疯狂找 Rita。最小映射表：

| plCode | 给人看的话 |
|---|---|
| `PL_REJECT_CONTENT_VERSION` | 这条记录已被他人修改过，请刷新页面后再编辑（你的修改未保存） |
| `PL_REJECT_MISSING_EXPECT_VERSION` | 页面版本过旧，请刷新后重试 |
| `PL_REJECT_CONTENT_ENCODING` | 该记录含特殊字符无法校验版本，请联系管理员 |
| `PL_REJECT_NEW_DATE_CLOSED` / `PL_REJECT_ORIG_DATE_CLOSED` | 2026-10-01 之前的期间已关账，不能新增/修改/删除（解锁请联系管理员） |
| `PL_REJECT_ALREADY_DELETED` | 这条记录已被删除，请刷新 |
| `PL_REJECT_HEADER_ROW` / `PL_REJECT_ROW_GONE` / `PL_REJECT_UUID_NOT_UNIQUE` / `PL_REJECT_OWNER_MISMATCH` | 记录状态异常，请刷新后重试 |
| `PL_UNCERTAIN_*`（带 logFailed:true） | 系统状态不确定，已记录待核查；请刷新确认你的修改是否生效，不要重复提交 |

> 与 A 包装的请假提示走**同一渲染通道**，不另建弹窗体系。

## 3. 部署 Runbook（按序执行，每步可独立验证）

| # | 步骤 | 验证 |
|---|---|---|
| 1 | 建 `_TS_WRITE_LOG` 页签（列：时间戳/类型/UUID/详情），并试写一行 | 试写行可见；删除试写行（软删或物理删该页签的试写行——此页签非业务数据，可物理删试写行） |
| 2 | `_plSetPolicy(true, true, 'rita-deploy')` 一次性执行 | PropertiesService 里 `PERIOD_LOCK_STATE` 可见且 `PERIOD_LOCK_POLICY_INIT=1` |
| 3 | **先部署客户端**：Index.html + Code.gs（含 rowHash 下发） | 用测试账号打开填报页，`res.logs` 每项有 `rowHash`；编辑一条保存成功（旧服务端忽略新参数，行为不变） |
| 4 | **后部署服务端 guard**：Code.gs L386/L460/L483 + RemoteActions.gs L68/L138 五入口 | 编辑一条成功；构造 9 月日期保存被拒（人话提示）；删除一条成功 |
| 5 | 灰度观察 1 个工作日 | `_TS_WRITE_LOG` 无异常堆积；无人反馈「填不了」 |
| 6 | Rita 显式 GO → 进入关账数据修复阶段 | — |

**回滚：** 任一步异常 → 服务端五入口回退到 HEAD 版本（客户端改动可保留，无害）；`_TS_WRITE_LOG` 与策略键**保留不删**（删了要重跑步骤 1-2）。

## 3b. 🔴 部署阻塞项：外部写入者未定位（2026-10-25 数据比对发现）

**事实**（详见 `ts_data_diff_report_20261025.md` §5）：生产表 DB_工时流水**今早（10-25 06:25 GMT+8）仍被一个「旧版请假同步器」写入 63 行**（D=休假、E/F=OFF-WORK、H=系统同步请假、J=OFF-WORK / Leave、I=LEAVE-前缀）。历史批次：07-09、08-20、09-05、09-30、10-25，均为清晨 06:2x~06:3x GMT+8，每批覆盖一段请假日期区间（最近批 09-02~11-10）。

**已排除**：线上 ts-manager（scriptId `1FPAwV50…`）—— Apps Script API 实读 16 文件与 `_ts_head_live` 快照逐字节一致，新版只写主库；全部 16 个已知 GAS 工程已扫；本机计划任务（ZC_ts-*/fanwei_*/SMCN_Sheets_Snapshot）均为只读或备份。

**与锁的交互**：这是设计里「外部写者（X1-X2）」的**活实例**。锁上线后，该写入者落在锁域（fillDate < 2026-10-01）的写会被 guard **拒绝**（fail-closed 设计使然，行为正确）——但意味着这个旧写入者会开始每日报错，产生持续错误噪音，且其「补写」语义（把历史区间重新灌进来）会被锁挡死。

**因此 Runbook 增加前置步 0**（在步骤 1 之前）：

| # | 步骤 | 验证 |
|---|---|---|
| 0 | **定位并停用/改造外部写入者**：① 生产表「扩展→Apps Script」查看绑定的全部脚本工程（Rita 操作，5 分钟）；② 对每个绑定工程用 Apps Script API 读 content，grep `系统同步请假`/`OFF-WORK / Leave`；③ 找到后删其定时触发器或升级其代码到主库目标 | 连续 2 个清晨无新批次写入生产表（用 `ts_data_diff.js` 复跑直方图确认） |

> 若定位后决定「保留该写入者但只写未来期间」——须 Rita 显式裁定（这属于放开锁域的特例，不在 guard 现有政策内）。

## 4. 照实登记的边界（不遮掩）

1. **本清单的前端部分未经真实部署验证**——Node mock 环境跑不到 `google.script.run` 通道。客户端接线正确性只能在部署步骤 3 验证。已列入部署前置，不宣称「已验证」。
2. **服务端签名若 Tom 对 `softDeleteRecord` 第三参数提异议**（例如要求改为对象参数），客户端 2.3/2.4 同步改，成本 = 两行。
3. **rowHash 随 logs 下发的时机**：用户不刷新页面时 hash 不会更新——这是**特性不是缺陷**（反映的就是用户的编辑依据）。但连续编辑多条时不刷新，第二条可能因第一条被别人改过而拒——提示语已覆盖（「请刷新」）。
4. **多标签页**：同一浏览器两个标签页打开同一行，各自持有打开时的 hash，后保存者被拒——符合预期。

## 5. 已登记的审阅边界（Tom 2026-10-25 12:28 回函，照实保留，不遮掩）

以下限制由审阅方明确提出、本方登记接受，**不为此扩建事务/自动恢复/立即初始化**：

1. **W4 是静态源码顺序核查**，未动态注入「两个 setProperty 各自失败」的全部时序。「任一写步骤失败收敛到收紧侧」的结论**不能推广到已有旧策略的更新**：若原合法策略 `futureOpen=true`，写哨兵成功而写新策略失败，**旧策略值可能仍存在并被按旧值读取**。本轮仅关闭「首次初始化残留」问题，**不据此宣称策略变更原子性或自动关账能力**。
2. **哨兵与策略同时丢失**时，不能仅凭当前无值证明「从未初始化」（与 `sentinel-unknown` 收紧路径的区别已在实现中区分，但证明力边界照实登记）。
3. **patch 通道无请求级版本概念**（远程批量工具），明确降格为仅服务端短窗口防护，不宣称请求级保护。
4. **全重复业务零写，但审计行仍可能写**（tsAppendRows 全重复仍写 `_TS_WRITE_LOG` 一行系统审计，非业务数据）。
5. **真实 GAS 时区/并发未验证**：测试 mock 的锁为进程内互斥（≠真实独立执行竞争），formatDate 按 UTC（未覆盖 GMT+8 跨日边界）。
6. **历史 C:H 窄覆盖**：哈希覆盖 B..O（含 K/M），不含 P/Q 之后列。
7. **外部写者未覆盖**（X1-X2 只检测告警）——2026-10-25 数据比对已发现一个活实例（见 §3b），其定位与停用列为部署阻塞项步骤 0。

> 以上边界随本 runbook 一同交付；runbook 是**计划与说明**，不是实现或部署证据。客户端实际源码改动（Index.html / Code.gs）尚未随本件交付，将作为独立的静态交付件另行提交。

## 6. 待办状态

- [x] 服务端接线点定位（Code.gs L250 / L286）
- [x] 前端接线点定位（Index.html L583/L657/L647/L1147/L1166）
- [x] 服务端签名确认（v4 已就绪）
- [ ] 客户端实际代码改动（等 Rita GO 后执行，或现在先出 diff 草案备好）
- [ ] 部署执行（须 Rita 显式授权）
