'use strict';
// ts_controlled_audit.js —— readAll 读取守卫单测（注入 mock 读取通道，不触网）。
// 覆盖 Tom X 批·二 的三处收紧：
//   · 短全空行（异常缺失）不得被 cells||[] 伪造成空行 → validateRows 必须 fail-closed；
//   · null 行槽（异常缺失）同样不得被掩盖 → fail-closed；
//   · 终点 probe2 必须在第二遍全量读【之后】，以检出第二遍期间的追加/改版漂移。
const ca = require('./ts_controlled_audit.js');

function makeFetch(cfg) {
  let callCount = 0;
  return async (args) => {
    callCount++;
    if (args.a1 === 'A1:Q2') {
      // 起读前 probe（首调）与终点 probe2（最后一个 A1:Q2 调用）
      if (callCount === 1) return { lastRow: cfg.startLast, revision: cfg.startRev };
      return { lastRow: cfg.endLast, revision: cfg.endRev };
    }
    const m = /^A(\d+):Q(\d+)$/.exec(args.a1);
    if (!m) return {};
    const s = +m[1], e = +m[2];
    const arr = [];
    for (let rr = s; rr <= e; rr++) {
      if (cfg.shortRow === rr) arr.push(new Array(5).fill(''));       // 短全空行（异常缺失，应被检出）
      else if (cfg.nullRow === rr) arr.push(null);                    // null 行槽（异常缺失，应被检出）
      else arr.push(new Array(17).fill('x'));                         // 完整宽度（含内容，过筛保留）
    }
    return { values: arr };
  };
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; process.stderr.write('  ✅ ' + name + '\n'); }
  else { fail++; process.stderr.write('  ❌ ' + name + (extra ? ' → ' + JSON.stringify(extra) : '') + '\n'); }
}

(async () => {
  // 1) 正常路径：两遍一致、revision 相同 → ok，guard=REVISION+CONTENT
  ca.setFetch(makeFetch({ startLast: 10, endLast: 10, startRev: 'r1', endRev: 'r1' }));
  let r = await ca.readAll('x', 'y', 'Q');
  check('happy: ok=true', r.ok === true, r);
  check('happy: 保留 10 数据行', r.rows && r.rows.length === 10, r.rows && r.rows.length);
  check('happy: guard=REVISION+CONTENT', r.guard === 'REVISION+CONTENT', r.guard);

  // 2) 短全空行（第5行只有5列，远小于期望宽度17）→ 不得被 cells||[] 掩盖，必须 VALIDATE_ROWS_FAILED
  ca.setFetch(makeFetch({ startLast: 10, endLast: 10, startRev: 'r1', endRev: 'r1', shortRow: 5 }));
  r = await ca.readAll('x', 'y', 'Q');
  check('shortRow: ok=false', r.ok === false, r);
  check('shortRow: reason=VALIDATE_ROWS_FAILED', r.reason === 'VALIDATE_ROWS_FAILED', r.reason);

  // 3) null 行槽（第5行是 null）→ 不得被 cells||[] 伪造成空行，必须 VALIDATE_ROWS_FAILED
  ca.setFetch(makeFetch({ startLast: 10, endLast: 10, startRev: 'r1', endRev: 'r1', nullRow: 5 }));
  r = await ca.readAll('x', 'y', 'Q');
  check('nullRow: ok=false', r.ok === false, r);
  check('nullRow: reason=VALIDATE_ROWS_FAILED', r.reason === 'VALIDATE_ROWS_FAILED', r.reason);

  // 4) 终点漂移：第二遍期间 lastRow 由 10 变 11（模拟中途追加）→ probe2 在二遍【之后】必须检出 DRIFT
  ca.setFetch(makeFetch({ startLast: 10, endLast: 11, startRev: 'r1', endRev: 'r1' }));
  r = await ca.readAll('x', 'y', 'Q');
  check('drift: ok=false', r.ok === false, r);
  check('drift: reason=DRIFT_DURING_READ', r.reason === 'DRIFT_DURING_READ', r.reason);

  // 5) revision 双侧缺失但内容一致 → 有效降级 CONTENT_FINGERPRINT
  ca.setFetch(makeFetch({ startLast: 10, endLast: 10, startRev: null, endRev: null }));
  r = await ca.readAll('x', 'y', 'Q');
  check('noRev: ok=true', r.ok === true, r);
  check('noRev: guard=CONTENT_FINGERPRINT', r.guard === 'CONTENT_FINGERPRINT', r.guard);

  process.stderr.write('\n[X2 readAll] pass=' + pass + ' fail=' + fail + '\n');
  process.exit(fail ? 1 : 0);
})();
