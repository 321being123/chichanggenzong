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
import urllib.request
import urllib.error
import urllib.parse
import time
import tempfile
import subprocess
import shutil

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


def _tushare(api_name, params, fields):
    """统一入口：直连 Tushare Pro POST API。"""
    if not TUSHARE_TOKEN:
        raise RuntimeError("TUSHARE_TOKEN 未配置")
    body = json.dumps({
        "api_name": api_name,
        "token": TUSHARE_TOKEN,
        "params": params or {},
        "fields": fields or "",
    }).encode("utf-8")
    request = urllib.request.Request(
        "https://api.tushare.pro",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if payload.get("code") != 0:
        raise RuntimeError(f"Tushare {api_name} 错误: {payload.get('msg') or payload.get('code')}")
    data = payload.get("data") or {}
    fields_out = data.get("fields")
    items = data.get("items")
    if not isinstance(fields_out, list) or not isinstance(items, list):
        raise RuntimeError(f"Tushare {api_name} 响应结构异常")
    if any(not isinstance(row, list) or len(row) != len(fields_out) for row in items):
        raise RuntimeError(f"Tushare {api_name} 字段与数据列数不一致")
    return [dict(zip(fields_out, row)) for row in items]


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
    if not TUSHARE_TOKEN:
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
