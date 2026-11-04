> ASCII mirror of docs/T1-B_系统大局梳理_v58_20261104_全日进度与AB错位修复_回应Tom16-54Z.md (same content, byte-identical below). Reason: Tom reported GitHub connector transfer failure on 2026-11-03 14:15Z; this path avoids non-ASCII URL encoding issues.

# T1-B 系统大局梳理 v58 — 2026-11-04 全日进度、A/B 错位事故闭环、对 Tom 16:54Z 逐条答复与大局系统还复要求

> **发布**：2026-11-04（Asia/Shanghai, GMT+8）
> **对应来函**：Tom `2026-11-03T16:54:30Z`（北京时间 11-04 00:54），MID `<tencent_602C36A81A1926D30A98793E13C6C2060805@qq.com>`，主题「回复：【生产表】证据映射与清理报告」
> **共享库**：`ritajin-tech/SMCN_ERP-T1B-audit-shared`（Tom 可读；本文件在 `docs/`）
> **版本链**：v54 `60188d3` → v55 `ee3b4fc` → v56 `6e3e06c` → v57 `69c3193` → **v58（本件）**
> **红线**：严禁换链接。全文所有部署动作均为 `deployments.update` 原地更新，部署恒 3 条、3 个 URL 逐字未变（§8 附实证）
> **状态分层**：事故线 A（11-04 A/B 错位）= 已修复并独立验收 PASS；事故线 B（T1-B 存量重复写入）= **OPEN / HOLD / NO-GO，M2 未签、clearance 未发，本件不构成任何放行**

---

## §0 一句话结论

11-03 23:55（GMT+8）那次 `purgeSoftLeaves` 整表写回，此前被我方判为「与 T1-B 正交、无业务影响」——**这个判断是错的，现予撤回**。它造成生产表 `DB_工时流水` A/B 两列与 C..Q 业务内容结构性错位，令 32 人中 20 人的看板在 9/10 月出现「明明填了却显示漏填」，Jerry Fu / Shirley Lin 的投诉即由此而来。今日已完成全盘全网七源彻查、全用户 dry-run、Rita 裁定的 v2 两步修复、写后独立验收全 PASS；同时如实披露今日确有生产写与 4 次原地部署，均在系统所有者授权轨上，不挂靠 Tom 的 M2，也不推进 GO-S4。

---

## §1 今日（2026-11-04）全量进度

### 1.1 逐项时间线

| # | 时段(GMT+8) | 工作线 | 结果 | 证据 |
|---|---|---|---|---|
| 1 | 10:20–11:00 | Jerry「工时被删 / 九月份都没了」初查 | 243 行 purge 备份逐行核对：全为已软标请假残留，零工时分录 | `_backups/sheets/2026-11-03_before_leave_purge/leave_rows_backup.csv` |
| 2 | 11:21–11:45 | 共享 GAS `ts-manager` 编译损坏（`AMY_EMAIL` 重复声明） | 将 dss API 部署 `AKfycbwYXV3` 原地回退到健康 v197；部署数 3→3，零换链 | 当日日志 §11:21 / §11:37 |
| 3 | 11:10–12:40 | 九月盘点、复刻 Web App 过滤、restore dry-run | 中间结论「609/576 孤儿可清 O 恢复」**后被证伪并作废** | `_tmp/Jerry_Shirley_恢复DryRun_核查报告_20261104.md` |
| 4 | 12:03–12:18 | NPS 孤儿再生根治 | 重写 `_resolveMainDataSheet` 四级选表；`repairMisaligned` dryRun scanned 19 / found 0；部署 @83 原地更新，URL 不变 | 当日日志 §12:03 |
| 5 | 12:26–14:0x | pmlist VO Registry「PO Code 合同编号」误标 | N1 改名 + 34 格强制文本化 + GAS 表头数组同步（@392→@393 原地部署，3→3 不换链） | 当日日志 §12:26 / §13:5x |
| 6 | 13:1x–14:0x | 七源「全盘全网」彻查 | 7 源逐源打勾；程序化 `fullscan.py`：文件 300 / 记忆 1434 / Git 提交 43；IMA 命中 2026-09-11 同构事故与「UUID 不可单独作唯一键」铁律；QQ 邮件命中 Tom 10-14「禁用靠承诺、非服务端硬阻断」；微信未贴记录 + `tencent_drive` 显式标不可达 | `_tmp/全盘全网彻查清单_20261104.md`、`_fullscan_report_20261104_1400.md` |
| 7 | 14:4x–15:0x | 根因 100% 锁定 | `purgeSoftLeaves` → `_tsSetValuesGuarded()` 按 UUID 把 B 钉回原行位；以 11-03 08:35 备份按 **C..I 双指针顺序对齐**生成 4167 行 A/B 修复清单，离线模拟消失键归零 | `tools/_tmp_rootcause_final.py` / `_tmp_mechanism.py` / `_tmp_align_and_sim.py`；`_tmp/工时看板少数据_最终根因与修复方案_20261104.md` |
| 8 | 14:55–15:17 | 全用户 dry-run + Rita 裁定 v2 | 32 人全查：20 个受影响者缺口 789→0、0 人变差、12 人本来无损且不动；抓出 36 组同 UUID 重复副本，收敛为 v2 两步（v1 降级为诊断对照基线，非方案） | `_tmp/全用户DRYRUN预演报告_20261104.md`、`_tmp/dryrun_all_users.csv` |
| 9 | 15:2x–16:11 | **v2 执行 + 写后独立验收** | 写前 A:Q 快照 → v199/v200 首次真写「返回 done 但 A/B 未落地」→ 立即回滚 36 行软标 → v201 仍失败 → 定位 Date 对象写入坑 → **v202 本地格式字符串写入** → 14 批 A/B + 1 批 dedup 全量成功 → 独立验收全 PASS | `_tmp/v2_apply_final_20261104.txt`、`_tmp/v2_verify_final_20261104.txt`、`_tmp/工时看板少数据_v2执行与验收报告_20261104.md` |
| 10 | 16:1x | 项目铁律更新 | 新立「生产写写后回读」「修复类生产写隔离」两条硬闸 | `.workbuddy/memory/MEMORY.md` / `2026-11-04.md` |

### 1.2 今日新收外部文件（已纳入本件，边界明示）

| 来件 | 时间 | 处理 | 边界 |
|---|---|---|---|
| Tom「回复：【生产表】证据映射与清理报告」`msg_NOIGeE4HNPJ2Q4BSfj3ZgI8sUVNwcHbk-L6TfQhJ5qU_og` | 2026-11-03T16:54:30Z | 全文逐条答复（§4） | 本件不构成 clearance / 生产授权 |
| Luby Huang「FY27H1 北亚经营 KPI 口径 & Design 考评数据补齐 — 同步」`msg_wfIY3jgVPP5hGyucWTlJOZBiT6IbANVnvvZMOmPJWV7UUA`，附件 `2026年8月工时填写情况汇总_含已填齐人员.xlsx`（5,620 B） | 2026-11-04T03:26:47Z | 附件已解码解析入仓（`_tmp/Luby_附件内容_20261104.txt`）：表头=「2026年8月／全员工时填写情况」，口径注记=21 个工作日、排除周末及标记请假、两张表都无工时也计漏填；共 31 人、合计漏填 305 人天、4 人已填齐、5 人暂估 105 天；表尾自标「初步结果，暂估天数未核实」。业务指令=设计部 KPI 按 8 月前填写率 100% 完整、8 月空缺率按附件计算 | **该表是基于两张截图的初核结果，与生产表 B 列日期口径不同源，且自标未核实；不得作为本事故的技术验收基线**。HR KPI 口径为独立业务线，个人明细不外发；今日修复只恢复生产表真实业务键，不改变、也不重算该附件的初核结论 |

---

## §2 事故线 A：工时看板 9/10 月漏填（已闭环）

### 2.1 根因（已定案，非推测）

| 环节 | 事实 |
|---|---|
| 触发 | 11-03 23:55–23:56 GMT+8 `purgeSoftLeaves`：读全表 → 过滤 243 条已软标请假行 → `setValues` 写回 → 删尾 |
| 机制 | C..Q 内容整列上移（分段位移 57 / 90 / 243 行），而 `RemoteActions.js:808` `_tsSetValuesGuarded()` 在 `:815–:831` 构造 `bBefore[uuid] = dataBefore[j][1]` 并按 `afterU[r][0]` 把 B 列**钉回原物理行位**（返回 `dateFixed:2519`） |
| 放大 | 生产表 UUID 大量重复且为空；历史铁律「UUID 不可单独作唯一键」（IMA 2026-09-11 工作日志）被违反，按 UUID 还原必然错配 |
| 结果 | A（录入时间）/ B（业务日期）与 C..I 内容错开；`getDetailLogsByMonth` / `getDashboardData` 按 B 列过滤月份 → 9/10 月工时挂到 4–8 月或不可见 |

**排除的误判（我方今日主动作废 4 处）**：① `Code.js:253` `getDay()` 周列错位（776 行实测错位=0）；②「看错页面 / 会话缓存」；③「后端把九月过滤掉」；④「清理 O 列软标即可恢复 1528 行孤儿」——11-02 新增 1720 条软标**全部**是 11-01 有可见副本的合法去重，清 O 会复活重复数据。

### 2.2 影响面（用户视角业务键 `K = 姓名 + GMT+8 日期 + 项目 + 类型 + 工时 + 备注`）

- 基线 = 11-01 事故前正确态；损坏态 `完全消失键 = 788`（早期离线口径记 789，差 1 为尾部新行，两口径均归零），`虚高键 = 15→36`
- 受影响 **20 / 32 人**：Jerry Fu 128、Shirley Lin 121、Kai Chang 89、Aien Sheng 52…
- **Jerry 逐月**：7 月缺 0 / 8 月缺 0 / **9 月缺 43 / 10 月缺 85** — 与「7 月 8 月正常，9 月开始不对」逐字吻合
- **Shirley 逐月**：9 月缺 56 / 10 月缺 65

### 2.3 v2 两步（Rita 裁定，唯一方案）

| 步骤 | 动作 | 行数 | 说明 |
|---|---|---|---|
| Step 1 | `repairAB` | 4167 | 以 11-03 08:35 备份按 **C..I 实填列双指针顺序对齐（不用 UUID）** 还原 A/B；C/F/G 三重指纹逐行校验 |
| Step 2 | `repairDedup` | 36 | 软标表尾 11204–11239 的同 UUID 重复副本 O/P/Q，与 11-02 合法去重同口径 |

只修 A/B 会留下 36 组「同 UUID 两行落同一天」→ 虚高键 36，故必须两步。载荷与回滚清单：`_tmp/AB_repair_payload.json` / `_tmp/dedup_payload.json` / `_tmp/AB_rollback_manifest.csv` / `_tmp/dedup_rollback_36.csv`。

### 2.4 执行时间线（含一次中途事故，如实记录）

| 时间(GMT+8) | 动作 | 结果 |
|---|---|---|
| 15:2x | `clasp pull` 线上 HEAD、v197 比对 | HEAD == v197；增量仅 `RepairAB.js` + dispatch 两行 |
| 15:40 | 写前 A:Q 全表快照 + 4167/36 指纹 | MATCH 4167 / 36，MISMATCH 0 |
| 15:42–15:4x | **v199**、**v200** 原地更新写通道 | 部署 3 条、URL 不变 |
| 15:46–15:48 | DRY 全绿 → 首次 `--apply` | 返回 4167+36 全 `done`，但 **A/B 实际未落地** |
| 15:49 | 写后独立验收发现 → **立即回滚 36 行软标** | 恢复修复前基线（否则消失键涨到 824） |
| 15:50–16:0x | 逐级定位（写日志 / GAS 内部回读 / `patchCells` 单格对照） | 见 §2.5 |
| 16:0x | **v201**（`setValue(Date)`） | 仍不落地，`verify` 抓到 `aIsDate=false` |
| 16:0x | **v202**（本地格式字符串） | 单行验证 `aIsDate/bIsDate=true` |
| 16:07 | 写前最终快照（4167/36 全 MATCH） | `soft=1747 / visible=9504` |
| 16:07–16:10 | **v202 全量 `--apply`** | 14 批 A/B + 1 批 dedup，每批写后回读闸通过，零回滚 |
| 16:11 | 写后快照 + 独立验收 | 全部 PASS |

共 4 次原地更新 v199→v202，全部走 `tools/gas_push_deploy.py`（`updateContent` → `versions.create` → `deployments.update`），**未用 `clasp deploy`、未新建部署**。线上版本清单实时可读：v199 `07:41:27Z` / v200 `07:45:03Z` / v201 `08:03:05Z` / v202 `08:05:48Z`（UTC）。

### 2.5 关键新发现：A/B 列对 Date 对象写入「返回成功但不落地」

| 写入方式 | 结果 |
|---|---|
| `setValues([[Date, Date]])` | 返回 `done=N`、写日志正常、GAS 内部回读仍是旧值 |
| `setValue(Date)` 单格 | 同上 |
| 带 `Z` 的 ISO 字符串 | 落地但存成**纯文本** |
| 本地格式 `"yyyy-MM-dd HH:mm:ss"` / `"yyyy-MM-dd"` | 落地，Sheets 解析成**真正 Date 对象** |

不能退化成文本的原因：`Code.js:118` 期锁 `rowHash` 用 `instanceof Date` 判定（`if (cellValue instanceof Date) return cellValue.getTime().toString();`），文本会让期锁 hash 失效，且 `substring(0,10)` 会取错日期。

已加护栏：`RepairAB.js:101` 每批返回 `verify`（前 3 行 A/B 值 + `aIsDate/bIsDate`）；`tools/ts_repair_ab.js:105–118` `phase()` 每批真写后强制校验类型与写后回读 B 值，不符立即抛错并由 `:160` 自动全量回滚。正是这道闸让首次失败没有演变成「以为修好了」。

### 2.6 写后独立验收（`tools/_tmp_verify_after_v2.py`，零写入）

| 判据 | 结果 |
|---|---|
| C..N 业务内容全表零改动 | PASS diff=0 |
| 非目标行 A/B 逐格未变 | PASS changed=0 |
| O/P/Q 只改 36 个目标行 | PASS 36/36 |
| 4167 行 A/B == payload 正确值 | PASS bad=0 / 0 |
| 完全消失业务键 788 → **0** | PASS |
| 虚高键 → **0** | PASS |
| 可见行 9468 / 工时 38770.0h | PASS |
| 工时减少 139.0h == 36 条副本合计 139.0h | PASS |
| 20 个受影响者缺口全归零、32 人 0 变差 | PASS |
| Jerry 9/10 月 43/85 → 0；Shirley 56/65 → 0；7/8 月始终 0 | PASS |
| 抽查 6 行 A/B `fmt=raw` 均为 ISO（真 Date） | PASS |

> 7/8/9 月可见行数低于 11-01 基线，是 11-02 那 1720 条**合法去重**造成，不是缺口；权威判据是 11-01 的 distinct 业务键是否全部回来。

### 2.7 回滚通道

`TS_WRITE_FREEZE=0 node tools/ts_repair_ab.js --rollback`（反序：先 `repairDedup undo=1` 清 36 行 O/P/Q，再还原 4167 行 A/B）。精确基线 `_backups/sheets/2026-11-04_before_v2_final/`（A:Q 全表 + manifest + 指纹）。注意 `--rollback` 会把 A/B 还原成**错位状态**，仅在决定整体撤销时使用。

---

## §3 事故线 B：T1-B 存量重复写入（独立，状态未变）

- 权威口径仍是：存活 11,111 行 / 43,431.5h；UUID 冗余 1,567 组 / 1,567 行 / 4,046.5h；MIXED=0；空 UUID 池 5,221 行 / 22,657h 一律 UNKNOWN 保留原状。
- `TS_WRITE_FREEZE` 全局冻结闸、`ts_post.py` 的 clearance、T1-B 冗余候选集**均未改动**。今日的 `TS_WRITE_FREEZE=0` 只设在 `ts_repair_ab.js` 的**单个进程**里，不改任何文件、不翻全局闸。
- M2 未签、A5 期锁旁路证据未闭合、W1–W6 未交卷、四项 T2 证据（服务端持久账本 / 恢复状态机 / 独立签发 / GAS LockService 跨项目互斥）仍无实证。
- **事故安全状态仍是 OPEN / HOLD / NO-GO，阶段一 PASS 暂缓**。本件不构成 clearance，也不推进 GO-S4。
- 治理分层照旧记录：所有者层级收口决定（v1 `ad2f19e` / v1.1 `f8a9edf`）与我方技术状态是两个来源，互不覆盖、不重开已决项。

---

## §4 对 Tom 16:54Z 来函的逐条答复

### 4.1 「时间存在冲突，请澄清时区、实际执行时间」

**是我方前函把时区标错了，致歉并更正。没有时间冲突。**

- 前函写的「11 月 3 日 23:56 UTC」中的 `23:56` 是 **Asia/Shanghai（GMT+8）本地时间**，误标成 UTC。
- 硬证据：`_backups/sheets/2026-11-03_before_leave_purge/manifest.json` 的 `backup_time = "2026-11-03T15:55:06.565Z"`；同目录 `leave_rows_backup.csv` 文件系统 mtime = `2026-11-03 23:55:06.565893000 +0800`；GAS 项目 `appsscript.json` 的 `timeZone = "Asia/Shanghai"`。
- 即：写前备份 15:55:06Z / 23:55:06 GMT+8，`purgeSoftLeaves` 随即执行，实际完成约 **2026-11-03 15:56 UTC = 2026-11-03 23:56 GMT+8**。
- 该时点**早于** 11-04 00:39 北京（= 11-03 16:39 UTC）那封来信约 43 分钟，因此附注是「报告一个已发生的事实」，不是「来信之后又发生的动作」。

### 4.2 「目标范围、备份、写前写后数据、业务影响尚未核实」「不能仅凭『正交』排除交集」

**这一条你说对了：我方此前「正交」的结论是错的，现正式撤回。**

| 你要求的项 | 本次交付 |
|---|---|
| 目标范围 | 谓词 `O[14]=TRUE AND _lsIsLeaveRow(r)`（`leave_sync.js:342`），命中 243 行；`purgeSoftLeaves?dry=1` → `removed:243`；real → `removed:243, kept:11203, dateFixed:2519`。11-01/11-02 的 1,720 条 T1-B 软标未动 |
| 备份 | `_backups/sheets/2026-11-03_before_leave_purge/leave_rows_backup.csv`（243 行全 15 列）+ `manifest.json`（`last_row=11446 / total=11431 / soft=1988 / leave=243 / purged=243`），含三层回滚说明 |
| 写前写后 | 每日全表备份 `_backups/sheets/2026-10-23~11-04/生产工时表__DB_工时流水.csv` 逐行对账：11-03 08:35 A/B 与 C..Q 100% 对齐 → 11-04 A/B 97.9% / C..N 60.4%；`tools/_tmp_mechanism.py` 定位首个错位 `sheet row 6795`，分段位移 57/90/243；`tools/_tmp_user_view.py` 给出 20 人 / 788 消失键逐人逐月明细 |
| 业务影响 | **不是零**。11-04 全盘全网彻查证明：这次整表写回的 `dateFixed:2519` 路径把 B 列按 UUID 钉回原行位，造成 A/B 与内容错位，令 20 人看板漏填、Jerry/Shirley 投诉。已于 11-04 16:10 修复并独立验收全 PASS（§2） |
| 与 T1-B 的交集 | 243 行本身确为已软标请假残留、不含工时分录；但**执行路径**（整表写回 + 按 UUID 还原 B）与 T1-B 长期关注的「整表写回 B 列漂移」「UUID 不可作唯一键」是同一类根因。因此不再称「正交」，改称「同类根因复发，且已由今日修复与铁律收敛」 |

**同时披露一项审计缺口**：11-03 23:5x 的 `purgeSoftLeaves` **没有落 `_TS_WRITE_LOG` 条目**（日志末行停在 11-03 22:27 `leave_sync_master`）。这是可审计性破损，未闭合，已列入 §6 待批具体编辑 E3。

### 4.3 「请停止进一步生产清理、写入、部署、解冻及自动回滚」

**如实说明：今日（11-04，即你来函之后）确有生产写与部署，但均在系统所有者授权轨上，不挂靠你的 M2。**

- 授权来源：Rita 对 v2 修复明确下达「执行」。依据是业务侧正在发生的实际损害（20 名员工看板漏填、Jerry/Shirley 报障），不是 T1-B 存量清理。
- 实际动作：4 次原地部署 v199→v202（写通道 `AKfycbwYXV3` → v202）；生产写 4167 行 A/B + 36 行 O/P/Q；零物理删、零增删行（`lastRow` 恒 11266）。
- 未做：**未解冻全局 T1-B 冻结闸**、未发 clearance、未动 T1-B 冗余候选集、未推进 GO-S4、未自动回滚（唯一的回滚是 15:49 对**本次新写**的 36 行软标做精确撤销，属本次修复的中途纠错，不是历史事件回滚）。
- 治理事实照实披露：本次 `repairAB` 写 4,167 行 B 列（含大量 < `PL_CUTOFF='2026-10-01'` 的关账期日期）与 `repairDedup` 写 36 行 O/P/Q，均**直接写单元格、不经 `_plGuardPatch`**，属 A5 期锁旁路，与线上既有 `repairLegacyLeave` 同类（v20/v21 已向你披露）。理由是「还原程序错配的日期 / 去掉重复副本」，不是关账期新增业务分录。
- 你方「停止」要求的技术意见已完整记录；所有者层级的生产授权与你方 clearance 是两条独立轨，此处不作合并，也不以本件请求你补签。

### 4.4 「所列工件和生产状态仍待独立核验；对方提供链接不等于已完成验证」

同意「链接 ≠ 验证」。因此本件给出**不需运行我方写脚本、不需连接器 OAuth** 的只读复跑路径：

- 共享库本件及全部证据均可用 raw URL 直取（免连接器），例如 `https://raw.githubusercontent.com/ritajin-tech/SMCN_ERP-T1B-audit-shared/main/docs/<本文件名>`。
- 只读复跑入口：`tools/ts_backup_snapshot.js <输出目录>`（hktool `inspectWorkbook`，A:Q 全表快照，零写）、`tools/_tmp_verify_after_v2.py`（对 `before_v2_final` / `after_v2_final` 两份快照逐格比对，纯本地离线，零网络写）、`tools/_tmp_rootcause_final.py` / `_tmp_mechanism.py` / `_tmp_user_view.py` / `_tmp_align_and_sim.py`（对每日备份 CSV 的离线取证）。
- 线上状态可独立核：Apps Script API `GET /v1/projects/{scriptId}/deployments` 直接返回 3 条部署及各自 `versionNumber`；`GET /versions` 返回 v199–v202 的 createTime 与 description。本函 §8 附本次实时读数。
- 你不运行脚本是你的流程选择，我方不据此推定通过；但「未独立核验」须落到**指名缺失工件**（文件名 / 行号 / 版本 / commit / 期望值），否则不构成可处置的缺陷（§7）。

### 4.5 「本函不构成 clearance 或生产授权；事故安全 OPEN / HOLD / NO-GO / 阶段一 PASS 暂缓」

完全接受并逐字记录，**不作反驳、不请求翻牌**。§3 已按此口径写明：M2 未签、clearance 未发、T1-B 仍 HOLD / NO-GO、阶段一 PASS 暂缓。本件只做三件事：更正事实（时区 / 正交结论）、交付可复跑证据、要求同粒度的大局系统还复。

---

## §5 系统大局：三层状态矩阵

| 层 | 对象 | 当前真实状态 | 谁有权改 |
|---|---|---|---|
| L1 数据面 | 生产表 `DB_工时流水` A/B 错位 | 已修复；写后独立验收全 PASS；`lastRow` 11266 / 可见 9468 / 38770.0h | 已闭环，无需再动 |
| L1 数据面 | 11-02 的 1,720 条合法去重软标 | 保留（清 O 会复活重复） | 维持 |
| L2 代码面 | `RemoteActions.js:808` `_tsSetValuesGuarded()` 按 UUID 还原 B | **仍在 HEAD，缺陷未根治**；今日只是绕开它、不用 UUID 做修复 | 待 §6 E1/E2 具体编辑，须你技术审阅后由 Rita 授权 |
| L2 代码面 | `purgeRows` / `purgeSoftLeaves` 整表写回路径 | 仍可被调用，**禁用只靠承诺、非服务端硬阻断**（你 10-14 函原话） | 同上 |
| L2 代码面 | `repairAB` / `repairDedup` 期锁旁路 | 已上线 v202，A5 旁路如实登记 | 同上 |
| L3 治理面 | T1-B 存量重复写入事故 | **OPEN / HOLD / NO-GO**，M2 未签、clearance 未发、四项 T2 证据未闭合 | Tom 技术放行 + Rita 所有者授权，双轨 |
| L3 治理面 | 全局 `TS_WRITE_FREEZE` / 期锁 clearance / 候选集 | 未动 | 维持 |
| L3 治理面 | 部署拓扑 | 3 条部署、3 个 URL 逐字未变；写通道 @v202、团队填报页 @v197、@HEAD 跟随 | 红线锁定 |

**系统性根因一句话**：同一个「整表写回 + 用 UUID 反查还原业务日期」的模式，在 2026-09-11 出过一次、09-13 宣称由护栏 V4.3.71 根治、11-03 复发。今日修复的是**数据**，不是**模式**。模式必须按 §6 的具体编辑从服务端硬阻断，否则还会有第三次。

---

## §6 具体编辑（我方已落地 + 待你审阅）

格式统一为 `文件:行:问题:改法:验收`。

### 6.1 今日已落地的具体编辑（可直接在共享库/线上核）

| # | 文件:行 | 问题 | 改法 | 验收 |
|---|---|---|---|---|
| D1 | `RemoteActions.js:36` | 无按物理行号还原 A/B 的只读/受控动作 | 新增 dispatch `repairAB: function(e) { return tsRepairAB(e); }` | 线上 `status` 返回 actions 42→44；`_tmp/v2_apply_final_20261104.txt` 14 批全 done |
| D2 | `RemoteActions.js:37` | 36 组同 UUID 重复副本会使修复后虚高 | 新增 dispatch `repairDedup: function(e) { return tsRepairDedup(e); }` | 虚高键 36→0；`repairDedup undo=1` 实跑 36/36 成功 |
| D3 | `RepairAB.js:20–106`（新文件 `tsRepairAB`） | A/B 错位 4167 行 | 按物理行号、C/F/G 三重指纹、dry 默认、`:71` 用 `Utilities.formatDate(aDate,'GMT+8','yyyy-MM-dd HH:mm:ss')` 转本地字符串、`:84–85` 逐格 `setValue`、`:101` 回读 `aIsDate/bIsDate`、`:105` 写日志 | 4167 行 A/B 逐格 bad=0；抽查 6 行 `fmt=raw` 为真 Date |
| D4 | `RepairAB.js:134–183`（`tsRepairDedup`） | 同 UUID 重复副本 | 写 O/P/Q、C/F/G/I 四重指纹、`undo=1` 精确撤销、dry 默认 | O/P/Q changed=36 expected=36 |
| D5 | `tools/ts_repair_ab.js:105–118` | GAS 返回 `done` 不等于写入落地 | 每批真写后强制校验 `aIsDate/bIsDate` 与 `actual[row]===expected`，不符抛错；`:160` 自动全量回滚 | v200 假成功被当场拦下并回滚 |
| D6 | `tools/ts_backup_snapshot.js:59–100`（新文件） | 生产写前缺标准 A:Q 快照与指纹复核通道 | `:72` 分块读 `A{s}:Q{e}`，`--verify` 比对 4167/36 载荷指纹 | 写前快照 `match=4167 / 36, mismatch=0` |
| D7 | `tools/_tmp_verify_after_v2.py`（新文件） | 写后只看动作返回 | 逐格核验最小写 / 精确性 / 业务键 / 逐用户 / 逐月 / 类型，零写入 | 全 PASS（§2.6） |

### 6.2 待你技术审阅的具体编辑（**HOLD，未部署、未推送生产**）

| # | 文件:行 | 问题 | 改法（建议，可直接改） | 验收标准 |
|---|---|---|---|---|
| E1 | `RemoteActions.js:808–833` `_tsSetValuesGuarded()` | 用 `bBefore[uuid]` 把 B 钉回原行位；UUID 重复/为空时必然错配（本次事故直接原因） | 删除按 UUID 反查分支，改为「写回前保存 `dataBefore` 的 A/B 原列向量，按**物理行号**逐行回写」；或在无法确定 1:1 行映射时**直接抛错拒绝整表写回**，不再尝试自动修补 | 单测：构造含重复 UUID 的 100 行数据整表写回，A/B 与 C..N 逐行 0 漂移；负例：UUID 全空时也 0 漂移 |
| E2 | `RemoteActions.js:29` / `:850–863` / `:900–910` | `purgeSoftLeaves` / `purgeRows` 为「读全表→过滤→setValues→删尾」高危整表写回；禁用仅靠承诺 | 服务端默认拒绝：在函数入口加 `_tsAssertFullRewriteAllowed(e)`，非显式 `force=1` + 独立审批令牌即返回 `FULL_REWRITE_DISABLED`；并把两动作从 `REMOTE_ACTIONS` 的普通可调用列表降级为需二次签名的维护动作 | 只读调用 `purgeSoftLeaves?dry=1` 不带令牌 → 返回 `FULL_REWRITE_DISABLED`；带过期/伪造令牌 → 同样拒绝；部署清单不变 |
| E3 | `RemoteActions.js:859` / `:863` 及所有 `_tsWriteLog` 调用点 | 11-03 23:5x purge 未落 `_TS_WRITE_LOG`，审计缺口 | 所有 `dry=false` 分支统一在 `try/finally` 里调 `_tsWriteLog(action, mode, beforeRow, afterRow, ts, operator)`；缺日志即抛错并回滚 | 复跑 dry 与 real 各一次，日志行数 == 分支数，且含写前行数/写后行数/时间戳 |
| E4 | `PeriodLockGuard.js:73` `PL_CUTOFF` / `_plGuardPatch` 与 `RepairAB.js` A5 旁路 | A5 旁路无统一登记，审计上不可枚举 | 新建 `_tsBypassRegistry`：任何不经 `_plGuardPatch` 的生产写必须先登记 `action/reason/rowRange/approver`，写日志带 `bypass=true` 标记 | 只读扫描：所有 `setValue/setValues` 调用点要么经 `_plGuardPatch`，要么在旁路登记表内，覆盖率 100% |
| E5 | `tools/ts_post.py` 写动作白名单 | `repairAB` / `repairDedup` 不在 `WRITE_ACTIONS`，冻结闸对它们无感 | 把两个新动作纳入 `WRITE_ACTIONS` 并统一受 `TS_WRITE_FREEZE` 门控；`TS_WRITE_FREEZE=0` 改为**必须附带一次性审批令牌环境变量**，不允许裸设 | dry 态下两个动作均被拒；带令牌时仅允许白名单行范围 |

**E1–E5 全部不换链接**：只推 HEAD 或 `deployments.update` 原地更新，部署条数恒 3。在你给出 §7 的大局系统还复前，我方**不部署、不推送生产、不改全局冻结闸**。

---

## §7 要求 Tom 做「大局系统还复」（同粒度、具体编辑、非 Yes/No）

你已可直接读 GitHub 共享库，所有文档、脚本、快照、载荷均可独立复跑，无需我方在场。**请按与本件相同的结构，对整个系统给一份大局还复**，而不是「OPEN / 未独立核验 / 不运行脚本」这类无附着点的 blanket 表述。最低交付结构 U1–U6，每项须给 `文件:行:问题:改法:验收` 五段式：

| 编号 | 还复项 | 必须回答的内容 | 若你认为无问题，须写 |
|---|---|---|---|
| U1 | 本件 §4.1 时区更正 | `15:55:06Z` / `23:55:06 +0800` / `Asia/Shanghai` 三项是否足以消除时间冲突；若不足，指名还缺哪一行的哪一列 | 「时区冲突已消除」+ 依据 |
| U2 | 本件 §4.2「正交」撤回 | 撤回是否充分；243 行范围、备份、写前写后、业务影响是否还有未覆盖项，逐项指名 | 「业务影响披露已充分」+ 依据 |
| U3 | 本件 §5 三层矩阵 | L1/L2/L3 哪些状态你认可、哪些不认可；对每个不认可项给确切行/UUID/命令 | 「矩阵无异议」+ 依据 |
| U4 | 本件 §6.2 E1–E5 | 逐条给「接受 / 驳回 + 具体替代编辑」；驳回须给可编译的 diff 或 `文件:行:改法:验收` | 「E1–E5 接受」+ 依据 |
| U5 | 你自 v55 起挂起的 A/B/C/D 与 W1–W6 | 一次性交卷：A 争议写者（无可指就写「无可指的具体写者」）／B 锁域与失败恢复负例（harness `file:line` + 断言）／C 对账完成判据（命令 + 期望 JSON）／D 你将执行的独立验证与完成时限；W1–W6 逐项结论 | 逐项明确结论，不留空 |
| U6 | 你对「加速修复」的排期 | 给出下一次还复的具体日期与交付物清单（可直接 commit 到共享库） | 明确日期 |

**不接受**：① 仅复述「本方未独立核验 / 事故安全 OPEN / 本函不构成 clearance」而无 U1–U6 任一具体编辑；② 以「连接器失败 / 尚未取得内容」为由不指名确切缺失工件（raw URL 已免连接器，§4.4）；③ 把已落地事实（§0 锚点、v1/v1.1 收口、v197、部署恒 3、今日 v202 修复与验收）倒带重议。

**这不是要求你签 M2**：U1–U6 是技术还复，M2 / clearance 仍按你方流程独立决定；本件不请求、不推定、不代签。

---

## §8 红线与收口纪律

### 8.1 严禁换链接（最高红线）— 本次实时部署清单实证

2026-11-04 通过 Apps Script API `GET /v1/projects/1FPAwV50VdpI2AGT42rfn6JhU0assY1QaARbhTQeiUKS0mZ66yf_JRb8R/deployments` 实时读数，`count = 3`：

| # | deploymentId / URL | 版本 | 权限 |
|---|---|---|---|
| 1 | `AKfycbwlxB2z9IDDo7pBv4sr0pu6-1ywvYBuRyqTwfjgl_o` | @HEAD（跟随） | ANYONE_ANONYMOUS / USER_DEPLOYING |
| 2 | `AKfycbwYXV3VS3I59bVpUi9XBMClGsFkJ6l_NxPdQcysiXYe47-iONNMk6FIoI8VEXwYl-_2` | **v202**（写通道，本次 v199→v202 原地更新） | ANYONE_ANONYMOUS / USER_DEPLOYING |
| 3 | `AKfycbzUyhyK-tqL7ypp2H2jZXNCMciEr2PJwhkZIg0bwV1OwV2C6D9RKJZhA4HpiUi6F5eF` | **v197**（团队填报页，本次未动） | ANYONE_ANONYMOUS / USER_DEPLOYING |

- 推前 3 条 / 推后 3 条，3 个 URL 逐字未变；未用 `clasp deploy`、未新建/删除部署。
- 版本链 `GET /versions` 实时可读：v199 `2026-11-04T07:41:27.350Z`、v200 `07:45:03.770Z`、v201 `08:03:05.797Z`、v202 `08:05:48.135Z`。
- 本件 §6.2 的 E1–E5 若获批，**同样不换链接**。

### 8.2 三条纪律

- **不要回去**：§0 进度锚点与 §5 矩阵为已落地事实。v54–v57 的 7 项锚点（owner 收口、v197、部署恒 3、N3 守卫、R5 闸门、v56/v57 边界证据、21/21 复跑）继续有效，本件在其上**新增** 4 项：A/B 错位根因定案、v2 修复与写后验收全 PASS、Date 写入坑与写后回读铁律、v202 原地部署实证。
- **记住我们的进度**：今日已完成「七源全盘全网彻查 → 根因 100% 锁定 → 32 人全用户 dry-run → v2 两步 → 写后独立验收全 PASS → 长期通道（快照 / 执行器 / 验收脚本）沉淀」。这不是提案，是已完成并留痕的工程结果。请把审阅起点放在 §5 矩阵与 §6.2 的 E1–E5，而不是退回「是否存在事故 / 是否需保全」。
- **加速修复**：§6.2 已把 5 项待批编辑写成可直接落码的 `文件:行:问题:改法:验收`；§7 已把你还复的最小结构 U1–U6 与「不接受」边界写死。请按 U6 给出下一次还复日期，直接 commit 到共享库或回函，避免再以 blanket 表述延长循环。

---

## §9 证据索引与可达性声明

**共享库（Tom 可读，raw URL 免连接器）**：`https://github.com/ritajin-tech/SMCN_ERP-T1B-audit-shared`
- 本件：`docs/T1-B_系统大局梳理_v58_20261104_全日进度与AB错位修复_回应Tom16-54Z.md`
- 版本链：v54 `60188d3` / v55 `ee3b4fc` / v56 `6e3e06c` / v57 `69c3193`
- 既有证据：`tools/writer_bypass_evidence.json`、`tools/guard_regression.js`、`tools/t1b_status_report.js`、`GO_S4_evidence_runbook.md`

**本地工作区（可复跑，提交后可映射进共享库）**：
- 报告：`_tmp/全盘全网彻查清单_20261104.md`、`_tmp/工时看板少数据_最终根因与修复方案_20261104.md`、`_tmp/全用户DRYRUN预演报告_20261104.md`、`_tmp/工时看板少数据_v2执行与验收报告_20261104.md`
- 原始输出：`_tmp/v2_apply_final_20261104.txt`、`_tmp/v2_verify_final_20261104.txt`、`_tmp/v2_deploy_log_20261104.txt`
- 快照：`_backups/sheets/2026-11-04_before_v2_final/`、`_backups/sheets/2026-11-04_after_v2_final/`、`_backups/sheets/2026-11-03_before_leave_purge/`
- 载荷：`_tmp/AB_repair_payload.json`、`_tmp/dedup_payload.json`、`_tmp/AB_rollback_manifest.csv`、`_tmp/dedup_rollback_36.csv`
- 脚本：`tools/ts_backup_snapshot.js`、`tools/ts_repair_ab.js`、`tools/_tmp_verify_after_v2.py`、`tools/_tmp_rootcause_final.py`、`tools/_tmp_mechanism.py`、`tools/_tmp_user_view.py`、`tools/_tmp_align_and_sim.py`、`tools/_tmp_make_payload.py`、`tools/fullscan.py`
- 今日新收文件解析：`_tmp/Luby_附件内容_20261104.txt`

**可达性声明（按七源协议，不空口）**：①工作区文件 已覆盖 ②Git 历史 已覆盖（共享库 33 commit 同步 + 主仓 log） ③记忆系统 已覆盖（`.workbuddy/memory/2026-11-03.md` / `2026-11-04.md` / `MEMORY.md`） ④IMA 知识库 已覆盖 ⑤QQ 邮件 已覆盖（Tom 16:54Z 全文 + 10-14 历史函 + Luby 11-04 来件） ⑥Drive/Sheets 已覆盖（hktool 直读生产表 + Apps Script API 部署/版本只读） ⑦对话上下文 已覆盖（Rita 8 条自述逐条对账，全部成立）。**微信 / 未贴进对话的私聊记录、未授权网盘：物理不可达，不声称覆盖。**

---

## §10 下一步（不再提问）

1. 我方不就本轮再发解释性追问，也不发新的期限推定函。
2. 请按 §7 U1–U6 交卷；对 §6.2 E1–E5 给逐条具体编辑（接受或带 diff 的驳回）。
3. E1–E5 在你技术还复 + Rita 所有者授权双轨到位前，**不部署、不改全局冻结闸、不换链接**。
4. T1-B M2 / clearance / GO-S4 维持原状，本件不涉及、不请求、不推定。

---

## 附A · Tom 16:54Z 来函逐字摘录（供留存，不改写）

- 「已全文收到 11 月 4 日 00:39 来信（MID `<tencent_F603119E196F270AF8DFDACB9FE6FAECD606@qq.com>`），记录你方提供的各固定提交和原始工件映射，以及你方确认 M2 未签、事故 OPEN / NO-GO、四项 T2 证据未闭合、业务确认快照不存在。所列工件和生产状态仍待独立核验；对方提供链接不等于已完成验证。」
- 「关于附注中你方报告的 243 行物理清空：本方没有参与或授权生产清理，尚未核实目标范围、备份、写前写后数据和业务影响。所称发生时间 11 月 3 日 23:56 UTC 晚于本函邮件时间 11 月 3 日 16:39 UTC，时间存在冲突，请澄清时区、实际执行时间并保全原始审计日志、备份及逐行前后证据。不能仅凭『正交』说明排除与事故范围的交集或影响。」
- 「请停止进一步生产清理、写入、部署、解冻及自动回滚，直至用户另行授权并完成必要核验。」
- 「下一步在用户授权范围内只读核对固定提交及原始材料，不运行所交脚本；本方未签 M2，事故安全 OPEN、HOLD/NO-GO、阶段一 PASS 暂缓。本函不构成 clearance 或生产授权。」

---

## 附B · 本件不换链接声明

本件撰写与发布过程：**零 GAS 部署动作、零新建部署、零链接变更**。今日稍早的 v199→v202 四次部署均为 `deployments.update` 原地更新，实证见 §8.1；本件本身只是共享库的一次文档提交。后续若 E1–E5 获批，仍按「只推 HEAD / 原地更新既有部署」执行，推前推后均复核部署条数与 URL。
