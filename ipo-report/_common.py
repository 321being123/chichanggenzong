"""ipo-report 共用样板工具（收口重复定义，避免分叉）。

集中放置 4+ 脚本里原本各自复制的样板：
  - shlex_quote / ssh_run（远程执行，inspect / verify_* 同款）
  - _load_env（加载 .env，统一查脚本同级与父目录）
  - _tushare（零依赖 REST 调用）
  - psql_run（本地 psql 执行，临时文件避免 GBK 截断）
密码不在本模块硬编码：ssh_run 从环境变量 SERVER_PASS 读取。
"""
import os
import json
import urllib.request
import tempfile
import subprocess
import shutil

# ============ 引号转义（4 份脚本完全一致） ============
def shlex_quote(s):
    return "'" + s.replace("'", "'\\''") + "'"


# ============ 远程执行（与 inspect / verify_* 同款，返回 out, err, status） ============
def ssh_run(client, cmd, sudo=False, timeout=300):
    """远程执行命令，返回 (stdout, stderr, exit_status)。sudo=True 用 SERVER_PASS 提权。"""
    passwd = os.environ.get("SERVER_PASS", "")
    if sudo:
        full = f"echo {passwd} | sudo -S bash -c {shlex_quote(cmd)}"
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
TUSHARE_TOKEN = os.environ.get("TUSHARE_TOKEN", "")


# ============ Tushare REST 调用（零依赖，不依赖 tushare 库） ============
def _tushare(api_name, params, fields):
    body = json.dumps({
        "api_name": api_name,
        "token": TUSHARE_TOKEN,
        "params": params,
        "fields": fields,
    }).encode("utf-8")
    req = urllib.request.Request(
        "http://api.tushare.pro",
        data=body,
        headers={"Content-Type": "application/json"},
    )
    resp = urllib.request.urlopen(req, timeout=30)
    d = json.loads(resp.read().decode("utf-8"))
    if d.get("code") != 0:
        raise RuntimeError(f"Tushare {api_name} 错误: {d.get('msg')}")
    f = d["data"]["fields"]
    rows = d["data"]["items"]
    return [dict(zip(f, r)) for r in rows]


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
