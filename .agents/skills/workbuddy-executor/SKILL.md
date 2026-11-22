---
name: workbuddy-executor
description: Use this skill when the user mentions workbuddy, WorkBuddy or CodeBuddy, or asks to delegate coding execution to WorkBuddy/CodeBuddyCLI (DeepSeek) while the current agent handles planning, code review and verification.
---

# WorkBuddy (CodeBuddyCLI) 协同执行闭环

当用户提到使用 **WorkBuddy** / **CodeBuddy** / **DeepSeek 执行** 时，当前 Agent 担任 **规划与验收方（Coordinator）**，通过本地 `codebuddy.cmd` 调用 **执行方（Executor）** 完成代码修改，并形成“规划 → 执行 → 验收 → 打回重改”的自动闭环。

## 1. 职责分工

- **当前 Agent（Antigravity / Codex 等）**：
  - 负责需求分析、方案规划、明确改动边界与验收标准。
  - 负责派发任务给 `codebuddy.cmd`。
  - 负责最终验收（查看 `git diff`、运行测试/构建），不直接越过执行方大面积手写业务代码。
- **WorkBuddy / CodeBuddyCLI（默认 `deepseek-v4.1-flash`）**：
  - 负责在目标仓库内读取上下文、修改代码、按要求做局部自测。

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

### Step 1：规划（Coordinator）
- 先读取必要文件与仓库规则（如 `AGENTS.md`、相关文档/源码），制定清晰方案。
- 向用户简要确认或直接明确：
  - 目标文件与修改点
  - 禁止触碰的范围（如无关模块、历史数据、破坏性 Git 操作）
  - 验收标准（需要通过哪些测试或检查）
- 遇到复发缺陷，先核对仓库已有规则、事故记录和实际调用链。若一个入口已有规则，找出遗漏的入口并让它复用规则。回归同时覆盖已支持入口及本次失败入口。示例见 [INC-0053](../../../docs/incidents/INC-0053-退市固定价未进入当前估值.md)，持仓已有退市固定价时，应同时核对总览、完整账户、持仓导出和既有净值规则。

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

### Step 3：阶段验收（Coordinator）
`codebuddy.cmd` 退出后，**不要仅凭其文本输出下结论**，必须亲自核验：
1. 运行 `git status` 和 `git diff` 检查实际改动是否符合规划、是否有越界修改。
2. **检查代码质量、结构与常见隐患**：
   - **代码冗余与拆分**：是否存在重复逻辑（未复用现有 helper 或抽公共函数）、或把大量职责全堆进同一个大文件/超长函数；
   - **防“假通过”**：是否为了跑通测试而改松断言、跳过用例、或用空 `try/catch` 静默吞掉异常；
   - **契约与兼容性**：是否擅自改动公共 API 字段、函数签名、数据库结构或环境变量名；
   - **安全与敏感信息**：是否有硬编码密钥/Token、SQL 拼接注入、越权或未校验外部输入；
   - **性能与依赖污染**：是否有明显 N+1 查询/资源未释放/死循环风险，以及未经确认私自新增第三方依赖或修改锁文件/全局配置。
3. **定向回归测试**：本阶段仅运行受影响模块的回归测试、Lint 或类型检查，确认全部通过（暂不跑全量）。

### Step 4：打回重改（Loop）
若阶段验收不通过（回归测试失败、diff 存在上述隐患、不符合规范）：
- 已知会话 ID 时，续跑在上方命令中加 `--resume <session-id>`。只在确认最近会话就是本任务时用 `-c`。审查意见同样通过 UTF-8 标准输入传递。本机曾用多行位置参数续跑，执行方只收到开头；若它报告缺少审查条目，先按标准输入重发并检查收到的条目，再继续验收。
- 修复后回到 **Step 3** 重新验收，直到所有问题解决、定向回归测试全部通过。

### Step 5：开发交接与发布验证（Coordinator）
按 `AGENTS.md` 与部署流程的测试分级完成交接。普通开发交接保留专项和关联回归，发布全量在最终整合树执行或按规则复用。发现回归及时返回 Step 4。
