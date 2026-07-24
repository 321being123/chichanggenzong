"""Backfill: Tushare cb_issue + cb_basic + cb_rating -> bond_history rich columns.

单位对照（已用浦发/日升等实测确认）：
  issue_size        : 亿元（Tushare 已是亿元，不要 ÷1e8）
  onl_size / offl_size : 张（每张100元）  -> /1e6 = 亿元
  onl_pch_num       : 户（原始计数）      -> /1e4 = 万户
  shd_ration_ratio  : 每股配售（元/股）   -> 配售10张所需股数 = 1000 / 该值
  shd_ration_size   : 股东优先配售总规模（张） -> 股东配售率% = 该值 / (issue_size×1e4)
  ann_date/res_ann_date/shd_ration_record_date/onl_date : YYYYMMDD 字符串

所有 NaN / 'nan' / 'NaN' / 'NaT' / 空 一律清洗为 NULL，避免脏数据显示成 'nan'。
Usage: python backfill_bond_history.py [--dry]
"""
import sys, os, json, time, math
sys.path.insert(0, os.path.dirname(__file__))
import db_pg
from ipo_daily_report import _get_tushare_pro

pro = _get_tushare_pro()
if not pro:
    print("ERROR: Tushare not configured")
    sys.exit(1)

# 凭据统一从 PG* 环境变量读取（.env / 部署脚本注入），不再写死密码
conn = db_pg.connect()
cur = conn.cursor()

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

# 3. Upsert（覆盖写，纠正旧的错误换算；None 清洗为 NULL）
print("[3/3] Upserting into bond_history...")
upserted = 0
for _, r in df.iterrows():
    ts_code = str(r.get('ts_code', '') or '')
    if not ts_code:
        continue
    code6 = ts_code.split('.')[0]
    basic = basic_map.get(ts_code, {})
    name = str(r.get('onl_name', '') or '')
    if not name or name.lower() in ('nan', 'none', 'nat'):
        name = basic.get('bond_short_name') or ''
    rating = rating_map.get(ts_code)
    if not rating:
        for _attempt in range(3):
            try:
                dr = pro.cb_rating(ts_code=ts_code)
                if dr is not None and not dr.empty:
                    if 'rating_date' in dr.columns:
                        dr = dr.sort_values('rating_date', ascending=False)
                    rt = dr.iloc[0].get('rating')
                    if rt:
                        rating = str(rt).replace('sti', '').replace('STI', '').strip()
                break
            except Exception:
                time.sleep(0.3 * (_attempt + 1))

    ann_date = _date8(r.get('ann_date'))
    res_ann_date = _date8(r.get('res_ann_date'))
    shd_rec_date = _date8(r.get('shd_ration_record_date'))
    onl_d = _date8(r.get('onl_date'))

    issue_sz = _num(r.get('issue_size'))                       # Tushare 单位不一致：多数债券为亿元(<10000)，少数近期债券为元(>=10000)
    if issue_sz is not None and issue_sz >= 10000:
        issue_sz = issue_sz / 1e8                              # 元 -> 亿元
    onl_sz = _num(r.get('onl_size'))
    onl_sz = onl_sz / 1e6 if onl_sz is not None else None       # 张 -> 亿元
    offl_sz = _num(r.get('offl_size'))
    offl_sz = offl_sz / 1e6 if offl_sz is not None else None     # 张 -> 亿元
    onl_pch = _num(r.get('onl_pch_num'))
    onl_pch = onl_pch / 1e4 if onl_pch is not None else None     # 户 -> 万户
    shd_ratio = _num(r.get('shd_ration_ratio'))                 # 每股配售（元/股）
    shd_size = _num(r.get('shd_ration_size'))                   # 股东优先配售总规模（张）
    issue_price = _num(r.get('issue_price'))

    sql = """INSERT INTO bond_history (security_code, security_name, listing_date,
        ann_date, res_ann_date, issue_size, issue_type, rating,
        shd_ration_ratio, issue_price, shd_ration_record_date,
        onl_date, onl_size, onl_pch_num, offl_size, shd_ration_size,
        conv_price, stk_code, stk_name)
      VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
      ON CONFLICT (security_code) DO UPDATE SET
        security_name=EXCLUDED.security_name,
        listing_date=EXCLUDED.listing_date,
        ann_date=EXCLUDED.ann_date,
        res_ann_date=EXCLUDED.res_ann_date,
        issue_size=EXCLUDED.issue_size,
        issue_type=EXCLUDED.issue_type,
        rating=EXCLUDED.rating,
        shd_ration_ratio=EXCLUDED.shd_ration_ratio,
        issue_price=EXCLUDED.issue_price,
        shd_ration_record_date=EXCLUDED.shd_ration_record_date,
        onl_date=EXCLUDED.onl_date,
        onl_size=EXCLUDED.onl_size,
        onl_pch_num=EXCLUDED.onl_pch_num,
        offl_size=EXCLUDED.offl_size,
        shd_ration_size=EXCLUDED.shd_ration_size,
        conv_price=EXCLUDED.conv_price,
        stk_code=EXCLUDED.stk_code,
        stk_name=EXCLUDED.stk_name,
        updated_at=NOW()"""

    vals = (
        code6, name, basic.get('list_date'),
        ann_date, res_ann_date, issue_sz, str(r.get('issue_type') or ''), rating,
        shd_ratio, issue_price, shd_rec_date,
        onl_d, onl_sz, onl_pch, offl_sz, shd_size,
        basic.get('conv_price'),
        basic.get('stk_code'), basic.get('stk_name'),
    )

    if not dry:
        cur.execute(sql, vals)
    upserted += 1
    time.sleep(0.02)  # 仅 rating 补缺时会再调用 Tushare，这里主要是轻量休眠

if not dry:
    conn.commit()

print(f"\nDone: upserted={upserted} (dry={dry})")

# 抽查验证
cur.execute("""SELECT security_code, security_name, res_ann_date, issue_size, rating,
                      shd_ration_size, shd_ration_ratio, onl_size, onl_pch_num
               FROM bond_history
               WHERE security_code IN ('110059','123095','125009','113671')
               ORDER BY security_code""")
print("  抽查（股东配售率%% = shd_ration_size/(issue_size*1e4)；配售10张股数 = 1000/shd_ration_ratio）:")
for row in cur.fetchall():
    code, nm, res, sz, rt, ss, sr, onl, pch = row
    shd_pct = (ss / (sz * 1e6) * 100) if (ss and sz) else None
    shares = (round(1000 / sr) if sr else None)
    print(f"  {code} {nm}: 规模={sz}亿 评级={rt} 股东配售率={shd_pct and f'{shd_pct:.2f}%'} "
          f"配售10张需{shares}股 onl_size={onl} onl_pch={pch}万")

cur.close(); conn.close()
