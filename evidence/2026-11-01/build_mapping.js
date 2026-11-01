const fs=require('fs');
const j=JSON.parse(fs.readFileSync('_tmp/evidence/controlled_audit_EXACT_ALL_2026-11-01.json','utf8'));
const meta=j.meta, src=meta.source, sm=src.scanMeta;
const safe=(j.detail&&j.detail.safe)||[];
const nib=(j.detail&&j.detail.notInBase)||[];
let rows=[];
function flat(arr,cat){for(const g of arr){const u=g.uuid||'';const bc=g.baseCount||'';
  for(const t of (g.targets||[])){rows.push({cat,uuid:u,baseCount:bc,candidateRow:t.row,keeperRow:t.keeperRow||'',targetHash:t.targetHash||'',keeperHash:t.keeperHash||'',hasBase:t.hasBase,baseHash:t.baseHash||''});}}}
flat(safe,'SAFE');flat(nib,'NOT_IN_BASE');
// 校验：SAFE 每行的 targetHash==keeperHash（同值证明）
let sameVal=0, diffVal=0, withBase=0, total=rows.length;
for(const r of rows){ if(r.targetHash&&r.targetHash===r.keeperHash) sameVal++; else if(r.targetHash&&r.keeperHash) diffVal++; if(r.hasBase) withBase++; }
const outPath='outputs/T1-B_候选保留映射_可核查_2026-11-01.csv';
const header=['类别','UUID','base计数','候选行(row)','保留对象行(keeperRow)','targetHash','keeperHash','哈希一致(同值)','hasBase','baseHash'].join(',');
const lines=rows.map(r=>[r.cat,r.uuid,r.baseCount,r.candidateRow,r.keeperRow,r.targetHash,r.keeperHash,(r.targetHash&&r.keeperHash&&r.targetHash===r.keeperHash)?'YES':'NO',r.hasBase,r.baseHash].join(','));
fs.writeFileSync(outPath,[header,...lines].join('\n'));
console.log('=== 映射交付物 ===');
console.log('源快照 ssId:', sm.ssId);
console.log('扫描时间:', sm.scannedAtBJT, '| sheet:', sm.sheet, '| rowCount:', sm.rowCount, '| uuidGroups:', sm.uuidGroups);
console.log('prodScan:', src.prodScan);
console.log('baseSnapshot:', src.baseSnapshot);
console.log('SAFE 组数:', safe.length, '| NOT_IN_BASE 组数:', nib.length);
console.log('映射总行数(候选→保留):', total, '(应=1340 EXACT 行)');
console.log('  - 哈希一致(同值证明):', sameVal, '| 哈希不同:', diffVal);
console.log('  - 含 baseHash 绑定:', withBase);
console.log('写出:', outPath, '| 文件行数:', lines.length+1);
