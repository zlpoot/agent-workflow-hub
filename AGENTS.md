# Issue #19 / C1-A Protocol 协作约定

Human 已明确启动 https://github.com/zlpoot/agent-workflow-hub/issues/19，父任务为 #18。本约定替代先前 #8 Phase A / #13 repair 的单任务限制。当前唯一实施范围为 C1-A Protocol；#3 Review Inbox 继续暂停，#20/#21/#22/#23 不自动启动。先完整读取 #19/#18 及最新评论，核对远端 main，用 App JWT 做 live installation 范围/权限 preflight；失败停止，不回退到 zlpoot 用户身份。

从最新 main 建立独立 `codex/c1a-protocol` 分支，通过关联 #19 的一个 Draft PR 串行交付代码、测试和规范。不直推或重写 main，不添加未经选择的许可证。保留现有 Node.js + TypeScript + pnpm 单包、C0 CLI、v0.1 Handoff、固定 Builder Profiles 和 transport/Ready 边界。新增固定 `hub/c1a` workflow：repository=`zlpoot/agent-workflow-hub`，base=`main`，branch=`codex/c1a-protocol`，work item=Hub #19，verification=`pnpm check`。

范围仅为版本化 Project Manifest / Project / Profile Policy / Executor / Work Item / Run / Event schema 与 TypeScript types、schema validation 与负例测试、Run 基础状态转换、Event append-only / sequence / idempotency 规则、WebSkill / Future UI 最小 fixture 及现有 Handoff 的兼容映射。Protocol 不依赖 Dashboard 或具体项目。Manifest 只绑定身份，Policy 由受信 Registry 提供，schema-valid 和 Ready 均不授予执行、审查或合并权限。Runtime state 与 GitHub durable truth 分离；协议中的命令、provider 引用和扩展字段始终只是声明数据。

selected-set inspection 始终使用 metadata-only token，只允许完整集合 {agent-workflow-hub}、{agent-workflow-hub, future-ui}、{agent-workflow-hub, future-ui, webskill}、{agent-workflow-hub, future-ui, webskill, agent-desktop}。agent-desktop 仅为 dormant installation 成员，不创建 Profile、不签发 write token、不读写其仓库、不创建 bootstrap PR、不启动迁移。未知或第五仓库、重复、数量不一致、All repositories 均 fail-closed。write token 请求和有效响应始终仅授权当前单一 Profile repository。不得接受任意 repo/base/branch/API/URL/Git/gh 透传，不提供 approve、review decision、merge、administration、workflow mutation。

既有 transport 规则全部保留：固定 feature ref before → authenticated_read_probe → receive_pack_dry_run → 同一 ref after → before/after 完全一致 → push；首次 bootstrap 必须 ABSENT→ABSENT。任何读取/校验失败、ref 变化、token expiry 或 transport FAIL 均停止后续阶段。保持 generic/scoped credential helper reset、单一 App header、system/global config/hooks/redirect 禁用、精确 safe.directory、local override 拒绝、代理保留和 secret suppression。不得输出 raw/sanitized transport text 或凭据。本任务不修改 transport 实现或错误类别。

本阶段只修改 Hub。不修改 App installation、WebSkill、Future UI 或 agent-desktop，不要求其本机 clone，不创建外部项目影子工作区，不运行其测试。不触碰 WebSkill #147 / PR #160 或 Future UI #70 授权；fixture 不构成真实项目接入或权限。不得扩展到 Web/UI、数据库、HTTP/SSE service、工作流引擎、模型 API、Docker、GitHub Actions、远程调度、自动监听/合并、真实模型/网站/付费流程或下一任务。#19 不放行 #8 Phase B，也不改变 C0.8 状态。

Codex 负责实现、测试、本地验证和修复；验证属于 Builder，不是独立 Review。最终提交后在 exact clean head 跑 `pnpm check`，记录环境、前后 SHA、命令、退出码、统计及原始输出；失败原因和日志也保留。日志发布为 GitHub PR 评论或双方可读附件。push、PR、Builder evidence、Handoff 和 Ready 使用 App installation identity，不使用 gh 用户登录写入。PEM/JWT/token 不进入 Git、对话、日志或交接。

真实 JSON 放 gitignored 的 `.handoff/`。以 `publication=pending` 发布 `AWH-HANDOFF v0.1` 评论并回读；成功后改 confirmed，以本 CLI 和准确 expected-head 校验；将 confirmed JSON、CLI 输出和 evidence 入口更新到同一评论，再回读并核对远端 base/head，才 Ready。任一步失败保持 Draft，不宣告完成。最终 SHA 不再 commit 到仓库；新提交必须重新验证交接，保留旧记录并注明替代关系。

交付后停止修改，向 Human 报告 PR、base SHA、exact head SHA、`pnpm check`、Protocol/Profile/selected-set tests 和 `READY_FOR_CHATGPT_REVIEW`。Human 通知 ChatGPT 从 GitHub 对 exact head 独立 Review。Codex 不自行批准、merge、关闭 Issue、代填 Review、进入 #20 或改变任何其他 Human Gate；C1-A 交付不等于完成整个 #18 产品化任务。
