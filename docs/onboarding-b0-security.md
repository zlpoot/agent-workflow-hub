# #31 Phase B0：离线安全边界（待独立 Design/Security Review）

基线：#48 合并后的 main `318a00ae5b11a9e7d1f3d2e51d48c6b583c8fab1`。范围依据 [B0/B1/B2 规划](https://github.com/zlpoot/agent-workflow-hub/issues/31#issuecomment-6057899954) 与 [Owner 固定工作流授权](https://github.com/zlpoot/agent-workflow-hub/issues/31#issuecomment-6075664595)。只在 Hub 新分支 `codex/c1h-b0-security` 实施离线 B0，通过显式 `--profile hub --workflow c1h-b0` 发布一个 App Draft PR。旧离线候选只作为复核输入，不复用其分支/基线/验证结论。本文件冻结 B0 设计选择；生产实现、临时 HTTPS CP 集成属于 B1，原 CP 接入属于 B2，均需 Review PASS 和单独授权。#30 的 PHASE_C_ACCEPTED_WITH_EXCEPTION 与原 Verification Exception 永久保留。

## 1. P2 admission 与有界审计

分流顺序：低成本前置 lane/identity admission → 有界请求检查 → 完整 Operator/Client 通道认证 → POST schema 校验 → nonce/可信决策事务。前置选择只读取固定 path/header descriptor 与受信模拟 transport；Operator cookie 做固定长度摘要的预置 session index 查找，并以可信配置的 expires_at 和无 SQLite 访问的认证时钟水位排除过期 session。未知/过期 cookie 走匿名 lane，时钟不可验证则关闭且不进入 Operator lane。Pairing ID 仅来自受信 transport，不相信 body。预分流不授予权限，仍需全部 Host/Origin/TTL/scope/CSRF/服务与凭据验证。匿名、Operator、Pairing 独立额度在输入遍历和完整鉴权前预留；已知有效身份额度也前置。fixture 的非规范 header 大小写可能先走更保守的匿名额度，经完整认证后再预留对应身份额度，不放宽原鉴权；B1 adapter 必须规范化 HTTP header。所有拒绝只返回固定错误码，不回显输入，catch 仅更新有界统计，不补扣请求或写 audit。

PR #49 R1 修复边界：匿名、格式/schema 错误及认证失败不写 SQLite；POST 在有效 schema 后才消费一次性 nonce，进入可信决策后的失败仍不能重放该 nonce。对已认证 Operator 的项目申请/approve/reject/创建与撤销邀请，以及已验证私有通道和有效材料后的 claim 决策，固定语义拒绝在原写锁/配额事务内先 rollback 业务 savepoint，再提交不可变 denial audit；包括 actor、固定 action/code、已校验 target 与最小 project/repository 元数据，不保存整个输入、header、秘密、hash 或原错误文本。既有失败材料/终态的 claim attempt 审计仍保留，actor 改为受信 transport peer 的 Client ID。审计写入、busy、行数或存储门禁失败时关闭，不跳过审计授予信任；外层 catch 从不补写拒绝审计。读取操作的普通拒绝统计仍为内存观测，不能冒充写决策审计。

离线固定上限（非可从请求覆盖的 policy）：

| 边界 | 上限/行为 |
| --- | --- |
| 请求对象 | body 64 KiB UTF-8、1024 JSON 节点、深度 16；数组 length 与总节点同预算，仅允许连续自有元素，无 hole/额外属性，超长数组在 ownKeys 前拒绝；header 64 项/16 KiB，单项至多 4 个值 |
| Operator lane | 每秒 256 请求；已认证 session 每秒 64；独立于匿名/配对 lane |
| 私有 Pairing lane | 每秒 128 请求；受信模拟 Client ID 每秒 32；通道认证不等于邀请码认证 |
| 匿名 lane | 每秒 64 请求；不能占用 Operator 配额 |
| 各 lane 在途 | 8；不排队，超限 429；释放必须在 finally |
| 身份桶 | 每 lane 最多 64，仅 Operator session ID/受信 transport Client ID；满时拒绝，不按攻击者 ID 淘汰旧桶 |
| 拒绝聚合 | 内存固定 lane × 分类计数，饱和上限 1,000,000，不保留请求/身份/secret；无定时落库、无后台 flush |
| 业务审计 | fixture 最多 8192 条；不可变，满时所有新增事务 fail-closed，不删旧审计、不把成功操作改为无审计 |
| 存储/锁 | fixture 主 DB 和 WAL 各 8 MiB、rollback journal 8 MiB；BEGIN IMMEDIATE 持有写锁后统一检查，包含初始化事务；SQLite 页上限；busy timeout 50 ms，失败 503，不重试 |

匿名丢弃统计是可丢失的观测，不冒充持久安全审计。身份/邀请/审批/已进入配对事务的失败（例如错误有效材料的 attempt、terminal replay）仍在原事务写不可变业务 audit；授权失败不能获得 trust。一个受信身份可以耗尽自己的配额/fixture 存储，届时新增接入关闭，已有审计与旧 CP 继续保留。页/WAL 门禁提供有界增长与异常停止，阈值检查至多有一个已入事务的 overshoot；没有对未知已有 DB 自动截断/清理。多进程不可复用内存限流来放大预算：B1 必须单写者/单 host admission；B0 只用多进程证明 SQLite 持久行数门禁、竞争和回滚。

时钟：admission 使用单调进程时钟，回拨或非有限值使请求关闭；独立认证时钟保留当前进程观测与已持久 fixture clock 的下界。匿名/认证拒绝不更新持久水位；仅发生拒绝后重启并回拨，不能从 B0 推导 session TTL 的跨重启保证。生产设计要求重启注销所有 Operator session（第 2 节），B0 未实现。重启重置速率统计，但不重置 audit quota、邀请/attempt/nonce/identity 的持久状态。

初始化同样属于可写路径：已有 fixture 不再在写锁前修改 journal_mode；持锁后先检查物理容量、schema 与 audit quota，再验证配置与写 clock。审计或存储已耗尽时 constructor 以 503 关闭并 rollback，不靠反复打开绕过 quota。仅新建空 fixture 的初始 WAL 模式设置发生在初始 schema 事务前，不复用/改造旧 DB；初始化失败不能返回可用 Store。近 quota 的 SQLite writer 串行检查不使用锁前容量快照，保留单次已允许事务的有限 overshoot，不宣称跨进程内存限流共享。

### 审计耗尽的紧急 quarantine / recovery（B1 设计 Gate，未部署）

硬 quota 满时，常规审批、配对、nonce 和撤销等需新增 audit 的写操作全部 503；禁止 DELETE/UPDATE 既有不可变 audit、抬高阈值自动续写或静默跳过审计。B0 只证明隔离 fixture 关闭，不声称实现了生产紧急撤销。

生产 B1 必须有独立于已满 identity/audit DB 的 Owner OS 认证私有控制路径。进入 emergency quarantine 时关闭新增信任、私有交付和所有动态新 Client 的认证，拒绝 existing-active dynamic 身份继续凭旧 snapshot 通过；只封闭新增 adapter/身份域，不停原 CP、不修改 legacy config/身份/Run/Event。隔离状态和受影响 generation/理由/最后 cursor 只存非敏感元数据，在新、专用、OS 保护且有预留空间的 recovery 存储中持久化。若该存储也失败，进程仍在内存封闭，重启默认 quarantine，不能因为 marker 缺失/损坏自动恢复动态认证。只有 Owner 经私有 OS 通道的新明确恢复决定才能解除；B1 的具体通道、单 writer 锁、latch 和预留存储都需独立实现/Review，不能将本轮 mock 当成证明。

恢复流程必须先在新建 synthetic snapshots 演练：保存满库及所有不可变 audit 的一致性只读证据（末尾 cursor、generation、schema、摘要），冻结旧段，不更改旧字节；核对 claimed/revoked/expired/locked 和 revocation watermark，未知或备份较旧保持 quarantine。Owner 另行批准后，在新的受控存储段创建带前段摘要/cursor 的 append-only recovery 记录和审计，单 writer 原子切换经审核的 generation。旧段继续保留并可追溯，不复活邀请、不重新交付原凭据、不覆盖 legacy identity。空间、校验和、generation、配置/服务绑定或恢复确认任一步不满足都停止且保持 quarantine。真实 snapshot/段切换/服务激活仍属于单独 Human Gate；B0 不读取原库、不建真实 recovery 文件、不实施迁移。

## 2. 生产 Operator host / session 设计（未实现）

选定独立受保护 loopback Operator host，精确 IP/端口/Host 白名单，与 Viewer host、Client reporting host 分域；不相信 Forwarded/X-Forwarded-*，不接受 wildcard CORS、任意 Origin、跨域 bearer 或 Viewer cookie。B1 启动需核准空闲端口、service 身份、受信 OS 用户、单实例锁和独立证书；不沿用正在运行的原 CP listener。

Operator bootstrap 必须经 OS 认证的本机私有通道（Windows pipe 限当前 Owner SID，macOS Unix socket 限用户），而不是网页/URL/argv 中的秘密。Session 256-bit 随机、server hash-only、绑定 operator/role/repo scope/service，idle 15 分钟、absolute 1 小时；登录/权限变化旋转，退出/撤销使该 session 和 nonce 失效。故障和重启默认注销全部 Operator session，禁止无保护的长期 admin cookie。

生产 HTTPS cookie 使用独立 __Host-awh_operator、Secure、HttpOnly、SameSite=Strict、Path=/、无 Domain；现有 awh_operator 仅保留 fixture 契约，不声称发行过生产 cookie。POST 必须精确 Origin、Host、application/json、无 content-encoding、一次性 session/action/service 绑定 CSRF nonce（60 秒）；拒绝 Fetch Metadata cross-site、navigate/no-cors，缺失 Metadata 必须仍通过 Origin+nonce，不由 absence 免检。GET 不改变业务授权；nonce 发行仍计入有界授权审计。

生产 TLS 校验链、有效期、EKU、目标 IP SAN/hostname 和指定 CA；禁止 rejectUnauthorized=false、系统未知 CA 回退、自动改 endpoint/CA 或 redirect。证书和 service ID 不一致 blocked。fixture verified=true 不能证明上述任何条件。

## 3. 私有邀请与 Client 凭据生命周期（未实现）

审批状态 pending → approved/rejected；binding 精确 project/repository/Profile version，不允许 Viewer 升权或修改既有固定 Profile。只有明确 Operator scope 可创建邀请。

邀请 pending_delivery → active → claimed / revoked / expired / locked；TTL 300 秒、256-bit 材料、最多 3 次有效坏材料尝试、终态不可恢复。浏览器只见 id/状态/期限。私有邀请交付经 OS 认证通道或 B1 核准的有界 mTLS service；邀请码禁止进入 URL、网页、环境扩散、剪贴板自动复制、CLI argv、GitHub、日志、Event/Handoff。

Client 本地规范化 Git root/origin 并取得用户确认，只代表 client_local_claim，不是 GitHub attestation。Claim 请求必须绑定 endpoint/CA/service/project/repository/Profile/executor/machine，与 peer 身份一致。通道身份、邀请码和 Client bearer 是三个独立检查。

Client pending_delivery → active / revoked：server 先提交 hash/scope/pending；私有安全写入 Client credential 后发送 installation receipt；再以原子 audit+state+registry generation 激活。发送/持久化/ACK 任一步失败均 pending/blocked 或 revoked，不重发同材料，不通过 snapshot 回滚复活。Client 尚未收到 active 确认不能上报。丢 ACK 的不确定身份必须人工撤销/重新申请；任何重试不得暗中覆盖旧身份。

Windows Client secret：仓库外用户专用目录/NTFS file，DACL 仅 Owner SID 与核准 service SID、关闭不必要继承、拒绝 broad Everyone/Users/Authenticated Users；拒绝 reparse point/hardlink，写临时文件→ACL 校验→原子 rename→flush。macOS 使用用户 Keychain 优先；若另行批准文件方案，目录 0700、文件 0600、验证 uid/无 symlink、原子替换+fsync。不把 mode 数字当成 Windows ACL PASS。B1 必须实测 OS 权限、崩溃和残留，不读取旧 Client secret。

## 4. CP v2 兼容与独立信任存储选择（未实现）

选择独立的新 trusted identity SQLite，保持原 CP v2 schema、Event/Run/Journal/Handoff 表和外部原 Client config 不变。B0 的 schema 101 不升级原库、不作为生产 identity DB。B1 仅新建 synthetic fixture 演练新 schema，不导入真实配置值。

未来 CP 单写者拥有新增 identity store。新 Client hash/scope 与只读加载的 legacy registry 合成 immutable generation；每次请求重新取得当前 snapshot，不继续依赖只在启动时捕获的 createAuthenticator(clients)。legacy 优先保留：ID/hash/executor/machine/project binding 冲突阻断，不能覆盖、撤销或轮换 legacy credential。只有新的 identity 可以独立 revoke；撤销 generation 必须立即拒绝旧 bearer，历史保留。

identity activation 与其 audit/generation 在同一数据库事务；CP Event 写入仍在原 v2 独立事务。禁止把跨两个 SQLite 的提交称为原子操作。writer crash 恢复由 identity 自有 journal/终态检查决定；加载失败时拒绝所有动态新身份，legacy 保持已有原语义，且不放宽其 scope。

迁移/备份：停止新增 onboarding、冻结 registry generation，在新 identity store 建一致性 snapshot；记录 schema/generation/摘要，不拷贝 Client plaintext。恢复必须检验服务身份、校验和、revocation watermark 和单 writer 锁，拒绝旧备份复活 claimed/revoked invite/client。无法证明 watermark 时动态身份整体 quarantined，等待 Owner 决定。回滚只卸载新 adapter，不重写 v2/config 或现存历史。任何读取原值、备份原库、服务重启均属于 B2 单独授权。

## 5. 安全诊断与错误契约

保留现有 Diagnostics DTO 和路由；新增纯函数 `doctorDiagnosticContract` 与闭合 `DoctorDiagnostics` schema，只为后续 doctor 定义脱敏契约，不实施 #32 CLI 或真实探测。输入必须来自已完成 scope 校验的 fixture Diagnostics；按每项固定 state/code 组合投影，输出每检查 passed|blocked|not_checked、固定 code/source/safe_next_step、authority_verified=false，删除全部 binding/policy/身份/路径/命令。passed 仅说明该 fixture 的审批/配对，不构成 live authority；Git、verification、provider 始终 not_checked，overall 不得 passed，未知组合拒绝。新增 SafetyDiagnostics 只是内存测试 DTO，没有生产/网页路由：固定 admission/aggregate/quota 元数据，无 Cookie/hash/Client ID/邀请码/凭据或文件路径。

401 身份缺失/错误；403 Origin/CSRF/scope/服务绑定；400 非 JSON/复杂度/字段；413 大包；429 admission/nonce 配额；409 身份/终态冲突；410 邀请不可用；503 busy/storage/audit quota；500 时钟/内部/projection。所有错误都 fail-closed，不能把拒绝次数统计失败转成成功，也不能在 catch 再写数据库。

## 6. 威胁与可验证停点

| 威胁 | B0 验证 | B1/B2 仍需证明 |
| --- | --- | --- |
| 多来源匿名 flood、恶意大包/Origin/Cookie | audit/DB/WAL 零增长，有限输入/计数/桶 | raw HTTP 字节与超时限制、OS/network admission |
| 有效 session 恶意高频/身份轮换 | per-session/global/in-flight 独立上限、审计 cap | 单 host/single writer，不能每连接重建限流器 |
| SQLite busy、磁盘满、聚合异常 | 503、无授权/事务残留、无 catch 写放大 | 实盘与故障注入、备份/恢复 |
| 邀请 replay/race、权限提升/秘密泄漏 | 延续 Phase A 全部负例 | 真实 channel/ACL/receipt/generation |
| audit 删除/回滚复活身份 | 不变 trigger、持久 quota/restart | watermark/quarantine 的 synthetic 演练与 live grant |
| 接入负载饥饿 CP Event writer | 两个纯 synthetic DB 的延迟/游标对照 | 真实 CP 延迟不是本轮证明 |

延迟对照记录同一 fixture 的空载与拒绝流量下 max/mean，只标 OBSERVED_ONLY_NO_PRODUCTION_SLA。Windows 磁盘 flush、调度和其他测试会影响 timing；不能从单次 fixture 毫秒数推导原 CP 的性能或 B1/B2 SLA PASS。B1 必须另定义 workload、baseline、采样分位数和明确通过条件。

固定有序验证命令：`pnpm build` → `node --test tests/onboarding.test.mjs tests/builder.test.mjs`；补充 `node --test tests/onboarding-b0.test.mjs` 并独立记录，不修改固定命令列表。禁止 pnpm check / Actions。所有 DB 都是自行创建的 fixture/synthetic snapshot，新增 CP v2 对照通过显式 `init` 创建不存在的临时文件再以 existing 模式打开，不启动 listener、不读取原 CP。最终提交在 exact clean HEAD 执行上述命令；环境、前后 SHA、退出码、统计、原始 stdout/stderr 与失败历史留在 ignored .handoff/ 并发布 App evidence 评论。固定工作流 bootstrap_paths=null 不授予任意路径/执行权限；仅本轮 B0 代码/测试/契约/设计与对应绑定允许变更。

交付限定一个 App Draft PR：完整 selected-set metadata-only preflight → Hub 单仓库 write token → 固定 Builder push/PR → evidence → pending Handoff 评论与回读 → confirmed JSON、exact expected-head CLI 输出更新同一评论与回读 → 远端 base/head/Draft/App actor 复核。既有 hub/c1h、hub/c05/default、其他 Profile 与 dormant agent-desktop 不变。Builder 验证不代表独立 Review；不执行 Ready、审查批准、merge、Issue close 或自动下一阶段。Provider 写入失败或状态不确定即停止，不隐式重发。

若未知 main/工作区变更、需要原配置/凭据/DB、需要 listener/TLS/产品工程、不能保持不可变 audit/身份、不能证明上限或 fixture 隔离，则停止。B0 完成后交付文档/契约/源码和隔离日志到独立 Design/Security Review，未通过不得进入 B1。

参考：[OWASP DoS](https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html) 的资源/速率上限、[OWASP CSRF](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html) 的 Origin/nonce/Fetch Metadata 组合、[OWASP Session](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) 的 session/cookie 生命周期。本轮是上述原则的离线设计，具体平台机制需 B1 独立验证。
