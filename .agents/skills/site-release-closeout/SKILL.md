---
name: site-release-closeout
description: "存在小站（portfolio-server）上线发布，或上一次发布的反馈回写没闭环需要续办时使用：先判断是新发布还是只补回写，把反馈批次在生产变更前准备好，按现行流程部署、逐条验收反馈并回读，代码和反馈结果分别报告。只做开发、只查数据或用户没有明确发布口令时不要用本技能。"
---

# 存在小站发布与收尾闭环

适用：用户明确说「部署 / 上线 / 发布」，或上一次发布的反馈回写没有闭环需要续办。
两个分支的判断放在第一步，是因为它决定「能不能改版本、能不能推送」——代码已经上线、只是反馈没回写的，重发一版就是多余的生产变更。
不适用：仅开发、仅只读排查、仅文档修改。本技能不能扩大用户已有的部署或生产写入授权。

## 第一步：先选分支，不要混做

| 分支 | 触发 | 允许做什么 | 不允许做什么 |
|---|---|---|---|
| A 新发布 | 有代码/配置要上生产，用户说了部署 | 定版、验收、推送、部署、反馈回写 | 没有本批核对依据就部署 |
| B 只补回写 | 代码已经上线，只是上次反馈没回写或回读不符 | 只读核对、补应用、回读 | 改版本号、推送、重新部署、重跑迁移 |

判断依据只有一条：本次有没有新提交要上生产。只有反馈要补的，一律走 B。

## 前置

1. **确认发布范围**：哪些任务提交进本次发布。按任务卡和 `git log` 核对，不能用「工作区全部差异」或文件修改时间推断。
2. **读现行流程**：`docs/生产部署流程.md` 的当前步骤是唯一依据，不凭记忆拼命令。
3. **授权**：用户没说部署就不部署；说了就执行完整流程，不再二次追问。

## A 分支：新发布

1. **定版**：更新 `public/changelog.json`、`CHANGELOG.md`、`package.json` 的 `appVersion`（默认末位加一）。条目用大白话，带 `新增：` / `优化：` / `修复：` 前缀，顺序固定为 新增→优化→修复。
2. **本地验收**：相关专项测试 + `npm.cmd run test:all` + `npm.cmd run check:knowledge`。
3. **提交并固定发布身份**：精确 `git add <文件>`，禁止 `git add -A`；提交后记下 HEAD SHA 与 `appVersion`，生成 `--deployment-id`（UUID）。
4. **反馈核对准备（必须在部署之前完成）**：按 `docs/意见反馈与版本发布闭环研发方案_20261023.md` 的链路，用 `--mode read` **完整**读取待处理反馈与 revision（分页读完，`complete=true`），逐条判定完整解决 / 部分解决 / 未涉及 / 待核验；再 `prepare`（绑本次 deployment-id、发布 SHA、版本）→ `conclusions` → `freeze` → 专项验收后 `verify --pass`。拿不准的留「待核验」，不要为了清空而关单。
   - 确认本批**没有**相关反馈时，不要凭记忆下结论：写一份查询证据文件（`complete=true`、逐条候选给 `unrelated` 与理由、`queriedAt` 在 48 小时内、`releaseSha` 指向本次提交），交给部署脚本 `--feedback-none-evidence`。
5. **推送**：`git push` 到 master（脚本要求 HEAD 与 origin/master 完全一致）。
6. **部署**：只用 `docs/生产部署流程.md` 规定的入口，并带上核对依据——`--feedback-run-id <批次>` 或 `--feedback-none-evidence <证据文件>`。两者都不给，脚本会在**任何生产变更之前**退出，这是设计不是故障。
7. **读结论**：按 `DEPLOY_RESULT.feedback_status` 下结论，不要自己重算。只有 `applied_verified`（确有实施且逐条回读一致）、`applied_verified_no_implementation`（本批明细全为不相关，无实施）和 `crosschecked_no_related_feedback`（完整查询确认无候选）是完成态；`applied_with_pending`、`readback_mismatch`、`apply_status_rejected`、`no_items`、`apply_failed`、`read_failed`、`not_crosschecked`、`skipped_missing_*` 都算未闭环。

## B 分支：只补回写

1. 用 `--mode status --run-id <批次>` 确认批次仍属于当前线上提交与版本（`releaseSha`/`appVersion`/`deploymentId` 一致）、`verifyStatus=passed`。
2. 用 `--mode apply --run-id <批次> --operator <账号> --deployment-id <同一 UUID>` 补应用；不改版本、不 push、不重新部署。
3. 用 `--mode status` 回读：逐条看主状态、`implementedVersion`、`implementedReleaseSha`、`revision` 与本批事件数。
4. 回读不符（状态没变、没有实施版本、没有本批事件）就是**未闭环**，如实报告，不能用「已应用」代替「已确认」。

## 反馈状态的判定

只有同时满足才可标「已实施」：本批次真实发布、专项验收通过、清单含本条、结论为完整解决、已成功应用并回读确认。

以下都不算：代码部署成功、pending 为空数组、标题相似、批量关单、只生成了计划、CLI 打印 applied 但回读为空。

读不到反馈（超时、权限不足、分页未完成）必须记为「核对不完整」，不能当作「没有反馈」。

## 必须交代

- 运行版本与提交 SHA、三个 systemd 单元、`/health`、本次相关接口和页面的实际结果；
- 反馈逐条：编号、revision、判定、实施版本、回读结果；
- 未闭环项及其去向（谁接着办、按哪个入口）；
- 代码与反馈各自的成功 / 失败边界（允许「代码已部署、反馈待续办」）。

## 边界

- 不直接改 SQL 改状态，不为补回写重复部署代码或重跑迁移。
- 反馈环节失败不应回滚已成功部署的代码。
- 未实测的浏览器、真机、备份恢复能力不得宣称通过。
