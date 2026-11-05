# v73 独立复算脚本（只读；不写任何生产/主库数据；不要求采信我方结论）
# 用法：在 evidence/v73_preservation 目录运行  python3 recheck_v73.py
import csv, json, hashlib, collections, os, re
D=os.path.dirname(os.path.abspath(__file__))
D72=os.path.join(D,'..','v72_preservation')
D71=os.path.join(D,'..','v71_preservation')
def rd(p):
    with open(p,encoding='utf-8-sig',newline='') as f: return [[(c or '').strip() for c in r] for r in csv.reader(f)]
def nm(rows,n=18): return [(r+['']*n)[:n] for r in rows]
def real(rows): return [r for r in rows[1:] if any(c for c in r)]
def sha(p): return hashlib.sha256(open(p,'rb').read()).hexdigest()
p1=os.path.join(D72,'S1_raw_prod_20261104_0835.csv'); p2=os.path.join(D72,'S2_raw_prod_20261105_0838.csv')
p3=os.path.join(D71,'_raw_prod_full_20261105_2200.json')
print('S1 sha256',sha(p1)); print('S2 sha256',sha(p2))
s1=nm(rd(p1)); s2=nm(rd(p2))
s3=nm([[('' if c is None else str(c)).strip() for c in r] for r in json.load(open(p3,encoding='utf-8'))['result']['values']])
r1,r2,r3=real(s1),real(s2),real(s3)
print('真实行 S1=%d S2=%d S3=%d  空占位 S1=%d S2=%d S3=%d'%(len(r1),len(r2),len(r3),len(s1)-1-len(r1),len(s2)-1-len(r2),len(s3)-1-len(r3)))
# R1 行位置
n=min(len(r1),len(r2))
print('R1 行位置  A=%d B=%d'%(sum(r1[i][0]!=r2[i][0] for i in range(n)),sum(r1[i][1]!=r2[i][1] for i in range(n))))
# R2 UUID 键 dict 覆盖
m1={r[8]:r for r in r1 if r[8]}; m2={r[8]:r for r in r2 if r[8]}; com=set(m1)&set(m2)
print('R2 UUID键 共同=%d A=%d B=%d'%(len(com),sum(m1[u][0]!=m2[u][0] for u in com),sum(m1[u][1]!=m2[u][1] for u in com)))
# R3 UUID 键 + 序号
def grp(rows):
    g=collections.defaultdict(list)
    for r in rows:
        if r[8]: g[r[8]].append(r)
    return g
g1,g2=grp(r1),grp(r2); a=b=0
for k in set(g1)&set(g2):
    L1,L2=g1[k],g2[k]
    for i in range(min(len(L1),len(L2))):
        a+=L1[i][0]!=L2[i][0]; b+=L1[i][1]!=L2[i][1]
print('R3 键+序号  A=%d B=%d'%(a,b))
# R4 全18列多重集
def cnt(rows,cols): return collections.Counter(tuple(r[j] for j in cols) for r in rows)
c1,c2=cnt(r1,range(18)),cnt(r2,range(18))
print('R4 全18列差集 仅S1=%d 仅S2=%d'%(sum((c1-c2).values()),sum((c2-c1).values())))
# S2->S3 全18列
c3=cnt(r3,range(18))
print('S2->S3 全18列 仅S2=%d 仅S3=%d'%(sum((c2-c3).values()),sum((c3-c2).values())))
# V8 四类格式（原值，不归一）
TS=re.compile(r'^TS-[0-9A-Fa-f]{12}$'); GUID=re.compile(r'^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$')
def fmt(x):
    if TS.fullmatch(x): return 'TS-12HEX'
    if GUID.fullmatch(x): return '36-GUID'
    if x.startswith('TS-RESTORE-'): return 'TS-RESTORE-*'
    if x.startswith('TS-R0907-TS-'): return 'TS-R0907-TS-*'
    return '其他'
for name,rows in [('S1',r1),('S2',r2),('S3',r3)]:
    u=[r[8] for r in rows]; ne=[x for x in u if x]
    fc=collections.Counter(fmt(x) for x in ne); c=collections.Counter(ne)
    dup={k:v for k,v in c.items() if v>1}
    print('%s 空=%d 格式=%s 重复键=%d 额外行=%d'%(name,len(u)-len(ne),dict(fc),len(dup),sum(dup.values())-len(dup)))
