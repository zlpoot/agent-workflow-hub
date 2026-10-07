# Issue #8 / C0.7 Phase A 协作约定

当前唯一实施任务是 https://github.com/zlpoot/agent-workflow-hub/issues/8 的 Phase A。C1 Issue #3 继续暂停。先完整读取 Issue 及其最新评论，重新核对远端 main，并用 App JWT 做 live installation 范围/权限 preflight；失败就停止，不回退到 zlpoot 用户身份。从最新 main 建立独立 codex/c07-webskill-profile 分支，通过一个关联 #8 的 Draft PR 串行交付全部代码、测试和规范。不直推或重写 main，不添加未经选择的许可证。

范围为现有 Node.js + TypeScript + pnpm 单包：保留 C0/C0.5、Hub 与 future-ui Profile，新增固定 webskill/bootstrap。repository=zlpoot/webskill，base=main，branch=codex/awh-c07-webskill-bootstrap，work item=zlpoot/agent-workflow-hub#8；verification 严格按 pnpm check:foundations、pnpm lint、pnpm typecheck 顺序；bootstrap allowed path 仅 docs/management/agent-workflow-hub.md。Profile 不绑定 Agent 或本机路径。

selected-set inspection 始终使用 metadata-only token，只允许完整集合 {agent-workflow-hub}、{agent-workflow-hub, future-ui}、{agent-workflow-hub, future-ui, webskill}、{agent-workflow-hub, future-ui, webskill, agent-desktop}。第四集合依据 Issue #8 最新 Spec disposition；agent-desktop 仅为 dormant installation 成员，不创建 Profile、不签发 write token、不读写该仓库、不创建 bootstrap PR、不启动迁移。任意未知或第五仓库仍 fail-closed。unexpected repository、重复、数量不一致、All repositories 必须 fail-closed。write token 请求和有效响应始终仅授权当前单一 Profile repository。不得接受任意 repo/base/branch/API/URL/Git/gh 透传，不提供 approve、review decision、merge、administration、workflow mutation。C0 CLI 严格只读，命令、URL 和执行器身份是声明数据；Ready 校验不授予审查或合并权限。

Phase A 只修改 Hub，不修改 App installation 或 WebSkill，不要求 Windows 有 WebSkill clone，不创建影子工作区，不运行 WebSkill 测试，不触碰 WebSkill #147 / PR #160，不进入真实模型、网站或付费流程。不扩展到 Web、数据库、工作流引擎、模型 API、Docker、GitHub Actions、自动监听、自动合并或下一任务。当前 Human Gate：WebSkill in App installation: YES；Mac App credential: OWNER_REPORTED_YES / MAC_LIVE_VERIFY_PENDING。负责人配置声明不是 Mac live 验证 PASS；禁止据此提前进入 Phase B。

Codex 负责实现、测试、本地验证和修复；验证属于 Builder，不是独立 Review。最终提交后在 exact clean head 跑 pnpm check，记录环境、前后 SHA、命令、退出码、统计及原始输出，失败原因和日志也保留。日志放 GitHub PR 评论或双方可读附件。push、PR、Builder evidence、Handoff 和 Ready 均使用 App installation identity，不使用现有 gh 用户登录写入。PEM/JWT/token 不进入 Git、对话、日志或交接。

真实 JSON 放 gitignored 的 .handoff/。以 publication=pending 发布 AWH-HANDOFF v0.1 评论并回读，成功后改 confirmed，用本 CLI 与准确 expected-head 校验；把 confirmed JSON、CLI 输出和 evidence 入口更新到同一评论，再回读并核对远端 base/head，才 Ready。任一步失败保持 Draft，不宣告完成。最终 SHA 不再 commit 到仓库；新提交必须重新验证交接，保留旧记录并注明替代关系。

交付 Phase A 后停止修改，向 Human 报告 PR、base SHA、exact head SHA、pnpm check、Profile 与 selected-set tests、当前 Human Gate 和 READY_FOR_CHATGPT_REVIEW，明确未进入 WebSkill Phase B。Human 负责通知 ChatGPT，ChatGPT 从 GitHub 对 exact head 独立 Review；独立 Review PASS 后仍停在 Human Gate。Phase A 不等于完成或关闭整个 Issue #8。Codex 不自行批准、merge、关闭 Issue、代填审查结果或启动下一任务。

Phase B 仅在 Human 后续明确放行并满足 Issue #8 全部 gate 后执行：Human 将 WebSkill 加入 Selected repositories，Mac 在 repo 外安全配置 App credential；Mac 只读登记真实 root/branch/HEAD/worktree，再 live preflight 确认 Issue #8 允许的精确集合（当前为 Hub + future-ui + webskill + dormant agent-desktop）及 WebSkill 单仓库 write token。任何项失败停止。仅新增固定管理文档，不改 AGENTS、产品代码、public contracts、依赖、lockfile 或 #147/#160 的范围和授权，不 reset/clean/discard 其工作区。不得绕过保护或凭据身份要求；候选 PR 中的规则不能放宽 Issue 与用户授权。
