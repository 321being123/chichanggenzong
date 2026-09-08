# -*- coding: utf-8 -*-
"""提取港交所港股 IPO 招股书中的申购关键事实。

只接受招股书正文中明确出现的发行价、认购截止时间和最小认购股数；
无法从原文确定的字段保持为空，不用上市报表或配发结果倒推。
默认从 stdin 读取 PDF 二进制，使用 --text 时从 stdin 读取已抽取文本。
"""

import json
import re
import sys
from datetime import datetime


def _number(value):
    if value is None:
        return None
    try:
        number = float(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _shares(value):
    number = _number(value)
    if number is None or int(number) != number:
        return None
    return int(number)


def _normalize(text):
    raw = re.sub(r"[\x00-\x1f\x7f]+", " ", str(text or ""))
    normalized = re.sub(r"\s+", " ", raw).strip()
    return re.sub(r"(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])", "", normalized)


def _snippet(text, start, end):
    return text[max(0, start - 100):min(len(text), end + 180)]


def _clean_sponsor_group(value, max_length=120):
    """只保留招股书中紧跟保荐人标签的可读名称，无法可靠识别时返回空值。"""
    text = re.sub(r"\s+", " ", str(value or "")).strip(" ：:：,，、;；|.-")
    text = re.sub(r"（排名不分先后）|\(排名不分先后\)|排名不分先後|排名不分先后", "", text).strip(" ：:：,，、;；|.-")
    role_tokens = [
        "保薦人", "保荐人", "協調人", "协调人", "賬簿管理人", "账簿管理人", "牽頭經辦人", "牵头经办人",
        "Sponsor", "sponsor", "Coordinator", "coordinator", "Bookrunner", "bookrunner", "Lead Manager", "lead manager",
    ]
    narrative_tokens = [
        "全球發售", "全球发售", "招股章程", "本公司", "構成", "构成", "重大", "遺漏", "遗漏", "撤回", "同意",
        "發生", "发生", "任何事宜", "有關事宜", "有关事宜", "法律程序", "風險", "风险",
    ]
    if not text or len(text) < 3 or len(text) > max_length or "�" in text \
        or any(token in text for token in role_tokens) \
        or any(token in text for token in narrative_tokens):
        return None
    if re.fullmatch(r"(?:and|or|&)", text, flags=re.IGNORECASE) \
        or re.match(r"^(?:and\s+the|for\s+themselves|sponsors?\b|overall\b)", text, flags=re.IGNORECASE):
        return None
    # 不能把后续章节说明或整段乱码当作保荐人名称。
    if not re.search(r"[A-Za-z\u4e00-\u9fff]", text):
        return None
    if text.count("�") > max(1, len(text) // 10):
        return None
    return text


def _parse_sponsor_group(text):
    raw_text = str(text or "")
    # 保荐人栏位通常在招股书前部；先限制扫描范围，避免正文风险章节中的引用污染结果。
    text = raw_text[:12000]
    markers = [
        "聯席保薦人", "聯席保荐人", "獨家保薦人", "獨家保荐人", "保薦人", "保荐人",
        "Joint Sponsors", "Sole Sponsor",
    ]
    end_markers = [
        "聯席整體協調人", "獨家整體協調人", "整體協調人", "聯席全球協調人",
        "聯席賬簿管理人", "聯席账簿管理人", "聯席牽頭經辦人", "聯席牵头经办人",
        "Joint Global Coordinators", "Sole Global Coordinator", "Overall Coordinators",
        "Joint Bookrunners", "Joint Lead Managers", "Hong Kong Exchanges and Clearing",
    ]
    lower = text.lower()
    for marker in markers:
        start = lower.find(marker.lower())
        if start < 0:
            continue
        value_start = start + len(marker)
        end = len(text)
        for end_marker in end_markers:
            position = lower.find(end_marker.lower(), value_start)
            if position >= 0:
                end = min(end, position)
        candidate = _clean_sponsor_group(text[value_start:end][:240])
        if candidate:
            return candidate, _snippet(text, start, min(end, start + 240))

    # 英文招股书在附录的“3. Joint Sponsors”中会明确列出法定保荐人，
    # 其后紧接“4. Consents of Experts”。只取“Each of ... satisfies”前的名称，
    # 不把正文中泛称的 Joint Sponsors 当作保荐人名称。
    section_matches = list(re.finditer(r"\b3\.\s*Joint\s+Sponsors\b", raw_text, flags=re.IGNORECASE))
    for section_match in reversed(section_matches):
        value_start = section_match.end()
        end_match = re.search(r"\b4\.\s*Consents\s+of\s+Experts\b", raw_text[value_start:], flags=re.IGNORECASE)
        if not end_match:
            continue
        end = value_start + end_match.start()
        section = raw_text[value_start:end]
        if not re.search(r"\beach\s+of\b", section, flags=re.IGNORECASE):
            continue
        name_part = re.split(r"\b(?:satisfies|satisfy|meets?|fulfills?)\b", section, maxsplit=1, flags=re.IGNORECASE)[0]
        name_part = re.sub(r"^\s*Each\s+of\s+", "", name_part, flags=re.IGNORECASE)
        candidate = _clean_sponsor_group(name_part, max_length=300)
        if candidate:
            return candidate, _snippet(raw_text, section_match.start(), min(end, section_match.start() + 900))

    # 另一些英文招股书只在正文的“PARTIES INVOLVED IN THE GLOBAL OFFERING”表格列出
    # 联席保荐人。表格标题有固定换行，按地址首行切出公司名，直到下一栏协调人。
    table_matches = list(re.finditer(
        r"PARTIES\s+INVOLVED(?:\s+IN\s+THE\s+GLOBAL\s+OFFERING)?[\t \r\n]+"
        r"(?:Joint\s+Sponsor(?:s|\s+s)(?:\s+and\s+(?:Capital\s+Market\s+Intermediaries|Overall\s+Coordinators?|"
        r"Sponsor\s*[- ]\s*Overall\s+Coordinators?|Sponsor-OCs?))?|"
        r"Sole\s+Sponsor(?:,\s*Sole\s+Representative)?(?:\s+and\s+(?:Sole\s+)?Sponsor\s*[- ]\s*Overall\s+Coordinator|"
        r"(?:\s*,?\s*Sole\s+(?:Overall|Global)\s+Coordinator){0,2}"
        r"(?:\s*,?\s*Joint\s+Bookrunners?(?:\s+and\s+Joint\s+Lead\s+Managers?)?)?))"
        r"[\t \r\n]+",
        raw_text, flags=re.IGNORECASE,
    ))
    # 部分招股书在董事名单后才出现“Joint Sponsors/Sole Sponsor”表格，
    # 中间夹有页眉或目录字段，不再与 PARTIES INVOLVED 标题相邻；
    # 只按行首角色标题补充候选，后续仍须经过公司名和地址边界校验。
    for role_match in re.finditer(
        r"^[ \t]*(?:Joint\s+Sponsor(?:s|\s+s)|Sole\s+Sponsor|Sponsor(?:\s*[- ]\s*Overall\s+Coordinator)?)\b[^\r\n]*"
        r"(?:[\r\n]+[ \t]*(?:Sponsor|Sole|Overall|Joint|Bookrunners?|Lead|Capital|Coordinators?|Managers?|Representatives?|Global|Intermediar(?:y|ies)|and)\b[^\r\n]*){0,8}[\r\n]+",
        raw_text, flags=re.IGNORECASE | re.MULTILINE,
    ):
        heading_context = raw_text[max(0, role_match.start() - 1200):role_match.start()]
        # 目录/释义正文也会出现同名词，必须有正式的全大写参与方章节页眉作锚点。
        if re.search(r"PARTIES\s+INVOLVED(?:\s+IN\s+THE\s+GLOBAL\s+OFFERING)?", heading_context):
            table_matches.append(role_match)
    for table_match in reversed(table_matches):
        value_start = table_match.end()
        end_match = re.search(
            r"(?:\bSponsor-OCs?\b|\bSponsor\s*[- ]\s*Overall\s+Coordinator(?:s)?\b|"
            r"\bOverall\s+Coordinators?\b|\b(?:Joint\s+)?Bookrunners?\b|\b(?:Joint\s+)?Lead\s+Managers?\b|"
            r"\bLegal\s+Advis(?:ers?|ors?)\b|\bDIRECTORS(?:,\s+SUPERVISORS)?\s+AND\s+PARTIES\s+INVOLVED\b)",
            raw_text[value_start:], flags=re.IGNORECASE,
        )
        if not end_match:
            continue
        end = value_start + end_match.start()
        lines = [re.sub(r"\s+", " ", line).strip() for line in raw_text[value_start:end].splitlines()]
        names = []
        current = []
        address_start = re.compile(r"^(?:\d|No\.?\s|Room\s|Unit(?:s)?\s|Suite(?:s)?\s|Block\s|Building\s|Level\s|Floor\s)", flags=re.IGNORECASE)
        address_continuation = re.compile(
            r"^(?:Hong\s+Kong(?:\s+SAR)?|Kowloon|Central(?:,\s*Hong\s+Kong)?|Road|Street|Centre|Tower|House|PRC|China)(?:,)?$",
            flags=re.IGNORECASE,
        )
        name_suffix = re.compile(r"(?:Limited|L\.L\.C\.|Corporation|Company|Bank|Capital|Securities|International|Holdings|Partners|Co\.|Inc\.|PLC|Group|Advisers?|Advisors?)$", flags=re.IGNORECASE)
        index = 0
        while index < len(lines):
            line = lines[index]
            if not line or re.fullmatch(r"\(?in alphabetical order\)?", line, flags=re.IGNORECASE):
                index += 1
                continue
            if current and re.match(r"^\((?:an?|the)\s+licensed\s+corporation\b", line, flags=re.IGNORECASE):
                # 招股书常在公司名后另起一行说明牌照，不能把说明文字并入保荐人名称。
                index += 1
                continue
            if address_start.search(line):
                if current:
                    names.append(" ".join(current))
                    current = []
                index += 1
                continue
            if name_suffix.search(line):
                current.append(line)
            elif not current and not address_continuation.search(line) \
                and index + 1 < len(lines) and name_suffix.search(lines[index + 1]):
                # 公司名在 PDF 文本中经常断成“……Hong Kong / Securities Limited”两行。
                current.extend([line, lines[index + 1]])
                index += 1
            elif current and len(line) <= 80 and not re.search(
                r"(?:Hong Kong|Kowloon|Central|Road|Street|Centre|Tower|House)$", line, flags=re.IGNORECASE
            ):
                current.append(line)
            index += 1
        if current:
            names.append(" ".join(current))
        candidate = _clean_sponsor_group("; ".join(names), max_length=500)
        if candidate and names and re.search(
            r"\b(?:Limited|Corporation|Securities|Capital|Holdings|Bank|Partners|Company|Inc\.|PLC|Group)\b",
            candidate, flags=re.IGNORECASE,
        ):
            return candidate, _snippet(raw_text, table_match.start(), min(end, table_match.start() + 1200))

    return None, None


def _chinese_integer(raw):
    if raw is None:
        return 0
    if str(raw).isdigit():
        return int(raw)
    digits = {"零": 0, "〇": 0, "一": 1, "二": 2, "兩": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
    total = 0
    current = 0
    for char in str(raw):
        if char in digits:
            current = current * 10 + digits[char]
        elif char == "十":
            total += (current or 1) * 10
            current = 0
        elif char == "百":
            total += (current or 1) * 100
            current = 0
    return total + current


def _parse_chinese_time(value):
    text = str(value or "")
    meridiem = ""
    if "下午" in text:
        meridiem = "pm"
    elif "上午" in text:
        meridiem = "am"
    elif "中午" in text:
        meridiem = "noon"
    match = re.search(r"([零〇一二三四五六七八九十百兩\d]+)時(?:(零〇一二三四五六七八九十\d+)分)?", text)
    if not match:
        match = re.search(r"(\d{1,2}):(\d{2})", text)
    if not match:
        return None
    hour = _chinese_integer(match.group(1))
    minute = _chinese_integer(match.group(2)) if match.group(2) else 0
    if meridiem == "pm" and hour < 12:
        hour += 12
    if meridiem == "noon" and hour < 12:
        hour += 12
    if hour > 23 or minute > 59:
        return None
    return hour, minute


def _parse_date_time(text, start, end):
    window = text[start:end]
    chinese = re.search(r"([零〇一二三四五六七八九十百兩\d]{4,})\s*年\s*"
                       r"([零〇一二三四五六七八九十百兩\d]{1,3})\s*月\s*"
                       r"([零〇一二三四五六七八九十百兩\d]{1,3})\s*日", window)
    if chinese:
        year, month, day = (_chinese_integer(value) for value in chinese.groups())
        date_text = f"{year:04d}-{month:02d}-{day:02d}"
    else:
        # 部分港交所时间表把年份单独放在表头（如“2025年（附注1）”，
        # 下面只写“9月19日”）。在同一证据窗口内取最近的年份，不跨窗口推断。
        short_chinese = re.search(
            r"([零〇一二三四五六七八九十百兩\d]{1,3})\s*月\s*"
            r"([零〇一二三四五六七八九十百兩\d]{1,3})\s*日",
            window,
        )
        if short_chinese:
            year_matches = list(re.finditer(r"((?:19|20)\d{2})年", window[:short_chinese.start()]))
            if not year_matches:
                # 表头年份与项目行之间可能隔着较长的点线/说明文字；仍只在
                # 当前标记前的有限窗口内取最近年份，避免跨整份招股书倒推。
                context_before = text[max(0, start - 1000):start]
                year_matches = list(re.finditer(r"((?:19|20)\d{2})年", context_before))
            if not year_matches:
                year_matches = list(re.finditer(r"((?:19|20)\d{2})年", window))
            if year_matches:
                year = int(year_matches[-1].group(1))
                month = _chinese_integer(short_chinese.group(1))
                day = _chinese_integer(short_chinese.group(2))
                date_text = f"{year:04d}-{month:02d}-{day:02d}"
            else:
                date_text = None
        else:
            date_text = None
        if date_text is not None:
            pass
        else:
            english = re.search(
                r"(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+"
                r"(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})",
                window,
                flags=re.IGNORECASE,
            )
            if not english:
                english = re.search(r"(\d{4})[-/]([01]?\d)[-/]([0-3]?\d)", window)
                if not english:
                    return None
                year, month, day = map(int, english.groups())
            else:
                day = int(english.group(1))
                month = datetime.strptime(english.group(2)[:3], "%b").month
                year = int(english.group(3))
            date_text = f"{year:04d}-{month:02d}-{day:02d}"
    try:
        datetime.strptime(date_text, "%Y-%m-%d")
    except ValueError:
        return None
    clock = _parse_chinese_time(window)
    if clock is None:
        time_match = re.search(r"(\d{1,2}):(\d{2})\s*(a\.m\.|p\.m\.|am|pm)?", window, flags=re.IGNORECASE)
        if time_match:
            hour, minute = int(time_match.group(1)), int(time_match.group(2))
            suffix = (time_match.group(3) or "").lower()
            if suffix.startswith("p") and hour < 12:
                hour += 12
            if suffix.startswith("a") and hour == 12:
                hour = 0
            clock = (hour, minute)
    if clock is None:
        return None
    hour, minute = clock
    return f"{date_text}T{hour:02d}:{minute:02d}:00+08:00"


def parse_prospectus_text(text):
    normalized = _normalize(text)
    result = {
        "parserStatus": "incomplete",
        "parserVersion": "hk-ipo-prospectus-v2",
        "securityCode": None,
        "issuePriceLow": None,
        "issuePriceHigh": None,
        "lotSizeShares": None,
        "offerOpenAt": None,
        "offerCloseAt": None,
        "sponsorGroup": None,
        "evidence": {},
        "warnings": [],
    }

    sponsor_group, sponsor_evidence = _parse_sponsor_group(text)
    if sponsor_group:
        result["sponsorGroup"] = sponsor_group
        result["evidence"]["sponsorGroup"] = sponsor_evidence

    code = re.search(r"(?:股份代號|Stock\s*Code)\s*[:：]?\s*(\d{1,5})", normalized, flags=re.IGNORECASE)
    if code:
        result["securityCode"] = f"{int(code.group(1)):05d}.HK"

    price_match = re.search(
        r"(?:發售價|Offer\s+Price)[^0-9]{0,100}"
        r"([0-9]+(?:\.[0-9]+)?)\s*(?:港元|HK\$|HKD)?"
        r"(?:\s*(?:至|到|[-–—]|to)\s*([0-9]+(?:\.[0-9]+)?))?",
        normalized,
        flags=re.IGNORECASE,
    )
    if price_match:
        low = _number(price_match.group(1))
        high = _number(price_match.group(2)) or low
        if low is not None and high is not None and high >= low:
            result["issuePriceLow"] = low
            result["issuePriceHigh"] = high
            result["evidence"]["issuePrice"] = _snippet(normalized, price_match.start(), price_match.end())

    lot_patterns = [
        r"(?:每手(?:買賣單位|股份|股數)?|每手為|board\s+lot(?:\s+size)?(?:\s+of)?)\s*[:：]?\s*([\d,]+)\s*(?:股|shares?)",
        r"(?:申請認購|申請最少|minimum(?:\s+application)?(?:\s+of)?)\s*(?:最少|至少|minimum)?\s*([\d,]+)\s*(?:股|shares?)",
        r"(?:minimum\s+of\s+)([\d,]+)\s+(?:Hong\s+Kong\s+Offer\s+Shares|offer\s+shares)",
    ]
    for pattern in lot_patterns:
        match = re.search(pattern, normalized, flags=re.IGNORECASE)
        if not match:
            continue
        shares = _shares(match.group(1))
        if shares:
            result["lotSizeShares"] = shares
            result["evidence"]["lotSizeShares"] = _snippet(normalized, match.start(), match.end())
            break

    # 招股书的时间表标题存在多种官方写法：有的把“优先发售”并列写出，
    # 有的把“开始”放在“申请期”之后。只扩展官方同义表述，不根据上市日倒推。
    open_markers = [
        "香港公開發售及優先發售開始",
        "香港公開發售開始",
        "開始香港公開發售",
        "開始進行香港公開發售",
        "香港公開發售期間將於",
        "香港公開發售的申請期將於",
        "香港公開發售申請期將於",
        "Hong Kong Public Offering and Preferential Offering commences",
        "Hong Kong Public Offering commences",
        "Hong Kong Public Offering will commence",
        "Hong Kong Public Offering period will commence",
        "commencement of the Hong Kong Public Offering",
    ]
    close_markers = [
        "截止辦理香港公開發售及優先發售申請登記",
        "截止辦理香港公開發售申請登記",
        "截止辦理申請登記",
        "香港公開發售及優先發售截止",
        "香港公開發售截止",
        "Hong Kong Public Offering and Preferential Offering closes",
        "Hong Kong Public Offering closes",
        "Latest time for lodging applications",
        "Latest time for applications",
    ]
    for marker in open_markers:
        pos = normalized.lower().find(marker.lower())
        if pos >= 0:
            parsed = _parse_date_time(normalized, pos, min(len(normalized), pos + 360))
            if parsed:
                result["offerOpenAt"] = parsed
                result["evidence"]["offerOpenAt"] = _snippet(normalized, pos, pos + 360)
                break
    for marker in close_markers:
        pos = normalized.lower().find(marker.lower())
        if pos >= 0:
            parsed = _parse_date_time(normalized, pos, min(len(normalized), pos + 420))
            if parsed:
                result["offerCloseAt"] = parsed
                result["evidence"]["offerCloseAt"] = _snippet(normalized, pos, pos + 420)
                break

    required = (
        result["issuePriceLow"], result["issuePriceHigh"], result["lotSizeShares"],
        result["offerOpenAt"], result["offerCloseAt"],
    )
    result["parserStatus"] = "parsed" if all(value is not None for value in required) else "partial"
    return result


def extract_pdf(data):
    try:
        import fitz
    except Exception as exc:  # pragma: no cover
        return {"parserStatus": "failed", "error": f"PyMuPDF unavailable: {exc}"}
    try:
        document = fitz.open(stream=data, filetype="pdf")
        text = "\n".join(page.get_text() for page in document)
        result = parse_prospectus_text(text)
        result["pageCount"] = len(document)
        return result
    except Exception as exc:  # pragma: no cover
        return {"parserStatus": "failed", "error": str(exc)}


def main():
    data = sys.stdin.buffer.read()
    if "--text" in sys.argv:
        result = parse_prospectus_text(data.decode("utf-8", errors="replace"))
    else:
        result = extract_pdf(data)
    print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
