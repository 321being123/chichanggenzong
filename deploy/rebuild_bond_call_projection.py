#!/usr/bin/env python3
"""用本地已验证公告正文重建生产强赎投影，并补齐基线外的交易所公告。"""

import argparse
import gzip
import json
import os
import subprocess
import sys
from datetime import date
from pathlib import Path

import paramiko

for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(errors="backslashreplace")

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "deploy"))

from deploy_password import HOST, USER, load_key, run_sudo  # noqa: E402


def export_baseline() -> bytes:
    result = subprocess.run(
        ["node", "server/scripts/exportVerifiedBondCallFacts.js"],
        cwd=ROOT,
        capture_output=True,
        check=False,
    )
    if result.returncode:
        raise SystemExit((result.stderr or result.stdout).decode("utf-8", "replace"))
    payload = json.loads(result.stdout.decode("utf-8"))
    if payload.get("schemaVersion") != 1 or int(payload.get("count") or 0) < 200:
        raise SystemExit("本地验证基线数量异常，拒绝生产同步")
    print(
        f"本地验证基线：{payload['count']} 条，"
        f"{payload['baselineFrom']} 至 {payload['baselineTo']}"
    )
    return gzip.compress(result.stdout, compresslevel=9)


def upload_payload(client, content: bytes, remote_path: str) -> None:
    command = f"sudo tee {remote_path} >/dev/null"
    stdin, stdout, stderr = client.exec_command(command, timeout=240)
    stdin.write(content)
    stdin.channel.shutdown_write()
    output = stdout.read().decode("utf-8", "replace")
    error = stderr.read().decode("utf-8", "replace")
    exit_code = stdout.channel.recv_exit_status()
    if output:
        print(output, end="")
    if error:
        print(error, end="", file=sys.stderr)
    if exit_code:
        raise SystemExit(exit_code)
    run_sudo(client, f"chown portfolio-app:portfolio-app {remote_path} && chmod 600 {remote_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="重建生产强赎公告投影")
    parser.add_argument("--history-start", default="2024-09-01")
    parser.add_argument("--to-date", default=date.today().isoformat())
    parser.add_argument("--confirm-production", action="store_true")
    args = parser.parse_args()
    if not args.confirm_production:
        raise SystemExit("拒绝执行：必须显式传入 --confirm-production")
    try:
        history_start = date.fromisoformat(args.history_start).isoformat()
        to_date = date.fromisoformat(args.to_date).isoformat()
    except ValueError as error:
        raise SystemExit("日期必须为 YYYY-MM-DD") from error
    if history_start > to_date:
        raise SystemExit("history-start 不能晚于 to-date")

    compressed = export_baseline()
    remote_gzip = "/tmp/portfolio-bond-call-verified.json.gz"
    remote_json = "/tmp/portfolio-bond-call-verified.json"
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
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
    try:
        print("===== 生产备份 =====")
        run_sudo(
            client,
            "set -Eeuo pipefail; systemctl start portfolio-db-backup.service; "
            "test \"$(systemctl show -p Result --value portfolio-db-backup.service)\" = success; "
            "echo backup=ok",
            timeout=1800,
        )
        print("===== 上传本地验证基线 =====")
        upload_payload(client, compressed, remote_gzip)
        run_sudo(
            client,
            f"set -Eeuo pipefail; gzip -dc {remote_gzip} > {remote_json}; "
            f"chown portfolio-app:portfolio-app {remote_json}; chmod 600 {remote_json}",
        )
        print("===== 重建生产投影 =====")
        run_sudo(
            client,
            "set -Eeuo pipefail; cd /opt/portfolio; "
            f"sudo -u portfolio-app /usr/bin/node server/scripts/rebuildBondCallProjection.js "
            f"--baseline-json={remote_json} --history-start={history_start} --to-date={to_date} "
            "--apply --confirm-production",
            timeout=7200,
        )
    finally:
        try:
            run_sudo(client, f"rm -f {remote_gzip} {remote_json}")
        finally:
            client.close()


if __name__ == "__main__":
    main()
