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

from _common import _load_env, _tushare, TUSHARE_REPLAY_API_KEY

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
    """返回 start_date 之后的下一个实际交易日，兼容周末和法定节假日。"""
    start = start_date or datetime.now()
    if not isinstance(start, datetime):
        start = datetime.combine(start, datetime.min.time())
    begin = start.date() + timedelta(days=1)
    end = begin + timedelta(days=31)
    try:
        rows = _tushare(
            "trade_cal",
            {
                "exchange": "SSE",
                "start_date": begin.strftime("%Y%m%d"),
                "end_date": end.strftime("%Y%m%d"),
                "is_open": "1",
            },
            "cal_date,is_open",
        )
        open_dates = sorted(
            _str_date(row.get("cal_date"))
            for row in rows
            if str(row.get("is_open")) == "1" and _str_date(row.get("cal_date"))
        )
        if open_dates:
            return datetime.strptime(open_dates[0], "%Y-%m-%d")
    except Exception as exc:
        print(f"[日历] 实际交易日查询失败，暂按工作日兜底: {exc}")

    # 上游不可用时只作为兜底，避免报告任务因日期查询暂时失败而中断。
    candidate = begin
    while candidate.weekday() >= 5:
        candidate += timedelta(days=1)
    return datetime.combine(candidate, datetime.min.time())


# ============ Tushare REST 调用（零依赖，不依赖 tushare 库）—— 已收口到 _common.py ============


def fetch_calendar_entries(start_date=None, end_date=None, full=False):
    """获取新股/新债日历数据（Tushare: new_share + cb_issue + cb_basic）。

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
    sd_int = str(start_date).replace("-", "") if (not full and start_date) else None
    ed_int = str(end_date).replace("-", "") if (not full and end_date) else None

    all_data = []
    new_share_ok = False

    # 1. 新股：申购日 ipo_date / 上市日 issue_date（服务端按日期窗口过滤）
    try:
        params = {}
        if sd_int:
            params["start_date"] = sd_int
        if ed_int:
            params["end_date"] = ed_int
        df = _tushare("new_share", params, "ts_code,name,ipo_date,issue_date")
        if not df:
            raise RuntimeError("Tushare new_share 返回空结果")
        new_share_ok = True
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

    # 2. 新债申购：cb_issue.onl_date（服务端按日期窗口过滤）
    df2 = []
    try:
        if not new_share_ok:
            raise RuntimeError("新股日历数据源失败，任务不得标记成功")
        params2 = {}
        if sd_int:
            params2["start_date"] = sd_int
        if ed_int:
            params2["end_date"] = ed_int
        df2 = _tushare("cb_issue", params2, CB_ISSUE_FIELDS)
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

    # 3. 新债上市：cb_basic.list_date（接口不支持日期范围，全量拉取后内存过滤窗口）
    cb_basic_kept = 0
    df3 = []
    try:
        df3 = _tushare("cb_basic", {}, CB_BASIC_FIELDS)
        for r in df3:
            ts_code = str(r.get("ts_code") or "")
            if not ts_code:
                continue
            ld = r.get("list_date")
            if not ld:
                continue
            ld_s = _str_date(ld)
            if not full and ld_s and (ld_s < win_start or ld_s > win_end):
                continue
            code6 = ts_code.split(".")[0]
            abbr = str(r.get("bond_short_name") or "")
            all_data.append({
                "TRADE_DATE": ld_s, "DATE_TYPE": "上市",
                "SECURITY_TYPE": "1", "SECURITY_NAME_ABBR": abbr,
                "SECURITY_CODE": code6, "SECUCODE": ts_code,
            })
            cb_basic_kept += 1
    except Exception as e:
        print(f"[日历] 新债上市获取失败: {e}")

    # cb_issue 已成功时，即使 cb_basic 暂时失败，也要把发行事实先写入统一层。
    if df2:
        try:
            from bond_data_layer import save_cb_issue_rows
            rating_map = {
                str(row.get("ts_code")): row.get("newest_rating") or row.get("issue_rating")
                for row in df3 if row.get("ts_code")
            }
            save_cb_issue_rows(df2, df3, rating_map)
        except Exception as exc:
            print(f"[日历] 可转债标准化入库失败（保留已有数据）: {exc}")

    scope = "全量(不限窗口)" if full else f"{win_start}~{win_end}"
    print(f"[日历] 拉取完成 范围={scope} 共 {len(all_data)} 条（其中新债上市 {cb_basic_kept} 条）")
    if not new_share_ok:
        raise RuntimeError("新股日历数据源失败，任务不得标记成功")
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
