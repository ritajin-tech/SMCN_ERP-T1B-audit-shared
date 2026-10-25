# T1-B period-lock · 客户端源码差异交付件 v3（runbook v3 §1/§2 落地 diff · 契约全覆盖+安全版）

> 性质：**本地代码，零生产写**。v3 相对 v2 的实质变化：吸收 Tom 14:28 核对清单四条——① 服务端契约覆盖补齐至**全部五个 mutation 入口**（v2/v6 只有 updateTimesheet/softDeleteRecord，submitBatch/tsAppendRows/tsPatchCells 仍抛裸码）；② 新增填报失败通道确认走 handleServerError（L697，三档渲染天然覆盖）；③ cause 消毒（截断 200 + token 形态打码）；④ 前端白名单（仅三个 PL_UNCERTAIN_* 码进三档，白名单外不猜）。

> 依据：runbook v3（commit ea850d2）+ guard v7（本次同批交付，PeriodLockGuard.gs 自 v5 起首次改动：契约 helper 移入定义层 + _plGuardedInsert/_plOrchestrate 抛出点接入 + 消毒）。

> 基线：ts-manager HEAD 快照 v4.3.72（_ts_head_live/，行尾为 CR-CR-LF 混合编码，本 diff 保持原字节不动，仅改清单所列区块）。

> 改后完整文件随本件同批落仓（_client_diff_work/Index.html、_client_diff_work/Code.gs），可逐行核对，不必只信 diff。

## Index.html

```diff
--- a/Index.html (HEAD v4.3.72)
+++ b/Index.html (period-lock client v3 contract-full)
@@ -156,4 +156,5 @@
             <form id="timeForm">
                 <input type="hidden" name="uuid" id="editUuid">
+                <input type="hidden" name="expectContentHash" id="editHash">
                 <div class="grid">
                     <div>
@@ -449,4 +450,61 @@
         }
 
+        // period-lock（runbook v3 §2.5 错误传输接口契约）：三档渲染。
+        // 契约：google.script.run failure handler 只跨边界传 message 字符串，
+        // Error 自定义属性不随序列化（该跨边界行为未经实测，本契约不依赖）——
+        // 故服务端把 uncertain 态状态安全序列化进 message：
+        //   拒绝码 PL_REJECT_*：message=码本身，无载荷（拒绝时不登记，无状态可传）；
+        //   不确定态 PL_UNCERTAIN_*：message=<码>|{"logFailed":bool,"cause":"…"}。
+        // 解析以第一个 | 切分；载荷缺失/不可解析/logFailed 非布尔 → 登记状态未知档，
+        // 禁默认 false、禁称「已登记」。
+        // [审⑧-v7] 白名单：plHumanMsg 只对明确允许的三个 PL_UNCERTAIN_* 码
+        // 走三档（含 PL_UNCERTAIN_PATCH_WRITE_FAILED）；未知/损坏码不猜。
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
+            // [审⑧-v7] 白名单精确匹配（Tom 14:28 清单第4条）：只接受明确
+            // 允许的 uncertain 码，不用前缀猜；未知/损坏码不进三档
+            var PL_UNCERTAIN_CODES = ["PL_UNCERTAIN_BIZ_WRITE_FAILED", "PL_UNCERTAIN_FLUSH_FAILED", "PL_UNCERTAIN_PATCH_WRITE_FAILED"];
+            var isUncertain = PL_UNCERTAIN_CODES.indexOf(code) >= 0;
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
@@ -458,5 +516,6 @@
                 showAuth();
             } else {
-                alert("Error: " + msg + "\n\nPlease refresh. / 请刷新页面。");
+                const human = plHumanMsg(msg);
+                alert(human ? human + "\n\n" + msg : "Error: " + msg + "\n\nPlease refresh. / 请刷新页面。");
             }
         }
@@ -646,4 +705,6 @@
 
         function del(id) { 
+            const log = currentLogs.find(l => String(l.uuid) === String(id));
+            if (!log || !log.rowHash) { alert('该记录含特殊字符无法校验版本，请联系管理员 / This record cannot be version-checked, please contact admin'); return; }
             if(confirm('Delete this record? / 确定删除该条记录？')) { 
                 toggle(true); 
@@ -651,5 +712,5 @@
                     .withSuccessHandler(() => init())
                     .withFailureHandler(handleServerError)
-                    .softDeleteRecord(currentToken, id); 
+                    .softDeleteRecord(currentToken, id, log.rowHash); 
             } 
         }
@@ -657,5 +718,7 @@
         function editRow(uuid) { 
             const log = currentLogs.find(l => String(l.uuid) === String(uuid)); if(!log) return;
+            if (!log.rowHash) { alert('该记录含特殊字符无法校验版本，请联系管理员 / This record cannot be version-checked, please contact admin'); return; }
             document.getElementById('editUuid').value = log.uuid; 
+            document.getElementById('editHash').value = log.rowHash || ''; 
             document.getElementById('inputDate').value = log.date; 
             document.getElementById('stageSelect').value = log.stage; 
@@ -669,5 +732,5 @@
         function cancelEdit() { 
             document.getElementById('timeForm').reset(); document.getElementById('inputDate').valueAsDate = new Date(); 
-            document.getElementById('editUuid').value = ""; document.getElementById('canBtn').style.display = 'none'; 
+            document.getElementById('editUuid').value = ""; document.getElementById('editHash').value = ""; document.getElementById('canBtn').style.display = 'none'; 
             handleStageChange(); validate();
         }
@@ -1147,4 +1210,6 @@
         function saveBatchEdit(uuid) {
             const sid = cssEscape(uuid);
+            const batchLog = batchCurrentLogs.find(l => String(l.uuid) === String(uuid));
+            if (!batchLog || !batchLog.rowHash) { alert('该记录含特殊字符无法校验版本，请联系管理员 / This record cannot be version-checked, please contact admin'); return; }
             const f = {
                 uuid: uuid,
@@ -1153,5 +1218,6 @@
                 stage: document.getElementById('ed_' + sid + '_stage').value,
                 hours: document.getElementById('ed_' + sid + '_hours').value,
-                notes: document.getElementById('ed_' + sid + '_notes').value
+                notes: document.getElementById('ed_' + sid + '_notes').value,
+                expectContentHash: batchLog.rowHash || ''
             };
             if (!f.date || !f.project || !f.hours) { alert('Date/Project/Hours required / 日期/项目/工时必填'); return; }
@@ -1165,4 +1231,6 @@
 
         function delBatchRow(uuid) {
+            const batchLog = batchCurrentLogs.find(l => String(l.uuid) === String(uuid));
+            if (!batchLog || !batchLog.rowHash) { alert('该记录含特殊字符无法校验版本，请联系管理员 / This record cannot be version-checked, please contact admin'); return; }
             if (!confirm('Delete this record? / 确定删除该条记录？')) return;
             toggle(true, 'Deleting... / 删除中...');
@@ -1170,5 +1238,5 @@
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
+++ b/Code.gs (period-lock client v3 contract-full)
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

## 变更清单（9 处，全部对照 runbook v3 + Tom 14:28 清单）

| # | 文件 | 位置 | 改动 | 对应 |
|---|---|---|---|---|
| 1 | Index.html | L157 表单 | 加隐藏域 `<input type="hidden" name="expectContentHash" id="editHash">` | §2.1 |
| 2 | Index.html | L451 handleServerError | **v3 重写（白名单）**：plParseErr（第一个 `|` 切分 + JSON.parse + logFailed 布尔校验）+ PL_MSG_MAP + plHumanMsg 三档（true=未能登记 / false=已登记 / null=登记状态未知）；uncertain 码白名单精确匹配（BIZ_WRITE/FLUSH/PATCH_WRITE 三码，白名单外不猜） | §2.5 契约 + Tom 清单4 |
| 3 | Index.html | L647 del | null 行禁删+管理员提示；第三参传 `log.rowHash` | §2.3 |
| 4 | Index.html | L657 editRow | null 行禁编辑+管理员提示；填 `editHash.value = log.rowHash` | §2.1 |
| 5 | Index.html | L669 cancelEdit | 清空 `editHash` | §2.1 |
| 6 | Index.html | L1147 saveBatchEdit | null 行禁编辑；f 加 `expectContentHash: batchLog.rowHash` | §2.2 |
| 7 | Index.html | L1166 delBatchRow | null 行禁删；第三参传 `batchLog.rowHash` | §2.4 |
| 8 | Code.gs | L250 getDashboardData | log 对象加 `rowHash: _plRowContentHash(tsData[i])` | §1 |
| 9 | Code.gs | L286 getDetailLogsByMonth | logs.push 加 `rowHash: _plRowContentHash(tsData[i])` | §1 |

## 五入口通道覆盖矩阵（Tom 14:28 清单第 1 条）

| mutation 入口 | 部署位置 | uncertain 抛出点 | v6（前） | v7（本件） |
|---|---|---|---|---|
| submitBatch | Code.gs L386 | guard `_plGuardedInsert`（flush/bizWrite 两处） | 裸码 | 载荷进 message |
| updateTimesheet | Code.gs L460 | guard `_plOrchestrate` + 集成源码重抛 | 载荷 | 载荷（helper 移 guard） |
| softDeleteRecord | Code.gs L483 | guard `_plOrchestrate` + 集成源码重抛 | 载荷 | 载荷（helper 移 guard） |
| tsAppendRows | RemoteActions.gs L68 | guard `_plGuardedInsert` | 裸码 message（但 success-return JSON 已带 plCode/logFailed 字段） | 载荷进 message + JSON 不变 |
| tsPatchCells | RemoteActions.gs L138 | 集成源码 catch | 裸码 message 进 JSON error | 载荷进 message + JSON error 同契约 |

**新增填报（submitBatch）的客户端错误提示**：Index.html L697 `.withFailureHandler((e) => { _tsEndSave(); handleServerError(e); })` → plHumanMsg 三档渲染——v6 起已覆盖，v7 服务端补齐载荷后新增提交同样可区分登记真假（不再落「登记状态未知」兜底档）。

## 与服务端 v7 的契约对齐

- `_plUncertainPayloadMsg`/`_plSanitizeCause` 现位于 PeriodLockGuard.gs 定义层（guard 先部署、集成源码后部署，helper 不得依赖后部署文件——v6 的本地定义已移除，本文件直接调用）。
- tsAppendRows / tsPatchCells 的既有 success-return JSON（plCode/plCause/logFailed）schema 未改；tsPatchCells 的 `error` 字段现携带同一 `<码>|{...}` 载荷，远程工具调用方可用同一 plParseErr 解析。
- 本客户端（Index.html）不直接调用 tsAppendRows/tsPatchCells（grep 零命中），其 JSON 契约仅约束远程批量工具调用方。

## 照实登记的边界

1. **依赖**：Code.gs 两处调用 `_plRowContentHash`，该 helper 仅存于 PeriodLockGuard.gs——本 diff 的 Code.gs 必须与 guard 文件同批部署（runbook v3 阶段 1/2），单独上线会 ReferenceError。
2. **版本号未 bump**：APP_VERSION / TS_APP_VERSION 维持 4.3.72（本 diff 不改版本校验机制）。部署时是否 bump 以强制存量页面自动重载，由 Rita 部署时裁定；不 bump 时存量页面按 runbook §0「首次编辑被拒+提示刷新」路径收敛。
3. **渲染通道纯文本**：三档提示经 `alert()` 渲染（alert 为纯文本，不当 HTML 执行）——Tom 清单第 3 条「不把 cause 当 HTML」在当前实现中满足，照实登记。
4. **cause 消毒是收窄不是绝对**：当前全部 cause 来源均为服务端自构造文案或 GAS 服务异常 message，员工原始行内容不经 cause 传输；`_plSanitizeCause` 截断 200 字符 + 连续 24+ 位字母数字串打码，件中不宣称绝对防护。
5. **未经真实部署验证**：Node 环境跑不到 google.script.run 通道；plParseErr 的纯函数部分（含三档降级与白名单）已由测试件 X6/X12 从**本交付件实抽实测**，端到端（真实通道/界面渲染）只能在部署步骤 3 验证。
6. **本 diff 只含阶段 1/2 的客户端+只读侧**；mutation guard 五入口改后函数由 v7 集成源码件同批交付，不重复。
7. 零生产写：本件为本地副本编辑，未触碰任何线上文件。

## 验证记录（提交方报告，非执行证据）

- 9/9 处替换精确命中（每处断言恰好 1 次）；
- 行尾保持：Index.html CR-CR-LF 1174→1242（新增行全部同款行尾）、唯一裸 CRLF 行（L343 APP_VERSION）未动；Code.gs 584→585；
- 变更范围：Index.html +73/-5 行、Code.gs +3/-2 行，无清单外改动；
- JS 语法：两份改后文件过 node --check 均通过；
- 契约测试：period_lock_tests.js R/I/V/W/X 共 **92/92 通过 exit 0**，其中 X7-X9 实测 submitBatch 两路径载荷（登记成功 false/失败 true/flush 路径）、X10 实测 tsPatchCells JSON error 载荷、X11 实测消毒（截断+打码+JSON 往返）、X12 从本交付件 Index.html 实抽 plHumanMsg 实测白名单（PATCH 码三档 + 白名单外码不猜）。
