"""打新与可转债标准数据层。

所有可转债发行、生命周期事件和上市表现均通过这里访问 PostgreSQL；
    不提供历史兼容表读写。
"""
import hashlib
import json
import math
from datetime import datetime

import db_pg


def _num(value):
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _issue_size_100m(value):
    number = _num(value)
    if number is None:
        return None
    return number / 100000000 if number >= 10000 else number


def _date(value):
    text = str(value or "").replace("-", "")[:8]
    return f"{text[:4]}-{text[4:6]}-{text[6:8]}" if len(text) == 8 and text.isdigit() else None


def _ts_code(code):
    text = str(code or "").strip().upper()
    if "." not in text:
        text = text.zfill(6) + (".SZ" if text.startswith("12") else ".SH")
    return text


def _stock_code(code):
    text = str(code or "").strip().upper()
    if not text:
        return None
    if "." in text:
        return text
    return text.zfill(6) + (".SZ" if text.startswith(("0", "3")) else ".SH")


def _raw_key(ts_code, row):
    version = json.dumps(row, ensure_ascii=False, sort_keys=True, default=str)
    return f"tushare:cb_issue:{ts_code}:{hashlib.sha256(version.encode('utf-8')).hexdigest()}"


def _source_id(cur):
    cur.execute("SELECT source_id FROM ops.data_sources WHERE source_code='tushare' LIMIT 1")
    row = cur.fetchone()
    if not row:
        raise RuntimeError("缺少 tushare 数据源")
    return row[0]


def save_cb_issue_rows(issue_rows, basic_rows=None, rating_map=None, dry=False):
    """幂等写入 cb_issue/cb_basic 标准事实及原始留痕。"""
    basic_map = {str(row.get("ts_code")): row for row in (basic_rows or []) if row.get("ts_code")}
    rating_map = rating_map or {}
    conn = db_pg.connect()
    cur = conn.cursor()
    source_id = _source_id(cur)
    run_id = None
    if not dry:
        cur.execute(
            """INSERT INTO ops.ingestion_runs(source_id,dataset_code,request_range,status)
               VALUES(%s,'cb_issue_cb_basic','{}','running') RETURNING run_id""",
            (source_id,),
        )
        run_id = cur.fetchone()[0]
    saved = 0
    try:
        for raw in issue_rows or []:
            ts_code = str(raw.get("ts_code") or "").strip().upper()
            if not ts_code:
                continue
            basic = basic_map.get(ts_code, {})
            code = _ts_code(ts_code)
            stock = _stock_code(basic.get("stk_code") or raw.get("stk_code"))
            name = str(basic.get("bond_short_name") or raw.get("onl_name") or ts_code)
            listing_date = _date(basic.get("list_date"))
            if dry:
                saved += 1
                continue
            payload = dict(raw)
            payload["cb_basic"] = basic
            payload["rating"] = rating_map.get(ts_code)
            payload_text = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
            cur.execute(
                """INSERT INTO ops.raw_records(run_id,source_id,dataset_code,source_key,payload,payload_hash)
                   VALUES(%s,%s,'cb_issue_cb_basic',%s,%s::jsonb,%s)
                   ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO NOTHING""",
                (run_id, source_id, _raw_key(ts_code, raw), payload_text,
                 hashlib.sha256(payload_text.encode("utf-8")).hexdigest()),
            )
            cur.execute(
                """INSERT INTO core.instruments(canonical_code,name,asset_class,market,list_date,status,raw_data)
                   VALUES(%s,%s,'convertible_bond','CN',%s::date,
                     CASE WHEN %s::date IS NULL THEN 'announced'
                          WHEN %s::date > CURRENT_DATE THEN 'pending_listing' ELSE 'listed' END,
                     %s::jsonb)
                   ON CONFLICT(canonical_code) DO UPDATE SET
                     name=COALESCE(NULLIF(core.instruments.name,''),EXCLUDED.name),
                     list_date=COALESCE(core.instruments.list_date,EXCLUDED.list_date),
                     status=CASE WHEN EXCLUDED.list_date IS NULL THEN core.instruments.status
                                 WHEN EXCLUDED.list_date > CURRENT_DATE THEN 'pending_listing' ELSE 'listed' END,
                     raw_data=core.instruments.raw_data || EXCLUDED.raw_data,updated_at=now()
                   RETURNING instrument_id""",
                (code, name, listing_date, listing_date, listing_date, payload_text),
            )
            instrument_id = cur.fetchone()[0]
            stock_id = None
            if stock:
                cur.execute(
                    """INSERT INTO core.instruments(canonical_code,name,asset_class,market)
                       VALUES(%s,%s,'stock','CN')
                       ON CONFLICT(canonical_code) DO UPDATE SET name=COALESCE(NULLIF(core.instruments.name,''),EXCLUDED.name),updated_at=now()
                       RETURNING instrument_id""",
                    (stock, basic.get("stk_short_name") or stock),
                )
                stock_id = cur.fetchone()[0]
            issue_size = _issue_size_100m(raw.get("issue_size"))
            cur.execute(
                """INSERT INTO fundamental.convertible_bond_profiles
                   (instrument_id,stock_instrument_id,bond_short_name,bond_full_name,cb_type,par_value,issue_price,issue_size,
                    first_conv_price,current_conv_price,newest_rating,list_date,source_id,raw_payload,source_updated_at)
                   VALUES(%s,%s,%s,%s,'CB',%s,%s,%s,%s,%s,%s,%s::date,%s,%s::jsonb,now())
                   ON CONFLICT(instrument_id) DO UPDATE SET
                     stock_instrument_id=COALESCE(EXCLUDED.stock_instrument_id,fundamental.convertible_bond_profiles.stock_instrument_id),
                     bond_short_name=COALESCE(NULLIF(EXCLUDED.bond_short_name,''),fundamental.convertible_bond_profiles.bond_short_name),
                     par_value=COALESCE(EXCLUDED.par_value,fundamental.convertible_bond_profiles.par_value),
                     issue_price=COALESCE(EXCLUDED.issue_price,fundamental.convertible_bond_profiles.issue_price),
                     issue_size=COALESCE(EXCLUDED.issue_size,fundamental.convertible_bond_profiles.issue_size),
                     first_conv_price=COALESCE(EXCLUDED.first_conv_price,fundamental.convertible_bond_profiles.first_conv_price),
                     current_conv_price=COALESCE(EXCLUDED.current_conv_price,fundamental.convertible_bond_profiles.current_conv_price),
                     newest_rating=COALESCE(NULLIF(EXCLUDED.newest_rating,''),fundamental.convertible_bond_profiles.newest_rating),
                     list_date=COALESCE(EXCLUDED.list_date,fundamental.convertible_bond_profiles.list_date),
                     raw_payload=fundamental.convertible_bond_profiles.raw_payload || EXCLUDED.raw_payload,
                     source_updated_at=now(),updated_at=now()""",
                (instrument_id, stock_id, name, name, _num(basic.get("par")), _num(raw.get("issue_price")),
                 issue_size * 100000000 if issue_size is not None else None,
                 _num(basic.get("first_conv_price")), _num(basic.get("conv_price")), rating_map.get(ts_code) or "",
                 listing_date, source_id, payload_text),
            )
            cur.execute(
                """INSERT INTO fundamental.convertible_bond_issuance
                   (instrument_id,issue_type,issue_price_yuan,issue_size_100m_yuan,shareholder_allotment_ratio_yuan_per_share,
                    online_size_100m_yuan,offline_size_100m_yuan,online_purchase_accounts_10k,shareholder_allotment_quantity,
                    source_id,source_updated_at,raw_payload)
                   VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now(),%s::jsonb)
                   ON CONFLICT(instrument_id) DO UPDATE SET
                     issue_type=COALESCE(EXCLUDED.issue_type,fundamental.convertible_bond_issuance.issue_type),
                     issue_price_yuan=COALESCE(EXCLUDED.issue_price_yuan,fundamental.convertible_bond_issuance.issue_price_yuan),
                     issue_size_100m_yuan=COALESCE(EXCLUDED.issue_size_100m_yuan,fundamental.convertible_bond_issuance.issue_size_100m_yuan),
                     shareholder_allotment_ratio_yuan_per_share=COALESCE(EXCLUDED.shareholder_allotment_ratio_yuan_per_share,fundamental.convertible_bond_issuance.shareholder_allotment_ratio_yuan_per_share),
                     online_size_100m_yuan=COALESCE(EXCLUDED.online_size_100m_yuan,fundamental.convertible_bond_issuance.online_size_100m_yuan),
                     offline_size_100m_yuan=COALESCE(EXCLUDED.offline_size_100m_yuan,fundamental.convertible_bond_issuance.offline_size_100m_yuan),
                     online_purchase_accounts_10k=COALESCE(EXCLUDED.online_purchase_accounts_10k,fundamental.convertible_bond_issuance.online_purchase_accounts_10k),
                     shareholder_allotment_quantity=COALESCE(EXCLUDED.shareholder_allotment_quantity,fundamental.convertible_bond_issuance.shareholder_allotment_quantity),
                     raw_payload=fundamental.convertible_bond_issuance.raw_payload || EXCLUDED.raw_payload,updated_at=now()""",
                (instrument_id, raw.get("issue_type"), _num(raw.get("issue_price")), issue_size,
                 _num(raw.get("shd_ration_ratio")),
                 (_num(raw.get("onl_size")) / 1000000 if _num(raw.get("onl_size")) is not None else None),
                 (_num(raw.get("offl_size")) / 1000000 if _num(raw.get("offl_size")) is not None else None),
                 (_num(raw.get("onl_pch_num")) / 10000 if _num(raw.get("onl_pch_num")) is not None else None),
                 _num(raw.get("shd_ration_size")), source_id, payload_text),
            )
            for event_type, value in (
                ("issue_announcement", raw.get("ann_date")),
                ("shareholder_record", raw.get("shd_ration_record_date")),
                ("online_subscription", raw.get("onl_date")),
                ("result_announcement", raw.get("res_ann_date")),
                ("listing", listing_date),
            ):
                event_date = _date(value)
                if not event_date:
                    continue
                cur.execute(
                    """INSERT INTO event.instrument_events(instrument_id,event_type,event_date,source_id,source_key,details,source_updated_at)
                       VALUES(%s,%s,%s,%s,%s,%s::jsonb,now())
                       ON CONFLICT(instrument_id,event_type,event_date) DO UPDATE SET source_id=EXCLUDED.source_id,source_key=EXCLUDED.source_key,
                         details=EXCLUDED.details,source_updated_at=now(),updated_at=now()""",
                    (instrument_id, event_type, event_date, source_id,
                     f"tushare:cb_issue:{ts_code}:{event_type}:{event_date}", payload_text),
                )
            saved += 1
        if not dry:
            cur.execute("UPDATE ops.ingestion_runs SET status='success',row_count=%s,finished_at=now() WHERE run_id=%s", (saved, run_id))
            cur.execute(
                """INSERT INTO ops.sync_cursors(scope_key,dataset_code,last_success_date,last_source_update,last_attempt_at,last_error,retry_count)
                   VALUES('convertible_bond_issue','cb_issue_cb_basic',CURRENT_DATE,now(),now(),'',0)
                   ON CONFLICT(scope_key,dataset_code) DO UPDATE SET last_success_date=EXCLUDED.last_success_date,last_source_update=now(),
                     last_attempt_at=now(),last_error='',retry_count=0,updated_at=now()"""
            )
            conn.commit()
        return saved
    except Exception:
        if not dry:
            cur.execute("UPDATE ops.ingestion_runs SET status='failed',error_message=%s,finished_at=now() WHERE run_id=%s", ("cb_issue 标准化失败", run_id))
            conn.commit()
        raise
    finally:
        cur.close()
        conn.close()


def get_bond_row(code):
    conn = db_pg.connect()
    cur = conn.cursor()
    cur.execute(
        """SELECT instrument_id,bond_code,bond_name,stock_code,stock_name,display_conv_price,display_issue_size,display_rating,
                  listing_date,ann_date,res_ann_date,onl_date,issue_type,bh_issue_price,first_day_return
             FROM public.bond_unified WHERE security_code=%s LIMIT 1""",
        (str(code).split(".")[0],),
    )
    row = cur.fetchone()
    cur.close()
    conn.close()
    if not row:
        return None
    fields = ("instrument_id", "bond_code", "bond_name", "stock_code", "stock_name", "conv_price", "issue_size", "rating",
              "listing_date", "ann_date", "res_ann_date", "onl_date", "issue_type", "issue_price", "first_day_return")
    return dict(zip(fields, row))


def get_listing_liquidity(code):
    """读取已落库的上市流通规模，避免重复请求公告。"""
    conn = db_pg.connect()
    cur = conn.cursor()
    cur.execute(
        """SELECT l.circulation_scale_100m_yuan,l.lock_scale_100m_yuan,
                  l.controller_quantity_zhang,l.total_quantity_zhang,l.controller_ratio_pct,
                  l.source_code,l.source_detail,l.listing_date
             FROM analytics.convertible_bond_listing_liquidity l
             JOIN core.instruments i ON i.instrument_id=l.instrument_id
            WHERE split_part(i.canonical_code,'.',1)=%s LIMIT 1""",
        (str(code or "").split(".")[0],),
    )
    row = cur.fetchone()
    cur.close(); conn.close()
    if not row:
        return None
    fields = ("circulation_scale", "lock_scale", "ctrl_zhang", "total_zhang", "ctrl_ratio",
              "source_code", "source_detail", "listing_date")
    return dict(zip(fields, row))


def save_listing_liquidity(code, payload, listing_date=None):
    """幂等保存公告解析出的流通规模；失败或空值不覆盖有效事实。"""
    if not payload or payload.get("status") != "ok" or payload.get("circulation_scale") is None:
        return False
    conn = db_pg.connect()
    cur = conn.cursor()
    cur.execute(
        "SELECT instrument_id,list_date FROM core.instruments WHERE split_part(canonical_code,'.',1)=%s LIMIT 1",
        (str(code or "").split(".")[0],),
    )
    instrument = cur.fetchone()
    if not instrument:
        cur.close(); conn.close()
        return False
    cur.execute("SELECT source_id FROM ops.data_sources WHERE source_code='cninfo_announcements' LIMIT 1")
    source = cur.fetchone()
    source_detail = {
        "source": payload.get("source"),
        "source_class": payload.get("source_class"),
    }
    cur.execute(
        """INSERT INTO analytics.convertible_bond_listing_liquidity
             (instrument_id,listing_date,circulation_scale_100m_yuan,lock_scale_100m_yuan,
              controller_quantity_zhang,total_quantity_zhang,controller_ratio_pct,source_id,source_code,source_detail)
           VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)
           ON CONFLICT(instrument_id) DO UPDATE SET
             listing_date=COALESCE(EXCLUDED.listing_date,analytics.convertible_bond_listing_liquidity.listing_date),
             circulation_scale_100m_yuan=EXCLUDED.circulation_scale_100m_yuan,
             lock_scale_100m_yuan=EXCLUDED.lock_scale_100m_yuan,
             controller_quantity_zhang=EXCLUDED.controller_quantity_zhang,
             total_quantity_zhang=EXCLUDED.total_quantity_zhang,
             controller_ratio_pct=EXCLUDED.controller_ratio_pct,
             source_id=EXCLUDED.source_id,source_code=EXCLUDED.source_code,
             source_detail=EXCLUDED.source_detail,updated_at=now()""",
        (instrument[0], _date(listing_date or instrument[1]), payload.get("circulation_scale"),
         payload.get("lock_scale"), payload.get("ctrl_zhang"), payload.get("total_zhang"),
         payload.get("ctrl_ratio"), source[0] if source else None,
         payload.get("source_code") or "cninfo_announcements",
         json.dumps(source_detail, ensure_ascii=False, default=str)),
    )
    conn.commit(); cur.close(); conn.close()
    return True


def list_bond_performance(cutoff_date):
    conn = db_pg.connect()
    cur = conn.cursor()
    cur.execute(
        """SELECT return_pct FROM analytics.convertible_bond_listing_performance
           WHERE listing_date >= %s::date AND return_pct IS NOT NULL""",
        (cutoff_date,),
    )
    rows = [row[0] for row in cur.fetchall()]
    cur.close()
    conn.close()
    return rows


def update_listing_performance(code, listing_date, observation_date, close_price, return_pct, raw_payload=None, dry=False):
    if dry:
        return
    conn = db_pg.connect()
    cur = conn.cursor()
    source_code = "tencent" if (raw_payload or {}).get("source") == "listing_kline" else "tushare"
    cur.execute("SELECT source_id FROM ops.data_sources WHERE source_code=%s LIMIT 1", (source_code,))
    source_row = cur.fetchone()
    if not source_row:
        cur.close(); conn.close()
        return
    source_id = source_row[0]
    cur.execute("SELECT instrument_id FROM core.instruments WHERE canonical_code=%s", (_ts_code(code),))
    row = cur.fetchone()
    if not row:
        cur.close(); conn.close()
        return
    cur.execute(
        """INSERT INTO analytics.convertible_bond_listing_performance
           (instrument_id,listing_date,observation_date,measurement_type,close_price,return_pct,formula_version,source_id,raw_payload)
           VALUES(%s,%s,%s,'first_non_limit_day',%s,%s,'first_non_limit_day_v1',%s,%s::jsonb)
           ON CONFLICT(instrument_id,measurement_type,formula_version) DO UPDATE SET
             listing_date=EXCLUDED.listing_date,observation_date=EXCLUDED.observation_date,close_price=EXCLUDED.close_price,
             return_pct=EXCLUDED.return_pct,raw_payload=EXCLUDED.raw_payload,calculated_at=now()""",
        (row[0], _date(listing_date), _date(observation_date), _num(close_price), _num(return_pct), source_id,
         json.dumps(raw_payload or {}, ensure_ascii=False, default=str)),
    )
    conn.commit(); cur.close(); conn.close()
