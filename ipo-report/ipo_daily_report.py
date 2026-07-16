#!/usr/bin/env python3
"""
打新日报生成器
每天生成第二天的：
1. 新股、新债申购信息及估值分析
2. 新股、新债上市信息及估值分析
"""

import requests
import json
import os
import re
from collections import defaultdict
import fitz  # PyMuPDF - PDF解析
import time
from datetime import datetime, timedelta

import db_pg  # PostgreSQL 数据层（替代 SQLite）

# ============ 加载 .env 环境变量 ============
# 优先脚本同级 .env，其次父目录（portfolio-server 根）.env
def _load_env():
    for _cand in [
        os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env'),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '.env'),
    ]:
        if os.path.exists(_cand):
            with open(_cand, 'r', encoding='utf-8') as _f:
                for _line in _f:
                    _line = _line.strip()
                    if _line and not _line.startswith('#') and '=' in _line:
                        _k, _, _v = _line.partition('=')
                        os.environ.setdefault(_k.strip(), _v.strip())
_load_env()

# ============ 配置 ============
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "history_reports")
CALENDAR_API = "https://datacenter-web.eastmoney.com/api/data/v1/get"
DETAIL_API = "https://ds.emoney.cn/DataCenter2/datacenter/NewStockXgzl"
BOND_DETAIL_URL = "https://data.eastmoney.com/kzz/detail/{code}.html"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Referer": "https://data.eastmoney.com/",
}

# 共享Session，避免sandbox频繁新建连接导致RemoteDisconnected
_session = None

def _get_session():
    global _session
    if _session is None:
        _session = requests.Session()
        _session.headers.update(HEADERS)
        # 连接池配置：复用连接，避免sandbox限制
        adapter = requests.adapters.HTTPAdapter(
            pool_connections=10,
            pool_maxsize=10,
            max_retries=2,
            pool_block=False,
        )
        _session.mount("https://", adapter)
        _session.mount("http://", adapter)
    return _session


def fetch_calendar():
    """获取新股/新债日历数据（Tushare: new_share + cb_issue + cb_basic）

    返回与东财同构的字典列表，键保持：
    TRADE_DATE, DATE_TYPE(申购/上市), SECURITY_TYPE(0=股票,1=债券),
    SECURITY_NAME_ABBR, SECURITY_CODE(6位), SECUCODE(ts_code)
    """
    pro = _get_tushare_pro()
    if not pro:
        print("[日历] Tushare 未配置，无法获取日历")
        return []
    all_data = []

    # 1. 新股：new_share 含申购日(ipo_date)与上市日(issue_date)
    try:
        df = pro.new_share()
        if df is not None and not df.empty:
            for _, r in df.iterrows():
                ts_code = str(r.get("ts_code", "") or "")
                if not ts_code:
                    continue
                code6 = ts_code.split(".")[0]
                abbr = str(r.get("name") or "")
                ipo = r.get("ipo_date")
                issue = r.get("issue_date")
                if ipo:
                    all_data.append({
                        "TRADE_DATE": _str_date(ipo), "DATE_TYPE": "申购", "SECURITY_TYPE": "0",
                        "SECURITY_NAME_ABBR": abbr, "SECURITY_CODE": code6, "SECUCODE": ts_code,
                    })
                if issue:
                    all_data.append({
                        "TRADE_DATE": _str_date(issue), "DATE_TYPE": "上市", "SECURITY_TYPE": "0",
                        "SECURITY_NAME_ABBR": abbr, "SECURITY_CODE": code6, "SECUCODE": ts_code,
                    })
    except Exception as e:
        print(f"[日历] 获取新股日历失败: {e}")

    # 2. 新债申购：cb_issue 含网上申购日(onl_date)
    try:
        df2 = pro.cb_issue(fields="ts_code,onl_name,onl_date")
        if df2 is not None and not df2.empty:
            for _, r in df2.iterrows():
                ts_code = str(r.get("ts_code", "") or "")
                if not ts_code:
                    continue
                code6 = ts_code.split(".")[0]
                abbr = str(r.get("onl_name") or "")
                onl = r.get("onl_date")
                if onl:
                    all_data.append({
                        "TRADE_DATE": _str_date(onl), "DATE_TYPE": "申购", "SECURITY_TYPE": "1",
                        "SECURITY_NAME_ABBR": abbr, "SECURITY_CODE": code6, "SECUCODE": ts_code,
                    })
    except Exception as e:
        print(f"[日历] 获取新债申购日历失败: {e}")

    # 3. 新债上市：cb_basic 含上市日(list_date)
    try:
        df3 = pro.cb_basic(fields="ts_code,bond_short_name,list_date")
        if df3 is not None and not df3.empty:
            for _, r in df3.iterrows():
                ts_code = str(r.get("ts_code", "") or "")
                if not ts_code:
                    continue
                ld = r.get("list_date")
                if not ld:
                    continue
                code6 = ts_code.split(".")[0]
                abbr = str(r.get("bond_short_name") or "")
                all_data.append({
                        "TRADE_DATE": _str_date(ld), "DATE_TYPE": "上市", "SECURITY_TYPE": "1",
                    "SECURITY_NAME_ABBR": abbr, "SECURITY_CODE": code6, "SECUCODE": ts_code,
                })
    except Exception as e:
        print(f"[日历] 获取新债上市日历失败: {e}")

    return all_data


def build_upcoming_calendar(calendar, days=90, apply_stocks=None, apply_bonds=None):
    """从全量日历筛选今天起未来 days 天的申购/上市事件，按日期分组。

    用于前端『打新日历』：列出还没过申购的申购日、还没上市的上市日。
    只展示已有明确日期的标的；没有明确日期的已公告标的（如尚未公布申购日的新股）不在日历中显示。
    """
    try:
        today = datetime.now().date()
    except Exception:
        today = datetime.today().date()
    end = today + timedelta(days=days)
    end_str = end.strftime("%Y-%m-%d")
    today_str = today.strftime("%Y-%m-%d")
    groups = {}
    order = []

    def _ensure_group(td_k):
        if td_k not in groups:
            try:
                dd = datetime.strptime(td_k, "%Y-%m-%d").date()
            except Exception:
                return None
            groups[td_k] = {
                "date": td_k,
                "weekday": ["周一", "周二", "周三", "周四", "周五", "周六", "周日"][dd.weekday()],
                "apply_stocks": [], "apply_bonds": [], "list_stocks": [], "list_bonds": [],
            }
            order.append(td_k)
        return groups[td_k]

    for item in calendar:
        td = (item.get("TRADE_DATE") or "")[:10]
        if not td:
            continue
        try:
            d = datetime.strptime(td, "%Y-%m-%d").date()
        except Exception:
            continue
        if d < today or d > end:
            continue
        g = _ensure_group(td)
        secu_type = item.get("SECURITY_TYPE", "0")
        name = item.get("SECURITY_NAME_ABBR", "")
        code = item.get("SECURITY_CODE", "")
        ent = {"name": name, "code": code}
        if item.get("DATE_TYPE") == "申购":
            if secu_type == "1":
                g["apply_bonds"].append(ent)
            else:
                g["apply_stocks"].append(ent)
        else:
            if secu_type == "1":
                g["list_bonds"].append(ent)
            else:
                g["list_stocks"].append(ent)

    # 补充：申购建议中已公告且明确了申购日(online_date)的标的，补入对应日期组。
    # 无明确日期的标的按用户要求不在日历显示。
    def _add_dated(items, group_key):
        if not items:
            return
        for s in items:
            c = s.get("code", "")
            if not c:
                continue
            d = s.get("detail") or {}
            od = d.get("online_date", "")
            if not od:
                continue
            td_k = od[:10]
            if td_k < today_str or td_k > end_str:
                continue
            g = _ensure_group(td_k)
            if not g:
                continue
            ent = {"name": s.get("name", ""), "code": c}
            if ent not in g[group_key]:
                g[group_key].append(ent)

    _add_dated(apply_stocks, "apply_stocks")
    _add_dated(apply_bonds, "apply_bonds")

    return [groups[k] for k in sorted(order)]


def fetch_stock_detail(secu_code):
    """获取新股详细发行信息（Tushare new_share）

    对齐原东财 HTML 解析产出的字段：
    issue_price, issue_pe, online_date, list_date, fund_raised, total_shares,
    online_shares, online_lottery_rate, main_business, industry, circulation_mv
    """
    try:
        pro = _get_tushare_pro()
        if not pro:
            return None
        ts_code = _to_ts_code(secu_code)
        df = pro.new_share(ts_code=ts_code)
        if df is None or df.empty:
            return None
        # Tushare new_share 的 ts_code 过滤在接口端不生效（返回全量待发行列表），
        # 必须本地再按 ts_code 精确匹配；已上市股票不在待发行列表中 → 返回 None，
        # 避免取到列表第一条（占位数据）污染历史记录。
        sub = df[df["ts_code"] == ts_code] if "ts_code" in df.columns else df
        if sub is None or sub.empty:
            return None
        r = sub.iloc[0]
        info = {}
        ip = _ts_float(r.get("price"))
        ipe = _ts_float(r.get("pe"))
        amount = _ts_float(r.get("amount"))            # 发行总量(万股)
        market_amount = _ts_float(r.get("market_amount"))  # 网上发行量(万股)
        ballot = _ts_float(r.get("ballot"))             # 中签率(%)
        funds = _ts_float(r.get("funds"))              # 募资总额(亿元)
        limit_amount = _ts_float(r.get("limit_amount"))   # 顶格申购上限(万股)

        info["issue_price"] = ip
        info["issue_pe"] = ipe
        info["online_date"] = _str_date(r.get("ipo_date"))
        info["list_date"] = _str_date(r.get("issue_date"))
        # 募资总额：优先用 Tushare funds 字段(亿元)；缺失时按 发行总量(万股)*发行价/1e4 估算
        if funds:
            info["fund_raised"] = round(funds, 2)
        elif amount and ip:
            info["fund_raised"] = round(amount * ip / 1e4, 2)   # 亿元
        info["total_shares"] = round(amount, 2) if amount else None  # 万股
        if market_amount:
            info["online_shares"] = round(market_amount, 2)  # 万股
        if market_amount and ip:
            info["circulation_mv"] = round(market_amount * ip / 1e4, 2)  # 亿元
        if ballot is not None:
            info["online_lottery_rate"] = ballot
        # 顶格申购股数 / 需配市值
        # Tushare new_share 的 limit_amount = 顶格申购上限(万股)
        # （北交所=网上发行量×5%，沪/深为交易所设定值，单位均为万股）
        if limit_amount:
            info["limit_amount"] = limit_amount                            # 万股
            info["subscribe_upper_limit"] = round(limit_amount, 2)         # 顶格申购上限(万股)
            # 沪深/京规则统一：每1万市值可申1000股 → 需配市值(万元)=顶格股数/1000=limit_amount*10
            info["subscribe_mv"] = round(limit_amount * 10, 1)             # 需配市值(万元)
        biz = r.get("main_business")
        info["main_business"] = (biz[:200] if isinstance(biz, str) and len(biz) > 200 else biz) or ""
        ind = (r.get("industry") or "").strip()
        if not ind:
            ind = _fetch_stock_industry(secu_code)   # 回退用 stock_basic 行业
        info["industry"] = ind or ""
        # 行业PE：用全市场行业中位数PE映射补全
        info["industry_pe"] = _get_industry_pe_map().get(ind) if ind else None
        return info if info else None
    except Exception as e:
        print(f"获取{secu_code}详情失败: {e}")
        return None


def fetch_bond_detail(secu_code):
    """获取新债详细发行信息"""
    try:
        info = {}

        # 1. 转债基础信息（Tushare cb_basic + cb_rating，替代东财 RPT_BOND_CB_LIST）
        pro = _get_tushare_pro()
        if not pro:
            return None
        ts_code = _to_ts_code(secu_code)
        cb = None
        try:
            df = pro.cb_basic(ts_code=ts_code,
                              fields="ts_code,bond_short_name,stk_code,stk_short_name,conv_price,first_conv_price,list_date,issue_size,par")
            if df is not None and not df.empty:
                cb = df.iloc[0]
        except Exception as e:
            print(f"[转债] cb_basic 获取失败({secu_code}): {e}")
        if cb is None:
            return None

        info["bond_name"] = str(cb.get("bond_short_name") or "")
        info["stock_code"] = str(cb.get("stk_code") or "").split(".")[0]  # 6位正股代码
        info["stock_name"] = str(cb.get("stk_short_name") or "")
        info["convert_price"] = _ts_float(cb.get("conv_price")) or _ts_float(cb.get("first_conv_price"))
        issue_size = _ts_float(cb.get("issue_size"))
        info["issue_scale"] = round(issue_size / 1e8, 4) if issue_size else None  # 亿
        info["list_date"] = _str_date(cb.get("list_date"))

        # 评级（优先 cb_rating 最新一期）
        rating = cb.get("rating")
        try:
            rdf = pro.cb_rating(ts_code=ts_code, fields="ts_code,rating,rating_date")
            if rdf is not None and not rdf.empty:
                rating = rdf.iloc[0].get("rating") or rating
        except Exception:
            pass
        info["rating"] = (str(rating or "").replace("sti", "").replace("STI", ""))

        # 2. 获取可转债交易价格（已上市→实时行情，未上市→面值100）
        bond_price = _fetch_bond_price(secu_code, info.get("list_date"))
        info["bond_price"] = bond_price

        # 2. 计算转股价值：尝试获取正股行情
        stock_code = info["stock_code"]
        if stock_code:
            stock_info = fetch_stock_quote(stock_code)
            if not stock_info:
                # fallback: 从HTML详情页获取正股价格
                stock_info = fetch_stock_price_from_detail(secu_code)
            if stock_info:
                info["stock_price"] = stock_info.get("price")
                info["stock_pe"] = stock_info.get("pe")
                info["stock_pb"] = stock_info.get("pb")
                info["stock_roe"] = stock_info.get("roe")
                info["stock_market_cap"] = stock_info.get("market_cap")
                info["stock_industry"] = stock_info.get("industry", "")

        # 2.1 如果行情API没拿到行业，从东财个股页面获取
        if not info.get("stock_industry") and stock_code:
            industry = _fetch_stock_industry(stock_code)
            if industry:
                info["stock_industry"] = industry

        # 3. 计算转股价值和转股溢价率
        if info.get("convert_price") and info.get("stock_price"):
            try:
                cp = float(info["convert_price"])
                sp = float(info["stock_price"])
                info["transfer_value"] = round(100 / cp * sp, 2)
                bp = float(info["bond_price"])
                if info["transfer_value"] > 0:
                    info["premium_ratio"] = round((bp / info["transfer_value"] - 1) * 100, 2)
            except (ValueError, TypeError):
                pass

        # 4. 计算流通规模和限售规模
        # 优先从配售结果公告获取精确数据（控股+实控人配售量），
        # 公告未发布时用网上占比分段系数估算
        if info.get("issue_scale"):
            calc_circulation_scale(info)

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


# ============ 可转债配售结果精确解析 ============

# orgId缓存
_org_id_cache = {}


def _get_org_id(stock_code):
    """从巨潮获取股票orgId（带重试，使用独立session避免cookie冲突）"""
    import time
    if stock_code in _org_id_cache:
        return _org_id_cache[stock_code]
    for attempt in range(3):
        try:
            url = "http://www.cninfo.com.cn/new/information/topSearch/query"
            # 使用独立session，避免共享的Eastmoney cookies干扰cninfo
            cn_session = requests.Session()
            cn_session.headers.update({
                "User-Agent": HEADERS["User-Agent"],
                "Accept": "application/json",
                "X-Requested-With": "XMLHttpRequest",
                "Referer": "http://www.cninfo.com.cn/",
            })
            resp = cn_session.post(url, data={"keyWord": stock_code, "maxNum": 10},
                                 timeout=20)
            cn_session.close()
            for item in resp.json():
                if item.get("code") == stock_code:
                    _org_id_cache[stock_code] = item["orgId"]
                    return item["orgId"]
            break
        except Exception as e:
            if attempt < 2:
                time.sleep(3)
            else:
                print(f"获取orgId失败({stock_code}): {e}")
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


def _extract_controller_names(text):
    """
    从上市公告书中识别控股股东、实际控制人及其控制的企业名称。

    返回 (controller_set, controlled_entity_set)
    """
    controllers = set()
    controlled_entities = set()

    # 控股股东名称
    for m in re.finditer(r'控股股东[是为:：]\s*(.{2,50})[，。,\n]', text):
        name = m.group(1).strip()
        if name:
            controllers.add(name)

    # 实际控制人名称（可能多个人：XXX先生和YYY女士）
    for m in re.finditer(r'实际控制人[是为:：\s]*\n?\s*(.{2,80})[。，,\n]', text, re.DOTALL):
        ctrl_text = m.group(1).strip()
        parts = re.split(r'[、和与]', ctrl_text)
        for part in parts:
            part = re.sub(r'[先生女士]', '', part).strip()
            if part and len(part) >= 2:
                controllers.add(part)

    # 实际控制人控制的企业（100%出资额、控制出资额等）
    for m in re.finditer(r'持有(.{2,30})100%的出资额', text):
        entity = m.group(1).strip()
        if entity:
            controlled_entities.add(entity)

    # 企业名称中出现的"有限公司"或"咨询"等关键词的实体
    # 从"实际控制人为XXX"段落后上下文找企业名
    # 收紧：排除 ETF/指数基金/公募私募/资管等财务投资主体（名称常含"投资"易被误判为一致行动人）
    _FUND_EXCLUDE = re.compile(r'基金|ETF|指数|资产管理|资管|公募|私募')
    # 公司名字符类（中文/字母/数字/括号/·，排除 、，。 等标点），避免把前导"基金、"等
    # 无关文本吞入实体；仅检查匹配关键词尾随12字符是否为基金/资管类，排除财务投资主体。
    _NAME = r'[\u4e00-\u9fa5A-Za-z0-9（）()·.\-]{2,30}'
    for m in re.finditer(r'(' + _NAME + r')(有限|咨询|投资|合伙)', text):
        entity = m.group(1).strip() + m.group(2).strip()
        window = text[m.start():m.end() + 12]
        if entity and len(entity) >= 4 and not _FUND_EXCLUDE.search(window):
            controlled_entities.add(entity)

    return controllers, controlled_entities


def _get_cninfo_session():
    """创建独立的cninfo session，避免共享Eastmoney cookies"""
    s = requests.Session()
    s.headers.update({
        "User-Agent": HEADERS["User-Agent"],
        "Accept": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": "http://www.cninfo.com.cn/",
    })
    return s


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


def fetch_placing_result(stock_code, issue_scale):
    """
    从巨潮资讯网获取可转债**上市公告书**，提取精确限售数据。

    算法：限售 = 控股股东 + 实控人（含其控制企业）+ 一致行动人配售量
          流通 = 发行总量 - 限售

    返回 dict: {"status": "ok"/"error",
                "lock_scale": 限售规模(亿), "circulation_scale": 流通规模(亿),
                "ctrl_zhang": 控股股东配售(张), "total_zhang": 发行总量(张),
                "ctrl_ratio": 限售占比, "source": "上市公告书(明细)",
                "error": "失败原因(仅error时)"}
    """
    org_id = _get_org_id(stock_code)
    if not org_id:
        return {"status": "error", "error": f"巨潮资讯网无法获取股票{stock_code}的orgId"}

    try:
        # 搜索公告（时间范围：最近180天）
        url = "http://www.cninfo.com.cn/new/hisAnnouncement/query"
        today = datetime.now()
        end_date = today.strftime("%Y-%m-%d")
        start_date = (today - timedelta(days=180)).strftime("%Y-%m-%d")
        plate = "sz" if len(stock_code) >= 3 and stock_code[0] in ('0', '3') else "sh"
        data = {
            "pageNum": 1, "pageSize": 50,
            "stock": f"{stock_code},{org_id}",
            "tabName": "fulltext", "column": "szse",
            "plate": plate,
            "seDate": f"{start_date}~{end_date}",
        }

        # 带重试的公告查询
        announcements = None
        cn_session = _get_cninfo_session()
        for attempt in range(3):
            try:
                resp = cn_session.post(url, data=data, timeout=20)
                result = resp.json()
                announcements = result.get("announcements") or []
                break
            except Exception as e:
                if attempt == 2:
                    cn_session.close()
                    return {"status": "error", "error": f"公告查询接口异常: {e}"}
                import time
                time.sleep(2)

        # 优先找上市公告书，没有则尝试发行结果公告
        target = None
        source_type = ""
        for ann in announcements:
            title = ann.get("announcementTitle", "")
            if "上市公告书" in title and "可转换" in title:
                target = ann
                source_type = "上市公告书"
                break
        if not target:
            for ann in announcements:
                title = ann.get("announcementTitle", "")
                if ("中签" in title and "配售" in title) or "发行结果" in title:
                    target = ann
                    source_type = "发行结果公告"
                    break

        if not target:
            cn_session.close()
            return {"status": "error", "error": "未找到上市公告书或发行结果公告，可能公告尚未发布或时间超出180天查询范围"}

        # 下载PDF
        pdf_url = f"http://static.cninfo.com.cn/{target['adjunctUrl']}"
        resp_pdf = cn_session.get(pdf_url, timeout=30)
        cn_session.close()
        if resp_pdf.status_code != 200:
            return {"status": "error", "error": f"PDF下载失败(HTTP {resp_pdf.status_code})"}

        # 解析PDF文本
        doc = fitz.open(stream=resp_pdf.content, filetype='pdf')
        text = ""
        for page in doc:
            text += page.get_text()
        doc.close()

        if source_type == "上市公告书":
            # ---- 从上市公告书解析精确限售数据 ----
            holders = _parse_bond_top10_holders(text)
            if not holders:
                return {"status": "error", "error": "上市公告书中未能解析前十名可转换公司债券持有人表格（PDF表格格式可能不被支持）"}

            controller_names, controlled_entities = _extract_controller_names(text)

            if not controller_names and not controlled_entities:
                return {"status": "error", "error": f"上市公告书中未能识别控股股东/实际控制人信息；前十名持有人明细：{'、'.join(f'{n}({a:,}张)' for n,a,_ in holders[:5])}"}

            # 匹配：控股股东/实控人/控制企业 vs 前十名持有人
            locked_holders = []
            # 直接排除 ETF/指数基金/资管等财务投资主体：其持有人名常带券商 custodian 前缀
            # （如"中国银河证券股份有限公司－XXX证券投资基金"），易被控股股东实体子串命中而
            # 混入限售；按用户要求在此彻底排除，与 _extract_controller_names 的收紧保持一致。
            _FUND_RE = re.compile(r'基金|ETF|指数|资产管理|资管|公募|私募')
            for name, amount, pct in holders:
                if _FUND_RE.search(name):
                    continue
                is_locked = False
                # 检查是否为控股股东
                for ctrl in controller_names:
                    # 子串匹配（如"南京迪威尔实业有限公司" vs "南京迪威尔实业有限公司"）
                    if ctrl in name or name in ctrl:
                        is_locked = True
                        break
                if not is_locked:
                    for entity in controlled_entities:
                        if entity in name or name in entity:
                            is_locked = True
                            break
                if is_locked:
                    locked_holders.append((name, amount, pct))

            if not locked_holders:
                holder_summary = '、'.join(f'{n}' for n, a, _ in holders[:5])
                return {"status": "error", "error": f"控股股东/实控人{controller_names}未在前十名持有人（{holder_summary}…）中找到匹配项"}

            # 计算
            ctrl_zhang = sum(a for _, a, _ in locked_holders)
            ctrl_pct = sum(p for _, _, p in locked_holders if p is not None)
            # 发行总张数（兜底）：从 issue_scale 推算（亿→元→张）
            scale_total = int(issue_scale * 100000000 / 100)

            # 合理性校验：控股股东/实控人配售量为全体持有人的子集，不可能超过发行总量。
            # 若超过，通常是PDF把"持有金额(元)"误读为"持有数量(张)"（面值100元/张，差100倍），
            # 按100元面值折算自动修正；若折算后仍超过，则数据不可信，报错交由报告标注失败。
            corrected_note = ""
            if ctrl_zhang > scale_total:
                if ctrl_zhang / 100 <= scale_total:
                    locked_holders = [(n, int(a / 100), p) for n, a, p in locked_holders]
                    ctrl_zhang = sum(a for _, a, _ in locked_holders)
                    corrected_note = "（金额列已按100元面值折算修正）"
                else:
                    return {"status": "error",
                            "error": f"控股股东/实控人配售量({ctrl_zhang:,}张)超过发行总量({scale_total:,}张)，公告书表格解析异常，流通规模不可信"}

            # 发行总张数：优先从公告书表格自身推导（控股股东持有量 ÷ 其占比%），
            # 比 cb_issue 的 issue_scale 更准；issue_scale 仅作一致性兜底（见 _derive_total_zhang）。
            total_zhang = _derive_total_zhang(ctrl_zhang, ctrl_pct, issue_scale)

            lock_scale = round(ctrl_zhang * 100 / 100000000, 4)
            circulation_scale = round((total_zhang - ctrl_zhang) * 100 / 100000000, 4)
            ctrl_ratio = round(ctrl_zhang / total_zhang * 100, 2) if total_zhang > 0 else 0

            holder_details = '、'.join(f'{n}({a:,}张)' for n, a, _ in locked_holders)

            return {
                "status": "ok",
                "lock_scale": lock_scale,
                "circulation_scale": circulation_scale,
                "ctrl_zhang": ctrl_zhang,
                "total_zhang": total_zhang,
                "ctrl_ratio": ctrl_ratio,
                "source": f"上市公告书（{holder_details}）{corrected_note}",
                "error": None,
            }

        else:
            # ---- 发行结果公告：只有原股东配售总量，没有控股股东级别的细分解 ----
            total_zhang = int(issue_scale * 100000000 / 100)
            ps_zhang = None
            m = re.search(r"原股东.{0,20}[配售].*?(\d[\d,]*)\s*手", text)
            if m:
                ps_zhang = int(m.group(1).replace(",", "")) * 10  # 手→张

            web_zhang = None
            m = re.search(r"网上社会公众投资者.{0,20}认购.*?(\d[\d,]*)\s*手", text)
            if m:
                web_zhang = int(m.group(1).replace(",", "")) * 10  # 手→张

            return {"status": "error", "error": f"仅找到发行结果公告，该公告仅有原股东配售总量(ps_zhang={ps_zhang}手)，无法区分控股股东/实控人的具体配售量，需等待上市公告书发布"}

    except Exception as e:
        return {"status": "error", "error": f"处理异常: {type(e).__name__}: {str(e)}"}


def calc_circulation_scale(info):
    """
    从上市公告书获取可转债精确流通规模。

    精确方法：从巨潮资讯网下载上市公告书PDF，
    解析"前十名可转换公司债券持有人"表格，
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

    placing = fetch_placing_result(stock_code, scale)
    if placing and placing.get("status") == "ok":
        info["lock_scale"] = placing["lock_scale"]
        info["circulation_scale"] = placing["circulation_scale"]
        info["_note"] = placing["source"]
        info["_circulation_source"] = "上市公告书"
    else:
        error_msg = placing.get("error", "查询失败（未知错误）") if placing else "接口无返回"
        info["_note"] = f"⚠️ 上市公告书查询失败：{error_msg}"
        info["_circulation_error"] = error_msg
        # 不设置 circulation_scale / lock_scale，让报告自行处理缺失情况


# 正股行情缓存，避免重复请求
_stock_quote_cache = {}
# 可转债行情缓存
_bond_price_cache = {}


def _get_qt_prefix(code):
    """
    根据证券代码返回腾讯行情前缀 (sh/sz)
    
    规则：
    - 沪市：6xxxxx（沪市主板）、11xxxx（沪市转债）、118xxx（科创板转债）
    - 深市：0xxxxx/3xxxxx（深市主板/创业板）、12xxxx（深市转债）、123xxx（创业板转债）
    - 科创板股票：688xxx → sh
    - 北交所：4xxxxx/8xxxxx → 暂用sz（腾讯行情可能不支持）
    """
    code_str = str(code)
    # 沪市判断
    if code_str.startswith(("6", "11", "118", "688")):
        return "sh"
    return "sz"


# ============ Tushare 数据层（主源，失败回退腾讯/东财）============
_TUSHARE_PRO = None


def _get_tushare_pro():
    """懒加载 Tushare pro 接口；未配置token或tushare未装返回None"""
    global _TUSHARE_PRO
    if _TUSHARE_PRO is not None:
        return _TUSHARE_PRO
    token = os.environ.get('TUSHARE_TOKEN', '')
    if not token:
        return None
    try:
        import tushare as ts
        ts.set_token(token)
        _TUSHARE_PRO = ts.pro_api()
        return _TUSHARE_PRO
    except Exception as e:
        print(f"[Tushare] 初始化失败: {e}")
        return None


def _ts_float(val):
    """安全转float，None/NaN返回None"""
    if val is None:
        return None
    try:
        f = float(val)
        return f if f == f else None
    except (ValueError, TypeError):
        return None


def _str_date(val):
    """Tushare 日期可能为 None/NaN，安全转为 YYYY-MM-DD 或空串"""
    if val is None:
        return ""
    try:
        if float(val) != float(val):  # NaN
            return ""
    except (ValueError, TypeError):
        pass
    s = str(val)[:10]
    return s if re.match(r"^\d{4}-\d{2}-\d{2}$", s) else ""


def _to_ts_code(code):
    """A股/转债代码 → Tushare ts_code（SH/SZ/BJ）"""
    code = str(code).strip()
    if '.' in code:                       # 已是 ts_code（如 300750.SZ），先剥后缀
        code = code.split('.')[0]
    code = code.zfill(6)
    if code[0] == '6' or code.startswith('11'):   # 沪市股票/沪市转债(110/113/118)
        return f"{code}.SH"
    if code.startswith(('8', '92', '43')):        # 北交所
        return f"{code}.BJ"
    return f"{code}.SZ"                           # 深市股票/深市转债(12x)


def _ts_latest_trade_date(pro):
    """获取最近一个交易日(YYYYMMDD)，取最近10天内开市日最大值"""
    try:
        today = datetime.now().strftime('%Y%m%d')
        start = (datetime.now() - timedelta(days=10)).strftime('%Y%m%d')
        df = pro.trade_cal(exchange='SSE', start_date=start, end_date=today,
                           is_open='1', fields='cal_date')
        if df is not None and len(df) > 0:
            return str(df['cal_date'].max())
    except Exception as e:
        print(f"[Tushare] 获取交易日历失败: {e}")
    return None


def _ts_fetch_roe(ts_code):
    """从 fina_indicator 取最新年报ROE(%)，无年报则取最新一期"""
    pro = _get_tushare_pro()
    if not pro:
        return None
    try:
        df = pro.fina_indicator(ts_code=ts_code, fields='ts_code,end_date,roe')
        if df is None or len(df) == 0:
            return None
        annual = df[df['end_date'].astype(str).str.endswith('1231')]
        src = annual if len(annual) > 0 else df
        return _ts_float(src.iloc[0].get('roe'))
    except Exception as e:
        print(f"[Tushare] ROE获取失败({ts_code}): {e}")
        return None


def _fetch_quote_tushare(stock_code):
    """Tushare正股行情：daily_basic(收盘价/PE/PB/总市值) + fina_indicator(ROE)
    返回 {price, pe, pb, roe, market_cap(亿元)}，与腾讯/东财返回结构一致
    """
    pro = _get_tushare_pro()
    if not pro:
        return None
    try:
        ts_code = _to_ts_code(stock_code)
        df = pro.daily_basic(ts_code=ts_code,
                             fields='ts_code,close,pe,pe_ttm,pb,total_mv')
        if df is None or len(df) == 0:
            return None
        row = df.iloc[0]
        price = _ts_float(row.get('close'))
        pe = _ts_float(row.get('pe_ttm')) or _ts_float(row.get('pe'))
        pb = _ts_float(row.get('pb'))
        total_mv = _ts_float(row.get('total_mv'))  # 万元
        market_cap = round(total_mv / 10000.0, 2) if total_mv else None  # →亿元
        roe = _ts_fetch_roe(ts_code)
        if price is None and pe is None and pb is None:
            return None
        return {"price": price, "pe": pe, "pb": pb, "roe": roe, "market_cap": market_cap}
    except Exception as e:
        print(f"[Tushare] 行情获取失败({stock_code}): {e}")
        return None


def _ts_fetch_bond_close(bond_code):
    """Tushare单只转债收盘价"""
    pro = _get_tushare_pro()
    if not pro:
        return None
    try:
        ts_code = _to_ts_code(bond_code)
        df = pro.cb_daily(ts_code=ts_code, fields='ts_code,close')
        if df is None or len(df) == 0:
            return None
        return _ts_float(df.iloc[0].get('close'))
    except Exception as e:
        print(f"[Tushare] 转债行情失败({bond_code}): {e}")
        return None


def _ts_fetch_all_market_prices():
    """Tushare按交易日一次拉全市场：转债收盘价 + 正股收盘价（2个请求）
    返回 (bond_prices{code:price}, stock_prices{code:price})，全失败返回 (None, None)
    """
    pro = _get_tushare_pro()
    if not pro:
        return None, None
    td = _ts_latest_trade_date(pro)
    if not td:
        return None, None
    bond_prices, stock_prices = {}, {}
    try:
        cb_df = pro.cb_daily(trade_date=td, fields='ts_code,close')
        if cb_df is not None and len(cb_df) > 0:
            for _, row in cb_df.iterrows():
                code = str(row['ts_code']).split('.')[0]
                p = _ts_float(row.get('close'))
                if p is not None:
                    bond_prices[code] = p
    except Exception as e:
        print(f"[Tushare] 全市场转债行情失败: {e}")
    try:
        st_df = pro.daily(trade_date=td, fields='ts_code,close')
        if st_df is not None and len(st_df) > 0:
            for _, row in st_df.iterrows():
                code = str(row['ts_code']).split('.')[0]
                p = _ts_float(row.get('close'))
                if p is not None:
                    stock_prices[code] = p
    except Exception as e:
        print(f"[Tushare] 全市场正股行情失败: {e}")
    if not bond_prices and not stock_prices:
        return None, None
    return bond_prices, stock_prices


def _fetch_bond_price(bond_code, list_date):
    """获取可转债交易价格：已上市→实时行情，未上市→面值100"""
    if bond_code in _bond_price_cache:
        return _bond_price_cache[bond_code]

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
        # 主源：Tushare转债收盘价
        price = _ts_fetch_bond_close(bond_code)
        if price:
            _bond_price_cache[bond_code] = price
            return price
        # 兜底：腾讯行情实时价格
        try:
            qt_code = f"{_get_qt_prefix(bond_code)}{bond_code}"
            resp = _get_session().get(f"https://qt.gtimg.cn/q={qt_code}", timeout=10)
            m = re.search(r'="(.+)"', resp.text)
            if m:
                parts = m.group(1).split("~")
                if len(parts) > 3 and parts[3]:
                    price = float(parts[3])
                    _bond_price_cache[bond_code] = price
                    return price
        except Exception:
            pass

    # 未上市或获取失败 → 面值100
    _bond_price_cache[bond_code] = 100
    return 100


def fetch_stock_quote(stock_code):
    """获取正股实时行情（PE/PB/ROE/股价/总市值/行业）- 带缓存"""
    if stock_code in _stock_quote_cache:
        return _stock_quote_cache[stock_code]

    # 主源：Tushare（daily_basic + fina_indicator）
    result = _fetch_quote_tushare(stock_code)
    if result:
        _stock_quote_cache[stock_code] = result
        return result

    # 兜底1：腾讯行情API（sandbox内可达，稳定）
    result = _fetch_quote_tencent(stock_code)
    if result:
        _stock_quote_cache[stock_code] = result
        return result

    # 兜底2：东财push2行情API（可能受限）
    result = _fetch_quote_eastmoney(stock_code)
    if result:
        _stock_quote_cache[stock_code] = result
        return result

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
            ind = df.iloc[0].get("industry")
            if ind:
                return str(ind)
    except Exception:
        pass
    return ""


# 行业PE映射缓存（进程内只构建一次）
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
    except Exception as e:
        print(f"行业PE映射构建失败: {e}")
    return _INDUSTRY_PE_MAP


def _fetch_quote_tencent(stock_code):
    """腾讯行情API - 数据格式稳定，sandbox内可达"""
    try:
        qt_code = f"{_get_qt_prefix(stock_code)}{stock_code}"
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


# ── 热门行业关键词（炒作溢价加成） ──
HOT_SECTOR_KEYWORDS = {
    "半导体": 0.25, "芯片": 0.25, "集成电路": 0.25,
    "AI": 0.25, "人工智能": 0.25, "算力": 0.20,
    "机器人": 0.25, "人形机器人": 0.25, "具身智能": 0.25,
    "新能源": 0.15, "光伏": 0.15, "储能": 0.15, "锂电池": 0.15,
    "低空经济": 0.25, "飞行汽车": 0.25, "无人机": 0.20,
    "新材料": 0.10, "先进材料": 0.15,
    "创新药": 0.15, "生物医药": 0.10, "医疗器械": 0.10,
    "高端装备": 0.10, "航天": 0.15, "军工": 0.10,
    "数据要素": 0.15, "数字经济": 0.10,
    "自动驾驶": 0.15, "智能驾驶": 0.15,
}

# ── 热门赛道加成（新股用，基于2025-2026年实际数据） ──
# 2025-2026年A股零破发，涨幅主要由赛道决定
# 科创板平均417%，北交所229%，主板/创业板约100-200%
NEW_STOCK_HOT_SECTORS = {
    "光通信": 3.0, "光纤": 3.0, "光子": 2.5,
    "半导体": 2.0, "芯片": 2.0, "集成电路": 2.0, "先进封装": 2.0,
    "AI": 2.5, "人工智能": 2.5, "算力": 2.0, "GPU": 2.5,
    "机器人": 1.5, "人形机器人": 2.0, "具身智能": 2.0,
    "低空经济": 1.5, "飞行汽车": 1.5, "航天": 1.0, "航空": 0.8,
    "储能": 1.0, "新能源": 0.8, "光伏": 0.8, "锂电池": 0.8,
    "创新药": 0.8, "医疗器械": 0.5, "生物医药": 0.5,
    "新材料": 0.5, "高端装备": 0.5, "精密制造": 0.3,
    "军工": 0.8, "自动驾驶": 1.0, "智能驾驶": 1.0,
    "电力设备": 0.3, "轨道交通": 0.3, "核电": 0.5,
    "数字经济": 0.5, "数据要素": 0.5, "云计算": 0.5,
    "氢能": 0.8, "钠离子": 0.8, "固态电池": 1.0,
    "消费电子": 0.3, "汽车电子": 0.5,
}

# ── 赛道热度数据驱动系统 ──
# 从已上市股票涨幅统计赛道热度，避免人工设定系数的偏差
# 数据缓存在 SQLite，每日增量更新
_SECTOR_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sector_heat.db")


def _init_sector_db():
    """初始化赛道热度数据库"""
    import sqlite3
    conn = db_pg.connect()
    # 已上市股票-赛道映射表（存储哪些股票属于哪个赛道）
    conn.execute("""
        CREATE TABLE IF NOT EXISTS stock_sector (
            stock_code TEXT,
            sector_key TEXT,
            stock_name TEXT,
            PRIMARY KEY (stock_code, sector_key)
        )
    """)
    # 赛道热度快照表（每日存储一次赛道统计结果）
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sector_heat (
            sector_key TEXT PRIMARY KEY,
            avg_gain_60d REAL,
            stock_count INTEGER,
            boost REAL,
            updated_at TEXT
        )
    """)
    # 股票涨跌幅缓存表（存储最近一次获取的60日涨跌幅）
    conn.execute("""
        CREATE TABLE IF NOT EXISTS stock_gain (
            stock_code TEXT PRIMARY KEY,
            gain_60d REAL,
            updated_at TEXT
        )
    """)
    conn.commit()
    return conn


def _match_sector_by_keywords(search_text):
    """
    对一段文本匹配所有赛道关键词
    返回 [(sector_key, boost), ...]
    """
    matches = []
    for keyword in NEW_STOCK_HOT_SECTORS:
        if keyword in search_text:
            matches.append(keyword)
    return matches


def _build_sector_stock_map(conn):
    """
    构建赛道->股票列表映射
    从所有A股中筛选匹配赛道关键词的股票
    用腾讯行情API批量获取，按行业代码批量处理
    """
    # 先读已有映射
    existing = conn.execute(
        "SELECT stock_code, sector_key FROM stock_sector"
    ).fetchall()
    stock_sectors = {}
    for code, sk in existing:
        if sk not in stock_sectors:
            stock_sectors[sk] = []
        stock_sectors[sk].append(code)

    return stock_sectors


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
        qt_codes = [f"{_get_qt_prefix(c)}{c}" for c in codes]
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


def _fetch_sector_stock_names(conn):
    """
    获取所有已上市A股，通过股票名称匹配赛道关键词
    同时从东财获取股票的行业信息，用行业名辅助匹配
    新增的插入stock_sector表
    """
    stocks = _fetch_all_a_stock_list()
    new_mappings = 0
    # 对每只股票获取行业信息（批量方式：只获取名称匹配不上的）
    # 先按简称匹配
    for code, name in stocks:
        matched = _match_sector_by_keywords(name)
        if matched:
            for sector_key in matched:
                cur = conn.execute(
                    "SELECT 1 FROM stock_sector WHERE stock_code=? AND sector_key=?",
                    (code, sector_key),
                )
                if not cur.fetchone():
                    conn.execute(
                        "INSERT INTO stock_sector (stock_code, sector_key, stock_name) VALUES (?,?,?)",
                        (code, sector_key, name),
                    )
                    new_mappings += 1
            continue  # 名称匹配到的不用再查行业

        # 名称没匹配到，查行业信息
        industry = _fetch_stock_industry(code)
        if industry:
            matched2 = _match_sector_by_keywords(industry)
            for sector_key in matched2:
                cur = conn.execute(
                    "SELECT 1 FROM stock_sector WHERE stock_code=? AND sector_key=?",
                    (code, sector_key),
                )
                if not cur.fetchone():
                    conn.execute(
                        "INSERT INTO stock_sector (stock_code, sector_key, stock_name) VALUES (?,?,?)",
                        (code, sector_key, name),
                    )
                    new_mappings += 1
        time.sleep(0.05)  # 避免请求过快

    conn.commit()
    return new_mappings


def _fetch_stock_60d_gain(stock_code):
    """
    获取某只股票60日涨跌幅
    从东财K线接口获取近60个交易日的收盘价，计算涨跌幅
    支持批量获取（同一板块的股票）
    """
    try:
        code_int = int(stock_code)
        if code_int >= 600000:
            secid = f"1.{stock_code}"
        elif code_int >= 400000:
            secid = f"0.{stock_code}"
        else:
            secid = f"0.{stock_code}"

        url = "https://push2his.eastmoney.com/api/qt/stock/kline/get"
        params = {
            "secid": secid,
            "fields1": "f1,f2,f3,f4,f5,f6",
            "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
            "klt": "101",
            "fqt": 1,
            "end": "20500101",
            "lmt": 65,
        }
        resp = _get_session().get(url, params=params, timeout=10)
        data = resp.json()
        if data.get("data") and data["data"].get("klines"):
            klines = data["data"]["klines"]
            if len(klines) >= 2:
                last_close = float(klines[-1].split(",")[2])
                # 找60个交易日前的收盘价（取最早可用的）
                target_idx = min(60, len(klines) - 1)
                first_close = float(klines[-target_idx].split(",")[2])
                if first_close > 0:
                    return round((last_close - first_close) / first_close * 100, 2)
        return None
    except Exception:
        return None


def _refresh_sector_heat(conn):
    """
    刷新赛道热度数据：
    1. 对每个赛道下的股票获取60日涨跌幅
    2. 算平均值，归一化到0~3.0系数
    3. 写入sector_heat表
    """
    from datetime import datetime

    # 获取所有赛道-股票映射
    rows = conn.execute(
        "SELECT sector_key, stock_code FROM stock_sector"
    ).fetchall()

    sector_stocks = {}
    for sk, code in rows:
        if sk not in sector_stocks:
            sector_stocks[sk] = []
        sector_stocks[sk].append(code)

    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # 获取所有赛道的60日涨幅均值
    sector_avg_gains = {}
    for sector_key, codes in sector_stocks.items():
        gains = []
        for code in codes:
            # 先查缓存
            cur = conn.execute(
                "SELECT gain_60d FROM stock_gain WHERE stock_code=?",
                (code,),
            )
            row = cur.fetchone()
            if row and row[0] is not None:
                gains.append(row[0])
            else:
                gain = _fetch_stock_60d_gain(code)
                if gain is not None:
                    gains.append(gain)
                    conn.execute(
                        "INSERT OR REPLACE INTO stock_gain (stock_code, gain_60d, updated_at) VALUES (?,?,?)",
                        (code, gain, now_str),
                    )
                # 避免请求太快
                time.sleep(0.05)

        if gains:
            avg_gain = sum(gains) / len(gains)
            sector_avg_gains[sector_key] = (avg_gain, len(gains))

    conn.commit()

    # 归一化到0~3.0系数
    # 取所有赛道中最大avg_gain作为基准
    if not sector_avg_gains:
        return

    max_avg = max(v[0] for v in sector_avg_gains.values())

    for sector_key, (avg_gain, count) in sector_avg_gains.items():
        # 归一化: boost = (avg_gain / max_avg) * 3.0
        boost = round((avg_gain / max_avg) * 3.0, 2) if max_avg > 0 else 0
        conn.execute(
            "INSERT OR REPLACE INTO sector_heat (sector_key, avg_gain_60d, stock_count, boost, updated_at) VALUES (?,?,?,?,?)",
            (sector_key, round(avg_gain, 2), count, boost, now_str),
        )
    conn.commit()


def calibrate_sector_boost():
    """
    自动校准赛道热度系数
    数据来源：理杏仁手动导出的一次性CSV -> stock_sector + stock_gain 表
    日常运行只从本地数据库读取，不请求外部接口
    如需刷新涨幅数据：读取DB已有股票列表，逐只从东财K线接口获取最新60日涨幅
    """
    from datetime import datetime

    conn = _init_sector_db()

    # 检查数据库是否有数据
    sector_count = conn.execute("SELECT COUNT(*) FROM sector_heat").fetchone()[0]
    stock_sector_count = conn.execute("SELECT COUNT(*) FROM stock_sector").fetchone()[0]

    if stock_sector_count == 0:
        print("[赛道热度] 数据库无数据（请先运行 import_lixinger_csv.py 导入理杏仁CSV）")
        print("[赛道热度] 使用默认赛道系数")
        conn.close()
        return

    # 检查是否需要刷新涨幅数据（>24h 且 距上次刷新>1天）
    cur = conn.execute("SELECT MAX(updated_at) FROM sector_heat")
    last_update = cur.fetchone()[0]
    need_refresh = True
    if last_update:
        try:
            last_dt = datetime.strptime(last_update, "%Y-%m-%d %H:%M:%S")
            if (datetime.now() - last_dt).total_seconds() < 86400:
                need_refresh = False
                print(f"[赛道热度] 数据上次更新 {last_update}，24小时内无需刷新")
        except ValueError:
            pass

    if need_refresh and sector_count > 0:
        print("[赛道热度] 正在刷新股票60日涨跌幅（增量）...")
        # 只对 stock_sector 表中已有的股票刷新涨跌幅
        stock_codes = conn.execute(
            "SELECT DISTINCT stock_code FROM stock_sector"
        ).fetchall()
        stock_codes = [r[0] for r in stock_codes]

        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        updated_count = 0
        sector_gains = {}  # sector_key -> [gain, ...]

        for i, code in enumerate(stock_codes):
            # 从东财K线获取60日涨幅
            gain = _fetch_stock_60d_gain(code)
            if gain is not None:
                conn.execute(
                    "INSERT OR REPLACE INTO stock_gain (stock_code, gain_60d, updated_at) VALUES (?,?,?)",
                    (code, gain, now_str),
                )
                updated_count += 1
                # 同时收集用于计算
                sector_keys = conn.execute(
                    "SELECT sector_key FROM stock_sector WHERE stock_code=?",
                    (code,),
                ).fetchall()
                for (sk,) in sector_keys:
                    if sk not in sector_gains:
                        sector_gains[sk] = []
                    sector_gains[sk].append(gain)
            time.sleep(0.03)  # 间隔

        print(f"[赛道热度] 已刷新 {updated_count}/{len(stock_codes)} 只股票的60日涨跌幅")

        # 计算新的赛道热度系数
        if sector_gains:
            max_avg = 1
            for gains in sector_gains.values():
                if gains:
                    avg = sum(gains) / len(gains)
                    if avg > max_avg:
                        max_avg = avg

            for sector_key, gains in sector_gains.items():
                if not gains:
                    continue
                avg_gain = sum(gains) / len(gains)
                boost = round((avg_gain / max_avg) * 3.0, 2) if max_avg > 0 else 0
                conn.execute(
                    "INSERT OR REPLACE INTO sector_heat (sector_key, avg_gain_60d, stock_count, boost, updated_at) VALUES (?,?,?,?,?)",
                    (sector_key, round(avg_gain, 2), len(gains), boost, now_str),
                )
            conn.commit()
            print("[赛道热度] 赛道系数已刷新")

    # 从数据库读取热度系数
    rows = conn.execute(
        "SELECT sector_key, boost, avg_gain_60d, stock_count FROM sector_heat ORDER BY boost DESC"
    ).fetchall()
    conn.close()

    # 更新全局 NEW_STOCK_HOT_SECTORS
    updated = []
    for sector_key, boost, avg_gain, count in rows:
        old = NEW_STOCK_HOT_SECTORS.get(sector_key, "?")
        NEW_STOCK_HOT_SECTORS[sector_key] = boost
        updated.append(f"{sector_key}: {old}→{boost}（{count}只, 60日均值{avg_gain}%）")

    if updated:
        print(f"[赛道热度] 赛道系数已更新（共{len(rows)}个赛道）")
        for line in updated[:10]:
            print(f"  {line}")
        if len(updated) > 10:
            print(f"  ... 还有{len(updated)-10}个赛道")


# ── 市场温度检测 ──
_MARKET_TEMP = {"level": "热市", "break_rate": 0, "avg_gain_3m": 0}
_TEMP_CALIBRATED = False


def detect_market_temperature():
    """
    检测当前新股市场温度
    从 ipo_history.db 统计近6个月数据
    返回 {'level': '热市'|'常温'|'冷市', 'break_rate': float, 'avg_gain_6m': float}
    """
    global _MARKET_TEMP, _TEMP_CALIBRATED
    from datetime import datetime, timedelta

    cutoff = (datetime.now() - timedelta(days=180)).strftime("%Y-%m-%d")
    try:
        conn = _init_ipo_db()
        rows = conn.execute(
            "SELECT ld_close_change FROM ipo_history WHERE listing_date >= ? AND ld_close_change IS NOT NULL AND market_type != '北交所'",
            (cutoff,),
        ).fetchall()
        conn.close()
    except Exception:
        rows = []

    if not rows:
        print("[市场温度] 数据不足，默认热市")
        _MARKET_TEMP = {"level": "热市", "break_rate": 0, "avg_gain_3m": 250}
        _TEMP_CALIBRATED = True
        return _MARKET_TEMP

    gains = [r[0] for r in rows]
    total = len(gains)
    break_count = sum(1 for g in gains if g < 0)
    break_rate = break_count / total if total > 0 else 0
    avg_gain = sum(gains) / total if total > 0 else 0

    if break_rate == 0 and avg_gain > 150:
        level = "热市"
    elif break_rate < 0.05 and avg_gain > 30:
        level = "常温"
    else:
        level = "冷市"

    _MARKET_TEMP = {"level": level, "break_rate": round(break_rate * 100, 1), "avg_gain_3m": round(avg_gain, 1)}
    _TEMP_CALIBRATED = True

    print(f"[市场温度] {level}（破发率{_MARKET_TEMP['break_rate']}%，6月均涨幅{_MARKET_TEMP['avg_gain_3m']}%）")
    return _MARKET_TEMP


# ── 新债市场温度（独立计算） ──
_BOND_MARKET_TEMP = {"level": "热市", "break_rate": 0, "avg_gain_6m": 0}

def detect_bond_market_temperature():
    """
    检测当前新债（可转债）市场温度
    从 bond_history 表或东财接口统计近6个月数据
    返回 {'level': '热市'|'常温'|'冷市', 'break_rate': float, 'avg_gain_6m': float}
    """
    global _BOND_MARKET_TEMP
    from datetime import datetime, timedelta

    cutoff = (datetime.now() - timedelta(days=180)).strftime("%Y-%m-%d")

    # 先从数据库查，检查数据是否够新（24h内）
    try:
        conn = _init_ipo_db()
        last_update = conn.execute("SELECT MAX(updated_at) FROM bond_history").fetchone()[0]
        need_fetch = True
        if last_update:
            try:
                last_dt = datetime.strptime(last_update, "%Y-%m-%d %H:%M:%S")
                if (datetime.now() - last_dt).total_seconds() < 86400:
                    need_fetch = False
            except ValueError:
                pass

        if need_fetch:
            conn.close()
            rows = _fetch_bond_listing_data_from_api(cutoff)
            # 保存后重新读取
            conn = _init_ipo_db()
            db_rows = conn.execute(
                "SELECT first_day_return FROM bond_history WHERE listing_date >= ? AND first_day_return IS NOT NULL",
                (cutoff,),
            ).fetchall()
            conn.close()
            rows = [r[0] for r in db_rows]
        else:
            db_rows = conn.execute(
                "SELECT first_day_return FROM bond_history WHERE listing_date >= ? AND first_day_return IS NOT NULL",
                (cutoff,),
            ).fetchall()
            conn.close()
            rows = [r[0] for r in db_rows]
    except Exception:
        rows = []

    if not rows:
        print("[新债市场温度] 数据不足，默认热市")
        _BOND_MARKET_TEMP = {"level": "热市", "break_rate": 0, "avg_gain_6m": 30}
        return _BOND_MARKET_TEMP

    gains = rows
    total = len(gains)
    break_count = sum(1 for g in gains if g < 0)
    break_rate = break_count / total if total > 0 else 0
    avg_gain = sum(gains) / total if total > 0 else 0

    if break_rate == 0 and avg_gain > 40:
        level = "热市"
    elif break_rate < 0.05 and avg_gain > 10:
        level = "常温"
    else:
        level = "冷市"

    _BOND_MARKET_TEMP = {"level": level, "break_rate": round(break_rate * 100, 1), "avg_gain_6m": round(avg_gain, 1)}
    print(f"[新债市场温度] {level}（破发率{_BOND_MARKET_TEMP['break_rate']}%，6月均涨幅{_BOND_MARKET_TEMP['avg_gain_6m']}%）")
    return _BOND_MARKET_TEMP


def _fetch_bond_listing_data_from_api(cutoff_date):
    """从东财获取近6个月上市新债，再从腾讯K线获取上市首日收盘价计算涨幅"""
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
                        ld_str = str(ld)[:10]
                        listing_dt = datetime.strptime(ld_str, "%Y-%m-%d")
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
        prefix = _get_qt_prefix(code)
        qt_code = f"{prefix}{code}"
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
            for d in days:
                if d[0] == ld:
                    listing_found = True
                    prev_close = float(d[2])
                    # D1涨停→跳过，否则直接取D1
                    if prev_close < 157.0:
                        day2_close = prev_close
                        break
                    continue
                if listing_found and len(d) >= 3:
                    close = float(d[2])
                    # 计算当日理论涨停价（可转债日常±20%）
                    limit_price = round(prev_close * 1.2, 1)
                    # 没涨停→取这天
                    if abs(close - limit_price) > 0.5:
                        day2_close = close
                        break
                    # 涨停了→记录暂存，继续看下一天
                    prev_close = close
                    day2_close = close
            if day2_close is None:
                # 所有天都涨停，fallback到首日收盘
                for d in days:
                    if d[0] == ld and len(d) >= 3:
                        day2_close = float(d[2])
                        break
            if day2_close is None:
                continue
            first_day_return = day2_close - 100  # 百分比值
            gains.append(first_day_return)
            # 保存到数据库（SQLite）
            try:
                conn = _init_ipo_db()
                conn.execute(
                    "INSERT OR REPLACE INTO bond_history (security_code, security_name, listing_date, first_day_return, updated_at) VALUES (?,?,?,?,?)",
                    (code, name, ld, round(first_day_return, 2), datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
                )
                conn.commit()
                conn.close()
            except Exception:
                pass
        except Exception:
            continue

    print(f"[新债温度] 从K线获取到 {len(gains)} 只新债首日涨幅")
    return gains


def get_temp_pe_penalty(issue_pe, industry_pe):
    """
    根据市场温度计算PE惩罚/奖励系数
    返回 >1=奖励, <1=惩罚, 1=无变化
    """
    temp = _MARKET_TEMP["level"]
    if not issue_pe or not industry_pe or industry_pe <= 0:
        return 1.0

    pe_ratio = issue_pe / industry_pe

    if temp == "热市":
        if pe_ratio < 0.7:
            return 1.2
        return 1.0
    elif temp == "常温":
        if pe_ratio < 0.7:
            return 1.15
        elif pe_ratio > 2:
            return 0.85
        elif pe_ratio > 1.5:
            return 0.92
        return 1.0
    else:  # 冷市
        if pe_ratio < 0.7:
            return 1.05
        elif pe_ratio > 2:
            return 0.6
        elif pe_ratio > 1.5:
            return 0.75
        elif pe_ratio > 1.2:
            return 0.88
        return 1.0


def get_temp_temp_score_penalty(score):
    """
    根据市场温度对综合评分做整体衰减/放大
    """
    temp = _MARKET_TEMP["level"]
    if temp == "热市":
        return score  # 不动
    elif temp == "常温":
        return int(score * 0.85)  # 打85折
    else:  # 冷市
        return int(score * 0.5)  # 打5折


def get_temp_listing_multiplier():
    """
    根据市场温度返回上市预测的涨幅衰减系数
    """
    temp = _MARKET_TEMP["level"]
    if temp == "热市":
        return 1.0
    elif temp == "常温":
        return 0.75
    else:  # 冷市
        return 0.4
# 板块基准首日涨幅（默认值，运行时会自动校准）
BOARD_BASE = {
    "科创板": 417,
    "北交所": 229,
    "创业板": 200,
    "深市主板": 150,
    "沪市主板": 150,
}

# 东财接口 MARKET_TYPE 到 BOARD_BASE 键的映射（前缀匹配）
# 东财实际返回值：科创板、北交所、非科创板（含创业板+深市主板+沪市主板）
# 需要根据股票代码前缀进一步细分
_MARKET_TYPE_MAP = {
    "科创板": "科创板",
    "北交所": "北交所",
    "非科创板": None,  # 需要根据代码细分
}
def _market_type_to_board_key(mt, code):
    """将东财 MARKET_TYPE + 股票代码 映射到 BOARD_BASE 的板块键"""
    board_key = _MARKET_TYPE_MAP.get(mt)
    if board_key is not None:
        return board_key
    # 非科创板需要按代码细分
    code_str = str(code)
    if code_str.startswith(("300", "301")):
        return "创业板"
    elif code_str.startswith(("000", "001", "002", "003")):
        return "深市主板"
    else:
        return "沪市主板"

# 最近N个月用于校准的数据范围
_CALIBRATE_MONTHS = 12

# 板块基准是否已校准
_BOARD_CALIBRATED = False

# SQLite 数据库路径（存放新股历史首日涨幅）
_IPO_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ipo_history.db")


def _is_bj_stock(code):
    """判断是否是北交所股票（北交所暂不参与每日推荐）"""
    code_str = str(code)
    return code_str.startswith(("920", "82", "83", "87", "43"))


def _init_ipo_db():
    """初始化新股历史数据库"""
    import sqlite3
    conn = db_pg.connect()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS ipo_history (
            security_code TEXT PRIMARY KEY,
            security_name TEXT,
            market_type TEXT,
            listing_date TEXT,
            ld_close_change REAL,
            board_key TEXT,
            updated_at TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS bond_history (
            security_code TEXT PRIMARY KEY,
            security_name TEXT,
            listing_date TEXT,
            first_day_return REAL,
            updated_at TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS predictions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            code TEXT NOT NULL,
            name TEXT NOT NULL,
            listing_date TEXT NOT NULL,
            pred_date TEXT NOT NULL,
            pred_return REAL,
            pred_price REAL,
            pred_advice TEXT,
            actual_return REAL,
            actual_price REAL,
            actual_date TEXT,
            status TEXT DEFAULT 'pending',
            updated_at TEXT,
            UNIQUE(type, code, pred_date)
        )
    """)
    conn.commit()
    return conn


def _sync_ipo_history(records):
    """
    将接口返回的新股数据同步到本地数据库
    已存在的记录跳过（不变），新增的记录插入
    已存在但LD_CLOSE_CHANGE为空的记录，若接口提供则更新
    """
    import sqlite3
    conn = _init_ipo_db()
    inserted = 0
    updated = 0
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    for r in records:
        code = r.get("SECURITY_CODE", "")
        if not code:
            continue
        api_close_change = r.get("LD_CLOSE_CHANGE")
        # 检查是否已存在
        cur = conn.execute("SELECT ld_close_change FROM ipo_history WHERE security_code=?", (code,))
        existing = cur.fetchone()
        if existing:
            # 已存在且ld_close_change为空，但接口现在提供 → 更新
            if existing[0] is None and api_close_change is not None:
                conn.execute(
                    "UPDATE ipo_history SET ld_close_change=?, updated_at=? WHERE security_code=?",
                    (api_close_change, now_str, code),
                )
                updated += 1
            continue
        mt = r.get("MARKET_TYPE", "")
        board_key = _market_type_to_board_key(mt, code)
        conn.execute(
            "INSERT OR IGNORE INTO ipo_history (security_code, security_name, market_type, listing_date, ld_close_change, board_key, updated_at) VALUES (?,?,?,?,?,?,?)",
            (
                code,
                r.get("SECURITY_NAME_ABBR", ""),
                mt,
                r.get("LISTING_DATE", ""),
                api_close_change,
                board_key,
                now_str,
            ),
        )
        inserted += 1
    conn.commit()
    conn.close()
    if updated > 0:
        print(f"[校准] 回填 {updated} 条LD_CLOSE_CHANGE")
    return inserted


def _save_stock_detail_to_db(code, detail):
    """将新股详细发行数据存入ipo_history数据库"""
    if not detail:
        return
    try:
        conn = _init_ipo_db()
        # 计算衍生字段
        ip = detail.get("issue_price")
        ipe = detail.get("issue_pe")
        ind_pe = detail.get("industry_pe")
        os_ = detail.get("online_shares")
        cmv = round(os_ * ip / 10000, 2) if os_ and ip else None
        pe_ratio = round(ind_pe / ipe, 2) if ind_pe and ipe else None

        conn.execute("""
            UPDATE ipo_history SET
                issue_price=?,
                issue_pe=?,
                industry_pe=?,
                fund_raised=?,
                total_shares=?,
                online_shares=?,
                online_lottery_rate=?,
                oversubscribe_multiple=?,
                subscribe_upper_limit=?,
                main_business=?,
                industry=?,
                circulation_mv=?,
                pe_ratio=?
            WHERE security_code=?
        """, (
            ip,
            ipe,
            ind_pe,
            detail.get("fund_raised"),
            detail.get("total_shares"),
            os_,
            detail.get("online_lottery_rate"),
            detail.get("oversubscribe_multiple"),
            detail.get("subscribe_upper_limit"),
            detail.get("main_business"),
            detail.get("industry"),
            cmv,
            pe_ratio,
            code,
        ))
        conn.commit()
        conn.close()
    except Exception:
        pass
# 全量可转债行情缓存（转股价值+价格+溢价率，用于迭代收敛法）
_BONDS_MARKET_CACHE = None  # list of (code, bond_price, transfer_value, premium_pct, stock_code)


def _fetch_all_bonds_market():
    """
    获取全市场可转债实时行情数据

    数据源：东财 datacenter RPT_BOND_CB_LIST（全量329只，含代码+转股价+正股代码+到期日）
          + 腾讯行情 API（批量获取转债现价+正股现价）

    过滤：DELIST_DATE为None（未退市）且 EXPIRE_DATE 未过期

    返回：[(code, bond_price, transfer_value, premium_pct, stock_code), ...]
    """
    global _BONDS_MARKET_CACHE
    if _BONDS_MARKET_CACHE is not None:
        return _BONDS_MARKET_CACHE

    import re as _re
    from datetime import datetime

    s = _get_session()
    today = datetime.now()

    # ── 1. 从东财 datacenter 获取所有转债基础信息 ──
    url = "https://datacenter-web.eastmoney.com/api/data/v1/get"
    codes = []
    seen = set()
    for page in range(1, 50):
        params = {
            "reportName": "RPT_BOND_CB_LIST",
            "columns": "SECURITY_CODE,SECURITY_NAME_ABBR,CONVERT_STOCK_CODE,INITIAL_TRANSFER_PRICE,EXPIRE_DATE,DELIST_DATE,LISTING_DATE",
            "pageNumber": page,
            "pageSize": 100,
            "sortTypes": -1,
            "sortColumns": "SECURITY_CODE",
            "source": "WEB",
            "client": "WEB",
        }
        try:
            resp = s.get(url, params=params, timeout=15)
            data = resp.json()
            if not (data.get("success") and data["result"] and data["result"]["data"]):
                break
            added = 0
            for b in data["result"]["data"]:
                sc = b.get("SECURITY_CODE", "")
                if sc in seen:
                    continue
                seen.add(sc)

                # 过滤已退市
                if b.get("DELIST_DATE"):
                    continue
                # 过滤已到期
                expire = b.get("EXPIRE_DATE")
                if expire:
                    try:
                        if isinstance(expire, str):
                            expire_dt = datetime.strptime(expire[:10], "%Y-%m-%d")
                            if expire_dt < today:
                                continue
                    except (ValueError, TypeError):
                        pass
                # 过滤未上市（LISTING_DATE为空或还未到上市日期）
                list_date = b.get("LISTING_DATE")
                if not list_date:
                    continue
                try:
                    if isinstance(list_date, str):
                        ld = datetime.strptime(list_date[:10], "%Y-%m-%d")
                        if ld > today:
                            continue
                except (ValueError, TypeError):
                    pass

                stock = b.get("CONVERT_STOCK_CODE")
                tp = b.get("INITIAL_TRANSFER_PRICE")
                if sc and stock and tp:
                    codes.append((sc, stock, float(tp)))
                    added += 1
            if added == 0:
                break
        except Exception:
            break

    if not codes:
        return None

    # ── 2. 转债价格 + 正股价格 ──
    # 主源：Tushare按交易日一次拉全市场（2个请求）
    bond_prices, stock_prices = _ts_fetch_all_market_prices()

    # 兜底：Tushare失败时用腾讯行情批量获取
    if bond_prices is None:
        bond_prices = {}
        stock_prices = {}
        all_qt = []
        for sc, stock, tp in codes:
            all_qt.append(f"{_get_qt_prefix(sc)}{sc}")
            all_qt.append(f"{_get_qt_prefix(stock)}{stock}")

        for i in range(0, len(all_qt), 50):
            batch = all_qt[i:i + 50]
            try:
                resp = s.get(f"https://qt.gtimg.cn/q={','.join(batch)}", timeout=15)
                for line in resp.text.strip().split(";"):
                    m = _re.search(r'v_(\w+)="(.+)"', line.strip())
                    if m:
                        parts = m.group(2).split("~")
                        if len(parts) >= 4 and parts[3]:
                            code = parts[2]
                            try:
                                price = float(parts[3])
                            except ValueError:
                                continue
                            if code in {c[0] for c in codes}:
                                bond_prices[code] = price
                            else:
                                stock_prices[code] = price
            except Exception:
                continue

    # ── 3. 计算转股价值和溢价率 ──
    result = []
    for sc, stock, tp in codes:
        bp = bond_prices.get(sc)
        sp = stock_prices.get(stock)
        if bp and sp and tp > 0 and sp > 0:
            tv = round(100.0 / tp * sp, 2)
            premium = round((bp / tv - 1) * 100, 2)
            result.append((sc, bp, tv, premium, stock))

    _BONDS_MARKET_CACHE = result
    return result


def _get_market_premium_curve(bonds_data):
    """
    从全市场转债数据构建"转股价值 → 溢价率"映射表

    按转股价值10元一档，取每档中位数溢价率。
    返回: {转股价值区间: 中位数溢价率} 的字典
    """
    curve = {}
    for lo in range(0, 300, 10):
        hi = lo + 10
        group = sorted([d[3] for d in bonds_data if lo <= d[2] < hi])
        if len(group) >= 3:
            curve[(lo, hi)] = group[len(group) // 2]
    return curve


def _estimate_initial_premium_by_iteration(transfer_value, bonds_data):
    """
    转股价值分档中位数法估算新债上市首日基础溢价率

    算法：
    1. 转股价值向下取整到10元档（如122.45 → 120-130区间）
    2. 取该区间内全市场转债溢价率的中位数
    3. 样本不足时扩大范围到±15、±25，最终fallback到全市场中位数

    为什么用转股价值分档：
    - 转债溢价率主要由转股价值决定（债性/股性二元结构）
    - 同转股价值区间的转债，市场给予的溢价率相近
    - 中位数比平均数更稳健，不受极端妖债影响
    """
    tv = float(transfer_value)

    # 转股价值10元一档
    bucket = int(tv // 10) * 10
    bucket_prems = sorted([d[3] for d in bonds_data if bucket <= d[2] < bucket + 10])

    if len(bucket_prems) >= 3:
        return bucket_prems[len(bucket_prems) // 2] / 100

    # 样本不足：扩大到转股价值±15
    nearby = sorted([d[3] for d in bonds_data if abs(d[2] - tv) <= 15])
    if len(nearby) >= 3:
        return nearby[len(nearby) // 2] / 100

    # 再扩大到±25
    nearby = sorted([d[3] for d in bonds_data if abs(d[2] - tv) <= 25])
    if len(nearby) >= 3:
        return nearby[len(nearby) // 2] / 100

    # 最终fallback：全市场中位数
    all_prems = sorted([d[3] for d in bonds_data])
    if all_prems:
        return all_prems[len(all_prems) // 2] / 100

    return 0.40  # 默认40%


# ── 市场热度快照 ──
_MARKET_SNAPSHOT = {
    "avg_premium": 0.40,       # 全市场平均溢价率（迭代收敛法的初始值）
    "index_level": "偏高",     # 综合判断
    "index_1m": -0.28,         # 中证转债近1月涨跌幅(%)
}


def fetch_market_heat():
    """获取当前市场热度指标（基于全量转债实时行情）"""
    global _BONDS_MARKET_CACHE

    try:
        bonds_data = _fetch_all_bonds_market()
        if bonds_data:
            all_prems = [d[3] for d in bonds_data]
            avg_p = sum(all_prems) / len(all_prems)
            _MARKET_SNAPSHOT["avg_premium"] = avg_p / 100

            # 基于全市场平均溢价率判断热度
            if avg_p < 25:
                _MARKET_SNAPSHOT["index_level"] = "低估"
            elif avg_p < 35:
                _MARKET_SNAPSHOT["index_level"] = "中性偏低"
            elif avg_p < 50:
                _MARKET_SNAPSHOT["index_level"] = "中性"
            elif avg_p < 70:
                _MARKET_SNAPSHOT["index_level"] = "偏高"
            else:
                _MARKET_SNAPSHOT["index_level"] = "高估"

        # 中证转债指数近1月涨跌
        index_change = _fetch_cb_index_change()
        if index_change is not None:
            _MARKET_SNAPSHOT["index_1m"] = index_change
    except Exception:
        pass

    return _MARKET_SNAPSHOT


def _fetch_cb_index_change():
    """获取中证转债指数(000832)近1月涨跌幅"""
    try:
        url = "https://push2his.eastmoney.com/api/qt/stock/kline/get"
        params = {
            "secid": "1.000832",
            "fields1": "f1,f2,f3,f4,f5,f6",
            "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
            "klt": "101",  # 日线
            "fqt": 1,
            "end": "20500101",
            "lmt": 25,  # 取近25个交易日（约1个月）
        }
        resp = _get_session().get(url, params=params, timeout=10)
        data = resp.json()
        if data.get("data") and data["data"].get("klines"):
            klines = data["data"]["klines"]
            if len(klines) >= 2:
                last = float(klines[-1].split(",")[2])
                first = float(klines[0].split(",")[2])
                if first > 0:
                    change_pct = round((last - first) / first * 100, 2)
                    return change_pct
    except Exception:
        pass
    return None


def detect_hot_sector(bond_name, stock_name, stock_industry=""):
    """
    检测正股是否属于当前市场炒作热门赛道
    返回 (sector_label, premium_boost)
    """
    search_text = f"{bond_name} {stock_name} {stock_industry}"
    for keyword, boost in HOT_SECTOR_KEYWORDS.items():
        if keyword in search_text:
            return keyword, boost
    return None, 0


def detect_stock_hot_sector(stock_name, main_business, industry):
    """检测新股热门赛道（基于2025-2026年实际涨幅数据）"""
    search_text = f"{stock_name} {main_business} {industry}"
    best_label, best_boost = None, 0
    for keyword, boost in NEW_STOCK_HOT_SECTORS.items():
        if keyword in search_text:
            if boost > best_boost:
                best_boost = boost
                best_label = keyword
    return best_label, best_boost


# ════════════════════════════════════════════
# XGBoost 动态校准：牛市修正参数
# ════════════════════════════════════════════

def _get_board_key_from_code(code):
    """从股票代码获取板块键"""
    code_str = str(code)
    if code_str.startswith("688"):
        return "科创板"
    if code_str.startswith(("300", "301")):
        return "创业板"
    if code_str.startswith(("000", "001", "002", "003")):
        return "深市主板"
    if code_str.startswith(("60",)):
        return "沪市主板"
    return "科创板"


def _calc_xgb_boost(stock_detail, xgb_raw):
    """根据板块基准和市场温度，计算XGBoost动态调整系数"""
    if xgb_raw is None or xgb_raw <= 0:
        return 1.0

    code = stock_detail.get("stock_code", "")
    board_key = _get_board_key_from_code(code)
    board_base = BOARD_BASE.get(board_key, 200)

    # 目标：让XGBoost预测值向板块基准收敛
    # 如果XGBoost明显低于板块基准（在牛市常见），则向上修正
    ratio = board_base / max(xgb_raw, 10)

    # 热市下，如果板基准远高于XGBoost，加大修正力度
    temp = _MARKET_TEMP["level"]
    if temp == "热市":
        # 热市时板基准置信度高，主动拉高XGBoost
        boost = 1.0 + (ratio - 1.0) * 0.6
    elif temp == "常温":
        boost = 1.0 + (ratio - 1.0) * 0.3
    else:
        # 冷市：不向上修正，反而保守
        boost = 1.0

    # 限制范围 0.5x ~ 3.0x
    boost = max(0.5, min(3.0, boost))
    return round(boost, 3)


# ════════════════════════════════════════════
# 上市后回填 & 预测误差校准
# ════════════════════════════════════════════

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
            prefix = _get_qt_prefix(code)
            qt_code = f"{prefix}{code}"
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


def _log_prediction_errors():
    """
    统计预测 vs 实际误差，输出到日志供参考
    后续可用此数据自动校准预测参数
    """
    import sqlite3
    from datetime import datetime, timedelta

    conn = _init_ipo_db()
    cutoff = (datetime.now() - timedelta(days=90)).strftime("%Y-%m-%d")

    for ptype, label in [("stock", "新股"), ("bond", "新债")]:
        rows = conn.execute(
            "SELECT name, code, pred_return, actual_return, listing_date FROM predictions "
            "WHERE type=? AND status='fulfilled' AND actual_return IS NOT NULL AND pred_return IS NOT NULL "
            "AND pred_date >= ? ORDER BY listing_date DESC LIMIT 10",
            (ptype, cutoff),
        ).fetchall()
        if rows:
            errors = [abs(r[2] - r[3]) for r in rows if r[3] is not None]
            if errors:
                mae = round(sum(errors) / len(errors), 1)
                bias = round(sum(r[3] - r[2] for r in rows if r[3] is not None) / len(errors), 1)
                print(f"[校准] {label}预测偏差: MAE={mae}pp, 平均偏向={bias}pp（正=低估, 负=高估）")
                # 偏差过大时输出明细
                if abs(bias) > 100:
                    print(f"[校准] {label}偏差较大，明细如下：")
                    for r in rows:
                        if r[3] is not None:
                            print(f"  {r[0]}({r[1]}): 预测{r[2]}% 实际{r[3]}% 误差{r[3]-r[2]:+.1f}pp")

    conn.close()


# ════════════════════════════════════════════
# 预测跟踪 & 准确率统计
# ════════════════════════════════════════════

def save_predictions(apply_stocks, apply_bonds, list_stocks, list_bonds, pred_date):
    """保存预测记录到数据库"""
    import sqlite3
    today_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    conn = _init_ipo_db()

    rows = []
    for s in apply_stocks + list_stocks:
        analysis = s.get("listing_analysis", {})
        pred_return = None
        if isinstance(analysis, dict):
            pred_return = analysis.get("predicted_return") or analysis.get("price")
        advice = s.get("advice", "")
        listing_date = pred_date

        rows.append(("stock", s["code"], s["name"], listing_date,
                      pred_date, pred_return, None, advice,
                      today_str))

    for b in apply_bonds + list_bonds:
        analysis = b.get("listing_analysis", {})
        pred_price = None
        pred_return = None
        if isinstance(analysis, dict):
            pred_price = analysis.get("price")
            pred_return = analysis.get("premium")
        advice = b.get("advice", "")
        listing_date = pred_date

        rows.append(("bond", b["code"], b["name"], listing_date,
                      pred_date, pred_return, pred_price, advice,
                      today_str))

    for row in rows:
        try:
            conn.execute("""
                INSERT OR REPLACE INTO predictions
                    (type, code, name, listing_date, pred_date, pred_return, pred_price, pred_advice, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?)
            """, row)
        except Exception:
            pass
    conn.commit()
    conn.close()
    if rows:
        print(f"[预测跟踪] 已保存 {len(rows)} 条预测记录")


def backfill_prediction_actuals():
    """补全已上市的预测记录，并回填实际结果"""
    from datetime import datetime

    conn = _init_ipo_db()
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # ── 1. 补全：bond_history / ipo_history 已上市但 predictions 缺记录的 ──
    bond_rows = conn.execute(
        "SELECT security_code, security_name, listing_date, first_day_return FROM bond_history WHERE first_day_return IS NOT NULL"
    ).fetchall()
    for code, name, ldate, fdr in bond_rows:
        if not conn.execute("SELECT 1 FROM predictions WHERE code=?", (code,)).fetchone():
            ld = str(ldate)[:10] if ldate else None
            conn.execute(
                "INSERT INTO predictions (type,code,name,listing_date,pred_date,actual_return,status,updated_at) VALUES ('bond',?,?,?,?,?,'fulfilled',?)",
                (code, name, ld, ld, fdr, now),
            )
    stock_rows = conn.execute(
        "SELECT security_code, security_name, listing_date, ld_close_change FROM ipo_history WHERE ld_close_change IS NOT NULL"
    ).fetchall()
    for code, name, ldate, ldc in stock_rows:
        if not conn.execute("SELECT 1 FROM predictions WHERE code=?", (code,)).fetchone():
            ld = str(ldate)[:10] if ldate else None
            conn.execute(
                "INSERT INTO predictions (type,code,name,listing_date,pred_date,actual_return,status,updated_at) VALUES ('stock',?,?,?,?,?,'fulfilled',?)",
                (code, name, ld, ld, ldc, now),
            )
    conn.commit()

    # ── 2. 回填 pending 中已上市的实际结果（按 code 匹配首日数据） ──
    pending = conn.execute(
        "SELECT id, type, code, name, listing_date FROM predictions WHERE status='pending' AND listing_date <= ?",
        (datetime.now().strftime("%Y-%m-%d"),),
    ).fetchall()

    updated = 0
    for pid, ptype, code, name, listing_date in pending:
        try:
            if ptype == "stock":
                row = conn.execute(
                    "SELECT ld_close_change FROM ipo_history WHERE security_code=? AND ld_close_change IS NOT NULL",
                    (code,),
                ).fetchone()
                if row:
                    conn.execute(
                        "UPDATE predictions SET actual_return=?, status='fulfilled', updated_at=? WHERE id=?",
                        (row[0], now, pid),
                    )
                    updated += 1
            else:
                row = conn.execute(
                    "SELECT first_day_return FROM bond_history WHERE security_code=? AND first_day_return IS NOT NULL",
                    (code,),
                ).fetchone()
                if row:
                    conn.execute(
                        "UPDATE predictions SET actual_return=?, status='fulfilled', updated_at=? WHERE id=?",
                        (row[0], now, pid),
                    )
                    updated += 1
        except Exception:
            pass

    conn.commit()
    conn.close()
    if updated > 0:
        print(f"[预测跟踪] 已回填 {updated} 条实际结果")


def get_prediction_accuracy(days=90):
    """获取最近N天的预测统计"""
    import sqlite3
    from datetime import datetime, timedelta

    conn = _init_ipo_db()
    cutoff = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")

    results = {"stock": {"total": 0, "fulfilled": 0, "errors": [], "mae": 0},
               "bond": {"total": 0, "fulfilled": 0, "errors": [], "mae": 0}}

    for ptype in ("stock", "bond"):
        rows = conn.execute(
            "SELECT pred_return, actual_return FROM predictions WHERE type=? AND status='fulfilled' AND actual_return IS NOT NULL AND pred_date >= ?",
            (ptype, cutoff),
        ).fetchall()
        if rows:
            results[ptype]["fulfilled"] = len(rows)
            pred_rows = [r for r in rows if r[0] is not None]
            results[ptype]["total"] = len(pred_rows)
            if pred_rows:
                errors = [abs(round(p - a, 1)) for p, a in pred_rows]
                results[ptype]["errors"] = errors
                results[ptype]["mae"] = round(sum(errors) / len(errors), 1)

    conn.close()
    return results


def _build_accuracy_lines(days=90):
    """生成准确率统计文本行"""
    stats = get_prediction_accuracy(days)
    lines = []
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("## 📊 预测跟踪统计")
    lines.append("")
    lines.append(f"> 统计近 {days} 天预测 vs 实际上市结果")
    lines.append("")
    has_data = False
    for label, key in [("新股", "stock"), ("新债", "bond")]:
        s = stats[key]
        if s["fulfilled"] > 0:
            has_data = True
            lines.append(f"**{label}**：已上市 {s['fulfilled']} 只，平均偏差 {s['mae']}pp")
        else:
            lines.append(f"**{label}**：暂无已上市数据")
    if not has_data:
        lines.append("> 暂无已上市的预测记录，数据将随交易日积累")
    lines.append("")
    lines.append("> ⚡ 系统会根据实际结果持续校准预测模型，提升准确率")
    return lines


def calibrate_board_base():
    """
    自动校准板块基准首日涨幅
    优先从本地数据库统计，数据不足时从东方财富接口增量拉取。
    """
    global BOARD_BASE, _BOARD_CALIBRATED
    from datetime import datetime, timedelta
    import sqlite3

    cutoff = datetime.now() - timedelta(days=_CALIBRATE_MONTHS * 30)
    cutoff_str = cutoff.strftime("%Y-%m-%d")

    # ── 1. 先查本地数据库 ──
    conn = _init_ipo_db()
    db_rows = conn.execute(
        "SELECT board_key, ld_close_change FROM ipo_history WHERE listing_date >= ? AND ld_close_change IS NOT NULL",
        (cutoff_str,),
    ).fetchall()
    db_gains = {}
    for bk, gain in db_rows:
        if bk not in db_gains:
            db_gains[bk] = []
        db_gains[bk].append(gain)

    db_count = sum(len(v) for v in db_gains.values())
    print(f"[校准] 本地数据库有 {db_count} 条近{_CALIBRATE_MONTHS}个月的新股记录")

    # ── 判断是否需要从接口拉取 ──
    # 检查数据库最近更新时间，超过1天再拉
    last_update = conn.execute("SELECT MAX(updated_at) FROM ipo_history").fetchone()[0]
    need_fetch = True
    if last_update:
        try:
            last_dt = datetime.strptime(last_update, "%Y-%m-%d %H:%M:%S")
            if (datetime.now() - last_dt).total_seconds() < 86400:
                need_fetch = False
                print(f"[校准] 数据库上次更新 {last_update}，24小时内无需拉取")
        except ValueError:
            pass

    # ── 2. 从接口获取最新数据（增量拉取） ──
    if need_fetch:
        url = "https://datacenter-web.eastmoney.com/api/data/v1/get"
        params = {
            "reportName": "RPTA_APP_IPOAPPLY",
            "columns": "SECURITY_CODE,SECURITY_NAME_ABBR,MARKET_TYPE,LISTING_DATE,LD_CLOSE_CHANGE",
            "pageNumber": 1,
            "pageSize": 500,
            "sortTypes": -1,
            "sortColumns": "LISTING_DATE",
            "source": "WEB",
            "client": "WEB",
            "filter": f"(LISTING_DATE>='{cutoff_str}')",
        }
        try:
            resp = _get_session().get(url, params=params, timeout=20)
            d = resp.json()
            if d.get("success") and d["result"] and d["result"]["data"]:
                api_records = d["result"]["data"]
                inserted = _sync_ipo_history(api_records)
                if inserted > 0:
                    print(f"[校准] 从接口增量拉取 {inserted} 条新记录")
                else:
                    print(f"[校准] 数据库已是最新，无需拉取")

                # 重新从数据库统计（包含新数据）
                db_rows = conn.execute(
                    "SELECT board_key, ld_close_change FROM ipo_history WHERE listing_date >= ? AND ld_close_change IS NOT NULL",
                    (cutoff_str,),
                ).fetchall()
                db_gains = {}
                for bk, gain in db_rows:
                    if bk not in db_gains:
                        db_gains[bk] = []
                    db_gains[bk].append(gain)
            else:
                print(f"[校准] 接口获取失败: {d.get('message', '未知')}，使用本地数据")
        except Exception as e:
            print(f"[校准] 接口请求异常: {e}，使用本地数据")
    else:
        # need_fetch=False时也要把try-except-finally走完的conn.close补上
        pass

    conn.close()

    # ── 3. 按板块统计并更新 BOARD_BASE ──
    if not db_gains:
        print("[校准] 无有效数据，保留默认板块基准")
        return

    updated = []
    for board_key in BOARD_BASE:
        gains = db_gains.get(board_key, [])
        if len(gains) >= 3:
            avg_gain = sum(gains) / len(gains)
            avg_gain = int(round(avg_gain))
            old = BOARD_BASE[board_key]
            BOARD_BASE[board_key] = avg_gain
            updated.append(f"{board_key}: {old}→{avg_gain}% ({len(gains)}只)")
        else:
            updated.append(f"{board_key}: 样本不足({len(gains)}只), 保留{BOARD_BASE[board_key]}%")

    total = sum(len(v) for v in db_gains.values())
    print(f"[校准] 板块基准已更新（基于 {total} 只新股）")
    for line in updated:
        print(f"  {line}")
    _BOARD_CALIBRATED = True


def estimate_board_base(stock_code):
    """根据股票代码判断板块，返回基准首日涨幅（%）"""
    code_str = str(stock_code)
    if code_str.startswith("688") or code_str.startswith("787"):
        return BOARD_BASE["科创板"]
    elif code_str.startswith("920") or code_str.startswith("82") or code_str.startswith("83") or code_str.startswith("87"):
        return BOARD_BASE["北交所"]
    elif code_str.startswith(("300", "301")):
        return BOARD_BASE["创业板"]
    elif code_str.startswith(("000", "001", "002", "003")):
        return BOARD_BASE["深市主板"]
    else:
        return BOARD_BASE["沪市主板"]


def estimate_bond_listing_price(transfer_value, circulation_scale, rating,
                                 stock_code="", bond_name="", stock_name="", stock_industry="",
                                 issue_scale=None):
    """
    新债上市首日价格预估 - 五因子模型（迭代收敛法）

    核心思路（用户方法论）：
    1. 用全市场平均溢价率估算新债首日价格P1
    2. 在市场中找价格≈P1的同类转债，看它们的平均溢价率 → 修正
    3. 用修正后溢价率重新算价格P2
    4. 重复直到收敛
    5. 在收敛后的基础溢价率上，叠加流通规模/评级/行业加成

    公式：上市首日价格 = 转股价值 × (1 + 迭代收敛溢价率 + 流通调整 + 评级调整 + 行业加成)

    上市首日沪深两市顶格均为 157.3元
    """
    if transfer_value is None:
        return None, "转股价值数据缺失"

    tv = float(transfer_value)

    # ── 0. 获取全市场数据和热度 ──
    bonds_data = _fetch_all_bonds_market()
    market = fetch_market_heat()
    market_level = market["index_level"]
    index_1m = market.get("index_1m", 0)

    # ── 1. 迭代收敛法计算基础溢价率 ──
    if bonds_data and len(bonds_data) >= 30:
        base_premium = _estimate_initial_premium_by_iteration(tv, bonds_data)
    else:
        # fallback: 用默认值
        base_premium = market["avg_premium"]

    # 动量修正：近1月中证转债指数涨跌影响情绪
    momentum_adj = index_1m * 0.02

    # ── 2. 流通规模调整（基于新上市转债统计校准，2026-06-18） ──
    # 统计结论：新债流通规模越小，溢价率越高，倒U型峰值在1.5-2亿
    # scale_adj 是在转股价值分档中位数基础溢价率之上的增量调整
    scale_adj = 0
    scale_label = ""
    is_yaozhai = False
    if circulation_scale is not None:
        cs = float(circulation_scale)
        if cs < 1:
            # 妖债：流通<1亿，额外大幅加成（保留原有转股价值联动逻辑）
            if market_level == "高估":
                yaozhai_base = 1.20
            elif market_level == "偏高":
                yaozhai_base = 1.00
            elif market_level == "中性偏低":
                yaozhai_base = 0.70
            else:
                yaozhai_base = 0.55
            scale_adj = yaozhai_base * (1 + tv / 100)
            scale_label = f"妖债(流通{cs}亿)"
            is_yaozhai = True
        elif cs < 1.5:
            scale_adj = 0.55
            scale_label = "小妖(1-1.5亿)"
            is_yaozhai = True
        elif cs < 2:
            scale_adj = 0.30
            scale_label = "中妖(1.5-2亿)"
            is_yaozhai = True
        elif cs < 3:
            scale_adj = 0.20
            scale_label = "小盘(2-3亿)"
        elif cs < 5:
            scale_adj = 0.12
            scale_label = "中盘(3-5亿)"
        elif cs < 10:
            scale_adj = 0.05
            scale_label = "大盘(5-10亿)"
        else:
            scale_adj = -0.05
            scale_label = "巨盘(>10亿)"

    # ── 2.5 发行规模(总募资)折扣（用户2026-07-15：巨无霸转债溢价率明显高估，需额外下修）──
    # 与流通规模折扣叠加；按总募资档位给固定负向调整（温和梯度）
    issue_adj = 0
    issue_scale_label = ""
    if issue_scale is not None:
        try:
            isz = float(issue_scale)
        except (TypeError, ValueError):
            isz = 0
        if isz >= 300:
            issue_adj = -0.18
            issue_scale_label = f"超大盘(总募资{isz:.0f}亿)"
        elif isz >= 100:
            issue_adj = -0.10
            issue_scale_label = f"大盘(总募资{isz:.0f}亿)"
        elif isz >= 50:
            issue_adj = -0.05
            issue_scale_label = f"中大盘(总募资{isz:.0f}亿)"

    # ── 3. 评级调整 ──
    rating_adj = 0
    if rating:
        if rating.startswith("AAA"):
            rating_adj = 0.05
        elif rating.startswith("AA+"):
            rating_adj = 0.03
        elif rating.startswith("AA"):
            rating_adj = 0
        elif rating.startswith("AA-"):
            rating_adj = -0.02
        elif rating:
            rating_adj = -0.05

    # ── 4. 行业炒作加成 ──
    sector_label, sector_boost = detect_hot_sector(bond_name, stock_name, stock_industry)
    if sector_boost == 0 and stock_industry:
        # 再尝试只用行业名搜索
        sector_label, sector_boost = detect_hot_sector("", "", stock_industry)

    # ── 5. 计算预估价格 ──
    total_premium = base_premium + scale_adj + rating_adj + sector_boost + issue_adj
    estimated_price = round(tv * (1 + total_premium), 2)

    # 上市首日沪深两市顶格均为 157.3元，模型估值超过则封顶
    capped = False
    cap_reason = ""
    if estimated_price > 157.3:
        estimated_price = 157.3
        capped = True
        cap_reason = "⚠️ 受上市首日157.3元上限限制（实际市场可能通过次日连板继续上涨）"

    # ── 6.5 预测区间带（规模越大不确定性越大，带宽越宽）──
    ref_size = issue_scale if issue_scale is not None else circulation_scale
    try:
        rs = float(ref_size)
    except (TypeError, ValueError):
        rs = 0
    if rs >= 50:
        band_unit = 10
    elif rs >= 20:
        band_unit = 7
    elif rs >= 5:
        band_unit = 5
    else:
        band_unit = 3
    low_price = max(100.0, round(estimated_price - band_unit, 2))
    high_price = min(157.3, round(estimated_price + band_unit, 2))

    # ── 6. 生成详细说明 ──
    premium_pct = round(total_premium * 100, 1)
    detail_parts = []
    detail_parts.append(f"📊 预估上市价: {estimated_price}元（溢价率 {premium_pct}%）")

    # 市场热度
    detail_parts.append(f"🔥 市场热度: {market_level}（全市场平均溢价率 {round(market['avg_premium']*100,1)}%，"
                        f"近1月指数 {index_1m:+.1f}%）")

    # 转股价值 + 基础溢价率
    detail_parts.append(f"📈 转股价值 {tv}元 → 转股价值分档中位数得基础溢价 {round(base_premium*100,1)}%")
    detail_parts.append(f"   （方法：在全市场{len(bonds_data)}只转债中，取同转股价值区间的溢价率中位数）")

    # 流通规模
    if scale_label:
        detail_parts.append(f"💰 流通规模 {circulation_scale}亿 → {scale_label}，调整 {round(scale_adj*100,1)}%")

    # 发行规模(总募资)
    if issue_scale_label:
        detail_parts.append(f"🏦 发行规模 {issue_scale}亿 → {issue_scale_label}，调整 {round(issue_adj*100,1)}%")

    # 评级
    if rating:
        detail_parts.append(f"⭐ 评级 {rating} → 调整 {round(rating_adj*100,1)}%")

    # 行业炒作
    if sector_label:
        detail_parts.append(f"🚀 行业加成: {sector_label}热门赛道 → +{round(sector_boost*100,1)}%")

    # 上限
    if capped:
        detail_parts.append(cap_reason)

    # 生成简洁摘要（区间带：规模越大带宽越宽；妖债/封顶保持单点）
    rounded_price = round(estimated_price / 5) * 5
    low_r = round(low_price)
    high_r = round(high_price)
    if is_yaozhai:
        if estimated_price >= 157:
            range_text = "🔥 妖债，大概率顶格157.3元，次日有望继续涨停"
        else:
            range_text = f"🔥 妖债，预估{rounded_price}元左右"
    elif capped:
        range_text = "预估157.3元（顶格）"
    else:
        suffix = "，注意破发风险" if estimated_price < 105 else ""
        range_text = f"预估{low_r}–{high_r}元{suffix}"

    return {
        "price": estimated_price,
        "premium": premium_pct,
        "detail": "\n".join(detail_parts),
        "summary": range_text,
        "low": low_price,
        "high": high_price,
        "capped": capped,
        "is_yaozhai": is_yaozhai,
        "market_level": market_level,
    }, None


def get_valuation_advice(item_type, issue_pe, industry_pe, rating=None, stock_detail=None):
    """基于估值给出打新建议（2025-2026年零破发环境适配版）"""
    if item_type == "bond":
        # 可转债申购建议：零破发环境一律顶格，出现破发后按评级分档
        bond_temp = _BOND_MARKET_TEMP
        if bond_temp.get("break_rate", 0) == 0:
            return "顶格申购", "当前可转债零破发，中签即赚"
        if rating and rating.startswith("AAA"):
            return "顶格申购", "优质AAA级转债，破发风险极低"
        elif rating and rating.startswith("AA"):
            return "顶格申购", "AA级转债，安全性较高"
        elif rating and rating.startswith("A"):
            return "可以申购", "A级转债，注意正股基本面"
        else:
            return "可以申购", "转债打新整体风险可控"

    # ── 新股申购建议（市场温度自适应版） ──

    if stock_detail is None:
        stock_detail = {}

    stock_code = stock_detail.get("stock_code", "")
    stock_name = stock_detail.get("stock_name", "")
    main_business = stock_detail.get("main_business", "")
    industry = stock_detail.get("industry", "")
    issue_price = stock_detail.get("issue_price")
    fund_raised = stock_detail.get("fund_raised")

    # 判断板块
    board_base = estimate_board_base(stock_code)

    # 检测热门赛道
    sector_label, sector_boost = detect_stock_hot_sector(stock_name, main_business, industry)

    # 综合评分（用于判断建议等级）
    score = board_base  # 板块基准

    if sector_label:
        # 赛道加成
        score = int(score * (1 + sector_boost * 0.3))

    # 市场温度 + PE修正
    temp_pe = get_temp_pe_penalty(issue_pe, industry_pe)
    score = int(score * temp_pe)

    # 市场温度整体衰减
    score = get_temp_temp_score_penalty(score)

    # 发行价修正：低价股涨幅通常更大，高价股压制
    if issue_price:
        if issue_price < 15:
            score = int(score * 1.15)
        elif issue_price < 30:
            score = int(score * 1.05)
        elif issue_price > 50:
            score = int(score * 0.90)

    # 募资规模修正：超大募资可能压制涨幅
    if fund_raised and fund_raised > 50:
        score = int(score * 0.85)

    # 中签率修正：中签率越低 = 申购越热 = 涨幅越大
    lottery_rate = stock_detail.get("online_lottery_rate")
    lottery_reason = ""
    if lottery_rate is not None and lottery_rate > 0:
        if lottery_rate < 0.02:
            score = int(score * 1.15)
            lottery_reason = "极低中签率"
        elif lottery_rate < 0.03:
            score = int(score * 1.10)
            lottery_reason = "低中签率"
        elif lottery_rate < 0.05:
            score = int(score * 1.05)
            lottery_reason = "较低中签率"
        elif lottery_rate > 0.12:
            score = int(score * 0.88)
            lottery_reason = "高中签率"
        elif lottery_rate > 0.08:
            score = int(score * 0.95)
            lottery_reason = "较高中签率"

    # 首日流通市值修正：流通盘越小越容易被炒作
    cmv = stock_detail.get("circulation_mv")
    cmv_reason = ""
    if cmv is not None and cmv > 0:
        if cmv < 3:
            score = int(score * 1.25)
            cmv_reason = "极小流通盘"
        elif cmv < 6:
            score = int(score * 1.15)
            cmv_reason = "小流通盘"
        elif cmv < 10:
            score = int(score * 1.05)
            cmv_reason = "较小流通盘"
        elif cmv > 50:
            score = int(score * 0.80)
            cmv_reason = "超大流通盘"
        elif cmv > 20:
            score = int(score * 0.90)
            cmv_reason = "较大流通盘"

    # 机构超额认购倍数：倍数越高 = 机构越看好
    oversub = stock_detail.get("oversubscribe_multiple")
    oversub_reason = ""
    if oversub is not None and oversub > 0:
        if oversub > 5000:
            score = int(score * 1.10)
            oversub_reason = "高认购倍数"
        elif oversub > 3000:
            score = int(score * 1.05)
            oversub_reason = "较高认购倍数"
        elif oversub < 500:
            score = int(score * 0.92)
            oversub_reason = "低认购倍数"

    temp = _MARKET_TEMP["level"]

    # 生成理由中的额外因子说明
    extra_reasons = []
    if lottery_reason:
        extra_reasons.append(lottery_reason)
    if cmv_reason:
        extra_reasons.append(cmv_reason)
    if oversub_reason:
        extra_reasons.append(oversub_reason)

    # 生成建议和理由
    extra_str = "，".join(extra_reasons)
    if extra_str:
        extra_str = f"（{extra_str}）"

    if temp != "冷市":
        if score >= 500:
            advice = "顶格申购"
            if sector_label:
                reason = f"热门赛道({sector_label})，预计首日涨幅可观{extra_str}"
            else:
                reason = f"板块优质，预计首日涨幅较高{extra_str}"
        elif score >= 300:
            advice = "顶格申购"
            reason = f"预计首日涨幅良好{extra_str}"
            if sector_label:
                reason += f"，{sector_label}赛道加持"
        elif score >= 150:
            advice = "顶格申购"
            if sector_label:
                reason = f"当前市场零破发，中签即赚，{sector_label}赛道加持{extra_str}"
            else:
                reason = f"当前市场零破发，中签即赚{extra_str}"
        else:
            advice = "可以申购"
            reason = f"当前市场零破发，中签即赚{extra_str}"
    else:
        # 冷市：新增谨慎/不建议等级
        if score >= 400:
            advice = "顶格申购"
            reason = "冷市中相对优质，注意控制仓位"
        elif score >= 200:
            advice = "可以申购"
            reason = "冷市环境下，建议谨慎参与"
        elif score >= 100:
            advice = "谨慎申购"
            reason = "市场降温，破发风险上升"
        else:
            advice = "放弃申购"
            reason = "冷市+高估值，破发风险较大"

    return advice, reason


# XGBoost预测模型（惰性加载）
_XGB_MODEL = None
_XGB_FEATURES = None
_XGB_FEATURE_INFO = None
_XGB_MEDIAN_VALS = {}


def _load_xgb_model():
    """加载XGBoost模型（从训练好的模型文件）"""
    global _XGB_MODEL, _XGB_FEATURES, _XGB_FEATURE_INFO, _XGB_MEDIAN_VALS
    if _XGB_MODEL is not None:
        return True

    import os
    import json
    import numpy as np
    import xgboost as xgb

    model_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ipo_xgb_model.json")
    feat_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ipo_xgb_features.json")

    if not os.path.exists(model_path) or not os.path.exists(feat_path):
        print("[XGBoost] 模型文件不存在，使用线性模型")
        return False

    try:
        _XGB_MODEL = xgb.Booster()
        _XGB_MODEL.load_model(model_path)

        with open(feat_path, "r", encoding="utf-8") as f:
            info = json.load(f)

        _XGB_FEATURES = info["features"]
        _XGB_FEATURE_INFO = info
        _XGB_MEDIAN_VALS = info.get("medians", {})
        return True
    except Exception as e:
        print(f"[XGBoost] 模型加载失败: {e}")
        return False


def _xgb_predict_listing(stock_detail, sector_label="", sector_boost=0):
    """
    用XGBoost模型预测首日涨幅
    返回 (estimated, detail_parts) 或 None
    """
    import numpy as np
    import xgboost as xgb

    if not _load_xgb_model():
        return None

    try:
        # 构建特征向量
        def get_val(key, default=np.nan):
            v = stock_detail.get(key)
            if v is None:
                v = _XGB_MEDIAN_VALS.get(key, default)
            try:
                return float(v) if v is not None else default
            except (ValueError, TypeError):
                return default

        ip = get_val("issue_price")
        ipe = get_val("issue_pe")
        ind_pe = get_val("industry_pe")
        fr = get_val("fund_raised")
        os_ = get_val("online_shares")
        ts = get_val("total_shares")
        lr = get_val("online_lottery_rate")
        ov = get_val("oversubscribe_multiple")
        cmv = get_val("circulation_mv")
        sl = get_val("subscribe_upper_limit")
        pr = get_val("pe_ratio")

        # 确保数值有效
        ip = ip if not np.isnan(ip) and ip > 0 else _XGB_MEDIAN_VALS.get("issue_price", 20)
        ipe = ipe if not np.isnan(ipe) and ipe > 0 else _XGB_MEDIAN_VALS.get("issue_pe", 25)
        ind_pe = ind_pe if not np.isnan(ind_pe) and ind_pe > 0 else _XGB_MEDIAN_VALS.get("industry_pe", 30)
        lr = lr if not np.isnan(lr) and lr > 0 else _XGB_MEDIAN_VALS.get("lottery_rate", 0.03)
        cmv = cmv if not np.isnan(cmv) and cmv > 0 else _XGB_MEDIAN_VALS.get("circ_mv", 5)
        ov = ov if not np.isnan(ov) and ov > 0 else _XGB_MEDIAN_VALS.get("oversub_multiple", 2000)
        fr = fr if not np.isnan(fr) and fr > 0 else 0
        ts = ts if not np.isnan(ts) and ts > 0 else 0
        os_ = os_ if not np.isnan(os_) and os_ > 0 else 0
        sl = sl if not np.isnan(sl) and sl > 0 else 0
        pr = pr if not np.isnan(pr) and pr > 0 else 0

        # 衍生特征
        cmv_log = np.log1p(cmv)
        fund_log = np.log1p(fr)
        price_times_pe = ip * ipe / 100
        lottery_inv = 1 / (lr + 0.001)
        circ_per_lot = cmv / (lr + 0.001)
        pe_squared = ipe ** 2 / 1000

        features = np.array([[
            ip, ipe, ind_pe, fr,
            os_, ts, lr,
            ov, cmv, sl, pr,
            cmv_log, fund_log, price_times_pe,
            lottery_inv, circ_per_lot, pe_squared
        ]])

        estimated = float(_XGB_MODEL.predict(xgb.DMatrix(features))[0])
        estimated = int(round(max(estimated, 0)))

        # XGBoost动态校准：按板块基准 + 市场温度调整
        xgb_boost = _calc_xgb_boost(stock_detail, estimated)
        if xgb_boost != 1.0:
            old_est = estimated
            estimated = int(round(estimated * xgb_boost))
            detail_parts = [
                f"📊 预估首日涨幅: {estimated}%（🤖 XGBoost模型，校准系数×{xgb_boost}）",
                f"📋 发行数据: 价{ip}元 PE{ipe} 中签{lr}% 流通{cmv:.1f}亿",
            ]
        else:
            detail_parts = [
                f"📊 预估首日涨幅: {estimated}%（🤖 XGBoost模型）",
                f"📋 发行数据: 价{ip}元 PE{ipe} 中签{lr}% 流通{cmv:.1f}亿",
            ]

        return estimated, detail_parts
    except Exception as e:
        print(f"[XGBoost] 预测失败: {e}")
        return None


def _get_lot_size(stock_code):
    """根据股票代码判断一签多少股"""
    if not stock_code:
        return 500  # 默认
    code_str = str(stock_code).strip()
    # 北交所
    if code_str.startswith(("8", "920", "43")):
        return 100
    # 沪市主板
    if code_str.startswith(("60",)):
        return 1000
    # 深市主板 / 创业板 / 科创板
    return 500


def _format_listing_summary(estimated, stock_detail, temp):
    """生成上市结论文字，包含预计单签收益
    涨幅按50%梯度向下取整，单签收益按万元整数向下取整"""
    # 涨幅向下取整到最近的50%梯度
    est_floor = (estimated // 50) * 50
    issue_price = None
    if stock_detail:
        try:
            issue_price = float(stock_detail.get("issue_price", 0))
        except (ValueError, TypeError):
            pass

    single_lot_profit = None
    if issue_price and issue_price > 0:
        stock_code = stock_detail.get("stock_code") if stock_detail else None
        lot_size = _get_lot_size(stock_code)
        single_lot_profit = issue_price * lot_size * estimated / 100 / 10000  # 万元

    if temp == "冷市":
        return f"❄️ 预计首日涨幅 {est_floor}%，冷市涨幅受限"
    if est_floor >= 500:
        part = f"{est_floor}%+"
    else:
        part = f"约{est_floor}%"
    if single_lot_profit and single_lot_profit >= 0.01:
        return f"预计首日涨幅{part}，预计首日单签收益{int(single_lot_profit)}万元"
    else:
        return f"预计首日涨幅{part}"


def get_listing_analysis(item_type, issue_price, issue_pe, industry_pe, bond_detail=None, stock_detail=None):
    """上市首日表现预估（2025-2026年零破发环境适配版）"""
    if item_type == "bond":
        if bond_detail:
            tv = bond_detail.get("transfer_value")
            cs = bond_detail.get("circulation_scale")
            rating = bond_detail.get("rating")
            sc = bond_detail.get("stock_code", "")
            bn = bond_detail.get("bond_name", "")
            sn = bond_detail.get("stock_name", "")
            si = bond_detail.get("stock_industry", "")
            result, err = estimate_bond_listing_price(tv, cs, rating, sc, bn, sn, si,
                                                      issue_scale=bond_detail.get("issue_scale"))
            if result:
                return result
        return {"summary": "预计首日涨幅 15%-30%，数据不足无法精确预估", "detail": "转股价值或流通规模数据缺失", "price": None}

    # ── 新股上市首日预测 ──
    # 优先使用XGBoost模型，无模型时回退到改进线性模型
    if stock_detail is None:
        stock_detail = {}

    stock_code = stock_detail.get("stock_code", "")
    stock_name = stock_detail.get("stock_name", "")
    main_business = stock_detail.get("main_business", "")
    industry = stock_detail.get("industry", "")
    sector_label, sector_boost = detect_stock_hot_sector(stock_name, main_business, industry)
    temp = _MARKET_TEMP["level"]

    # 尝试XGBoost预测
    xgb_result = _xgb_predict_listing(stock_detail, sector_label, sector_boost)
    if xgb_result is not None:
        estimated, detail_parts = xgb_result
        # 叠加赛道热度修正
        if sector_label:
            if sector_boost >= 2:
                # 顶级热门赛道龙头：非线性高加成 + 板块基准软下限
                bkey = _get_board_key_from_code(stock_code)
                bbase = BOARD_BASE.get(bkey, 200)
                sector_mult = 1 + (sector_boost ** 1.6) * 0.35
                new_est = int(round(estimated * sector_mult))
                floor = int(round(bbase * (1.0 + sector_boost * 0.25)))
                estimated = max(new_est, floor)
                detail_parts.append(f"🚀 顶级赛道修正: {sector_label}（×{sector_mult:.2f}，下限{floor}%）→{estimated}%")
            else:
                sector_mult = 1 + sector_boost * 0.10
                estimated = int(round(estimated * sector_mult))
                detail_parts.append(f"🚀 赛道修正: {sector_label}（×{sector_mult:.2f}）→{estimated}%")
        # 市场温度衰减
        temp_mult = get_temp_listing_multiplier()
        estimated = int(round(estimated * temp_mult))
        detail_parts.append(f"🌡️ 温度衰减: {temp}（×{temp_mult}）→{estimated}%")

        if temp == "冷市":
            summary = f"❄️ 预计首日涨幅 {estimated}%，冷市涨幅受限"
        elif estimated >= 500:
            summary = _format_listing_summary(estimated, stock_detail, temp)
        elif estimated >= 200:
            summary = _format_listing_summary(estimated, stock_detail, temp)
        elif estimated >= 100:
            summary = f"预计首日涨幅约{estimated}%"
        else:
            summary = f"预计首日涨幅约{estimated}%"

        return {"summary": summary, "detail": "\n".join(detail_parts), "price": None, "predicted_return": estimated}

    # ── 回退：改进版线性模型 ──
    unified_base = _MARKET_TEMP.get("avg_gain_3m", 250)

    # 发行价修正
    if issue_price:
        if issue_price < 15:
            estimated = estimated * 1.1
        elif issue_price > 50:
            estimated = estimated * 0.90

    # 募资规模修正
    fund_raised = stock_detail.get("fund_raised")
    if fund_raised and fund_raised > 50:
        estimated = estimated * 0.85
    elif fund_raised and fund_raised > 20:
        estimated = estimated * 0.95

    # 中签率修正：中签率越低 = 申购越热
    lottery_rate = stock_detail.get("online_lottery_rate")
    if lottery_rate is not None and lottery_rate > 0:
        if lottery_rate < 0.02:
            estimated = estimated * 1.15
        elif lottery_rate < 0.03:
            estimated = estimated * 1.10
        elif lottery_rate < 0.05:
            estimated = estimated * 1.05
        elif lottery_rate > 0.12:
            estimated = estimated * 0.85
        elif lottery_rate > 0.08:
            estimated = estimated * 0.92

    # 机构超额认购倍数：倍数越高 = 机构越看好
    oversub = stock_detail.get("oversubscribe_multiple")
    if oversub is not None and oversub > 0:
        if oversub > 5000:
            estimated = estimated * 1.10
        elif oversub > 3000:
            estimated = estimated * 1.05
        elif oversub < 500:
            estimated = estimated * 0.92

    # 首日流通市值修正：流通盘越小越容易被炒作
    cmv = stock_detail.get("circulation_mv")
    if cmv is not None and cmv > 0:
        if cmv < 3:
            estimated = estimated * 1.25
        elif cmv < 6:
            estimated = estimated * 1.15
        elif cmv < 10:
            estimated = estimated * 1.05
        elif cmv > 50:
            estimated = estimated * 0.75
        elif cmv > 20:
            estimated = estimated * 0.88

    # 市场温度整体衰减
    temp = _MARKET_TEMP["level"]
    temp_mult = get_temp_listing_multiplier()
    estimated = int(round(estimated * temp_mult))

    # 生成预测文本
    if temp == "冷市":
        summary = f"❄️ 预计首日涨幅 {estimated}%，冷市环境下涨幅受限"
    elif estimated >= 500:
        summary = _format_listing_summary(estimated, stock_detail, temp)
    elif estimated >= 200:
        summary = _format_listing_summary(estimated, stock_detail, temp)
    elif estimated >= 100:
        summary = f"预计首日涨幅约{estimated}%，打新收益良好"
    else:
        summary = f"预计首日涨幅约{estimated}%，中签即赚"

    detail_parts = []
    detail_parts.append(f"📊 预估首日涨幅: {estimated}%")
    detail_parts.append(f"🏢 市场基准: {unified_base}%（近3月均值）")
    detail_parts.append(f"🌡️ 市场温度: {temp}（衰减系数×{temp_mult}）")
    if sector_label:
        detail_parts.append(f"🚀 热门赛道: {sector_label}（加成系数×{1+sector_boost*0.15:.1f}）")
    if lottery_rate is not None:
        detail_parts.append(f"📋 中签率: {lottery_rate}%")
    if cmv is not None:
        detail_parts.append(f"💰 首日流通市值: {cmv}亿元")
    if issue_pe and industry_pe and industry_pe > 0:
        pe_ratio = issue_pe / industry_pe
        detail_parts.append(f"📈 PE对比: 发行{issue_pe} vs 行业{industry_pe}（比值{pe_ratio:.2f}）")
    if issue_price:
        detail_parts.append(f"💰 发行价: {issue_price}元")
    if fund_raised:
        detail_parts.append(f"📦 募资规模: {fund_raised}亿")

    return {
        "summary": summary,
        "detail": " | ".join(detail_parts),
        "price": None,
        "predicted_return": estimated,
    }


def build_report(target_date):
    """生成日报"""
    date_str = target_date.strftime("%Y-%m-%d")
    date_display = target_date.strftime("%Y年%m月%d日")
    weekday = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"][target_date.weekday()]

    print(f"正在生成 {date_display} {weekday} 的打新日报...")

    # 1. 获取日历数据
    calendar = fetch_calendar()
    print(f"获取到 {len(calendar)} 条日历记录")

    # 2. 筛选目标日期的申购和上市
    target_apply_stocks = []   # 申购-新股
    target_apply_bonds = []    # 申购-新债
    target_list_stocks = []    # 上市-新股
    target_list_bonds = []     # 上市-新债

    for item in calendar:
        trade_date = item.get("TRADE_DATE", "")[:10]
        if trade_date != date_str:
            continue

        date_type = item.get("DATE_TYPE", "")
        secu_type = item.get("SECURITY_TYPE", "0")  # 0=股票, 1=债券
        name = item.get("SECURITY_NAME_ABBR", "")
        code = item.get("SECURITY_CODE", "")
        secu_code = item.get("SECUCODE", "")

        entry = {
            "name": name,
            "code": code,
            "secu_code": secu_code,
        }

        # 跳过北交所股票（不参与每日日报推荐）
        if _is_bj_stock(code):
            continue

        if date_type == "申购":
            if secu_type == "1":
                target_apply_bonds.append(entry)
            else:
                target_apply_stocks.append(entry)
        elif date_type == "上市":
            if secu_type == "1":
                target_list_bonds.append(entry)
            else:
                target_list_stocks.append(entry)

    # 3. 获取详细信息
    print(f"明日申购: 新股{len(target_apply_stocks)}只, 新债{len(target_apply_bonds)}只")
    print(f"明日上市: 新股{len(target_list_stocks)}只, 新债{len(target_list_bonds)}只")

    # 获取新股详情（如果没有新股则跳过）
    for stock in target_apply_stocks + target_list_stocks:
        code = stock["secu_code"].split(".")[0]
        detail = fetch_stock_detail(code)
        if detail:
            # 注入股票代码和简称
            detail["stock_code"] = code
            detail["stock_name"] = stock.get("name", "")
            stock["detail"] = detail
            stock["has_detail"] = True
            # 存入数据库
            _save_stock_detail_to_db(code, detail)
        else:
            stock["has_detail"] = False

    # 获取新债详情（如果没有新债则跳过）
    for bond in target_apply_bonds + target_list_bonds:
        code = bond["secu_code"].split(".")[0]
        detail = fetch_bond_detail(code)
        if detail:
            bond["detail"] = detail
            bond["has_detail"] = True
        else:
            bond["has_detail"] = False

    # 4. 生成估值建议（只在有对应类型时计算）
    for stock in target_apply_stocks:
        if stock.get("has_detail"):
            d = stock["detail"]
            stock["advice"], stock["reason"] = get_valuation_advice(
                "stock", d.get("issue_pe"), d.get("industry_pe"), stock_detail=d
            )

    for bond in target_apply_bonds:
        if bond.get("has_detail"):
            d = bond["detail"]
            bond["advice"], bond["reason"] = get_valuation_advice(
                "bond", None, None, d.get("rating")
            )
        else:
            bond["advice"], bond["reason"] = "可以申购", "可转债打新整体风险较低"

    for stock in target_list_stocks:
        if stock.get("has_detail"):
            d = stock["detail"]
            stock["listing_analysis"] = get_listing_analysis(
                "stock", d.get("issue_price"), d.get("issue_pe"), d.get("industry_pe"), stock_detail=d
            )

    for bond in target_list_bonds:
        if bond.get("has_detail"):
            d = bond["detail"]
            result = get_listing_analysis("bond", None, None, None, bond_detail=d)
            if isinstance(result, dict):
                bond["listing_analysis"] = result
            else:
                bond["listing_analysis"] = {"summary": result, "detail": "", "price": None}
        else:
            bond["listing_analysis"] = {"summary": "预计首日涨幅 15%-30%", "detail": "数据不足", "price": None}

    # 保存预测记录（用于后续跟踪准确率）
    save_predictions(target_apply_stocks, target_apply_bonds,
                     target_list_stocks, target_list_bonds, date_str)

    # 当前生效的赛道热度系数（动态，来自sector_heat.db，按系数降序）
    sector_boost_info = []
    try:
        conn = _init_sector_db()
        rows = conn.execute(
            "SELECT sector_key, boost, avg_gain_60d, stock_count FROM sector_heat ORDER BY boost DESC"
        ).fetchall()
        for sk, boost, avg_gain, cnt in rows:
            sector_boost_info.append(
                {"sector": sk, "boost": boost, "avg_gain": avg_gain, "count": cnt}
            )
        conn.close()
    except Exception:
        pass

    # 5. 生成Markdown报告
    return generate_markdown(
        date_display, weekday,
        target_apply_stocks, target_apply_bonds,
        target_list_stocks, target_list_bonds,
        sector_boost_info=sector_boost_info
    ), {
        "date_display": date_display,
        "weekday": weekday,
        "apply_stocks": target_apply_stocks,
        "apply_bonds": target_apply_bonds,
        "list_stocks": target_list_stocks,
        "list_bonds": target_list_bonds,
        "sector_boost_info": sector_boost_info,
        "calendar": build_upcoming_calendar(calendar, days=90, apply_stocks=target_apply_stocks, apply_bonds=target_apply_bonds),
    }


def generate_markdown(date_display, weekday, apply_stocks, apply_bonds, list_stocks, list_bonds, sector_boost_info=None):
    """生成Markdown格式日报"""
    lines = []
    lines.append(f"# 🏦 打新日报 — {date_display} {weekday}")
    lines.append("")
    lines.append(f"> 📅 报告生成时间：{datetime.now().strftime('%Y-%m-%d %H:%M')}")
    temp = _MARKET_TEMP
    temp_icon = {"热市": "🔥", "常温": "🌤️", "冷市": "❄️"}.get(temp["level"], "🌡️")
    bond_temp = _BOND_MARKET_TEMP
    btemp_icon = {"热市": "🔥", "常温": "🌤️", "冷市": "❄️"}.get(bond_temp["level"], "🌡️")
    lines.append(f"> 🌡️ 新股温度：**{temp_icon} {temp['level']}**（破发率{temp['break_rate']}%，近6月均涨幅{temp['avg_gain_3m']}%）")
    lines.append(f"> 🏷️ 新债温度：**{btemp_icon} {bond_temp['level']}**（破发率{bond_temp['break_rate']}%，近6月均涨幅{bond_temp['avg_gain_6m']}%）")
    lines.append(f"> ⚠️ 声明：以下内容仅供参考，不构成投资建议。打新有风险，投资需谨慎。")
    lines.append("")

    # ── 结论概要 ──
    lines.append("## 📋 结论")
    lines.append("")

    def _get_market(code):
        code_str = str(code)
        if code_str.startswith("688"):
            return "科创板"
        if code_str.startswith("30"):
            return "创业板"
        if code_str.startswith(("60", "11", "118")):
            return "沪市"
        if code_str.startswith(("00", "12", "123")):
            return "深市"
        return ""

    # 上市结论
    listing_items = []
    for s in list_stocks:
        analysis = s.get("listing_analysis", {})
        summary = analysis.get("summary", "预计上市") if isinstance(analysis, dict) else str(analysis)
        market = _get_market(s["code"])
        listing_items.append(f"{s['name']}-{market}（{summary}）")
    for b in list_bonds:
        analysis = b.get("listing_analysis", {})
        summary = analysis.get("summary", "预计上市") if isinstance(analysis, dict) else str(analysis)
        market = _get_market(b["code"])
        listing_items.append(f"{b['name']}-{market}（{summary}）")
    if listing_items:
        lines.append("**上市**")
        for item in listing_items:
            lines.append(f"- {item}")
        lines.append("")

    # 打新结论
    apply_items = []
    for s in apply_stocks:
        advice = s.get("advice", "可以申购")
        market = _get_market(s["code"])
        apply_items.append(f"{s['name']}-{market}（{advice}）")
    for b in apply_bonds:
        advice = b.get("advice", "可以申购")
        rating = ""
        if b.get("has_detail") and b["detail"].get("rating"):
            rating = b["detail"]["rating"].replace(" ", "")
        apply_items.append(f"{b['name']}（{advice}）")
    if apply_items:
        lines.append("**打新**")
        for item in apply_items:
            lines.append(f"- {item}")
        lines.append("")

    # ========== 一、明日可申购 ==========
    lines.append("---")
    lines.append("## 一、明日可申购")
    lines.append("")

    if not apply_stocks and not apply_bonds:
        lines.append("> 明日无可申购的新股或新债。")
        lines.append("")
    else:
        # 新股申购
        if apply_stocks:
            lines.append("### 📈 新股申购")
            lines.append("")
            lines.append("| 代码 | 简称 | 发行价 | 发行PE | 行业PE | 发行规模 | 申购建议 |")
            lines.append("|------|------|--------|--------|--------|----------|----------|")
            for s in apply_stocks:
                if s.get("has_detail"):
                    d = s["detail"]
                    price = f"{d.get('issue_price', '-')}"
                    issue_pe = f"{d.get('issue_pe', '-')}"
                    ind_pe = f"{d.get('industry_pe', '-')}"
                    fund = f"{d.get('fund_raised', '-')}"
                else:
                    price = issue_pe = ind_pe = fund = "-"
                advice = s.get("advice", "待评估")
                lines.append(f"| {s['code']} | {s['name']} | {price} | {issue_pe} | {ind_pe} | {fund} | {advice} |")
            lines.append("")

            # 个股详细分析
            for s in apply_stocks:
                if s.get("has_detail"):
                    d = s["detail"]
                    lines.append(f"#### {s['name']}（{s['code']}）")
                    lines.append(f"- **申购建议**：{s.get('advice', '待评估')}")
                    lines.append(f"- **分析理由**：{s.get('reason', '待分析')}")
                    if d.get("main_business"):
                        lines.append(f"- **主营业务**：{d['main_business']}")
                    if d.get("issue_price"):
                        lines.append(f"- **发行价格**：{d['issue_price']}元")
                    if d.get("issue_pe"):
                        lines.append(f"- **发行市盈率**：{d['issue_pe']}")
                    if d.get("fund_raised"):
                        lines.append(f"- **募集资金**：{d['fund_raised']}亿元")
                    lines.append("")

        # 新债申购
        if apply_bonds:
            lines.append("### 💰 新债申购")
            lines.append("")
            lines.append("| 债券代码 | 债券简称 | 评级 | 发行规模(亿) | 转股价 | 转股价值 | 溢价率 | 申购建议 |")
            lines.append("|----------|----------|------|-------------|--------|----------|--------|----------|")
            for b in apply_bonds:
                if b.get("has_detail"):
                    d = b["detail"]
                    rating = d.get("rating", "-")
                    scale = d.get("issue_scale", "-")
                    cp = d.get("convert_price", "-")
                    tv = d.get("transfer_value", "-")
                    pr = f"{d.get('premium_ratio')}%" if d.get("premium_ratio") is not None else "-"
                else:
                    rating = scale = cp = tv = pr = "-"
                advice = b.get("advice", "待评估")
                lines.append(f"| {b['code']} | {b['name']} | {rating} | {scale} | {cp} | {tv} | {pr} | {advice} |")
            lines.append("")

            for b in apply_bonds:
                if b.get("has_detail"):
                    d = b["detail"]
                    lines.append(f"#### {b['name']}（{b['code']}）")
                    lines.append(f"- **申购建议**：{b.get('advice', '待评估')}")
                    lines.append(f"- **分析理由**：{b.get('reason', '待分析')}")
                    if d.get("rating"):
                        lines.append(f"- **债券评级**：{d['rating']}")
                    if d.get("stock_name") and d.get("stock_code"):
                        lines.append(f"- **正股**：{d['stock_name']}（{d['stock_code']}）")
                    if d.get("stock_price"):
                        lines.append(f"- **正股价**：{d['stock_price']}元")
                    if d.get("stock_pe"):
                        lines.append(f"- **正股PE**：{d['stock_pe']}")
                    if d.get("stock_pb"):
                        lines.append(f"- **正股PB**：{d['stock_pb']}")
                    if d.get("stock_roe"):
                        lines.append(f"- **正股ROE**：{d['stock_roe']}%")
                    if d.get("convert_price"):
                        lines.append(f"- **转股价**：{d['convert_price']}元")
                    if d.get("transfer_value"):
                        lines.append(f"- **转股价值**：{d['transfer_value']}元")
                    if d.get("premium_ratio") is not None:
                        lines.append(f"- **转股溢价率**：{d['premium_ratio']}%")
                    if d.get("issue_scale"):
                        lines.append(f"- **发行规模**：{d['issue_scale']}亿元")
                    if d.get("lock_scale") is not None:
                        lines.append(f"- **限售规模**：约{d['lock_scale']}亿元")
                    if d.get("circulation_scale") is not None:
                        note = d.get("_note", "")
                        if "上市公告书" in note:
                            label = "流通规模"
                            warn = ""
                        else:
                            label = "流通规模"
                            warn = ""
                        lines.append(f"- **{label}**：约{d['circulation_scale']}亿元")
                    elif d.get("_circulation_error"):
                        lines.append(f"- **流通规模**：❌ 获取失败 — {d['_circulation_error']}")
                    if d.get("market_cap_ratio") is not None:
                        lines.append(f"- **转债总市值占比**：{d['market_cap_ratio']}%")
                    if d.get("ytm_pre_tax") is not None:
                        lines.append(f"- **到期税前收益率**：{d['ytm_pre_tax']}%")
                    if d.get("ytm_after_tax") is not None:
                        lines.append(f"- **到期税后收益率**：{d['ytm_after_tax']}%")
                    if d.get("interest_rate"):
                        lines.append(f"- **票面利率**：{d['interest_rate']}")
                    lines.append("")

    # ========== 二、明日上市 ==========
    lines.append("---")
    lines.append("## 二、明日上市")
    lines.append("")

    if not list_stocks and not list_bonds:
        lines.append("> 明日无新股或新债上市。")
        lines.append("")
    else:
        if list_stocks:
            lines.append("### 📈 新股上市")
            lines.append("")
            lines.append("| 代码 | 简称 | 发行价 | 发行PE | 行业PE | 首日预估 |")
            lines.append("|----------|----------|-----------|--------|--------|----------|")
            for s in list_stocks:
                if s.get("has_detail"):
                    d = s["detail"]
                    price = f"{d.get('issue_price', '-')}"
                    issue_pe = f"{d.get('issue_pe', '-')}"
                    ind_pe = f"{d.get('industry_pe', '-')}"
                else:
                    price = issue_pe = ind_pe = "-"
                la = s.get("listing_analysis", "数据不足")
                if isinstance(la, dict):
                    analysis = la.get("summary", "数据不足")
                else:
                    analysis = str(la)
                lines.append(f"| {s['code']} | {s['name']} | {price} | {issue_pe} | {ind_pe} | {analysis} |")
            lines.append("")

            for s in list_stocks:
                if s.get("has_detail"):
                    d = s["detail"]
                    la = s.get("listing_analysis", "数据不足")
                    if isinstance(la, dict):
                        summary = la.get("summary", "数据不足")
                        detail_text = la.get("detail", "")
                    else:
                        summary = str(la)
                        detail_text = ""
                    lines.append(f"#### {s['name']}（{s['code']}）")
                    lines.append(f"- **首日预估**：{summary}")
                    if detail_text:
                        lines.append(f"- **预测详情**：{detail_text}")
                    if d.get("main_business"):
                        lines.append(f"- **主营业务**：{d['main_business']}")
                    if d.get("issue_price"):
                        lines.append(f"- **发行价格**：{d['issue_price']}元")
                    if d.get("issue_pe"):
                        lines.append(f"- **发行市盈率**：{d['issue_pe']}")
                    lines.append("")

        if list_bonds:
            lines.append("### 💰 新债上市")
            lines.append("")
            lines.append("| 债券代码 | 债券简称 | 评级 | 发行规模(亿) | 转股价值 | 溢价率 | 首日预估 |")
            lines.append("|----------|----------|------|-------------|----------|--------|----------|")
            for b in list_bonds:
                if b.get("has_detail"):
                    d = b["detail"]
                    rating = d.get("rating", "-")
                    scale = d.get("issue_scale", "-")
                    tv = d.get("transfer_value", "-")
                    pr = f"{d.get('premium_ratio')}%" if d.get("premium_ratio") is not None else "-"
                else:
                    rating = scale = tv = pr = "-"
                la = b.get("listing_analysis", {})
                summary = la.get("summary", "数据不足") if isinstance(la, dict) else str(la)
                lines.append(f"| {b['code']} | {b['name']} | {rating} | {scale} | {tv} | {pr} | {summary} |")
            lines.append("")

            for b in list_bonds:
                if b.get("has_detail"):
                    d = b["detail"]
                    la = b.get("listing_analysis", {})
                    if isinstance(la, dict):
                        detail = la.get("detail", "")
                        lines.append(f"#### {b['name']}（{b['code']}）")
                        lines.append(f"- **首日预估**：{la.get('summary', '数据不足')}")
                        if detail:
                            for line in detail.split("\n"):
                                lines.append(f"  - {line}")
                        if d.get("rating"):
                            lines.append(f"- **债券评级**：{d['rating']}")
                        if d.get("stock_name"):
                            lines.append(f"- **正股**：{d['stock_name']}（{d.get('stock_code','')}）")
                        if d.get("convert_price"):
                            lines.append(f"- **转股价**：{d['convert_price']}元")
                        if d.get("transfer_value"):
                            lines.append(f"- **转股价值**：{d['transfer_value']}元")
                        if d.get("premium_ratio") is not None:
                            lines.append(f"- **转股溢价率**：{d['premium_ratio']}%")
                        if d.get("stock_price"):
                            lines.append(f"- **正股价**：{d['stock_price']}元")
                        if d.get("circulation_scale") is not None:
                            lines.append(f"- **流通规模**：约{d['circulation_scale']}亿元")
                        elif d.get("_circulation_error"):
                            lines.append(f"- **流通规模**：❌ {d['_circulation_error']}")
                        lines.append("")

    # ── 预测跟踪统计 ──
    lines.extend(_build_accuracy_lines(days=90))

    # ── 当前赛道热度系数（动态） ──
    if sector_boost_info:
        lines.append("---")
        lines.append("## 📊 当前赛道热度系数（每日动态校准）")
        lines.append("")
        lines.append("> 系数 = 该赛道成分股近60日平均涨幅 / 最热赛道 × 3.0，由系统每日自动计算，非人工固定值。")
        lines.append("")
        lines.append("| 赛道 | 热度系数 | 成分股60日均值 | 样本数 |")
        lines.append("|------|----------|----------------|--------|")
        for r in sector_boost_info:
            lines.append(f"| {r['sector']} | {r['boost']} | {r['avg_gain']}% | {r['count']} |")
        lines.append("")

    lines.append("---")
    lines.append("")
    lines.append("*本报告由打新日报系统自动生成，数据来源：东方财富网、巨潮资讯网。*")
    lines.append("")
    lines.append("*⚠️ 流通规模说明：取自上市公司公告书「前十名可转换公司债券持有人」表格，以控股股东+实际控制人+一致行动人的配售量为限售依据，精确计算流通规模。若公告书未发布或解析失败，则不展示估算值，并注明失败原因。*")
    lines.append(f"*报告日期：{date_display} {weekday}*")

    return "\n".join(lines)


def generate_html(md_content, data):
    """生成HTML格式日报"""
    temp = _MARKET_TEMP
    temp_icon = {"热市": "🔥", "常温": "🌤️", "冷市": "❄️"}.get(temp["level"], "🌡️")
    bond_temp = _BOND_MARKET_TEMP
    btemp_icon = {"热市": "🔥", "常温": "🌤️", "冷市": "❄️"}.get(bond_temp["level"], "🌡️")
    # 简单的HTML模板
    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>打新日报 — {data['date_display']} {data['weekday']}</title>
<style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; background: #f5f5f5; color: #333; line-height: 1.6; }}
    .card {{ background: white; border-radius: 12px; padding: 24px; margin-bottom: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }}
    h1 {{ color: #1a1a1a; font-size: 24px; margin: 0 0 8px 0; }}
    h2 {{ color: #e74c3c; font-size: 20px; border-bottom: 2px solid #e74c3c; padding-bottom: 8px; }}
    h3 {{ color: #2c3e50; font-size: 17px; margin-top: 20px; }}
    h4 {{ color: #34495e; font-size: 15px; margin: 16px 0 8px 0; }}
    table {{ width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 14px; }}
    th {{ background: #2c3e50; color: white; padding: 10px 12px; text-align: center; white-space: nowrap; }}
    td {{ padding: 10px 12px; border-bottom: 1px solid #eee; text-align: center; }}
    tr:hover {{ background: #f8f9fa; }}
    .subtitle {{ color: #888; font-size: 13px; }}
    .disclaimer {{ color: #999; font-size: 12px; }}
    .section-empty {{ color: #999; font-style: italic; }}
    .stock-item {{ background: #fafafa; border-radius: 8px; padding: 16px; margin: 12px 0; border-left: 3px solid #e74c3c; }}
    .bond-item {{ background: #fafafa; border-radius: 8px; padding: 16px; margin: 12px 0; border-left: 3px solid #3498db; }}
    .advice {{ font-weight: bold; }}
    hr {{ border: none; border-top: 1px solid #eee; margin: 20px 0; }}
</style>
</head>
<body>
<div class="card">
    <h1>🏦 打新日报 — {data['date_display']} {data['weekday']}</h1>
    <p class="subtitle">📅 报告生成时间：{datetime.now().strftime('%Y-%m-%d %H:%M')}</p>
    <p class="subtitle">🌡️ 新股温度：<strong>{temp_icon} {temp['level']}</strong>（破发率{temp['break_rate']}%，近6月均涨幅{temp['avg_gain_3m']}%）</p>
    <p class="subtitle">🏷️ 新债温度：<strong>{btemp_icon} {bond_temp['level']}</strong>（破发率{bond_temp['break_rate']}%，近6月均涨幅{bond_temp['avg_gain_6m']}%）</p>
    <p class="disclaimer">⚠️ 声明：以下内容仅供参考，不构成投资建议。打新有风险，投资需谨慎。</p>
</div>
"""

    # 申购部分
    html += '<div class="card">\n<h2>一、明日可申购</h2>\n'

    if not data["apply_stocks"] and not data["apply_bonds"]:
        html += '<p class="section-empty">明日无可申购的新股或新债。</p>\n'
    else:
        if data["apply_stocks"]:
            html += '<h3>📈 新股申购</h3>\n<table>\n<tr><th>代码</th><th>简称</th><th>发行价</th><th>发行PE</th><th>行业PE</th><th>规模</th><th>建议</th></tr>\n'
            for s in data["apply_stocks"]:
                d = s.get("detail", {}) if s.get("has_detail") else {}
                html += f'<tr><td>{s["code"]}</td><td>{s["name"]}</td><td>{d.get("issue_price","-")}</td><td>{d.get("issue_pe","-")}</td><td>{d.get("industry_pe","-")}</td><td>{d.get("fund_raised","-")}</td><td class="advice">{s.get("advice","待评估")}</td></tr>\n'
            html += '</table>\n'

            for s in data["apply_stocks"]:
                if s.get("has_detail"):
                    d = s["detail"]
                    html += f'<div class="stock-item"><h4>{s["name"]}（{s["code"]}）</h4>'
                    html += f'<p><strong>建议：</strong>{s.get("advice","待评估")} — {s.get("reason","")}</p>'
                    if d.get("main_business"):
                        html += f'<p><strong>主营业务：</strong>{d["main_business"]}</p>'
                    html += '</div>\n'

        if data["apply_bonds"]:
            html += '<h3>💰 新债申购</h3>\n<table>\n<tr><th>代码</th><th>简称</th><th>评级</th><th>规模(亿)</th><th>转股价</th><th>转股价值</th><th>溢价率</th><th>建议</th></tr>\n'
            for b in data["apply_bonds"]:
                d = b.get("detail", {}) if b.get("has_detail") else {}
                tv = d.get("transfer_value", "-")
                pr = f"{d.get('premium_ratio')}%" if d.get("premium_ratio") is not None else "-"
                html += f'<tr><td>{b["code"]}</td><td>{b["name"]}</td><td>{d.get("rating","-")}</td><td>{d.get("issue_scale","-")}</td><td>{d.get("convert_price","-")}</td><td>{tv}</td><td>{pr}</td><td class="advice">{b.get("advice","待评估")}</td></tr>\n'
            html += '</table>\n'

            for b in data["apply_bonds"]:
                if b.get("has_detail"):
                    d = b["detail"]
                    html += f'<div class="bond-item"><h4>{b["name"]}（{b["code"]}）</h4>'
                    html += f'<p><strong>建议：</strong>{b.get("advice","待评估")} — {b.get("reason","")}</p>'
                    if d.get("rating"):
                        html += f'<p><strong>评级：</strong>{d["rating"]} | <strong>规模：</strong>{d.get("issue_scale","")}亿'
                        if d.get("circulation_scale") is not None:
                            html += f' | <strong>流通：</strong>约{d["circulation_scale"]}亿'
                        elif d.get("_circulation_error"):
                            html += f' | <strong>流通：</strong>❌ {d["_circulation_error"]}'
                        if d.get("lock_scale") is not None:
                            html += f' | <strong>限售：</strong>约{d["lock_scale"]}亿'
                        html += '</p>'
                    if d.get("stock_name"):
                        html += f'<p><strong>正股：</strong>{d["stock_name"]}（{d.get("stock_code","")}）'
                        if d.get("stock_price"):
                            html += f' | 股价：{d["stock_price"]}元'
                        if d.get("stock_pe"):
                            html += f' | PE：{d["stock_pe"]}'
                        if d.get("stock_pb"):
                            html += f' | PB：{d["stock_pb"]}'
                        if d.get("stock_roe"):
                            html += f' | ROE：{d["stock_roe"]}%'
                        html += '</p>'
                    if d.get("convert_price"):
                        html += f'<p><strong>转股价：</strong>{d["convert_price"]}元'
                        if d.get("transfer_value"):
                            html += f' | 转股价值：{d["transfer_value"]}元'
                        if d.get("premium_ratio") is not None:
                            html += f' | 溢价率：{d["premium_ratio"]}%'
                        html += '</p>'
                    if d.get("ytm_pre_tax") is not None:
                        html += f'<p><strong>到期收益率：</strong>税前{d["ytm_pre_tax"]}% | 税后{d.get("ytm_after_tax","")}%</p>'
                    if d.get("market_cap_ratio") is not None:
                        html += f'<p><strong>转债总市值占比：</strong>{d["market_cap_ratio"]}%</p>'
                    html += '</div>\n'

    html += '</div>\n'

    # 上市部分
    html += '<div class="card">\n<h2>二、明日上市</h2>\n'

    if not data["list_stocks"] and not data["list_bonds"]:
        html += '<p class="section-empty">明日无新股或新债上市。</p>\n'
    else:
        if data["list_stocks"]:
            html += '<h3>📈 新股上市</h3>\n<table>\n<tr><th>代码</th><th>简称</th><th>发行价</th><th>发行PE</th><th>行业PE</th><th>首日预估</th></tr>\n'
            for s in data["list_stocks"]:
                d = s.get("detail", {}) if s.get("has_detail") else {}
                la = s.get("listing_analysis", {})
                summary = la.get("summary", "数据不足") if isinstance(la, dict) else (la or "数据不足")
                html += f'<tr><td>{s["code"]}</td><td>{s["name"]}</td><td>{d.get("issue_price","-")}</td><td>{d.get("issue_pe","-")}</td><td>{d.get("industry_pe","-")}</td><td>{summary}</td></tr>\n'
            html += '</table>\n'

        if data["list_bonds"]:
            html += '<h3>💰 新债上市</h3>\n<table>\n<tr><th>代码</th><th>简称</th><th>评级</th><th>规模(亿)</th><th>转股价值</th><th>溢价率</th><th>预估上市价</th></tr>\n'
            for b in data["list_bonds"]:
                d = b.get("detail", {}) if b.get("has_detail") else {}
                tv = d.get("transfer_value", "-")
                pr = f"{d.get('premium_ratio')}%" if d.get("premium_ratio") is not None else "-"
                la = b.get("listing_analysis", {})
                if isinstance(la, dict):
                    price = f"{la.get('price')}元" if la.get("price") else "数据不足"
                else:
                    price = str(la)
                html += f'<tr><td>{b["code"]}</td><td>{b["name"]}</td><td>{d.get("rating","-")}</td><td>{d.get("issue_scale","-")}</td><td>{tv}</td><td>{pr}</td><td>{price}</td></tr>\n'
            html += '</table>\n'

            for b in data["list_bonds"]:
                if b.get("has_detail"):
                    d = b["detail"]
                    la = b.get("listing_analysis", {})
                    html += f'<div class="bond-item"><h4>{b["name"]}（{b["code"]}）</h4>'
                    if isinstance(la, dict):
                        html += f'<p><strong>首日预估：</strong>{la.get("summary","数据不足")}</p>'
                        detail = la.get("detail", "")
                        if detail:
                            html += f'<p style="color:#666;font-size:13px">{"<br>".join(detail.split(chr(10)))}</p>'
                    else:
                        html += f'<p><strong>首日预估：</strong>{la}</p>'
                    if d.get("stock_name"):
                        html += f'<p><strong>正股：</strong>{d["stock_name"]}（{d.get("stock_code","")}）'
                        if d.get("stock_price"):
                            html += f' | 股价：{d["stock_price"]}元'
                        html += '</p>'
                    if d.get("convert_price"):
                        html += f'<p><strong>转股价：</strong>{d["convert_price"]}元'
                        if d.get("transfer_value"):
                            html += f' | 转股价值：{d["transfer_value"]}元'
                        if d.get("premium_ratio") is not None:
                            html += f' | 溢价率：{d["premium_ratio"]}%'
                        html += '</p>'
                    if d.get("circulation_scale") is not None:
                        html += f'<p><strong>流通规模：</strong>约{d["circulation_scale"]}亿元</p>'
                    elif d.get("_circulation_error"):
                        html += f'<p><strong>流通规模：</strong>❌ {d["_circulation_error"]}</p>'
                    html += '</div>\n'

    html += '</div>\n'

    # 当前生效的赛道热度系数（动态）
    sb = data.get("sector_boost_info", [])
    if sb:
        html += '<div class="card">\n<h2>📊 当前赛道热度系数（每日动态校准）</h2>\n'
        html += '<p class="subtitle">系数 = 该赛道成分股近60日平均涨幅 / 最热赛道 × 3.0，由系统每日自动计算，非人工固定值。</p>\n'
        html += '<table>\n<tr><th>赛道</th><th>热度系数</th><th>成分股60日均值</th><th>样本数</th></tr>\n'
        for r in sb:
            html += f'<tr><td>{r["sector"]}</td><td>{r["boost"]}</td><td>{r["avg_gain"]}%</td><td>{r["count"]}</td></tr>\n'
        html += '</table>\n</div>\n'

    html += f'<div class="card">\n<p class="disclaimer">本报告由打新日报系统自动生成，数据来源：东方财富网、巨潮资讯网。<br>⚠️ 流通规模说明：取自上市公司公告书「前十名可转换公司债券持有人」表格，以控股股东+实际控制人+一致行动人的配售量为限售依据，精确计算流通规模。若公告书未发布或解析失败，则不展示估算值，并注明失败原因。<br>报告日期：{data["date_display"]} {data["weekday"]}</p>\n</div>\n'
    html += '</body>\n</html>'

    return html


def _extract_bottom_block(md):
    """从合并 md 提取底部「预测跟踪统计 + 当前赛道」段，用于个股单独报告末尾。"""
    idx = md.find("## 📊 预测跟踪统计")
    if idx < 0:
        idx = md.find("## 📊 当前赛道热度系数")
    if idx < 0:
        return ""
    footer = md.find("*本报告由打新日报系统自动生成")
    end = footer if footer >= 0 else len(md)
    return md[idx:end].strip()


def _extract_code_sections(md):
    """从合并 md 提取每个「#### 名称（代码）」段，返回 {code: 段文本}。"""
    import re
    lines = md.split("\n")
    sections = {}
    cur_code = None
    buf = []
    pat = re.compile(r"^####\s+.+?[（(](\w+)[）)]")
    for ln in lines:
        m = pat.match(ln)
        if m:
            if cur_code is not None:
                sections[cur_code] = "\n".join(buf).strip()
            cur_code = m.group(1)
            buf = [ln]
        elif ln.startswith("## ") and cur_code is not None:
            sections[cur_code] = "\n".join(buf).strip()
            cur_code = None
            buf = []
        elif cur_code is not None:
            buf.append(ln)
    if cur_code is not None:
        sections[cur_code] = "\n".join(buf).strip()
    return sections


def generate_individual_reports(md, data):
    """为每只有关联分析的新股/新债生成单独分析日报 md（末尾追加当前赛道等）。

    输出到 ipo-report/individual/<code>.md，供前端「打新建议」每支的查看详情跳转。
    """
    import re
    bottom = _extract_bottom_block(md)
    sections = _extract_code_sections(md)
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "individual")
    os.makedirs(out_dir, exist_ok=True)
    codes = {}
    for key in ("apply_stocks", "apply_bonds", "list_stocks", "list_bonds"):
        for it in (data.get(key) or []):
            if it.get("has_detail") and it.get("code"):
                codes[it["code"]] = it.get("name", "")
    written = 0
    for code, name in codes.items():
        sec = sections.get(code)
        if not sec:
            continue
        ind_md = "# 📄 单独分析 — {name}（{code}）\n\n{sec}\n\n---\n\n{bottom}\n".format(
            name=name, code=code, sec=sec, bottom=bottom)
        with open(os.path.join(out_dir, code + ".md"), "w", encoding="utf-8") as f:
            f.write(ind_md)
        written += 1
    if written:
        print(f"[个股报告] 已生成 {written} 份单独分析日报 -> {out_dir}")


def _sync_sector_boost_from_db():
    """模块加载时把DB中的动态赛道热度系数同步进全局静态字典，
    避免源码硬编码默认值与运行时实际值不一致（防止误读旧值）"""
    try:
        conn = _init_sector_db()
        rows = conn.execute("SELECT sector_key, boost FROM sector_heat").fetchall()
        for sector_key, boost in rows:
            NEW_STOCK_HOT_SECTORS[sector_key] = boost
        conn.close()
    except Exception:
        pass  # DB缺失或无数据时保留源码默认系数


# 模块加载即同步一次，使 NEW_STOCK_HOT_SECTORS 默认即为动态校准值
_sync_sector_boost_from_db()


def save_report_to_pg(md_content, html_content, data, date_str):
    """把生成的报告写入 PostgreSQL（ipo_reports 表），替代本地 HTML 文件供前端读取"""
    try:
        import json
        conn = db_pg.connect()
        summary = {
            "date_display": data.get("date_display"),
            "weekday": data.get("weekday"),
            "apply_stocks": data.get("apply_stocks"),
            "apply_bonds": data.get("apply_bonds"),
            "list_stocks": data.get("list_stocks"),
            "list_bonds": data.get("list_bonds"),
            "sector_boost_info": data.get("sector_boost_info"),
            "calendar": data.get("calendar"),
        }
        conn.execute(
            """INSERT INTO ipo_reports (report_date, html, md, summary_json, created_at)
               VALUES (%s, %s, %s, %s, now())
               ON CONFLICT (report_date) DO UPDATE SET
                 html=EXCLUDED.html, md=EXCLUDED.md,
                 summary_json=EXCLUDED.summary_json, created_at=EXCLUDED.created_at""",
            (date_str, html_content, md_content, json.dumps(summary, ensure_ascii=False, default=str)),
        )
        conn.commit()
        conn.close()
        print(f"[报告] 已写入 PostgreSQL: ipo_reports {date_str}")
    except Exception as e:
        print(f"[报告] 写入 PostgreSQL 失败: {e}")


def main():
    """主函数 - 支持命令行传参指定日期"""
    # 上市后回填：从K线补全实际首日涨跌幅
    _fetch_stock_listing_actuals()
    # 预测跟踪：回填已上市的实际结果
    backfill_prediction_actuals()
    # 预测误差日志
    _log_prediction_errors()
    # 自动校准板块基准
    calibrate_board_base()
    # 自动校准赛道热度系数
    calibrate_sector_boost()
    # 检测市场温度
    detect_market_temperature()
    detect_bond_market_temperature()


    import sys
    if len(sys.argv) > 1:
        # 支持 YYYY-MM-DD 或 YYYYMMDD 格式
        date_arg = sys.argv[1]
        if "-" in date_arg:
            target_date = datetime.strptime(date_arg, "%Y-%m-%d")
        else:
            target_date = datetime.strptime(date_arg, "%Y%m%d")
    else:
        # 默认：明天；如果明天是周末则跳到下周一
        target_date = datetime.now() + timedelta(days=1)
        if target_date.weekday() >= 5:
            days_to_monday = 7 - target_date.weekday()
            target_date += timedelta(days=days_to_monday)

    md_content, data = build_report(target_date)

    date_str = target_date.strftime("%Y%m%d")

    # 确保输出目录存在（服务器 Linux 路径，避免 open 因目录缺失崩溃）
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    # 保存Markdown
    md_path = os.path.join(OUTPUT_DIR, f"打新日报_{date_str}.md")
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(md_content)
    print(f"Markdown报告已保存: {md_path}")

    # 保存HTML
    html_content = generate_html(md_content, data)
    html_path = os.path.join(OUTPUT_DIR, f"打新日报_{date_str}.html")
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html_content)
    print(f"HTML报告已保存: {html_path}")

    # 写入 PostgreSQL（供前端「打新日历」tab 读取）
    save_report_to_pg(md_content, html_content, data, date_str)

    # 生成个股单独分析日报（供「打新建议」每支的查看详情跳转）
    try:
        generate_individual_reports(md_content, data)
    except Exception as e:
        print(f"[个股报告] 生成失败: {e}")

    # 输出摘要
    print("\n" + "=" * 50)
    print(f"打新日报生成完成 — {data['date_display']} {data['weekday']}")
    print(f"明日申购: 新股{len(data['apply_stocks'])}只, 新债{len(data['apply_bonds'])}只")
    print(f"明日上市: 新股{len(data['list_stocks'])}只, 新债{len(data['list_bonds'])}只")
    print("=" * 50)

    return html_path, md_path


if __name__ == "__main__":
    main()
