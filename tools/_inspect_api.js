'use strict';
const fs = require('fs');
const https = require('https');
const { URLSearchParams } = require('url');
const CLASP = 'C:/Users/rita.jin/.clasprc.json';
const SCRIPT_ID = '1FPAwV50VdpI2AGT42rfn6JhU0assY1QaARbhTQeiUKS0mZ66yf_JRb8R';
function getCreds(){ return JSON.parse(fs.readFileSync(CLASP,'utf8')).tokens.default; }
function refreshToken(d){ return new Promise((res,rej)=>{ const body=new URLSearchParams({client_id:d.client_id,client_secret:d.client_secret,refresh_token:d.refresh_token,grant_type:'refresh_token'}).toString(); const req=https.request({hostname:'oauth2.googleapis.com',path:'/token',method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(body)}},r=>{let s='';r.on('data',c=>s+=c);r.on('end',()=>{try{const j=JSON.parse(s);j.access_token?res(j):rej(new Error('rf:'+s.slice(0,200)));}catch(e){rej(new Error('p:'+s.slice(0,200)));}});});req.on('error',rej);req.write(body);req.end();}); }
function api(method,path,token,body){ return new Promise((res,rej)=>{ const data=body?JSON.stringify(body):null; const req=https.request({hostname:'script.googleapis.com',path:path,method:method,headers:Object.assign({'Authorization':'Bearer '+token},data?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}:{})},r=>{const ch=[];r.on('data',c=>ch.push(c));r.on('end',()=>{const b=Buffer.concat(ch),x=b.toString('utf8');if(r.statusCode>=400)return rej(new Error('HTTP '+r.statusCode+' '+method+' '+path+': '+x.slice(0,400)));try{res({status:r.statusCode,json:x?JSON.parse(x):null});}catch(e){res({status:r.statusCode,json:x});}});});req.on('error',rej);if(data)req.write(data);req.end();}); }
(async()=>{
  const d=getCreds(); const r=await refreshToken(d); const tok=r.access_token;
  const dep=await api('GET','/v1/projects/'+SCRIPT_ID+'/deployments',tok);
  console.log('=== DEPLOYMENTS RAW (structure) ===');
  console.log(JSON.stringify(dep.json.deployments.map(x=>({id:x.deploymentId, cfg:x.deploymentConfig})),null,1).slice(0,1500));
  const c=await api('GET','/v1/projects/'+SCRIPT_ID+'/content',tok);
  console.log('\n=== CONTENT FILE STRUCTURE (name/type, no source) ===');
  console.log('fileCount=',c.json.files.length);
  console.log(JSON.stringify(c.json.files.map(f=>({name:f.name,type:f.type,hasSource:typeof f.source==='string',bytes:f.source?Buffer.byteLength(f.source):0})),null,1).slice(0,1500));
  // save full content for the push step
  fs.writeFileSync('C:/Users/rita.jin/SMCN_ERP-T1B-audit-shared/tools/_live_content.json', JSON.stringify(c.json));
  console.log('\nsaved _live_content.json (bytes='+Buffer.byteLength(JSON.stringify(c.json))+')');
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
