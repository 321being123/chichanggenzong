# 本文件由 ipo_daily_report.py 物理拆分而来，函数体/常量未改动，仅调整文件归属。
import requests
import json
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

__all__ = ['fetch_stock_detail', 'fetch_bond_detail', '_org_id_cache', '_get_org_id', '_parse_bond_top10_holders', '_extract_controller_names', '_derive_total_zhang', 'fetch_placing_result', 'calc_circulation_scale', '_fetch_bond_price', 'fetch_stock_quote', '_fetch_stock_industry', '_INDUSTRY_PE_MAP', '_get_industry_pe_map', '_fetch_quote_tencent', '_fetch_quote_eastmoney', 'fetch_stock_price_from_detail', '_fetch_all_a_stock_list', '_fetch_bond_listing_data_from_api', '_BONDS_MARKET_CACHE', '_fetch_all_bonds_market', '_fetch_cb_index_change', '_fetch_stock_listing_actuals']
