// masterException.gs —— 考勤表(主库)「月度异常」矩阵 —— 【DISABLED 2026-10-15】
// ============================================================
// 2026-10-15 Rita 决定：审查期间暂停 07:00 月度异常自动刷新。
// 本文件已禁用：refreshMasterException 改为纯 no-op，不读取/不写入任何工作表、
// 不重建 07:00 触发器、不写 _TS_WRITE_LOG。触发器仍安装但调用即直接返回，等效暂停。
// 恢复方式：将本文件还原为上一版（v165）源码即可。
// ============================================================
var MASTER_EXCEPTION_SHEET = '月度异常';

function ensureMasterExceptionTrigger() {
  // 禁用期：不再自检/重建 07:00 触发器。
  return;
}

function refreshMasterException(yearMonth) {
  // 【DISABLED 2026-10-15】Rita 决定审查期间暂停。零副作用返回。
  console.log('[refreshMasterException] DISABLED 2026-10-15 by Rita decision — no-op.');
  return '[PAUSED] 月度异常刷新已暂停（2026-10-15 Rita 决定，审查期间不运行）。';
}
