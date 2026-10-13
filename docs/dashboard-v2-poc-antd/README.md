# 第一轮独立 Review 修复 · 浏览器证据

Issue #86 · 原 Draft PR #89 · **AWAITING_INDEPENDENT_REVIEW** · Owner 授权的 Windows local-fast 普通交付。
固定基线：`8470e51bec7c5a5a5c4301b6900c6a8c5cc05503`；被修复 HEAD：`ff909b2dd69d31350541d3652efa68fb5da2db16`。
最终精确 HEAD 与 clean-HEAD 验证回读见 PR 正文。本报告属于开发方验证，等待 ChatGPT 独立复审。

全部截图来自真实 Chromium 156.0.8078.4，1440×1024 桌面 / 390×844 移动视口；Overview/Tasks 使用 fullPage 截图，Drawer 使用视口截图，避免将视口外的背景表格混入固定 Drawer。
所有数据都是明确标注的**模拟数据**：新建内存 store、随机本地 Viewer 会话、共享 task fixture，无生产凭据。
移动 Tasks 表格在组件内部水平滚动，页面本身没有横向溢出。Drawer 内容在面板内部纵向滚动。

| 页面 | 1440px 桌面 | 390px 移动 |
| --- | --- | --- |
| Overview | [截图](overview-desktop.png) | [截图](overview-mobile.png) |
| Tasks | [截图](tasks-desktop.png) | [截图](tasks-mobile.png) |
| Task Detail Drawer | [截图](task-detail.png) | [截图](task-detail-mobile.png) |

[浏览器 Smoke 原始摘要、CSP、bundle 与截图 SHA-256](smoke.json)。完整开发失败日志、9 张原始截图和最终 clean-HEAD 验证结果保留在 gitignored `.handoff/review-fix/` 与 `.handoff/dashboard-v2-smoke/`，仅提交上述六张必要截图。

浏览器正常流程：0 非预期 console error、0 page error、0 CSP violation。故障注入期间记录 2 条预期浏览器资源错误（断网及详情 503），单独计数，不隐藏应用异常。
CSP 与既有 Gateway 字符串逐字节相同，未放宽。每张截图前检查页面横向溢出，移动 Drawer 边界落在 390px 内。

Smoke 验证既有阶段筛选（Review 已通过只显示 PASS 等待 checks，不进入独立 Review 队列）、搜索/空态、键盘导航、Drawer/Escape、断网降级与恢复、详情 503 的历史 fallback。
SSE 用真实 fixture 宿主和原生 EventSource；在第二个 Chromium 标签中注入契约有效的模拟事件，并控制快照响应延迟及游标，验证 partial → refreshing → 仍落后 → 10s 读取追平；打开中的 Drawer 同步恢复。该注入只存在于 Smoke，不修改 Reader、REST/SSE 或 CP。

定向验证：三个 TypeScript 检查、V2 构建、7 个相关测试文件（70 pass / 0 fail）、浏览器 Smoke、`git diff --check`，全部退出 0。V1 构建产物在最终验证前后使用 SHA-256 比对不变。

限制：沿用既有 hoisted node_modules，直接调用 tsc/node，未修改依赖管理；Chromium 启动和 loopback fetch 在本机 Windows 沙箱被拒绝，授权后在沙箱外运行。未执行大型全量 CI、打包安装测试、生产验证或第二轮 AI 修改实验。
