# 本文件由 ipo_daily_report.py 物理拆分而来，函数体/常量未改动，仅调整文件归属。
import requests
import json
import hashlib
import os
import re
from collections import defaultdict
import time
from datetime import datetime, timedelta
import fitz  # PyMuPDF - PDF解析
import db_pg  # PostgreSQL 数据层
from calendar_core import _str_date, build_upcoming_calendar, fetch_calendar_entries
from _classify import _is_bj_stock, _market_type_to_board_key
from _common import _load_env
from ipo_lib_common import *
from ipo_lib_common import _to_ts_code
from external_call_guard import ExternalCallGuardError
from document_pdf_cache import get_cached_pdf, put_cached_pdf
from bond_data_layer import get_bond_row, get_listing_liquidity, save_listing_liquidity
from sse_listing_parser import (
    SSE_LISTING_INDEX_URL,
    parse_sse_listing_detail,
    parse_sse_listing_index,
)

_bond_price_source = {}


def _cached_pdf_text(url):
    """读取统一持久化 PDF 缓存；缓存损坏时按未命中处理并允许重新下载。"""
    try:
        cached = get_cached_pdf(url)
        if not cached:
            return None
        content = cached.read_bytes()
        if not content.lstrip().startswith(b"%PDF"):
            return None
        doc = fitz.open(stream=content, filetype="pdf")
        try:
            return "".join(page.get_text() for page in doc) or None
        finally:
            doc.close()
    except Exception:
        return None


def _put_pdf_cache(url, content):
    """缓存是加速层，落盘失败不能阻断官方资料解析。"""
    try:
        put_cached_pdf(url, content)
    except Exception:
        pass


def _split_embedded_industry(main_business):
    """兼容旧数据：把主营业务末尾拼接的“所属行业”拆成独立字段。"""
    text = re.sub(r'\s+', ' ', str(main_business or '')).strip()
    if not text:
        return '', ''
    match = re.search(r'(?:^|[；;])\s*所属行业\s*[:：]\s*(.+?)\s*$', text)
    if not match:
        return text, ''
    industry = re.split(r'[；;]', match.group(1), maxsplit=1)[0].strip(' ：:，,。')
    business = text[:match.start()].strip(' ；;，,')
    return business or text, industry[:80]


def _normalize_stock_detail(info):
    """统一新股详情中的行业/主营字段，供数据库读取和外部补全共同复用。"""
    if not isinstance(info, dict):
        return info
    business, embedded_industry = _split_embedded_industry(info.get('main_business'))
    if embedded_industry:
        if not str(info.get('industry') or '').strip():
            info['industry'] = embedded_industry
        info['main_business'] = business
    return info


def fetch_stock_detail(secu_code):
    """从 ipo_history 读取新股详细发行信息。

    对齐原东财 HTML 解析产出的字段：
    issue_price, issue_pe, online_date, list_date, fund_raised, total_shares,
    online_shares, online_lottery_rate, main_business, industry, circulation_mv
    """
    try:
        conn = _init_ipo_db()
        row = conn.execute(
            """SELECT issue_price,issue_pe,ipo_date,listing_date,fund_raised,total_shares,
                      online_shares,online_lottery_rate,oversubscribe_multiple,subscribe_upper_limit,circulation_mv,
                      main_business,industry,industry_pe,business_exposure
                 FROM ipo_history WHERE security_code=? LIMIT 1""",
            (str(secu_code or "").split(".")[0],),
        ).fetchone()
        conn.close()
        if not row:
            return None
        fields = ("issue_price", "issue_pe", "online_date", "list_date", "fund_raised", "total_shares",
                  "online_shares", "online_lottery_rate", "oversubscribe_multiple", "subscribe_upper_limit", "circulation_mv",
                  "main_business", "industry", "industry_pe", "business_exposure")
        info = dict(zip(fields, row))
        _normalize_stock_detail(info)
        if isinstance(info.get("business_exposure"), str):
            try:
                info["business_exposure"] = json.loads(info["business_exposure"])
            except (TypeError, ValueError):
                info["business_exposure"] = None
        if info.get("subscribe_upper_limit"):
            info["limit_amount"] = float(info["subscribe_upper_limit"])
            info["subscribe_mv"] = round(float(info["subscribe_upper_limit"]) * 10, 1)
        return info
    except Exception as e:
        print(f"获取{secu_code}详情失败: {e}")
        return None

def fetch_bond_detail(secu_code):
    """从统一数据库读取债券发行详情和最近已入库行情。"""
    try:
        row = get_bond_row(secu_code)
        if not row:
            return None
        info = {}

        info["bond_name"] = str(row.get("bond_name") or "")
        info["stock_code"] = str(row.get("stock_code") or "").split(".")[0]
        info["stock_name"] = str(row.get("stock_name") or "")
        info["convert_price"] = _ts_float(row.get("conv_price"))
        issue_size = _ts_float(row.get("issue_size"))
        info["issue_scale"] = round(issue_size, 4) if issue_size is not None else None
        info["list_date"] = _str_date(row.get("listing_date"))
        info["rating"] = str(row.get("rating") or "").replace("sti", "").replace("STI", "")

        # 2. 获取可转债价格（已上市→最近已入库收盘价，未上市→面值100）
        bond_price = _fetch_bond_price(secu_code, info.get("list_date"))
        info["bond_price"] = bond_price

        # 2. 计算转股价值：尝试获取正股行情
        stock_code = info["stock_code"]
        if stock_code:
            stock_info = fetch_stock_quote(stock_code)
            if stock_info:
                info["stock_price"] = stock_info.get("price")
                info["stock_pe"] = stock_info.get("pe")
                info["stock_pb"] = stock_info.get("pb")
                info["stock_roe"] = stock_info.get("roe")
                info["stock_market_cap"] = stock_info.get("market_cap")
                info["stock_industry"] = stock_info.get("industry", "")

        # 3. 计算转股价值和转股溢价率
        if info.get("convert_price") and info.get("stock_price"):
            try:
                cp = float(info["convert_price"])
                sp = float(info["stock_price"])
                transfer_value, premium_ratio = calculate_conversion_metrics(
                    sp, cp, info.get("bond_price")
                )
                info["transfer_value"] = transfer_value
                if premium_ratio is not None:
                    info["premium_ratio"] = premium_ratio
            except (ValueError, TypeError):
                pass

        # 4. 计算流通规模和限售规模
        # 优先从配售结果公告获取精确数据（控股+实控人配售量），
        # 公告未发布时用网上占比分段系数估算
        if info.get("issue_scale"):
            calc_circulation_scale(info, bond_code=secu_code)

        # 5. 转债总市值占比
        if info.get("issue_scale") and info.get("stock_market_cap"):
            try:
                mc = float(info["stock_market_cap"])
                if mc > 0:
                    info["market_cap_ratio"] = round(float(info["issue_scale"]) / mc * 100, 2)
            except (ValueError, TypeError):
                pass

        # 6. 估算到期税前/税后收益率（简化计算）
        # 到期收益率 ≈ (到期赎回价 + 累计利息 - 债券现价) / 债券现价 / 剩余年限
        if info.get("bond_expire") and info.get("coupon_ir") is not None:
            try:
                years = float(info["bond_expire"])
                coupon = float(info["coupon_ir"])
                bp = float(info["bond_price"])
                # 到期赎回价通常为108（最后一期利息另计），简化估算
                redeem_price = 108
                total_coupons = coupon * years  # 简化：假设每年票息相同
                total_return = redeem_price + total_coupons
                if bp > 0 and years > 0:
                    info["ytm_pre_tax"] = round((total_return / bp - 1) / years * 100, 2)
                    # 税后：利息收入扣20%税
                    after_tax_return = redeem_price + total_coupons * 0.8
                    info["ytm_after_tax"] = round((after_tax_return / bp - 1) / years * 100, 2)
            except (ValueError, TypeError):
                pass

        return info
    except Exception as e:
        print(f"获取新债{secu_code}详情失败: {e}")
        return None

_org_id_cache = {}
_STOCK_NAME_CACHE = {}
_MAIN_BUSINESS_SOURCE = {}
_MAIN_BUSINESS_DOCUMENT = {}
_MAIN_BUSINESS_DIAGNOSTIC = {}
_EXCHANGE_PROSPECTUS_CACHE = {}
_EXCHANGE_IPO_DOCUMENT_CACHE = {}
_IPO_ISSUANCE_DETAIL_CACHE = {}
_IPO_ISSUANCE_DETAIL_DIAGNOSTIC = {}
_CNINFO_IPO_ISSUANCE_CACHE = {}
_IPO_ISSUANCE_RESULT_DETAIL_CACHE = {}


def _record_main_business_attempt(code, source, status, **extra):
    diagnostic = _MAIN_BUSINESS_DIAGNOSTIC.setdefault(code, {"attempts": []})
    attempt = {"source": source, "status": status}
    attempt.update({key: value for key, value in extra.items() if value is not None})
    diagnostic.setdefault("attempts", []).append(attempt)


def _finalize_main_business_diagnostic(code):
    diagnostic = _MAIN_BUSINESS_DIAGNOSTIC.setdefault(code, {"attempts": []})
    attempts = diagnostic.get("attempts") or []
    statuses = {item.get("status") for item in attempts}
    if diagnostic.get("status") == "value":
        return diagnostic
    if "document_parse_failed" in statuses:
        diagnostic.update({"status": "document_parse_failed", "reason": "document_found_but_parser_found_no_main_business"})
    elif "source_error" in statuses:
        diagnostic.update({"status": "source_unavailable", "reason": "upstream_source_error"})
    elif attempts and statuses.issubset({"document_not_found"}):
        diagnostic.update({"status": "document_not_found", "reason": "no_prospectus_candidate_found"})
    else:
        diagnostic.update({"status": "source_unavailable", "reason": "no_main_business_value_returned"})
    return diagnostic


def _get_org_id(stock_code):
    """从巨潮获取股票 orgId，供交易所主源失败时的备源查询使用。"""
    if stock_code in _org_id_cache:
        return _org_id_cache[stock_code]
    last_error = None
    for attempt in range(3):
        try:
            url = "https://www.cninfo.com.cn/new/information/topSearch/query"
            cn_session = requests.Session()
            cn_session.headers.update({
                "User-Agent": HEADERS["User-Agent"],
                "Accept": "application/json",
                "X-Requested-With": "XMLHttpRequest",
                "Referer": "https://www.cninfo.com.cn/",
            })
            resp = cn_session.post(url, data={"keyWord": stock_code, "maxNum": 10}, timeout=20)
            cn_session.close()
            for item in resp.json():
                if item.get("code") == stock_code:
                    _org_id_cache[stock_code] = item["orgId"]
                    return item["orgId"]
            break
        except ExternalCallGuardError:
            raise
        except Exception as error:
            last_error = error
            if attempt < 2:
                time.sleep(3)
    if last_error is not None:
        raise ExternalCallGuardError(
            "UPSTREAM_5XX", f"获取orgId失败({stock_code}): {last_error}",
            "cninfo", f"topSearch:{stock_code}", api_name="topSearch",
        ) from last_error
    _org_id_cache[stock_code] = None
    return None

def _parse_bond_top10_holders(text):
    """
    解析上市公告书中的"前十名可转换公司债券持有人"表格。

    返回 [(持有人名称, 持有量(张), 持有比例(%)), ...] 或 None
    """
    # 找表格起始
    idx = -1
    for kw in ['前十名可转换公司债券持有人', '前十名可转换', '前10 名债券持有人']:
        idx = text.find(kw)
        if idx >= 0:
            break
    if idx < 0:
        return None

    section = text[idx:]

    # 找表格结束位置：下一个章节头如 "\nX、"
    end_pos = len(section)
    for m in re.finditer(r'\n\d+、', section):
        pos = m.start()
        if pos > 0:
            end_pos = pos
            break
    for stop in ['发行费用', '二、本次承销', '二、发行费用', '三、本次发行']:
        pos = section.find(stop)
        if pos > 0:
            end_pos = min(end_pos, pos)
    section = section[:end_pos]

    # 判定数量列单位：公告书表格"持有数量"列常用"（张）"或"（手）"。
    # 1 手 = 10 张；若单位为手却按张计，控股股东配售量会缩小 10 倍，流通规模失真。
    # 注意：表头单位常换行书写（"持有数量" 与 "（手）" 分两行），故允许中间有空白/换行。
    _unit = 10 if re.search(r'持有数量[ \t\r\n]*[（(][ \t\r\n]*手', section) else 1

    entries = []
    lines = section.split('\n')
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if re.match(r'^\d+$', line) and 1 <= int(line) <= 50:
            i += 1
            while i < len(lines) and not lines[i].strip():
                i += 1
            if i >= len(lines):
                break
            name_parts = []
            while i < len(lines):
                l = lines[i].strip()
                if not l:
                    i += 1
                    continue
                if re.match(r'^\d+$', l) and 1 <= int(l) <= 50:
                    break
                if re.match(r'^[\d,]+\.?\d*$', l):
                    amount = int(l.replace(',', '').split('.')[0])
                    i += 1
                    while i < len(lines) and not lines[i].strip():
                        i += 1
                    pct = None
                    if i < len(lines):
                        try:
                            pct = float(lines[i].strip().replace('%', ''))
                        except:
                            pass
                        i += 1
                    name = ''.join(name_parts).strip()
                    entries.append((name, amount * _unit, pct))
                    break
                else:
                    name_parts.append(l)
                    i += 1
        else:
            i += 1

    return entries if entries else None


def _parse_listed_bond_quantity(text):
    """读取上市公告书明确给出的可转债上市数量（张）。"""
    compact = re.sub(r'\s+', '', str(text or ''))
    patterns = (
        r'可转换公司债券上市数量[：:]\d[\d,]*(?:\.\d+)?(?:（万元）|\(万元\))(?P<zhang>[\d,]+)张',
        r'可转换公司债券上市数量[：:](?P<zhang>[\d,]+)张',
        r'上市数量[：:](?P<zhang>[\d,]+)张',
    )
    for pattern in patterns:
        match = re.search(pattern, compact)
        if match:
            try:
                quantity = int(match.group('zhang').replace(',', ''))
            except (TypeError, ValueError):
                continue
            if quantity > 0:
                return quantity
    return None


def _parse_issue_result_liquidity(text, issue_scale, source_code="cninfo_announcements", source_class=None, source_name=None):
    """用发行结果公告中的控股股东体系配售量，形成可审计的流通规模值。"""
    raw_text = str(text or '')
    ps_zhang = None

    # 发行结果公告通常同时披露：原股东合计配售量，以及其中控股股东、
    # 实际控制人及一致行动人的配售量。后者才是本项目“限售依据”，不能
    # 把前者整体当成限售，否则会把原股东中可流通部分也错误扣除。
    controller_patterns = (
        r'控\s*股\s*股\s*东\s*[、,，]?\s*实\s*际\s*控\s*制\s*人\s*(?:及其\s*)?一\s*致\s*行\s*动\s*人'
        r'[\s\S]{0,160}?(?P<quantity>[\d,]+)\s*(?P<unit>手|张)?',
        r'控\s*股\s*股\s*东[\s\S]{0,20}?实\s*际\s*控\s*制\s*人[\s\S]{0,20}?一\s*致\s*行\s*动\s*人'
        r'[\s\S]{0,160}?(?P<quantity>[\d,]+)\s*(?P<unit>手|张)?',
    )
    for pattern in controller_patterns:
        match = re.search(pattern, raw_text)
        if not match:
            continue
        try:
            value = int(match.group('quantity').replace(',', ''))
        except (TypeError, ValueError):
            continue
        ps_zhang = value * (10 if match.group('unit') == '手' else 1)
        break

    try:
        total_zhang = int(float(issue_scale) * 100000000 / 100)
    except (TypeError, ValueError):
        total_zhang = 0
    if not ps_zhang or total_zhang <= 0 or ps_zhang >= total_zhang:
        return None
    lock_scale = round(ps_zhang * 100 / 100000000, 4)
    circulation_scale = round((total_zhang - ps_zhang) * 100 / 100000000, 4)
    source_name = source_name or {
        "sse": "上交所", "szse": "深交所", "cninfo_announcements": "巨潮资讯网",
    }.get(source_code, source_code)
    return {
        "status": "ok",
        "source_code": source_code,
        "source_class": source_class or f"{source_code}_issue_result",
        "lock_scale": lock_scale,
        "circulation_scale": circulation_scale,
        "ctrl_zhang": ps_zhang,
        "total_zhang": total_zhang,
        "ctrl_ratio": round(ps_zhang / total_zhang * 100, 2),
        "source": f"{source_name}官方发行结果公告（控股股东、实际控制人及一致行动人配售量）",
        "quality": "issue_result_controller_allotment",
        "error": None,
    }


def _listed_quantity_fallback(text, source_code="cninfo_announcements", source_class=None, source_name=None):
    """上市公告书缺少持有人拆分时，使用公告明确的上市数量，并保留质量标记。"""
    total_zhang = _parse_listed_bond_quantity(text)
    if not total_zhang:
        return None
    circulation_scale = round(total_zhang * 100 / 100000000, 4)
    source_name = source_name or {
        "sse": "上交所", "szse": "深交所", "cninfo_announcements": "巨潮资讯网",
    }.get(source_code, source_code)
    return {
        "status": "ok",
        "source_code": source_code,
        "source_class": source_class or f"{source_code}_listing_book_listed_quantity",
        "lock_scale": 0,
        "circulation_scale": circulation_scale,
        "ctrl_zhang": 0,
        "total_zhang": total_zhang,
        "ctrl_ratio": 0,
        "source": f"{source_name}官方上市公告书（公告明确上市数量兜底，未解析持有人拆分）",
        "quality": "listed_quantity_fallback",
        "error": None,
    }


_FUND_HOLDER_RE = re.compile(r'基金|ETF|指数|证券投资|资产管理计划|资管计划|公募|私募')


def _controller_section(text):
    """只截取控股股东/实际控制人章节，避免从整份公告正文误抓普通句子。"""
    starts = [
        text.find('发行人控股股东和实际控制人情况'),
        text.find('控股股东和实际控制人情况'),
        text.find('（一）控股股东'),
    ]
    start = min((pos for pos in starts if pos >= 0), default=-1)
    if start < 0:
        return text
    section = text[start:start + 20000]
    next_heading = re.search(r'\n[六七八九十]+、', section[20:])
    return section[:next_heading.start() + 20] if next_heading else section


def _clean_controller_candidate(value):
    value = re.sub(r'\s+', '', str(value or '')).strip('，。；;：:、')
    value = re.sub(r'^(?:仍|分别|共同)', '', value)
    if not 2 <= len(value) <= 50:
        return ''
    if value in {'一人', '二人', '双方', '其本人'}:
        return ''
    if re.search(r'不存在|情形|情况|发行人|上市公司|本公司|公司与|及其|其他企业|重大|公开承诺|经营|募集资金|规定', value):
        return ''
    if re.search(r'[{}\[\]“”"\d%]', value):
        return ''
    return value


def _holder_alias(name):
    alias = re.sub(r'\s+', '', str(name or ''))
    alias = re.sub(r'(股份有限公司|投资管理有限公司|集团有限公司|有限责任公司|有限公司)$', '', alias)
    alias = re.sub(r'^(深圳|上海|北京|广州|南京|杭州|苏州)市', r'\1', alias)
    return alias


def _extract_controller_names(text, holders=None):
    """
    从上市公告书中识别控股股东、实际控制人及其控制的企业名称。

    返回 (controller_set, controlled_entity_set)
    """
    controllers, controlled_entities = set(), set()
    section = _controller_section(text)
    compact = re.sub(r'\s+', '', section)

    # 只接受带“为/是/：”的明确身份表述，禁止把“实际控制人最近三年……”等正文误当名称。
    for m in re.finditer(r'(?:控股股东|实际控制人)(?:仍)?(?:为|是|：|:)\s*([^。；;\n]{2,100})', section):
        for part in re.split(r'[、和与]', m.group(1)):
            name = _clean_controller_candidate(re.sub(r'先生|女士', '', part))
            if name:
                controllers.add(name)

    # “X、Y为发行人的共同实际控制人”等反向表述。
    for m in re.finditer(r'([\u4e00-\u9fa5]{2,4})与([\u4e00-\u9fa5]{2,4})为(?:父子|父女|母子|母女|夫妻)关系', section):
        controllers.update(m.groups())
    for m in re.finditer(r'([^。；;\n]{2,60}?)(?:为|系)发行人的(?:共同)?(?:控股股东|实际控制人)', section):
        for part in re.split(r'[、和与]', m.group(1)):
            name = _clean_controller_candidate(re.sub(r'^.*[，,]', '', part))
            if name:
                controllers.add(name)

    # 上市公告书常写作“控股股东、实际控制人基本信息/具体情况如下：张三先生”。
    for m in re.finditer(
        r'(?:控股股东[、和及]实际控制人|控股股东、实际控制人)[^。；]{0,30}?'
        r'(?:基本信息|具体情况)如下[：:]\s*'
        r'([\u4e00-\u9fa5]{2,4})(?:先生|女士)?',
        section,
    ):
        controllers.add(m.group(1))

    # 控股股东章节常见的直接持股、公司名称表格和控制链表述。
    entity_patterns = [
        r'截至[^。；]{0,80}[，,]([^，。；\n]{2,50}?)(?:直接)?持有(?:发行人|公司)',
        r'公司名称\s*\n\s*([^\n]{2,50})',
        r'([^，。；\n]{2,50}?)通过控制([^，。；\n]{2,50}?)间接控制发行人',
        r'持有([^，。；\n]{2,50}?)100%的出资额',
    ]
    for pattern in entity_patterns:
        for match in re.finditer(pattern, section):
            for raw in match.groups():
                entity = _clean_controller_candidate(raw)
                if entity and not _FUND_HOLDER_RE.search(entity):
                    controlled_entities.add(entity)

    # 用已解析的前十名持有人反向补全公司全称。只有名称别名确实出现在控制人章节才纳入。
    for holder_name, _amount, _pct in holders or []:
        if _FUND_HOLDER_RE.search(holder_name):
            continue
        alias = _holder_alias(holder_name)
        if len(alias) >= 4 and alias in compact:
            controlled_entities.add(re.sub(r'\s+', '', holder_name))

    return controllers, controlled_entities


def _match_controller_holders(holders, controller_names, controlled_entities):
    """从前十名持有人中匹配控股股东、实控人及其控制企业。"""
    locked_holders = []
    candidates = [x for x in controller_names | controlled_entities if x]
    for name, amount, pct in holders:
        if _FUND_HOLDER_RE.search(name):
            continue
        compact_name = re.sub(r'\s+', '', name)
        if any(candidate in compact_name or compact_name in candidate for candidate in candidates):
            locked_holders.append((name, amount, pct))
    return locked_holders

def _derive_total_zhang(ctrl_zhang, ctrl_pct, issue_scale):
    """
    从公告书表格推导可转债发行总张数。

    优先用 控股股东/实控人持有量 ÷ 其占比% 反推（公告书自身数字，比 cb_issue 的
    issue_scale 更准，个别债券 cb_issue 发行规模与公告书不符）；issue_scale 仅作
    一致性兜底：若推导值与 issue_scale 偏离过大（>2倍或<0.5倍），说明表格占比解析
    异常，退回 issue_scale 推算值。
    """
    scale_total = int(issue_scale * 100000000 / 100)
    if ctrl_pct and ctrl_pct > 0:
        total_zhang = int(ctrl_zhang / (ctrl_pct / 100))
        if scale_total > 0 and not (0.5 * scale_total <= total_zhang <= 2.0 * scale_total):
            total_zhang = scale_total
        return total_zhang
    return scale_total

_SSE_LISTING_CACHE = {}


def _sse_listing_page_url(page_num):
    if page_num == 1:
        return SSE_LISTING_INDEX_URL
    return SSE_LISTING_INDEX_URL.replace("s_list.shtml", f"s_list_{page_num}.shtml")


def _fetch_sse_listing_notice(bond_code=None, stock_name=None, max_pages=None):
    """从上交所官方上市/退市公告中查找指定可转债，仅用于补充生命周期诊断。"""
    code = re.sub(r"\D", "", str(bond_code or ""))
    name = str(stock_name or "").strip()
    if not code and not name:
        return None
    cache_key = code or name
    if cache_key in _SSE_LISTING_CACHE:
        return _SSE_LISTING_CACHE[cache_key]

    try:
        session = _get_session()
        page_num = 1
        seen_pages = set()
        while max_pages is None or page_num <= max_pages:
            response = session.get(_sse_listing_page_url(page_num), timeout=20)
            records = parse_sse_listing_index(response.text)
            if not records:
                break
            page_signature = tuple(str(item.get("url") or item.get("title") or "") for item in records)
            if page_signature in seen_pages:
                break
            seen_pages.add(page_signature)
            for record in records:
                if code and code not in record.get("title", "") and "可转" not in record.get("title", ""):
                    continue
                if name and name not in record.get("title", ""):
                    continue
                detail_response = session.get(record["url"], timeout=20)
                detail = parse_sse_listing_detail(detail_response.text, record["url"])
                if code and detail.get("bond_code") != code:
                    continue
                if name and name not in (detail.get("title") or "") and name not in (detail.get("body") or ""):
                    continue
                _SSE_LISTING_CACHE[cache_key] = detail
                return detail
            page_num += 1
        _SSE_LISTING_CACHE[cache_key] = None
    except Exception as exc:
        print(f"查询上交所上市/退市公告失败({bond_code or stock_name}): {exc}")
    return None


def _listing_notice_error(notice):
    if not notice:
        return None
    bond_name = notice.get("bond_name") or notice.get("bond_code") or "目标债券"
    listing_date = notice.get("listing_date") or "未提取到上市日"
    return (
        f"已找到上交所正式上市公告（{bond_name}，上市日{listing_date}），"
        "但当前未找到可解析的交易所官方上市公告书明细，暂不能形成流通规模"
    )


def _exchange_document_url(path, source_code):
    """把交易所公告接口返回的相对路径转换为官方 PDF 地址。"""
    raw = str(path or "").strip()
    if not raw:
        return None
    if raw.startswith("http://") or raw.startswith("https://"):
        return raw
    if source_code == "sse":
        return "https://big5.sse.com.cn/site/cht/www.sse.com.cn" + (raw if raw.startswith("/") else f"/{raw}")
    if source_code == "szse":
        if raw.startswith("/download/"):
            return "https://disc.static.szse.cn" + raw
        return "https://disc.static.szse.cn/download" + (raw if raw.startswith("/") else f"/{raw}")
    return None


def _exchange_bond_document_candidates(stock_code, listing_date=None):
    """从上交所/深交所官方公告接口查找可转债上市公告书和发行结果公告。"""
    code = re.sub(r"\D", "", str(stock_code or ""))
    if not code:
        return [], ""
    if code.startswith(("6", "9")):
        source_code = "sse"
    elif code.startswith(("0", "3")):
        source_code = "szse"
    else:
        return [], ""

    try:
        listing_dt = datetime.strptime(str(listing_date)[:10], "%Y-%m-%d") if listing_date else None
    except ValueError:
        listing_dt = None
    today = datetime.now()
    start_dt = listing_dt - timedelta(days=60) if listing_dt else today - timedelta(days=3650)
    end_dt = listing_dt + timedelta(days=180) if listing_dt else today
    start_date, end_date = start_dt.strftime("%Y-%m-%d"), end_dt.strftime("%Y-%m-%d")
    rows = []
    session = requests.Session()
    session.headers.update(HEADERS)
    try:
        if source_code == "sse":
            endpoint = "https://query.sse.com.cn/security/stock/queryCompanyBulletin.do"
            page_num = 1
            seen_pages = set()
            while True:
                payload = {
                    "isPagination": "true", "productId": code,
                    "keyWord": "可转换公司债券", "securityType": "0101,120100,020100,020200,120200",
                    "beginDate": start_date, "endDate": end_date,
                    "pageHelp.pageSize": "100", "pageHelp.pageNo": str(page_num),
                    "pageHelp.beginPage": str(page_num), "pageHelp.endPage": str(page_num),
                }
                response = session.get(endpoint, params=payload, timeout=20,
                                       headers={"Referer": "https://www.sse.com.cn/", "Accept": "application/json"})
                result = _parse_jsonp_payload(response.text) or {}
                page_help = result.get("pageHelp") or {}
                page_rows = page_help.get("data") or []
                if page_rows and isinstance(page_rows[0], list):
                    page_rows = [item for group in page_rows for item in (group if isinstance(group, list) else [group])]
                page_signature = tuple(str(item.get("URL") or item.get("TITLE") or item.get("SSEDATE") or "") for item in page_rows)
                if page_signature and page_signature in seen_pages:
                    break
                if page_signature:
                    seen_pages.add(page_signature)
                rows.extend(page_rows)
                total = int(page_help.get("total") or 0)
                if not page_rows or (total and len(rows) >= total) or len(page_rows) < 100:
                    break
                page_num += 1
        else:
            endpoint = "https://www.szse.cn/api/disc/announcement/annList?random=0.1"
            page_num = 1
            seen_pages = set()
            while True:
                body = {
                    "seDate": [start_date, end_date], "stock": [code],
                    "channelCode": ["listedNotice_disc"], "pageSize": 50, "pageNum": page_num,
                }
                response = session.post(endpoint, json=body, timeout=20,
                                        headers={"Content-Type": "application/json",
                                                 "Referer": "https://www.szse.cn/disclosure/listed/notice/index.html",
                                                 "X-Requested-With": "XMLHttpRequest"})
                result = response.json() if response.content else {}
                page_rows = result.get("data") or []
                page_signature = tuple(str(item.get("URL") or item.get("url") or item.get("TITLE") or item.get("title") or "") for item in page_rows)
                if page_signature and page_signature in seen_pages:
                    break
                if page_signature:
                    seen_pages.add(page_signature)
                rows.extend(page_rows)
                total = int(result.get("announceCount") or 0)
                if not page_rows or (total and len(rows) >= total) or len(page_rows) < 50:
                    break
                page_num += 1
    finally:
        # 这里只关闭本次公告查询会话，避免影响其它任务的连接池。
        session.close()

    candidates = []
    for row in rows:
        title = str(row.get("TITLE") or row.get("title") or "").strip()
        normalized = re.sub(r"\s+", "", title)
        is_listing_book = "上市公告书" in normalized and ("可转换" in normalized or "可转债" in normalized)
        is_issue_result = "发行结果" in normalized and ("可转换" in normalized or "可转债" in normalized)
        if not (is_listing_book or is_issue_result):
            continue
        raw_path = row.get("URL") or row.get("attachPath") or row.get("url")
        url = _exchange_document_url(raw_path, source_code)
        if not url:
            continue
        date = str(row.get("SSEDATE") or row.get("publishTime") or row.get("publishDate") or "")[:10]
        candidates.append({
            "source_code": source_code,
            "source_type": "listing_book" if is_listing_book else "issue_result",
            "title": title,
            "date": date,
            "url": url,
        })
    candidates.sort(key=lambda item: item.get("date") or "", reverse=True)
    return candidates, source_code


def _download_exchange_bond_pdf_text(target):
    """下载交易所官方可转债公告 PDF 并提取正文。"""
    try:
        cached_text = _cached_pdf_text(target["url"])
        if cached_text:
            return cached_text, None
        session = _get_session()
        response = session.get(
            target["url"], timeout=30,
            headers={
                "User-Agent": HEADERS["User-Agent"],
                "Referer": "https://www.sse.com.cn/" if target["source_code"] == "sse"
                    else "https://www.szse.cn/disclosure/listed/notice/index.html",
                "Accept": "application/pdf,*/*",
            },
        )
        content = response.content or b""
        if int(response.status_code or 0) != 200 or not content.lstrip().startswith(b"%PDF"):
            return None, f"交易所官方 PDF 下载失败（HTTP {response.status_code} 或返回内容不是 PDF）"
        _put_pdf_cache(target["url"], content)
        doc = fitz.open(stream=content, filetype="pdf")
        text = "".join(page.get_text() for page in doc)
        doc.close()
        return text or None, None if text else "交易所官方 PDF 未提取到正文"
    except ExternalCallGuardError:
        raise
    except Exception as error:
        return None, f"交易所官方 PDF 处理异常：{type(error).__name__}: {error}"


def _download_cninfo_pdf_text(target):
    """下载并提取一条巨潮公告 PDF，作为交易所主源失败时的兜底。"""
    adjunct = str(target.get("adjunctUrl") or "").strip()
    pdf_url = adjunct if adjunct.startswith("http") else f"https://static.cninfo.com.cn/{adjunct.lstrip('/')}"
    cached_text = _cached_pdf_text(pdf_url)
    if cached_text:
        return cached_text, None
    session = _get_cninfo_session()
    try:
        response = session.get(pdf_url, timeout=30)
        if response.status_code != 200:
            return None, f"PDF下载失败(HTTP {response.status_code})"
        if not (response.content or b"").lstrip().startswith(b"%PDF"):
            return None, "PDF下载失败(返回内容不是 PDF)"
        _put_pdf_cache(pdf_url, response.content)
        doc = fitz.open(stream=response.content, filetype="pdf")
        text = "".join(page.get_text() for page in doc)
        doc.close()
        return text, None
    finally:
        session.close()


def _parse_exchange_listing_book(
    text, issue_scale, source_code, issue_texts=None, source_name=None,
    source_class=None, issue_source_class=None,
):
    """按统一规则解析上市公告书；同一来源的发行结果公告作第一层兜底。"""
    source_name = source_name or {
        "sse": "上交所", "szse": "深交所", "cninfo_announcements": "巨潮资讯网",
    }.get(source_code, source_code)
    source_class = source_class or f"{source_code}_listing_book"
    issue_source_class = issue_source_class or f"{source_code}_issue_result"
    holders = _parse_bond_top10_holders(text)
    issue_texts = issue_texts or []

    def issue_result_fallback():
        for issue_text in issue_texts:
            fallback = _parse_issue_result_liquidity(
                issue_text, issue_scale, source_code, issue_source_class, source_name,
            )
            if fallback:
                return fallback
        return None

    if not holders:
        fallback = issue_result_fallback() or _listed_quantity_fallback(
            text, source_code, f"{source_code}_listing_book_listed_quantity", source_name,
        )
        if fallback:
            return fallback
        return {"status": "error", "source_code": source_code, "source_class": source_class,
                "error": f"{source_name}官方上市公告书未能解析前十名可转换公司债券持有人表格"}

    controller_names, controlled_entities = _extract_controller_names(text, holders)
    if not controller_names and not controlled_entities:
        fallback = issue_result_fallback() or _listed_quantity_fallback(
            text, source_code, f"{source_code}_listing_book_listed_quantity", source_name,
        )
        if fallback:
            return fallback
        return {"status": "error", "source_code": source_code, "source_class": source_class,
                "error": f"{source_name}官方上市公告书未能识别控股股东/实际控制人信息；前十名持有人明细："
                         f"{'、'.join(f'{n}({a:,}张)' for n, a, _ in holders[:5])}"}

    locked_holders = _match_controller_holders(holders, controller_names, controlled_entities)
    if not locked_holders:
        fallback = issue_result_fallback() or _listed_quantity_fallback(
            text, source_code, f"{source_code}_listing_book_listed_quantity", source_name,
        )
        if fallback:
            return fallback
        holder_summary = "、".join(name for name, _amount, _pct in holders[:5])
        return {"status": "error", "source_code": source_code, "source_class": source_class,
                "error": f"控股股东/实控人未在前十名持有人（{holder_summary}…）中找到匹配项"}

    ctrl_zhang = sum(amount for _name, amount, _pct in locked_holders)
    ctrl_pct = sum(pct for _name, _amount, pct in locked_holders if pct is not None)
    scale_total = int(issue_scale * 100000000 / 100)
    corrected_note = ""
    if ctrl_zhang > scale_total:
        if ctrl_zhang / 100 <= scale_total:
            locked_holders = [(name, int(amount / 100), pct) for name, amount, pct in locked_holders]
            ctrl_zhang = sum(amount for _name, amount, _pct in locked_holders)
            corrected_note = "（金额列已按100元面值折算修正）"
        else:
            return {"status": "error", "source_code": source_code, "source_class": source_class,
                    "error": f"控股股东/实控人配售量({ctrl_zhang:,}张)超过发行总量({scale_total:,}张)，"
                             f"{source_name}公告书表格解析异常，流通规模不可信"}

    total_zhang = _derive_total_zhang(ctrl_zhang, ctrl_pct, issue_scale)
    lock_scale = round(ctrl_zhang * 100 / 100000000, 4)
    circulation_scale = round((total_zhang - ctrl_zhang) * 100 / 100000000, 4)
    ctrl_ratio = round(ctrl_zhang / total_zhang * 100, 2) if total_zhang > 0 else 0
    holder_details = "、".join(f"{name}({amount:,}张)" for name, amount, _pct in locked_holders)
    return {
        "status": "ok", "source_code": source_code, "source_class": source_class,
        "lock_scale": lock_scale, "circulation_scale": circulation_scale,
        "ctrl_zhang": ctrl_zhang, "total_zhang": total_zhang, "ctrl_ratio": ctrl_ratio,
        "source": f"{source_name}官方上市公告书（{holder_details}）{corrected_note}",
        "quality": f"{source_code}_listing_book_controller_holder_match", "error": None,
    }


def _fetch_exchange_placing_result(stock_code, issue_scale, bond_code=None, stock_name=None, listing_date=None):
    """查询并解析交易所官方可转债上市公告书和发行结果公告。"""
    source_code = ""
    source_class = "exchange_listing_book"
    try:
        candidates, source_code = _exchange_bond_document_candidates(stock_code, listing_date)
        source_class = f"{source_code}_listing_book" if source_code else "exchange_listing_book"
        if not candidates:
            notice = _fetch_sse_listing_notice(bond_code=bond_code, stock_name=stock_name) if source_code == "sse" else None
            result = {"status": "error", "source_code": source_code or "exchange",
                      "source_class": source_class,
                      "error": "未找到上交所/深交所官方可转债上市公告书或发行结果公告"}
            if notice:
                result["listing_notice"] = notice
                result["error"] = _listing_notice_error(notice)
            return result

        listing_targets = [item for item in candidates if item["source_type"] == "listing_book"]
        issue_targets = [item for item in candidates if item["source_type"] == "issue_result"]
        listing_target = listing_targets[0] if listing_targets else None
        issue_texts = []
        # 发行结果公告可能存在更正/补充版本，不能用固定条数截断；
        # 由去重、解析成功和任务安全止损控制执行边界。
        for target in issue_targets:
            text, _error = _download_exchange_bond_pdf_text(target)
            if text:
                issue_texts.append(text)

        if listing_target:
            text, download_error = _download_exchange_bond_pdf_text(listing_target)
            if text:
                return _parse_exchange_listing_book(text, issue_scale, source_code, issue_texts)
            if issue_texts:
                for issue_text in issue_texts:
                    fallback = _parse_issue_result_liquidity(issue_text, issue_scale, source_code)
                    if fallback:
                        return fallback
            return {"status": "error", "source_code": source_code, "source_class": f"{source_code}_listing_book",
                    "error": download_error or "交易所官方上市公告书未能提取正文"}

        for issue_text in issue_texts:
            result = _parse_issue_result_liquidity(issue_text, issue_scale, source_code)
            if result:
                return result
        return {"status": "error", "source_code": source_code,
                "source_class": f"{source_code}_issue_result",
                "error": "交易所官方发行结果公告未解析出有效的控股股东体系配售数量，无法形成流通规模"}
    except ExternalCallGuardError as error:
        return {"status": "error", "source_code": source_code or "exchange",
                "source_class": source_class,
                "error": f"交易所官方接口受限：{error}"}
    except Exception as error:
        return {"status": "error", "source_code": source_code or "exchange",
                "source_class": source_class,
                "error": f"交易所官方资料处理异常：{type(error).__name__}: {error}"}


def _fetch_cninfo_placing_result(stock_code, issue_scale, bond_code=None, stock_name=None, listing_date=None):
    """交易所未能形成结果时，从 CNINFO 查询同一份上市公告书作为兜底。"""
    source_code = "cninfo_announcements"
    source_class = "cninfo_listing_book"
    try:
        org_id = _get_org_id(stock_code)
        if not org_id:
            return {
                "status": "error", "source_code": source_code, "source_class": source_class,
                "error": f"巨潮资讯网无法获取股票{stock_code}的orgId",
            }

        url = "https://www.cninfo.com.cn/new/hisAnnouncement/query"
        try:
            listing_dt = datetime.strptime(str(listing_date)[:10], "%Y-%m-%d") if listing_date else None
        except ValueError:
            listing_dt = None
        today = datetime.now()
        start_dt = listing_dt - timedelta(days=60) if listing_dt else today - timedelta(days=3650)
        end_dt = listing_dt + timedelta(days=180) if listing_dt else today
        start_date, end_date = start_dt.strftime("%Y-%m-%d"), end_dt.strftime("%Y-%m-%d")
        plate = "sz" if str(stock_code).startswith(("0", "3")) else "sh"

        announcements = []
        cn_session = _get_cninfo_session()
        try:
            seen = set()
            page_size = 30
            total_announcement = None
            page_num = 1
            seen_pages = set()
            while True:
                data = {
                    "pageNum": page_num, "pageSize": page_size,
                    "stock": f"{stock_code},{org_id}",
                    "tabName": "fulltext", "column": "szse" if plate == "sz" else "shse",
                    "plate": plate, "seDate": f"{start_date}~{end_date}",
                }
                page_items = None
                for attempt in range(3):
                    try:
                        resp = cn_session.post(url, data=data, timeout=20)
                        result = resp.json()
                        page_items = result.get("announcements") or []
                        total_announcement = result.get("totalAnnouncement") or result.get("totalRecordNum")
                        break
                    except Exception as error:
                        if attempt == 2:
                            raise error
                        time.sleep(2)
                for ann in page_items or []:
                    key = (ann.get("announcementId"), ann.get("adjunctUrl"), ann.get("announcementTitle"))
                    if key not in seen:
                        seen.add(key)
                        announcements.append(ann)
                page_signature = tuple(str(ann.get("announcementId") or ann.get("adjunctUrl") or ann.get("announcementTitle") or "") for ann in page_items or [])
                if page_signature and page_signature in seen_pages:
                    break
                if page_signature:
                    seen_pages.add(page_signature)
                if not page_items:
                    break
                if total_announcement is not None and len(seen) >= int(total_announcement):
                    break
                page_num += 1
        finally:
            cn_session.close()

        listing_target = None
        issue_result_targets = []
        for ann in announcements:
            title = str(ann.get("announcementTitle") or "")
            normalized_title = re.sub(r"\s+", "", title)
            if "上市公告书" in normalized_title and ("可转换" in normalized_title or "可转债" in normalized_title):
                listing_target = ann
                break
        for ann in announcements:
            title = str(ann.get("announcementTitle") or "")
            if (("中签" in title and "配售" in title) or "发行结果" in title) and ann.get("adjunctUrl"):
                issue_result_targets.append(ann)
        issue_result_targets.sort(
            key=lambda ann: 0 if "中签率" in ann.get("announcementTitle", "")
            and "配售" in ann.get("announcementTitle", "") else 1
        )

        issue_texts = []
        # 巨潮结果公告同样不得按固定条数截断，避免前几份无法解析时漏掉有效版本。
        for candidate in issue_result_targets:
            issue_text, _error = _download_cninfo_pdf_text(candidate)
            if issue_text:
                issue_texts.append(issue_text)

        if listing_target:
            text, download_error = _download_cninfo_pdf_text(listing_target)
            if text:
                return _parse_exchange_listing_book(
                    text, issue_scale, source_code, issue_texts,
                    source_name="巨潮资讯网", source_class="cninfo_listing_book",
                    issue_source_class="cninfo_issue_result",
                )
            if issue_texts:
                for issue_text in issue_texts:
                    result = _parse_issue_result_liquidity(
                        issue_text, issue_scale, source_code,
                        "cninfo_issue_result", "巨潮资讯网",
                    )
                    if result:
                        return result
            return {
                "status": "error", "source_code": source_code, "source_class": source_class,
                "error": download_error or "巨潮资讯网上市公告书未能提取正文",
            }

        for issue_text in issue_texts:
            result = _parse_issue_result_liquidity(
                issue_text, issue_scale, source_code,
                "cninfo_issue_result", "巨潮资讯网",
            )
            if result:
                return result
        return {
            "status": "error", "source_code": source_code, "source_class": "cninfo_issue_result",
            "error": "巨潮资讯网未找到或未解析出上市公告书/发行结果公告",
        }
    except ExternalCallGuardError as error:
        return {
            "status": "error", "source_code": source_code, "source_class": source_class,
            "error": f"CNINFO 兜底接口受限：{error}",
        }
    except Exception as error:
        return {
            "status": "error", "source_code": source_code, "source_class": source_class,
            "error": f"CNINFO 兜底资料处理异常：{type(error).__name__}: {error}",
        }


def fetch_placing_result(stock_code, issue_scale, bond_code=None, stock_name=None, listing_date=None):
    """交易所优先，交易所未形成结果时以 CNINFO 上市公告书作为兜底。"""
    exchange_result = _fetch_exchange_placing_result(
        stock_code, issue_scale, bond_code=bond_code,
        stock_name=stock_name, listing_date=listing_date,
    )
    if exchange_result and exchange_result.get("status") == "ok":
        return exchange_result

    cninfo_result = _fetch_cninfo_placing_result(
        stock_code, issue_scale, bond_code=bond_code,
        stock_name=stock_name, listing_date=listing_date,
    )
    if exchange_result:
        cninfo_result.setdefault("exchange_error", exchange_result.get("error"))
        cninfo_result.setdefault("exchange_source_code", exchange_result.get("source_code"))
        if exchange_result.get("listing_notice"):
            cninfo_result.setdefault("listing_notice", exchange_result.get("listing_notice"))
    return cninfo_result

def calc_circulation_scale(info, bond_code=None):
    """
    从交易所官方上市公告书获取可转债精确流通规模。

    精确方法：从上交所/深交所官方 PDF 解析“前十名可转换公司债券持有人”表格，
    提取控股股东+实控人+一致行动人的配售量为限售依据。

    若获取失败，不返回估算值，而是记录明确失败原因。
    """
    scale = float(info.get("issue_scale", 0))
    if scale <= 0:
        return

    stock_code = info.get("stock_code", "")
    if not stock_code:
        info["_note"] = "缺少正股代码，无法查询上市公告书"
        return

    resolved_bond_code = bond_code or info.get("bond_code")
    try:
        cached = get_listing_liquidity(resolved_bond_code)
    except Exception as error:
        cached = None
        print(f"读取流通规模缓存失败({resolved_bond_code}): {error}")
    # 旧版本可能留下巨潮来源缓存；普通补全必须重新走交易所，成功后覆盖旧事实。
    # 数据库只读模式仍可展示旧事实，但不会发起任何外部请求。
    cached_source = str((cached or {}).get("source_code") or "").lower()
    if cached and (cached_source in {"sse", "szse"} or os.environ.get("IPO_REPORT_DATABASE_ONLY") == "1"):
        info["lock_scale"] = float(cached["lock_scale"])
        info["circulation_scale"] = float(cached["circulation_scale"])
        source_detail = cached.get("source_detail") or {}
        info["_note"] = source_detail.get("source") or "上市公告书（数据库缓存）"
        info["_circulation_source"] = cached.get("source_code") or "cninfo_announcements"
        return

    if os.environ.get("IPO_REPORT_DATABASE_ONLY") == "1":
        info["_note"] = "⚠️ 尚无已入库上市流通规模，日报只读数据库，不在生成阶段请求公告源"
        info["_circulation_error"] = "database_fact_missing"
        return

    placing = fetch_placing_result(
        stock_code,
        scale,
        bond_code=resolved_bond_code,
        stock_name=info.get("stock_name"),
        listing_date=info.get("list_date"),
    )
    notice = placing.get("listing_notice") if placing else None
    if notice:
        info["_official_listing_notice"] = {
            key: notice.get(key)
            for key in (
                "bond_code", "bond_name", "announcement_date", "listing_date",
                "announcement_number", "url", "source_code", "source_name", "source_class",
            )
        }
        info["_listing_source"] = notice.get("source_code")
        if not info.get("list_date") and notice.get("listing_date"):
            info["list_date"] = notice["listing_date"]
    if placing and placing.get("status") == "ok":
        info["lock_scale"] = placing["lock_scale"]
        info["circulation_scale"] = placing["circulation_scale"]
        info["_note"] = placing["source"]
        info["_circulation_source"] = placing.get("source_class", "exchange_listing_book")
        try:
            save_listing_liquidity(resolved_bond_code, placing, info.get("list_date"))
        except Exception as error:
            print(f"保存流通规模缓存失败({resolved_bond_code}): {error}")
    else:
        error_msg = placing.get("error", "查询失败（未知错误）") if placing else "接口无返回"
        info["_note"] = f"⚠️ 可转债公告解析失败：{error_msg}"
        info["_circulation_error"] = error_msg

def calculate_conversion_metrics(stock_price, convert_price, bond_price=None):
    """用同一时点的正股/转债价格计算转股价值和转股溢价率。"""
    cp = float(convert_price)
    sp = float(stock_price)
    transfer_value = round(100 / cp * sp, 2)
    if bond_price is None or transfer_value <= 0:
        return transfer_value, None
    premium_ratio = round((float(bond_price) / transfer_value - 1) * 100, 2)
    return transfer_value, premium_ratio


def _parse_tencent_bond_price(content, bond_code):
    """解析并校验腾讯可转债行情，响应固定按 GBK 解码。"""
    code = re.sub(r"\D", "", str(bond_code))[:6]
    text = content.decode("gbk", "replace") if isinstance(content, bytes) else str(content or "")
    match = re.search(r'v_(?:sh|sz)(\d{6})="([^"]*)"', text)
    if not match or match.group(1) != code:
        return None
    parts = match.group(2).split("~")
    if len(parts) <= 3 or parts[2] != code:
        return None
    try:
        price = float(parts[3])
    except (TypeError, ValueError):
        return None
    return price if price > 0 else None


def _fetch_bond_price(bond_code, list_date):
    """读取最近已入库可转债收盘价；未上市债券使用面值100。"""
    code = re.sub(r"\D", "", str(bond_code))[:6]
    if code in _bond_price_cache:
        return _bond_price_cache[code]

    # 判断是否已上市
    is_listed = False
    if list_date:
        try:
            ld = datetime.strptime(str(list_date)[:10], "%Y-%m-%d")
            if ld <= datetime.now():
                is_listed = True
        except Exception:
            pass

    if is_listed:
        try:
            conn = _init_ipo_db()
            row = conn.execute(
                """SELECT m.close FROM market.convertible_bond_daily_metrics m
                     JOIN core.instruments i ON i.instrument_id=m.instrument_id
                    WHERE split_part(i.canonical_code,'.',1)=? AND m.close>0
                    ORDER BY m.trade_date DESC,m.source_id DESC LIMIT 1""",
                (code,),
            ).fetchone()
            conn.close()
            price = float(row[0]) if row and row[0] is not None else None
            if price and price > 0:
                _bond_price_cache[code] = price
                _bond_price_source[code] = "database"
                return price
        except Exception:
            pass
        return None

    # 未上市债券尚无市场成交价，申购报告按面值100计算参考溢价率。
    _bond_price_cache[code] = 100
    _bond_price_source[code] = "face_value"
    return 100

def fetch_stock_quote(stock_code):
    """读取正股最近已入库行情和估值。"""
    if stock_code in _stock_quote_cache:
        return _stock_quote_cache[stock_code]

    try:
        conn = _init_ipo_db()
        row = conn.execute(
            """SELECT b.close,v.pe_ttm,v.pb,v.total_market_cap
                 FROM core.instruments i
                 LEFT JOIN LATERAL (
                   SELECT close,trade_date FROM market.daily_bars
                    WHERE instrument_id=i.instrument_id ORDER BY trade_date DESC,source_id DESC LIMIT 1
                 ) b ON true
                 LEFT JOIN LATERAL (
                   SELECT pe_ttm,pb,total_market_cap FROM market.daily_valuations
                    WHERE instrument_id=i.instrument_id ORDER BY trade_date DESC,source_id DESC LIMIT 1
                 ) v ON true
                WHERE split_part(i.canonical_code,'.',1)=? AND i.asset_class='stock' LIMIT 1""",
            (str(stock_code or "").split(".")[0],),
        ).fetchone()
        conn.close()
        if not row or row[0] is None:
            return None
        result = {
            "price": float(row[0]), "pe": float(row[1]) if row[1] is not None else None,
            "pb": float(row[2]) if row[2] is not None else None, "roe": None,
            "market_cap": float(row[3]) / 10000 if row[3] is not None else None,
            "industry": "",
        }
        _stock_quote_cache[stock_code] = result
        return result
    except Exception as error:
        print(f"数据库行情读取失败({stock_code}): {error}")
        return None

def _fetch_stock_industry(stock_code):
    """从 Tushare stock_basic 获取行业信息（替代东财）"""
    try:
        pro = _get_tushare_pro()
        if not pro:
            return ""
        ts_code = _to_ts_code(stock_code)
        df = pro.stock_basic(ts_code=ts_code, fields="ts_code,industry,name")
        if df is not None and not df.empty:
            name = df.iloc[0].get("name")
            if name:
                _STOCK_NAME_CACHE[str(stock_code or '').split('.')[0]] = str(name).strip()
            ind = df.iloc[0].get("industry")
            if ind:
                return str(ind)
    except ExternalCallGuardError:
        raise
    except Exception:
        pass
    return ""

# 赛道判定用关键词（与 ipo_lib_sector 中的 NEW_STOCK_HOT_SECTORS/HOT_SECTOR_KEYWORDS 对应，
# 此处本地复制一份以避免与 ipo_lib_fetch 形成循环导入）。
_SECTOR_KW = set(
    "PCB 印制电路板 半导体 芯片 集成电路 先进封装 光子 光通信 光纤 AI 人工智能 算力 GPU 机器人 "
    "人形机器人 具身智能 低空经济 飞行汽车 航天 航空 储能 新能源 光伏 锂电池 "
    "创新药 医疗器械 生物医药 新材料 高端装备 精密制造 军工 自动驾驶 智能驾驶 "
    "电力设备 轨道交通 核电 数字经济 数据要素 云计算 氢能 钠离子 固态电池 "
    "消费电子 汽车电子".split()
)


def _has_sector_keyword(text):
    """文本是否含赛道关键词（用于判断主营业务是否足以做赛道判定）。"""
    if not text:
        return False
    normalized = str(text).upper()
    return any(k.upper() in normalized for k in _SECTOR_KW)


def _extract_main_business(text):
    """从招股书PDF全文提取主营业务描述与所属行业（启发式）。

    优先取『公司专业/主要从事』正文整句，并附招股书里的行业赛道分类，
    供报告展示和赛道判定使用。招股书目录也会出现“主营业务/所属行业”，
    因此不能直接取首次匹配结果。
    """
    # PyMuPDF 常在句子中间插入换行，先折叠空白让句子连续，避免正则截断。
    text = re.sub(r'\s+', ' ', str(text or '')).strip()

    def clean_candidate(value):
        value = re.sub(r'\s+', '', str(value or '')).strip('：:，,；;')
        # 目录中的省略点和财务章节标题是本次高凯技术误读的根源，直接丢弃。
        if not value or re.search(r'\.{3,}|…{2,}|财务数据|财务指标|目录|报告期的主要', value):
            return ''
        if not re.search(r'研发|生产|销售|制造|提供|经营|产品|设备|材料|服务|控制|从事', value):
            return ''
        return value

    # 正文优先：公司“专业从事”是科创板招股书最稳定的主营业务表述。
    # 每种句式都遍历候选，避免首个匹配落在目录或风险提示章节。
    biz = ''
    for pat in [
        r'(?:公司|发行人)专业从事\s*([^。；;]{8,1000})',
        r'(?:公司|发行人)主要从事\s*([^。；;]{8,1000})',
        r'(?:公司|发行人)专门从事\s*([^。；;]{8,1000})',
        r'(?:公司|发行人)?业务(?:聚焦于|集中于|专注于)\s*([^。；;]{8,1000})',
        r'(?:公司|发行人)(?:的)?核心业务[为是：:]\s*([^。；;]{8,1000})',
        r'(?:公司|发行人)主营业务[为是：:]\s*([^。；;]{8,1000})',
        r'主营业务[为：:]\s*([^。；;]{8,1000})',
    ]:
        for m in re.finditer(pat, text):
            biz = clean_candidate(m.group(1))
            if biz:
                break
        if biz:
            break

    # 行业赛道优先取“所属行业领域”勾选项，例如“√高端装备”；
    # 再取“主要业务领域属于……”等明确分类，最后才回退到标准行业名称。
    ind = ''
    checked = re.search(
        r'所属行业领域.{0,180}?[√✓✔☑]\s*([^\s□■☐☒]{2,24})',
        text,
    )
    if checked:
        ind = checked.group(1).strip('，。；;：:')

    if not ind:
        sector = re.search(
            r'(?:主要业务领域|所处行业领域)属于[^。；;]{0,80}?["“]?'
            r'(?:\d+(?:\.\d+)?\s*)?(高端装备|新一代信息技术|新材料|新能源|节能环保|生物医药|半导体|集成电路)',
            text,
        )
        if sector:
            ind = sector.group(1)

    if not ind:
        classification = re.search(
            r'(?:公司|发行人)(?:从事的)?主营业务(?:所处|所属)行业(?:为|属于)[：:、“"]?'
            r'(?:[A-Z]\d{2,4}\s*)?([^。；;，,」”"]{2,40})',
            text,
        )
        if classification:
            ind = classification.group(1).strip()

    if not ind:
        standard = re.search(
            r'(?:公司|发行人)(?:所处|所属)行业(?:为|属于)[：:、“"]?'
            r'([^。；;，,」”"]{2,40})',
            text,
        )
        if standard:
            ind = re.sub(r'^C\d+\s*', '', standard.group(1)).strip()

    if ind:
        ind = re.sub(r'\s+', '', ind).strip('，。；;：:')[:40]
        if not ind or re.search(r'财务|报告期|目录|情况良好', ind):
            ind = ''
    if biz and ind:
        return f"{biz}；所属行业：{ind}"
    return biz or ind or None


def _parse_jsonp_payload(text):
    """解析交易所公开接口的 JSON/JSONP 响应。"""
    raw = str(text or '').strip()
    if not raw:
        return None
    if raw.startswith('{') or raw.startswith('['):
        try:
            return json.loads(raw)
        except (TypeError, ValueError):
            return None
    left = raw.find('(')
    right = raw.rfind(')')
    if left < 0 or right <= left:
        return None
    try:
        return json.loads(raw[left + 1:right])
    except (TypeError, ValueError):
        return None


def _stock_name_from_database(stock_code):
    """交易所按简称检索时，优先复用已入库 IPO 主档名称，不重复请求上游。"""
    code = str(stock_code or '').split('.')[0]
    if not code:
        return ''
    if _STOCK_NAME_CACHE.get(code):
        return _STOCK_NAME_CACHE[code]
    try:
        conn = _init_ipo_db()
        row = conn.execute(
            "SELECT security_name FROM ipo_history WHERE security_code=? LIMIT 1", (code,)
        ).fetchone()
        conn.close()
        name = str(row[0] or '').strip() if row else ''
        if name:
            _STOCK_NAME_CACHE[code] = name
        return name
    except Exception:
        return ''


def _download_exchange_pdf_text(session, pdf_url, source):
    """下载交易所 PDF；挑战页/HTML 不视为成功，交由巨潮继续兜底。"""
    if not pdf_url:
        return None
    try:
        cached_text = _cached_pdf_text(pdf_url)
        if cached_text:
            return cached_text
        response = session.get(
            pdf_url,
            timeout=30,
            headers={
                'User-Agent': HEADERS['User-Agent'],
                'Referer': {
                    'sse': 'https://www.sse.com.cn/ipo/',
                    'szse': 'https://www.szse.cn/listing/disclosure/ipo/index.html',
                    'bse': 'https://www.bse.cn/issue/issue_disclosure.html',
                    'cninfo': 'https://www.cninfo.com.cn/',
                }.get(source, 'https://www.cninfo.com.cn/'),
                'Accept': 'application/pdf,*/*',
            },
        )
        content = response.content or b''
        if int(response.status_code or 0) != 200 or not content.lstrip().startswith(b'%PDF'):
            return None
        _put_pdf_cache(pdf_url, content)
        doc = fitz.open(stream=content, filetype='pdf')
        text = ''.join(page.get_text() for page in doc)
        doc.close()
        return text or None
    except ExternalCallGuardError:
        # 交易所主源失败时必须继续走巨潮备源；主源熔断仍由 Guard 留痕。
        if source in {'sse', 'szse', 'bse'}:
            return None
        raise
    except Exception:
        return None


def _exchange_market_for_code(code):
    """按证券代码前缀选择 IPO 招股书交易所；北交所 92 开头必须优先于上交所 9 开头。"""
    digits = re.sub(r'\D', '', str(code or ''))
    if digits.startswith('92') or digits.startswith(('4', '8')):
        return 'bse'
    if digits.startswith(('6', '9')):
        return 'sse'
    if digits.startswith(('0', '3')):
        return 'szse'
    return ''


def _ipo_document_role(title):
    """识别 IPO 官方文件角色；提示性公告不能作为正文来源。"""
    normalized = re.sub(r'\s+', '', str(title or ''))
    if not normalized or '提示性' in normalized:
        return ''
    if '招股说明书' in normalized or '招股意向书' in normalized:
        return 'prospectus'
    if ('发行结果' in normalized or '中签率公告' in normalized
            or '配售结果及网上中签结果' in normalized):
        return 'issuance_result'
    if '投资风险特别公告' in normalized:
        return 'issuance_risk_announcement'
    if ('发行公告' in normalized and '发行安排' not in normalized
            and '投资风险' not in normalized):
        return 'issuance_announcement'
    return ''


def _exchange_ipo_document_candidates(stock_code, security_name=''):
    """返回交易所官方 IPO 文件候选：(source, url, title, role, date)。"""
    code = str(stock_code or '').split('.')[0]
    if not code:
        return []
    digits = re.sub(r'\D', '', code)
    market = _exchange_market_for_code(digits)
    if not market:
        return []
    cache_key = (market, digits, str(security_name or '').strip())
    if cache_key in _EXCHANGE_IPO_DOCUMENT_CACHE:
        return list(_EXCHANGE_IPO_DOCUMENT_CACHE[cache_key])
    today = datetime.now()
    start = (today - timedelta(days=365 * 5)).strftime('%Y-%m-%d')
    end = today.strftime('%Y-%m-%d')
    candidates = []
    session = requests.Session()
    session.headers.update({'User-Agent': HEADERS['User-Agent']})
    try:
        if market == 'sse':
            response = session.get(
                'https://query.sse.com.cn/security/stock/queryCompanyBulletinNew.do',
                params={
                    'jsonCallBack': 'ipoExchangeCallback', 'isPagination': 'true',
                    'SECURITY_CODE': digits, 'BULLETIN_TYPE': '08',
                    'pageHelp.pageSize': 30, 'pageHelp.cacheSize': 1,
                    'pageHelp.pageNo': 1,
                },
                timeout=20,
                headers={'Referer': 'https://www.sse.com.cn/ipo/', 'Accept': 'application/json'},
            )
            payload = _parse_jsonp_payload(response.text)
            groups = (payload or {}).get('result') or (payload or {}).get('pageHelp', {}).get('data') or []
            rows = []
            for group in groups:
                rows.extend(group if isinstance(group, list) else [group])
            for row in rows:
                if str(row.get('SECURITY_CODE') or '') != digits:
                    continue
                title = str(row.get('TITLE') or '')
                role = _ipo_document_role(title)
                if not role:
                    continue
                path = str(row.get('URL') or '')
                if not path:
                    continue
                url = _exchange_document_url(path, 'sse')
                candidates.append(('sse', url, title, role, str(row.get('SSEDATE') or '')[:10]))
        elif market == 'szse':
            keyword = str(security_name or '').strip() or code
            response = session.get(
                'https://www.szse.cn/api/ras/infodisc/query',
                params={
                    'pageIndex': 0, 'pageSize': 100, 'keywords': keyword,
                    'disclosedStartDate': start, 'disclosedEndDate': end,
                    'catalog': '', 'bizType': 1, 'boardCode': '', 'biztypsb': '',
                    'random': str(time.time()),
                },
                timeout=20,
                headers={'Referer': 'https://www.szse.cn/listing/disclosure/ipo/index.html', 'Accept': 'application/json'},
            )
            payload = _parse_jsonp_payload(response.text) or {}
            for item in payload.get('data') or []:
                for sub in item.get('subInfoDisclosureList') or []:
                    title = str(sub.get('dfnm') or sub.get('configFileName') or '')
                    role = _ipo_document_role(title)
                    if not role:
                        continue
                    path = str(sub.get('dfpth') or sub.get('url') or '')
                    if not path:
                        continue
                    if path.startswith('http'):
                        url = path
                    elif path.startswith('/UpFiles/'):
                        url = 'https://reportdocs.static.szse.cn' + path
                    else:
                        url = 'https://www.szse.cn' + path
                    announced_at = str(sub.get('ddtime') or sub.get('publishTime') or '')[:10]
                    candidates.append(('szse', url, title, role, announced_at))
        else:
            fields = ('companyCd', 'companyName', 'disclosureTitle', 'disclosurePostTitle',
                      'destFilePath', 'publishDate', 'xxfcbj', 'fileExt')
            form = [
                ('disclosureType', '9533'), ('disclosureTypes', '9533'),
                ('page', '0'), ('companyCd', digits), ('fileName', ''),
                ('inquiryList', ''), ('startTime', start), ('endTime', end),
                ('keyword', ''), ('isLink', '1'), ('callback', 'ipoExchangeCallback'),
            ]
            form.extend(('needFields', field) for field in fields)
            response = session.post(
                'https://www.bse.cn/disclosureInfoController/zoneInfoResult.do',
                data=form,
                timeout=20,
                headers={'Referer': 'https://www.bse.cn/issue/issue_disclosure.html', 'Accept': 'application/javascript'},
            )
            payload = _parse_jsonp_payload(response.text)
            groups = (payload[0] if isinstance(payload, list) and payload else payload) or {}
            for row in (groups.get('listInfo') or {}).get('content') or []:
                title = str(row.get('disclosureTitle') or '') + str(row.get('disclosurePostTitle') or '')
                role = _ipo_document_role(title)
                if not role:
                    continue
                path = str(row.get('destFilePath') or '')
                if not path:
                    continue
                url = path if path.startswith('http') else 'https://www.bse.cn' + path
                candidates.append(('bse', url, title, role, str(row.get('publishDate') or '')[:10]))
    finally:
        session.close()
    # 同一版本可能在接口中重复出现；按日期/返回顺序去重，最新版本优先。
    seen = set()
    result = []
    for source, url, title, role, announced_at in candidates:
        if url in seen:
            continue
        seen.add(url)
        result.append((source, url, title, role, announced_at))
    _EXCHANGE_IPO_DOCUMENT_CACHE[cache_key] = list(result)
    return result


def _exchange_prospectus_candidates(stock_code, security_name=''):
    """返回交易所官方招股说明书候选：(source, url, title)。"""
    return [
        (source, url, title)
        for source, url, title, role, _announced_at
        in _exchange_ipo_document_candidates(stock_code, security_name)
        if role == 'prospectus'
    ]


def _exchange_issuance_announcement_candidates(stock_code, security_name=''):
    """返回交易所官方发行/风险公告候选：(source, url, title, date)。"""
    return [
        (source, url, title, announced_at)
        for source, url, title, role, announced_at
        in _exchange_ipo_document_candidates(stock_code, security_name)
        if role in {'issuance_announcement', 'issuance_risk_announcement'}
    ]


def _cninfo_ipo_issuance_candidates(stock_code):
    """交易所列表未命中时，从已准入的巨潮公告入口查 IPO 发行/风险公告。"""
    code = str(stock_code or '').split('.')[0]
    if not code:
        return []
    if code in _CNINFO_IPO_ISSUANCE_CACHE:
        return list(_CNINFO_IPO_ISSUANCE_CACHE[code])

    org_id = _get_org_id(code)
    if not org_id:
        _CNINFO_IPO_ISSUANCE_CACHE[code] = []
        return []

    today = datetime.now()
    start = (today - timedelta(days=365 * 5)).strftime('%Y-%m-%d')
    end = today.strftime('%Y-%m-%d')
    market = _exchange_market_for_code(code)
    # CNINFO 查询接口已在深/沪市场发行资料链路验证；北交所继续使用交易所主源。
    column, plate = {'szse': ('szse', 'sz'), 'sse': ('shse', 'sh')}.get(market, ('', ''))
    if not column:
        _CNINFO_IPO_ISSUANCE_CACHE[code] = []
        return []
    session = requests.Session()
    session.headers.update({
        'User-Agent': HEADERS['User-Agent'],
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': 'https://www.cninfo.com.cn/',
    })
    candidates = []
    page = 1
    page_size = 30
    seen_pages = set()
    try:
        while True:
            response = session.post(
                'https://www.cninfo.com.cn/new/hisAnnouncement/query',
                data={
                    'pageNum': page, 'pageSize': page_size,
                    'stock': f'{code},{org_id}', 'tabName': 'fulltext',
                    'column': column, 'plate': plate,
                    'seDate': f'{start}~{end}',
                },
                timeout=20,
            )
            response.raise_for_status()
            payload = response.json()
            announcements = payload.get('announcements') or []
            total = int(payload.get('totalAnnouncement') or 0)
            if not announcements:
                if total >= page * page_size:
                    raise RuntimeError('CNINFO IPO 公告分页不完整')
                break
            signature = tuple(
                str(item.get('announcementId') or item.get('adjunctUrl') or '')
                for item in announcements
            )
            if signature in seen_pages:
                raise RuntimeError('CNINFO IPO 公告分页重复')
            seen_pages.add(signature)
            for item in announcements:
                title = str(item.get('announcementTitle') or '')
                role = _ipo_document_role(title)
                if role not in {'issuance_announcement', 'issuance_risk_announcement'}:
                    continue
                adjunct = str(item.get('adjunctUrl') or '').strip()
                if not adjunct:
                    continue
                url = adjunct if adjunct.startswith(('http://', 'https://')) else (
                    f'https://static.cninfo.com.cn/{adjunct.lstrip("/")}'
                )
                date_match = re.search(r'/finalpage/(\d{4}-\d{2}-\d{2})/', url)
                announced_at = date_match.group(1) if date_match else str(
                    item.get('announcementTime') or ''
                )[:10]
                candidates.append(('cninfo', url, title, announced_at))
            if total and page * page_size >= total:
                break
            page += 1
    finally:
        session.close()

    _CNINFO_IPO_ISSUANCE_CACHE[code] = list(candidates)
    return candidates


def _exchange_issuance_result_candidates(stock_code, security_name=''):
    """返回交易所官方发行结果公告候选：(source, url, title, date)。"""
    return [
        (source, url, title, announced_at)
        for source, url, title, role, announced_at
        in _exchange_ipo_document_candidates(stock_code, security_name)
        if role == 'issuance_result'
    ]


def _parse_ipo_issuance_detail(text):
    """从 IPO 发行公告提取公告直接披露的行业和行业市盈率。"""
    compact = re.sub(r'\s+', '', str(text or ''))
    if not compact:
        return {}

    industry = ''
    for pattern in (
        r'所属行业名称及行业代码[：:]?([^（）()，。；;]{2,40})[（(][A-Z]\d{2,4}[）)]',
        r'(?:发行人|公司)所属行业为[：:“"]?([^（）()，。；;]{2,40})[（(][A-Z]\d{2,4}[）)]',
        r'(?:发行人|公司)从事的主营业务所属行业为[：:“"]?(?:[A-Z]\d{2,4})?([^”"，。；;]{2,40})',
    ):
        match = re.search(pattern, compact)
        if match:
            industry = match.group(1).strip('：:，,。；;“”"')
            break

    industry_pe = None
    pe_match = None
    for pattern in (
        r'所属行业T-?\d+日静态行业市盈率[：:]?(\d+(?:\.\d+)?)',
        r'(?:该行业|所处行业|发行人所属行业|公司所属行业)最近一个月平均静态市盈率(?:为|[：:])?(\d+(?:\.\d+)?)倍?',
        r'(?:中证指数有限公司发布的)?[^。；;]{0,160}?最近一个月平均静态市盈率(?:为|[：:])?(\d+(?:\.\d+)?)倍?',
    ):
        pe_match = re.search(pattern, compact)
        if pe_match:
            value = float(pe_match.group(1))
            if 0 < value < 10000:
                industry_pe = value
                break

    result = {}
    if industry:
        result['industry'] = industry[:80]
    if industry_pe is not None:
        result['industry_pe'] = industry_pe
        if pe_match:
            context_start = max(0, pe_match.start() - 180)
            context = compact[context_start:pe_match.end(1)]
            dates = list(re.finditer(r'截至(20\d{2})年(\d{1,2})月(\d{1,2})日', context))
            if dates:
                date = dates[-1]
                result['industry_pe_as_of'] = (
                    f'{date.group(1)}-{int(date.group(2)):02d}-{int(date.group(3)):02d}'
                )
    if '尚未盈利' in compact:
        result['issuer_unprofitable'] = True
    return result


def _fetch_exchange_ipo_issuance_detail(stock_code, security_name=''):
    """交易所主源、巨潮备源：提取 IPO 行业 PE 和发行人盈利状态。"""
    code = str(stock_code or '').split('.')[0]
    if code in _IPO_ISSUANCE_DETAIL_CACHE:
        return dict(_IPO_ISSUANCE_DETAIL_CACHE[code])
    try:
        candidates = _exchange_issuance_announcement_candidates(
            code, security_name or _stock_name_from_database(code)
        )
        discovered_count = len(candidates)
        downloaded = 0
        parsed_detail = {}
        session = requests.Session()
        session.headers.update({'User-Agent': HEADERS['User-Agent']})
        try:
            # 先查官方交易所。只有未提取到目标字段时，才走已登记的巨潮备源。
            candidate_groups = [('exchange', candidates)]
            for source, candidate_list in candidate_groups:
                if source == 'cninfo':
                    discovered_count += len(candidate_list)
                for candidate_source, url, title, announced_at in candidate_list:
                    text = _download_exchange_pdf_text(session, url, candidate_source)
                    if text:
                        downloaded += 1
                    extracted = _parse_ipo_issuance_detail(text)
                    if not extracted:
                        continue
                    role = _ipo_document_role(title)
                    parsed_detail.update(extracted)
                    parsed_detail.update({
                        'ipo_announcement_source': candidate_source,
                        'ipo_announcement_role': role,
                        'ipo_announcement_url': url,
                        'ipo_announcement_title': title,
                        'ipo_announcement_date': announced_at or None,
                        'ipo_announcement_content_hash': hashlib.sha256(
                            str(text or '').encode('utf-8')
                        ).hexdigest(),
                        'ipo_announcement_parser_version': 'ipo-issuance-facts-v2',
                    })
                    if parsed_detail.get('industry_pe') is not None:
                        break
                if parsed_detail.get('industry_pe') is not None:
                    break
                if source == 'exchange':
                    candidate_groups.append(('cninfo', _cninfo_ipo_issuance_candidates(code)))
        finally:
            session.close()
        if not discovered_count:
            _IPO_ISSUANCE_DETAIL_DIAGNOSTIC[code] = {
                'status': 'document_not_found',
                'reason': 'no_issuance_or_risk_announcement_candidate_found',
            }
            _IPO_ISSUANCE_DETAIL_CACHE[code] = {}
            return {}
        if parsed_detail:
            _IPO_ISSUANCE_DETAIL_DIAGNOSTIC[code] = {
                'status': 'value' if parsed_detail.get('industry_pe') is not None else 'document_field_absent',
                'reason': None if parsed_detail.get('industry_pe') is not None else 'issuance_announcement_has_no_industry_pe',
                'source': parsed_detail.get('ipo_announcement_source'),
                'as_of': parsed_detail.get('industry_pe_as_of'),
                'document_role': parsed_detail.get('ipo_announcement_role'),
            }
            _IPO_ISSUANCE_DETAIL_CACHE[code] = dict(parsed_detail)
            return parsed_detail
    except ExternalCallGuardError:
        _IPO_ISSUANCE_DETAIL_DIAGNOSTIC[code] = {
            'status': 'source_unavailable',
            'reason': 'issuance_announcement_source_guarded',
        }
        raise
    except Exception:
        _IPO_ISSUANCE_DETAIL_DIAGNOSTIC[code] = {
            'status': 'source_unavailable',
            'reason': 'issuance_announcement_source_error',
        }
    _IPO_ISSUANCE_DETAIL_CACHE[code] = {}
    if code not in _IPO_ISSUANCE_DETAIL_DIAGNOSTIC:
        _IPO_ISSUANCE_DETAIL_DIAGNOSTIC[code] = {
            'status': 'document_parse_failed' if downloaded else 'document_unavailable',
            'reason': 'document_found_but_parser_found_no_industry_pe' if downloaded else 'document_download_failed',
        }
    return {}


def _parse_ipo_issuance_result_detail(text):
    """从发行结果/中签率公告提取网上有效申购倍数和最终中签率。"""
    compact = re.sub(r'\s+', '', str(text or '')).replace(',', '').replace('，', '')
    if not compact:
        return {}

    result = {}
    # 发行结果公告通常披露的是“网上发行初步有效申购倍数”；若公告给出最终
    # 有效倍数则优先采用最终口径。不要把网下机构认购倍数混入该字段。
    for pattern in (
        r'网上发行最终有效申购倍数(?:约为|为|约)?(\d+(?:\.\d+)?)倍',
        r'网上投资者最终有效申购倍数(?:约为|为|约)?(\d+(?:\.\d+)?)倍',
        r'网上发行初步有效申购倍数(?:约为|为|约)?(\d+(?:\.\d+)?)倍',
        r'网上投资者有效申购倍数(?:约为|为|约)?(\d+(?:\.\d+)?)倍',
        r'网上有效申购倍数(?:约为|为|约)?(\d+(?:\.\d+)?)倍',
    ):
        match = re.search(pattern, compact)
        if match:
            value = float(match.group(1))
            if 0 < value < 1000000:
                result['oversubscribe_multiple'] = value
                break

    for pattern in (
        r'网上发行最终中签率(?:为|约为|约)?(\d+(?:\.\d+)?)%',
        r'回拨机制启动后网上发行最终中签率(?:为|约为|约)?(\d+(?:\.\d+)?)%',
        r'网上初步中签率(?:为|约为|约)?(\d+(?:\.\d+)?)%',
        r'网上发行中签率(?:为|约为|约)?(\d+(?:\.\d+)?)%',
    ):
        match = re.search(pattern, compact)
        if match:
            value = float(match.group(1))
            if 0 < value < 100:
                result['online_lottery_rate'] = value
                break
    return result


def _fetch_exchange_ipo_issuance_result_detail(stock_code, security_name=''):
    """交易所发行结果主源：读取网上有效申购倍数和中签率。"""
    code = str(stock_code or '').split('.')[0]
    if code in _IPO_ISSUANCE_RESULT_DETAIL_CACHE:
        return dict(_IPO_ISSUANCE_RESULT_DETAIL_CACHE[code])
    try:
        candidates = _exchange_issuance_result_candidates(
            code, security_name or _stock_name_from_database(code)
        )
        if not candidates:
            _IPO_ISSUANCE_RESULT_DETAIL_CACHE[code] = {}
            return {}
        session = requests.Session()
        session.headers.update({'User-Agent': HEADERS['User-Agent']})
        try:
            for source, url, title, announced_at in candidates:
                text = _download_exchange_pdf_text(session, url, source)
                parsed = _parse_ipo_issuance_result_detail(text)
                if not parsed:
                    continue
                parsed.update({
                    'ipo_result_announcement_source': source,
                    'ipo_result_announcement_url': url,
                    'ipo_result_announcement_title': title,
                    'ipo_result_announcement_date': announced_at or None,
                    'ipo_result_announcement_content_hash': hashlib.sha256(
                        str(text or '').encode('utf-8')
                    ).hexdigest(),
                    'ipo_result_announcement_parser_version': 'ipo-issuance-result-facts-v1',
                })
                _IPO_ISSUANCE_RESULT_DETAIL_CACHE[code] = dict(parsed)
                return parsed
        finally:
            session.close()
    except Exception:
        pass
    _IPO_ISSUANCE_RESULT_DETAIL_CACHE[code] = {}
    return {}


def _fetch_exchange_prospectus_main_business(stock_code, security_name=''):
    """交易所主源：上交所/深交所/北交所招股说明书，失败返回空交由巨潮兜底。"""
    code = str(stock_code or '').split('.')[0]
    cache_key = code
    if cache_key in _EXCHANGE_PROSPECTUS_CACHE:
        source, value = _EXCHANGE_PROSPECTUS_CACHE[cache_key]
        _MAIN_BUSINESS_SOURCE[code] = source
        _MAIN_BUSINESS_DIAGNOSTIC[code] = {
            'status': 'value', 'source': source,
            'attempts': [{'source': source, 'status': 'value'}],
        }
        return value
    try:
        candidates = _exchange_prospectus_candidates(code, security_name or _stock_name_from_database(code))
        if not candidates:
            _record_main_business_attempt(code, 'exchange_prospectus', 'document_not_found', candidate_count=0)
            return ''
        downloaded = 0
        session = requests.Session()
        session.headers.update({'User-Agent': HEADERS['User-Agent']})
        try:
            for source, url, _title in candidates:
                text = _download_exchange_pdf_text(session, url, source)
                if not text:
                    continue
                downloaded += 1
                main_business = _extract_main_business(text)
                if main_business:
                    _EXCHANGE_PROSPECTUS_CACHE[cache_key] = (source, main_business)
                    _MAIN_BUSINESS_SOURCE[code] = source
                    _MAIN_BUSINESS_DOCUMENT[code] = {
                        'source': source,
                        'url': url,
                        'title': _title,
                        'content_hash': hashlib.sha256(text.encode('utf-8')).hexdigest(),
                        'parser_version': 'ipo-prospectus-main-business-v2',
                    }
                    _record_main_business_attempt(
                        code, 'exchange_prospectus', 'value', source=source,
                        candidate_count=len(candidates), downloaded_count=downloaded,
                    )
                    _MAIN_BUSINESS_DIAGNOSTIC[code].update({
                        'status': 'value', 'source': source,
                        'document': dict(_MAIN_BUSINESS_DOCUMENT[code]),
                    })
                    return main_business
        finally:
            session.close()
        _record_main_business_attempt(
            code, 'exchange_prospectus', 'document_parse_failed',
            candidate_count=len(candidates), downloaded_count=downloaded,
        )
    except Exception:
        _record_main_business_attempt(code, 'exchange_prospectus', 'source_error')
        return ''
    return ''


def _download_cninfo_prospectus_pdf_text(session, announcement):
    """读取或下载一份巨潮招股书 PDF，供 IPO 资料备源复用统一缓存。"""
    adjunct = str(announcement.get("adjunctUrl") or "").strip()
    if not adjunct:
        return None
    url = adjunct if adjunct.startswith("http") else f"https://static.cninfo.com.cn/{adjunct.lstrip('/')}"
    cached_text = _cached_pdf_text(url)
    if cached_text:
        return cached_text
    try:
        response = session.get(url, timeout=30)
        content = response.content or b""
        if int(response.status_code or 0) != 200 or not content.lstrip().startswith(b"%PDF"):
            return None
        _put_pdf_cache(url, content)
        doc = fitz.open(stream=content, filetype="pdf")
        try:
            return "".join(page.get_text() for page in doc) or None
        finally:
            doc.close()
    except ExternalCallGuardError:
        raise
    except Exception:
        return None


def _fetch_cninfo_prospectus_main_business(stock_code):
    """从巨潮招股说明书PDF提取主营业务（交易所主源失败后的备源）。"""
    try:
        import backfill_lottery_rate as blr
        code = str(stock_code).split('.')[0]
        org = blr.get_org_id(code)
        if not org:
            _record_main_business_attempt(code, 'cninfo_prospectus', 'document_not_found', reason='org_id_not_found')
            return ""
        s = requests.Session()
        s.headers.update({"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                          "Accept": "application/json", "X-Requested-With": "XMLHttpRequest",
                          "Referer": "https://www.cninfo.com.cn/"})
        plate = "sz" if code[0] in ('0', '3') else "sh"
        column = "szse" if code[0] in ('0', '3') else "shse"
        d = datetime.now()
        start = (d - timedelta(days=365 * 5)).strftime("%Y-%m-%d")
        end = d.strftime("%Y-%m-%d")
        announcement_count = 0
        downloaded_count = 0

        def _scan(skip_notice):
            page = 1
            seen_pages = set()
            while True:
                data = {"pageNum": page, "pageSize": 30, "stock": "%s,%s" % (code, org),
                        "tabName": "fulltext", "column": column, "plate": plate,
                        "seDate": "%s~%s" % (start, end)}
                try:
                    r = s.post("https://www.cninfo.com.cn/new/hisAnnouncement/query", data=data, timeout=20)
                    payload = r.json()
                    anns = payload.get("announcements") or []
                    total = int(payload.get("totalAnnouncement") or 0)
                except ExternalCallGuardError:
                    raise
                except Exception:
                    break
                if not anns:
                    break
                page_signature = tuple(str(a.get("announcementId") or a.get("adjunctUrl") or '') for a in anns)
                if page_signature in seen_pages:
                    break
                seen_pages.add(page_signature)
                for a in anns:
                    t = a.get("announcementTitle", "")
                    if "招股说明书" not in t and "招股意向书" not in t:
                        continue
                    announcement_count += 1
                    # 跳过“提示性公告”等简短通知，只取完整招股说明书
                    if skip_notice and ("提示性" in t or "提示" in t):
                        continue
                    text = _download_cninfo_prospectus_pdf_text(s, a)
                    if text:
                        downloaded_count += 1
                        mb = _extract_main_business(text)
                        if mb:
                            _record_main_business_attempt(
                                code, 'cninfo_prospectus', 'value',
                                candidate_count=announcement_count,
                                downloaded_count=downloaded_count,
                            )
                            return mb
                if total and page * 30 >= total:
                    break
                page += 1
            return ""

        # 优先完整招股说明书；实在没有再退而求其次（避免取到提示性公告的占位文本）
        mb = _scan(skip_notice=True)
        if mb:
            return mb
        mb = _scan(skip_notice=False)
        if not mb:
            _record_main_business_attempt(
                code, 'cninfo_prospectus',
                'document_parse_failed' if downloaded_count else 'document_not_found',
                candidate_count=announcement_count, downloaded_count=downloaded_count,
            )
        return mb
    except ExternalCallGuardError:
        raise
    except Exception:
        _record_main_business_attempt(code, 'cninfo_prospectus', 'source_error')
        return ""


def fetch_prospectus_main_business(stock_code, security_name=None):
    """主营业务取数：交易所官方招股书优先，巨潮招股书兜底。"""
    code = str(stock_code or '').split('.')[0]
    _MAIN_BUSINESS_SOURCE.pop(code, None)
    _MAIN_BUSINESS_DOCUMENT.pop(code, None)
    _MAIN_BUSINESS_DIAGNOSTIC.pop(code, None)
    official = _fetch_exchange_prospectus_main_business(code, security_name or '')
    if official:
        return official
    try:
        mb = _fetch_cninfo_prospectus_main_business(code)
        if mb:
            _MAIN_BUSINESS_SOURCE[code] = 'cninfo'
        return mb
    except ExternalCallGuardError:
        raise


def _fetch_stock_main_business(stock_code, security_name=None):
    """主营业务：交易所官方招股书优先，巨潮和 Tushare 依次回退。"""
    cninfo_error = None
    try:
        mb = fetch_prospectus_main_business(stock_code, security_name=security_name)
        if mb:
            return mb
    except ExternalCallGuardError as exc:
        # 巨潮是备源；其权限/熔断不能阻断最后的 Tushare stock_company 回退。
        cninfo_error = exc
        _record_main_business_attempt(str(stock_code or '').split('.')[0], 'cninfo_prospectus', 'source_error', reason='external_guard')
    except Exception:
        pass
    try:
        pro = _get_tushare_pro()
        if pro:
            ts_code = _to_ts_code(stock_code)
            df = pro.stock_company(ts_code=ts_code, fields="ts_code,main_business")
            if df is not None and not df.empty:
                biz = df.iloc[0].get("main_business")
                if biz:
                    code = str(stock_code or '').split('.')[0]
                    _MAIN_BUSINESS_SOURCE[code] = 'tushare'
                    _record_main_business_attempt(code, 'tushare_stock_company', 'value')
                    _MAIN_BUSINESS_DIAGNOSTIC[code].update({'status': 'value', 'source': 'tushare'})
                    return str(biz).strip()
    except ExternalCallGuardError:
        raise
    except Exception:
        pass
    code = str(stock_code or '').split('.')[0]
    _record_main_business_attempt(code, 'tushare_stock_company', 'source_unavailable')
    _finalize_main_business_diagnostic(code)
    return ""

_INDUSTRY_PE_MAP = None

def _get_industry_pe_map():
    """构建 申万行业 -> 行业中位数PE(ttm) 映射（进程内缓存一次）。

    数据源：Tushare daily_basic(最新交易日 pe_ttm) + stock_basic(行业)。
    用于补全打新报告里大量为空的 industry_pe。
    """
    global _INDUSTRY_PE_MAP
    if _INDUSTRY_PE_MAP is not None:
        return _INDUSTRY_PE_MAP
    _INDUSTRY_PE_MAP = {}
    try:
        pro = _get_tushare_pro()
        if not pro:
            return _INDUSTRY_PE_MAP
        # 最近一个交易日
        today = datetime.now()
        cal = pro.trade_cal(
            exchange='SSE', is_open='1',
            start_date=(today - timedelta(days=14)).strftime('%Y%m%d'),
            end_date=today.strftime('%Y%m%d'),
            fields='cal_date'
        )
        if cal is None or cal.empty:
            return _INDUSTRY_PE_MAP
        # 从最近交易日倒序查找第一个已有日线数据的日期（盘中当天 daily_basic 尚未生成）
        trade_dates = [str(x) for x in cal['cal_date'].tolist()]
        trade_dates.sort(reverse=True)
        # 行业映射（全部上市股票）
        sb = pro.stock_basic(exchange='', list_status='L', fields='ts_code,industry')
        if sb is None or sb.empty:
            return _INDUSTRY_PE_MAP
        ind_map = dict(zip(sb['ts_code'], sb['industry']))
        pe_map = {}
        last_date = None
        for td in trade_dates:
            pe = pro.daily_basic(trade_date=td, fields='ts_code,pe_ttm')
            if pe is not None and not pe.empty:
                pe_map = dict(zip(pe['ts_code'], pe['pe_ttm']))
                last_date = td
                break
        if not pe_map:
            return _INDUSTRY_PE_MAP
        groups = defaultdict(list)
        for ts, ind in ind_map.items():
            if not ind:
                continue
            p = pe_map.get(ts)
            if p is None or (isinstance(p, float) and p != p) or p <= 0:
                continue
            groups[ind].append(float(p))
        for ind, vals in groups.items():
            if len(vals) < 3:
                continue
            vals.sort()
            n = len(vals)
            mid = vals[n // 2] if n % 2 else (vals[n // 2 - 1] + vals[n // 2]) / 2
            _INDUSTRY_PE_MAP[ind] = round(mid, 1)
        print(f"行业PE映射构建完成: {len(_INDUSTRY_PE_MAP)} 个行业 (基准日 {last_date})")
    except ExternalCallGuardError:
        raise
    except Exception as e:
        print(f"行业PE映射构建失败: {e}")
    return _INDUSTRY_PE_MAP

def fetch_stock_historical_detail(secu_code, existing_industry=None, existing_main_business=None, missing_fields=None):
    """补全已进入历史的新股详情，不依赖 new_share 的待发行列表。"""
    code = str(secu_code or '').split('.')[0]
    if not code:
        return None
    requested = set(missing_fields or (
        'industry', 'industry_pe', 'main_business', 'business_exposure',
        'online_lottery_rate', 'oversubscribe_multiple',
    ))
    need_industry = 'industry' in requested
    need_industry_pe = 'industry_pe' in requested
    need_main_business = 'main_business' in requested
    need_result = bool({'online_lottery_rate', 'oversubscribe_multiple'} & requested)
    security_name = _STOCK_NAME_CACHE.get(code) or _stock_name_from_database(code)
    announcement_detail = (
        _fetch_exchange_ipo_issuance_detail(code, security_name=security_name)
        if (need_industry or need_industry_pe) else {}
    )
    result_detail = (
        _fetch_exchange_ipo_issuance_result_detail(code, security_name=security_name)
        if need_result else {}
    )
    industry = (
        str(announcement_detail.get('industry') or '').strip()
        or (_fetch_stock_industry(code) if need_industry else '')
        or str(existing_industry or '').strip()
    )
    detail = dict(announcement_detail)
    detail.update(result_detail)
    detail['industry'] = industry or ''
    if announcement_detail.get('industry'):
        detail['industry_source'] = f"{announcement_detail.get('ipo_announcement_source')}_issuance_announcement"
    detail['main_business'] = (
        _fetch_stock_main_business(code, security_name=security_name)
        if need_main_business else str(existing_main_business or '').strip()
    ) or ''
    detail['main_business_source'] = _MAIN_BUSINESS_SOURCE.get(code, '')
    if _MAIN_BUSINESS_DOCUMENT.get(code):
        detail['main_business_document'] = dict(_MAIN_BUSINESS_DOCUMENT[code])
    if need_main_business and _MAIN_BUSINESS_DIAGNOSTIC.get(code):
        diagnostic = dict(_MAIN_BUSINESS_DIAGNOSTIC[code])
        diagnostic['attempts'] = list(diagnostic.get('attempts') or [])[-6:]
        detail['main_business_diagnostic'] = diagnostic
    _normalize_stock_detail(detail)
    issuance_pe_diagnostic = dict(_IPO_ISSUANCE_DETAIL_DIAGNOSTIC.get(code) or {})
    if need_industry_pe:
        if detail.get('industry_pe') is not None:
            announcement_role = (
                announcement_detail.get('ipo_announcement_role') or 'issuance_announcement'
            )
            detail['industry_pe_source'] = (
                f"{announcement_detail.get('ipo_announcement_source')}_{announcement_role}"
                if announcement_detail.get('ipo_announcement_source')
                else 'stored_or_existing'
            )
            detail['industry_pe_diagnostic'] = {
                'status': 'value', 'source': detail['industry_pe_source'],
                'as_of': announcement_detail.get('industry_pe_as_of'),
                'document_role': announcement_detail.get('ipo_announcement_role'),
                'document_url': announcement_detail.get('ipo_announcement_url'),
            }
        elif detail.get('industry'):
            industry_pe_map = _get_industry_pe_map()
            detail['industry_pe'] = industry_pe_map.get(detail['industry'])
            if detail['industry_pe'] is None and '仪器仪表' in detail['industry']:
                detail['industry_pe'] = industry_pe_map.get('电器仪表')
            if detail.get('industry_pe') is not None:
                detail['industry_pe_source'] = 'tushare_derived_industry_median'
                detail['industry_pe_diagnostic'] = {
                    'status': 'value', 'source': 'tushare_derived_industry_median',
                }
            else:
                detail['industry_pe_diagnostic'] = issuance_pe_diagnostic or {
                    'status': 'source_unavailable',
                    'reason': 'insufficient_or_unmatched_industry_sample',
                }
                if detail['industry_pe_diagnostic'].get('status') == 'document_not_found':
                    detail['industry_pe_diagnostic']['reason'] = 'issuance_announcement_not_found_and_industry_sample_unmatched'
        else:
            detail['industry_pe_diagnostic'] = {
                'status': 'source_unavailable', 'reason': 'industry_unavailable',
            }
    elif detail.get('industry_pe') is not None:
        announcement_role = (
            announcement_detail.get('ipo_announcement_role') or 'issuance_announcement'
        )
        detail['industry_pe_source'] = (
            f"{announcement_detail.get('ipo_announcement_source')}_{announcement_role}"
        )
    if announcement_detail.get('issuer_unprofitable'):
        detail['issue_pe_status'] = 'loss'
    try:
        from ipo_lib_sector import analyze_business_exposure
        detail['business_exposure'] = analyze_business_exposure(
            '', detail['main_business'], detail.get('industry', '')
        )
    except Exception:
        detail['business_exposure'] = None
    return detail

def _fetch_quote_tencent(stock_code):
    """腾讯行情API - 数据格式稳定，sandbox内可达"""
    try:
        qt_code = _get_qt_symbol(stock_code, 'stock')
        if not qt_code:
            return None
        url = f"https://qt.gtimg.cn/q={qt_code}"
        resp = _get_session().get(url, timeout=10)
        text = resp.text
        # 格式: v_sz300881="51~盛德鑫泰~300881~43.06~...";
        m = re.search(r'="(.+)"', text)
        if not m:
            return None
        parts = m.group(1).split("~")
        if len(parts) < 40:
            return None
        # parts索引: 1=名称, 2=代码, 3=现价, 4=昨收, 31=总市值(亿)
        # 32=流通市值(亿), 37=PE(动态), 46=PB
        price = float(parts[3]) if parts[3] else None
        pe = float(parts[37]) if len(parts) > 37 and parts[37] else None
        pb = float(parts[46]) if len(parts) > 46 and parts[46] else None
        market_cap = float(parts[31]) if len(parts) > 31 and parts[31] else None
        # 腾讯API没有ROE，返回None
        return {
            "price": price,
            "pe": pe,
            "pb": pb,
            "roe": None,
            "market_cap": market_cap,
        }
    except Exception as e:
        print(f"腾讯行情获取失败({stock_code}): {e}")
    return None

def _fetch_quote_eastmoney(stock_code):
    """东财push2行情API - 二分查找"""
    try:
        code_int = int(stock_code)
        if code_int >= 600000:
            fs = "m:1+t:2,m:1+t:23"
        elif code_int >= 400000:
            fs = "m:0+t:81+s:2048"
        else:
            fs = "m:0+t:6,m:0+t:80"

        url = "https://push2.eastmoney.com/api/qt/clist/get"
        params = {
            "pn": "1", "pz": "100", "po": "1", "np": "1",
            "ut": "bd1d9ddb04089700cf9c27f6f7426281",
            "fltt": "2", "invt": "2", "fid": "f12",
            "fs": fs,
            "fields": "f2,f9,f23,f37,f20,f12",
        }
        resp = _get_session().get(url, params=params, timeout=10)
        d = resp.json()
        if not (d.get("data") and d["data"].get("total")):
            return None

        total = d["data"]["total"]
        total_pages = (total + 99) // 100
        lo, hi = 1, total_pages
        max_retries = 3
        while lo <= hi and max_retries > 0:
            mid = (lo + hi) // 2
            params["pn"] = str(mid)
            try:
                resp = _get_session().get(url, params=params, timeout=10)
                d = resp.json()
            except Exception:
                max_retries -= 1
                continue
            if not (d.get("data") and d["data"].get("diff")):
                max_retries -= 1
                continue
            items = d["data"]["diff"]
            first_code = items[0]["f12"]
            last_code = items[-1]["f12"]
            for item in items:
                if item.get("f12") == stock_code:
                    return {
                        "price": item.get("f2"),
                        "pe": item.get("f9"),
                        "pb": item.get("f23"),
                        "roe": item.get("f37"),
                        "market_cap": item.get("f20"),
                    }
            if stock_code < first_code:
                hi = mid - 1
            elif stock_code > last_code:
                lo = mid + 1
            else:
                break
    except Exception as e:
        print(f"东财行情获取失败({stock_code}): {e}")
    return None

def fetch_stock_price_from_detail(bond_code):
    """从债券详情HTML页获取正股价格和PE/PB（fallback方案）"""
    try:
        url = f"{DETAIL_API}?secucode={bond_code}&type=kzz"
        resp = _get_session().get(url, timeout=15)
        html = resp.text
        result = {}

        # 解析HTML表格
        rows = re.findall(r"<tr>(.*?)</tr>", html, re.DOTALL)
        table_data = {}
        for row in rows:
            tds = re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", row, re.DOTALL)
            cells = [re.sub(r"<[^>]+>", "", c).strip() for c in tds]
            i = 0
            while i < len(cells) - 1:
                key = cells[i]
                val = cells[i + 1]
                if re.search(r"[\u4e00-\u9fff]", val) and not re.match(r"^[\d.\-]+$", val) and key not in {"发行价格(元)", "发行市盈率", "正股价(元)", "正股市净率", "转股价(元)", "转股价值(元)", "转股溢价率"}:
                    i += 1
                    continue
                table_data[key] = val
                i += 2

        # 正股价
        for k in ["正股价(元)"]:
            if k in table_data and table_data[k]:
                try:
                    result["price"] = float(table_data[k])
                except ValueError:
                    pass

        # 正股市净率 → PB
        for k in ["正股市净率"]:
            if k in table_data and table_data[k]:
                try:
                    result["pb"] = float(table_data[k])
                except ValueError:
                    pass

        return result if result else None
    except Exception as e:
        print(f"从详情页获取正股行情失败: {e}")
    return None

def _fetch_all_a_stock_list():
    """获取全市场A股列表（代码+名称） — Tushare主源 + 腾讯兜底
    返回 [(code, name), ...]
    """
    # 主源：Tushare stock_basic（1次请求 vs 1200次）
    pro = _get_tushare_pro()
    if pro:
        try:
            df = pro.stock_basic(exchange='', list_status='L',
                                 fields='ts_code,symbol,name')
            if df is not None and len(df) > 0:
                result = []
                for _, row in df.iterrows():
                    sym = str(row.get('symbol', ''))
                    if sym:
                        result.append((sym.zfill(6), str(row.get('name', ''))))
                return result
        except Exception as e:
            print(f"[Tushare] stock_basic失败，回退腾讯: {e}")

    # 兜底：枚举代码段+腾讯行情API批量查询（原有逻辑不变）
    s = _get_session()
    all_stocks = []
    seen_codes = set()

    def batch_query(codes):
        """批量查询股票名称"""
        if not codes:
            return {}
        qt_codes = [_get_qt_symbol(c, 'stock') for c in codes]
        qt_codes = [code for code in qt_codes if code]
        if not qt_codes:
            return {}
        try:
            url = f"https://qt.gtimg.cn/q={','.join(qt_codes)}"
            resp = s.get(url, timeout=15)
            results = {}
            for line in resp.text.strip().split(";"):
                m = re.search(r'="(.+)"', line.strip())
                if m:
                    parts = m.group(1).split("~")
                    if len(parts) >= 3:
                        code = parts[2]
                        name = parts[1] if len(parts) > 1 else ""
                        if name and not name.startswith("?"):
                            results[code] = name
            return results
        except Exception:
            return {}

    ranges = [
        ("600", range(600000, 610000)),
        ("688", range(688000, 690000)),
        ("000", range(1, 1000)),
        ("001", range(1000, 2000)),
        ("002", range(2000, 3000)),
        ("003", range(3000, 4000)),
        ("300", range(300000, 302000)),
        ("301", range(301000, 302000)),
        ("83", range(830000, 840000)),
        ("87", range(870000, 880000)),
        ("82", range(820000, 830000)),
        ("920", range(920000, 921000)),
        ("43", range(430000, 440000)),
    ]

    for prefix, r in ranges:
        batch = []
        for code_int in r:
            code_str = str(code_int)
            if code_str in seen_codes:
                continue
            batch.append(code_str)
            if len(batch) >= 50:
                results = batch_query(batch)
                for c, n in results.items():
                    all_stocks.append((c, n))
                    seen_codes.add(c)
                batch = []
        if batch:
            results = batch_query(batch)
            for c, n in results.items():
                all_stocks.append((c, n))
                seen_codes.add(c)
        time.sleep(0.3)

    return all_stocks

def _fetch_bond_listing_data_from_api(cutoff_date):
    """从Tushare获取近6个月上市新债，再从腾讯K线获取首个非涨停日涨幅。"""
    import re as _re
    from datetime import datetime

    s = _get_session()
    url = "https://datacenter-web.eastmoney.com/api/data/v1/get"
    bonds = []  # [(code, name, listing_date)]
    now = datetime.now()

    # 1. 从 Tushare 获取最近上市的新债代码（替代东财 RPT_BOND_CB_LIST）
    try:
        pro = _get_tushare_pro()
        if pro:
            df = pro.cb_basic(fields="ts_code,bond_short_name,list_date")
            if df is not None and not df.empty:
                for _, b in df.iterrows():
                    ld = b.get("list_date")
                    if not ld:
                        continue
                    try:
                        ld_raw = str(ld).strip()
                        if re.fullmatch(r"\d{8}", ld_raw):
                            listing_dt = datetime.strptime(ld_raw, "%Y%m%d")
                        else:
                            listing_dt = datetime.strptime(ld_raw[:10], "%Y-%m-%d")
                        ld_str = listing_dt.strftime("%Y-%m-%d")
                    except (ValueError, TypeError):
                        continue
                    if (now - listing_dt).days > 180:
                        continue
                    code = str(b.get("ts_code", "")).split(".")[0]
                    name = str(b.get("bond_short_name") or "")
                    if code:
                        bonds.append((code, name, ld_str))
    except Exception as e:
        print(f"[新债温度] Tushare 获取上市清单失败: {e}")

    if not bonds:
        return []

    # 2. 从腾讯K线获取上市首日收盘价（旧逻辑：取上市后首个「非涨停日」收盘）
    # 判定标准（用户确认保留旧逻辑）：上市涨幅 = 上市后首个非涨停日收盘 - 100（%）。
    # 上市日若未涨停(D1收盘<157)直接取D1；若涨停则顺延，取首个未触及±20%涨停的交易日收盘。
    # 注：此逻辑会越过首日限制，可能产生 204%/147% 等值，为旧逻辑既定行为。
    gains = []
    for code, name, ld in bonds:
        qt_code = _get_qt_symbol(code, 'convertible_bond')
        if not qt_code:
            continue
        # 取上市日后第2个交易日收盘价（避开首日涨跌幅限制）
        kline_url = f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={qt_code},day,,,365,qfq"
        try:
            resp = s.get(kline_url, timeout=10)
            kdata = resp.json()
            days = (kdata.get("data", {}).get(qt_code, {}).get("day") or
                    kdata.get("data", {}).get(qt_code.replace("sh", "sz"), {}).get("day") or
                    kdata.get("data", {}).get(qt_code.replace("sz", "sh"), {}).get("day") or [])
            day2_close = None
            listing_found = False
            prev_close = None
            observation_date = None
            for d in days:
                if d[0] == ld:
                    listing_found = True
                    prev_close = float(d[2])
                    # D1涨停→跳过，否则直接取D1
                    if abs(prev_close - 157.3) > 0.05:
                        day2_close = prev_close
                        observation_date = d[0]
                        break
                    continue
                if listing_found and len(d) >= 3:
                    close = float(d[2])
                    # 计算当日理论涨停价（可转债日常±20%）
                    limit_price = round(prev_close * 1.2, 1)
                    # 没涨停→取这天
                    if abs(close - limit_price) > 0.5:
                        day2_close = close
                        observation_date = d[0]
                        break
                    # 涨停了→记录暂存，继续看下一天
                    prev_close = close
                    day2_close = close
                    observation_date = d[0]
            # 还没有出现非涨停日时不写入首日临时值，后续每日继续回补。
            if day2_close is None:
                continue
            first_day_return = day2_close - 100  # 百分比值
            gains.append(first_day_return)
            from bond_data_layer import update_listing_performance
            update_listing_performance(
                code, ld, observation_date or ld, day2_close, round(first_day_return, 2),
                {"source": "listing_kline", "formula": "first_non_limit_day_v1"},
            )
        except Exception:
            continue

    print(f"[新债温度] 从K线获取到 {len(gains)} 只新债首个非涨停日涨幅")
    return gains

_BONDS_MARKET_CACHE = None  # list of (code, bond_price, transfer_value, premium_pct, stock_code)

def _fetch_all_bonds_market():
    """读取最近已发布批次的全市场转债行情。"""
    global _BONDS_MARKET_CACHE
    if _BONDS_MARKET_CACHE is not None:
        return _BONDS_MARKET_CACHE
    try:
        conn = _init_ipo_db()
        rows = conn.execute(
            """WITH latest AS (SELECT MAX(trade_date) AS trade_date FROM market.convertible_bond_daily_metrics)
               SELECT split_part(i.canonical_code,'.',1),m.close,m.conversion_value,m.conversion_premium_pct,
                      split_part(s.canonical_code,'.',1)
                 FROM market.convertible_bond_daily_metrics m
                 JOIN latest d ON d.trade_date=m.trade_date
                 JOIN core.instruments i ON i.instrument_id=m.instrument_id
                 JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=i.instrument_id
                 LEFT JOIN core.instruments s ON s.instrument_id=p.stock_instrument_id
                WHERE m.close>0 AND m.conversion_value>0 AND m.conversion_premium_pct IS NOT NULL"""
        ).fetchall()
        conn.close()
        _BONDS_MARKET_CACHE = [
            (str(row[0]), float(row[1]), float(row[2]), float(row[3]), str(row[4] or ""))
            for row in rows
        ]
    except Exception:
        _BONDS_MARKET_CACHE = []
    return _BONDS_MARKET_CACHE

def _fetch_cb_index_change():
    """读取中证转债指数最近约一个月的已入库涨跌幅。"""
    try:
        conn = _init_ipo_db()
        rows = conn.execute(
            """SELECT b.close FROM market.daily_bars b
                 JOIN core.instruments i ON i.instrument_id=b.instrument_id
                WHERE split_part(i.canonical_code,'.',1)='000832' AND b.close>0
                ORDER BY b.trade_date DESC,b.source_id DESC LIMIT 25"""
        ).fetchall()
        conn.close()
        if len(rows) >= 2:
            last = float(rows[0][0])
            first = float(rows[-1][0])
            if first > 0:
                return round((last - first) / first * 100, 2)
    except Exception:
        pass
    return None

def _fetch_stock_listing_actuals():
    """
    从腾讯K线获取已上市股票的实际首日涨跌幅，更新ipo_history
    用于补全上市前接口未返回的LD_CLOSE_CHANGE
    """
    import sqlite3
    from datetime import datetime, timedelta

    today_str = datetime.now().strftime("%Y-%m-%d")
    conn = _init_ipo_db()

    # 找出已到上市日但ld_close_change仍为空的股票（近30天）
    cutoff = (datetime.now() - timedelta(days=30)).strftime("%Y-%m-%d")
    candidates = conn.execute(
        "SELECT security_code, security_name, listing_date, issue_price FROM ipo_history "
        "WHERE listing_date >= ? AND listing_date <= ? AND ld_close_change IS NULL AND issue_price IS NOT NULL",
        (cutoff, today_str),
    ).fetchall()

    if not candidates:
        conn.close()
        return

    s = _get_session()
    updated = 0
    for code, name, listing_date, issue_price in candidates:
        try:
            ld = listing_date[:10]
            qt_code = _get_qt_symbol(code, 'stock')
            if not qt_code:
                continue
            kline_url = f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={qt_code},day,,,365,qfq"
            resp = s.get(kline_url, timeout=10)
            kdata = resp.json()
            days = (kdata.get("data", {}).get(qt_code, {}).get("day") or
                    kdata.get("data", {}).get(qt_code.replace("sh", "sz"), {}).get("day") or
                    kdata.get("data", {}).get(qt_code.replace("sz", "sh"), {}).get("day") or [])

            # 找到上市日收盘价
            first_day_close = None
            for d in days:
                if d[0] == ld and len(d) >= 3:
                    first_day_close = float(d[2])
                    break

            if first_day_close is None or issue_price <= 0:
                continue

            ld_close_change = round((first_day_close - issue_price) / issue_price * 100, 2)
            conn.execute(
                "UPDATE ipo_history SET ld_close_change=?, updated_at=? WHERE security_code=?",
                (ld_close_change, datetime.now().strftime("%Y-%m-%d %H:%M:%S"), code),
            )
            updated += 1
            print(f"  [回填] {code} {name} 首日涨幅{ld_close_change}%（发行价{issue_price}→收盘{first_day_close}）")
        except Exception as e:
            continue

    conn.commit()
    conn.close()
    if updated > 0:
        print(f"[回填] 从K线回填 {updated} 只股票的首日涨幅")

__all__ = ['fetch_stock_detail', 'fetch_stock_historical_detail', '_split_embedded_industry', '_normalize_stock_detail', 'fetch_bond_detail', '_org_id_cache', '_get_org_id', '_parse_bond_top10_holders', '_extract_controller_names', '_match_controller_holders', '_derive_total_zhang', 'fetch_placing_result', 'calc_circulation_scale', 'calculate_conversion_metrics', '_parse_tencent_bond_price', '_fetch_bond_price', 'fetch_stock_quote', '_fetch_stock_industry', '_INDUSTRY_PE_MAP', '_get_industry_pe_map', '_fetch_quote_tencent', '_fetch_quote_eastmoney', 'fetch_stock_price_from_detail', '_fetch_all_a_stock_list', '_fetch_bond_listing_data_from_api', '_BONDS_MARKET_CACHE', '_fetch_all_bonds_market', '_fetch_cb_index_change', '_fetch_stock_listing_actuals']
