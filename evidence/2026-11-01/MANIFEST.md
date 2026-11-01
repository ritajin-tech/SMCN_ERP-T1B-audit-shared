# T1-B 全量核验包 · MANIFEST（2026-11-01）

> 本目录为回应 Tom 2026-11-01T08:52:19Z 来信（msg_YvCAVh16…）所要求的「全量映射 + 源快照 + base + EXACT 明细 + 各文件摘要/版本/哈希算法/字段口径」交付物。
> 所有文件静态提供，不运行、不修改任何生产数据。SHA-256/SHA-1 由本机 `sha256sum`/`sha1sum` 实算。

## 0. 包级元数据（溯源绑定）

| 项 | 值 |
|---|---|
| 源表 ssId | `1Pi5u9fEawgp7yICWPMMyQCT_LbwTZthQDW-H05xYdVI`（生产表 `DB_工时流水`） |
| 源快照扫描时刻 | `2026-11-01-14-56-27`（BJT，live 只读拉取） |
| 源快照行数 / UUID 组 | 11,366 行 / 4,380 组 |
| 候选↔保留映射生成时刻 | `2026-11-01-14-57-30` |
| 映射总候选行 | **1,340**（SAFE 866 + NOT_IN_BASE 474） |
| 同值证明 | 1,340 / 1,340 行 `targetHash == keeperHash` |

## 1. 文件清单（摘要 / 版本 / 体积）

| 文件 | SHA-256 | SHA-1 | 字节 |
|---|---|---|---|
| `T1-B_候选保留映射_可核查_2026-11-01.csv` | `d517d4d86ebc9179ebca04da31225aba084126cae3e57a9fc090bd3b372d07f6` | `b85a6848b12bf7116d576ee6b81ab946d40854fa` | 321,815 |
| `prod_scan_LIVE_2026-11-01-14-56-27.json` | `bc10d2ddf780987ae3429e18cc80417ef257ccb06a0c36f6458811466d554dbc` | `d98bc8fdcd27cc29ab64b050b5774f763044c300` | 1,841,281 |
| `base_候选0824_LIVE_2026-11-01-14-57-15.csv` | `51bc7a6535f97ceee32381649a01e0697a9bea05fbdf34b0d6edcc7624c85c0b` | `ebadb4447f66dfe42a455037b124973453f0207c` | 1,317,748 |
| `controlled_audit_EXACT_ALL_2026-11-01.json` | `586a12b3b350de23256202d33a8691a71a0a6e9d491727d25218dc0b6de172cf` | `4275bbc5baf611a46ca813c3398dd5ed30e4572a` | 684,196 |
| `build_mapping.js` | `e5c13d2878468853aaad15d21d7daaba921d62806d9a35d4d2e25b28e9366cc8` | `86674d3b579e582776a70ce17766ae0f29cdb635` | 2,079 |
| `verify_mapping.js` | *(本目录同次提交生成)* | — | — |
| `fix_T1-B_concurrency_window.md` | *(本目录同次提交生成)* | — | — |

> 收到后请先逐文件核摘要再静态核验，不运行任何附件/脚本（除非你方主动选择运行 `verify_mapping.js`，其为自包含只读校验，仅读取上述文件并输出 PASS/FAIL 报告）。

## 2. 哈希算法与字段口径（Tom 08:52 明示要求）

**单一可信源**：`tools/ts_softdel_norm.js` 的 `_sdRowHash`（GAS `RemoteActions` 内联副本由 `v4_genpatches` 同文生成，逐字一致）。

**函数链**：
1. `_sdHashCols(timeOnly)` → 纳入指纹的列（1-based 表列 A..O = 索引 0..14）：
   - 固定：`列1`（业务日期，显式时区 ISO +08:00）、`列2..13`（负载）、`列14`（审计列 O，保全原审计版本）。
   - 仅当 `timeOnly === false`：追加 `列0`（录入时间）。
2. `_sdCellTok(v)` → 类型保全 token（**绝不把数字串 coercion 成数字**，前导零 ID/工号 `"007"` 保留为 `['str','007']`）：
   - `null/undefined` → `['null']`；`number` → `['num', String(v)]`；`boolean` → `['bool','true'/'false']`；`Date` → `['date', _sdIsoTz(v)]`；`string` → `['str', 原值]`。
3. `_sdCanonRow(cells, cols)` → `JSON.stringify(cols.map(c => _sdCellTok(cells[c])))`（定长 JSON 数组，自带转义，避免裸分隔符碰撞）。
4. `_sdSha256(s)` → `sha256:` + `crypto.createHash('sha256').update(s,'utf8').digest('hex')`（Node）/ `Utilities.computeDigest(SHA_256,...)`（GAS），小写 hex。
5. `_sdRowHash(cells, timeOnly)` = `_sdSha256(_sdCanonRow(cells, _sdHashCols(timeOnly)))`。

**三个哈希的语义**：
- `targetHash` = 候选行 cells 的 `_sdRowHash`。
- `keeperHash` = 保留（权威）行 cells 的 `_sdRowHash`。
- `targetHash == keeperHash` ⇒ 两行**业务字段逐列一致** ⇒ 候选可判定为保留行的冗余副本（软标候选、保留权威行）。
- `baseHash` = 底稿（`base_候选0824`）中该 UUID 恰 1 行时其 cells 的 `_sdRowHash`；底稿 0 行时显式记 `NO_BASE`（**绝不伪造**，交由服务端按「底稿须 0 行」核验）。

> 注：`timeOnly` 标志由审计工具按组判定。复核时若不确定标志，可对 `true`/`false` 两态各算一次，任一命中即证明可复现。`verify_mapping.js` 已内置「双态尝试验证」。

## 3. 候选保留映射 CSV 字段口径

表头（逐列）：`类别,UUID,base计数,候选行(row),保留对象行(keeperRow),targetHash,keeperHash,哈希一致(同值),hasBase,baseHash`

| 列 | 含义 |
|---|---|
| 类别 | `SAFE`（有底稿佐证）/ `NOT_IN_BASE`（保留行 live-only，无 0824 底稿） |
| UUID | 该冗余组的唯一码 |
| base计数 | 底稿中该 UUID 行数 |
| 候选行(row) | 拟软标的冗余行（生产表 sheet 行号） |
| 保留对象行(keeperRow) | 保留为权威、其余行对齐的权威行（生产表 sheet 行号） |
| targetHash | 候选行指纹 |
| keeperHash | 保留行指纹 |
| 哈希一致(同值) | `targetHash == keeperHash`（全 1,340 行应为 TRUE） |
| hasBase | 是否恰有 1 行底稿 |
| baseHash | 底稿行指纹（`hasBase=false` 时为 `NO_BASE`） |

## 4. 三级核验路径（供 Tom 独立复算）

- **L1 表内一致性（已做）**：CSV 1,340 行，SAFE 866 / NOT_IN_BASE 474，`targetHash == keeperHash` 逐行 TRUE。Tom 08:52 已自行复算确认数量一致。
- **L2 审计 JSON 一致性（交付物支持）**：`controlled_audit_EXACT_ALL_2026-11-01.json` 的 `detail.safe[].targets[]` 与 `detail.notInBase[].targets[]` 逐条含 `targetHash/keeperHash/hasBase/baseHash`，可直接与 CSV 互核。
- **L3 源快照重算（交付物支持）**：`prod_scan_LIVE_...json` 的 `byUuid[uuid] = [{row, cells[15], soft}]` 含每行原始 15 列；`verify_mapping.js` 据此用第 2 节算法重算 `_sdRowHash`，与审计 JSON 记录的 `targetHash/keeperHash` 比对，证明哈希确实源自源快照而非凭空声明。

## 5. 覆盖边界（诚实标注，非缺口）

- 866 个 SAFE 组含 `baseHash`（底稿佐证）。
- 474 个 NOT_IN_BASE 组 `hasBase=false` / `baseHash=NO_BASE`：保留行 live-only、无 0824 底稿 → **按原状保留、不删**，待 Rita 最终裁定，不视为「已核验可清」。
- 空 UUID 池（5,221 行 / 22,657h，占 47%）一律 `UNKNOWN` 保留原状，不进入本映射。

## 6. 与既有交付物的关系

- 本目录交付物 = v12 邮件（msg_pc4BwqM… / msg_B2VzF6…，2026-11-01T08:37–08:38Z）所承诺的「全量映射 + 源快照 + base + EXACT 明细 + 摘要/版本/哈希算法/字段口径」一次性齐备包。
- 系统大局梳理主文见 `../docs/T1-B_系统大局梳理_v13_回应Tom08-52_全量核验包_20261101.md`。
- 根因修复具体编辑见同目录 `fix_T1-B_concurrency_window.md`（file:line，非 Yes/No）。
