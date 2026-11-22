---
name: workbuddy-executor
description: Use this skill when the user mentions workbuddy, WorkBuddy or CodeBuddy, or asks to delegate coding execution to WorkBuddy/CodeBuddyCLI (DeepSeek) for repository investigation, implementation, targeted tests and handoff, with independent review and verification by the current agent.
---

# WorkBuddy (CodeBuddyCLI) 协同执行闭环

用户把开发工作交给 WorkBuddy 时，通过本地 `codebuddy.cmd` 委派一段有明确结果的工作。WorkBuddy 负责查、改、测和交接，Codex 负责定边界、复核关键判断并独立验收。

## 1. 职责分工

- **WorkBuddy / CodeBuddyCLI（默认 `deepseek-v4.1-flash`）**负责在目标工作树读取仓库规则和权威文档，排查原因与影响入口，拟定局部方案并实施，补反例、跑定向回归，更新任务卡和受影响的权威文档。
- **Codex**明确用户要的结果、已知业务口径、授权边界和验收条件。把相关证据与仓库指针交给 WorkBuddy，保留业务判断、敏感环境核对、关键差异审查和独立验收。

## 2. Windows 环境与调用前提

1. **必须使用 `.cmd` 入口**：Windows PowerShell 若禁用 `.ps1` 脚本执行，直接用 `codebuddy.cmd`（不要用 `codebuddy`）。
2. **确保工作目录正确**：执行前先 `cd` 到目标 Git 仓库或任务对应的 worktree 根目录，避免把外层工作区的临时文件当作源码。
3. **环境变量兜底（严禁打印密钥）**：若当前终端进程未继承最新环境变量，先在命令前加载用户变量：
   ```powershell
   if (-not $env:CODEBUDDY_API_KEY) { $env:CODEBUDDY_API_KEY = [Environment]::GetEnvironmentVariable('CODEBUDDY_API_KEY', 'User') }
   if (-not $env:CODEBUDDY_INTERNET_ENVIRONMENT) { $env:CODEBUDDY_INTERNET_ENVIRONMENT = [Environment]::GetEnvironmentVariable('CODEBUDDY_INTERNET_ENVIRONMENT', 'User') }
   ```
   - `CODEBUDDY_INTERNET_ENVIRONMENT` 应为 `internal`（国内版 WorkBuddy 接口）。
4. **明确本次模型**：同时传 `--model deepseek-v4.1-flash` 并为本次调用设置同值的进程变量 `CODEBUDDY_MODEL`。本机曾继承 `x-hy3`，请求实际报 `model [x-hy3] service info not found`。先检查本次进程模型，保留用户和系统环境变量原值。用户指定其他模型时，两处同改。

## 3. 标准执行闭环

### Step 1：定义结果与验收（Codex）

- 简述现象、预期结果、任务工作树、已知证据和允许范围。给出有关文档、事故或代码入口的指针。源码排查、局部设计和文件定位交给 WorkBuddy。
- 边界清楚的任务一次委派排查、实现、测试和交接。涉及业务口径歧义、鉴权、迁移或共享链路时，先让 WorkBuddy 返回带文件位置的根因、拟改范围和需要决定的事项。Codex 复核关键假设后，沿用同一会话执行。
- 遇到复发缺陷，要求 WorkBuddy 核对仓库已有规则、事故记录和实际调用链，检查已有规则覆盖了哪些入口。回归同时覆盖既有入口和失败入口。退市固定价案例同时核对总览、完整账户、导出和净值。 [INC-0053](../../../docs/incidents/INC-0053-退市固定价未进入当前估值.md)

### Step 2：派发执行（Executor）
在目标任务工作树中通过 UTF-8 标准输入传递完整任务。对用户已授权的无人值守文件编辑和定向测试，默认使用本次调用的 `-y`。先限任务目录、启用工具和允许的改动，提示词写清测试命令和边界。

```powershell
$previousModel = $env:CODEBUDDY_MODEL
$previousOutputEncoding = $OutputEncoding
try {
    $env:CODEBUDDY_MODEL = 'deepseek-v4.1-flash'
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $worktree = git rev-parse --show-toplevel
    if ($LASTEXITCODE -ne 0) { throw "无法识别任务工作树" }
    $task | codebuddy.cmd -p --model deepseek-v4.1-flash -y --tools Read,Edit,Write,Glob,Grep,PowerShell --add-dir $worktree
    $workbuddyExitCode = $LASTEXITCODE
} finally {
    $env:CODEBUDDY_MODEL = $previousModel
    $OutputEncoding = $previousOutputEncoding
}
```

- `$task` 是获授权的任务说明。无需运行命令时可从工具列表去掉 `PowerShell`。独立 worktree 和工具列表缩小运行范围，Shell 仍继承当前用户权限。提示词明确只改该任务工作树、只跑相关定向测试，保留部署、推送和生产写入的原授权边界。
- `acceptEdits` 是自动接受编辑模式。本机 CodeBuddy CLI 2.185.0 曾在无头会话仍对 `Edit` / `Write` 要求审批，报 `requires approval but permission prompts are not available in non-interactive mode`，CLI 甚至可能退出码为 0。遇到该提示先查 `git status` / `git diff`，再用上述无头方式续跑。
- `-y` 为本次调用跳过常规审批，高风险命令和受管策略仍可能挡住。官方用户级 `settings.json` 支持 `permissions.defaultMode = "bypassPermissions"`，会影响其他会话。项目流程使用单次参数即可，保持全局设置原样。若受管策略禁止绕过或仍要求审批，记录具体阻塞，保留现有授权边界。详见 [CodeBuddy 权限模式](https://www.codebuddy.cn/docs/cli/permission-modes)和[设置配置](https://www.codebuddy.ai/docs/zh/cli/settings)。

### Step 3：证据交接与独立验收

1. WorkBuddy 交回简短摘要，包含根因及文件位置、关键改动、实际执行的测试命令与结果、文档位置、未验项或阻塞。完整日志保留在原位置，摘要提供定位信息。
2. Codex 独立检查 `git status`、差异清单和关键 diff，核对实现是否符合业务规则、是否越界，以及关键契约、权限、数据质量和失败分支是否保持正确。检查相应反例，确认测试没有跳过、弱化断言或吞掉异常。遇到证据冲突时再展开相关源码和日志。
3. Codex 独立复跑能证明原问题修复和关键边界的测试。WorkBuddy 已通过的其余专项，按仓库规则核对当前代码树、测试环境和结果证据后采用。影响边界不清、代码在测试后变化、证据不全或出现回归时，补跑受影响的检查。

### Step 4：打回重改（Loop）
若阶段验收不通过（回归测试失败、diff 存在上述隐患、不符合规范）：
- 已知会话 ID 时，续跑在上方命令中加 `--resume <session-id>`。只在确认最近会话就是本任务时用 `-c`。审查意见同样通过 UTF-8 标准输入传递。本机曾用多行位置参数续跑，执行方只收到开头；若它报告缺少审查条目，先按标准输入重发并检查收到的条目，再继续验收。
- 修复后回到 **Step 3** 重新验收，直到所有问题解决、定向回归测试全部通过。

### Step 5：开发交接与发布验证（Coordinator）
按 `AGENTS.md` 与部署流程的测试分级完成交接。普通开发交接保留专项和关联回归，发布全量在最终整合树执行或按规则复用。发现回归及时返回 Step 4。
