# C1-B Control Plane MVP (Hub #20)

Control Plane 保存 runtime Registry、Executor last-seen、Run 和 Event timeline。GitHub 仍是 Issue/Commit/Branch/PR/Evidence/Handoff/Review/Merge 的长期事实源。本服务不连接 GitHub、扫描工程目录、运行命令或启动 Executor。JSON/SSE data 都含 `authority_verified: false`；`REVIEW_PASSED` 等只是 runtime declaration，不产生 Review/merge 权限。

本阶段只交付 HTTP + SQLite，不含 Dashboard、可安装 Client (#21)、Builder Adapter (#22)、远程调度或部署平台。复用 [C1-A Protocol](protocol.md)，保留 C0 只读 CLI 和现有 App Builder。

## 本地启动

要求 Node.js 24+、pnpm 11.25.0。使用内置 `node:sqlite` / `DatabaseSync`，无新增依赖；Node 24 上 SQLite API 仍可能输出 experimental warning。CLI 固定监听 `127.0.0.1`，默认端口 4310。数据库父目录需存在。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm control-plane --database <absolute-sqlite-file> --config <absolute-trusted-json-file> --port 4310
```

SIGINT/SIGTERM 关闭 SSE/HTTP 后关闭数据库。启动/请求错误不回显 credential/config 或原始 SQLite 异常。不兼容 schema version 时停止，不自动降级。TLS、公网和生产部署不在 #20 范围。

## C1-C 可选原生 HTTPS

#21 按 PR #26 Owner 指令新增 `--https-config <absolute-external-json>`，在同一个进程/同一个 `ControlPlaneStore` 上增加 HTTPS listener；原 HTTP 始终 loopback。配置 closed `{host,port,certificate_file,private_key_file}`，显式 private IPv4（例如 192.168.2.5:8443），不接受 wildcard、公网 IP、DNS 自动解析或 LAN HTTP。三种 TLS 文件均 bounded regular、仓库外；private key 在 Unix 必须 owner-only，Windows provisioning 使用 owner/SYSTEM ACL。检查 leaf 非 CA、当前有效、真实 IP SAN 与 key 匹配；Node 原生 HTTPS 至少 TLS 1.2，Registry/auth/body/SSE 边界完全相同。任一 listener 启动失败则关闭全部 listener/store，不留下部分服务。

OS provisioning 为一次性人工设置，证书或防火墙验证未完成前不得启动 LAN listener。`scripts/c1c-https-certificate.ps1 -Directory <new-external-private-directory>` 使用 Windows PKI 创建独立非导出 CA key 和带 iPAddress 192.168.2.5 SAN 的 leaf；仅在 private directory 写 leaf key，不输出秘密、不导入系统 trust。public CA fingerprint 经可信渠道核对，Client 使用仓库外 per-endpoint CA。[Microsoft PKI 文档](https://learn.microsoft.com/en-us/powershell/module/pki/new-selfsignedcertificate?view=windowsserver2025-ps) 描述 SAN/签发；[Node HTTPS 文档](https://nodejs.org/api/https.html) 描述请求级 CA 与默认链/主机校验。

管理员执行 `scripts/c1c-https-firewall.ps1 -NodeExecutable <actual-node.exe> -ProofPath <external-proof.json>`：仅 Human 指定的可信 LAN 192.168.2.5 接口，不修改现有网络 profile；在全部 profile 上，8443 入站 allow 只限 192.168.2.3/指定 Node binary；显式 block 全部其他 IPv4 来源（覆盖已有宽 allow），读取 ActiveStore 与 filter 核对有效地址/port/action/profile/program。无第三方 proxy、SSH、service 安装或网络信任类别变更。IPv6/wildcard listener 不存在；本机 loopback 验收保持 4310。管理员规则 proof 仍不等于实际 Mac 连接 PASS。

启动示例：`node dist/control-plane-cli.js --database <existing-runtime.sqlite> --config <existing-trusted.json> --port 4310 --https-config <external-https.json>`。保留已接受 Windows Run/machine/token/Registry，同一库继续 append；不创建第二 DB、不直接复制在线 WAL 文件、不 cutover。完整跨主机备份/恢复/稳定 service identity 和 Client pending session 兼容迁移留给 #27；[Client 迁移前置 gate](client.md) 明确禁止在它完成前改址。

本地受信 config 只有 `clients` 与 `profiles`，不在 HTTP 上编辑。`profiles` 为 C1-A `ProfilePolicy[]`；`clients` 每项如下（hash 是须替换的占位符）：

```json
{
  "id": "fixture-mac-client",
  "project_ids": ["webskill"],
  "executor_ids": ["fixture-mac-builder"],
  "token_sha256": "0000000000000000000000000000000000000000000000000000000000000000"
}
```

管理员显式选择项目范围、Executor 身份和受信 Profile。注册不等于执行授权。同 Executor ID 只能属于一个 Client；ID、hash、scope 不可重复或 wildcard，最多 64 Client、每 scope 最多 64 项。Credential 在仓库外独立生成，格式 `awh_cp_` + 至少 32 random bytes 的 base64url 编码；config 只放 SHA-256 hash。GitHub App/PAT/JWT/仓库凭据不能用于认证。轮换 hash 保持 Client/Executor 身份不变。认证是可替换同步接口，无自助签发/Client 注册 HTTP API。

以下 provisioning 示例只用于 **Hub 本地 fixture**，不构成 WebSkill 接入或授权。保存为仓库外脚本，从 Hub 根目录执行，并传入不存在的仓库外专用目录。秘密只写文件，不输出到终端；使用本地 HTTP 客户端从文件读取 credential，避免复制到日志、Git、PR/Handoff 或命令行参数。

```js
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
if (!process.argv[2]) throw new Error('A new dedicated directory is required');
const directory = resolve(process.argv[2]);
mkdirSync(directory, { mode: 0o700 });
const fixture = JSON.parse(readFileSync('examples/protocol/webskill.json', 'utf8'));
const credential = 'awh_cp_' + randomBytes(32).toString('base64url');
const clients = [{ id: 'fixture-mac-client', project_ids: [fixture.project.id],
  executor_ids: [fixture.executor.id], token_sha256: createHash('sha256').update(credential).digest('hex') }];
writeFileSync(join(directory, 'client-secret.txt'), credential, { mode: 0o600, flag: 'wx' });
writeFileSync(join(directory, 'trusted.json'), JSON.stringify({ clients, profiles: [fixture.profile_policy] }), { mode: 0o600, flag: 'wx' });
```

Windows 上 mode 不替代 ACL，目录应继承仅负责人可读 ACL。使用该目录中的 `runtime.sqlite` 和 `trusted.json` 启动。演示依次 POST fixture 的 `manifest`、`executor`、`work_item`、`run`，再上报 Event。真实 Client 分发/CLI 接入留给 #21；测试只使用临时数据，不访问外部项目仓库。

## HTTP API

全部请求（包括 GET/SSE）需要单个 `Authorization: Bearer <dedicated-control-plane-credential>`。POST 只接受 UTF-8 `application/json`（可带 `charset=utf-8`），不接受压缩 body。ID 使用 C1-A 格式，未知/重复 query 拒绝，没有 URL/repo/Git/gh/command 透传。

| Method / path | Body / query | Result |
| --- | --- | --- |
| POST `/v1/projects/register` | Project Manifest | `project`, `disposition` |
| GET `/v1/projects` | 无 | scoped `projects` |
| GET `/v1/projects/:id` | 无 | `project` |
| GET `/v1/profiles` | 必填 `project_id` | 已绑定项目的受信 `profiles` 版本列表，只读 |
| POST `/v1/executors/register` | Executor，或 C1-C `{executor,client}` | `executor`, optional `client`, server `last_seen`, `disposition` |
| GET `/v1/executors` | 无 | 本 Client scoped `executors` / `last_seen` |
| POST `/v1/executors/:id/heartbeat` | `{}` | server `last_seen`, `executor` |
| POST `/v1/work-items/register` | Work Item | `work_item`, `disposition` |
| GET `/v1/work-items/:id` | 无 | `work_item` |
| POST `/v1/runs` | initial Run，`state=created` | `run`, `disposition` |
| GET `/v1/runs` | 必填 `project_id` | 该项目 `runs` |
| GET `/v1/runs/:id` | 无 | runtime `run` projection |
| POST `/v1/runs/:id/events` | Event | `event`, `run`, `cursor`, `disposition` |
| GET `/v1/runs/:id/events` | 可选 `after`（Run sequence，默认 0）、`limit`（1–100，默认 100） | `events: [{cursor,event}]`，sequence 升序 |
| GET `/v1/events/stream` | 可选 `after` 或 `Last-Event-ID`，全局 cursor | SSE |

初次注册/创建/追加返回 201；语义相同重试返回 200 + `disposition=idempotent`。Registry 身份不可通过重注册更换 repo/Profile/owner/machine/Work Item/Run initial，没有 PUT/PATCH/DELETE、Profile mutation 或 run-control 接口。Manifest 必须匹配受信 Profile ref/repository，不能携带 Policy。同 ref/version 不可替换，新 version 可添加，同 ref 不可换 repository；旧版本供已有 Run 使用。

Run 创建通过 C1-A `validateBindings`：已注册 Project、受信 exact Profile version、Work Item 项目、当前 Client 拥有的 Executor、machine 与 source repository 一致。Work Item Issue reference 可指向 Hub（外部 bootstrap 兼容），只保存 reference，不获取/复制 Issue。Run retry 返回现有 projection，不重置状态。读取限定 project scope；Executor 操作和 Event 写入同时要求 executor scope 与持久化 owner。同项目其他 Client 可观察，不能冒充 owner 追加。heartbeat 不接受客户端 last-seen，服务端时钟回退也不使 last-seen 倒退。

错误格式 `{"error":{"code":"...","message":"..."},"authority_verified":false}`。401 未认证；403 scope/受信 Policy 边界；404 缺实体/endpoint；400 schema/JSON/query/header；409 binding/state/sequence/idempotency/身份冲突；413 大小；415 media/encoding；503 DB busy/SSE 超限。busy 时仅重试同一 Event，不能改 ID/sequence 绕过冲突。未知 DB 异常固定 500，不回显请求/异常。

## 持久化与 Event

SQLite `PRAGMA user_version=2`。首次迁移在一个 `BEGIN IMMEDIATE` 事务建表/index/trigger 并设置版本；C1-B v1 升到 v2 只新增 `executor_clients` metadata 表，保留 Registry/Run/Event/owner/last-seen。重复启动不重建，未来版本 fail-closed。启用 foreign keys、WAL、`synchronous=FULL`、5s busy timeout。Profile seed 原子应用，不把 Client credential/hash 或 App key/token 存入 DB。DB/WAL/SHM 有 gitignore，真实 runtime 文件建议存仓库外。

C1-C metadata DTO 为 closed `{schema_version:"1.0",executor_type,machine_name,arch,client_version}`，不放进既有 closed C1-A Executor entity。类型、hostname、arch 和 semver 有格式约束；safeData 拒绝凭据/复杂 JSON。Metadata 仅当前 owner 可随 register 更新（例如升级 Client version），不会改变 Executor/machine/owner 身份。GET executors 与 heartbeat 返回已持久化的 optional client。旧直接 Executor 注册、旧 DB 及无 metadata 的 heartbeat 兼容，last-seen 仍由 server 生成。此扩展不开放 Profile 上传或凭据签发。

Event append 在 `BEGIN IMMEDIATE` 下读取 initial/history，调用 C1-A `appendEvent`，插入 Event 并更新 Run projection，全部成功才 COMMIT。投影写失败时 Event/cursor 一起回滚。独立 SQLite 连接也争用写锁；重启恢复 projection/history，Client 可重发未确认 Event。

Event ID 是 Run 内 idempotency key；optional HTTP `Idempotency-Key` 必须匹配 Event ID。只有内容 canonical 相等的同 ID retry 成功；同 ID 不同内容、同 sequence 不同 ID、缺失/乱序 sequence 都冲突。DB `UNIQUE(run_id,event_id)`、`UNIQUE(run_id,sequence)` 及禁止 Event UPDATE/DELETE、initial Run identity 更改的 trigger 提供存储保护。timestamp/terminal state/verification/Handoff/PR exact-head/reviewer declaration 继续遵守 C1-A replay，不能作为独立 Review authority。

HTTP JSON 最大 64 KiB（header 与 streamed byte count 都检查）、Event payload 最大 32 KiB、深度 32、节点数 10000；schema 在写入前验证。拒绝已知 PEM/JWT/GitHub token/专用 CP token 字符串形态与 credential 字段，错误不回显原值；发送方仍须主动移除敏感数据。extensions 仅数据，不能执行。

## SSE

frame：`id: <global-persistent-cursor>`、`event: run-event`、`data: {cursor,event,authority_verified:false}`。连接发 `: connected`，随后按全局 cursor 升序发送 scope 内已提交 Event。默认从 0 replay；单个 `Last-Event-ID` 或 `after` 恢复已见 cursor 之后的历史，两者不可同时设置，负数/未来 cursor/重复参数拒绝。REST events 的 after 是 sequence，SSE 的 after 是全局 cursor。

每 250ms 从 DB 查询，能观察其他本地连接的提交并支持服务重启恢复。网络可能重放，Client 按 cursor 去重；idempotent retry 不生成新 cursor/frame。scope 外 Event 不发送，cursor gaps 正常。15s heartbeat comment 不代表 Executor heartbeat。

最多 64 SSE 连接；backpressure 暂停轮询，缓冲超过 128 KiB 断开，用已处理 cursor 重连。shutdown 清理 timers/连接。headers/request/body 有时间/大小限制，不自动连接外部项目。

## 验证与限制

`pnpm check` 覆盖既有 Builder/Protocol/C0 及 Control Plane tests：真实 migration/restart、CLI 进程重启、Registry/owner/bindings、Event 原子回滚/SQL append-only、HTTP 大小/schema/credential 边界、多个 worker 独立 SQLite 连接竞争、HTTP 并发重试和 SSE live/reconnect/scope。fixture 不访问外部项目、模型或网站。

同步 SQLite/完整历史 replay 适合本地 MVP；append 成本随单 Run 历史增长，Registry list 尚未分页。高吞吐、大规模历史、跨节点部署、credential 分发/撤销基础设施、repair/backup CLI 与 Dashboard contract 后续独立设计。服务不替代 GitHub exact-head Evidence/Handoff/Review gate，不支持 approve/merge/下一阶段。
