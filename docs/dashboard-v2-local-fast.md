# Dashboard V2 Local Fast 操作台

普通 Windows Local Fast 路径在 V2 内完成项目管理、队列绑定、Watcher 控制、任务观察和 Review 交接。使用既有仓库与 Issue，复用现有 `LocalFast`、Watcher、REST/SSE 和 GitHub 观察缓存。CP Enrollment 继续通过兼容 V1 使用。

## 操作流程

1. 打开默认 `/dashboard`（已有 `/dashboard/v2` 也可用），点击「项目」或「添加项目」。在已批准根目录中浏览并选择已有 Git 根目录，点击「检查 Local Fast 项目」。页面显示 origin 仓库、分支、完整 HEAD 和工作区是否有本机改动。
2. 已有 binding：确认「关联已有队列」，保留交付身份、原队列与全部历史。未绑定：填写有限有序 Issue 编号（如 `12,15,18`）、每行一条定向检查命令，选择已连接 `github-app` 或已登录 `personal-gh`，预览后确认。服务端核对真实身份、仓库写权限、OPEN Issue 与冲突；绑定不启动开发。
3. 项目关联保存到已配置的外置状态目录，Viewer 启动自动恢复。新增项目不需要手写 `project_ids`、`local_fast_observations` 或 Watcher 路径。目录丢失或 binding/登录异常会保留关联并明确报错。
4. 「查询 Watcher」显示实际 Owner 仓库/队列、到期时间、自动 Merge 上限、本机锁和 GUI 状态。查询超过 15 秒后摘要标为历史，启动前需重新查询；每 30 秒自动查询，确认框打开时暂停。每次启动仍由现有 Watcher 重新验证授权。
5. 缺少有效 scope 时，在「Windows Owner 确认引导」填写未来 30 天内的 UTC 到期时间与 Codex.exe 绝对路径，明确选择是否允许自动 Merge。复制生成的精确 PowerShell 命令，由 Owner 在真实交互式 Windows 终端运行，回到 V2 查询状态后启动。
6. V2 只启动现有 Watcher；重复点击不会新增执行器。「停止本 GUI Watcher」和 Viewer 退出只停止该 GUI 拥有的运行。其他启动来源、失效锁、完成队列与旧授权均保留，按既有 CLI 恢复规则处理。
7. 项目详情按绑定顺序展示任务；也可进入「任务」。详情显示执行者/机器、Issue/PR、HEAD、Stage 检查、实际 GitHub Review/Merge、来源时效、Watcher 历史、阻塞原因和下一责任方。SSE 断开或过期快照显示未知，历史 Review 不代表当前 Gate。
8. 打开任务详情中的 PR，将「ChatGPT Review 指令」复制到独立 ChatGPT 会话。Reviewer 重新核对真实 PR 作者和准确 HEAD：App Bot PR 使用受信个人的原生 APPROVED/CHANGES_REQUESTED；同账号 personal-gh 按已有结构化 COMMENTED 协议。V2 不发布 Review。已有有效 Owner scope 允许 Merge 时，Watcher 在真实 Gate PASS 后按现有逻辑合并、回读 CLOSED、推进下一 Issue，直到 `QUEUE_COMPLETED`。

## Owner 确认的明确缺口

`GUI_OWNER_CONFIRMATION_NOT_INTEGRATED`：仍需一次真实 Windows Owner 终端交互。现有原生 CP Enrollment 确认器只批准专用登记/心跳请求，绑定受保护的安装条目与 Owner SID，无法直接授予 Watcher scope。本轮不扩建权限平台，也不以浏览器 `confirm:true` 冒充 Owner。取消、scope 到期、绑定不一致、旧 scope 已存在或锁占用不自动覆盖；查看返回的错误码与恢复建议。

## 验证边界

提供 V2 资源的正式 Viewer 默认进入 V2；V1 兼容入口为 `/dashboard/v1`（含末尾 `/`），保留旧 `/dashboard/app.js`、`app.css` 与全部 `/dashboard/v1/*` REST/SSE。没有 V2 资源的旧 sidecar 仍保持 V1 默认入口。两套 UI 使用同一个 `/dashboard` HttpOnly Cookie 和原 CSP。

`tests/dashboard-v2-projects-browser.test.mjs` 使用 Windows Edge、真实隔离 Git、模拟 Provider/执行器/Owner scope 与空 CP 数据库，覆盖绑定预览/取消、非法编号、重复启动、停止、授权命令复制、Review 复制、断线恢复及 Viewer 关联重建。模拟环境不代表真实新业务队列验收。

`scripts/dashboard-local-fast-smoke.mjs <已完成 Sandbox 根目录>` 在独立安装的 Viewer 和空数据库中通过 V2 关联既有 completed Sandbox，检查两项任务的真实 PR/Review/Merge/Stage/Watcher 和重启恢复，核对历史文件与数据库摘要未变。该脚本只接受既有 `zlpoot/awh-m1-e-sandbox` completed `[1,2]`，不 bind/start/authorize/Stage。

真实新业务队列、Windows Owner 新授权、独立 Review/自动 Merge 实际重跑、Strict Builder、生产切换、Mac、Release/deployment 均不属于本轮验证。
