import argparse
import calendar
import hashlib
import json
import os
import re
import sys
import urllib.request
from datetime import date

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '..', 'ipo-report'))
from external_call_guard import guarded_urlopen


PARSER_VERSION = "call-event-v3"
MAX_PDF_BYTES = 12 * 1024 * 1024
DATE = r"(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?"
PARTIAL_DATE = r"(\d{1,2})\s*月\s*(\d{1,2})\s*日?"
DATE_TOKEN = rf"(?:{DATE}|{PARTIAL_DATE})"
RANGE_SEPARATOR = r"\s*(?:至|到|—|-)\s*"
NO_CALL_PATTERN = r"不提前赎回|不行使(?:提前)?赎回|不实施赎回|暂不赎回"


def compact(text):
    return re.sub(r"\s+", "", str(text or ""))


def valid_iso(year, month, day):
    try:
        return date(int(year), int(month), int(day)).isoformat()
    except (TypeError, ValueError):
        return None


def infer_year(text, fallback=None):
    years = [int(value) for value in re.findall(r"(20\d{2})\s*年", str(text or ""))]
    if years:
        # 只在当前证据片段内取年份，禁止用整份 PDF 的最大年份覆盖跨年日期。
        return years[0]
    if fallback:
        hit = re.search(r"(20\d{2})", str(fallback))
        if hit:
            return int(hit.group(1))
    return None


def parse_date_token(raw, context="", year_hint=None):
    text = compact(raw)
    full = re.search(r"^" + DATE + r"$", text)
    if full:
        return valid_iso(full.group(1), full.group(2), full.group(3))
    partial = re.search(r"^" + PARTIAL_DATE + r"$", text)
    if not partial:
        return None
    year = infer_year(context, year_hint)
    return valid_iso(year, partial.group(1), partial.group(2)) if year else None


def first_date(text, patterns, year_hint=None):
    for pattern in patterns:
        hit = re.search(pattern, text)
        if hit:
            value = parse_date_token(hit.group(1), text[max(0, hit.start() - 120):hit.end() + 120], year_hint)
            if value:
                return value, hit.group(0)
    return None, None


def add_months(value, months):
    if not value:
        return None
    current = date.fromisoformat(value)
    month_index = current.month - 1 + int(months)
    year = current.year + month_index // 12
    month = month_index % 12 + 1
    day = min(current.day, calendar.monthrange(year, month)[1])
    return date(year, month, day).isoformat()


def classify_event(text, title=""):
    value = compact(f"{title}{text}")
    # “现金管理到期赎回”等理财公告不属于可转债事件；只有同时出现明确转债证据时才继续分类。
    if re.search(r"现金管理|理财产品|结构性存款|闲置自有资金|委托理财", value) and not re.search(
        r"可转债|转债|债券代码|最后交易日|最后转股日|赎回登记日|转股价|转股期", value
    ):
        return None
    if "不提前赎回" in value or "不行使赎回" in value or "不实施赎回" in value or "暂不赎回" in value:
        return "waive"
    if re.search(r"实施结果|赎回结果|完成赎回|赎回完成", value):
        return "completion"
    if re.search(r"赎回实施|实施赎回|到期兑付|到期偿付|兑付暨摘牌|到期赎回|停止交易|最后交易日|最后转股日|赎回公告", value):
        return "implementation"
    if re.search(r"可能触发|触发条件|强赎提示", value):
        return "warning"
    if re.search(r"强赎|提前赎回|触发.*赎回|可能触发", value):
        return "exercise"
    return None


def date_near(text, label_patterns, year_hint=None):
    return first_date(text, [rf"{label}(?:为|：|是)?\s*({DATE_TOKEN})" for label in label_patterns], year_hint)


def extract_decision_date(text, event_type, year_hint, fallback=None):
    patterns = [
        rf"(?:公司|本公司|发行人)(?:于|在)?\s*({DATE_TOKEN})\s*(?:召开|审议通过|决定)",
        rf"({DATE_TOKEN})\s*[，,]?\s*(?:公司|本公司|发行人)(?:于|在)?\s*(?:召开|审议通过|决定)",
        rf"(?:公司|本公司|发行人)[^。；;]{{0,100}}?({DATE_TOKEN})[^。；;]{{0,120}}?(?:召开|董事会|审议通过|决定)",
        rf"({DATE_TOKEN})[^。；;]{{0,100}}?(?:公司|本公司|发行人)[^。；;]{{0,120}}?(?:董事会|审议通过|决定)",
        rf"({DATE_TOKEN})[^。；;]{{0,100}}?(?:董事会|董事会会议)[^。；;]{{0,120}}?(?:审议通过|决定)",
    ]
    candidates = []
    for pattern in patterns:
        for hit in re.finditer(pattern, text):
            value = parse_date_token(hit.group(1), text[max(0, hit.start() - 120):hit.end() + 160], year_hint)
            if not value:
                continue
            nearby = text[max(0, hit.start() - 120):min(len(text), hit.end() + 240)]
            score = 0
            if re.search(r"董事会|审议通过", nearby):
                score += 3
            if re.search(r"提前赎回|行使.*赎回", nearby):
                score += 5
            if event_type == "exercise":
                if re.search(r"(?:董事会|公司).*决定行使|行使.*提前赎回", nearby):
                    score += 12
                if re.search(r"不提前赎回|不行使.*赎回", nearby):
                    score -= 15
            elif event_type == "waive":
                if re.search(r"不提前赎回|不行使.*赎回|暂不赎回", nearby):
                    score += 12
            candidates.append((score, value, nearby))
    if not candidates:
        return fallback, None
    candidates.sort(key=lambda item: (-item[0], item[1]))
    _, value, evidence = candidates[0]
    return value, evidence


def extract_no_call(text, decision_date, year_hint):
    evidence = {}
    errors = []
    waive_hits = list(re.finditer(NO_CALL_PATTERN, text))
    if not waive_hits:
        return None, None, None, evidence, errors
    contexts = []
    for phrase in waive_hits:
        context_start = max(0, phrase.start() - 100)
        context_end = min(len(text), phrase.end() + 620)
        contexts.append((phrase.start(), context_start, text[context_start:context_end]))

    for phrase_start, context_start, context in contexts:
        next_hit = re.search(r"(?:自|从)" + DATE_TOKEN + r".{0,50}(?:重新计算|重新起算|首个交易日|第一个交易日)", context)
        next_count_start_date = None
        if next_hit:
            date_hit = re.search(DATE_TOKEN, next_hit.group(0))
            if date_hit:
                next_count_start_date = parse_date_token(date_hit.group(0), context, year_hint)
        if re.search(r"至本次债券到期|到期前|直至到期|至债券到期", context):
            if next_count_start_date:
                evidence["next_count_start_date"] = next_hit.group(0)
            evidence["no_call_until"] = context[:500]
            return None, "through_maturity", next_count_start_date, evidence, errors

    candidates = []
    range_pattern = DATE_TOKEN + RANGE_SEPARATOR + DATE_TOKEN
    for phrase_start, context_start, context in contexts:
        next_count_start_date = None
        next_hit = re.search(r"(?:自|从)" + DATE_TOKEN + r".{0,50}(?:重新计算|重新起算|首个交易日|第一个交易日)", context)
        if next_hit:
            date_hit = re.search(DATE_TOKEN, next_hit.group(0))
            if date_hit:
                next_count_start_date = parse_date_token(date_hit.group(0), context, year_hint)
        for hit in re.finditer(range_pattern, context):
            absolute_start = context_start + hit.start()
            if "至" in hit.group(0):
                left_raw, right_raw = hit.group(0).split("至", 1)
            else:
                split = re.split(r"到|—|-", hit.group(0), maxsplit=1)
                if len(split) != 2:
                    continue
                left_raw, right_raw = split
            left = parse_date_token(left_raw, context, year_hint)
            right = parse_date_token(right_raw, context, year_hint)
            if left and right and re.search(r"^\s*" + PARTIAL_DATE + r"\s*$", right_raw):
                left_value = date.fromisoformat(left)
                right_value = date.fromisoformat(right)
                if right_value <= left_value:
                    right = valid_iso(left_value.year + 1, right_value.month, right_value.day)
            if left and right:
                before = context[max(0, hit.start() - 80):hit.start()]
                after = context[hit.end():min(len(context), hit.end() + 120)]
                nearby = before + after
                score = 0
                if re.search(r"均不行使|期间(?:均)?不(?:提前)?行使|不提前赎回|锁定", nearby):
                    score += 8
                if re.search(r"未来[一二三四五六七八九十\d]+个?月|期限", nearby):
                    score += 4
                if re.search(r"股票.{0,30}(?:已)?满足|触发.{0,30}赎回", nearby):
                    score -= 6
                if absolute_start >= phrase_start:
                    score += 2
                else:
                    score -= 2
                if decision_date:
                    try:
                        score += 3 if date.fromisoformat(right) > date.fromisoformat(decision_date) else -4
                    except ValueError:
                        pass
                candidates.append((score, abs(absolute_start - phrase_start), right, "explicit_range",
                                   context[:500], next_count_start_date, hit.group(0)))
    if candidates:
        candidates.sort(key=lambda item: (-item[0], item[1]))
        _, _, value, basis, context, next_count_start_date, range_text = candidates[0]
        evidence["no_call_until"] = context
        if next_count_start_date:
            evidence["next_count_start_date"] = next_count_start_date
        return value, basis, next_count_start_date, evidence, errors

    explicit_pattern = rf"(?:{NO_CALL_PATTERN}).{{0,240}}?((?:20\d{{2}}\s*年\s*)?\d{{1,2}}\s*月\s*\d{{1,2}}\s*日?)(?:前|止|起)?"
    explicit_candidates = []
    for phrase_start, context_start, context in contexts:
        explicit = re.search(explicit_pattern, context)
        if not explicit:
            continue
        value = parse_date_token(explicit.group(1), context, year_hint)
        if not value:
            continue
        score = 0
        if re.search(r"均不行使|期间(?:均)?不(?:提前)?行使|不提前赎回|锁定", context):
            score += 8
        if re.search(r"股票.{0,30}(?:已)?满足|触发.{0,30}赎回", context):
            score -= 6
        if decision_date:
            try:
                score += 3 if date.fromisoformat(value) > date.fromisoformat(decision_date) else -4
            except ValueError:
                pass
        explicit_candidates.append((score, abs(context_start + explicit.start() - phrase_start), value, context[:500]))
    if explicit_candidates:
        explicit_candidates.sort(key=lambda item: (-item[0], item[1]))
        _, _, value, context = explicit_candidates[0]
        evidence["no_call_until"] = context
        return value, "explicit_range", None, evidence, errors

    number_map = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}
    duration_candidates = []
    for phrase_start, context_start, context in contexts:
        duration = re.search(rf"(?:{NO_CALL_PATTERN}).{{0,180}}?([一二三四五六七八九十\d]+)个?月", context)
        if not duration or not decision_date:
            continue
        count = number_map.get(duration.group(1), duration.group(1))
        try:
            duration_candidates.append((abs(context_start + duration.start() - phrase_start), add_months(decision_date, int(count)), context[:500]))
        except (TypeError, ValueError):
            errors.append("duration_invalid")
    if duration_candidates:
        duration_candidates.sort(key=lambda item: item[0])
        _, value, context = duration_candidates[0]
        evidence["no_call_until"] = context
        return value, "duration_from_decision", None, evidence, errors
    errors.append("no_call_deadline_not_found")
    return None, "unknown", next_count_start_date, evidence, errors


def extract_one(url, cached_text=None, metadata=None):
    metadata = metadata or {}
    content_hash = str(metadata.get("content_hash") or "")
    pages = metadata.get("pages")
    extraction_method = "text_layer"
    if cached_text is None:
        if not (url.startswith("https://static.cninfo.com.cn/")
                or url.startswith("https://www.sse.com.cn/")
                or url.startswith("https://big5.sse.com.cn/")
                or url.startswith("https://disc.static.szse.cn/")):
            raise ValueError("仅允许读取巨潮资讯或交易所官方 PDF")
        request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with guarded_urlopen(request, timeout=30, source=None, dataset=f"bond-call-pdf:{url}") as response:
            data = response.read(MAX_PDF_BYTES + 1)
        if len(data) > MAX_PDF_BYTES:
            raise ValueError("公告 PDF 超过 12MB")
        content_hash = hashlib.sha256(data).hexdigest()
        try:
            import fitz
            document = fitz.open(stream=data, filetype="pdf")
            pages = len(document)
            text_parts = [page.get_text() for page in document]
            extraction_method = "text_layer" if any(text_parts) else "ocr_unavailable"
            cached_text = "\n".join(text_parts)
        except Exception as exc:
            raise ValueError(f"PDF文本提取失败: {exc}") from exc
    text = compact(cached_text)
    text_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
    url_year = re.search(r"/(20\d{2})-\d{2}-\d{2}/", url)
    year_hint = int(url_year.group(1)) if url_year else infer_year(text, metadata.get("announced_at"))
    announced_at = metadata.get("announced_at")
    event_type = metadata.get("event_type") or classify_event(text, metadata.get("title"))
    decision_date, decision_evidence = extract_decision_date(
        text, event_type, year_hint, metadata.get("decision_date") or announced_at
    )
    no_call_until, validity_basis, next_count_start_date, evidence, errors = extract_no_call(text, decision_date, year_hint)
    if decision_evidence:
        evidence["decision_date"] = decision_evidence
    elif event_type in ("waive", "exercise"):
        errors.append("decision_date_not_found")
    if event_type == "waive" and no_call_until and decision_date:
        try:
            if date.fromisoformat(no_call_until) <= date.fromisoformat(decision_date):
                evidence["no_call_until_candidate"] = no_call_until
                no_call_until = None
                validity_basis = "unknown"
                errors.append("no_call_deadline_not_after_decision")
        except ValueError:
            errors.append("no_call_deadline_invalid")
    last_conversion_date, conversion_evidence = date_near(text, ["最后转股日", "停止转股日", "转股截止日"], year_hint)
    last_trade_date, trade_evidence = date_near(text, ["最后交易日", "停止交易日"], year_hint)
    redemption_record_date, record_evidence = date_near(text, ["赎回登记日", "登记日"], year_hint)
    price_hit = re.search(r"赎回价格[^0-9]{0,40}(\d+(?:\.\d+)?)\s*元", text)
    price = float(price_hit.group(1)) if price_hit else None
    if conversion_evidence:
        evidence["last_conversion_date"] = conversion_evidence
    if trade_evidence:
        evidence["last_trade_date"] = trade_evidence
    if record_evidence:
        evidence["redemption_record_date"] = record_evidence
    if len(text) < 40:
        errors.append("extracted_text_too_short")
    if event_type == "waive" and not no_call_until and validity_basis != "through_maturity":
        errors.append("no_call_deadline_not_found")
    complete = (
        event_type == "waive" and (no_call_until or validity_basis == "through_maturity")
    ) or (
        event_type == "exercise" and decision_date
    ) or (
        event_type == "implementation" and last_trade_date and last_conversion_date
    ) or (
        event_type == "completion" and (redemption_record_date or price is not None)
    ) or event_type == "warning"
    parse_status = "complete" if complete and not errors else "partial"
    return {
        "source_url": url,
        "event_type": event_type,
        "decision_date": decision_date,
        "lock_start_date": decision_date if event_type == "waive" else None,
        "no_call_until": no_call_until,
        "validity_basis": validity_basis,
        "next_count_start_date": next_count_start_date,
        "last_conversion_date": last_conversion_date,
        "last_trade_date": last_trade_date,
        "redemption_record_date": redemption_record_date,
        "redemption_price": price,
        "content_hash": content_hash,
        "text_hash": text_hash,
        "extracted_text": text,
        "extraction": {
            "status": "complete" if text else "partial",
            "method": extraction_method,
            "pages": pages,
            "text_length": len(text),
        },
        "evidence": evidence,
        "errors": sorted(set(errors)),
        "parse_status": parse_status,
        "parser_version": PARSER_VERSION,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("urls", nargs="*")
    parser.add_argument("--text-json", default="")
    parser.add_argument("--metadata-json", default="")
    args = parser.parse_args()
    cached_texts = {}
    metadata = {}
    if args.text_json:
        with open(args.text_json, "r", encoding="utf-8") as handle:
            cached_texts = json.load(handle)
    if args.metadata_json:
        with open(args.metadata_json, "r", encoding="utf-8") as handle:
            metadata = json.load(handle)
    urls = list(dict.fromkeys(args.urls or list(cached_texts.keys())))[:50]
    output = []
    for url in urls:
        try:
            output.append(extract_one(url, cached_texts.get(url), metadata.get(url)))
        except Exception as exc:
            output.append({
                "source_url": url,
                "errors": [str(exc)],
                "parse_status": "failed",
                "extraction": {"status": "failed", "error": str(exc)},
                "parser_version": PARSER_VERSION,
            })
    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    main()
