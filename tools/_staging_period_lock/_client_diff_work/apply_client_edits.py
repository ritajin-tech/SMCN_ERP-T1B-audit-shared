#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
period-lock 客户端 diff 草案：对 _ts_head_live 副本应用 runbook v3 §1/§2 的全部改动
（v3 §2.5 错误传输接口契约：plParseErr 三档 + 载荷序列化解析）。
v7 追加：plHumanMsg 白名单精确匹配三个 PL_UNCERTAIN_* 码（Tom 14:28 清单第4条）。
只动 _client_diff_work/ 下的副本，零生产写。每处替换断言恰好命中一次。
"""
import io, sys

BASE = r"C:\Users\rita.jin\WorkBuddy\SMCN_ERP\tools\_staging_period_lock\_client_diff_work"

def load(name):
    with io.open(BASE + "\\" + name, "r", encoding="utf-8", newline="") as f:
        return f.read()

def save(name, text):
    with io.open(BASE + "\\" + name, "w", encoding="utf-8", newline="") as f:
        f.write(text)

def apply(text, old, new, tag):
    n = text.count(old)
    if n != 1:
        print("[FAIL] %s: 命中 %d 次（要求 1 次）" % (tag, n))
        sys.exit(1)
    print("[ok] %s" % tag)
    return text.replace(old, new, 1)

# ============ Index.html ============
h = load("Index.html")

# 1) 表单隐藏域（§2.1）
h = apply(h,
    '                <input type="hidden" name="uuid" id="editUuid">\r\r\n',
    '                <input type="hidden" name="uuid" id="editUuid">\r\r\n'
    '                <input type="hidden" name="expectContentHash" id="editHash">\r\r\n',
    "Index L157 隐藏域 editHash")

# 2) handleServerError：错误传输接口契约三档渲染（runbook v3 §2.5）
h = apply(h,
    '        function handleServerError(err) {\r\r\n'
    '            toggle(false);\r\r\n'
    '            const msg = err.message || String(err);\r\r\n'
    '            if (msg.includes("AUTH_FAILED")) {\r\r\n'
    '                localStorage.removeItem(\'ts_app_token\');\r\r\n'
    '                localStorage.removeItem(\'ts_login_time\');\r\r\n'
    '                alert(msg.split(":")[1]);\r\r\n'
    '                showAuth();\r\r\n'
    '            } else {\r\r\n'
    '                alert("Error: " + msg + "\\n\\nPlease refresh. / 请刷新页面。");\r\r\n'
    '            }\r\r\n'
    '        }\r\r\n',
    '        // period-lock（runbook v3 §2.5 错误传输接口契约）：三档渲染。\r\r\n'
    '        // 契约：google.script.run failure handler 只跨边界传 message 字符串，\r\r\n'
    '        // Error 自定义属性不随序列化（该跨边界行为未经实测，本契约不依赖）——\r\r\n'
    '        // 故服务端把 uncertain 态状态安全序列化进 message：\r\r\n'
    '        //   拒绝码 PL_REJECT_*：message=码本身，无载荷（拒绝时不登记，无状态可传）；\r\r\n'
    '        //   不确定态 PL_UNCERTAIN_*：message=<码>|{"logFailed":bool,"cause":"…"}。\r\r\n'
    '        // 解析以第一个 | 切分；载荷缺失/不可解析/logFailed 非布尔 → 登记状态未知档，\r\r\n'
    '        // 禁默认 false、禁称「已登记」。\r\r\n'
    '        // [审⑧-v7] 白名单：plHumanMsg 只对明确允许的三个 PL_UNCERTAIN_* 码\r\r\n'
    '        // 走三档（含 PL_UNCERTAIN_PATCH_WRITE_FAILED）；未知/损坏码不猜。\r\r\n'
    '        function plParseErr(msg) {\r\r\n'
    '            var s = String(msg || "");\r\r\n'
    '            var i = s.indexOf("|");\r\r\n'
    '            if (i < 0) return { code: s, logFailed: null, cause: "" };\r\r\n'
    '            var code = s.slice(0, i), payload = null;\r\r\n'
    '            try { payload = JSON.parse(s.slice(i + 1)); } catch (e) { payload = null; }\r\r\n'
    '            if (!payload || typeof payload.logFailed !== "boolean") {\r\r\n'
    '                return { code: code, logFailed: null, cause: "" };\r\r\n'
    '            }\r\r\n'
    '            return { code: code, logFailed: payload.logFailed, cause: String(payload.cause || "") };\r\r\n'
    '        }\r\r\n'
    '        var PL_MSG_MAP = [\r\r\n'
    '            ["PL_REJECT_MISSING_EXPECT_VERSION", "页面版本过旧，请刷新后重试（你的修改未保存）"],\r\r\n'
    '            ["PL_REJECT_CONTENT_VERSION", "这条记录已被他人修改过，请刷新页面后再编辑（你的修改未保存）"],\r\r\n'
    '            ["PL_REJECT_NEW_DATE_CLOSED", "2026-10-01 之前的期间已关账，不能新增/修改/删除（解锁请联系管理员）"],\r\r\n'
    '            ["PL_REJECT_ORIG_DATE_CLOSED", "2026-10-01 之前的期间已关账，不能新增/修改/删除（解锁请联系管理员）"],\r\r\n'
    '            ["PL_REJECT_FUTURE_CLOSED", "当前锁政策暂不接受该日期的写入，请刷新或联系管理员"],\r\r\n'
    '            ["PL_REJECT_ALREADY_DELETED", "这条记录已被删除，请刷新"],\r\r\n'
    '            ["PL_REJECT_LOCK_BUSY", "系统繁忙，请稍候重试（不要连续点击）"],\r\r\n'
    '            ["PL_REJECT_ROW_GONE", "记录状态异常，请刷新后重试"],\r\r\n'
    '            ["PL_REJECT_NO_UUID", "记录状态异常，请刷新后重试"],\r\r\n'
    '            ["PL_REJECT_UUID_NOT_UNIQUE", "记录状态异常，请刷新后重试"],\r\r\n'
    '            ["PL_REJECT_OWNER_MISMATCH", "记录状态异常，请刷新后重试"],\r\r\n'
    '            ["PL_REJECT_ORIG_UNKNOWN", "记录状态异常，请刷新后重试"],\r\r\n'
    '            ["PL_REJECT_BAD_NEW_DATE", "记录状态异常，请刷新后重试"]\r\r\n'
    '        ];\r\r\n'
    '        function plHumanMsg(msg) {\r\r\n'
    '            var p = plParseErr(msg);\r\r\n'
    '            var code = p.code;\r\r\n'
    '            // [审⑧-v7] 白名单精确匹配（Tom 14:28 清单第4条）：只接受明确\r\r\n'
    '            // 允许的 uncertain 码，不用前缀猜；未知/损坏码不进三档\r\r\n'
    '            var PL_UNCERTAIN_CODES = ["PL_UNCERTAIN_BIZ_WRITE_FAILED", "PL_UNCERTAIN_FLUSH_FAILED", "PL_UNCERTAIN_PATCH_WRITE_FAILED"];\r\r\n'
    '            var isUncertain = PL_UNCERTAIN_CODES.indexOf(code) >= 0;\r\r\n'
    '            if (isUncertain) {\r\r\n'
    '                if (p.logFailed === true) {\r\r\n'
    '                    return "系统状态不确定，且未能登记待核查；请刷新确认你的修改是否生效，不要重复提交，并联系管理员补登记";\r\r\n'
    '                }\r\r\n'
    '                if (p.logFailed === false) {\r\r\n'
    '                    return "系统状态不确定，已登记待核查；请刷新确认你的修改是否生效，不要重复提交";\r\r\n'
    '                }\r\r\n'
    '                return "系统状态不确定，登记状态未知；请刷新确认你的修改是否生效，不要重复提交，并联系管理员核查";\r\r\n'
    '            }\r\r\n'
    '            for (var i = 0; i < PL_MSG_MAP.length; i++) {\r\r\n'
    '                if (code.indexOf(PL_MSG_MAP[i][0]) >= 0) return PL_MSG_MAP[i][1];\r\r\n'
    '            }\r\r\n'
    '            return null;\r\r\n'
    '        }\r\r\n'
    '        function handleServerError(err) {\r\r\n'
    '            toggle(false);\r\r\n'
    '            const msg = err.message || String(err);\r\r\n'
    '            if (msg.includes("AUTH_FAILED")) {\r\r\n'
    '                localStorage.removeItem(\'ts_app_token\');\r\r\n'
    '                localStorage.removeItem(\'ts_login_time\');\r\r\n'
    '                alert(msg.split(":")[1]);\r\r\n'
    '                showAuth();\r\r\n'
    '            } else {\r\r\n'
    '                const human = plHumanMsg(msg);\r\r\n'
    '                alert(human ? human + "\\n\\n" + msg : "Error: " + msg + "\\n\\nPlease refresh. / 请刷新页面。");\r\r\n'
    '            }\r\r\n'
    '        }\r\r\n',
    "Index L451 handleServerError 契约三档")

# 3) del：null 行禁删 + 第三参 rowHash（§2.3）
h = apply(h,
    '        function del(id) { \r\r\n'
    '            if(confirm(\'Delete this record? / 确定删除该条记录？\')) { \r\r\n'
    '                toggle(true); \r\r\n'
    '                google.script.run\r\r\n'
    '                    .withSuccessHandler(() => init())\r\r\n'
    '                    .withFailureHandler(handleServerError)\r\r\n'
    '                    .softDeleteRecord(currentToken, id); \r\r\n'
    '            } \r\r\n'
    '        }\r\r\n',
    '        function del(id) { \r\r\n'
    '            const log = currentLogs.find(l => String(l.uuid) === String(id));\r\r\n'
    '            if (!log || !log.rowHash) { alert(\'该记录含特殊字符无法校验版本，请联系管理员 / This record cannot be version-checked, please contact admin\'); return; }\r\r\n'
    '            if(confirm(\'Delete this record? / 确定删除该条记录？\')) { \r\r\n'
    '                toggle(true); \r\r\n'
    '                google.script.run\r\r\n'
    '                    .withSuccessHandler(() => init())\r\r\n'
    '                    .withFailureHandler(handleServerError)\r\r\n'
    '                    .softDeleteRecord(currentToken, id, log.rowHash); \r\r\n'
    '            } \r\r\n'
    '        }\r\r\n',
    "Index L647 del 第三参+禁行")

# 4) editRow：null 行禁编辑 + editHash 填充（§2.1）
h = apply(h,
    '        function editRow(uuid) { \r\r\n'
    '            const log = currentLogs.find(l => String(l.uuid) === String(uuid)); if(!log) return;\r\r\n'
    '            document.getElementById(\'editUuid\').value = log.uuid; \r\r\n',
    '        function editRow(uuid) { \r\r\n'
    '            const log = currentLogs.find(l => String(l.uuid) === String(uuid)); if(!log) return;\r\r\n'
    '            if (!log.rowHash) { alert(\'该记录含特殊字符无法校验版本，请联系管理员 / This record cannot be version-checked, please contact admin\'); return; }\r\r\n'
    '            document.getElementById(\'editUuid\').value = log.uuid; \r\r\n'
    '            document.getElementById(\'editHash\').value = log.rowHash || \'\'; \r\r\n',
    "Index L657 editRow 禁行+填hash")

# 5) cancelEdit：清空 editHash（§2.1）
h = apply(h,
    '            document.getElementById(\'timeForm\').reset(); document.getElementById(\'inputDate\').valueAsDate = new Date(); \r\r\n'
    '            document.getElementById(\'editUuid\').value = ""; document.getElementById(\'canBtn\').style.display = \'none\'; \r\r\n',
    '            document.getElementById(\'timeForm\').reset(); document.getElementById(\'inputDate\').valueAsDate = new Date(); \r\r\n'
    '            document.getElementById(\'editUuid\').value = ""; document.getElementById(\'editHash\').value = ""; document.getElementById(\'canBtn\').style.display = \'none\'; \r\r\n',
    "Index L669 cancelEdit 清hash")

# 6) saveBatchEdit：expectContentHash + null 行禁编辑（§2.2）
h = apply(h,
    '            const f = {\r\r\n'
    '                uuid: uuid,\r\r\n'
    '                date: document.getElementById(\'ed_\' + sid + \'_date\').value,\r\r\n'
    '                project: formatBatchPid(document.getElementById(\'ed_\' + sid + \'_pid\').value),\r\r\n'
    '                stage: document.getElementById(\'ed_\' + sid + \'_stage\').value,\r\r\n'
    '                hours: document.getElementById(\'ed_\' + sid + \'_hours\').value,\r\r\n'
    '                notes: document.getElementById(\'ed_\' + sid + \'_notes\').value\r\r\n'
    '            };\r\r\n',
    '            const batchLog = batchCurrentLogs.find(l => String(l.uuid) === String(uuid));\r\r\n'
    '            if (!batchLog || !batchLog.rowHash) { alert(\'该记录含特殊字符无法校验版本，请联系管理员 / This record cannot be version-checked, please contact admin\'); return; }\r\r\n'
    '            const f = {\r\r\n'
    '                uuid: uuid,\r\r\n'
    '                date: document.getElementById(\'ed_\' + sid + \'_date\').value,\r\r\n'
    '                project: formatBatchPid(document.getElementById(\'ed_\' + sid + \'_pid\').value),\r\r\n'
    '                stage: document.getElementById(\'ed_\' + sid + \'_stage\').value,\r\r\n'
    '                hours: document.getElementById(\'ed_\' + sid + \'_hours\').value,\r\r\n'
    '                notes: document.getElementById(\'ed_\' + sid + \'_notes\').value,\r\r\n'
    '                expectContentHash: batchLog.rowHash || \'\'\r\r\n'
    '            };\r\r\n',
    "Index L1147 saveBatchEdit expectContentHash")

# 7) delBatchRow：null 行禁删 + 第三参 rowHash（§2.4）
h = apply(h,
    '        function delBatchRow(uuid) {\r\r\n'
    '            if (!confirm(\'Delete this record? / 确定删除该条记录？\')) return;\r\r\n'
    '            toggle(true, \'Deleting... / 删除中...\');\r\r\n'
    '            google.script.run\r\r\n'
    '                .withSuccessHandler(() => { toggle(false); loadBatchMonth(); })\r\r\n'
    '                .withFailureHandler(handleServerError)\r\r\n'
    '                .softDeleteRecord(currentToken, uuid);\r\r\n'
    '        }\r\r\n',
    '        function delBatchRow(uuid) {\r\r\n'
    '            const batchLog = batchCurrentLogs.find(l => String(l.uuid) === String(uuid));\r\r\n'
    '            if (!batchLog || !batchLog.rowHash) { alert(\'该记录含特殊字符无法校验版本，请联系管理员 / This record cannot be version-checked, please contact admin\'); return; }\r\r\n'
    '            if (!confirm(\'Delete this record? / 确定删除该条记录？\')) return;\r\r\n'
    '            toggle(true, \'Deleting... / 删除中...\');\r\r\n'
    '            google.script.run\r\r\n'
    '                .withSuccessHandler(() => { toggle(false); loadBatchMonth(); })\r\r\n'
    '                .withFailureHandler(handleServerError)\r\r\n'
    '                .softDeleteRecord(currentToken, uuid, batchLog.rowHash);\r\r\n'
    '        }\r\r\n',
    "Index L1166 delBatchRow 第三参+禁行")

save("Index.html", h)

# ============ Code.gs ============
c = load("Code.gs")

# 8) getDashboardData log 对象加 rowHash（§1 · Code.gs L250）
c = apply(c,
    '    let log = { uuid: safeGetUuid(tsData[i][8]), date: Utilities.formatDate(rowDate, "GMT+8", "yyyy-MM-dd"), stage: tsData[i][4], project: tsData[i][5], hours: parseFloat(tsData[i][6]) || 0, notes: tsData[i][7] };\r\r\n',
    '    let log = { uuid: safeGetUuid(tsData[i][8]), date: Utilities.formatDate(rowDate, "GMT+8", "yyyy-MM-dd"), stage: tsData[i][4], project: tsData[i][5], hours: parseFloat(tsData[i][6]) || 0, notes: tsData[i][7], rowHash: _plRowContentHash(tsData[i]) };\r\r\n',
    "Code L250 getDashboardData rowHash")

# 9) getDetailLogsByMonth logs.push 加 rowHash（§1 · Code.gs L286-287）
c = apply(c,
    '    logs.push({\r\r\n'
    '      uuid: safeGetUuid(tsData[i][8]),\r\r\n'
    '      date: Utilities.formatDate(rowDate, "GMT+8", "yyyy-MM-dd"),\r\r\n'
    '      stage: tsData[i][4],\r\r\n'
    '      project: tsData[i][5],\r\r\n'
    '      hours: parseFloat(tsData[i][6]) || 0,\r\r\n'
    '      notes: tsData[i][7]\r\r\n'
    '    });\r\r\n',
    '    logs.push({\r\r\n'
    '      uuid: safeGetUuid(tsData[i][8]),\r\r\n'
    '      date: Utilities.formatDate(rowDate, "GMT+8", "yyyy-MM-dd"),\r\r\n'
    '      stage: tsData[i][4],\r\r\n'
    '      project: tsData[i][5],\r\r\n'
    '      hours: parseFloat(tsData[i][6]) || 0,\r\r\n'
    '      notes: tsData[i][7],\r\r\n'
    '      rowHash: _plRowContentHash(tsData[i])\r\r\n'
    '    });\r\r\n',
    "Code L286 getDetailLogsByMonth rowHash")

save("Code.gs", c)
print("ALL 9 EDITS OK")
