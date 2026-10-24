import argparse
import json
import re
import sys
import urllib.request
import os
import unicodedata
from datetime import date

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '..', 'ipo-report'))
from external_call_guard import guarded_urlopen

import fitz
from convertibleBondDocument import read_report_document as read_document


FUND_WORDS = re.compile(r"基金|养老金|年金|社保|资产管理计划|集合资产管理")
HOLDER_TITLE = r"前十名(?:转债|可转债|可转换公司债(?:券)?)持有人"
NATURE_WORDS = {
    "其他", "境内自然人", "境外自然人", "境内非国有法人", "境内国有法人",
    "国有法人", "境外法人", "境内法人", "未知",
}


def clean_page(text):
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if lines and ("报告全文" in lines[0] or re.search(r'20\d{2}\s*年(?:半年度|年度)报告$', lines[0])):
        lines.pop(0)
    if lines and re.fullmatch(r"\d{1,4}(?:\s*/\s*\d{1,4})?", lines[0]):
        lines.pop(0)
    return "\n".join(lines)


def parse_holders(text):
    title = re.search(HOLDER_TITLE, text)
    if not title:
        return []
    table = text[title.start():]
    stops = [table.find(marker) for marker in ("3、报告期转债", "3.报告期转债", "转股价格历次")]
    stops = [position for position in stops if position > 0]
    if stops:
        table = table[:min(stops)]
    rank_matches = list(re.finditer(r"(?m)^(10|[1-9])$", table))
    # SSE reports also use an unnumbered table: holder -> CNY face amount -> percent.
    # Its explicit header is mandatory; a lone amount must never be guessed as bond quantity.
    if re.search(r"期末(?:持债数|持有数)\s*量?\s*[（(]元[）)]", table) and not re.search(r"序号", table[:table.find('期末')]):
        header = re.search(r"(?:持\s*有\s*)?比\s*例(?:\s*[（(]%[）)])?", table)
        if not header:
            return []
        section = table[header.end():]
        stop = re.search(r"(?:报告期(?:可转换公司债券|转债)|可转债)变动情况|转股价格历次", section)
        if stop:
            section = section[:stop.start()]
        lines = [line.strip() for line in section.splitlines() if line.strip()]
        # Narrow PDF cells wrap a comma-group amount; only join when the final
        # group becomes exactly three digits and a separate decimal ratio follows.
        merged = []
        i = 0
        while i < len(lines):
            if i + 2 < len(lines) and re.fullmatch(r"\d{1,3}(?:,\d{3})*,\d{1,2}", lines[i]) and re.fullmatch(r"\d{1,2}", lines[i+1]) and re.fullmatch(r"\d+\.\d+%?", lines[i+2]) and len(lines[i].rsplit(',',1)[1])+len(lines[i+1]) == 3:
                merged.append(lines[i]+lines[i+1]); i += 2
            else:
                merged.append(lines[i]); i += 1
        lines = merged
        holders, name_lines = [], []
        index = 0
        while index < len(lines):
            line = lines[index]
            if re.fullmatch(r"\d[\d,]*(?:\.\d+)?", line) and index + 1 < len(lines) and name_lines:
                ratio_line = lines[index + 1]
                if re.fullmatch(r"\d+(?:\.\d+)?%?", ratio_line):
                    amount = float(line.replace(',', ''))
                    ratio = float(ratio_line.rstrip('%'))
                    if 0 <= ratio <= 100 and amount > 0:
                        holders.append({'rank': len(holders) + 1, 'name': ''.join(name_lines),
                                        'quantity': amount / 100, 'amount': amount, 'ratio': ratio / 100,
                                        'table_unit': 'CNY_face_amount'})
                        name_lines = []
                        index += 2
                        continue
            if not re.search(r"\d+\s*/\s*\d+|公司\s*20\d{2}\s*年.*报告", line):
                name_lines.append(line)
            index += 1
        return holders
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
            else:
                pair = re.fullmatch(r"(\d[\d,]*(?:\.\d+)?)\s+(\d[\d,]*(?:\.\d+)?)", line)
                if pair:
                    numeric.extend((i, float(value.replace(",", ""))) for value in pair.groups())
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


def unlisted_holder_exemption(text, bond_name):
    if not bond_name or re.search(HOLDER_TITLE, text):
        return None
    compact = re.sub(r'\s+', '', unicodedata.normalize('NFKC', text))
    for heading in re.finditer('报告期转债持有人及担保人情况', compact):
        prefix = compact[max(0, heading.start()-400):heading.start()]
        section = compact[heading.end():heading.end()+500]
        stop = re.search(r'\([三四五六七八九十]\)', section)
        if stop:
            section = section[:stop.start()]
        names = re.findall(r'债券简称(?:为)?[:：]?[“"]([^”"]+)[”"]', prefix)
        if set(names) != {bond_name} or not re.match(r'[□√☑]*不适用', section):
            continue
        if not re.search(r'报告期内(?:公司|本公司|本行)?可转换公司债券未上市', section):
            continue
        dates = set()
        for m in re.finditer(r'于(20\d{2})年(\d{1,2})月(\d{1,2})日.{0,60}?上市交易', prefix):
            try:
                dates.add(date(*(int(v) for v in m.groups())).isoformat())
            except ValueError:
                pass
        if len(dates) == 1:
            return {'reason': 'not_listed_by_report_period', 'bond_name': bond_name,
                    'listing_date': next(iter(dates)), 'evidence': prefix+section}
    return None


def extract(url, security_code=None, bond_name=None, issuer_name=None):
    pages, evidence = read_document(url, security_code, bond_name, issuer_name)
    combined = '\n'.join(clean_page(page) for page in pages)
    candidates = list(re.finditer(HOLDER_TITLE, combined))
    scope = None
    if len(candidates) > 1:
        bindings = list(re.finditer(r'可转换公司债券名称\s*([^\n]+)', combined))
        matched = []
        for candidate in candidates:
            prior = [binding for binding in bindings if binding.end() <= candidate.start()]
            if prior and bond_name and re.sub(r'\s+', '', prior[-1].group(1)) == re.sub(r'\s+', '', bond_name):
                matched.append(candidate)
        candidates = matched
        if len(candidates) != 1:
            raise ValueError('多只转债持有人表无法唯一归属目标债券')
    if candidates:
        scope = candidates[0].start()
        end = re.search(r'可转换公司债券名称', combined[candidates[0].end():])
        stop = candidates[0].end() + end.start() if end else len(combined)
        combined = combined[scope:stop]
    else:
        exemption = unlisted_holder_exemption(combined, bond_name)
        if exemption:
            return {**evidence, 'parse_status': 'not_applicable', 'all_holders': [],
                    'holder_table_bond': bond_name, 'holder_exemption': exemption}
        combined = ''
    holders = parse_holders(combined)
    if candidates and len(holders) != 10:
        raise ValueError('前十名持有人表解析不完整，不能当作零基金持仓')
    return {**evidence, **aggregate(holders), 'all_holders': holders, 'holder_table_bond': bond_name, 'holder_table_offset': scope,
            'parse_status': 'complete' if holders else 'not_disclosed'}


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
    parser.add_argument("--security-code", default=None)
    parser.add_argument("--bond-name", default=None)
    parser.add_argument("--issuer-name", default=None)
    args = parser.parse_args()
    if args.stdin:
        result = aggregate(parse_holders(sys.stdin.read()))
    elif args.url:
        result = extract(args.url, args.security_code, args.bond_name, args.issuer_name)
    else:
        parser.error("缺少 PDF URL")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
