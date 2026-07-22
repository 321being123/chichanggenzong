import argparse
import json
import re
import urllib.request

import fitz


DATE_PATTERN = r"(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日"


def format_date(groups):
    return f"{int(groups[0]):04d}-{int(groups[1]):02d}-{int(groups[2]):02d}"


def extract_history(url, initial_price=None):
    if not (url.startswith("https://static.cninfo.com.cn/") or url.startswith("https://www.sse.com.cn/")
            or url.startswith("https://big5.sse.com.cn/") or url.startswith("https://disc.static.szse.cn/")):
        raise ValueError("仅允许读取巨潮资讯或交易所官方 PDF")
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        data = response.read(25 * 1024 * 1024 + 1)
    if len(data) > 25 * 1024 * 1024:
        raise ValueError("定期报告 PDF 超过 25MB")
    document = fitz.open(stream=data, filetype="pdf")
    text = "\n".join(page.get_text() for page in document)
    starts = [text.find("转股价格历次调整情况"), text.find("转股价格历次调整、修正情况")]
    start = max(starts)
    compact_text = re.sub(r"\s+", "", text)
    outlooks = re.findall(r"评级展望(?:调整)?为[：:]?([\u4e00-\u9fa5]{1,4})", compact_text)
    rating_outlook = outlooks[-1] if outlooks else None
    if start < 0:
        return {"source_url": url, "price_changes": [], "rating_outlook": rating_outlook}
    section = text[start:start + 12000]
    stop = re.search(r"(?:报告期末公司的负债情况|公司的负债情况、资信变化情况)", section)
    if stop:
        section = section[:stop.start()]
    section = re.sub(r"(20\d{2})-(\d{2})-(\d{2})", r"\1年\2月\3日", section)
    section = re.sub(r"(20\d{2})/(\d{1,2})/(\d{1,2})", r"\1年\2月\3日", section)
    section = re.sub(r"\s+", " ", section)
    pattern = re.compile(
        DATE_PATTERN + r"\s+(\d+(?:\.\d+)?)\s+" + DATE_PATTERN
        + r"\s+(?:《[^》]+》)?\s*(.*?)(?=" + DATE_PATTERN + r"\s+\d+(?:\.\d+)?|$)"
    )
    rows = []
    previous = float(initial_price) if initial_price is not None else None
    for match in pattern.finditer(section):
        after = float(match.group(4))
        reason = re.sub(r"\s+", "", match.group(8)).strip("，。;； ")
        concise_reason = re.search(r"(因[^，。]{0,40}(?:调整转股价格|修正转股价格))", reason)
        if concise_reason:
            reason = concise_reason.group(1)
        rows.append({
            "publish_date": format_date(match.groups()[4:7]),
            "change_date": format_date(match.groups()[0:3]),
            "convertprice_bef": previous,
            "convertprice_aft": after,
            "reason": reason,
            "source_url": url,
        })
        previous = after
    return {"source_url": url, "price_changes": rows, "rating_outlook": rating_outlook}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--initial-price", type=float, default=None)
    args = parser.parse_args()
    print(json.dumps(extract_history(args.url, args.initial_price), ensure_ascii=False))


if __name__ == "__main__":
    main()
