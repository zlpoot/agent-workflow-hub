# Dashboard V2 Local Fast 操作台

普通 Windows Local Fast 路径在 V2 内完成项目管理、队列绑定、Watcher 控制、任务观察和 Review 交接。使用既有仓库与 Issue，复用现有 `LocalFast`、Watcher、REST/SSE 和 GitHub 观察缓存。CP Enrollment 继续通过兼容 V1 使用。

## 操作流程

1. 打开默认 `/dashboard`（已有 `/dashboard/v2` 也可用），点击「项目」或「添加项目」。在已批准根目录中浏览并选择已有 Git 根目录，点击「检查 Local Fast 项目」。页面显示 origin 仓库、分支、完整 HEAD 和工作区是否有本机改动。
2. 已有 binding：确认「关联已有队列」，保留交付身份、原队列与全部历史。未绑定：填写有限有序 Issue 编号（如 `12,15,18`）、每行一条定向检查命令，选择已连接 `github-app` 或已登录 `personal-gh`，预览后确认。服务端核对真实身份、仓库写权限、OPEN Issue 与冲突；绑定不启动开发。
   项目详情的「GitHub Issues 与候选队列」会查询本仓库已有 OPEN Issue（排除 PR，每页最多 50 条，最多 20 页）。按编号/标题筛选本页，点击「加入」，再通过上移、下移、移除调整顺序；也可直接输入编号。点击「保存候选队列」保存选择，Viewer 重启后恢复。这是候选顺序，不会启动任务。
   当前执行队列未开始或全部完成时，已关联项目可以「预览保存执行队列」并确认新顺序。服务端再次检查 Git HEAD、绑定版本、真实 OPEN Issue、已执行 Issue 冲突以及仓库锁。进行中的队列保留原顺序，仍可保存候选；任务完成后再确认下一轮。新轮次沿用已有交付身份和定向检查，原绑定原文保存在 common Git 的 `awh-local-fast/queues/<轮次>/state.json`，旧工作区和检查记录保留，最多保留 32 轮引用。归档的未执行候选不制造任务记录。
   每轮通过已有 Watcher 保存自己的有限 Windows Owner scope；新的 scope/Watcher 状态位于 Git 外原仓库目录下的 `queues/<轮次>`，旧授权文件原样保留。所有轮次共用原仓库 `watcher.lock`，切换队列也占用这个锁。旧授权不能启动新轮次；CLI 原有 TTY、仓库、顺序、有效期、Codex.exe 和 allow-merge 语义不变。GUI 生成的终端命令调用当前候选 Viewer 附带的准确 Client CLI，避免系统旧 CLI 不识别新轮次。观察 API 可选 `queue_id` / `queue_archived` 只表示本机记录来源，历史 Owner/Watcher 不代表当前授权，也不产生 CP Run/Event。
3. 项目关联保存到已配置的外置状态目录，Viewer 启动自动恢复。新增项目不需要手写 `project_ids`、`local_fast_observations` 或 Watcher 路径。目录丢失或 binding/登录异常会保留关联并明确报错。
4. 「查询 Watcher」显示实际 Owner 仓库/队列、到期时间、自动 Merge 上限、本机锁和 GUI 状态。查询超过 15 秒后摘要标为历史，启动前需重新查询；每 30 秒自动查询，确认框打开时暂停。每次启动仍由现有 Watcher 重新验证授权。
5. 「Windows Owner 确认引导」自动从本机 Codex Desktop 安装目录与有限 PATH 项检测外置、非重定向的 Codex.exe 并预填；没有找到时保留手动选择。填写未来 30 天内的 UTC 到期时间，明确选择是否允许自动 Merge。已配置 Windows Owner 确认的 Viewer 可点击「打开 Windows Owner 授权窗口」，在本机原生窗口核对仓库、Issue 顺序、本轮队列、定向检查、交付身份、有效期、可执行文件和自动 Merge。确认后页面自动刷新实际 scope，再点击启动；无需复制终端命令。终端方式保留为兼容备用。
6. V2 只启动现有 Watcher；重复点击不会新增执行器。「停止本 GUI Watcher」和 Viewer 退出只停止该 GUI 拥有的运行。其他启动来源、失效锁、完成队列与旧授权均保留，按既有 CLI 恢复规则处理。
   若 Coding 已结束但父进程 Stage 失败，且保存的 scope 仍有效、仓库没有锁或可能仍活跃的执行器，可确认「恢复现有候选的 Stage」。它只对当前已保留的任务工作区进行 Commit、定向验证和同一 PR 的交付，复用既有 Stage 和仓库锁，不清除原 attempt，也不再次启动 Coding；保留恢复次数和原错误。成功后同一 GUI Watcher 继续等待独立 Review。缺少已执行 attempt、阶段不符、授权过期/变更、锁或存活执行器均拒绝。它不授予新 scope 或 Merge 权限；已有 CLI retry 仍保留自己的真实交互要求。
7. 项目详情按绑定顺序展示任务；也可进入「任务」。详情显示执行者/机器、Issue/PR、HEAD、Stage 检查、实际 GitHub Review/Merge、来源时效、Watcher 历史、阻塞原因和下一责任方。SSE 断开或过期快照显示未知，历史 Review 不代表当前 Gate。
8. 打开任务详情中的 PR，将「ChatGPT Review 指令」复制到独立 ChatGPT 会话。Reviewer 重新核对真实 PR 作者和准确 HEAD：App Bot PR 使用受信个人的原生 APPROVED/CHANGES_REQUESTED；同账号 personal-gh 按已有结构化 COMMENTED 协议。V2 不发布 Review。已有有效 Owner scope 允许 Merge 时，Watcher 在真实 Gate PASS 后按现有逻辑合并、回读 CLOSED、推进下一 Issue，直到 `QUEUE_COMPLETED`。

## Windows Owner 确认边界

GitHub App 仓库范围在 GitHub 安装页面更新后，返回 V2 设置（窗口获得焦点、重新进入设置或点击“同步 GitHub 仓库范围”）会使用已有 App 身份与 metadata-only token 重新读取完整 Selected Repository 集合。页面显示新增/移除与当前完整范围；勾选核对后，通过已有 Windows App Owner 原生窗口确认保存。确认前后都核对相同 App、Installation、Bot、Reviewer 与准确范围；过期、取消、范围再次变化、部分分页或权限异常均保留旧连接。保存仅替换仓库清单并在 Git 外受保护目录保留旧连接备份，不重绑历史队列，不扩大 Watcher/Merge scope。移除的仓库无法再交付；保存后需重新 Preflight。

复用现有 `--github-app-owner-config` 的受保护 Owner SID、ACL、策略摘要和原 App helper pin，以及同一个 Windows 原生确认启动器。Local Fast 使用固定的专用 helper，安装包代码内固定其 BOM 文件摘要；原 App helper 与外置策略保持原样。此配置只用于识别本机 Owner，新 Watcher 权限仍必须由 Owner 在每次原生窗口中明确授予。不会扩展 App 安装范围、登记授权或 Reviewer 身份。

浏览器只能提交有限 scope 参数，不能提交 `confirm:true`、SID、helper 路径或授权结果。保存前后校验真实身份、绑定/队列、有效期、可执行文件及 Viewer 会话，等待确认期间占用现有仓库锁。取消、断线、退出、超时、篡改、旧 scope 冲突或锁占用均不保存新授权，也不启动执行器。CLI 原有真实 TTY 授权保持兼容。未配置原生确认时仍明确显示 `GUI_OWNER_CONFIRMATION_NOT_INTEGRATED` 并提供准确的已安装 CLI 命令。

## 验证边界

提供 V2 资源的正式 Viewer 默认进入 V2；V1 兼容入口为 `/dashboard/v1`（含末尾 `/`），保留旧 `/dashboard/app.js`、`app.css` 与全部 `/dashboard/v1/*` REST/SSE。没有 V2 资源的旧 sidecar 仍保持 V1 默认入口。两套 UI 使用同一个 `/dashboard` HttpOnly Cookie 和原 CSP。

`tests/dashboard-v2-projects-browser.test.mjs` 使用 Windows Edge、真实隔离 Git、模拟 Provider/执行器/Owner scope 与空 CP 数据库，覆盖绑定预览/取消、非法编号、重复启动、停止、授权命令复制、Review 复制、断线恢复及 Viewer 关联重建。模拟环境不代表真实新业务队列验收。

`scripts/dashboard-local-fast-smoke.mjs <已完成 Sandbox 根目录>` 在独立安装的 Viewer 和空数据库中通过 V2 关联既有 completed Sandbox，检查两项任务的真实 PR/Review/Merge/Stage/Watcher 和重启恢复，核对历史文件与数据库摘要未变。该脚本只接受既有 `zlpoot/awh-m1-e-sandbox` completed `[1,2]`，不 bind/start/authorize/Stage。

真实新业务队列、Windows Owner 新授权、独立 Review/自动 Merge 实际重跑、Strict Builder、生产切换、Mac、Release/deployment 均不属于本轮验证。
