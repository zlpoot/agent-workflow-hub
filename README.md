# agent-workflow-hub

Issue [#8](https://github.com/zlpoot/agent-workflow-hub/issues/8) 的 C0.7 Phase A：扩展固定 webskill/bootstrap Profile 和完整 selected-set 检查，保留 Hub/future-ui 与 C0/C0.5 行为。当前只交付 Hub 实现与离线回归，独立 Review PASS 后停在 Human Gate；真实 WebSkill bootstrap 由 Human 后续放行。C1 #3 继续暂停。

Issue [#4](https://github.com/zlpoot/agent-workflow-hub/issues/4) 已完成 C0.5 身份隔离，引入独立的 GitHub App Builder wrapper。C0 Handoff 校验器保持只读。C1 [#3](https://github.com/zlpoot/agent-workflow-hub/issues/3) 仍按当前路线暂停，不因 C0.5 完成而自动恢复。

Issue [#1](https://github.com/zlpoot/agent-workflow-hub/issues/1) 的最小自举工具：读取 `builder_handoff` JSON，校验结构、候选版本与 Ready 声明的一致性。当前是单包 Node.js + TypeScript CLI，无运行时依赖；尚未实现工作流平台。

## 安装与检查

实际开发环境：Windows、Node.js **24.21.0**、pnpm **11.25.0**。要求 Node.js 24 或更高，使用 package.json 固定的 pnpm 版本。先准备 pnpm 11.25.0（例如已有 Corepack 时 `corepack prepare pnpm@11.25.0 --activate`），在干净检出中运行：

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm handoff:check examples/ready.json --expected-head aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

`pnpm check` 顺序执行 TypeScript 类型检查、编译和 Node.js 内置测试（含启动真实 CLI 进程的行为测试）。`dist/` 是编译产物；只运行 CLI 时先执行 `pnpm build`。安装需要从 npm registry 下载锁定的开发依赖（TypeScript、Node 类型及其类型依赖），没有依赖安装脚本。CLI 自身不需要网络。

## 固定命令与结果

```sh
pnpm handoff:check <handoff.json> --expected-head <full-sha>
```

参数严格为上述三个 token，文件名不能以 `-` 开头（可加 `./`）；预期 SHA 必填。文件编码为 UTF-8，无 BOM。stdout 仅一行稳定 JSON；pnpm 11.25.0 的命令横幅位于 stderr，直接运行 `node dist/cli.js ...` 可省去该横幅。

```json
{"schema_valid":true,"ready_claim_valid":true,"authority_verified":false,"errors":[]}
```

| 退出码 | 含义 | errors.category |
| --- | --- | --- |
| 0 | 结构和 Ready 声明均通过 | 无错误 |
| 1 | 结构错误，或结构合法但未满足 Ready 条件 | `schema` 或 `ready` |
| 2 | 参数、文件读取、JSON 解析或意外运行错误 | `input` |

`errors` 每项含 `category`、`path`、`reason`。字段路径以 `$` 为根，例如 `$.verification.checks[0].exit_code`；参数和文件错误分别使用 `$args`、`$file`。结构错误存在时先返回结构诊断，不推断 Ready 条件；I/O 失败时 `schema_valid=false` 表示无法建立结构有效性。诊断不回显文件内容或命令。

## 契约 0.1

所有字段必填，所有对象（含 checks 的元素）拒绝未知字段。完整例子见 [examples/ready.json](examples/ready.json)，其 SHA、PR 和发布状态仅为教学数据，**不是本 PR 的真实交接或证据**。真实记录位于 PR 的 `AWH-HANDOFF v0.1` 评论。

| 路径 | 允许值 |
| --- | --- |
| `schema_version` / `kind` | `"0.1"` / `"builder_handoff"` |
| `work_item.repo` / `issue` | `owner/name` / 正安全整数 |
| `candidate.pr` / `base_sha` / `head_sha` | 正安全整数 / 完整 SHA / 完整 SHA |
| `producer.executor` / `run_id` | 非空白字符串；executor 不限制执行器名称 |
| `verification.subject_sha` | 完整 SHA |
| `verification.lifecycle` | `completed`、`failed`、`cancelled` |
| `verification.outcome` | `pass`、`fail`、`inconclusive` |
| `verification.checks` | 非空数组；元素仅含非空白 `command` 和安全整数 `exit_code` |
| `verification.evidence_refs` | 非空数组；每项为带主机名、无空白的绝对 `https://` URL |
| `handoff.next_step` | `review` |
| `handoff.publication` | `pending`、`confirmed`、`failed` |

完整 SHA 是 40 位十六进制，比较忽略大小写，拒绝短 SHA。整数限于 JavaScript 能精确表示的安全整数。repo 的 owner 允许英文字母、数字和连字符；name 额外允许下划线和点。字符串不会被自动修剪或改写。

结构合法的失败、取消、待发布记录仍是 `schema_valid=true`。Ready 需要同时满足：验证完成、结果 pass、所有 exit_code 为 0、subject_sha 等于候选 head、候选 head 等于调用方 expected-head、publication 为 confirmed。

## 信任边界与交接

校验通过只表示声明格式和内部一致性成立。`authority_verified` 恒为 false；工具不验证身份、代码正确性、证据真实性、URL 可达性或 GitHub 当前 SHA，不表示独立 Review 通过，不授予合并权限。`approved` / `merge_authorized` 等扩展字段会被拒绝。命令与 URL 都是数据，CLI 不执行命令、不访问网络、不修改输入、不写 GitHub、不合并。

Builder 在最终干净 head 上检查并发布原始验证输出；真实 handoff 放在 gitignored 的 `.handoff/`，先以 pending 发布并回读，再以 confirmed 使用准确 expected-head 校验，将记录与 CLI 输出更新到同一评论并再次回读、核对远端 head，才标记 Ready。有新提交就重新交接，保留旧记录并注明替代关系。Human 通知开发完成，ChatGPT 从 GitHub 独立审查并按 Issue 的条件决定是否合并。Builder 验证不冒充独立重跑。

## GitHub App Builder 与固定 Project Profiles

`pnpm builder` 是独立的联网写入 wrapper；上面的 `handoff:check` 保持只读。默认仍选择 Hub / c05，兼容 C0.5 命令。C0.6 通过固定 Profile + workflow 选择 repository、base、branch、work item、验证命令和 bootstrap 路径；不接受任意 repo/base/branch/URL 或配置文件覆盖。没有任意 API/URL、gh 命令或 Git 参数透传。它不读取现有 gh 登录，也不回退到用户身份。

| Profile / workflow | Repository | Base / branch | 验证命令（固定顺序） | Bootstrap 路径 |
| --- | --- | --- | --- | --- |
| `hub` / `c05`（默认） | `zlpoot/agent-workflow-hub` | `main` / `codex/c05-github-app-builder` | `pnpm check` | 非 bootstrap，受 Issue #4 范围约束 |
| `hub` / `c06` | `zlpoot/agent-workflow-hub` | `main` / `codex/c06-project-profiles` | `pnpm check` | 非 bootstrap，受 Issue #6 范围约束 |
| `hub` / `c07` | `zlpoot/agent-workflow-hub` | `main` / `codex/c07-webskill-profile` | `pnpm check` | 非 bootstrap，受 Issue #8 Phase A 范围约束 |
| `webskill` / `bootstrap` | `zlpoot/webskill` | `main` / `codex/awh-c07-webskill-bootstrap` | `pnpm check:foundations`、`pnpm lint`、`pnpm typecheck` | 仅 `docs/management/agent-workflow-hub.md` |
| `future-ui` / `bootstrap` | `zlpoot/future-ui` | `main` / `codex/awh-c06-bootstrap` | `pnpm lint`、`pnpm typecheck`、`pnpm test` | 仅 `docs/management/agent-workflow-hub.md` |

Profile 是仓库和工作流边界，不绑定机器路径或产品开发 Agent。future-ui 产品 Worker 仍为豆包工作，其 R1-004 / #70 范围独立有效。bootstrap 只证明接入闭环，不修改产品源码、public contracts、依赖、lockfile 或 #70 Grant。

Human 配置 private App：只使用 Selected repositories，C0.7 Phase A 不修改现有 installation；Contents、Pull requests、Issues 为 write，Metadata 为 read，其他权限均 No access。PEM 放在仓库之外，并用 Windows ACL 限制读者。PowerShell 示例（替换本地路径占位符，不复制私钥内容）：

```powershell
$env:AWH_GITHUB_APP_ID = '5219770'
$env:AWH_GITHUB_APP_PRIVATE_KEY_PATH = 'C:\Users\<user>\.config\agent-workflow-hub\credentials\awh-builder.pem'
pnpm build
pnpm builder preflight
```

`AWH_GITHUB_INSTALLATION_ID` 可选；若提供，必须与 App JWT 对 Profile 目标仓库的 live 查询结果一致。每次命令先检查 App、installation 的 selected 范围、未暂停状态和精确权限，再签发仅 `metadata: read` 的检查 token 读取 installation 实际仓库列表（不限制 repositories，以免隐藏错误范围）。检查 token 不含任何 write 权限；完整集合仅允许 `{Hub}`、`{Hub, future-ui}`、`{Hub, future-ui, webskill}`，并必须包含所选 Profile 仓库。`{Hub, webskill}`、重复、缺少、unexpected repository、数量不一致及 All repositories 必须 fail-closed，失败时不签发 write token。随后才签发限定所选唯一仓库及三项 write 权限的 token，并核对返回的 token repositories 也恰好为该仓库。三仓库 installation 不会签发多仓库 write token。token/JWT/PEM 仅在进程内使用，不打印、不缓存、不写 Handoff；命令在 GitHub 返回的 `expires_at` 到期后失败，需要重新运行。有效期合理性检查允许最多 60 秒本机/服务器时钟偏差，不延长返回的到期时间。

读取 PEM 前，helper 从 canonical cwd 向上找最近的 `.git` 目录或 linked-worktree 文件，再用不含 App 凭据的 Git 子进程核实实际 worktree root，并确认 origin 是所选 Profile 的固定 GitHub repository（只接受对应 HTTPS 或 SSH origin）。允许子目录调用；不要求 helper 与目标仓库在同一目录，未来可从 future-ui worktree 调用 Hub 的 CLI。无法核实根目录或仓库不符则失败。私钥路径经 realpath 解析后与核实的完整根目录比较，不能因 cwd 位于子目录而允许仓库内的 PEM，也不能通过仓库外的符号链接指向仓库内的密钥。后续 Git 检查/push 固定在核实的根目录执行，safe.directory 也只设置为该根目录。实现无固定盘符或本机工作区路径。

```text
pnpm builder preflight
pnpm builder push
pnpm builder pr-create <title> <body-file>
pnpm builder pr-update <pr-number> <title> <body-file>
pnpm builder pr-read <pr-number>
pnpm builder comment-create <pr-number> <body-file>
pnpm builder comment-edit <pr-number> <comment-id> <body-file>
pnpm builder comment-read <pr-number> <comment-id>
pnpm builder pr-ready <pr-number> <expected-head> <confirmed-handoff-file> <handoff-comment-id>
```

显式选择必须在操作前完整给出两个固定标志；操作和其参数保持上述格式：

```sh
pnpm builder --profile hub --workflow c07 preflight
pnpm builder --profile hub --workflow c07 push
pnpm builder --profile hub --workflow c07 pr-create 'C0.7 Phase A' .handoff/pr-body.md
```

选择错误在读凭据或请求 GitHub 前失败。外部 Profile bootstrap push 会把当前远端 main 的完整 SHA 作为比较基准，检查 Git diff 仅含固定文档路径；PR 创建前及后续 PR 读写/Ready 也用 GitHub exact base/head compare 检查远端 candidate 只新增或修改该文档，阻止绕过 push 的产品代码 PR。检查不执行文档或评论中的命令。Handoff 的 `work_item` 指向任务所在仓库：c05 为 Hub #4，c06 与 future-ui bootstrap 为 Hub #6，c07 与 webskill bootstrap 为 Hub #8；交付仓库由所选 Profile、实际 PR 和该仓库证据 URL 绑定，不能把 future-ui #70 或 WebSkill #147 冒充本任务。Ready 还要求 checks 按该 workflow 固定顺序完整覆盖允许验证命令。

**C0.7 Phase A / Human Gate：** 当前只交付 Hub 实现、自身 exact clean head 的 pnpm check、离线三仓库回归及真实 Hub App preflight。Windows 不需要 WebSkill clone，也不创建影子工作区或运行 WebSkill 测试；离线 mock 的 PASS 不表示真实 WebSkill bootstrap/验证 PASS。当前 Gate：WebSkill in App installation NO；Mac App credential NO。这两项不阻塞 Hub Phase A。Builder 发布 evidence 与 confirmed Handoff、转 Ready for ChatGPT Review 后停止；独立 Review PASS 后仍需 Human 放行。Phase A 不修改 installation 或 WebSkill，不触碰 #147 / PR #160，不进入真实模型、网站或付费流程。

进入 Phase B 必须由 Human 明确放行并满足 Issue #8 全部门槛：Human 将 WebSkill 加入现有 Selected repositories，在 Mac 的仓库外安全配置 App credential；Mac Codex executor 只读登记真实 WebSkill root、branch、HEAD、worktree，再重新 live preflight 确认 selected set 恰好为 Hub + future-ui + webskill，write token 仅授权 WebSkill。任何项失败停止，不回退用户身份。若 #147 工作区占用或有未提交修改，后续 bootstrap 使用最新 main 的独立干净工作区，不 reset/clean/discard 其工作。Phase B 只新增固定管理文档，不改 AGENTS、产品代码/public contracts、依赖、lockfile 或 #147/#160 的范围及授权，不运行模型、网站、付费流程、Docker full 或 GitHub Actions。Profile 不绑定机器路径或具体 Agent，Mac executor 是本任务执行约定。

参数个数严格固定，数字必须是正安全整数；body-file 是 UTF-8 文件，真实数据放在 gitignored 的 `.handoff/`。成功 stdout 一行 JSON，失败 stderr 一行脱敏 JSON、退出码 2。Git 子进程输出不透传，token 只经进程环境中的临时 HTTP Basic header 提供，不在命令行、Git remote 或磁盘配置中出现；Git 系统/用户配置、用户凭据 helper、trace、hooks 和 redirects 禁用。若本地仓库存在 URL rewrite、HTTP/proxy、credential 或 include 配置，则拒绝 push；push 必须从指定功能分支执行，不能 force、push main 或选择其他 remote。

PR 创建固定 Draft。其后写入及评论回读均核对 App bot actor、目标仓库、指定分支与 main；不修改他人评论。`pr-ready` 复用 C0 校验器，核对所选 `workflow.work_item`（`hub/c05` 绑定 Hub #4；`hub/c06` 与 `future-ui/bootstrap` 绑定 Hub #6；`hub/c07` 与 `webskill/bootstrap` 绑定 Hub #8）、PR、base/head、该 workflow 的完整验证命令集、已发布且回读的 confirmed Handoff JSON 和 CLI 结果，以及当前 head 的独立 Builder evidence 评论（所有 evidence_refs 必须是同一 PR 上该 App 的另一条评论）。Handoff 评论正文格式为 `AWH-HANDOFF v0.1` 首行、首个 json fenced block 放交接 JSON，正文包含 C0 的单行 CLI 结果。Evidence 评论首行为 `Builder evidence`，含验证的完整 head SHA 和原始日志。转 Ready 前后再次核对远端版本；不确定的 Ready 发布结果会尝试恢复并回读 Draft，恢复也失败则明确报告，不能宣告交接成功。

Builder evidence 属于 Builder 验证；Ready 仍不授予审批或合并权限。Contents write 技术上也能调用 merge API，Pull requests write 也覆盖 review API；本轮的禁止由 wrapper 的固定操作和协作 policy 强制，不能宣称是 GitHub permission-level 隔离。wrapper 不提供 approve、review decision、merge、administration、workflow mutation、关闭 Issue 或恢复 C1 的操作。ChatGPT 从 GitHub 独立核对 App bot 身份，并以自己的用户 principal 对 exact head 提交原生 APPROVE；该 Review gate 不由 Builder 代填。

自动测试用运行时生成的 RSA key 和注入的 mock fetch/Git 子进程，覆盖 JWT 签名/时钟、安装查询、token 请求/有效期、权限/范围、脱敏失败、身份和版本检查、禁止操作及 Draft 恢复，不访问公网或使用真实秘密。私钥若意外进入日志或 Git 历史，停止并由 Human revoke/rotate；不能只删除日志继续。
