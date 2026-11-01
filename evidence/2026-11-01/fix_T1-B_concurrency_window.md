# T1-B 根因修复 · 具体编辑（回应 Tom 08:52「要有具体编辑，不要 Yes/No」）

> 本文给出**可落盘的、file:line 级**修复，供 Tom 在共享仓 review。
> 这些编辑**尚未部署、尚未写入任何生产数据**——生产写仍处于 `TS_WRITE_FREEZE` + `EXIT=1` 锁死（Rita 14:1x 裁定：owner 接受数据基线 ≠ 技术放行）。
> 文件基线：`code_pull/finance_dss_backend/RemoteActions.js` 与 `PeriodLockGuard.js`（live 只读拉取快照）。

## 0. 根因一句话

`tsAppendRows` 在**锁外**读取「已存在 UUID 集合」并**锁外**判定 `toWrite`，两并发请求各读到「该 UUID 尚不存在」→ 各写一份 → 生产表 `DB_工时流水` 重复行（双倍工时）。锁（`_plGuardedInsert`）只保护「期间门禁 + 写入」，未保护「UUID 去重判定」。

精确窗口（live 代码行号）：
- `RemoteActions.js:96-105` —— `exist{}` 读（锁外）
- `RemoteActions.js:108-117` —— `toWrite` 判定（锁外）
- `RemoteActions.js:127` —— 进 `_plGuardedInsert`，但**未传 `lockPreWrite`**
- `PeriodLockGuard.js:494-498` —— 仅当 `opts.lockPreWrite` 为函数时才在锁内重核；因上面没传，整段跳过
- `PeriodLockGuard.js:502-509` —— 仅做期间门禁 `post` 检查 + `bizWrite`

## 1. Edit A —— `RemoteActions.js` `tsAppendRows`：把去重重读移入锁内

**位置**：`tsAppendRows` 内 `_plGuardedInsert({...})` 调用（当前约 :126-138）。

**修改前**：
```js
    // period-lock（M8/R12a）：远程批量写同样进 guard 临界区（按 B 列 fillDate 过期间门禁）
    var res = _plGuardedInsert({
      rows: toWrite,
      dateOf: function (r) { return r[1]; },        // B 列 fillDate
      bizWrite: function (rows2, policy) {
        var startRow = sh.getLastRow() + 1;
        sh.getRange(startRow, 1, rows2.length, 14).setValues(rows2);
        var back = sh.getRange(startRow, 9, rows2.length, 1).getValues();
        var got = 0;
        for (var m = 0; m < back.length; m++) if (String(back[m][0] || '').trim()) got++;
        return { wrote: rows2.length, verified: got, startRow: startRow };
      }
    });
```

**修改后**（新增 `lockPreWrite`；`:96-105`/`:108-117` 的锁外预读保留作 dry-run 统计用，权威去重改为锁内）：
```js
    // period-lock（M8/R12a）：远程批量写同样进 guard 临界区（按 B 列 fillDate 过期间门禁）
    // [T1-B 根因修复] 并发窗口：原 exist{} 读与 toWrite 判定在锁外（:96-105 / :108-117），
    //   两个并发请求各读到「UUID 尚不存在」→ 各写一份 → 重复行。
    //   现把去重重读移入锁内（lockPreWrite 在 _plGuardedInsert 取得锁后执行，见 PeriodLockGuard.js:494）。
    var res = _plGuardedInsert({
      rows: toWrite,
      dateOf: function (r) { return r[1]; },        // B 列 fillDate
      // [T1-B fix] 锁内重读 exist 并重判 toWrite；返回 {rows, duplicates}（契约见 PeriodLockGuard.js:496）
      lockPreWrite: function (rowsIn, policy) {
        var last2 = sh.getLastRow();
        var existNow = {};
        if (last2 > 1) {
          var uu = sh.getRange(2, 9, last2 - 1, 1).getValues();
          for (var i2 = 0; i2 < uu.length; i2++) {
            var ux = String(uu[i2][0] || '').trim();
            if (ux) existNow[ux] = true;
          }
        }
        var out2 = [], dup2 = 0;
        for (var j2 = 0; j2 < rowsIn.length; j2++) {
          var r2 = rowsIn[j2] || [];
          var uid2 = String(r2[8] || '').trim();
          if (uid2 && existNow[uid2]) { dup2++; continue; }   // 锁内刚写入的行跳过
          if (!force && _tsIsLeaveRowForGuard(r2)) { continue; }
          if (uid2) existNow[uid2] = true;
          out2.push(r2);
        }
        return { rows: out2, duplicates: dup2 };
      },
      bizWrite: function (rows2, policy) {
        var startRow = sh.getLastRow() + 1;
        sh.getRange(startRow, 1, rows2.length, 14).setValues(rows2);
        var back = sh.getRange(startRow, 9, rows2.length, 1).getValues();
        var got = 0;
        for (var m = 0; m < back.length; m++) if (String(back[m][0] || '').trim()) got++;
        return { wrote: rows2.length, verified: got, startRow: startRow };
      }
    });
```
**闭合证明**：请求 B 在请求 A 释放锁前阻塞于 `_plAcquire`；B 取得锁后 `lockPreWrite` 重读，看到 A 刚写入的 UUID → 跳过 → 不再重复写。`lockPreWrite` 契约（`PeriodLockGuard.js:496-497`：`pr.rows` / `pr.duplicates`）已存在，本编辑仅提供实现。

## 2. Edit B —— `PeriodLockGuard.js` `_plAcquire`：跨项目互斥

**位置**：`function _plAcquire(timeoutMs)` 第一行（当前 `PeriodLockGuard.js:260`）。

**修改前**：
```js
function _plAcquire(timeoutMs) {
  var lock = LockService.getScriptLock();
```
**修改后**：
```js
function _plAcquire(timeoutMs) {
  // [T1-B fix] 跨项目互斥：同表可能被多个 GAS 项目（如方案A 新建后端项目 + 既有填报页项目）并发写入。
  //   getScriptLock 仅锁本脚本实例，跨项目无效；改用 getDocumentLock 锁到文档（表格）级，
  //   所有写入同一表格的脚本共享同一把锁，实现跨项目互斥。
  var lock = LockService.getDocumentLock();
  // [T1-B fix] 有效锁守卫（回应 Tom 10:26「运行上下文是否返回有效锁」）：
  //   若受限上下文返回 null/无 tryLock → fail-closed 中止，绝不裸写。
  if (!lock || typeof lock.tryLock !== 'function') {
    var err0 = new Error('PL_REJECT_NO_LOCK');
    err0.plCode = 'PL_REJECT_NO_LOCK';
    throw err0;
  }
```
**依据**：Apps Script `LockService.getDocumentLock()` 锁定的是**文档（Spreadsheet）级**互斥区，跨所有操作同一文档的脚本实例共享；`getScriptLock()` 仅限当前脚本实例。方案A 引入独立后端项目后，必须用 document 锁才能覆盖「两项目写同表」的并发。
**有效锁守卫（闭合 Tom 10:26 条件）**：原 `_plAcquire`（PeriodLockGuard.js:259-269）已对 `tryLock` 超时做 fail-closed（`PL_REJECT_LOCK_BUSY`）；本补丁新增「锁对象本身为空/非法 → `PL_REJECT_NO_LOCK`」前置检查，确保**未返回有效锁时一律中止**，不进入任何写路径。该守卫逻辑已由 `concurrency_test_harness.js` 测试6 实跑验证（PASS）。

## 3. 还原/部署前置（部署时，不在本编辑范围）

- 两处修改**仅在 Rita 解除 `TS_WRITE_FREEZE` + 签发 M2 clearance + 提供 A5 证据后**，才经「原地 `deployments.update`」推送到既有部署（`AKfycbwYXV3`@193 后端 / 填报页 `AKfycbzUyhyK`@193），**链接不变**。
- 推前须：`node --check` 通过 → 只读 dry-run → `clasp list-deployments` 复核部署数不变。
- 锁超时（`PL_LOCK_TIMEOUT_MS`）与重试策略需随 document 锁实测调整（document 锁争用面更大）。

## 4. 对 Tom 的 review 要求（非 Yes/No）

请就 Edit A / Edit B 在共享仓给出**逐条裁定**：
- 接受；或
- 驳回 + 具体理由 + 你的替代 diff（file:line）。

并请补充两项你此前点名的负例证据（独立于本编辑、用于证明「清完不长回」）：
- **N1–N4 并发负例**：两个独立进程/项目对同一资源在锁内/锁外的失锁、重启、重放实测。
- **跨项目互斥实证**：两 GAS 项目 + 同表，验证 document 锁确实互斥（含锁超时/异常释放后行为）。

本编辑不替代上述负例——它们是「止血充分性」的独立证明，与本代码修复正交。
