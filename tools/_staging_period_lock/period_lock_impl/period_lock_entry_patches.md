# T1-B · period-lock 入口接入 patches（入口与锁域覆盖 · 供差异审阅）

> 状态：**实现 patch 清单（本地，零生产写）** — 配套 `PeriodLockGuard.gs`。
> 日期：2026-10-25 09:1x
> 基线：ts-manager HEAD 只读快照 `_ts_head_live/`（版本 4.3.72，16 文件）。
> 锁域事实：5 个写入口**全部位于同一 script 项目**（ts-manager `1FPAwV50VdpI2AGT42rfn6JhU0assY1QaARbhTQeiUKS0mZ66yf_JRb8R8`），故共用 `LockService.getScriptLock()` 单例符合 M8；跨项目写者不在此锁域，列未覆盖。

## 0. DB_工时流水 列布局（快照实证）

| 列 | 1-based | 内容 |
|---|---|---|
| A | 1 | 写入时间戳 |
| **B** | **2** | **fillDate（锁键）** |
| C | 3 | 姓名 |
| D | 4 | 类型 |
| E | 5 | 阶段 |
| F | 6 | 项目编号 |
| G | 7 | 工时 |
| H | 8 | 备注 |
| **I** | **9** | **UUID（稳定行标识）** |
| J | 10 | 项目名 |
| K/L/M | 11-13 | 空/leader/空 |
| N | 14 | yearMonth |
| **O/P/Q** | **15-17** | **软删标记/软删人/软删时间** |

## 1. submitBatch（Code.gs L386-458）

**现状**：已有 `LockService.getScriptLock()` + `waitLock(30000)`（L437-438）——是唯一带锁的入口，但 waitLock 是“等待”而非“失败零写”，且锁内无 guard。

**Patch**（L436-457 整块替换）：
```diff
-  const lock = LockService.getScriptLock();
-  lock.waitLock(30000);
-  try {
-    const sheet = getDbSheet();
-    const startRow = sheet.getLastRow() + 1;
-    sheet.getRange(startRow, 1, newRows.length, 14).setValues(newRows);
-    // V4.3.62 写后回读校验（保留）
-    const written = sheet.getRange(startRow, 9, newRows.length, 1).getValues().map(...);
-    let missed = 0;
-    expectIds.forEach(...);
-    if (missed > 0) throw new Error("写入校验失败...");
-    return "SUCCESS";
-  } catch (e) {
-    throw new Error(e.message || "Batch write failed...");
-  } finally {
-    lock.releaseLock();
-  }
+  // period-lock（M8/R12a）：tryLock 失败零写；锁内重读策略+门禁；flush 后才释放
+  return _plGuardedInsert({
+    rows: newRows,
+    dateOf: function (r) { return r[1]; },          // B 列 fillDate
+    bizWrite: function (policy) {
+      const sheet = getDbSheet();
+      const startRow = sheet.getLastRow() + 1;
+      sheet.getRange(startRow, 1, newRows.length, 14).setValues(newRows);
+      const written = sheet.getRange(startRow, 9, newRows.length, 1).getValues().map(function(r){ return String(r[0]); });
+      let missed = 0;
+      expectIds.forEach(function(id){ if (written.indexOf(id) < 0) missed++; });
+      if (missed > 0) {
+        var e = new Error("写入校验失败：" + missed + "/" + newRows.length + " 条未落表，请重试（数据未丢失）");
+        e.plCode = 'BIZ_WRITE_FAILED';
+        throw e;
+      }
+      return "SUCCESS";
+    }
+  });
```
（幂等/批内去重逻辑 L386-435 原样保留在 guard 之前。）

## 2. updateTimesheet（Code.gs L460-481）

**现状**：全表读→按 UUID+姓名匹配→**直接写 B:J 9 列，无锁**。属 M1 双向检查的“修改”场景。

**Patch**（L471-477 匹配命中块替换）：
```diff
-      if (safeGetUuid(data[i][8]) == String(f.uuid).trim() && String(data[i][2]) === String(user.name)) {
-        let row = i + 1;
-        sheet.getRange(row, 2, 1, 9).setValues([[...]]);
-        return "SUCCESS";
-      }
+      if (safeGetUuid(data[i][8]) == String(f.uuid).trim() && String(data[i][2]) === String(user.name)) {
+        let row = i + 1;
+        const origBiz = data[i][1];                 // 锁内重核的期望期间
+        // period-lock（M1/M8）：双向门禁 + LockService 临界区
+        return _plGuardedMutation({
+          sheet: sheet,
+          uuid: safeGetUuid(data[i][8]),
+          newDateRaw: f.date,
+          origDateRaw: origBiz,
+          expectDeleted: false,
+          bizWrite: function (recheck) {
+            sheet.getRange(row, 2, 1, 9).setValues([[
+              f.date, String(user.name), "", String(f.stage), formatPid(f.project), parseFloat(f.hours) || 0, String(f.notes), safeGetUuid(data[i][8]), pMap[formatPid(f.project)] || "Other / 其他"
+            ]]);
+            return "SUCCESS";
+          }
+        });
+      }
```

## 3. softDeleteRecord（Code.gs L483-497）

**现状**：匹配 UUID+姓名→**直接写 O:Q，无锁**。“删除”场景：原记录期间在关账期即拒。

**Patch**（L490-492 替换）：
```diff
-      if (safeGetUuid(data[i][8]) == String(uuid).trim() && String(data[i][2]) === String(user.name)) { 
-        sheet.getRange(i + 1, 15, 1, 3).setValues([[true, user.name, new Date()]]); 
-        return "SUCCESS"; 
-      }
+      if (safeGetUuid(data[i][8]) == String(uuid).trim() && String(data[i][2]) === String(user.name)) {
+        const origBiz = data[i][1];
+        return _plGuardedMutation({
+          sheet: sheet,
+          uuid: safeGetUuid(data[i][8]),
+          newDateRaw: origBiz,                     // 删除不产生新日期：以原期间过门禁
+          origDateRaw: origBiz,
+          expectDeleted: false,
+          bizWrite: function (recheck) {
+            sheet.getRange(i + 1, 15, 1, 3).setValues([[true, user.name, new Date()]]);
+            return "SUCCESS";
+          }
+        });
+      }
```

## 4. tsAppendRows（RemoteActions.gs L68-131）

**现状**：远程批量写（≤3000 行；UUID 去重；force 可写请假行）→ **setValues 无锁**。

**Patch**（L116-126 替换）：
```diff
-    var startRow = sh.getLastRow() + 1;
-    sh.getRange(startRow, 1, toWrite.length, 14).setValues(toWrite);
-    // 写后回读校验
-    var back = sh.getRange(startRow, 9, toWrite.length, 1).getValues();
-    var got = 0;
-    for (var m = 0; m < back.length; m++) if (String(back[m][0] || '').trim()) got++;
-    _tsWriteLog('appendRows', ...);
-    return JSON.stringify({ ok: true, ... });
+    // period-lock（M8/R12a）：远程批量写同样进 guard 临界区
+    var res = _plGuardedInsert({
+      rows: toWrite,
+      dateOf: function (r) { return r[1]; },        // B 列 fillDate
+      bizWrite: function (policy) {
+        var startRow = sh.getLastRow() + 1;
+        sh.getRange(startRow, 1, toWrite.length, 14).setValues(toWrite);
+        var back = sh.getRange(startRow, 9, toWrite.length, 1).getValues();
+        var got = 0;
+        for (var m = 0; m < back.length; m++) if (String(back[m][0] || '').trim()) got++;
+        return { wrote: toWrite.length, verified: got, startRow: startRow };
+      }
+    });
+    _tsWriteLog('appendRows', 'req=' + rows.length + ' wrote=' + res.wrote + ' verified=' + res.verified +
+                ' skipDup=' + skippedDup + ' skipLeave=' + skippedLeave);
+    return JSON.stringify({ ok: true, requested: rows.length, wrote: res.wrote, verified: res.verified,
+                            skippedDup: skippedDup, skippedLeave: skippedLeave, startRow: res.startRow });
```

## 5. tsPatchCells（RemoteActions.gs L138-177）

**现状**：可写**任意表任意格**（ssid 参数，≤5000 格）→ **无锁**。M1 分列：仅当目标为 DB_工时流水 且触及 B 列（fillDate）或 O:Q（软删）时过 guard；其他表/其他列不拦（不影响期间归属）。

**Patch**（L156-171 的 `if (!dry) {` 块替换）：
```diff
-    var n = 0;
-    if (!dry) {
-      for (...) { ...setValue... }
-      for (...) { ...setValues... }
-    }
+    var n = 0;
+    if (!dry) {
+      // period-lock：仅 DB_工时流水 的 B/O:Q 列进 guard（M1 分列）
+      if (sheetName === PL_DB_SHEET) {
+        var _lock = _plAcquire();
+        try {
+          var chk = _plGuardPatch(sh, cells, ranges);
+          if (!chk.ok) {
+            var e = new Error('period-lock reject: ' + chk.reason + ' ' + JSON.stringify(chk.offenders || []));
+            e.plCode = chk.reason;
+            throw e;
+          }
+          for (var i = 0; i < cells.length; i++) { ...setValue...; n++; }
+          for (var r = 0; r < ranges.length; r++) { ...setValues...; n += ...; }
+          SpreadsheetApp.flush();
+        } finally {
+          try { _lock.releaseLock(); } catch (re) {}
+        }
+      } else {
+        for (var i2 = 0; i2 < cells.length; i2++) { ...setValue...; n++; }
+        for (var r2 = 0; r2 < ranges.length; r2++) { ...setValues...; n += ...; }
+      }
+    }
```

## 6. 未覆盖登记（M1 分列 · 仅 X2 检测告警）

- **跨项目入口**：其他 GAS 项目/脚本直接写 DB_工时流水 → 不在本 script 锁域，不拦，仅 X2 周期扫描检测告警。
- **人工在浏览器里直接改表**：不拦，仅 X2。
- **本表之外的任何页签/电子表格**：不拦。
- X2 周期扫描本身**不是冻结证明**，检测到仅告警+人工处置，不做自动回滚。

## 7. 回滚设计（M3/R11）

- 版本回退必须**保留执行锁入口**：回退包 = 旧业务代码 + `PeriodLockGuard.gs` + 5 处 patch 的最小保留集（至少 submitBatch/updateTimesheet/softDeleteRecord 三处主入口）；或回退即先拒绝写入（fail-closed）。
- 锁政策态存 `PropertiesService`（`PERIOD_LOCK_STATE`），代码回退不擦除状态；但**状态存在不等于执行约束**——执行约束由保留的 guard 代码提供。
- 例外路径（E1-E5）整体暂缓：审计 tab 授权就绪前不启用；本 patch 集不含任何例外解锁入口。
