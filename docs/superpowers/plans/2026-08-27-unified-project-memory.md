# 统一项目记忆系统实施计划

> 范围：仅 `portfolio-server`（存在小站）。
> 设计依据：[统一项目记忆系统设计](../specs/2026-08-27-unified-project-memory-design.md)。

## 目标

把项目内的知识入口、变更路由、决策/故障/任务模板和自动检查落地；Codex 只以项目文件为长期记忆来源。WorkBuddy 与 CodeBuddy 共用同一仓库知识库，平台级接入状态明确标记，不猜测其配置方式。

## 任务 1：建立共享知识入口与结构

**文件：**
- 新增：`docs/知识索引.md`
- 新增：`governance/knowledge-map.json`
- 新增：`docs/decisions/README.md`
- 新增：`docs/incidents/README.md`
- 新增：`docs/tasks/README.md`
- 新增：`docs/tasks/active/.gitkeep`
- 新增：`docs/tasks/closed/.gitkeep`

**步骤：**
1. 写入知识分层、权威来源和所有 Agent 的固定开工/交付流程。
2. 以 JSON 定义路径、关键词、风险等级、必读/必更新文档和验证命令。
3. 写入 ADR、事故复盘、任务卡的最小模板及完成条件。
4. 用 Node 内置 JSON 解析确认路由文件合法。

## 任务 2：先写失败测试，再实现知识检查器

**文件：**
- 新增：`server/test/knowledge-governance.test.js`
- 新增：`scripts/check-knowledge.js`
- 修改：`package.json`

**步骤：**
1. 测试覆盖：有效路由能通过；影响架构的变更未更新架构文档时失败；更新后通过；JSON 或必需入口缺失时失败。
2. 先运行测试，确认因检查器不存在而失败。
3. 以 Node 内置模块实现检查器，支持 `--files` 和 `--base`；无变更参数时仅校验知识库完整性。
4. 增加 `npm.cmd run check:knowledge`，运行测试并确认通过。

## 任务 3：让 Codex 与 CI 强制使用该入口

**文件：**
- 新增：`.codex/config.toml`
- 修改：`AGENTS.md`
- 修改：`.github/workflows/ci.yml`

**步骤：**
1. 在项目级 Codex 配置中关闭原生记忆的读写，仅保留仓库知识库。
2. 在 `AGENTS.md` 追加简短强制流程：先读索引与路由，按命中项阅读/更新，交付前运行检查器；不改写原有架构规则。
3. 新增独立 CI 作业，以 PR 基线或上一个提交为比较基准运行检查器。
4. 静态检查 JavaScript，执行检查器的基础校验和路由校验。

## 任务 4：收尾验证与交付

**步骤：**
1. 检查 JSON、TOML 文本和 Git 差异。
2. 运行 `node server/test/knowledge-governance.test.js`、`npm.cmd run check:knowledge` 与 `npm.cmd run test:all`。
3. 不启动本地服务：本次只涉及文档、CI 和离线检查器，不改变运行时服务。
4. 仅提交本工作区新增/修改的治理文件；汇报 Codex 已生效项与其他平台待确认项。
