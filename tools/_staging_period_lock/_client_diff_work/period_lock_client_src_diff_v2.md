# T1-B period-lock · 客户端源码差异交付件 v2（runbook v3 §1/§2 落地 diff · 错误传输接口契约版）

> 性质：**本地代码，零生产写**。v2 相对 v1 草案的唯一实质变化：§2.5 错误渲染由「纯文本匹配码」升级为 **runbook v3 §2.5 接口契约**（plParseErr 三档：载荷 logFailed 真/假两档 + 缺失/不可解析落「登记状态未知」档，禁默认 false）。

> 依据：runbook v3（commit ea850d2）+ guard 三件 v6（本次同批交付，PeriodLockGuard.gs 与 v5 逐字节一致未改动）。

> 基线：ts-manager HEAD 快照 v4.3.72（_ts_head_live/，行尾为 CR-CR-LF 混合编码，本 diff 保持原字节不动，仅改清单所列区块）。

> 改后完整文件随本件同批落仓（_client_diff_work/Index.html、_client_diff_work/Code.gs），可逐行核对，不必只信 diff。

## Index.html

```diff
--- a/Index.html (HEAD v4.3.72)
+++ b/Index.html (period-lock client v2 契约版)
@@ -156,4 +156,5 @@
             <form id="timeForm">
                 <input type="hidden" name="uuid" id="editUuid">
+                <input type="hidden" name="expectContentHash" id="editHash">
                 <div class="grid">
                     <div>
@@ -449,4 +450,56 @@
         }
 
+        // period-lock（runbook v3 §2.5 错误传输接口契约）：三档渲染。
+        // 契约：google.script.run failure handler 只跨边界传 message 字符串，
+        // Error 自定义属性不随序列化（该跨边界行为未经实测，本契约不依赖）——
+        // 故服务端把 uncertain 态状态安全序列化进 message：
+        //   拒绝码 PL_REJECT_*：message=码本身，无载荷（拒绝时不登记，无状态可传）；
+        //   不确定态 PL_UNCERTAIN_*：message=<码>|{"logFailed":bool,"cause":"…"}。
+        // 解析以第一个 | 切分；载荷缺失/不可解析/logFailed 非布尔 → 登记状态未知档，
+        // 禁默认 false、禁称「已登记」。
+        function plParseErr(msg) {
+            var s = String(msg || "");
+            var i = s.indexOf("|");
+            if (i < 0) return { code: s, logFailed: null, cause: "" };
+            var code = s.slice(0, i), payload = null;
+            try { payload = JSON.parse(s.slice(i + 1)); } catch (e) { payload = null; }
+            if (!payload || typeof payload.logFailed !== "boolean") {
+                return { code: code, logFailed: null, cause: "" };
+            }
+            return { code: code, logFailed: payload.logFailed, cause: String(payload.cause || "") };
+        }
+        var PL_MSG_MAP = [
+            ["PL_REJECT_MISSING_EXPECT_VERSION", "页面版本过旧，请刷新后重试（你的修改未保存）"],
+            ["PL_REJECT_CONTENT_VERSION", "这条记录已被他人修改过，请刷新页面后再编辑（你的修改未保存）"],
+            ["PL_REJECT_NEW_DATE_CLOSED", "2026-10-01 之前的期间已关账，不能新增/修改/删除（解锁请联系管理员）"],
+            ["PL_REJECT_ORIG_DATE_CLOSED", "2026-10-01 之前的期间已关账，不能新增/修改/删除（解锁请联系管理员）"],
+            ["PL_REJECT_FUTURE_CLOSED", "当前锁政策暂不接受该日期的写入，请刷新或联系管理员"],
+            ["PL_REJECT_ALREADY_DELETED", "这条记录已被删除，请刷新"],
+            ["PL_REJECT_LOCK_BUSY", "系统繁忙，请稍候重试（不要连续点击）"],
+            ["PL_REJECT_ROW_GONE", "记录状态异常，请刷新后重试"],
+            ["PL_REJECT_NO_UUID", "记录状态异常，请刷新后重试"],
+            ["PL_REJECT_UUID_NOT_UNIQUE", "记录状态异常，请刷新后重试"],
+            ["PL_REJECT_OWNER_MISMATCH", "记录状态异常，请刷新后重试"],
+            ["PL_REJECT_ORIG_UNKNOWN", "记录状态异常，请刷新后重试"],
+            ["PL_REJECT_BAD_NEW_DATE", "记录状态异常，请刷新后重试"]
+        ];
+        function plHumanMsg(msg) {
+            var p = plParseErr(msg);
+            var code = p.code;
+            var isUncertain = code.indexOf("PL_UNCERTAIN_BIZ_WRITE_FAILED") === 0 || code.indexOf("PL_UNCERTAIN_FLUSH_FAILED") === 0;
+            if (isUncertain) {
+                if (p.logFailed === true) {
+                    return "系统状态不确定，且未能登记待核查；请刷新确认你的修改是否生效，不要重复提交，并联系管理员补登记";
+                }
+                if (p.logFailed === false) {
+                    return "系统状态不确定，已登记待核查；请刷新确认你的修改是否生效，不要重复提交";
+                }
+                return "系统状态不确定，登记状态未知；请刷新确认你的修改是否生效，不要重复提交，并联系管理员核查";
+            }
+            for (var i = 0; i < PL_MSG_MAP.length; i++) {
+                if (code.indexOf(PL_MSG_MAP[i][0]) >= 0) return PL_MSG_MAP[i][1];
+            }
+            return null;
+        }
         function handleServerError(err) {
             toggle(false);
@@ -458,5 +511,6 @@
                 showAuth();
             } else {
-                alert("Error: " + msg + "\n\nPlease refresh. / 请刷新页面。");
+                const human = plHumanMsg(msg);
+                alert(human ? human + "\n\n" + msg : "Error: " + msg + "\n\nPlease refresh. / 请刷新页面。");
             }
         }
@@ -646,4 +700,6 @@
 
         function del(id) { 
+            const log = currentLogs.find(l => String(l.uuid) === String(id));
+            if (!log || !log.rowHash) { alert('该记录含特殊字符无法校验版本，请联系管理员 / This record cannot be version-checked, please contact admin'); return; }
             if(confirm('Delete this record? / 确定删除该条记录？')) { 
                 toggle(true); 
@@ -651,5 +707,5 @@
                     .withSuccessHandler(() => init())
                     .withFailureHandler(handleServerError)
-                    .softDeleteRecord(currentToken, id); 
+                    .softDeleteRecord(currentToken, id, log.rowHash); 
             } 
         }
@@ -657,5 +713,7 @@
         function editRow(uuid) { 
             const log = currentLogs.find(l => String(l.uuid) === String(uuid)); if(!log) return;
+            if (!log.rowHash) { alert('该记录含特殊字符无法校验版本，请联系管理员 / This record cannot be version-checked, please contact admin'); return; }
             document.getElementById('editUuid').value = log.uuid; 
+            document.getElementById('editHash').value = log.rowHash || ''; 
             document.getElementById('inputDate').value = log.date; 
             document.getElementById('stageSelect').value = log.stage; 
@@ -669,5 +727,5 @@
         function cancelEdit() { 
             document.getElementById('timeForm').reset(); document.getElementById('inputDate').valueAsDate = new Date(); 
-            document.getElementById('editUuid').value = ""; document.getElementById('canBtn').style.display = 'none'; 
+            document.getElementById('editUuid').value = ""; document.getElementById('editHash').value = ""; document.getElementById('canBtn').style.display = 'none'; 
             handleStageChange(); validate();
         }
@@ -1147,4 +1205,6 @@
         function saveBatchEdit(uuid) {
             const sid = cssEscape(uuid);
+            const batchLog = batchCurrentLogs.find(l => String(l.uuid) === String(uuid));
+            if (!batchLog || !batchLog.rowHash) { alert('该记录含特殊字符无法校验版本，请联系管理员 / This record cannot be version-checked, please contact admin'); return; }
             const f = {
                 uuid: uuid,
@@ -1153,5 +1213,6 @@
                 stage: document.getElementById('ed_' + sid + '_stage').value,
                 hours: document.getElementById('ed_' + sid + '_hours').value,
-                notes: document.getElementById('ed_' + sid + '_notes').value
+                notes: document.getElementById('ed_' + sid + '_notes').value,
+                expectContentHash: batchLog.rowHash || ''
             };
             if (!f.date || !f.project || !f.hours) { alert('Date/Project/Hours required / 日期/项目/工时必填'); return; }
@@ -1165,4 +1226,6 @@
 
         function delBatchRow(uuid) {
+            const batchLog = batchCurrentLogs.find(l => String(l.uuid) === String(uuid));
+            if (!batchLog || !batchLog.rowHash) { alert('该记录含特殊字符无法校验版本，请联系管理员 / This record cannot be version-checked, please contact admin'); return; }
             if (!confirm('Delete this record? / 确定删除该条记录？')) return;
             toggle(true, 'Deleting... / 删除中...');
@@ -1170,5 +1233,5 @@
                 .withSuccessHandler(() => { toggle(false); loadBatchMonth(); })
                 .withFailureHandler(handleServerError)
-                .softDeleteRecord(currentToken, uuid);
+                .softDeleteRecord(currentToken, uuid, batchLog.rowHash);
         }
     </script>
```

## Code.gs

```diff
--- a/Code.gs (HEAD v4.3.72)
+++ b/Code.gs (period-lock client v2 契约版)
@@ -248,5 +248,5 @@
     if (isNaN(rowDate.getTime()) || rowDate < startOfRange || rowDate > endOfRange) continue;
     
-    let log = { uuid: safeGetUuid(tsData[i][8]), date: Utilities.formatDate(rowDate, "GMT+8", "yyyy-MM-dd"), stage: tsData[i][4], project: tsData[i][5], hours: parseFloat(tsData[i][6]) || 0, notes: tsData[i][7] };
+    let log = { uuid: safeGetUuid(tsData[i][8]), date: Utilities.formatDate(rowDate, "GMT+8", "yyyy-MM-dd"), stage: tsData[i][4], project: tsData[i][5], hours: parseFloat(tsData[i][6]) || 0, notes: tsData[i][7], rowHash: _plRowContentHash(tsData[i]) };
     logs.push(log);
     if (!matrix[log.project]) matrix[log.project] = [0,0,0,0,0,0,0];
@@ -290,5 +290,6 @@
       project: tsData[i][5],
       hours: parseFloat(tsData[i][6]) || 0,
-      notes: tsData[i][7]
+      notes: tsData[i][7],
+      rowHash: _plRowContentHash(tsData[i])
     });
   }
```

## 变更清单（9 处，全部对照 runbook v3）

| # | 文件 | 位置 | 改动 | 对应 runbook |
|---|---|---|---|---|
| 1 | Index.html | L157 表单 | 加隐藏域 `<input type="hidden" name="expectContentHash" id="editHash">` | §2.1 |
| 2 | Index.html | L451 handleServerError | **v2 重写**：plParseErr（第一个 `|` 切分 + JSON.parse + logFailed 布尔校验）+ PL_MSG_MAP + plHumanMsg 三档（true=未能登记话术 / false=已登记话术 / null=登记状态未知话术） | §2.5 契约 |
| 3 | Index.html | L647 del | null 行禁删+管理员提示；第三参传 `log.rowHash` | §2.3 |
| 4 | Index.html | L657 editRow | null 行禁编辑+管理员提示；填 `editHash.value = log.rowHash` | §2.1 |
| 5 | Index.html | L669 cancelEdit | 清空 `editHash` | §2.1 |
| 6 | Index.html | L1147 saveBatchEdit | null 行禁编辑；f 加 `expectContentHash: batchLog.rowHash` | §2.2 |
| 7 | Index.html | L1166 delBatchRow | null 行禁删；第三参传 `batchLog.rowHash` | §2.4 |
| 8 | Code.gs | L250 getDashboardData | log 对象加 `rowHash: _plRowContentHash(tsData[i])` | §1 |
| 9 | Code.gs | L286 getDetailLogsByMonth | logs.push 加 `rowHash: _plRowContentHash(tsData[i])` | §1 |

## 与服务端 v6 的契约对齐

- 服务端 v6（period_lock_integrated_src.gs `_plUncertainPayloadMsg`）：uncertain 态 message=`<码>|{"logFailed":bool,"cause":…}`；拒绝码/普通错误 message 不变。本件 #2 的 plParseErr 即该契约的客户端解析侧，两端同批交付、同批部署。
- tsAppendRows / tsPatchCells 的既有 success-return JSON（plCode/plCause/logFailed）schema 已对齐，v6 未改；且本客户端（Index.html）**不直接调用**这两个入口（grep 零命中），其 JSON 契约仅约束远程批量工具调用方，本件无对应改动。

## 照实登记的边界

1. **依赖**：Code.gs 两处调用 `_plRowContentHash`，该 helper 仅存于 PeriodLockGuard.gs——本 diff 的 Code.gs 必须与 guard 文件同批部署（runbook v3 阶段 1/2），单独上线会 ReferenceError。
2. **版本号未 bump**：APP_VERSION / TS_APP_VERSION 维持 4.3.72（本 diff 不改版本校验机制）。部署时是否 bump 以强制存量页面自动重载，由 Rita 部署时裁定；不 bump 时存量页面按 runbook §0「首次编辑被拒+提示刷新」路径收敛。
3. **未经真实部署验证**：Node 环境跑不到 google.script.run 通道；plParseErr 的纯函数部分（含三档降级）已由测试件 X6 从**本交付件实抽实测**，端到端（真实通道/界面渲染）只能在部署步骤 3 验证。
4. **本 diff 只含阶段 1/2 的客户端+只读侧**；mutation guard 五入口改后函数由 v6 集成源码件同批交付，不重复。
5. 零生产写：本件为本地副本编辑，未触碰任何线上文件。

## 验证记录（提交方报告，非执行证据）

- 9/9 处替换精确命中（每处断言恰好 1 次）；
- 行尾保持：Index.html CR-CR-LF 1174→1237（新增行全部同款行尾）、唯一裸 CRLF 行（L343 APP_VERSION）未动；Code.gs 584→585；
- 变更范围：Index.html +68/-5 行、Code.gs +3/-2 行，无清单外改动；
- JS 语法：两份改后文件过 node --check 均通过；
- 契约测试：period_lock_tests.js R/I/V/W/X 共 **86/86 通过 exit 0**，其中 X1-X5 实测服务端载荷序列化、X6 从本交付件 Index.html 实抽 plParseErr/plHumanMsg 实测三档（含 cause 含 `|` 切分鲁棒性、非布尔 logFailed 不默认 false）。
