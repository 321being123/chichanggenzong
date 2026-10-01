# -*- coding: utf-8 -*-
"""新股历史同步确定性测试：不访问外部接口，事务结束后回滚。"""
import os
import sys
import json
import traceback
from datetime import date, datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ipo_history_sync as sync
import ipo_lib_fetch
from ipo_lib_fetch import _extract_main_business

PASS, FAIL, ERR = [], [], []


class QualityCursorSpy:
    def execute(self, query, params=()):
        self.query = query
        self.params = params

    def fetchall(self):
        return []


class IndustryTaxonomyCursorSpy:
    def __init__(self, stored=None, listing_date=None, ipo_status="listed"):
        self.connection = object()
        self.row = (stored, listing_date, ipo_status)
        self.rowcount = 0
        self.query = ""
        self.params = ()

    def execute(self, query, params=()):
        self.query = query
        self.params = params
        self.rowcount = 1 if "UPDATE ipo_history" in query else 0

    def fetchone(self):
        return self.row


def check(name, condition, detail=""):
    (PASS if condition else FAIL).append(name)
    print("  [%s] %s %s" % ("PASS" if condition else "FAIL", name, detail))


try:
    targeted_quality_cursor = QualityCursorSpy()
    targeted_codes = ["920196", "301718", "920162"]
    sync.update_quality(targeted_quality_cursor, date(2026, 9, 29), only_codes=targeted_codes)
    check("定向补全质量刷新只查询目标证券",
          "security_code=ANY(%s::text[])" in targeted_quality_cursor.query
          and targeted_quality_cursor.params == (sorted(targeted_codes),),
          repr(targeted_quality_cursor.params))
    check("定向任务存在请求字段缺口不能完成",
          not sync._targeted_stage_complete(
              {"attempted": 3, "failed": 0, "stopped": None, "remaining": 1,
               "industry_taxonomy": {"updated": 3, "cached": 0, "missing": 0, "failed": 0, "stopped": None}},
              targeted_codes
          ))
    check("定向任务遇 Guard 停止不能标记阶段完成",
          not sync._targeted_stage_complete(
              {"attempted": 2, "failed": 0, "stopped": {"code": "CIRCUIT_OPEN"},
               "industry_taxonomy": {"updated": 0, "cached": 0, "missing": 0, "failed": 0, "stopped": None}},
              targeted_codes
          ))

    taxonomy_cursor = IndustryTaxonomyCursorSpy()
    old_taxonomy_query = sync.tushare_query
    old_provider_resolver = sync.resolve_provider_code
    sync.tushare_query = lambda api, params, fields: [{
        "ts_code": "301716.SZ", "l1_code": "801080.SI", "l1_name": "电子",
        "l2_code": "801086.SI", "l2_name": "电子化学品Ⅱ",
        "l3_code": "850861.SI", "l3_name": "电子化学品Ⅲ", "is_new": "Y",
    }]
    sync.resolve_provider_code = lambda code, *args, **kwargs: "301716.SZ"
    try:
        taxonomy_result = sync.sync_sw_industry_taxonomies(
            taxonomy_cursor, ["301716"], date(2026, 9, 29)
        )
    finally:
        sync.tushare_query = old_taxonomy_query
        sync.resolve_provider_code = old_provider_resolver
    check("申万二级行业路径入库且不覆盖官方行业事实",
          taxonomy_result.get("updated") == 1
          and "industry_taxonomies" in taxonomy_cursor.query
          and "SW2021" in taxonomy_cursor.query
          and taxonomy_cursor.params[0].adapted.get("l2_code") == "801086.SI"
          and taxonomy_cursor.params[0].adapted.get("l2_name") == "电子化学品Ⅱ",
          repr(taxonomy_result))

    today = sync._today_shanghai()
    sync.resolve_provider_code = lambda code, *args, **kwargs: "999999.SH"
    sync.tushare_query = lambda *args: []
    try:
        pending_cursor = IndustryTaxonomyCursorSpy(ipo_status="active")
        pending_result = sync.sync_sw_industry_taxonomies(pending_cursor, ["999999"], today)
        pending = pending_cursor.params[0].adapted
        check("未上市申万成功空结果记正常待收录且不伪造分类",
              pending_result["pending_not_due"] == 1 and pending_result["missing"] == 0
              and pending["reason"] == "prelisting_not_indexed" and "l2_code" not in pending)
        same_day = sync.sync_sw_industry_taxonomies(
            IndustryTaxonomyCursorSpy(pending, ipo_status="active"), ["999999"], today)
        check("未上市待收录同日复用数据库不重复请求",
              same_day["pending_not_due"] == 1 and same_day["attempted"] == 0)
        listed = sync.sync_sw_industry_taxonomies(
            IndustryTaxonomyCursorSpy(pending, today.isoformat(), "active"), ["999999"], today)
        check("上市日申万空结果仍为真实缺口不能沿用未上市豁免",
              listed["missing"] == 1 and listed["pending_not_due"] == 0 and listed["attempted"] == 1)
        stale = dict(pending, fetched_at="2026-01-01T12:00:00+08:00")
        next_day = sync.sync_sw_industry_taxonomies(
            IndustryTaxonomyCursorSpy(stale, ipo_status="active"), ["999999"], today)
        check("待收录次日通过原同步链重新核验", next_day["attempted"] == 1)
        valid = {"l2_code": "801050.SI", "l2_name": "有证据的测试分类"}
        sync.tushare_query = lambda *args: [valid]
        acquired_cursor = IndustryTaxonomyCursorSpy(stale, ipo_status="active")
        acquired = sync.sync_sw_industry_taxonomies(acquired_cursor, ["999999"], today)
        check("上游收录后真实分类替换待收录状态",
              acquired["updated"] == 1 and acquired_cursor.params[0].adapted["l2_code"] == valid["l2_code"]
              and "status" not in acquired_cursor.params[0].adapted)
        def failed_query(*args):
            raise RuntimeError("接口请求失败")
        sync.tushare_query = failed_query
        failed = sync.sync_sw_industry_taxonomies(
            IndustryTaxonomyCursorSpy(ipo_status="active"), ["999999"], today)
        check("未上市接口失败不能伪装正常待收录", failed["failed"] == 1 and failed["pending_not_due"] == 0)
        check("定向资料完整且仅未上市申万待收录允许完成",
              sync._targeted_stage_complete({"attempted": 1, "remaining": 0,
                                             "industry_taxonomy": pending_result}, ["999999"]))
    finally:
        sync.tushare_query = old_taxonomy_query
        sync.resolve_provider_code = old_provider_resolver

    loss = sync.normalize_share({
        "ts_code": "999999.SH", "name": "测试新股", "ipo_date": "20260801",
        "issue_date": "20260811", "amount": 1000, "market_amount": 500,
        "price": 20, "pe": None, "limit_amount": 1, "funds": None, "ballot": 0.03,
    })
    check("日期标准化", loss["ipo_date"] == "2026-08-01" and loss["listing_date"] == "2026-08-11")
    check("募资额派生", loss["fund_raised"] == 2.0)
    check("Guard恢复时间可序列化", sync._recover_at_text(datetime(2026, 9, 10, 22, 0)) == "2026-09-10T22:00:00")
    check("公开发行市值派生", loss["circulation_mv"] == 1.0)
    check("无公告证据时发行PE状态待确认", loss["issue_pe"] is None and loss["issue_pe_status"] == "pending")

    long_business = "公司主要从事" + "高性能云端人工智能芯片研发设计销售及配套软件服务" * 10 + "。"
    extracted = _extract_main_business(long_business)
    check("主营业务全文不截断", extracted is not None and len(extracted) > 200, str(len(extracted or "")))

    conn = sync.pg_connect()
    cur = conn.cursor()
    cur.execute("DELETE FROM ipo_history WHERE security_code='999999'")
    inserted, refreshed = sync.upsert_shares(cur, [loss])
    check("首次写入", inserted == 1 and refreshed == 0)
    cur.execute("UPDATE ipo_history SET source_payload=source_payload || %s::jsonb WHERE security_code='999999'",
                (json.dumps({"industry_taxonomies": {"SW2021": pending}}),))
    check("申万待收录记录不依赖申购上市日期继续进入原任务",
          "999999" in sync.target_enrichment_codes(cur, date(2026, 12, 31)))
    blank = dict(loss)
    blank.update({"issue_price": None, "online_shares": None, "circulation_mv": None,
                  "source_payload": {"ts_code": "999999.SH", "price": None}})
    inserted2, refreshed2 = sync.upsert_shares(cur, [blank])
    cur.execute("SELECT issue_price,online_shares,circulation_mv,ipo_date FROM ipo_history WHERE security_code='999999'")
    row = cur.fetchone()
    check("空值不覆盖旧值", inserted2 == 0 and refreshed2 == 1 and tuple(row) == (20.0, 500.0, 1.0, "2026-08-01"), str(row))
    cur.execute(
        "UPDATE ipo_history SET main_business=%s, industry='', business_exposure='{}'::jsonb WHERE security_code='999999'",
        ("电子测量技术的研究和产品开发；所属行业：仪器仪表制造业",),
    )
    normalized = sync.normalize_stored_details(cur, date(2026, 9, 9))
    cur.execute("SELECT main_business,industry,business_exposure FROM ipo_history WHERE security_code='999999'")
    detail = cur.fetchone()
    check(
        "已入库主营文本归一化",
        normalized["updated"] >= 1
        and detail[0] == "电子测量技术的研究和产品开发"
        and detail[1] == "仪器仪表制造业"
        and detail[2].get("exposures", [{}])[0].get("label") == "电子测量仪器",
        str(detail),
    )

    current_codes = [str(970000 + index) for index in range(25)]
    historical_codes = [str(970025 + index) for index in range(40)]
    empty_exposure_code = "969995"
    cur.execute(
        """INSERT INTO ipo_history(security_code,security_name,market_code,ipo_date,ipo_status,
                                    industry,industry_pe,main_business,business_exposure)
             VALUES(%s,'空赛道数组测试','CN','2026-09-11','active','测试行业',30,'主营业务',
                    '{"exposures":[]}'::jsonb)
             ON CONFLICT(security_code) DO UPDATE SET market_code='CN',ipo_date='2026-09-11',
               ipo_status='active',industry='测试行业',industry_pe=30,main_business='主营业务',
               business_exposure='{"exposures":[]}'::jsonb""",
        (empty_exposure_code,),
    )
    empty_exposure_candidates = sync.target_enrichment_codes(cur, date(2026, 9, 11))
    check("空赛道数组在候选和字段状态中都算缺口",
          empty_exposure_code in empty_exposure_candidates
          and not sync._has_business_exposures({"exposures": []})
          and sync._detail_field_state({"exposures": []})["status"] == "retryable"
          and sync._has_business_exposures({"exposures": [{"label": "测试"}]})
          and not sync._has_business_exposures({"version": 2, "exposures": [{"label": "测试"}],
                                                 "industry_chain": {"status": "partial"}})
          and sync._has_business_exposures({"version": 2, "exposures": [{"label": "测试"}],
                                            "industry_chain": {"status": "complete"}}))
    cur.executemany(
        """INSERT INTO ipo_history(security_code,security_name,market_code,ipo_date,listing_date,ipo_status)
             VALUES(%s,%s,'CN',%s,%s,%s)
             ON CONFLICT(security_code) DO UPDATE SET industry=NULL,industry_pe=NULL,main_business=NULL,
               business_exposure='{}'::jsonb,data_quality_status='{}'::jsonb,ipo_date=EXCLUDED.ipo_date,
               listing_date=EXCLUDED.listing_date,ipo_status=EXCLUDED.ipo_status""",
        [
            (code, "当前发行" + code, "2026-09-11", None, "active")
            for code in current_codes
        ] + [
            (code, "历史新股" + code, "2026-08-01", "2026-08-10", "listed")
            for code in historical_codes
        ],
    )
    scoped_code = "969999"
    cur.execute(
        """INSERT INTO ipo_history(security_code,security_name,market_code,ipo_date,ipo_status)
             VALUES(%s,%s,'CN','2026-09-11','active')
             ON CONFLICT(security_code) DO UPDATE SET market_code='CN',ipo_date='2026-09-11',
               ipo_status='active',industry=NULL,industry_pe=NULL,main_business=NULL,
               business_exposure='{}'::jsonb,data_quality_status='{}'::jsonb""",
        (scoped_code, "阶段范围测试"),
    )
    calls = []
    original_fetch = ipo_lib_fetch.fetch_stock_historical_detail

    def fake_fetch(code, existing_industry=None, existing_main_business=None, missing_fields=None):
        calls.append(code)
        return {
            "industry": "半导体",
            "industry_pe": 30.0,
            "main_business": "高性能芯片研发设计销售及相关软件服务" * 15,
            "business_exposure": {
                "status": "complete", "confidence": 0.9,
                "exposures": [{"label": "半导体", "weight": 1.0}],
            },
            # 数据源在"尚未公布"时会给出 0 而不是空值，这里固定返回 0
            # 以验证写入侧不会把占位 0 当成实测值写回库。
            "online_lottery_rate": 0,
            "oversubscribe_multiple": 0,
        }

    ipo_lib_fetch.fetch_stock_historical_detail = fake_fetch
    try:
        scoped = sync.enrich_stock_missing_details(
            cur, date(2026, 9, 10), target_date=date(2026, 9, 11),
            priority_codes=[scoped_code], only_codes=[scoped_code], retry_same_day=True,
        )
        cur.execute("""
          SELECT count(*) FILTER (WHERE NULLIF(industry,'') IS NULL)
               + count(*) FILTER (WHERE industry_pe IS NULL)
               + count(*) FILTER (WHERE NULLIF(main_business,'') IS NULL)
               + count(*) FILTER (WHERE business_exposure IS NULL OR business_exposure='{}'::jsonb
                                   OR NOT (business_exposure ? 'exposures'))
            FROM ipo_history WHERE market_code='CN' AND ipo_date ~ '^\\d{4}-\\d{2}-\\d{2}$'
        """)
        unrelated_remaining = int(cur.fetchone()[0] or 0)
        check("阶段剩余只统计目标代码", scoped["remaining"] == 0 and unrelated_remaining > 0,
              "目标已补齐时不被其他历史新股缺口误阻塞")
        calls.clear()

        no_candidate_code = "969998"
        cur.execute(
            """INSERT INTO ipo_history(security_code,security_name,market_code,ipo_date,ipo_status,
                                        data_quality_status)
                 VALUES(%s,%s,'CN','2026-09-11','active',
                        '{"enrichment":{"attempted_on":"2026-09-10"}}'::jsonb)
                 ON CONFLICT(security_code) DO UPDATE SET market_code='CN',ipo_date='2026-09-11',
                   ipo_status='active',industry=NULL,industry_pe=NULL,main_business=NULL,
                   business_exposure='{}'::jsonb,
                   data_quality_status='{"enrichment":{"attempted_on":"2026-09-10"}}'::jsonb""",
            (no_candidate_code, "已尝试但仍缺资料"),
        )
        cur.execute(
            """UPDATE ipo_history SET data_quality_status=jsonb_set(
                    data_quality_status,'{enrichment,industry_parser_version}',%s::jsonb,true)
                 WHERE security_code=%s""",
            ('"ipo-issuance-facts-v2"', no_candidate_code),
        )
        old_parser_attempted = sync.same_day_target_attempted_codes(
            cur, date(2026, 9, 10), date(2026, 9, 11)
        )
        check("解析器版本升级后同日旧尝试不再短路",
              no_candidate_code not in old_parser_attempted)
        cur.execute(
            """UPDATE ipo_history SET data_quality_status=jsonb_set(
                    data_quality_status,'{enrichment,industry_parser_version}',%s::jsonb,true)
                 WHERE security_code=%s""",
            (json.dumps(ipo_lib_fetch._IPO_ISSUANCE_PARSER_VERSION), no_candidate_code),
        )
        current_parser_attempted = sync.same_day_target_attempted_codes(
            cur, date(2026, 9, 10), date(2026, 9, 11)
        )
        check("同版本成功尝试仍按日去重",
              no_candidate_code in current_parser_attempted)
        no_candidate = sync.enrich_stock_missing_details(
            cur, date(2026, 9, 10), target_date=date(2026, 9, 11), only_codes=[no_candidate_code]
        )
        check(
            "空候选仍保留已知资料缺口",
            no_candidate["attempted"] == 0
            and no_candidate["remaining"] == 4
            and no_candidate["remaining_by_field"] == {
                "industry": 1, "industry_pe": 1, "main_business": 1, "business_exposure": 1,
            }
            and no_candidate["diagnostic_summary"].get("query_status") == "succeeded"
            and no_candidate["diagnostic_summary"]["by_field_and_reason"]["industry"]["not_attempted"]["security_codes"]
            == [no_candidate_code],
            str(no_candidate),
        )

        # 断言范围限定在本测试构造的证券代码：测试库可能带有回填前的历史残留，
        # 全库扫描会让该断言依赖库快照新旧，无法稳定反映本次写入行为。
        cur.execute(
            "UPDATE ipo_history SET online_lottery_rate=NULL, oversubscribe_multiple=NULL "
            "WHERE left(security_code,3) IN ('969','970')"
        )
        result = sync.enrich_stock_missing_details(
            cur, date(2026, 9, 10), target_date=date(2026, 9, 11), priority_codes=current_codes
        )
    finally:
        ipo_lib_fetch.fetch_stock_historical_detail = original_fetch
    check("资料补全无固定8条上限", result["attempted"] >= 65, str(result))
    cur.execute(
        "SELECT count(*) FROM ipo_history WHERE (online_lottery_rate = 0 "
        "OR oversubscribe_multiple = 0) AND left(security_code,3) IN ('969','970')"
    )
    check("中签率与超额认购倍数零占位不被写回库",
          int(cur.fetchone()[0] or 0) == 0,
          "数据源返回 0 时必须按缺失处理，否则写入侧会把它当结果长期维持")
    check("当前发行25条全部优先", set(calls[:25]) == set(current_codes), str(calls[:25]))
    cur.execute("SELECT min(length(main_business)) FROM ipo_history WHERE security_code=ANY(%s)", (current_codes,))
    check("长主营业务完整入库", int(cur.fetchone()[0] or 0) > 200)

    evidence_code = "969997"
    cur.execute(
        """INSERT INTO ipo_history(security_code,security_name,market_code,ipo_date,ipo_status,
                                    industry_pe,main_business,business_exposure,
                                    online_lottery_rate,oversubscribe_multiple,data_quality_status)
             VALUES(%s,'证据落库测试','CN','2026-09-11','active',38.2,'主营业务测试',
                    '{"exposures":[{"label":"测试"}]}'::jsonb,0.02,100,'{}'::jsonb)
             ON CONFLICT(security_code) DO UPDATE SET market_code='CN',ipo_date='2026-09-11',
               ipo_status='active',industry=NULL,industry_pe=38.2,main_business='主营业务测试',
               business_exposure='{"exposures":[{"label":"测试"}]}'::jsonb,
               online_lottery_rate=0.02,oversubscribe_multiple=100,source_payload='{}'::jsonb,
               data_quality_status='{}'::jsonb""",
        (evidence_code,),
    )
    evidence_calls = []

    def fake_industry_evidence(code, existing_industry=None, existing_main_business=None, missing_fields=None):
        evidence_calls.append(list(missing_fields or []))
        result = {
            "industry": "计算机、通信和其他电子设备制造业",
            "industry_diagnostic": {
                "status": "value", "source": "cninfo", "document_url": "https://example.test/ipo.pdf",
                "content_hash": "fixture-hash", "parser_version": "ipo-issuance-facts-v3",
                "classification_system": "listed_company_industry_classification",
                "classification_version": "2023", "classification_code": "C39",
            },
            "industry_evidence": {"snippet": "发行人所属行业为（C39）计算机、通信和其他电子设备制造业"},
            "industry_classification": {
                "classification_system": "national_economic_industry",
                "classification_version": "GB/T 4754-2017", "classification_code": "C39",
            },
        }
        if code == "969994":
            result["issuance_stopped"] = {
                "code": "CIRCUIT_OPEN", "source": "szse",
                "recover_at": "2026-09-10T10:00:00+08:00",
            }
        return result

    ipo_lib_fetch.fetch_stock_historical_detail = fake_industry_evidence
    try:
        first_evidence_run = sync.enrich_stock_missing_details(
            cur, date(2026, 9, 10), only_codes=[evidence_code], retry_same_day=True
        )
        same_value_evidence_run = sync.enrich_stock_missing_details(
            cur, date(2026, 9, 10), only_codes=[evidence_code],
            priority_codes=[evidence_code], retry_same_day=True,
        )
        cur.execute(
            """SELECT industry,data_quality_status->'field_states'->'industry',
                      source_payload->'historical_enrichment'->'industry_evidence'
                 FROM ipo_history WHERE security_code=%s""",
            (evidence_code,),
        )
        evidence_row = cur.fetchone()
    finally:
        ipo_lib_fetch.fetch_stock_historical_detail = original_fetch
    check("只缺行业时独立请求且分类证据落库",
          evidence_calls == [["industry"], []]
          and evidence_row[0] == "计算机、通信和其他电子设备制造业"
          and evidence_row[1].get("source") == "cninfo"
          and evidence_row[1].get("document_url") == "https://example.test/ipo.pdf"
          and evidence_row[2].get("snippet", "").startswith("发行人所属行业"),
          "missing_fields=%r state=%r evidence=%r" % (evidence_calls, evidence_row[1], evidence_row[2]))
    check("值未变化时仍幂等保留本轮行业证据",
          first_evidence_run["updated"] == 1 and same_value_evidence_run["updated"] == 1
          and evidence_row[2].get("snippet", "").startswith("发行人所属行业"))

    upgrade_code = "969993"
    legacy_payload = {
        "historical_enrichment": {
            "industry_source": "tushare_stock_basic",
            "industry_pe_source": "tushare_derived_industry_median",
        }
    }
    cur.execute(
        """INSERT INTO ipo_history(security_code,security_name,market_code,ipo_date,ipo_status,
                                    industry,industry_pe,main_business,business_exposure,
                                    online_lottery_rate,oversubscribe_multiple,source_payload,data_quality_status)
             VALUES(%s,'行业升级测试','CN','2026-09-11','active','全国地产',36.5,'主营业务测试',
                    '{\"exposures\":[{\"label\":\"地产\"}]}'::jsonb,0.02,100,%s::jsonb,'{}'::jsonb)
             ON CONFLICT(security_code) DO UPDATE SET market_code='CN',ipo_date='2026-09-11',
               ipo_status='active',industry='全国地产',industry_pe=36.5,main_business='主营业务测试',
               business_exposure='{"exposures":[{"label":"地产"}]}'::jsonb,
               online_lottery_rate=0.02,oversubscribe_multiple=100,source_payload=EXCLUDED.source_payload,
               data_quality_status='{}'::jsonb""",
        (upgrade_code, json.dumps(legacy_payload)),
    )
    upgrade_calls = []

    def fake_authoritative_upgrade(code, existing_industry=None, existing_main_business=None, missing_fields=None):
        upgrade_calls.append(list(missing_fields or []))
        return {
            "industry": "计算机、通信和其他电子设备制造业",
            "industry_source": "sse",
            "industry_diagnostic": {
                "status": "value", "source": "sse", "document_url": "https://example.test/industry.pdf",
                "content_hash": "official-hash", "parser_version": "ipo-issuance-facts-v3",
                "classification_system": "listed_company_industry_classification",
                "classification_version": "2022", "classification_code": "C39",
            },
            "industry_evidence": {
                "snippet": "发行人所属行业为计算机、通信和其他电子设备制造业（C39）",
                "url": "https://example.test/industry.pdf", "content_hash": "official-hash",
                "parser_version": "ipo-issuance-facts-v3",
            },
            "industry_classification": {
                "classification_system": "listed_company_industry_classification",
                "classification_version": "2022", "classification_code": "C39",
            },
            "industry_pe_diagnostic": {
                "status": "source_unavailable",
                "reason": "official_industry_classification_not_matched_to_tushare_pe_sample",
            },
        }

    ipo_lib_fetch.fetch_stock_historical_detail = fake_authoritative_upgrade
    try:
        upgrade_result = sync.enrich_stock_missing_details(
            cur, date(2026, 9, 10), only_codes=[upgrade_code], priority_codes=[upgrade_code], retry_same_day=True,
        )
        cur.execute(
            """SELECT industry,industry_pe,
                      source_payload->'historical_enrichment'->'industry_upgrade_history',
                      source_payload->'historical_enrichment'->'industry_pe_legacy_history',
                      data_quality_status->'field_states'->'industry_pe'
                 FROM ipo_history WHERE security_code=%s""",
            (upgrade_code,),
        )
        upgraded_row = cur.fetchone()
    finally:
        ipo_lib_fetch.fetch_stock_historical_detail = original_fetch
    check("官方行业升级替换已知Tushare兜底并归档旧值及不匹配PE",
          upgrade_calls == [["industry", "industry_pe"]]
          and upgraded_row[0] == "计算机、通信和其他电子设备制造业"
          and upgraded_row[1] is None
          and upgraded_row[2][-1].get("previous_value") == "全国地产"
          and upgraded_row[2][-1].get("previous_source") == "tushare_stock_basic"
          and upgraded_row[3][-1].get("value") == 36.5
          and upgraded_row[3][-1].get("source") == "tushare_derived_industry_median"
          and upgraded_row[4].get("reason") == "official_industry_classification_not_matched_to_tushare_pe_sample",
          "result=%r row=%r" % (upgrade_result, upgraded_row))

    unclassified_code = "969992"
    unclassified_payload = {
        "historical_enrichment": {
            "industry_source": "szse",
            "industry_diagnostic": {
                "status": "value", "source": "szse",
                "evidence": {"url": "https://example.test/old-prospectus.pdf", "snippet": "所属行业为芯片产业"},
            },
        }
    }
    cur.execute(
        """INSERT INTO ipo_history(security_code,security_name,market_code,ipo_date,ipo_status,
                                    industry,main_business,business_exposure,source_payload,data_quality_status)
             VALUES(%s,'未分类行业升级测试','CN','2026-09-11','active','芯片产业','主营业务测试',
                    '{\"exposures\":[{\"label\":\"芯片\"}]}'::jsonb,%s::jsonb,'{}'::jsonb)
             ON CONFLICT(security_code) DO UPDATE SET market_code='CN',ipo_date='2026-09-11',
               ipo_status='active',industry='芯片产业',main_business='主营业务测试',
               business_exposure='{"exposures":[{"label":"芯片"}]}'::jsonb,
               source_payload=EXCLUDED.source_payload,data_quality_status='{}'::jsonb""",
        (unclassified_code, json.dumps(unclassified_payload)),
    )
    unclassified_calls = []

    def fake_classified_upgrade(code, existing_industry=None, existing_main_business=None, missing_fields=None):
        unclassified_calls.append(list(missing_fields or []))
        return {
            "industry": "计算机、通信和其他电子设备制造业",
            "industry_source": "cninfo",
            "industry_diagnostic": {
                "status": "value", "source": "cninfo", "document_url": "https://example.test/c39.pdf",
                "content_hash": "c39-hash", "parser_version": "ipo-issuance-facts-v5",
                "classification_system": "listed_company_association_industry_guide",
                "classification_version": "2023", "classification_code": "C39",
                "evidence": {"snippet": "通则康威所属行业为计算机、通信和其他电子设备制造业（C39）"},
            },
            "industry_evidence": {
                "snippet": "通则康威所属行业为计算机、通信和其他电子设备制造业（C39）",
                "url": "https://example.test/c39.pdf", "content_hash": "c39-hash",
                "parser_version": "ipo-issuance-facts-v5",
            },
            "industry_pe_diagnostic": {
                "status": "unavailable", "reason": "official_pe_value_not_disclosed",
            },
        }

    ipo_lib_fetch.fetch_stock_historical_detail = fake_classified_upgrade
    try:
        sync.enrich_stock_missing_details(
            cur, date(2026, 9, 10), only_codes=[unclassified_code],
            priority_codes=[unclassified_code], retry_same_day=True,
        )
        cur.execute(
            """SELECT industry,source_payload->'historical_enrichment'->'industry_upgrade_history'
                 FROM ipo_history WHERE security_code=%s""",
            (unclassified_code,),
        )
        reclassified_row = cur.fetchone()
    finally:
        ipo_lib_fetch.fetch_stock_historical_detail = original_fetch
    check("官方分类代码可替换并留痕未分类行业值",
          "industry" in unclassified_calls[0]
          and reclassified_row[0] == "计算机、通信和其他电子设备制造业"
          and reclassified_row[1][-1].get("previous_value") == "芯片产业"
          and reclassified_row[1][-1].get("previous_source") == "szse"
          and reclassified_row[1][-1].get("reason") == "verified_official_classification_replaced_unclassified_industry",
          "calls=%r row=%r" % (unclassified_calls, reclassified_row))

    stale_parser_code = "969990"
    stale_parser_payload = {"historical_enrichment": {
        "industry_source": "szse",
        "industry_pe_source": "cninfo_issuance_risk_announcement",
        "industry_diagnostic": {
            "status": "value", "source": "szse", "parser_version": "ipo-issuance-facts-v6",
            "classification_system": "national_economic_industry",
            "classification_version": "GB/T 4754-2017", "classification_code": "T4754",
            "evidence": {"url": "https://example.test/old.pdf", "snippet": "GB/T4754-2017", "classification_code": "T4754"},
        },
        "industry_pe_diagnostic": {"status": "value", "source": "cninfo_issuance_risk_announcement"},
    }}
    cur.execute(
        """INSERT INTO ipo_history(security_code,security_name,market_code,ipo_date,ipo_status,
                                    industry,industry_pe,main_business,business_exposure,source_payload,data_quality_status)
             VALUES(%s,'解析版本升级测试','CN','2026-09-11','active','标准》(GB/',73.89,
                    '热管理、电磁屏蔽及吸波材料等电子功能材料的研发、生产和销售',
                    '{\"exposures\":[{\"label\":\"电子功能材料\",\"sector_key\":\"电子功能材料\"}]}'::jsonb,
                    %s::jsonb,%s::jsonb)
             ON CONFLICT(security_code) DO UPDATE SET market_code='CN',ipo_date='2026-09-11',
               ipo_status='active',industry='标准》(GB/',industry_pe=73.89,
               main_business='热管理、电磁屏蔽及吸波材料等电子功能材料的研发、生产和销售',
               business_exposure='{"exposures":[{"label":"电子功能材料","sector_key":"电子功能材料"}]}'::jsonb,
               source_payload=EXCLUDED.source_payload,data_quality_status=EXCLUDED.data_quality_status""",
        (stale_parser_code, json.dumps(stale_parser_payload),
         json.dumps({"enrichment": {"industry_parser_version": "ipo-issuance-facts-v6", "attempted_on": "2026-09-10"}})),
    )
    stale_parser_calls = []

    def fake_parser_version_reparse(code, existing_industry=None, existing_main_business=None, missing_fields=None):
        stale_parser_calls.append(list(missing_fields or []))
        snippet = "根据《国民经济行业分类标准》（GB/T4754-2017），公司属于\"C39 计算机、通信和其他电子设备制造业\""
        return {
            "industry": "计算机、通信和其他电子设备制造业",
            "industry_source": "szse",
            "industry_diagnostic": {
                "status": "value", "source": "szse", "parser_version": ipo_lib_fetch._IPO_ISSUANCE_PARSER_VERSION,
                "document_url": "https://example.test/new.pdf", "content_hash": "new-hash",
                "classification_system": "national_economic_industry",
                "classification_version": "GB/T 4754-2017", "classification_code": "C39",
                "evidence": {"url": "https://example.test/new.pdf", "snippet": snippet, "content_hash": "new-hash", "classification_code": "C39"},
            },
            "industry_evidence": {
                "snippet": snippet, "url": "https://example.test/new.pdf", "content_hash": "new-hash",
                "parser_version": ipo_lib_fetch._IPO_ISSUANCE_PARSER_VERSION,
            },
        }

    ipo_lib_fetch.fetch_stock_historical_detail = fake_parser_version_reparse
    try:
        sync.enrich_stock_missing_details(
            cur, date(2026, 9, 10), only_codes=[stale_parser_code],
            priority_codes=[stale_parser_code], retry_same_day=True,
        )
        cur.execute(
            """SELECT industry,industry_pe,
                      source_payload->'historical_enrichment'->'industry_upgrade_history',
                      data_quality_status->'enrichment'->>'industry_parser_version'
                 FROM ipo_history WHERE security_code=%s""",
            (stale_parser_code,),
        )
        reparsed_row = cur.fetchone()
    finally:
        ipo_lib_fetch.fetch_stock_historical_detail = original_fetch
    check("行业解析器升级后定向重解析并保留官方行业PE",
          len(stale_parser_calls) == 1
          and "industry" in stale_parser_calls[0]
          and "industry_pe" not in stale_parser_calls[0]
          and reparsed_row[0] == "计算机、通信和其他电子设备制造业"
          and reparsed_row[1] == 73.89
          and reparsed_row[2][-1].get("previous_value") == '标准》(GB/'
          and reparsed_row[2][-1].get("reason") == "verified_official_industry_reparsed_after_parser_version_change"
          and reparsed_row[3] == ipo_lib_fetch._IPO_ISSUANCE_PARSER_VERSION,
          "calls=%r row=%r" % (stale_parser_calls, reparsed_row))

    cur.execute(
        """INSERT INTO ipo_history(security_code,security_name,market_code,ipo_date,ipo_status,
                                    industry_pe,main_business,business_exposure,
                                    online_lottery_rate,oversubscribe_multiple,data_quality_status)
             VALUES('969994','Guard续跑测试','CN','2026-09-11','active',38.2,'主营业务测试',
                    '{"exposures":[{"label":"测试"}]}'::jsonb,0.02,100,'{}'::jsonb)
             ON CONFLICT(security_code) DO UPDATE SET market_code='CN',ipo_date='2026-09-11',
               ipo_status='active',industry=NULL,industry_pe=38.2,main_business='主营业务测试',
               business_exposure='{"exposures":[{"label":"测试"}]}'::jsonb,
               online_lottery_rate=0.02,oversubscribe_multiple=100,data_quality_status='{}'::jsonb"""
    )
    ipo_lib_fetch.fetch_stock_historical_detail = fake_industry_evidence
    try:
        stopped_evidence = sync.enrich_stock_missing_details(
            cur, date(2026, 9, 10), only_codes=["969994"], priority_codes=["969994"],
            retry_same_day=True,
        )
        cur.execute(
            "SELECT industry,source_payload->'historical_enrichment'->'industry_evidence'->>'snippet' "
            "FROM ipo_history WHERE security_code='969994'"
        )
        stopped_row = cur.fetchone()
    finally:
        ipo_lib_fetch.fetch_stock_historical_detail = original_fetch
    check("Guard中断前的行业值和证据先写入并保留恢复点",
          stopped_evidence.get("stopped", {}).get("code") == "CIRCUIT_OPEN"
          and stopped_row[0] == "计算机、通信和其他电子设备制造业"
          and stopped_row[1].startswith("发行人所属行业"),
          "stopped=%r row=%r" % (stopped_evidence.get("stopped"), stopped_row))

    disclosure_state = {
        "status": "not_disclosed", "verified": True,
        "document_url": "https://static.cninfo.com.cn/official.pdf", "content_hash": "verified-test-hash",
        "disclosure_due": "2026-10-08", "retry_after": "2026-10-08",
    }
    check("北交所行业PE仅记录不告警",
          sync._industry_pe_non_alerting("920186", {"status": "parse_miss"}, date(2026, 10, 1)))
    check("有官方证据的尚未披露行业PE不告警",
          sync._industry_pe_non_alerting("301718", disclosure_state, date(2026, 10, 1)))
    check("行业PE披露日到期重新检查而非永久豁免",
          not sync._industry_pe_non_alerting("301718", disclosure_state, date(2026, 10, 8)))
    check("解析失败和无证据未披露不能豁免行业PE告警",
          not sync._industry_pe_non_alerting("301718", {"status": "parse_miss"}, date(2026, 10, 1))
          and not sync._industry_pe_non_alerting("301718", {"status": "not_disclosed"}, date(2026, 10, 1)))
    check("官方PE补齐后未披露状态退出",
          sync._industry_pe_state("301718", 32.5, {}, disclosure_state, date(2026, 10, 1))["status"] == "value")
    for test_code, state in (("920998", {}), ("999997", disclosure_state), ("999996", {"status": "parse_miss"})):
        cur.execute("""INSERT INTO ipo_history(security_code,security_name,market_code,ipo_date,industry_pe,data_quality_status)
                       VALUES(%s,'行业PE质量政策测试','CN','2026-10-09',NULL,%s::jsonb)
                       ON CONFLICT(security_code) DO UPDATE SET industry_pe=NULL,data_quality_status=EXCLUDED.data_quality_status""",
                    (test_code, json.dumps({"field_states": {"industry_pe": state}})))
    sync.update_quality(cur, date(2026, 10, 1), only_codes=["920998", "999997", "999996"])
    cur.execute("SELECT security_code,data_quality_status FROM ipo_history WHERE security_code=ANY(%s)",
                (["920998", "999997", "999996"],))
    quality_rows = dict(cur.fetchall())
    check("北交所PE豁免不掩盖其他资料缺项",
          "industry_pe" not in quality_rows["920998"]["missing_fields"]
          and "industry" in quality_rows["920998"]["missing_fields"]
          and quality_rows["920998"]["field_states"]["industry_pe"]["status"] == "not_required")
    check("未披露PE记录待披露但解析失败仍为缺项",
          "industry_pe" not in quality_rows["999997"]["missing_fields"]
          and "industry_pe" in quality_rows["999997"]["pending_not_due"]
          and "industry_pe" in quality_rows["999996"]["missing_fields"])
    original_taxonomy = sync.sync_sw_industry_taxonomies
    ipo_lib_fetch.fetch_stock_historical_detail = lambda *args, **kwargs: {}
    sync.sync_sw_industry_taxonomies = lambda *args, **kwargs: {}
    try:
        policy_result = sync.enrich_stock_missing_details(
            cur, date(2026, 10, 1), only_codes=["920998", "999997", "999996"],
            retry_same_day=True, include_result_fields=False)
    finally:
        ipo_lib_fetch.fetch_stock_historical_detail = original_fetch
        sync.sync_sw_industry_taxonomies = original_taxonomy
    check("补全阶段告警计数排除北交所和有证据的待披露PE",
          policy_result["remaining_by_field"]["industry_pe"] == 1
          and policy_result["diagnostic_summary"]["non_alerting_industry_pe"] == ["920998", "999997"])
    conn.rollback()
    cur.close()
    conn.close()
except Exception as exc:
    ERR.append(str(exc))
    traceback.print_exc()

print("PASS=%d FAIL=%d ERROR=%d" % (len(PASS), len(FAIL), len(ERR)))
print("OK" if not FAIL and not ERR else "HAS_ISSUES")
