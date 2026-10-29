# T1-B 收口设计规范：独立授权期锁契约 + 批次级 base 读取 fail-closed

> 状态：**设计草案（待 Tom 技术审核）**。本文档**不改动任何已部署代码**，仅为 GO-S4 ④ 收口与"生产写"放行提供可审的设计基线。
> 关联：Tom 2026-10-29 09:51Z 回复（技术阻塞① clearance / ② live 主库底稿读取降级）的落地要求。
> 审阅仓：ritajin-tech/SMCN_ERP-T1B-audit-shared（本文件副本在 contract/）。

---

## 1. 期锁 clearance：独立授权服务端契约（回应 Tom 技术阻塞①）

### 1.1 设计目标
`--clearance <令牌>` 当前在服务端是写死桩（`gen_gas_softdel.py:189` 与部署物 `ts_softdel_gas_embedded.js:1101` 均 `return false`）。
为让 1450 行（全部 bizDate<2026-10-01 锁账期）可被授权放行，又不破坏红线#10（不换链接、安全部署）、且不把它变成"谁都能传令牌就放行"的后门，clearance 必须是**独立授权的服务端契约**。

### 1.2 契约要素（须由服务端校验，全部满足才放行）
1. **身份核验**：令牌由业务 owner（Rita）在**服务端 Script Properties** 中签发，**不写死在公开代码**（`isClearance` 改为读 `PropertiesService.getScriptProperties().getProperty('T1B_CLEARANCE_TOKEN')`）。
2. **最小范围绑定**：令牌须绑定 `{ action: 'ts_softdel_apply', sheetId: '1Pi5u9fE', jobId, rowSetDigest, snapshotFingerprint }`；
   - `rowSetDigest` = 本次 apply 目标行集（keeper/目标行号）的 SHA-256；
   - `snapshotFingerprint` = 本次读取守卫的完整规范化快照指纹；
   - 服务端校验令牌绑定与本次请求参数**完全一致**，否则 `PERIOD_LOCKED`（防越权放大到无关行/无关表）。
3. **短时 + 可撤销**：令牌带 `issuedAt` 与 `ttl`（建议 ≤ 24h）；服务端校验未过期；owner 可随时在 Script Properties 删除令牌即全局撤销。
4. **一次性 + nonce 防重放**（Tom 09:51Z 明确要求）：令牌含一次性 `nonce`（或单次 `jobId`）；服务端**原子消费**——同一令牌/同一 jobId 第二次请求即 `REPLAY_REJECTED`。（因生产写是幂等软标，重放无害，但 nonce 仍是审计与防混淆必需。）
5. **失败全拒**：身份不符 / 范围不符 / 过期 / 已消费 / 缺失，一律 `PERIOD_LOCKED` 或 `CLEARANCE_REJECTED`，**绝不静默放行**。

### 1.3 部署方式（红线#10）
- 仅**原地更新部署**（只推 HEAD 或 `projects.deployments.update`），**不新建部署、不换链接**；
- 推后 `list-deployments` 复核部署数量/版本与推前一致；
- 公开仓代码**不内嵌**令牌值与端点（已脱敏）。

### 1.4 验收（请 Tom 给具体编辑）
- 令牌存放键名 / 格式 / TTL / 是否限单行；
- nonce 是一次性的还是按 jobId 锁定；
- 是否须经 Tom 代码复核后再部署；
- 是否同意原地更新（不换链接）。

---

## 2. base 读取：批次级 fail-closed（回应 Tom 技术阻塞②）

### 2.1 现状问题
dry-run 实测：exactA 1225 组中 **474 个 UUID 在 live 主库"工时_候选0824"读不到**（报错"底稿该UUID行数=0"），但本地 13:50 底稿快照（11685 行）完整包含全部 1225 个 UUID。
证明是 **hktool live 读取降级/截断**，非数据丢失。服务端 CAS 同样 live 读主库底稿做 base 哈希校验——若同样降级，apply 时 474 行也会被服务端拒，只能写 751 行、剩 474 悬着，且暴露主库底稿读取不可靠。

### 2.2 设计目标
base 读取须是**批次级 fail-closed**：预检阶段发现"批次内存在读取不完整/版本不一致"即**整批拒绝**，不允许"读到的就写、读不到的就静默误拒"。

### 2.3 设计要素
1. **预检与写入两阶段分离**：先对整批所需 base 行集做一次性完整读取 + 完整性断言；任何 UUID 的 base 读取返回"行数=0 但本地快照证明该 UUID 应存在"→ 判定 `BASE_READ_INCOMPLETE`，**整批 fail-closed**，不进入写入阶段。
2. **版本一致性**：base 读取同样绑定读取守卫（内容指纹 / revision，复用 `ts_read_guard.js`）；base 源在读取期间漂移 → `BASE_VERSION_MISMATCH`，整批 fail-closed。
3. **禁止 override fallback 静默放行**（Tom 09:51Z 明确要求）：即便提供 `TS_BASE_OVERRIDE` 本地快照，也**不得**在批次级完整性未通过时静默用它替换 live 读取结果；override 仅作为"已知 hktool 降级时的显式、受控、可审计"路径，且**必须与本次 apply 的 rowSetDigest 绑定、单独审批**，不作为默认 fallback。
4. **根因优先**：在 hktool live 读取降级根因（缺页 / 超时 / 权限 / 该 tab 被改）未查清前，**禁止任何 live 写**；只允许受控 override 路径（已验证零误拒）。

### 2.4 验收（请 Tom 给具体编辑）
- hktool 降级根因结论；
- 服务端是否需同步 base 兜底（与客户端一致用 override）；
- 未修复前是否同意禁止 live 写、仅走受控 override；
- 批次级 fail-closed 的拒绝码与回滚语义。

---

## 3. 与 GO-S4 五前置的关系
- clearance 契约 = GO-S4 ④（写者稳定性 / 部署权限 / 安全阻断）的落地项之一；
- base 读取 fail-closed = GO-S4 ③（快照 / 独立回读 / 失联恢复）的读侧补全；
- 两者均须 Tom 审核通过后，由业务 owner（Rita）显式授权部署与执行，且执行前先 dry-run/emit 复核。
- 当前 GO-S4 整体仍 **NO-GO**：①入口/客户端契约、②UUID↔关系+指纹+期锁+时长依据、⑤owner 授权（已收，必要条件非充分）等其余项仍按 Tom 逐条清单推进。
