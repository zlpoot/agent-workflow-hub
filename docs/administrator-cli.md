# 本机管理员授权 CLI（M1-B0）

入口：node dist/admin-cli.js（或 pnpm admin）。完整参数见 --help。该入口不调用 GitHub、不读取 App PEM、不写 CP、不承担 Review。

## 两层授权

**Project / Workflow Policy** 是一个仓库的可复用不可变版本：既有 builder_policy、App/Installation/完整 selected set、分支规则、检查命令、路径范围、Executor/Machine 约束、允许阶段与权限上限。一个 Project 可含多个 Workflow；新增仓库登记新版本，无源码名单。

**Work Item Authorization** 引用已批准的 Project 版本，绑定 Issue、Workflow、分支、准确 base、执行身份、有效期、阶段、Provider 操作。未经批准的 JSON 模板不能产生有效 Work Item。旧任务不自动迁移到新策略。

Observe、Develop、Deliver 独立选择。任务默认仅 Develop、零 Provider 操作。Deliver 仅支持 push、draft_pr、evidence、handoff；不包含 Ready、Review、Merge、Release、Tag、Issue close、生产部署。

head_sha 默认 null：开发前没有最终 HEAD，不能伪造。交付时由原 Builder 从真实 Git 检查干净分支/HEAD 并固定候选；此后变化必须重新验证并创建新的交付 Run。实际 HEAD/base、授权与策略版本、身份进入原 Client Journal 和 Builder Evidence。已存在的 #65 修复可用 --head-sha 限定原准确 HEAD；批准不声称该提交已验证或发布。

## 独立管理员信任源

管理员在仓库外保护 registry、trust、receipt 与 launcher。例子不会自动加载：

~~~json
{
  "schema_version": "1.0",
  "kind": "admin_trust",
  "registry_root": "C:/AWH-Admin/registry",
  "operator": { "login": "your-admin", "id": 12345 },
  "host": "YOUR-APPROVED-HOST",
  "installation_sha256": "<独立批准的完整 installation 对象摘要>"
}
~~~

installation pin 覆盖 App/Installation/account、完整 selected sets、Reviewer 与管理员 login/数值 ID；编码为 JSON.stringify(value,null,2) 加 LF 换行。变化必须独立审查信任根，不能从提议或 Provider 响应自动扩大。host 必须等于真实 OS hostname。Executor/Machine 由受保护 launcher 提供，并核对任务与既有 CP/Client；第一版不声称硬件远程证明。

所有文件必须在任何 Git 仓库及 symlink/junction 之外。Windows ACL 将写权限给专用管理员/Administrators/SYSTEM；普通 Client/Agent 不应拥有写权。Unix 目录 0700，文件 0600。CLI 不创建正式 trust、改 ACL 或签发管理员凭据。Windows ACL 由部署管理员配置和检查，此文档不是已完成权限隔离的证据。

**Digest 是完整性 pin，不是数字签名。** 同一 OS 管理员账户中的程序共享其权限，CLI 无法识别一个 hash 是 Human 还是 Agent 计算的。独立批准必须由受保护管理员会话/launcher 提供；普通 Agent 不得把自生成 trust/receipt 摘要注入批准环境。Issue、示例、Client bearer、网页、manifest 均无此权限。

以下步骤在独立管理员会话执行，product 为经审查安装目录：

~~~powershell
$admin = 'C:\AWH-Admin\product\dist\admin-cli.js'
$env:AWH_ADMIN_TRUST_FILE = 'C:\AWH-Admin\admin-trust.json'
$env:AWH_ADMIN_TRUST_SHA256 = '<独立核对的 trust pin>'
node $admin inspect
node $admin diagnose
~~~

有效 trust/receipt 来源、pin、PEM/JWT/token 与批准环境只留在管理员/受保护 Builder launcher；不能进入普通 Client 配置、浏览器、CP响应、仓库或证据。launcher 命令仅输出脱敏任务状态，不导出路径、有效 pin 或可执行环境。Client/Viewer 包只带只读 loader，不带管理员 CLI/writer。

## 首次登记项目

项目文件包裹既有 [builder_policy 结构](builder-policy.md)：

~~~json
{
  "builder_policy": "<替换成既有 builder_policy 对象；单一 repository，可含多个 Workflow>",
  "stages": ["observe", "develop", "deliver"],
  "permissions": { "contents": "write", "issues": "read", "pull_requests": "write" }
}
~~~

占位必须替换成对象，不是字符串。issue_prefix 可连续复用：codex/task- + Issue 123 得到 codex/task-123。项目模板的 bootstrap_paths 可为文件 allowlist，或由管理员明确设为 null 允许一般仓库代码变更；运行时一定收窄为精确 fixed Work Item。旧 legacy issue_prefix Task 仍要求 docs/path allowlist，不因此扩大。fixed 模板只绑定原分支/Issue，例如一次性 #65。只接受现有有界 pnpm script、node --test tests/<files>.mjs、git diff --check origin/<base>...HEAD，不执行任意 shell/API。

~~~powershell
node $admin register --policy C:\AWH-Admin\project.proposed.json --version project-v1 --out C:\AWH-Admin\project-v1.proposal.json
node $admin validate --proposal C:\AWH-Admin\project-v1.proposal.json
node $admin approval-prepare --proposal C:\AWH-Admin\project-v1.proposal.json --receipt approve-project-v1 --reason 'Approve bounded project policy' --out C:\AWH-Admin\approve-project-v1.proposed.json

# 管理员独立审核提议和 receipt 的字节、scope、operator、时间、expected state。
# 下面只填写管理员独立批准并保存在受保护来源的文件与 pin。
$env:AWH_ADMIN_APPROVAL_FILE = 'C:\AWH-Admin\approve-project-v1.approved.json'
$env:AWH_ADMIN_APPROVAL_SHA256 = '<独立批准的 receipt pin>'
node $admin approve --proposal C:\AWH-Admin\project-v1.proposal.json --confirm
node $admin inspect
~~~

approval-prepare 仍是提议，--confirm 不授予权限。批准窗口默认一小时，验证上限 24 小时；任务有效期独立。receipt 绑定准确提议摘要、当前 state pin、管理员与审计理由。并发改变 state 后旧提议失效，重新准备与批准。

## 后续任务无需改源码或拼大型 JSON

~~~powershell
node $admin propose --policy-version project-v1 --profile my-project --workflow develop-to-pr --repo owner/repository --issue 123 --branch codex/task-123 --base-sha <准确远端mainSHA> --executor codex --machine APPROVED-HOST --stages observe,develop,deliver --operations push,draft_pr,evidence,handoff --expires-at 2026-10-18T00:00:00.000Z --version issue123-v1 --out C:\AWH-Admin\issue123-v1.proposal.json
node $admin validate --proposal C:\AWH-Admin\issue123-v1.proposal.json
# 对该任务执行上述 approval-prepare → 独立批准 receipt pin → approve
node $admin validate --version issue123-v1 --stage deliver
node $admin preflight --version issue123-v1
node $admin diagnose --version issue123-v1
~~~

下一 Issue 改任务参数/授权版本，引用同一项目版本。提议不能扩大模板的检查、权限、分支、身份。策略/身份/分支变化需新批准；最终 HEAD 在实际交付验证与 Journal 记录，不能复用旧 HEAD 的测试。prepare 是 propose 的同一入口别名。compare --left <提议> --right <提议> 只读输出差异。

受保护 Builder launcher 固定 trust source/pin、AWH_ADMIN_VERSION、AWH_ADMIN_EXECUTOR_ID、AWH_ADMIN_MACHINE_ID 和现有外置 App 配置，再调用同一 Builder/Client Deliver。登记不等于 CP Enrollment：CP Profile 与所选固定授权版本、命令、身份仍须一致，通过既有隔离管理员配置流程核对；不改生产 CP，不提升普通 bearer。

Builder 先检查 scope/身份/真实 HEAD，再读密钥；metadata-only Token 分页检查完整 selected set。真实 Issue/base 用单仓只读 Token核对，每个写操作才申请单仓最小 Token：push 为 contents:write，Draft PR/Evidence/Handoff 为 pull_requests:write。后续操作重读授权，撤销/到期/损坏 fail closed。非法 managed 输入不回退；未启用 managed 时保留旧外置 policy/pin。

使用既有 --hold-draft / holdDraft 路径，托管授权禁止 Ready。交付沿用原 Journal/Outbox/Receipt，不确定副作用先只读 reconcile，不能重新运行来盲目重试。管理员 recover 只恢复本地授权事务。

## 撤销、审计与中断恢复

~~~powershell
node $admin revoke --target issue123-v1 --version revoke-issue123-v1 --out C:\AWH-Admin\revoke.proposal.json
# 再独立 approval-prepare / receipt pin / approve
node $admin inspect
node $admin diagnose --version issue123-v1
~~~

撤销任务只影响它，撤销项目使其所有任务的后续操作拒绝。旧版本、批准来源/摘要、历史 state、Run/Event/Journal/Receipt 保留。inspect 展示 scope、版本、审批人/时间、digest 与撤销/过期状态，不更改历史。

approve 以排他锁写 immutable transaction/proposal/receipt/policy 与历史快照，fsync 后同目录原子 rename 切换 state.json，再读回。准确重复返回 ALREADY_COMMITTED；冲突版本/receipt/expected state 拒绝。

第一版每个 registry 最多保留 128 次版本/撤销操作，单文件最大 64 KiB，selected set 最多 128 仓库。达到限制会拒绝，管理员另行规划受保护的新 registry 并保留旧完整历史；不会自动重置或迁移正在运行的任务。

进程中断后先 diagnose，保留 lock/pending/orphan 原件。管理员用同一提议与独立 receipt pin：

~~~powershell
node $admin recover --proposal C:\AWH-Admin\issue123-v1.proposal.json --confirm
node $admin diagnose
~~~

只有确认原 PID 已消失才归档同一事务 lock。活进程、PID 状态未知、不同事务或字节冲突拒绝。旧不可变文件只核对相同字节，不覆盖。切换前完成原事务；切换后仅确认与归档死锁，不重放 generation。截断/损坏字节不能自动重写，需要管理员调查原件/备份。恢复 Provider 写入数为零。

## 验收状态

本地 preflight/validate 的 provider_scope:NOTRUN 不证明真实交付。Observe Enrollment/Resident/Doctor 与 Deliver 独立；CLI 不改变现有 Observe/Develop catalog、SQLite 或 App 安装权限。模拟 Provider 只证明本地逻辑；真实 PR/Evidence/confirmed Handoff、独立 Review、Mac、E2E、Release 按实际状态报告。

[#65 精确授权](issue65-authorization.md) 保留原 HEAD、独立 PR。本候选尚须独立 Review；本地开发授权不构成其自身发布批准。
