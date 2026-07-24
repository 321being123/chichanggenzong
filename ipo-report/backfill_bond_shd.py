# -*- coding: utf-8 -*-
"""
从巨潮网《发行结果公告》/《网上中签率及优先配售结果公告》解析真实数据，回填
bond_history 中 Tushare 占位/缺失的字段：

  - 股东配售率：公告原文"原股东优先配售…约占本次发行总量的XX.XX%"（单位无关，最权威）
    -> 折算 shd_ration_size(张) = rate/100 × issue_size(亿) × 1e6，前端按原公式显示配售率
  - 网上申购户数：公告原文"本次网上申购有效申购户数为N 户"
    -> onl_pch_num(万户) = N / 1e4

策略（按用户要求"API 读不了的读公告"）：
  - 仅处理已上市(listing_date 非空)且字段缺失(shd_ration_size 占位/空 或 onl_pch_num 空)的债；
  - 可转债公告挂在【正股】名下，故用 stk_code（去 .SH/.SZ 后缀）查巨潮；
  - 只更新缺失字段，绝不覆盖 Tushare 已给的真实值；幂等，可重复跑。

复用 backfill_lottery_rate.py 的 cninfo 抓取链路（get_org_id / _download_pdf_text）。

用法：
  python backfill_bond_shd.py            # 全量回填（已上市+字段缺失者）
  python backfill_bond_shd.py 111025     # 单只调试
  python backfill_bond_shd.py --dry      # 只查不写
"""
import os, sys, re, time, datetime, argparse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from backfill_lottery_rate import get_org_id, _download_pdf_text
import db_pg
import requests

HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
           "Referer": "https://data.eastmoney.com/"}

_ORG_CACHE = {}


def get_conn():
    return db_pg.connect()


def _clean_num(s):
    s = re.sub(r'[\s,]', '', s)
    try:
        return float(s)
    except Exception:
        return None


def _norm_date(s):
    """8位 YYYYMMDD 或 YYYY-MM-DD -> YYYY-MM-DD；其它返回空。"""
    s = str(s or "").strip()
    if re.match(r'^\d{8}$', s):
        return s[:4] + '-' + s[4:6] + '-' + s[6:8]
    if re.match(r'^\d{4}-\d{2}-\d{2}', s):
        return s[:10]
    return ''


def _cand_score(title):
    if "发行结果" in title:
        return 100
    if "中签" in title and "优先配售" in title:
        return 90
    if "优先配售" in title and "结果" in title:
        return 80
    if "中签" in title:
        return 60
    if "配售" in title:
        return 40
    return 0


def find_rate(text):
    """股东配售率(%)：优先取『原股东优先配售…占发行总量XX%』，否则取任意『占发行总量XX%』。"""
    m = re.search(r'原股东优先配售.{0,600}?占[本次]*发行总量[的]*([0-9]+\.[0-9]+)\s*%', text, re.S)
    if m:
        return float(m.group(1))
    m = re.search(r'占[本次]*发行总量[的]*([0-9]+\.[0-9]+)\s*%', text)
    if m:
        return float(m.group(1))
    return None


def find_pch(text):
    """网上有效申购户数(户) -> 万户；深市新债无'户数'，用配号总数(个)÷1000估算户数(每账户约1000配号) -> 万户。"""
    # 优先真实户数（沪市及深市老债公告直接给'户'）
    for pat in [
        r'网上有效申购户数[为:：]?\s*([0-9][0-9,\s]{3,})\s*户',
        r'有效申购户数[为:：]?\s*([0-9][0-9,\s]{3,})\s*户',
        r'网上申购户数[为:：]?\s*([0-9][0-9,\s]{3,})\s*户',
        r'申购户数[为:：]?\s*([0-9][0-9,\s]{3,})\s*户',
    ]:
        m = re.search(pat, text)
        if m:
            v = _clean_num(m.group(1))
            if v and v > 0:
                return v / 1e4   # 户 -> 万户
    # 深市新债只给'配号总数(个)'：估算户数 = 配号总数 / 1万，再转万户
    m = re.search(r'配号总数为\s*([0-9][0-9,\s]{3,})\s*个', text)
    if m:
        v = _clean_num(m.group(1))
        if v and v > 0:
            return v / 1e7   # 配号(个)/1000=户, /1万=万户
    return None


def find_qty(text):
    """原股东优先配售数量(手/张) -> 张（沪市手×10，深市张×1），作为 rate 缺失时的兜底。"""
    m = re.search(r'原股东优先配售[^\n]{0,160}?([0-9][0-9,\s]{2,})\s*(手|张)', text)
    if m:
        v = _clean_num(m.group(1))
        if v:
            return v * (10 if m.group(2) == '手' else 1)
    return None


def fetch_announcements(stk_code, center_date):
    """返回候选公告 [(title, text)]，按优先级排序。公告挂在正股名下。"""
    org = get_org_id(stk_code)
    if not org:
        return []
    s = requests.Session()
    s.headers.update({"User-Agent": HEADERS["User-Agent"], "Accept": "application/json",
                      "X-Requested-With": "XMLHttpRequest", "Referer": "http://www.cninfo.com.cn/"})
    plate = "sz" if stk_code[0] in ('0', '3') else "sh"
    column = "szse" if stk_code[0] in ('0', '3') else "shse"
    try:
        d = datetime.datetime.strptime(_norm_date(center_date), "%Y-%m-%d")
    except Exception:
        d = datetime.datetime.now()
    start = (d - datetime.timedelta(days=90)).strftime("%Y-%m-%d")
    end = (d + datetime.timedelta(days=90)).strftime("%Y-%m-%d")

    cands = []
    for page in range(1, 7):
        data = {"pageNum": page, "pageSize": 30, "stock": "%s,%s" % (stk_code, org),
                "tabName": "fulltext", "column": column, "plate": plate,
                "seDate": "%s~%s" % (start, end)}
        anns = None
        for attempt in range(3):
            try:
                r = s.post("http://www.cninfo.com.cn/new/hisAnnouncement/query", data=data, timeout=20)
                anns = r.json().get("announcements") or []
                break
            except Exception:
                if attempt == 2:
                    anns = []
                time.sleep(2)
        if not anns:
            break
        for a in anns:
            if _cand_score(a.get("announcementTitle", "")) > 0:
                cands.append(a)
        if len(anns) < 30:
            break

    seen = set(); uniq = []
    for a in cands:
        u = a.get("adjunctUrl")
        if u in seen:
            continue
        seen.add(u); uniq.append(a)
    uniq.sort(key=lambda a: -_cand_score(a.get("announcementTitle", "")))

    out = []
    for a in uniq:
        text = _download_pdf_text(s, a)
        out.append((a.get("announcementTitle"), text))
    s.close()
    return out


def parse_bond(stk_code, center_date):
    """返回 (rate_pct, pch_wan, qty_zhang) 或相应为 None。"""
    anns = fetch_announcements(stk_code, center_date)
    rate = pch = qty = None
    for title, text in anns:
        if not text:
            continue
        if rate is None:
            r = find_rate(text)
            if r is not None and 0 < r < 100:
                rate = r
        if pch is None:
            p = find_pch(text)
            if p is not None and p > 0:
                pch = p
        if qty is None:
            q = find_qty(text)
            if q is not None and q > 0:
                qty = q
        if rate is not None and pch is not None and qty is not None:
            break
    return rate, pch, qty


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("code", nargs="?", default=None)
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--limit", type=int, default=0, help="只处理前 N 只（调试用）")
    args = ap.parse_args()

    conn = get_conn()
    cur = conn.cursor()
    if args.code:
        cur.execute("SELECT security_code, security_name, stk_code, issue_size, shd_ration_size, onl_pch_num, onl_date "
                    "FROM bond_history WHERE security_code=%s", (args.code,))
    else:
        # 只抓能真正改善的：配售率缺失(shd占位/空) 或 户数缺失(沪市取真实户数，深市取公告配号总数兜底)
        cur.execute("SELECT security_code, security_name, stk_code, issue_size, shd_ration_size, onl_pch_num, onl_date "
                    "FROM bond_history WHERE listing_date IS NOT NULL "
                    "AND (issue_type IS NULL OR issue_type NOT IN ('定向','私募')) "
                    "AND (shd_ration_size IS NULL OR shd_ration_size <= 100 OR onl_pch_num IS NULL) "
                    "ORDER BY onl_date DESC")
    rows = cur.fetchall()
    if args.limit:
        rows = rows[:args.limit]
    print("待回填(已上市+字段缺失):", len(rows))

    ok = skip = fail = 0
    for code, name, stk, issue_sz, old_shd, old_pch, onl_d in rows:
        stk_code = (stk or "").split(".")[0]
        if not stk_code:
            print("  [SKIP] %s %s 无正股代码" % (code, name))
            skip += 1
            continue
        center = onl_d or ""
        rate, pch, qty = parse_bond(stk_code, center)

        new_shd = old_shd
        if (old_shd is None or old_shd <= 100):
            if rate is not None and issue_sz:
                new_shd = round(rate / 100.0 * float(issue_sz) * 1e6)
            elif qty is not None:
                new_shd = qty
        new_pch = old_pch
        if old_pch is None and pch is not None:
            new_pch = pch

        need = (new_shd != old_shd) or (new_pch != old_pch)
        if not need:
            print("  [SKIP] %s %s 公告未取到新值(rate=%s pch=%s)" % (code, name, rate, pch))
            skip += 1
            time.sleep(0.3)
            continue

        upd_shd = (new_shd != old_shd)
        upd_pch = (new_pch != old_pch)
        print("  [UPDATE] %s %s 配售率=%s%% 户数=%s万 (shd:%s->%s pch:%s->%s)" % (
            code, name, rate, pch, old_shd, new_shd if upd_shd else '-', old_pch, new_pch if upd_pch else '-'))
        if not args.dry:
            cur.execute("UPDATE bond_history SET shd_ration_size=%s, onl_pch_num=%s, updated_at=NOW() "
                        "WHERE security_code=%s", (new_shd, new_pch, code))
            conn.commit()
        ok += 1
        time.sleep(0.5)

    print("完成: update=%d skip=%d fail=%d" % (ok, skip, fail))
    cur.close(); conn.close()


if __name__ == "__main__":
    main()
