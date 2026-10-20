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


def previous_rating_context(text, start):
    prefix = re.sub(r'\s+', '', text[:start]).split('。')[-1][-250:]
    if '评级结果' in prefix and re.search(r'本次(?:跟踪)?评级上次评级|上次评级本次(?:跟踪)?评级|本次首次|首次本次', prefix):
        return bool(re.search(r'(?:上次|前次|首次)$', prefix))
    previous = [match.start() for match in re.finditer(r'前次|上次|首次|历史', prefix)]
    current = [match.start() for match in re.finditer(r'本次|此次', prefix)]
    return bool(previous) and max(previous) > max(current, default=-1)


def find_current(pattern, text):
    return next((match for match in re.finditer(pattern, text) if not previous_rating_context(text, match.start())), None)


def normalize_rating_text(text):
    # NFKC alone leaves U+2212 intact; do not truncate AA− to AA.
    return unicodedata.normalize('NFKC', text).translate(str.maketrans({'−': '-', '–': '-', '‐': '-', '‑': '-'}))


def current_bond_conclusions(pages, bond_name):
    if not bond_name:
        return []
    evidence = []
    for page in pages:
        text = re.sub(r'\s+', '', normalize_rating_text(page))
        text = re.split(r'历史评级|评级历史|附录|评级模型', text, maxsplit=1)[0]
        pattern = re.escape(bond_name) + r'[”\"]?(?:的)?(?:债项)?(?:长期)?信用等级(?:由[A-D]{1,3}[+-]?(?:调整至|上调至|调降至)|均为|为|维持为|维持|：|:)[“\"]?([A-D]{1,3}[+-]?)(?![A-D+-])'
        evidence.extend((match.group(1), match.group(0)) for match in re.finditer(pattern, text)
                        if not previous_rating_context(text, match.start()))
    return evidence


def rating_date_context(pages, evidence):
    if not evidence:
        return 'unknown'
    if evidence.startswith('于'):
        return 'current_report_issuance'
    for page in pages:
        compact = re.sub(r'\s+', '', unicodedata.normalize('NFKC', page))
        start = compact.find(re.sub(r'\s+', '', evidence))
        if start >= 0:
            prefix = compact[:start].split('。')[-1][-250:]
            if re.search(r'本次|此次', prefix) and not previous_rating_context(compact, start):
                return 'current_explicit_label'
    return 'official_unscoped'


def current_summary_date(pages):
    # Only a dated current row in an explicitly labelled results table counts.
    # Do not infer a column from the order or magnitude of two dates.
    found = {}
    for page in pages:
        text = re.sub(r'\s+', '', unicodedata.normalize('NFKC', page))
        text = re.split(r'主要财务数据|评级模型|历史评级|评级历史|附录', text, maxsplit=1)[0]
        if not all(label in text for label in ['评级结果', '评级时间', '上次评级', '本次评级']):
            continue
        for match in re.finditer(r'本次(?:跟踪)?评级(?:(?!上次评级|本次评级|债券简称|债项简称).){0,80}?(20\d{2})[年/.-](\d{1,2})[月/.-](\d{1,2})日?', text):
            try:
                found[date(*(int(part) for part in match.groups())).isoformat()] = match.group(0)
            except ValueError:
                continue
    return next(iter(found.items())) if len(found) == 1 else (None, None)


def official_rating_date(pages):
    # 日期只消费评级正文/通知书的明确日期，不扫描历史评级附录。
    # A scanned notification/cover/declaration can put the current summary on
    # page four or later. Explicit date labels remain scoped away from history.
    current_pages = [re.split(r'评级历史|历史评级|附录', page, maxsplit=1)[0] for page in pages]
    patterns = [
        r'于(20\d{2})[年/.-](\d{1,2})[月/.-](\d{1,2})日(?:出具|发布)(?:了)?[《“"]?[^。]{0,180}?评级报告',
        r'(?:评级日期|评级自期|评级时间|本次评级时间|报告日期)[：:]?.{0,80}?(20\d{2})[年/.-](\d{1,2})[月/.-](\d{1,2})日?',
        r'(?:中诚信国际信用评级有限责任公司|大公国际资信评估有限公司|联合资信评估股份有限公司|中证鹏元资信评估股份有限公司|东方金诚国际信用评估有限公司)[：:]?(20\d{2})年(\d{1,2})月(\d{1,2})日',
        r'([二〇○零一三四五六七八九]{4})年([一二三四五六七八九十\d]{1,3})月([一二三四五六七八九十\d]{1,3})日',
    ]
    for pattern in patterns:
        # A narrative sentence can continue onto the next PDF page; keep its
        # current/previous context rather than dropping the leading "于".
        candidates = ['\n'.join(current_pages)] if pattern == patterns[0] else current_pages
        for page in candidates:
            found = {}
            compact = re.sub(r'\s+', '', page)
            for match in re.finditer(pattern, compact):
                if previous_rating_context(compact, match.start()):
                    continue
                try:
                    found[date(*(chinese_number(part) for part in match.groups())).isoformat()] = match.group(0)
                except (ValueError, KeyError):
                    continue
            if len(found) == 1:
                return next(iter(found.items()))
    return None, None


def parse_rating_pages(pages, bond_name, announcement_date):
    text = normalize_rating_text("\n".join(pages))
    compact = re.sub(r"\s+", "", text)
    summary = re.sub(r'\s+', '', normalize_rating_text('\n'.join(pages[:3])))
    table = None
    if bond_name and bond_name in summary and re.search(r'(?:主体|评级)/展望/债项/评级时间', summary):
        table = re.search(r'本次(?:跟踪|评级)[：:]?([A-D]{1,3}[+-]?)/(稳定|正面|负面|发展中|观察)/([A-D]{1,3}[+-]?)/(20\d{2})年(\d{1,2})月(\d{1,2})日', summary)
    outlook_match = find_current(r'评级展望\s*(?:调整|维持)?为?\s*[：:]?\s*[“"]?(稳定|正面|负面|发展中|观察)', text)
    if not outlook_match:
        outlook_match = find_current(r"给予公司(稳定|正面|负面|发展中|观察)的(?:信用)?评级展望", compact)
    rating_match = find_current(
        r"主体信用等级由[A-D]{1,3}[+-]?(?:调整至|调降至|上调至)[“\"]?([A-D]{1,3}[+-]?)",
        compact,
    )
    if not rating_match:
        rating_match = find_current(r"主体(?:长期)?信用等级\s*(?:为)?\s*[：:]?\s*([A-D]{1,3}[+-]?)", text)
    if not rating_match:
        rating_match = find_current(r"主体信用等级为[“\"]?([A-D]{1,3}[+-]?)", compact)
    if bond_name:
        rating_match = find_current(re.escape(bond_name) + r"[”\"]?(?:的)?(?:债项)?(?:长期)?信用等级(?:由[A-D]{1,3}[+-]?(?:调整至|上调至|调降至)|均为|为|维持为|维持|：|:)?[“\"]?([A-D]{1,3}[+-]?)", compact)
        if not rating_match:
            rating_match = find_current(re.escape(bond_name) + r"[”\"]?(?:的)?(?:债项)?(?:信用)?评级(?:结果)?(?:为|维持为|：|:)?[“\"]?([A-D]{1,3}[+-]?)", compact)
        if not rating_match:
            rating_match = find_current(re.escape(bond_name) + r"[”\"]?[：:|]?([A-D]{1,3}[+-]?)[/／](?:稳定|正面|负面|发展中|观察)", compact)
    rating_date, date_evidence = current_summary_date(pages)
    if rating_date:
        date_context = 'current_summary_table'
    else:
        rating_date, date_evidence = official_rating_date(pages)
        date_context = rating_date_context(pages, date_evidence)
    # Explicit current/previous columns identify the bond row; the issuer row
    # and historical-rating appendices must never provide its grade.
    row_rating = None
    row_rating_value = None
    row_outlook_evidence = None
    if bond_name:
        for page in pages:
            page = normalize_rating_text(page)
            if not re.search(r'评级结果', page) or re.search(r'历史评级|评级历史|附录', page):
                continue
            current_header = re.search(r'本次(?:跟踪)?评级|(?m:^\s*本次\s*$)', page)
            previous_header = re.search(r'上次评级|(?m:^\s*首次\s*$)', page)
            name_pattern = r'\s*'.join(re.escape(ch) for ch in bond_name)
            if re.search(r'本次评级结果', page) and '债券简称' in page and '债券信用等级' in page and not previous_header:
                summary_page = re.split(r'评级观点|评级模型|历史评级信息', page, maxsplit=1)[0]
                named_rows = list(re.finditer(name_pattern + r'[”"]?\s+([A-D]{1,3}[+-]?)(?=\s|$)', summary_page))
                if len({match.group(1) for match in named_rows}) == 1:
                    row_rating = named_rows[0]
                    row_rating_value = row_rating.group(1)
                    break
            if not current_header or not previous_header:
                continue
            # Issuance amount/tenor can precede the two grade columns.
            match = re.search(name_pattern + r'[”"]?(?:\s+[\d,.]+)*\s+([A-D]{1,3}[+-]?)\s+([A-D]{1,3}[+-]?)(?=\s|$)', page)
            # A generic bond row is usable only with a single explicit bond
            # short name on the same page. Never borrow the issuer grade.
            short_names = re.findall(r'债券简称\s*[：:]\s*([^\s，。；]+)', page)
            if not match and short_names == [bond_name]:
                match = re.search(r'债券信用等级\s+([A-D]{1,3}[+-]?)\s+([A-D]{1,3}[+-]?)(?=\s|$)', page)
            if match:
                row_rating = match
                column = 1 if current_header.start()<previous_header.start() else 2
                row_rating_value = match.group(column)
                date_row = re.search(r'评级日期\s*[：:]?\s*(20\d{2}[年/.-]\d{1,2}[月/.-]\d{1,2}日?)\s+(20\d{2}[年/.-]\d{1,2}[月/.-]\d{1,2}日?)', page)
                if date_row:
                    rating_date = date(*(int(part) for part in re.findall(r'\d+', date_row.group(column)))).isoformat()
                    date_evidence = date_row.group(0)
                    date_context = 'current_summary_table'
                outlook_row = re.search(r'评级展望\s+(稳定|正面|负面|发展中|观察)\s+(稳定|正面|负面|发展中|观察)', page)
                if outlook_row:
                    outlook_match = find_current(r'(稳定|正面|负面|发展中|观察)', outlook_row.group(column))
                    row_outlook_evidence = outlook_row.group(0)
                break
    if table:
        rating_date = date(*(int(table.group(i)) for i in [4, 5, 6])).isoformat()
        date_evidence = table.group(0)
        date_context = 'current_summary_table'
    rating_date_source = 'official_document' if rating_date else 'announcement_fallback'
    if rating_date and announcement_date and rating_date > announcement_date:
        raise ValueError('评级原文日期晚于公告日期，保留原事实')
    grade = table.group(3) if table else row_rating_value if row_rating else rating_match.group(1) if rating_match else None
    grade_evidence = table.group(0) if table else row_rating.group(0) if row_rating else rating_match.group(0) if rating_match else None
    conclusions = current_bond_conclusions(pages, bond_name)
    candidates = conclusions + ([(grade, grade_evidence)] if grade else [])
    conflicts = [{'rating': value, 'evidence': quote} for value, quote in candidates] if len({value for value, _ in candidates}) > 1 else []
    return {
        "rating_date": rating_date or announcement_date,
        "rating_date_source": rating_date_source,
        "rating": None if conflicts else grade,
        "rating_outlook": table.group(2) if table else outlook_match.group(1) if outlook_match else None,
        "rating_evidence": grade_evidence,
        "rating_conflicts": conflicts,
        "rating_grade_context_version": "current-grade-v1",
        "outlook_evidence": table.group(0) if table else row_outlook_evidence or (outlook_match.group(0) if outlook_match else None),
        "date_evidence": date_evidence,
        "rating_context_version": "current-narrative-v2",
        "rating_date_context": date_context,
    }


def initial_issue_summary(text):
    summary = re.search(r'发行要素(.{0,1800}?)评级观点[:：]', text)
    return summary.group(1) if summary and '发行主体本期规模发行期限' in summary.group(1) else ''


def initial_issue_amount(text):
    # 本次债券正式条款优先于摘要中的亿元舍入值，仍要求精确金额，不设置容差。
    precise = list(re.finditer(r'本次可转换公司债券(发行规模[：:]?(?:为)?(?:拟发行总额)?(?:人民币)?(?:不超过)?(?:人民币)?[\d,.]+(?:亿元|万元|元))', text))
    if precise:
        amounts = [initial_issue_amount(match.group(1)) for match in precise]
        if amounts[0][0] is not None and len({amount for amount, _ in amounts}) == 1:
            return amounts[0][0], precise[0].group(0)
        return None, None
    match = re.search(r'(?:发行规模|发债规模|发行金额|债券规模|发行额)[：:]?(?:为)?(?:拟发行总额)?(?:人民币)?(?:不超过)?(?:人民币)?([\d,.]+)(亿元|万元|元)', text)
    if not match:
        summary = initial_issue_summary(text)
        matches = list(re.finditer(r'不超过(?:人民币)?([\d,.]+)(亿元|万元|元)', summary))
        if len(matches) == 1:
            match = matches[0]
    if not match:
        return None, None
    token = match.group(1)
    # In a thousand-grouped number OCR can read an interior comma as a dot.
    # Every interior group must have three digits and the fraction two digits.
    if ',' in token or token.count('.') > 1:
        if not re.fullmatch(r'\d{1,3}(?:[,.]\d{3})+(?:\.\d{2})?', token):
            return None, None
        parts = re.split(r'[,.]', token)
        fraction = parts.pop() if len(parts[-1]) == 2 and '.' in token else None
        token = ''.join(parts) + ('.' + fraction if fraction is not None else '')
    value = Decimal(token) * {'亿元': Decimal(100000000), '万元': Decimal(10000), '元': Decimal(1)}[match.group(2)]
    return value, match.group(0)


def parse_rating_result_notice(pages, bond_name, bond_code, issuer_name, announcement_date):
    """A named issuer notice is its own fact source, never a successful report OCR."""
    text = re.sub(r'\s+', '', normalize_rating_text('\n'.join(pages)))
    head = text[:800]
    if not re.search(r'关于[^。]{0,100}评级结果(?:的)?公告', head):
        return None
    codes = re.findall(r'(?:转债|债券)代码[:：]?(\d{6})(?!\d)', head)
    if not bond_code or codes != [bond_code.split('.')[0]] or not issuer_name or issuer_name not in head or not bond_name:
        raise ValueError('评级结果公告未唯一匹配目标发行人及转债代码')
    name_header = re.search(r'(?:转债|债券)简称[:：]?' + re.escape(bond_name), head)
    following = head[name_header.end():] if name_header else ''
    next_code_field = bool(re.match(r'(?:转债|债券)代码[:：]?\d{6}(?!\d)', following))
    if not name_header or (not next_code_field and re.match(r'[A-Za-z0-9]|[\u4e00-\u9fff]*转债', following)):
        raise ValueError('评级结果公告未匹配目标转债简称')
    agencies = list(re.finditer(r'委托(?:(?:信用)?评级机构)?([^，。；;()]{2,60}?(?:股份有限公司|有限责任公司|有限公司))(?:\(以下简称[“"]?([^”"()]+)[”"]?\))?', text))
    agencies = [match for match in agencies if re.search(r'信用(?:评级|评估)|资信(?:评级|评估)', match.group(1))]
    agency = agencies[0].group(1) if len({m.group(1) for m in agencies}) == 1 else None
    agency_names = {agency} | {m.group(2) for m in agencies if m.group(2)}
    grade_pattern = r'[“"]?([A-D]{1,3}[+-]?)(?![A-D+-])'
    current = list(re.finditer(r'本次债项评级[:：]' + grade_pattern, text))
    named = list(re.finditer(re.escape(bond_name) + r'[”"]?(?:的)?(?:信用)?评级结果为[:：]?' + grade_pattern, text))
    named = [m for m in named if not previous_rating_context(text, m.start())]
    conclusions = [(m.group(1), m.group(0)) for m in current + named]
    # 明确点名本债的正式债项结论；主体等级和前次结论不参与本次评级。
    named_debt = list(re.finditer(re.escape(bond_name) + r'[”"]?(?:的)?(?:债项)?信用等级(?:为|至)' + grade_pattern, text))
    named_debt = [m for m in named_debt if not previous_rating_context(text, m.start())]
    conclusions.extend((m.group(1), m.group(0)) for m in named_debt)
    # 官方“本次评级结果”提示段同时包含主体与债项，只取明确目标债名的等级。
    summary = re.search(r'本次评级结果[:：]([^。]+。)', text)
    summary_block = summary.group(1) if summary else ''
    summary_grades = list(re.finditer(re.escape(bond_name) + r'[”"]?(?:的)?(?:信用)?评级(?:结果为)?[:：]?' + grade_pattern, summary_block))
    conclusions.extend((m.group(1), m.group(0)) for m in summary_grades)
    conflicts = [{'rating': value, 'evidence': quote} for value, quote in conclusions] if len({v for v, _ in conclusions}) > 1 else []
    references = []
    for m in re.finditer(r'于(20\d{2})年(\d{1,2})月(\d{1,2})日出具(?:了)?《([^》]+评级报告(?:\(20\d{2}\))?)》(?:\(([^()]*(?:\([^()]*\)[^()]*)*)\))?', text):
        if previous_rating_context(text, m.start()) or issuer_name not in m.group(4):
            continue
        actual = date(*(int(m.group(i)) for i in (1, 2, 3))).isoformat()
        references.append({'title': m.group(4), 'number': m.group(5), 'issued_at': actual, 'evidence': m.group(0)})
    unique = {(r['title'], r['issued_at']): r for r in references}
    reference = next(iter(unique.values())) if len(unique) == 1 else None
    current_block = text.split('本次债项评级', 1)[-1].split('根据', 1)[0] if current else summary_block if summary_grades else ''
    if not current_block and (named or named_debt) and reference:
        # 仅取明确出具本次报告、且同句包含目标债项结论的正式结果段。
        current_block = next((sentence for sentence in text.split('。')
                              if reference['evidence'] in sentence
                              and any(m.group(0) in sentence for m in named + named_debt)), '')
    outlooks = list(re.finditer(r'评级展望(?:为|维持|[:：])?[“"]?(稳定|正面|负面|发展中|观察)', current_block))
    outlook = outlooks[0] if len({m.group(1) for m in outlooks}) == 1 else None
    if reference and announcement_date and reference['issued_at'] > announcement_date:
        raise ValueError('评级原文日期晚于公告日期，保留原事实')
    previous = []
    prior_block = text.split('本次债项评级', 1)[0]
    prior_outlook = re.search(r'前次债项评级[:：]' + grade_pattern + r'.*?评级展望[:：][“"]?(稳定|正面|负面|发展中|观察)', prior_block)
    prior = re.search(r'((?:本公司|公司)前次[^。]+。)', text)
    if prior and prior_outlook and reference:
        quote = prior.group(1)
        grades = list(re.finditer(re.escape(bond_name) + r'前次评级结果为[:：]?' + grade_pattern, quote))
        dates = list(re.finditer(r'评级时间为(20\d{2})年(\d{1,2})月(\d{1,2})日', quote))
        prior_agency = re.search(r'评级机构为([^，,。；;]+)', quote)
        if agency and prior_agency and prior_agency.group(1).strip('“”"') in agency_names and len(grades) == len(dates) == 1 and grades[0].group(1) == prior_outlook.group(1):
            actual = date(*(int(v) for v in dates[0].groups())).isoformat()
            if actual < reference['issued_at']:
                previous.append({'rating': grades[0].group(1), 'rating_outlook': prior_outlook.group(2), 'rating_date': actual,
                                 'rating_com_name': agency,
                                 'rating_date_source': 'official_document', 'rating_date_context': 'explicit_previous_named_bond',
                                 'rating_evidence': quote, 'date_evidence': quote, 'outlook_evidence': prior_outlook.group(0)})
    return {'rating': None if conflicts or not conclusions else conclusions[0][0], 'rating_outlook': outlook.group(1) if outlook else None, 'rating_com_name': agency,
            'rating_date': reference['issued_at'] if reference else None, 'rating_date_source': 'official_document' if reference else 'missing',
            'rating_evidence': conclusions[0][1] if conclusions else None, 'rating_conflicts': conflicts,
            'outlook_evidence': outlook.group(0) if outlook else None, 'date_evidence': reference['evidence'] if reference else None,
            'rating_date_context': 'current_report_issuance', 'rating_context_version': 'current-narrative-v2',
            'rating_grade_context_version': 'current-grade-v1', 'rating_result_notice': {'version': 'named-result-v1', 'bond_code': bond_code,
                'bond_name': bond_name, 'issuer_name': issuer_name, 'rating_company': agency, 'report_reference': reference, 'previous_ratings': previous}}


def initial_report_cover_date(pages, issuer_name):
    issuer = re.sub(r'\s+', '', normalize_rating_text(issuer_name or ''))
    found = {}
    for page in pages[:2]:
        compact = re.sub(r'\s+', '', normalize_rating_text(page))
        if not issuer or issuer not in compact or '跟踪' in compact or not re.search(r'公开发行(?:A股)?可转换公司债券信用评级报告', compact):
            continue
        for line in page.splitlines():
            match = re.fullmatch(r'(20\d{2})年(\d{1,2})月(\d{1,2})日', re.sub(r'\s+', '', normalize_rating_text(line)))
            if not match:
                continue
            try:
                found[date(*(int(v) for v in match.groups())).isoformat()] = match.group(0).strip()
            except ValueError:
                continue
    return next(iter(found.items())) if len(found) == 1 else (None, None)


def extract_rating(url, announcement_date=None, security_code=None, bond_name=None, issuer_name=None, issue_date=None, initial_issue_size_yuan=None, initial_tenor_years=None, list_date=None, bond_code=None):
    publication_end = list_date if list_date and issue_date and list_date >= issue_date else issue_date
    initial_window = bool(initial_issue_size_yuan and initial_tenor_years and issue_date and announcement_date and announcement_date <= publication_end)
    def initial_binding(pages):
        covers = [re.sub(r'\s+', '', unicodedata.normalize('NFKC', page)) for page in pages[:2]]
        issuer = re.sub(r'\s+', '', unicodedata.normalize('NFKC', issuer_name or ''))
        text = re.sub(r'\s+', '', unicodedata.normalize('NFKC', '\n'.join(pages)))
        amount, amount_evidence = initial_issue_amount(text)
        tenor = re.search(r'(?:发行期限|债券期限|存续期限)[：:]?(?:为)?(?:自?发行之日起)?(?:不超过)?([一二三四五六七八九十\d]+)年', text)
        if not tenor:
            tenor = re.search(r'自发行之日起(?:不超过)?([一二三四五六七八九十\d]+)年', initial_issue_summary(text))
        if not tenor:
            issue_summary = initial_issue_summary(text)
            summary_tenors = [match for match in re.finditer(r'(?<![\d.])([一二三四五六七八九十]{1,3}|\d{1,2})年', issue_summary)
                              if issue_summary[max(0,match.start()-2):match.start()] != '最后']
            if len({chinese_number(match.group(1)) for match in summary_tenors}) == 1:
                tenor = summary_tenors[0]
        if not tenor:
            # A debt clause binds the bare "期限" to this issue, not a loan or
            # the issuer's other financial instruments elsewhere in the PDF.
            clause = re.search(r'本次发行的可转换公司债券[^。；]*', text)
            if clause:
                tenor = re.search(r'[，,](?:债券)?期限(?:为|[：:])(?:自?发行之日起)?([一二三四五六七八九十\d]+)年', clause.group(0))
        title = next((match.group(0) for cover in covers for match in re.finditer(r'(?:向不特定对象发行|公开发行)(?:A股)?可转换公司债券(?:信用评级报告|信用等级通知书)', cover) if issuer and issuer in cover and '跟踪评级' not in cover),None)
        return title if initial_window and title and amount is not None and tenor and amount==Decimal(str(initial_issue_size_yuan)) and chinese_number(tenor.group(1))==int(initial_tenor_years) else None
    def parse(pages):
        notice = parse_rating_result_notice(pages, bond_name, bond_code, issuer_name, announcement_date)
        if notice is not None:
            return notice
        result = parse_rating_pages(pages, bond_name, announcement_date)
        if not result['rating'] and not result['rating_conflicts'] and initial_binding(pages):
            normalized = re.sub(r'\s+', '', normalize_rating_text('\n'.join(pages)))
            matches = list(re.finditer(r'(?:(?:债券|债项)信用等级[：:]?|(?:可转换公司债券|债券\(以下简称[“"]本期债券[”"]\)|本期(?:公司)?债券)(?:的)?信用等级(?:为|[：:])?)([A-D]{1,3}[+-]?)(?=[^A-D+-]|$)', normalized))
            # Explicit formal debt conclusions take precedence over a summary
            # table's OCR glyph. Keep all secondary evidence for audit.
            conclusions = list(re.finditer(r'(?:可转换公司债券|债券\(以下简称[“"]本期债券[”"]\)|本期(?:公司)?债券)(?:的)?信用等级为([A-D]{1,3}[+-]?)(?=[^A-D+-]|$)', normalized))
            if conclusions:
                result['secondary_rating_evidence'] = [match.group(0) for match in matches]
                matches = conclusions
            if len({match.group(1) for match in matches}) == 1:
                result['rating'] = matches[0].group(1)
                result['rating_evidence'] = matches[0].group(0)
                result['identity_binding'] = {'method':'issuer_issue_amount_tenor_pending_identity','validated':False,'issuer':issuer_name,'security_code':security_code,'bond_name':bond_name,'issue_date':issue_date,'announcement_date':announcement_date,'issue_size_yuan':str(initial_issue_size_yuan),'tenor_years':initial_tenor_years,'document_title':initial_binding(pages)}
                result['identity_binding']['list_date'] = list_date
                result['identity_binding']['issue_amount_evidence'] = initial_issue_amount(normalized)[1]
        if initial_binding(pages) and result['rating_date_source'] == 'announcement_fallback':
            cover_date, cover_evidence = initial_report_cover_date(pages, issuer_name)
            if cover_date and cover_date <= issue_date and cover_date <= announcement_date:
                result.update(rating_date=cover_date, rating_date_source='official_document', date_evidence=cover_evidence, rating_date_context='initial_report_cover')
        return result
    def complete(pages):
        text = re.sub(r'\s+', '', '\n'.join(pages))
        issuer = re.sub(r'\s+', '', unicodedata.normalize('NFKC', issuer_name or ''))
        text = unicodedata.normalize('NFKC', text)
        identity = (not security_code or security_code.split('.')[0] in text or issuer and issuer in text) and (not bond_name or bond_name in text or initial_binding(pages))
        result = parse(pages)
        return identity and (result['rating_conflicts'] or result['rating'] and result['rating_outlook'] and result['rating_date_source'] == 'official_document')
    try:
        pages, evidence = read_document(url, security_code, None if initial_window else bond_name, issuer_name)
        if initial_window and not initial_binding(pages) and bond_name and bond_name not in re.sub(r'\s+', '', '\n'.join(pages)):
            raise ValueError('PDF 未匹配目标可转债简称')
    except ValueError as error:
        if not any(word in str(error) for word in ['无文本层', '未匹配目标']):
            raise
        pages, evidence = read_document(url, security_code, None if initial_window else bond_name, issuer_name, ocr=True, stop_when=complete)
    result = parse(pages)
    if not result['rating_conflicts'] and (not result['rating'] or not result['rating_outlook']) and (not bond_name or bond_name in re.sub(r'\s+', '', '\n'.join(pages))):
        pages, evidence = read_document(url, security_code, None if initial_window else bond_name, issuer_name, ocr=True, stop_when=complete)
        result = parse(pages)
    return {**evidence, **result, 'source_url': url}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--announcement-date", default=None)
    parser.add_argument("--security-code", default=None)
    parser.add_argument("--bond-name", default=None)
    parser.add_argument("--bond-code", default=None)
    parser.add_argument("--issuer-name", default=None)
    parser.add_argument("--issue-date", default=None)
    parser.add_argument("--list-date", default=None)
    parser.add_argument("--initial-issue-size-yuan", default=None)
    parser.add_argument("--initial-tenor-years", type=int, default=None)
    args = parser.parse_args()
    print(json.dumps(extract_rating(args.url, args.announcement_date, args.security_code, args.bond_name, args.issuer_name, args.issue_date, args.initial_issue_size_yuan, args.initial_tenor_years, args.list_date, args.bond_code), ensure_ascii=False))


if __name__ == "__main__":
    main()
