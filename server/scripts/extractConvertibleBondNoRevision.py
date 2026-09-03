import argparse
import datetime as dt
import json
import re
import urllib.request
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '..', 'ipo-report'))
from external_call_guard import guarded_urlopen

import fitz


DATE_PATTERN = r"(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日"
MONTHS = {"一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}


def iso_date(match):
    return f"{int(match.group(1)):04d}-{int(match.group(2)):02d}-{int(match.group(3)):02d}"


def add_months(value, months):
    year = value.year + (value.month - 1 + months) // 12
    month = (value.month - 1 + months) % 12 + 1
    last_day = (dt.date(year + (month == 12), month % 12 + 1, 1) - dt.timedelta(days=1)).day
    return dt.date(year, month, min(value.day, last_day))


def chinese_number(value):
    if value.isdigit():
        return int(value)
    if value == "十":
        return 10
    if "十" in value:
        left, right = value.split("十", 1)
        return MONTHS.get(left, 1) * 10 + MONTHS.get(right, 0)
    return MONTHS.get(value)


def match_date(match, offset=1):
    return dt.date(int(match.group(offset)), int(match.group(offset + 1)), int(match.group(offset + 2)))


def extract_period(text):
    section_starts = [
        text.rfind("决定本次不向下修正"),
        text.rfind("不向下修正转股价格的具体"),
        text.rfind("关于不向下修正"),
    ]
    section_start = max(section_starts)
    decision_text = text[section_start:] if section_start >= 0 else text
    duration_pattern = r"未来([一二两三四五六七八九十\d]+)(?:个)?(个月|月|年)内?"
    period_matches = list(re.finditer(
        duration_pattern + r"(?:即)?[（(]?" + DATE_PATTERN + r".*?至" + DATE_PATTERN,
        decision_text,
    ))
    period = max(period_matches, key=lambda item: match_date(item, 6), default=None)
    lock_start = match_date(period, 3) if period else None
    lock_end = match_date(period, 6) if period else None
    restart_matches = list(re.finditer(
        r"(?:从|自)" + DATE_PATTERN + r".{0,24}?(?:重新(?:开始)?(?:起算|计算)|开始重新(?:起算|计算)|起重新计算|起计算|起算)",
        decision_text,
    ))
    restart_date = max((match_date(item) for item in restart_matches), default=None)
    # “自某日后首个交易日重新起算”中的日期是锁定期最后一天，
    # 先取自然日次日；入库后由交易日历再校正为真正的首个开市日。
    after_first_trade_matches = list(re.finditer(
        DATE_PATTERN + r"后首个交易日.{0,24}?(?:重新(?:开始)?(?:起算|计算)|开始重新(?:起算|计算)|起重新计算|起计算|起算)",
        decision_text,
    ))
    after_first_trade_date = max(
        (match_date(item) + dt.timedelta(days=1) for item in after_first_trade_matches),
        default=None,
    )
    if after_first_trade_date and (not restart_date or after_first_trade_date > restart_date):
        restart_date = after_first_trade_date
    duration = re.search(duration_pattern, decision_text)
    duration_value = chinese_number(duration.group(1)) if duration else None
    months = duration_value * 12 if duration and duration.group(2) == "年" else duration_value
    decision_matches = list(re.finditer(r"(?:公司)?于" + DATE_PATTERN + r".{0,30}?(?:召开|召开的)", decision_text))
    decision_date = max((match_date(item) for item in decision_matches), default=None)
    document_dates = [match_date(item) for item in re.finditer(r"董事会" + DATE_PATTERN + r"(?:日)?$", text)]
    document_date = max(document_dates, default=None)
    next_day_restart = bool(re.search(r"(?:召开)?次(?:日|一交易日).{0,12}?重新(?:起算|计算)", decision_text))
    # 有些公告把锁定期写成“至某次董事会会议召开之日”，没有可直接落库的日期。
    # 这类公告仍必须标记为锁定，等后续董事会公告给出新的重新起算日。
    symbolic_lock = bool(re.search(
        r"(?:至|到).{0,180}?(?:董事会(?:会议)?之日|董事会.{0,30}?召开之日).{0,220}?"
        r"(?:亦?不提.{0,5}?出|不再.{0,12}?(?:下修|向下修正)|不向下修正)",
        decision_text,
    ))
    # “至公司召开审议《2026年第三季度报告》的董事会会议之日”没有固定日期，
    # 但可以从报告期识别出应开始每日核查真实董事会公告的时间。
    report_reference = re.search(r"(20\d{2})年(?:第?三季度|三季度)报告", decision_text)
    symbolic_reference_type = "quarterly_report_board_meeting" if symbolic_lock and report_reference else None
    symbolic_report_period = f"{report_reference.group(1)}-Q3" if report_reference else None
    symbolic_check_from = f"{report_reference.group(1)}-11-01" if symbolic_reference_type else None
    if not period:
        explicit_ranges = list(re.finditer(r"(?:自|即)?[（(]?" + DATE_PATTERN + r"(?:起)?至" + DATE_PATTERN, decision_text))
        valid_ranges = [item for item in explicit_ranges if not decision_date or match_date(item, 4) >= decision_date]
        explicit_range = max(valid_ranges, key=lambda item: match_date(item, 4), default=None)
        if explicit_range:
            lock_start = match_date(explicit_range)
            lock_end = match_date(explicit_range, 4)
    # “自本公告日至某日”没有显式起始日期，结束日仍是当前锁定期的权威日期。
    bulletin_ends = [match_date(item) for item in re.finditer(r"自本公告日(?:起)?至" + DATE_PATTERN, decision_text)]
    if bulletin_ends:
        lock_start = decision_date
        lock_end = max(bulletin_ends)
    # “至债券到期日（2026年11月4日）”等命名日期同样是明确锁定终点。
    named_ends = [match_date(item) for item in re.finditer(
        r"至[^。；]{0,60}?[（(]" + DATE_PATTERN + r"[）)]",
        decision_text,
    )]
    if named_ends:
        lock_start = decision_date
        lock_end = max(named_ends)
    # 公告常会先回顾上一轮重新起算日，再给出本轮锁定期；旧日期不得覆盖本次决议。
    if decision_date and restart_date and restart_date < decision_date:
        restart_date = None
    if decision_date and lock_end and lock_end < decision_date:
        lock_start = None
        lock_end = None
    if restart_date and not lock_end:
        lock_end = restart_date - dt.timedelta(days=1)
    if not restart_date and not lock_end and months and decision_date:
        restart_date = add_months(decision_date, months)
        lock_end = restart_date - dt.timedelta(days=1)
    if not restart_date and next_day_restart and document_date:
        restart_date = document_date + dt.timedelta(days=1)
        lock_end = restart_date - dt.timedelta(days=1)
    if not lock_start and decision_date:
        lock_start = decision_date
    if lock_end and not restart_date:
        restart_date = lock_end + dt.timedelta(days=1)
    return {
        "lock_start_date": lock_start.isoformat() if lock_start else None,
        "valid_until": lock_end.isoformat() if lock_end else None,
        "next_eligible_date": restart_date.isoformat() if restart_date else None,
        "lock_declared": bool(duration or period or restart_matches or after_first_trade_matches
                               or bulletin_ends or named_ends or explicit_range or next_day_restart or symbolic_lock),
        "symbolic_lock": symbolic_lock,
        "symbolic_reference_type": symbolic_reference_type,
        "symbolic_report_period": symbolic_report_period,
        "symbolic_check_from": symbolic_check_from,
        # 普通权益分派公告也会出现停牌/复牌日期，只有正文明确出现不下修决定
        # 时才允许把解析出的日期作为下修锁定期。
        "no_revision_evidence": bool(re.search(r"(?:不向下修正|不下修|不修正)", decision_text)),
        "parser_version": "7",
    }


def extract_one(url):
    if not (url.startswith("https://static.cninfo.com.cn/")
            or url.startswith("https://www.sse.com.cn/")
            or url.startswith("https://big5.sse.com.cn/")
            or url.startswith("https://disc.static.szse.cn/")):
        raise ValueError("仅允许读取巨潮资讯或交易所官方 PDF")
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with guarded_urlopen(request, timeout=30, source=None, dataset=f"bond-no-revision-pdf:{url}") as response:
        data = response.read(12 * 1024 * 1024 + 1)
    if len(data) > 12 * 1024 * 1024:
        raise ValueError("公告 PDF 超过 12MB")
    document = fitz.open(stream=data, filetype="pdf")
    text = re.sub(r"\s+", "", "\n".join(page.get_text() for page in document))
    period = extract_period(text)
    return {
        "source_url": url,
        **period,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("urls", nargs="+")
    args = parser.parse_args()
    print(json.dumps([extract_one(url) for url in args.urls[:10]], ensure_ascii=False))


if __name__ == "__main__":
    main()
