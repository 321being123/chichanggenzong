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
import uuid
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
    opts = {"feedback_run_id": None, "deployment_id": None, "operator": os.environ.get("DEPLOY_OPERATOR"),
            "feedback_none_evidence": os.environ.get("DEPLOY_FEEDBACK_NONE_EVIDENCE")}
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
        if token == "--feedback-none-evidence" and value:
            opts["feedback_none_evidence"] = value
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


# 「确认无相关反馈」的证据要求：查询必须完整、结论必须逐条显式、时效与提交都要对得上。
# 只有两种可接受的核对依据，缺一不可（2026-10-30 复查 P1：此前缺依据也照样完成生产变更）。
FEEDBACK_EVIDENCE_MAX_AGE_HOURS = 48


def verify_none_evidence(evidence, commit, now=None):
    """校验「已完整查询、确认无相关反馈」的证据内容；返回问题清单（空 = 通过）。

    纯函数，反例测试直接调用，不依赖 SSH 或数据库。
    """
    problems = []
    if not isinstance(evidence, dict):
        return ["证据必须是 JSON 对象"]
    if evidence.get("complete") is not True:
        problems.append("查询未完整（complete 必须为 true，列表分页没读完不能作为证据）")
    if not str(evidence.get("operator") or "").strip():
        problems.append("缺少核对人（operator）")
    candidates = evidence.get("candidates")
    if not isinstance(candidates, list):
        problems.append("缺少 candidates 列表（即使是空列表也要显式给出）")
    else:
        for position, candidate in enumerate(candidates, start=1):
            if not isinstance(candidate, dict):
                problems.append(f"第 {position} 条候选格式不正确")
                continue
            conclusion = candidate.get("conclusion")
            if conclusion != "unrelated":
                problems.append(
                    f"第 {position} 条候选结论为 {conclusion or '空'}，只有 unrelated 且写明理由才可视为无相关反馈"
                )
            elif not str(candidate.get("reason") or "").strip():
                problems.append(f"第 {position} 条候选缺少不相关理由")
    queried_at = str(evidence.get("queriedAt") or "").strip()
    if not queried_at:
        problems.append("缺少查询时间（queriedAt）")
    else:
        try:
            from datetime import datetime, timedelta, timezone

            moment = datetime.fromisoformat(queried_at.replace("Z", "+00:00"))
            if moment.tzinfo is None:
                moment = moment.replace(tzinfo=timezone.utc)
            reference = now or datetime.now(timezone.utc)
            if reference - moment > timedelta(hours=FEEDBACK_EVIDENCE_MAX_AGE_HOURS):
                problems.append(
                    f"查询时间 {queried_at} 已超过 {FEEDBACK_EVIDENCE_MAX_AGE_HOURS} 小时，需重新查询后再发布"
                )
        except ValueError:
            problems.append(f"查询时间无法解析：{queried_at}")
    evidence_sha = str(evidence.get("releaseSha") or "").strip()
    if not evidence_sha:
        problems.append("缺少本次发布的提交（releaseSha）")
    elif commit and not _same_commit(evidence_sha, commit):
        problems.append(f"证据对应提交 {evidence_sha} 与本次发布 {commit} 不一致")
    return problems


def verify_feedback_requirement(opts, commit):
    """发布前防漏：必须带本批反馈核对依据，缺失或不合格一律在变更前阻止。"""
    if opts.get("feedback_run_id"):
        return
    evidence_path = opts.get("feedback_none_evidence")
    if not evidence_path:
        raise SystemExit(
            "发布前置校验失败：缺少本批反馈核对依据。\n"
            "请提供 --feedback-run-id（已冻结并通过专项验收的批次），"
            "或确认本次没有相关反馈后提供 --feedback-none-evidence <证据文件>。\n"
            "说明：代码可以照常发布，但必须先有核对依据，不能部署完再补说明。"
        )
    path = Path(evidence_path)
    if not path.exists():
        raise SystemExit(f"发布前置校验失败：反馈查询证据文件不存在：{evidence_path}")
    try:
        evidence = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise SystemExit(f"发布前置校验失败：反馈查询证据无法解析（{exc}）") from exc
    problems = verify_none_evidence(evidence, commit)
    if problems:
        raise SystemExit("发布前置校验失败：无相关反馈的证据不合格：\n- " + "\n- ".join(problems))


def verify_feedback_run_ready(client, run_id, commit):
    """部署前只读核查批次是否已冻结并通过验收；不合格则阻止生产变更。

    只读执行 --mode status，不写库、不改批次状态。核查项对应发布规范：
    批次必须已冻结、专项验收已通过、明细读取完整且非空、目标提交与本次一致。
    """
    command = (
        "cd /opt/portfolio && sudo -u portfolio-app env FEEDBACK_ENV_FILE=/opt/portfolio/.env "
        f"/usr/bin/node {FEEDBACK_SCRIPT} --mode status --run-id {int(run_id)}"
    )
    try:
        stdin, stdout, stderr = client.exec_command("sudo bash -c " + shlex.quote(command), timeout=120)
        output = stdout.read().decode("utf-8", "replace")
        error = stderr.read().decode("utf-8", "replace")
        exit_code = stdout.channel.recv_exit_status()
    except Exception as exc:
        raise SystemExit(f"发布前置校验失败：无法读取反馈批次 {run_id} 状态（{exc}），已中止部署") from exc
    if exit_code != 0:
        raise SystemExit(
            f"发布前置校验失败：读取反馈批次 {run_id} 失败（退出码 {exit_code}）："
            f"{(error or output or '无输出').strip()[:400]}"
        )
    try:
        payload = json.loads(output)
    except Exception as exc:
        raise SystemExit(f"发布前置校验失败：反馈批次状态不是合法 JSON（{exc}）") from exc
    run = payload.get("run") or {}
    items = payload.get("items") or []
    problems = []
    if payload.get("complete") is not True:
        problems.append("明细未读取完整（complete 不为 true）")
    if not items:
        problems.append("批次里没有任何反馈明细")
    if run.get("prepareStatus") != "frozen":
        problems.append(f"批次未冻结（prepareStatus={run.get('prepareStatus') or '空'}）")
    if run.get("verifyStatus") != "passed":
        problems.append(f"专项验收未通过（verifyStatus={run.get('verifyStatus') or '空'}）")
    if run.get("applyStatus") == "applied":
        problems.append("该批次已应用过，重复应用会把上一批结果套到本次发布")
    run_sha = run.get("releaseSha")
    if commit and run_sha and not _same_commit(run_sha, commit):
        problems.append(f"批次目标提交 {run_sha} 与本次发布 {commit} 不一致")
    if problems:
        raise SystemExit(
            f"发布前置校验失败：反馈批次 {run_id} 不满足发布条件：\n- " + "\n- ".join(problems)
        )
    print(f"反馈核对依据已核查：批次 {run_id}（{len(items)} 条明细，已冻结并通过验收）。")


def verify_release_ready(opts):
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
    # 反馈核对依据的本地部分（参数存在性 + 证据内容）在连服务器之前就拦，失败即不发起任何变更。
    verify_feedback_requirement(opts, local_commit)
    return local_commit


# 反馈闭环判定：只有「整体应用成功 + 明细齐全无待续办 + 真实回读一致」同时成立才算已核验。
# 2026-10-30 复查实测到两种误报（旧实现只看 items 里有没有 pending）：
#   ① applyStatus=failed 且 items=[] → 仍落 applied_verified（布尔值恰好是 False，状态却是已核验）；
#   ② applyStatus=applied 但 readBack 为空、主状态还是 new、没有版本/提交/事件 → 仍报 applied_verified。
# 因此判定必须同时看整体状态、目标明细和真实回读，任何一环缺失或不符都不得报已核验。
FEEDBACK_STATUS_VERIFIED = "applied_verified"
# 本批明细全部是「不相关」（skipped）时使用：闭环已完成，但没有需要实施的反馈，
# 不能与「确有实施且已回读核验」混为同一个状态。
FEEDBACK_STATUS_VERIFIED_NO_IMPLEMENTATION = "applied_verified_no_implementation"


def _same_commit(left, right):
    """提交号比较：允许一方是另一方的前缀（短 SHA 与全 SHA 混用时仍能判定一致）。"""
    left = str(left or "").strip().lower()
    right = str(right or "").strip().lower()
    if not left or not right:
        return False
    width = min(len(left), len(right))
    return left[:width] == right[:width]


def _verify_read_back_row(row, expected_sha, expected_version):
    """核对单条真实回读：状态、实施版本、实施提交、修订号、发布事件都要对得上。"""
    problems = []
    if row.get("status") != "implemented":
        problems.append(f"主状态仍为 {row.get('status') or '空'}")
    if not row.get("implementedVersion"):
        problems.append("没有实施版本")
    if not row.get("implementedReleaseSha"):
        problems.append("没有实施提交")
    elif expected_sha and not _same_commit(row.get("implementedReleaseSha"), expected_sha):
        problems.append(f"实施提交 {row.get('implementedReleaseSha')} 与本次部署 {expected_sha} 不一致")
    if expected_version and row.get("implementedVersion") and str(row.get("implementedVersion")) != str(expected_version):
        problems.append(f"实施版本 {row.get('implementedVersion')} 与本次部署 {expected_version} 不一致")
    revision = row.get("revision")
    if revision is None or str(revision).strip() == "":
        problems.append("没有修订号")
    try:
        event_count = int(row.get("eventCount") or 0)
    except (TypeError, ValueError):
        event_count = 0
    if event_count < 1:
        problems.append("没有发布事件留痕")
    return problems


def evaluate_feedback_release(payload, expected_sha=None, expected_version=None):
    """按回写结果与真实回读判定本批反馈是否闭环（纯函数，反例测试直接调用）。

    返回结构固定：feedback_applied / status / reason / pending / unverified /
    apply_status / applied / failed / items。
    """
    if not isinstance(payload, dict) or not payload:
        return {
            "feedback_applied": False,
            "status": "read_failed",
            "reason": "反馈回写没有返回可解析结果",
            "pending": [],
            "unverified": [],
            "items": [],
        }
    items = payload.get("items")
    if not isinstance(items, list):
        items = []
    apply_status = payload.get("applyStatus")
    base = {
        "apply_status": apply_status,
        "applied": payload.get("applied", 0),
        "failed": payload.get("failed", 0),
        "items": items,
    }
    # 1) 整体应用状态：不是 applied 就是没闭环，明细再怎么"看起来正常"也不能翻转结论。
    if apply_status != "applied":
        return {
            **base,
            "feedback_applied": False,
            "status": "apply_status_rejected",
            "reason": f"服务端整体应用状态为 {apply_status or '空'}，不是 applied，不能视为已闭环",
            "pending": [item.get("feedbackId") for item in items if isinstance(item, dict)],
            "unverified": [],
        }
    # 2) 明细必须存在：空清单无从证明实施或核对过。
    if not items:
        return {
            **base,
            "feedback_applied": False,
            "status": "no_items",
            "reason": "本批没有返回任何反馈明细，无法证明有反馈被应用或核对",
            "pending": [],
            "unverified": [],
        }
    # 3) 待续办：任何一条既不是 applied 也不是 skipped 都算未完成。
    pending = [
        item.get("feedbackId")
        for item in items
        if isinstance(item, dict) and item.get("applyStatus") not in ("applied", "skipped")
    ]
    if pending:
        return {
            **base,
            "feedback_applied": False,
            "status": "applied_with_pending",
            "reason": f"还有 {len(pending)} 条未应用完成",
            "pending": pending,
            "unverified": [],
        }
    # 4) 真实回读：只对声明已应用的条目要求，逐项核对状态/版本/提交/修订/事件。
    read_back = payload.get("readBack")
    if not isinstance(read_back, list):
        read_back = []
    index = {
        str(row.get("feedbackId")): row
        for row in read_back
        if isinstance(row, dict) and row.get("feedbackId") is not None
    }
    implemented = [
        item for item in items
        if isinstance(item, dict) and item.get("applyStatus") == "applied"
    ]
    unverified = []
    for item in implemented:
        feedback_id = str(item.get("feedbackId"))
        row = index.get(feedback_id)
        if row is None:
            unverified.append({"feedbackId": feedback_id, "reason": "回读里没有这一条"})
            continue
        problems = _verify_read_back_row(row, expected_sha, expected_version)
        if problems:
            unverified.append({"feedbackId": feedback_id, "reason": "；".join(problems)})
    if unverified:
        return {
            **base,
            "feedback_applied": False,
            "status": "readback_mismatch",
            "reason": "真实回读与预期不符：" + "；".join(
                f"{item['feedbackId']}（{item['reason']}）" for item in unverified[:5]
            ),
            "pending": [],
            "unverified": unverified,
        }
    if not implemented:
        # 全部为不相关项：闭环成立，但没有实施任何反馈，不能记成「已核验实施」。
        return {
            **base,
            "feedback_applied": True,
            "status": FEEDBACK_STATUS_VERIFIED_NO_IMPLEMENTATION,
            "reason": f"本批 {len(items)} 条全部为不相关项，已核对无待实施反馈",
            "pending": [],
            "unverified": [],
        }
    return {
        **base,
        "feedback_applied": True,
        "status": FEEDBACK_STATUS_VERIFIED,
        "reason": None,
        "pending": [],
        "unverified": [],
    }


def apply_feedback_release(client, run_id, operator, deployment_id, current_sha, current_version, lock_token):
    """代码部署成功之后的第二段：专项验收后的反馈回写。

    单独捕获错误：失败不触发第一段的代码回滚，也不重跑迁移；
    返回结构化结果供最终输出区分 code_deployed / feedback_applied。
    运行身份必须是真实的内容管理员账号（--deploy-operator），伪造身份会被服务端拒绝；
    同时把本次部署批次与当前运行提交/版本传给受控命令，避免旧清单套到新代码上。
    C-03：第一段的 hold-lock 进程仍持锁，这里必须携带 --held-lock-token / --held-lock-ready-file
    走“部署已持锁”通道，不得再抢同一把 advisory lock（否则自我死锁）。
    """
    if not operator:
        return {
            "feedback_applied": False,
            "status": "skipped_missing_operator",
            "reason": "缺少 --deploy-operator（必须是网站上的内容管理员账号），反馈闭环未执行",
            "items": [],
        }
    if not deployment_id:
        return {
            "feedback_applied": False,
            "status": "skipped_missing_deployment_id",
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
    # C-03：部署持锁凭证（ready 文件由第一段 setsid 的 hold-lock 进程持有）
    # D-01：凭证路径按部署批次隔离，等待中的第二发布者删不到本批凭证
    if lock_token:
        extra += (
            f" --held-lock-token {shlex.quote(str(lock_token))}"
            f" --held-lock-ready-file {shlex.quote(lock_ready_path(lock_token))}"
        )
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
        return {"feedback_applied": False, "status": "read_failed", "reason": f"反馈回写调用失败：{exc}", "items": []}
    payload = None
    try:
        payload = json.loads(output)
    except Exception:
        payload = None
    if exit_code != 0 or not payload:
        reason = (error or output or "未返回结果").strip()[:500]
        return {
            "feedback_applied": False,
            "status": "apply_failed",
            "reason": f"反馈回写失败（退出码 {exit_code}）：{reason}",
            "pending": [],
            "unverified": [],
            "items": [],
        }
    # 判定统一走 evaluate_feedback_release：整体状态、明细和真实回读三者一致才算已核验。
    return evaluate_feedback_release(payload, expected_sha=current_sha, expected_version=current_version)


def lock_ready_path(lock_token):
    """D-01：每个部署批次独立的凭证文件路径。

    共享 /tmp/portfolio-release-lock.ready 时，第二发布者启动前的 rm -f 会删掉
    第一发布者仍在使用的凭证，导致其反馈回写报“发布锁已丢失”。改为按令牌
    隔离后，等待者只清理自己的文件，永远碰不到持有者的凭证。
    """
    return f"/tmp/portfolio-release-lock.{lock_token}.ready"


def release_deploy_lock(client, lock_token):
    """部署收尾：释放第一段持有的发布锁（幂等）。必须在反馈第二段之后调用。"""
    if not lock_token:
        return
    command = (
        "cd /opt/portfolio && /usr/bin/node "
        f"{FEEDBACK_SCRIPT} --mode release-lock --ready-file {shlex.quote(lock_ready_path(lock_token))} "
        f"--token {shlex.quote(str(lock_token))}"
    )
    try:
        wrapped = "sudo bash -c " + shlex.quote(command)
        stdin, stdout, stderr = client.exec_command(wrapped, timeout=60)
        stdout.read()
        stderr.read()
        stdout.channel.recv_exit_status()
        print("发布锁已释放。")
    except Exception as exc:
        print(f"警告：发布锁释放失败（{exc}），持锁进程将在持有期满后自动释放。", file=sys.stderr)


def main():
    opts = parse_deploy_args(sys.argv[1:])
    # C-02/C-03：一次部署一个随机令牌，写入 ready 文件；反馈第二段与 release-lock 凭此证明同一次部署
    lock_token = uuid.uuid4().hex
    local_commit = verify_release_ready(opts)
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
        # 发布前防漏（2026-10-30 复查 P1）：带 --feedback-run-id 时，先在只读状态查询里
        # 确认批次已冻结、验收通过、明细完整且目标提交一致；不合格直接中止，
        # 不进入任何生产变更（此前是部署完才记 not_crosschecked）。
        if opts["feedback_run_id"]:
            verify_feedback_run_ready(client, opts["feedback_run_id"], local_commit)
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
            # C-03：发布锁【最后】释放——回滚期间必须持续持锁；成功路径留给 Python 在反馈第二段之后释放。
            "if [ $deploy_complete -ne 1 ] && [ -n \"${release_lock_pid:-}\" ]; then kill $release_lock_pid 2>/dev/null || true; fi; "
            "if [ $rollback_failed -ne 0 ]; then echo '严重：部署回滚未能恢复服务，请立即人工介入' >&2; exit 90; fi; "
            "exit $rc; }; "
            "trap rollback_deploy EXIT; "
            # 目标级发布锁：与反馈回写共用 advisory lock，代码部署/回写/回滚在同一串行边界内。
            # 当前服务器代码尚未含该脚本（首次发布）时降级提示，不阻断部署。
            "release_lock_pid=''; "
            "if [ -f /opt/portfolio/server/scripts/reconcileFeedbackRelease.js ]; then "
            # D-01：只清理【本批次】凭证文件；共享路径会让等待者删掉持有者的凭证
            f"rm -f {shlex.quote(lock_ready_path(lock_token))}; "
            # C-02：持有时间单位是秒（5400 秒 = 90 分钟，覆盖 3600 秒部署上限 + 600 秒反馈回写）；
            # setsid 让持锁进程脱离 SSH 会话存活到 Python 第二段结束（C-03）。
            "setsid /usr/bin/node /opt/portfolio/server/scripts/reconcileFeedbackRelease.js --mode hold-lock --hold-seconds 5400 "
            f"--ready-file {shlex.quote(lock_ready_path(lock_token))} --token {shlex.quote(lock_token)} "
            f">> /tmp/portfolio-release-lock.{lock_token}.log 2>&1 < /dev/null & "
            "release_lock_pid=$!; "
            f"for i in $(seq 1 90); do test -f {shlex.quote(lock_ready_path(lock_token))} && break; sleep 1; done; "
            f"test -f {shlex.quote(lock_ready_path(lock_token))} || {{ echo '无法获取发布锁，中止部署' >&2; exit 11; }}; "
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
        # C-04：未取到本批核对依据时记 not_crosschecked（未核对），不得冒充“确认没有反馈”。
        feedback_result = {
            "feedback_applied": False,
            "status": "not_crosschecked",
            "reason": "未提供 --feedback-run-id，本次没有本批反馈核对依据，反馈闭环未执行",
            "items": [],
        }
        if opts["feedback_run_id"]:
            print(f"开始反馈回写：发布批次 {opts['feedback_run_id']}")
            feedback_result = apply_feedback_release(
                client,
                opts["feedback_run_id"],
                opts["operator"],
                opts["deployment_id"],
                local_commit,
                local_version,
                lock_token,
            )
        summary = {
            "code_deployed": True,
            "commit": local_commit[:8],
            "app_version": local_version,
            "deployment_id": opts["deployment_id"],
            "feedback_run_id": opts["feedback_run_id"],
            "feedback_applied": bool(feedback_result.get("feedback_applied")),
            "feedback_status": feedback_result.get("status", "unknown"),
            "feedback_reason": feedback_result.get("reason"),
            "feedback_pending": feedback_result.get("pending", []),
        }
        print("DEPLOY_RESULT=" + json.dumps(summary, ensure_ascii=False))
        if not summary["feedback_applied"]:
            print(
                "注意：代码已部署成功，但反馈闭环未完成（状态 "
                + str(summary["feedback_status"])
                + "，不触发代码回滚），请按上述待续办编号继续处理。",
                file=sys.stderr,
            )
    finally:
        # C-03：发布锁【最后】释放——必须覆盖代码更新、失败回滚与反馈第二段全程。
        # release-lock 幂等；拿不到就记录告警，不改变部署退出语义。
        release_deploy_lock(client, lock_token)
        client.close()


if __name__ == "__main__":
    main()
