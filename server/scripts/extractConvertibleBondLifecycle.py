import argparse
import json
import os
import re
import sys
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '..', 'ipo-report'))
from external_call_guard import guarded_urlopen

import fitz


DATE = r"(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?"


def iso(match):
    return f"{int(match.group(1)):04d}-{int(match.group(2)):02d}-{int(match.group(3)):02d}" if match else None


def first_date(text, patterns):
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            return iso(match)
    return None


def first_text(text, patterns):
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            return match.group(1).strip("“”\"'。，,; ")
    return None


def parse_text(raw_text):
    text = re.sub(r"\s+", "", raw_text or "")
    bond_code = first_text(text, [
        r"(?:债券|可转债)(?:代码|交易代码)[：:]?(\d{6})",
        r"(?:代码|债券代码)[：:]?(1(?:10|11|13|18|23|27|28)\d{3})",
    ])
    bond_name = first_text(text, [
        r"(?:债券|可转债)(?:简称|交易简称)[：:]?(.{2,12}?)(?=(?:股票|证券|债券|可转债)(?:代码|简称|交易代码|交易简称)[：:]?|(?:上市时间|上市日期|上市交易日|发行总额|发行规模|网上申购日|申购日|原股东优先配售股权登记日|股权登记日)[：:]?|$)",
    ])
    stock_code = first_text(text, [r"(?:股票|证券)代码[：:]?(\d{6})"])
    stock_name = first_text(text, [
        r"(?:股票|证券)简称[：:]?(.{2,12}?)(?=(?:股票|证券|债券|可转债)(?:代码|简称|交易代码|交易简称)[：:]?|(?:上市时间|上市日期|上市交易日|发行总额|发行规模|网上申购日|申购日|原股东优先配售股权登记日|股权登记日)[：:]?|$)",
    ])
    listing_date = first_date(text, [
        r"(?:上市时间|上市日期|上市交易日)[：:]?" + DATE,
        r"(?:将于|于)" + DATE + r"起?在[^\n]{0,30}上市交易",
    ])
    online_date = first_date(text, [
        r"(?:网上申购日|申购日)(?:[（(]T日[）)])?[：:]?" + DATE,
        r"网上申购时间[^\n]{0,40}" + DATE,
    ])
    record_date = first_date(text, [
        r"(?:股权登记日|原股东优先配售股权登记日)[：:]?" + DATE,
    ])
    issue_scale = None
    scale = re.search(r"(?:发行总额|发行规模)[^\d]{0,20}([\d,.]+)亿元", text)
    if scale:
        issue_scale = float(scale.group(1).replace(",", ""))
    return {
        "bond_code": bond_code,
        "bond_name": bond_name,
        "stock_code": stock_code,
        "stock_name": stock_name,
        "listing_date": listing_date,
        "online_date": online_date,
        "shareholder_record_date": record_date,
        "issue_scale": issue_scale,
        "parser_version": "lifecycle-v1",
    }


def extract_one(url):
    allowed = (
        "https://static.cninfo.com.cn/",
        "https://www.sse.com.cn/",
        "https://big5.sse.com.cn/",
        "https://disc.static.szse.cn/",
    )
    if not url.startswith(allowed):
        raise ValueError("仅允许读取巨潮资讯或交易所官方 PDF")
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with guarded_urlopen(request, timeout=30, source=None, dataset=f"bond-lifecycle-pdf:{url}") as response:
        data = response.read(15 * 1024 * 1024 + 1)
    if len(data) > 15 * 1024 * 1024:
        raise ValueError("公告 PDF 超过 15MB")
    document = fitz.open(stream=data, filetype="pdf")
    parsed = parse_text("\n".join(page.get_text() for page in document))
    return {"source_url": url, **parsed}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("urls", nargs="+")
    args = parser.parse_args()
    output = []
    for url in args.urls[:20]:
        try:
            output.append(extract_one(url))
        except Exception as exc:
            output.append({"source_url": url, "error": str(exc), "parser_version": "lifecycle-v1"})
    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    main()
