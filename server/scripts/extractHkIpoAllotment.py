# -*- coding: utf-8 -*-
"""解析港交所港股 IPO 配发结果英文 PDF 的初始发售结构。

只使用 PDF 中明确列出的初始公开发售和初始国际发售股数，不用固定比例或
配发结果后的回拨比例替代申购期事实。脚本从 stdin 读取 PDF 二进制，输出一行 JSON。
使用 --text 时从 stdin 读取已抽取文本，便于单元测试。
"""

import json
import re
import sys


def _number(value):
    if value is None:
        return None
    text = str(value).replace(",", "").strip()
    try:
        number = float(text)
    except (TypeError, ValueError):
        return None
    if not number.is_integer():
        return None
    number = int(number)
    return number if number > 0 else None


def _non_negative_number(value):
    """读取允许为 0 的公告数量（例如“超配 0 股”）。"""
    if value is None:
        return None
    text = str(value).replace(",", "").strip()
    try:
        number = float(text)
    except (TypeError, ValueError):
        return None
    if not number.is_integer() or number < 0:
        return None
    return int(number)


def _find_number(text, pattern):
    match = re.search(pattern + r"\s+([\d,]+)", text, flags=re.IGNORECASE)
    return _number(match.group(1)) if match else None


def _find_final_public_offer_number(text):
    """读取配发公告回拨后的最终香港公开发售股数。"""
    normalized = re.sub(r"\s+", " ", str(text or "")).strip()
    patterns = [
        r"Final\s+(?:no\.?|number)\s+of\s+Offer\s+Shares\s+(?:in|under)\s+(?:the\s+)?(?:Hong\s+Kong\s+)?Public\s+Offer(?:ing)?(?:\s*\([^)]*\))?\s*([\d,]+)",
        r"final\s+number\s+of\s+Offer\s+Shares\s+under\s+(?:the\s+)?(?:Hong\s+Kong\s+)?Public\s+Offer(?:ing)?\s+is\s+adjusted\s+to\s+([\d,]+)",
        r"(?:香港公開發售|香港公开发售)[^。；;]{0,100}?(?:發售股份|发售股份)(?:的)?(?:最終數目|最终数目)(?:調整為|调整为)\s*([\d,]+)",
    ]
    for pattern in patterns:
        match = re.search(pattern, normalized, flags=re.IGNORECASE)
        if match:
            value = _number(match.group(1))
            if value is not None:
                return value, normalized[max(0, match.start() - 40):min(len(normalized), match.end() + 100)]
    return None, None


def _line_number(value):
    text = str(value or "").replace(",", "").strip()
    if not re.fullmatch(r"\d+", text):
        return None
    return _number(text)


def _percent(text, patterns):
    for pattern in patterns:
        match = re.search(pattern + r"\s*([0-9]+(?:\.[0-9]+)?)\s*%", text, flags=re.IGNORECASE)
        if match:
            return float(match.group(1))
    return None


def _parse_public_oversubscription(text):
    """只读取配发公告明确披露的香港公开发售超额认购倍数。"""
    normalized = re.sub(r"\s+", " ", str(text or "")).strip()
    patterns = [
        r"(?:Hong\s+Kong\s+)?Public\s+Offer(?:ing)?[^.]{0,180}?(?:has\s+been|was|is)\s+over[- ]?subscribed\s+(?:by\s+)?(?:approximately\s+)?([0-9]+(?:\.[0-9]+)?)\s+times(?:\s+or\s+more)?",
        r"(?:Hong\s+Kong\s+)?Public\s+Offer(?:ing)?[^.]{0,180}?over[- ]?subscribed\s+(?:by\s+)?(?:approximately\s+)?([0-9]+(?:\.[0-9]+)?)\s+times(?:\s+or\s+more)?",
        r"(?:香港公開發售|香港公开发售)[^。；;]{0,100}?超額認購(?:約)?([0-9]+(?:\.[0-9]+)?)倍",
        r"(?:香港公開發售|香港公开发售)[^。；;]{0,100}?超額认购(?:约)?([0-9]+(?:\.[0-9]+)?)倍",
    ]
    matches = []
    # “Subscription level”通常位于 PUBLIC OFFER 小节；必须确认在它之前
    # 最近的章节标题不是 INTERNATIONAL OFFER，避免把国际配售倍数错当公开发售倍数。
    subscription_pattern = r"SUBSCRIPTION\s+LEVEL(?:\s*\([^)]*\))?\s*([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?)\s+TIMES"
    for match in re.finditer(subscription_pattern, normalized, flags=re.IGNORECASE):
        context = normalized[max(0, match.start() - 700):match.start()]
        public_matches = list(re.finditer(r"(?:HONG\s+KONG\s+)?PUBLIC\s+OFFER(?:ING)?", context, flags=re.IGNORECASE))
        if not public_matches:
            continue
        after_public = context[public_matches[-1].end():]
        if re.search(r"INTERNATIONAL\s+OFFER(?:ING)?|PLACING", after_public, flags=re.IGNORECASE):
            continue
        matches.append(match)
    for pattern in patterns:
        match = re.search(pattern, normalized, flags=re.IGNORECASE)
        if match:
            matches.append(match)
    for match in matches:
        value = float(match.group(1).replace(",", ""))
        if value <= 0:
            continue
        evidence = normalized[max(0, match.start() - 40):min(len(normalized), match.end() + 80)]
        return {
            "value": value,
            "qualifier": "or_more" if re.search(r"or\s+more", match.group(0), flags=re.IGNORECASE) else None,
            "evidence": evidence[:500],
        }
    return None


def _parse_greenshoe(text):
    """解析官方配发公告中的超额配售（绿鞋）事实，不把假设性表格当成已行使。"""
    normalized = re.sub(r"\s+", " ", str(text or "")).strip()
    option_pattern = r"Over[- ]allotment\s+Option"
    mechanism_mentioned = bool(re.search(option_pattern, normalized, flags=re.IGNORECASE))
    no_stabilization = re.search(
        r"(?:no\s+stabili[sz](?:ing|ation)\s+(?:manager|activities)|no\s+stabilization\s+activities|not\s+appoint(?:ed)?\s+(?:a\s+)?stabili[sz]ing\s+manager)",
        normalized,
        flags=re.IGNORECASE,
    )
    over_allocated = None
    allocation_match = re.search(
        r"(?:No\.?|Number)\s+of\s+(?:Offer\s+)?Shares\s+over[- ]allocated\s*[:：]?\s*([\d,]+)",
        normalized,
        flags=re.IGNORECASE,
    )
    if allocation_match:
        over_allocated = _non_negative_number(allocation_match.group(1))
    option_shares = None
    option_match = re.search(
        option_pattern + r".{0,220}?(?:up\s+to|aggregate\s+of|comprising)\s+([\d,]+)\s+(?:Offer\s+)?(?:H\s+)?Shares",
        normalized,
        flags=re.IGNORECASE,
    )
    if option_match:
        option_shares = _non_negative_number(option_match.group(1))

    status = "not_disclosed"
    exercised = None
    status_evidence = None
    # “assuming ... not exercised”是资本结构假设，不是实际状态，必须排除。
    for match in re.finditer(option_pattern, normalized, flags=re.IGNORECASE):
        snippet = normalized[max(0, match.start() - 100):min(len(normalized), match.end() + 220)]
        if re.search(r"assuming", snippet, flags=re.IGNORECASE):
            continue
        if re.search(r"(?:no\s+exercise\s+of|not\s+exercised|will\s+not\s+be\s+exercised|was\s+not\s+exercised|has\s+not\s+been\s+exercised)", snippet, flags=re.IGNORECASE):
            status = "not_exercised"
            exercised = False
            status_evidence = snippet[:500]
            break
        if re.search(r"(?:was|has\s+been|will\s+be)\s+exercised(?:\s+in\s+full)?", snippet, flags=re.IGNORECASE):
            status = "exercised"
            exercised = True
            status_evidence = snippet[:500]
            break
    if status == "not_disclosed" and over_allocated is not None:
        status = "no_over_allocation" if over_allocated == 0 else "over_allocated"
    if not mechanism_mentioned and over_allocated is None and no_stabilization:
        evidence = normalized[max(0, no_stabilization.start() - 80):min(len(normalized), no_stabilization.end() + 180)]
        return {
            "mechanismMentioned": False,
            "status": "not_available",
            "exercised": False,
            "overAllocatedShares": None,
            "optionShares": None,
            "parserStatus": "parsed",
            "evidence": evidence[:1000],
        }
    if not mechanism_mentioned and over_allocated is None:
        # 公告正文没有出现绿鞋/稳定价格机制关键词，保留可审计的“未披露”状态，
        # 但 parserStatus 仍标记 missing，避免把未披露冒充成“无机制”。
        return {
            "mechanismMentioned": False,
            "status": "not_disclosed",
            "exercised": None,
            "overAllocatedShares": None,
            "optionShares": None,
            "parserStatus": "missing",
            "evidence": "",
        }
    evidence = []
    if allocation_match:
        evidence.append(normalized[max(0, allocation_match.start() - 40):min(len(normalized), allocation_match.end() + 180)])
    if status_evidence:
        evidence.append(status_evidence)
    return {
        "mechanismMentioned": mechanism_mentioned,
        "status": status,
        "exercised": exercised,
        "overAllocatedShares": over_allocated,
        "optionShares": option_shares,
        "parserStatus": "parsed",
        "evidence": " ".join(evidence)[:1000],
    }


def _first_pool_a_lottery(text, lot_size_shares=None):
    """读取官方 Pool A 第一档的实际一手配发比例。

    配发公告的表格文本通常按“申请股数、有效申请数、配发基准、百分比”
    顺序导出。第一档对应一手申请；如果招股书已经给出每手股数，则优先
    选择与该股数相同的行，避免表格前置说明或分页页码误识别。
    """
    raw = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+", " ", str(text or ""))
    lines = [re.sub(r"\s+", " ", line).strip() for line in raw.splitlines()]
    lines = [line for line in lines if line]
    pool_index = next((index for index, line in enumerate(lines)
                       if re.fullmatch(r"POOL\s+A", line, flags=re.IGNORECASE)), None)
    if pool_index is None:
        return None
    target = _number(lot_size_shares)
    for index in range(pool_index + 1, len(lines) - 2):
        applied = _line_number(lines[index])
        valid = _line_number(lines[index + 1])
        if applied is None or valid is None or applied <= 0 or valid <= 0:
            continue
        basis_lines = []
        percentage = None
        cursor = index + 2
        while cursor < len(lines):
            line = lines[cursor]
            percent_match = re.search(r"(\d+(?:\.\d+)?)\s*%", line)
            if percent_match:
                percentage = float(percent_match.group(1))
                basis_lines.append(line)
                break
            # 下一组数字行意味着当前行不是一个完整的分配表记录。
            if cursor > index + 2 and _line_number(line) is not None \
                    and cursor + 1 < len(lines) and _line_number(lines[cursor + 1]) is not None:
                break
            basis_lines.append(line)
            cursor += 1
        if percentage is None or not 0 < percentage <= 100:
            continue
        if target is not None and applied != target:
            continue
        basis = " ".join(basis_lines)
        success = None
        success_match = re.search(
            r"([\d,]+)\s+out\s+of\s+([\d,]+)\s+to\s+receive",
            basis,
            flags=re.IGNORECASE,
        )
        if success_match:
            success = _line_number(success_match.group(1))
        return {
            "oneLotAppliedShares": int(applied),
            "oneLotValidApplications": int(valid),
            "oneLotSuccessfulApplications": int(success) if success is not None else None,
            "oneLotSuccessRate": percentage,
            "evidence": basis[:1000],
        }
    return None


def _first_allocation_table_lottery(text, lot_size_shares=None):
    """读取没有显式 ``POOL A`` 标题的官方首档分配表。

    部分配发公告直接从“BASIS OF ALLOCATION UNDER THE HONG KONG PUBLIC
    OFFERING”开始，首档行依次列出申请股数、有效申请数、配发基准和官方
    “APPROXIMATE PERCENTAGE ALLOTTED”。该百分比是公告原文事实；没有
    明确的成功申请数时不自行反推，只保存首档百分比和有效申请数。
    """
    raw = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+", " ", str(text or ""))
    lines = [re.sub(r"\s+", " ", line).strip() for line in raw.splitlines()]
    lines = [line for line in lines if line]
    heading_index = next((index for index, line in enumerate(lines)
                          if re.search(r"BASIS OF ALLOCATION UNDER THE HONG KONG PUBLIC OFFER(?:ING)?", line, re.IGNORECASE)), None)
    if heading_index is None:
        return None
    target = _number(lot_size_shares)
    if target is None:
        return None
    for index in range(heading_index + 1, min(len(lines), heading_index + 500)):
        if _line_number(lines[index]) != target:
            continue
        next_line = lines[index + 1] if index + 1 < len(lines) else ""
        valid = _line_number(next_line)
        inline_row = False
        if valid is None:
            inline_valid = re.match(r"^([\d,]+)(?:\s+|$)", next_line)
            valid = _line_number(inline_valid.group(1)) if inline_valid else None
            inline_row = inline_valid is not None
        if valid is None:
            continue
        basis_lines = [next_line] if inline_row else []
        percentage = None
        for cursor in range(index + 2, min(len(lines), index + 8)):
            line = lines[cursor]
            percent_match = re.search(r"(\d+(?:\.\d+)?)\s*%", line)
            if percent_match:
                percentage = float(percent_match.group(1))
                basis_lines.append(line)
                break
            basis_lines.append(line)
        if percentage is None or not 0 < percentage <= 100:
            continue
        basis = " ".join(basis_lines)
        success_match = re.search(
            r"([\d,]+)\s+out\s+of\s+([\d,]+)",
            basis,
            flags=re.IGNORECASE,
        )
        success = _line_number(success_match.group(1)) if success_match else None
        return {
            "oneLotAppliedShares": int(target),
            "oneLotValidApplications": int(valid),
            "oneLotSuccessfulApplications": int(success) if success is not None else None,
            "oneLotSuccessRate": percentage,
            "evidence": basis[:1000],
        }
    return None


def parse_allotment_text(text, lot_size_shares=None):
    # 部分官方 PDF 的文本层会把换行/分页控制符导出为退格等不可见字符，
    # 先统一为空格，避免把 “Hong\x08 Kong” 误判为缺字段。
    raw = re.sub(r"[\x00-\x1f\x7f]+", " ", str(text or ""))
    normalized = re.sub(r"\s+", " ", raw).strip()
    oversubscription = _parse_public_oversubscription(normalized)
    greenshoe = _parse_greenshoe(normalized)
    final_price_match = re.search(
        r"(?:Final\s+Offer\s+Price|(?<!Maximum\s)Offer\s+Price|最終發售價|最终发售价|發售價|发售价)\s*[:：]?\s*(?:HK\$|HKD|港元)?\s*([0-9]+(?:\.[0-9]+)?)",
        normalized,
        flags=re.IGNORECASE,
    )
    final_offer_price = float(final_price_match.group(1).replace(',', '')) if final_price_match else None
    brokerage_rate = _percent(normalized, [r"brokerage(?:\s+fee)?(?:\s+of)?", r"經紀佣金", r"经纪佣金"])
    sfc_rate = _percent(normalized, [r"SFC\s+transaction\s*levy(?:\s+of)?", r"證監會交易徵費", r"证监会交易征费"])
    afrc_rate = _percent(normalized, [
        r"AFRC\s+transaction\s*levy(?:\s+of)?",
        r"Accounting\s+and\s+Financial\s+Reporting\s+Council\s+transaction\s*levy(?:\s+of)?",
        r"會財局交易徵費", r"会财局交易征费",
    ])
    exchange_rate = _percent(normalized, [r"(?:the\s+)?(?:Hong\s+Kong\s+)?Stock\s+Exchange\s+trading\s+fee(?:\s+of)?", r"(?:香港)?聯交所交易費", r"(?:香港)?联交所交易费"])
    fee_rates = [brokerage_rate, sfc_rate, afrc_rate, exchange_rate]
    fee_parser_status = 'parsed' if final_offer_price is not None and all(rate is not None for rate in fee_rates) else 'missing'
    lot_amount_hkd = None
    application_fee_hkd = None
    brokerage_fee_hkd = None
    lot_size = _number(lot_size_shares)
    if fee_parser_status == 'parsed' and lot_size is not None and lot_size > 0:
        principal = final_offer_price * lot_size
        total_rate = sum(fee_rates)
        brokerage_fee_hkd = round(principal * brokerage_rate / 100, 2)
        application_fee_hkd = round(principal * total_rate / 100, 2)
        lot_amount_hkd = round(principal + application_fee_hkd, 2)
    total_reported = _find_number(
        normalized,
        r"Number of Offer Shares(?! (?:in|under|initially))",
    )
    parenthetical = r"(?:\s+\([^)]*\))?"
    public_initial = _find_number(
        normalized,
        r"(?:No\.|Number) of Offer Shares initially available under "
        r"(?:the )?(?:Hong Kong )?Public Offer(?:ing)?" + parenthetical,
    )
    public_final, public_final_evidence = _find_final_public_offer_number(normalized)
    international_initial = _find_number(
        normalized,
        r"(?:No\.|Number) of Offer Shares initially available under "
        r"(?:the )?International (?:Offer|Offering|Placing)" + parenthetical,
    )

    initial_total = None
    public_ratio = None
    international_ratio = None
    warnings = []
    if public_initial and international_initial:
        initial_total = public_initial + international_initial
        public_ratio = public_initial / initial_total
        international_ratio = international_initial / initial_total
        if total_reported and total_reported != initial_total:
            warnings.append("reported_total_differs_from_initial_offer_total")

    # 绿鞋保护比例使用配发公告明确列出的回拨后最终香港公开发售股数，
    # 不用初始发售量或假设性表格替代。比例单位为百分比。
    if greenshoe:
        if public_initial is not None:
            greenshoe["initialPublicOfferShares"] = public_initial
        if public_final is not None:
            greenshoe["finalPublicOfferShares"] = public_final
            greenshoe["publicOfferShares"] = public_final
            greenshoe["publicOfferSharesBasis"] = "final_public_offer_after_reallocation"
        elif public_initial is not None:
            greenshoe["publicOfferSharesBasis"] = "final_public_offer_missing"
        over_allocated = greenshoe.get("overAllocatedShares")
        if over_allocated is not None and public_final:
            greenshoe["protectionRatioPct"] = round(over_allocated / public_final * 100, 4)

    parsed = (
        public_initial is not None
        and international_initial is not None
        and initial_total is not None
        and 0 < public_ratio < 1
        and 0 < international_ratio < 1
        and abs(public_ratio + international_ratio - 1) < 1e-9
    )
    lottery = _first_pool_a_lottery(text, lot_size_shares) or _first_allocation_table_lottery(text, lot_size_shares)
    return {
        "parserVersion": "hk-ipo-allotment-v2",
        "parserStatus": "parsed" if parsed else "incomplete",
        "finalOfferPrice": final_offer_price,
        "brokerageRatePct": brokerage_rate,
        "sfcTransactionLevyRatePct": sfc_rate,
        "afrcTransactionLevyRatePct": afrc_rate,
        "stockExchangeTradingFeeRatePct": exchange_rate,
        "lotAmountHkd": lot_amount_hkd,
        "applicationFeeHkd": application_fee_hkd,
        "brokerageFeeHkd": brokerage_fee_hkd,
        "feeParserStatus": fee_parser_status,
        "publicOversubscription": oversubscription["value"] if oversubscription else None,
        "publicOversubscriptionQualifier": oversubscription["qualifier"] if oversubscription else None,
        "oversubscriptionParserStatus": "parsed" if oversubscription else "missing",
        "greenshoeDetails": greenshoe or {},
        "greenshoeParserStatus": greenshoe.get("parserStatus", "parsed") if greenshoe else "missing",
        "totalOfferSharesReported": total_reported,
        "initialPublicOfferShares": public_initial,
        "finalPublicOfferShares": public_final,
        "finalPublicOfferSharesParserStatus": "parsed" if public_final is not None else "missing",
        "initialInternationalOfferShares": international_initial,
        "initialOfferSharesTotal": initial_total,
        "initialPublicOfferRatio": public_ratio,
        "initialInternationalOfferRatio": international_ratio,
        "oneLotAppliedShares": lottery["oneLotAppliedShares"] if lottery else None,
        "oneLotValidApplications": lottery["oneLotValidApplications"] if lottery else None,
        "oneLotSuccessfulApplications": lottery["oneLotSuccessfulApplications"] if lottery else None,
        "oneLotSuccessRate": lottery["oneLotSuccessRate"] if lottery else None,
        "lotteryParserStatus": "parsed" if lottery else "missing",
        "warnings": warnings,
        "evidence": {
            "publicLabel": "No. of Offer Shares initially available under the Hong Kong Public Offer",
            **({"finalPublicOfferShares": public_final_evidence} if public_final_evidence else {}),
            "internationalLabel": "No. of Offer Shares initially available under the International Offer/Offering/Placing",
            **({"finalOfferPrice": final_price_match.group(0)} if final_price_match else {}),
            **({"feeRates": {
                "brokerageRatePct": brokerage_rate,
                "sfcTransactionLevyRatePct": sfc_rate,
                "afrcTransactionLevyRatePct": afrc_rate,
                "stockExchangeTradingFeeRatePct": exchange_rate,
            }} if any(rate is not None for rate in fee_rates) else {}),
            **({"oneLotBasis": lottery["evidence"]} if lottery else {}),
            **({"publicOversubscription": oversubscription} if oversubscription else {}),
            **({"greenshoe": greenshoe} if greenshoe else {}),
        },
    }


def extract_pdf(data, lot_size_shares=None):
    try:
        import fitz  # PyMuPDF，项目 requirements.txt 已固定版本
    except Exception as exc:  # pragma: no cover - 环境缺依赖时由调用方记录失败
        return {"parserStatus": "failed", "error": f"PyMuPDF unavailable: {exc}"}
    try:
        document = fitz.open(stream=data, filetype="pdf")
        text = "\n".join(page.get_text() for page in document)
        result = parse_allotment_text(text, lot_size_shares)
        result["pageCount"] = len(document)
        return result
    except Exception as exc:
        return {"parserStatus": "failed", "error": str(exc)}


def main():
    data = sys.stdin.buffer.read()
    lot_size_shares = None
    if "--lot-size" in sys.argv:
        try:
            lot_size_shares = float(sys.argv[sys.argv.index("--lot-size") + 1])
        except (IndexError, TypeError, ValueError):
            lot_size_shares = None
    if "--text" in sys.argv:
        result = parse_allotment_text(data.decode("utf-8", errors="replace"), lot_size_shares)
    else:
        result = extract_pdf(data, lot_size_shares)
    # Windows 子进程可能使用 GBK 标准输出；原文证据含“−”等字符时，
    # 使用 ASCII 转义输出，Node 端 JSON.parse 后仍会还原原文。
    print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
