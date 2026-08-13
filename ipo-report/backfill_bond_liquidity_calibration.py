#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""首次补齐近半年新债流通规模，并恢复已有历史预测的校准基线。"""
import json
import re
from datetime import date, timedelta

import db_pg
from bond_data_layer import get_listing_liquidity, save_listing_liquidity
from ipo_lib_fetch import fetch_placing_result


OLD_ADJUSTMENT_RE = re.compile(r"流通规模.*?调整\s*([+-]?\d+(?:\.\d+)?)%")


def listing_rows():
    conn = db_pg.connect()
    try:
        return conn.execute(
            """SELECT split_part(i.canonical_code,'.',1),i.name,lp.listing_date,
                      split_part(si.canonical_code,'.',1),si.name,iss.issue_size_100m_yuan
                 FROM analytics.convertible_bond_listing_performance lp
                 JOIN core.instruments i ON i.instrument_id=lp.instrument_id
                 JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=i.instrument_id
                 LEFT JOIN core.instruments si ON si.instrument_id=p.stock_instrument_id
                 LEFT JOIN fundamental.convertible_bond_issuance iss ON iss.instrument_id=i.instrument_id
                WHERE lp.measurement_type='first_non_limit_day'
                  AND lp.listing_date >= %s::date
                ORDER BY lp.listing_date""",
            ((date.today() - timedelta(days=184)).isoformat(),),
        ).fetchall()
    finally:
        conn.close()


def backfill_liquidity():
    total = saved = cached = failed = 0
    for code, bond_name, listing_date, stock_code, stock_name, issue_scale in listing_rows():
        total += 1
        if get_listing_liquidity(code):
            cached += 1
            continue
        if not stock_code or not issue_scale:
            failed += 1
            print(f"[跳过] {bond_name}({code}) 缺正股代码或发行规模")
            continue
        result = fetch_placing_result(stock_code, float(issue_scale), bond_code=code, stock_name=stock_name)
        if save_listing_liquidity(code, result, listing_date):
            saved += 1
            print(f"[保存] {bond_name}({code}) 流通{result['circulation_scale']}亿")
        else:
            failed += 1
            print(f"[失败] {bond_name}({code}) {result.get('error', '未知错误')}")
    return {"total": total, "saved": saved, "cached": cached, "failed": failed}


def backfill_prediction_baselines():
    """仅使用当时日报已经保存的预测拆分流通调整，不用未来数据倒推。"""
    conn = db_pg.connect()
    updated = 0
    try:
        rows = conn.execute(
            """SELECT elem->>'code',elem->'detail'->>'transfer_value',
                      elem->'detail'->>'circulation_scale',
                      COALESCE(elem->'listing_analysis'->>'tracking_price',elem->'listing_analysis'->>'price'),
                      elem->'listing_analysis'->>'detail',elem->'listing_analysis'
                 FROM ipo_reports r
                 CROSS JOIN LATERAL jsonb_array_elements(r.summary_json->'list_bonds') elem
                WHERE r.report_date >= to_char(current_date - interval '6 months','YYYYMMDD')
                  AND elem->'detail'->>'circulation_scale' IS NOT NULL
                  AND elem->'detail'->>'transfer_value' IS NOT NULL"""
        ).fetchall()
        for code, tv_text, scale_text, pred_text, detail, context in rows:
            try:
                tv = float(tv_text)
                scale = float(scale_text)
                pred_price = float(pred_text)
            except (TypeError, ValueError):
                continue
            match = OLD_ADJUSTMENT_RE.search(detail or "")
            if not match:
                continue
            old_adjustment_pp = float(match.group(1))
            base_price = round(pred_price - tv * old_adjustment_pp / 100, 4)
            cursor = conn.execute(
                """UPDATE predictions SET
                      transfer_value=%s,circulation_scale=%s,base_price_no_liquidity=%s,
                      liquidity_adjustment_pp=%s,liquidity_sample_count=0,
                      valuation_model_version='legacy_snapshot_v1',valuation_context=%s::jsonb
                    WHERE type='bond' AND code=%s AND pred_price IS NOT NULL
                      AND (base_price_no_liquidity IS NULL OR valuation_model_version IS NULL)""",
                (tv, scale, base_price, old_adjustment_pp,
                 json.dumps(context or {}, ensure_ascii=False, default=str), code),
            )
            updated += max(0, cursor.rowcount)
        conn.execute(
            """UPDATE predictions p SET circulation_scale=l.circulation_scale_100m_yuan
                  FROM analytics.convertible_bond_listing_liquidity l
                 WHERE p.type='bond' AND p.instrument_id=l.instrument_id
                   AND p.base_price_no_liquidity IS NOT NULL"""
        )
        conn.commit()
        return updated
    finally:
        conn.close()


def main():
    result = backfill_liquidity()
    baselines = backfill_prediction_baselines()
    print(json.dumps({"liquidity": result, "prediction_baselines": baselines}, ensure_ascii=False))
    if result["total"] and result["saved"] + result["cached"] == 0:
        raise SystemExit("近半年流通规模全部补齐失败")


if __name__ == "__main__":
    main()
