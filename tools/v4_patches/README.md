# v4 补丁包（2026-10-26）—— 主库 + 生产库根治

配套文档：`docs/主库与生产库_根治完整方案_v4_终版_20261026.md`

## 基线源码

`clasp pull` 于 2026-10-26 23:44，18 个文件，目录 `D:/AI_DATA/WorkBuddy/_ts_current_20261026/`。
**应用前请务必对 ts-manager（`1FPAwV50VdpI2AGT42rfn6JhU0assY1QaARbhTQeiUKS0mZ66yf_JRb8R`）重新 `clasp pull` 并核对行数**：

| 文件 | 行数 | 行尾 |
|---|---|---|
| `PeriodLockGuard.js` | 619 | LF |
| `RemoteActions.js` | 1144 | LF |

行数对不上说明线上已变，补丁需重新生成。

## 补丁清单

| 补丁 | 作用 | 目标区间 |
|---|---|---|
| `A0_PeriodLockGuard.patch` | 新增清理类工具统一护栏 `_plGuardCleanup` / `_plGuardedCleanup` | 追加到文件末尾 |
| `A1_RemoteActions_tsAppendRows.patch` | **根因修复**：去重搬进临界区（TOCTOU） | 替换 78–147 行 |
| `A1b_RemoteActions_tsPatchCells.patch` | `tsPatchCells` 非 DB 分支补锁 | 替换 173–215 行 |

## 验证状态（已实测）

```
A0_PeriodLockGuard:          node --check OK, git apply OK, CRLF=无
A1_RemoteActions_tsAppendRows: node --check OK, git apply OK, CRLF=无
A1b_RemoteActions_tsPatchCells: node --check OK, git apply OK, CRLF=无
应用后整文件：PeriodLockGuard.js OK / RemoteActions.js OK
```

## 应用方式

```bash
# 在 clasp pull 出来的目录里
git init -q . && git add -A && git commit -qm base   # 先建基线，便于回滚
git -c core.autocrlf=false apply A0_PeriodLockGuard.patch
git -c core.autocrlf=false apply A1_RemoteActions_tsAppendRows.patch
git -c core.autocrlf=false apply A1b_RemoteActions_tsPatchCells.patch
node --check PeriodLockGuard.js && node --check RemoteActions.js
```

> ⚠️ 必须 `core.autocrlf=false`，否则补丁上下文因行尾符失配而拒应用。

## 未包含在补丁包里的动作

- **A2**（`tools/ts_post.py` 写入冻结开关）—— 本地脚本，非 GAS，见方案 §A2。
- **A3/A4/A5/A6**（数据清理与对账）—— 属于**生产写操作**，当前处于 NO-GO，待 Tom 评审后再执行。

## 🔴 铁律

- **只 `clasp push` 到 @HEAD，不建新部署**（3 个部署中 `AKfycbwlxB2z9IDDo7pBv4sr0pu6-1ywvYBuRyqTwfjgl_o` 是 @HEAD，推码即生效，链接不变）。
- 推码前先离线验证；生产 NO-GO 期间不推送。
