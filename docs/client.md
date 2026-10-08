# C1-C Client / Issue #21

`@zlpoot/awh-client` 0.1.0 是可独立安装的 Node 24+ CLI/Client。消费者不需要 Hub checkout；包内含编译后的 Client、C1-A Protocol 校验器及固定的运行依赖，不含 Builder、CP server、开发依赖或凭据。Hub 保持原有 pnpm 单包；不向 npm registry 发布、不新增许可证。版本入口为 `awh --version`，升级必须显式安装新 tarball。`deliver` 等待 #22。

## 分发与安装

Builder 在 Hub 执行 `pnpm client:pack`，生成 `.handoff/packages/zlpoot-awh-client-0.1.0.tgz` 和 SHA-256/文件清单 JSON。`--output` 仅指定包输出目录。打包从锁定、已安装的 runtime dependencies 复制依赖闭包，调用本机 npm 的 offline pack，不下载或运行 lifecycle scripts。

将 tarball 经已认证的文件传输交给消费者，核对提供的 SHA-256。消费者在仓库外安装：

```sh
npm install --prefix /absolute/external/awh-client --offline --ignore-scripts --no-audit --no-fund /absolute/zlpoot-awh-client-0.1.0.tgz
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

这是 C1-A closed Manifest 的六行 YAML 子集，支持安全 plain scalar 或 JSON 双引号字符串，拒绝额外字段、重复、alias、tag、复杂 YAML、超过 4 KiB 或 symlink 文件。已存在且语义相同则保持文件；冲突不会覆盖。每次操作重新核对 canonical Git root、真实 local origin、HEAD/ref。origin 仅支持单一 canonical GitHub HTTPS/SSH URL；拒绝 credential URL、includes、URL rewrite、local filter driver 和 worktree config override。Git 操作只读，禁用 hooks/fsmonitor/global/system config/credential helper，无 shell 或 Git 参数透传，不联网；status 忽略 submodule，避免在子工作区执行独立配置的 Git。source_dirty 只反映当前根工作区（不含 submodule），只上报 boolean，不上报本地文件路径。

Manifest 只请求身份绑定。Policy 来自 CP trusted registry，不从项目加载或上传，亦不执行 Policy 中的命令。`start --issue` 绑定当前项目仓库中的 Issue reference，不创建/读取 GitHub Issue。source 是真实 HEAD/ref，不切分支、不 commit/reset/clean、不运行产品命令。

配置、专用凭据和 state_directory 都必须为显式绝对仓库外路径；检查 canonical ancestor，拒绝 symlink 指向项目。machine.json 首次 register 生成稳定 UUID，保存 name/platform/arch；项目移动不会换 machine ID。executor_id 显式配置，重注册不改变 machine/owner 身份。不同 Executor 可共用同一机器 state_directory；项目/endpoint/executor 单独 namespace 保存 Run session。name/arch/Client version 是额外 metadata，不改变 C1-A Executor schema。

## 专用认证与 endpoint

通过 `awh --config <absolute-config.json> <command>` 或 `AWH_CLIENT_CONFIG` 指定配置；无自动发现或用户/GitHub凭据 fallback：

```json
{
  "schema_version": "1.0",
  "endpoint": "http://127.0.0.1:4311",
  "credential_file": "/absolute/external/client.credential",
  "state_directory": "/absolute/external/state",
  "executor_id": "webskill-mac-client",
  "executor_type": "codex",
  "profile_version": "trusted-v1"
}
```

credential_file 放管理员另行生成的专用 CP credential，非 GitHub token；Unix 必须 owner-only，Windows 配置者应设置 owner-only NTFS ACL。CP trusted config 仅持有 hash 与 project/executor scope。不得通过参数、stdout、payload、Git 或交接发送凭据；错误只输出固定诊断。

endpoint 仅支持无 userinfo/path/query/fragment 的 origin：numeric loopback HTTP 或证书校验的 HTTPS。Mac 到 Windows 的第一版使用显式 SSH tunnel：Windows CP 固定 127.0.0.1:4310，Mac 本地 127.0.0.1:4311。不得直接监听 LAN HTTP、跟随重定向、读取 HTTP proxy 自动配置或关闭 TLS 校验。连接/auth/schema/ACK 错误非零退出，无静默切换 endpoint、身份或自动重试。网络总 deadline 15s，response 上限 8 MiB，所有响应要求 `authority_verified=false`。

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

Mac/Windows 都实际连接并通过后才标真实双平台 PASS。SSH、credential、管理员配置、Mac 未执行等缺口都必须明确阻断；Windows 或 fixture PASS 不能代替 Mac。验收中使用的 repo root、config、endpoint、SHA 是外部运行记录，不绑定 Profile 到 Agent 或本机路径。最终 clean-head `pnpm check`、原始失败日志、独立安装证据和实际双方验收记录通过 App-only Builder 发布到同一 Draft PR；有阻断时不 Ready、不关闭 #21。
