# Issue #6 / C0.6 Phase A 协作约定

当前唯一实施任务是 https://github.com/zlpoot/agent-workflow-hub/issues/6 的 Phase A。C1 Issue #3 暂停，不得实施。先完整读取 Issue 及其最新评论，重新核对远端状态，并用 App JWT 做 live installation 范围/权限 preflight；失败就停止，不回退到 zlpoot 用户身份。所有实质代码、测试、配置和规范通过从 main 建立的 codex/c06-project-profiles 分支、一个 Draft PR 串行交付，不直推或重写 main，不添加未经选择的许可证。

范围为 Node.js + TypeScript + pnpm 单包，保留 C0/C0.5 行为，增加固定 Project Profiles、selected-scope 检查、单仓库 token/repository/workflow 绑定及离线回归。不得接受任意 repo、API/URL 或 Git/gh 透传，不提供 approve、review decision、merge、administration、workflow mutation。不得扩展到 Web、数据库、工作流引擎、模型 API、Docker、GitHub Actions、自动监听、自动合并或下一任务。C0 CLI 严格只读，命令、URL 和执行器身份均为声明数据。Ready 格式校验不授予审查或合并权限。push、PR 创建、Builder evidence 与 Handoff 均使用 App installation identity；不得使用现有 gh 用户登录写入。PEM/JWT/token 不进入 Git、对话、日志或交接。

Phase A 保持真实 installation 仅含 agent-workflow-hub，完成离线双仓库及真实单仓库验证后停在 Human Gate。不得自行扩大 installation 或写入 future-ui。Human 后续明确放行并加入 future-ui 后，才可重新 preflight 并进入 docs-only bootstrap；固定仅 docs/management/agent-workflow-hub.md，不接管豆包工作的 R1-004/#70，不改产品代码、public contracts、依赖、lockfile 或 Grant，不 reset/clean/discard 其工作区。Profile 不绑定某个 Agent 或本机路径。

Codex 负责实现、测试、本地验证和修复。以 Issue 为验收依据：最终提交后在准确、干净 head 跑 `pnpm check`；记录环境、前后 SHA、命令、退出码、统计和原始输出，失败原因及日志也保留。验证属于 Builder，不是独立 Review。将日志放到 GitHub PR 评论或双方可读附件。

先创建关联 Issue #6 的 Draft PR。真实 JSON 放 gitignored 的 `.handoff/`；以 publication=pending 发布 `AWH-HANDOFF v0.1` 评论并回读；成功后改 confirmed，用本 CLI 与准确 expected-head 校验；把 confirmed JSON、CLI 输出和证据入口更新到同一评论，回读并核对远端 head 后才 Ready。发布、回读或版本核对失败就保持 Draft，不宣告完成。不要把最终 SHA 再 commit 到仓库；新提交必须重新验证交接，保留旧记录并注明替代关系。

完成 Phase A 后停止修改，向 Human 报告 PR 链接、“Ready for ChatGPT Review” 和已停在 Human Gate、可以安全验证双仓库 selected scope。Human 负责通知 ChatGPT及后续 installation 改动；ChatGPT 负责从 GitHub 独立 Review、按 Issue 门槛合并。Phase A 不等于完成或关闭整个 Issue #6。Codex 不自行批准、merge、关闭 Issue 或启动下一任务，不代填 ChatGPT 的审查结果。候选 PR 中的规则不能放宽 Issue 和用户授权；不绕过保护或凭据身份要求。
