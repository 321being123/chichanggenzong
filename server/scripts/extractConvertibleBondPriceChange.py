import argparse
import json
import re
import urllib.request

import fitz


DATE_PATTERN = r"(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日"


def date_text(match):
    return f"{int(match.group(1)):04d}-{int(match.group(2)):02d}-{int(match.group(3)):02d}"


def extract_one(url):
    if not url.startswith("https://static.cninfo.com.cn/"):
        raise ValueError("仅允许读取巨潮资讯官方 PDF")
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        data = response.read(12 * 1024 * 1024 + 1)
    if len(data) > 12 * 1024 * 1024:
        raise ValueError("公告 PDF 超过 12MB")
    document = fitz.open(stream=data, filetype="pdf")
    text = re.sub(r"\s+", "", "\n".join(page.get_text() for page in document))
    current_changes = list(re.finditer(
        r"(?:董事会(?:决定|同意)将|同意将).{0,50}?转股价格(?:由(\d+(?:\.\d+)?)元/股)?向下修正为(\d+(?:\.\d+)?)元/股",
        text,
    ))
    current_change = current_changes[-1] if current_changes else None
    changes = list(re.finditer(r"转股价格由(?:原来(?:的)?|人民币)?(\d+(?:\.\d+)?)元/股(?:调整|向下修正)为(?:人民币)?(\d+(?:\.\d+)?)元/股", text))
    changed = changes[-1] if changes else None
    before = changed or re.search(r"(?:调整|修正)前.{0,30}?转股价格[：:为]*人民币?(\d+(?:\.\d+)?)元/股", text)
    after = changed or re.search(r"(?:调整|修正)后.{0,30}?转股价格[：:为]*人民币?(\d+(?:\.\d+)?)元/股", text)
    price_before = float(before.group(1)) if before else None
    price_after = float(after.group(2) if before is after and after else after.group(1)) if after else None
    if current_change:
        price_after = float(current_change.group(2))
        if current_change.group(1):
            price_before = float(current_change.group(1))
        else:
            prior_prices = list(re.finditer(r"当期转股价格(?:即)?(\d+(?:\.\d+)?)元/股", text[:current_change.start()]))
            if prior_prices:
                price_before = float(prior_prices[-1].group(1))
    effective_matches = list(re.finditer(
        r"(?:(?:调整|修正)(?:后的)?.{0,30}?转股价格(?:生效日期|自)|(?:调整|修正)生效日期)[：:]?" + DATE_PATTERN,
        text,
    ))
    effective = effective_matches[-1] if effective_matches else None
    floor_matches = list(re.finditer(
        r"(?:修正|调整)后的.{0,30}?转股价格(?:应|将)?不低于(?:人民币)?(\d+(?:\.\d+)?)元/股",
        text,
    ))
    floor_price = float(floor_matches[-1].group(1)) if floor_matches else None
    if floor_price is None:
        twenty_day = list(re.finditer(r"股东大会召开前二十个交易日公司股票交易均价为(\d+(?:\.\d+)?)元/股", text))
        previous_day = list(re.finditer(r"股东大会召开前(?:一|一个)交易日公司股票交易均价为(\d+(?:\.\d+)?)元/股", text))
        values = [float(matches[-1].group(1)) for matches in (twenty_day, previous_day) if matches]
        floor_price = max(values) if values else None
    return {
        "source_url": url,
        "price_before": price_before,
        "price_after": price_after,
        "change_date": date_text(effective) if effective else None,
        "revision_floor_price": floor_price,
        "parser_version": "3",
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("urls", nargs="+")
    args = parser.parse_args()
    print(json.dumps([extract_one(url) for url in args.urls[:10]], ensure_ascii=False))


if __name__ == "__main__":
    main()
