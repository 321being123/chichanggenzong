# -*- coding: utf-8 -*-
"""新股历史同步确定性测试：不访问外部接口，事务结束后回滚。"""
import os
import sys
import traceback
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ipo_history_sync as sync
import ipo_lib_fetch
from ipo_lib_fetch import _extract_main_business

PASS, FAIL, ERR = [], [], []


def check(name, condition, detail=""):
    (PASS if condition else FAIL).append(name)
    print("  [%s] %s %s" % ("PASS" if condition else "FAIL", name, detail))


try:
    loss = sync.normalize_share({
        "ts_code": "999999.SH", "name": "测试新股", "ipo_date": "20260801",
        "issue_date": "20260811", "amount": 1000, "market_amount": 500,
        "price": 20, "pe": None, "limit_amount": 1, "funds": None, "ballot": 0.03,
    })
    check("日期标准化", loss["ipo_date"] == "2026-08-01" and loss["listing_date"] == "2026-08-11")
    check("募资额派生", loss["fund_raised"] == 2.0)
    check("公开发行市值派生", loss["circulation_mv"] == 1.0)
    check("亏损企业状态", loss["issue_pe"] is None and loss["issue_pe_status"] == "loss")

    long_business = "公司主要从事" + "高性能云端人工智能芯片研发设计销售及配套软件服务" * 10 + "。"
    extracted = _extract_main_business(long_business)
    check("主营业务全文不截断", extracted is not None and len(extracted) > 200, str(len(extracted or "")))

    conn = sync.pg_connect()
    cur = conn.cursor()
    inserted, refreshed = sync.upsert_shares(cur, [loss])
    check("首次写入", inserted == 1 and refreshed == 0)
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
    calls = []
    original_fetch = ipo_lib_fetch.fetch_stock_historical_detail

    def fake_fetch(code, existing_industry=None):
        calls.append(code)
        return {
            "industry": "半导体",
            "industry_pe": 30.0,
            "main_business": "高性能芯片研发设计销售及相关软件服务" * 15,
            "business_exposure": {
                "status": "complete", "confidence": 0.9,
                "exposures": [{"label": "半导体", "weight": 1.0}],
            },
        }

    ipo_lib_fetch.fetch_stock_historical_detail = fake_fetch
    try:
        result = sync.enrich_stock_missing_details(
            cur, date(2026, 9, 10), target_date=date(2026, 9, 11), priority_codes=current_codes
        )
    finally:
        ipo_lib_fetch.fetch_stock_historical_detail = original_fetch
    check("资料补全无固定8条上限", result["attempted"] >= 65, str(result))
    check("当前发行25条全部优先", set(calls[:25]) == set(current_codes), str(calls[:25]))
    cur.execute("SELECT min(length(main_business)) FROM ipo_history WHERE security_code=ANY(%s)", (current_codes,))
    check("长主营业务完整入库", int(cur.fetchone()[0] or 0) > 200)
    conn.rollback()
    cur.close()
    conn.close()
except Exception as exc:
    ERR.append(str(exc))
    traceback.print_exc()

print("PASS=%d FAIL=%d ERROR=%d" % (len(PASS), len(FAIL), len(ERR)))
print("OK" if not FAIL and not ERR else "HAS_ISSUES")
