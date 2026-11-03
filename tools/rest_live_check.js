'use strict';
const fs = require('fs');
const https = require('https');

const CLASP = 'C:/Users/rita.jin/.clasprc.json';
const SCRIPT_ID = '1FPAwV50VdpI2AGT42rfn6JhU0assY1QaARbhTQeiUKS0mZ66yf_JRb8R';

function getToken() {
  const j = JSON.parse(fs.readFileSync(CLASP, 'utf8'));
  const def = j.tokens && j.tokens.default;
  if (!def) throw new Error('no tokens.default');
  // prefer access_token; note refresh would require secret — assume fresh enough
  return def.access_token || (def.credentials && def.credentials.access_token);
}

function httpsGet(path) {
  const token = getToken();
  return new Promise((resolve, reject) => {
    const url = 'https://script.googleapis.com' + path;
    const req = https.get(url, { headers: { Authorization: 'Bearer ' + token } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const txt = buf.toString('utf8');
        if (res.statusCode >= 400) {
          reject(new Error('HTTP ' + res.statusCode + ': ' + txt.slice(0, 500)));
          return;
        }
        try { resolve({ status: res.statusCode, json: JSON.parse(txt) }); }
        catch (e) { resolve({ status: res.statusCode, raw: txt }); }
      });
    });
    req.on('error', reject);
  });
}

(async () => {
  try {
    // 1) deployments
    const dep = await httpsGet('/v1/projects/' + SCRIPT_ID + '/deployments');
    console.log('=== DEPLOYMENTS ===');
    if (dep.json && dep.json.deployments) {
      console.log('count =', dep.json.deployments.length);
      for (const d of dep.json.deployments) {
        console.log('  deploymentId=' + d.deploymentId + ' | version=' + (d.deploymentConfig && d.deploymentConfig.versionNumber) + ' | url=' + (d.deploymentConfig && d.deploymentConfig.url));
      }
    } else {
      console.log(JSON.stringify(dep.json || dep.raw, null, 2).slice(0, 800));
    }

    // 2) content (file list)
    const content = await httpsGet('/v1/projects/' + SCRIPT_ID + '/content');
    console.log('\n=== CONTENT FILES ===');
    if (content.json && content.json.files) {
      console.log('fileCount =', content.json.files.length);
      for (const f of content.json.files) {
        const src = f.source || '';
        console.log('  ' + f.name + ' (' + (f.type || '?') + ') bytes=' + Buffer.byteLength(src, 'utf8'));
      }
    } else {
      console.log(JSON.stringify(content.json || content.raw, null, 2).slice(0, 800));
    }

    // 3) versions (last few)
    const ver = await httpsGet('/v1/projects/' + SCRIPT_ID + '/versions?pageSize=5');
    console.log('\n=== VERSIONS (recent) ===');
    if (ver.json && ver.json.versions) {
      for (const v of ver.json.versions) {
        console.log('  v' + v.versionNumber + ' | ' + (v.description || '') + ' | ' + (v.createTime || ''));
      }
    } else {
      console.log(JSON.stringify(ver.json || ver.raw, null, 2).slice(0, 800));
    }
  } catch (e) {
    console.error('ERROR:', e.message);
    process.exit(1);
  }
})();
