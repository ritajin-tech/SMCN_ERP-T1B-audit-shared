# 阶段三 上线 Dry-Run 推演清单（请假提示 ts_leave_tip → 生产表）

> **用途**：本文档是「待 Tom 技术 clearance + Rita 所有者显式授权」后，方可逐步执行的上线推演稿。
> **当前状态（2026-10-24 13:1x）**：仅草稿，尚未触发。v4 代码已就绪（commit `1f0ae990c5336d1cc7ce80547ab5a89185a2c8e7`，负例 29/29、stage4 35/35 提交方本地 exit 0）。**任何一步未过闸门 → 停摆，不发任何生产写操作。**
> **铁律**：零生产操作、零新增授权；邮件/owner 声明不替代 Tom 验收或 Rita 独立生产授权。

---

## 0. 双独立授权闸门（两关都过才进阶段 1）

| Gate | 来源 | 形式 | 未过动作 |
|------|------|------|----------|
| **Gate A** | Tom 技术 clearance | 邮件确认 A 放行（非 HOLD/OPEN） | 停摆，回 Tom 复核 |
| **Gate B** | Rita 所有者显式生产授权 | 口头/邮件「授权上线」+ 时间戳 | 停摆，不推 |

- [ ] **Gate A**：确认收到 Tom 关于 `1f0ae99` 的 clearance 邮件，A 状态 = 放行。
- [ ] **Gate B**：确认收到 Rita 显式授权（记录 YYYY-MM-DD HH:MM），独立于 Tom。
- [ ] **影响面复核**：Tom 仍 OPEN/HOLD 的 B/C/D/E/F、106 HOLD、历史 23 行 / D241 / 事故安全 OPEN——若任一被 Tom 标注「阻断本上线」则停摆。

---

## 1. 拉取真实 HEAD + 身份核验（绝不盲推）

> 生产表是脆弱实时系统（每日有人填），上线前必拉线上 HEAD 核身份/集成/开关，先 gas_pull 后改。

**目标脚本（生产表 TimeSheet 正式填报页）：**
`1FPAwV50VdpI2AGT42rfn6JhU0assY1QaARbhTQeiUKS0mZ66yf_JRb8R8`

```bash
# 1) 拉取线上 HEAD 到本地（推前必拉；symlink 须用真实路径）
cd "C:/Users/rita.jin/WorkBuddy/SMCN_ERP"   # 真实路径，勿用 ReparsePoint
python tools/gas_pull.py --script 1FPAwV50VdpI2AGT42rfn6JhU0assY1QaARbhTQeiUKS0mZ66yf_JRb8R8
```

- [ ] **身份核验**：脚本内 `_lsGetMasterSs()` 指向主库 `1oxPj0mz`；菜单/触发器确为 TimeSheet 正式填报页，非测试副本。
- [ ] **集成核验**：现有 `onEdit`/每日链入口未被破坏；与 pmlist / PROC 遥控桥无冲突。
- [ ] **开关核验**：存在「请假提示一键关闭」开关，且 **fail-safe 默认关**（关 = 完全不加载核心、不解析、不读镜像）。
- [ ] **判据**：三项任一不符 → **停摆上报 Rita + Tom**，不进入阶段 2。

---

## 2. 阶段四哈希比对（非目标区域零漂移）

> 用 v4 stage4_hash_check.js 对线上 HEAD 非目标区域取 SHA，证明本轮只动目标区、未漂移他人改动。

```bash
cd "C:/Users/rita.jin/WorkBuddy/SMCN_ERP/tools/_staging_ts_leave_tip"
node -e "const S=require('./stage4_hash_check.js'); /* 注入线上 HEAD 非目标区 CSV + manifest */ S.main();"
```

manifest 必填（v4 已强制）：
- `frozenVersion` 非空、`table` 非空、`capturedAt` = ISO-8601（占位 `C` 不再合法）
- `nonTargetColumns` 合法唯一、`authorizedTarget.dataWrite === false`
- 证据文件 before/after SHA 绑定

- [ ] 线上 HEAD 非目标区 SHA == 预期基线 SHA → 零漂移。
- [ ] **判据**：不一致 → **停摆**（可能有人改过生产表），上报 Rita 比对差异，不推。

---

## 3. 本地集成改动（内联 + 开关默认关）

> 将 v4 接入 1FPAwV50 HEAD，结构上一律只信任服务端注入的身份。

- [ ] 将 `ts_leave_tip_core.js` + v4 `deploy_wrapper.js` 以「内联 + 开关默认关」接入 HEAD（不新建独立 webapp，避免匿名 403）。
- [ ] **真实身份注入**：`setTrustedResolver(() => ({ employeeId: Session.getActiveUser().getEmail() }))` 由 GAS 服务端一次性注入；客户端 `req.identityResolver/employeeId/who` 一律被白名单剔除（v4 已结构保证）。
- [ ] 主体解析一次后固化为 `Object.freeze({employeeId})`，杜绝双解析 + 可变引用。
- [ ] **本地复跑**（提交方已绿，复核）：
```bash
cd "C:/Users/rita.jin/WorkBuddy/SMCN_ERP/tools/_staging_ts_leave_tip"
node wrapper_negative_tests.js   # 期望 29/29 exit 0
node stage4_tests.js             # 期望 35/35 exit 0
```
- [ ] **dry-run 校验**（语法/行数，不部署）：
```bash
python tools/gas_push_deploy.py --script 1FPAwV50VdpI2AGT42rfn6JhU0assY1QaARbhTQeiUKS0mZ66yf_JRb8R8 --dry-run
```
- [ ] 判据：测试非全绿或 dry-run 报错 → 修后再验，不部署。

---

## 4. 版本化部署（URL 不变）

> push 前必查 CLASP_PROJECT_MAP（目录名不可信）；deploy 是版本化的，URL 不变、保留 ANYONE_ANONYMOUS。

```bash
# 查目录绑定（真实路径）
cat tools/CLASP_PROJECT_MAP.md | grep -i "1FPAwV50"

# 版本化部署（dry-run 默认；deploy 后 URL 不变）
python tools/gas_push_deploy.py --script 1FPAwV50VdpI2AGT42rfn6JhU0assY1QaARbhTQeiUKS0mZ66yf_JRb8R8
```

- [ ] 部署后行数 == 本地预期行数（验行数）。
- [ ] 保留 `ANYONE_ANONYMOUS`（不收窄既有匿名访问）。
- [ ] **判据**：行数不符 / 部署失败 → 回滚到上一版本 URL，不强行。

---

## 5. 灰度 + 监控（开关默认关 → 仅限指定人）

- [ ] 开关保持默认关；仅对 **Rita 本人（或指定 1–2 人）** 开启。
- [ ] 观察 **1 个完整填报周期**（含提交 / 只读本人镜像）。
- [ ] 监控项：
  - [ ] 每日链心跳正常（看门狗见心跳 <180min 静默，不误报）
  - [ ] 报错日志仅含固定诊断码（`ERR_*`），无原始异常/行数据外泄
  - [ ] 无他人数据泄漏（核心收到的镜像 `every(who===本人)`）
- [ ] **全量放开需 Rita 二次确认**（不自动扩面）。

---

## 6. 回滚预案（fail-closed）

- [ ] 任一异常 → **一键关闭开关**（不删代码，立即 fail-safe 到关）。
- [ ] 或回滚到阶段 4 上一版本 URL（`gas_push_deploy.py` 重新 deploy 旧版本号）。
- [ ] 事故安全 OPEN 项保持独立跟踪，不因上线关闭。

---

## 7. 诚实分层 —— 部署期仍未验项（本清单执行后仍须 Rita/Tom 共验）

- 真实 GAS 身份（`Session.getActiveUser()` 注入）在真实运行环境的会话可信性
- 可信会话边界（模块级函数不证明传入 session 可信）
- UI 内联产物 / 集成 / 性能 / 恢复
- **不得将「部署期再验」解释为允许先生产部署**——本清单每一阶段失败即停。

---

## 附：关键资产与通道（备查）

| 项 | 值 |
|----|----|
| 生产表 TimeSheet 正式填报页 | `1FPAwV50VdpI2AGT42rfn6JhU0assY1QaARbhTQeiUKS0mZ66yf_JRb8R8` |
| 主库 | `1oxPj0mz` |
| v4 固定 commit | `1f0ae990c5336d1cc7ce80547ab5a89185a2c8e7` |
| 拉取脚本 | `tools/gas_pull.py` |
| 部署脚本 | `tools/gas_push_deploy.py`（dry-run 默认） |
| 目录映射 | `tools/CLASP_PROJECT_MAP.md`（目录名不可信，symlink 用真实路径） |
| clasp 凭据 | `~/.clasprc.json` |
| node 运行时 | `C:\Users\rita.jin\.workbuddy\binaries\node\versions\22.12.0\node.exe` |
| 提交方测试 | `wrapper_negative_tests.js`(29/29) / `stage4_tests.js`(35/35) |
