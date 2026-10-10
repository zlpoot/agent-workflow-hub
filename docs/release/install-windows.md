# Windows x64 候选包安装

Node.js >=24 x64 + npm；Builder/Client 项目操作另需 Git。无需 Hub checkout、pnpm、
Docker 或常驻服务。先取得可信候选目录、exact source 和 CANDIDATE-SHA256SUMS；
最终九资产集合则使用 release-manifest.json / SHA256SUMS。用 Get-FileHash -Algorithm
SHA256 对照每个资产/清单；不要运行错误架构或使用 force。Mac 尚未实测不能称双端 PASS。

在新外置目录安装每个本地 tgz（名称见 candidate index）：

```powershell
npm install --prefix "<external-prefix>" --cache "<new-empty-cache>" --offline --ignore-scripts --no-audit --no-fund "<candidate>/awh-control-plane-0.1.0-rc.1-win32-x64.tgz" "<candidate>/awh-viewer-0.1.0-rc.1-win32-x64.tgz" "<candidate>/awh-client-0.4.6-win32-x64.tgz" "<candidate>/awh-builder-0.1.0-rc.1-win32-x64.tgz"
Expand-Archive "<candidate>/awh-dashboard-ui-0.1.0-rc.1-static.zip" "<external-ui>"
& "<external-prefix>/node_modules/.bin/awh-control-plane.cmd" --help
& "<external-prefix>/node_modules/.bin/awh-viewer.cmd" --help
& "<external-prefix>/node_modules/.bin/awh.cmd" --version
& "<external-prefix>/node_modules/.bin/awh-builder.cmd" --version
```

安装期间任何联网下载/closure 缺失停止；不改系统 PATH、证书或 npm 登录。PS shim 也
随 npm 安装生成；如本机 execution policy 限制，使用 cmd shim，不更改系统 policy。

CP 使用 Owner 手工批准的仓库外 runtime/trusted config：

```powershell
& "<external-prefix>/node_modules/.bin/awh-control-plane.cmd" serve --runtime-config "<absolute-runtime.json>"
& "<external-prefix>/node_modules/.bin/awh-viewer.cmd" --enable --config "<absolute-viewer.json>"
```

serve 不创建/升级 DB；init 只在新 scratch DB 明确授权后使用，不能对生产数据库再启动
writer。Viewer 默认 OFF，仅显式已有 v2 DB、sessions digest 文件、解压 UI、端口；
UI source/contract/digest 必须匹配包。密钥、session secret、config、DB 保持外置并设置
owner-only ACL。Viewer host 预配 cookie 的受信 exchange 规则见 rc-packaging.md；
不使用 Client token，不自动生成凭据。退出使用控制台 Ctrl+C。

最后在目标真实 worktree，显式选择外置可信 Client config/Project Manifest 后执行
`awh doctor --json`（默认只读离线）。无 config/project 时 BLOCKED 是准确结果。
CP 网络 Doctor、注册/start/event/finish、Viewer 新生产 session 与 GitHub Deliver 必须
各自获得 Human Live 授权；安装不授予这些权限。获准后再按同一中央 CP 的 Run/cursor
核对 Dashboard，不以旧事件重放或本地 journal 为新增提交。

卸载只删除确认属于本次的 external-prefix/UI 目录；不要删除 config/state/Machine identity。
重装用新 prefix 与空缓存。回退不自动降级 DB/policy。故障按 Node/arch、闭包缺失、
路径/ACL、DB v2、TLS/SAN/CA、Viewer session/来源、identity/scope、Provider gate 定位；
不自动修配置、换身份、reset 项目或跳过证书。
