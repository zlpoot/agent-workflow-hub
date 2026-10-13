# Dashboard V2 · 只读 Viewer（Issue #90）

基于已合并 PR #88 的 main `b1c9ce079f10723a7f5e8eab4cdc081ef7ab4099`，V2 的 Overview / Tasks 正式接入现有 Viewer。React 19、shadcn/ui、Tailwind CSS 4 继续使用选定方案 B；没有引入方案 A。

## 启动与回退

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm viewer --config <绝对路径的外置-viewer.json>
```

Viewer 使用原配置、只读数据库与现有任务观察适配器，打印 `url`（V1）和 `v2_url`（V2）。直接打开 `http://127.0.0.1:<port>/dashboard/v2` 或末尾带 `/` 的路径，通过正常本机文档导航建立一小时 HttpOnly / SameSite=Strict 会话。V2 的 Dashboard V1 链接返回 `/dashboard`，两者共用 `/dashboard` Cookie、项目范围及只读 DTO。V1 继续作为默认启动 URL，并保留项目接入和设置。

V2 的独立静态资源为 `/dashboard/v2/app.js`、`/dashboard/v2/app.css`。Overview/Tasks 使用现有 DashboardReader、`/dashboard/v1` REST/SSE 和 OpenAPI 静态校验器，只有同源 GET 请求。设置 → GitHub App 读取原 status；只有已显式启用本机 Owner 管理时才使用既有有界 detect/connect/preflight POST，见 [App 设置边界](dashboard-github-app.md)。CSP、Host/Origin/Fetch Metadata、会话有效期和权限模型保持原有规则。当前实际执行者、责任方和任务阶段在断线或 SSE 领先快照时降级，历史 Review / HEAD 与来源继续分开标注；CP 声明不能替代 GitHub 原生核验或管理员授权。

真实 Viewer 不接收 fixture 开关、假任务或配置指定的资源目录。`pnpm dashboard:v2:preview` 仍是独立随机端口、独立内存 SQLite 的明确模拟预览，始终标明“示例预览 · 模拟数据”，不能接收生产路径或凭据。

## 构建与离仓打包

`pnpm build` 统一生成 `dist/dashboard-ui/`（V1）和 `dist/dashboard-v2/`（V2）；V1 资源不会被 V2 覆盖。单独 `dashboard:v2:build` 仍可用于已有契约校验器产物的定向重建。

`pnpm ui:pack` 的 `awh-ui.zip` 在根目录保留 V1 的 index.html、app.js、app.css、validators.cjs，并在 `v2/` 下增加 V2 的 index.html、app.js、app.css。静态宿主须按上述 URL 映射这些文件，并由受保护 Gateway 提供同源 API/会话；不要用裸静态服务器绕过认证。`pnpm viewer:pack` 的离仓包包含两套同字节产物；构建报告、源码、fixture 和测试不进入 UI 资产集。本地 release 打包路径也携带 V2 资源，未执行 Release 发布。

## 有界验证

```powershell
pnpm typecheck
pnpm build
node --test --test-concurrency=4 tests/dashboard-v2.test.mjs tests/dashboard-ui.test.mjs tests/dashboard-gateway.test.mjs tests/dashboard.test.mjs tests/dashboard-tasks.test.mjs tests/release-packaging.test.mjs
pnpm dashboard:v2:viewer-smoke
pnpm dashboard:v2:smoke
```

`dashboard:v2:viewer-smoke` 离线安装本轮真实 Viewer tarball，在全新 Windows 临时目录创建配置、App 配置根和非生产 CP 数据库。测试准备程序写入脱敏 CP 运行时声明；正式 Viewer 只读该库，不注入 Task fixture、GitHub 原生结果或授权。验证桌面 / 390px、任务和 Issue/PR 链接、执行者/机器/责任方、详情、手动刷新、真实持久 Event → SSE → Reader 刷新、实际 Viewer 停止后的降级和重新启动后的恢复、Cookie/CSP/GET-only、同包 UI 字节一致以及 V1 回退。结束前关闭准备程序，再验证 Viewer 重启读取没有改变数据库字节。

原始日志、失败、安装包、截图与准确干净 HEAD 的最终验证记录保留在 gitignored `.handoff/`。这些是本地验证，不是正式 Builder Evidence / Handoff / CP Run，也不是独立 Review。没有运行大型全量 CI。

Mac 真机、生产 Cutover、真实 GitHub 任务端到端交付：**NOTRUN**。生产配置、CP/Viewer/Resident 与业务 worktree 不用于本轮测试。#84 在此基线上增加 V2 GitHub App 设置 UI；原 #90 的验证只对应当时 HEAD，#84 的准确 HEAD 与证据另见其 Draft PR。停在独立 Review，不自动批准、Merge、Tag、Release 或生产部署。
