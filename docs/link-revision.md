# v0.2.1：已交付 Draft PR 的文档修订关联

本候选实现 Hub #43，基于 PR #42 的已审恢复候选。Client 为 0.4.2。
代码交付仅等待 ChatGPT exact-head Independent Review；代码通过不代表生产部署授权。
原生产 CP、Client、DB、Profile、Future UI PR #92 和真实 Run 均不在本次操作范围。

## 受控入口

```text
awh --config <原外部配置> link-revision --run <原真实 Run ID> --pr <原 PR 编号> --head <新 40 位 SHA> --evidence-comment <既存 App 证据评论 ID>
awh --config <原外部配置> link-revision --retry
```

第一版只接纳 Windows `future-ui/c1c-acceptance` / `v02-repeatable-v1` 的原
`awaiting_review` Run、同一 App-owned open Draft PR、原 Issue/分支/base 和身份。
新 HEAD 必须已经存在于该远端 PR，本命令不 push、不创建 Run/PR，不进行 Review、
Ready、merge、close 或 sync。`event --type` 不能注入内部修订 Event。

工作树必须 clean，branch/HEAD 与明确指定值相同；新 HEAD 必须是上一有效 HEAD
及原 delivery HEAD 的后代，且严格前进。两段差异均检查 name-status、文件模式和实际
文本 diff，仅允许新增/修改以下普通文档，拒绝 rename/copy/delete、二进制、符号链接、
可执行位及任何其他路径：

- `docs/management/awh-repeatable-workflow.md`
- `docs/management/awh-v01-acceptance.md`

沿用固定 Profile 的 allowlist，命令没有 repo、URL、shell、凭据或路径透传参数。
原 Profile、Project、Executor、machine、endpoint/namespace 和 Task fingerprint 均须匹配。
先比对原 Session/Journal、完整 CP Timeline 和 Registry，再检查 GitHub。
App 始终先用 metadata-only token 检查允许的完整 Selected set，再签发单仓库 token。
观察阶段只读；发布阶段只授予 contents/read、pull_requests/read、issues/write，以发布
新的 Handoff 并确认该新评论。旧评论不编辑，发布模式不允许其他 Provider mutation。

## 既存 exact-head 证据

不会机械重复执行验证命令。当前 MVP 接纳 PR #92 使用的固定评论格式：
`Builder evidence — documentation review correction`、JSON code fence、`Raw stdout:`
和 `Raw stderr:` 两行 JSON 字符串。其他格式失败关闭。
评论须由受信 App 发布，并包含相同 actor 和 verification：固定命令
`git diff --check origin/main...HEAD`、一次执行、exit 0、原 base、前后均为新 SHA、
前后 clean、开始/结束时间、platform/arch/node/git 环境和原始 stdout/stderr。
原始输出必须与评论尾部原始值一致。保存完整评论及 SHA-256；发布前后再次回读。
这仍是 Builder 证据，不是独立 Review。

既存 `docs-review-*` Handoff 不是 CP Run，不可拿来关联。本命令创建新
AWH-HANDOFF v0.1，使用真实原 Run ID 和新 subject/head；另附固定
`AWH-REVISION v0.2.1` JSON，包含 revision ID、原/上一/新 HEAD、旧 Handoff
和 evidence 地址/摘要。旧 Handoff 保留。新评论 pending→回读→confirmed→回读，
原 v0.1 schema 和 `validateHandoff` 不放宽。

## 追加历史与生命周期

确定性 revision ID 绑定原 Run、原 Task fingerprint、上一 HEAD、新 HEAD 和同一 PR。
原 namespace 的六个 receipt 阶段以 exclusive create + fsync 写入，每个阶段关联
上阶段原始字节摘要：资格、发布 pending 前、pending 评论返回、确认前、固定 Event、ACK。
发布结果未知、中断、文件冲突或 Handoff 不确定都保留 receipt 并阻止下一次尝试。
不删除 receipt、不换 state_directory、不另建 Run。

确认完成后才追加一条强类型 `PR_REVISION_LINKED`，固定 Event ID/内容摘要和 sequence。
事件携带原/上一/新 HEAD、PR/ref/base、前后 Handoff 与证据引用/摘要、固定成功检查。
CP 在原 v2 events 表按原 owner、sequence、idempotency 和 Replay 规则追加，不新增表。
原 Run.source.sha 不变，状态仍 `awaiting_review`。

Replay 从原 `GITHUB_PR_CREATED` 加连续修订 Event 推导 `effective_candidate_head`。
原 Session/交付 Journal 字节不修改；后续 Event、pending 和 completed 状态写入独立的
追加 revision-state sidecar，关联原文件摘要和前一 sidecar 摘要。
原 Session 内出现修订 Event 一律拒绝，即使 CP 有相同声明也不能绕过缺失的 receipt/sidecar。
`status` 和 `timeline` 回读 CP 并展示有效候选/修订链；`sync` 的原生 Review
subject 必须匹配有效 HEAD。原 HEAD 的 APPROVE、dismissed 或有效 CHANGES_REQUESTED
不能批准新候选。有效新 HEAD 原生批准、真实 merge 和同一 Issue closed 才完成 Run。
完成状态保存在追加层；下一 Issue 的交付归档原 Session 字节及追加层，保留原 Journal。

`link-revision --retry` 仅允许已确认 Handoff 且已固定 Event 的 ACK 补发，使用完全相同
Event ID/内容，不重新验证、不连接 App、不发布评论、不执行其他 GitHub 写入。
Sync 的 Event ACK 使用原 `deliver --retry` 机制；它不能补发未确认的 revision Event。

## 兼容与部署门禁

没有修订的旧 Run/Event/固定 Profile 行为保持；数据库仍是 v2，历史无需迁移。
新增 Event 需要新 CP runtime 的 schema/replay 支持。认证只读
`GET /v1/capabilities` 返回 `revision_linking=v021-docs-v1` 和 database_version=2；
旧 CP 无此能力时，Client 在任何 Handoff 写入前停止。
旧 Client 可继续处理未修订 Run，但不能解码新增 Event，也不能处理 revision sidecar；
不能把旧 Client 用于已关联修订的 namespace。
真实 CP 升级、Client 安装注册、#92 唯一一次关联及之后 sync 分别需要 Human 授权。

离线 fixture 来自保留的 8/42 恢复备份加原真实交付 1/10 Timeline，合计 9/52；
模拟追加得到 9/53，保留全部旧 Event、Run initial 和其他 Registry 行。
真实 PR #92 评论作为离线证据解析输入；测试不访问 GitHub，不读写生产 DB。
