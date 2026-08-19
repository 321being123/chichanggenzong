"""Python 自动任务共用的外部请求预算、熔断和数据集锁。"""
import atexit
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
from datetime import datetime, timedelta
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse
from zoneinfo import ZoneInfo


_stats = {"total": 0, "sources": {}}
_requests_installed = False


def enabled():
    return os.environ.get("EXTERNAL_CALL_GUARD", "") == "1"


class ExternalCallGuardError(RuntimeError):
    def __init__(self, code, message, source, dataset, api_name="", token_fingerprint="", recover_at=None):
        super().__init__(message)
        self.code = code
        self.error_type = {
            "RATE_LIMIT": "rate_limit",
            "QUOTA_EXHAUSTED": "rate_limit",
            "DATASET_LOCKED": "in_progress",
        }.get(code, "circuit_open")
        self.source = source
        self.dataset = dataset
        self.api_name = api_name or ""
        self.token_fingerprint = token_fingerprint or ""
        self.recover_at = recover_at

    def __str__(self):
        api = f"[{self.api_name}]" if self.api_name else ""
        return f"[{self.code}][{self.source}]{api} {super().__str__()}"


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


def token_fingerprint(token):
    value = str(token or "")
    return hashlib.sha256(value.encode("utf-8")).hexdigest() if value else "none"


def _api_name(source, dataset="", api_name=None):
    if api_name:
        return str(api_name)[:64]
    if _source_key(source).startswith("tushare"):
        match = re.match(r"^([A-Za-z0-9_]+)", str(dataset or ""))
        return match.group(1)[:64] if match else "*"
    return "*"


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


def _next_minute_at():
    now = time.time()
    return datetime.fromtimestamp((int(now // 60) + 1) * 60 + 1, tz=ZoneInfo("UTC"))


def _next_shanghai_day_at():
    now = datetime.now(ZoneInfo("Asia/Shanghai"))
    return (now.replace(hour=0, minute=0, second=1, microsecond=0) + timedelta(days=1)).astimezone(ZoneInfo("UTC"))


def _recover_at(code):
    if code == "RATE_LIMIT":
        return _next_minute_at()
    if code == "QUOTA_EXHAUSTED":
        return _next_shanghai_day_at()
    return None


def _circuit_api(api_name, code):
    # 只有 Token 认证失效或调用方明确传入 '*' 时才扩大到整个 Token。
    # 上游接口自己的当日额度仍然绑定当前接口；本系统总预算由 _consume 显式传入 '*'.
    return "*" if code == "AUTH_ERROR" else (api_name or "*")


def _upsert_circuit(cur, source, api_name, fingerprint, code, detail, recover_at):
    cur.execute(
        """INSERT INTO ops.external_circuits
           (source,api_name,token_fingerprint,state,recover_at,probe_in_flight,error_code,error_type,detail)
           VALUES(%s,%s,%s,'open',%s,%s,%s,%s,%s)
           ON CONFLICT(source,api_name,token_fingerprint) DO UPDATE SET
           state='open',recover_at=EXCLUDED.recover_at,probe_in_flight=false,
           error_code=EXCLUDED.error_code,error_type=EXCLUDED.error_type,
           detail=EXCLUDED.detail,opened_at=now(),updated_at=now()""",
        (source, _circuit_api(api_name, code), fingerprint, recover_at, False,
         code, "rate_limit" if code in {"RATE_LIMIT", "QUOTA_EXHAUSTED"} else "circuit_open",
         str(detail or "")[:1000]),
    )


def _check_circuit(cur, source, api_name, fingerprint, dataset):
    names = [api_name, "*"] if api_name != "*" else ["*"]
    cur.execute(
        """SELECT api_name,recover_at,probe_in_flight,error_code,detail
             FROM ops.external_circuits
            WHERE source=%s AND api_name=ANY(%s) AND token_fingerprint=%s AND state='open'
            ORDER BY CASE WHEN api_name='*' THEN 0 ELSE 1 END
            FOR UPDATE""",
        (source, names, fingerprint),
    )
    row = cur.fetchone()
    if not row:
        return
    circuit_api, recover_at, probe_in_flight, code, detail = row
    if recover_at is not None and recover_at <= datetime.now(ZoneInfo("UTC")) and not probe_in_flight:
        cur.execute(
            """UPDATE ops.external_circuits SET probe_in_flight=true,updated_at=now()
                WHERE source=%s AND api_name=%s AND token_fingerprint=%s""",
            (source, circuit_api, fingerprint),
        )
        return
    scope = "Token" if circuit_api == "*" else f"接口 {circuit_api}"
    raise ExternalCallGuardError(
        "CIRCUIT_OPEN", f"{source} {scope}已熔断，等待恢复探测", source, dataset,
        api_name=circuit_api if circuit_api != "*" else api_name,
        token_fingerprint=fingerprint, recover_at=recover_at,
    )


def _consume(conn, source, dataset, circuit_source=None, api_name=None, token_fingerprint_value="none"):
    source = _source_key(source)
    api_name = _api_name(source, dataset, api_name)
    fingerprint = str(token_fingerprint_value or "none")
    day_key = _date_text()
    minute_key = f"{day_key}:{_minute_key()}"
    day_limit = _limit(source, "day")
    minute_limit = _limit(source, "minute")
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT pg_advisory_xact_lock(hashtext('external_budget:' || %s))", (source,))
            cur.execute("""SELECT call_count FROM ops.external_call_budgets
                           WHERE source=%s AND window_type='day' AND window_key=%s FOR UPDATE""", (source, day_key))
            day_row = cur.fetchone()
            _check_circuit(cur, source, api_name, fingerprint, dataset)
            cur.execute(
                """SELECT call_count FROM ops.external_call_budgets
                   WHERE source=%s AND window_type='minute' AND window_key=%s FOR UPDATE""",
                (source, minute_key),
            )
            minute_row = cur.fetchone()
            day_count = int(day_row[0] if day_row else 0)
            minute_count = int(minute_row[0] if minute_row else 0)
            if minute_count >= minute_limit:
                recover_at = _recover_at("RATE_LIMIT")
                _upsert_circuit(cur, source, api_name, fingerprint, "RATE_LIMIT", f"{source} 已达到每分钟请求预算 {minute_limit}", recover_at)
                conn.commit()
                raise ExternalCallGuardError("RATE_LIMIT", f"{source} {api_name} 已达到每分钟请求预算 {minute_limit}", source, dataset, api_name, fingerprint, recover_at)
            if day_count >= day_limit:
                recover_at = _recover_at("QUOTA_EXHAUSTED")
                _upsert_circuit(cur, source, "*", fingerprint, "QUOTA_EXHAUSTED", f"{source} 已达到当日请求预算 {day_limit}", recover_at)
                conn.commit()
                raise ExternalCallGuardError("QUOTA_EXHAUSTED", f"{source} 已达到当日请求预算 {day_limit}", source, dataset, "*", fingerprint, recover_at)
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


def _open_circuit(source, detail, api_name="*", token_fingerprint_value="none", code="RATE_LIMIT", recover_at=None):
    conn = _db_connect()
    try:
        with conn.cursor() as cur:
            _upsert_circuit(cur, _source_key(source), api_name, token_fingerprint_value, code, detail, recover_at if recover_at is not None else _recover_at(code))
        conn.commit()
    finally:
        conn.close()


def open_external_circuit(source, api_name, token_fingerprint_value, code, detail):
    _open_circuit(source, detail, api_name, token_fingerprint_value, code)


def close_external_circuit(source, api_name, token_fingerprint_value):
    conn = _db_connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE ops.external_circuits SET state='closed',probe_in_flight=false,last_success_at=now(),updated_at=now()
                    WHERE source=%s AND api_name=ANY(%s) AND token_fingerprint=%s""",
                (_source_key(source), [str(api_name or "*")[:64], "*"], str(token_fingerprint_value or "none")),
            )
        conn.commit()
    finally:
        conn.close()


def release_external_circuit_probe(source, api_name, token_fingerprint_value, retry_seconds=5):
    conn = _db_connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE ops.external_circuits
                    SET probe_in_flight=false,
                          recover_at=now() + (%s * interval '1 second'),
                          updated_at=now()
                    WHERE source=%s AND api_name=ANY(%s) AND token_fingerprint=%s
                      AND state='open' AND probe_in_flight=true""",
                (max(float(retry_seconds or 5), 1), _source_key(source), [str(api_name or "*")[:64], "*"], str(token_fingerprint_value or "none")),
            )
        conn.commit()
    finally:
        conn.close()


def with_external_call_guard(source, dataset, fn, circuit_source=None, api_name=None, token_fingerprint_value="none"):
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
        _consume(conn, source, dataset, circuit_source, api_name, token_fingerprint_value)
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


def guarded_urlopen(request, timeout=30, source=None, dataset=None, api_name=None, token_fingerprint_value="none"):
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
                _open_circuit(source, str(error), api_name or _api_name(source, dataset), token_fingerprint_value, "RATE_LIMIT")
                raise ExternalCallGuardError("RATE_LIMIT", f"{source} 接口 HTTP 429", source, dataset, api_name or _api_name(source, dataset), token_fingerprint_value, _recover_at("RATE_LIMIT")) from error
            if error.code in {401, 403}:
                code = "AUTH_ERROR" if error.code == 401 else "PERMISSION_DENIED"
                _open_circuit(source, str(error), "*" if code == "AUTH_ERROR" else api_name or _api_name(source, dataset), token_fingerprint_value, code)
                raise ExternalCallGuardError(code, f"{source} 接口 HTTP {error.code}", source, dataset, api_name or _api_name(source, dataset), token_fingerprint_value) from error
            if error.code >= 500:
                raise ExternalCallGuardError("UPSTREAM_5XX", f"{source} 接口 HTTP {error.code}", source, dataset, api_name or _api_name(source, dataset), token_fingerprint_value) from error
            raise
        status = int(getattr(response, "status", getattr(response, "code", 200)) or 200)
        if status == 429:
            _open_circuit(source, f"HTTP {status}", api_name or _api_name(source, dataset), token_fingerprint_value, "RATE_LIMIT")
            raise ExternalCallGuardError("RATE_LIMIT", f"{source} 接口 HTTP 429", source, dataset, api_name or _api_name(source, dataset), token_fingerprint_value, _recover_at("RATE_LIMIT"))
        if status in {401, 403}:
            code = "AUTH_ERROR" if status == 401 else "PERMISSION_DENIED"
            _open_circuit(source, f"HTTP {status}", "*" if code == "AUTH_ERROR" else api_name or _api_name(source, dataset), token_fingerprint_value, code)
            raise ExternalCallGuardError(code, f"{source} 接口 HTTP {status}", source, dataset, api_name or _api_name(source, dataset), token_fingerprint_value)
        if status >= 500:
            raise ExternalCallGuardError("UPSTREAM_5XX", f"{source} 接口 HTTP {status}", source, dataset, api_name or _api_name(source, dataset), token_fingerprint_value)
        return response

    return with_external_call_guard(source, dataset, perform, api_name=api_name, token_fingerprint_value=token_fingerprint_value)


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
                _open_circuit(source, f"HTTP {status}", _api_name(source, dataset), "none", "RATE_LIMIT")
                raise ExternalCallGuardError("RATE_LIMIT", f"{source} 接口 HTTP 429", source, dataset, _api_name(source, dataset), "none", _recover_at("RATE_LIMIT"))
            if status in {401, 403}:
                code = "AUTH_ERROR" if status == 401 else "PERMISSION_DENIED"
                _open_circuit(source, f"HTTP {status}", "*" if code == "AUTH_ERROR" else _api_name(source, dataset), "none", code)
                raise ExternalCallGuardError(code, f"{source} 接口 HTTP {status}", source, dataset, _api_name(source, dataset), "none")
            if status >= 500:
                raise ExternalCallGuardError("UPSTREAM_5XX", f"{source} 接口 HTTP {status}", source, dataset, _api_name(source, dataset), "none")
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
