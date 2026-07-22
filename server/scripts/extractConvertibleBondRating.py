import argparse
import json
import re
import urllib.request

import fitz


def extract_rating(url, announcement_date=None):
    if not (url.startswith("https://static.cninfo.com.cn/") or url.startswith("https://www.sse.com.cn/")
            or url.startswith("https://big5.sse.com.cn/") or url.startswith("https://disc.static.szse.cn/")):
        raise ValueError("仅允许读取巨潮资讯或交易所官方 PDF")
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        data = response.read(15 * 1024 * 1024 + 1)
    if len(data) > 15 * 1024 * 1024:
        raise ValueError("评级报告 PDF 超过 15MB")
    document = fitz.open(stream=data, filetype="pdf")
    text = "\n".join(page.get_text() for page in document)
    compact = re.sub(r"\s+", "", text)
    outlook_match = re.search(r"评级展望\s*(?:调整)?为?\s*[：:]?\s*(稳定|正面|负面|发展中|观察)", text)
    rating_match = re.search(
        r"主体信用等级由[A-D]{1,3}[+-]?(?:调整至|调降至|上调至)[“\"]?([A-D]{1,3}[+-]?)",
        compact,
    )
    if not rating_match:
        rating_match = re.search(r"主体信用等级\s*[：:]?\s*([A-D]{1,3}[+-]?)", text)
    if not rating_match:
        rating_match = re.search(r"主体信用等级为[“\"]?([A-D]{1,3}[+-]?)", compact)
    date_match = re.search(r"评级日期[：:]?(20\d{2})年(\d{1,2})月(\d{1,2})日", compact)
    rating_date = announcement_date
    if date_match:
        rating_date = f"{int(date_match.group(1)):04d}-{int(date_match.group(2)):02d}-{int(date_match.group(3)):02d}"
    return {
        "rating_date": rating_date,
        "rating": rating_match.group(1) if rating_match else None,
        "rating_outlook": outlook_match.group(1) if outlook_match else None,
        "source_url": url,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--announcement-date", default=None)
    args = parser.parse_args()
    print(json.dumps(extract_rating(args.url, args.announcement_date), ensure_ascii=False))


if __name__ == "__main__":
    main()
