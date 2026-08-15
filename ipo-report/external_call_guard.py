"""Python 自动任务共用的外部请求预算、熔断和数据集锁。"""
import atexit
import json
import os
import sys
import time
import urllib.error
from datetime import datetime
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse
from zoneinfo import ZoneInfo


_stats = {"total": 0, "sources": {}}
_requests_installed = False


def enabled():
    return os.environ.get("EXTERNAL_CALL_GUARD", "") == "1"


class ExternalCallGuardError(RuntimeError):
    def __init__(self, code, message, source, dataset):
        super().__init__(message)
        self.code = code
        self.error_type = {
            "RATE_LIMIT": "rate_limit",
            "QUOTA_EXHAUSTED": "rate_limit",
            "DATASET_LOCKED": "in_progress",
        }.get(code, "circuit_open")
        self.source = source
        self.dataset = dataset

    def __str__(self):
        return f"[{self.code}][{self.source}] {super().__str__()}"


def _db_connect():
    import psycopg2

    dsn = os.environ.get("DATABASE_URL", "").strip()
    if dsn:
        return psycopg2.connect(dsn, connect_timeout=10)
    kwargs = {
        "host": os.environ.get("PGHOST", "127.0.0.1"),
        "port": int(os.environ.get("PGPORT", "5432")),
        "user": os.environ.get("PGUSER", "postgres"),
        "dbname": os.environ.get("PGDATABASE", "portfolio"),
        "connect_timeout": 10,
    }
    password = os.environ.get("PGPASSWORD", "")
    if password:
        kwargs["password"] = password
    return psycopg2.connect(**kwargs)


def _source_key(source):
    return str(source or "python-http")


def _env_key(source):
    return "".join(char if char.isalnum() else "_" for char in _source_key(source).upper())


def _limit(source, window):
    name = f"{_env_key(source)}_{'PER_MINUTE_BUDGET' if window == 'minute' else 'DAILY_BUDGET'}"
    fallback = 120 if source == "tushare" and window == "minute" else 4000 if source == "tushare" else 60 if window == "minute" else 2000
    try:
        value = int(os.environ.get(name, fallback))
    except (TypeError, ValueError):
        value = fallback
    return value if value > 0 else fallback


def _date_text():
    business_date = os.environ.get("JOB_BUSINESS_DATE", "").strip()
    if business_date:
        return business_date[:10]
    return datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d")


def _minute_key():
    return str(int(time.time() // 60))


def _record(source):
    key = _source_key(source)
    _stats["total"] += 1
    _stats["sources"][key] = int(_stats["sources"].get(key, 0)) + 1


def _consume(conn, source, dataset):
    source = _source_key(source)
    day_key = _date_text()
    minute_key = f"{day_key}:{_minute_key()}"
    day_limit = _limit(source, "day")
    minute_limit = _limit(source, "minute")
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT pg_advisory_xact_lock(hashtext('external_budget:' || %s))", (source,))
            cur.execute(
                """SELECT call_count,circuit_open FROM ops.external_call_budgets
                   WHERE source=%s AND window_type='day' AND window_key=%s FOR UPDATE""",
                (source, day_key),
            )
            day_row = cur.fetchone()
            if day_row and day_row[1]:
                raise ExternalCallGuardError("CIRCUIT_OPEN", f"{source} 数据源今日已熔断，停止自动请求", source, dataset)
            cur.execute(
                """SELECT call_count FROM ops.external_call_budgets
                   WHERE source=%s AND window_type='minute' AND window_key=%s FOR UPDATE""",
                (source, minute_key),
            )
            minute_row = cur.fetchone()
            day_count = int(day_row[0] if day_row else 0)
            minute_count = int(minute_row[0] if minute_row else 0)
            if minute_count >= minute_limit:
                raise ExternalCallGuardError("RATE_LIMIT", f"{source} 已达到每分钟请求预算 {minute_limit}", source, dataset)
            if day_count >= day_limit:
                cur.execute(
                    """INSERT INTO ops.external_call_budgets
                       (source,window_type,window_key,call_count,budget_limit,circuit_open,last_error)
                       VALUES(%s,'day',%s,%s,%s,true,%s)
                       ON CONFLICT(source,window_type,window_key) DO UPDATE SET
                       circuit_open=true,last_error=EXCLUDED.last_error,updated_at=now()""",
                    (source, day_key, day_count, day_limit, f"达到当日请求预算 {day_limit}"),
                )
                conn.commit()
                raise ExternalCallGuardError("QUOTA_EXHAUSTED", f"{source} 已达到当日请求预算 {day_limit}", source, dataset)
            cur.execute(
                """INSERT INTO ops.external_call_budgets
                   (source,window_type,window_key,call_count,budget_limit)
                   VALUES(%s,'day',%s,1,%s)
                   ON CONFLICT(source,window_type,window_key) DO UPDATE SET
                   call_count=ops.external_call_budgets.call_count+1,updated_at=now()""",
                (source, day_key, day_limit),
            )
            cur.execute(
                """INSERT INTO ops.external_call_budgets
                   (source,window_type,window_key,call_count,budget_limit)
                   VALUES(%s,'minute',%s,1,%s)
                   ON CONFLICT(source,window_type,window_key) DO UPDATE SET
                   call_count=ops.external_call_budgets.call_count+1,updated_at=now()""",
                (source, minute_key, minute_limit),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def _open_circuit(source, detail):
    conn = _db_connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO ops.external_call_budgets
                   (source,window_type,window_key,call_count,budget_limit,circuit_open,last_error)
                   VALUES(%s,'day',%s,0,%s,true,%s)
                   ON CONFLICT(source,window_type,window_key) DO UPDATE SET
                   circuit_open=true,last_error=EXCLUDED.last_error,updated_at=now()""",
                (_source_key(source), _date_text(), _limit(source, "day"), detail or "上游限流或配额错误"),
            )
        conn.commit()
    finally:
        conn.close()


def with_external_call_guard(source, dataset, fn):
    if not enabled():
        return fn()
    conn = _db_connect()
    lock_key = f"{_source_key(source)}:{dataset or 'unknown'}:{_date_text()}"
    locked = False
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT pg_try_advisory_lock(hashtext('external_dataset:' || %s))", (lock_key,))
            locked = bool(cur.fetchone()[0])
        if not locked:
            raise ExternalCallGuardError("DATASET_LOCKED", "同一数据集正在由其他 Worker 请求中", _source_key(source), dataset)
        _consume(conn, source, dataset)
        _record(source)
        return fn()
    finally:
        if locked:
            try:
                with conn.cursor() as cur:
                    cur.execute("SELECT pg_advisory_unlock(hashtext('external_dataset:' || %s))", (lock_key,))
            except Exception:
                pass
        conn.close()


def _url_source(url):
    host = (urlparse(str(url)).hostname or "").lower()
    if "tushare" in host:
        return "tushare"
    if "gtimg" in host:
        return "tencent"
    if "cninfo" in host:
        return "cninfo"
    if "eastmoney" in host or "emoney" in host:
        return "eastmoney"
    if "sse.com.cn" in host:
        return "sse"
    if "hkex" in host:
        return "hkex"
    if "er-api" in host:
        return "exchange-rate"
    return "python-http"


def _dataset(url, params=None, body=None):
    parsed = urlparse(str(url))
    query = list(parse_qsl(parsed.query, keep_blank_values=True))
    if isinstance(params, dict):
        query.extend((str(key), str(value)) for key, value in sorted(params.items()))
    normalized = urlunparse((parsed.scheme, parsed.netloc, parsed.path, parsed.params, urlencode(sorted(query)), ""))
    if body not in (None, "", b""):
        if isinstance(body, bytes):
            body = body.decode("utf-8", "replace")
        normalized += ":" + str(body)[:500]
    return normalized[:1000]


def guarded_urlopen(request, timeout=30, source=None, dataset=None):
    """在不修改 urllib 全局行为的前提下保护单次请求。"""
    if not enabled():
        from urllib.request import urlopen
        return urlopen(request, timeout=timeout)
    url = request.full_url if hasattr(request, "full_url") else str(request)
    source = source or _url_source(url)
    dataset = dataset or _dataset(url, body=getattr(request, "data", None))

    def perform():
        from urllib.request import urlopen
        try:
            response = urlopen(request, timeout=timeout)
        except urllib.error.HTTPError as error:
            if error.code == 429:
                _open_circuit(source, str(error))
                raise ExternalCallGuardError("RATE_LIMIT", f"{source} 接口 HTTP 429", source, dataset) from error
            if error.code >= 500:
                raise ExternalCallGuardError("UPSTREAM_5XX", f"{source} 接口 HTTP {error.code}", source, dataset) from error
            raise
        status = int(getattr(response, "status", getattr(response, "code", 200)) or 200)
        if status == 429:
            _open_circuit(source, f"HTTP {status}")
            raise ExternalCallGuardError("RATE_LIMIT", f"{source} 接口 HTTP 429", source, dataset)
        if status >= 500:
            raise ExternalCallGuardError("UPSTREAM_5XX", f"{source} 接口 HTTP {status}", source, dataset)
        return response

    return with_external_call_guard(source, dataset, perform)


def install_requests_guard():
    global _requests_installed
    if not enabled() or _requests_installed:
        return
    import requests

    original = requests.sessions.Session.request
    if getattr(original, "_external_call_guard", False):
        _requests_installed = True
        return

    def guarded_request(session, method, url, **kwargs):
        source = _url_source(url)
        dataset = _dataset(url, kwargs.get("params"), kwargs.get("data", kwargs.get("json")))

        def perform():
            response = original(session, method, url, **kwargs)
            status = int(response.status_code or 0)
            if status == 429:
                _open_circuit(source, f"HTTP {status}")
                raise ExternalCallGuardError("RATE_LIMIT", f"{source} 接口 HTTP 429", source, dataset)
            if status >= 500:
                raise ExternalCallGuardError("UPSTREAM_5XX", f"{source} 接口 HTTP {status}", source, dataset)
            return response

        return with_external_call_guard(source, dataset, perform)

    guarded_request._external_call_guard = True
    requests.sessions.Session.request = guarded_request
    _requests_installed = True


def get_external_call_stats():
    return {"total": _stats["total"], "sources": dict(_stats["sources"])}


def _emit_stats():
    if enabled() and _stats["total"]:
        print(f"[external-call-stats] {json.dumps(get_external_call_stats(), ensure_ascii=False)}", file=sys.stderr)


atexit.register(_emit_stats)
