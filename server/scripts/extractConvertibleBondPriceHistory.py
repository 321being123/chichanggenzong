import argparse
import json
import re
import urllib.request
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '..', 'ipo-report'))
from external_call_guard import guarded_urlopen

import fitz
from convertibleBondDocument import read_report_document as read_document, report_table_rows


DATE_PATTERN = r"(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日"


def format_date(groups):
    return f"{int(groups[0]):04d}-{int(groups[1]):02d}-{int(groups[2]):02d}"


def parse_scanned_history(table, url, bond_name, initial_price):
    selected, active = [], False
    for row in table:
        cells = [re.sub(r'\s+', '', value) for value in row['cells']]
        if '转股价格调整日' in cells[1] and '披露时间' in cells[3]:
            active = True
            continue
        if not active:
            continue
        if cells[0] == bond_name:
            selected.append(cells)
        elif selected and cells[4] and not any(cells[:4]+cells[5:]):
            selected[-1][4] += cells[4]
    output, previous = [], initial_price
    latest_prices = set()
    for name, changed, price, published, reason, latest in selected:
        change_date, publish_date = re.fullmatch(DATE_PATTERN, changed), re.fullmatch(DATE_PATTERN, published)
        pair = re.search(r'由(\d+(?:\.\d+)?)元/股调整至(\d+(?:\.\d+)?)元/股', reason)
        if not change_date or not publish_date or not re.fullmatch(r'\d+(?:\.\d+)?', price) or not re.fullmatch(r'\d+(?:\.\d+)?', latest) or not pair:
            raise ValueError('扫描转股价表日期、价格或调整前后原文不完整')
        before, after = map(float, pair.groups())
        if after <= 0 or abs(after-float(price)) > .000001 or previous is not None and abs(float(previous)-before) > .000001:
            raise ValueError('扫描转股价表与原文调整价格或前后链不一致')
        output.append({'change_date': format_date(change_date.groups()), 'publish_date': format_date(publish_date.groups()),
                       'convertprice_bef': before, 'convertprice_aft': after, 'reason': reason, 'source_url': url})
        previous = after
        latest_prices.add(float(latest))
    if output and (latest_prices != {output[-1]['convertprice_aft']} or any(a['change_date'] >= b['change_date'] for a, b in zip(output, output[1:]))):
        raise ValueError('扫描转股价表未覆盖截至报告期末最新价格或日期顺序冲突')
    return output


def extract_history(url, initial_price=None, bond_name=None, security_code=None, issuer_name=None):
    pages, evidence = read_document(url, security_code, bond_name, issuer_name)
    text = "\n".join(pages)
    starts = [text.find("转股价格历次调整情况"), text.find("转股价格历次调整、修正情况")]
    start = max(starts)
    compact_text = re.sub(r"\s+", "", text)
    outlooks = re.findall(r"评级展望(?:调整)?为[：:]?([\u4e00-\u9fa5]{1,4})", compact_text)
    rating_outlook = outlooks[-1] if outlooks else None
    if start < 0:
        return {**evidence, "price_changes": [], "rating_outlook": rating_outlook}
    section = text[start:start + 12000]
    stop = re.search(r"(?:报告期末公司的负债情况|公司的负债情况、资信变化情况|五、\s*报告期内合并报表范围亏损|（五）)", section)
    if stop:
        section = section[:stop.start()]
    section = re.sub(r"(20\d{2})-(\d{2})-(\d{2})", r"\1年\2月\3日", section)
    section = re.sub(r"(20\d{2})/(\d{1,2})/(\d{1,2})", r"\1年\2月\3日", section)
    section = re.sub(r"\s+", " ", section)
    pattern = re.compile(
        r"([^\s]{2,20}?)\s+" + DATE_PATTERN + r"\s+(\d+(?:\.\d+)?)\s+" + DATE_PATTERN
        + r"\s+(?:《[^》]+》)?\s*(.*?)(?=[^\s]{2,20}?\s+" + DATE_PATTERN + r"\s+\d+(?:\.\d+)?|$)"
    )
    rows = []
    previous = float(initial_price) if initial_price is not None else None
    for match in pattern.finditer(section):
        row_bond_name = re.sub(r"\s+", "", match.group(1))
        if bond_name and bond_name not in row_bond_name.split("、"):
            continue
        after = float(match.group(5))
        reason = re.sub(r"\s+", "", match.group(9)).strip("，。;； ")
        reason = reason.split("截至本报告期末最新转股价格", 1)[0]
        reason = re.sub(r"(?:[\u4e00-\u9fa5]{1,8}转(?:债|\d+)[、,，]*)+$", "", reason)
        reason = re.sub(r"\d+(?:\.\d+)?$", "", reason)
        concise_reason = re.search(r"(因[^，。]{0,40}(?:调整转股价格|修正转股价格))", reason)
        if concise_reason:
            reason = concise_reason.group(1)
        rows.append({
            "publish_date": format_date(match.groups()[5:8]),
            "change_date": format_date(match.groups()[1:4]),
            "convertprice_bef": previous,
            "convertprice_aft": after,
            "reason": reason,
            "source_url": url,
        })
        previous = after
    if not rows and (not bond_name or bond_name in section):
        fallback_pattern = re.compile(
            DATE_PATTERN + r"\s+(\d+(?:\.\d+)?)\s+" + DATE_PATTERN
            + r"\s+(?:《[^》]+》)?\s*(.*?)(?=" + DATE_PATTERN + r"\s+\d+(?:\.\d+)?|$)"
        )
        for match in fallback_pattern.finditer(section):
            after = float(match.group(4))
            reason = re.sub(r"\s+", "", match.group(8)).strip("，。;； ")
            reason = reason.split("截至本报告期末最新转股价格", 1)[0]
            reason = re.sub(r"\d+(?:\.\d+)?$", "", reason)
            rows.append({
                "publish_date": format_date(match.groups()[4:7]),
                "change_date": format_date(match.groups()[0:3]),
                "convertprice_bef": previous,
                "convertprice_aft": after,
                "reason": reason,
                "source_url": url,
            })
            previous = after
    if evidence.get('text_method') == 'rapidocr-onnx-v1' and not rows:
        rows = parse_scanned_history(report_table_rows(url, evidence), url, bond_name, initial_price)
        if not rows:
            raise ValueError('扫描转股价表未完整解析，不能以空结果标记历史完成')
    return {**evidence, "price_changes": rows, "rating_outlook": rating_outlook}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--initial-price", type=float, default=None)
    parser.add_argument("--bond-name", default=None)
    parser.add_argument("--security-code", default=None)
    parser.add_argument("--issuer-name", default=None)
    args = parser.parse_args()
    print(json.dumps(extract_history(args.url, args.initial_price, args.bond_name, args.security_code, args.issuer_name), ensure_ascii=False))


if __name__ == "__main__":
    main()
