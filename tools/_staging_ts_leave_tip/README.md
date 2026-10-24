# T1-B 生产表 Step1 · 填报页请假提示 · 阶段三部署包装（STAGING 评审件）

**用途**：这是 T1-B 收口「生产表请假提示功能」上线的**安全部署包装 + 阶段四切换复核脚本**，纯评审件，未推生产。

**提交方**：Rita / SMCN 团队 ｜ **日期**：2026-10-24 ｜ **版本**：v3（二次修订，回应 Tom 11:58 复核函六点阻塞）

---

## 1. 文件与 SHA-256（提交方本地 `node` 实跑生成，你可重算核对）

| 文件 | SHA-256（大写） |
|---|---|
| `tools/_staging_ts_leave_tip/deploy_wrapper.js` | `54F7FE8668A9EE3481AB825DCEF4AF9E119F3F493D7FB0033DF0F3E068F3B96B` |
| `tools/_staging_ts_leave_tip/stage4_hash_check.js` | `96F7B341AE97F9D09B7A8AE5A1AEF6501BF2285827F7D8E75053ED6E5FB0D50E` |
| `tools/_staging_ts_leave_tip/wrapper_negative_tests.js` | `C20FF092AB99046AB8E3DC383CEB13B4ABA8A085FC6BB3A9BBEDC9CD60FF2302` |
| `tools/_staging_ts_leave_tip/stage4_tests.js`（新增） | `AFC203D3D4CE1C66ACC775D40F5B18177342D9280FB6247F847DDCD7C705D0CF` |
| `docs/T1B_A包装二次修复_20261024.md`（逐点修复对照） | `6DE070FF5D7C5A82D794074A2D071414DAA056D8B3E68BB729802B534A62D875` |

重算命令（任意装了 Node 的环境）：
```bash
node -e "const c=require('crypto'),f=process.argv[1];console.log(c.createHash('sha256').update(require('fs').readFileSync(f)).digest('hex').toUpperCase(),f)" <file>
```

---

## 2. 依赖说明（重要）

- `deploy_wrapper.js` 运行时 `require('../ts_leave_tip_core.js')` —— 该核心为**既有已交付件**（提交方 82 例隔离测试全绿 exit 0，属 v2p7 时代已验证逻辑，**未在本仓重发**，遵循 Tom「不要重送既有核心」的指示）。
- 本仓布局约定：`tools/ts_leave_tip_core.js`（既有核心，提交方环境已有）+ `tools/_staging_ts_leave_tip/deploy_wrapper.js`（本包装）。
- **负例测试 `wrapper_negative_tests.js` 与 `stage4_tests.js` 均为自包含设计**：不依赖既有核心，全部用注入 mock 模拟核心 OK/异常，因此你**无需取核心即可复现 19/19 + 26/26**。
- Tom 上一轮（7da3ea7 + e9bff81）SHA 完整性已由其全文静态复核确认一致，本 v3 为在其实质反馈上的二次修订。

---

## 3. 如何运行测试（自包含，零外部依赖）

```bash
cd tools/_staging_ts_leave_tip
node wrapper_negative_tests.js      # 期望输出：结果: 19 通过 / 0 失败，exit 0
node stage4_tests.js               # 期望输出：结果: 26 通过 / 0 失败，exit 0
# stage4 全链路演示（需自建 manifest + before/after.csv，见 stage4_tests.js 同款结构）：
node stage4_hash_check.js --manifest <manifest.json> --before <before.csv> --after <after.csv>
```

---

## 4. v3 对 Tom 复核函六点阻塞的落点（详见 `docs/T1B_A包装二次修复_20261024.md`）

| Tom 验证点（11:58 复核函） | v3 落点（文件:函数/逻辑） |
|---|---|
| ① 两入口经相同安全路径；自报身份结构上杜绝 | `deploy_wrapper.js`：`enterControlled()` 统一入口，两入口共用；白名单构造 coreOpts，**不复制**客户端 `identityResolver/employeeId/who`；核心只收 `frozenResolver` |
| ② 主体只解析一次 + 校验 employeeId 非空 + 异常不外逃 | `resolvePrincipal()` 显式校验 `employeeId` 非空；`frozenResolver=()=>principal` 固化给核心（杜绝双解析不一致）；整段受控处理包在单一 try，resolver 抛错→PRIVACY_BLOCKED |
| ③ 对外响应只含固定码，无原始异常/内部 status | `availabilityFallback()`/`privacyBlocked()` 不含原始异常文本或内部 status；诊断仅经 `_log` 落受控日志 |
| ④ manifest 必填校验 + 强制 dataWrite=false + 空投影 fail-close | `validateManifest()` 强制 frozenVersion/table/capturedAt 非空、nonTargetColumns 合法唯一、dataWrite===false、before/after SHA 绑定；空投影判失败关闭 |
| ⑤ 真实 CSV 解析（引号内逗号/换行）+ 多字母列(AA) + 列边界校验 | `parseCsv()` RFC4180 风格；`colToIndex()` 支持 AA/AB 并拒绝非法字符；列索引<文件列数校验 |
| ⑥ 开关关不读不解析(抛错 getter 验证)/真实加载失败/身份断言/handleRequestSafe 覆盖/计数统一 | 负例 19 项含 OFF 抛错 getter、真实加载失败、`assert` 显式校验 TRUSTED 解析器与无他人行、handleRequestSafe 覆盖；新增 `stage4_tests.js` 26 项覆盖 Pt4/5 反例与全链路 |

---

## 5. 边界（提交方登记，诚实分层）

- **读**：`session.loginUser`→唯一 `employeeId`；`fillDate`；`mirror`（只读本人请假镜像）；`now`（受控时钟）。
- **写**：**无**——仅 UI 展示，不写任何工时/薪酬/主数据列。
- **消费者**：仅 TimeSheet 正式填报页（生产表）调用 `getLeaveTipSafe`；`handleRequestSafe` 为同路径预留入口。
- **授权写集**：`kind:code-module-addition`，`module:ts_leave_tip`，`dataWrite:false`（仅改 UI 代码）。
- **恢复**：恢复部署前快照 + 翻转 `FEATURE_ENABLED=false`；须所有者显式授权 + 写权限。

### 仍属部署期验证、本轮未关闭（ Tom 复核函末段指明，确认保留为门槛）
- **真实 GAS 身份**：`TRUSTED_RESOLVER` 须由服务端（GAS `Session.getActiveUser()`）一次性注入；本件仅保证结构上只信任模块级解析器、忽略客户端 `identityResolver`。
- **会话信任边界**：模块级函数不证明传入 session 可信——须真实 GAS 运行环境（HTTPS + 已认证会话）集成验证。
- **内联产物 / 集成 / 性能 / 恢复**：UI 改动即部署变更；上线序列须 `gas_pull` 真实 HEAD diff + 身份核实 + 一键关闭开关 + 阶段四哈希 + 灰度，并由所有者 Rita 显式授权。

---

## 6. 状态

- A 包装 v3：提交方本地实跑 **19/19 负例 + 26/26 stage4** 全绿（exit 0），核心 82 例未改动仍 exit 0；**未推生产**；A clearance 仍待 Tom 复核。
- B/C/D/E/F 维持各自 OPEN/HOLD（见往来邮件）。
- 零生产操作、零新增授权，直至所有者明确批准且 Tom 技术风险 clearance。
