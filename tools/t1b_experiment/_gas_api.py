"""T1-B 阶段B 非生产实验 · Apps Script API 助手（只读/写均限于新建隔离项目，零生产数据）。

能力：token 刷新 / 建独立 GAS 项目 / 推代码 / 部署 API-executable（非 web app，无 /exec 链接）/ 远程执行函数。
不触碰主库(1oxPj0mz)/生产表(1Pi5u9fE)/任何现有部署，不新建任何填报入口链接。
"""
import json, time, urllib.request, urllib.parse

CLASPRC = r"C:/Users/rita.jin/.clasprc.json"
SCRIPT_API = "https://script.googleapis.com/v1/projects"
SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets"
TOKEN_URL = "https://oauth2.googleapis.com/token"


def _load_tokens():
    return json.load(open(CLASPRC, encoding="utf-8"))["tokens"]["default"]


def get_token():
    t = _load_tokens()
    now = time.time() * 1000
    if t.get("expiry_date", 0) > now + 60000:
        return t["access_token"]
    b = urllib.parse.urlencode({
        "client_id": t["client_id"], "client_secret": t["client_secret"],
        "refresh_token": t["refresh_token"], "grant_type": "refresh_token",
    }).encode()
    r = json.loads(urllib.request.urlopen(
        urllib.request.Request(TOKEN_URL, data=b, method="POST",
                              headers={"Content-Type": "application/x-www-form-urlencoded"}),
        timeout=30).read().decode())
    return r["access_token"]


def _req(method, url, data=None, token=None, timeout=90):
    token = token or get_token()
    headers = {"Authorization": "Bearer " + token,
               "Content-Type": "application/json"}
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    return json.loads(urllib.request.urlopen(req, timeout=timeout).read().decode())


def create_project(title):
    return _req("POST", SCRIPT_API, {"title": title})["scriptId"]


def push_content(script_id, files):
    # files: list of (name, type, source)
    f = [{"name": n, "type": tp, "source": src} for n, tp, src in files]
    return _req("PUT", f"{SCRIPT_API}/{script_id}/content", {"files": f})


def deploy_executable(script_id, version_number, desc="t1b-exp-api-exec"):
    """部署为可经 scripts.run 调用的版本（扁平结构，非 web app，不产生 /exec 填报链接）。
    API executable 的 access 默认 MYSELF，仅本令牌可调用。"""
    payload = {"description": desc, "manifestFileName": "appsscript",
               "versionNumber": version_number}
    r = _req("POST", f"{SCRIPT_API}/{script_id}/deployments", payload)
    return r.get("deploymentId")


def create_version(script_id, desc="exp-v1"):
    """为库项目建一个已发布版本（库必须被引用为具体版本号，version 0 不可用于部署消费）。"""
    r = _req("POST", f"{SCRIPT_API}/{script_id}/versions", {"description": desc})
    return r.get("versionNumber")


def delete_deployment(script_id, deployment_id):
    _req("DELETE", f"{SCRIPT_API}/{script_id}/deployments/{deployment_id}")
    return True


def delete_file(file_id):
    _req("DELETE", f"https://www.googleapis.com/drive/v3/files/{file_id}")
    return True


def list_deployments(script_id):
    r = _req("GET", f"{SCRIPT_API}/{script_id}/deployments?pageSize=50")
    return r.get("deployments", [])


def run(script_id, function, parameters=None, token=None):
    """scripts.run（Execution API）远程执行——用于并发触发两项目做负例。"""
    url = f"https://script.googleapis.com/v1/scripts/{script_id}:run"
    body = {"function": function,
            "parameters": parameters or [],
            "devMode": False}
    return _req("POST", url, body, token=token, timeout=120)


def create_sheet(title):
    """用 Drive API 新建隔离测试表（纯 dummy 数据，与生产无关）。"""
    url = "https://www.googleapis.com/drive/v3/files"
    data = {"name": title, "mimeType": "application/vnd.googleapis.com/spreadsheet"}
    r = _req("POST", url, data)
    # 仅用 Drive API（令牌无 spreadsheets 范围）；表内只用默认 Sheet1，不做 addSheet。
    return r["id"]
