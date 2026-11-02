'use strict';
const fs = require('fs');
const https = require('https');
const { URLSearchParams } = require('url');
const CLASP = 'C:/Users/rita.jin/.clasprc.json';
const SCRIPT_ID = '1FPAwV50VdpI2AGT42rfn6JhU0assY1QaARbhTQeiUKS0mZ66yf_JRb8R';
function getCreds(){ return JSON.parse(fs.readFileSync(CLASP,'utf8')).tokens.default; }
function refreshToken(d){ return new Promise((res,rej)=>{ const body=new URLSearchParams({client_id:d.client_id,client_secret:d.client_secret,refresh_token:d.refresh_token,grant_type:'refresh_token'}).toString(); const req=https.request({hostname:'oauth2.googleapis.com',path:'/token',method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(body)}},r=>{let s='';r.on('data',c=>s+=c);r.on('end',()=>{try{const j=JSON.parse(s);j.access_token?res(j):rej(new Error('rf:'+s.slice(0,200)));}catch(e){rej(new Error('p:'+s.slice(0,200)));}});});req.on('error',rej);req.write(body);req.end();}); }
function apiGet(p,t){ return new Promise((res,rej)=>{ const req=https.get('https://script.googleapis.com'+p,{headers:{Authorization:'Bearer '+t}},r=>{const ch=[];r.on('data',c=>ch.push(c));r.on('end',()=>{const b=Buffer.concat(ch),x=b.toString('utf8');if(r.statusCode>=400)return rej(new Error('HTTP '+r.statusCode+': '+x.slice(0,400)));try{res(JSON.parse(x));}catch(e){res(x);}});});req.on('error',rej);}); }
(async()=>{ const d=getCreds(); const r=await refreshToken(d); const tok=r.access_token;
  const c=await apiGet('/v1/projects/'+SCRIPT_ID+'/content',tok);
  const f=c.files.find(f=>f.name==='PeriodLockGuard'||f.name==='PeriodLockGuard.js');
  if(!f){console.error('PeriodLockGuard not found');process.exit(1);}
  fs.writeFileSync('/c/Users/rita.jin/SMCN_ERP-T1B-audit-shared/tools/_live_PeriodLockGuard.js', f.source||'');
  const lines=(f.source||'').split('\n');
  console.log('live PeriodLockGuard lines =', lines.length, '| saved to _live_PeriodLockGuard.js');
  const anchors=['_plGuardedInsert','_plGuardedMutation','_plGuardPatch','_plAcquire','TS_WRITE_FREEZE','_plLedgerGet','_plLedgerSet','_plPolicy','_plRecheckRow','_plGuardCheck','enteredWrite','bizWrite','opts.requestId','payloadHash'];
  for(const a of anchors){ const li=lines.findIndex(l=>l.includes(a)); console.log('  "'+a+'": '+(li>=0?('line '+(li+1)):'NOT FOUND')); }
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
