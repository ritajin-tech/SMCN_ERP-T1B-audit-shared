'use strict';
// Read-only: fetches LIVE project content via Apps Script API (script.projects,
// read scope only) and statically enumerates every Sheets/SpreadsheetApp WRITE
// call site, flagging which are gated by _plGuardedInsert / _plGuardedMutation.
// No writes to any system. Output is a scan report for independent review.
const fs = require('fs');
const https = require('https');
const { URLSearchParams } = require('url');

const CLASP = 'C:/Users/rita.jin/.clasprc.json';
const SCRIPT_ID = '1FPAwV50VdpI2AGT42rfn6JhU0assY1QaARbhTQeiUKS0mZ66yf_JRb8R';

function getCreds() { return JSON.parse(fs.readFileSync(CLASP, 'utf8')).tokens.default; }
function refreshToken(d) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({ client_id: d.client_id, client_secret: d.client_secret, refresh_token: d.refresh_token, grant_type: 'refresh_token' }).toString();
    const u = new URL('https://oauth2.googleapis.com/token');
    const req = https.request({ hostname: u.hostname, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => { try { const j = JSON.parse(data); j.access_token ? resolve(j) : reject(new Error('refresh failed: ' + data.slice(0, 300))); } catch (e) { reject(new Error('parse: ' + data.slice(0, 300))); } });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}
function apiGet(path, token) {
  return new Promise((resolve, reject) => {
    const req = https.get('https://script.googleapis.com' + path, { headers: { Authorization: 'Bearer ' + token } }, (res) => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { const buf = Buffer.concat(chunks), txt = buf.toString('utf8');
        if (res.statusCode >= 400) { reject(new Error('HTTP ' + res.statusCode + ': ' + txt.slice(0, 400))); return; }
        try { resolve(JSON.parse(txt)); } catch (e) { resolve(txt); } });
    });
    req.on('error', reject);
  });
}

// write verbs of interest
const WRITE_RE = /\b(appendRow|appendRows|setValues|setValue|setValues\(|insertRows|insertRowAfter|insertRowBefore|deleteRow|clear\(|clearContents|getRange\([^)]*\)\.(set|delete)|SpreadsheetApp\.getActive|sheet\.(append|set|insert|delete|clear)|appendSheet|batchUpdate)\b/;
// exclude obvious pure-read patterns already covered by READ_RE
const READ_RE = /\b(getValue|getValues|getDataRange|getLastRow|getLastColumn|getRange\(|openById|openByUrl|getSheetByName|getActiveSheet)\b/;
// guard markers
const GUARD_RE = /_plGuardedInsert|_plGuardedMutation|_plGuardPatch/;

(async () => {
  try {
    const d = getCreds(); const now = Date.now();
    let token = d.access_token;
    if (!d.expiry_date || d.expiry_date < now + 60000) { const r = await refreshToken(d); token = r.access_token; }
    const content = await apiGet('/v1/projects/' + SCRIPT_ID + '/content', token);
    const files = content.files || [];
    // save raw for reproducibility
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync('tools/evidence/live_content_' + stamp + '.json', JSON.stringify(content, null, 2));
    console.log('SAVED live content -> tools/evidence/live_content_' + stamp + '.json  (fileCount=' + files.length + ')');

    const ALL_WRITE_FILES = ['Code', 'RemoteActions', 'RemoteTrigger', 'masterCreate', 'masterAttendanceLive', 'rebuildAttendance', 'leave_sync', 'masterLeaves', 'masterException', 'PruneDead', '每天自动提醒', '抓取设计脚本', 'amy_indirect_cost', 'FixBDates', 'onOpen', 'Index', 'PeriodLockGuard'];
    let total = 0, guarded = 0;
    const byFile = {};
    for (const f of files) {
      if (f.type === 'JSON' || f.name === 'appsscript') continue;
      const lines = (f.source || '').split('\n');
      const hits = [];
      lines.forEach((ln, i) => {
        if (WRITE_RE.test(ln) && !READ_RE.test(ln)) {
          const g = GUARD_RE.test(ln) || (i > 0 && GUARD_RE.test(lines[i - 1]));
          if (g) guarded++;
          hits.push({ line: i + 1, guarded: g, text: ln.trim().slice(0, 140) });
        }
      });
      if (hits.length) { byFile[f.name] = hits; total += hits.length; }
    }
    console.log('\n=== WRITE CALL SITES (non-read) ===');
    console.log('total write-sites=' + total + ' | near-guard=' + guarded);
    for (const [name, hits] of Object.entries(byFile)) {
      console.log('\n[' + name + ']  sites=' + hits.length);
      hits.slice(0, 40).forEach(h => console.log('  L' + h.line + (h.guarded ? ' [GUARDED]' : '') + '  ' + h.text));
    }
    // specifically locate the two production-table insert points
    console.log('\n=== look for tsAppendRows / submitBatch / DB_工时流水 insert ===');
    for (const f of files) {
      const lines = (f.source || '').split('\n');
      lines.forEach((ln, i) => {
        if (/tsAppendRows|submitBatch|DB_工时流水|_plGuardedInsert\s*\(/.test(ln)) {
          console.log('  ' + f.name + ':L' + (i + 1) + '  ' + ln.trim().slice(0, 160));
        }
      });
    }
  } catch (e) { console.error('ERROR:', e.message); process.exit(1); }
})();
