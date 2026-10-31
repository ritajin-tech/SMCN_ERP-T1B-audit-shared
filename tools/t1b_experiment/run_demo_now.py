"""阶段B 实证编排（最终）：部署临时 web app(ANYONE_ANONYMOUS,跑完即删) -> 并行触发两独立写者做并发负例 -> 回读日志证据 -> 删部署(净零链接)。
纯非生产；不碰主库/生产表；不充当任何正式入口。"""
import json, time, threading, urllib.request, sys
sys.path.insert(0, __import__('os').path.dirname(__import__('os').path.abspath(__file__)))
import _gas_api as G

EXP_TITLE = "T1B_EXP_NONPROD_20261031_v2"


def read_file(p):
    return open(p, encoding="utf-8").read()


def fire(url, timeout=60):
    try:
        return urllib.request.urlopen(url, timeout=timeout).read().decode()
    except Exception as e:
        return "ERR:" + str(e)[:200]


def main():
    ids = json.load(open("ids.json"))
    A, B, sid, LIB = ids["A"], ids["B"], ids["sheet"], ids["lib"]

    # 重新推 writer 代码（含 doGet/webapp manifest），建 v2，部署 web app
    manifest = json.dumps({
        "timeZone": "Asia/Shanghai",
        "dependencies": {"libraries": [
            {"userSymbol": "SharedLockLib", "libraryId": LIB, "version": "1"}]},
        "webapp": {"access": "ANYONE_ANONYMOUS", "executeAs": "USER_DEPLOYING"},
        "exceptionLogging": "STACKDRIVER"}, ensure_ascii=False)
    ev = {"sheet": sid, "lib": LIB, "A": A, "B": B, "deployments": {}, "runs": {}}
    for name, s in (("A", A), ("B", B)):
        G.push_content(s, [("Code", "SERVER_JS", read_file("writer_Code.js")),
                           ("appsscript", "JSON", manifest)])
        v = G.create_version(s, "exp-v2")
        dep = G.deploy_executable(s, v, "t1b-exp-webapp")
        exec_url = "https://script.google.com/macros/s/%s/exec" % dep
        ev["deployments"][name] = {"version": v, "deploymentId": dep,
                                   "execUrl": exec_url}
        print("  %s webapp %s -> %s" % (name, dep, exec_url))

    def run_pair(mode_label, useShared):
        ua = "1" if useShared else "0"
        tA = "https://script.google.com/macros/s/%s/exec?mode=run&useShared=%s&sleep=4000&name=writerA&ssId=%s" % (
            ev["deployments"]["A"]["deploymentId"], ua, sid)
        tB = "https://script.google.com/macros/s/%s/exec?mode=run&useShared=%s&sleep=4000&name=writerB&ssId=%s" % (
            ev["deployments"]["B"]["deploymentId"], ua, sid)
        res = {}
        def go(k, u):
            res[k] = fire(u, 30)
        th1 = threading.Thread(target=go, args=("A", tA))
        th2 = threading.Thread(target=go, args=("B", tB))
        th1.start(); th2.start(); th1.join(); th2.join()
        ev["runs"][mode_label] = res
        return res

    print("[4/5] 运行实证...")
    # 经 web app 初始化 config（freeze=0）
    fire(ev["deployments"]["A"]["execUrl"] + "?mode=setfreeze&val=0&ssId=" + sid)
    time.sleep(2)

    print("  · Mode=own（各自锁，预期不互斥/重叠）...")
    run_pair("own", False)
    time.sleep(6)
    print("  · Mode=shared（共享库锁，预期互斥/串行）...")
    run_pair("shared", True)
    time.sleep(6)

    # guardTest：freeze=1 应 PERIOD_LOCKED（E3 单一受信源）
    print("  · guardTest（freeze=1 应 PERIOD_LOCKED）...")
    fire(ev["deployments"]["A"]["execUrl"] + "?mode=setfreeze&val=1&ssId=" + sid)
    time.sleep(1)
    g1 = fire(ev["deployments"]["A"]["execUrl"] + "?mode=guard&ssId=" + sid)
    fire(ev["deployments"]["A"]["execUrl"] + "?mode=setfreeze&val=0&ssId=" + sid)
    time.sleep(1)
    g0 = fire(ev["deployments"]["A"]["execUrl"] + "?mode=guard&ssId=" + sid)
    ev["runs"]["guard"] = {"freeze1": g1.strip(), "freeze0": g0.strip()}

    # 回读日志证据
    logA = fire(ev["deployments"]["A"]["execUrl"] + "?mode=read&ssId=" + sid)
    ev["log"] = logA[:4000]

    # 删 web app 部署（净零持久链接）
    print("[5/5] 删除 web app 部署（净零链接）...")
    for name, s in (("A", A), ("B", B)):
        dep = ev["deployments"][name]["deploymentId"]
        try:
            G.delete_deployment(s, dep)
            print("  deleted", name, dep)
        except Exception as e:
            print("  del-fail", name, str(e)[:150])

    json.dump(ev, open("experiment_evidence.json", "w"), ensure_ascii=False, indent=2)
    print("=== EVIDENCE ===")
    print(json.dumps(ev, ensure_ascii=False, indent=2)[:3500])


if __name__ == "__main__":
    main()
