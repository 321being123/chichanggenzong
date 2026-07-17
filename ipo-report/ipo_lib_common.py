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

OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "history_reports")

CALENDAR_API = "https://datacenter-web.eastmoney.com/api/data/v1/get"

DETAIL_API = "https://ds.emoney.cn/DataCenter2/datacenter/NewStockXgzl"

BOND_DETAIL_URL = "https://data.eastmoney.com/kzz/detail/{code}.html"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Referer": "https://data.eastmoney.com/",
}

_session = None

def _get_session():
    global _session
    if _session is None:
        _session = requests.Session()
        _session.headers.update(HEADERS)
        # 连接池配置：复用连接，避免sandbox限制
        adapter = requests.adapters.HTTPAdapter(
            pool_connections=10,
            pool_maxsize=10,
            max_retries=2,
            pool_block=False,
        )
        _session.mount("https://", adapter)
        _session.mount("http://", adapter)
    return _session

def _get_cninfo_session():
    """创建独立的cninfo session，避免共享Eastmoney cookies"""
    s = requests.Session()
    s.headers.update({
        "User-Agent": HEADERS["User-Agent"],
        "Accept": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": "http://www.cninfo.com.cn/",
    })
    return s

_stock_quote_cache = {}

_bond_price_cache = {}

def _get_qt_prefix(code):
    """
    根据证券代码返回腾讯行情前缀 (sh/sz)
    
    规则：
    - 沪市：6xxxxx（沪市主板）、11xxxx（沪市转债）、118xxx（科创板转债）
    - 深市：0xxxxx/3xxxxx（深市主板/创业板）、12xxxx（深市转债）、123xxx（创业板转债）
    - 科创板股票：688xxx → sh
    - 北交所：4xxxxx/8xxxxx → 暂用sz（腾讯行情可能不支持）
    """
    code_str = str(code)
    # 沪市判断
    if code_str.startswith(("6", "11", "118", "688")):
        return "sh"
    return "sz"

_TUSHARE_PRO = None

def _get_tushare_pro():
    """懒加载 Tushare pro 接口；未配置token或tushare未装返回None"""
    global _TUSHARE_PRO
    if _TUSHARE_PRO is not None:
        return _TUSHARE_PRO
    token = os.environ.get('TUSHARE_TOKEN', '')
    if not token:
        return None
    try:
        import tushare as ts
        ts.set_token(token)
        _TUSHARE_PRO = ts.pro_api()
        return _TUSHARE_PRO
    except Exception as e:
        print(f"[Tushare] 初始化失败: {e}")
        return None

def _ts_float(val):
    """安全转float，None/NaN返回None"""
    if val is None:
        return None
    try:
        f = float(val)
        return f if f == f else None
    except (ValueError, TypeError):
        return None

def _to_ts_code(code):
    """A股/转债代码 → Tushare ts_code（SH/SZ/BJ）"""
    code = str(code).strip()
    if '.' in code:                       # 已是 ts_code（如 300750.SZ），先剥后缀
        code = code.split('.')[0]
    code = code.zfill(6)
    if code[0] == '6' or code.startswith('11'):   # 沪市股票/沪市转债(110/113/118)
        return f"{code}.SH"
    if code.startswith(('8', '92', '43')):        # 北交所
        return f"{code}.BJ"
    return f"{code}.SZ"                           # 深市股票/深市转债(12x)

def _ts_latest_trade_date(pro):
    """获取最近一个交易日(YYYYMMDD)，取最近10天内开市日最大值"""
    try:
        today = datetime.now().strftime('%Y%m%d')
        start = (datetime.now() - timedelta(days=10)).strftime('%Y%m%d')
        df = pro.trade_cal(exchange='SSE', start_date=start, end_date=today,
                           is_open='1', fields='cal_date')
        if df is not None and len(df) > 0:
            return str(df['cal_date'].max())
    except Exception as e:
        print(f"[Tushare] 获取交易日历失败: {e}")
    return None

def _ts_fetch_roe(ts_code):
    """从 fina_indicator 取最新年报ROE(%)，无年报则取最新一期"""
    pro = _get_tushare_pro()
    if not pro:
        return None
    try:
        df = pro.fina_indicator(ts_code=ts_code, fields='ts_code,end_date,roe')
        if df is None or len(df) == 0:
            return None
        annual = df[df['end_date'].astype(str).str.endswith('1231')]
        src = annual if len(annual) > 0 else df
        return _ts_float(src.iloc[0].get('roe'))
    except Exception as e:
        print(f"[Tushare] ROE获取失败({ts_code}): {e}")
        return None

def _fetch_quote_tushare(stock_code):
    """Tushare正股行情：daily_basic(收盘价/PE/PB/总市值) + fina_indicator(ROE)
    返回 {price, pe, pb, roe, market_cap(亿元)}，与腾讯/东财返回结构一致
    """
    pro = _get_tushare_pro()
    if not pro:
        return None
    try:
        ts_code = _to_ts_code(stock_code)
        df = pro.daily_basic(ts_code=ts_code,
                             fields='ts_code,close,pe,pe_ttm,pb,total_mv')
        if df is None or len(df) == 0:
            return None
        row = df.iloc[0]
        price = _ts_float(row.get('close'))
        pe = _ts_float(row.get('pe_ttm')) or _ts_float(row.get('pe'))
        pb = _ts_float(row.get('pb'))
        total_mv = _ts_float(row.get('total_mv'))  # 万元
        market_cap = round(total_mv / 10000.0, 2) if total_mv else None  # →亿元
        roe = _ts_fetch_roe(ts_code)
        if price is None and pe is None and pb is None:
            return None
        return {"price": price, "pe": pe, "pb": pb, "roe": roe, "market_cap": market_cap}
    except Exception as e:
        print(f"[Tushare] 行情获取失败({stock_code}): {e}")
        return None

def _ts_fetch_bond_close(bond_code):
    """Tushare单只转债收盘价"""
    pro = _get_tushare_pro()
    if not pro:
        return None
    try:
        ts_code = _to_ts_code(bond_code)
        df = pro.cb_daily(ts_code=ts_code, fields='ts_code,close')
        if df is None or len(df) == 0:
            return None
        return _ts_float(df.iloc[0].get('close'))
    except Exception as e:
        print(f"[Tushare] 转债行情失败({bond_code}): {e}")
        return None

def _ts_fetch_all_market_prices():
    """Tushare按交易日一次拉全市场：转债收盘价 + 正股收盘价（2个请求）
    返回 (bond_prices{code:price}, stock_prices{code:price})，全失败返回 (None, None)
    """
    pro = _get_tushare_pro()
    if not pro:
        return None, None
    td = _ts_latest_trade_date(pro)
    if not td:
        return None, None
    bond_prices, stock_prices = {}, {}
    try:
        cb_df = pro.cb_daily(trade_date=td, fields='ts_code,close')
        if cb_df is not None and len(cb_df) > 0:
            for _, row in cb_df.iterrows():
                code = str(row['ts_code']).split('.')[0]
                p = _ts_float(row.get('close'))
                if p is not None:
                    bond_prices[code] = p
    except Exception as e:
        print(f"[Tushare] 全市场转债行情失败: {e}")
    try:
        st_df = pro.daily(trade_date=td, fields='ts_code,close')
        if st_df is not None and len(st_df) > 0:
            for _, row in st_df.iterrows():
                code = str(row['ts_code']).split('.')[0]
                p = _ts_float(row.get('close'))
                if p is not None:
                    stock_prices[code] = p
    except Exception as e:
        print(f"[Tushare] 全市场正股行情失败: {e}")
    if not bond_prices and not stock_prices:
        return None, None
    return bond_prices, stock_prices

BOARD_BASE = {
    "科创板": 417,
    "北交所": 229,
    "创业板": 200,
    "深市主板": 150,
    "沪市主板": 150,
}

_CALIBRATE_MONTHS = 12

_BOARD_CALIBRATED = False

_IPO_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ipo_history.db")

def _init_ipo_db():
    """初始化新股历史数据库"""
    import sqlite3
    conn = db_pg.connect()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS ipo_history (
            security_code TEXT PRIMARY KEY,
            security_name TEXT,
            market_type TEXT,
            listing_date TEXT,
            ld_close_change REAL,
            board_key TEXT,
            updated_at TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS bond_history (
            security_code TEXT PRIMARY KEY,
            security_name TEXT,
            listing_date TEXT,
            first_day_return REAL,
            updated_at TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS predictions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            code TEXT NOT NULL,
            name TEXT NOT NULL,
            listing_date TEXT NOT NULL,
            pred_date TEXT NOT NULL,
            pred_return REAL,
            pred_price REAL,
            pred_advice TEXT,
            actual_return REAL,
            actual_price REAL,
            actual_date TEXT,
            status TEXT DEFAULT 'pending',
            updated_at TEXT,
            UNIQUE(type, code, pred_date)
        )
    """)
    conn.commit()
    return conn

def _sync_ipo_history(records):
    """
    将接口返回的新股数据同步到本地数据库
    已存在的记录跳过（不变），新增的记录插入
    已存在但LD_CLOSE_CHANGE为空的记录，若接口提供则更新
    """
    import sqlite3
    conn = _init_ipo_db()
    inserted = 0
    updated = 0
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    for r in records:
        code = r.get("SECURITY_CODE", "")
        if not code:
            continue
        api_close_change = r.get("LD_CLOSE_CHANGE")
        # 检查是否已存在
        cur = conn.execute("SELECT ld_close_change FROM ipo_history WHERE security_code=?", (code,))
        existing = cur.fetchone()
        if existing:
            # 已存在且ld_close_change为空，但接口现在提供 → 更新
            if existing[0] is None and api_close_change is not None:
                conn.execute(
                    "UPDATE ipo_history SET ld_close_change=?, updated_at=? WHERE security_code=?",
                    (api_close_change, now_str, code),
                )
                updated += 1
            continue
        mt = r.get("MARKET_TYPE", "")
        board_key = _market_type_to_board_key(mt, code)
        conn.execute(
            "INSERT OR IGNORE INTO ipo_history (security_code, security_name, market_type, listing_date, ld_close_change, board_key, updated_at) VALUES (?,?,?,?,?,?,?)",
            (
                code,
                r.get("SECURITY_NAME_ABBR", ""),
                mt,
                r.get("LISTING_DATE", ""),
                api_close_change,
                board_key,
                now_str,
            ),
        )
        inserted += 1
    conn.commit()
    conn.close()
    if updated > 0:
        print(f"[校准] 回填 {updated} 条LD_CLOSE_CHANGE")
    return inserted

__all__ = ['OUTPUT_DIR', 'CALENDAR_API', 'DETAIL_API', 'BOND_DETAIL_URL', 'HEADERS', '_session', '_get_session', '_get_cninfo_session', '_stock_quote_cache', '_bond_price_cache', '_get_qt_prefix', '_TUSHARE_PRO', '_get_tushare_pro', '_ts_float', '_to_ts_code', '_ts_latest_trade_date', '_ts_fetch_roe', '_fetch_quote_tushare', '_ts_fetch_bond_close', '_ts_fetch_all_market_prices', 'BOARD_BASE', '_CALIBRATE_MONTHS', '_BOARD_CALIBRATED', '_IPO_DB_PATH', '_init_ipo_db', '_sync_ipo_history']
