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
