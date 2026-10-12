# Dashboard GitHub App 接入

用户在现有 Dashboard 打开 **设置 → GitHub App**。首次填写 App ID、slug、已有 PEM 的本机绝对路径及个人 Reviewer，默认 slug 为 `zlpoot-awh-builder`、Reviewer 为 `zlpoot`。不上传或粘贴 PEM，不填写 Token，不手工拼接仓库列表。

点击 **检测配置** 后，服务器调用现有 `GithubApp.detect`：通过 App JWT 核验真实 App；完整读取该 App 的安装列表，逐一核验账号、暂停状态、Selected 模式和所需权限；使用 Metadata-only Token 完整读取每个合法安装的选中仓库，并核验 Bot 和个人 Reviewer 的真实数值 ID/login/type。安装列表、Selected 集合均最多 128 项；分页不完整、重复、身份不一致或权限不符时失败关闭。多个安装由用户选择，不自动合并范围。

用户查看完整范围、选择其中一个只读检查仓库并勾选确认，然后点击 **连接并保存**。Windows 原生 Owner 窗口显示实际 App/Installation/账号/Bot/Reviewer/完整仓库名称与 ID、PEM 路径和检查仓库。取消是默认焦点及 Enter/Escape 默认行为；三分钟超时取消。确认后重新向 GitHub 核验，严格比较之前确认的事实，再调用既有 `GithubApp.connect` 保存到 `%LOCALAPPDATA%\AWH\github-app\connection.json`，随后自动调用 `preflight`。

已连接后无需重新填写信息，直接 **重新检查**。刷新或 Viewer 重启从受保护配置恢复 `CONNECTED_LOCAL`，不会把旧检查当作新的实时 PASS。`PREFLIGHT_PASS` 仅代表本次既有 Provider 的实时 Preflight，通过时间会显示；它不授权 Push、PR、Review、Merge 或 Strict Builder。该方法使用 Metadata-only 检查 Token；单仓库写入 Token 的范围/权限/有效期仍由现有交付 operation 在执行时核验。

页面区分 `NOT_CONNECTED`、`CONNECTED_LOCAL`、`PREFLIGHT_PASS`、`BLOCKED`；Fixture 有显著模拟标记及 `真实 Preflight NOTRUN`。连接保存后 Preflight 失败仍保留连接，显示故障与下一步，无需重复连接。当前页面不提供配置替换、删除或历史队列重绑；已有连接无法通过它覆盖。范围漂移需 Owner 单独处理，不能删除/重绑历史状态绕过检查。

## 管理员安装一次

普通 Viewer 默认只读。管理员将最新 Viewer 安装到 Git 外受保护目录，保留生产服务及独立部署 Gate；为 GitHub App 管理单独提供外部受保护 Owner policy，并在 Viewer 启动配置加入 `--github-app-owner-config <绝对外部JSON>`。原有项目 Enrollment 的 `--owner-config` 独立保留，两者可同时使用；GitHub App 页面不依赖 Machine 配置，也不改变 CP。

Owner policy 仅接受下面三个字段：

```json
{
  "schema_version": "1.0",
  "owner_sid": "<真实 Windows Owner SID>",
  "confirmation_script_sha256": "<已安装 dist/dashboard/github-app-confirm.ps1 的 SHA256>"
}
```

policy、其目录、已安装的固定 helper 及 App 配置目录需满足已有 Windows 校验：拥有者为当前 Owner/SYSTEM/Administrators，Allow ACE 只包含这三类主体。管理员预置 `%LOCALAPPDATA%\AWH\github-app` 的保护目录；不把这些文件放入 Git。PEM 文件使用已有有效 RSA key，保持 Git 外及同样的文件拥有者/ACL。部署 policy 只能指认 Owner 和固定安装 helper 的摘要，不能指定任意程序或脚本路径。摘要及 policy 每次确认前后都重新核验，helper 自行核对当前 Windows SID。

这是本机 App 管理权限，不是外部 Strict Builder administrator policy，不授予任何 Builder Work Item 或 Merge 权限。网页不能启用 Owner 功能或提交 Owner policy 路径。未提供该 policy 时仍可读取状态，所有 App 管理 POST 拒绝；远程 authenticated gateway 不提供这些本机入口。

用户后续全部在页面填写、检测、确认和检查，不使用 PowerShell 完成 App 接入。现有 CLI `github-app connect/status/preflight` 继续可用，原配置 schema 与 Local Fast/Strict Builder 交付边界不变。

## 有限本机 API

普通 `/dashboard/v1/*` REST 保持只读。App 管理独立使用固定 `/dashboard/github-app/v1/` 动作，仅在显式 loopback OS-user Viewer 中启用：

| 方法/动作 | 请求字段 | 行为 |
|---|---|---|
| GET status | 无 query/body | 本机状态、管理能力和会话绑定的一次性 CSRF |
| POST detect | app_id, app_slug, private_key_path, reviewer | 检测，不保存；返回无凭据事实和五分钟检测句柄 |
| POST connect | detection_id, installation_id, repository | 引用服务器检测快照；原生 Owner 确认、核验、首次保存和 Preflight |
| POST preflight | repository | 仅限受保护配置内已有仓库，重新检查 |

POST 必须有已认证 HttpOnly/SameSite=Strict Viewer 会话、精确 Origin、`Sec-Fetch-Site: same-origin`、JSON Content-Type、单个 `X-AWH-CSRF`。CSRF 每次消费，绑定当前 cookie 摘要、有效五分钟；刷新 status 轮换。检测句柄也绑定当前会话、有效五分钟且 connect 消费一次。Viewer 重启全部失效。全局单次操作锁拒绝重复/并发，配置保存仍使用 `wx`；两个进程也不能覆盖既有连接。

请求体最多 4096 字节，严格字段白名单；不接受 `confirm`、PEM 内容、Token、安装权限覆盖、任意 config/executable/API URL/命令。每个 GitHub 请求 15 秒超时，Dashboard 的每次 Provider 检查有两分钟总预算；Owner 对话三分钟，管理请求最多七分钟，断开/关闭 Viewer 会中止待确认操作。保存前再次检查会话、检测快照期限和取消状态。已经实际写入的连接即使响应中断也保留，重新读取状态恢复，不自动重放 connect。

JWT/PEM/Token 只留在现有 Provider 闭包；浏览器仅获得非秘密事实和本地操作 nonce。GitHub/文件/PowerShell 原始错误不透传，安全故障码对应中文说明和固定 GitHub 设置入口。All repositories、权限不足、未安装或暂停仅告知 Owner，不自动变更 GitHub。

## 定向验收

构建后打包 Client/Viewer，运行 `tests/github-app-dashboard.test.mjs`、`tests/github-app-owner.test.mjs`、既有 App/网关/Enrollment 回归和 `scripts/github-app-dashboard-smoke.mjs`。所有数据库、身份、key/config/安装目录均新建隔离；测试注入不存在生产配置/REST 开关。

浏览器 Smoke 使用固定本机 Fixture host，覆盖未连接、输入拒绝、完整范围、确认/取消 Fixture、自动 Preflight Fixture、漂移/权限/网络、刷新/服务重启、普通 Viewer、390px 和键盘。Windows Owner 测试使用已安装固定 helper、真实 ACL/SID 与摘要检查，同时注入 child ACK 验证取消/篡改/确认边界；真实原生窗口人工确认验收单独标记，不用 child ACK 声称真人已确认。当前无真实 PEM 时真实 GitHub Preflight 保持 NOTRUN。
