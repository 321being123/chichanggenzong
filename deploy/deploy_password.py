#!/usr/bin/env python3
"""通过腾讯云账户密码部署生产环境。"""

import json
import os
import shlex
import sys
import time
from pathlib import Path

for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(errors="backslashreplace")

try:
    import paramiko
except ImportError as exc:
    raise SystemExit("缺少部署依赖，请先执行：python -m pip install -r deploy/requirements-deploy.txt") from exc


ROOT = Path(__file__).resolve().parents[1]
ENV_FILE = ROOT / ".env"
HOST = "82.156.125.47"
USER = "ubuntu"


def read_env_value(name):
    if not ENV_FILE.exists():
        raise SystemExit("未找到项目根目录 .env，无法读取部署密码。")
    for raw_line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key.strip() != name:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        return value
    raise SystemExit(f".env 中未配置 {name}。")


def run_sudo(client, password, command, timeout=240):
    wrapped = "sudo -S -p '' bash -lc " + shlex.quote(command)
    stdin, stdout, stderr = client.exec_command(wrapped, timeout=timeout)
    stdin.write(password + "\n")
    stdin.flush()
    output = stdout.read().decode("utf-8", "replace")
    error = stderr.read().decode("utf-8", "replace")
    exit_code = stdout.channel.recv_exit_status()
    if output:
        print(output, end="")
    if error:
        print(error, end="", file=sys.stderr)
    if exit_code:
        raise SystemExit(exit_code)
    return output


def main():
    password = read_env_value("DEPLOY_SSH_PASSWORD")
    local_version = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["appVersion"]
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(
            HOST,
            username=USER,
            password=password,
            timeout=20,
            auth_timeout=20,
            banner_timeout=20,
            look_for_keys=False,
            allow_agent=False,
        )
        run_sudo(
            client,
            password,
            "cd /opt/portfolio && git fetch origin && git reset --hard origin/master "
            "&& npm ci --omit=dev && pm2 restart portfolio-server --update-env && pm2 save",
        )
        time.sleep(5)
        result = run_sudo(
            client,
            password,
            "cd /opt/portfolio && printf 'commit=' && git rev-parse --short HEAD "
            "&& printf 'pm2pid=' && pm2 pid portfolio-server "
            "&& curl -fsS http://127.0.0.1:3000/health",
            timeout=60,
        )
        if f'"version":"{local_version}"' not in result:
            raise SystemExit(f"部署后版本校验失败，期望 {local_version}。")
        print("部署完成。")
    finally:
        client.close()


if __name__ == "__main__":
    main()
