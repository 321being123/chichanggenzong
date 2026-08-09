#!/usr/bin/env python3
"""通过 SSH 密钥部署生产环境（服务器已关闭密码登录，2026-07-31 起用密钥+免密 sudo）。"""

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
HOST = "82.156.125.47"
USER = "ubuntu"


def load_key():
    """加载本机 SSH 密钥（环境变量 SSH_KEY_PATH > 默认 ~/.ssh/server_login）。"""
    key_path = os.environ.get("SSH_KEY_PATH") or os.path.expanduser("~/.ssh/server_login")
    if not os.path.exists(key_path):
        raise SystemExit(f"未找到 SSH 密钥 {key_path}（服务器已关闭密码登录，必须用密钥）")
    return paramiko.Ed25519Key.from_private_key_file(key_path)


def run_sudo(client, command, timeout=240):
    """免密 sudo 执行（服务器 sudoers 已配置 NOPASSWD）。"""
    wrapped = "sudo bash -c " + shlex.quote(command)
    stdin, stdout, stderr = client.exec_command(wrapped, timeout=timeout)
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
    local_version = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["appVersion"]
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    known_hosts = os.environ.get("SSH_KNOWN_HOSTS")
    if known_hosts:
        client.load_host_keys(os.path.expanduser(known_hosts))
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    try:
        client.connect(
            HOST,
            username=USER,
            pkey=load_key(),
            timeout=20,
            auth_timeout=20,
            banner_timeout=20,
            look_for_keys=False,
            allow_agent=False,
        )
        run_sudo(
            client,
            "cd /opt/portfolio && git fetch origin && git reset --hard origin/master "
            "&& npm ci --omit=dev && pm2 startOrRestart deploy/ecosystem.config.js --update-env && pm2 save",
        )
        time.sleep(5)
        result = run_sudo(
            client,
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
