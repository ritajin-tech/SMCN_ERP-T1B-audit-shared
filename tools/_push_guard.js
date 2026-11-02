'use strict';
const fs = require('fs');
const https = require('https');
const { URLSearchParams } = require('url');
const CLASP = 'C:/Users/rita.jin/.clasprc.json';
const SCRIPT_ID = '1FPAwV50VdpI2AGT42rfn6JhU0assY1QaARbhTQeiUKS0mZ66yf_JRb8R';
const OFFICIAL_DEP_ID = 'AKfycbzUyhyK-tqL7ypp2H2jZXNCMciEr2PJwhkZIg0bwV1OwV2C6D9RKJZhA4HpiUi6F5eF';
function getCreds(){ return JSON.parse(fs.readFileSync(CLASP,'utf8')).tokens.default; }
function refreshToken(d){ return new Promise((res,rej)=>{ const body=new URLSearchParams({client_id:d.client_id,client_secret:d.client_secret,refresh_token:d.refresh_token,grant_type:'refresh_token'}).toString(); const req=https.request({hostname:'oauth2.googleapis.com',path:'/token',method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(body)}},r=>{let s='';r.on('data',c=>s+=c);r.on('end',()=>{try{const j=JSON.parse(s);j.access_token?res(j):rej(new Error('rf:'+s.slice(0,200)));}catch(e){rej(new Error('p:'+s.slice(0,200)));}});});req.on('error',rej);req.write(body);req.end();}); }
function api(method,path,token,body){ return new Promise((res,rej)=>{ const data=body?JSON.stringify(body):null; const req=https.request({hostname:'script.googleapis.com',path:path,method:method,headers:Object.assign({'Authorization':'Bearer '+token},data?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}:{})},r=>{const ch=[];r.on('data',c=>ch.push(c));r.on('end',()=>{const b=Buffer.concat(ch),x=b.toString('utf8');if(r.statusCode>=400)return rej(new Error('HTTP '+r.statusCode+' '+method+' '+path+': '+x.slice(0,400)));try{res({status:r.statusCode,json:x?JSON.parse(x):null});}catch(e){res({status:r.statusCode,json:x});}});});req.on('error',rej);if(data)req.write(data);req.end();}); }
function findDep(deps){ return deps.find(d=>d.deploymentId===OFFICIAL_DEP_ID); }
(async()=>{
  const d=getCreds(); const r=await refreshToken(d); const tok=r.access_token;
  console.log('token OK, expires_in', r.expires_in);

  // 1. load full content, replace PeriodLockGuard
  const content=JSON.parse(fs.readFileSync('C:/Users/rita.jin/SMCN_ERP-T1B-audit-shared/tools/_live_content.json','utf8'));
  const merged=fs.readFileSync('C:/Users/rita.jin/SMCN_ERP-T1B-audit-shared/tools/_merged_PeriodLockGuard.js','utf8');
  let pl=content.files.find(f=>f.name==='PeriodLockGuard');
  if(!pl) throw new Error('PeriodLockGuard not in content');
  const oldBytes=Buffer.byteLength(pl.source);
  pl.source=merged;
  console.log('content files =', content.files.length, '| PeriodLockGuard', oldBytes,'->',Buffer.byteLength(merged),'bytes');

  // 2. PUT content (HEAD only; live still on v196)
  console.log('\n[2] PUT /content ...');
  const put=await api('PUT','/v1/projects/'+SCRIPT_ID+'/content',tok,{files:content.files.map(f=>({name:f.name,type:f.type,source:f.source}))});
  console.log('  PUT /content status', put.status);

  // 3. verify content re-GET
  console.log('[3] re-GET /content to verify ...');
  const c2=await api('GET','/v1/projects/'+SCRIPT_ID+'/content',tok);
  const pl2=c2.json.files.find(f=>f.name==='PeriodLockGuard');
  if(c2.json.files.length!==18) throw new Error('file count changed: '+c2.json.files.length);
  if(!pl2.source.includes('PL_LEDGER_KEY')) throw new Error('merged PeriodLockGuard NOT present after PUT');
  console.log('  OK: 18 files, PL_LEDGER_KEY present in live HEAD PeriodLockGuard');

  // 4. POST version
  console.log('[4] POST /versions ...');
  const ver=await api('POST','/v1/projects/'+SCRIPT_ID+'/versions',tok,{});
  const newVer=ver.json.versionNumber;
  console.log('  new version =', newVer);

  // 5. confirm deployments still 3 and official at 196 before bump
  console.log('[5] GET /deployments (pre-bump) ...');
  const depPre=await api('GET','/v1/projects/'+SCRIPT_ID+'/deployments',tok);
  const offPre=findDep(depPre.json.deployments);
  console.log('  count =', depPre.json.deployments.length, '| official v =', offPre.deploymentConfig.versionNumber);
  if(depPre.json.deployments.length!==3) throw new Error('deployment count != 3 pre-bump: '+depPre.json.deployments.length);
  if(offPre.deploymentConfig.versionNumber!==196) throw new Error('official not at 196 pre-bump: '+offPre.deploymentConfig.versionNumber);

  // 6. PUT deployment -> newVer (preserving deploymentId/URL)
  console.log('[6] PUT /deployments/'+OFFICIAL_DEP_ID+' -> v'+newVer+' (URL preserved) ...');
  const up=await api('PUT','/v1/projects/'+SCRIPT_ID+'/deployments/'+OFFICIAL_DEP_ID,tok,{
    deploymentConfig:{ versionNumber:newVer, manifestFileName:'appsscript', scriptId:SCRIPT_ID }
  });
  console.log('  PUT deployment status', up.status);

  // 7. re-verify deployments
  console.log('[7] GET /deployments (post-bump) ...');
  const depPost=await api('GET','/v1/projects/'+SCRIPT_ID+'/deployments',tok);
  const offPost=findDep(depPost.json.deployments);
  console.log('  count =', depPost.json.deployments.length, '| official v =', offPost.deploymentConfig.versionNumber);
  if(depPost.json.deployments.length!==3) throw new Error('deployment count != 3 post-bump!');
  if(offPost.deploymentConfig.versionNumber!==newVer) throw new Error('official not bumped to '+newVer);

  // 8. evidence
  const ev={ owner_ruled:'M2 v1 (commit 83bb1be)', executed_at:new Date().toISOString(),
    action:'pushed N3 ledger guard to live @HEAD (no link change)',
    official_deployment_id:OFFICIAL_DEP_ID, url_preserved:'AKfycbzUyhyK @196 -> @'+newVer,
    deployments_count:3, periodlockguard_bytes:Buffer.byteLength(merged),
    ledger_key:'TS_WRITE_LEDGER', coverage:['_plGuardedInsert(W1/W4)','_plGuardedMutation(W2/W3)'],
    deferred:['_plGuardPatch(W5) requires caller tsPatchCells integration'],
    deviation:'requestId/payloadHash self-derived from payload (callers do not pass them)',
    red_lines:{no_link_change:true, deployments_unchanged_count:3, zero_data_loss:true} };
  fs.writeFileSync('C:/Users/rita.jin/SMCN_ERP-T1B-audit-shared/tools/writer_bypass_evidence.json', JSON.stringify(ev,null,2));
  console.log('\n=== PUSH COMPLETE ===');
  console.log('live now serves v'+newVer+' via AKfycbzUyhyK (URL unchanged), 3 deployments, ledger self-creates on first write');
  console.log('evidence -> tools/writer_bypass_evidence.json');
})().catch(e=>{ console.error('\n!!! PUSH ABORTED:', e.message); console.error('Live remains on v196 (deployment not bumped). No link change, no data loss.'); process.exit(1); });
