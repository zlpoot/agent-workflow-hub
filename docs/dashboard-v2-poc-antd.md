# Dashboard V2 PoC A · Ant Design 6 工作流指挥台

Issue #86 · 技术路线 A · 分支 `codex/dashboard-poc-antd` · 状态 **AWAITING_INDEPENDENT_REVIEW**

## 1. 固定基线

| 项 | 值 |
| --- | --- |
| 共用基线 SHA（#85 合并后 main） | `8470e51bec7c5a5a5c4301b6900c6a8c5cc05503` |
| 基线 commit | `8470e51 Merge pull request #85 from zlpoot/codex/github-app-dashboard-onboarding` |
| Worktree | `.handoff/issue86-antd/source`（独立，不影响其他 worktree） |
| 对照 PoC | Issue #87 · shadcn/ui + Tailwind 4（方案 B，独立分支，未同步任何中间实现） |

## 2. 依赖版本（精确锁定在 `pnpm-lock.yaml`）

- `antd@6.6.6`、`@ant-design/icons@6.3.4`（开发依赖，不进入服务端运行时依赖）
- 沿用 `react@19.3.0`、`react-dom@19.3.0`、`typescript@5.9.3`、`esbuild@0.28.2`
- 未引入 Umi / Next.js / Ant Design Pro；antd v6 原生支持 React 19，无需兼容补丁
- API 以官方迁移指南 + 本地 `.d.ts` 双重核对，未使用废弃 API（如 `Drawer.width`、`Statistic.valueStyle`、`Descriptions.children` 均未使用）

## 3. 结构（Token / 组件与页面逻辑分离）

```
dashboard/v2/
  app.tsx                 仅 bootstrap（createRoot + Root）
  Root.tsx                组合根：导航 + 数据 hook + 两个页面
  theme.ts                统一 Ant Design Design Token（唯一视觉取值来源）
  semantics.ts            状态词汇表 / 角色与来源中文标签 / 安全 GitHub URL
  selectors.ts            派生指标、项目行、下一责任方分组
  useDashboard.ts         复用既有 DashboardReader 的生命周期 hook
  components/             AppShell / StatusTag / ConnectionBar / MetricCard / StateViews
                          TaskTable / TaskDetailDrawer / GitHubLink / SourceNote
  pages/                  OverviewPage（工作流指挥台）、TasksPage（任务工作台）
```

`dashboard/app.tsx`（V1）未改动；`dist/dashboard-ui/*` 产物路径与内容均未覆盖。

## 4. 数据契约与安全边界（未改变）

- 直接复用 `dashboard/adapter.mjs` 的 `DashboardReader`、`safeGitHubUrl`/`safeSourceUrl` 语义与同一套 OpenAPI 生成校验器；REST/SSE 相位机（loading / refreshing / connecting / live / partial / outdated / offline / error）不变。
- 不修改 Control Plane / Viewer / Resident 业务逻辑，不修改 Gateway、CSP、Cookie、CSRF、PEM/JWT/Token 隔离与 Owner 确认流程。
- 预览使用合成 fixture（`tests/task-fixture.mjs` 与方案 B 共享同一套脱敏任务集），所有模拟行带「模拟数据」标签；`authority_verified=false`、「GitHub 授权未核验」常驻展示。
- 注册/心跳不显示为在线，断线/过期显示为离线/过期；只有 Review Gate 真实证据才显示通过。

## 5. 预览方式（独立入口，端口与产物隔离）

```bash
pnpm build                            # 生成 dist/dashboard-v2/
pnpm dashboard:v2:preview             # http://127.0.0.1:8791/dashboard/v2
node scripts/dashboard-v2-preview.mjs --port 0   # 随机端口（测试使用）
pnpm dashboard:v2:smoke               # Playwright 桌面 + 390px 冒烟
```

- 预览脚本为纯 fixture 只读宿主：`/dashboard/v2` 静态资源 + `/dashboard/v1/*` 由与 V1 fixture 相同的内存 store 提供（真实 `dashboardRoute`、真实校验器、真实 SSE）。
- 与 V1（`pnpm dashboard:fixture`）和方案 B 的工作树、构建产物、运行端口完全隔离；默认端口 `8791`，可用 `AWH_V2_PORT` 或 `--port` 覆盖。
- Cookie 仍为 `awh_viewer`，`HttpOnly; SameSite=Strict; Path=/dashboard`；请求仅限同源 GET。

## 6. 构建产物大小（本地 esbuild，minify，未开 sourcemap）

| 产物 | V1（Radix Themes） | V2（Ant Design 6） |
| --- | --- | --- |
| `app.js` | 693,822 B（gzip 166,424 B） | 1,368,772 B（gzip 391,747 B） |
| `app.css` | 701,446 B（gzip 83,572 B） | 270 B（gzip 196 B） |
| 合计 | 1,395,268 B（gzip 249,996 B） | 1,369,042 B（gzip 391,943 B） |

- V2 将样式交给 cssinjs 运行时注入，因此 CSS 文件接近 0；传输体积 gzip 口径比 V1 多约 142 KB，原始字节数反而少 26 KB。
- `dist/dashboard-v2/build-inputs.json` 记录全部打包输入，`tests/dashboard-v2.test.mjs` 断言不含任何 `src/` 服务端模块、node: 内建或 builder 代码。

## 7. 初版验证记录（第一轮修复的记录见第 10 节）（Windows，Node v24.21.0，pnpm 11.25.0）

| 命令 | 退出码 |
| --- | --- |
| `tsc --noEmit` | 0 |
| `tsc -p dashboard/tsconfig.json` | 0 |
| `tsc -p dashboard/v2/tsconfig.json` | 0 |
| `node scripts/clean-build.mjs` | 0 |
| `tsc` | 0 |
| `node scripts/dashboard-build.mjs` | 0 |
| `node scripts/dashboard-v2-build.mjs` | 0 |
| `node --test --test-concurrency=2 tests/dashboard*.test.mjs`（含新增 `tests/dashboard-v2.test.mjs`） | 0（61 pass / 0 fail） |
| `node scripts/dashboard-v2-smoke.mjs` | 0（9 张截图，0 console / page error） |

### 冒烟覆盖

Overview 四段指标 + 等待独立 Review / 阻塞待处理 / 进行中 / 下一责任方分组；Tasks 项目与阶段筛选、搜索、空态；任务详情 Drawer（打开、Escape 关闭、无原始契约值泄漏）；键盘 Enter 激活导航；离线保留上次快照并明确提示；390px 无横向溢出、抽屉完整落在视口内；`HttpOnly` 同源 Cookie、空浏览器存储、仅同源 GET、未触碰 `/v1/*` CP 路由。

截图位于 `.handoff/dashboard-v2-smoke/`（gitignored）：`overview-desktop`、`tasks-desktop`、`tasks-empty`、`task-detail`、`offline`、`overview-mobile`、`nav-mobile`、`tasks-mobile`、`task-detail-mobile` + `evidence.json`。

## 8. 已知问题 / 兼容性说明

1. **本地 pnpm isolated 布局不可用（仅本机环境）**：沙箱环境禁止创建 symlink，pnpm 11 的 `nodeLinker: isolated` 静默不生成根链接，导致 `pnpm run` 后 `antd` 无法解析。本机验证使用 `corepack pnpm install --ignore-scripts --node-linker=hoisted` 并直接调用 `tsc` / node 脚本。锁文件与脚本不变；在允许 symlink 的环境（CI / 常规 Windows 开发机）中 `pnpm install && pnpm check` 行为不受影响。
2. **`scripts/clean-build.mjs` 的大目录删除**：`rmSync` 一次性删除 97 个文件会触发本机安全删除守卫；已通过单独执行并重建验证，未修改脚本。
3. **antd v6 `size` 枚举**：`Table size="medium"`、`Statistic`/`Card size="small"` 已按 v6 枚举书写；`Descriptions column={{ xs: 1, md: 2 }}` 响应式列数在 390px 正常降为单列。
4. **样式注入与 CSP**：antd v6 通过 cssinjs 注入内联 `<style>`，在既有 `style-src 'self' 'unsafe-inline'` 下工作正常；未放宽任何 CSP 指令，桌面与移动端冒烟均无 CSP / 资源路径报错。
5. **`pnpm-workspace.yaml` 新增 `minimumReleaseAgeExclude: antd@6.6.6`**：pnpm 11 供应链时效策略要求，为安装 antd 当前版本所必需，属锁文件级变更。
6. **模拟数据标记**：fixture 任务的 `fixture: true` 由服务端数据带出，UI 额外在连接条与每行任务上重复标注，避免与真实任务混淆。

## 9. 第二轮 AI 修改实验

按 Owner 指令暂不执行（Tasks 新增「仅显示等待独立 Review」筛选、执行机器信息、详情最近更新时间）。当前实现已为该实验保留扩展点：筛选逻辑集中在 `TasksPage`，机器与更新时间字段已在 `Task` 契约中存在。


## 10. 第一轮独立 Review 修复（2026-10-13）

保持原 PR #89 为 Draft / AWAITING_INDEPENDENT_REVIEW；固定基线与方案 B 不变。Owner 明确授权 Windows local-fast 普通交付。

- **P2-1**：新增 `presentation.ts`，复用 `task-freshness.mjs`，统一 Overview、Tasks、搜索/阶段筛选、责任方分组及 Drawer 的展示任务。offline/outdated/error/partial、事件水位领先快照、观察过期、详情 loading/失败均清除当前状态、执行者、机器、责任方、动作、Owner 范围和 Watcher 运行字段；历史 HEAD/Review/Checks 标注明确。普通刷新保留新鲜事实；从失效状态刷新时保留失效标记，成功快照及事件水位追平后恢复。新快照覆盖 Drawer 中更旧的成功详情。
- **P2-2**：覆盖全部 12 种 TaskState 的互斥分类：进行中、等待独立 Review、待处理、完成、未知。13 行共享 fixture 的统计为 3 / 1 / 7 / 1 / 1。queued/ready/changes_requested/review_passed/awaiting_merge/blocked 都进入待处理；Review 已通过与等待合并各保留原阶段标签，只有 awaiting_review 进入 Review 队列。分组优先明确 waiting_for，每个未完成任务只进入一个责任方组，未知责任方不遗漏。
- **P2-3**：PR 正文采用 `Refs #86`；Issue 是否关闭仍由 Owner 决定。

[六张已提交桌面/390px 截图与 Smoke 摘要](dashboard-v2-poc-antd/README.md)，均为模拟数据。无生产服务或凭据。

| 本轮命令 | 退出码 / 数量 |
| --- | --- |
| `node node_modules/typescript/bin/tsc --noEmit` | 0 |
| `node node_modules/typescript/bin/tsc -p dashboard/tsconfig.json` | 0 |
| `node node_modules/typescript/bin/tsc -p dashboard/v2/tsconfig.json` | 0 |
| `node scripts/dashboard-v2-build.mjs` | 0 |
| `node --test --test-concurrency=2 tests/dashboard-v2.test.mjs tests/dashboard-v2-presentation.test.mjs tests/dashboard-tasks.test.mjs tests/dashboard-refresh.test.mjs tests/dashboard-ui.test.mjs tests/dashboard.test.mjs tests/dashboard-gateway.test.mjs` | 0 · 70 pass / 0 fail（新增 11 项） |
| `node scripts/dashboard-v2-smoke.mjs`（已有 Chromium 路径由 AWH_DASHBOARD_TEST_BROWSER 指定） | 0 · 9 张原始截图，提交其中 6 张 |
| `git diff --check` 与 `git diff --check ff909b2dd69d31350541d3652efa68fb5da2db16...HEAD` | 0 / 0 |

浏览器：0 非预期控制台错误、0 page error、0 CSP violation；2 条故障注入预期资源错误单独计数。1440px/390px 各截图无页面横向溢出，Drawer 在移动视口内。
本轮 V2 JS：1,372,160 B（gzip 392,773 B）；CSS：270 B（gzip 196 B）。V1 源码与产物不变。

原始结果和开发失败保留在 `.handoff/review-fix/`。开发过程中修复了展示时钟边界、普通 refreshing 的过度降级及 Smoke 的 Ant Select 虚拟选项/Drawer 遮罩交互；环境失败包括默认 Playwright 浏览器缺失、沙箱拒绝 Chromium 与 loopback 请求。最终验证在 clean final HEAD 上重新执行；精确 HEAD 和回读结果由 PR 正文给出。
不执行大型全量 CI、打包安装测试或第二轮 AI 修改稳定性实验；不声明独立 Review PASS。
