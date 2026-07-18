#!/usr/bin/env python3
"""打新日历核心逻辑（统一收口）。

原本 ipo_daily_report.py 与 refresh_calendar.py 各自维护了一份完全相同的
_str_date / fetch_calendar / build_upcoming_calendar，导致"改一处漏一处"
（历史上就因 _str_date 只认带横杠日期而反复漏数据）。

现统一到本模块，两个脚本都从此处 import，从源头消除重复。
本模块零重依赖（仅 urllib + 标准库），不引入 tushare 库 / fitz / psycopg2。
"""

import os
import re
import json
import urllib.request
from datetime import datetime, timedelta

from _common import _load_env, _tushare, TUSHARE_TOKEN

_load_env()


def _str_date(val):
    """Tushare 日期可能为 None/NaN，安全转为 YYYY-MM-DD 或空串。

    兼容两种格式：横杠 YYYY-MM-DD 与无横杠 YYYYMMDD。
    新股申购/上市、转债上市用无横杠格式，转债申购用横杠格式。
    """
    if val is None:
        return ""
    try:
        if float(val) != float(val):  # NaN
            return ""
    except (ValueError, TypeError):
        pass
    s = str(val).strip()
    # 无横杠格式 YYYYMMDD → YYYY-MM-DD
    if re.match(r"^\d{8}$", s):
        return f"{s[:4]}-{s[4:6]}-{s[6:8]}"
    return s[:10] if re.match(r"^\d{4}-\d{2}-\d{2}$", s[:10]) else ""


# ============ Tushare REST 调用（零依赖，不依赖 tushare 库）—— 已收口到 _common.py ============


def fetch_calendar_entries():
    """获取新股/新债日历数据（Tushare: new_share + cb_issue + cb_basic）。

    返回与东财同构的字典列表，键保持：
    TRADE_DATE, DATE_TYPE(申购/上市), SECURITY_TYPE(0=股票,1=债券),
    SECURITY_NAME_ABBR, SECURITY_CODE(6位), SECUCODE(ts_code)
    """
    all_data = []

    # 1. 新股：申购日 ipo_date / 上市日 issue_date
    try:
        df = _tushare("new_share", {}, "ts_code,name,ipo_date,issue_date")
        for r in df:
            ts_code = str(r.get("ts_code") or "")
            if not ts_code:
                continue
            code6 = ts_code.split(".")[0]
            abbr = str(r.get("name") or "")
            ipo = r.get("ipo_date")
            issue = r.get("issue_date")
            if ipo:
                all_data.append({
                    "TRADE_DATE": _str_date(ipo), "DATE_TYPE": "申购",
                    "SECURITY_TYPE": "0", "SECURITY_NAME_ABBR": abbr,
                    "SECURITY_CODE": code6, "SECUCODE": ts_code,
                })
            if issue:
                all_data.append({
                    "TRADE_DATE": _str_date(issue), "DATE_TYPE": "上市",
                    "SECURITY_TYPE": "0", "SECURITY_NAME_ABBR": abbr,
                    "SECURITY_CODE": code6, "SECUCODE": ts_code,
                })
    except Exception as e:
        print(f"[日历] 新股获取失败: {e}")

    # 2. 新债申购：cb_issue.onl_date
    try:
        df2 = _tushare("cb_issue", {}, "ts_code,onl_name,onl_date")
        for r in df2:
            ts_code = str(r.get("ts_code") or "")
            if not ts_code:
                continue
            code6 = ts_code.split(".")[0]
            abbr = str(r.get("onl_name") or "")
            onl = r.get("onl_date")
            if onl:
                all_data.append({
                    "TRADE_DATE": _str_date(onl), "DATE_TYPE": "申购",
                    "SECURITY_TYPE": "1", "SECURITY_NAME_ABBR": abbr,
                    "SECURITY_CODE": code6, "SECUCODE": ts_code,
                })
    except Exception as e:
        print(f"[日历] 新债申购获取失败: {e}")

    # 3. 新债上市：cb_basic.list_date
    try:
        df3 = _tushare("cb_basic", {}, "ts_code,bond_short_name,list_date")
        for r in df3:
            ts_code = str(r.get("ts_code") or "")
            if not ts_code:
                continue
            ld = r.get("list_date")
            if not ld:
                continue
            code6 = ts_code.split(".")[0]
            abbr = str(r.get("bond_short_name") or "")
            all_data.append({
                "TRADE_DATE": _str_date(ld), "DATE_TYPE": "上市",
                "SECURITY_TYPE": "1", "SECURITY_NAME_ABBR": abbr,
                "SECURITY_CODE": code6, "SECUCODE": ts_code,
            })
    except Exception as e:
        print(f"[日历] 新债上市获取失败: {e}")

    return all_data


def build_upcoming_calendar(calendar, days=90, apply_stocks=None, apply_bonds=None):
    """从全量日历筛选今天起未来 days 天的申购/上市事件，按日期分组。

    用于前端『打新日历』：列出还没过申购的申购日、还没上市的上市日。
    只展示已有明确日期的标的；没有明确日期的已公告标的（如尚未公布申购日的新股）不在日历中显示。
    """
    try:
        today = datetime.now().date()
    except Exception:
        today = datetime.today().date()
    end = today + timedelta(days=days)
    end_str = end.strftime("%Y-%m-%d")
    today_str = today.strftime("%Y-%m-%d")
    groups = {}
    order = []

    def _is_bj_stock(code, secucode=""):
        return str(secucode).upper().endswith(".BJ") or str(code).startswith(("920", "82", "83", "87", "43"))

    def _ensure_group(td_k):
        if td_k not in groups:
            try:
                dd = datetime.strptime(td_k, "%Y-%m-%d").date()
            except Exception:
                return None
            groups[td_k] = {
                "date": td_k,
                "weekday": ["周一", "周二", "周三", "周四", "周五", "周六", "周日"][dd.weekday()],
                "apply_stocks": [], "apply_bonds": [], "list_stocks": [], "list_bonds": [],
            }
            order.append(td_k)
        return groups[td_k]

    for item in calendar:
        td = (item.get("TRADE_DATE") or "")[:10]
        if not td:
            continue
        try:
            d = datetime.strptime(td, "%Y-%m-%d").date()
        except Exception:
            continue
        if d < today or d > end:
            continue
        g = _ensure_group(td)
        secu_type = item.get("SECURITY_TYPE", "0")
        name = item.get("SECURITY_NAME_ABBR", "")
        code = item.get("SECURITY_CODE", "")
        if secu_type != "1" and _is_bj_stock(code, item.get("SECUCODE", "")):
            continue
        ent = {"name": name, "code": code}
        if item.get("DATE_TYPE") == "申购":
            if secu_type == "1":
                g["apply_bonds"].append(ent)
            else:
                g["apply_stocks"].append(ent)
        else:
            if secu_type == "1":
                g["list_bonds"].append(ent)
            else:
                g["list_stocks"].append(ent)

    # 补充：申购建议中已公告且明确了申购日(online_date)的标的，补入对应日期组。
    # 无明确日期的标的按用户要求不在日历显示。
    def _add_dated(items, group_key):
        if not items:
            return
        for s in items:
            c = s.get("code", "")
            if not c:
                continue
            if group_key == "apply_stocks" and _is_bj_stock(c):
                continue
            d = s.get("detail") or {}
            od = d.get("online_date", "")
            if not od:
                continue
            td_k = od[:10]
            if td_k < today_str or td_k > end_str:
                continue
            g = _ensure_group(td_k)
            if not g:
                continue
            ent = {"name": s.get("name", ""), "code": c}
            if ent not in g[group_key]:
                g[group_key].append(ent)

    _add_dated(apply_stocks, "apply_stocks")
    _add_dated(apply_bonds, "apply_bonds")

    return [groups[k] for k in sorted(order)]
