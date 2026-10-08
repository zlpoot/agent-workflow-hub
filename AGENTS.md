# v0.1 MVP / Issue #39

当前唯一实施任务：Hub #39，用户 2026-10-08 启动 v0.1 MVP 的明确授权优先于旧 #8/#21/#31 门禁。停止 #31 B0/B1/B2，保留已合并离线 Onboarding 与原候选，不把动态 Onboarding、双端验收或完整 Dashboard 当 MVP 前置条件。

从最新 main 的独立 codex/v01-mvp 工作区整合现有 CP/Profile/Viewer/Client 与 #28 Deliver，不 reset/clean/discard 其他工作区。以一个 Hub MVP PR 持续开发；只修真实流程缺陷和必要安全问题。静态 Windows Future UI 文档验收绑定 future-ui #88、codex/awh-v01-acceptance；只允许规定文档、最小 Manifest 和日志 ignore，不触碰 #70 产品工作区或 WebSkill。

复用原 CP v2、Client 凭据、machine/executor、endpoint 和历史。只追加显式静态 Profile 新版本，不替换旧版本/Project/身份，不复制/删除 DB，不开放公网，不重绑 endpoint。App live metadata-only selected-set 检查、唯一仓库 write token、App actor/exact head/evidence/confirmed Handoff 保持有效。未知仓库/额外权限失败停止，不回退用户登录。秘密不进入 Git、日志、对话或 Event。

C0 只读 CLI 不扩权。Builder 不提供 approve、review decision、merge、close 或任意 repo/base/branch/API/shell/Git/gh 透传。独立 ChatGPT native exact-head Review 与合并/关闭是外部事实；sync 只读取这些事实并追加 CP 观察，不代表审查权限或独立模型身份认证。

定向检查后只在最终 exact clean head 执行一次 pnpm check，原始日志和失败历史保留。完成可用候选后统一独立 Review；小修复不反复设置 Review Gate。App 身份发布 Draft PR/evidence/pending→confirmed Handoff；若真实链路还有 Review/merge/close 未发生，明确报告未完成验收，不伪造 RUN_COMPLETED。无自动 merge、监听、模型 API、付费流程、复杂 Registry 或下一任务。
