#!/usr/bin/env python3
"""通过 SSH 密钥部署生产环境（服务器已关闭密码登录，2026-07-31 起用密钥+免密 sudo）。

反馈闭环接入（2026-10-23）：代码部署成功后，可传入已准备好的反馈发布批次
（--feedback-run-id）执行专项验收后的回写；回写与代码部署分开报告、互不牵连：
代码部署失败仍按原非零规则退出，回写失败不影响已成功的代码部署，但会明确报告未闭环。
"""

import json
import os
import re
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
FEEDBACK_SCRIPT = "server/scripts/reconcileFeedbackRelease.js"


def parse_deploy_args(argv):
    """解析反馈发布相关参数；不改变既有 --confirm-production 的必需性。"""
    opts = {"feedback_run_id": None, "deployment_id": None, "operator": os.environ.get("DEPLOY_OPERATOR")}
    index = 0
    while index < len(argv):
        token = argv[index]
        value = argv[index + 1] if index + 1 < len(argv) else None
        if token == "--feedback-run-id" and value:
            opts["feedback_run_id"] = value
            index += 2
            continue
        if token == "--deployment-id" and value:
            opts["deployment_id"] = value
            index += 2
            continue
        if token == "--deploy-operator" and value:
            opts["operator"] = value
            index += 2
            continue
        index += 1
    if opts["feedback_run_id"] is not None and not re.fullmatch(r"\d{1,18}", str(opts["feedback_run_id"])):
        raise SystemExit("参数错误：--feedback-run-id 必须是数字编号")
    if opts["deployment_id"] is not None and not re.fullmatch(
        r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", str(opts["deployment_id"])
    ):
        raise SystemExit("参数错误：--deployment-id 必须是 UUID")
    return opts


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
    if args[:2] == ['git', 'fetch'] and os.name == 'nt':
        args = ['git', '-c', 'core.sshCommand=C:/Windows/System32/OpenSSH/ssh.exe', *args[1:]]
    result = subprocess.run(args, cwd=ROOT, text=True, capture_output=True, encoding='utf-8', errors='replace')
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


def apply_feedback_release(client, run_id, operator, deployment_id, current_sha, current_version):
    """代码部署成功之后的第二段：专项验收后的反馈回写。

    单独捕获错误：失败不触发第一段的代码回滚，也不重跑迁移；
    返回结构化结果供最终输出区分 code_deployed / feedback_applied。
    运行身份必须是真实的内容管理员账号（--deploy-operator），伪造身份会被服务端拒绝；
    同时把本次部署批次与当前运行提交/版本传给受控命令，避免旧清单套到新代码上。
    """
    if not operator:
        return {
            "feedback_applied": False,
            "reason": "缺少 --deploy-operator（必须是网站上的内容管理员账号），反馈闭环未执行",
            "items": [],
        }
    if not deployment_id:
        return {
            "feedback_applied": False,
            "reason": "缺少 --deployment-id（发布批次必须与本次部署一一对应），反馈闭环未执行",
            "items": [],
        }
    operator_arg = shlex.quote(str(operator))
    # B-01：--current-sha / --current-version 只做交叉核对；
    # 服务端会在锁内自行读取真实运行提交与版本，参数无法覆盖。
    extra = f" --deployment-id {shlex.quote(str(deployment_id))}"
    if current_sha:
        extra += f" --current-sha {shlex.quote(str(current_sha))}"
    if current_version:
        extra += f" --current-version {shlex.quote(str(current_version))}"
    command = (
        "cd /opt/portfolio && "
        "sudo -u portfolio-app env FEEDBACK_ENV_FILE=/opt/portfolio/.env "
        f"/usr/bin/node {FEEDBACK_SCRIPT} --mode apply --run-id {int(run_id)} --operator {operator_arg}{extra}"
    )
    try:
        wrapped = "sudo bash -c " + shlex.quote(command)
        stdin, stdout, stderr = client.exec_command(wrapped, timeout=600)
        output = stdout.read().decode("utf-8", "replace")
        error = stderr.read().decode("utf-8", "replace")
        exit_code = stdout.channel.recv_exit_status()
    except Exception as exc:  # 通道异常也要如实报告未闭环
        return {"feedback_applied": False, "reason": f"反馈回写调用失败：{exc}", "items": []}
    payload = None
    try:
        payload = json.loads(output)
    except Exception:
        payload = None
    if exit_code != 0 or not payload:
        reason = (error or output or "未返回结果").strip()[:500]
        return {"feedback_applied": False, "reason": f"反馈回写失败（退出码 {exit_code}）：{reason}", "items": []}
    pending = [
        item.get("feedbackId")
        for item in payload.get("items", [])
        if item.get("applyStatus") not in ("applied", "skipped")
    ]
    return {
        "feedback_applied": payload.get("applyStatus") == "applied" and not pending,
        "apply_status": payload.get("applyStatus"),
        "applied": payload.get("applied", 0),
        "failed": payload.get("failed", 0),
        "pending": pending,
        "items": payload.get("items", []),
    }


def main():
    opts = parse_deploy_args(sys.argv[1:])
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
        # Worker 排空可能长时间没有 SSH 输出；连接保活不改变任务运行/停机时限。
        client.get_transport().set_keepalive(30)
        result = run_sudo(
            client,
            "set -Eeuo pipefail; cd /opt/portfolio; "
            "previous_commit=$(git rev-parse HEAD); "
            "backup_dir=$(mktemp -d /tmp/portfolio-deploy.XXXXXX); "
            "services_stopped=0; code_updated=0; python_deps_changed=0; nginx_config_changed=0; nginx_config_preexisting=0; deploy_complete=0; health_timer_preexisting=0; health_timer_enabled=0; health_timer_active=0; health_timer_masked=0; "
            "for unit in portfolio-server.service portfolio-worker.service portfolio-worker-health.service portfolio-worker-health.timer portfolio-db-backup.service portfolio-db-backup.timer portfolio-db-offsite-sync.service portfolio-db-offsite-sync.timer portfolio-db-restore-drill.service portfolio-db-restore-drill.timer portfolio-backup-alert@.service; do "
            "if test -e /etc/systemd/system/$unit || test -L /etc/systemd/system/$unit; then cp -a /etc/systemd/system/$unit $backup_dir/$unit; fi; done; "
            "if test -e /etc/nginx/conf.d/portfolio.conf || test -L /etc/nginx/conf.d/portfolio.conf; then cp -a /etc/nginx/conf.d/portfolio.conf $backup_dir/portfolio.conf; nginx_config_preexisting=1; fi; "
            "if test -e $backup_dir/portfolio-worker-health.timer || test -L $backup_dir/portfolio-worker-health.timer; then health_timer_preexisting=1; fi; "
            "if [ $health_timer_preexisting -eq 1 ]; then "
            "test \"$(systemctl is-enabled portfolio-worker-health.timer 2>/dev/null || true)\" != masked || health_timer_masked=1; "
            "systemctl is-enabled --quiet portfolio-worker-health.timer && health_timer_enabled=1 || true; "
            "systemctl is-active --quiet portfolio-worker-health.timer && health_timer_active=1 || true; fi; "
            "stop_unit_if_present() { systemctl cat \"$1\" >/dev/null 2>&1 || return 0; systemctl stop \"$1\"; }; "
            "rollback_deploy() { rc=$?; "
            "if [ -n \"${release_lock_pid:-}\" ]; then kill $release_lock_pid 2>/dev/null || true; fi; "
            "rollback_failed=0; "
            "if [ $deploy_complete -ne 1 ]; then "
            "echo '部署失败，正在恢复部署前版本和服务' >&2; "
            "if [ $code_updated -eq 1 ]; then git reset --hard $previous_commit || rollback_failed=1; npm ci --omit=dev || rollback_failed=1; fi; "
            "if [ $python_deps_changed -eq 1 ]; then /opt/portfolio/ipo-report/venv/bin/python -m pip install --disable-pip-version-check -r requirements.txt || rollback_failed=1; fi; "
            "if [ $nginx_config_changed -eq 1 ]; then "
            "if [ $nginx_config_preexisting -eq 1 ]; then install -m 0644 $backup_dir/portfolio.conf /etc/nginx/conf.d/portfolio.conf || rollback_failed=1; "
            "else rm -f /etc/nginx/conf.d/portfolio.conf || rollback_failed=1; fi; "
            "nginx -t >/dev/null 2>&1 && systemctl reload nginx || rollback_failed=1; fi; "
            "for unit in portfolio-server.service portfolio-worker.service portfolio-worker-health.service portfolio-worker-health.timer portfolio-db-backup.service portfolio-db-backup.timer portfolio-db-offsite-sync.service portfolio-db-offsite-sync.timer portfolio-db-restore-drill.service portfolio-db-restore-drill.timer portfolio-backup-alert@.service; do "
            "if test -e $backup_dir/$unit || test -L $backup_dir/$unit; then rm -f /etc/systemd/system/$unit; cp -a $backup_dir/$unit /etc/systemd/system/$unit || rollback_failed=1; "
            "else rm -f /etc/systemd/system/$unit || rollback_failed=1; fi; done; "
            "if ! test -e $backup_dir/portfolio-db-offsite-sync.timer && ! test -L $backup_dir/portfolio-db-offsite-sync.timer; then systemctl disable --now portfolio-db-offsite-sync.timer >/dev/null 2>&1 || true; fi; "
            "if ! test -e $backup_dir/portfolio-db-restore-drill.timer && ! test -L $backup_dir/portfolio-db-restore-drill.timer; then systemctl disable --now portfolio-db-restore-drill.timer >/dev/null 2>&1 || true; fi; "
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
            # 目标级发布锁：与反馈回写共用 advisory lock，代码部署/回写/回滚在同一串行边界内。
            # 当前服务器代码尚未含该脚本（首次发布）时降级提示，不阻断部署。
            "release_lock_pid=''; "
            "if [ -f /opt/portfolio/server/scripts/reconcileFeedbackRelease.js ]; then "
            "rm -f /tmp/portfolio-release-lock.ready; "
            "/usr/bin/node /opt/portfolio/server/scripts/reconcileFeedbackRelease.js --mode hold-lock --hold-ms 5400 --ready-file /tmp/portfolio-release-lock.ready >> /tmp/portfolio-release-lock.log 2>&1 & "
            "release_lock_pid=$!; "
            "for i in $(seq 1 90); do test -f /tmp/portfolio-release-lock.ready && break; sleep 1; done; "
            "test -f /tmp/portfolio-release-lock.ready || { echo '无法获取发布锁，中止部署' >&2; exit 11; }; "
            "else echo '提示：当前服务器代码尚不含发布锁，本次代码部署未参与串行边界'; fi "
            "&& git fetch origin "
            "&& git show origin/master:deploy/portfolio-worker.service | tee /etc/systemd/system/portfolio-worker.service >/dev/null "
            "&& git show origin/master:deploy/portfolio-server.service | tee /etc/systemd/system/portfolio-server.service >/dev/null "
            "&& systemctl daemon-reload "
            "&& systemctl start portfolio-db-backup.service "
            "&& test \"$(systemctl show -p Result --value portfolio-db-backup.service)\" = success "
            "&& services_stopped=1 "
            "&& stop_unit_if_present portfolio-worker-health.timer "
            "&& stop_unit_if_present portfolio-worker-health.service "
            "&& systemctl stop portfolio-worker.service "
            "&& systemctl stop portfolio-server.service "
            "&& code_updated=1 "
            "&& git reset --hard origin/master "
            "&& test \"$(git rev-parse HEAD)\" = " + shlex.quote(local_commit) + " "
            "&& nginx_config_changed=1 "
            "&& install -m 0644 deploy/nginx-portfolio.conf /etc/nginx/conf.d/portfolio.conf "
            "&& nginx -t "
            "&& systemctl reload nginx "
            "&& npm ci --omit=dev "
            "&& if ! git diff --quiet $previous_commit HEAD -- requirements.txt; then python_deps_changed=1; "
            "/opt/portfolio/ipo-report/venv/bin/python -m pip install --disable-pip-version-check -r requirements.txt "
            "&& /opt/portfolio/ipo-report/venv/bin/python -m pip check "
            "&& (/opt/portfolio/ipo-report/venv/bin/python -c 'import cv2' || (apt-get update -qq && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 && /opt/portfolio/ipo-report/venv/bin/python -c 'import cv2')); fi "
            "&& MIGRATION_ENV_FILE=/etc/portfolio/migration.env /usr/bin/node /opt/portfolio/server/scripts/runMigrations.js "
            "&& install -d -o portfolio-app -g portfolio-app -m 0750 /var/lib/portfolio /var/lib/portfolio/models /var/lib/portfolio/models/ipo /opt/portfolio/data "
            "&& install -d -o portfolio-app -g portfolio-app -m 0755 ipo-report/data ipo-report/history_reports ipo-report/individual "
            "&& chown -R portfolio-app:portfolio-app ipo-report/data ipo-report/history_reports ipo-report/individual "
            "&& (grep -q '^TRUST_PROXY=' .env "
            "&& sed -i 's/^TRUST_PROXY=.*/TRUST_PROXY=loopback/' .env "
            "|| printf '\\nTRUST_PROXY=loopback\\n' >> .env) "
            "&& if grep -q '^VISION_MODEL=agnes-2.0-flash$' .env; then sed -i 's/^VISION_MODEL=agnes-2.0-flash$/VISION_MODEL=agnes-2.5-flash/' .env; fi "
            "&& install -m 0644 deploy/portfolio-server.service /etc/systemd/system/portfolio-server.service "
            "&& install -m 0644 deploy/portfolio-worker.service /etc/systemd/system/portfolio-worker.service "
            "&& install -m 0644 deploy/portfolio-worker-health.service /etc/systemd/system/portfolio-worker-health.service "
            "&& install -m 0644 deploy/portfolio-worker-health.timer /etc/systemd/system/portfolio-worker-health.timer "
            "&& install -m 0644 deploy/portfolio-db-backup.service /etc/systemd/system/portfolio-db-backup.service "
            "&& install -m 0644 deploy/portfolio-db-backup.timer /etc/systemd/system/portfolio-db-backup.timer "
            "&& install -m 0644 deploy/portfolio-db-offsite-sync.service /etc/systemd/system/portfolio-db-offsite-sync.service "
            "&& install -m 0644 deploy/portfolio-db-offsite-sync.timer /etc/systemd/system/portfolio-db-offsite-sync.timer "
            "&& install -m 0644 deploy/portfolio-db-restore-drill.service /etc/systemd/system/portfolio-db-restore-drill.service "
            "&& install -m 0644 deploy/portfolio-db-restore-drill.timer /etc/systemd/system/portfolio-db-restore-drill.timer "
            "&& install -m 0644 deploy/portfolio-backup-alert@.service /etc/systemd/system/portfolio-backup-alert@.service "
        "&& systemctl daemon-reload "
            "&& systemctl enable portfolio-server.service portfolio-worker.service "
            "&& systemctl start portfolio-server.service portfolio-worker.service "
            "&& systemctl enable --now portfolio-worker-health.timer "
            # 迁移125需处理全量历史主档，启动耗时可能超过10秒；健康检查采用60秒有界轮询，避免服务已能启动却被过早回滚。
            "&& for i in $(seq 1 30); do curl -fsS http://127.0.0.1:3000/health >/dev/null 2>&1 && break; sleep 2; done "
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
        # 第二段：反馈回写。必须在代码部署成功边界之后独立执行与独立报告。
        feedback_result = {"feedback_applied": False, "reason": "未提供发布核对记录，反馈闭环未执行", "items": []}
        if opts["feedback_run_id"]:
            print(f"开始反馈回写：发布批次 {opts['feedback_run_id']}")
            feedback_result = apply_feedback_release(
                client,
                opts["feedback_run_id"],
                opts["operator"],
                opts["deployment_id"],
                local_commit,
                local_version,
            )
        summary = {
            "code_deployed": True,
            "commit": local_commit[:8],
            "app_version": local_version,
            "deployment_id": opts["deployment_id"],
            "feedback_run_id": opts["feedback_run_id"],
            "feedback_applied": bool(feedback_result.get("feedback_applied")),
            "feedback_reason": feedback_result.get("reason"),
            "feedback_pending": feedback_result.get("pending", []),
        }
        print("DEPLOY_RESULT=" + json.dumps(summary, ensure_ascii=False))
        if not summary["feedback_applied"]:
            print("注意：代码已部署成功，但反馈闭环未完成（不触发代码回滚），请按上述待续办编号继续处理。", file=sys.stderr)
    finally:
        client.close()


if __name__ == "__main__":
    main()
