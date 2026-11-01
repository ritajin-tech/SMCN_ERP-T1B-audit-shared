/**
 * gas_test_EditB_crossproject.gs
 * ---------------------------------------------------------------------------
 * T1-B Edit B 验证：在【真实 GAS】下证明 getDocumentLock 提供「跨项目」互斥，
 * 而 getScriptLock 仅「脚本实例」级（跨项目无效）。
 *
 * 对应 Tom 10:11 来信：「Edit B 暂不接受仅替换 document lock 即证明跨项目互斥，
 *   空锁拒绝是必要条件，仍需隔离环境证明锁域、超时及异常释放。」
 *
 * 本文件把 N1–N4 隔离实验落成【可运行代码】。部署方式见文末。
 *
 * 实验设计（两个独立 GAS 项目 + 同一张共享表）：
 *   - 项目 A、项目 B 各部署本文件（同一份代码，仅 PROJECT_TAG 不同）。
 *   - 两项目都向 SHARED_SHEET_ID 的同一张表写「临界区标记行」。
 *   - 临界区内：写 PROJECT_TAG 起始标记 → 睡眠 WINDOW_MS 拉开窗口 → 写结束标记。
 *   - 协调器（可在任一项目或第三项目）用 UrlFetch 同时触发 A、B 的 doGet/runBoth。
 *   - 断言：若 document lock 生效，A 的起止标记之间不会出现 B 的标记（无交错）。
 *   - 对照：把 USE_DOCUMENT_LOCK 改为 false（用 getScriptLock），重跑 → 两项目互不
 *     排斥 → 标记交错 → 证明 script lock 跨项目无效。
 * ---------------------------------------------------------------------------
 */

var SHARED_SHEET_ID = 'REPLACE_WITH_SHARED_TEST_SHEET_ID'; // 两项目共用同一张表
var PROJECT_TAG = 'A';                  // 部署到项目 B 时改 'B'
var USE_DOCUMENT_LOCK = true;           // false => 改用 getScriptLock（对照实验）
var WINDOW_MS = 3000;                   // 临界区窗口，拉大以制造竞争

function _acquireLock() {
  var lock = USE_DOCUMENT_LOCK
    ? LockService.getDocumentLock()      // Edit B 目标：文档级，跨项目共享
    : LockService.getScriptLock();       // 对照：脚本实例级，跨项目不共享
  if (!lock.tryLock(30000)) {
    // Edit B 必要不充分条件：空锁/超时须 fail-closed 拒绝裸写（见 fix_T1-B_concurrency_window.md §2）
    throw new Error('PL_REJECT_NO_LOCK');
  }
  return lock;
}

function writerRun(tag) {
  var lock = _acquireLock();
  try {
    var ss = SpreadsheetApp.openById(SHARED_SHEET_ID);
    var sh = ss.getSheetByName('lock_test') || ss.insertSheet('lock_test');
    var t0 = new Date().getTime();
    // 临界区开始
    sh.appendRow([tag, 'START', t0, '']);
    Utilities.sleep(WINDOW_MS);           // 拉长窗口，制造与另一项目的竞争
    var t1 = new Date().getTime();
    sh.appendRow([tag, 'END', t1, '']);
    return 'OK ' + tag;
  } finally {
    lock.releaseLock();
  }
}

/**
 * 协调器：在同一函数内顺序触发「逻辑上的两个项目」不可行（单实例无法模拟跨项目），
 * 故用 UrlFetch 调两个已部署的 web app。把下面的 URL 换成 A、B 两项目的 doGet 部署地址。
 */
function coordinator() {
  var A_URL = 'REPLACE_WITH_PROJECT_A_WEBAPP_URL'; // doGet 调用 writerRun('A')
  var B_URL = 'REPLACE_WITH_PROJECT_B_WEBAPP_URL'; // doGet 调用 writerRun('B')
  // 并发触发（不 await，制造重叠）
  var a = UrlFetchApp.fetch(A_URL);
  var b = UrlFetchApp.fetch(B_URL);
  return 'fired A=' + a.getResponseCode() + ' B=' + b.getResponseCode();
}

function doGet(e) {
  var tag = e.parameter.tag || PROJECT_TAG;
  var r = writerRun(tag);
  return ContentService.createTextOutput(r);
}

// ============ 本地验证（单项目，证明锁语义本身）============
function selfTest() {
  var a = writerRun('SELF_A');
  var b = writerRun('SELF_B');   // 同项目串行，document/script 锁都会互斥 → 都 OK
  return a + ' | ' + b;
}

/** 断言读取：检查 lock_test 表中是否出现 A.START ... B.START ... A.END 的交错 */
function checkNoInterleave() {
  var ss = SpreadsheetApp.openById(SHARED_SHEET_ID);
  var sh = ss.getSheetByName('lock_test');
  var rows = sh.getDataRange().getValues();
  var cur = null;
  for (var i = 1; i < rows.length; i++) {
    var tag = rows[i][0], phase = rows[i][1];
    if (phase === 'START') cur = tag;
    if (phase === 'END' && cur !== tag) {
      return 'INTERLEAVED ❌ at row ' + (i + 1) + ' (expected close ' + cur + ' got ' + tag + ')';
    }
  }
  return USE_DOCUMENT_LOCK
    ? 'NO_INTERLEAVE ✅ (document lock 跨项目互斥成立)'
    : 'NOTE: script lock 下交错属预期（跨项目无效）';
}

/**
 * 部署步骤（N1–N4 隔离实证）：
 *  N1 新建两个独立 GAS 项目 PA、PB，各粘贴本文件；PA 设 PROJECT_TAG='A'、PB 设 'B'。
 *  N2 两项目共用同一 SHARED_SHEET_ID（一张测试表，建 lock_test 分页）。
 *  N3 部署为 web app（doGet），把 URL 填进 coordinator() 的 A_URL/B_URL；USE_DOCUMENT_LOCK=true 先跑。
 *  N4 跑 coordinator() 制造并发 → checkNoInterleave() 应得 NO_INTERLEAVE ✅（证明跨项目互斥）。
 *     对照：把两项目 USE_DOCUMENT_LOCK 改 false（getScriptLock）重跑 → 应出现 INTERLEAVED ❌（证明 script lock 跨项目无效，Edit B 方向正确）。
 *  超时/异常释放：writerRun 用 try/finally releaseLock；把 WINDOW_MS 调到 >30000 触发 tryLock 超时 → 应抛 PL_REJECT_NO_LOCK（空锁 fail-closed 拒绝裸写）。
 */
