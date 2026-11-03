'use strict';
const fs = require('fs');
const https = require('https');
const { URLSearchParams } = require('url');

const CLASP = 'C:/Users/rita.jin/.clasprc.json';
const SCRIPT_ID = '1FPAwV50VdpI2AGT42rfn6JhU0assY1QaARbhTQeiUKS0mZ66yf_JRb8R';

function getCreds() { return JSON.parse(fs.readFileSync(CLASP, 'utf8')).tokens.default; }

function refreshToken(d) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      client_id: d.client_id, client_secret: d.client_secret,
      refresh_token: d.refresh_token, grant_type: 'refresh_token'
    }).toString();
    const u = new URL('https://oauth2.googleapis.com/token');
    const req = https.request({ hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => { try { const j = JSON.parse(data); j.access_token ? resolve(j) : reject(new Error('refresh failed: ' + data.slice(0,300))); } catch (e) { reject(new Error('parse: ' + data.slice(0,300))); } });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

function apiGet(path, token) {
  return new Promise((resolve, reject) => {
    const req = https.get('https://script.googleapis.com' + path, { headers: { Authorization: 'Bearer ' + token } }, (res) => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { const buf = Buffer.concat(chunks), txt = buf.toString('utf8');
        if (res.statusCode >= 400) { reject(new Error('HTTP ' + res.statusCode + ': ' + txt.slice(0,400))); return; }
        try { resolve(JSON.parse(txt)); } catch (e) { resolve(txt); } });
    });
    req.on('error', reject);
  });
}

(async () => {
  try {
    const d = getCreds(); const now = Date.now();
    let token = d.access_token;
    const expired = !d.expiry_date || d.expiry_date < now + 60000;
    console.log('access_token expiry:', d.expiry_date ? new Date(d.expiry_date).toISOString() : 'none', '| expired?', expired);
    if (expired) { console.log('refreshing token...'); const r = await refreshToken(d); token = r.access_token; console.log('refreshed OK, expires_in', r.expires_in, 's'); }
    else console.log('token still valid, no refresh needed');

    const dep = await apiGet('/v1/projects/' + SCRIPT_ID + '/deployments', token);
    console.log('\n=== DEPLOYMENTS ===');
    if (dep.deployments) {
      console.log('count =', dep.deployments.length);
      for (const x of dep.deployments) console.log('  id=' + x.deploymentId + ' | v=' + (x.deploymentConfig && x.deploymentConfig.versionNumber) + ' | url=' + (x.deploymentConfig && x.deploymentConfig.url));
    } else console.log(JSON.stringify(dep).slice(0, 500));

    const content = await apiGet('/v1/projects/' + SCRIPT_ID + '/content', token);
    console.log('\n=== CONTENT FILES ===');
    if (content.files) {
      console.log('fileCount =', content.files.length);
      for (const f of content.files) console.log('  ' + f.name + ' (' + (f.type || '?') + ') bytes=' + Buffer.byteLength(f.source || '', 'utf8'));
      const pl = content.files.find(f => f.name === 'PeriodLockGuard' || f.name === 'PeriodLockGuard.js');
      if (pl) {
        const src = pl.source || ''; const lines = src.split('\n');
        const anchors = ['_plGuardedInsert', '_plGuardedMutation', '_plGuardPatch', '_plAcquire', 'TS_WRITE_FREEZE', '_plLedgerGet', '_plLedgerSet'];
        console.log('\n--- PeriodLockGuard.js 锚点行号核查 (v47 提案锚定 pin412f3db: _plGuardedInsert:479-543 / _plGuardedMutation:411-473 / _plGuardPatch:557-619 / _plLedger*:70-183) ---');
        for (const a of anchors) { const li = lines.findIndex(l => l.includes(a)); console.log('  "' + a + '": ' + (li >= 0 ? 'line ' + (li + 1) : 'NOT FOUND')); }
        console.log('  total lines =', lines.length);
      }
    } else console.log(JSON.stringify(content).slice(0, 500));
  } catch (e) { console.error('ERROR:', e.message); process.exit(1); }
})();
