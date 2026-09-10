#!/usr/bin/env python3
"""独立的新股历史增量同步任务。

数据源：Tushare new_share（官方口径：申购日、上市日及发行字段）。
首次无游标时回看两年；后续从成功游标向前重叠 60 天。
任何空结果、异常响应或字段结构错误都会使任务失败，且不覆盖旧数据。
"""
import argparse
import hashlib
import json
import os
import random
import sys
import time
import urllib.error
import urllib.request
from datetime import date, datetime, time as dt_time, timedelta

import psycopg2
from psycopg2.extras import Json, RealDictCursor

from _common import _load_env, _tushare
from external_call_guard import ExternalCallGuardError, guarded_urlopen, get_external_call_stats
from instrument_identity import ensure_instrument, resolve_canonical_code, resolve_provider_code

_load_env()

SCOPE_KEY = "global:ipo_history"
DATASET_CODE = "new_share"
REQUIRED_FIELDS = (
    "ipo_date", "listing_date", "issue_price", "total_shares",
    "online_shares", "online_lottery_rate", "subscribe_upper_limit",
    "fund_raised", "circulation_mv",
)
QUALITY_BASE_FIELDS = (
    "ipo_date", "issue_price", "total_shares", "online_shares",
    "online_lottery_rate", "subscribe_upper_limit", "fund_raised", "circulation_mv",
)
QUALITY_DETAIL_FIELDS = ("industry", "industry_pe", "main_business")


def _date_text(value):
    if value is None:
        return None
    text = str(value).strip()
    if len(text) == 8 and text.isdigit():
        return f"{text[:4]}-{text[4:6]}-{text[6:8]}"
    if len(text) >= 10 and text[4:5] == "-" and text[7:8] == "-":
        return text[:10]
    return None


def _positive(value):
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _market_fields(ts_code):
    code = str(ts_code or "").split(".")[0]
    if code.startswith("688"):
        return "科创板", "科创板"
    if code.startswith(("300", "301")):
        return "创业板", "创业板"
    if str(ts_code or "").endswith(".BJ") or code.startswith(("92", "82", "83", "87", "43")):
        return "北交所", "北交所"
    if str(ts_code or "").endswith(".SH"):
        return "沪市主板", "沪市主板"
    return "深市主板", "深市主板"


def normalize_share(row):
    ts_code = str(row.get("ts_code") or "").strip()
    code = ts_code.split(".")[0]
    if not code:
        raise ValueError("new_share 返回空 ts_code")
    issue_price = _positive(row.get("price"))
    total_shares = _positive(row.get("amount"))
    online_shares = _positive(row.get("market_amount"))
    fund_raised = _positive(row.get("funds"))
    if fund_raised is None and total_shares and issue_price:
        fund_raised = round(total_shares * issue_price / 10000, 2)
    circulation_mv = None
    if online_shares and issue_price:
        circulation_mv = round(online_shares * issue_price / 10000, 2)
    market_type, board_key = _market_fields(ts_code)
    listing_date = _date_text(row.get("issue_date"))
    issue_pe = _positive(row.get("pe"))
    return {
        "security_code": code,
        "security_name": str(row.get("name") or "").strip(),
        "market_code": "CN",
        "market_type": market_type,
        "board_key": board_key,
        "ipo_date": _date_text(row.get("ipo_date")),
        "listing_date": listing_date,
        "issue_price": issue_price,
        "issue_pe": issue_pe,
        "issue_pe_status": "value" if issue_pe is not None else ("loss" if listing_date and issue_price else "pending"),
        "fund_raised": fund_raised,
        "total_shares": total_shares,
        "online_shares": online_shares,
        "online_lottery_rate": _positive(row.get("ballot")),
        "subscribe_upper_limit": _positive(row.get("limit_amount")),
        "circulation_mv": circulation_mv,
        "ipo_status": "active",
        "source_payload": row,
    }


def tushare_query(api_name, params, fields, retries=2):
    return _tushare(api_name, params, fields)


def pg_connect():
    return psycopg2.connect(
        host=os.environ.get("PGHOST", "127.0.0.1"),
        port=int(os.environ.get("PGPORT", "5432")),
        user=os.environ.get("PGUSER", "postgres"),
        password=os.environ.get("PGPASSWORD", "postgres"),
        dbname=os.environ.get("PGDATABASE", "portfolio"),
        connect_timeout=10,
    )


def sync_window(cur, today):
    cur.execute(
        "SELECT last_success_date FROM ops.sync_cursors WHERE scope_key=%s AND dataset_code=%s",
        (SCOPE_KEY, DATASET_CODE),
    )
    row = cur.fetchone()
    if row and row[0]:
        return row[0] - timedelta(days=60), today + timedelta(days=90), False
    return today - timedelta(days=730), today + timedelta(days=90), True


def upsert_shares(cur, records, as_of=None):
    codes = [row["security_code"] for row in records]
    cur.execute("SELECT security_code FROM ipo_history WHERE security_code = ANY(%s)", (codes,))
    existing = {row[0] for row in cur.fetchall()}
    for record in records:
        as_of_text = as_of.isoformat() if hasattr(as_of, "isoformat") else date.today().isoformat()
        listing_text = str(record.get("listing_date") or "")[:10]
        record["ipo_status"] = "listed" if listing_text and listing_text <= as_of_text else "active"
        canonical = resolve_canonical_code(record["security_code"], "stock", cur.connection)
        if not canonical:
            raise ValueError(f"无法为 IPO 记录解析统一证券身份：{record['security_code']}")
        exchange = "SH" if canonical.endswith(".SH") else ("BJ" if canonical.endswith(".BJ") else "SZ")
        master = ensure_instrument(
            canonical,
            name=record.get("security_name") or canonical,
            asset_class="stock",
            market="CN",
            exchange_code=exchange,
            currency_code="CNY",
            list_date=record.get("listing_date"),
            status=record.get("ipo_status") or "active",
            raw_data={"ipo_history": True, "source_payload": record.get("source_payload") or {}},
            company_name=record.get("security_name") or canonical,
            conn=cur.connection,
        )
        record["instrument_id"] = master["instrument_id"]
    sql = """
        INSERT INTO ipo_history AS old (
          security_code,security_name,market_code,market_type,listing_date,board_key,updated_at,
          issue_price,issue_pe,fund_raised,total_shares,online_shares,online_lottery_rate,
          subscribe_upper_limit,circulation_mv,ipo_date,issue_pe_status,source_payload,
          instrument_id,ipo_status,ipo_status_at
        ) VALUES (
          %(security_code)s,%(security_name)s,%(market_code)s,%(market_type)s,%(listing_date)s,%(board_key)s,
          to_char(now(),'YYYY-MM-DD HH24:MI:SS'),%(issue_price)s,%(issue_pe)s,%(fund_raised)s,
          %(total_shares)s,%(online_shares)s,%(online_lottery_rate)s,%(subscribe_upper_limit)s,
          %(circulation_mv)s,%(ipo_date)s,%(issue_pe_status)s,%(source_payload)s,
          %(instrument_id)s,%(ipo_status)s,now()
        )
        ON CONFLICT (security_code) DO UPDATE SET
          security_name=COALESCE(NULLIF(EXCLUDED.security_name,''),old.security_name),
          market_code=COALESCE(NULLIF(EXCLUDED.market_code,''),old.market_code),
          market_type=COALESCE(NULLIF(EXCLUDED.market_type,''),old.market_type),
          listing_date=COALESCE(EXCLUDED.listing_date,old.listing_date),
          board_key=COALESCE(NULLIF(EXCLUDED.board_key,''),old.board_key),
          issue_price=COALESCE(EXCLUDED.issue_price,old.issue_price),
          issue_pe=COALESCE(EXCLUDED.issue_pe,old.issue_pe),
          fund_raised=COALESCE(EXCLUDED.fund_raised,old.fund_raised),
          total_shares=COALESCE(EXCLUDED.total_shares,old.total_shares),
          online_shares=COALESCE(EXCLUDED.online_shares,old.online_shares),
          online_lottery_rate=COALESCE(EXCLUDED.online_lottery_rate,old.online_lottery_rate),
          subscribe_upper_limit=COALESCE(EXCLUDED.subscribe_upper_limit,old.subscribe_upper_limit),
          circulation_mv=COALESCE(EXCLUDED.circulation_mv,old.circulation_mv),
          ipo_date=COALESCE(EXCLUDED.ipo_date,old.ipo_date),
          issue_pe_status=CASE WHEN EXCLUDED.issue_pe_status<>'pending' THEN EXCLUDED.issue_pe_status ELSE old.issue_pe_status END,
          instrument_id=COALESCE(EXCLUDED.instrument_id,old.instrument_id),
          ipo_status=CASE WHEN old.ipo_status='listed' OR EXCLUDED.ipo_status='listed' THEN 'listed'
                          ELSE COALESCE(NULLIF(EXCLUDED.ipo_status,''),old.ipo_status) END,
          ipo_status_at=now(),
          source_payload=COALESCE(old.source_payload,'{}'::jsonb) || EXCLUDED.source_payload,
          updated_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS')
    """
    for record in records:
        params = dict(record)
        params["source_payload"] = Json(record["source_payload"])
        cur.execute(sql, params)
    return len([code for code in codes if code not in existing]), len([code for code in codes if code in existing])


def _tencent_first_close(code, listing_date):
    qt_code = resolve_provider_code(code, "tencent", "quote_symbol", asset_class="stock")
    if not qt_code:
        return None
    url = f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={qt_code},day,,,30,qfq"
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with guarded_urlopen(request, timeout=12, source="tencent", dataset=f"history-kline:{qt_code}:{listing_date}") as response:
        payload = json.loads(response.read().decode("utf-8"))
    data = payload.get("data", {})
    days = (data.get(qt_code, {}).get("day") or
            data.get(qt_code.replace("sh", "sz"), {}).get("day") or
            data.get(qt_code.replace("sz", "sh"), {}).get("day") or [])
    for item in days:
        if len(item) >= 3 and item[0] == listing_date:
            return _positive(item[2])
    return None


def backfill_first_day(cur, now):
    today = now.date()
    cur.execute("""
      SELECT security_code,listing_date,issue_price,first_day_retry_count,first_day_last_attempt_at
        FROM ipo_history
       WHERE market_code='CN' AND listing_date <= %s AND ld_close_change IS NULL
         AND issue_price IS NOT NULL
       ORDER BY listing_date DESC,security_code
    """, (today.isoformat(),))
    updated = attempted = failed = 0
    stopped = None
    for row in cur.fetchall():
        code, listing_text, issue_price, _, last_attempt = row
        try:
            listing = datetime.strptime(str(listing_text)[:10], "%Y-%m-%d").date()
        except (TypeError, ValueError):
            continue
        if listing == today and now.time() < dt_time(15, 30):
            continue
        if last_attempt and last_attempt.date() == today:
            continue
        attempted += 1
        try:
            close = _tencent_first_close(code, listing.isoformat())
        except ExternalCallGuardError as exc:
            stopped = {"code": exc.code, "recover_at": exc.recover_at}
            attempted -= 1
            break
        except Exception:
            close = None
        if close and float(issue_price) > 0:
            change = round((close - float(issue_price)) / float(issue_price) * 100, 2)
            cur.execute("""
              UPDATE ipo_history SET ld_close_change=%s,first_day_last_attempt_at=now(),
                updated_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS') WHERE security_code=%s
            """, (change, code))
            updated += 1
        else:
            cur.execute("""
              UPDATE ipo_history SET first_day_retry_count=COALESCE(first_day_retry_count,0)+1,
                first_day_last_attempt_at=now() WHERE security_code=%s
            """, (code,))
            failed += 1
    return {"attempted": attempted, "updated": updated, "pending": failed, "stopped": stopped}


def normalize_stored_details(cur, today, target_date=None):
    """用已入库的主营文本恢复行业，并重算结构化赛道暴露；不访问外部接口。"""
    from ipo_lib_fetch import _split_embedded_industry
    from ipo_lib_sector import analyze_business_exposure

    clauses = [
        "market_code='CN'",
        "(NULLIF(main_business,'') IS NOT NULL OR NULLIF(industry,'') IS NOT NULL)",
        "(main_business LIKE '%%所属行业%%' OR NULLIF(industry,'') IS NULL OR business_exposure IS NULL OR business_exposure='{}'::jsonb)",
    ]
    params = []
    if target_date:
        clauses.append("(ipo_date=%s OR listing_date=%s)")
        params.extend([target_date.isoformat(), target_date.isoformat()])
    cur.execute(
        """SELECT security_code,security_name,main_business,industry,business_exposure
             FROM ipo_history WHERE """ + " AND ".join(clauses), params,
    )
    updated = 0
    for code, name, main_business, industry, stored_exposure in cur.fetchall():
        business, embedded_industry = _split_embedded_industry(main_business)
        normalized_industry = str(industry or '').strip() or embedded_industry
        exposure = analyze_business_exposure(name or '', business, normalized_industry, stored=stored_exposure)
        old_exposure = stored_exposure if isinstance(stored_exposure, dict) else {}
        changed = (
            business != str(main_business or '').strip()
            or normalized_industry != str(industry or '').strip()
            or exposure != old_exposure
        )
        if not changed:
            continue
        cur.execute(
            """UPDATE ipo_history SET
                    main_business=COALESCE(NULLIF(%s,''),main_business),
                    industry=COALESCE(NULLIF(%s,''),industry),
                    business_exposure=COALESCE(%s::jsonb,business_exposure),
                    source_payload=COALESCE(source_payload,'{}'::jsonb)
                      || jsonb_build_object('profile_normalization',%s::jsonb),
                    updated_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS')
                WHERE security_code=%s""",
            (business, normalized_industry, Json(exposure), Json({
                "normalized_on": today.isoformat(),
                "industry": normalized_industry,
                "business_exposure": exposure,
            }), code),
        )
        updated += 1
    return {"updated": updated}


def enrich_stock_missing_details(cur, today, target_date=None, retry_same_day=False, priority_codes=None):
    """不限业务条数补全资料；当前发行优先，历史缺口按 Guard 边界续跑。"""
    today_text = today.isoformat()
    target_text = str(target_date)[:10] if target_date else ""
    priority_codes = sorted({str(code or '').split('.')[0] for code in (priority_codes or []) if code})
    mandatory_gap = """(NULLIF(industry,'') IS NULL OR NULLIF(main_business,'') IS NULL
              OR business_exposure IS NULL OR business_exposure = '{}'::jsonb
              OR NOT (business_exposure ? 'exposures'))"""
    cur.execute("""
      SELECT security_code,COALESCE(data_quality_status,'{}'::jsonb),industry,
             main_business,industry_pe,business_exposure
        FROM ipo_history
       WHERE market_code='CN' AND ipo_date ~ '^\\d{4}-\\d{2}-\\d{2}$'
         AND (""" + mandatory_gap + """ OR (
              industry_pe IS NULL
              AND COALESCE(data_quality_status->'field_states'->'industry_pe'->>'retry_after','') <= %s
         ))
         AND (COALESCE(data_quality_status->'enrichment'->>'attempted_on','') <> %s
              OR (%s::boolean AND security_code=ANY(%s::text[])))
       ORDER BY CASE WHEN security_code=ANY(%s::text[]) THEN 0
                     WHEN ipo_status='active' THEN 1 ELSE 2 END,
                CASE WHEN """ + mandatory_gap + """ THEN 0 ELSE 1 END,
                CASE WHEN ipo_date=%s OR listing_date=%s THEN 0
                     WHEN ipo_date>%s OR listing_date>%s THEN 1 ELSE 2 END,
                CASE WHEN ipo_date >= %s THEN ipo_date END ASC NULLS LAST,
                CASE WHEN listing_date >= %s THEN listing_date END ASC NULLS LAST,
                ipo_date DESC,security_code
    """, (today_text, today_text, retry_same_day, priority_codes,
          priority_codes,
          target_text, target_text, target_text, target_text,
          target_text, target_text))
    candidates = cur.fetchall()
    if not candidates:
        return {"attempted": 0, "updated": 0, "failed": 0, "remaining": 0,
                "remaining_by_field": {}, "stopped": None}

    from ipo_lib_fetch import fetch_stock_historical_detail

    attempted = updated = failed = 0
    stopped = None
    for code, prior_status, existing_industry, existing_business, existing_industry_pe, existing_exposure in candidates:
        attempted += 1
        meta = {"attempted_on": today_text, "source": "stock_basic/cninfo/valuation"}
        try:
            detail = fetch_stock_historical_detail(code, existing_industry) or {}
            business_exposure = detail.get("business_exposure")
            resolved_industry = str(existing_industry or detail.get("industry") or '').strip()
            resolved_business = max(
                (str(existing_business or '').strip(), str(detail.get("main_business") or '').strip()),
                key=len,
            )
            resolved_industry_pe = existing_industry_pe if existing_industry_pe is not None else detail.get("industry_pe")
            resolved_exposure = business_exposure if (
                isinstance(business_exposure, dict) and business_exposure.get("exposures")
            ) else existing_exposure
            changed = (
                resolved_industry != str(existing_industry or '').strip()
                or resolved_business != str(existing_business or '').strip()
                or resolved_industry_pe != existing_industry_pe
                or resolved_exposure != existing_exposure
            )
            if changed:
                cur.execute("""
                  UPDATE ipo_history SET
                    industry=COALESCE(NULLIF(industry,''),NULLIF(%s,'')),
                    industry_pe=COALESCE(industry_pe,%s),
                    main_business=CASE
                      WHEN length(COALESCE(%s,'')) > length(COALESCE(main_business,'')) THEN %s
                      ELSE main_business END,
                    business_exposure=COALESCE(NULLIF(%s::jsonb,'{}'::jsonb),business_exposure),
                    source_payload=COALESCE(source_payload,'{}'::jsonb) || jsonb_build_object('historical_enrichment',%s::jsonb),
                    updated_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS')
                   WHERE security_code=%s
                """, (detail.get("industry"), detail.get("industry_pe"), detail.get("main_business"), detail.get("main_business"),
                      Json(business_exposure) if business_exposure else None, Json(detail), code))
                updated += 1
                meta["updated_fields"] = [field for field in QUALITY_DETAIL_FIELDS if detail.get(field) not in (None, "")]
                if isinstance(business_exposure, dict) and business_exposure.get("exposures"):
                    meta["updated_fields"].append("business_exposure")
            else:
                meta["result"] = "no_new_value"
            field_states = {
                "industry": {"status": "value" if resolved_industry else "retryable"},
                "main_business": {"status": "value" if resolved_business else "retryable"},
                "business_exposure": {"status": "value" if isinstance(resolved_exposure, dict) and resolved_exposure.get("exposures") else "retryable"},
                "industry_pe": {"status": "value" if resolved_industry_pe is not None else "source_unavailable"},
            }
            if resolved_industry_pe is None:
                field_states["industry_pe"].update({
                    "reason": "insufficient_or_unmatched_industry_sample",
                    "retry_after": (today + timedelta(days=7)).isoformat(),
                })
        except ExternalCallGuardError as exc:
            stopped = {"code": exc.code, "recover_at": exc.recover_at}
            attempted -= 1
            break
        except Exception as exc:
            failed += 1
            meta["error"] = str(exc)[:300]
            field_states = (prior_status or {}).get("field_states", {})
        cur.execute("""
          UPDATE ipo_history
             SET data_quality_status=COALESCE(data_quality_status,'{}'::jsonb)
               || jsonb_build_object('enrichment',%s::jsonb,'field_states',%s::jsonb)
           WHERE security_code=%s
        """, (Json(meta), Json(field_states), code))

    cur.execute("""
      SELECT
        count(*) FILTER (WHERE NULLIF(industry,'') IS NULL),
        count(*) FILTER (WHERE industry_pe IS NULL),
        count(*) FILTER (WHERE NULLIF(main_business,'') IS NULL),
        count(*) FILTER (WHERE business_exposure IS NULL OR business_exposure='{}'::jsonb
                          OR NOT (business_exposure ? 'exposures'))
      FROM ipo_history
       WHERE market_code='CN' AND ipo_date ~ '^\\d{4}-\\d{2}-\\d{2}$'
    """)
    counts = cur.fetchone()
    remaining_by_field = dict(zip(("industry", "industry_pe", "main_business", "business_exposure"),
                                  (int(value or 0) for value in counts)))
    remaining = sum(remaining_by_field.values())
    return {"attempted": attempted, "updated": updated, "failed": failed, "remaining": remaining,
            "remaining_by_field": remaining_by_field, "stopped": stopped}


def update_quality(cur, today):
    cur.execute("""
      SELECT security_code,ipo_date,listing_date,issue_price,total_shares,online_shares,
             online_lottery_rate,oversubscribe_multiple,subscribe_upper_limit,fund_raised,circulation_mv,
             issue_pe,issue_pe_status,industry,industry_pe,main_business,business_exposure,ld_close_change,
             COALESCE(data_quality_status,'{}'::jsonb)
        FROM ipo_history
       WHERE market_code='CN' AND ipo_date ~ '^\\d{4}-\\d{2}-\\d{2}$'
    """)
    missing_records = 0
    missing_fields = 0
    for row in cur.fetchall():
        values = dict(zip(("security_code", "ipo_date", "listing_date", "issue_price", "total_shares",
                           "online_shares", "online_lottery_rate", "oversubscribe_multiple",
                           "subscribe_upper_limit", "fund_raised",
                           "circulation_mv", "issue_pe", "issue_pe_status", "industry", "industry_pe",
                           "main_business", "business_exposure", "ld_close_change", "prior_status"), row))
        missing = [field for field in QUALITY_BASE_FIELDS if values.get(field) in (None, "")]
        if values.get("issue_pe") in (None, "") and values.get("issue_pe_status") != "loss":
            missing.append("issue_pe")
        prior = values.get("prior_status") if isinstance(values.get("prior_status"), dict) else {}
        prior_field_states = prior.get("field_states") if isinstance(prior.get("field_states"), dict) else {}
        for field in QUALITY_DETAIL_FIELDS:
            prior_state = prior_field_states.get(field) if isinstance(prior_field_states.get(field), dict) else {}
            if values.get(field) in (None, "") and prior_state.get("status") != "source_unavailable":
                missing.append(field)
        exposure = values.get("business_exposure")
        if not isinstance(exposure, dict) or not exposure.get("exposures"):
            missing.append("business_exposure")
        listing_text = str(values.get("listing_date") or "")[:10]
        valid_listing = (
            len(listing_text) == 10 and listing_text[4] == "-" and listing_text[7] == "-"
            and listing_text.replace("-", "").isdigit()
        )
        listed = valid_listing and listing_text <= today.isoformat()
        pending = []
        if not listed:
            if values.get("listing_date") in (None, ""):
                pending.append("listing_date")
            for field in ("online_lottery_rate", "oversubscribe_multiple"):
                if values.get(field) in (None, ""):
                    pending.append(field)
            missing = [field for field in missing if field not in pending]
        elif values.get("ld_close_change") in (None, ""):
            missing.append("ld_close_change")
        field_states = dict(prior_field_states)
        for field in QUALITY_DETAIL_FIELDS:
            if values.get(field) not in (None, ""):
                field_states[field] = {"status": "value"}
            elif field not in field_states:
                field_states[field] = {"status": "retryable"}
        field_states["business_exposure"] = {
            "status": "value" if isinstance(exposure, dict) and exposure.get("exposures") else "retryable"
        }
        status = {
            "status": "missing" if missing else "complete",
            "missing_fields": missing,
            "pending_not_due": pending,
            "stage": "listed" if listed else "subscribed",
            "checked_at": datetime.now().isoformat(timespec="seconds"),
            "field_states": field_states,
        }
        if prior.get("enrichment"):
            status["enrichment"] = prior["enrichment"]
        cur.execute("UPDATE ipo_history SET data_quality_status=%s WHERE security_code=%s",
                    (Json(status), values["security_code"]))
        if missing:
            missing_records += 1
            missing_fields += len(missing)
    return {"missing_records": missing_records, "missing_fields": missing_fields}


def mark_cursor(cur, today, error=None):
    if error:
        cur.execute("""
          INSERT INTO ops.sync_cursors(scope_key,dataset_code,last_attempt_at,last_error,retry_count,updated_at)
          VALUES(%s,%s,now(),%s,1,now())
          ON CONFLICT(scope_key,dataset_code) DO UPDATE SET last_attempt_at=now(),last_error=EXCLUDED.last_error,
            retry_count=ops.sync_cursors.retry_count+1,updated_at=now()
        """, (SCOPE_KEY, DATASET_CODE, str(error)[:500]))
    else:
        cur.execute("""
          INSERT INTO ops.sync_cursors(scope_key,dataset_code,last_success_date,last_source_update,last_attempt_at,last_error,retry_count,updated_at)
          VALUES(%s,%s,%s,now(),now(),'',0,now())
          ON CONFLICT(scope_key,dataset_code) DO UPDATE SET last_success_date=EXCLUDED.last_success_date,
            last_source_update=now(),last_attempt_at=now(),last_error='',retry_count=0,updated_at=now()
        """, (SCOPE_KEY, DATASET_CODE, today))


def start_ingestion_run(cur, start, end, today):
    cur.execute("SELECT source_id FROM ops.data_sources WHERE source_code='tushare' LIMIT 1")
    source = cur.fetchone()
    if not source:
        raise RuntimeError("缺少 tushare 数据源登记")
    cur.execute(
        """INSERT INTO ops.ingestion_runs(source_id,dataset_code,request_range,status)
           VALUES(%s,%s,%s,'running') RETURNING run_id""",
        (source[0], DATASET_CODE, Json({
            "business_date": today.isoformat(),
            "start_date": start.isoformat(),
            "end_date": end.isoformat(),
        })),
    )
    return int(cur.fetchone()[0])


def finish_ingestion_run(cur, run_id, status, row_count=0, error=""):
    cur.execute(
        """UPDATE ops.ingestion_runs
              SET status=%s,row_count=%s,error_message=%s,finished_at=now()
            WHERE run_id=%s""",
        (status, int(row_count or 0), str(error or "")[:500], run_id),
    )


def next_trade_date(cur, today):
    cur.execute(
        """SELECT trade_date::text FROM market.trade_calendar
            WHERE exchange='SSE' AND is_open=true AND trade_date>%s::date
            ORDER BY trade_date LIMIT 1""",
        (today.isoformat(),),
    )
    row = cur.fetchone()
    if not row:
        raise RuntimeError(f"trade_calendar 没有 {today.isoformat()} 之后的已入库交易日，拒绝发布 IPO 事实分区")
    return str(row[0])[:10]


def _set_hash(codes):
    normalized = sorted({str(code or "").split(".")[0] for code in codes if code})
    return hashlib.sha256("\n".join(normalized).encode("utf-8")).hexdigest(), normalized


def publication_quality(cur, records, today, run_id):
    target_date = next_trade_date(cur, today)
    source_apply = {row["security_code"] for row in records if row.get("ipo_date") == target_date}
    source_listing = {row["security_code"] for row in records if row.get("listing_date") == target_date}
    cur.execute(
        """SELECT security_code,security_name,ipo_date,listing_date,industry,main_business,business_exposure
             FROM ipo_history
            WHERE market_code='CN' AND (ipo_date=%s OR listing_date=%s)""",
        (target_date, target_date),
    )
    db_rows = cur.fetchall()
    db_apply = {row[0] for row in db_rows if row[2] == target_date}
    db_listing = {row[0] for row in db_rows if row[3] == target_date}
    missing_identity = sorted({row[0] for row in db_rows if not row[0] or not str(row[1] or "").strip()})
    missing_issuance_detail = sorted(
        row[0] for row in db_rows
        if row[2] == target_date and (
            not str(row[4] or '').strip()
            or not str(row[5] or '').strip()
            or not isinstance(row[6], dict)
            or not row[6].get('exposures')
        )
    )
    source_with_listing = {row["security_code"] for row in records if row.get("listing_date")}
    if source_with_listing:
        cur.execute(
            """SELECT security_code FROM ipo_history
                WHERE market_code='CN' AND security_code=ANY(%s) AND (listing_date IS NULL OR listing_date='')""",
            (list(source_with_listing),),
        )
        unpersisted_listing = sorted(row[0] for row in cur.fetchall())
    else:
        unpersisted_listing = []
    cur.execute(
        """SELECT COUNT(*) FROM ipo_history
            WHERE market_code='CN' AND ipo_date ~ '^\\d{4}-\\d{2}-\\d{2}$'
              AND ipo_date<=%s AND (listing_date IS NULL OR listing_date='')""",
        (today.isoformat(),),
    )
    missing_listing_date_count = int(cur.fetchone()[0] or 0)
    all_codes = source_apply | source_listing | db_apply | db_listing
    security_set_hash, security_codes = _set_hash(all_codes)
    errors = []
    if source_apply != db_apply:
        errors.append(f"申购集合不一致 source={sorted(source_apply)} db={sorted(db_apply)}")
    if source_listing != db_listing:
        errors.append(f"上市集合不一致 source={sorted(source_listing)} db={sorted(db_listing)}")
    if unpersisted_listing:
        errors.append(f"上游已有上市日但事实表仍为空：{unpersisted_listing}")
    if missing_identity:
        errors.append(f"目标日证券缺代码或名称：{missing_identity}")
    if missing_issuance_detail:
        errors.append(f"目标日新股发行资料未补全（行业/主营业务/业务赛道）：{missing_issuance_detail}")
    if errors:
        raise RuntimeError("IPO事实质量门禁失败：" + "；".join(errors))
    return {
        "quality_status": "passed",
        "target_date": target_date,
        "apply_security_count": len(db_apply),
        "listing_security_count": len(db_listing),
        "security_count": len(db_apply | db_listing),
        "security_codes": security_codes,
        "security_set_hash": security_set_hash,
        "ingestion_run_id": run_id,
        "missing_listing_date_count": missing_listing_date_count,
        "source_missing_listing_date_count": sum(1 for row in records if row.get("ipo_date") and not row.get("listing_date")),
        "unpersisted_listing_date_count": len(unpersisted_listing),
    }


def _refresh_new_share_snapshot(cur, today):
    """晚间先刷新一次 new_share，覆盖 Tushare 19 点后的发行公告变更。"""
    start, end, _ = sync_window(cur, today)
    fields = "ts_code,sub_code,name,ipo_date,issue_date,amount,market_amount,price,pe,limit_amount,funds,ballot"
    raw_rows = tushare_query(
        "new_share",
        {"start_date": start.strftime("%Y%m%d"), "end_date": end.strftime("%Y%m%d")},
        fields,
    )
    if not raw_rows:
        return {"fetched": 0, "inserted": 0, "refreshed": 0, "verified_empty": True}
    records = [normalize_share(row) for row in raw_rows]
    codes = [row["security_code"] for row in records]
    if len(codes) != len(set(codes)):
        raise RuntimeError("晚间 new_share 返回重复证券代码")
    inserted, refreshed = upsert_shares(cur, records, today)
    mark_cursor(cur, today)
    current_codes = [row["security_code"] for row in records if row.get("ipo_status") != "listed"]
    return {
        "fetched": len(records), "inserted": inserted, "refreshed": refreshed,
        "window_start": start.isoformat(), "window_end": end.isoformat(),
        "current_security_codes": current_codes,
    }


def run(today=None, mode="core"):
    today = today or date.today()
    connection = pg_connect()
    run_id = None
    try:
        if mode == "enrichment":
            with connection.cursor() as cur:
                refreshed_snapshot = _refresh_new_share_snapshot(cur, today)
                normalized = normalize_stored_details(cur, today)
                # 当前发行资料先于首日表现和历史欠账，避免共享请求保护被低优先级任务占用。
                enrichment = enrich_stock_missing_details(
                    cur, today, target_date=next_trade_date(cur, today), retry_same_day=True,
                    priority_codes=refreshed_snapshot.get("current_security_codes", []),
                )
                first_day = backfill_first_day(cur, datetime.now())
                quality = update_quality(cur, today)
            connection.commit()
            return {
                "ok": True, "mode": "enrichment", "dataAsOf": today.isoformat(),
                "refreshed_snapshot": refreshed_snapshot,
                "normalization": normalized,
                "first_day": first_day, "enrichment": enrichment, "quality": quality,
                "publishDatasets": False,
            }
        with connection.cursor() as cur:
            start, end, bootstrap = sync_window(cur, today)
            run_id = start_ingestion_run(cur, start, end, today)
        connection.commit()
        fields = "ts_code,sub_code,name,ipo_date,issue_date,amount,market_amount,price,pe,limit_amount,funds,ballot"
        raw_rows = tushare_query(
            "new_share",
            {"start_date": start.strftime("%Y%m%d"), "end_date": end.strftime("%Y%m%d")},
            fields,
        )
        if not raw_rows:
            raise RuntimeError(f"Tushare new_share 在 {start}~{end} 返回空结果，已拒绝推进水位")
        records = [normalize_share(row) for row in raw_rows]
        codes = [row["security_code"] for row in records]
        if len(codes) != len(set(codes)):
            raise RuntimeError("Tushare new_share 返回重复证券代码")
        with connection.cursor() as cur:
            inserted, refreshed = upsert_shares(cur, records, today)
            normalization = normalize_stored_details(cur, today)
            issuance_enrichment = enrich_stock_missing_details(
                cur, today, target_date=next_trade_date(cur, today),
                priority_codes=[row["security_code"] for row in records if row.get("ipo_status") != "listed"],
            )
            quality = update_quality(cur, today)
            dataset_diagnostics = publication_quality(cur, records, today, run_id)
            mark_cursor(cur, today)
            finish_ingestion_run(cur, run_id, "success", len(records))
        connection.commit()
        return {
            "ok": True, "mode": "core", "source": "tushare.new_share", "bootstrap": bootstrap,
            "window_start": start.isoformat(), "window_end": end.isoformat(),
            "fetched": len(records), "inserted": inserted, "refreshed": refreshed,
            "normalization": normalization,
            "issuance_enrichment": issuance_enrichment,
            "completed_fields": max(0, refreshed + inserted - quality["missing_records"]),
            "quality": quality, "calendar_diff": 0, "dataAsOf": today.isoformat(),
            "datasetDiagnostics": {"ipo_history": dataset_diagnostics},
        }
    except Exception as exc:
        connection.rollback()
        try:
            with connection.cursor() as cur:
                if mode == "core":
                    mark_cursor(cur, today, exc)
                    if run_id is not None:
                        finish_ingestion_run(cur, run_id, "failed", 0, exc)
            connection.commit()
        except Exception:
            connection.rollback()
        raise
    finally:
        connection.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--today", help="测试用业务日期 YYYY-MM-DD")
    parser.add_argument("--mode", choices=("core", "enrichment"), default="core")
    args = parser.parse_args()
    today = datetime.strptime(args.today, "%Y-%m-%d").date() if args.today else None
    try:
        result = run(today, args.mode)
        result.update({"externalCalls": get_external_call_stats()["total"], "externalSources": get_external_call_stats()["sources"]})
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    except Exception as exc:
        recover_at = getattr(exc, "recover_at", None)
        if hasattr(recover_at, "isoformat"):
            recover_at = recover_at.isoformat()
        print(json.dumps({
            "ok": False,
            "error": str(exc),
            "errorCode": getattr(exc, "code", None),
            "errorType": getattr(exc, "error_type", None),
            "source": getattr(exc, "source", None),
            "dataset": getattr(exc, "dataset", None),
            "apiName": getattr(exc, "api_name", None),
            "recoverAt": recover_at,
            "externalCalls": get_external_call_stats()["total"],
            "externalSources": get_external_call_stats()["sources"],
        }, ensure_ascii=False, separators=(",", ":")), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
