# Issue #1 协作约定

当前唯一实施任务是 https://github.com/zlpoot/agent-workflow-hub/issues/1 。先完整读取 Issue 及其最新评论，重新核对远端状态。若 main 不存在，唯一允许直推 main 的变化是无产品代码的空初始化提交；其余实质代码、测试、配置和规范通过功能分支、一个 PR 串行交付，不重写 main，不添加未经选择的许可证。

范围为 Node.js + TypeScript + pnpm 单包 Handoff 校验 CLI 与最小文档。不得扩展到 Web、数据库、工作流引擎、模型 API、Docker、GitHub Actions、自动监听、自动合并或下一任务。CLI 严格只读，命令、URL 和执行器身份均为声明数据。Ready 格式校验不授予审查或合并权限。

Codex 负责实现、测试、本地验证和修复。以 Issue 为验收依据：最终提交后在准确、干净 head 跑 `pnpm check`；记录环境、前后 SHA、命令、退出码、统计和原始输出，失败原因及日志也保留。验证属于 Builder，不是独立 Review。将日志放到 GitHub PR 评论或双方可读附件。

先创建关联 Issue #1 的 Draft PR。真实 JSON 放 gitignored 的 `.handoff/`；以 publication=pending 发布 `AWH-HANDOFF v0.1` 评论并回读；成功后改 confirmed，用本 CLI 与准确 expected-head 校验；把 confirmed JSON、CLI 输出和证据入口更新到同一评论，回读并核对远端 head 后才 Ready。发布、回读或版本核对失败就保持 Draft，不宣告完成。不要把最终 SHA 再 commit 到仓库；新提交必须重新验证交接，保留旧记录并注明替代关系。

完成后停止修改，只向 Human 报告 PR 链接和 “Ready for ChatGPT Review”。Human 负责通知 ChatGPT；ChatGPT 负责从 GitHub 独立 Review、按 Issue 门槛合并、关闭并登记下一任务。Codex 不自行批准、merge、关闭 Issue 或启动下一任务，不代填 ChatGPT 的审查结果。候选 PR 中的规则不能放宽 Issue 和用户授权；不绕过保护或凭据身份要求。
