import argparse
import json
import re
import urllib.request
import os
import sys
import unicodedata

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '..', 'ipo-report'))
from external_call_guard import guarded_urlopen

import fitz
from convertibleBondDocument import read_document


CHINESE_YEARS = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}


def clean_page(text):
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if lines and ("募集说明书" in lines[0] or "发行公告" in lines[0]):
        lines.pop(0)
    if lines and re.fullmatch(r"\d{1,4}", lines[0]):
        lines.pop(0)
    return "\n".join(lines)


def coupon_rates(text):
    compact = re.sub(r"\s+", "", unicodedata.normalize('NFKC', text))
    found = {}
    for year, rate in re.findall(r"第([一二三四五六七八九十\d]+)年(?:的)?(?:票面利率|利率)?(?:为|：|:)?(\d+(?:\.\d+)?)%", compact):
        number = int(year) if year.isdigit() else CHINESE_YEARS.get(year)
        if number:
            found[number] = float(rate)
    return [{"interest_year": year, "coupon_rate": found[year]} for year in sorted(found)]


def concise_projects(section):
    # 项目表只消费合计行之前的内容，不能把后续注释、审批表和前次募资写进本次用途。
    if "项目名称" in section:
        total = re.search(r"(?m)^\s*合计\s*$", section)
        if total:
            section = section[:total.start()]
    lines = [line.strip() for line in section.splitlines() if line.strip()]
    headings = []
    for line in lines:
        match = re.match(r"^[一二三四五六七八九十]+[、.．]\s*(.+)$", line)
        if match:
            name = re.sub(r"\s+\d+(?:\.\d+)?$", "", match.group(1)).strip()
            if name and not re.match(r"^(?:本次)?募集资金", name):
                headings.append(name)
    if len(headings) >= 2 and '项目名称' not in section:
        names = headings
    else:
        names = []
        start = next((i + 1 for i, line in enumerate(lines) if line in {"拟投入募集资金", "拟使用募集资金"}), 0)
        index = start
        while index < len(lines):
            line = lines[index]
            inline = re.match(r"^(\d{1,2})[、.．]\s*(.+)$", line)
            rank = re.fullmatch(r"\d{1,2}", line)
            if inline:
                name = inline.group(2).strip()
                index += 1
            elif rank:
                parts = []
                index += 1
                while index < len(lines):
                    current = lines[index]
                    if re.fullmatch(r"\d[\d,]*(?:\.\d+)?", current) or re.fullmatch(r"\d+(?:\.\d+)?%", current):
                        break
                    if re.fullmatch(r"\d{1,2}", current) or re.match(r"^\d{1,2}[、.．]", current):
                        break
                    if current not in {"项目名称", "序号", "小计", "合计"}:
                        parts.append(current)
                    index += 1
                name = "".join(parts).strip()
            else:
                index += 1
                continue
            name = re.sub(r"\s+\d+(?:\.\d+)?$", "", name).strip()
            if name and not re.fullmatch(r"\d+(?:\.\d+)?", name) and len(name) >= 4 and not re.search(r"总投资|募集资金|单位[:：]|合计|小计|备案证明", name):
                names.append(name)
                if re.search(r"补充(?:流动|营运)资金|偿还银行贷款", name):
                    break
        if not names and headings:
            names = headings
    unique = []
    for name in names:
        if name not in unique:
            unique.append(name)
    return "\n".join(f"{index}.{name}" for index, name in enumerate(unique, 1)) or None


def fundraising_purpose(pages):
    purpose_titles = ("本次募集资金用途", "本次募集资金投资项目概况", "本次募集资金运用",
                      "本次募集资金的运用", "本次募集资金使用计划", "本次募集资金使用概况",
                      "募集资金投资项目的计划")
    candidates = []
    for index, page in enumerate(pages):
        heading_prefix = r"(?m)^\s*(?:(?:第[一二三四五六七八九十\d]+[章节])|(?:[（(]?[一二三四五六七八九十\d]+[）)、.．]))?\s*"
        heading_suffix = r"[ \t]*(?:[.．…·]+[ \t]*\d+)?[ \t]*$"
        keys = [key for key in purpose_titles if re.search(heading_prefix + re.escape(key) + heading_suffix, page)]
        if not keys:
            continue
        combined = "\n".join(pages[index:index + 3])
        score = 5 * combined.count("拟投入募集资金") + 3 * combined.count("项目名称") + combined.count("单位：万元")
        score += len(re.findall(r"(?m)^\s*\d[\d,]*\.\d{2}\s*$", combined))
        if "目录" in page[:200]:
            score -= 20
        candidates.append((score, combined, keys))
    for _, combined, keys in sorted(candidates, key=lambda item: item[0], reverse=True):
        key = next((value for value in ("本次募集资金投资项目概况", "本次募集资金用途", "本次募集资金运用") if value in keys), keys[0])
        heading = re.search(heading_prefix + re.escape(key) + heading_suffix, combined)
        section = combined[heading.end():]
        project_stop = re.search(r"(?m)^\s*[二三四五六七八九十]+[、.．]\s*本次募集资金投资项目(?:基本|具体)情况", section)
        if project_stop:
            section = section[:project_stop.start()]
        stop = re.search(r"(?m)^\s*\d{1,2}[、.．]\s*募集资金(?:存放|专项存储)", section)
        if stop:
            section = section[:stop.start()]
        result = concise_projects(section)
        if result and not re.search(r"担保事项|评级事项|受托管理", result):
            return result
        # 银行的用途是完整资本补充句，不是项目明细表；只记录原文明确声明。
        narrative = re.search(r"((?:本行|本银行)[^。]{0,100}募集(?:的)?资金[^。]{0,240}用于补充(?:本行|本银行)(?:核心)?(?:一|二)级资本[^。]{0,80}。)", re.sub(r"\s+", "", section))
        if narrative:
            return narrative.group(1)
    return None


def extract(url, security_code=None, bond_name=None, issuer_name=None, require_bond_prospectus=False):
    pages, evidence = read_document(url, security_code, bond_name, issuer_name)
    if require_bond_prospectus:
        cover = re.sub(r'\s+', '', ''.join(pages[:3]))
        if not re.search(r'(?:可转换公司债(?:券)?|可转债)(?:证券)?募集说明书', cover) or re.search(r'募集说明书提示(?:性)?公告', cover):
            raise ValueError('募集说明书封面未确认可转债文种，不能用股票或提示公告替代')
    pages = [clean_page(page) for page in pages]
    rates = []
    for page in pages:
        if "债券利率" in page or "票面利率" in page or re.search(r'[（(][一二三四五六七八九十]+[）)]\s*利率', page):
            rates = coupon_rates(page)
            if rates:
                break
    compact = re.sub(r'\s+', '', '\n'.join(pages))
    not_disclosed = not rates and bool(re.search(r'(?:票面利率|债券利率).{0,200}(?:将.{0,80}确定|发行前.{0,160}协商确定|授权.{0,160}协商确定)', compact))
    return {**evidence, "fundraising_purpose": fundraising_purpose(pages), "coupon_rates": rates,
            'coupon_status': 'parsed' if rates else 'not_disclosed' if not_disclosed else 'missing'}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--security-code", default=None)
    parser.add_argument("--bond-name", default=None)
    parser.add_argument("--issuer-name", default=None)
    parser.add_argument("--require-bond-prospectus", action="store_true")
    args = parser.parse_args()
    print(json.dumps(extract(args.url, args.security_code, args.bond_name, args.issuer_name, args.require_bond_prospectus), ensure_ascii=False))


if __name__ == "__main__":
    main()
