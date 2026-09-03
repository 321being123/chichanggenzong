"""Python 自动任务共用的外部请求预算、熔断和数据集锁。"""
import atexit
import hashlib
import json
import os
import re
import sys
import time
import uuid
import urllib.error
from datetime import datetime, timedelta
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse
from zoneinfo import ZoneInfo


_stats = {"total": 0, "sources": {}}
_requests_installed = False
try:
    _run_call_count = max(int(os.environ.get("JOB_EXTERNAL_CALL_USED", "0")), 0)
except (TypeError, ValueError):
    _run_call_count = 0
_probe_owner = f"{os.uname().nodename if hasattr(os, 'uname') else os.environ.get('COMPUTERNAME', 'python')}:{os.getpid()}:{uuid.uuid4()}"
_probe_lease_seconds = 300

# 这是系统内部保护线，不等同于上游官方配额；必须与 Node Guard 保持一致。
# 主账号 6000 积分：官方 500 次/分钟，常规接口无每日总量；备用账号 2000 积分：
# 官方 200 次/分钟、单接口每日 100000 次，内部分别保留 20 次/分钟和 90000 次凭据止损线。
_DEFAULT_EXTERNAL_BUDGETS = {
    "tushare": {"minute": 450, "day": None},
    "tushare_backup": {"minute": 180, "day": 90000},
    # 巨潮曾发生熔断，保留既有来源级保护线。
    "cninfo": {"minute": 20, "day": 500},
    # 腾讯当前没有触及内部预算，不设置本系统分钟/日限额；仍保留上游异常处理。
    "tencent": {"minute": None, "day": None},
    "default": {"minute": 60, "day": 2000},
}


def enabled():
    configured = os.environ.get("EXTERNAL_CALL_GUARD")
    # 默认开启；生产环境禁止通过环境变量关闭，开发/测试仍可显式 EXTERNAL_CALL_GUARD=0。
    environments = {
        str(os.environ.get("NODE_ENV", "")).strip().lower(),
        str(os.environ.get("APP_ENV", "")).strip().lower(),
    }
    if configured == "0" and "production" in environments:
        return True
    return configured != "0"


class ExternalCallGuardError(RuntimeError):
    def __init__(self, code, message, source, dataset, api_name="", token_fingerprint="", recover_at=None):
        super().__init__(message)
        self.code = code
        self.error_type = {
            "RATE_LIMIT": "rate_limit",
            "QUOTA_EXHAUSTED": "rate_limit",
            "BUDGET_WAIT": "rate_limit",
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


def _budget_source(source):
    source = _source_key(source)
    return "tushare" if source.lower() == "tushare_backup" else source


def _credential_profile(source):
    source = _source_key(source).lower()
    return "backup" if source == "tushare_backup" else "primary" if source == "tushare" else "anonymous"


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
    fallback = _DEFAULT_EXTERNAL_BUDGETS.get(source, _DEFAULT_EXTERNAL_BUDGETS["default"])[window]
    configured = os.environ.get(name)
    if configured is None and fallback is None:
        return None
    try:
        value = int(configured if configured is not None else fallback)
    except (TypeError, ValueError):
        value = fallback
    return value if value is not None and value > 0 else fallback


def _date_text():
    business_date = os.environ.get("JOB_BUSINESS_DATE", "").strip()
    if business_date:
        return business_date[:10]
    return datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d")


def _budget_date_text():
    """API预算按真实请求发生日计算，不能使用补跑任务的数据业务日。"""
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


def _recover_at(code, window=None):
    if code == "RATE_LIMIT" or (code == "BUDGET_WAIT" and window != "day"):
        return _next_minute_at()
    if code == "BUDGET_WAIT" and window == "day":
        return _next_shanghai_day_at()
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
           (source,api_name,token_fingerprint,state,recover_at,probe_in_flight,probe_owner,probe_token,probe_lease_until,error_code,error_type,detail)
           VALUES(%s,%s,%s,'open',%s,false,NULL,NULL,NULL,%s,%s,%s)
           ON CONFLICT(source,api_name,token_fingerprint) DO UPDATE SET
           state='open',recover_at=EXCLUDED.recover_at,probe_in_flight=false,
           probe_owner=NULL,probe_token=NULL,probe_lease_until=NULL,
           error_code=EXCLUDED.error_code,error_type=EXCLUDED.error_type,
           detail=EXCLUDED.detail,opened_at=now(),updated_at=now()""",
        (source, _circuit_api(api_name, code), fingerprint, recover_at,
         code, "rate_limit" if code in {"RATE_LIMIT", "QUOTA_EXHAUSTED"} else "circuit_open",
         str(detail or "")[:1000]),
    )


def _check_circuit(cur, source, api_name, fingerprint, dataset):
    names = [api_name, "*"] if api_name != "*" else ["*"]
    cur.execute(
        """SELECT api_name,recover_at,probe_in_flight,probe_token,probe_lease_until,error_code,detail,updated_at,
                    (recover_at IS NOT NULL AND recover_at <= now()) AS probe_ready,
                    (probe_in_flight AND COALESCE(probe_lease_until, COALESCE(updated_at,opened_at) + interval '5 minutes') < now()) AS stale_probe
             FROM ops.external_circuits
            WHERE source=%s AND api_name=ANY(%s) AND token_fingerprint=%s AND state='open'
            ORDER BY CASE WHEN api_name='*' THEN 0 ELSE 1 END
            FOR UPDATE""",
        (source, names, fingerprint),
    )
    row = cur.fetchone()
    if not row:
        return
    circuit_api, recover_at, probe_in_flight, old_probe_token, probe_lease_until, code, detail, updated_at, probe_ready, stale_probe = row
    if probe_ready and (not probe_in_flight or stale_probe):
        probe_token = str(uuid.uuid4())
        cur.execute(
            """UPDATE ops.external_circuits
                  SET probe_in_flight=true,probe_owner=%s,probe_token=%s,
                      probe_lease_until=now() + (%s * interval '1 second'),updated_at=now()
                WHERE source=%s AND api_name=%s AND token_fingerprint=%s""",
            (_probe_owner, probe_token, _probe_lease_seconds, source, circuit_api, fingerprint),
        )
        return {"probe_token": probe_token, "probe_api_name": circuit_api}
    scope = "Token" if circuit_api == "*" else f"接口 {circuit_api}"
    raise ExternalCallGuardError(
        "CIRCUIT_OPEN", f"{source} {scope}已熔断，等待恢复探测", source, dataset,
        api_name=circuit_api if circuit_api != "*" else api_name,
        token_fingerprint=fingerprint, recover_at=recover_at,
    )


def _consume(conn, source, dataset, circuit_source=None, api_name=None, token_fingerprint_value="none"):
    global _run_call_count
    if os.environ.get("JOB_EXTERNAL_CALL_LIMIT_ACTIVE") == "1":
        try:
            run_limit = float(os.environ.get("JOB_EXTERNAL_CALL_LIMIT", "0"))
        except (TypeError, ValueError):
            run_limit = 0
        if run_limit >= 0 and _run_call_count >= run_limit:
            raise ExternalCallGuardError("JOB_BUDGET_EXCEEDED", f"{source} 已达到本任务声明的外部请求上限 {int(run_limit)}", source, dataset, api_name or "*")
    source = _source_key(source)
    budget_source = _budget_source(source)
    api_name = _api_name(source, dataset, api_name)
    credential_profile = _credential_profile(source)
    fingerprint = str(token_fingerprint_value or "none")
    try:
        with conn.cursor() as cur:
            probe = _check_circuit(cur, source, api_name, fingerprint, dataset)
            # 旧 ops.consume_external_call_budget 仅保留迁移兼容；实际限额必须由策略函数读取。
            # reserve_external_call 最终仍原子写入 ops.external_call_budgets，Node/Python 共用同一计数。
            cur.execute(
                """SELECT allowed,reason,wait_until,day_count,minute_count,
                              effective_daily_limit,effective_minute_limit,timeout_ms,
                              retry_policy,empty_policy,concurrency_slot
                     FROM ops.reserve_external_call(%s,%s,%s,%s)""",
                (budget_source, api_name, credential_profile, fingerprint),
            )
            budget = cur.fetchone() or (False, "policy_missing", None, 0, 0, None, None, 30000, {}, "preserve_last_success", None)
            allowed, reason, wait_until, day_count, minute_count, day_limit, minute_limit, timeout_ms, retry_policy, empty_policy, concurrency_slot = budget
            if not allowed:
                if reason in {"policy_missing", "policy_disabled"}:
                    conn.commit()
                    code = "POLICY_DISABLED" if reason == "policy_disabled" else "POLICY_NOT_CONFIGURED"
                    raise ExternalCallGuardError(code, f"{budget_source} {api_name} 未配置可用接口策略", source, dataset, api_name, fingerprint)
                if reason == "permission_denied":
                    conn.commit()
                    raise ExternalCallGuardError("PERMISSION_DENIED", f"{budget_source} {api_name} 权限策略禁止调用", source, dataset, api_name, fingerprint)
                day_wait = reason in {"day", "credential_day"}
                recover_at = wait_until or _recover_at("BUDGET_WAIT", "day" if day_wait else "minute")
                conn.commit()
                raise ExternalCallGuardError("BUDGET_WAIT", f"{budget_source} {api_name} 已达到保护线，等待恢复", source, dataset, api_name, fingerprint, recover_at)
        conn.commit()
        _run_call_count += 1
        return {
            **(probe or {}), "source": budget_source, "api_name": api_name,
            "credential_profile": credential_profile, "token_fingerprint": fingerprint,
            "day_count": int(day_count or 0), "minute_count": int(minute_count or 0),
            "timeout_ms": int(timeout_ms or 30000), "retry_policy": retry_policy or {},
            "empty_policy": empty_policy or "preserve_last_success",
            "concurrency_slot": concurrency_slot,
        }
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


def close_external_circuit(source, api_name, token_fingerprint_value, probe_token=None):
    conn = _db_connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE ops.external_circuits SET state='closed',probe_in_flight=false,probe_owner=NULL,probe_token=NULL,probe_lease_until=NULL,last_success_at=now(),updated_at=now()
                    WHERE source=%s AND api_name=ANY(%s) AND token_fingerprint=%s
                      AND (%s IS NULL OR probe_token=%s)""",
                (_source_key(source), [str(api_name or "*")[:64], "*"], str(token_fingerprint_value or "none"), probe_token, probe_token),
            )
        conn.commit()
    finally:
        conn.close()


def release_external_circuit_probe(source, api_name, token_fingerprint_value, retry_seconds=5, probe_token=None):
    conn = _db_connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE ops.external_circuits
                    SET probe_in_flight=false,probe_owner=NULL,probe_token=NULL,probe_lease_until=NULL,
                          recover_at=now() + (%s * interval '1 second'),
                          updated_at=now()
                    WHERE source=%s AND api_name=ANY(%s) AND token_fingerprint=%s
                      AND state='open' AND probe_in_flight=true
                      AND (%s IS NULL OR probe_token=%s)""",
                (max(float(retry_seconds or 5), 1), _source_key(source), [str(api_name or "*")[:64], "*"], str(token_fingerprint_value or "none"), probe_token, probe_token),
            )
        conn.commit()
    finally:
        conn.close()


def release_external_call_slot(source, api_name, token_fingerprint_value="none", slot=None, conn=None):
    if slot is None:
        return
    lock_key = f"external_slot:{_budget_source(source)}:{str(api_name or '*')[:64]}:{str(token_fingerprint_value or 'none')}:{int(slot)}"
    own_conn = conn is None
    client = conn or _db_connect()
    try:
        with client.cursor() as cur:
            cur.execute("SELECT pg_advisory_unlock(hashtextextended(%s,0))", (lock_key,))
        if own_conn:
            client.commit()
    finally:
        if own_conn:
            client.close()


def with_external_call_guard(source, dataset, fn, circuit_source=None, api_name=None, token_fingerprint_value="none"):
    if not enabled():
        return fn()
    conn = _db_connect()
    lock_key = f"{_budget_source(source)}:{dataset or 'unknown'}:{_date_text()}"
    locked = False
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT pg_try_advisory_lock(hashtext('external_dataset:' || %s))", (lock_key,))
            locked = bool(cur.fetchone()[0])
        if not locked:
            raise ExternalCallGuardError("DATASET_LOCKED", "同一数据集正在由其他 Worker 请求中", _source_key(source), dataset)
        probe = _consume(conn, source, dataset, circuit_source, api_name, token_fingerprint_value)
        _record(source)
        result = fn()
        if probe.get("probe_token"):
            close_external_circuit(source, probe.get("probe_api_name") or api_name, token_fingerprint_value, probe.get("probe_token"))
        return result
    except Exception:
        if 'probe' in locals() and probe.get("probe_token"):
            try:
                release_external_circuit_probe(source, probe.get("probe_api_name") or api_name, token_fingerprint_value, 5, probe.get("probe_token"))
            except Exception:
                pass
        raise
    finally:
        if 'probe' in locals() and probe.get("concurrency_slot") is not None:
            try:
                release_external_call_slot(source, probe.get("api_name") or api_name, token_fingerprint_value,
                                           probe.get("concurrency_slot"), conn)
            except Exception:
                pass
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
    if "szse.cn" in host:
        return "szse"
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
    # total 要包含同一任务前序 Node/子进程已消耗的请求数，避免跨进程重置任务额度。
    return {"total": _run_call_count, "sources": dict(_stats["sources"])}


def _emit_stats():
    if enabled() and _stats["total"]:
        print(f"[external-call-stats] {json.dumps(get_external_call_stats(), ensure_ascii=False)}", file=sys.stderr)


atexit.register(_emit_stats)
