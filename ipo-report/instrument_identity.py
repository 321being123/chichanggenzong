"""Python 侧供应商代码解析器：只读 core.instrument_identifiers，带有界 TTL 缓存。"""
import json
import re
import time
from collections import OrderedDict

import db_pg

_CACHE = OrderedDict()
_CACHE_MAX = 5000
_CACHE_TTL = 600


def _key(canonical_code, source_code, identifier_type, asset_class=None):
    return "|".join(str(value or "").strip().upper() for value in (canonical_code, source_code, identifier_type, asset_class))


def _derive_provider_identifier(canonical, source_code, identifier_type):
    """只由统一身份模块派生供应商标识；调用方不得自行按前缀拼接。"""
    text = str(canonical or "").strip().upper()
    source = str(source_code or "").strip().lower()
    identifier = str(identifier_type or "").strip()
    match = re.match(r"^(\d{5,6})\.(SH|SZ|BJ|HK)$", text)
    if source == "tushare" and identifier == "ts_code":
        return text or None
    if not match:
        return None
    code, exchange = match.groups()
    if source == "tencent" and identifier == "quote_symbol":
        return f"{exchange.lower()}{code}"
    if source == "eastmoney" and identifier == "f10_code":
        return f"{exchange}{code}"
    if source == "eastmoney" and identifier == "guba_code":
        return code
    if source == "sina" and identifier == "symbol":
        return f"{exchange.lower()}{code}"
    return None


def resolve_provider_code(canonical_code, source_code="tushare", identifier_type="ts_code", conn=None, asset_class=None):
    key = _key(canonical_code, source_code, identifier_type, asset_class)
    now = time.time()
    item = _CACHE.get(key)
    if item and item[0] > now:
        _CACHE.move_to_end(key)
        return item[1]
    own = conn is None
    connection = conn or db_pg.connect()
    try:
        canonical = resolve_canonical_code(canonical_code, asset_class, connection)
        with connection.cursor() as cur:
            cur.execute(
                """SELECT x.identifier_value,x.instrument_id
                     FROM core.instrument_identifiers x
                     JOIN core.instruments i ON i.instrument_id=x.instrument_id
                     JOIN ops.data_sources d ON d.source_id=x.source_id
                    WHERE upper(i.canonical_code)=upper(%s)
                      AND lower(d.source_code)=lower(%s)
                      AND x.identifier_type=%s
                      AND (x.valid_from IS NULL OR x.valid_from<=CURRENT_DATE)
                      AND (x.valid_to IS NULL OR x.valid_to>=CURRENT_DATE)
                    ORDER BY x.valid_from DESC NULLS LAST,x.identifier_id DESC
                    LIMIT 2""",
                (str(canonical or "").strip(), str(source_code or "").strip(), str(identifier_type or "").strip()),
            )
            rows = cur.fetchall()
        unique_instruments = {row[1] for row in rows if len(row) > 1 and row[1] is not None}
        value = rows[0][0] if len(unique_instruments) == 1 else None
        instrument_id = rows[0][1] if len(unique_instruments) == 1 else None
        if instrument_id is None:
            with connection.cursor() as instrument_cur:
                instrument_cur.execute(
                    """SELECT instrument_id FROM core.instruments
                         WHERE upper(canonical_code)=upper(%s) LIMIT 1""",
                    (str(canonical or "").strip(),),
                )
                instrument_row = instrument_cur.fetchone()
            instrument_id = instrument_row[0] if instrument_row else None
        # 映射缺失时由统一身份模块生成候选并先落库，随后再次校验唯一性。
        # 这样运行时不会出现各业务模块各自拼接供应商代码的第二套规则。
        if value is None and instrument_id:
            derived = _derive_provider_identifier(canonical, source_code, identifier_type)
            if derived:
                with connection.cursor() as write_cur:
                    write_cur.execute(
                    """SELECT source_id FROM ops.data_sources WHERE lower(source_code)=lower(%s) LIMIT 1""",
                    (str(source_code or "").strip(),),
                    )
                    source_row = write_cur.fetchone()
                    if source_row:
                        write_cur.execute(
                        """INSERT INTO core.instrument_identifiers
                              (instrument_id,source_id,identifier_type,identifier_value,valid_from)
                           VALUES(%s,%s,%s,%s,CURRENT_DATE)
                           ON CONFLICT(source_id,identifier_type,identifier_value,valid_from) DO NOTHING""",
                            (instrument_id, source_row[0], identifier_type, derived),
                        )
                        write_cur.execute(
                        """SELECT x.identifier_value,x.instrument_id
                             FROM core.instrument_identifiers x
                            WHERE x.source_id=%s AND x.identifier_type=%s AND x.identifier_value=%s
                              AND (x.valid_from IS NULL OR x.valid_from<=CURRENT_DATE)
                              AND (x.valid_to IS NULL OR x.valid_to>=CURRENT_DATE)
                            LIMIT 2""",
                            (source_row[0], identifier_type, derived),
                        )
                        verify = write_cur.fetchall()
                        if len(verify) == 1 and int(verify[0][1]) == int(instrument_id):
                            value = verify[0][0]
        if own:
            connection.commit()
        _CACHE[key] = (now + _CACHE_TTL, value)
        _CACHE.move_to_end(key)
        while len(_CACHE) > _CACHE_MAX:
            _CACHE.popitem(last=False)
        return value
    except Exception:
        if own:
            connection.rollback()
        return None
    finally:
        if own:
            connection.close()


def clear_cache():
    _CACHE.clear()


def ensure_instrument(canonical_code, name="", asset_class="stock", market="CN", exchange_code="", currency_code="CNY", list_date=None, status="listed", raw_data=None, company_name=None, conn=None):
    """统一主档写入口；调用方可传入已有事务连接。"""
    own = conn is None
    connection = conn or db_pg.connect()
    try:
        with connection.cursor() as cur:
            cur.execute(
                """INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code,currency_code,list_date,status,raw_data)
                   VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)
                   ON CONFLICT(canonical_code) DO UPDATE SET name=CASE WHEN EXCLUDED.name<>'' THEN EXCLUDED.name ELSE core.instruments.name END,
                     asset_class=EXCLUDED.asset_class,market=EXCLUDED.market,exchange_code=EXCLUDED.exchange_code,currency_code=EXCLUDED.currency_code,
                     list_date=COALESCE(core.instruments.list_date,EXCLUDED.list_date),status=EXCLUDED.status,
                     raw_data=core.instruments.raw_data || EXCLUDED.raw_data,updated_at=now()
                   RETURNING instrument_id""",
                (str(canonical_code).strip().upper(), str(name or ""), asset_class, market, exchange_code, currency_code, list_date, status, json.dumps(raw_data or {}, ensure_ascii=False, default=str)),
            )
            instrument_id = cur.fetchone()[0]
            company_id = None
            company = str(company_name if company_name is not None else (name if asset_class == "stock" else "")).strip()
            if company:
                cur.execute(
                    """INSERT INTO core.companies(legal_name,short_name,country_code,raw_data)
                       VALUES(%s,%s,%s,%s::jsonb)
                       ON CONFLICT(country_code,legal_name) DO UPDATE SET short_name=EXCLUDED.short_name,raw_data=core.companies.raw_data || EXCLUDED.raw_data,updated_at=now()
                       RETURNING company_id""",
                    (company, str(name or company), "HK" if market == "HK" else "CN", json.dumps(raw_data or {}, ensure_ascii=False, default=str)),
                )
                company_id = cur.fetchone()[0]
                cur.execute(
                    """INSERT INTO core.company_instruments(company_id,instrument_id,relation_type,valid_from)
                       VALUES(%s,%s,'issued_by',%s) ON CONFLICT(company_id,instrument_id,relation_type) DO NOTHING""",
                    (company_id, instrument_id, list_date),
                )
            cur.execute("SELECT source_id,source_code FROM ops.data_sources WHERE source_code IN ('tushare','tencent','eastmoney','sina')")
            sources = {row[1]: row[0] for row in cur.fetchall()}
            values = [
                ("tushare", "ts_code", resolve_provider_code(canonical_code, "tushare", "ts_code", connection, asset_class)),
            ]
            for source, identifier_type in (("tencent", "quote_symbol"), ("eastmoney", "f10_code"), ("eastmoney", "guba_code"), ("sina", "symbol")):
                value = resolve_provider_code(canonical_code, source, identifier_type, connection, asset_class)
                if value:
                    values.append((source, identifier_type, value))
            for source, identifier_type, value in values:
                if not value or sources.get(source) is None:
                    continue
                cur.execute(
                    """INSERT INTO core.instrument_identifiers(instrument_id,source_id,identifier_type,identifier_value,valid_from)
                       VALUES(%s,%s,%s,%s,%s) ON CONFLICT(source_id,identifier_type,identifier_value,valid_from) DO NOTHING""",
                    (instrument_id, sources[source], identifier_type, value, list_date or "0001-01-01"),
                )
        if own:
            connection.commit()
        return {"instrument_id": instrument_id, "company_id": company_id}
    except Exception:
        if own:
            connection.rollback()
        raise
    finally:
        if own:
            connection.close()


def _derive_canonical_code(value, asset_class=None):
    text = str(value or "").strip().upper()
    if not text:
        return None
    if "." in text:
        return text
    digits = "".join(ch for ch in text if ch.isdigit())
    if len(digits) not in (5, 6):
        return text
    code = digits.zfill(6)
    if asset_class == "convertible_bond" or (asset_class is None and code.startswith(("11", "12"))):
        return f"{code}.{'SH' if code.startswith('11') else 'SZ'}"
    if asset_class == "stock":
        if code.startswith(("6", "68")):
            return f"{code}.SH"
        if code.startswith(("4", "8", "92", "43")):
            return f"{code}.BJ"
        return f"{code}.SZ"
    return text


def resolve_canonical_code(value, asset_class=None, conn=None):
    """先从统一主档按纯数字唯一匹配，无法匹配时由本模块按明确市场规则派生。"""
    text = str(value or "").strip().upper()
    if not text or "." in text:
        return text or None
    digits = "".join(ch for ch in text if ch.isdigit())
    if len(digits) not in (5, 6):
        return text
    own = conn is None
    connection = conn or db_pg.connect()
    try:
        with connection.cursor() as cur:
            if asset_class:
                cur.execute(
                    """SELECT canonical_code FROM core.instruments
                         WHERE asset_class=%s AND regexp_replace(canonical_code,'\\D','','g')=%s
                         ORDER BY instrument_id LIMIT 2""",
                    (asset_class, digits),
                )
            else:
                cur.execute(
                    """SELECT canonical_code FROM core.instruments
                         WHERE regexp_replace(canonical_code,'\\D','','g')=%s
                         ORDER BY instrument_id LIMIT 2""",
                    (digits,),
                )
            rows = cur.fetchall()
        if len(rows) == 1:
            return rows[0][0]
        if len(rows) > 1:
            return None
    except Exception:
        pass
    finally:
        if own:
            connection.close()
    if len(digits) == 5 and asset_class == "stock":
        return f"{digits.zfill(5)}.HK"
    return _derive_canonical_code(text, asset_class)
