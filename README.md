# agent-workflow-hub

Current main includes v0.2 repeatable delivery, v0.2.1 revision linking and v0.2.1-R1 publication recovery, with standalone **Client 0.4.4**. Hub #42/#44/#46 are merged and #41/#43/#45 are closed; the Future UI #90/#92 delivery chain has closed. These completed deliveries do not authorize a new production operation.

See [architecture](docs/architecture.md), [deployment configuration](config/README.md), [Client](docs/client.md), [repeatable delivery](docs/repeatable.md) and [publication recovery](docs/publication-recovery.md). Historical v0.1/C0/C1 documents and fixtures remain reproducible. Dynamic Operator/Pairing, arbitrary Workflow Profiles and cross-host CP migration remain unimplemented.

## C1-G Dashboard read-only MVP

Issue [#30](https://github.com/zlpoot/agent-workflow-hub/issues/30) 新增独立只读浏览器界面：Overview / Projects / Executors / Runs / Timeline、真实未知/离线状态、#23 契约校验和 SSE 恢复。使用锁定的 Radix Themes；Future UI 保留为本地语义适配入口。`pnpm dashboard:fixture` 启动仅内存 fixture 的 loopback 预览。P2 通过共享 scope 投影消除空闲全量 SQLite 重读；真实 gateway 默认关闭，原 CP 保持不变。启动、测试与独立 live/session/deployment 门禁见 [Dashboard UI 规范](docs/dashboard-ui.md)。

## C1-E Dashboard read contract

Issue [#23](https://github.com/zlpoot/agent-workflow-hub/issues/23) 增加版本化只读 [Dashboard API](docs/dashboard-api.md) 与 [OpenAPI 3.1](contracts/dashboard-v1.openapi.json)：Projects/Executors/Runs/Timeline、全局 SSE cursor 和安全 diagnostic 投影。可选 viewer gateway 默认关闭，与 CP Client 凭据独立；该 API 的原交付不部署或修改原 CP；后续页面见 #30。
Issue [#22](https://github.com/zlpoot/agent-workflow-hub/issues/22) 的 C1-D 在现有 Builder 上新增观测 Adapter 和安装包内固定范围 `awh deliver`。CP 保存 Run/Event，GitHub 保持开发事实源。交付、event-only retry、Draft/independent Review 边界与真实双端验收见 [delivery](docs/delivery.md)。

## C1-C Client

Issue [#21](https://github.com/zlpoot/agent-workflow-hub/issues/21) 增加可独立安装的 `@zlpoot/awh-client` CLI：minimal Manifest、真实 Git origin binding、稳定 machine identity、专用 CP 配置，以及 register/start/event/status/finish。`pnpm client:pack` 生成包含运行依赖的 tarball，消费者在仓库外安装，无需 Hub checkout。安装、固定命令、显式重试、原生 verified HTTPS 和真实双端验收边界见 [Client 规范](docs/client.md)。当前主线已整合 #22 的 `deliver`；双平台 PASS 必须由同一个 CP 的实际两端证据证明。

## C1-B Control Plane

Issue [#20](https://github.com/zlpoot/agent-workflow-hub/issues/20) 增加本地 HTTP REST/SSE + SQLite runtime service：Project/Profile/Executor Registry、Work Item/Run/Event 持久化、原子 append、重启恢复和独立注册 Client 认证。启动、受信配置、API、cursor/权限边界及限制见 [Control Plane 规范](docs/control-plane.md)。服务显式启动，固定监听 loopback，不连接 GitHub 或执行项目命令；支持默认关闭的只读 Dashboard API；不执行远程调度。所有 runtime 结果 `authority_verified=false`，GitHub 仍保存长期开发事实。

## C1-A Protocol

Issue [#19](https://github.com/zlpoot/agent-workflow-hub/issues/19) 的版本化 Project / Profile Policy / Executor / Work Item / Run / Event 模型位于 `src/protocol/`。独立 JSON Schema、纯函数校验、状态与 sequence/idempotency 规则、v0.1 Handoff 映射及 WebSkill / Future UI fixture 见 [Protocol 规范](docs/protocol.md)。Manifest 只绑定身份，不授予权限；所有结果 `authority_verified=false`。C1-B/C1-C 复用该协议；Dashboard 的当前能力与门禁见上文。

既有基线 Issue [#16](https://github.com/zlpoot/agent-workflow-hub/issues/16)：C0.7-R3 安全兼容 exact GitHub-host scoped credential helper，仅修改 AWH。#19 不改变 WebSkill frozen candidate、live acceptance 或其他 Human Gate；这些历史任务约束不自动授权新任务；agent-desktop 保持 dormant。

Issue [#4](https://github.com/zlpoot/agent-workflow-hub/issues/4) 已完成 C0.5 身份隔离，引入独立的 GitHub App Builder wrapper。C0 Handoff 校验器保持只读。后续生产或产品工作由当前 Issue 和 Human 明确授权。

Issue [#1](https://github.com/zlpoot/agent-workflow-hub/issues/1) 的最小自举工具保留：读取 `builder_handoff` JSON，校验结构、候选版本与 Ready 声明的一致性。当前仍是 Node.js + TypeScript 单包，Protocol 使用锁定的 Ajv 依赖；Control Plane 使用 Node 内置 HTTP/SQLite。

## 安装与检查

实际开发环境：Windows、Node.js **24.21.0**、pnpm **11.25.0**。要求 Node.js 24 或更高，使用 package.json 固定的 pnpm 版本。先准备 pnpm 11.25.0（例如已有 Corepack 时 `corepack prepare pnpm@11.25.0 --activate`），在干净检出中运行：

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm handoff:check examples/ready.json --expected-head aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

`pnpm check` 顺序执行服务端/浏览器 TypeScript 类型检查、编译和 Node.js 内置测试（含启动真实 CLI 进程的行为测试）。`dist/` 是编译产物；只运行 CLI 时先执行 `pnpm build`。安装从 npm registry 下载锁定依赖；只有 esbuild 的固定构建脚本获准执行，浏览器依赖不进入独立 Client 包。CLI 自身不需要网络。浏览器 smoke 与 SSE 负载是显式的定向验证。

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
| `hub` / `c07-r1` | `zlpoot/agent-workflow-hub` | `main` / `codex/c07-r1-git-transport` | `pnpm check` | 非 bootstrap，受 Issue #10 transport repair 范围约束 |
| `hub` / `c07-r2` | `zlpoot/agent-workflow-hub` | `main` / `codex/c07-r2-receive-pack` | `pnpm check` | 非 bootstrap，受 Issue #13 transport repair 范围约束 |
| `hub` / `c07-r3` | `zlpoot/agent-workflow-hub` | `main` / `codex/c07-r3-scoped-helper` | `pnpm check` | 非 bootstrap，受 Issue #16 scoped-helper repair 范围约束 |
| `hub` / `c1a` | `zlpoot/agent-workflow-hub` | `main` / `codex/c1a-protocol` | `pnpm check` | 非 bootstrap，仅 Issue #19 Protocol 范围 |
| `hub` / `c1b` | `zlpoot/agent-workflow-hub` | `main` / `codex/c1b-control-plane` | `pnpm check` | 非 bootstrap，仅 Issue #20 Control Plane 范围 |
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

`AWH_GITHUB_INSTALLATION_ID` 可选；若提供，必须与 App JWT 对 Profile 目标仓库的 live 查询结果一致。每次命令先检查 App、installation 的 selected 范围、未暂停状态和精确权限，再签发仅 `metadata: read` 的检查 token 读取 installation 实际仓库列表（不限制 repositories，以免隐藏错误范围）。检查 token 不含任何 write 权限；完整集合仅允许 `{Hub}`、`{Hub, future-ui}`、`{Hub, future-ui, webskill}`、`{Hub, future-ui, webskill, agent-desktop}`，并必须包含所选 Profile 仓库。`{Hub, webskill}`、重复、缺少、unexpected repository、数量不一致及 All repositories 必须 fail-closed，失败时不签发 write token。随后才签发限定所选唯一仓库及三项 write 权限的 token，并核对返回的 token repositories 也恰好为该仓库。四仓库集合来自 [Issue #8 Spec disposition](https://github.com/zlpoot/agent-workflow-hub/issues/8#issuecomment-6033698220)。agent-desktop 仅为 dormant installation 成员，没有 Profile、write token 或 write path；不读写该仓库、不创建 bootstrap PR、不启动迁移。任意未知或第五仓库仍 fail-closed。多仓库 installation 不会签发多仓库 write token。token/JWT/PEM 仅在进程内使用，不打印、不缓存、不写 Handoff；命令在 GitHub 返回的 `expires_at` 到期后失败，需要重新运行。有效期合理性检查允许最多 60 秒本机/服务器时钟偏差，不延长返回的到期时间。

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

**C0.7 Human Gate / 最新状态：** #8 Phase A、#10/#13 repair 已合并；此前 Mac live preflight 和 private authenticated read 已报告 PASS，最新 Mac run 在 fixed-ref before 之前被 local scoped helper key 阻断，当前 `BLOCKED: AWH_SCOPED_CREDENTIAL_HELPER_COMPAT_REQUIRED (#16)`。Windows #16 只交付 Hub 实现、自身 exact clean head 的 pnpm check、离线四仓库回归及真实 Hub App preflight；不验证 Mac 凭据、创建 WebSkill 影子工作区或运行 WebSkill 测试。离线 mock PASS 和 Hub 自身 push 不表示 private WebSkill acceptance PASS。Builder 发布 evidence 与 confirmed Handoff、转 Ready for ChatGPT Review 后停止；独立 Review PASS 后仍需 Human gate，不修改 installation、WebSkill 或 #147/#160，不进入模型、网站或付费流程。

进入 Phase B 必须由 Human 明确放行并满足 Issue #8 全部门槛：Human 将 WebSkill 加入现有 Selected repositories，在 Mac 的仓库外安全配置 App credential；Mac Codex executor 只读登记真实 WebSkill root、branch、HEAD、worktree，再重新 live preflight 确认 selected set 恰好为 Issue #8 允许的精确集合（当前负责人配置为 Hub + future-ui + webskill + dormant agent-desktop），write token 仅授权 WebSkill。任何项失败停止，不回退用户身份。若 #147 工作区占用或有未提交修改，后续 bootstrap 使用最新 main 的独立干净工作区，不 reset/clean/discard 其工作。Phase B 只新增固定管理文档，不改 AGENTS、产品代码/public contracts、依赖、lockfile 或 #147/#160 的范围及授权，不运行模型、网站、付费流程、Docker full 或 GitHub Actions。Profile 不绑定机器路径或具体 Agent，Mac executor 是本任务执行约定。

参数个数严格固定，数字必须是正安全整数；body-file 是 UTF-8 文件，真实数据放在 gitignored 的 `.handoff/`。成功 stdout 一行 JSON，失败 stderr 一行脱敏 JSON、退出码 2。Git 子进程输出不透传，token 只经进程环境中的临时 HTTP Basic header 提供，不在命令行、Git remote 或磁盘配置中出现；Git 系统/用户配置、用户凭据 helper、trace、hooks 和 redirects 禁用。本地仅允许上述 exact GitHub host helper key 并临时 neutralize；其他 credential、URL rewrite、HTTP/proxy 或 include 配置仍拒绝 push；push 必须从指定功能分支执行，不能 force、push main 或选择其他 remote。

### C0.7-R3 scoped-helper compatibility

[Issue #16](https://github.com/zlpoot/agent-workflow-hub/issues/16) 的 local config scanner 继续仅调用 `git config --local --name-only --list`，不读取 helper command/value。唯一允许的 credential key 为 case-insensitive 精确匹配的 `credential.https://github.com.helper`，可重复；generic `credential.helper`、username/useHttpPath、GitHub path scope、其他 host 或任何其他 credential key 均拒绝。现有 `http.*`、`https.*`、`url.*`、`include*`、`core.gitProxy`、`core.sshCommand` 继续 fail-closed。

authenticated read、receive-pack dry-run 和 real push 使用同一个临时 child-process Git config，其中同时注入 `credential.helper=` 和 `credential.https://github.com.helper=`。Git 的 URL-scoped local helper 不会被 generic reset 覆盖，同 scope 的高优先级空值才能使 fixed GitHub URL 的 effective helper 为空。唯一 auth 仍为单一 `http.https://github.com/.extraheader` App installation Basic header。Builder 不写 local/global/system config，不删除用户配置，不读取/执行 helper，不调用 GCM，也不使用 gh/PAT/user fallback。

真实 Git regression 只在测试临时 repo 写两个 dummy scoped helper：`git config --get-urlmatch credential.helper https://github.com/zlpoot/webskill.git` 在仅有 generic reset 时仍解析到 dummy helper，加入实际 Builder child env 的 scoped reset 后解析为空；测试只查询 config resolution，不执行 helper、不联网，并验证查询不修改临时 config。`hub/c07-r3` 固定绑定 Hub #16、`codex/c07-r3-scoped-helper`、`pnpm check` 和 exact-head pending → readback → confirmed → Ready 流程，保留已有 Profiles、selected-set、single-repository token、fixed-ref、expiry、secret/proxy guards。

### C0.7-R2 Git transport

[Issue #10](https://github.com/zlpoot/agent-workflow-hub/issues/10) 的修复仅使用一个 `http.https://github.com/.extraheader`，值为 `AUTHORIZATION: basic <redacted>`；不再注入 generic/scoped 空 header reset。system/global config 已禁用，local transport override 除上述 exact scoped-helper 例外仍拒绝，caller `GIT_*` / `GH_*` / `GITHUB_*` / `AWH_*`、`SSH_ASKPASS` / `SSH_ASKPASS_REQUIRE` 和 trace 仍过滤。`HTTP_PROXY`、`HTTPS_PROXY`、`http_proxy`、`https_proxy` 保留；不更改用户代理配置或 transport。

固定 `push` 操作按顺序执行 authenticated `ls-remote --exit-code` 检查固定 base ref → `git push --dry-run <fixed-profile-url> HEAD:refs/heads/<fixed-profile-branch>` → real push。三个阶段使用同一 installation write token、同一个受限 child environment 和固定 Profile URL，均禁用 credential helper、hooks 与 redirects；Windows 保持 `NUL`，Mac 保持 `/dev/null`。read probe FAIL 时 dry-run/push NOTRUN，dry-run FAIL 时 real push NOTRUN。每个 transport 调用前检查 expiry，包括 dry-run PASS 后 real push 前。不接受 caller URL、ref 或 Git args，不自动重试。

PR #15 的 ref-state 修订在上述流程中强制插入独立 GitHub API gate：读取固定 feature ref → authenticated read probe → receive-pack dry-run → 再次读取同一固定 feature ref → before/after 完全一致 → real push。内部无参数 reader 仅请求当前 Profile repository 的 `/git/ref/heads/<workflow.branch>`，使用同一 installation write token、禁用 redirect 和 response cache。404 受控表示 ABSENT，不解析/输出其 body；200 必须是固定 `refs/heads/<workflow.branch>` 和 repository URL、commit 类型、40 位 SHA 及匹配 commit URL，才能表示 PRESENT。其他状态、network/JSON/identity/SHA 错误或 token expiry 全部 fail-closed。ABSENT→ABSENT 和 SHA A→SHA A 才通过；branch 出现、更新或删除均阻止 real push。ref-state gate 错误为固定非 transport error，不新增 stage/category，不提供 caller ref/API/URL 接口。首次 WebSkill bootstrap 要求 ABSENT→ABSENT；本轮 Windows 只验证 AWH live gate 和离线 WebSkill 回归。

Git stdout/stderr/error message 仅在进程内处理，永不透传。先检测所有已知/regex secret matches，再把重叠匹配替换为固定 `[suppressed]` placeholder，最后只在 sanitized text 上运行原有六类 classifier；sanitized text 也永不输出。错误仍 exit 2；`error` 固定，transport `stage` 仅允许 `authenticated_read_probe`、`receive_pack_dry_run`、`push`，不会从 upstream text 推导。可选 `category` 保持六类：`git_network_or_proxy`、`git_authentication`、`git_remote_permission_or_policy`、`git_non_fast_forward_or_ref_conflict`、`git_timeout`、`git_transport_unknown`。例如：

```json
{"error":"App HTTPS Git receive-pack dry-run failed (details suppressed)","stage":"receive_pack_dry_run","category":"git_remote_permission_or_policy","suppression_reason":["authorization_header"]}
```

`suppression_reason` 只返回 detector 名称，去重并按字典序排序：`known_private_key`、`known_jwt`、`known_installation_token`、`known_basic_credential`、`authorization_header`、`github_token_pattern`、`jwt_pattern`、`spawn_exception`。重叠匹配的全部 reasons 在替换前记录；Authorization 整行和完整 PEM block 被清洗，credential URL 也从分类输入移除。完整且可安全清洗的秘密输出仍可返回 sanitized category；不认识的失败为 `git_transport_unknown`。无法安全界定的 PEM 或直接 spawn exception 仅返回 generic suppressed error、固定 stage 和 safe reasons，不返回 category。exit 0 的 secret-like 输出仍 fail-closed，不执行后续阶段。非 transport 错误不赋予 stage/category/reasons。

分类只表示有限错误特征，不证明远端写入状态。没有 raw stdout/stderr、redacted raw line、token prefix/suffix、Authorization value、credential URL 或 secret hash 输出。dry-run 不写 ref；失败后先独立核对远端状态。

`hub/c07-r2` 固定绑定 Hub #13、`pnpm check` 和 `codex/c07-r2-receive-pack`，沿用 pending → 回读 → confirmed 的 exact-head Handoff / Ready 门槛。`hub/c07-r1` 与所有已有 Profile 保留。此修复不改变外部 Profile、selected-set 或 App 权限；本次不运行 WebSkill push。离线 transport 测试和 Hub 自身 App push 不等于 private-repository live 验收。

冻结 WebSkill base `e4035dcd40ce2b4788b990144024a73ae39fe7e8`、head `f65888dcc39148996c998df709e7824c4cbdd358`、branch `codex/awh-c07-webskill-bootstrap`，changed path 仅 `docs/management/agent-workflow-hub.md`，保留 #147/#160。#16 independent Review + merge 后，Mac executor 必须从 exact merged AWH source 显式 `pnpm build` 绑定 dist provenance，再 live preflight 验证精确 selected set、metadata-only inspection 和 WebSkill 单仓库 write token。只对同一 frozen candidate 执行一次 Builder push invocation；dry-run FAIL 则 push NOTRUN，独立回读确认 remote ref 未创建；real push FAIL 不做第二次 retry。Builder 内部在 dry-run 前后独立读取固定 remote ref，首次 bootstrap 仅 ABSENT→ABSENT 后才允许 real push；任何读不到或变化均停止。本修复不提供 arbitrary diagnostic/Git passthrough。Windows 交付后停止，Human 通知 ChatGPT 对 exact head 独立 Review，不代填 review，不 merge/close，不启动 agent-desktop/C1。

PR 创建固定 Draft。其后写入及评论回读均核对 App bot actor、目标仓库、指定分支与 main；不修改他人评论。`pr-ready` 复用 C0 校验器，核对所选 `workflow.work_item`（`hub/c05` 绑定 Hub #4；`hub/c06` 与 `future-ui/bootstrap` 绑定 Hub #6；`hub/c07` 与 `webskill/bootstrap` 绑定 Hub #8）、PR、base/head、该 workflow 的完整验证命令集、已发布且回读的 confirmed Handoff JSON 和 CLI 结果，以及当前 head 的独立 Builder evidence 评论（所有 evidence_refs 必须是同一 PR 上该 App 的另一条评论）。Handoff 评论正文格式为 `AWH-HANDOFF v0.1` 首行、首个 json fenced block 放交接 JSON，正文包含 C0 的单行 CLI 结果。Evidence 评论首行为 `Builder evidence`，含验证的完整 head SHA 和原始日志。转 Ready 前后再次核对远端版本；不确定的 Ready 发布结果会尝试恢复并回读 Draft，恢复也失败则明确报告，不能宣告交接成功。

Builder evidence 属于 Builder 验证；Ready 仍不授予审批或合并权限。Contents write 技术上也能调用 merge API，Pull requests write 也覆盖 review API；本轮的禁止由 wrapper 的固定操作和协作 policy 强制，不能宣称是 GitHub permission-level 隔离。wrapper 不提供 approve、review decision、merge、administration、workflow mutation、关闭 Issue 或恢复 C1 的操作。ChatGPT 从 GitHub 独立核对 App bot 身份，并以自己的用户 principal 对 exact head 提交原生 APPROVE；该 Review gate 不由 Builder 代填。

自动测试用运行时生成的 RSA key 、注入的 mock fetch/Git 子进程及临时 repo 的真实 Git config resolution，覆盖 JWT 签名/时钟、安装查询、token 请求/有效期、权限/范围、脱敏失败、身份和版本检查、禁止操作及 Draft 恢复，不访问公网或使用真实秘密。私钥若意外进入日志或 Git 历史，停止并由 Human revoke/rotate；不能只删除日志继续。
