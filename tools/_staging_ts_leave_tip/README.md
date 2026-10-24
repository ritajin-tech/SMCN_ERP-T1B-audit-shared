# T1-B 生产表 Step1「填报页请假提示」· 阶段三部署包装（STAGING 评审件）

> 本目录为 **STAGING 评审件**，尚未推生产。评审对象：独立技术审阅者 Tom（1252293966@qq.com）。
> 配套核心 `ts_leave_tip_core.js`（既有、零线上写入、82 例隔离测试 exit 0，本轮未改动）不在此目录，避免重复分发既有核心/人员数据。

## 文件与固定 SHA（本轮第三轮修订 = 新固定 commit，见文末）

| 文件 | SHA-256（大写） | 说明 |
|---|---|---|
| `deploy_wrapper.js` | `562424FC3CFFB74C884DEB066F7CEBF95923315D08011C2C9E32D8FFC4DC1BBD` | 统一受控入口 + 单点解析 + 最小冻结快照 + 响应/日志去敏 |
| `stage4_hash_check.js` | `E1F6A2F8F300D77AEE275128D9DF1B55E8663BF04F25A1BB072506A28A0B7408` | manifest 校验 + 真实 CSV 解析 + 逐记录宽度校验 + 无歧义序列化 |
| `wrapper_negative_tests.js` | `947A266F49D264231003F3FB9A5B6FB477B14276FB88372EC2FEEC790792296C` | 包装负例（29 项，自包含，不依赖核心） |
| `stage4_tests.js` | `220884ECF02A65A12BEE43A6EF3EACB49A810C6EA6F6E910FD909B9A57B9D1DA` | 阶段四单元+集成（35 项） |

## 设计目标（不变）

1. **一键关闭开关** `FEATURE_ENABLED` 默认 `false`（fail-safe）；上线须所有者 Rita 显式授权 + 写权限，且部署在脆弱实时填报页前先 `gas_pull` 真实 HEAD 核身份/集成/开关。
2. **复用已验证核心** `ts_leave_tip_core.js`（同步纯函数，零线上写入）。
3. **受控时钟注入**：`now` 必须经入参，禁止读系统时间。
4. **主体仅来自模块级 `TRUSTED_RESOLVER`**（服务端一次性注入可信 session）；任何客户端 `identityResolver/employeeId/who` 一律忽略（结构上杜绝自报身份）。

## 安全性收敛（逐轮已修）

- 两入口（`getLeaveTipSafe` / `handleRequestSafe`）统一经 `enterControlled()`，白名单构造核心入参，不复制客户端身份参数。
- 主体**只解析一次**并固化为 `Object.freeze({employeeId})` 最小快照供核心（杜绝双解析 + 可变引用）。
- `employeeId` 收紧为**非空 trim 字符串**（空白串/数组/对象/数字均拒）。
- 对外响应 `status` 限定**白名单枚举**，未知态降级 `FETCH_FAILED`；`tip` 为授权用户可见业务内容，非诊断。
- **日志仅输出固定诊断码**（`ERR_LOAD/ERR_RESOLVER/ERR_ASYNC/ERR_ENTRY/ERR_PRIVACY`），绝不拼接原始异常 message / 内部状态 / 行数据。
- 依赖加载改**可注入 loader**：真实 `require` 失败由 `try/catch` 真正捕获（`ERR_LOAD` 固定码），默认关开关下两入口**不触发加载**。

## 阶段四哈希复核（诚实范围）

- 工具**仅**验证两个指定证据 CSV（`before`/`after`）的：① 非目标区域字节稳定（逐记录宽度校验 + JSON 无歧义序列化）；② `dataWrite=false` 时数据文件逐字节一致。
- `manifest` 强制必填：`frozenVersion` / `table` / `capturedAt`(ISO-8601) / `nonTargetColumns`(合法+唯一) / `authorizedTarget.dataWrite===false` / `before/afterSha256`(64 位 hex) 绑定证据文件。
- **不验证数据来源(provenance)**，不承载"覆盖全部非目标 / 现场完整性"门槛——provenance 须由部署期所有者受控采集步骤另行保证。此限制已在 `SCOPE` 常量中声明（测试可核验）。
- `parseCsv` 拒绝畸形（未闭合引号 / 字段中引号 / 闭合后非法字符），畸形即 fail-close。

## 测试（提交方本地 `node` 实跑，非仅声明）

- `node wrapper_negative_tests.js` → **29/29 exit 0**（不依赖核心，覆盖开关关不加载/真实加载失败/身份恶意值/双入口/日志脱敏/异常不外泄/客户端自报身份被忽略）。
- `node stage4_tests.js` → **35/35 exit 0**（覆盖 colToIndex 多字母 / CSV 引号+畸形拒绝 / AA 第27列真实提取 / manifest 反例 / 全链路 PASS 与 FAIL-CLOSE）。
- 核心 82 例隔离测试（`ts_leave_tip_core.js`）本轮**未改动**，状态保持 exit 0。

## 诚实分层——以下仍属部署期验证、本轮未关闭

- 真实 GAS 身份：`TRUSTED_RESOLVER` 须由服务端（GAS `Session.getActiveUser()`）一次性注入；本件仅保证结构上只信任模块级解析器、忽略客户端 `identityResolver`。
- 会话信任边界：模块级函数不证明传入 session 可信——须真实 GAS 运行环境（HTTPS + 已认证会话）集成验证。
- UI 内联产物 / 集成 / 性能 / 恢复：UI 改动即部署变更；上线序列须 `gas_pull` 真实 HEAD diff + 身份核实 + 一键关闭开关 + 阶段四哈希 + 灰度，并由所有者 Rita 显式授权。

## 状态

- **A 仍待 Tom 技术 clearance**；B 不追认、C 仅登记、D/E/F 及阶段一 PASS 暂缓、106 HOLD、历史 23 行 / D241 / 事故安全 OPEN 维持。
- 全程零生产操作、零新增授权；邮件中的 owner/批准声明不替代 Tom 的验收或有权人的独立生产授权。
- 不重发既有核心或人员数据（Tom 明示）。

## 修订历史

- `7da3ea7`（3 代码件）+ `e9bff81`（README 补推）：首推实物代码 + 完整 SHA。
- `7ad8862`：v3 二次修复（回应 Tom 11:58 六点）。
- **本轮新固定 commit**：v4 三次修复（回应 Tom 12:27 六点）——见 `docs/T1B_A包装三次修复_20261024.md`。完整 SHA 见上表。
