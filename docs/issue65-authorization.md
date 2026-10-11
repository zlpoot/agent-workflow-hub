# #65：原修复的最小一次性授权

截至本候选准备时，已核实 main 为 `7c4a8ed0d83af15f4ca44e25102fadc62dfc4c87`。本地 `codex/issue65-windows-isolated` 保留原提交 **`6706316b44f7ed5ddd9a38b00ab65d871d74a909`**，只改 `src/client/client.ts`、`tests/client.test.mjs`。其原 exact-head 72/72 测试、干净安装与 Human Windows 验收保持有效。新 CLI 分支以该原提交为祖先，没有重做或改写修复。

## 管理员批准的范围

批准独立的新外置策略及发布请求，不能编辑或挪用 #63 的旧授权文件：

| 字段 | 唯一允许值 |
| --- | --- |
| repository / Work Item | `zlpoot/agent-workflow-hub` / Issue `65` |
| branch | `codex/issue65-windows-isolated` |
| base | `main@7c4a8ed0d83af15f4ca44e25102fadc62dfc4c87` |
| head | `6706316b44f7ed5ddd9a38b00ab65d871d74a909` |
| 路径 | `src/client/client.ts`、`tests/client.test.mjs` |
| executor / machine | 当前已核实的 `codex` / `DESKTOP-5IP6BCN`（变化则新批准） |
| App / installation | `5219770` / `168746815`，`zlpoot-awh-builder[bot]` |
| selected set | 当前获准的 Hub、agent-desktop、future-ui、webskill 完整四仓集合；安装变化则先 BLOCKED |
| 操作 | 只读 preflight；Push 原准确 HEAD；一个 Draft PR；exact-head Evidence；confirmed Handoff；读回 |
| 禁止 | Review/Approve、Merge、Issue close、Tag、Release、生产部署、扩大 App 集合或借用个人 Token |

批准须绑定允许的验证命令、完整 policy/request/launcher/runtime/payload digest 与到期时间。验证日志必须对应同一 `6706316b…`；#66 的测试不能代替 #65 准确 HEAD 原件。

## 最短执行顺序

1. 只读核验上述 SHA、分支、干净状态与两个 diff 文件；再次经已批准 App metadata-only 完整 selected-set 和单仓库只读 token 核对 main。main 或候选变化即停止，重新办理批准。
2. 管理员独立检查 Agent 准备的新外置 **proposed** policy/request；核对 SHA-256 后明确批准该准确范围，并把独立 pin、固定身份和受保护 launcher 放在新目录。不能把候选 `confirmed:true` 字段、普通 Issue 评论或自己计算的新 hash 当批准。
3. CLI 尚未独立 Review/安装时，bootstrap 发布使用既有已审查 Builder 及受保护的精确 HEAD launcher。不得先让这次新 CLI 批准它自己。旧 #63 launcher 固定 #63/PR64，不能直接套用；新 launcher 只能在上述独立管理员批准后受限配置。
4. 在 #65 原工作树中通过受保护 launcher 调用原 Builder 的 `preflight → push → pr-create → comment-create/edit/read → pr-read`。preflight 必须得到正确 bot、installation、完整 selected set 和单仓库最小写权限；不使用个人 gh 登录。原修复无需 cherry-pick、rebase、重做或换分支。
5. 只有实际 PR/head/actor 读回一致后才生成并发布 Evidence；先发布 pending Handoff，成功读回后改为 confirmed，再读回同一 PR 与原准确 HEAD。保留 Draft，运行现有 `handoff:check … --expected-head 6706316b44f7ed5ddd9a38b00ab65d871d74a909` 作声明格式检查；这不作独立 Review。
6. 交给 ChatGPT 独立 Review，停在这个准确 HEAD。不 Merge 或部署。没有批准时保留原提交、提议和失败原件，报告 `BLOCKED_ADMIN_AUTHORIZATION`。

## CLI 经独立 Review 后的标准替代

按 [管理员 CLI](administrator-cli.md) 的受保护 trust root 与模板流程，用 `prepare` / `register` 生成上述固定任务提议；`approval-prepare` 后由管理员独立核验并提供 receipt pin；`approve --confirm` 写入新版本；`inspect` / `preflight` / `launcher` 只读核验。随后继续调用同一现有 Builder/Client 交付链。不要将新 policy/receipt 摘要自动绑定为管理员批准，也不要把本地 preflight 的 `NOTRUN` 改写为 GitHub 交付已通过。

本文件提供可办理的准确 scope 和顺序，不宣称外置批准、Push、PR、Evidence、confirmed Handoff 或 Review 已发生。
