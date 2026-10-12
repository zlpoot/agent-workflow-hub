# Windows M1 Fast Flow Quick Start

For Windows personal single-repository development without per-Issue administrator approval, use the explicit [Local Fast mode](windows-local-fast.md). This page describes the existing Strict/App delivery flow.

Human 在 Codex App 启动每个 Issue；Codex 在一个任务内完成实现、测试、Commit 和已有受信 Stage 交付。队列 `.awh/flow.json` 只有版本与 Issue 顺序，可以 Commit；进度来自原 Run/Event、Session/Journal/Receipt 和 GitHub 原生事实。队列、Issue、manifest 均不授予权限。

## 1. 安装、建仓库、一次性接入

准备 Git、Node.js 24+ 和独立核验的 Client/CP/Builder/Admin。安装和 CP 启动按 [Windows 指南](windows-product.md)、[发行包说明](release-windows.md)、[CP 配置](control-plane.md)，使用仓库外受保护目录、全新 SQLite/身份/配置。保留已有 CP/Viewer/Resident；本文不迁移生产。下面 `$awh` 指经核验安装的 Client `dist/client/cli.js`，也可使用安装后的 `awh`。

Human 在 GitHub 创建仓库（初始化 main 提交）和三个普通 Issue。将新仓库加入 GitHub App **selected repositories**；管理员独立批准完整 installation/selected-set、Reviewer 与授权人的 login/数值 ID。新增 GitHub 选中项不自动扩大 AWH 权限。

```powershell
$repo = 'owner/new-project' # 替换
$root = 'E:\projects\new-project'
git clone "https://github.com/$repo.git" $root
Set-Location $root
$awh = 'C:\AWH\client\dist\client\cli.js'
$machine = 'C:\AWH\machine\settings.json'
# 仅首次机器设置；已有配置时复用，保留 Machine 身份。
node $awh setup --machine-config $machine --home C:\AWH\machine --endpoint http://127.0.0.1:4310 --project-root E:\projects
node $awh init --machine-config $machine --directory $root --mode observe --confirm
```

先完成第 2 节的首次 Project/CP Profile 规划和新数据库初始化，再由独立 CP-owner 会话批准返回的 external request，完成接入：

```powershell
$cp = 'C:\AWH\cp\dist\control-plane-cli.js'
$request = '<返回的外部 request 文件>'
node $cp approve-project --request $request --database C:\AWH\cp\cp.sqlite --config C:\AWH\cp\trust.json
node $cp approve-project --request $request --database C:\AWH\cp\cp.sqlite --config C:\AWH\cp\trust.json --confirm
# 普通 Client 会话
node $awh init --machine-config $machine --directory $root --complete --confirm
$client = '<Enrollment 返回的外部 Client config>'
```

详见 [Enrollment](project-enrollment.md)。Observe 和 Develop/Deliver 批准独立；后续 worktree 使用管理员批准的 Client/Executor/Machine 绑定，不清空 Session 或另造身份。

## 2. 批准一次可复用 Project Policy

管理员按 [管理员 CLI](administrator-cli.md) 与 [Builder Policy](builder-policy.md) 在外部 `project.proposed.json` 包装现有 `builder_policy`，选择单仓库、`base: main`、`branch_mode: issue_prefix`、例如 `branch: codex/task-`、`work_item: { repo: owner/new-project, issue: 0 }`。**Profile/Workflow ref 复用 Enrollment request 的 `profile_ref`**（Observe 首次通常为 `observe/project-<实际id>`），不要在接入后改 manifest/CP Project 身份；名称含 observe 不代表 Deliver 权限。Executor/Machine 取同一个 request 的真实绑定。`bootstrap_paths` 由管理员明确选择 allowlist 或 `null`（普通工程代码）。配置该项目的有序验证命令；Project stages 为 `observe,develop,deliver`，permissions 为 `contents:write, issues:read, pull_requests:write`。

以下在已有独立 trust/pin 的受保护管理员会话执行；CLI 不创建正式 trust 或批准 pin：

```powershell
$admin = 'C:\AWH\admin\dist\admin-cli.js'
$adminRoot = 'C:\AWH-Admin'
node $admin inspect
node $admin diagnose
node $admin register --policy "$adminRoot\project.proposed.json" --version project-v1 --out "$adminRoot\project-v1.proposal.json"
node $admin validate --proposal "$adminRoot\project-v1.proposal.json"
node $admin approval-prepare --proposal "$adminRoot\project-v1.proposal.json" --receipt approve-project-v1 --reason 'Approve bounded project workflow' --out "$adminRoot\project-v1.receipt.proposed.json"
# 管理员独立核对 scope、字节、operator、时间和 expected state，
# 从受保护来源设置正式 AWH_ADMIN_APPROVAL_FILE / AWH_ADMIN_APPROVAL_SHA256。
node $admin approve --proposal "$adminRoot\project-v1.proposal.json" --confirm
```

本版 CP 不在正常启动时追加 immutable Profile。三个 Issue 的固定 Profile **一次性在全新 CP init 前准备**，例如版本 `issue1-v1,issue2-v1,issue3-v1`；后续精确 Work Item 批准使用这些名称，base SHA 仍在每项启动时从 GitHub 读取。下面只是管理员可信 CP 配置生成，不签发 Work Item/Provider 批准：

```powershell
# 独立管理员会话。文件取已批准 registry 的 immutable Project policy；
# 路径由原 inspect/受保护配置提供，不从仓库发现。
$approvedProjectFile = '<已批准 project-v1.policy.json 的外部路径>'
$project = Get-Content $approvedProjectFile -Raw | ConvertFrom-Json
$selection = $project.builder_policy.default_selection
$p = $project.builder_policy.profiles | Where-Object id -EQ $selection.profile
$w = $p.workflows | Where-Object id -EQ $selection.workflow
$enroll = Get-Content $request -Raw | ConvertFrom-Json
if ("$($p.id)/$($w.id)" -ne $enroll.profile_ref) { throw 'Project ref must match Enrollment' }
$issues = @(1,2,3) # 实际队列编号
$profiles = @($issues | ForEach-Object {
  @{ schema_version='1.0'; kind='profile_policy'; ref=$enroll.profile_ref;
     version="issue$_-v1"; repository=$p.repository; base=$p.base;
     branch=@{mode='fixed';ref="$($w.branch)$_"};
     verification=@{commands=@($w.verification_commands)};
     github_app=@{identity='installation';repository_scope='single';selected_set_policy='exact';
       permissions=@{contents='write';issues='write';metadata='read';pull_requests='write'}};
     review=@{mode='independent_exact_head';builder_is_reviewer=$false};
     delivery=@{draft_pr=$true;handoff_version='0.1';confirmed_publication_required=$true;exact_head_required=$true};
     executor_restrictions=@{executor_ids=@($enroll.executor_id);machine_ids=@($enroll.machine.id)} }
})
@{clients=@();profiles=$profiles;enrollments=@()} | ConvertTo-Json -Depth 20 |
  Out-File -FilePath C:\AWH\cp\trust.json -Encoding utf8NoBOM -NoClobber
# 管理员先核对配置/ACL；runtime.json 按 CP 文档指向这个 trust 与全新 SQLite。
node $cp init --runtime-config C:\AWH\cp\runtime.json
node $cp serve --runtime-config C:\AWH\cp\runtime.json
# 再回第 1 节执行 Enrollment approve-project → complete。
```

新 CP 的 `serve` 是前台进程，放在独立终端。以上 PowerShell 7 使用 `utf8NoBOM`。完整安装包和批准检查工具链须在受保护 runtime 中可用。需要新策略版本而当前 CP 未预置时，按现有独立部署 Gate 处理，不能向旧 SQLite 直接插入或重建业务记录。

`approval-prepare` 是提议，不能自行 hash 后注入批准环境。首次无 Run 时，受保护只读 launcher 可选择 `AWH_ADMIN_VERSION=project-v1` 运行 Flow。它用原 App metadata-only 完整 selected-set 检查，再申请单仓库 `contents/issues/pull_requests:read` token；没有交付写入能力。

## 3. 队列与 Work Item 标准批准步骤

```powershell
Set-Location $root
node $awh flow init --issues 1,2,3 # 替换为真实普通 Issue 编号
# 新仓库需要忽略原验证/恢复目录。
Add-Content .gitignore '.handoff/'
git add .awh/project.yaml .awh/flow.json .gitignore
git commit -m 'Declare AWH project and Issue queue'
```

首次 bootstrap 必须先通过已有合法 GitHub 开发身份发布到远端 main，才能生成第一项 Work Item/base SHA。选择下列一种路径；不使用 AWH Stage 发布 bootstrap：

- 新测试仓库 main 允许直推，且 Owner 已授权时：

```powershell
git push origin HEAD:main
if ($LASTEXITCODE -ne 0) { throw 'Bootstrap Push failed; do not start Issue #1' }
```

- main 受保护时，创建 bootstrap PR，由 Human 独立 Review/Merge：

```powershell
git switch -c codex/awh-bootstrap
git push --set-upstream origin codex/awh-bootstrap
if ($LASTEXITCODE -ne 0) { throw 'Bootstrap Push failed; do not start Issue #1' }
gh pr create --base main --head codex/awh-bootstrap --title 'Declare AWH project and Issue queue' --body 'Bootstrap .awh/project.yaml, .awh/flow.json and the .handoff ignore before Issue #1.' --draft
# 停在 Human Review/Merge；PR 尚未合并时不开始 Issue #1。
```

直推成功或 bootstrap PR 经 Human 合并后，回读远端 main 并检查两份 `.awh` 文件；本地 commit 或仅 Push bootstrap 分支不算完成：

```powershell
git fetch origin main
if ($LASTEXITCODE -ne 0) { throw 'Cannot read remote main; do not start Issue #1' }
foreach ($file in @('.awh/project.yaml', '.awh/flow.json')) {
  git cat-file -e "origin/main:$file"
  if ($LASTEXITCODE -ne 0) { throw "origin/main missing $file; finish bootstrap publication first" }
}
git show origin/main:.awh/project.yaml
git show origin/main:.awh/flow.json
$bootstrapBase = (git rev-parse origin/main).Trim()
```

确认回读的 manifest 和队列内容与本项目一致后，再执行下面的 Flow，并基于此后的最新远端 main 生成/批准 Work Item。首个 Issue 的 `READY.base_sha` 必须包含 bootstrap；若 main 更新，继续按 READY 核对准确 SHA。

```powershell
# 在已批准 Project 的受保护 launcher 中执行
node $awh --config $client flow status
node $awh --config $client flow next
```

`APPROVAL_REQUIRED` 返回准确 GitHub main SHA、Issue、分支、Project/Workflow、现有 Executor/Machine 和可复制的 `steps`。trust/Project/App 尚不可用时先完成真实 Gate，再重跑；不会从项目文件批准自己。

独立管理员会话先设置这些变量，然后复制输出的 propose、validate、approval-prepare、approve、preflight：

```powershell
$version = 'issue1-v1' # 每项或新 base 使用新 immutable version
$expires = (Get-Date).ToUniversalTime().AddHours(24).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
$proposal = "$adminRoot\$version.proposal.json"
$receipt = "approve-$version"
$receiptProposal = "$adminRoot\$version.receipt.proposed.json"
# 粘贴 steps；在 approve 之前独立审查并配置正式 receipt/pin。
```

Stage 必须批准 **observe,develop,deliver**；仅 `develop,deliver` 不足。管理员在对应 external Client config 设置 `profile_version` 为已经预置的 fixed Profile version（本例 issue1-v1 → issue2-v1 → issue3-v1），其余 endpoint、credential、state_directory、Executor/Machine 不变，保留原配置审计副本与 namespace。不要重跑 Enrollment complete 来覆盖既有绑定。普通 bearer 和 Flow 无权追加 CP 策略；项目登记不能替代 Work Item 批准。CP 必须支持 `stage-v1` / `exact-grant-v1`；旧 runtime 由管理员独立升级。见 [M1-C 部署与恢复](develop-to-pr.md)。

## 4. Human 启动，Codex 自主交付

在 Codex App 发出：

> 按 AWH 流程开始下一个 Issue。运行 flow next，遵循 READY 的 Issue、授权版本、分支、base SHA 和开发规范；读取 Issue，自主实现、验证、Commit，并在同一任务执行 stage execute，发布 Draft PR、Evidence 和 confirmed Handoff。停在 AWAITING_INDEPENDENT_REVIEW。

READY 带授权版本、分支、base、检查和路径约束。Codex 核对最新 main 后创建独立工作树，并使用对应受保护 Work Item launcher 与 external Client config：

```powershell
git fetch origin main
git rev-parse origin/main # 必须等于 READY.base_sha，变化则重新 Flow/批准
git worktree add -b <READY.branch> <新工作树路径> <READY.base_sha>
Set-Location <新工作树路径>
node $awh stage prepare
# Codex 读取 Issue → 实现 → 指定检查 → git commit。
node $awh --config $client stage execute --title '<PR 标题>' --body '<UTF8 正文文件>'
```

没有单独的 Human Push/创建 PR 命令。成功保留 M1-C `status: awaiting_review` 契约，增加 `issue`、`pr_url`、`head`、`evidence_urls`、`handoff_url`、`run_id`、`next_action: AWAITING_INDEPENDENT_REVIEW`。原后置条件回读准确 App Draft PR、Evidence、confirmed Handoff 与 CP 历史，缺事实则 BLOCKED。

## 5. Review、同 PR 修复、继续

Human 在 ChatGPT 独立 Review 指定 PR／HEAD，决定 REQUEST_CHANGES 或 APPROVE，再独立决定 Merge/Issue close。正文可写 `Closes #1`，由 GitHub 在 Merge 时关闭 Issue。仅 APPROVE、仅 Merge 或仅 close 都不足。

Human 说“继续下一个任务”后，Codex **先从上一项确认的 clean candidate 工作树、原受保护 Work Item launcher** 执行 `node $awh --config $client flow next`。Flow 对照 Run/Event、Journal、GitHub Review/Merge/Issue；事实齐备后调用既有 `syncDelivery` 确认完成，再读取新 main。不要提前切换授权/工作树再同步；过期、撤销或错误 launcher 会返回真实批准/恢复 Gate。`flow status` 只读，必要时显示 `SYNC_REQUIRED`。

REQUEST_CHANGES 输出原 PR/Run/branch/base/previous HEAD/review ID。Codex 修复并 Commit 后，管理员通过现有 revision grant 精确批准新 HEAD：

```powershell
# 独立管理员会话：参数来自 REQUEST_CHANGES 和修复 Commit
node $admin propose --policy-version <original-project> --profile <profile> --workflow <workflow> --repo <repo> --issue <same-issue> --branch <same-branch> --base-sha <original-base> --head-sha <new-head> --executor <executor> --machine <machine> --stages observe,develop,deliver --operations push,evidence,handoff --expires-at $expires --version <new-revision-version> --out $proposal --original-version <original-grant> --run <same-run> --pr <same-pr> --previous-head <old-head> --review <review-id>
# validate → approval-prepare → 独立正式 receipt/pin → approve → preflight
```

获准后 Codex 用 revision launcher 执行同一 Stage，更新同 PR、验证新 HEAD、发布新证据/Handoff，停在独立 Review。原记录保留；原生 Request Changes 本身不授予 revision 权限。

| 三 Issue 示例 | 输出与动作 |
|---|---|
| #1 得到 Work Item 批准 | `READY issue=1`；交付 PR1，停止独立 Review |
| PR1 尚未 Merge，即使 APPROVE | `AWAITING_REVIEW issue=1`，不启动 #2 |
| PR1 REQUEST_CHANGES | 同 PR1 修复并精确批准 revision，更新证据 |
| PR1 APPROVE + Merge、#1 closed；Human 继续 | 自动 sync #1；准确新 main；#2 缺新 base 批准则 `APPROVAL_REQUIRED`，否则 `READY issue=2` |
| PR2 APPROVE + Merge、#2 closed；Human 继续 | 同样选择 #3，复用 Project、新 Work Item version |
| PR3 APPROVE + Merge、#3 closed；Human 继续 | 自动 sync；`QUEUE_COMPLETED completed=[1,2,3]` |

丢 ACK、pending Event、缺 Journal、原生事实变化或 CP 不一致会 BLOCKED。按 [原 Revision/Recovery](develop-to-pr.md) 与现有 sync/reconcile 处理，保留原失败、原始日志和 Receipt，不重放不确定写入。离线模拟只证明 SYNTHETIC PASS；真实新仓库 E2E、Release 与部署按实际执行状态报告。
