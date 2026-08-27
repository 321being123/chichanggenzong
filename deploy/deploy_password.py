#!/usr/bin/env python3
"""通过 SSH 密钥部署生产环境（服务器已关闭密码登录，2026-07-31 起用密钥+免密 sudo）。"""

import json
import os
import shlex
import subprocess
import sys
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


def run_local(args):
    result = subprocess.run(args, cwd=ROOT, text=True, capture_output=True)
    if result.returncode:
        message = (result.stderr or result.stdout).strip()
        raise SystemExit(f"发布前置校验失败：{' '.join(args)}\n{message}")
    return result.stdout.strip()


def verify_release_ready():
    if '--confirm-production' not in sys.argv[1:]:
        raise SystemExit('拒绝部署：必须显式传入 --confirm-production，且取得用户线上部署授权。')
    if run_local(['git', 'status', '--porcelain']):
        raise SystemExit('发布前置校验失败：本地工作区存在未提交修改。')
    if run_local(['git', 'branch', '--show-current']) != 'master':
        raise SystemExit('发布前置校验失败：只能从 master 分支部署。')
    run_local(['git', 'fetch', 'origin'])
    local_commit = run_local(['git', 'rev-parse', 'HEAD'])
    remote_commit = run_local(['git', 'rev-parse', 'origin/master'])
    if local_commit != remote_commit:
        raise SystemExit('发布前置校验失败：本地 HEAD 必须与 origin/master 完全一致。')
    run_local(['npm.cmd', 'run', 'check:knowledge'])
    return local_commit


def main():
    local_commit = verify_release_ready()
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
        result = run_sudo(
            client,
            "set -Eeuo pipefail; cd /opt/portfolio; "
            "previous_commit=$(git rev-parse HEAD); "
            "backup_dir=$(mktemp -d /tmp/portfolio-deploy.XXXXXX); "
            "services_stopped=0; code_updated=0; deploy_complete=0; health_timer_preexisting=0; health_timer_enabled=0; health_timer_active=0; health_timer_masked=0; "
            "for unit in portfolio-server.service portfolio-worker.service portfolio-worker-health.service portfolio-worker-health.timer; do "
            "if test -e /etc/systemd/system/$unit || test -L /etc/systemd/system/$unit; then cp -a /etc/systemd/system/$unit $backup_dir/$unit; fi; done; "
            "if test -e $backup_dir/portfolio-worker-health.timer || test -L $backup_dir/portfolio-worker-health.timer; then health_timer_preexisting=1; fi; "
            "if [ $health_timer_preexisting -eq 1 ]; then "
            "test \"$(systemctl is-enabled portfolio-worker-health.timer 2>/dev/null || true)\" != masked || health_timer_masked=1; "
            "systemctl is-enabled --quiet portfolio-worker-health.timer && health_timer_enabled=1 || true; "
            "systemctl is-active --quiet portfolio-worker-health.timer && health_timer_active=1 || true; fi; "
            "stop_unit_if_present() { systemctl cat \"$1\" >/dev/null 2>&1 || return 0; systemctl stop \"$1\"; }; "
            "rollback_deploy() { rc=$?; "
            "rollback_failed=0; "
            "if [ $deploy_complete -ne 1 ]; then "
            "echo '部署失败，正在恢复部署前版本和服务' >&2; "
            "if [ $code_updated -eq 1 ]; then git reset --hard $previous_commit || rollback_failed=1; npm ci --omit=dev || rollback_failed=1; fi; "
            "for unit in portfolio-server.service portfolio-worker.service portfolio-worker-health.service portfolio-worker-health.timer; do "
            "if test -e $backup_dir/$unit || test -L $backup_dir/$unit; then rm -f /etc/systemd/system/$unit; cp -a $backup_dir/$unit /etc/systemd/system/$unit || rollback_failed=1; "
            "else rm -f /etc/systemd/system/$unit || rollback_failed=1; fi; done; "
            "systemctl daemon-reload || rollback_failed=1; fi; "
            "if [ $deploy_complete -ne 1 ] && [ $services_stopped -eq 1 ]; then "
            "systemctl restart portfolio-server.service portfolio-worker.service || rollback_failed=1; "
            "if [ $health_timer_preexisting -eq 1 ]; then "
            "systemctl unmask portfolio-worker-health.timer || rollback_failed=1; "
            "if [ $health_timer_masked -eq 1 ]; then systemctl stop portfolio-worker-health.timer || rollback_failed=1; systemctl mask portfolio-worker-health.timer || rollback_failed=1; "
            "else if [ $health_timer_enabled -eq 1 ]; then systemctl enable portfolio-worker-health.timer || rollback_failed=1; "
            "else systemctl disable portfolio-worker-health.timer || rollback_failed=1; fi; "
            "if [ $health_timer_active -eq 1 ]; then systemctl start portfolio-worker-health.timer || rollback_failed=1; "
            "else systemctl stop portfolio-worker-health.timer || rollback_failed=1; fi; fi; fi; "
            "sleep 5; "
            "systemctl is-active --quiet portfolio-server.service portfolio-worker.service || rollback_failed=1; "
            "if [ $health_timer_preexisting -eq 1 ]; then "
            "if [ $health_timer_masked -eq 1 ]; then test \"$(systemctl is-enabled portfolio-worker-health.timer 2>/dev/null || true)\" = masked || rollback_failed=1; "
            "else if [ $health_timer_enabled -eq 1 ]; then systemctl is-enabled --quiet portfolio-worker-health.timer || rollback_failed=1; "
            "else systemctl is-enabled --quiet portfolio-worker-health.timer && rollback_failed=1 || true; fi; "
            "if [ $health_timer_active -eq 1 ]; then systemctl is-active --quiet portfolio-worker-health.timer || rollback_failed=1; "
            "else systemctl is-active --quiet portfolio-worker-health.timer && rollback_failed=1 || true; fi; fi; fi; "
            "curl -fsS http://127.0.0.1:3000/health >/dev/null || rollback_failed=1; fi; "
            "case $backup_dir in /tmp/portfolio-deploy.*) rm -rf -- $backup_dir ;; esac; "
            "if [ $rollback_failed -ne 0 ]; then echo '严重：部署回滚未能恢复服务，请立即人工介入' >&2; exit 90; fi; "
            "exit $rc; }; "
            "trap rollback_deploy EXIT; "
            "git fetch origin "
            "&& git show origin/master:deploy/portfolio-worker.service | tee /etc/systemd/system/portfolio-worker.service >/dev/null "
            "&& git show origin/master:deploy/portfolio-server.service | tee /etc/systemd/system/portfolio-server.service >/dev/null "
            "&& systemctl daemon-reload "
            "&& services_stopped=1 "
            "&& stop_unit_if_present portfolio-worker-health.timer "
            "&& stop_unit_if_present portfolio-worker-health.service "
            "&& systemctl stop portfolio-worker.service "
            "&& systemctl stop portfolio-server.service "
            "&& code_updated=1 "
            "&& git reset --hard origin/master "
            "&& test \"$(git rev-parse HEAD)\" = " + shlex.quote(local_commit) + " "
            "&& npm ci --omit=dev "
            "&& install -d -o portfolio-app -g portfolio-app -m 0755 ipo-report/data ipo-report/history_reports ipo-report/individual "
            "&& chown -R portfolio-app:portfolio-app ipo-report/data ipo-report/history_reports ipo-report/individual "
            "&& (grep -q '^TRUST_PROXY=' .env "
            "&& sed -i 's/^TRUST_PROXY=.*/TRUST_PROXY=loopback/' .env "
            "|| printf '\\nTRUST_PROXY=loopback\\n' >> .env) "
            "&& install -m 0644 deploy/portfolio-server.service /etc/systemd/system/portfolio-server.service "
            "&& install -m 0644 deploy/portfolio-worker.service /etc/systemd/system/portfolio-worker.service "
            "&& install -m 0644 deploy/portfolio-worker-health.service /etc/systemd/system/portfolio-worker-health.service "
            "&& install -m 0644 deploy/portfolio-worker-health.timer /etc/systemd/system/portfolio-worker-health.timer "
        "&& systemctl daemon-reload "
            "&& systemctl enable portfolio-server.service portfolio-worker.service "
            "&& systemctl start portfolio-server.service portfolio-worker.service "
            "&& systemctl enable --now portfolio-worker-health.timer "
            "&& sleep 10 "
            "&& systemctl is-active --quiet portfolio-server.service portfolio-worker.service portfolio-worker-health.timer "
            "&& systemctl is-enabled --quiet portfolio-server.service portfolio-worker.service portfolio-worker-health.timer "
            "&& health_json=$(curl -fsS http://127.0.0.1:3000/health) "
            "&& printf '%s' \"$health_json\" | grep -Fq '\"version\":\"" + local_version + "\"' "
            "&& printf 'commit=%s webpid=%s health=%s\\n' \"$(git rev-parse --short HEAD)\" \"$(systemctl show -p MainPID --value portfolio-server.service)\" \"$health_json\" "
            "&& deploy_complete=1",
            timeout=3600,
        )
        if f'"version":"{local_version}"' not in result:
            raise SystemExit(f"部署后版本校验失败，期望 {local_version}。")
        print("部署完成。")
    finally:
        client.close()


if __name__ == "__main__":
    main()
