---
name: workbuddy-executor
description: Use this skill when the user mentions workbuddy, WorkBuddy or CodeBuddy, or asks to delegate coding execution to WorkBuddy/CodeBuddyCLI (DeepSeek) for repository investigation, implementation, targeted tests and handoff, with independent review and verification by the coordinating agent.
---

# WorkBuddy (CodeBuddyCLI) 协同执行闭环

用户指定 WorkBuddy 执行开发任务时，通过本地 `codebuddy.cmd` 把从现象到可验收改动的开发工作交给它。WorkBuddy 对排查、方案、实现、测试和交接负责，协调 Agent 定边界并独立验收。

## 1. 职责分工

- **WorkBuddy / CodeBuddyCLI（默认 `deepseek-v4.1-flash`）**负责在目标工作树读取仓库规则和权威文档，排查原因与影响入口，拟定局部方案并实施，补反例、跑定向回归，更新任务卡和受影响的权威文档。
- **协调 Agent**明确用户要的结果、已知业务口径、授权边界和验收条件。把相关证据与仓库指针交给 WorkBuddy，保留业务判断、敏感环境核对、关键差异审查和独立验收。

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

### Step 1：尽早派发完整工作（协调 Agent）

- 派发前完成仓库规定的必读项，核对任务归属和已有实现。提供用户现象、预期结果、手头已有的证据、相关入口、权限边界和验收条件。确认范围足以开始时立即派发，把源码定位、复现、根因分析和局部方案留给 WorkBuddy。等待期间可做授权范围内的只读取证和验收准备。
- 边界清楚时，一次委派 WorkBuddy 排查、提出并实施方案、跑定向回归、更新任务卡和权威文档。存在需要裁定的业务口径、鉴权、迁移或共享链路影响时，先委派它调查并提交证据、候选方案和待裁定项。协调 Agent 只裁定关键分歧，再用原会话继续实现。用户明确限定方案时按该方案派发。
- 只有协调 Agent 能读取的生产反馈、权限或敏感环境证据，由协调 Agent 在授权内核查，向 WorkBuddy 提供完成排查所需的脱敏证据。WorkBuddy 给出需要核实的假设和最小查询范围。复发问题由 WorkBuddy 对照既有事故与实际调用链，覆盖原失败入口和同类消费者。回归同时覆盖既有入口和失败入口，例如退市固定价案例同时核对总览、完整账户、导出和净值。[INC-0053](../../../docs/incidents/INC-0053-退市固定价未进入当前估值.md)
- WorkBuddy 或 CLI 报告具体阻塞时，先按原因补证据或续跑。仍无法委派且协调 Agent 有权处理时，只接手受阻的最小一步，记录原因和范围，其余开发继续由 WorkBuddy 执行。

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

1. WorkBuddy 按事项交回根因及文件位置、方案、实际改动、测试命令与结果、文档位置和未验项。记录会话 ID（可得时）及协调 Agent 实际承担的步骤。交付时按事实说明分工，只有实现由 WorkBuddy 完成时，就说明它负责实现。完整日志保留在原位置，摘要提供定位信息。
2. 协调 Agent 独立检查 `git status`、差异清单和关键 diff，核对实现是否符合业务规则、是否越界，以及关键契约、权限、数据质量和失败分支是否保持正确。检查相应反例，确认测试没有跳过、弱化断言或吞掉异常。遇到证据冲突时再展开相关源码和日志。
3. 协调 Agent 独立复跑能证明原问题修复和关键边界的测试。WorkBuddy 已通过的其余专项，按仓库规则核对当前代码树、测试环境和结果证据后采用。影响边界不清、代码在测试后变化、证据不全或出现回归时，补跑受影响的检查。

### Step 4：打回重改（Loop）
若阶段验收不通过（回归测试失败、diff 存在上述隐患、不符合规范）：
- 已知会话 ID 时，续跑在上方命令中加 `--resume <session-id>`。只在确认最近会话就是本任务时用 `-c`。审查意见同样通过 UTF-8 标准输入传递。本机曾用多行位置参数续跑，执行方只收到开头；若它报告缺少审查条目，先按标准输入重发并检查收到的条目，再继续验收。
- 打回时给出失败现象、证据、必须满足的合同和复验条件，让 WorkBuddy 自行定位并提出修法。协调 Agent 裁定业务或权限边界上的问题。修复后回到 **Step 3** 重新验收，直到相关回归通过。

### Step 5：开发交接与发布验证（协调 Agent）
按 `AGENTS.md` 与部署流程的测试分级完成交接。普通开发交接保留专项和关联回归，发布全量在最终整合树执行或按规则复用。发现回归及时返回 Step 4。
