# 本文件由 ipo_daily_report.py 物理拆分而来，函数体/常量未改动，仅调整文件归属。
import requests
import json
import os
import re
from collections import defaultdict
import time
from datetime import datetime, timedelta
import fitz  # PyMuPDF - PDF解析
import db_pg  # PostgreSQL 数据层
from calendar_core import _str_date, build_upcoming_calendar, fetch_calendar_entries
from _classify import _is_bj_stock, _market_type_to_board_key
from _common import _load_env
from ipo_lib_common import *
from ipo_lib_fetch import *

def _bond_predicted_return(pred_price, fallback=None):
    """新债首个非涨停日预测涨幅，统一按发行价100元计算。"""
    if pred_price is not None:
        return round(float(pred_price) - 100, 2)
    return fallback

def _bond_first_non_limit_return(stored_return):
    """bond_history与预测准确率统一使用首个非涨停日涨幅。"""
    if stored_return is None:
        return None
    return round(float(stored_return), 2)

def _log_prediction_errors():
    """
    统计预测 vs 实际误差，输出到日志供参考
    后续可用此数据自动校准预测参数
    """
    import sqlite3
    from datetime import datetime, timedelta

    conn = _init_ipo_db()
    cutoff = (datetime.now() - timedelta(days=90)).strftime("%Y-%m-%d")

    for ptype, label in [("stock", "新股"), ("bond", "新债")]:
        rows = conn.execute(
            "SELECT name, code, pred_return, actual_return, listing_date FROM predictions "
            "WHERE type=? AND status='fulfilled' AND actual_return IS NOT NULL AND pred_return IS NOT NULL "
            "AND pred_date >= ? ORDER BY listing_date DESC LIMIT 10",
            (ptype, cutoff),
        ).fetchall()
        if rows:
            errors = [abs(r[2] - r[3]) for r in rows if r[3] is not None]
            if errors:
                mae = round(sum(errors) / len(errors), 1)
                bias = round(sum(r[3] - r[2] for r in rows if r[3] is not None) / len(errors), 1)
                print(f"[校准] {label}预测偏差: MAE={mae}pp, 平均偏向={bias}pp（正=低估, 负=高估）")
                # 偏差过大时输出明细
                if abs(bias) > 100:
                    print(f"[校准] {label}偏差较大，明细如下：")
                    for r in rows:
                        if r[3] is not None:
                            print(f"  {r[0]}({r[1]}): 预测{r[2]}% 实际{r[3]}% 误差{r[3]-r[2]:+.1f}pp")

    conn.close()

def save_predictions(apply_stocks, apply_bonds, list_stocks, list_bonds, pred_date):
    """保存预测记录到数据库"""
    import sqlite3
    today_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    conn = _init_ipo_db()

    rows = []
    for s in apply_stocks + list_stocks:
        analysis = s.get("listing_analysis", {})
        pred_return = None
        if isinstance(analysis, dict):
            pred_return = analysis.get("predicted_return") or analysis.get("price")
        advice = s.get("advice", "")
        listing_date = pred_date

        rows.append(("stock", s["code"], s["name"], listing_date,
                      pred_date, pred_return, None, advice,
                      today_str))

    for b in apply_bonds + list_bonds:
        analysis = b.get("listing_analysis", {})
        pred_price = None
        pred_return = None
        if isinstance(analysis, dict):
            # tracking_price是不受首日157.3元涨停限制的理论价格，用于预测首个非涨停日。
            pred_price = analysis.get("tracking_price", analysis.get("price"))
            pred_return = _bond_predicted_return(pred_price)
        advice = b.get("advice", "")
        listing_date = pred_date

        # 申购日通常还没有上市价预测，不写入无预测值的跟踪记录。
        if pred_return is None:
            continue

        rows.append(("bond", b["code"], b["name"], listing_date,
                      pred_date, pred_return, pred_price, advice,
                      today_str))

    for row in rows:
        try:
            conn.execute("""
                INSERT OR REPLACE INTO predictions
                    (type, code, name, listing_date, pred_date, pred_return, pred_price, pred_advice, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?)
            """, row)
        except Exception:
            pass
    conn.commit()
    conn.close()
    if rows:
        print(f"[预测跟踪] 已保存 {len(rows)} 条预测记录")

def backfill_prediction_actuals():
    """补全已上市的预测记录，并回填实际结果"""
    from datetime import datetime

    conn = _init_ipo_db()
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # ── 1. 补全：bond_history / ipo_history 已上市但 predictions 缺记录的 ──
    bond_rows = conn.execute(
        "SELECT security_code, security_name, listing_date, first_day_return FROM bond_history WHERE first_day_return IS NOT NULL"
    ).fetchall()
    for code, name, ldate, fdr in bond_rows:
        if not conn.execute("SELECT 1 FROM predictions WHERE code=?", (code,)).fetchone():
            ld = str(ldate)[:10] if ldate else None
            conn.execute(
                "INSERT INTO predictions (type,code,name,listing_date,pred_date,actual_return,status,updated_at) VALUES ('bond',?,?,?,?,?,'fulfilled',?)",
                (code, name, ld, ld, fdr, now),
            )
    stock_rows = conn.execute(
        "SELECT security_code, security_name, listing_date, ld_close_change FROM ipo_history WHERE ld_close_change IS NOT NULL"
    ).fetchall()
    for code, name, ldate, ldc in stock_rows:
        if not conn.execute("SELECT 1 FROM predictions WHERE code=?", (code,)).fetchone():
            ld = str(ldate)[:10] if ldate else None
            conn.execute(
                "INSERT INTO predictions (type,code,name,listing_date,pred_date,actual_return,status,updated_at) VALUES ('stock',?,?,?,?,?,'fulfilled',?)",
                (code, name, ld, ld, ldc, now),
            )
    conn.commit()

    # ── 2. 刷新所有有预测值且已上市的实际结果 ──
    # 不只更新 pending：历史行情可能在后续任务中被修正，fulfilled 也必须同步刷新。
    tracked = conn.execute(
        "SELECT id, type, code, name, listing_date, pred_price FROM predictions "
        "WHERE (pred_return IS NOT NULL OR pred_price IS NOT NULL) AND listing_date <= ?",
        (datetime.now().strftime("%Y-%m-%d"),),
    ).fetchall()

    updated = 0
    for pid, ptype, code, name, listing_date, pred_price in tracked:
        try:
            if ptype == "stock":
                row = conn.execute(
                    "SELECT ld_close_change FROM ipo_history WHERE security_code=? AND ld_close_change IS NOT NULL",
                    (code,),
                ).fetchone()
                if row:
                    conn.execute(
                        "UPDATE predictions SET actual_return=?, status='fulfilled', updated_at=? WHERE id=?",
                        (row[0], now, pid),
                    )
                    updated += 1
            else:
                row = conn.execute(
                    "SELECT first_day_return FROM bond_history WHERE security_code=? AND first_day_return IS NOT NULL",
                    (code,),
                ).fetchone()
                if row:
                    actual_return = _bond_first_non_limit_return(row[0])
                    pred_return = _bond_predicted_return(pred_price)
                    conn.execute(
                        "UPDATE predictions SET pred_return=COALESCE(?, pred_return), actual_return=?, status='fulfilled', updated_at=? WHERE id=?",
                        (pred_return, actual_return, now, pid),
                    )
                    updated += 1
        except Exception:
            pass

    conn.commit()
    conn.close()
    if updated > 0:
        print(f"[预测跟踪] 已回填 {updated} 条实际结果")

def get_prediction_accuracy(days=90):
    """获取最近N天的预测统计"""
    import sqlite3
    from datetime import datetime, timedelta

    conn = _init_ipo_db()
    cutoff = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")

    results = {"stock": {"total": 0, "fulfilled": 0, "errors": [], "mae": 0},
               "bond": {"total": 0, "fulfilled": 0, "errors": [], "mae": 0}}

    for ptype in ("stock", "bond"):
        rows = conn.execute(
            "SELECT pred_return, actual_return FROM predictions WHERE type=? AND status='fulfilled' AND actual_return IS NOT NULL AND pred_date >= ?",
            (ptype, cutoff),
        ).fetchall()
        if rows:
            pred_rows = [r for r in rows if r[0] is not None]
            results[ptype]["fulfilled"] = len(pred_rows)
            results[ptype]["total"] = len(pred_rows)
            if pred_rows:
                errors = [abs(round(p - a, 1)) for p, a in pred_rows]
                results[ptype]["errors"] = errors
                results[ptype]["mae"] = round(sum(errors) / len(errors), 1)

    conn.close()
    return results

def _build_accuracy_lines(days=90):
    """生成准确率统计文本行"""
    stats = get_prediction_accuracy(days)
    lines = []
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("## 📊 预测跟踪统计")
    lines.append("")
    lines.append(f"> 统计近 {days} 天预测 vs 实际上市结果")
    lines.append("")
    has_data = False
    for label, key in [("新股", "stock"), ("新债", "bond")]:
        s = stats[key]
        if s["fulfilled"] > 0:
            has_data = True
            lines.append(f"**{label}**：有效预测样本 {s['fulfilled']} 只，平均绝对偏差 {s['mae']}pp")
        else:
            lines.append(f"**{label}**：暂无已上市数据")
    if not has_data:
        lines.append("> 暂无已上市的预测记录，数据将随交易日积累")
    lines.append("")
    lines.append("> ⚡ 系统会根据实际结果持续校准预测模型，提升准确率")
    return lines

def calibrate_board_base():
    """
    自动校准板块基准首日涨幅
    优先从本地数据库统计，数据不足时从东方财富接口增量拉取。
    """
    global BOARD_BASE, _BOARD_CALIBRATED
    from datetime import datetime, timedelta
    import sqlite3

    cutoff = datetime.now() - timedelta(days=_CALIBRATE_MONTHS * 30)
    cutoff_str = cutoff.strftime("%Y-%m-%d")

    # ── 1. 先查本地数据库 ──
    conn = _init_ipo_db()
    db_rows = conn.execute(
        "SELECT board_key, ld_close_change FROM ipo_history WHERE listing_date >= ? AND ld_close_change IS NOT NULL",
        (cutoff_str,),
    ).fetchall()
    db_gains = {}
    for bk, gain in db_rows:
        if bk not in db_gains:
            db_gains[bk] = []
        db_gains[bk].append(gain)

    db_count = sum(len(v) for v in db_gains.values())
    print(f"[校准] 本地数据库有 {db_count} 条近{_CALIBRATE_MONTHS}个月的新股记录")

    # ── 判断是否需要从接口拉取 ──
    # 检查数据库最近更新时间，超过1天再拉
    last_update = conn.execute("SELECT MAX(updated_at) FROM ipo_history").fetchone()[0]
    need_fetch = True
    if last_update:
        try:
            last_dt = datetime.strptime(last_update, "%Y-%m-%d %H:%M:%S")
            if (datetime.now() - last_dt).total_seconds() < 86400:
                need_fetch = False
                print(f"[校准] 数据库上次更新 {last_update}，24小时内无需拉取")
        except ValueError:
            pass

    # ── 2. 从接口获取最新数据（增量拉取） ──
    if need_fetch:
        url = "https://datacenter-web.eastmoney.com/api/data/v1/get"
        params = {
            "reportName": "RPTA_APP_IPOAPPLY",
            "columns": "SECURITY_CODE,SECURITY_NAME_ABBR,MARKET_TYPE,LISTING_DATE,LD_CLOSE_CHANGE",
            "pageNumber": 1,
            "pageSize": 500,
            "sortTypes": -1,
            "sortColumns": "LISTING_DATE",
            "source": "WEB",
            "client": "WEB",
            "filter": f"(LISTING_DATE>='{cutoff_str}')",
        }
        try:
            resp = _get_session().get(url, params=params, timeout=20)
            d = resp.json()
            if d.get("success") and d["result"] and d["result"]["data"]:
                api_records = d["result"]["data"]
                inserted = _sync_ipo_history(api_records)
                if inserted > 0:
                    print(f"[校准] 从接口增量拉取 {inserted} 条新记录")
                else:
                    print(f"[校准] 数据库已是最新，无需拉取")

                # 重新从数据库统计（包含新数据）
                db_rows = conn.execute(
                    "SELECT board_key, ld_close_change FROM ipo_history WHERE listing_date >= ? AND ld_close_change IS NOT NULL",
                    (cutoff_str,),
                ).fetchall()
                db_gains = {}
                for bk, gain in db_rows:
                    if bk not in db_gains:
                        db_gains[bk] = []
                    db_gains[bk].append(gain)
            else:
                print(f"[校准] 接口获取失败: {d.get('message', '未知')}，使用本地数据")
        except Exception as e:
            print(f"[校准] 接口请求异常: {e}，使用本地数据")
    else:
        # need_fetch=False时也要把try-except-finally走完的conn.close补上
        pass

    conn.close()

    # ── 3. 按板块统计并更新 BOARD_BASE ──
    if not db_gains:
        print("[校准] 无有效数据，保留默认板块基准")
        return

    updated = []
    for board_key in BOARD_BASE:
        gains = db_gains.get(board_key, [])
        if len(gains) >= 3:
            avg_gain = sum(gains) / len(gains)
            avg_gain = int(round(avg_gain))
            old = BOARD_BASE[board_key]
            BOARD_BASE[board_key] = avg_gain
            updated.append(f"{board_key}: {old}→{avg_gain}% ({len(gains)}只)")
        else:
            updated.append(f"{board_key}: 样本不足({len(gains)}只), 保留{BOARD_BASE[board_key]}%")

    total = sum(len(v) for v in db_gains.values())
    print(f"[校准] 板块基准已更新（基于 {total} 只新股）")
    for line in updated:
        print(f"  {line}")
    _BOARD_CALIBRATED = True

def estimate_board_base(stock_code):
    """根据股票代码判断板块，返回基准首日涨幅（%）"""
    code_str = str(stock_code)
    if code_str.startswith("688") or code_str.startswith("787"):
        return BOARD_BASE["科创板"]
    elif code_str.startswith("920") or code_str.startswith("82") or code_str.startswith("83") or code_str.startswith("87"):
        return BOARD_BASE["北交所"]
    elif code_str.startswith(("300", "301")):
        return BOARD_BASE["创业板"]
    elif code_str.startswith(("000", "001", "002", "003")):
        return BOARD_BASE["深市主板"]
    else:
        return BOARD_BASE["沪市主板"]

__all__ = ['_bond_predicted_return', '_bond_first_non_limit_return', '_log_prediction_errors', 'save_predictions', 'backfill_prediction_actuals', 'get_prediction_accuracy', '_build_accuracy_lines', 'calibrate_board_base', 'estimate_board_base']
