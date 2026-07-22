import argparse
import json
import re
import sys
import urllib.request

import fitz


FUND_WORDS = re.compile(r"基金|养老金|年金|社保|资产管理计划|集合资产管理")
NATURE_WORDS = {
    "其他", "境内自然人", "境外自然人", "境内非国有法人", "境内国有法人",
    "国有法人", "境外法人", "境内法人", "未知",
}


def clean_page(text):
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if lines and "报告全文" in lines[0]:
        lines.pop(0)
    if lines and re.fullmatch(r"\d{1,4}", lines[0]):
        lines.pop(0)
    return "\n".join(lines)


def parse_holders(text):
    start = text.find("前十名转债持有人情况如下")
    if start < 0:
        start = text.find("前十名可转债持有人")
    if start < 0:
        return []
    table = text[start:]
    stops = [table.find(marker) for marker in ("3、报告期转债", "3.报告期转债", "转股价格历次")]
    stops = [position for position in stops if position > 0]
    if stops:
        table = table[:min(stops)]
    rank_matches = list(re.finditer(r"(?m)^(10|[1-9])$", table))
    holders = []
    for index, match in enumerate(rank_matches):
        end = rank_matches[index + 1].start() if index + 1 < len(rank_matches) else len(table)
        lines = [line.strip() for line in table[match.end():end].splitlines() if line.strip()]
        ratio_index = next((i for i, line in enumerate(lines) if re.fullmatch(r"\d+(?:\.\d+)?%", line)), None)
        if ratio_index is None:
            continue
        numeric = []
        for i, line in enumerate(lines[:ratio_index]):
            if re.fullmatch(r"\d[\d,]*(?:\.\d+)?", line):
                numeric.append((i, float(line.replace(",", ""))))
        if len(numeric) < 2:
            continue
        quantity_index, quantity = numeric[-2]
        _, amount = numeric[-1]
        name_lines = [line for line in lines[:quantity_index] if line not in NATURE_WORDS]
        suffix_lines = [
            line for line in lines[ratio_index + 1:]
            if line not in NATURE_WORDS and not re.fullmatch(r"\d[\d,.]*%?", line)
        ]
        name_lines.extend(suffix_lines)
        name = "".join(name_lines)
        name = re.sub(r"^(?:序号|可转债持有人名称|可转债持有人性质)+", "", name)
        ratio = float(lines[ratio_index].rstrip("%")) / 100
        if name:
            holders.append({
                "rank": int(match.group(1)),
                "name": name,
                "quantity": quantity,
                "amount": amount,
                "ratio": ratio,
            })
    return holders


def extract(url):
    if not url.startswith("https://static.cninfo.com.cn/"):
        raise ValueError("仅允许读取巨潮资讯官方 PDF")
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        data = response.read(30 * 1024 * 1024 + 1)
    if len(data) > 30 * 1024 * 1024:
        raise ValueError("PDF 文件超过 30MB")
    document = fitz.open(stream=data, filetype="pdf")
    target_pages = []
    for index in range(len(document)):
        text = document[index].get_text()
        if "前十名转债持有人" in text or "前十名可转债持有人" in text:
            target_pages.extend(range(index, min(index + 3, len(document))))
            break
    combined = "\n".join(clean_page(document[index].get_text()) for index in target_pages)
    return parse_holders(combined)


def aggregate(holders):
    funds = [holder for holder in holders if FUND_WORDS.search(holder["name"])]
    return {
        "fund_count": len(funds),
        "holding_quantity": sum(item["quantity"] for item in funds) / 10000,
        "holding_market_value": sum(item["amount"] for item in funds) / 10000,
        "remain_size_ratio": sum(item["ratio"] for item in funds),
        "holders": funds,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("url", nargs="?")
    parser.add_argument("--stdin", action="store_true")
    args = parser.parse_args()
    if args.stdin:
        holders = parse_holders(sys.stdin.read())
    elif args.url:
        holders = extract(args.url)
    else:
        parser.error("缺少 PDF URL")
    print(json.dumps(aggregate(holders), ensure_ascii=False))


if __name__ == "__main__":
    main()
