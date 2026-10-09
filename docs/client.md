# Client / C1-C and C1-D

Current main ships Client **0.4.4**, including v0.2 repeatable delivery, v0.2.1 controlled document revision linking and [v0.2.1-R1 one-shot publication recovery](publication-recovery.md). Hub #42/#44/#46 are merged and #41/#43/#45 are closed. Independent Review of any new head and separate Human production authorization remain required; old recovery decisions are not reusable.

The standalone package includes Client, Protocol, shared stateless security checks, the fixed App Builder/policies and bundled runtime dependencies. It excludes CP server/Store, Builder CLI, browser/development dependencies and credentials. Consumers need Node 24+, not a Hub checkout. [Configuration sources and closed schemas](../config/README.md) document current deployment parameters.

Historical / Legacy: the original C1-C/C1-D descriptions and constraints below remain as historical contracts. The [v0.1 guide](mvp.md) describes Client 0.3.0; it is not a current task instruction. Mac production pairing and cross-host endpoint migration are not implied by Windows acceptance.

## 分发与安装

Builder 在 Hub 执行 `pnpm client:pack`，生成 `.handoff/packages/zlpoot-awh-client-0.4.4.tgz` 和 SHA-256/文件清单 JSON。`--output` 仅指定包输出目录。打包从锁定、已安装的 runtime dependencies 复制依赖闭包，调用本机 npm 的 offline pack，不下载或运行 lifecycle scripts。

将 tarball 经已认证的文件传输交给消费者，核对提供的 SHA-256。消费者在仓库外安装：

```sh
npm install --prefix /absolute/external/awh-client --offline --ignore-scripts --no-audit --no-fund /absolute/zlpoot-awh-client-0.4.4.tgz
/absolute/external/awh-client/node_modules/.bin/awh --version
```

Windows 使用相同 prefix 的 `node_modules\.bin\awh.cmd`。`--prefix` 应是独立工具目录，不改变产品 package.json/lockfile。支持 Windows、macOS、Linux；自动测试中的平台取自实际 OS，其他 OS 的实测结果必须单独记录。模拟 platform 字段或 fixture 不能证明双平台 PASS。

## 项目身份与本地状态

在真实产品 worktree 执行 `awh init --profile <requested-ref> [--project-id <id>]`，默认 project id 为 origin repo 名，只创建 `.awh/project.yaml`：

```yaml
apiVersion: awh/v1
project:
  id: "webskill"
  repository: "zlpoot/webskill"
profile:
  ref: "webskill/bootstrap"
```

这是 C1-A closed Manifest 的六行 YAML 子集，支持安全 plain scalar 或 JSON 双引号字符串，拒绝额外字段、重复、alias、tag、复杂 YAML、超过 4 KiB 或 symlink 文件。已存在且语义相同则保持文件；冲突不会覆盖。每次操作重新核对 canonical Git root、真实 local origin、HEAD/ref。origin 仅支持单一 canonical GitHub HTTPS/SSH URL；拒绝 credential URL、includes、URL rewrite、local filter driver 和 worktree config override。允许 `extensions.worktreeConfig` 单一有效 boolean；开启功能时只接受不存在或无配置项的当前 `config.worktree`，不是绕过 worktree 覆盖检查。实际非空覆盖、重复开关、非普通或超过 1 MiB 的配置文件仍拒绝；无需删除开关或修改消费者 Git 配置。Git 操作只读，禁用 hooks/fsmonitor/global/system config/credential helper，无 shell 或 Git 参数透传，不联网；status 忽略 submodule，避免在子工作区执行独立配置的 Git。source_dirty 只反映当前根工作区（不含 submodule），只上报 boolean，不上报本地文件路径。

Manifest 只请求身份绑定。Policy 来自 CP trusted registry，不从项目加载或上传，亦不执行 Policy 中的命令。`start --issue` 绑定当前项目仓库中的 Issue reference，不创建/读取 GitHub Issue。source 是真实 HEAD/ref，不切分支、不 commit/reset/clean、不运行产品命令。

配置、专用凭据和 state_directory 都必须为显式绝对仓库外路径；检查 canonical ancestor，拒绝 symlink 指向项目。machine.json 首次 register 生成稳定 UUID，保存 name/platform/arch；项目移动不会换 machine ID。executor_id 显式配置，重注册不改变 machine/owner 身份。不同 Executor 可共用同一机器 state_directory；项目/endpoint/executor 单独 namespace 保存 Run session。name/arch/Client version 是额外 metadata，不改变 C1-A Executor schema。

## 专用认证与 endpoint

通过 `awh --config <absolute-config.json> <command>` 或 `AWH_CLIENT_CONFIG` 指定配置；无自动发现或用户/GitHub凭据 fallback：

```json
{
  "schema_version": "1.0",
  "endpoint": "https://192.168.2.5:8443",
  "ca_certificate_file": "/absolute/external/awh-ca.pem",
  "credential_file": "/absolute/external/client.credential",
  "state_directory": "/absolute/external/state",
  "executor_id": "webskill-mac-client",
  "executor_type": "codex",
  "profile_version": "trusted-v1"
}
```

credential_file 放管理员另行生成的专用 CP credential，非 GitHub token；Unix 必须 owner-only，Windows 配置者应设置 owner-only NTFS ACL。CP trusted config 仅持有 hash 与 project/executor scope。不得通过参数、stdout、payload、Git 或交接发送凭据；错误只输出固定诊断。

endpoint 仅支持无 userinfo/path/query/fragment 的 origin：numeric loopback HTTP 或证书校验的 HTTPS。Owner [最新指令](https://github.com/zlpoot/agent-workflow-hub/pull/26#issuecomment-6050291524) 废止旧 SSH/tunnel 步骤。Windows 原生 Node HTTPS 显式监听 192.168.2.5:8443，Mac 192.168.2.3 直接使用该 HTTPS origin；保留 Windows 127.0.0.1:4310，两端共享原有同一个 SQLite store。防火墙有效规则必须只允许 Mac 来源；配置证书/密钥和 trusted Registry 在仓库外，不增加第三方常驻服务。不得绑定 0.0.0.0 或 LAN 明文 HTTP。

`ca_certificate_file` 为可选 absolute 仓库外单个 public CA PEM，仅 HTTPS 可用。读取 bounded regular file，拒绝项目内（含 canonical ancestor 跳转）、私钥、非 CA、已过期/尚未有效证书。它仅通过当前请求的 Node HTTPS `ca` 选项生效，不导入全局系统信任。未指定时使用 Node 默认 CA。实际 TLS 仍验证签发链、有效期与 endpoint hostname/IP SAN；不覆盖 `checkServerIdentity`。管理员经可信渠道核对 public CA SHA-256 fingerprint 后才交给 Mac；leaf 私钥不离开 Windows。不跟随重定向、读取 HTTP proxy 自动配置、关闭 TLS 检查或静默 HTTP fallback。连接/auth/schema/ACK 错误非零退出，无身份或 endpoint fallback/自动重试。网络总 deadline 15s，response 上限 8 MiB，所有响应要求 `authority_verified=false`。

**主机切换阻断 / #27：** 当前 session namespace 与已保存 binding 包含 endpoint。改址会看不见旧 session，因此 #21 不支持改址、HTTP→HTTPS 的既有 Client 会话迁移或 Windows→Mac CP cutover。现有 Windows Client 保留原 loopback endpoint；尚未注册的 Mac 首次使用 HTTPS。不得删除/改写旧 state、强行换 endpoint 后 start 或把旧 session 交给无关 CP。[#27](https://github.com/zlpoot/agent-workflow-hub/issues/27) 必须先实现稳定逻辑 service ID、显式验证旧/新 CP identity 和同一 DB 的恢复边界，以及锁内原子兼容迁移；保留 machine UUID、Run/Event ID/sequence/timestamp、pending bytes/archived history；冲突/身份不明停机并保持原数据。验收必须覆盖 pending ACK 已提交但未确认时跨 host 单写者切换、幂等回放、恢复原 endpoint 和中断回滚，无丢失/重复 cursor。当前回归明确证明 endpoint 改址不迁移数据、原状态字节未变、恢复原 endpoint 后同一 pending Event 能幂等确认；它不构成跨主机迁移 PASS。此设计与未实现验收作为 #27 cutover 前置 gate。

## 命令、事件与恢复

| 命令 | 行为 |
| --- | --- |
| `init --profile <ref> [--project-id <id>]` | 只生成 minimal Manifest，无 config/网络需求 |
| `register` | Project + Executor/Client metadata 注册，显式 server heartbeat |
| `status` | 回读受限 Registry、当前 Run 和本地 pending Event，不重试写入 |
| `start --issue <positive-n>` | 选 exact trusted Profile version，持久化 Work Item/Run/RUN_STARTED 后提交 |
| `event --type <type> --data <json-file>` | 校验状态、payload、顺序后上报 |
| `event --retry` | 仅重发已持久化的 pending Event |
| `finish --outcome failed --data <reason-json-file>` | 显式提交 RUN_FAILED，结束无交付/Review 的受控测试 |
| `finish` | 仅确认 CP 已 terminal；不捏造成功、交付或 Review |

允许 runtime Event 为 STEP_STARTED/COMPLETED、VERIFICATION_STARTED/PASSED/FAILED、RUN_FAILED，payload 遵循 C1-A。成功 RUN_COMPLETED 需要完整独立 Review/交付链；#21 不提供该链，不能把 CLI 冒烟测试包装成产品成功执行。受控失败 Run 可证明 register/start/event/status/finish，验收判断独立于 Run outcome。

每 Event 的 ID/sequence/timestamp 在发送前原子保存，ACK 必须匹配 exact Event、预期 Run projection、合法 cursor/disposition 才清除 pending。断线或 malformed ACK 可能已提交；显式 retry 保留原 ID/sequence/data，让 CP 幂等处理。初始 RUN_STARTED 用相同 `start --issue` 恢复，其他用 `event --retry` 或完全相同 type/data。pending 时拒绝不同事件或 Issue。终态再次 start 保存旧 Run archive，再创建新 UUID。

namespace 的 exclusive lock 防止并发写；崩溃遗留 lock 必须先确认无进程后人工处理，不自动丢弃。损坏 session、身份冲突或 256 Events 上限 fail closed。session 是单写者本地历史；若外部 writer 追加事件，保留记录并显式人工恢复，不自动吸收或重置历史。

## 同一个 CP 的真实验收

管理员在仓库外创建两个独立 CP Client hash/scope 与 trusted Profiles。Windows Future UI、Mac WebSkill 分别安装同一校验过的 tarball，记录实际 machine/platform/arch、包版本/SHA-256、产品 Git root/origin/branch/HEAD/status 前后。只新增 minimal Manifest，在同一 CP register、start 受控 Run、上报 STEP_STARTED/COMPLETED、status 回读并显式失败 finish；检查 server timeline 连续序号及 scope 隔离。不得触碰活动产品分支、产品代码、AGENTS、锁文件或模型/付费流程。

Mac/Windows 都实际连接并通过后才标真实双平台 PASS。证书、credential、防火墙管理员配置、Mac 未执行等缺口都必须明确阻断；Windows 或 fixture PASS 不能代替 Mac。验收中使用的 repo root、config、endpoint、SHA 是外部运行记录，不绑定 Profile 到 Agent 或本机路径。最终 clean-head `pnpm check`、原始失败日志、独立安装证据和实际双方验收记录通过 App-only Builder 发布到同一 Draft PR；有阻断时不 Ready、不关闭 #21。
