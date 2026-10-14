# AWH 自举研发（SELF_BOOTSTRAP）

Windows 上，Owner 明确派发 `zlpoot/agent-workflow-hub` 的普通研发 Issue 后，Codex 可自主修改、测试、Commit、App Push、发布普通 Draft PR 并回读。无需为每个研发 PR 创建 Strict Project/Work Item、approval receipt、独立 pin 或受保护 Builder launcher。该授权只覆盖派发的任务，不包含 Review、Merge、关闭 Issue、Release 或部署。

这复用已有 GitHub App Local Fast，不新增授权模块或 GitHub writer。正式受信交付采用 STRICT_DELIVERY；测试真实授权和完整产品链采用 PRODUCT_ACCEPTANCE（如 #94）。后两种模式继续验证真实外置批准、版本、身份和安全门禁，自举 PR 不能充当正式验收。

## 实际流程

使用 Node 24+、Git、现有 AWH Client，以及已有正常 `gh` 登录。App 模式仍通过正常登录读取 Owner/仓库/Issue/队列事实和 Git 读取远端；Push、Draft PR 创建/更新及交付回读使用 App token。已有 App 连接直接复用，不重复输入 PEM/App ID，不更改连接或安装范围。

先只读核对最新远端 main、Issue OPEN、本地分支/完整 diff/HEAD、现有队列及工作区。已有个人或 App 队列不能转换或覆盖；冲突时在 Git 外新 Clone 建立独立 common Git 状态，origin 必须指向本仓库。单纯增加同 common Git 的 worktree 不能隔离队列。保留原工作树和历史。

```powershell
# 在独立 clone 中，Owner 已明确授权该仓库和仅 #93 队列：
awh github-app preflight --repo zlpoot/agent-workflow-hub
awh local-fast bind --repo zlpoot/agent-workflow-hub --issues 93 --provider github-app --confirm --check 'pnpm typecheck' --check 'node --test tests/release-packaging.test.mjs'
awh local-fast flow status
awh local-fast flow next
Set-Location '<flow next 返回的 worktree>'
awh local-fast stage prepare
# 实现派发内容；已有提交可审计地 cherry-pick -x，原分支不改写。
# 使用该 worktree 自己的依赖/编译产物；新 HEAD 重新验证。
awh local-fast stage execute --title '<PR 标题>' --body '<UTF8 正文文件>' --message '<提交说明>'
```

Local Fast 固定分支为 `codex/local-fast-<issue>`。`bind` 和 `flow next` 使用现有真实身份、仓库权限及 Issue 检查；队列声明位于 `.awh/flow.json`，绑定/进度位于 common Git 的 `awh-local-fast`。一次 bind 不授予其他仓库、其他 Issue、App 扩权或合并权限。为自举 clone 使用的临时队列声明可通过该 clone 的 Git 本地 exclude 保持本地，不修改或删除历史状态。

`stage execute` 接受已提交修改，也会为未提交文件创建 Commit；随后执行主线 diff 检查及已配置的有界检查，确认同一 clean final HEAD，非 Force Push，创建或更新同一 Draft PR，并验证远端准确 HEAD、Bot 作者、仓库/分支和 Draft 状态。App 实时 Preflight 完整检查 Selected 集合，写入用单仓最小权限 token，失败不回退个人写入。

AWH 普通自举 PR 可追加 `--check 'pnpm test:self-bootstrap:local-fast'` 和 `--check 'pnpm test:self-bootstrap:github-app'`。这两个已有 pnpm 检查入口选择现有测试中的单 Issue 发布、有限范围/身份、准确 HEAD、失败/ACK 恢复和 App token/传输/Reviewer 门禁；三 Issue 连续推进、合并后推进、Watcher 合并与 Review Bridge 留给对应验收任务。完整回归不因此声称 PASS，安全测试断言不改写。调用链仍为 LocalFast.execute → deliveryDependencies.verify，单条检查的 300 秒上限不变；两个范围独立执行，不扩大验证器命令语法。

## 交接和停止点

普通 PR 写清 SELF_BOOTSTRAP 范围、准确 HEAD 和本地测试边界，说明没有正式 Builder Evidence、confirmed Handoff 或 CP Run/Event。原始日志留在 gitignored `.handoff/local-fast/checks`。Stage 成功后停止于 `AWAITING_INDEPENDENT_REVIEW`；ChatGPT 独立读取新 HEAD 的 diff/tests，以保存的独立 Reviewer 身份提交原生 Review。修复新 HEAD 后重新验证并重新 Review；Owner 授权 ChatGPT 合并并回读，Codex 不自行批准或合并。

**注意自动关闭引用：** 当前 Stage 正文固定添加 `Closes #<issue>`。#93 合并后仍需最终 main 五资产冻结与 Windows 离仓复核，因此必须保持 OPEN。交接必须提示 ChatGPT 在 Owner 授权的合并前正文调整中将自动关闭行改为 `Refs #93`，回读正文/closing references 后再合并；仅在正文另写“不要关闭”不会取消 GitHub 自动关闭。此文档不授权 Codex 绕过 Stage 修改正文或关闭 Issue。

## 阻塞与恢复

- 身份、权限、Selected 集合、分支或队列不符：保留现场，报告精确错误；Owner 处理真实权限，不能关掉检查或修改状态造假。
- 验证失败：本地 Commit/原始失败保留，修复后对新 HEAD 运行同一 Stage；不要复用旧 HEAD 报告。
- Push/PR 回读或 ACK 不确定：保留同一候选和 create-attempt/进度，先只读检查真实分支/PR。沿现有恢复路径继续，不 Force Push、不删除 marker、不创建替代 PR。`local_fast_pr_ack_unknown` 在不能确认时仍需停点。
- Strict 缺授权：仅当 Owner 明确要求普通 AWH 研发时使用 SELF_BOOTSTRAP；正式 Deliver、#94 安全功能验收仍按真实 Strict 流程处理，不能将自举声明变成 trust/receipt。

#93 原始 `b3dfd3c751e88582503f9fdd97603a9501016d09` 和 Windows 五资产 PASS 报告属于历史候选。迁移后新 HEAD 的检查单独记录；最终 RC 必须在修复合并后从 clean main 统一构建。Mac/跨平台、正式 Release 和生产 Cutover 在本轮均 NOTRUN。

相关入口：[Windows Local Fast](windows-local-fast.md)、[GitHub App 模式](windows-github-app.md)、[正式管理员 CLI](administrator-cli.md)。
