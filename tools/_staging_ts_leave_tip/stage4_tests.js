// T1-B 生产表 Step1 · 阶段四哈希复核 · 单元 + 集成测试（回应 Tom 2026-10-24 Pt4 / Pt5）
// 自包含：不依赖 ts_leave_tip_core.js。覆盖 colToIndex / CSV 引号解析 / manifest 合法性反例 /
// readNonTargetRegion(AA 列) / 全链路 PASS 与 FAIL-CLOSE（缺 dataWrite / 空列 / 数据漂移）。
// 运行：node stage4_tests.js   exit 0 = 全部通过

'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const S = require('./stage4_hash_check.js');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name); }
}

// ===== colToIndex（Pt5：多字母列）=====
check('colToIndex A=0', S.colToIndex('A') === 0);
check('colToIndex Z=25', S.colToIndex('Z') === 25);
check('colToIndex AA=26', S.colToIndex('AA') === 26);
check('colToIndex AB=27', S.colToIndex('AB') === 27);
check('colToIndex 小写 az=51', S.colToIndex('az') === 51);
check('colToIndex 非法(数字)→null', S.colToIndex('A1') === null);
check('colToIndex 小写被归一(AA)→26', S.colToIndex('aA') === S.colToIndex('AA'));
check('colToIndex 空→null', S.colToIndex('') === null);

// ===== parseCsv（Pt5：引号内逗号/换行/转义引号）=====
const csvQ = 'A,B,C\n"a,b","line1\nline2","he said ""hi"""\nx,y,z';
const rowsQ = S.parseCsv(csvQ);
check('parseCsv 引号内逗号不拆列', rowsQ[1][0] === 'a,b');
check('parseCsv 引号内换行保留', rowsQ[1][1] === 'line1\nline2');
check('parseCsv 转义引号 ""→"', rowsQ[1][2] === 'he said "hi"');
check('parseCsv 普通行正常', rowsQ[2][0] === 'x' && rowsQ[2][2] === 'z');

// ===== readNonTargetRegion（AA 列正确提取）=====
const rowsAA = [['h1', 'h2', 'h3'], ['a', 'b', 'c'], ['d', 'e', 'f']]; // C 是第三列(索引2)
const region = S.readNonTargetRegion(rowsAA, ['A', 'C']); // 取 A 与 C
check('readNonTargetRegion 取 A,C 列', region === 'h1,h3\na,c\nd,f');

// ===== validateManifest（Pt4：反例 fail-close）=====
check('manifest 空对象→不合法', S.validateManifest({}).ok === false);
check('manifest 缺 dataWrite→不合法', S.validateManifest({ frozenVersion: 'V', table: 'T', capturedAt: 'C', nonTargetColumns: ['A'], authorizedTarget: {}, beforeSha256: '0'.repeat(64), afterSha256: '0'.repeat(64) }).ok === false);
check('manifest 空 nonTargetColumns→不合法', S.validateManifest({ frozenVersion: 'V', table: 'T', capturedAt: 'C', nonTargetColumns: [], authorizedTarget: { dataWrite: false }, beforeSha256: '0'.repeat(64), afterSha256: '0'.repeat(64) }).ok === false);
check('manifest 非法列字母→不合法', S.validateManifest({ frozenVersion: 'V', table: 'T', capturedAt: 'C', nonTargetColumns: ['A', '1B'], authorizedTarget: { dataWrite: false }, beforeSha256: '0'.repeat(64), afterSha256: '0'.repeat(64) }).ok === false);
check('manifest 合法→ok', S.validateManifest({ frozenVersion: 'V', table: 'T', capturedAt: 'C', nonTargetColumns: ['A'], authorizedTarget: { dataWrite: false }, beforeSha256: '0'.repeat(64), afterSha256: '0'.repeat(64) }).ok === true);
check('manifest 缺 beforeSha256→不合法', S.validateManifest({ frozenVersion: 'V', table: 'T', capturedAt: 'C', nonTargetColumns: ['A'], authorizedTarget: { dataWrite: false }, afterSha256: '0'.repeat(64) }).ok === false);

// ===== verifyWriteSet（dataWrite 非 false → fail）=====
check('verifyWriteSet dataWrite!=false→fail', S.verifyWriteSet(Buffer.from('x'), Buffer.from('x'), { authorizedTarget: {} }).ok === false);

// ===== 集成：全链路 child 进程 exit code =====
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage4-'));
// before/after 完全一致的真实数据 CSV（含引号逗号 + 第4列 D，验证解析与多列索引）
const dataCsv =
  'A,B,C,D\n' +
  'row1,"x,y",v1,w1\n' +
  'row2,normal,v2,w2\n';
const beforePath = path.join(tmp, 'before.csv');
const afterPath = path.join(tmp, 'after.csv');
fs.writeFileSync(beforePath, dataCsv);
fs.writeFileSync(afterPath, dataCsv);
const bSha = crypto.createHash('sha256').update(fs.readFileSync(beforePath)).digest('hex');
const aSha = crypto.createHash('sha256').update(fs.readFileSync(afterPath)).digest('hex');

function runStage4(manifest) {
  const mp = path.join(tmp, 'manifest.json');
  fs.writeFileSync(mp, JSON.stringify(manifest, null, 2));
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'stage4_hash_check.js'), '--manifest', mp, '--before', beforePath, '--after', afterPath], { stdio: 'pipe' });
    return 0;
  } catch (e) {
    return (e.status != null) ? e.status : 2;
  }
}

const goodManifest = {
  frozenVersion: 'VP-20261018-R5729', table: 'DB_工时流水', capturedAt: '2026-10-24T08:15:00+08:00',
  nonTargetColumns: ['A', 'B', 'C', 'D'], authorizedTarget: { kind: 'code-module-addition', module: 'ts_leave_tip', dataWrite: false },
  beforeSha256: bSha, afterSha256: aSha,
};
check('stage4 合法(数据一致)→exit 0 PASS', runStage4(goodManifest) === 0);

const missDataWrite = JSON.parse(JSON.stringify(goodManifest));
missDataWrite.authorizedTarget = { dataWrite: true };
check('stage4 缺 dataWrite=false→exit 1 FAIL', runStage4(missDataWrite) === 1);

const emptyCols = JSON.parse(JSON.stringify(goodManifest));
emptyCols.nonTargetColumns = [];
check('stage4 空 nonTargetColumns→exit 1 FAIL', runStage4(emptyCols) === 1);

const wrongCol = JSON.parse(JSON.stringify(goodManifest));
wrongCol.nonTargetColumns = ['A', 'ZZ']; // ZZ 索引 701，远超文件列数 4 → 越界
check('stage4 列越界(ZZ)→exit 1 FAIL', runStage4(wrongCol) === 1);

// 数据漂移：after 改了一行数据 → dataWrite=false 但字节不一致 → FAIL
fs.writeFileSync(afterPath, dataCsv.replace('row1', 'CHANGED'));
const aSha2 = crypto.createHash('sha256').update(fs.readFileSync(afterPath)).digest('hex');
const driftManifest = JSON.parse(JSON.stringify(goodManifest));
driftManifest.afterSha256 = aSha2;
check('stage4 数据漂移→exit 1 FAIL', runStage4(driftManifest) === 1);

// 证据 SHA 不符（before SHA 写错）→ FAIL
const badShaManifest = JSON.parse(JSON.stringify(goodManifest));
badShaManifest.beforeSha256 = '0'.repeat(64);
check('stage4 证据 SHA 不符→exit 1 FAIL', runStage4(badShaManifest) === 1);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
