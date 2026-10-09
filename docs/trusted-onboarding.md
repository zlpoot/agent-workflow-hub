# C1.2 Trusted Onboarding：离线安全设计与 Review Gate

> Onboarding currently runs **offline Fixture only**. Production Operator/Pairing is unavailable. #31 Phase B0 adds admission before request traversal/authentication and replaces catch → recordDenied SQLite writes with bounded memory counters. Limits, recovery design and production gaps are in [B0 security](onboarding-b0-security.md); fixture checks are Builder evidence pending independent Design/Security Review.


本规范对应 [#31](https://github.com/zlpoot/agent-workflow-hub/issues/31) 与 [Owner kickoff](https://github.com/zlpoot/agent-workflow-hub/issues/31#issuecomment-6055785767)。本轮仅实现可独立审查的隔离 fixture；没有生产监听入口，不接入原 CP，不使用现有配置、凭据、数据库或产品工作区。#30 的 PHASE_C_ACCEPTED_WITH_EXCEPTION 与原 Verification Exception 永久保留。

## 1. 架构与安全 Gate

已合并 CP 的 ControlPlaneStore 采用 SQLite v2，Client hash/scope 由外部 trusted config 静态注入，Dashboard 另用只读 Viewer cookie。C1.2 新增独立 onboarding 模块与独立 fixture SQLite，保持这些既有入口不变。fixture 使用全新临时目录和专用标记；禁止把普通 CP v2 文件交给该模块。旧 Registry/Client 身份在测试中仅由模拟快照保留为不可重绑定的 reservation，不读取原数据库。

本设计冻结之后可实现下述离线最小闭环。进入真实 CP 前另需 Human 与独立安全 Review：真实 Operator 认证及安全会话发放、TLS/loopback 通道实现、CLI 交付材料与 owner-only 存储、单写者/backup/rollback/迁移兼容评审、保留既有 Client 认证的受控接入。fixture 的 verified transport 是可信测试适配器注入的模拟上下文，不是生产 TLS 验证或远程文件系统证明。若上述条件不可满足，停在 Design Gate，不放宽约束。

## 2. 身份、权限与 Profile

| 身份 | 能力 | 明确禁止 |
|---|---|---|
| 独立 requester Operator session | 申请、读取自己申请的安全状态 | 审批、配对、其他人的申请 |
| 受信 Operator session | 在配置的精确 repository 范围审批、拒绝、创建/撤销邀请、读取审计/诊断 | 新增 Profile 权限、GitHub write、执行命令 |
| Pairing Client 通道 | 认领自己收到的一次性材料，验证模拟凭据及读取自己 project 的安全诊断 | Operator API、他人邀请/Client/Project |
| 已有 Client bearer / Viewer cookie | 原有 reporting / read-only API | 任何 Operator 权限升级 |

Operator 的 awh_operator cookie（awh_op_ 独立格式）与 awh_viewer、CP Bearer 分域。受信配置只存带 operator 域分隔的 SHA-256、绝对 expiry、role 和 repository scope；Pairing hash 另用 pairing 域分隔，CP credential hash 保持现有 createAuthenticator 的 SHA-256 兼容。API body 不能指定 role/permissions。fixture 固定为数值 IPv4 loopback Operator origin，不提供登录/会话生成 HTTP 端点。生产 HttpOnly/SameSite/安全 session 发放尚未部署。

审批仅接受已配置的 future-ui/default → zlpoot/future-ui 与 webskill/default → zlpoot/webskill 的精确 version。保存并核对完整不可变 ProfilePolicy，永不修改 src/profiles.ts 的 Builder 工作流/固定 branch/check/权限。未知 repository 可以作为 pending 申请保存，审批必须拒绝；未审批请求不是授权。已绑定 project/repository/profile/version 的重复审批幂等，冲突一律拒绝；不存在隐式 adopt、replace 或 credential rotation。

## 3. 状态机与闭环

项目申请：pending → approved / rejected，终态不能回转；审批与有效 project 绑定、审计在同一 BEGIN IMMEDIATE 事务提交。已存在精确 project 绑定可以幂等复用，已有 CP Project 仅作为 reservation，不能借此改写身份。

邀请：pending_delivery → active → claimed / revoked / expired / locked。只有私有交付与激活审计成功后才 active；pending_delivery 不能认领且不会因重启自动激活。TTL 固定最多 300 秒，最多 3 次有效通道的失败认领；服务器单调时间水位持久化，时钟回拨不能复活邀请。失效/超限/撤销/已认领均不可恢复。一个 executor/client/machine 不得被多个有效邀请或其他历史身份抢占；旧/已认领的身份保留，撤销 Client 也不释放身份。

闭环：project request → Operator approve → issue scoped invite → trusted out-of-browser mock Client receives secret → Client checks exact declared repo/profile/executor/machine/service/endpoint/CA plus explicit local-root verification/user confirmation → atomically consume invite + persist dedicated credential hash/single-project/executor identity + append audit → deliver credential only to the Client private sink → query safe diagnostics.

邀请绑定 project_id/repository/Profile ref+version/client_id/executor_id/executor_type/machine_id/platform/service_id/endpoint/CA fingerprint。只有服务器已批准的 project 与服务配置构成授权；认领者不能改变任何字段。Git root/origin 是 Client 本地核对声明，服务器不把它视为远程文件系统 attestation 或 GitHub 授权。

秘密只生成于服务端内存；SQLite 仅存邀请 hash、Client credential hash 与固定作用域。Browser request/response、diagnostics、audit、Run/Event、Git、日志、URL、Handoff 均不得包含这些原值。创建邀请响应只有 identifier/status/expiry，秘密通过另外受信的交付 sink 送达；claim 响应也只含安全状态，credential 经 Client 私有 provisioning sink 交付。Client 为 pending_delivery → active / revoked，只有交付和激活审计成功后才 active；崩溃/存储故障遗留 pending_delivery 仍不可认证，没有自动补发。只有一次发送，丢失响应不恢复秘密；交付失败使邀请或 Client 终止/撤销，并产生脱敏审计，必须重新经 Operator 审批创建新身份，不能重新认领旧邀请。

## 4. API 契约

机器可读契约见 contracts/onboarding-v1.openapi.json。offline dispatcher 不创建 HTTP server/socket；下列路径用于 fixture 内接口验证及后续 host integration 的契约，并不表示生产入口已开放。

| 路径 | 方法 | 身份与用途 |
|---|---|---|
| /onboarding/v1/nonce | GET | 独立 Operator session，发放无权限的一次性 CSRF nonce |
| /onboarding/v1/requests | POST | requester/operator，提交 project/repository/profile/version |
| /onboarding/v1/requests/{id}/decision | POST | Operator approve/reject，不能上传 Policy |
| /onboarding/v1/invitations | POST | Operator，创建固定 scope 邀请，指定预配置的受信交付 sink |
| /onboarding/v1/invitations/{id}/revoke | POST | Operator，撤销 active 邀请 |
| /onboarding/v1/requests/{id} | GET | requester 自己或 scope 内 Operator，安全状态 |
| /onboarding/v1/projects/{id}/diagnostics | GET | scope 内 Operator 或该 Project Client，安全诊断 |
| /onboarding/v1/audit?after={cursor} | GET | Operator，只返回其 scope 的审计元数据 |
| /pairing/v1/claim | POST | 专用非浏览器 Client 通道与 Pairing header，一次性认领 |
| /pairing/v1/diagnostics/{project_id} | GET | 专用 Client bearer 与受信非浏览器通道 |

所有 Operator POST 必须 exact Host + Origin、可信 numeric loopback peer、单一 session cookie、application/json、one-use x-awh-nonce；拒绝跨站/重复头/forwarded header/Authorization fallback。nonce 与 session hash 绑定、最多 60 秒、消费持久化；失败后也不可重放。body 为严格字段集合，有限 JSON/大小/深度，没有自由文本 reason、Policy、命令、URL 或任意权限字段。Client claim 拒绝 Cookie/Origin/Sec-Fetch-*，通道由服务端测试 adapter 验证，不从 body 中接受 verified:true 作为授权。URL 不包含配对材料，401/403/409 等错误固定且不回显输入或 SQLite 文本。

诊断保留 authority_verified=false/source=offline_fixture；fixed branch/check 仅声明数据，不执行。provider_app_permissions、真实 branch/check、真实 Git root 仍为 not_checked。未完成审批/配对、已撤销和绑定冲突为 blocked；即使模拟认证成功，也不将整体真实产品 preflight 标为 passed。

## 5. 威胁模型与事务

| 威胁 | 控制与负例 |
|---|---|
| Viewer/Client/请求字段冒充 Operator | 独立 session hash registry、固定 role/scope、拒绝 bearer/cookie 混用与未知字段 |
| CSRF、DNS rebinding、代理绕过、请求重放 | exact loopback origin/Host/peer、拒绝 forwarded headers、单次 nonce/expiry/session 绑定 |
| 邀请猜测/泄漏/重放/竞态 | 256-bit 材料、hash-only、短 TTL/3 attempts、BEGIN IMMEDIATE + 单次 conditional update/unique scope；并发 worker 仅一个成功 |
| Profile/Repo/Executor/机器/CA/service 错配 | 严格 scope tuple 与预置 policy 限制核对，权限提升字段拒绝 |
| 旧 identity 被重写 | 不可变 reservations、client/executor/machine 唯一性、终态仍保留 ownership；完整事务回滚 |
| 失败后半写、重启复活、时间回拨 | project/client/invite/audit 同事务、事务失败整体 rollback、持久时间水位、跨重启 nonce/claim 重放拒绝 |
| 原凭据进入浏览器/日志/Event/存储 | 私有 delivery/provisioning sink、严格 safe projection、credential-pattern 拒绝、SQLite/WAL/审计/响应扫描 |
| 把 fixture 当成现场验证 | 明确 offline source / authority_verified=false / not_checked；没有自动挂接 CP/CLI/Dashboard |

audit 为 append-only 安全元数据：cursor/time/actor/action/target/project/repository/result/code。准入/输入/鉴权拒绝只记有界内存分类，不写 SQLite、不记录 cookie/header/body/原始错误；已进入受信配对事务的失败尝试与 locked 等业务状态仍需同事务审计。fixture SQLite 强制不可更新/删除 audit、不可更新已绑定身份/Policy/Client scope；8192 条持久审计与 8 MiB 存储门禁耗尽时新增事务 fail-closed，不删旧审计。身份/审批错误没有部分信任写入。

## 6. 兼容性与本轮停点

不改变 CP v2 schema/user_version、ControlPlaneStore/createAuthenticator、现有 Client namespace 或 #23 Dashboard OpenAPI。隔离库的 fixture schema/version 与 CP v2 不互用；旧 CP fixture 的 7 张表/历史在 onboarding 操作前后保持一致，Dashboard 可继续独立读取。真实集成迁移和动态 Client hash/scope 注入留待单独设计与授权，不声称现存 CP 已接受新 Client。

本轮完成定向负例后生成本地提交候选，在 exact clean head 最多执行一次 pnpm check。Evidence 放 gitignored .handoff/；不 Push/PR/Ready/Handoff 发布，不借用 hub/c1g。停在 Human/ChatGPT 独立 Review Gate。后续需先批准可读离线代码的审查/交付方式；任何新的 Builder workflow、生产配对、迁移或现场验收再单独授权。

## 7. 离线复现与限制

安装现有 pinned dependencies 后，在 Hub 独立工作区先运行 `pnpm exec tsc`，再运行 `node --test tests/onboarding.test.mjs`。测试自建并清理专用临时目录/数据库；并发 worker 只在内存传递模拟 Client 请求，不把材料序列化到磁盘、浏览器或输出。`scripts/onboarding-contract.mjs` 同时生成 runtime schema 与 OpenAPI，测试保证二者一致。全量最终验证仍只在最终 clean head 运行一次 `pnpm check`。

mock 适配器不能证明真实 TLS/CA/HttpOnly/NTFS ACL、真实 Git root/origin 或生产身份管理；这些是独立部署 Gate。本轮没有新 connect/doctor 命令、Dashboard wizard、动态 CP trusted-config 注入或真实迁移。若私有交付后存储故障遗留 pending_delivery，身份保持 blocked，Operator 可通过审计定位并撤销未激活邀请；Client 不提供自动重新认领、补发或身份覆盖。
