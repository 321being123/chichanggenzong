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
from ipo_lib_fetch import *
from ipo_lib_valuation import *
from ipo_lib_sector import *
from ipo_lib_prediction import *

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

def build_report(target_date):
    """生成日报"""
    date_str = target_date.strftime("%Y-%m-%d")
    date_display = target_date.strftime("%Y年%m月%d日")
    weekday = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"][target_date.weekday()]

    print(f"正在生成 {date_display} {weekday} 的打新日报...")

    # 1. 获取日历数据
    calendar = fetch_calendar_entries()
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
        elif re.match(r"^#{2,4}\s+", ln) and cur_code is not None:
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
            if it.get("code"):
                codes[it["code"]] = it.get("name", "")
    for code, sec in sections.items():
        if code not in codes:
            first_line = sec.split("\n", 1)[0]
            match = re.match(r"^####\s+(.+?)[（(]", first_line)
            codes[code] = match.group(1).strip() if match else code
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
    # 先刷新新债上市行情，再回填预测结果，避免实际涨幅永远落后一轮。
    detect_bond_market_temperature()
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

__all__ = ['_save_stock_detail_to_db', 'build_report', 'generate_markdown', 'generate_html', '_extract_bottom_block', '_extract_code_sections', 'generate_individual_reports', 'save_report_to_pg', 'main']
