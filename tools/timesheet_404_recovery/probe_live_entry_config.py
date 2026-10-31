import json, time, urllib.request, urllib.parse
CLASPRC = r"C:/Users/rita.jin/.clasprc.json"
SID = "1FPAwV50VdpI2AGT42rfn6JhU0assY1QaARbhTQeiUKS0mZ66yf_JRb8R"
DEP = "AKfycbzUyhyK-tqL7ypp2H2jZXNCMciEr2PJwhkZIg0bwV1OwV2C6D9RKJZhA4HpiUi6F5eF"
def tok():
    d=json.load(open(CLASPRC,encoding="utf-8")); t=d["tokens"]["default"]; now=time.time()*1000
    if t.get("expiry_date",0)>now+60000: return t["access_token"]
    b=urllib.parse.urlencode({"client_id":t["client_id"],"client_secret":t["client_secret"],"refresh_token":t["refresh_token"],"grant_type":"refresh_token"}).encode()
    r=json.loads(urllib.request.urlopen(urllib.request.Request("https://oauth2.googleapis.com/token",data=b,method="POST",headers={"Content-Type":"application/x-www-form-urlencoded"}),timeout=30).read().decode())
    return r["access_token"]
def gj(u,t): 
    req=urllib.request.Request(u,headers={"Authorization":"Bearer "+t})
    return json.loads(urllib.request.urlopen(req,timeout=60).read().decode())
t=tok()
d=gj("https://script.googleapis.com/v1/projects/%s/deployments/%s"%(SID,DEP),t)
print(json.dumps(d.get("entryPoints",[]),ensure_ascii=False,indent=2))
