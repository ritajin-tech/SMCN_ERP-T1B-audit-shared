// ts_softdel_norm.js — 字段规范化 / 类型保全 / SHA-256 指纹（单一可信源）
//
// 设计目标（回应 Tom 2026-10-27 复审，条件 #2/#3/#4）：
//  - 类型保全：绝不把"看起来像数字的字符串"统一 coercion 成数字（否则前导零 ID/工号/备注
//    "007" 会被并成 7，导致哈希误判）。用显式类型标签 num/bool/date/str/null。
//  - 业务日期（列1）纳入指纹，规范为显式时区 ISO（YYYY-MM-DDTHH:mm:ss+08:00）。
//  - 录入时间（列0）默认纳入指纹；仅当显式 timeOnly 时排除出哈希，但仍由调用方分别绑定
//    （expectEntryTime / keeperEntryTime），绝不"放掉"校验。
//  - 审计列 O（列14）纳入指纹，保全原审计版本：预期 O=FALSE（未软标）由哈希约束。
//  - 不使用裸分隔符拼接（避免内容碰撞），改用 JSON 定长数组（自带转义）。
//  - 用 SHA-256（密码学）而非 djb2 32 位弱哈希。
//  - 双环境：Node 走 crypto；GAS 走 Utilities.computeDigest。代码由 v4_genpatches 同文生成，
//    保证 GAS 内联副本与 Node 模块逐字一致（见 harness 的「跨环境一致性」断言）。
//
// 本文件是「单一可信源」：GAS RemoteActions 的对应函数由 v4_genpatches.py 从本文件文本生成，
// 不另写一份逻辑，避免漂移。

'use strict';

// ---- 显式时区 ISO：把 Date / 日期串规范为 GMT+8 墙面时钟 ----
// 约定（与 ts_softdel.js 既有约定一致）：日期串按 UTC 解析后 +8h 再取墙面时钟；
// GAS 原生 Date 用 Utilities.formatDate(...,'GMT+8',...) 得到同一墙面时钟。
function _sdIsoTz(v) {
  var d = null;
  if (v instanceof Date) {
    d = v;
  } else if (typeof v === 'string') {
    var s = v.trim();
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
    if (!m) return null;
    var y = +m[1], mo = +m[2], da = +m[3];
    if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
    var hh = m[4] !== undefined ? +m[4] : 0;
    var mi = m[5] !== undefined ? +m[5] : 0;
    var ss = m[6] !== undefined ? +m[6] : 0;
    if (hh > 23 || mi > 59 || ss > 59) return null;
    d = new Date(Date.UTC(y, mo - 1, da, hh, mi, ss));
  }
  if (!d || isNaN(d.getTime())) return null;
  var t = d.getTime() + 8 * 3600 * 1000;     // 墙面时钟 = 该瞬时的 GMT+8
  var u = new Date(t);
  var p = function (n) { return (n < 10 ? '0' + n : '' + n); };
  return u.getUTCFullYear() + '-' + p(u.getUTCMonth() + 1) + '-' + p(u.getUTCDate()) +
    'T' + p(u.getUTCHours()) + ':' + p(u.getUTCMinutes()) + ':' + p(u.getUTCSeconds()) + '+08:00';
}

// ---- 类型保全 token：绝不把数字串 coercion 成数字 ----
function _sdCellTok(v) {
  if (v === null || v === undefined) return ['null'];
  if (typeof v === 'number') return ['num', String(v)];
  if (typeof v === 'boolean') return ['bool', v ? 'true' : 'false'];
  // GAS 原生 Date —— 规范为显式时区 ISO
  if (typeof v === 'object' && typeof v.getFullYear === 'function') {
    var iso = _sdIsoTz(v);
    return iso ? ['date', iso] : ['null'];
  }
  // 字符串：逐字保留（含前导零 ID/工号/备注），不做任何数字 coercion
  return ['str', String(v)];
}

// ---- 纳入指纹的列：timeOnly 时排除录入时间列0，但仍由调用方绑定 ----
function _sdHashCols(timeOnly) {
  var cols = [1];                       // 业务日期（列1，显式时区 ISO）
  for (var c = 2; c <= 13; c++) cols.push(c);  // 负载列 2..13
  if (!timeOnly) cols.push(0);          // 录入时间（列0）：仅非 timeOnly 纳入哈希
  cols.push(14);                        // 审计列 O（列14）：保全原审计版本
  return cols;
}

// ---- 定长 JSON 数组（自带转义，避免裸分隔符碰撞）----
function _sdCanonRow(cells, cols) {
  var arr = [];
  for (var i = 0; i < cols.length; i++) {
    arr.push(_sdCellTok(cells ? cells[cols[i]] : undefined));
  }
  return JSON.stringify(arr);
}

// ---- SHA-256：双环境 ----
function _sdSha256(s) {
  if (typeof Utilities !== 'undefined') {
    var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
    var hex = '';
    for (var i = 0; i < bytes.length; i++) {
      var b = (bytes[i] < 0) ? (bytes[i] + 256) : bytes[i];
      hex += (b < 16 ? '0' : '') + b.toString(16);
    }
    return 'sha256:' + hex;
  }
  // Node
  var crypto = require('crypto');
  return 'sha256:' + crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

// ---- 行指纹 ----
function _sdRowHash(cells, timeOnly) {
  return _sdSha256(_sdCanonRow(cells, _sdHashCols(timeOnly)));
}

// ---- 兼容旧代码的轻量归一（数值字符串规范化、不含 Date）：保留以维持既有比对 ----
function _sdNorm(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  var s = String(v).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return String(Number(s));
  return s;
}
// ---- O 列归一化（v5，Tom 第 6 项）----
// 真实返回的 O 值可能是布尔 true（GAS getValues 对勾选框/布尔单元格）、字符串 'TRUE'/'true'、
// 空值或别的类型。此前用 _sdNorm(true) 会得到小写 'true'，与 'TRUE' 比较必然失败，
// 并把一次**已经成功**的写入误记为 REJECTED（谎报未写）。统一入口：一律归一为大写串。
function _sdNormO(v) {
  if (v === undefined || v === null) return '';
  if (v === true) return 'TRUE';
  if (v === false) return 'FALSE';
  if (typeof v === 'number') return String(v);
  return String(v).trim().toUpperCase();
}
function _sdSoftDel(r) {
  return _sdNormO(r) === 'TRUE';
}

// ---- 固定测试向量（跨 GAS/Node 一致性证据）----
// 这些向量在 v4_genpatches 生成 GAS 副本、harness 自检时都用同一组输入；
// EXPECTED 为作者期（Node 运行）固化的已知 SHA-256，任何算法漂移都会让断言失败。
function _sdTestVectors() {
  function blank() { return new Array(15).fill(''); }
  var v = [];
  // V1: 全空行（timeOnly=false）
  v.push({ name: 'V1_empty', cells: blank(), timeOnly: false,
    EXPECTED: 'sha256:40ad38542f0328c17fc8f23265eefe2abee16f55c7b46cf2ae335a407a84941a' });
  // V2: 前导零工号（timeOnly=false）—— 必须保留 "007"，不能并成 7
  var a2 = blank(); a2[2] = 'Name007'; a2[8] = '007'; a2[6] = 8;
  v.push({ name: 'V2_leadingzero', cells: a2, timeOnly: false,
    EXPECTED: 'sha256:7b51833a117f87b87a5a9dd51093da410b2538730545162866998cd0ae73d08e' });
  // V3: 业务日期（列1）纳入、显式时区
  var a3 = blank(); a3[1] = '2026-10-15'; a3[8] = 'UUID-A';
  v.push({ name: 'V3_bizdate', cells: a3, timeOnly: false,
    EXPECTED: 'sha256:f546e8f9c0da6596d5eb780bbff5d62f34bf3b155991286ab249d21691c82350' });
  // V4: timeOnly=true —— 列0 录入时间排除出哈希，但列1/2..13/14 仍在
  var a4 = blank(); a4[0] = '2026-10-01 09:00'; a4[1] = '2026-11-02'; a4[8] = 'UUID-B';
  v.push({ name: 'V4_timeonly', cells: a4, timeOnly: true,
    EXPECTED: 'sha256:0770cd3897dcb0742cf5b55b39ec1627f286534cc4b4139c54b5081f4341d4b2' });
  return v;
}

// ---- 自检：返回每个向量的 实际/期望 是否一致 ----
function _sdSelfTest() {
  var vecs = _sdTestVectors();
  var out = [];
  for (var i = 0; i < vecs.length; i++) {
    var got = _sdRowHash(vecs[i].cells, vecs[i].timeOnly);
    out.push({ name: vecs[i].name, expected: vecs[i].EXPECTED, got: got, ok: (got === vecs[i].EXPECTED) });
  }
  return out;
}

// ---- Node 导出（GAS 侧由 genpatches 内联，不依赖 require）----
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    _sdIsoTz: _sdIsoTz, _sdCellTok: _sdCellTok, _sdHashCols: _sdHashCols,
    _sdCanonRow: _sdCanonRow, _sdSha256: _sdSha256, _sdRowHash: _sdRowHash,
    _sdNorm: _sdNorm, _sdNormO: _sdNormO, _sdSoftDel: _sdSoftDel,
    _sdTestVectors: _sdTestVectors, _sdSelfTest: _sdSelfTest
  };
}
