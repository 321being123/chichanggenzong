"""ipo-report 共用样板工具（收口重复定义，避免分叉）。

集中放置 4+ 脚本里原本各自复制的样板：
  - shlex_quote / ssh_connect / ssh_run（远程执行，inspect / verify_* 同款）
  - _load_env（加载 .env，统一查脚本同级与父目录）
  - _tushare（零依赖 REST 调用）
  - psql_run（本地 psql 执行，临时文件避免 GBK 截断）
登录方式：SSH 用密钥（默认 ~/.ssh/server_login，可用环境变量 SSH_KEY_PATH 覆盖），
sudo 提权走免密（服务器 sudoers 已配置 NOPASSWD），全程不依赖密码。
"""
import os
import json
import re
import sys
import urllib.request
import urllib.error
import time
import tempfile
import subprocess
import shutil
from external_call_guard import (
    guarded_urlopen,
    open_external_circuit,
    close_external_circuit,
    release_external_circuit_probe,
    token_fingerprint,
    enabled,
)

# ============ 引号转义（4 份脚本完全一致） ============
def shlex_quote(s):
    return "'" + s.replace("'", "'\\''") + "'"


# ============ SSH 连接（密钥登录，2026-07-31 起服务器已关闭密码登录） ============
def ssh_connect(host="82.156.125.47", port=22, username="ubuntu", timeout=30):
    """用本机密钥连接服务器。密钥路径：环境变量 SSH_KEY_PATH > ~/.ssh/server_login。"""
    import paramiko
    key_path = os.environ.get("SSH_KEY_PATH") or os.path.expanduser("~/.ssh/server_login")
    if not os.path.exists(key_path):
        raise FileNotFoundError(f"未找到 SSH 密钥 {key_path}（服务器已关闭密码登录，必须用密钥）")
    key = paramiko.Ed25519Key.from_private_key_file(key_path)
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    known_hosts = os.environ.get("SSH_KNOWN_HOSTS")
    if known_hosts:
        client.load_host_keys(os.path.expanduser(known_hosts))
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.connect(host, port=port, username=username, pkey=key, timeout=timeout,
                   banner_timeout=timeout, auth_timeout=timeout,
                   look_for_keys=False, allow_agent=False)
    return client


# ============ 远程执行（与 inspect / verify_* 同款，返回 out, err, status） ============
def ssh_run(client, cmd, sudo=False, timeout=300):
    """远程执行命令，返回 (stdout, stderr, exit_status)。sudo=True 用免密 sudo 提权。"""
    if sudo:
        full = f"sudo bash -c {shlex_quote(cmd)}"
    else:
        full = f"bash -c {shlex_quote(cmd)}"
    stdin, stdout, stderr = client.exec_command(full, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    status = stdout.channel.recv_exit_status()
    return out, err, status


# ============ 加载 .env 环境变量（收口 4 份，统一查脚本同级 + 父目录） ============
def _load_env():
    cand = [
        os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env"),
    ]
    for p in cand:
        if os.path.exists(p):
            for line in open(p, encoding="utf-8"):
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, _, v = line.partition("=")
                    os.environ.setdefault(k.strip(), v.strip())


_load_env()
TUSHARE_TOKEN = os.environ.get("TUSHARE_TOKEN", "").strip()
TUSHARE_BACKUP_TOKEN = os.environ.get("TUSHARE_BACKUP_TOKEN", "").strip()
TUSHARE_TOKEN_MODE = os.environ.get("TUSHARE_TOKEN_MODE", "auto").strip().lower()
if TUSHARE_TOKEN_MODE not in {"auto", "primary", "backup"}:
    TUSHARE_TOKEN_MODE = "auto"


def _tushare_failover_eligible(error=None, message=""):
    code = getattr(error, "code", None)
    if code in {"AUTH_ERROR", "PERMISSION_DENIED", "RATE_LIMIT", "QUOTA_EXHAUSTED", "CIRCUIT_OPEN"}:
        return True
    if isinstance(error, urllib.error.HTTPError) and error.code in {401, 403, 429}:
        return True
    return bool(re.search(r"token|权限|permission|积分不足|没有接口|无权限|频率|频次|配额|rate.?limit|quota", str(message), re.I))


class TushareRequestError(RuntimeError):
    def __init__(self, code, message, source, api_name, fingerprint, recover_at=None):
        super().__init__(message)
        self.code = code
        self.error_type = "rate_limit" if code in {"RATE_LIMIT", "QUOTA_EXHAUSTED"} else "permission" if code in {"AUTH_ERROR", "PERMISSION_DENIED"} else "upstream"
        self.source = source
        self.api_name = api_name
        self.token_fingerprint = fingerprint
        self.recover_at = recover_at

    def __str__(self):
        return f"[{self.code}][{self.source}][{self.api_name}] {super().__str__()}"


def _emit_tushare_failover(api_name, error):
    recover_at = getattr(error, "recover_at", None)
    if hasattr(recover_at, "isoformat"):
        recover_at = recover_at.isoformat()
    payload = {
        "api_name": str(api_name or "")[:64],
        "from_role": "primary",
        "to_role": "backup",
        "reason": str(error or "接口不可用")[:240],
        "recover_at": recover_at,
    }
    print("[tushare-failover] " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")), file=sys.stderr, flush=True)


def _classify_tushare_error(code, message):
    text = str(message or "")
    if code in {401, 40101} or re.search(r"token\s*(无效|错误)|无效 token|invalid token", text, re.I):
        return "AUTH_ERROR"
    if code == 2002 or re.search(r"权限|permission|积分不足|没有接口|无权限", text, re.I):
        return "PERMISSION_DENIED"
    if re.search(r"当日|每日|当天|日频|次数.*耗尽|额度.*耗尽|配额.*耗尽|daily.*quota|daily.*limit", text, re.I):
        return "QUOTA_EXHAUSTED"
    if re.search(r"429|频率|频次|限速|配额|rate.?limit|quota", text, re.I):
        return "RATE_LIMIT"
    return "UPSTREAM_ERROR"


def _tushare(api_name, params, fields):
    """统一直连 Tushare Pro 官方 POST API。"""
    candidates = [(TUSHARE_TOKEN, "tushare"), (TUSHARE_BACKUP_TOKEN, "tushare_backup")]
    if TUSHARE_TOKEN_MODE == "primary":
        candidates = candidates[:1]
    elif TUSHARE_TOKEN_MODE == "backup":
        candidates = candidates[1:]
    candidates = [(token, source) for token, source in candidates if token]
    if not candidates:
        raise RuntimeError("当前 Tushare 模式未配置可用 Token")
    dataset = api_name + json.dumps(params or {}, ensure_ascii=False, separators=(',', ':')) + (fields or '')
    last_error = None
    primary_failure = None
    for index, (token, source) in enumerate(candidates):
        body = json.dumps({
            "api_name": api_name,
            "token": token,
            "params": params or {},
            "fields": fields or "",
        }).encode("utf-8")
        request = urllib.request.Request(
            "https://api.tushare.pro",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            fingerprint = token_fingerprint(token)
            with guarded_urlopen(
                request, timeout=30, source=source, dataset=dataset,
                api_name=api_name, token_fingerprint_value=fingerprint,
            ) as response:
                payload = json.loads(response.read().decode("utf-8"))
            if payload.get("code") != 0:
                message = payload.get("msg") or payload.get("code")
                error_code = _classify_tushare_error(payload.get("code"), message)
                recover_at = _recover_at(error_code) if enabled() else None
                if enabled() and error_code in {"AUTH_ERROR", "PERMISSION_DENIED", "RATE_LIMIT", "QUOTA_EXHAUSTED"}:
                    open_external_circuit(
                        source,
                        "*" if error_code == "AUTH_ERROR" else api_name,
                        fingerprint,
                        error_code,
                        f"Tushare {api_name} 错误: {message}",
                    )
                error = TushareRequestError(error_code, f"Tushare {api_name} 错误: {message}", source, api_name, fingerprint, recover_at)
                if index < len(candidates) - 1 and _tushare_failover_eligible(error=error, message=message):
                    last_error = error
                    primary_failure = error if source == "tushare" else primary_failure
                    continue
                raise error
            data = payload.get("data") or {}
            fields_out = data.get("fields")
            items = data.get("items")
            if not isinstance(fields_out, list) or not isinstance(items, list):
                raise RuntimeError(f"Tushare {api_name} 响应结构异常")
            if any(not isinstance(row, list) or len(row) != len(fields_out) for row in items):
                raise RuntimeError(f"Tushare {api_name} 字段与数据列数不一致")
            if enabled():
                close_external_circuit(source, api_name, fingerprint)
            if source == "tushare_backup" and primary_failure is not None:
                _emit_tushare_failover(api_name, primary_failure)
            return [dict(zip(fields_out, row)) for row in items]
        except Exception as error:
            last_error = error
            if enabled():
                try:
                    release_external_circuit_probe(source, api_name, fingerprint)
                except Exception:
                    pass
            if index == len(candidates) - 1 or not _tushare_failover_eligible(error=error, message=str(error)):
                raise
            primary_failure = error if source == "tushare" else primary_failure
    raise last_error


class TusharePro:
    """兼容旧版 pro.xxx(**params) 代码，返回 pandas.DataFrame。"""

    def query(self, api_name, **params):
        fields = params.pop("fields", "")
        rows = _tushare(api_name, params, fields)
        import pandas as pd
        return pd.DataFrame(rows)

    def __getattr__(self, api_name):
        if api_name.startswith("_"):
            raise AttributeError(api_name)
        return lambda **params: self.query(api_name, **params)


def get_tushare_pro():
    if not (TUSHARE_TOKEN or TUSHARE_BACKUP_TOKEN):
        return None
    return TusharePro()


# ============ 本地 psql 执行（收口 2 份，临时文件避免 Windows GBK 截断） ============
PSQL = os.environ.get("PSQL_EXE") or shutil.which("psql") or (r"C:\pgsql\bin\psql.exe" if os.name == "nt" else "psql")
PGHOST = os.environ.get("PGHOST", "127.0.0.1")
PGPORT = os.environ.get("PGPORT", "5432")
PGUSER = os.environ.get("PGUSER", "postgres")
PGPASSWORD = os.environ.get("PGPASSWORD", "")
PGDATABASE = os.environ.get("PGDATABASE", "portfolio")


def psql_run(sql, ignore_error=False):
    fd, path = tempfile.mkstemp(suffix=".sql", prefix="ipo_")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fp:
            fp.write(sql)
        env = os.environ.copy()
        env["PGPASSWORD"] = PGPASSWORD
        env["PGCLIENTENCODING"] = "UTF8"  # 关键：强制 UTF-8 客户端编码
        p = subprocess.run(
            [PSQL, "-h", PGHOST, "-p", PGPORT, "-U", PGUSER, "-d", PGDATABASE,
             "-v", "ON_ERROR_STOP=1", "-f", path],
            capture_output=True, text=True, env=env, encoding="utf-8",
        )
    finally:
        try:
            os.remove(path)
        except Exception:
            pass
    if p.returncode != 0 and not ignore_error:
        print("PSQL 失败:", p.stderr)
        raise RuntimeError(p.stderr)
    return p
