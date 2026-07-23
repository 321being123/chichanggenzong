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

HOT_SECTOR_KEYWORDS = {
    "半导体": 0.25, "芯片": 0.25, "集成电路": 0.25,
    "AI": 0.25, "人工智能": 0.25, "算力": 0.20,
    "机器人": 0.25, "人形机器人": 0.25, "具身智能": 0.25,
    "新能源": 0.15, "光伏": 0.15, "储能": 0.15, "锂电池": 0.15,
    "低空经济": 0.25, "飞行汽车": 0.25, "无人机": 0.20,
    "新材料": 0.10, "先进材料": 0.15,
    "创新药": 0.15, "生物医药": 0.10, "医疗器械": 0.10,
    "高端装备": 0.10, "航天": 0.15, "军工": 0.10,
    "数据要素": 0.15, "数字经济": 0.10,
    "自动驾驶": 0.15, "智能驾驶": 0.15,
}

NEW_STOCK_HOT_SECTORS = {
    "光通信": 3.0, "光纤": 3.0, "光子": 2.5,
    "半导体": 2.0, "芯片": 2.0, "集成电路": 2.0, "先进封装": 2.0,
    "AI": 2.5, "人工智能": 2.5, "算力": 2.0, "GPU": 2.5,
    "机器人": 1.5, "人形机器人": 2.0, "具身智能": 2.0,
    "低空经济": 1.5, "飞行汽车": 1.5, "航天": 1.0, "航空": 0.8,
    "储能": 1.0, "新能源": 0.8, "光伏": 0.8, "锂电池": 0.8,
    "创新药": 0.8, "医疗器械": 0.5, "生物医药": 0.5,
    "新材料": 0.5, "高端装备": 0.5, "精密制造": 0.3,
    "军工": 0.8, "自动驾驶": 1.0, "智能驾驶": 1.0,
    "电力设备": 0.3, "轨道交通": 0.3, "核电": 0.5,
    "数字经济": 0.5, "数据要素": 0.5, "云计算": 0.5,
    "氢能": 0.8, "钠离子": 0.8, "固态电池": 1.0,
    "消费电子": 0.3, "汽车电子": 0.5,
}

_SECTOR_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sector_heat.db")

def _init_sector_db():
    """初始化赛道热度数据库"""
    import sqlite3
    conn = db_pg.connect()
    # 已上市股票-赛道映射表（存储哪些股票属于哪个赛道）
    conn.execute("""
        CREATE TABLE IF NOT EXISTS stock_sector (
            stock_code TEXT,
            sector_key TEXT,
            stock_name TEXT,
            PRIMARY KEY (stock_code, sector_key)
        )
    """)
    # 赛道热度快照表（每日存储一次赛道统计结果）
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sector_heat (
            sector_key TEXT PRIMARY KEY,
            avg_gain_60d REAL,
            stock_count INTEGER,
            boost REAL,
            updated_at TEXT
        )
    """)
    # 股票涨跌幅缓存表（存储最近一次获取的60日涨跌幅）
    conn.execute("""
        CREATE TABLE IF NOT EXISTS stock_gain (
            stock_code TEXT PRIMARY KEY,
            gain_60d REAL,
            updated_at TEXT
        )
    """)
    conn.commit()
    return conn

def _match_sector_by_keywords(search_text):
    """
    对一段文本匹配所有赛道关键词
    返回 [(sector_key, boost), ...]
    """
    matches = []
    for keyword in NEW_STOCK_HOT_SECTORS:
        if keyword in search_text:
            matches.append(keyword)
    return matches

def _build_sector_stock_map(conn):
    """
    构建赛道->股票列表映射
    从所有A股中筛选匹配赛道关键词的股票
    用腾讯行情API批量获取，按行业代码批量处理
    """
    # 先读已有映射
    existing = conn.execute(
        "SELECT stock_code, sector_key FROM stock_sector"
    ).fetchall()
    stock_sectors = {}
    for code, sk in existing:
        if sk not in stock_sectors:
            stock_sectors[sk] = []
        stock_sectors[sk].append(code)

    return stock_sectors

def _fetch_sector_stock_names(conn):
    """
    获取所有已上市A股，通过股票名称匹配赛道关键词
    同时从东财获取股票的行业信息，用行业名辅助匹配
    新增的插入stock_sector表
    """
    stocks = []
    pro = _get_tushare_pro()
    if pro:
        try:
            df = pro.stock_basic(
                exchange="", list_status="L",
                fields="ts_code,symbol,name,industry",
            )
            if df is not None and not df.empty:
                for _, row in df.iterrows():
                    raw_code = row.get("symbol") or str(row.get("ts_code") or "").split(".")[0]
                    code = str(raw_code or "").zfill(6)
                    if code and code != "000000":
                        stocks.append((code, str(row.get("name") or ""), str(row.get("industry") or "")))
        except Exception as e:
            print(f"[赛道热度] Tushare stock_basic 获取失败: {e}")
    if not stocks:
        stocks = [(code, name, "") for code, name in _fetch_all_a_stock_list()]

    new_mappings = 0
    for code, name, industry in stocks:
        for sector_key in _match_sector_by_keywords(f"{name} {industry}"):
            cur = conn.execute(
                "SELECT 1 FROM stock_sector WHERE stock_code=? AND sector_key=?",
                (code, sector_key),
            )
            if not cur.fetchone():
                conn.execute(
                    "INSERT INTO stock_sector (stock_code, sector_key, stock_name) VALUES (?,?,?)",
                    (code, sector_key, name),
                )
                new_mappings += 1

    conn.commit()
    print(f"[赛道热度] 已持久化 {new_mappings} 条新增成分股映射")
    return new_mappings

def _fetch_stock_60d_gain(stock_code):
    """
    获取某只股票60日涨跌幅
    优先从 Tushare 获取近60个交易日收盘价，东财K线作为备用。
    """
    try:
        pro = _get_tushare_pro()
        if pro:
            end_date = datetime.now().strftime("%Y%m%d")
            start_date = (datetime.now() - timedelta(days=150)).strftime("%Y%m%d")
            df = pro.daily(
                ts_code=_to_ts_code(stock_code),
                start_date=start_date,
                end_date=end_date,
                fields="trade_date,close",
            )
            if df is not None and len(df) >= 2:
                df = df.sort_values("trade_date")
                closes = [float(v) for v in df["close"].tolist() if v is not None]
                closes = closes[-61:]
                if len(closes) >= 2 and closes[0] > 0:
                    return round((closes[-1] / closes[0] - 1) * 100, 2)
    except Exception:
        pass

    try:
        code_int = int(stock_code)
        if code_int >= 600000:
            secid = f"1.{stock_code}"
        elif code_int >= 400000:
            secid = f"0.{stock_code}"
        else:
            secid = f"0.{stock_code}"

        url = "https://push2his.eastmoney.com/api/qt/stock/kline/get"
        params = {
            "secid": secid,
            "fields1": "f1,f2,f3,f4,f5,f6",
            "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
            "klt": "101",
            "fqt": 1,
            "end": "20500101",
            "lmt": 65,
        }
        resp = _get_session().get(url, params=params, timeout=10)
        data = resp.json()
        if data.get("data") and data["data"].get("klines"):
            klines = data["data"]["klines"]
            if len(klines) >= 2:
                last_close = float(klines[-1].split(",")[2])
                # 找60个交易日前的收盘价（取最早可用的）
                target_idx = min(60, len(klines) - 1)
                first_close = float(klines[-target_idx].split(",")[2])
                if first_close > 0:
                    return round((last_close - first_close) / first_close * 100, 2)
        return None
    except Exception:
        return None

def _refresh_sector_heat(conn):
    """
    刷新赛道热度数据：
    1. 对每个赛道下的股票获取60日涨跌幅
    2. 算平均值，归一化到0~3.0系数
    3. 写入sector_heat表
    """
    from datetime import datetime

    # 获取所有赛道-股票映射
    rows = conn.execute(
        "SELECT sector_key, stock_code FROM stock_sector"
    ).fetchall()

    sector_stocks = {}
    for sk, code in rows:
        if sk not in sector_stocks:
            sector_stocks[sk] = []
        sector_stocks[sk].append(code)

    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # 获取所有赛道的60日涨幅均值
    sector_avg_gains = {}
    for sector_key, codes in sector_stocks.items():
        gains = []
        for code in codes:
            # 先查缓存
            cur = conn.execute(
                "SELECT gain_60d FROM stock_gain WHERE stock_code=?",
                (code,),
            )
            row = cur.fetchone()
            if row and row[0] is not None:
                gains.append(row[0])
            else:
                gain = _fetch_stock_60d_gain(code)
                if gain is not None:
                    gains.append(gain)
                    conn.execute(
                        "INSERT OR REPLACE INTO stock_gain (stock_code, gain_60d, updated_at) VALUES (?,?,?)",
                        (code, gain, now_str),
                    )
                # 避免请求太快
                time.sleep(0.05)

        if gains:
            avg_gain = sum(gains) / len(gains)
            sector_avg_gains[sector_key] = (avg_gain, len(gains))

    conn.commit()

    # 归一化到0~3.0系数
    # 取所有赛道中最大avg_gain作为基准
    if not sector_avg_gains:
        return

    max_avg = max(v[0] for v in sector_avg_gains.values())

    for sector_key, (avg_gain, count) in sector_avg_gains.items():
        # 归一化: boost = (avg_gain / max_avg) * 3.0
        boost = round((avg_gain / max_avg) * 3.0, 2) if max_avg > 0 else 0
        conn.execute(
            "INSERT OR REPLACE INTO sector_heat (sector_key, avg_gain_60d, stock_count, boost, updated_at) VALUES (?,?,?,?,?)",
            (sector_key, round(avg_gain, 2), count, boost, now_str),
        )
    conn.commit()

def calibrate_sector_boost():
    """
    自动校准赛道热度系数
    每次运行从 Tushare 增量补充股票赛道映射，并持久化到 stock_sector。
    每24小时从东财K线刷新60日涨跌幅，写入 stock_gain 和 sector_heat。
    """
    from datetime import datetime

    conn = _init_sector_db()

    # 检查数据库是否有数据
    sector_count = conn.execute("SELECT COUNT(*) FROM sector_heat").fetchone()[0]
    stock_sector_count = conn.execute("SELECT COUNT(*) FROM stock_sector").fetchone()[0]

    if stock_sector_count == 0:
        print("[赛道热度] 成分股映射为空，开始从 Tushare 重建")
    _fetch_sector_stock_names(conn)
    stock_sector_count = conn.execute("SELECT COUNT(*) FROM stock_sector").fetchone()[0]
    if stock_sector_count == 0:
        print("[赛道热度] 未匹配到赛道成分股，保留上一份系数")
        conn.close()
        return

    if sector_count == 0:
        print("[赛道热度] 系数为空，开始计算60日涨跌幅")
        _refresh_sector_heat(conn)
        sector_count = conn.execute("SELECT COUNT(*) FROM sector_heat").fetchone()[0]

    # 检查是否需要刷新涨幅数据（>24h 且 距上次刷新>1天）
    cur = conn.execute("SELECT MAX(updated_at) FROM sector_heat")
    last_update = cur.fetchone()[0]
    need_refresh = True
    if last_update:
        try:
            last_dt = datetime.strptime(last_update, "%Y-%m-%d %H:%M:%S")
            if (datetime.now() - last_dt).total_seconds() < 86400:
                need_refresh = False
                print(f"[赛道热度] 数据上次更新 {last_update}，24小时内无需刷新")
        except ValueError:
            pass

    if need_refresh and sector_count > 0:
        print("[赛道热度] 正在刷新股票60日涨跌幅（增量）...")
        # 只对 stock_sector 表中已有的股票刷新涨跌幅
        stock_codes = conn.execute(
            "SELECT DISTINCT stock_code FROM stock_sector"
        ).fetchall()
        stock_codes = [r[0] for r in stock_codes]

        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        updated_count = 0
        sector_gains = {}  # sector_key -> [gain, ...]

        for i, code in enumerate(stock_codes):
            # 从东财K线获取60日涨幅
            gain = _fetch_stock_60d_gain(code)
            if gain is not None:
                conn.execute(
                    "INSERT OR REPLACE INTO stock_gain (stock_code, gain_60d, updated_at) VALUES (?,?,?)",
                    (code, gain, now_str),
                )
                updated_count += 1
                # 同时收集用于计算
                sector_keys = conn.execute(
                    "SELECT sector_key FROM stock_sector WHERE stock_code=?",
                    (code,),
                ).fetchall()
                for (sk,) in sector_keys:
                    if sk not in sector_gains:
                        sector_gains[sk] = []
                    sector_gains[sk].append(gain)
            time.sleep(0.03)  # 间隔

        print(f"[赛道热度] 已刷新 {updated_count}/{len(stock_codes)} 只股票的60日涨跌幅")

        # 计算新的赛道热度系数
        if sector_gains:
            max_avg = 1
            for gains in sector_gains.values():
                if gains:
                    avg = sum(gains) / len(gains)
                    if avg > max_avg:
                        max_avg = avg

            for sector_key, gains in sector_gains.items():
                if not gains:
                    continue
                avg_gain = sum(gains) / len(gains)
                boost = round((avg_gain / max_avg) * 3.0, 2) if max_avg > 0 else 0
                conn.execute(
                    "INSERT OR REPLACE INTO sector_heat (sector_key, avg_gain_60d, stock_count, boost, updated_at) VALUES (?,?,?,?,?)",
                    (sector_key, round(avg_gain, 2), len(gains), boost, now_str),
                )
            conn.commit()
            print("[赛道热度] 赛道系数已刷新")

    # 从数据库读取热度系数
    rows = conn.execute(
        "SELECT sector_key, boost, avg_gain_60d, stock_count FROM sector_heat ORDER BY boost DESC"
    ).fetchall()
    conn.close()

    # 更新全局 NEW_STOCK_HOT_SECTORS
    updated = []
    for sector_key, boost, avg_gain, count in rows:
        old = NEW_STOCK_HOT_SECTORS.get(sector_key, "?")
        NEW_STOCK_HOT_SECTORS[sector_key] = boost
        updated.append(f"{sector_key}: {old}→{boost}（{count}只, 60日均值{avg_gain}%）")

    if updated:
        print(f"[赛道热度] 赛道系数已更新（共{len(rows)}个赛道）")
        for line in updated[:10]:
            print(f"  {line}")
        if len(updated) > 10:
            print(f"  ... 还有{len(updated)-10}个赛道")

_MARKET_TEMP = {"level": "热市", "break_rate": 0, "avg_gain_3m": 0}

_TEMP_CALIBRATED = False

def detect_market_temperature():
    """
    检测当前新股市场温度
    从 ipo_history.db 统计近6个月数据
    返回 {'level': '热市'|'常温'|'冷市', 'break_rate': float, 'avg_gain_6m': float}
    """
    global _MARKET_TEMP, _TEMP_CALIBRATED
    from datetime import datetime, timedelta

    cutoff = (datetime.now() - timedelta(days=180)).strftime("%Y-%m-%d")
    try:
        conn = _init_ipo_db()
        rows = conn.execute(
            "SELECT ld_close_change FROM ipo_history WHERE listing_date >= ? AND ld_close_change IS NOT NULL AND market_type != '北交所'",
            (cutoff,),
        ).fetchall()
        conn.close()
    except Exception:
        rows = []

    if not rows:
        print("[市场温度] 数据不足，默认热市")
        _MARKET_TEMP.clear()
        _MARKET_TEMP.update({"level": "热市", "break_rate": 0, "avg_gain_3m": 250})
        _TEMP_CALIBRATED = True
        return _MARKET_TEMP

    gains = [r[0] for r in rows]
    total = len(gains)
    break_count = sum(1 for g in gains if g < 0)
    break_rate = break_count / total if total > 0 else 0
    avg_gain = sum(gains) / total if total > 0 else 0

    if break_rate == 0 and avg_gain > 150:
        level = "热市"
    elif break_rate < 0.05 and avg_gain > 30:
        level = "常温"
    else:
        level = "冷市"

    _MARKET_TEMP.clear()
    _MARKET_TEMP.update({"level": level, "break_rate": round(break_rate * 100, 1), "avg_gain_3m": round(avg_gain, 1)})
    _TEMP_CALIBRATED = True

    print(f"[市场温度] {level}（破发率{_MARKET_TEMP['break_rate']}%，6月均涨幅{_MARKET_TEMP['avg_gain_3m']}%）")
    return _MARKET_TEMP

_BOND_MARKET_TEMP = {"level": "热市", "break_rate": 0, "avg_gain_6m": 0}

def detect_bond_market_temperature():
    """
    检测当前新债（可转债）市场温度
    从 bond_history 表或东财接口统计近6个月数据
    返回 {'level': '热市'|'常温'|'冷市', 'break_rate': float, 'avg_gain_6m': float}
    """
    global _BOND_MARKET_TEMP
    from datetime import datetime, timedelta

    cutoff = (datetime.now() - timedelta(days=180)).strftime("%Y-%m-%d")

    # 先从数据库查，检查数据是否够新（24h内）
    try:
        conn = _init_ipo_db()
        last_update = conn.execute("SELECT MAX(updated_at) FROM bond_history").fetchone()[0]
        need_fetch = True
        if last_update:
            try:
                last_dt = datetime.strptime(last_update, "%Y-%m-%d %H:%M:%S")
                if (datetime.now() - last_dt).total_seconds() < 86400:
                    need_fetch = False
            except ValueError:
                pass

        if need_fetch:
            conn.close()
            rows = _fetch_bond_listing_data_from_api(cutoff)
            # 保存后重新读取
            conn = _init_ipo_db()
            db_rows = conn.execute(
                "SELECT first_day_return FROM bond_history WHERE listing_date >= ? AND first_day_return IS NOT NULL",
                (cutoff,),
            ).fetchall()
            conn.close()
            rows = [r[0] for r in db_rows]
        else:
            db_rows = conn.execute(
                "SELECT first_day_return FROM bond_history WHERE listing_date >= ? AND first_day_return IS NOT NULL",
                (cutoff,),
            ).fetchall()
            conn.close()
            rows = [r[0] for r in db_rows]
    except Exception:
        rows = []

    if not rows:
        print("[新债市场温度] 数据不足，默认热市")
        _BOND_MARKET_TEMP.clear()
        _BOND_MARKET_TEMP.update({"level": "热市", "break_rate": 0, "avg_gain_6m": 30})
        return _BOND_MARKET_TEMP

    gains = rows
    total = len(gains)
    break_count = sum(1 for g in gains if g < 0)
    break_rate = break_count / total if total > 0 else 0
    avg_gain = sum(gains) / total if total > 0 else 0

    if break_rate == 0 and avg_gain > 40:
        level = "热市"
    elif break_rate < 0.05 and avg_gain > 10:
        level = "常温"
    else:
        level = "冷市"

    _BOND_MARKET_TEMP.clear()
    _BOND_MARKET_TEMP.update({"level": level, "break_rate": round(break_rate * 100, 1), "avg_gain_6m": round(avg_gain, 1)})
    print(f"[新债市场温度] {level}（破发率{_BOND_MARKET_TEMP['break_rate']}%，6月均涨幅{_BOND_MARKET_TEMP['avg_gain_6m']}%）")
    return _BOND_MARKET_TEMP

_MARKET_SNAPSHOT = {
    "avg_premium": 0.40,       # 全市场平均溢价率（迭代收敛法的初始值）
    "index_level": "偏高",     # 综合判断
    "index_1m": -0.28,         # 中证转债近1月涨跌幅(%)
}

def fetch_market_heat():
    """获取当前市场热度指标（基于全量转债实时行情）"""
    global _BONDS_MARKET_CACHE

    try:
        bonds_data = _fetch_all_bonds_market()
        if bonds_data:
            all_prems = [d[3] for d in bonds_data]
            avg_p = sum(all_prems) / len(all_prems)
            _MARKET_SNAPSHOT["avg_premium"] = avg_p / 100

            # 基于全市场平均溢价率判断热度
            if avg_p < 25:
                _MARKET_SNAPSHOT["index_level"] = "低估"
            elif avg_p < 35:
                _MARKET_SNAPSHOT["index_level"] = "中性偏低"
            elif avg_p < 50:
                _MARKET_SNAPSHOT["index_level"] = "中性"
            elif avg_p < 70:
                _MARKET_SNAPSHOT["index_level"] = "偏高"
            else:
                _MARKET_SNAPSHOT["index_level"] = "高估"

        # 中证转债指数近1月涨跌
        index_change = _fetch_cb_index_change()
        if index_change is not None:
            _MARKET_SNAPSHOT["index_1m"] = index_change
    except Exception:
        pass

    return _MARKET_SNAPSHOT

def detect_hot_sector(bond_name, stock_name, stock_industry=""):
    """
    检测正股是否属于当前市场炒作热门赛道
    返回 (sector_label, premium_boost)
    """
    search_text = f"{bond_name} {stock_name} {stock_industry}"
    for keyword, boost in HOT_SECTOR_KEYWORDS.items():
        if keyword in search_text:
            return keyword, boost
    return None, 0

def detect_stock_hot_sector(stock_name, main_business, industry):
    """检测新股热门赛道（基于2025-2026年实际涨幅数据）"""
    search_text = f"{stock_name} {main_business} {industry}"
    best_label, best_boost = None, 0
    for keyword, boost in NEW_STOCK_HOT_SECTORS.items():
        if keyword in search_text:
            if boost > best_boost:
                best_boost = boost
                best_label = keyword
    return best_label, best_boost

def _get_board_key_from_code(code):
    """从股票代码获取板块键"""
    code_str = str(code)
    if code_str.startswith("688"):
        return "科创板"
    if code_str.startswith(("300", "301")):
        return "创业板"
    if code_str.startswith(("000", "001", "002", "003")):
        return "深市主板"
    if code_str.startswith(("60",)):
        return "沪市主板"
    return "科创板"

def _sync_sector_boost_from_db():
    """模块加载时把DB中的动态赛道热度系数同步进全局静态字典，
    避免源码硬编码默认值与运行时实际值不一致（防止误读旧值）"""
    try:
        conn = _init_sector_db()
        rows = conn.execute("SELECT sector_key, boost FROM sector_heat").fetchall()
        for sector_key, boost in rows:
            NEW_STOCK_HOT_SECTORS[sector_key] = boost
        conn.close()
    except Exception:
        pass  # DB缺失或无数据时保留源码默认系数

__all__ = ['HOT_SECTOR_KEYWORDS', 'NEW_STOCK_HOT_SECTORS', '_SECTOR_DB_PATH', '_init_sector_db', '_match_sector_by_keywords', '_build_sector_stock_map', '_fetch_sector_stock_names', '_fetch_stock_60d_gain', '_refresh_sector_heat', 'calibrate_sector_boost', '_MARKET_TEMP', '_TEMP_CALIBRATED', 'detect_market_temperature', '_BOND_MARKET_TEMP', 'detect_bond_market_temperature', '_MARKET_SNAPSHOT', 'fetch_market_heat', 'detect_hot_sector', 'detect_stock_hot_sector', '_get_board_key_from_code', '_sync_sector_boost_from_db']
