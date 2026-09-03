import argparse
import json
import re
import urllib.request
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '..', 'ipo-report'))
from external_call_guard import guarded_urlopen

import fitz


DATE = r"(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?"
PARTIAL_DATE = r"(\d{1,2})\s*月\s*(\d{1,2})\s*日?"


def iso(match, year_hint=None):
    if match.lastindex >= 3:
        return f"{int(match.group(1)):04d}-{int(match.group(2)):02d}-{int(match.group(3)):02d}"
    if match.lastindex == 2 and year_hint:
        return f"{int(year_hint):04d}-{int(match.group(1)):02d}-{int(match.group(2)):02d}"
    return None


def date_from(text, patterns, year_hint=None):
    for pattern in patterns:
        hit = re.search(pattern, text)
        if hit:
            value = iso(hit, year_hint)
            if value:
                return value
    return None


def infer_year(text):
    years = [int(value) for value in re.findall(r"(20\d{2})\s*年", text)]
    return max(years) if years else None


def extract_one(url):
    if not (url.startswith("https://static.cninfo.com.cn/")
            or url.startswith("https://www.sse.com.cn/")
            or url.startswith("https://big5.sse.com.cn/")
            or url.startswith("https://disc.static.szse.cn/")):
        raise ValueError("仅允许读取巨潮资讯或交易所官方 PDF")
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with guarded_urlopen(request, timeout=30, source=None, dataset=f"bond-call-pdf:{url}") as response:
        data = response.read(12 * 1024 * 1024 + 1)
    if len(data) > 12 * 1024 * 1024:
        raise ValueError("公告 PDF 超过 12MB")
    document = fitz.open(stream=data, filetype="pdf")
    text = re.sub(r"\s+", "", "\n".join(page.get_text() for page in document))
    url_year = re.search(r"/(20\d{2})-\d{2}-\d{2}/", url)
    year_hint = int(url_year.group(1)) if url_year else infer_year(text)

    ranges = list(re.finditer(DATE + r"\s*(?:至|到|—|-)\s*" + DATE, text))
    no_call_until = None
    range_candidates = []
    for hit in ranges:
        context = text[max(0, hit.start() - 260):hit.end() + 260]
        if re.search(r"不提前赎回|不行使.*赎回|暂不赎回|不实施.*赎回", context):
            range_candidates.append(f"{int(hit.group(4)):04d}-{int(hit.group(5)):02d}-{int(hit.group(6)):02d}")
    if range_candidates:
        no_call_until = max(range_candidates)
    if not no_call_until:
        explicit = re.search(r"(?:不提前赎回|暂不赎回|不行使.*赎回).{0,240}?" + DATE, text)
        if explicit:
            no_call_until = iso(explicit, year_hint)

    last_conversion_date = date_from(text, [
        r"最后转股日(?:为|：|是)?" + DATE,
        r"最后转股日(?:为|：|是)?" + PARTIAL_DATE,
        r"停止转股日(?:为|：|是)?" + DATE,
        r"停止转股日(?:为|：|是)?" + PARTIAL_DATE,
        r"转股截止日(?:为|：|是)?" + DATE,
        r"转股截止日(?:为|：|是)?" + PARTIAL_DATE,
    ], year_hint)
    last_trade_date = date_from(text, [
        r"最后交易日(?:为|：|是)?" + DATE,
        r"最后交易日(?:为|：|是)?" + PARTIAL_DATE,
        r"停止交易日(?:为|：|是)?" + DATE,
        r"停止交易日(?:为|：|是)?" + PARTIAL_DATE,
    ], year_hint)
    redemption_record_date = date_from(text, [
        r"(?:赎回)?登记日(?:为|：|是)?" + DATE,
        r"(?:赎回)?登记日(?:为|：|是)?" + PARTIAL_DATE,
    ], year_hint)
    price = None
    price_hit = re.search(r"赎回价格[^0-9]{0,40}(\d+(?:\.\d+)?)\s*元", text)
    if price_hit:
        price = float(price_hit.group(1))
    return {
        "source_url": url,
        "no_call_until": no_call_until,
        "last_conversion_date": last_conversion_date,
        "last_trade_date": last_trade_date,
        "redemption_record_date": redemption_record_date,
        "redemption_price": price,
        "parser_version": "2",
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("urls", nargs="+")
    args = parser.parse_args()
    output = []
    for url in args.urls[:10]:
        try:
            output.append(extract_one(url))
        except Exception as exc:
            output.append({"source_url": url, "error": str(exc), "parser_version": "2"})
    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    main()
