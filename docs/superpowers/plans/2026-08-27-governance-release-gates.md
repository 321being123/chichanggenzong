# 知识治理与发布门禁整改实施计划

> 设计依据：[统一项目记忆系统设计](../specs/2026-08-27-unified-project-memory-design.md)。
> 范围：仅 `portfolio-server` 的本地检查、Git 门禁、版本一致性、部署前置校验及本次盈亏修复收尾；不执行生产部署。

## 目标

把“规则存在但未被执行”的漏洞改成机械门禁：本地未提交改动也会触发知识路由；提交前不能绕过；版本记录必须完整一致；部署脚本只接受已推送、可追溯且经过检查的提交。

## 固定前提

1. Codex 项目必须从 `D:\Users\存在小站\portfolio-server` 打开。上级目录不是 Git 项目，无法自动加载项目级 `AGENTS.md` 与 `.codex/config.toml`；此项由用户在 Codex 项目设置中修正，并作为后续验收前置条件。
2. 不修改生产服务器、不执行 `deploy/deploy_password.py`，也不推送提交；线上部署仍须用户另行明确授权。
3. 仅改动以下治理相关文件及当前盈亏修复涉及的文件；不重构业务模块。

## 任务 1：让默认知识检查覆盖工作区

**文件：**
- 修改：`scripts/check-knowledge.js`
- 修改：`server/test/knowledge-governance.test.js`

**先写失败测试：**
1. 为“未传 `--files/--base/--staged` 时，检查未暂存、暂存和未跟踪文件的并集”写测试。
2. 使用临时 Git 仓库制造 `public/a.js` 未暂存改动，断言默认检查命中 `frontend` 并要求更新 `docs/技术架构.md`。
3. 运行该测试，确认旧逻辑因 `changedFiles=[]` 而错误通过。

**实现：**
1. 在检查器中增加读取工作区变更的函数：合并 `git diff`、`git diff --cached` 与 `git ls-files --others --exclude-standard` 的文件列表并去重。
2. 仅当用户显式提供 `--files`、`--base` 或 `--staged` 时保留原有对应范围；三者都未提供时使用工作区并集。
3. 保持输出中命中路由、文件与必更文档的提示格式。

**验证：**
1. 新增测试先红后绿。
2. `npm.cmd run check:knowledge -- --files public/shared/core-tables.js,server/test/positions-zero.test.js` 必须失败并明确要求 `docs/技术架构.md`。
3. 在文档同步后，`npm.cmd run check:knowledge` 必须按真实工作区变更给出结果。

## 任务 2：加入受版本控制的提交前门禁

**文件：**
- 新增：`.githooks/pre-commit`
- 新增：`scripts/install-git-hooks.js`
- 修改：`package.json`
- 修改：`server/test/knowledge-governance.test.js`

**先写失败测试：**
1. 断言安装脚本将 `core.hooksPath` 设置为 `.githooks`，且 Hook 调用 `node scripts/check-knowledge.js --staged`。
2. 在临时仓库暂存一个 `public/` 文件且未暂存架构文档，断言 Hook 非零退出。

**实现：**
1. Hook 只运行暂存范围的知识检查；失败时阻止提交，不执行自动修复或自动暂存。
2. 安装脚本使用 Git 配置当前仓库的 `core.hooksPath=.githooks`，并在非 Git 目录给出明确错误。
3. 在 `package.json` 新增 `setup:hooks`，让开发者可重复执行安装。
4. CI 仍是最终门禁；Hook 只是本地尽早反馈，不能替代 CI。

**验证：**
1. 新测试先红后绿。
2. `npm.cmd run setup:hooks` 后，`git config --get core.hooksPath` 返回 `.githooks`。
3. 使用临时索引/仓库验证缺文档提交被拒，补齐文档后允许通过。

## 任务 3：建立版本一致性检查与原子升级

**文件：**
- 修改：`add_changelog.py`
- 修改：`scripts/check-knowledge.js`
- 修改：`server/test/knowledge-governance.test.js`
- 必要时修改：`package.json`

**先写失败测试：**
1. 构造 `package.json` 与 `package-lock.json` 版本不一致的临时项目，断言知识检查失败并指出不一致字段。
2. 调用 `add_changelog.py --bump-package` 的测试副本，断言同步修改 `package.json` 和 `package-lock.json` 的顶层与根包版本。

**实现：**
1. 知识检查器校验 `package.json.version/appVersion`、`package-lock.json.version/packages[''].version`、`CHANGELOG.md` 最新版本和 `public/changelog.json` 最新版本一致。
2. 升级脚本一次性更新 package 文件与两份变更记录；任一输入异常就中止，不留下半更新文件。
3. 不在此任务中擅自升级依赖。

**验证：**
1. 每条新测试先红后绿。
2. 当前版本 `0.6.4.9` 的四处记录通过一致性检查。
3. 在本次修复发版时，递增到 `0.6.4.10` 并再次验证一致性。

## 任务 4：给部署脚本增加本地发布前置校验

**文件：**
- 修改：`deploy/deploy_password.py`
- 修改：`docs/生产部署流程.md`
- 新增或修改：部署脚本对应测试文件

**先写失败测试：**
1. 用可替换的 Git/命令执行器测试：工作区脏、分支不是 `master`、本地 HEAD 落后/领先 `origin/master`、知识检查失败、未带确认参数时均必须在 SSH 前失败。
2. 测试正常条件下将期望 SHA 与版本传入远端校验命令。

**实现：**
1. 要求显式 `--confirm-production`；只执行脚本本身不再具备部署意图。
2. SSH 前依次验证：干净工作区、`master` 分支、已 `git fetch origin`、`HEAD == origin/master`、知识检查通过、版本记录一致。
3. 读取本地完整提交 SHA；远端 `git reset --hard` 后必须与该 SHA 完全一致，再重启服务和检查健康版本。
4. 保留既有回滚逻辑与 systemd 验收；不新增任何绕过机制。
5. 文档同步命令和失败处理，明确“检查未通过不得连接生产服务器”。

**验证：**
1. 新测试先红后绿。
2. 本地执行不带确认参数只输出拒绝信息且不建立 SSH 连接。
3. 不执行真实线上部署。

## 任务 5：完成本次盈亏修复的版本与知识闭环

**文件：**
- 修改：`public/shared/core-tables.js`
- 修改：`server/test/positions-zero.test.js`
- 修改：`docs/技术架构.md`
- 修改：`package.json`、`package-lock.json`、`CHANGELOG.md`、`public/changelog.json`
- 视第 3 任务结果由 `add_changelog.py` 统一更新

**步骤：**
1. 在架构文档持仓计算章节写清：今日盈亏以行情“昨收/涨跌额”作为日内基准，不能使用持仓历史快照；快照只用于累计或成本类计算。
2. 保留已有回归测试：昨收等于现价时，即使历史快照不同，今日盈亏为 0；核查同一计算函数覆盖所有持仓类型。
3. 按统一工具升级到 `0.6.4.10`，补充用户可见修复说明。
4. 运行目标测试、`npm.cmd run check:knowledge`、`npm.cmd run test:all`。
5. 不启动本地服务、不推送、不部署；待用户明确授权后，才按生产流程继续提交、推送和部署。

## 交付验收

1. 默认 `check:knowledge` 不再显示“命中 0 条路由”而遗漏工作区业务改动。
2. 新机器或新克隆项目执行一次 `npm.cmd run setup:hooks` 后，暂存业务改动未同步知识文档时无法提交。
3. 发版文件出现任意版本漂移时，检查和部署前置校验都会失败。
4. 部署脚本在任何本地前置检查失败时不连接生产服务器；通过时也只部署与本地完全相同的已推送 SHA。
5. 本次“涨跌 0%、今日盈亏非 0”有回归测试、架构说明与版本记录，且全量测试通过。
