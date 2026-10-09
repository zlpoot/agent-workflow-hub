# v0.1 MVP 使用与验收

> Historical / Legacy. This records the original version and its authorization boundary. Current main ships Client 0.4.4; the old task/candidate/setup text below is historical, not a permanent instruction or new production authorization. See [current Client](client.md).


唯一实施任务为 [Hub #39](https://github.com/zlpoot/agent-workflow-hub/issues/39)，真实 Windows 文档验收为 [Future UI #88](https://github.com/zlpoot/future-ui/issues/88)。动态 Onboarding #31 B0/B1/B2 暂停；已合并 fixture 和 #28 原始 Deliver、恢复修复及历史证据保留。本候选复用现有 CP v2、Client、固定 App Builder、Handoff 和 Viewer，没有新 Dashboard、动态 Registry、模型 API、监听器或自动合并。

## 能力盘点

| 模块 | 可实际运行的入口 | 本候选工作 |
| --- | --- | --- |
| Control Plane | 原 loopback HTTP / REST / SQLite v2 | 原服务、数据库、Client 认证和历史保留；只追加静态 Profile 版本 |
| 固定 Profile / App Builder | builder preflight/push/PR/evidence/Handoff | hub/v01-mvp 与 Future UI mvp-docs 固定到 #39/#88 |
| 安装型 Client | awh register/status/start/event/finish | 集成 #28 deliver；新增 timeline/sync |
| Viewer | 既有 Dashboard read API / viewer | 可复用；MVP 日常使用 CLI，不新部署 Dashboard |
| Deliver | 保留 #28 的 App exact-head 交付与耐久 outbox/journal | 真实 Windows 小任务接入，Review/终态观察分离 |
| Onboarding | 离线 fixture schema 101 | 保留，首版不激活生产服务 |

## 静态接入与原数据

在 Hub 安装锁定依赖并 build。管理员显式执行下面的一次静态 seed。命令要求仓库外已有 CP v2，不创建 DB、不迁移、不读取 trusted config/credential、不重启 CP。复用原不可变 Profile seed 事务，仅追加 future-ui/c1c-acceptance@v01-mvp-docs-v1。旧版本、Project ref、Executor、machine、endpoint、Run/Event 不变；原 CP 查询直接读取同一库里的新版本。

    node dist/mvp-cli.js seed-profile --database <existing-external-runtime.sqlite>

为本候选创建一个仓库外 Client 配置文件：沿用原 credential_file、state_directory、executor_id、executor_type、endpoint 和 CA，仅 profile_version 选择 v01-mvp-docs-v1。保留旧文件，不更改其内容；此版本使用同一 namespace 和机器，旧 terminal Run 正常归档。不得删 session/journal、改 endpoint 或换身份绕过失败恢复。

在独立 Future UI codex/awh-v01-acceptance 工作区使用原 minimal Manifest，project.id=future-ui，repository=zlpoot/future-ui，profile.ref=future-ui/c1c-acceptance。这保留既有 Project 身份，不切换 #70 活动分支。唯一交付路径为 docs/management/awh-v01-acceptance.md、.awh/project.yaml 和日志所需 .gitignore。固定验证只执行 git diff --check origin/main...HEAD；文档任务不跑产品全量测试。

## 安装与日常命令

Hub build 后执行 node scripts/client-pack.mjs，得到独立 @zlpoot/awh-client 0.3.0 tarball 与 SHA-256。将包 offline/ignore-scripts 安装到仓库外工具目录；消费者无需 Hub checkout。旧安装包和原 CP runtime 保留，不替换生产服务。已有 Client 用 register 更新版本 metadata，machine/executor/owner 不变。

    awh --config <external-mvp-client.json> register
    awh --config <external-mvp-client.json> status
    awh --config <external-mvp-client.json> deliver --title <title> --body <utf8-file> --hold-draft
    awh --config <external-mvp-client.json> timeline
    awh --config <external-mvp-client.json> sync

status 展示 Project、Executor、机器、当前 Run 和 pending Event；timeline 展示当前 Run 的完整有界分页事件及全局 cursor。全部是 JSON，可直接保存/查看或由既有 Viewer 展示。CLI 不自动刷新或启动 Codex；本次 Codex 在受信机器实际完成 Issue 工作，Client 负责交付和记录。

App 凭据保留原仓库外配置，通过已有环境变量传给 deliver/sync，不打印值。selected-set inspection 始终 metadata-only，write token 只当前单仓库；Hub/Future UI token 分开发放。C0 handoff:check 保持只读。

## Review → 合并/关闭 → 记录

交付形成 10 个真实 Run Events，等待独立 ChatGPT exact-head Review。完成可用候选后统一做一次独立 Review，不在每个小修复设置 Gate。Hub MVP 与 Future UI 验收 PR 均先 Draft，记录阻断/未发生事项；Builder 不伪造 Review。

sync 在原干净交付 candidate 上调用 App，只读取固定 PR、分页 native Reviews 和固定 Work Item。它核对 App PR actor、repository/base/branch/head，拒绝变化中的 merge 状态；只接受 User 的当前有效 exact-head APPROVED，任何有效 CHANGES_REQUESTED 阻止通过，dismissed/bot/wrong-head 不算通过。原生 GitHub actor 不证明运行过独立 ChatGPT session，独立审查的真实执行仍由 Human/ChatGPT 确认。

观察到有效 APPROVED 时追加 REVIEW_STARTED/REVIEW_PASSED；只有同时观察到该 PR merged、合法 merge SHA、同仓库固定 Issue closed，才追加 RUN_COMPLETED。未审查、未合并或未关闭时保持非终态。每条 Event 带 provider reference 与观察事实，authority_verified=false；不会调用 approve、merge 或 close API。它不能为 Hub 交叉仓库 bootstrap Work Item 冒充关闭验收。

ACK 丢失时保留原 Event ID/sequence/timestamp，先 deliver --retry 再 sync；只重试 CP Events，不重复 GitHub writes。sync 重复调用不生成重复 Review/完成 Event。保留已有 delivery reconciliation 门禁：本版本仍不自动解锁旧失败/已归档交付 journal，后续任务需要明确的新授权与恢复方案。

## 发布候选判据

定向集成检查、一次最终 exact clean-head pnpm check、包独立安装、原 CP/机器/历史保留和真实 #88 Issue→Codex→PR/evidence/Handoff/Run 必须有可回读证据。之后统一独立 Review；Review、合并或关闭尚未发生时不能称端到端 PASS 或最终发布完成。完成后手动 sync 并回读 timeline，核对 REVIEW_PASSED、merge SHA、Issue closed 和 RUN_COMPLETED。证据/失败日志发布到同一个 Hub MVP PR，最终 SHA 留在 ignored Handoff，不能再 commit 到仓库。
