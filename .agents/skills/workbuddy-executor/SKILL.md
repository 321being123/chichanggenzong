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

## 3. 标准执行闭环

### Step 1：规划（Coordinator）
- 先读取必要文件与仓库规则（如 `AGENTS.md`、相关文档/源码），制定清晰方案。
- 向用户简要确认或直接明确：
  - 目标文件与修改点
  - 禁止触碰的范围（如无关模块、历史数据、破坏性 Git 操作）
  - 验收标准（需要通过哪些测试或检查）

### Step 2：派发执行（Executor）
在目标仓库目录下以无头模式调用 `codebuddy.cmd`：

```powershell
codebuddy.cmd -p "<结构化任务指令：目标、涉及文件、约束、定向回归测试范围>" --model deepseek-v4.1-flash --permission-mode acceptEdits
```

- **模型选择**：固定默认使用 **DeepSeek-V4.1-Flash**（CLI 模型 ID 必须传小写 `--model deepseek-v4.1-flash`，勿写成其他变体）；仅当用户明确要求更换模型时才改传其他 `--model`。
- **权限模式**：
  - 仅需读写编辑文件时用 `--permission-mode acceptEdits`；
  - 需要执行测试/构建等命令时可用 `-y`（`--dangerously-skip-permissions`），并在 prompt 中明确禁止破坏性操作（如 `git reset --hard`、`push`、删库等）。
- **测试约束**：派发给 WorkBuddy 时，要求其**只跑受影响模块的定向回归测试/单测，不要跑全量测试**，加快迭代速度。

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
- 使用 `-c`（`--continue`）沿用上一轮会话上下文直接打回修复：
  ```powershell
  codebuddy.cmd -c -p "验收未通过，请修复以下问题：<具体报错输出 / diff 问题点 / 期望行为>" --model deepseek-v4.1-flash --permission-mode acceptEdits
  ```
- 修复后回到 **Step 3** 重新验收，直到所有问题解决、定向回归测试全部通过。

### Step 5：最终全量验收（Coordinator）
当 **Step 3 + Step 4** 所有问题已解决且代码审查通过后，由当前 Agent 按项目规范（如 `AGENTS.md` 中的测试要求）**最后统一跑一次全量测试**；全量通过后向用户汇报结果（若全量发现回归问题，再回到 Step 4 定向修复并重验）。
