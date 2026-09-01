#!/usr/bin/env python3
"""打新日历核心逻辑（统一收口）。

原本 ipo_daily_report.py 与 refresh_calendar.py 各自维护了一份完全相同的
_str_date / fetch_calendar / build_upcoming_calendar，导致"改一处漏一处"
（历史上就因 _str_date 只认带横杠日期而反复漏数据）。

现统一到本模块，两个脚本都从此处 import，从源头消除重复。
本模块只读取 PostgreSQL 中已入库的新股事实、交易日历和可转债标准事件。
"""

import os
import re
import json
from datetime import datetime, timedelta

from _common import _load_env

_load_env()

CB_ISSUE_FIELDS = "ts_code,ann_date,res_ann_date,issue_size,issue_price,issue_type,shd_ration_record_date,shd_ration_ratio,onl_date,onl_size,onl_pch_num,offl_size,shd_ration_size,onl_name"
CB_BASIC_FIELDS = "ts_code,bond_full_name,bond_short_name,cb_type,stk_code,stk_short_name,maturity,par,issue_price,issue_size,remain_size,value_date,maturity_date,rate_type,coupon_rate,add_rate,pay_per_year,list_date,delist_date,exchange,conv_start_date,conv_end_date,conv_stop_date,first_conv_price,conv_price,issue_rating,newest_rating,rating_comp"


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


def next_trading_date(start_date=None):
    """从已入库交易日历返回 start_date 之后的下一个交易日。"""
    start = start_date or datetime.now()
    if not isinstance(start, datetime):
        start = datetime.combine(start, datetime.min.time())
    import db_pg
    conn = db_pg.connect()
    try:
        row = conn.execute(
            "SELECT trade_date::text FROM market.trade_calendar "
            "WHERE exchange='SSE' AND is_open=true AND trade_date>?::date "
            "ORDER BY trade_date LIMIT 1",
            (start.date().isoformat(),),
        ).fetchone()
    finally:
        conn.close()
    if not row:
        raise RuntimeError(f"trade_calendar 没有 {start.date().isoformat()} 之后的已入库交易日")
    return datetime.strptime(str(row[0])[:10], "%Y-%m-%d")


# ============ 已入库标准事实读取 ============


def fetch_calendar_entries(start_date=None, end_date=None, full=False):
    """从 ipo_history 与标准可转债事件表读取新股/新债日历。

    增量优化（整改报告 P1）：默认只拉近期窗口，不再每次全量拉取。
    - 默认窗口：今天前60天 ~ 今天后90天（覆盖已公告未上市 + 未来90天申购/上市）。
    - full=True 时强制全量（用于手动补历史）。
    - start_date/end_date 可显式指定（YYYY-MM-DD 或 YYYYMMDD），优先级高于默认窗口。

    返回与东财同构的字典列表，键保持：
    TRADE_DATE, DATE_TYPE(申购/上市), SECURITY_TYPE(0=股票,1=债券),
    SECURITY_NAME_ABBR, SECURITY_CODE(6位), SECUCODE(ts_code)
    """
    today = datetime.now().date()
    if not full:
        if not start_date:
            start_date = (today - timedelta(days=60)).strftime("%Y-%m-%d")
        if not end_date:
            end_date = (today + timedelta(days=90)).strftime("%Y-%m-%d")
    win_start = _str_date(start_date) or (today - timedelta(days=60)).strftime("%Y-%m-%d")
    win_end = _str_date(end_date) or (today + timedelta(days=90)).strftime("%Y-%m-%d")
    import db_pg
    conn = db_pg.connect()
    try:
        rows = conn.execute(
            """SELECT event_date,event_type,security_type,name,code,secu_code FROM (
                 SELECT ipo_date AS event_date,'申购' AS event_type,'0' AS security_type,
                        security_name AS name,security_code AS code,security_code AS secu_code
                   FROM ipo_history WHERE ipo_date ~ '^\\d{4}-\\d{2}-\\d{2}$'
                 UNION ALL
                 SELECT listing_date,'上市','0',security_name,security_code,security_code
                   FROM ipo_history WHERE listing_date ~ '^\\d{4}-\\d{2}-\\d{2}$'
                 UNION ALL
                 SELECT e.event_date::text,
                        CASE e.event_type WHEN 'online_subscription' THEN '申购' ELSE '上市' END,
                        '1',i.name,split_part(i.canonical_code,'.',1),i.canonical_code
                   FROM event.instrument_events e
                   JOIN core.instruments i ON i.instrument_id=e.instrument_id
                   LEFT JOIN fundamental.convertible_bond_issuance iss ON iss.instrument_id=e.instrument_id
                  WHERE i.asset_class='convertible_bond'
                    AND e.event_type IN ('online_subscription','listing')
                    AND (iss.issue_type IS NULL OR iss.issue_type NOT IN ('定向','私募'))
               ) facts
              WHERE (? OR event_date BETWEEN ? AND ?)
              ORDER BY event_date,security_type,code,event_type""",
            (bool(full), win_start, win_end),
        ).fetchall()
    finally:
        conn.close()
    all_data = [{
        "TRADE_DATE": _str_date(row[0]), "DATE_TYPE": row[1],
        "SECURITY_TYPE": row[2], "SECURITY_NAME_ABBR": str(row[3] or ""),
        "SECURITY_CODE": str(row[4] or ""), "SECUCODE": str(row[5] or ""),
    } for row in rows]
    cb_basic_kept = sum(1 for row in all_data if row["SECURITY_TYPE"] == "1" and row["DATE_TYPE"] == "上市")

    scope = "全量(不限窗口)" if full else f"{win_start}~{win_end}"
    print(f"[日历] 拉取完成 范围={scope} 共 {len(all_data)} 条（其中新债上市 {cb_basic_kept} 条）")
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
