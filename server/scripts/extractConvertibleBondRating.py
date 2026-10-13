import argparse
import json
import re
import urllib.request
import os
import sys
from datetime import date
import unicodedata

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '..', 'ipo-report'))
from external_call_guard import guarded_urlopen

import fitz
from convertibleBondDocument import read_document


def chinese_number(value):
    digits = {**dict.fromkeys('零〇○', 0), **dict(zip('一二三四五六七八九', range(1, 10)))}
    if value.isdigit():
        return int(value)
    if '十' in value:
        tens, units = value.split('十', 1)
        return (digits.get(tens, 1) if tens else 1) * 10 + (digits[units] if units else 0)
    return int(''.join(str(digits[ch]) for ch in value))


def official_rating_date(pages):
    # 日期只消费评级正文/通知书的明确日期，不扫描历史评级附录。
    compact = re.sub(r'\s+', '', '\n'.join(pages[:3]))
    patterns = [
        r'(?:评级日期|评级时间|本次评级时间|报告日期)[：:]?.{0,80}?(20\d{2})[年/.-](\d{1,2})[月/.-](\d{1,2})日?',
        r'(?:中诚信国际信用评级有限责任公司|大公国际资信评估有限公司|联合资信评估股份有限公司|中证鹏元资信评估股份有限公司|东方金诚国际信用评估有限公司)[：:]?(20\d{2})年(\d{1,2})月(\d{1,2})日',
        r'([二〇○零一三四五六七八九]{4})年([一二三四五六七八九十\d]{1,3})月([一二三四五六七八九十\d]{1,3})日',
    ]
    for pattern in patterns:
        found = set()
        for match in re.finditer(pattern, compact):
            try:
                found.add(date(*(chinese_number(part) for part in match.groups())).isoformat())
            except (ValueError, KeyError):
                continue
        if len(found) == 1:
            return found.pop(), match.group(0)
    return None, None


def parse_rating_pages(pages, bond_name, announcement_date):
    text = unicodedata.normalize('NFKC', "\n".join(pages))
    compact = re.sub(r"\s+", "", text)
    summary = re.sub(r'\s+', '', unicodedata.normalize('NFKC', '\n'.join(pages[:3])))
    table = None
    if bond_name and bond_name in summary and re.search(r'(?:主体|评级)/展望/债项/评级时间', summary):
        table = re.search(r'本次(?:跟踪|评级)[：:]?([A-D]{1,3}[+-]?)/(稳定|正面|负面|发展中|观察)/([A-D]{1,3}[+-]?)/(20\d{2})年(\d{1,2})月(\d{1,2})日', summary)
    outlook_match = re.search(r"评级展望\s*(?:调整|维持)?为?\s*[：:]?\s*(稳定|正面|负面|发展中|观察)", text)
    rating_match = re.search(
        r"主体信用等级由[A-D]{1,3}[+-]?(?:调整至|调降至|上调至)[“\"]?([A-D]{1,3}[+-]?)",
        compact,
    )
    if not rating_match:
        rating_match = re.search(r"主体(?:长期)?信用等级\s*(?:为)?\s*[：:]?\s*([A-D]{1,3}[+-]?)", text)
    if not rating_match:
        rating_match = re.search(r"主体信用等级为[“\"]?([A-D]{1,3}[+-]?)", compact)
    if bond_name:
        rating_match = re.search(re.escape(bond_name) + r"[”\"]?(?:的)?(?:债项)?(?:长期)?信用等级(?:由[A-D]{1,3}[+-]?(?:调整至|上调至|调降至)|均为|为|维持为|维持|：|:)?[“\"]?([A-D]{1,3}[+-]?)", compact)
        if not rating_match:
            rating_match = re.search(re.escape(bond_name) + r"[”\"]?(?:的)?(?:债项)?(?:信用)?评级(?:结果)?(?:为|维持为|：|:)?[“\"]?([A-D]{1,3}[+-]?)", compact)
        if not rating_match:
            rating_match = re.search(re.escape(bond_name) + r"[”\"]?[：:|]?([A-D]{1,3}[+-]?)[/／](?:稳定|正面|负面|发展中|观察)", compact)
    rating_date, date_evidence = official_rating_date(pages)
    if table:
        rating_date = date(*(int(table.group(i)) for i in [4, 5, 6])).isoformat()
        date_evidence = table.group(0)
    rating_date_source = 'official_document' if rating_date else 'announcement_fallback'
    if rating_date and announcement_date and rating_date > announcement_date:
        raise ValueError('评级原文日期晚于公告日期，保留原事实')
    return {
        "rating_date": rating_date or announcement_date,
        "rating_date_source": rating_date_source,
        "rating": table.group(3) if table else rating_match.group(1) if rating_match else None,
        "rating_outlook": table.group(2) if table else outlook_match.group(1) if outlook_match else None,
        "rating_evidence": table.group(0) if table else rating_match.group(0) if rating_match else None,
        "outlook_evidence": table.group(0) if table else outlook_match.group(0) if outlook_match else None,
        "date_evidence": date_evidence,
    }


def extract_rating(url, announcement_date=None, security_code=None, bond_name=None, issuer_name=None):
    def complete(pages):
        text = re.sub(r'\s+', '', '\n'.join(pages))
        issuer = re.sub(r'\s+', '', unicodedata.normalize('NFKC', issuer_name or ''))
        text = unicodedata.normalize('NFKC', text)
        identity = (not security_code or security_code.split('.')[0] in text or issuer and issuer in text) and (not bond_name or bond_name in text)
        result = parse_rating_pages(pages, bond_name, announcement_date)
        return identity and result['rating'] and result['rating_outlook'] and result['rating_date_source'] == 'official_document'
    try:
        pages, evidence = read_document(url, security_code, bond_name, issuer_name)
    except ValueError as error:
        if not any(word in str(error) for word in ['无文本层', '未匹配目标']):
            raise
        pages, evidence = read_document(url, security_code, bond_name, issuer_name, ocr=True, stop_when=complete)
    result = parse_rating_pages(pages, bond_name, announcement_date)
    if (not result['rating'] or not result['rating_outlook']) and (not bond_name or bond_name in re.sub(r'\s+', '', '\n'.join(pages))):
        pages, evidence = read_document(url, security_code, bond_name, issuer_name, ocr=True, stop_when=complete)
        result = parse_rating_pages(pages, bond_name, announcement_date)
    return {**evidence, **result, 'source_url': url}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--announcement-date", default=None)
    parser.add_argument("--security-code", default=None)
    parser.add_argument("--bond-name", default=None)
    parser.add_argument("--issuer-name", default=None)
    args = parser.parse_args()
    print(json.dumps(extract_rating(args.url, args.announcement_date, args.security_code, args.bond_name, args.issuer_name), ensure_ascii=False))


if __name__ == "__main__":
    main()
