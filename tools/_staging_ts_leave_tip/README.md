# T1-B 生产表 Step1 · 填报页请假提示 · 阶段三部署包装（STAGING 评审件）

**用途**：这是 T1-B 收口「生产表请假提示功能」上线的**安全部署包装 + 阶段四切换复核脚本**，纯评审件，未推生产。

**提交方**：Rita / SMCN 团队 ｜ **日期**：2026-10-24 ｜ **回应对象**：Tom 2026-10-24 阻塞函（Sent228, 10:26）的五项技术阻塞 + 后续「请给固定 commit/path/完整 SHA」要求。

---

## 1. 文件与 SHA-256（提交方计算，你可重算核对）

| 文件 | SHA-256（大写） |
|---|---|
| `tools/_staging_ts_leave_tip/deploy_wrapper.js` | `94EA7DF8E7711D69DF4E3AF5B2394FF6F30C132F0D2FC0964828345AD691FF3F` |
| `tools/_staging_ts_leave_tip/stage4_hash_check.js` | `82597862CF670338E763A7165CC3B8519E91E40A52BD9A0202BC2EADACAB7930` |
| `tools/_staging_ts_leave_tip/wrapper_negative_tests.js` | `B624CFDCF886C1740A29ADCAB69693E4CA8C4F4D1265636C31AA0BB80E79E05C` |
| `docs/T1B_A包装技术阻塞修复_20261024.md`（修复对照说明） | `7529F56DB33323D23E8597A73CFA16C12FCA8306837E1D4A486A7DA1DB164BB2` |

重算命令（任意装了 Node 的环境）：
```bash
node -e "const c=require('crypto'),f=process.argv[1];console.log(c.createHash('sha256').update(require('fs').readFileSync(f)).digest('hex').toUpperCase(),f)" <file>
```

---

## 2. 依赖说明（重要）

- `deploy_wrapper.js` 运行时 `require('../ts_leave_tip_core.js')` —— 该核心为**既有已交付件**（提交方 82 例隔离测试全绿 exit 0，属 v2p7 时代已验证逻辑，**未在本仓重发**，遵循 Tom「不要重送既有核心」的指示）。
- 本仓布局约定：`tools/ts_leave_tip_core.js`（既有核心，提交方环境已有）+ `tools/_staging_ts_leave_tip/deploy_wrapper.js`（本包装）。
- **负例测试 `wrapper_negative_tests.js` 为自包含设计**：不依赖既有核心，全部用注入 mock 模拟核心 OK/异常，因此你**无需取核心即可复现 13/13**。

---

## 3. 如何运行测试（自包含，零外部依赖）

```bash
cd tools/_staging_ts_leave_tip
node wrapper_negative_tests.js      # 期望输出：结果: 13 通过 / 0 失败，exit 0
node stage4_hash_check.js --manifest <manifest.json> --before <before.csv> --after <after.csv>   # 见文件头示例
```

---

## 4. 对 Tom 验证点的逐条落点

| Tom 验证点（10:26 阻塞函 + 10:56 复核函） | 落点（文件:行/逻辑） |
|---|---|
| ① 两入口经相同安全路径；Promise/thenable 拒绝与加载异常均兜底 | `deploy_wrapper.js`：`settle()` 统一兜底异步 reject；`getLeaveTipSafe`/`handleRequestSafe` 均 try/catch；`loadCore()` 惰性加载、缺失不致命（Block2） |
| ② 主体来自可信会话而非客户端自报 employeeId；响应与日志最小化 | `deploy_wrapper.js`：`TRUSTED_RESOLVER` 模块级单点注入（服务端一次性设），`bindPrincipal` 仅用模块级解析器；`getLeaveTipSafe` 白名单构造 coreOpts，**显式剔除** opts 中任何 `identityResolver/employeeId/who`；`wrapResponse` 剥离 `who`/镜像原始对象；全程无 PII 日志 |
| ③ 过滤在读取边界生效且不先泄露整镜像 | `deploy_wrapper.js`：`bindPrincipal` 在调用核心【前】即把镜像行级过滤到仅本人（`filteredMirror`），核心只收到本人子集 |
| ④ now=0 明确透传 | `deploy_wrapper.js`：`const now = (opts.now !== undefined) ? opts.now : undefined;`（`!== undefined`，非 `!!now`） |
| ⑤ 哈希绑定范围、授权目标写集与非目标完整覆盖；恢复只作经授权方案不自动回滚 | `stage4_hash_check.js`：manifest 绑定 `frozenVersion/table/capturedAt/nonTargetColumns`；`verifyWriteSet`（`dataWrite=false` → 数据文件逐字节一致断言）；`planRollback` 仅返回指令、不自动执行（须所有者显式授权+写权限） |
| ⑥ 不因「只 UI」视作无部署变更；不以关开关替代完整恢复验证 | 已在 `docs/T1B_A包装技术阻塞修复_20261024.md` 与 `stage4_hash_check.js` 头注释明示：本件仅改 UI 提示代码（`dataWrite=false`），身份核实/真实 GAS 内联产物/集成/性能仍须由所有者授权后 gas_pull 真实 HEAD diff 另行验证 |

---

## 5. 边界（提交方登记，待 Tom 复核）

- **读**：`session.loginUser`→唯一 `employeeId`；`fillDate`；`mirror`（只读本人请假镜像）；`now`（受控时钟）。
- **写**：**无**——仅 UI 展示，不写任何工时/薪酬/主数据列。
- **消费者**：仅 TimeSheet 正式填报页（生产表）调用 `getLeaveTipSafe`；无其他消费者/后台批量。
- **授权写集**：`kind:code-module-addition`，`module:ts_leave_tip`，`dataWrite:false`（仅改 UI 代码）。
- **恢复**：恢复部署前快照 + 翻转 `FEATURE_ENABLED=false`；须所有者显式授权 + 写权限。

---

## 6. 状态

- A 包装：提交方自跑 13/13 负例 + 核心 82 例仍 exit 0；**未推生产**；A clearance 仍待 Tom 复核。
- B/C/D/E/F 维持各自 OPEN/HOLD（见往来邮件）。
- 零生产操作、零新增授权，直至所有者明确批准且 Tom 技术风险 clearance。
