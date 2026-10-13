import argparse
import json
import re
import urllib.request
import os
import sys
from datetime import date
from decimal import Decimal
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
    # A scanned notification/cover/declaration can put the current summary on
    # page four or later. Explicit date labels remain scoped away from history.
    current_pages = [re.split(r'评级历史|历史评级|附录', page, maxsplit=1)[0] for page in pages]
    patterns = [
        r'(?:评级日期|评级时间|本次评级时间|报告日期)[：:]?.{0,80}?(20\d{2})[年/.-](\d{1,2})[月/.-](\d{1,2})日?',
        r'(?:中诚信国际信用评级有限责任公司|大公国际资信评估有限公司|联合资信评估股份有限公司|中证鹏元资信评估股份有限公司|东方金诚国际信用评估有限公司)[：:]?(20\d{2})年(\d{1,2})月(\d{1,2})日',
        r'([二〇○零一三四五六七八九]{4})年([一二三四五六七八九十\d]{1,3})月([一二三四五六七八九十\d]{1,3})日',
    ]
    for pattern in patterns:
        for page in current_pages:
            found = {}
            compact = re.sub(r'\s+', '', page)
            for match in re.finditer(pattern, compact):
                if re.search(r'(?:上次|前次|历史)$', compact[max(0,match.start()-4):match.start()]):
                    continue
                try:
                    found[date(*(chinese_number(part) for part in match.groups())).isoformat()] = match.group(0)
                except (ValueError, KeyError):
                    continue
            if len(found) == 1:
                return next(iter(found.items()))
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
    # Explicit current/previous columns identify the bond row; the issuer row
    # and historical-rating appendices must never provide its grade.
    row_rating = None
    if bond_name:
        for page in pages:
            page = unicodedata.normalize('NFKC', page)
            if not re.search(r'评级结果', page) or re.search(r'历史评级|评级历史|附录', page):
                continue
            if not re.search(r'本次(?:跟踪)?评级', page) or not re.search(r'上次评级', page):
                continue
            name_pattern = r'\s*'.join(re.escape(ch) for ch in bond_name)
            match = re.search(name_pattern + r'[”"]?\s+([A-D]{1,3}[+-]?)\s+([A-D]{1,3}[+-]?)(?=\s|$)', page)
            if match:
                row_rating = match
                break
    if table:
        rating_date = date(*(int(table.group(i)) for i in [4, 5, 6])).isoformat()
        date_evidence = table.group(0)
    rating_date_source = 'official_document' if rating_date else 'announcement_fallback'
    if rating_date and announcement_date and rating_date > announcement_date:
        raise ValueError('评级原文日期晚于公告日期，保留原事实')
    return {
        "rating_date": rating_date or announcement_date,
        "rating_date_source": rating_date_source,
        "rating": table.group(3) if table else rating_match.group(1) if rating_match else row_rating.group(1) if row_rating else None,
        "rating_outlook": table.group(2) if table else outlook_match.group(1) if outlook_match else None,
        "rating_evidence": table.group(0) if table else rating_match.group(0) if rating_match else row_rating.group(0) if row_rating else None,
        "outlook_evidence": table.group(0) if table else outlook_match.group(0) if outlook_match else None,
        "date_evidence": date_evidence,
    }


def extract_rating(url, announcement_date=None, security_code=None, bond_name=None, issuer_name=None, issue_date=None, initial_issue_size_yuan=None, initial_tenor_years=None):
    initial_window = bool(initial_issue_size_yuan and initial_tenor_years and issue_date and announcement_date and announcement_date <= issue_date)
    def initial_binding(pages):
        cover = re.sub(r'\s+', '', unicodedata.normalize('NFKC', pages[0] if pages else ''))
        issuer = re.sub(r'\s+', '', unicodedata.normalize('NFKC', issuer_name or ''))
        text = re.sub(r'\s+', '', unicodedata.normalize('NFKC', '\n'.join(pages)))
        amount = re.search(r'发行规模[：:]?(?:不超过)?([\d.]+)亿元', text)
        tenor = re.search(r'发行期限[：:]?(?:不超过)?(\d+)年', text)
        return initial_window and issuer and issuer in cover and '向不特定对象发行可转换公司债券信用评级报告' in cover and '跟踪评级' not in cover and amount and tenor and Decimal(amount.group(1))*Decimal(100000000)==Decimal(str(initial_issue_size_yuan)) and int(tenor.group(1))==int(initial_tenor_years)
    def parse(pages):
        result = parse_rating_pages(pages, bond_name, announcement_date)
        if not result['rating'] and initial_binding(pages):
            candidates = re.findall(r'债券信用等级\s*[：:]?\s*([A-D]{1,3}[+-]?)(?=\s|$)', unicodedata.normalize('NFKC', '\n'.join(pages)))
            if len(set(candidates)) == 1:
                result['rating'] = candidates[0]
                result['rating_evidence'] = '债券信用等级 ' + candidates[0]
                result['identity_binding'] = {'method':'unique_issuer_issue_amount_tenor','issuer':issuer_name,'security_code':security_code,'bond_name':bond_name,'issue_date':issue_date,'announcement_date':announcement_date,'issue_size_yuan':str(initial_issue_size_yuan),'tenor_years':initial_tenor_years,'document_title':'向不特定对象发行可转换公司债券信用评级报告'}
        return result
    def complete(pages):
        text = re.sub(r'\s+', '', '\n'.join(pages))
        issuer = re.sub(r'\s+', '', unicodedata.normalize('NFKC', issuer_name or ''))
        text = unicodedata.normalize('NFKC', text)
        identity = (not security_code or security_code.split('.')[0] in text or issuer and issuer in text) and (not bond_name or bond_name in text or initial_binding(pages))
        result = parse(pages)
        return identity and result['rating'] and result['rating_outlook'] and result['rating_date_source'] == 'official_document'
    try:
        pages, evidence = read_document(url, security_code, None if initial_window else bond_name, issuer_name)
        if initial_window and not initial_binding(pages) and bond_name and bond_name not in re.sub(r'\s+', '', '\n'.join(pages)):
            raise ValueError('PDF 未匹配目标可转债简称')
    except ValueError as error:
        if not any(word in str(error) for word in ['无文本层', '未匹配目标']):
            raise
        pages, evidence = read_document(url, security_code, None if initial_window else bond_name, issuer_name, ocr=True, stop_when=complete)
    result = parse(pages)
    if (not result['rating'] or not result['rating_outlook']) and (not bond_name or bond_name in re.sub(r'\s+', '', '\n'.join(pages))):
        pages, evidence = read_document(url, security_code, None if initial_window else bond_name, issuer_name, ocr=True, stop_when=complete)
        result = parse(pages)
    return {**evidence, **result, 'source_url': url}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--announcement-date", default=None)
    parser.add_argument("--security-code", default=None)
    parser.add_argument("--bond-name", default=None)
    parser.add_argument("--issuer-name", default=None)
    parser.add_argument("--issue-date", default=None)
    parser.add_argument("--initial-issue-size-yuan", default=None)
    parser.add_argument("--initial-tenor-years", type=int, default=None)
    args = parser.parse_args()
    print(json.dumps(extract_rating(args.url, args.announcement_date, args.security_code, args.bond_name, args.issuer_name, args.issue_date, args.initial_issue_size_yuan, args.initial_tenor_years), ensure_ascii=False))


if __name__ == "__main__":
    main()
