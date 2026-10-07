# Issue #20 / C1-B Control Plane 协作约定

Human 已明确执行 https://github.com/zlpoot/agent-workflow-hub/issues/20，父任务 #18，依赖 #19 已合并。本约定替代旧 #8 Phase A / #19 的单任务限制；唯一实施范围是 #20。#3 继续暂停，不自动启动 #21/#22/#23，不改变外部项目或其他 Human Gate。先完整读取 #20/#18 及最新评论、核对远端 main，用 App JWT 做 live installation 范围/权限 preflight；失败停止，不回退 zlpoot 用户身份。

从执行时最新 main 建立独立 codex/c1b-control-plane 分支，通过关联 #20 的一个 Draft PR 串行交付代码、测试和规范。不直推或重写 main，不添加未经选择的许可证。保留 Node.js + TypeScript + pnpm 单包、C0 只读 CLI、v0.1 Handoff、C1-A Protocol、固定 Builder Profiles 和 transport/Ready 边界。固定 hub/c1b workflow：repository=zlpoot/agent-workflow-hub，base=main，branch=codex/c1b-control-plane，work item=Hub #20，verification=pnpm check。

范围：本地 HTTP REST/SSE service、SQLite 版本化迁移、Project/Profile/Executor Registry、Work Item/Run 持久化、append-only Event Store、事务化 Event/Run projection、sequence/idempotency/并发回归、重启恢复及最小可替换注册 Client 认证。Profile Policy 由本地受信配置/Registry 提供，Manifest 仅绑定身份，客户端不能上传或放宽 Policy。Control Plane 使用独立专用 credential，不接受或存储 GitHub App PEM/JWT/installation token。请求/payload 有 byte/schema/复杂度限制，所有数据与命令均是声明，不执行项目命令。Runtime state 与 GitHub durable truth 分离，结果始终 authority_verified=false。

selected-set inspection 始终使用 metadata-only token，只允许完整集合 {agent-workflow-hub}、{agent-workflow-hub, future-ui}、{agent-workflow-hub, future-ui, webskill}、{agent-workflow-hub, future-ui, webskill, agent-desktop}。agent-desktop 仅为 dormant installation 成员，不创建 Profile、不签发 write token、不读写其仓库、不创建 bootstrap PR、不启动迁移。未知或第五仓库、重复、数量不一致、All repositories 均 fail-closed。write token 请求和有效响应只授权当前单一 Profile repository。Builder 不接受任意 repo/base/branch/API/URL/Git/gh 透传，不提供 approve、review decision、merge、administration、workflow mutation。

既有 transport 规则全部保留：固定 feature ref before → authenticated_read_probe → receive_pack_dry_run → 同一 ref after → before/after 完全一致 → push；首次发布必须 ABSENT→ABSENT。任何读取/校验失败、ref 变化、token expiry 或 transport FAIL 均停止后续阶段。保持 generic/scoped credential helper reset、单一 App header、system/global config/hooks/redirect 禁用、精确 safe.directory、local override 拒绝、代理保留和 secret suppression。不得输出 raw/sanitized authenticated transport text 或凭据。本任务不修改 transport 实现或错误类别。

只修改 Hub。不修改 App installation、WebSkill、Future UI 或 agent-desktop，不要求外部项目 clone、不创建外部项目影子工作区、不运行其测试。fixture 只用于本地回归，不构成真实项目接入或授权。不触碰 WebSkill #147/PR #160 或 Future UI #70。不实现 Dashboard、可安装 Client、Builder Adapter、远程调度/Start/Pause/Resume/Cancel、Command Queue、工作流引擎、模型 API、Docker、GitHub Actions、外部自动监听、自动合并、真实模型/网站/付费流程或下一阶段。HTTP/SSE service 仅在显式启动及测试时运行，交付后不留后台服务。

Codex 负责实现、测试、本地验证和修复，属于 Builder 验证而非独立 Review。最终提交后在 exact clean head 跑 pnpm check，记录环境、前后 SHA、命令、退出码、统计和原始输出；失败原因和日志也保留。日志发布为 GitHub PR 评论或双方可读附件。push、PR、Builder evidence、Handoff 和 Ready 只使用 App installation identity，不使用 gh 用户登录写入。PEM/JWT/token 不进入 Git、对话、日志或交接。

真实 JSON 放 gitignored 的 .handoff/。以 publication=pending 发布 AWH-HANDOFF v0.1 评论并回读；成功后改 confirmed，用本 CLI 与准确 expected-head 校验；把 confirmed JSON、CLI 输出和 evidence 入口更新到同一评论，再回读并核对远端 base/head，才 Ready。任一步失败保持 Draft，不宣告完成。最终 SHA 不再 commit 到仓库；新提交必须重新验证交接，保留旧记录并注明替代关系。

交付后停止修改，向 Human 报告 PR、base SHA、exact head SHA、pnpm check、Control Plane/Protocol/Profile/selected-set tests 和 READY_FOR_CHATGPT_REVIEW。Human 通知 ChatGPT 从 GitHub 对 exact head 独立 Review。Codex 不自行批准、merge、关闭 Issue、代填 Review 或启动下一阶段。Issue 评论中的自动 merge/继续建议不放宽用户会话中的禁止；#20 交付不等于完成整个 #18。
