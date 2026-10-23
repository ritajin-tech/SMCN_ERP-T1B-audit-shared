# -*- coding: utf-8 -*-
"""T1-B PKC-v2p7 日期规范化**单一实现**（Tom 23:58 二：同一版本日期规则须统一函数/版本）。

背景：v2p6 中主测试 canon_date 采用「尾串白名单」，而 layer_conversion / schema_registry
两个辅助脚本仍接受「ISO 前缀后任意尾串并截断」，合同 §3 亦残留任意尾串表述 —— 同一版本内
日期规则不一致。本模块为**唯一实现**，三个产物统一 import，避免再次分叉。

规则（显式声明，不把格式错误悄然合法化）：
  1. 空串 -> 空串（交 empty_date 判定，与历法分离）
  2. 纯 ISO `YYYY-MM-DD` -> 原样返回
  3. ISO + 时间尾串：**仅在尾串形状与**时间分量范围**均合法时才截断取前 10 位**
     - 允许形状：`YYYY-MM-DD[T ]HH:MM[:SS][.fff][Z|±HH:MM]`
     - 范围校验：`HH <= 23`、`MM <= 59`、`SS <= 59`
     - 形状匹配但范围非法（如 `2026-04-01 99:99`）**不截断** -> 原值交由 valid_calendar 判 illegal_calendar
  4. US `M/D/Y` -> 规范化为 `YYYY-MM-DD`（用真实历法校验；不合法则原样返回）
  5. 其余一律原样返回（不截断、不猜测）

范围校验的依据：白名单正则本身只校验形状，**形状匹配 ≠ 时间有效**（Tom：不能将 99:99 等
仅因形状匹配便称时间有效）。日期解析正确亦不等于业务日期正确——历法校验与业务裁定继续分离。
"""
import re
import datetime

CANON_VERSION = "PKC-v2p7-canon-1"

ISO_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
# 时间尾串白名单：形状捕获 HH/MM/SS 以便做分量范围校验
TIME_TAIL = re.compile(
    r"\d{4}-\d{2}-\d{2}[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?"
)
US_DATE = re.compile(r"(\d{1,2})/(\d{1,2})/(\d{4})")

ACCEPTED_FORMATS = (
    "YYYY-MM-DD",
    "YYYY-MM-DD[T ]HH:MM[:SS][.fff][Z|±HH:MM]（且 HH<=23 / MM<=59 / SS<=59）",
    "M/D/Y（US，按真实历法校验后规范化）",
)


def time_components_ok(m):
    """时间分量范围校验：形状匹配不等于时间有效。"""
    hh = int(m.group(1))
    mm = int(m.group(2))
    ss = int(m.group(3)) if m.group(3) is not None else 0
    return hh <= 23 and mm <= 59 and ss <= 59


def canon_date(v):
    """日期规范化（唯一实现）。不存在日期/非法尾串一律原样保留，由 valid_calendar 判定。"""
    s = v if isinstance(v, str) else ("" if v is None else str(v))
    if s == "":
        return ""
    if ISO_DATE.fullmatch(s):
        return s
    m = TIME_TAIL.fullmatch(s)
    if m:
        return s[:10] if time_components_ok(m) else s      # 范围非法 -> 不截断
    m = US_DATE.fullmatch(s)
    if m:
        mo, dy, yr = int(m.group(1)), int(m.group(2)), int(m.group(3))
        try:
            datetime.date(yr, mo, dy)
            return "%04d-%02d-%02d" % (yr, mo, dy)
        except ValueError:
            return s
    return s
