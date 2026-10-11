# Windows 五资产安装套件（M1-B1）

四个 OS-neutral Node tarball（Client、Control Plane、Viewer、Builder）和一个静态 UI ZIP 来自同一 clean source HEAD、同一次重新编译。`release/components.json` 是组件版本映射；Client/Viewer/UI 为 0.4.8，CP/Builder 为 0.1.0。`release-manifest.json` 保存 source SHA、工具链、依赖版本及每个归档内文件摘要；`SHA256SUMS` 覆盖五资产、Manifest 和本指南。摘要证明传输完整性，不能代替可信来源、管理员批准或独立 Review。当前是可安装候选，不是 Tag/Release/npm 正式发布。

## 生成和核验

在已提交且 clean 的源码 HEAD 执行一次 `pnpm release:pack --output <全新目录>`。该命令清空生成目录 dist，编译一次，再从此构建产出全部资产；拒绝 dirty 源码和已有 output。`pnpm release:validate <套件目录> --expected-head <40位SHA>` 扫描真实归档、依赖闭包、所有文件哈希、兼容声明与 Viewer/UI 相同字节。构建目录不能置于源码 dist/node_modules 内。原始结果保存在 gitignored `.handoff/`。平台 smoke 写独立证据，不改冻结 Manifest 中的 NOTRUN；Windows PASS 不代表 Mac PASS。

## PowerShell 5.1 与 7 的安装

需要独立安装的 Node.js >=24（含 npm）、Git 和 PowerShell；Node 内置 SQLite 不需要原生 npm addon。以下命令兼容两种 PowerShell，路径可含空格。使用显式 `.cmd` 避免 npm PS shim 的执行策略问题。套件和安装目录应由 OS ACL 保护，业务身份、配置、SQLite 和 Client state 在安装目录与所有 Git 仓库之外。

```powershell
$kit = 'C:\AWH-Kit'
$install = 'C:\AWH\candidate-4388086' # 每个候选使用全新目录
$cache = 'C:\AWH\empty-cache-67'      # 必须是全新缓存
$manifest = Get-Content -LiteralPath (Join-Path $kit 'release-manifest.json') -Raw | ConvertFrom-Json
# 从可信交付 Evidence 核对 source_commit 和 SHA256SUMS 摘要后再读套件。
foreach ($line in Get-Content -LiteralPath (Join-Path $kit 'SHA256SUMS')) {
  if ($line -notmatch '^([a-f0-9]{64})  ([A-Za-z0-9_.-]+)$') { throw 'Invalid checksum' }
  $expected = $Matches[1]; $file = Join-Path $kit $Matches[2]
  if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Digest mismatch' }
}
New-Item -ItemType Directory -Path $install,$cache -ErrorAction Stop | Out-Null
$emptyUser = Join-Path $cache 'user.npmrc'; $emptyGlobal = Join-Path $cache 'global.npmrc'
[IO.File]::WriteAllText($emptyUser,''); [IO.File]::WriteAllText($emptyGlobal,'')
$packages = @($manifest.artifacts | Where-Object { $_.target -eq 'universal' } | ForEach-Object { Join-Path $kit $_.filename })
& npm.cmd install --prefix $install --cache $cache --userconfig $emptyUser --globalconfig $emptyGlobal --offline --ignore-scripts --no-audit --no-fund @packages
if ($LASTEXITCODE -ne 0) { throw 'Offline install failed' }
$bin = Join-Path $install 'node_modules\.bin'
& (Join-Path $bin 'awh.cmd') --version
& (Join-Path $bin 'awh-control-plane.cmd') --help
& (Join-Path $bin 'awh-viewer.cmd') --help
& (Join-Path $bin 'awh-admin.cmd') --help
$ui = @($manifest.artifacts | Where-Object { $_.target -eq 'static' })[0]
Expand-Archive -LiteralPath (Join-Path $kit $ui.filename) -DestinationPath 'C:\AWH\ui-candidate'
```

不需要联网 npm resolution；全部 npm runtime dependencies 已 bundled。UI ZIP 用于资产传输/核验；唯一 Viewer 使用自己包内的相同静态资产，不能通过 config 替换资产或另起旧 session-host。

## 新 CP、Observe、Doctor 与 Viewer

首次安装请管理员依 [control-plane.md](control-plane.md) 配置全新 external trusted config（明确 Profile 和 token SHA256；不要把 Token 写入记录），并准备新的 runtime config：

```json
{ "schema_version": "1.0", "database": "C:/AWH-State/new.sqlite", "trusted_config_file": "C:/AWH-State/trusted.json", "port": 44310 }
```

```powershell
& (Join-Path $bin 'awh-control-plane.cmd') init --runtime-config 'C:\AWH-State\cp-runtime.json'
& (Join-Path $bin 'awh-control-plane.cmd') serve --runtime-config 'C:\AWH-State\cp-runtime.json'
```

`init` 只创建新 v2 DB，已有文件拒绝；`serve` 要求已初始化 DB。默认仅 IPv4 loopback。生产 LAN/HTTPS 需现有受信 CA、外置 TLS config 和单独部署授权。不要复制旧业务 SQLite 或把 init 当作升级迁移。选独立端口，冲突时更换隔离端口而非停止已有服务。

按 [project-enrollment.md](project-enrollment.md) 在普通项目目录完成 `awh setup` → `awh init --machine-config ... --directory ... --confirm` → 管理员 `approve-project` → `--complete --confirm`。只进行 Observe；接入不授予 Deliver。也可使用管理员预配的独立 external Client config，执行 `awh --config ... register`。首次注册写初始 Session，重复注册保留已有 Session。`awh --config ... doctor --json --probe-cp` 仅查询配置、Session 和 CP；Develop/Deliver 未授权可显示 blocked/not_checked，不应被解释成 Observe 失败。

Viewer external config 参照包内 `docs/windows-product.md`：`mode=local_browser_direct`、新 DB、独立 port、scoped viewer 与 local_bindings。显式打开终端运行 `awh-viewer --config ...`，再导航它输出的 `/dashboard` 地址；Viewer 只读现有 DB。自动化验收只做导航响应/资产/快照定向检查，不重复浏览器全流程或 TTL。

Builder 无外置 policy/digest 应拒绝 `awh-builder preflight`。Client/Viewer 仅包含 `admin/registry.js` 只读 loader，不含管理员 writer；Builder 包提供 `awh-admin` 作为管理员 CLI，其存在、模板和 `--confirm` 均不授予权限。独立管理员 provisioning 与 pin 要求见 `docs/administrator-cli.md`。不要从安装 Manifest 或候选自行生成批准环境。

## 停止、重装、升级和恢复

CP/Viewer 在各自前台窗口用 Ctrl+C 停止，确认各自端口释放；不要按进程名批量停止 Node。Resident 仅在明确启动后用原外置 Client config 的 `resident stop` 停止。发行命令不安装服务、不暗中管理进程。

重装用同五资产、全新安装目录和空缓存；核验 source SHA、版本、相同 digest，停止新隔离进程后重启，既有 external 身份/Session 保留。升级先独立 Review/Human Gate，另建安装目录；只在明确批准的兼容计划下切换既有外置配置，不声称旧 CP 数据自动迁移。失败时保留原始日志、安装目录、外置 Session/Journal/DB，回到已批准安装与原 endpoint；不要清库、丢弃 Journal 或重放不确定 Push。生产 Cutover/备份迁移为另行授权阶段。

## 旧 #57 对账

保留：单次构建、四 Node 包与 UI ZIP、bundled dependency closure、归档 SHA256/file audit、Windows executable bin 模式归一化、空缓存离仓安装/停止/重装。

取代：旧 Viewer CLI 和登录/session bootstrap 改为已合并 `dashboard-cli` 的本机 scoped navigation；旧硬编码版本改为结构化组件映射；手搬 CP 改为静态 import 闭包。

不移植：session-host、旧 Wizard/兼容 CLI、固定 future-ui/webskill/agent-desktop 授权、旧 smoke fixture 来源与虚构平台 PASS、旧九资产和 Release gate 自动推进。仅候选打包；Mac/Sandbox E2E/Tag/Release/npm 正式发布/生产 Cutover NOTRUN。
