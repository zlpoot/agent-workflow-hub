# agent-workflow-hub

Issue [#4](https://github.com/zlpoot/agent-workflow-hub/issues/4) adds a separate GitHub App Builder wrapper for C0.5 identity isolation. The C0 handoff validator remains read-only. C1 (#3) remains paused until the independent Reviewer completes the C0.5 gate.

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

## C0.5 GitHub App Builder

`pnpm builder` 是独立的联网写入 wrapper；上面的 `handoff:check` 保持只读。生产目标固定为 `zlpoot/agent-workflow-hub`，功能分支固定为 `codex/c05-github-app-builder`，PR base 固定为 main。没有任意 API/URL、gh 命令或 Git 参数透传。它不读取现有 gh 登录，也不回退到用户身份。

Human 配置 private App：仅 selected repository `zlpoot/agent-workflow-hub`；Contents、Pull requests、Issues 为 write，Metadata 为 read，其他权限均 No access。PEM 放在仓库之外，并用 Windows ACL 限制读者。PowerShell 示例（替换本地路径占位符，不复制私钥内容）：

```powershell
$env:AWH_GITHUB_APP_ID = '5219770'
$env:AWH_GITHUB_APP_PRIVATE_KEY_PATH = 'C:\Users\<user>\.config\agent-workflow-hub\credentials\awh-builder.pem'
pnpm build
pnpm builder preflight
```

`AWH_GITHUB_INSTALLATION_ID` 可选；若提供，必须与 App JWT 对目标仓库的 live 查询结果一致。每次命令先检查 App、installation 的 selected 范围、未暂停状态和精确权限，再用短时 token 读取 installation 实际仓库列表，确认仅一个目标仓库，最后签发限定该仓库及三项 write 权限的 token。token/JWT/PEM 仅在进程内使用，不打印、不缓存、不写 Handoff；命令在 GitHub 返回的 `expires_at` 到期后失败，需要重新运行。有效期合理性检查允许最多 60 秒本机/服务器时钟偏差，不延长返回的到期时间。

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

参数个数严格固定，数字必须是正安全整数；body-file 是 UTF-8 文件，真实数据放在 gitignored 的 `.handoff/`。成功 stdout 一行 JSON，失败 stderr 一行脱敏 JSON、退出码 2。Git 子进程输出不透传，token 只经进程环境中的临时 HTTP Basic header 提供，不在命令行、Git remote 或磁盘配置中出现；Git 系统/用户配置、用户凭据 helper、trace、hooks 和 redirects 禁用。若本地仓库存在 URL rewrite、HTTP/proxy、credential 或 include 配置，则拒绝 push；push 必须从指定功能分支执行，不能 force、push main 或选择其他 remote。

PR 创建固定 Draft。其后写入及评论回读均核对 App bot actor、目标仓库、指定分支与 main；不修改他人评论。`pr-ready` 复用 C0 校验器，核对 Issue #4、PR、base/head、已发布且回读的 confirmed Handoff JSON 和 CLI 结果，以及当前 head 的独立 Builder evidence 评论（所有 evidence_refs 必须是同一 PR 上该 App 的另一条评论）。Handoff 评论正文格式为 `AWH-HANDOFF v0.1` 首行、首个 json fenced block 放交接 JSON，正文包含 C0 的单行 CLI 结果。Evidence 评论首行为 `Builder evidence`，含验证的完整 head SHA 和原始日志。转 Ready 前后再次核对远端版本；不确定的 Ready 发布结果会尝试恢复并回读 Draft，恢复也失败则明确报告，不能宣告交接成功。

Builder evidence 属于 Builder 验证；Ready 仍不授予审批或合并权限。Contents write 技术上也能调用 merge API，Pull requests write 也覆盖 review API；本轮的禁止由 wrapper 的固定操作和协作 policy 强制，不能宣称是 GitHub permission-level 隔离。wrapper 不提供 approve、review decision、merge、administration、workflow mutation、关闭 Issue 或恢复 C1 的操作。ChatGPT 从 GitHub 独立核对 App bot 身份，并以自己的用户 principal 对 exact head 提交原生 APPROVE；该 Review gate 不由 Builder 代填。

自动测试用运行时生成的 RSA key 和注入的 mock fetch/Git 子进程，覆盖 JWT 签名/时钟、安装查询、token 请求/有效期、权限/范围、脱敏失败、身份和版本检查、禁止操作及 Draft 恢复，不访问公网或使用真实秘密。私钥若意外进入日志或 Git 历史，停止并由 Human revoke/rotate；不能只删除日志继续。
