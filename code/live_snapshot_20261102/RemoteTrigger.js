// ============================================================
// RemoteTrigger.gs  v1.0  —  SMCN 标准化「手机远程触发」helper
// ------------------------------------------------------------
// 让任意 GAS 项目获得手机/云端 Web App 触发能力（复制到项目根即可）。
//
// 接入步骤：
//   1) 复制本文件到项目根目录
//   2) 新建 RemoteActions.gs，定义：
//        var REMOTE_ACTIONS = {
//          myaction: function(){ /* ... */ return "完成提示"; }
//        };
//        function doGet(e){
//          var r = _rtMaybeHandle(e); if (r) return r;   // ← 接管远程触发
//          /* 你原本的 doGet 逻辑（没有就返回状态 JSON） */
//        }
//      （若项目已有 doGet，把第一行改成调用 _rtMaybeHandle 即可，原逻辑放后面）
//   3) 在 onOpen 菜单加：.addItem('生成手机远程链接','showRemoteTriggerLinks')
//   4) 部署为 Web App（执行身份=我；访问=仅自己 或 任何人/匿名）
//
// 安全：首跑自动生成 REMOTE_TOKEN 存 Script Properties；调用须带 ?token=
// 触发：<WEBAPP_URL>?action=<动作>&token=<token>
//       内置动作：status（看状态）、_seturl（注册真实 URL，供菜单显示）
// ============================================================
var RT_VERSION = "RT1.0";

// 👇 REMOTE_WEBAPP_URL 由各系统的 RemoteActions.gs 定义（部署后的真实 Web App URL）。
//    运行时优先读取 Script Properties REMOTE_WEBAPP_URL（由 ?action=_seturl 写入，可热更新），
//    其次取本常量，最后才用 scriptId 推导（仅供示意，scriptId ≠ 部署ID，需校正）。
//    故此处不再声明该变量，避免与 RemoteActions.gs 的赋值冲突。

/**
 * 核心分发。返回 ContentService 响应；若无 action 参数则返回 null（调用方继续原有逻辑）。
 */
function _rtMaybeHandle(e) {
  e = e || {};
  var action = String(e.parameter.action || "").toLowerCase();
  if (!action) return null;

  var props = PropertiesService.getScriptProperties();
  var expected = props.getProperty("REMOTE_TOKEN");
  var isFirstRun = false;
  if (!expected) {
    expected = "SMCN-" + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd") + "-" + _rtMakeShortToken(6);
    props.setProperty("REMOTE_TOKEN", expected);
    isFirstRun = true;
  }

  var ts = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");
  var token = String(e.parameter.token || "");

  if (token !== expected) {
    var errObj = {
      ok: false,
      error: "Invalid or missing token",
      hint: isFirstRun ? "Token initialized on first run. Open sheet menu '📱 生成手机远程链接' to view it." : undefined,
      ts: ts
    };
    // 首跑时一次性把刚生成的 token 回显，便于手机/云端首次配置（之后不再泄露）
    // FIX 2026-10-13: 首跑不再把 token 明文回显。
    //   原逻辑 if (isFirstRun) errObj.token = expected 在 ANYONE_ANONYMOUS 部署下，等于把长期 token
    //   送给任何拿到 URL 的匿名请求者 —— 随后即可获得 readRange / appendRows / patchCells / purgeRows
    //   的完整读写权。现在 token 一律通过菜单「📱 生成手机远程链接」给已登录的本人查看。
    return _rtResponse(errObj);
  }

  var result = { ok: true, action: action, version: RT_VERSION, ts: ts };
  try {
    if (action === "status") {
      result.message = "ok";
      result.actions = _rtActionList();
    } else if (action === "_seturl") {
      var u = String(e.parameter.url || "").trim();
      if (u) { props.setProperty("REMOTE_WEBAPP_URL", u); result.message = "REMOTE_WEBAPP_URL saved"; }
      else { result.ok = false; result.error = "missing url param"; }
    } else if (typeof REMOTE_ACTIONS === "object") {
      // 大小写不敏感查找：分发器早期把 action .toLowerCase()，但 REMOTE_ACTIONS 键是混合大小写
      // (checkLeaves/syncLeaves/cleanupLeaves/setupAmy/testAmySelf)，直接查会全部 miss。线性找一次即可。
      var _rtKey = null;
      for (var _k in REMOTE_ACTIONS) {
        if (String(_k).toLowerCase() === action && typeof REMOTE_ACTIONS[_k] === "function") { _rtKey = _k; break; }
      }
      if (_rtKey) {
        var out = REMOTE_ACTIONS[_rtKey](e);
        if (out !== undefined && out !== null) result.message = String(out);
      } else {
        result.message = "unknown action: " + action + ". available: " + _rtActionList().join(", ");
      }
    } else {
      result.message = "unknown action: " + action + ". available: " + _rtActionList().join(", ");
    }
  } catch (err) {
    result.ok = false;
    result.error = err.message;
  }
  return _rtResponse(result);
}

/** 列出所有可用动作（含内置）。 */
function _rtActionList() {
  var list = ["status", "_seturl"];
  if (typeof REMOTE_ACTIONS === "object") {
    for (var k in REMOTE_ACTIONS) {
      if (typeof REMOTE_ACTIONS[k] === "function" && list.indexOf(k) < 0) list.push(k);
    }
  }
  return list;
}

/**
 * V4.3.62 POST 分发 —— 与 _rtMaybeHandle 共用同一套 token 校验与动作分发，
 * 额外把解析后的 JSON body 挂在 e.postBody 上供动作函数读取（appendRows / patchCells 用）。
 * 返回 ContentService 响应；body 无 action 时返回 null（调用方继续原有逻辑）。
 */
function _rtMaybeHandlePost(e) {
  e = e || {};
  var body = {};
  try {
    if (e.postData && e.postData.contents) body = JSON.parse(e.postData.contents);
    else if (e.parameter && e.parameter.payload) body = JSON.parse(e.parameter.payload);
  } catch (err) {
    return _rtResponse({ ok: false, error: 'invalid JSON body: ' + ((err && err.message) || err) });
  }
  var action = String(body.action || (e.parameter && e.parameter.action) || '').toLowerCase();
  if (!action) return null;

  var params = {};
  var src = e.parameter || {};
  for (var k in src) params[k] = src[k];
  for (var k2 in body) { if (typeof body[k2] !== 'object') params[k2] = body[k2]; }
  params.action = action;
  if (!params.token && body.token) params.token = body.token;

  return _rtMaybeHandle({ parameter: params, postBody: body });
}

/** 统一 JSON 响应。 */
function _rtResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** 生成短随机 token 后缀。 */
function _rtMakeShortToken(len) {
  var chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  var out = "";
  for (var i = 0; i < len; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

/**
 * 菜单入口：显示当前 Web App URL + 各 action 的完整远程触发链接。
 * URL 优先取 Script Properties REMOTE_WEBAPP_URL（部署后由 _seturl 写入），
 * 其次取本文件常量 REMOTE_WEBAPP_URL，最后用 scriptId 推导（示意，需校正）。
 */
function showRemoteTriggerLinks() {
  var ui = SpreadsheetApp.getUi();
  if (!ui) return;
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty("REMOTE_TOKEN");
  if (!token) {
    token = "SMCN-" + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd") + "-" + _rtMakeShortToken(6);
    props.setProperty("REMOTE_TOKEN", token);
  }
  var url = props.getProperty("REMOTE_WEBAPP_URL") || REMOTE_WEBAPP_URL ||
            ("https://script.google.com/a/macros/spacematrix.com/s/" + ScriptApp.getScriptId() + "/exec");
  var actions = _rtActionList().filter(function(a) { return a !== "_seturl"; });
  var links = "";
  actions.forEach(function(a) {
    var u = url + "?action=" + a + "&token=" + token;
    links += '<p><b>' + a + ':</b><br><a href="' + u + '" target="_blank">' + u + '</a></p>';
  });
  var html = '<h3>📱 SMCN 远程触发链接</h3>' +
    '<p><b>Web App URL:</b><br><code>' + url + '</code></p>' +
    '<p><b>Token:</b> <code>' + token + '</code></p><hr>' + links +
    '<p style="color:#666;font-size:12px;">把常用链接收藏到手机浏览器书签，或发给 WorkBuddy 手机端。' +
    'Token 存在 Script Properties，换设备也通用。如菜单链接打不开，说明 Web App URL 未校正，' +
    '点一次「部署」后在手机或电脑执行一次 <code>?action=_seturl&url=&lt;真实URL&gt;</code> 即可。</p>';
  ui.showModalDialog(HtmlService.createHtmlOutput(html).setWidth(700).setHeight(480), '📱 远程触发链接');
}
