import argparse
import datetime as dt
import json
import re
import urllib.request

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
    section_starts = [
        text.rfind("决定本次不向下修正"),
        text.rfind("不向下修正转股价格的具体"),
        text.rfind("关于不向下修正"),
    ]
    section_start = max(section_starts)
    decision_text = text[section_start:] if section_start >= 0 else text
    duration_pattern = r"未来([一二两三四五六七八九十\d]+)(?:个)?(个月|月|年)内?"
    period = re.search(
        duration_pattern + r"(?:即)?[（(]?" + DATE_PATTERN + r".*?至" + DATE_PATTERN,
        decision_text,
    )
    lock_start = f"{int(period.group(3)):04d}-{int(period.group(4)):02d}-{int(period.group(5)):02d}" if period else None
    lock_end = None
    if period:
        lock_end = f"{int(period.group(6)):04d}-{int(period.group(7)):02d}-{int(period.group(8)):02d}"
    restart = re.search(r"(?:从|自)" + DATE_PATTERN + r".{0,50}?(?:开始重新起算|重新开始起算|重新起算|起计算)", decision_text)
    restart_date = iso_date(restart) if restart else None
    duration = re.search(duration_pattern, decision_text)
    duration_value = chinese_number(duration.group(1)) if duration else None
    months = duration_value * 12 if duration and duration.group(2) == "年" else duration_value
    decision = re.search(r"公司于" + DATE_PATTERN + r".{0,30}?(?:召开|召开的)", text)
    decision_date = dt.date.fromisoformat(iso_date(decision)) if decision else None
    if not period:
        explicit_range = re.search(r"(?:自|即)?[（(]?" + DATE_PATTERN + r"(?:起)?至" + DATE_PATTERN, decision_text)
        if explicit_range:
            lock_start = f"{int(explicit_range.group(1)):04d}-{int(explicit_range.group(2)):02d}-{int(explicit_range.group(3)):02d}"
            lock_end = f"{int(explicit_range.group(4)):04d}-{int(explicit_range.group(5)):02d}-{int(explicit_range.group(6)):02d}"
    if restart_date and not lock_end:
        lock_end = (dt.date.fromisoformat(restart_date) - dt.timedelta(days=1)).isoformat()
    if not restart_date and not lock_end and months and decision_date:
        restart_date = add_months(decision_date, months).isoformat()
        lock_end = (dt.date.fromisoformat(restart_date) - dt.timedelta(days=1)).isoformat()
    if not lock_start and decision_date:
        lock_start = decision_date.isoformat()
    if lock_end and not restart_date:
        restart_date = (dt.date.fromisoformat(lock_end) + dt.timedelta(days=1)).isoformat()
    return {
        "source_url": url,
        "lock_start_date": lock_start,
        "valid_until": lock_end,
        "next_eligible_date": restart_date,
        "lock_declared": bool(duration or period or restart),
        "parser_version": "3",
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("urls", nargs="+")
    args = parser.parse_args()
    print(json.dumps([extract_one(url) for url in args.urls[:10]], ensure_ascii=False))


if __name__ == "__main__":
    main()
