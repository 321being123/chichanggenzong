# 本文件由 ipo_daily_report.py 物理拆分而来，函数体/常量未改动，仅调整文件归属。
import requests
import json
import math
import os
import re
from collections import defaultdict
from contextlib import contextmanager
from datetime import datetime, timedelta
from statistics import median
import fitz  # PyMuPDF - PDF解析
import db_pg  # PostgreSQL 数据层
from calendar_core import _str_date, build_upcoming_calendar, fetch_calendar_entries
from _classify import _is_bj_stock, _market_type_to_board_key, board_key_from_code
from _common import _load_env
from ipo_lib_common import *
from ipo_lib_fetch import *

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

NEW_STOCK_HOT_SECTORS = {
    "光通信": 3.0, "光纤": 3.0, "光子": 2.5,
    "PCB": 1.0, "印制电路板": 1.0,
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

# “新材料”不是最终需求行业。先把主营业务拆到可观察的下游，再把下游
# 的历史新股表现合并，避免看到一个宽泛词就直接套用高倍数。
_BUSINESS_EXPOSURE_RULES = (
    ("光伏", "光伏", ("光伏", "太阳能", "硅片", "电池片", "组件", "逆变器")),
    ("电子功能材料", "电子功能材料", ("电子功能材料", "电子专用材料", "热界面材料", "电磁屏蔽材料", "电磁屏蔽", "吸波材料")),
    ("PCB", "PCB", ("PCB", "印制电路板")),
    ("电子测量仪器", "高端装备", ("电子测量仪器", "电子测量", "测试测量", "测量仪器")),
    ("高端装备", "高端装备", ("高端装备", "重大技术装备", "离心压缩机", "往复压缩机", "核泵", "通用设备制造")),
    ("消费电子", "消费电子", ("3C", "消费电子", "手机", "电脑", "可穿戴")),
    ("电子封装", "消费电子", ("电子封装", "封装材料", "封装", "封装胶")),
    ("半导体", "半导体", ("半导体", "芯片", "晶圆", "集成电路", "先进封装")),
    ("新能源汽车", "汽车电子", ("新能源汽车", "新能源车", "汽车电子", "动力电池", "电驱")),
    ("储能", "储能", ("储能", "储能系统")),
    ("医疗", "医疗器械", ("医疗", "医药", "医疗器械", "诊断")),
    ("军工", "军工", ("军工", "航空航天", "航天")),
)

# 运行时的有效系数与样本数独立保存。NEW_STOCK_HOT_SECTORS 仍保留为兼容
# 旧调用方的展示字典，但不再把源码默认值当作真实风口倍数。
SECTOR_EFFECTIVE_BOOSTS = {}
SECTOR_SAMPLE_COUNTS = {}
SECTOR_CALIBRATION_DAYS = 365
BUSINESS_EXPOSURE_VERSION = 2

def _default_sector_boost(sector_key):
    """源码中写死的默认赛道热度系数（动态计算异常/归零时回退用）"""
    return NEW_STOCK_HOT_SECTORS.get(sector_key, 0)


def _robust_median(values):
    """返回稳健中位数；小样本也保留信号，但不使用极端平均值。"""
    clean = []
    for value in values:
        try:
            value = float(value)
        except (TypeError, ValueError):
            continue
        if value == value:
            clean.append(value)
    return median(clean) if clean else None


def _compute_sector_multiplier(robust_gain, benchmark):
    """直接返回赛道历史表现相对全市场基准的比值。"""
    if benchmark is None or float(benchmark) == 0:
        raise ValueError("赛道热度基准不可为0")
    value = float(robust_gain) / float(benchmark)
    if not math.isfinite(value):
        raise ValueError("赛道热度比值无效")
    return round(value, 3)


def _stored_sw_industry_taxonomy(source_payload):
    """读取与官方 IPO 行业事实分开的申万分类元数据。"""
    if isinstance(source_payload, str):
        try:
            source_payload = json.loads(source_payload)
        except (TypeError, ValueError):
            return {}
    if not isinstance(source_payload, dict):
        return {}
    taxonomies = source_payload.get("industry_taxonomies")
    taxonomy = taxonomies.get("SW2021") if isinstance(taxonomies, dict) else None
    return taxonomy if isinstance(taxonomy, dict) else {}


def _sw_industry_level2(industry_taxonomy):
    """只接受有申万2021代码和二级名称的分类路径。"""
    if not isinstance(industry_taxonomy, dict):
        return None
    if industry_taxonomy.get("taxonomy_code") != "SW2021":
        return None
    code = str(industry_taxonomy.get("l2_code") or "").strip()
    name = str(industry_taxonomy.get("l2_name") or "").strip()
    if not code or not name:
        return None
    return {"code": code, "name": name}


def analyze_business_exposure(stock_name, main_business, industry, stored=None,
                              industry_chain=None, evidence_document=None):
    """从主营业务提取“产品→下游”暴露度，返回可持久化的解释结果。

    招股书没有收入占比时，不把暴露度粗暴置零：对明确出现的下游按证据
    均分，并降低 confidence；只有宽泛的“新材料”时才使用低置信度兜底。
    """
    if isinstance(stored, dict) and isinstance(industry_chain, dict):
        saved_chain = stored.get("industry_chain")
        saved_chain = saved_chain if isinstance(saved_chain, dict) else {}
        saved_evidence = saved_chain.get("evidence")
        saved_evidence = saved_evidence if isinstance(saved_evidence, dict) else {}
        document = evidence_document if isinstance(evidence_document, dict) else {}
        if (saved_chain.get("status") == "complete"
                and saved_chain.get("version") == "ipo-industry-chain-v6-evidence-v1"
                and saved_evidence.get("url") and saved_evidence.get("content_hash")
                and saved_evidence.get("url") == document.get("url")
                and saved_evidence.get("content_hash") == document.get("content_hash")
                and all(isinstance(saved_chain.get(key), list) and saved_chain[key]
                        for key in ("products", "upstream", "downstream"))
                and industry_chain.get("extraction_method") != "source_evidence_correction"):
            return stored
    if isinstance(stored, dict) and industry_chain is None:
        chain = stored.get("industry_chain")
        chain = chain if isinstance(chain, dict) else {}
        evidence = chain.get("evidence")
        evidence = evidence if isinstance(evidence, dict) else {}
        complete_chain = (chain.get("status") == "complete" and evidence.get("url")
                          and evidence.get("content_hash")
                          and all(isinstance(chain.get(key), list) and chain[key]
                                  for key in ("products", "upstream", "downstream")))
        if stored.get("exposures") or complete_chain:
            return stored

    text = f"{stock_name or ''} {main_business or ''} {industry or ''}"
    normalized = text.upper()
    matches = []
    for label, sector_key, keywords in _BUSINESS_EXPOSURE_RULES:
        found = [kw for kw in keywords if kw.upper() in normalized]
        if found:
            # 有“收入/客户/产品/应用”证据时可信度更高；仅行业名命中时保守。
            explicit_evidence = any(marker in text for marker in ("收入", "客户", "产品", "应用", "销售"))
            matches.append({
                "label": label,
                "sector_key": sector_key,
                "keywords": found,
                "weight": 0.0,
                "evidence_level": "explicit" if explicit_evidence else "keyword",
                "relationship": "direct_business",
            })

    chain = industry_chain if isinstance(industry_chain, dict) else {}
    downstream = chain.get("downstream") if isinstance(chain.get("downstream"), list) else []
    for relation in downstream:
        if not isinstance(relation, dict):
            continue
        for sector_key in relation.get("related_tracks") or []:
            sector_key = str(sector_key or "").strip()
            if not sector_key or any(item.get("sector_key") == sector_key for item in matches):
                continue
            matches.append({
                "label": sector_key,
                "sector_key": sector_key,
                "keywords": [str(relation.get("industry") or sector_key)],
                "weight": 0.0,
                "evidence_level": "official_downstream",
                "relationship": "downstream",
            })

    generic = any(term in normalized for term in ("新材料", "先进材料", "化工材料"))
    if matches:
        total = sum(1.0 for _ in matches)
        for item in matches:
            item["weight"] = round(1.0 / total, 4)
        confidence = 0.90 if chain.get("status") == "complete" and downstream else (
            0.78 if any(item["evidence_level"] in ("explicit", "official_downstream") for item in matches)
            else 0.55
        )
    elif generic:
        matches = [{
            "label": "新材料",
            "sector_key": "新材料",
            "keywords": ["新材料"],
            "weight": 1.0,
            "evidence_level": "generic",
        }]
        confidence = 0.30
    else:
        confidence = 0.0

    document = evidence_document if isinstance(evidence_document, dict) else {}
    supply_chain = {
        "version": str(chain.get("version") or "ipo-industry-chain-v1"),
        "status": str(chain.get("status") or "unavailable"),
        "products": list(chain.get("products") or []),
        "upstream": list(chain.get("upstream") or []),
        "downstream": downstream,
        "evidence": {
            "source": document.get("source"),
            "url": document.get("url"),
            "title": document.get("title"),
            "content_hash": document.get("content_hash"),
            "parser_version": chain.get("version"),
        } if document else {},
    }
    return {
        "version": BUSINESS_EXPOSURE_VERSION,
        "exposures": matches,
        "confidence": confidence,
        "status": "complete" if confidence >= 0.7 else "partial" if matches else "missing",
        "source": "stored" if stored else "prospectus_text",
        "industry_chain": supply_chain,
    }


def _effective_sector_multiplier(sector_key, fallback=1.0):
    value = SECTOR_EFFECTIVE_BOOSTS.get(sector_key)
    if value is None:
        return fallback
    try:
        value = float(value)
        return value if math.isfinite(value) else fallback
    except (TypeError, ValueError):
        return fallback


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

def sector_tables_from_history(history_rows):
    """按给定历史样本重算赛道系数表，供生产校准与回测（历史时点）共用。

    history_rows: [(security_code, security_name, market_type, listing_date,
                    main_business, industry, ld_close_change, source_payload)]

    返回 ({sector_key: {"boost": float, "sample_count": int, "robust_gain": float}}, benchmark)。
    只算结果、不写全局也不写库，回测才能按要求「只用测试点之前的历史」重算系数，
    而不污染进程内的生产状态（生产落库仍由 calibrate_sector_boost 负责）。
    """
    sector_gains = defaultdict(list)
    benchmark_gains = []
    for _code, name, market_type, _listing, mb, ind, ld, source_payload in history_rows:
        if ld is None or str(market_type or "") == "北交所":
            continue
        try:
            ld = float(ld)
        except (TypeError, ValueError):
            continue
        benchmark_gains.append(ld)
        exposure = analyze_business_exposure(name, mb, ind)
        for item in exposure.get("exposures", []):
            sector_gains[item["sector_key"]].append(ld)
        level2 = _sw_industry_level2(_stored_sw_industry_taxonomy(source_payload))
        if level2:
            sector_gains[f"行业二级:{level2['code']}"].append(ld)
        # 所有新股同时沉淀所属行业热度，供未命中热门关键词的新股统一兜底。
        industry_name = str(ind or "").strip()
        if industry_name and industry_name.lower() not in ("nan", "none", "-"):
            sector_gains[f"行业:{industry_name}"].append(ld)

    benchmark = _robust_median(benchmark_gains)
    if benchmark is None or benchmark <= 0:
        benchmark = 150.0

    table = {}
    for sector_key, gains in sector_gains.items():
        if not gains:
            continue
        robust_gain = _robust_median(gains)
        if robust_gain is None:
            continue
        # 这是“相对同期市场”的历史效果，不再做上下限或小样本收缩。
        table[sector_key] = {
            "boost": _compute_sector_multiplier(robust_gain, benchmark),
            "sample_count": len(gains),
            "robust_gain": robust_gain,
        }
    return table, benchmark


@contextmanager
def swap_sector_boosts(effective_boosts, sample_counts):
    """在上下文内临时替换赛道系数表，退出后完整恢复。

    回测要按每个测试点之前的历史重算系数，又不能污染进程内的生产状态。
    """
    saved_boosts = dict(SECTOR_EFFECTIVE_BOOSTS)
    saved_counts = dict(SECTOR_SAMPLE_COUNTS)
    SECTOR_EFFECTIVE_BOOSTS.clear()
    SECTOR_EFFECTIVE_BOOSTS.update(effective_boosts or {})
    SECTOR_SAMPLE_COUNTS.clear()
    SECTOR_SAMPLE_COUNTS.update(sample_counts or {})
    try:
        yield
    finally:
        SECTOR_EFFECTIVE_BOOSTS.clear()
        SECTOR_EFFECTIVE_BOOSTS.update(saved_boosts)
        SECTOR_SAMPLE_COUNTS.clear()
        SECTOR_SAMPLE_COUNTS.update(saved_counts)


def calibrate_sector_boost():
    """
    用已上市新股的首日涨幅重算赛道热度系数（数据驱动，保留历史风口效果）。

    旧算法把赛道绝对均值除以150后直接当乘数，导致“新材料”这类宽泛
    标签在3只样本时也可能变成2.68倍。新算法改用同窗口全市场稳健中位数
    作基准，直接使用“赛道稳健中位数÷全市场稳健中位数”；不做样本收缩，
    也不设置最终系数上下限。系数仍写回原 sector_heat 表，避免新增平行事实表。
    统计口径集中在 sector_tables_from_history，回测复用同一实现。
    """
    conn = _init_sector_db()
    SECTOR_EFFECTIVE_BOOSTS.clear()
    SECTOR_SAMPLE_COUNTS.clear()

    # 行业兜底系数每次按最新历史数据重建，避免同一进程重复校准时残留旧行业。
    for key in [k for k in NEW_STOCK_HOT_SECTORS if k.startswith("行业:")]:
        del NEW_STOCK_HOT_SECTORS[key]

    # 清空旧的全市场板块数据，只保留基于新股首日涨幅重算的结果
    conn.execute("DELETE FROM sector_heat")

    # 已上市新股：主营业务 / 行业 / 上市首日涨跌幅
    cutoff = (datetime.now() - timedelta(days=SECTOR_CALIBRATION_DAYS)).strftime("%Y-%m-%d")
    rows = conn.execute(
        """SELECT security_code, security_name, market_type, listing_date,
                  main_business, industry, ld_close_change, source_payload
             FROM ipo_history
            WHERE listing_date >= ? AND ld_close_change IS NOT NULL""",
        (cutoff,),
    ).fetchall()

    table, _benchmark = sector_tables_from_history(rows)

    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    for sector_key, item in table.items():
        SECTOR_SAMPLE_COUNTS[sector_key] = item["sample_count"]
        SECTOR_EFFECTIVE_BOOSTS[sector_key] = item["boost"]
        conn.execute(
            "INSERT OR REPLACE INTO sector_heat (sector_key, avg_gain_60d, stock_count, boost, updated_at) VALUES (?,?,?,?,?)",
            (sector_key, round(item["robust_gain"], 2), item["sample_count"], item["boost"], now_str),
        )
    conn.commit()

    rows = conn.execute(
        "SELECT sector_key, boost, avg_gain_60d, stock_count FROM sector_heat ORDER BY boost DESC"
    ).fetchall()
    conn.close()

    updated = []
    for sector_key, boost, avg_gain, count in rows:
        old = NEW_STOCK_HOT_SECTORS.get(sector_key, "?")
        effective = _effective_sector_multiplier(sector_key, 1.0)
        NEW_STOCK_HOT_SECTORS[sector_key] = effective
        updated.append(f"{sector_key}: {old}→{effective}（{count}只新股, 稳健首日中位数{avg_gain}%）")

    if updated:
        print(f"[赛道热度] 赛道系数已更新（共{len(rows)}个赛道）")
        for line in updated[:10]:
            print(f"  {line}")
        if len(updated) > 10:
            print(f"  ... 还有{len(updated)-10}个赛道")
    return updated

# 新股市场温度的统计窗口；窗口与阈值只在训练/验证段选定，不在预测时临时调整。
TEMP_WINDOW_DAYS = 180

# 温度统计量：mean=算术平均（现行），median=稳健中位数。
# 算术平均易被极端高涨幅拉高；中位数抗极值，但识别转冷更慢。
# 2026-09-29 用完整链路逐层回测比较过两者：现有 182 条样本上 102 个测试点的温度判定
# **完全一致**（全部热市，窗口破发率恒为 0），换统计量对预测零影响，也拿不到样本外
# 增益证据；而现行阈值是按均值量纲标定的，只换统计量、不重标定阈值会变成"更严格的
# 门槛"，属于无依据改动。故维持 mean，待出现破发/冷市样本后再连同阈值重验。
# 复核命令：python backtest_ipo_prediction.py --temp-stat median
TEMP_GAIN_STAT = "mean"

# 判据阈值：热市要求窗口内零破发且涨幅统计量高于 TEMP_HOT_GAIN_MIN；
# 常温要求破发率低于 TEMP_WARM_BREAK_MAX 且涨幅统计量高于 TEMP_WARM_GAIN_MIN。
TEMP_HOT_GAIN_MIN = 150.0
TEMP_WARM_BREAK_MAX = 0.05
TEMP_WARM_GAIN_MIN = 30.0


def summarize_temperature(gains):
    """把窗口内首日涨幅归纳为温度三态，供检测与回测共用同一实现。

    没有样本必须返回“未知”，破发率保持 None，不能默认热市和零破发，
    否则缺数据会被当成乐观证据。涨幅统计量由 TEMP_GAIN_STAT 决定，
    阈值集中在模块常量，便于用回测重验而不能临时调整。
    """
    values = []
    for value in gains:
        try:
            number = float(value)
        except (TypeError, ValueError):
            continue
        if number == number:  # 排除 NaN
            values.append(number)

    total = len(values)
    if total == 0:
        return {
            "level": "未知", "break_rate": None, "avg_gain_3m": None, "gain_stat": None,
            "sample_count": 0, "window_days": TEMP_WINDOW_DAYS, "status": "unknown",
            "gain_stat_kind": TEMP_GAIN_STAT,
        }

    break_rate = sum(1 for v in values if v < 0) / total
    gain_stat = median(values) if TEMP_GAIN_STAT == "median" else sum(values) / total

    if break_rate == 0 and gain_stat > TEMP_HOT_GAIN_MIN:
        level = "热市"
    elif break_rate < TEMP_WARM_BREAK_MAX and gain_stat > TEMP_WARM_GAIN_MIN:
        level = "常温"
    else:
        level = "冷市"

    # avg_gain_3m 保留为兼容键（日报既有文案读取它），真实统计量见 gain_stat。
    return {
        "level": level,
        "break_rate": round(break_rate * 100, 1),
        "avg_gain_3m": round(gain_stat, 1),
        "gain_stat": round(gain_stat, 1),
        "sample_count": total,
        "window_days": TEMP_WINDOW_DAYS,
        "status": "known",
        "gain_stat_kind": TEMP_GAIN_STAT,
    }


# level 只在拿到足够样本时才给出热市/常温/冷市；没有样本必须是“未知”。
_MARKET_TEMP = {
    "level": "未知",
    "break_rate": None,
    "avg_gain_3m": None,
    "gain_stat": None,
    "sample_count": 0,
    "window_days": TEMP_WINDOW_DAYS,
    "status": "unknown",
    "gain_stat_kind": TEMP_GAIN_STAT,
}

_TEMP_CALIBRATED = False

def detect_market_temperature(ref_date=None):
    """
    检测新股市场温度：统计截至 ref_date（默认今天）近 TEMP_WINDOW_DAYS 天
    已上市 A 股新股首日涨幅。

    ref_date 供回测按历史时点还原温度：只能使用该时点前已公布的首日结果，
    不能拿当前日期重算历史。判据与统计量见 summarize_temperature。

    返回 {'level': '热市'|'常温'|'冷市'|'未知', 'break_rate': float|None,
          'gain_stat': float|None, 'sample_count': int, 'window_days': int,
          'status': 'known'|'unknown'}
    没有可用样本时返回“未知”，破发率保持 None，不写成 0。
    """
    global _MARKET_TEMP, _TEMP_CALIBRATED
    from datetime import datetime, timedelta

    anchor = ref_date or datetime.now()
    if isinstance(anchor, str):
        anchor = datetime.strptime(anchor[:10], "%Y-%m-%d")
    cutoff = (anchor - timedelta(days=TEMP_WINDOW_DAYS)).strftime("%Y-%m-%d")
    upper = anchor.strftime("%Y-%m-%d")
    try:
        conn = _init_ipo_db()
        rows = conn.execute(
            "SELECT ld_close_change FROM ipo_history WHERE listing_date >= ? AND listing_date <= ?"
            " AND ld_close_change IS NOT NULL AND market_type != '北交所'",
            (cutoff, upper),
        ).fetchall()
        conn.close()
    except Exception:
        rows = []

    summary = summarize_temperature([r[0] for r in rows])

    _MARKET_TEMP.clear()
    _MARKET_TEMP.update(summary)
    _TEMP_CALIBRATED = True

    if summary["status"] == "unknown":
        print(f"[市场温度] 近{TEMP_WINDOW_DAYS}天无有效样本，标记为未知（不默认热市、不默认零破发）")
    else:
        stat_label = "中位涨幅" if summary["gain_stat_kind"] == "median" else "均涨幅"
        print(f"[市场温度] {summary['level']}（破发率{summary['break_rate']}%，"
              f"{stat_label}{summary['gain_stat']}%，样本{summary['sample_count']}只）")
    return _MARKET_TEMP

_BOND_MARKET_TEMP = {"level": "热市", "break_rate": 0, "avg_gain_6m": 0}

def detect_bond_market_temperature():
    """
    检测当前新债（可转债）市场温度
    从标准上市表现表统计近6个月数据
    返回 {'level': '热市'|'常温'|'冷市', 'break_rate': float, 'avg_gain_6m': float}
    """
    global _BOND_MARKET_TEMP
    from datetime import datetime, timedelta

    cutoff = (datetime.now() - timedelta(days=180)).strftime("%Y-%m-%d")

    # 先从数据库查，检查数据是否够新（24h内）
    try:
        conn = _init_ipo_db()
        conn.close()
        from bond_data_layer import list_bond_performance
        rows = list_bond_performance(cutoff)
    except Exception:
        rows = []

    if not rows:
        print("[新债市场温度] 数据不足，默认热市")
        _BOND_MARKET_TEMP.clear()
        _BOND_MARKET_TEMP.update({"level": "热市", "break_rate": 0, "avg_gain_6m": 30})
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

    _BOND_MARKET_TEMP.clear()
    _BOND_MARKET_TEMP.update({"level": level, "break_rate": round(break_rate * 100, 1), "avg_gain_6m": round(avg_gain, 1)})
    print(f"[新债市场温度] {level}（破发率{_BOND_MARKET_TEMP['break_rate']}%，6月均涨幅{_BOND_MARKET_TEMP['avg_gain_6m']}%）")
    return _BOND_MARKET_TEMP

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
    """检测新股赛道，按产品/下游暴露度合并多个赛道信号。"""
    context = get_stock_sector_context(stock_name, main_business, industry)
    return context["label"], context["multiplier"]


def get_stock_sector_context(stock_name, main_business, industry, stored=None, industry_taxonomy=None):
    """返回可解释的赛道判断，保留兼容的二元 detect_stock_hot_sector 接口。"""
    exposure = analyze_business_exposure(stock_name, main_business, industry, stored=stored)
    items = exposure.get("exposures", [])
    level2 = _sw_industry_level2(industry_taxonomy)
    level2_key = f"行业二级:{level2['code']}" if level2 else ""
    if not items:
        if level2:
            multiplier = _effective_sector_multiplier(level2_key, 1.0)
            return {"label": level2["name"], "multiplier": multiplier,
                    "confidence": 1.0, "classification_status": "industry_level2_fallback",
                    "industry_level": 2, "industry_taxonomy": industry_taxonomy,
                    "exposure": exposure,
                    "components": [{"label": level2["name"], "sector_key": level2_key,
                                    "weight": 1.0, "multiplier": multiplier,
                                    "sample_count": SECTOR_SAMPLE_COUNTS.get(level2_key, 0)}]}
        industry_name = str(industry or "").strip()
        key = f"行业:{industry_name}" if industry_name and industry_name.lower() not in ("nan", "none", "-") else ""
        multiplier = _effective_sector_multiplier(key, 1.0) if key else 1.0
        return {"label": industry_name or "其他赛道", "multiplier": multiplier,
                "confidence": 0.25 if key else 0.0,
                "classification_status": "industry_fallback" if key else "missing",
                "exposure": exposure}

    exposure_sample_count = sum(
        int(SECTOR_SAMPLE_COUNTS.get(item.get("sector_key") or item.get("label"), 0) or 0)
        for item in items
    )
    if level2 and exposure_sample_count == 0:
        multiplier = _effective_sector_multiplier(level2_key, 1.0)
        return {"label": level2["name"], "multiplier": multiplier,
                "confidence": float(exposure.get("confidence") or 0.0),
                "classification_status": "industry_level2_fallback",
                "industry_level": 2, "industry_taxonomy": industry_taxonomy,
                "exposure": exposure,
                "components": [{"label": level2["name"], "sector_key": level2_key,
                                "weight": 1.0, "multiplier": multiplier,
                                "sample_count": SECTOR_SAMPLE_COUNTS.get(level2_key, 0)}]}

    weighted_delta = 0.0
    labels = []
    components = []
    for item in items:
        key = item.get("sector_key") or item.get("label")
        multiplier = _effective_sector_multiplier(key, 1.0)
        weight = float(item.get("weight") or 0.0)
        weighted_delta += weight * (multiplier - 1.0)
        labels.append(item.get("label") or key)
        components.append({"label": item.get("label") or key, "sector_key": key,
                           "weight": weight, "multiplier": multiplier,
                           "sample_count": SECTOR_SAMPLE_COUNTS.get(key, 0)})

    # 可信度只描述赛道分类证据，不再折扣赛道历史表现系数。
    confidence = float(exposure.get("confidence") or 0.0)
    multiplier = round(1.0 + weighted_delta, 3)
    return {"label": "、".join(dict.fromkeys(labels)), "multiplier": multiplier,
            "confidence": confidence, "classification_status": "matched",
            "exposure": exposure, "components": components}

def _get_board_key_from_code(code):
    """从股票代码获取板块键；无法识别时返回“未知”，不默认科创板或沪市主板。"""
    return board_key_from_code(code)

def _sync_sector_boost_from_db():
    """模块加载时把DB中的动态赛道热度系数同步进全局静态字典，
    避免源码硬编码默认值与运行时实际值不一致（防止误读旧值）"""
    try:
        conn = _init_sector_db()
        rows = conn.execute("SELECT sector_key, boost, stock_count FROM sector_heat").fetchall()
        for sector_key, boost, stock_count in rows:
            effective = boost if boost and boost > 0 else 1.0
            SECTOR_EFFECTIVE_BOOSTS[sector_key] = effective
            SECTOR_SAMPLE_COUNTS[sector_key] = int(stock_count or 0)
            NEW_STOCK_HOT_SECTORS[sector_key] = effective
        conn.close()
    except Exception:
        pass  # DB缺失或无数据时保留源码默认系数

__all__ = ['HOT_SECTOR_KEYWORDS', 'NEW_STOCK_HOT_SECTORS', 'SECTOR_EFFECTIVE_BOOSTS', 'SECTOR_SAMPLE_COUNTS', '_SECTOR_DB_PATH', '_init_sector_db', 'calibrate_sector_boost', 'analyze_business_exposure', 'get_stock_sector_context', '_compute_sector_multiplier', '_MARKET_TEMP', '_TEMP_CALIBRATED', 'detect_market_temperature', '_BOND_MARKET_TEMP', 'detect_bond_market_temperature', '_MARKET_SNAPSHOT', 'fetch_market_heat', 'detect_hot_sector', 'detect_stock_hot_sector', '_get_board_key_from_code', '_sync_sector_boost_from_db', 'summarize_temperature', 'sector_tables_from_history', 'swap_sector_boosts', 'TEMP_GAIN_STAT', 'TEMP_WINDOW_DAYS']
