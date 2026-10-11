# 本机管理员授权 CLI（M1-B0）

此入口管理仓库外的版本化 Builder Profile / Workflow / 单项 Work Item，不调用 GitHub、不改 CP、不读取 PEM，也不作 Review。`pnpm admin --help` 或 `node dist/admin-cli.js --help` 显示完整参数。新增任务沿用模板与这套流程，不需要修改源码仓库名单。

## 信任来源与边界

管理员先以独立 OS 权限配置受保护的 registry 目录与 `admin-trust.json`，把文件绝对路径和**独立批准的 SHA-256**放进受保护 launcher：

```json
{
  "schema_version": "1.0",
  "kind": "admin_trust",
  "registry_root": "C:/AWH-Admin/registry",
  "operator": { "login": "your-admin", "id": 12345 },
  "host": "YOUR-APPROVED-HOST",
  "installation_sha256": "<已批准 Builder policy.installation 的 JSON.stringify(value,null,2)+换行之 SHA-256>"
}
```

示例不能加载为授权。`installation_sha256` 固定整个现有 installation 对象：App/installation/account、完整 selected sets、Reviewer 与授权人的 login/数值 ID。扩大集合或换安装须管理员重新审查信任根，普通提议不能覆盖它。字段顺序也是批准字节的一部分。

`host` 必须等于独立批准的实际 OS hostname，复制 trust root 到另一主机不能凭 Client 的 machine 字段通过。Executor/Machine ID 仍是受保护 launcher 与现有 Client/CP 策略绑定的身份，不新增远程硬件证明服务。

Windows 应让 Administrators/SYSTEM 或专用管理员账户拥有写权，普通 Client/Agent 账户只读。Unix 目录 0700，授权文件 0600。文件、信任根、批准凭据和 launcher 都必须在所有 Git 仓库外，不经 symlink/junction；单份 JSON 最大 64 KiB。Windows ACL 是部署管理员的前置职责，CLI 不自动改 ACL。同一 OS 管理员身份运行的程序共享其权限；这些 pins 不是密码学签名，不能隔离拥有同等管理员文件写权的恶意程序。

受保护管理员会话配置：

```powershell
$env:AWH_ADMIN_TRUST_FILE = 'C:\AWH-Admin\admin-trust.json'
$env:AWH_ADMIN_TRUST_SHA256 = '<管理员独立核对并批准的 trust 文件摘要>'
node <已审查安装目录>\dist\admin-cli.js inspect
node <已审查安装目录>\dist\admin-cli.js diagnose
```

CLI 没有自批准、自动信任、从 Issue/CP/manifest 获取 pin、或下载权限的入口。下面准备出的 receipt **仍是提议**，Agent 不能把自己的输出自动设置为批准环境。管理员对具体提议审核后，独立存放并提供 receipt digest；`--confirm` 本身不构成授权。

## 一次登记模板，后续按任务准备

模板沿用 [现有 builder_policy](builder-policy.md) 结构。可保存多仓库 Profile 和 Workflow、固定或 issue_prefix 分支、允许的检查与 path allowlist、Executor/Machine 列表。它只用于准备提议，没有运行权限。新任务从一个 Workflow 产生一个最小 fixed grant，并冻结明确的 Work Item、版本、base/head、机器和到期时间：

```powershell
node <安装目录>\dist\admin-cli.js prepare `
  --template C:\AWH-Admin\templates\reviewed-template.json `
  --profile project-profile --workflow develop-to-pr `
  --repo owner/repository --issue 123 --branch codex/task-123 `
  --base-sha <40位mainSHA> --head-sha <40位最终cleanHEAD> `
  --executor approved-executor --machine approved-machine `
  --expires-at 2026-10-18T00:00:00.000Z `
  --version task-123-v1 --out C:\AWH-Admin\proposals\task-123-v1.json
node <安装目录>\dist\admin-cli.js inspect --proposal C:\AWH-Admin\proposals\task-123-v1.json
```

issue_prefix 必须得到模板前缀加同一 Issue 数字的分支；fixed 模板只接受原有分支/Issue。Executor/Machine 必须在模板列表内。Profile 与 Workflow 来源可复用，但每个 grant 只有一个 Profile、一个 Workflow 和一项固定任务；CLI 为 Workflow 设置本次不可变版本。Source/head 更改须新提议和新批准。仅支持现有 Deliver 的有界 pnpm script、`node --test tests/*.mjs` 列表、`git diff --check origin/<base>...HEAD`，不提供 shell/API 转发。

首次精确导入或不同模板登记使用 `register --policy <外置policy> --task <外置Task> --version <id> --out <新文件>`。Task 字段：repository、issue、branch、base_sha、head_sha、profile、workflow、executor_id、machine_id、expires_at。它也只生成提议，不登记有效权限。

`compare --left <提议1> --right <提议2>` 输出字段级差异；`inspect` 输出版本、批准人/时间、digest、目标任务及完整 installation/Profile/Workflow。两者只读且不构成远端 App preflight。

## 准备独立批准与原子生效

```powershell
node <安装目录>\dist\admin-cli.js approval-prepare `
  --proposal C:\AWH-Admin\proposals\task-123-v1.json `
  --receipt admin-receipt-123-v1 --reason 'Approve this exact bounded candidate' `
  --out C:\AWH-Admin\approvals\receipt-123-v1.proposed.json
```

管理员独立审核提议 scope 和批准文件：固定的 operator、proposal 字节摘要、当前 registry generation 摘要、时间、理由。准备的 receipt 有效期一小时；验证器上限 24 小时。这是完成一次原子批准的窗口，不是任务的有效期；任务以其 `expires_at` 单独到期。

确认后由独立管理员会话输入批准来源和 pin（不能直接从 Agent 返回值自动赋权）：

```powershell
$env:AWH_ADMIN_APPROVAL_FILE = 'C:\AWH-Admin\approvals\receipt-123-v1.approved.json'
$env:AWH_ADMIN_APPROVAL_SHA256 = '<管理员独立批准的receiptSHA256>'
node <安装目录>\dist\admin-cli.js approve --proposal C:\AWH-Admin\proposals\task-123-v1.json --confirm
node <安装目录>\dist\admin-cli.js inspect
node <安装目录>\dist\admin-cli.js preflight --version task-123-v1
node <安装目录>\dist\admin-cli.js launcher --version task-123-v1
```

`approve` 使用排他锁；在锁内重新检查 expected generation、receipt 重放和完整旧历史。它写入全新的 policy、proposal、approval、历史 state 文件并 fsync，最后在同目录原子 rename `state.json`。这个指针是 launcher 的 registry 引用；安装引用固定 trust 根和显式 `AWH_ADMIN_VERSION`，不会自动挑最新版本。现有批准文件不被覆盖，新版本不重写已开始任务。

`launcher` 只输出获准的引用与身份环境；不能执行任意命令，不会自行向 GitHub 发布。管理员将输出的环境配置进已有受保护 Builder/Client launcher，另行配置现有 App ID/外置 PEM 路径。Builder 沿用原有发布功能与 Client Journal，而不是另一套发布器。安装的代码本身须经过独立审查；本地候选不能凭“digest 一致”宣称已审查。

Managed 模式下 Builder 在读取密钥前检查任务选择、Executor/Machine 和准确 clean HEAD/分支，在取得写 token 前用单仓库只读 token 检查真实 Issue 和远端 base。每次网络操作或 Git 写前重读批准版本，撤销/到期/字节变化立即拒绝。启用 managed 环境后错误配置不会回退旧 Builder policy。未启用 managed 环境时仍沿用既有 `AWH_BUILDER_POLICY_FILE/SHA256` 机制，不加载示例。

## 撤销与恢复

```powershell
node <安装目录>\dist\admin-cli.js revoke --version revoke-123-v1 `
  --target task-123-v1 --out C:\AWH-Admin\proposals\revoke-123-v1.json
# 同上准备并由管理员独立批准新的 receipt，再 approve 这份撤销提议。
node <安装目录>\dist\admin-cli.js diagnose
```

撤销准备不立即生效。已批准撤销保留旧 policy/receipt/history，旧任务不能自动迁移到新版本；也不能重放批准 receipt。停止任务后由管理员另批准新版本恢复。

并发失败、锁、pending switch、孤立的不可变记录均保留。`diagnose` 给出 BLOCKED 和文件名，禁止自动删锁、覆盖记录、删历史或重新计算被改变文件的 pin 来“修复”。崩溃后的已成功原子切换可只读核验；切换前的孤立记录需要管理员检查并明确授权恢复。128 次批准是第一版有界容量；有权限迁移/备份须独立办理，不自动清理历史。

历史完整性和重放防护依赖受保护 OS trust root；拥有该 root 写权的管理员恢复旧快照属于根授权管理，不是防恶意管理员的远端反回滚服务。

## Observe、CP 与真实 Provider 的事实边界

Observe 的 CP Enrollment、Machine/Executor、Resident、Doctor 不需要 Deliver grant。这个 CLI 不改变 `trusted.json`、SQLite、Versioned Observe/Develop catalog 或 App 安装权限。CP/Client 的 Profile 版本仍需管理员通过现有独立流程配置并与 Builder 精确匹配；Builder 登记不会隐式提升 Client bearer。既有 [Versioned Profile](versioned-profile.md) trust anchor 不是这个 Deliver registry 的批准来源。

本机 `preflight` 只检查本地授权，返回 `provider_scope: NOTRUN`。GitHub 真实 App 身份、完整 selected-set、单仓库 token 和 PR/Handoff 仍由现有 Builder 实测；独立 Review/Merge 是下一 Human Gate。合成测试只证明授权逻辑，不证明真实业务 E2E、Mac、Release 或部署。
