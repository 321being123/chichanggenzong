# -*- coding: utf-8 -*-
"""
确定性单元测试（不依赖 PostgreSQL / 外部行情，固定 fixture 或桩隔离，CI 必过）。
运行：python ipo-report/test_ipo_unit.py
"""
import os
import sys
import json
import hashlib
import tempfile
import traceback
import types

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def _ensure_test_model():
    """生产模型是运行时产物；单元测试缺少外部模型时生成临时最小模型。"""
    model_dir = os.environ.get("IPO_MODEL_DIR", "").strip()
    if not model_dir:
        model_dir = tempfile.mkdtemp(prefix="portfolio-ipo-model-")
        os.environ["IPO_MODEL_DIR"] = model_dir
    model_path = os.path.join(model_dir, "ipo_xgb_model.json")
    features_path = os.path.join(model_dir, "ipo_xgb_features.json")
    if os.path.exists(model_path) and os.path.exists(features_path):
        return
    import numpy as np
    import xgboost as xgb
    features = [
        "issue_price", "issue_pe", "industry_pe", "fund_raised",
        "online_shares", "total_shares", "lottery_rate", "oversub_multiple",
        "circ_mv", "sub_limit", "pe_ratio", "circ_mv_log", "fund_log",
        "price_times_pe", "lottery_inv", "circ_per_lot", "pe_squared",
    ]
    matrix = np.array([[20, 25, 30, 10, 1, 2, 0.03, 2000, 5, 1, 25, 1.8, 2.4, 5, 32, 161, 0.625],
                       [30, 35, 40, 20, 2, 4, 0.04, 2500, 8, 2, 35, 2.2, 3.0, 10.5, 24, 195, 1.225]], dtype=float)
    train = xgb.DMatrix(matrix, label=np.array([0.0, 0.0]), feature_names=features)
    booster = xgb.train({"objective": "reg:squarederror", "max_depth": 1, "eta": 0.1, "verbosity": 0}, train, num_boost_round=1)
    # medians 只放训练段真实拟合出的补位值；issue_price 等字段训练时保留缺失状态，
    # 产物里不出现它们，推理端也必须保持缺失而不是用 0 或硬编码默认值冒充。
    medians = {
        "issue_pe": 21.03, "industry_pe": 44.7, "lottery_rate": 0.02412762,
        "oversub_multiple": 4539.93, "circ_mv": 3.96, "pe_ratio": 1.44,
    }
    os.makedirs(model_dir, exist_ok=True)
    booster.save_model(model_path)
    with open(features_path, "w", encoding="utf-8") as handle:
        json.dump({
            "features": features,
            "medians": medians,
            "fill_sources": {key: "median_of_existing_samples" for key in medians},
            "native_missing_features": [
                "issue_price", "fund_raised", "online_shares", "total_shares", "sub_limit",
            ],
            "trained_at": "test",
            "target_transform": "symlog_return",
        }, handle)


_ensure_test_model()
import ipo_daily_report as m
import ipo_lib_report as report_lib
import ipo_lib_fetch as fetch
import _common as common
import calendar_core
import ipo_history_sync as history_sync
from ipo_history_sync import normalize_share
from ipo_lib_liquidity import calculate_adjustment_from_samples, liquidity_bucket, robust_mean
from ipo_lib_historical_prediction import (
    historical_base_price,
    prior_liquidity_samples,
    rollback_prediction,
)
from datetime import date, datetime, timezone

PASS, FAIL, ERR = [], [], []


def check(name, cond, detail=""):
    if cond:
        PASS.append(name)
        print("  [PASS] %s %s" % (name, detail))
    else:
        FAIL.append(name)
        print("  [FAIL] %s %s" % (name, detail))


fixed_instant = datetime(2026, 9, 27, 16, 30, tzinfo=timezone.utc)
check("日历业务日期固定按上海时区", calendar_core._today_shanghai(fixed_instant) == date(2026, 9, 28))
check("IPO同步子阶段时刻固定按上海时区",
      history_sync._now_shanghai(fixed_instant).isoformat() == "2026-09-28T00:30:00+08:00")
check("历史业务日驱动字段重试日期",
      history_sync._detail_field_state(None, retry_after=date(2026, 9, 25))["retry_after"] == "2026-10-02")

check("新股预测价格入库换算", m._price_from_return(84.46, 100) == 168.92)
check("新债实际价格入库换算", m._price_from_return(100, 23.5) == 123.5)
check("流通规模细分8-10亿", liquidity_bucket(8.03)[1] == "中大盘(8-10亿)")
check("小规模按1亿元梯度分组",
      liquidity_bucket(1.2)[0] == liquidity_bucket(1.8)[0]
      and liquidity_bucket(2.1)[0] == liquidity_bucket(2.9)[0]
      and liquidity_bucket(1.9)[0] != liquidity_bucket(2.1)[0])
check("小样本平均使用中位数", robust_mean([1, 2, 100]) == 2)

print("== 打新日报空结果与板块结论 ==")
try:
    original_accuracy_lines = m._build_accuracy_lines
    m._build_accuracy_lines = lambda days=90: []
    empty_report = m.generate_markdown(
        "2026年08月28日", "周五", [], [], [], [], sector_boost_info=[]
    )
    check("无申购/上市时明确提示无打新建议",
          "2026年08月28日没有打新建议的股和债。" in empty_report)
    board_report = m.generate_markdown(
        "2026年08月28日", "周五", [], [],
        [{"name": "电科思仪", "code": "600000", "listing_analysis": {"summary": "预计上市"}}],
        [], sector_boost_info=[]
    )
    check("结论显示沪市主板",
          "电科思仪-沪市主板" in board_report)
    board_report = m.generate_markdown(
        "2026年08月28日", "周五", [], [],
        [
            {"name": "科创测试", "code": "688001", "listing_analysis": {"summary": "预计上市"}},
            {"name": "创业测试", "code": "301001", "listing_analysis": {"summary": "预计上市"}},
            {"name": "北交测试", "code": "920001", "listing_analysis": {"summary": "预计上市"}},
        ], [], sector_boost_info=[]
    )
    check("结论显示沪市科创板", "科创测试-沪市科创板" in board_report)
    check("结论显示深市创业板", "创业测试-深市创业板" in board_report)
    check("结论显示京市主板", "北交测试-京市主板" in board_report)
finally:
    if 'original_accuracy_lines' in locals():
        m._build_accuracy_lines = original_accuracy_lines

print("== 招股书主营业务/赛道提取 ==")
try:
    highkai_fixture = (
        "四、发行人主营业务情况 "
        "公司专业从事精密流体控制领域中关键控制部件及相关设备的研发、生产与销售。 "
        "公司所属行业领域 □新一代信息技术 □新材料 √高端装备 □新能源 "
        "五、发行人报告期的主要财务数据和财务指标"
    )
    parsed_business = fetch._extract_main_business(highkai_fixture) or ""
    check("主营业务不误取目录/财务章节",
          "精密流体控制领域中关键控制部件及相关设备的研发、生产与销售" in parsed_business
          and "财务数据" not in parsed_business,
          "结果=%r" % parsed_business)

    focus_business = fetch._extract_main_business(
        "公司业务聚焦于高性能要求的改性工程塑料领域，主营产品的研发、生产和销售。"
    ) or ""
    check("主营业务识别业务聚焦于句式",
          "高性能要求的改性工程塑料领域" in focus_business,
          "结果=%r" % focus_business)
    check("交易所识别招股意向书",
          fetch._ipo_document_role("中塑股份招股意向书") == "prospectus")
    check("交易所识别投资风险特别公告",
          fetch._ipo_document_role("粤芯半导体首次公开发行股票并在创业板上市投资风险特别公告")
          == "issuance_risk_announcement")
    check("巨潮识别初步询价及推介公告",
          fetch._ipo_document_role("广州通则康威科技股份有限公司首次公开发行股票并在创业板上市初步询价及推介公告")
          == "issuance_announcement")
    issuance = fetch._parse_ipo_issuance_detail(
        "发行人所属行业为塑料制品业（C292），发行人所属行业最近一个月平均静态市盈率为38.2倍"
    )
    check("发行公告识别行业PE句式",
          issuance.get("industry") == "塑料制品业" and issuance.get("industry_pe") == 38.2,
          "结果=%r" % issuance)
    risk_notice = fetch._parse_ipo_issuance_detail(
        "粤芯半导体尚未盈利。截至2026年9月18日（T-4日），中证指数有限公司发布的"
        "计算机、通信和其他电子设备制造业（C39）最近一个月平均静态市盈率为73.18倍。"
    )
    check("投资风险公告识别行业PE基准日和亏损状态",
          risk_notice.get("industry_pe") == 73.18
          and risk_notice.get("industry_pe_as_of") == "2026-09-18"
          and risk_notice.get("issuer_unprofitable") is True,
          "结果=%r" % risk_notice)
    fixture_path = os.path.join(
        os.path.dirname(__file__), "tests", "fixtures", "ipo_industry",
        "301716-risk-notice.json",
    )
    with open(fixture_path, encoding="utf-8") as fixture_file:
        real_ipo_fixture = json.load(fixture_file)
    fixture_hash = hashlib.sha256(real_ipo_fixture["text"].encode("utf-8")).hexdigest()
    parsed_real_ipo = fetch._parse_ipo_issuance_detail(
        real_ipo_fixture["text"], real_ipo_fixture["security_name"], real_ipo_fixture["stock_code"]
    )
    industry_evidence = parsed_real_ipo.get("industry_evidence") or {}
    check("鸿富诚真实公告夹具哈希未变化",
          fixture_hash == real_ipo_fixture["excerpt_sha256"]
          and real_ipo_fixture["document_text_sha256"] ==
          "bd4bbf20601a47d4d3dfc59c0c3da9a735ba95ccc20f9bb04161384bd21df5c5")
    check("鸿富诚代码在前格式解析行业和独立证据",
          parsed_real_ipo.get("industry") == real_ipo_fixture["expected"]["industry"]
          and parsed_real_ipo.get("industry_classification", {}).get("classification_code") == "C39"
          and real_ipo_fixture["text"][industry_evidence.get("start", -1):industry_evidence.get("end", -1)]
          == industry_evidence.get("snippet"),
          "证据=%r" % industry_evidence)
    check("鸿富诚公告PE及基准日保留",
          parsed_real_ipo.get("industry_pe") == real_ipo_fixture["expected"]["industry_pe"]
          and parsed_real_ipo.get("industry_pe_as_of") == real_ipo_fixture["expected"]["industry_pe_as_of"])
    historical_fixture_path = os.path.join(
        os.path.dirname(__file__), "tests", "fixtures", "ipo_industry",
        "historical-three-issuers.json",
    )
    with open(historical_fixture_path, encoding="utf-8") as fixture_file:
        historical_fixtures = json.load(fixture_file)["fixtures"]
    for fixture in historical_fixtures:
        parsed = fetch._parse_ipo_issuance_detail(
            fixture["text"], fixture["security_name"], fixture["stock_code"]
        )
        classification = parsed.get("industry_classification") or {}
        expected = fixture["expected"]
        check(
            "%s真实公告行业格式、分类口径及PE" % fixture["stock_code"],
            hashlib.sha256(fixture["text"].encode("utf-8")).hexdigest()
            == fixture["excerpt_sha256"]
            and parsed.get("industry") == expected["industry"]
            and classification.get("classification_code") == expected["classification_code"]
            and classification.get("classification_system") == expected["classification_system"]
            and classification.get("classification_version") == expected["classification_version"]
            and parsed.get("industry_pe") == expected["industry_pe"]
            and parsed.get("industry_pe_as_of") == expected["industry_pe_as_of"],
            "结果=%r" % parsed,
        )
    hongfucheng_gbt_fixture = next(item for item in historical_fixtures if item["stock_code"] == "301716")
    hongfucheng_gbt_parsed = fetch._parse_ipo_issuance_detail(
        hongfucheng_gbt_fixture["text"], "鸿富诚", "301716"
    )
    check("鸿富诚GB/T行业标准解析C39",
          hongfucheng_gbt_parsed.get("industry") == "计算机、通信和其他电子设备制造业"
          and hongfucheng_gbt_parsed.get("industry_classification", {}).get("classification_code") == "C39"
          and hongfucheng_gbt_parsed.get("industry_classification", {}).get("classification_system") == "national_economic_industry",
          "结果=%r" % hongfucheng_gbt_parsed)
    targeted_fixture = next(item for item in historical_fixtures if item["stock_code"] == "301718")
    inquiry_parsed = fetch._parse_ipo_issuance_detail(
        targeted_fixture["text"], targeted_fixture["security_name"], targeted_fixture["stock_code"]
    )
    check("初步询价公告解析协会分类C39且不伪造行业PE",
          inquiry_parsed.get("industry") == targeted_fixture["expected"]["industry"]
          and (inquiry_parsed.get("industry_classification") or {}).get("classification_code") == "C39"
          and inquiry_parsed.get("industry_pe") is None,
          "结果=%r" % inquiry_parsed)
    ambiguous_prospectus_url = "https://example.test/301718-prospectus.pdf"
    original_ranked_docs = fetch._exchange_ipo_document_candidates
    original_ranked_cninfo = fetch._cninfo_ipo_issuance_candidates
    original_ranked_download = fetch._download_exchange_pdf_text
    fetch._exchange_ipo_document_candidates = lambda code, security_name='': [
        ("szse", ambiguous_prospectus_url, "通则康威招股说明书", "prospectus", "2026-09-24")
    ]
    fetch._cninfo_ipo_issuance_candidates = lambda code, security_name='': [
        ("cninfo", targeted_fixture["source_url"], "通则康威首次公开发行股票投资风险特别公告", "2026-09-23")
    ]
    fetch._download_exchange_pdf_text = lambda session, url, source: (
        "通则康威所属行业为芯片产业，公司产品应用于多个电子领域。"
        if url == ambiguous_prospectus_url else targeted_fixture["text"]
    )
    fetch._IPO_ISSUANCE_DETAIL_CACHE.pop("301718", None)
    try:
        ranked_issuance = fetch._fetch_exchange_ipo_issuance_detail(
            "301718", targeted_fixture["security_name"], required_fields={"industry", "industry_pe"}
        )
    finally:
        fetch._exchange_ipo_document_candidates = original_ranked_docs
        fetch._cninfo_ipo_issuance_candidates = original_ranked_cninfo
        fetch._download_exchange_pdf_text = original_ranked_download
        fetch._IPO_ISSUANCE_DETAIL_CACHE.pop("301718", None)
    check("官方行业分类代码优先于较新但未分类的招股书表述",
          ranked_issuance.get("industry") == targeted_fixture["expected"]["industry"]
          and ranked_issuance.get("industry_classification", {}).get("classification_code") == "C39"
          and ranked_issuance.get("industry_evidence", {}).get("source") == "cninfo"
          and ranked_issuance.get("industry_pe") is None,
          "结果=%r" % ranked_issuance)
    original_detail_fetch = fetch._fetch_exchange_ipo_issuance_detail
    cached_stock_name = fetch._STOCK_NAME_CACHE.get("301718")
    fetch._STOCK_NAME_CACHE["301718"] = targeted_fixture["security_name"]
    fetch._fetch_exchange_ipo_issuance_detail = lambda *args, **kwargs: {
        "industry": targeted_fixture["expected"]["industry"],
        "industry_classification": {
            "classification_system": targeted_fixture["expected"]["classification_system"],
            "classification_version": targeted_fixture["expected"]["classification_version"],
            "classification_code": "C39",
        },
        "industry_evidence": {"snippet": targeted_fixture["text"], "url": targeted_fixture["source_url"]},
        "ipo_issuance_diagnostics": {
            "industry": {"status": "value", "source": "cninfo"},
            "industry_pe": {
                "status": "parse_miss",
                "reason": "no_industry_pe_value_parsed_from_downloaded_documents",
                "candidate_scan_status": "complete",
            },
        },
    }
    try:
        targeted_detail = fetch.fetch_stock_historical_detail(
            "301718", missing_fields={"industry", "industry_pe"}
        )
    finally:
        fetch._fetch_exchange_ipo_issuance_detail = original_detail_fetch
        if cached_stock_name is None:
            fetch._STOCK_NAME_CACHE.pop("301718", None)
        else:
            fetch._STOCK_NAME_CACHE["301718"] = cached_stock_name
    check("PE未见数值时保留官方文档字段缺口原因",
          targeted_detail.get("industry_pe_diagnostic", {}).get("status") == "parse_miss"
          and targeted_detail.get("industry_pe_diagnostic", {}).get("reason")
          == "no_industry_pe_value_parsed_from_downloaded_documents",
          "诊断=%r" % targeted_detail.get("industry_pe_diagnostic"))
    competitor_only = fetch._parse_ipo_issuance_detail(
        "鸿富诚招股说明书。可比公司甲公司行业分类：塑料制品业（C292）。",
        "鸿富诚", "301716",
    )
    check("行业解析跳过同行公司行业分类", competitor_only.get("industry") is None,
          "结果=%r" % competitor_only)

    class _FakeExchangeResponse:
        def __init__(self, payload):
            self.text = json.dumps(payload, ensure_ascii=False)

    class _FakeExchangeSession:
        def __init__(self):
            self.headers = {}
            self.calls = []

        def get(self, _url, params=None, **_kwargs):
            page = int(params["pageHelp.pageNo"])
            self.calls.append(page)
            rows = exchange_pages[page - 1]
            return _FakeExchangeResponse({"pageHelp": {"total": 101, "data": rows}})

        def close(self):
            pass

    exchange_pages = [
        [{"SECURITY_CODE": "600001", "TITLE": "测试公司首次公开发行股票招股说明书",
          "URL": "/ipo/prospectus.pdf", "SSEDATE": "2026-09-01"}]
        + [{"SECURITY_CODE": "600001", "TITLE": "普通公告", "URL": f"/ipo/other-{i}.pdf"}
           for i in range(99)],
        [{"SECURITY_CODE": "600001", "TITLE": "测试公司首次公开发行股票投资风险特别公告",
          "URL": "/ipo/risk.pdf", "SSEDATE": "2026-09-02"}],
    ]
    fake_exchange_session = _FakeExchangeSession()
    original_request_session = fetch.requests.Session
    exchange_cache_key = ("sse", "600001", "测试公司")
    fetch._EXCHANGE_IPO_DOCUMENT_CACHE.pop(exchange_cache_key, None)
    fetch._EXCHANGE_IPO_DOCUMENT_SCAN_STATUS.pop(exchange_cache_key, None)
    fetch.requests.Session = lambda: fake_exchange_session
    try:
        paged_candidates = fetch._exchange_ipo_document_candidates("600001", "测试公司")
        paged_status = fetch._EXCHANGE_IPO_DOCUMENT_SCAN_STATUS.get(exchange_cache_key, {})
    finally:
        fetch.requests.Session = original_request_session
        fetch._EXCHANGE_IPO_DOCUMENT_CACHE.pop(exchange_cache_key, None)
        fetch._EXCHANGE_IPO_DOCUMENT_SCAN_STATUS.pop(exchange_cache_key, None)
    check("上交所IPO候选遍历分页并记录完整状态",
          fake_exchange_session.calls == [1, 2]
          and {candidate[3] for candidate in paged_candidates}
          == {"prospectus", "issuance_risk_announcement"}
          and paged_status.get("status") == "complete",
          "pages=%r status=%r candidates=%r" % (
              fake_exchange_session.calls, paged_status, paged_candidates))
    check("new_share空PE不再仅凭上市日期推断亏损",
          normalize_share({"ts_code": "301660.SZ", "name": "粤芯半导体", "price": 12.01,
                           "issue_date": "20260930", "pe": 0}).get("issue_pe_status") == "pending")

    class _FakeCninfoResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "totalAnnouncement": 3,
                "announcements": [
                    {"announcementId": "risk", "announcementTitle": "首次公开发行股票并在创业板上市投资风险特别公告",
                     "adjunctUrl": "finalpage/2026-09-23/risk.PDF"},
                    {"announcementId": "issue", "announcementTitle": "首次公开发行股票并在创业板上市发行公告",
                     "adjunctUrl": "finalpage/2026-09-23/issue.PDF"},
                    {"announcementId": "inquiry", "announcementTitle": "首次公开发行股票并在创业板上市初步询价及推介公告",
                     "adjunctUrl": "finalpage/2026-09-23/inquiry.PDF"},
                ],
            }

    class _FakeCninfoSession:
        def __init__(self):
            self.headers = {}
            self.calls = 0

        def post(self, *args, **kwargs):
            self.calls += 1
            return _FakeCninfoResponse()

        def close(self):
            return None

    class _FakeTopSearchResponse:
        def __init__(self, payload):
            self.payload = payload

        def json(self):
            return self.payload

    class _FakeTopSearchSession:
        def __init__(self, name_result):
            self.headers = {}
            self.calls = []
            self.name_result = name_result

        def post(self, _url, data=None, **_kwargs):
            keyword = data.get("keyWord")
            self.calls.append(keyword)
            if keyword == "301718":
                return _FakeTopSearchResponse([])
            return _FakeTopSearchResponse(self.name_result)

        def close(self):
            return None

    original_session = fetch.requests.Session
    fetch._org_id_cache.pop("301718", None)
    top_search = _FakeTopSearchSession([
        {"orgId": "9900063681", "zwjc": "通则康威股份有限公司", "code": "301718"}
    ])
    fetch.requests.Session = lambda: top_search
    try:
        matched_org_id = fetch._get_org_id("301718", "通则康威")
    finally:
        fetch.requests.Session = original_session
        fetch._org_id_cache.pop("301718", None)
    check("巨潮代码未命中时按精确发行人名称补查orgId",
          matched_org_id == "9900063681"
          and top_search.calls == ["301718", "通则康威"],
          "queries=%r orgId=%r" % (top_search.calls, matched_org_id))

    fetch._org_id_cache.pop("301718", None)
    mismatched_top_search = _FakeTopSearchSession([
        {"orgId": "9900063681", "zwjc": "其他公司股份有限公司", "code": "301718"}
    ])
    fetch.requests.Session = lambda: mismatched_top_search
    try:
        mismatched_org_id = fetch._get_org_id("301718", "通则康威")
    finally:
        fetch.requests.Session = original_session
        fetch._org_id_cache.pop("301718", None)
    check("巨潮名称回查拒绝不匹配发行人",
          mismatched_org_id is None and mismatched_top_search.calls == ["301718", "通则康威"],
          "queries=%r orgId=%r" % (mismatched_top_search.calls, mismatched_org_id))

    old_session = fetch.requests.Session
    old_org_lookup = fetch._get_org_id
    fetch._CNINFO_IPO_ISSUANCE_CACHE.pop("301660", None)
    fake_session = _FakeCninfoSession()
    org_lookup_calls = []
    fetch.requests.Session = lambda: fake_session
    fetch._get_org_id = lambda code, security_name='': (
        org_lookup_calls.append((code, security_name)) or "9900063681"
    )
    try:
        candidates = fetch._cninfo_ipo_issuance_candidates("301660", "粤芯半导体")
    finally:
        fetch.requests.Session = old_session
        fetch._get_org_id = old_org_lookup
        fetch._CNINFO_IPO_ISSUANCE_CACHE.pop("301660", None)
    check("巨潮备源发现发行、风险和询价公告并保留公告日",
          len(candidates) == 3 and candidates[0][0] == "cninfo"
          and candidates[0][3] == "2026-09-23"
          and all("static.cninfo.com.cn/finalpage/2026-09-23/" in item[1] for item in candidates)
          and org_lookup_calls == [("301660", "粤芯半导体")],
          "候选=%r org查询=%r" % (candidates, org_lookup_calls))
    old_exchange_candidates = fetch._exchange_ipo_document_candidates
    old_cninfo_candidates = fetch._cninfo_ipo_issuance_candidates
    old_pdf_download = fetch._download_exchange_pdf_text
    fetch._IPO_ISSUANCE_DETAIL_CACHE.pop("301660", None)
    fetch._IPO_ISSUANCE_DETAIL_DIAGNOSTIC.pop("301660", None)
    fetch._exchange_ipo_document_candidates = lambda code, security_name='': []
    fetch._cninfo_ipo_issuance_candidates = lambda code, security_name='': [
        ("cninfo", "https://static.cninfo.com.cn/finalpage/2026-09-23/risk.PDF",
         "粤芯半导体投资风险特别公告", "2026-09-23")
    ]
    fetch._download_exchange_pdf_text = lambda session, url, source: (
        "粤芯半导体尚未盈利。截至2026年9月18日（T-4日），中证指数有限公司发布的"
        "计算机、通信和其他电子设备制造业（C39）最近一个月平均静态市盈率为73.18倍。"
    )
    try:
        resolved_issuance = fetch._fetch_exchange_ipo_issuance_detail("301660", "粤芯半导体")
    finally:
        fetch._exchange_ipo_document_candidates = old_exchange_candidates
        fetch._cninfo_ipo_issuance_candidates = old_cninfo_candidates
        fetch._download_exchange_pdf_text = old_pdf_download
        fetch._IPO_ISSUANCE_DETAIL_CACHE.pop("301660", None)
        fetch._IPO_ISSUANCE_DETAIL_DIAGNOSTIC.pop("301660", None)
    check("深交所列表未命中时用巨潮风险公告补出301660官方行业PE",
          resolved_issuance.get("industry_pe") == 73.18
          and resolved_issuance.get("industry_pe_as_of") == "2026-09-18"
          and resolved_issuance.get("ipo_announcement_source") == "cninfo"
          and resolved_issuance.get("issuer_unprofitable") is True,
          "结果=%r" % resolved_issuance)

    original_official_ipo_docs = fetch._exchange_ipo_document_candidates
    original_cninfo_ipo_docs = fetch._cninfo_ipo_issuance_candidates
    original_issuance_download = fetch._download_exchange_pdf_text
    office_ipo_docs = [
        ("szse", "https://example.test/risk.pdf", "测试科技投资风险特别公告",
         "issuance_risk_announcement", "2026-09-25"),
        ("szse", "https://example.test/prospectus.pdf", "测试科技招股说明书",
         "prospectus", "2026-08-01"),
    ]
    issuance_texts = {
        "https://example.test/risk.pdf": (
            "测试科技尚未盈利。截至2026年9月18日（T-4日），中证指数有限公司发布的"
            "计算机、通信和其他电子设备制造业（C39）最近一个月平均静态市盈率为73.18倍。"
        ),
        "https://example.test/prospectus.pdf": (
            "测试科技首次公开发行招股说明书。发行人所属行业为（C39）"
            "计算机、通信和其他电子设备制造业。"
        ),
    }
    fetch._exchange_ipo_document_candidates = lambda code, security_name='': list(office_ipo_docs)
    fetch._cninfo_ipo_issuance_candidates = lambda code, security_name='': []
    fetch._download_exchange_pdf_text = lambda session, url, source: issuance_texts[url]
    fetch._IPO_ISSUANCE_DETAIL_CACHE.pop("301611", None)
    try:
        split_source_issuance = fetch._fetch_exchange_ipo_issuance_detail(
            "301611", "测试科技", required_fields={"industry", "industry_pe"}
        )
        office_ipo_docs.reverse()
        fetch._IPO_ISSUANCE_DETAIL_CACHE.pop("301611", None)
        reverse_split_source_issuance = fetch._fetch_exchange_ipo_issuance_detail(
            "301611", "测试科技", required_fields={"industry", "industry_pe"}
        )
    finally:
        fetch._exchange_ipo_document_candidates = original_official_ipo_docs
        fetch._cninfo_ipo_issuance_candidates = original_cninfo_ipo_docs
        fetch._download_exchange_pdf_text = original_issuance_download
        fetch._IPO_ISSUANCE_DETAIL_CACHE.pop("301611", None)
    check("PE先命中仍继续查找行业且字段证据各自绑定文档",
          split_source_issuance.get("industry") == "计算机、通信和其他电子设备制造业"
          and split_source_issuance.get("industry_pe") == 73.18
          and split_source_issuance.get("industry_evidence", {}).get("url")
          == "https://example.test/prospectus.pdf"
          and split_source_issuance.get("industry_pe_evidence", {}).get("url")
          == "https://example.test/risk.pdf",
          "结果=%r" % split_source_issuance)
    check("交换候选顺序不改变字段值和来源",
          reverse_split_source_issuance.get("industry") == split_source_issuance.get("industry")
          and reverse_split_source_issuance.get("industry_pe") == split_source_issuance.get("industry_pe")
          and reverse_split_source_issuance.get("industry_evidence", {}).get("url")
          == split_source_issuance.get("industry_evidence", {}).get("url")
          and reverse_split_source_issuance.get("industry_pe_evidence", {}).get("url")
          == split_source_issuance.get("industry_pe_evidence", {}).get("url"))

    backup_texts = {
        "https://example.test/exchange-risk.pdf": (
            "测试科技尚未盈利。截至2026年9月18日（T-4日），最近一个月平均静态市盈率为73.18倍。"
        ),
        "https://example.test/cninfo-risk.pdf": (
            "测试科技发行人所属行业为（C39）计算机、通信和其他电子设备制造业。"
            "截至2026年9月18日（T-4日），最近一个月平均静态市盈率为73.18倍。"
        ),
    }
    fetch._exchange_ipo_document_candidates = lambda code, security_name='': [
        ("szse", "https://example.test/exchange-risk.pdf", "测试科技投资风险特别公告",
         "issuance_risk_announcement", "2026-09-23")
    ]
    fetch._cninfo_ipo_issuance_candidates = lambda code, security_name='': [
        ("cninfo", "https://example.test/cninfo-risk.pdf", "测试科技投资风险特别公告", "2026-09-23")
    ]
    fetch._download_exchange_pdf_text = lambda session, url, source: backup_texts[url]
    fetch._IPO_ISSUANCE_DETAIL_CACHE.pop("301610", None)
    try:
        backup_completion = fetch._fetch_exchange_ipo_issuance_detail(
            "301610", "测试科技", required_fields={"industry", "industry_pe"}
        )
    finally:
        fetch._exchange_ipo_document_candidates = original_official_ipo_docs
        fetch._cninfo_ipo_issuance_candidates = original_cninfo_ipo_docs
        fetch._download_exchange_pdf_text = original_issuance_download
        fetch._IPO_ISSUANCE_DETAIL_CACHE.pop("301610", None)
    check("主源已有PE仍由巨潮只补缺失行业并保留分字段来源",
          backup_completion.get("industry") == "计算机、通信和其他电子设备制造业"
          and backup_completion.get("industry_pe") == 73.18
          and backup_completion.get("industry_evidence", {}).get("source") == "cninfo"
          and backup_completion.get("industry_pe_evidence", {}).get("source") == "szse")

    fetch._exchange_ipo_document_candidates = lambda code, security_name='': list(office_ipo_docs)

    def guarded_prospectus_download(session, url, source):
        if url.endswith("prospectus.pdf"):
            raise fetch.ExternalCallGuardError(
                "CIRCUIT_OPEN", "测试熔断", source, "ipo_issuance", api_name="pdf"
            )
        return issuance_texts[url]

    fetch._cninfo_ipo_issuance_candidates = lambda code, security_name='': []
    fetch._download_exchange_pdf_text = guarded_prospectus_download
    fetch._IPO_ISSUANCE_DETAIL_CACHE.pop("301609", None)
    try:
        interrupted_issuance = fetch._fetch_exchange_ipo_issuance_detail(
            "301609", "测试科技", required_fields={"industry", "industry_pe"}
        )
    finally:
        fetch._exchange_ipo_document_candidates = original_official_ipo_docs
        fetch._cninfo_ipo_issuance_candidates = original_cninfo_ipo_docs
        fetch._download_exchange_pdf_text = original_issuance_download
        fetch._IPO_ISSUANCE_DETAIL_CACHE.pop("301609", None)
    check("Guard中断时保留已解析PE并标记行业待续",
          interrupted_issuance.get("industry_pe") == 73.18
          and interrupted_issuance.get("industry") is None
          and interrupted_issuance.get("ipo_issuance_candidate_scan", {}).get("status") == "interrupted"
          and interrupted_issuance.get("ipo_issuance_diagnostics", {}).get("industry", {}).get("status")
          == "source_unavailable")

    import sync_bond_listing_liquidity as bond_liquidity_sync

    class _FakeSqlCursor:
        def fetchall(self):
            return []

    class _FakeSqlConnection:
        def __init__(self):
            self.sql = ""
            self.params = ()

        def execute(self, sql, params):
            self.sql, self.params = sql, tuple(params)
            return _FakeSqlCursor()

        def close(self):
            return None

    old_db_connect = bond_liquidity_sync.db_pg.connect
    fake_sql_connection = _FakeSqlConnection()
    bond_liquidity_sync.db_pg.connect = lambda: fake_sql_connection
    try:
        bond_liquidity_sync.listing_candidates()
    finally:
        bond_liquidity_sync.db_pg.connect = old_db_connect
    check("可转债流通规模筛选使用绑定参数传递LIKE百分号",
          "l.source_code LIKE %s" in fake_sql_connection.sql
          and "cninfo%" in fake_sql_connection.params,
          "sql=%r 参数=%r" % (fake_sql_connection.sql, fake_sql_connection.params))
    original_issuance_fetch = fetch._fetch_exchange_ipo_issuance_detail
    issuance_calls = []
    fetch._fetch_exchange_ipo_issuance_detail = lambda code, security_name='', required_fields=None: (
        issuance_calls.append(code) or {
            "industry": "塑料制品业", "industry_pe": 38.2,
            "ipo_announcement_source": "szse",
        }
    )
    try:
        detail = fetch.fetch_stock_historical_detail(
            "301686", existing_industry="塑料制品业", missing_fields=["industry_pe"]
        ) or {}
    finally:
        fetch._fetch_exchange_ipo_issuance_detail = original_issuance_fetch
    check("仅缺行业PE时先读取发行公告",
          issuance_calls == ["301686"] and detail.get("industry_pe") == 38.2
          and detail.get("industry_pe_diagnostic", {}).get("status") == "value",
          "调用=%r 结果=%r" % (issuance_calls, detail))
    check("主营赛道读取高端装备",
          "所属行业：高端装备" in parsed_business,
          "结果=%r" % parsed_business)
except Exception as e:
    ERR.append("主营业务/赛道提取: " + str(e))

recent_liquidity_samples = [
    {"circulation_scale": scale, "residual_pp": residual}
    for scale, residual in [(2.1, 12), (2.2, 10), (2.3, 14), (2.4, 8), (2.15, 11), (2.35, 9),
                            (8.0, 2), (9.0, 0)]
]
older_liquidity_samples = [
    {"circulation_scale": scale, "residual_pp": residual}
    for scale, residual in [(2.1, 8), (2.2, 6), (2.3, 10), (2.4, 4), (8.0, 0), (9.0, -2)]
]
dynamic_adjustment = calculate_adjustment_from_samples(
    2.25, recent_liquidity_samples, older_liquidity_samples
)
check("流通影响按近3月70%和第4至6月30%加权",
      dynamic_adjustment["adjustment_pp"] == 9.45,
      "adjustment=%s" % dynamic_adjustment["adjustment_pp"])
inactive_adjustment = calculate_adjustment_from_samples(2.25, [], [])
check("动态流通调整无符合样本时不启用", inactive_adjustment["adjustment_pp"] == 0)

sparse_cross_bucket_samples = [
    {"circulation_scale": scale, "residual_pp": residual}
    for scale, residual in [(17.6984, 27.28), (2.6723, 49.67), (3.0917, 59.50),
                            (1.2495, 59.20), (77.6359, 10.75)]
]
sparse_adjustment = calculate_adjustment_from_samples(8.0332, sparse_cross_bucket_samples, [])
check("流通规模样本稀疏时不跨多档凑样本",
      sparse_adjustment["adjustment_pp"] == 0,
      "adjustment=%s" % sparse_adjustment["adjustment_pp"])

single_adjustment = calculate_adjustment_from_samples(
    8.0332, [{"circulation_scale": 8.417, "residual_pp": 11.72}], []
)
check("流通规模只有一个符合样本时直接采用",
      single_adjustment["adjustment_pp"] == 11.72,
      "adjustment=%s" % single_adjustment["adjustment_pp"])

real_priority = calculate_adjustment_from_samples(
    8.03,
    [
        {"circulation_scale": 8.4, "residual_pp": 25, "is_backfilled": True},
        {"circulation_scale": 8.2, "residual_pp": 4, "is_backfilled": False},
    ],
    [],
)
check("真实日报样本覆盖历史回滚样本",
      real_priority["adjustment_pp"] == 4
      and real_priority["recent"]["sample_source"] == "live")

base_fixture = historical_base_price(
    82.32,
    [
        {"conversion_value": 81, "conversion_premium_pct": 20},
        {"conversion_value": 84, "conversion_premium_pct": 30},
        {"conversion_value": 88, "conversion_premium_pct": 40},
    ],
    rating="AA", issue_scale=20, bond_name="测试债", stock_name="测试股",
)
check("历史回滚基础价只使用预测日前市场截面",
      base_fixture["base_price_no_liquidity"] == 107.02
      and base_fixture["market_sample_count"] == 3)

recent_fixture, older_fixture = prior_liquidity_samples(
    [
        {"listing_date": "2026-08-01", "circulation_scale": 5.5, "residual_pp": 8},
        {"listing_date": "2026-01-01", "circulation_scale": 5.4, "residual_pp": 30},
        {"listing_date": "2026-09-01", "circulation_scale": 5.4, "residual_pp": 99},
    ],
    "2026-08-16",
)
check("历史回滚严格排除预测日之后样本",
      len(recent_fixture) == 1 and len(older_fixture) == 0)

rollback_fixture = rollback_prediction(
    82.32, 5.5,
    [
        {"conversion_value": 81, "conversion_premium_pct": 20},
        {"conversion_value": 84, "conversion_premium_pct": 30},
        {"conversion_value": 88, "conversion_premium_pct": 40},
    ],
    "2026-08-16", [], rating="AA", issue_scale=20,
    bond_name="测试债", stock_name="测试股",
)
check("历史回滚同时生成基础价和预测价",
      rollback_fixture["base_price_no_liquidity"] == 107.02
      and rollback_fixture["tracking_price"] == 107.02
      and rollback_fixture["liquidity_adjustment_pp"] == 0)


check("psql 路径适配当前系统", os.name == "nt" or not common.PSQL.lower().startswith("c:\\"), common.PSQL)

class _FakeRows:
    def __init__(self, rows): self.rows = rows
    def fetchone(self): return self.rows[0] if self.rows else None
    def fetchall(self): return self.rows


class _FakeCalendarDb:
    def execute(self, sql, params=None):
        if "market.trade_calendar" in sql:
            return _FakeRows([("2026-10-02",)])
        return _FakeRows([
            ("2026-08-12", "申购", "0", "测试股", "301001", "301001"),
            ("2026-08-13", "上市", "0", "测试股", "301001", "301001"),
            ("2026-08-13", "申购", "1", "测试债", "113099", "113099.SH"),
        ])
    def close(self): pass


old_connect = calendar_core.__dict__.get("db_pg")
import db_pg as _calendar_db_pg
old_db_connect = _calendar_db_pg.connect
try:
    _calendar_db_pg.connect = lambda: _FakeCalendarDb()
    check("下一个实际交易日读取入库日历", calendar_core.next_trading_date(datetime(2026, 9, 30)).strftime("%Y-%m-%d") == "2026-10-02")
    calendar_rows = calendar_core.fetch_calendar_entries("2026-08-01", "2026-08-31")
    check("数据库日历保留新股", any(row.get("SECURITY_CODE") == "301001" for row in calendar_rows))
    check("数据库日历保留新债标准事件", any(row.get("SECURITY_CODE") == "113099" for row in calendar_rows))
finally:
    _calendar_db_pg.connect = old_db_connect


# ===== 1. _str_date 单元（修复：NaN 污染为 'nan'）=====
print("== 1. _str_date 安全日期转换 ==")
try:
    check("None->空串", m._str_date(None) == "")
    check("NaN(float)->空串", m._str_date(float("nan")) == "")
    check("标准日期透传", m._str_date("2026-07-20") == "2026-07-20")
    check("无横线日期->YYYY-MM-DD", m._str_date("20260720") == "2026-07-20")
    check("空串->空串", m._str_date("") == "")
except Exception as e:
    ERR.append("_str_date: " + str(e))


# ===== 2. _to_ts_code 后缀处理（修复：已带后缀不得再拼 .SZ）=====
print("== 2. _to_ts_code 后缀处理 ==")
try:
    import instrument_identity as _instrument_identity
    check("统一身份模块无映射时补深市后缀",
          _instrument_identity._derive_canonical_code("301677") == "301677.SZ")
    check("统一身份模块无映射时补沪市后缀",
          _instrument_identity._derive_canonical_code("600000") == "600000.SH")
    check("_to_ts_code 已带后缀不双拼", m._to_ts_code("300750.SZ") == "300750.SZ",
          "得到 %r" % m._to_ts_code("300750.SZ"))
    check("_to_ts_code 无后缀补.SZ", m._to_ts_code("301677") == "301677.SZ")
    check("_to_ts_code 沪市补.SH", m._to_ts_code("600000") == "600000.SH")
except Exception as e:
    ERR.append("_to_ts_code: " + str(e))


# ===== 3. 可转债预测：发行规模折扣 + 区间带（桩隔离外部行情）=====
print("== 3. 可转债预测：发行规模折扣 + 区间带 ==")
try:
    # 隔离外部依赖：强制用固定市场热度与基础溢价率，使结果可断言。
    # estimate_bond_listing_price 定义在 ipo_lib_valuation，其引用的
    # _fetch_all_bonds_market / fetch_market_heat 经 `from ... import *`
    # 进入 ipo_lib_valuation 命名空间，故桩必须打到该模块才生效。
    import ipo_lib_valuation as _val
    _old_market_temp = dict(_val._MARKET_TEMP)
    _val._MARKET_TEMP.clear()
    _val._MARKET_TEMP.update({
        "level": "热市", "break_rate": 0, "avg_gain_3m": 0,
        "sample_count": 24, "window_days": 180, "status": "known",
    })
    hot_zero_advice = _val.get_valuation_advice(
        "stock", 38.19, None,
        stock_detail={"stock_code": "001232", "stock_name": "嘉立创", "issue_price": 84.46, "fund_raised": 46.93},
    )
    check("新股热市且零破发一律顶格申购", hot_zero_advice[0] == "顶格申购", "实得=%s" % (hot_zero_advice,))
    check("零破发理由带统计窗口与样本数且不做中签即赚承诺",
          "24只" in hot_zero_advice[1] and "中签即赚" not in hot_zero_advice[1],
          "实得=%s" % (hot_zero_advice,))
    advice_with_detail = _val.get_valuation_advice(
        "stock", 38.19, None,
        stock_detail={"stock_code": "001232", "stock_name": "嘉立创", "issue_price": 84.46, "fund_raised": 46.93},
        return_detail=True,
    )
    check("打新建议保留逐步评分明细",
          len(advice_with_detail) == 3 and len(advice_with_detail[2].get("steps", [])) >= 3,
          "实得=%s" % (advice_with_detail,))
    check("建议明细区分市场级温度与个股级赛道分量",
          advice_with_detail[2].get("market_sample_count") == 24
          and advice_with_detail[2].get("market_window_days") == 180
          and "market_scope_note" in advice_with_detail[2]
          and "sector_scope_note" in advice_with_detail[2],
          "实得=%s" % (advice_with_detail[2],))
    # 建议分的赛道分量必须以中性 ×1.00 为基准：中性不加减、冷赛道扣分、热赛道加分。
    _orig_hot_sector = _val.detect_stock_hot_sector
    sector_score_by_boost = {}
    try:
        for _boost in (1.0, 0.5, 2.0):
            _val.detect_stock_hot_sector = lambda *a, _b=_boost, **kw: ("测试赛道", _b)
            sector_score_by_boost[_boost] = _val.get_valuation_advice(
                "stock", 38.19, None,
                stock_detail={"stock_code": "001232", "stock_name": "嘉立创", "issue_price": 84.46, "fund_raised": 46.93},
                return_detail=True,
            )[2].get("sector_score_multiplier")
    finally:
        _val.detect_stock_hot_sector = _orig_hot_sector
    check("建议分赛道分量以中性×1.00为基准且冷赛道扣分热赛道加分",
          sector_score_by_boost.get(1.0) == 1.0
          and (sector_score_by_boost.get(0.5) or 1.0) < 1.0
          and (sector_score_by_boost.get(2.0) or 0.0) > 1.0,
          "实得=%s" % (sector_score_by_boost,))
    _val._MARKET_TEMP.clear()
    _val._MARKET_TEMP.update({
        "level": "热市", "break_rate": 0, "avg_gain_3m": 0,
        "sample_count": 0, "window_days": 180, "status": "unknown",
    })
    zero_sample_advice = _val.get_valuation_advice(
        "stock", 38.19, None,
        stock_detail={"stock_code": "001232", "stock_name": "嘉立创", "issue_price": 84.46, "fund_raised": 46.93},
    )
    check("样本为空时热市零破发不触发顶格覆盖",
          zero_sample_advice[0] != "顶格申购", "实得=%s" % (zero_sample_advice,))
    _val._MARKET_TEMP.clear()
    _val._MARKET_TEMP.update({
        "level": "未知", "break_rate": None, "avg_gain_3m": None,
        "sample_count": 0, "window_days": 180, "status": "unknown",
    })
    unknown_temp_advice = _val.get_valuation_advice(
        "stock", 38.19, None,
        stock_detail={"stock_code": "001232", "stock_name": "嘉立创", "issue_price": 84.46, "fund_raised": 46.93},
    )
    check("温度未知时不给零破发结论也不按热市加分",
          unknown_temp_advice[0] != "顶格申购" and "中签即赚" not in unknown_temp_advice[1]
          and "样本不足" in unknown_temp_advice[1],
          "实得=%s" % (unknown_temp_advice,))
    check("温度未知时涨幅不衰减", _val.get_temp_listing_multiplier() == 1.0,
          "实得=%s" % (_val.get_temp_listing_multiplier(),))
    check("温度未知时发行PE修正保持中性", _val.get_temp_pe_penalty(10, 20) == 1.0,
          "实得=%s" % (_val.get_temp_pe_penalty(10, 20),))
    _val._MARKET_TEMP.clear()
    _val._MARKET_TEMP.update(_old_market_temp)
    check("XGBoost模型文件可加载", _val._load_xgb_model())
    check("产物补位值按训练特征名建立映射",
          _val._XGB_FILL_VALUES.get("industry_pe") == _val._XGB_MEDIAN_VALS.get("industry_pe")
          and "issue_price" not in _val._XGB_FILL_VALUES,
          "fill=%r" % (_val._XGB_FILL_VALUES,))
    check("旧产物中的零占位不被当作补位值",
          _val._build_xgb_fill_values({"issue_price": 0.0, "sub_limit": 0.0, "industry_pe": 44.7})
          == {"industry_pe": 44.7},
          "实得=%r" % (_val._build_xgb_fill_values({"issue_price": 0.0, "sub_limit": 0.0, "industry_pe": 44.7}),))
    check("训练未填充字段的缺位不写成硬编码常数",
          _val._XGB_FILL_VALUES.get("lottery_rate") == _val._XGB_MEDIAN_VALS.get("lottery_rate")
          and _val._XGB_FILL_VALUES.get("lottery_rate") != 0.03,
          "fill=%r" % (_val._XGB_FILL_VALUES,))
    model_prediction = _val._xgb_predict_listing({
        "stock_code": "688001", "issue_price": 20, "issue_pe": 30,
        "industry_pe": 35, "fund_raised": 10, "online_lottery_rate": 0.03,
        "circulation_mv": 5,
    })
    check("XGBoost可完成新股预测并保留输入明细",
           model_prediction is not None and len(model_prediction) >= 5
           and model_prediction[4].get("model_features"),
           "模型输入明细已生成")
    legacy_pe_prediction = _val._xgb_predict_listing({
        "stock_code": "688001", "issue_price": 20, "issue_pe": 30,
        "industry_pe": 36.5, "fund_raised": 10, "online_lottery_rate": 0.03,
        "circulation_mv": 5,
    })
    unclassified_pe_prediction = _val._xgb_predict_listing({
        "stock_code": "688001", "issue_price": 20, "issue_pe": 30,
        "industry_pe": None, "fund_raised": 10, "online_lottery_rate": 0.03,
        "circulation_mv": 5,
    })
    check("升级后不兼容PE退出预测输入并按模型缺省值补位",
          legacy_pe_prediction is not None and unclassified_pe_prediction is not None
          and legacy_pe_prediction[4]["model_features"]["industry_pe"] == 36.5
          and unclassified_pe_prediction[4]["model_features"]["industry_pe"]
          == _val._XGB_MEDIAN_VALS.get("industry_pe", 30)
          and unclassified_pe_prediction[4]["model_feature_status"]["industry_pe"] == "补位",
          "legacy=%r unclassified=%r expected=%r" % (
              None if legacy_pe_prediction is None else legacy_pe_prediction[4]["model_features"].get("industry_pe"),
              None if unclassified_pe_prediction is None else unclassified_pe_prediction[4]["model_features"].get("industry_pe"),
              _val._XGB_MEDIAN_VALS.get("industry_pe", 30)))
    check("训练未填充字段在推理端保持缺失且不写成 0",
          unclassified_pe_prediction[4]["model_features"]["issue_price"] is not None
          and unclassified_pe_prediction[4]["model_features"]["online_shares"] is None
          and unclassified_pe_prediction[4]["model_feature_status"]["online_shares"] == "缺失",
          "features=%r status=%r" % (
              unclassified_pe_prediction[4]["model_features"],
              unclassified_pe_prediction[4]["model_feature_status"]))
    zero_rate_prediction = _val._xgb_predict_listing({
        "stock_code": "688001", "issue_price": 20, "issue_pe": 30,
        "industry_pe": None, "fund_raised": 10, "online_lottery_rate": 0,
        "circulation_mv": 5,
    })
    check("中签率零占位按缺失处理并统一走补位",
          zero_rate_prediction is not None
          and zero_rate_prediction[4]["model_features"]["online_lottery_rate"]
          == _val._XGB_FILL_VALUES.get("lottery_rate")
          and zero_rate_prediction[4]["model_feature_status"]["online_lottery_rate"] == "补位"
          and "online_lottery_rate" in zero_rate_prediction[3]
          and zero_rate_prediction[4]["model_feature_status"]["industry_pe"] == "补位",
          "features=%r status=%r imputed=%r" % (
              None if zero_rate_prediction is None else zero_rate_prediction[4]["model_features"],
              None if zero_rate_prediction is None else zero_rate_prediction[4]["model_feature_status"],
              None if zero_rate_prediction is None else zero_rate_prediction[3]))
    zero_oversub_prediction = _val._xgb_predict_listing({
        "stock_code": "688001", "issue_price": 20, "issue_pe": 30,
        "industry_pe": 35, "fund_raised": 10, "online_lottery_rate": 0.03,
        "oversubscribe_multiple": 0, "circulation_mv": 5,
    })
    check("超额认购倍数零占位按缺失处理并统一走补位",
          zero_oversub_prediction is not None
          and zero_oversub_prediction[4]["model_features"]["oversubscribe_multiple"]
          == _val._XGB_FILL_VALUES.get("oversub_multiple")
          and zero_oversub_prediction[4]["model_feature_status"]["oversubscribe_multiple"] == "补位"
          and "oversubscribe_multiple" in zero_oversub_prediction[3],
          "features=%r status=%r imputed=%r" % (
              None if zero_oversub_prediction is None else zero_oversub_prediction[4]["model_features"],
              None if zero_oversub_prediction is None else zero_oversub_prediction[4]["model_feature_status"],
              None if zero_oversub_prediction is None else zero_oversub_prediction[3]))
    zero_pe_prediction = _val._xgb_predict_listing({
        "stock_code": "688001", "issue_price": 20, "issue_pe": 0,
        "industry_pe": 35, "fund_raised": 10, "online_lottery_rate": 0.03,
        "circulation_mv": 5,
    })
    check("亏损股发行PE零值属合法取值不被判为缺失",
          zero_pe_prediction is not None
          and zero_pe_prediction[4]["model_features"]["issue_pe"] == 0
          and zero_pe_prediction[4]["model_feature_status"]["issue_pe"] == "实际"
          and "issue_pe" not in zero_pe_prediction[3],
          "features=%r status=%r imputed=%r" % (
              None if zero_pe_prediction is None else zero_pe_prediction[4]["model_features"],
              None if zero_pe_prediction is None else zero_pe_prediction[4]["model_feature_status"],
              None if zero_pe_prediction is None else zero_pe_prediction[3]))
    check("模型输入明细可安全序列化为JSON",
          "NaN" not in json.dumps(unclassified_pe_prediction[4]["model_features"]),
          "features=%r" % (unclassified_pe_prediction[4]["model_features"],))
    check("模型输入明细标注缺失字段",
          "（缺失）" in report_lib._format_model_features({
              "model_features": {"online_shares": None},
              "model_feature_status": {"online_shares": "缺失"},
          }))
    model_feature_text = report_lib._format_model_features({
        "model_features": {"issue_price": 20, "pe_ratio": 0.8, "online_shares": 1},
        "model_feature_status": {"online_shares": "补位"},
    })
    check("模型输入明细带单位和派生含义",
          "发行价（元/股）=20" in model_feature_text
          and "PE比值（无单位：发行PE÷行业PE）=0.8" in model_feature_text
          and "网上发行量（万股）=1（补位）" in model_feature_text)
    # 训练脚本是顶层即执行的独立 CLI，无法 import 做数值测试，改用源码级断言锁定口径。
    _ipo_dir = os.path.dirname(os.path.abspath(__file__))
    _train_src = open(os.path.join(_ipo_dir, "train_xgb_model.py"), encoding="utf-8").read()
    _val_src = open(os.path.join(_ipo_dir, "ipo_lib_valuation.py"), encoding="utf-8").read()
    _lib_train_src = open(os.path.join(_ipo_dir, "ipo_lib_train.py"), encoding="utf-8").read()
    check("训练目标保留破发不再截断负收益",
          "np.maximum(y_train, 0)" not in _train_src
          and "np.maximum(y_test, 0)" not in _train_src
          and "symlog_return(y_train)" in _train_src,
          "目标变换应改为奇对称对数，否则模型永远学不到破发")
    check("训练与回测共用同一套特征工程与目标变换",
          "def symlog_return" in _lib_train_src
          and "def build_feature_matrix" in _lib_train_src
          and "from ipo_lib_train import" in _train_src,
          "两处各写一套会让回测结论不代表实际训练流程")
    check("上线模型用全部样本训练而非只用训练段",
          "dfull" in _train_src
          and '"model_trained_on": "all_samples"' in _train_src
          and "eval_model" in _train_src,
          "评估模型与上线模型职责必须分离，避免最新样本不参与训练")
    check("评估补值只用训练段中位数",
          "eval_medians" in _train_src and "[:train_size]" in _train_src,
          "测试段样本不得进入补值统计，否则样本外指标虚高")
    check("推理端支持奇对称对数反变换且不做输出截断",
          "symlog_return" in _val_src
          and "estimated = int(round(model_output))" in _val_src,
          "破发是需要预警的真实输出，截断会把它掩盖成 0")
    check("预测区间半宽由滚动样本外误差分位数定标",
          "interval_half_width" in _train_src
          and "np.quantile(rolling_errors" in _train_src
          and "interval_half_width" in _val_src,
          "应用数据驱动半宽替代经验系数，否则名义 80% 区间实际只覆盖约 70%")
    issuance_prediction = _val.get_listing_analysis(
        "stock", 20, 30, 35,
        stock_detail={
            "stock_code": "688001", "stock_name": "发行阶段测试股",
            "issue_price": 20, "issue_pe": 30, "industry_pe": 35,
            "industry": "专用设备", "main_business": "高端装备研发与生产",
        },
        prediction_stage="issuance",
    )
    check("申购阶段生成可能涨幅", issuance_prediction.get("prediction_stage") == "issuance"
          and issuance_prediction.get("predicted_return") is not None)
    check("结果未公布时输出可能区间", issuance_prediction.get("prediction_range_low") is not None
          and issuance_prediction.get("prediction_range_high") is not None
          and "online_lottery_rate" in issuance_prediction.get("prediction_context", {}).get("result_fields_pending", []))
    check("XGBoost预测保留计算链",
          issuance_prediction.get("prediction_context", {}).get("calculation_detail", {}).get("model") in ("XGBoost", "线性兜底模型")
          and issuance_prediction.get("prediction_context", {}).get("calculation_detail", {}).get("final_return") is not None,
          "context=%r" % (issuance_prediction.get("prediction_context"),))
    summary_125 = _val._format_listing_summary(
        125,
        {"stock_code": "301668", "issue_price": 84.46},
        "热市",
    )
    check("新股125%按50%档位向下显示100%", "约100%" in summary_125, "summary=%r" % summary_125)
    check("新股摘要包含单签收益", "预计首日单签收益4万元" in summary_125, "summary=%r" % summary_125)
    summary_sh_main = _val._format_listing_summary(
        100,
        {"stock_code": "603448", "issue_price": 62.65},
        "热市",
    )
    check("沪市主板新股按500股/签计算", "预计首日单签收益3万元" in summary_sh_main,
          "summary=%r" % summary_sh_main)
    summary_under_ten_thousand = _val._format_listing_summary(
        100,
        {"stock_code": "301001", "issue_price": 19.98},
        "热市",
    )
    check("单签收益低于一万元时按千元向下取整",
          "预计首日单签收益9千元" in summary_under_ten_thousand,
          "summary=%r" % summary_under_ten_thousand)
    _old_xgb_for_floor = _val._xgb_predict_listing
    _old_sector_for_floor = _val.detect_stock_hot_sector
    _old_temp_multiplier_for_floor = _val.get_temp_listing_multiplier
    _val._xgb_predict_listing = lambda *args, **kwargs: (125.99, ["测试"], None)
    _val.detect_stock_hot_sector = lambda *args, **kwargs: ("", 1.0)
    _val.get_temp_listing_multiplier = lambda: 1.0
    floored = _val.get_listing_analysis(
        "stock", 10, None, None,
        stock_detail={"stock_code": "001234", "issue_price": 10},
    )
    check("仅新股首日预估按50%档位向下取整", floored.get("predicted_return") == 126,
          "predicted_return=%r" % floored.get("predicted_return"))
    check("打新建议摘要不显示涨幅区间和预测版本",
          "可能区间" not in floored.get("summary", "")
          and "上市前版" not in floored.get("summary", ""),
          "summary=%r" % floored.get("summary"))
    _val._xgb_predict_listing = _old_xgb_for_floor
    _val.detect_stock_hot_sector = _old_sector_for_floor
    _val.get_temp_listing_multiplier = _old_temp_multiplier_for_floor
    sector = _val.detect_stock_hot_sector("测试", "印制电路板（PCB）研发和生产", "电子元器件")
    check("PCB赛道无历史样本时按中性系数识别", sector[0] in ("PCB", "印制电路板") and sector[1] == 1.0,
          "sector=%r" % (sector,))
    industry_fallback = _val.detect_stock_hot_sector("测试", "普通产品研发和生产", "专用设备")
    check("未命中热门赛道时按行业中性兜底", industry_fallback == ("专用设备", 1.0),
          "sector=%r" % (industry_fallback,))
    no_industry_fallback = _val.detect_stock_hot_sector("测试", "普通产品研发和生产", "")
    check("行业缺失时仍有中性赛道系数", no_industry_fallback == ("其他赛道", 1.0),
          "sector=%r" % (no_industry_fallback,))
    business, embedded_industry = fetch._split_embedded_industry(
        "电子测量技术的研究和产品开发；所属行业：仪器仪表制造业"
    )
    check("旧主营文本可拆分行业", business == "电子测量技术的研究和产品开发" and embedded_industry == "仪器仪表制造业",
          "business=%r industry=%r" % (business, embedded_industry))
    electronic_measurement = _val.get_stock_sector_context(
        "电科思仪", business, embedded_industry,
    )
    check("电子测量仪器正确识别赛道", electronic_measurement.get("label") == "电子测量仪器"
          and electronic_measurement.get("classification_status") == "matched"
          and electronic_measurement.get("confidence", 0) > 0,
          "context=%r" % (electronic_measurement,))
    shengu_exposure = _val.analyze_business_exposure(
        "沈鼓集团",
        "大型重载离心压缩机、工艺流程用往复压缩机、核泵等高端装备研发设计、生产制造和全生命周期服务业务",
        "通用设备制造业",
    )
    check("沈鼓集团主营业务识别高端装备赛道",
          any(item.get("sector_key") == "高端装备" for item in shengu_exposure.get("exposures", [])),
          "exposure=%r" % (shengu_exposure,))
    hongfucheng_exposure = _val.analyze_business_exposure(
        "鸿富诚",
        "热管理、电磁屏蔽及吸波材料等电子功能材料及器件的研发、生产和销售",
        "C39 计算机、通信和其他电子设备制造业",
    )
    check("鸿富诚主营业务识别电子功能材料赛道",
          len(hongfucheng_exposure.get("exposures", [])) == 1
          and hongfucheng_exposure["exposures"][0].get("label") == "电子功能材料"
          and hongfucheng_exposure["exposures"][0].get("sector_key") == "电子功能材料"
          and hongfucheng_exposure.get("status") == "complete",
          "exposure=%r" % (hongfucheng_exposure,))
    chain_source_text = (
        "导热界面材料上游行业主要为高分子材料、金属材料、陶瓷材料、碳基材料等基体材料和填料行业；"
        "电磁屏蔽材料上游行业主要为金属材料、塑料粒、硅胶块、导电布、泡棉等基础材料行业；"
        "吸波材料的上游行业主要为化工与高分子材料及有色金属等行业。"
        "导热界面材料、屏蔽材料、吸波材料的终端应用领域包括数据中心（AI 高功率芯片、光模块）、"
        "5G 通信、智能汽车、计算机及消费 深圳市鸿富诚新材料股份有限公司 招股说明书（注册稿） 1-1-128 电子等。"
    )
    chain = fetch._extract_industry_chain_relations(chain_source_text)
    check("招股书上下游关系提取覆盖上游材料与下游应用",
          chain.get("status") == "complete"
          and set(chain.get("products", [])) == {"热管理材料", "电磁屏蔽材料", "吸波材料"}
          and len(chain.get("upstream", [])) >= 10
          and all(item.get("relationship") == "supplies" and item.get("evidence")
                  for item in chain.get("upstream", []))
          and {"数据中心", "AI高功率芯片", "光模块", "5G通信", "智能汽车", "计算机", "消费电子"}.issubset(
              {item.get("industry") for item in chain.get("downstream", [])})
          and all(item.get("relationship") == "applied_in"
                  and set(item.get("products", [])) == set(chain.get("products", []))
                  and item.get("evidence") for item in chain.get("downstream", [])),
          "chain=%r" % (chain,))
    chain_exposure = _val.analyze_business_exposure(
        "鸿富诚", "热管理、电磁屏蔽及吸波材料等电子功能材料及器件的研发、生产和销售",
        "C39 计算机、通信和其他电子设备制造业", industry_chain=chain,
        evidence_document={"source": "szse", "url": "https://example.test/prospectus.pdf", "content_hash": "abc"},
    )
    related_tracks = {item.get("sector_key") for item in chain_exposure.get("exposures", [])}
    check("下游明确应用转为关联赛道并保留关系方向",
          {"算力", "人工智能", "半导体", "光通信", "5G通信", "汽车电子", "计算机", "消费电子"}.issubset(related_tracks)
          and any(item.get("relationship") == "downstream" for item in chain_exposure.get("exposures", []))
          and abs(sum(item.get("weight", 0) for item in chain_exposure.get("exposures", [])) - 1.0) < 0.001,
          "exposure=%r" % (chain_exposure,))
    chain_display = report_lib._industry_chain_display({"business_exposure": chain_exposure})
    check("IPO详情呈现上下游关系和关联赛道",
          "高分子材料" in chain_display and "数据中心" in chain_display and "光通信" in chain_display,
          "display=%r" % (chain_display,))
    _old_sector_boosts_for_l2 = dict(_val.SECTOR_EFFECTIVE_BOOSTS)
    _old_sector_counts_for_l2 = dict(_val.SECTOR_SAMPLE_COUNTS)
    _val.SECTOR_EFFECTIVE_BOOSTS.clear()
    _val.SECTOR_SAMPLE_COUNTS.clear()
    l2_key = "行业二级:801086.SI"
    taxonomy = {
        "taxonomy_code": "SW2021", "l1_name": "电子",
        "l2_code": "801086.SI", "l2_name": "电子化学品Ⅱ",
        "l3_code": "850861.SI", "l3_name": "电子化学品Ⅲ",
    }
    _val.SECTOR_EFFECTIVE_BOOSTS[l2_key] = 1.42
    _val.SECTOR_SAMPLE_COUNTS[l2_key] = 4
    l2_fallback = _val.get_stock_sector_context(
        "鸿富诚", "热管理、电磁屏蔽及吸波材料等电子功能材料及器件的研发、生产和销售",
        "C39 计算机、通信和其他电子设备制造业", stored=hongfucheng_exposure,
        industry_taxonomy=taxonomy,
    )
    check("细分赛道无样本时回退申万二级行业历史热度",
          l2_fallback.get("label") == "电子化学品Ⅱ"
          and l2_fallback.get("classification_status") == "industry_level2_fallback"
          and l2_fallback.get("multiplier") == 1.42
          and l2_fallback.get("components", [{}])[0].get("sample_count") == 4,
          "context=%r" % (l2_fallback,))
    _val.SECTOR_EFFECTIVE_BOOSTS.pop(l2_key, None)
    _val.SECTOR_SAMPLE_COUNTS.pop(l2_key, None)
    l2_neutral = _val.get_stock_sector_context(
        "鸿富诚", "热管理、电磁屏蔽及吸波材料等电子功能材料及器件的研发、生产和销售",
        "C39 计算机、通信和其他电子设备制造业", stored=hongfucheng_exposure,
        industry_taxonomy=taxonomy,
    )
    check("申万二级行业样本为空时仍显示二级行业并使用中性系数",
          l2_neutral.get("label") == "电子化学品Ⅱ"
          and l2_neutral.get("classification_status") == "industry_level2_fallback"
          and l2_neutral.get("multiplier") == 1.0
          and l2_neutral.get("components", [{}])[0].get("sample_count") == 0,
          "context=%r" % (l2_neutral,))
    _val.SECTOR_EFFECTIVE_BOOSTS.clear()
    _val.SECTOR_EFFECTIVE_BOOSTS.update(_old_sector_boosts_for_l2)
    _val.SECTOR_SAMPLE_COUNTS.clear()
    _val.SECTOR_SAMPLE_COUNTS.update(_old_sector_counts_for_l2)
    missing_context = _val.get_stock_sector_context("测试", "", "")
    check("行业和主营缺失时标记待补全", missing_context.get("classification_status") == "missing",
          "context=%r" % (missing_context,))
    exposure = _val.analyze_business_exposure(
        "贝特利",
        "电子材料和化工新材料的研发、生产与销售，产品涵盖导电材料、有机硅材料和涂层材料，广泛应用于光伏、3C电子、电子封装、医疗、新能源汽车等领域",
        "计算机、通信和其他电子设备制造业",
    )
    check("主营业务拆分多个下游", len(exposure.get("exposures", [])) >= 4,
          "exposure=%r" % (exposure,))
    check("多下游权重归一", abs(sum(x.get("weight", 0) for x in exposure.get("exposures", [])) - 1.0) < 0.001,
          "exposure=%r" % (exposure,))
    context = _val.get_stock_sector_context(
        "贝特利",
        "电子材料和化工新材料的研发、生产与销售，广泛应用于光伏、3C电子、电子封装、医疗、新能源汽车等领域",
        "计算机、通信和其他电子设备制造业",
    )
    old_sector_effective = dict(_val.SECTOR_EFFECTIVE_BOOSTS)
    _val.SECTOR_EFFECTIVE_BOOSTS.clear()
    _val.SECTOR_EFFECTIVE_BOOSTS.update({
        "光伏": 2.68, "消费电子": 2.68, "医疗器械": 2.68, "汽车电子": 2.68,
    })
    uncapped_context = _val.get_stock_sector_context(
        "贝特利",
        "电子材料和化工新材料的研发、生产与销售，广泛应用于光伏、3C电子、电子封装、医疗、新能源汽车等领域",
        "计算机、通信和其他电子设备制造业",
    )
    check("多下游赛道系数不受1.5上限限制", uncapped_context.get("multiplier", 0) > 1.5,
          "context=%r" % (uncapped_context,))
    _val.SECTOR_EFFECTIVE_BOOSTS.clear()
    _val.SECTOR_EFFECTIVE_BOOSTS.update(old_sector_effective)
    check("赛道系数直接使用历史表现比值",
          abs(_val._compute_sector_multiplier(371.73, 213.4369) - 1.742) < 0.001)
    _old_detect_for_cap = _val.detect_stock_hot_sector
    _old_context_for_cap = _val.get_stock_sector_context
    _old_xgb_for_cap = _val._xgb_predict_listing
    _old_temp_for_cap = _val.get_temp_listing_multiplier
    _val.detect_stock_hot_sector = lambda *args, **kwargs: ("新材料", 2.68)
    _val.get_stock_sector_context = lambda *args, **kwargs: {
        "label": "新材料", "multiplier": 2.68, "confidence": 0.78,
        "classification_status": "matched", "components": [],
    }
    _val._xgb_predict_listing = lambda *args, **kwargs: (308, ["测试"], None)
    _val.get_temp_listing_multiplier = lambda: 1.0
    uncapped = _val.get_listing_analysis("stock", 12.1, None, None,
                                         stock_detail={"stock_code": "301697", "stock_name": "贝特利"})
    check("风口倍数取消1.5上限", uncapped.get("predicted_return") == 825,
          "predicted_return=%r" % (uncapped.get("predicted_return"),))
    board_cases = {
        "688001": "科创板", "787001": "科创板",
        "300750": "创业板", "301668": "创业板",
        "000001": "深市主板", "001232": "深市主板", "002594": "深市主板", "003816": "深市主板",
        "600000": "沪市主板", "601398": "沪市主板", "603448": "沪市主板", "605319": "沪市主板",
        "920196": "北交所", "830799": "北交所", "870204": "北交所", "832000": "北交所", "430047": "北交所",
        "999999": "未知",
    }
    board_mismatched = {code: _val._get_board_key_from_code(code)
                        for code, expected in board_cases.items()
                        if _val._get_board_key_from_code(code) != expected}
    check("板块识别覆盖各板块前缀且未知代码不猜板块", not board_mismatched,
          "实得=%s" % (board_mismatched,))
    check("申购单位统一使用北交所判定",
          _val._get_lot_size("920196") == 100 and _val._get_lot_size("430047") == 100
          and _val._get_lot_size("830799") == 100 and _val._get_lot_size("688001") == 500,
          "920196=%s 430047=%s 830799=%s 688001=%s" % (
              _val._get_lot_size("920196"), _val._get_lot_size("430047"),
              _val._get_lot_size("830799"), _val._get_lot_size("688001")))
    check("未知代码板块基准返回未知而非默认沪市主板",
          _val.estimate_board_base("999999") == 0 and _val.estimate_board_base("688001") > 0,
          "未知=%s 科创板=%s" % (_val.estimate_board_base("999999"), _val.estimate_board_base("688001")))
    check("北交所不套用非北交所模型",
          _val.get_listing_analysis(
              "stock", 10, None, None,
              stock_detail={"stock_code": "920196", "stock_name": "北交测试"}
          ).get("prediction_context", {}).get("prediction_unavailable_reason") == "board_not_covered",
          "实得=%s" % (_val.get_listing_analysis(
              "stock", 10, None, None,
              stock_detail={"stock_code": "920196", "stock_name": "北交测试"}),))
    unknown_board_prediction = _val.get_listing_analysis(
        "stock", 10, None, None, stock_detail={"stock_code": "999999", "stock_name": "未知板块测试"})
    check("未知板块不使用猜测的板块基准",
          ((unknown_board_prediction.get("prediction_context") or {}).get("calculation_detail") or {}).get("board_base") is None,
          "实得=%s" % (unknown_board_prediction,))
    _val.detect_stock_hot_sector = _old_detect_for_cap
    _val.get_stock_sector_context = _old_context_for_cap
    _val._xgb_predict_listing = _old_xgb_for_cap
    _val.get_temp_listing_multiplier = _old_temp_for_cap
    _val._fetch_all_bonds_market = lambda: []          # 空列表 -> 走 fallback: base_premium = market['avg_premium']
    _val.fetch_market_heat = lambda: {"index_level": "中性", "avg_premium": 0.30, "index_1m": 0.0}
    _val.calculate_liquidity_adjustment = lambda cs, *_args: {
        "adjustment_pp": -5.0 if float(cs) >= 10 else (20.0 if float(cs) < 3 else 0.0),
        "bucket_label": liquidity_bucket(cs)[1], "sample_count": 8,
        "weight_text": "测试样本", "model_version": "dynamic_residual_v1",
    }
    _old_xgb = _val._xgb_predict_listing
    _val._xgb_predict_listing = lambda *args, **kwargs: None
    fallback = _val.get_listing_analysis("stock", 10, None, None, stock_detail={"stock_code": "001234"})
    check("新股线性模型回退已初始化", fallback.get("predicted_return") is not None)
    _val._xgb_predict_listing = _old_xgb

    sample_md = "#### 测试新股（688001）\n- **首日预估**：100%\n\n### 💰 新债申购\n\n| 债券 | 内容 |"
    stock_section = m._extract_code_sections(sample_md).get("688001", "")
    check("新股单独报告不混入新债", "新债申购" not in stock_section)

    # 3.1 发行规模(总募资)折扣档位：TV=100 / 流通20亿(巨盘,-0.05) / AAA(+0.05)
    #     总溢价率 = 0.30(基础) -0.05(流通) + 发行折扣 + 0.05(AAA)
    discount_cases = [
        (500, 112.00, "超大盘(>=300亿) -0.18"),
        (150, 120.00, "大盘(>=100亿) -0.10"),
        (60,  125.00, "中大盘(>=50亿) -0.05"),
        (None, 130.00, "无发行规模折扣 0"),
    ]
    for isz, exp_price, label in discount_cases:
        r, err = m.estimate_bond_listing_price(100, 20, "AAA",
                                                bond_name="", stock_name="", stock_industry="",
                                                issue_scale=isz)
        check("发行规模折扣 %s" % label, err is None and abs(r["price"] - exp_price) < 0.01,
              "issue_scale=%s 实得=%s 期望=%s" % (isz, (r or {}).get("price"), exp_price))

    # 3.2 区间带宽度（ref_size = issue_scale 优先，否则流通规模）
    r500, _ = m.estimate_bond_listing_price(100, 20, "AAA", issue_scale=500)   # >=50亿 -> ±10
    check("区间带 500亿 ±10 (low)", abs(r500["low"] - 102.0) < 0.01, "low=%s" % r500["low"])
    check("区间带 500亿 ±10 (high)", abs(r500["high"] - 122.0) < 0.01, "high=%s" % r500["high"])

    r20, _ = m.estimate_bond_listing_price(100, 20, "AAA", issue_scale=20)     # >=20亿 -> ±7
    check("区间带 20亿 ±7 (low)", abs(r20["low"] - 123.0) < 0.01, "low=%s" % r20["low"])
    check("区间带 20亿 ±7 (high)", abs(r20["high"] - 137.0) < 0.01, "high=%s" % r20["high"])

    r8, _ = m.estimate_bond_listing_price(100, 20, "AAA", issue_scale=8)       # >=5亿 -> ±5
    check("区间带 8亿 ±5 (low)", abs(r8["low"] - 125.0) < 0.01, "low=%s" % r8["low"])
    check("区间带 8亿 ±5 (high)", abs(r8["high"] - 135.0) < 0.01, "high=%s" % r8["high"])

    r3cs, _ = m.estimate_bond_listing_price(100, 2, "AAA", issue_scale=None)   # 流通2亿(<3) -> ±3
    check("区间带 流通2亿 ±3 (low)", abs(r3cs["low"] - 152.0) < 0.01, "low=%s" % r3cs["low"])
    check("区间带 流通2亿 ±3 (high<=157.3)", abs(r3cs["high"] - 157.3) < 0.01, "high=%s" % r3cs["high"])

    # 3.3 摘要格式：最终理论价按5元档向下取整，不显示首日交易上限替代值。
    check("summary 显示向下取整后的最终价格", r500["summary"] == "110元左右", "summary=%r" % r500["summary"])
    capped_result, _ = m.estimate_bond_listing_price(108, 2, "AAA", issue_scale=None)
    check("理论估值167元向下展示165元左右",
          capped_result["price"] == 157.3
          and capped_result["display_price"] == 165
          and capped_result["summary"] == "165元左右",
          "price=%s display=%s summary=%s" % (
              capped_result["price"], capped_result["display_price"], capped_result["summary"]))

    # 3.4 返回结构含 low/high 区间键
    check("返回含 low 键", "low" in r500)
    check("返回含 high 键", "high" in r500)

    # 3.5 回归：issue_scale=None 不报错（旧调用兼容）
    r0, err0 = m.estimate_bond_listing_price(100, 5, "AA", issue_scale=None)
    check("issue_scale=None 正常返回", err0 is None and r0 is not None)
except Exception as e:
    ERR.append("可转债预测(发行规模/区间): " + str(e))
    traceback.print_exc()


# ===== 汇总 =====
print("\n===== 结果汇总（确定性单元测试）=====")
print("PASS=%d  FAIL=%d  ERROR=%d" % (len(PASS), len(FAIL), len(ERR)))
if FAIL:
    print("失败项:", FAIL)
if ERR:
    print("异常项:", ERR)
print("OK" if not FAIL and not ERR else "HAS_ISSUES")
