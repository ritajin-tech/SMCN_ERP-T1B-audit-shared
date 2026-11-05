# v72 独立复算脚本（只读；不写任何生产/主库数据；不要求采信我方结论）
# 用法：python3 recheck_v72.py   （在本目录运行；依赖同目录 S1/S2 原始件 + 上级 v71_preservation 的 S3 JSON）
import csv, json, hashlib, collections, os, re
D=os.path.dirname(os.path.abspath(__file__))
def rd(p):
    with open(p,encoding='utf-8-sig',newline='') as f: return [[(c or '').strip() for c in r] for r in csv.reader(f)]
def nm(rows,n=18): return [(r+['']*n)[:n] for r in rows]
s1=nm(rd(os.path.join(D,'S1_raw_prod_20261104_0835.csv')))
s2=nm(rd(os.path.join(D,'S2_raw_prod_20261105_0838.csv')))
s3p=os.path.join(D,'..','v71_preservation','_raw_prod_full_20261105_2200.json')
s3=nm([[('' if c is None else str(c)).strip() for c in r] for r in json.load(open(s3p,encoding='utf-8'))['result']['values']])
def real(rows): return [r for r in rows[1:] if any(c for c in r)]
r1,r2,r3=real(s1),real(s2),real(s3)
print("空占位行: S1=%d S2=%d S3=%d"%(len(s1)-1-len(r1),len(s2)-1-len(r2),len(s3)-1-len(r3)))
def cnt(rows,cols): return collections.Counter(tuple(r[j] for j in cols) for r in rows)
for lab,cols in [("前15列",range(15)),("全18列",range(18))]:
    c2,c3=cnt(r2,cols),cnt(r3,cols)
    print("S2->S3 [%s] 仅S2=%d 仅S3=%d"%(lab,sum((c2-c3).values()),sum((c3-c2).values())))
def us(rows,name):
    u=[r[8] for r in rows]; ne=[x for x in u if x]
    nu=[x.upper().replace(' ','') for x in ne]
    bad=[x for x in nu if not re.fullmatch(r'TS-[0-9A-F]{12}',x)]
    print("%s 真实行=%d 空UUID=%d 非空=%d 重复(额外行)=%d 格式不符=%d 归一后重复=%d"%(
        name,len(rows),len(u)-len(ne),len(ne),len(ne)-len(set(ne)),len(bad),len(nu)-len(set(nu))))
us(r2,'S2'); us(r3,'S3')
print("行数守恒: %d + 17 = %d vs S3 %d"%(len(r2),len(r2)+17,len(r3)))
set2=set(r[8] for r in r2 if r[8])
added=[r for r in r3 if r[8] and r[8] not in set2]
print("仅S3新增行=%d"%len(added))
for r in added:
    print("  sha256=%s A=%s B=%s O=%r"%(hashlib.sha256('\x1f'.join(r).encode('utf-8')).hexdigest()[:16],r[0][:24],r[1][:10],r[14]))
m1={r[8]:r for r in r1 if r[8]}; m2={r[8]:r for r in r2 if r[8]}
com=set(m1)&set(m2)
print("S1->S2 共同UUID=%d A改写=%d B改写=%d C:R改写=%d 新增=%d 消失=%d"%(
    len(com),sum(m1[u][0]!=m2[u][0] for u in com),sum(m1[u][1]!=m2[u][1] for u in com),
    sum(any(m1[u][j]!=m2[u][j] for j in range(2,18)) for u in com),
    len(set(m2)-set(m1)),len(set(m1)-set(m2))))
