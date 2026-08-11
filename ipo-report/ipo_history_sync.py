#!/usr/bin/env python3
"""独立的新股历史增量同步任务。

数据源：Tushare new_share（官方口径：申购日、上市日及发行字段）。
首次无游标时回看两年；后续从成功游标向前重叠 60 天。
任何空结果、异常响应或字段结构错误都会使任务失败，且不覆盖旧数据。
"""
import argparse
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

_load_env()

SCOPE_KEY = "global:ipo_history"
DATASET_CODE = "new_share"
REQUIRED_FIELDS = (
    "ipo_date", "listing_date", "issue_price", "total_shares",
    "online_shares", "online_lottery_rate", "subscribe_upper_limit",
    "fund_raised", "circulation_mv",
)


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


def upsert_shares(cur, records):
    codes = [row["security_code"] for row in records]
    cur.execute("SELECT security_code FROM ipo_history WHERE security_code = ANY(%s)", (codes,))
    existing = {row[0] for row in cur.fetchall()}
    sql = """
        INSERT INTO ipo_history AS old (
          security_code,security_name,market_type,listing_date,board_key,updated_at,
          issue_price,issue_pe,fund_raised,total_shares,online_shares,online_lottery_rate,
          subscribe_upper_limit,circulation_mv,ipo_date,issue_pe_status,source_payload
        ) VALUES (
          %(security_code)s,%(security_name)s,%(market_type)s,%(listing_date)s,%(board_key)s,
          to_char(now(),'YYYY-MM-DD HH24:MI:SS'),%(issue_price)s,%(issue_pe)s,%(fund_raised)s,
          %(total_shares)s,%(online_shares)s,%(online_lottery_rate)s,%(subscribe_upper_limit)s,
          %(circulation_mv)s,%(ipo_date)s,%(issue_pe_status)s,%(source_payload)s
        )
        ON CONFLICT (security_code) DO UPDATE SET
          security_name=COALESCE(NULLIF(EXCLUDED.security_name,''),old.security_name),
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
          source_payload=COALESCE(old.source_payload,'{}'::jsonb) || EXCLUDED.source_payload,
          updated_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS')
    """
    for record in records:
        params = dict(record)
        params["source_payload"] = Json(record["source_payload"])
        cur.execute(sql, params)
    return len([code for code in codes if code not in existing]), len([code for code in codes if code in existing])


def _tencent_first_close(code, listing_date):
    prefix = "sh" if str(code).startswith("6") else "sz"
    qt_code = prefix + str(code)
    url = f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={qt_code},day,,,30,qfq"
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=12) as response:
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
    cutoff = today - timedelta(days=14)
    cur.execute("""
      SELECT security_code,listing_date,issue_price,first_day_retry_count,first_day_last_attempt_at
        FROM ipo_history
       WHERE listing_date >= %s AND listing_date <= %s AND ld_close_change IS NULL
         AND issue_price IS NOT NULL AND COALESCE(first_day_retry_count,0) < 3
    """, (cutoff.isoformat(), today.isoformat()))
    updated = attempted = failed = 0
    for row in cur.fetchall():
        code, listing_text, issue_price, _, last_attempt = row
        listing = datetime.strptime(listing_text[:10], "%Y-%m-%d").date()
        if listing == today and now.time() < dt_time(15, 30):
            continue
        if last_attempt and last_attempt.date() == today:
            continue
        attempted += 1
        try:
            close = _tencent_first_close(code, listing.isoformat())
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
    return {"attempted": attempted, "updated": updated, "pending": failed}


def update_quality(cur, today):
    cur.execute("""
      SELECT security_code,ipo_date,listing_date,issue_price,total_shares,online_shares,
             online_lottery_rate,subscribe_upper_limit,fund_raised,circulation_mv
        FROM ipo_history
       WHERE listing_date IS NOT NULL AND listing_date<>'' AND listing_date::date <= %s
         AND listing_date::date >= %s
    """, (today, today - timedelta(days=730)))
    missing_records = 0
    missing_fields = 0
    for row in cur.fetchall():
        values = dict(zip(("security_code",) + REQUIRED_FIELDS, row))
        missing = [field for field in REQUIRED_FIELDS if values.get(field) in (None, "")]
        status = {
            "status": "missing" if missing else "complete",
            "missing_fields": missing,
            "checked_at": datetime.now().isoformat(timespec="seconds"),
        }
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


def run(today=None):
    today = today or date.today()
    connection = pg_connect()
    try:
        with connection.cursor() as cur:
            start, end, bootstrap = sync_window(cur, today)
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
            inserted, refreshed = upsert_shares(cur, records)
            first_day = backfill_first_day(cur, datetime.now())
            quality = update_quality(cur, today)
            listed_source = {row["security_code"] for row in records if row["listing_date"] and row["listing_date"] <= today.isoformat()}
            cur.execute("SELECT security_code FROM ipo_history WHERE security_code = ANY(%s)", (list(listed_source),))
            listed_db = {row[0] for row in cur.fetchall()}
            calendar_diff = len(listed_source - listed_db)
            if calendar_diff:
                raise RuntimeError(f"日历与历史表仍相差 {calendar_diff} 只")
            mark_cursor(cur, today)
        connection.commit()
        return {
            "ok": True, "source": "tushare.new_share", "bootstrap": bootstrap,
            "window_start": start.isoformat(), "window_end": end.isoformat(),
            "fetched": len(records), "inserted": inserted, "refreshed": refreshed,
            "completed_fields": max(0, refreshed + inserted - quality["missing_records"]),
            "first_day": first_day, "quality": quality, "calendar_diff": calendar_diff,
        }
    except Exception as exc:
        connection.rollback()
        try:
            with connection.cursor() as cur:
                mark_cursor(cur, today, exc)
            connection.commit()
        except Exception:
            connection.rollback()
        raise
    finally:
        connection.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--today", help="测试用业务日期 YYYY-MM-DD")
    args = parser.parse_args()
    today = datetime.strptime(args.today, "%Y-%m-%d").date() if args.today else None
    try:
        print(json.dumps(run(today), ensure_ascii=False, separators=(",", ":")))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False, separators=(",", ":")), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
