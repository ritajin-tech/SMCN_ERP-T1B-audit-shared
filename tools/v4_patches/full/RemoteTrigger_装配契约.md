# RemoteTrigger 装配契约（回应 Tom #5「未覆盖 RemoteTrigger 的参数/postBody 装配」）

> 交付件：`RemoteTrigger.js`（178 行，本目录）。
> 本文件说明「HTTP 请求 → `_rtMaybeHandle` → `REMOTE_ACTIONS[...]` → `tsSoftDelGuarded`」的参数装配规则，
> 供离线隔离分发测试（harness S19 改造）依据。本轮**未部署、未发起任何生产请求**。

## 1. 入口链

```
doPost(e) ─► _rtMaybeHandlePost(e) ─► _rtMaybeHandle({parameter, postBody}) ─► REMOTE_ACTIONS[key](e) ─► tsSoftDelGuarded(e, deps)
doGet(e)  ─► _rtMaybeHandle(e)      ─► 同上
```

## 2. body 解析（`_rtMaybeHandlePost`，:114）

| 序 | 来源 | 条件 |
|---|---|---|
| 1 | `e.postData.contents` | `JSON.parse` |
| 2 | `e.parameter.payload` | 上者不存在时，`JSON.parse` |

解析失败 → 直接返回 `{ok:false, error:'invalid JSON body: ...'}`，**不进入分发**。

## 3. action 与 params 装配（:123–133）

```js
action = String(body.action || e.parameter.action || '').toLowerCase();   // 空则 return null
params = { ...e.parameter };                                              // 标量键浅拷贝
for (k in body) if (typeof body[k] !== 'object') params[k] = body[k];      // body 标量键并入
params.action = action;
if (!params.token && body.token) params.token = body.token;
return _rtMaybeHandle({ parameter: params, postBody: body });
```

**关键结论（对核心参数读取的影响）**：

- **数组/对象键（如 `rows`）不会并入 `params`** —— 只能从 `e.postBody.rows` 读到。
  核心 `tsSoftDelGuarded` 取 `body.rows || p.rows`，`body` = `e.postBody`，`p` = `e.parameter`；
  因此 `rows` **必须走 postBody**，与核心实现一致。
- **标量键（如 `jobId` / `batchId` / `version` / `expectMasterVersion`）两侧皆可**：
  走 postBody 时由 `body` 直接读到；走 query/form parameter 时并入 `params` 由 `p` 读到。
  ⇒ v5 计划新增的 `expectMasterVersion`（标量字符串）**两种通道都可达**，无装配阻碍。

## 4. 分发（:75–83）

`REMOTE_ACTIONS` 键为混合大小写，分发器把 action `toLowerCase()` 后做**大小写不敏感**查找：

```js
for (var _k in REMOTE_ACTIONS) if (String(_k).toLowerCase() === action && typeof REMOTE_ACTIONS[_k] === 'function') { _rtKey = _k; break; }
REMOTE_ACTIONS[_rtKey](e);
```

⇒ 客户端 `action:'softDelGuarded'` 与键 `softDelGuarded` 匹配（大小写不敏感）。

## 5. 状态查询（statusQuery）路径

`tsSoftDelGuarded` 内部按 `action === 'statusQuery'` 分流（见核心 `tsSoftDelStatus`），
**与写入走同一个 `REMOTE_ACTIONS` 入口**，无独立路由。

## 6. 离线可证 / 不可证边界

- **可静态证明**：上述装配规则（本文件 + `RemoteTrigger.js` 源码可读）。
- **可离线隔离证明（v5 B3 计划）**：隔离适配器加载 **FINAL 文件** → 构造 `e`（postData.contents / parameter.payload 两种形态）→ 经 `REMOTE_ACTIONS` 分发 → 断言抵达 `tsSoftDelGuarded`。
- **不可离线证明（如实声明）**：线上 `doPost` 的真实调用形态、部署版本与运行态；本轮未部署、未发请求，故不声称线上调用链已实测。

## 7. 脱敏检查

`RemoteTrigger.js` 已扫描：无 script ID（`AKfyc…`）、无长随机串、无邮箱、无真实姓名。可进公开审阅仓。
