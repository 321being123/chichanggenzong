#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""首次补齐近半年新债流通规模，并恢复已有历史预测的校准基线。"""
import json
import re
from datetime import date, timedelta
from collections import defaultdict

import db_pg
from bond_data_layer import get_listing_liquidity, save_listing_liquidity
from ipo_lib_fetch import fetch_placing_result
from ipo_lib_historical_prediction import (
    HISTORICAL_ROLLBACK_MODEL_VERSION,
    rollback_prediction,
)


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


def _historical_listing_rows(conn):
    """读取可以按上市日前事实回滚的历史新债。"""
    return conn.execute(
        """SELECT DISTINCT ON (lp.instrument_id)
                      i.instrument_id,split_part(i.canonical_code,'.',1),i.name,
                      lp.listing_date::date,
                      COALESCE(lp.close_price,100*(1+lp.return_pct/100.0)) AS actual_price,
                      p.stock_instrument_id,p.first_conv_price,p.current_conv_price,
                      p.issue_rating,p.newest_rating,p.issue_size,
                      iss.issue_size_100m_yuan,
                      l.circulation_scale_100m_yuan,
                      sb.trade_date AS quote_date,sb.close AS stock_close,
                      si.name AS stock_name
                 FROM analytics.convertible_bond_listing_performance lp
                 JOIN core.instruments i ON i.instrument_id=lp.instrument_id
                 JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=i.instrument_id
                 JOIN analytics.convertible_bond_listing_liquidity l ON l.instrument_id=i.instrument_id
                 LEFT JOIN fundamental.convertible_bond_issuance iss ON iss.instrument_id=i.instrument_id
                 LEFT JOIN core.instruments si ON si.instrument_id=p.stock_instrument_id
                 LEFT JOIN LATERAL (
                   SELECT db.trade_date,db.close
                     FROM market.daily_bars db
                    WHERE db.instrument_id=p.stock_instrument_id
                      AND db.trade_date < lp.listing_date::date
                      AND db.close IS NOT NULL
                    ORDER BY db.trade_date DESC,db.source_id DESC
                    LIMIT 1
                 ) sb ON true
                WHERE lp.measurement_type='first_non_limit_day'
                  AND lp.listing_date IS NOT NULL
                  AND COALESCE(lp.close_price,100*(1+lp.return_pct/100.0)) IS NOT NULL
                  AND l.circulation_scale_100m_yuan > 0
                ORDER BY lp.instrument_id,lp.calculated_at DESC"""
    ).fetchall()


def _historical_market_rows(conn, start_date, end_date):
    rows = conn.execute(
        """SELECT trade_date,conversion_value,conversion_premium_pct
             FROM market.convertible_bond_daily_metrics
            WHERE trade_date BETWEEN %s::date AND %s::date
              AND conversion_value IS NOT NULL
              AND conversion_premium_pct IS NOT NULL
            ORDER BY trade_date""",
        (start_date, end_date),
    ).fetchall()
    grouped = defaultdict(list)
    for trade_date, conversion_value, premium in rows:
        grouped[str(trade_date)[:10]].append({
            "conversion_value": conversion_value,
            "conversion_premium_pct": premium,
        })
    return grouped


def _historical_rating_map(conn):
    ratings = defaultdict(list)
    rows = conn.execute(
        """SELECT instrument_id,rating_date,announced_at,rating
             FROM fundamental.convertible_bond_ratings
            WHERE NULLIF(rating,'') IS NOT NULL
            ORDER BY instrument_id,rating_date,announced_at"""
    ).fetchall()
    for instrument_id, rating_date, announced_at, rating in rows:
        ratings[int(instrument_id)].append({
            "rating_date": rating_date,
            "announced_at": announced_at,
            "rating": rating,
        })
    return ratings


def _rating_as_of(ratings, as_of, fallback=""):
    target = str(as_of or "")[:10]
    valid = []
    for row in ratings or []:
        rating_date = str(row.get("rating_date") or "")[:10]
        announced_at = str(row.get("announced_at") or rating_date)[:10]
        if rating_date <= target and announced_at <= target:
            valid.append(row)
    if valid:
        return str(valid[-1].get("rating") or "")
    return str(fallback or "")


def _prediction_rows(conn):
    rows = conn.execute(
        """SELECT id,code,listing_date,pred_return,pred_price,actual_return,actual_price,
                         actual_date,status,instrument_id,transfer_value,circulation_scale,
                         base_price_no_liquidity,valuation_model_version,valuation_context
                    FROM predictions WHERE type='bond'"""
    ).fetchall()
    result = {}
    for row in rows:
        result[(str(row[1]), str(row[2])[:10])] = row
    return result


def _ready_sample(row):
    if not row:
        return None
    actual_price = row[6]
    transfer_value = row[10]
    base_price = row[12]
    scale = row[11]
    if actual_price is None or transfer_value is None or base_price is None or scale is None:
        return None
    try:
        residual = (float(actual_price) - float(base_price)) / float(transfer_value) * 100
        if float(scale) <= 0 or float(transfer_value) <= 0:
            return None
    except (TypeError, ValueError, ZeroDivisionError):
        return None
    context = row[14] if isinstance(row[14], dict) else {}
    source = str(context.get("source") or "")
    return {
        "listing_date": str(row[2])[:10],
        "circulation_scale": float(scale),
        "residual_pp": residual,
        "is_backfilled": source in ("historical_rollback", "legacy_snapshot")
                         or str(row[13] or "").startswith("historical_"),
    }


def backfill_historical_prediction_baselines():
    """按上市日期顺序回滚历史预测，只使用预测日前的事实。"""
    conn = db_pg.connect()
    try:
        candidates = _historical_listing_rows(conn)
        if not candidates:
            return {"candidates": 0, "generated": 0, "updated": 0, "skipped": 0}

        quote_dates = [str(row[13])[:10] for row in candidates if row[13]]
        market_rows = _historical_market_rows(conn, min(quote_dates), max(quote_dates)) if quote_dates else {}
        ratings = _historical_rating_map(conn)
        prediction_rows = _prediction_rows(conn)
        samples_by_key = {}
        for row in prediction_rows.values():
            sample = _ready_sample(row)
            if sample:
                samples_by_key[(sample["listing_date"], sample["circulation_scale"])] = sample

        upsert_sql = """INSERT INTO predictions
                   (type,code,name,listing_date,pred_date,pred_return,pred_price,actual_return,
                    actual_price,actual_date,status,updated_at,instrument_id,transfer_value,
                    circulation_scale,base_price_no_liquidity,liquidity_adjustment_pp,
                    liquidity_sample_count,valuation_model_version,valuation_context)
             VALUES ('bond',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now(),%s,%s,%s,%s,%s,%s,%s,%s::jsonb)
             ON CONFLICT (type,code,pred_date) DO UPDATE SET
                    name=EXCLUDED.name,
                    pred_return=COALESCE(predictions.pred_return,EXCLUDED.pred_return),
                    pred_price=COALESCE(predictions.pred_price,EXCLUDED.pred_price),
                    actual_return=COALESCE(predictions.actual_return,EXCLUDED.actual_return),
                    actual_price=COALESCE(predictions.actual_price,EXCLUDED.actual_price),
                    actual_date=COALESCE(predictions.actual_date,EXCLUDED.actual_date),
                    status=CASE WHEN COALESCE(predictions.actual_price,EXCLUDED.actual_price) IS NOT NULL
                                THEN 'fulfilled' ELSE predictions.status END,
                    updated_at=now(),instrument_id=COALESCE(predictions.instrument_id,EXCLUDED.instrument_id),
                    transfer_value=EXCLUDED.transfer_value,circulation_scale=EXCLUDED.circulation_scale,
                    base_price_no_liquidity=EXCLUDED.base_price_no_liquidity,
                    liquidity_adjustment_pp=EXCLUDED.liquidity_adjustment_pp,
                    liquidity_sample_count=EXCLUDED.liquidity_sample_count,
                    valuation_model_version=EXCLUDED.valuation_model_version,
                    valuation_context=EXCLUDED.valuation_context"""

        generated = updated = skipped = 0
        for row in sorted(candidates, key=lambda value: (str(value[3]), int(value[0]))):
            (instrument_id, code, name, listing_date, actual_price, stock_instrument_id,
             first_conv_price, current_conv_price, issue_rating, newest_rating, issue_size,
             issue_size_100m, circulation_scale, quote_date, stock_close, stock_name) = row
            if not quote_date or stock_close is None:
                skipped += 1
                continue
            conv_price = first_conv_price or current_conv_price
            try:
                transfer_value = 100.0 / float(conv_price) * float(stock_close)
                scale = float(circulation_scale)
            except (TypeError, ValueError, ZeroDivisionError):
                skipped += 1
                continue
            if transfer_value <= 0 or scale <= 0:
                skipped += 1
                continue

            listing_text = str(listing_date)[:10]
            quote_text = str(quote_date)[:10]
            existing = prediction_rows.get((str(code), listing_text))
            existing_context = existing[14] if existing and isinstance(existing[14], dict) else {}
            existing_source = str(existing_context.get("source") or "")
            if (
                existing
                and existing[6] is not None
                and existing[10] is not None
                and existing[11] is not None
                and existing[12] is not None
                and existing_source not in ("historical_rollback", "legacy_snapshot")
            ):
                # 已有真实日报基准时不被历史回滚覆盖；它会在上面的样本池中继续参与校准。
                continue
            rating = _rating_as_of(ratings.get(int(instrument_id), []), quote_text, issue_rating or newest_rating)
            prior_samples = list(samples_by_key.values())
            rollback = rollback_prediction(
                transfer_value, scale, market_rows.get(quote_text, []), listing_text,
                prior_samples, rating=rating,
                issue_scale=(issue_size_100m if issue_size_100m is not None else (
                    float(issue_size) / 100000000 if issue_size is not None else None
                )),
                bond_name=name, stock_name=stock_name or "",
            )
            if not rollback:
                skipped += 1
                continue

            old_pred_price = existing[4] if existing else None
            pred_price = float(old_pred_price) if old_pred_price is not None else rollback["tracking_price"]
            pred_return = existing[3] if existing and existing[3] is not None else round(pred_price - 100, 2)
            old_actual_price = existing[6] if existing and existing[6] is not None else actual_price
            old_actual_return = existing[5] if existing and existing[5] is not None else (
                round(float(old_actual_price) - 100, 2) if old_actual_price is not None else None
            )
            old_actual_date = existing[7] if existing and existing[7] else listing_text
            old_status = existing[8] if existing and existing[8] else "pending"
            old_context = existing_context
            context = dict(old_context)
            context.update({
                "source": "historical_rollback",
                "is_historical_backfill": True,
                "rollback_model_version": HISTORICAL_ROLLBACK_MODEL_VERSION,
                "prediction_date": listing_text,
                "quote_date": quote_text,
                "preserved_original_prediction": old_pred_price is not None,
                "base_components": {
                    key: rollback[key] for key in (
                        "base_premium", "rating_adjustment", "sector_adjustment",
                        "issue_size_adjustment", "market_sample_count",
                    )
                },
                "rollback_price": rollback["tracking_price"],
            })
            conn.execute(upsert_sql, (
                str(code), name or str(code), listing_text, listing_text,
                pred_return, pred_price, old_actual_return, old_actual_price, old_actual_date,
                "fulfilled" if old_actual_price is not None else old_status,
                instrument_id, transfer_value, scale, rollback["base_price_no_liquidity"],
                rollback["liquidity_adjustment_pp"], rollback["liquidity_sample_count"],
                HISTORICAL_ROLLBACK_MODEL_VERSION, json.dumps(context, ensure_ascii=False, default=str),
            ))
            generated += 1 if old_pred_price is None else 0
            updated += 1

            if old_actual_price is not None:
                samples_by_key[(listing_text, scale)] = {
                    "listing_date": listing_text,
                    "circulation_scale": scale,
                    "residual_pp": (float(old_actual_price) - rollback["base_price_no_liquidity"]) / transfer_value * 100,
                    "is_backfilled": True,
                }

        conn.commit()
        return {"candidates": len(candidates), "generated": generated, "updated": updated, "skipped": skipped}
    finally:
        conn.close()


def _backfill_report_prediction_baselines():
    """兼容旧日报：仅恢复日报已经保存的预测拆分，不用未来数据倒推。"""
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
            legacy_context = dict(context or {})
            legacy_context.update({"source": "legacy_snapshot", "is_historical_backfill": True})
            base_price = round(pred_price - tv * old_adjustment_pp / 100, 4)
            cursor = conn.execute(
                """UPDATE predictions SET
                      transfer_value=%s,circulation_scale=%s,base_price_no_liquidity=%s,
                      liquidity_adjustment_pp=%s,liquidity_sample_count=0,
                      valuation_model_version='legacy_snapshot_v1',valuation_context=%s::jsonb
                    WHERE type='bond' AND code=%s AND pred_price IS NOT NULL
                      AND (base_price_no_liquidity IS NULL OR valuation_model_version IS NULL)""",
                (tv, scale, base_price, old_adjustment_pp,
                 json.dumps(legacy_context, ensure_ascii=False, default=str), code),
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


def backfill_prediction_baselines():
    """先做历史回滚，再兼容恢复旧日报中的可审计基准。"""
    historical = backfill_historical_prediction_baselines()
    legacy = _backfill_report_prediction_baselines()
    return {"historical_rollback": historical, "legacy_report": legacy}


def main():
    result = backfill_liquidity()
    baselines = backfill_prediction_baselines()
    print(json.dumps({"liquidity": result, "prediction_baselines": baselines}, ensure_ascii=False))
    if result["total"] and result["saved"] + result["cached"] == 0:
        raise SystemExit("近半年流通规模全部补齐失败")


if __name__ == "__main__":
    main()
