"""Backfill: Tushare cb_issue + cb_basic + cb_rating -> 统一可转债标准表。

单位对照（已用浦发/日升等实测确认）：
  issue_size        : 亿元（Tushare 已是亿元，不要 ÷1e8）
  onl_size / offl_size : 张（每张100元）  -> /1e6 = 亿元
  onl_pch_num       : 户（原始计数）      -> /1e4 = 万户
  shd_ration_ratio  : 每股配售（元/股）   -> 配售10张所需股数 = 1000 / 该值
  shd_ration_size   : 股东优先配售总规模（张） -> 股东配售率% = 该值 / (issue_size×1e4)
  ann_date/res_ann_date/shd_ration_record_date/onl_date : YYYYMMDD 字符串

所有 NaN / 'nan' / 'NaN' / 'NaT' / 空 一律清洗为 NULL，避免脏数据显示成 'nan'。
Usage: python backfill_cb_issue.py [--dry]
"""
import sys, os, json, time, math
sys.path.insert(0, os.path.dirname(__file__))
from ipo_daily_report import _get_tushare_pro
from bond_data_layer import save_cb_issue_rows

pro = _get_tushare_pro()
if not pro:
    print("ERROR: Tushare not configured")
    sys.exit(1)

dry = '--dry' in sys.argv


def _num(v):
    """Return float or None（NaN/inf/None/blank -> None）."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        s = str(v).strip().lower()
        if s in ('', 'nan', 'none', 'nat'):
            return None
        return None
    if math.isnan(f) or math.isinf(f):
        return None
    return f


def _date8(v):
    """Return YYYYMMDD 字符串或 None（NaN/NaT/空 -> None）。"""
    if v is None:
        return None
    s = str(v)[:10].replace('-', '')
    if len(s) == 8 and s.isdigit() and s.lower() not in ('nan', 'nat'):
        return s
    return None


def _date10(v):
    """Return YYYY-MM-DD 字符串或 None（NaN/NaT/空 -> None）。"""
    if v is None:
        return None
    s = str(v)[:10].replace('-', '')
    if len(s) == 8 and s.isdigit() and s.lower() not in ('nan', 'nat'):
        return f"{s[:4]}-{s[4:6]}-{s[6:]}"
    return None


# 1. Fetch cb_issue（全字段，单次拉取）
print("[1/3] Fetching cb_issue...")
try:
    df = pro.cb_issue(fields='')
    if df is None or df.empty:
        print("ERROR: cb_issue returned empty")
        sys.exit(1)
    print(f"  cb_issue: {len(df)} rows")
except Exception as e:
    print(f"ERROR: cb_issue failed: {e}")
    sys.exit(1)

# 2. cb_basic（conv_price, stk_code）+ cb_rating 批量
print("[2/3] Fetching cb_basic + cb_rating...")
basic_map = {}
try:
    dfb = pro.cb_basic(fields='ts_code,bond_short_name,stk_code,stk_short_name,conv_price,first_conv_price,list_date')
    if dfb is not None:
        for _, r in dfb.iterrows():
            tc = str(r.get('ts_code', '') or '')
            cp = _num(r.get('conv_price'))
            basic_map[tc] = {
                'ts_code': tc,
                'bond_short_name': str(r.get('bond_short_name', '') or ''),
                'conv_price': cp,
                'stk_code': str(r.get('stk_code', '') or ''),
                'stk_name': str(r.get('stk_short_name', '') or ''),
                'list_date': _date10(r.get('list_date')),
            }
        print(f"  cb_basic: {len(basic_map)} entries")
except Exception as e:
    print(f"  cb_basic warning: {e}")

rating_map = {}
try:
    dfr = pro.cb_rating(fields='ts_code,rating')
    if dfr is not None:
        for _, r in dfr.iterrows():
            tc = str(r.get('ts_code', '') or '')
            rt = r.get('rating')
            if tc and rt and tc not in rating_map:
                rating_map[tc] = str(rt).replace('sti', '').replace('STI', '').strip()
        print(f"  cb_rating: {len(rating_map)} entries")
except Exception as e:
    print(f"  cb_rating warning: {e}")

print("[3/3] Upserting into unified bond data layer...")
issue_rows = [dict(row) for _, row in df.iterrows()]
basic_rows = [dict(row) for row in basic_map.values()]
upserted = save_cb_issue_rows(issue_rows, basic_rows, rating_map, dry=dry)
print(f"\nDone: upserted={upserted} (dry={dry})")
