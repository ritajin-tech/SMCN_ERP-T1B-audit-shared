# T1-B 离线受控审计生成器（ts_controlled_audit_offline.js）契约与证据

> 本文件是 Tom 🅐 点①所要求的"固定审阅提交 + 非员工原始数据证据/契约"：说明输入快照身份、
> 规范化/分组规则、分类边界、失败关闭条件。**不含任何员工姓名或生产原始行**，仅含伪名化 UUID 与聚合数。

## 1. 工具身份与边界
- 工具：`tools/ts_controlled_audit_offline.js`（Node，零 hktool / 零网络 / 零生产写）。
- 它**只读**两个本地文件（经 `--prod` / `--base` 传入），**不**连接生产表、不调用任何写端点、
  不软标任何行；仅把"候选软标集"派生为执行器兼容 JSON 写到本地 `--out` 目录。
- 本工具**不含密钥**：KEY 来自本地 `.hktool_remote.json`（不进审阅仓）；离线模式下根本不需要 KEY。
- 分类逻辑抽为纯函数 `classifyGroup`（已单测 `ts_controlled_audit_offline.test.js`，13/13 PASS），
  执行器侧直接复用同一实现，杜绝"两份口径"。

## 2. 输入快照身份（明文，供独立核验）
| 输入 | 身份 | 备注 |
|------|------|------|
| prodScan | 生产表 `DB_工时流水`（ssId `1Pi5u9fE`） | 13:50 快照：lastRow=11330，dataRows=11316，distinctUuid=4330 |
| base | 主库底稿 `工时_候选0824` / `主库T1B__工时.csv`（ssId `1oxPj0mz`） | UUID 列索引 8（`⚙ 唯一码 (UUID)`） |
| 候选白名单 | `candidate_dedupe_LIVE_20261026_pseudonym_v2.csv` | 伪名化（列含 `pseudonym` 如 P0015，**无员工姓名**）；已剔除 2 异常 UUID |

## 3. 规范化与分组规则（单一可信源 `ts_softdel_norm`）
- `_sdNorm(cells)`：单元格规范化（空值/trim/日期 ISO 等）。
- `_sdRowHash(cells, timeOnly)`：每行列 0..13 的 SHA-256，**与服务端 `ts_softdel_core` 一致**；
  `baseHash` 仅当底稿恰 1 行（**hasBase=true**）时按 `timeOnly=false` 计算；
  **bc==0 时显式 `hasBase=false` + `baseHash='NO_BASE'`，绝不伪造**（回应 Tom A点①：不得用 keeper 指纹冒充底稿哈希，
  交由服务端按"底稿须 0 行"核验）；`target`/`keeper` 哈希按本组 `timeOnly` 标志。
- 分组（按 UUID 聚组后）：组内副本 col0..13 全同 → **exact**；仅 col0(录入时间) 差 → **timeonly**；
  col1..13 任一差 → **mixed**（UNSAFE）。

## 4. 分类边界与失败关闭条件（`classifyGroup`，已单测 13/13）
| 底稿行数 bc | 组内类型 | 归类 | 处置 |
|-----------|---------|------|------|
| bc==1 | exact | `safeExactA`（A 级） | 自动软标候选 |
| bc==1 | timeonly | `safeTimeOnlyA`（A 级） | 自动软标候选（须 `--allow-time-only`） |
| bc==0 | exact | `notInBase`（B 级） | 待人工裁定（底稿须 0 行） |
| bc==0 | timeonly | `timeonlyB`（B 级） | 待**另行授权**（不自动） |
| — | mixed（payload 不一致） | `unsafe` / `PAYLOAD_DIFF` | **剔除，绝不动** |
| — | bc>=2（底稿歧义） | `unsafe` / `BASE_NOT_UNIQUE` | **剔除，绝不动** |
| — | 组内任一副本 O=TRUE | `alreadyHandled` | 历史已正确终态，**排除**不纳入 |
| — | entries<2 或表头键 | `null` | 跳过 |

执行器侧**附加运行时守卫**（非本离线工具，运行时才生效）：CAS 逐行 SHA-256 不变性、
期锁（已锁账期须 `--clearance`，否则 fail-closed）、软标仅置 O 列 `TRUE`（**不物理删**）。

## 5. 13:50 实测聚合（提交方报告；待 Tom 在自有隔离环境复现核验）
| 桶 | 组数 |
|----|------|
| A 级自动候选：safeExactA | **1225** |
| A 级自动候选：safeTimeOnlyA | **225** |
| B 级待裁定：notInBase | **115** |
| B 级待授权：timeonlyB | **2**（TS-669D9086A3FF、TS-CBB5F7A8A965，待另授权） |
| 剔除 UNSAFE | **0** |
| 已处理排除 alreadyHandled | **211** |

- 受控自动软标候选 = 1225 + 225 = **1450 组**；B 级待裁定/授权 = 115 + 2 = **117 组**；UNSAFE=0、mixed-load=0。
- 工时汇总在执行器侧（本离线工具不汇总数）；明细见 `evidence/controlled_audit_summary_*.json`、`controlled_audit_phase1_exactA_*.json` 等（均为伪名化 UUID，无姓名）。

## 6. PII / 零生产写声明
- 本工具与契约**不载任何员工姓名或生产原始行**；UUID 为系统唯一码（伪名化），非个人身份。
- 本工具**零生产写**：只读本地快照，不触生产表、不软标；软标动作仅由执行器在获授权后、经 CAS+期锁守卫执行。

## 7. 关联（🅐 点②读取守卫）
live reader（`ts_controlled_audit.js`）的 `revision` 缺失退化问题已由 `ts_controlled_readguard`（内容指纹
SHA-256 + `revision` 缺失时 fail-closed）修复，见 `ts_controlled_readguard_test.js` 的"同 lastRow 内容变化"
负例证据。

## 8. 本轮（U 批）对 A点①② 的再加固（回应 Tom 2026-10-29 08:27Z 代码级复核）
- **A点② 拼接碰撞已消除**：`contentFingerprint` 由 `行号:单元格|单元格\n` 拼接改为 **JSON 结构化编码**
  （`JSON.stringify([row, [cells]])`），`['a|b','c']` 与 `['a','b|c']` 不再产生同一串；并新增拼接碰撞回归测试。
  同时 `verifyReadGuard` 对 **revision 单侧缺失** 改为 `REVISION_INCONSISTENT` fail-closed（不再放行），测试覆盖。
- **A点① 不再伪造 baseHash**：`classifyGroup` 在 `bc==0` 时显式 `hasBase=false` + `baseHash='NO_BASE'`；
  新增单测断言（15/15）。
- **S2 零执行彻底化**：`_repro_r_static_scan.py` 已**移除**任何 `--exec`/exec() 执行仓库函数路径；
  AST 白名单收紧——直接调用剔除 `getattr`/`hasattr`，并拒绝一切 `(f())()` 动态调用形式与危险基准名属性调用
  （验证器对 `getattr(os,'system')`、`os.system`、`(f())()` 均报违规，对合法目标通过）。
- **S3 后置快照全覆盖**：`ts_repro_isolation_runner.py` 移除绕过开关，后置原树 SHA-256 快照在**所有退出路径**
  （含生成器非零返回）执行，杜绝"非零 return 跳过后置快照"。
