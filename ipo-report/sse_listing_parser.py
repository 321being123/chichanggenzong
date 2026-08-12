"""上交所上市/退市公告解析器。

上交所公告与巨潮公告是两类不同数据源：上交所公告负责确认证券生命周期日期，
巨潮上市公告书负责解析前十名持有人等限售明细。本模块只做上交所页面的抓取结果
解析和来源分类，不把公告中的发行规模误当成流通规模。
"""

import html
import re
from urllib.parse import urljoin


SSE_LISTING_INDEX_URL = "https://www.sse.com.cn/disclosure/announcement/listing/stock/s_list.shtml"
SSE_SOURCE_CODE = "sse_listing_announcements"
SSE_SOURCE_NAME = "上交所上市/退市公告"


def _repair_text(value):
    """兼容少数上游响应被错误按 latin-1 解码的页面。"""
    text = html.unescape(str(value or ""))
    if any(mark in text for mark in ("å", "ç", "æ", "è", "ä")):
        try:
            repaired = text.encode("latin1").decode("utf-8")
            if repaired:
                return repaired
        except (UnicodeEncodeError, UnicodeDecodeError):
            pass
    return text


def _strip_html(value):
    text = re.sub(r"<br\s*/?>", "\n", str(value or ""), flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", _repair_text(text)).strip()


def _date_from_match(match):
    if not match:
        return None
    year, month, day = (int(x) for x in match.groups())
    return f"{year:04d}-{month:02d}-{day:02d}"


def parse_sse_listing_index(page_html, base_url=SSE_LISTING_INDEX_URL):
    """解析上交所上市/退市公告列表，返回轻量公告索引。"""
    records = []
    pattern = re.compile(
        r"<dd\b[^>]*>.*?"
        r"<span\b[^>]*>\s*(\d{4}-\d{1,2}-\d{1,2})\s*</span>.*?"
        r"<a\b[^>]*href=[\"']([^\"']+)[\"'][^>]*title=[\"'](.*?)[\"'][^>]*>.*?</a>"
        r".*?</dd>",
        flags=re.I | re.S,
    )
    for match in pattern.finditer(page_html or ""):
        title = _strip_html(match.group(3))
        if "可转" not in title and "可转换" not in title:
            continue
        records.append({
            "announcement_date": match.group(1),
            "title": title,
            "url": urljoin(base_url, match.group(2)),
            "source_code": SSE_SOURCE_CODE,
            "source_name": SSE_SOURCE_NAME,
            "source_class": "exchange_lifecycle_announcement",
        })
    return records


def parse_sse_listing_detail(page_html, source_url=""):
    """解析单篇上交所可转债上市/退市公告。"""
    raw = page_html or ""
    title_match = re.search(r'<span\b[^>]*id=["\']searchTitle["\'][^>]*>(.*?)</span>', raw, re.I | re.S)
    if not title_match:
        title_match = re.search(r"<h2\b[^>]*>(.*?)</h2>", raw, re.I | re.S)
    title = _strip_html(title_match.group(1) if title_match else "")

    date_match = re.search(r"<div\b[^>]*class=[\"'][^\"']*article_opt[^\"']*[\"'][^>]*>.*?<i\b[^>]*>\s*(\d{4}-\d{1,2}-\d{1,2})\s*</i>", raw, re.I | re.S)
    if not date_match:
        date_match = re.search(r"<i\b[^>]*>\s*(\d{4}-\d{1,2}-\d{1,2})\s*</i>", raw, re.I | re.S)
    announcement_date = date_match.group(1) if date_match else None

    body_match = re.search(r'<div\b[^>]*class=["\'][^"\']*allZoom[^"\']*["\'][^>]*>(.*?)</div>', raw, re.I | re.S)
    body = _strip_html(body_match.group(1) if body_match else raw)

    is_delisting = any(word in title for word in ("终止上市", "摘牌", "退市"))
    event_type = "convertible_bond_delisting" if is_delisting else "convertible_bond_listing"

    code_match = re.search(r"证券代码\s*[为是:：]\s*[“\"']?\s*(\d{6})", body)
    name_match = re.search(r"证券简称\s*[为是:：]\s*[“\"']?\s*([^”\"'< >，。\s]+)", body)
    listing_match = re.search(
        r"(?:将于|于)\s*(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日\s*起?\s*在本所市场上市交易",
        body,
    )
    issue_match = re.search(r"发行的\s*([\d,.]+)\s*亿元", body)
    number_match = re.search(r"上证公告（可转债上市）\s*[【\[]?(\d{4})[】\]]?(\d+)号", body)

    result = {
        "title": title,
        "announcement_date": announcement_date,
        "url": source_url,
        "bond_code": code_match.group(1) if code_match else None,
        "bond_name": name_match.group(1) if name_match else None,
        "listing_date": _date_from_match(listing_match),
        "issue_scale": float(issue_match.group(1).replace(",", "")) if issue_match else None,
        "announcement_number": f"{number_match.group(1)}-{number_match.group(2)}" if number_match else None,
        "event_type": event_type,
        "source_code": SSE_SOURCE_CODE,
        "source_name": SSE_SOURCE_NAME,
        "source_class": "exchange_lifecycle_announcement",
        "is_official": True,
        "body": body,
    }
    return result


__all__ = [
    "SSE_LISTING_INDEX_URL",
    "SSE_SOURCE_CODE",
    "SSE_SOURCE_NAME",
    "parse_sse_listing_index",
    "parse_sse_listing_detail",
]
