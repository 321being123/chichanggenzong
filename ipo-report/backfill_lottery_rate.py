# -*- coding: utf-8 -*-
"""
回填 ipo_history.online_lottery_rate 为交易所《发行结果公告》里的精确中签率。

数据来源（权威，含10位小数）：
  - 深交所/上交所股票：巨潮资讯网 发行结果公告 PDF（网上发行中签率）
  - 北交所股票：北交所官网 发行结果公告 PDF

复用 ipo_daily_report.py 中已验证可用的巨潮抓取链路（http + column=szse/shse + orgId）。

用法：
  python backfill_lottery_rate.py            # 全量回填（已精确的直接跳过）
  python backfill_lottery_rate.py 301583     # 仅单只调试
  python backfill_lottery_rate.py --dry      # 只查不写
"""
import os, sys, re, time, json, argparse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import psycopg2

try:
    import fitz
except Exception as e:
    print("PyMuPDF 未安装:", e); sys.exit(1)

import requests

DB = dict(host="127.0.0.1", port=5432, user="postgres", password=***REDACTED***, dbname="portfolio")
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
           "Referer": "https://data.eastmoney.com/"}
_org_id_cache = {}


def get_conn():
    return psycopg2.connect(**DB)


def get_org_id(code):
    if code in _org_id_cache:
        return _org_id_cache[code]
    for attempt in range(3):
        try:
            s = requests.Session()
            s.headers.update({"User-Agent": HEADERS["User-Agent"], "Accept": "application/json",
                               "X-Requested-With": "XMLHttpRequest", "Referer": "http://www.cninfo.com.cn/"})
            r = s.post("http://www.cninfo.com.cn/new/information/topSearch/query",
                       data={"keyWord": code, "maxNum": 10}, timeout=20)
            s.close()
            for it in r.json():
                if it.get("code") == code:
                    _org_id_cache[code] = it["orgId"]
                    return it["orgId"]
            break
        except Exception as e:
            if attempt < 2:
                time.sleep(3)
            else:
                print("  orgId失败", code, e)
    _org_id_cache[code] = None
    return None


def find_lottery(text):
    for pat in [
        r'网上发行中签率[为:：]?\s*([0-9]+\.[0-9]+)\s*%',
        r'网上最终发行中签率[为:：]?\s*([0-9]+\.[0-9]+)\s*%',
        r'发行中签率[为:：]?\s*([0-9]+\.[0-9]+)\s*%',
        r'中签率[为:：]?\s*([0-9]+\.[0-9]+)\s*%',
    ]:
        m = re.search(pat, text)
        if m:
            return float(m.group(1))
    return None


def _candidate_score(title):
    """给公告标题打分，越高越优先作为中签率来源。"""
    if "发行结果" in title and "股票" in title:
        return 100
    if "中签" in title and "结果" in title:
        return 90
    if "发行结果公告" in title:
        return 85
    if "摇号" in title and "中签" in title:
        return 80
    if "中签" in title:
        return 70
    if "发行结果" in title:
        return 60
    if "配售" in title and "结果" in title:
        return 50
    return 0


def _download_pdf_text(s, ann):
    """下载单个公告PDF并返回文本，失败返回 None。"""
    adj = ann.get("adjunctUrl") or ""
    if not adj:
        return None
    url = adj if adj.startswith("http") else "http://static.cninfo.com.cn/" + adj.lstrip("/")
    try:
        g = s.get(url, timeout=30)
    except Exception:
        return None
    if g.status_code != 200:
        return None
    try:
        doc = fitz.open(stream=g.content, filetype="pdf")
        text = "\n".join(p.get_text() for p in doc)
        doc.close()
        return text
    except Exception:
        return None


def fetch_cninfo_pdf_text(code, ipo_date=None):
    """复用已验证的巨潮链路，在窗口内收集所有候选公告，逐个尝试解析精确中签率。

    以 ipo_date 为中心开 ±75 天窗口（缺省则回退到近5年），使发行结果公告落在第1页，
    避免被后期年报/董事会公告淹没。部分股票的"发行结果公告"PDF 文本不含可提取的中签率
    （中签率在以图片/表格呈现的"网上摇号中签结果公告"等其他公告里），故收集全部候选、
    按优先级逐个尝试，命中即返回。
    """
    org = get_org_id(code)
    if not org:
        return None
    s = requests.Session()
    s.headers.update({"User-Agent": HEADERS["User-Agent"], "Accept": "application/json",
                      "X-Requested-With": "XMLHttpRequest", "Referer": "http://www.cninfo.com.cn/"})
    plate = "sz" if code[0] in ('0', '3') else "sh"
    column = "szse" if code[0] in ('0', '3') else "shse"
    dt = __import__("datetime")
    if ipo_date:
        try:
            d = dt.datetime.strptime(str(ipo_date)[:10], "%Y-%m-%d")
            start = (d - dt.timedelta(days=75)).strftime("%Y-%m-%d")
            end = (d + dt.timedelta(days=75)).strftime("%Y-%m-%d")
        except Exception:
            d = dt.datetime.now()
            start = (d - dt.timedelta(days=365*5)).strftime("%Y-%m-%d")
            end = d.strftime("%Y-%m-%d")
    else:
        d = dt.datetime.now()
        start = (d - dt.timedelta(days=365*5)).strftime("%Y-%m-%d")
        end = d.strftime("%Y-%m-%d")

    # 收集窗口内所有候选公告（标题打分 > 0）
    candidates = []
    for page in range(1, 7):
        data = {"pageNum": page, "pageSize": 30, "stock": "%s,%s" % (code, org),
                "tabName": "fulltext", "column": column, "plate": plate,
                "seDate": "%s~%s" % (start, end)}
        anns = None
        for attempt in range(3):
            try:
                r = s.post("http://www.cninfo.com.cn/new/hisAnnouncement/query", data=data, timeout=20)
                j = r.json()
                anns = j.get("announcements") or []
                break
            except Exception:
                if attempt == 2:
                    break
                time.sleep(2)
        if not anns:
            break
        for a in anns:
            if _candidate_score(a.get("announcementTitle", "")) > 0:
                candidates.append(a)
        if len(anns) < 30:
            break

    if not candidates:
        s.close(); return None

    # 去重（同一 adjunctUrl 只试一次），按优先级排序
    seen = set(); uniq = []
    for a in candidates:
        u = a.get("adjunctUrl")
        if u in seen:
            continue
        seen.add(u); uniq.append(a)
    uniq.sort(key=lambda a: -_candidate_score(a.get("announcementTitle", "")))

    for a in uniq:
        text = _download_pdf_text(s, a)
        if text and find_lottery(text):
            s.close(); return text
    s.close()
    return None


def precise_rate(code, market, ipo_date=None):
    """仅深交所/上交所走巨潮PDF；北交所按约定保持原2位值，不参与精填。"""
    if market == "北交所":
        return None
    text = fetch_cninfo_pdf_text(code, ipo_date)
    if not text:
        return None
    return find_lottery(text)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("code", nargs="?", default=None)
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--emit-sql", default=None,
                    help="把最终 online_lottery_rate 写成 UPDATE SQL 差值文件（用于同步到服务器库）")
    args = ap.parse_args()

    conn = get_conn()
    cur = conn.cursor()
    if args.code:
        cur.execute("SELECT security_code, security_name, market_type, online_lottery_rate, ipo_date FROM ipo_history WHERE security_code=%s", (args.code,))
    else:
        # 北交所(79只)按约定保持原2位小数，不参与精填
        cur.execute("SELECT security_code, security_name, market_type, online_lottery_rate, ipo_date FROM ipo_history WHERE market_type<>'北交所' ORDER BY security_code")
    rows = cur.fetchall()
    print("待处理(非北交所):", len(rows))

    ok = skip = fail = 0
    diff_rows = []  # (code, final_rate) 用于生成同步服务器的 SQL 差值
    for code, name, market, old, ipo_date in rows:
        rate = precise_rate(code, market, ipo_date)
        if rate is None:
            print("  [FAIL] %s %s (%s) 未取到" % (code, name, market))
            fail += 1
            diff_rows.append((code, old))
            time.sleep(0.5)
            continue
        # 判断是否需要更新：与旧值差异超过1e-6（考虑浮点）
        need = (old is None) or (abs(float(old) - rate) > 1e-6)
        if not need:
            skip += 1
            diff_rows.append((code, old))
            continue
        print("  [UPDATE] %s %s (%s) %.8f -> %.10f" % (code, name, market, old, rate))
        if not args.dry:
            cur.execute("UPDATE ipo_history SET online_lottery_rate=%s, updated_at=%s WHERE security_code=%s",
                        (rate, __import__("datetime").datetime.now().strftime("%Y-%m-%d %H:%M:%S"), code))
            conn.commit()
        ok += 1
        diff_rows.append((code, rate))
        time.sleep(0.5)

    print("完成: update=%d skip=%d fail=%d" % (ok, skip, fail))

    if args.emit_sql:
        with open(args.emit_sql, "w", encoding="utf-8") as f:
            f.write("-- 中签率精确回填 SQL 差值（非北交所），由 backfill_lottery_rate.py 生成\n")
            f.write("-- 在服务器库执行即可将 online_lottery_rate 同步为本地精填结果（幂等）\n")
            for code, val in diff_rows:
                lit = "NULL" if val is None else repr(float(val))
                f.write("UPDATE ipo_history SET online_lottery_rate=%s WHERE security_code='%s';\n" % (lit, code))
        print("已生成 SQL 差值: %s (行数 %d)" % (args.emit_sql, len(diff_rows)))

    cur.close(); conn.close()


if __name__ == "__main__":
    main()
