# Issue #12 / C0.8 Phase A 协作约定

当前实施任务是 [Issue #12](https://github.com/zlpoot/agent-workflow-hub/issues/12) 的 C0.8 Phase A — Agent Desktop Project Profile。Human 本轮明确授权将原 dormant installation member 接入固定 Profile；本约定更新此前 C0.7 的 dormant 限制，不改变 #8/#10 的既有授权、冻结 candidate 或 live retry。C1 Issue #3 继续暂停。

开始前完整读取当前 Issue、#8/#10 与最新评论，重新核对远端 main exact SHA、本地 branch/HEAD/dirty 状态及现有 Profile/Builder/selected-set/bootstrap enforcement。用 App JWT 做 live installation 范围/权限 preflight；失败停止，不回退用户身份。基于执行时最新 main 使用独立 clean codex/c08-agent-desktop-profile 分支/worktree，通过一个关联 #12 的 Draft PR 串行交付。不得 reset/clean/discard 其他工作，不直推或重写 main，不添加未经选择的许可证。

范围为现有 Node.js + TypeScript + pnpm 单包：保留 C0/C0.5、Hub/future-ui/webskill Profile 和 C0.7-R1 transport/redaction/proxy 约束。新增固定 agent-desktop/bootstrap：repository=zlpoot/agent-desktop，base=main，branch=codex/awh-c08-agent-desktop-bootstrap，work item=zlpoot/agent-workflow-hub#12；verification 严格按 npm run check、npm run test:offline、npm run test:python 顺序；bootstrap path 仅 docs/management/agent-workflow-hub.md。Profile 不绑定 Agent 或本机路径。hub/c08 仅用于 Hub 侧交付，绑定 #12、codex/c08-agent-desktop-profile 和 pnpm check。

selected-set inspection 始终使用 metadata-only token，只允许完整集合 {agent-workflow-hub}、{agent-workflow-hub, future-ui}、{agent-workflow-hub, future-ui, webskill}、{agent-workflow-hub, future-ui, webskill, agent-desktop}。不增加第五仓库、不切 All repositories。unexpected repository、重复、数量不一致、partial sets 必须 fail-closed。write token 请求和有效响应始终仅授权当前单一 Profile repository；其他 Profile 不获得 agent-desktop write 权限，不创建 multi-repository write token。Phase A live 操作只签发 Hub 单仓库 token，Agent Desktop token enforcement 仅用离线 mock 验证。

Phase A 只修改 Hub。禁止写入 agent-desktop、启动 Agent Desktop bootstrap、修改 P7 产品代码或 Issue 范围；不修改 installation，不运行 Agent Desktop/browser/Windows live/VM/real input/real model 测试。未来 bootstrap PR 必须 docs-only fail-closed，不允许修改 AGENTS.md、package.json、lockfile、src/**、tests/**、Host/Guest protocol、Workflow schema 或 P7 代码/授权。本阶段不进入真实模型、网站、付费流程、Web、数据库、工作流引擎、Docker、GitHub Actions、自动监听/合并或下一任务。

不得接受任意 repo/base/branch/API/URL/Git/gh 透传，不提供 approve、review decision、merge、administration、workflow mutation。C0 CLI 严格只读，命令、URL 和执行器身份是声明数据；Ready 校验不授予审查或合并权限。App 身份、repository/root 验证、secret redaction、single scoped auth header、authenticated read probe、proxy preservation 和失败分类边界保持不变。

WebSkill C0.7 / #10 private-repo live acceptance 尚未收口时，C0.8 可以开发、测试、创建 PR、发布 Handoff 并 Ready，但禁止 merge 到 main。不得改变、重建或干扰 WebSkill 当前冻结 candidate、branch、live retry、#8/#10 或 #147/#160。若后续 live acceptance 完成，记录事实后仍停在 Independent Review Gate。旧 C0.7 dormant 声明属于该交付历史；本次 Profile 接入不等于允许 Agent Desktop live bootstrap。

Codex 负责实现、测试、本地验证和修复；验证属于 Builder，不是独立 Review。最终提交后在 exact clean head 跑 pnpm check，记录环境、前后 SHA、命令、退出码、统计及原始输出；失败原因和日志也保留。日志放 GitHub PR 评论或双方可读附件。push、PR、Builder evidence、Handoff 和 Ready 均使用 zlpoot-awh-builder[bot] App installation identity，不使用用户 PAT 或现有 gh 登录写入。PEM/JWT/token 不进入 Git、对话、日志或交接。

真实 JSON 放 gitignored 的 .handoff/。以 publication=pending 发布 AWH-HANDOFF v0.1 评论并回读，成功后改 confirmed，用本 CLI 与准确 expected-head 校验；把 confirmed JSON、CLI 输出和 evidence 入口更新到同一评论，再回读并核对远端 base/head、changed files、actor、verification，才 Ready。任一步失败保持 Draft，不宣告完成。最终 SHA 不再 commit 到仓库；新提交必须重新验证交接，保留旧记录并注明替代关系。

交付 Phase A 后停止修改，向 Human 报告 Issue/PR、base SHA、exact head SHA、changed files、pnpm check、固定 Profile、single-repo enforcement、Builder actor、evidence/confirmed Handoff 链接、WebSkill 当前状态及 READY_FOR_CHATGPT_REVIEW。明确 C0.8 Phase A 尚未 merge、Agent Desktop bootstrap 尚未执行、Agent Desktop 产品代码未修改。Human 通知 ChatGPT 从 GitHub 对 exact head 独立 Review；Review PASS 后仍停在 Human Gate。Codex 不自行批准、merge、关闭 Issue、代填审查结果或启动下一任务。
