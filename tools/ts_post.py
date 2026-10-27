#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""ts_post.py — 写入端客户端（对应 GAS 的 doPost / appendRows / patchCells）

用法:
  python tools/ts_post.py appendRows _tmp/_ts_restore_rows.json            # 真写
  python tools/ts_post.py appendRows _tmp/_ts_restore_rows.json --dry      # 演练
  python tools/ts_post.py patchCells _tmp/_ts_patch_cells.json             # 补类型列
  python tools/ts_post.py snapshot                                          # 写每日指纹

⚠️ Google Web App 对 POST 会先回 302，本脚本手动把同一份 body 再 POST 到 Location。
"""
import json, io, os, sys, urllib.parse, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
# 默认读脚本同目录的 .ts_selfcheck.json；隔离测试可用 TS_SELFCHECK 指向临时配置（默认不变）。
CFG = os.environ.get('TS_SELFCHECK', os.path.join(HERE, '.ts_selfcheck.json'))

# [A2] 清理期止血开关 —— 生产表 NO-GO 期间冻结一切写入动作。
# 默认冻结（不设环境变量即冻结）。确需写入须由 Rita 明确解除：
#   Windows PowerShell:  $env:TS_WRITE_FREEZE=0
#   Git Bash / Linux:    export TS_WRITE_FREEZE=0
TS_WRITE_FREEZE = os.environ.get('TS_WRITE_FREEZE', '1') == '1'
# snapshot 也一并冻结：它虽只往 _TS_SNAPSHOT 追加一行指纹（非业务数据），
# 但仍是生产写入；NO-GO 期间一律拦死。（已核实无任何自动任务调用本脚本）
WRITE_ACTIONS = ('appendRows', 'patchCells', 'snapshot', 'softDelGuarded')


def _assert_writable(action):
    if action in WRITE_ACTIONS and TS_WRITE_FREEZE:
        raise SystemExit(
            '[TS_WRITE_FREEZE] 写入已冻结：生产表处于 NO-GO 清理期。\n'
            '  被拦动作: %s\n'
            '  确需写入请先由 Rita 明确解除，再执行：\n'
            '    Git Bash   : export TS_WRITE_FREEZE=0\n'
            '    PowerShell : $env:TS_WRITE_FREEZE=0' % action
        )


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def post(url, payload, timeout=600):
    body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    opener = urllib.request.build_opener(_NoRedirect)
    hdrs = {'Content-Type': 'application/json; charset=utf-8'}
    req = urllib.request.Request(url, data=body, headers=hdrs, method='POST')
    try:
        r = opener.open(req, timeout=timeout)
        raw = r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        if e.code in (301, 302, 303, 307, 308):
            loc = e.headers.get('Location')
            if not loc:
                raise
            # GAS 特性：doPost 已在 302 前执行完毕，响应体挂在 Location 上，用 GET 取回
            # （第二次再 POST 会 405）
            r2 = opener.open(urllib.request.Request(loc, method='GET'), timeout=timeout)
            raw = r2.read().decode('utf-8', 'replace')
        else:
            raise
    # GAS 返回可能被包一层，尽量解析成 JSON
    try:
        return json.loads(raw)
    except Exception:
        return {'raw': raw[:2000]}


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    action = sys.argv[1]
    _assert_writable(action)          # [A2] 止血开关：写入动作默认拦死
    dry = '--dry' in sys.argv
    cfg = json.load(io.open(CFG, encoding='utf-8'))
    url, token = cfg['url'], cfg['token']

    if action == 'snapshot':
        payload = {'action': 'snapshot', 'token': token}
    else:
        pfile = sys.argv[2]
        data = json.load(io.open(pfile, encoding='utf-8'))
        payload = {'action': action, 'token': token}
        if action == 'appendRows':
            rows = data.get('rows', [])
            sys.stderr.write('待写入行数: %d\n' % len(rows))
            payload['rows'] = rows
            for k in ('force', 'sheet'):
                if k in data: payload[k] = data[k]
        elif action == 'patchCells':
            cells = data.get('cells', [])
            sys.stderr.write('待修改格数: %d\n' % len(cells))
            payload['cells'] = cells
            if 'sheet' in data: payload['sheet'] = data['sheet']
        else:
            payload.update(data)
        if dry:
            payload['dry'] = '1'

    sys.stderr.write('POST %s  action=%s dry=%s\n' % (url.split('/macros/')[0] + '/macros/...', action, dry))
    res = post(url, payload)
    try:
        if isinstance(res, dict):
            res.setdefault('_env', 'ts_post/1')   # 版本化信封：stdout 仅此一个 JSON，诊断全走 stderr
        out = json.dumps(res, ensure_ascii=False, indent=2)
    except Exception:
        out = json.dumps({'raw': str(res)[:4000], '_env': 'ts_post/1'}, ensure_ascii=False)
    sys.stdout.write(out)   # stdout 仅 JSON 信封，供调用方严格解析；诊断一律走 stderr（Tom 点1）
    try:
        rf = os.path.join(HERE, '_tmp', 'ts_post_last_response.json')
        os.makedirs(os.path.dirname(rf), exist_ok=True)
        io.open(rf, 'w', encoding='utf-8').write(out)
    except Exception:
        pass
    return 0


if __name__ == '__main__':
    sys.exit(main())
