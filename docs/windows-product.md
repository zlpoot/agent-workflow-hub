# Windows Client / Viewer 接入

本功能实现 #58 的离线代码范围。Client 0.4.7 增加正式 presence 常驻入口；Viewer 0.4.7 增加普通浏览器本机入口及当前已安装 Client 的离线 Doctor。它不改变既有 CP、身份、业务历史或审批。真实 Future UI 验收、新 Windows RC、独立 Review 和 Release 仍是后续门槛，旧 #57 ZIP 不因本功能而成为合格候选。

## 从外置目录安装

Node.js 24+、Git 和 npm 是运行前提。操作人先核对本次源码 SHA、两个 tarball 的 SHA-256 和来源，再安装到新的仓库外目录。不要覆盖旧安装或产品 package.json/lockfile。无需 AWH 源码 checkout：

```powershell
Get-FileHash -Algorithm SHA256 '<本次 Client tarball>'
Get-FileHash -Algorithm SHA256 '<本次 Viewer tarball>'
npm install --prefix '<新的外置 Client 目录>' --offline --ignore-scripts --no-audit --no-fund '<Client tarball 绝对路径>'
npm install --prefix '<新的外置 Viewer 目录>' --offline --ignore-scripts --no-audit --no-fund '<Viewer tarball 绝对路径>'
& '<Client 目录>/node_modules/.bin/awh.cmd' --version
```

本仓库开发构建提供 `pnpm client:pack` / `pnpm viewer:pack`；归档包含依赖及说明，hash 从实际归档字节计算。新产物不要复用任何历史 digest。打包功能不发布 npm 或 GitHub Release，也不修改 #57 冻结产物。

## 复用身份和配置

Client 接入复用现有项目 `.awh/project.yaml`、仓库外 Client config、Machine/Executor、专用 credential、endpoint/CA 和 state。运行离线 Doctor 不创建配置或身份：

```powershell
Set-Location '<真实已登记 Git worktree>'
& '<Client 目录>/node_modules/.bin/awh.cmd' --config '<原外置 Client config>' doctor --json
```

没有 Manifest/配置或没有批准 Policy 时结果是 `blocked` 或 `not_checked`。第二个 Git 项目也可诊断，但输入和 Manifest 不授予 Profile/Provider 权限。不为解决分支冲突而 checkout/reset/clean。

升级版本后，CP 保存的 Client version 可能与新安装不同。常驻会阻断并报告 `response_binding`；操作人须在另行批准的现场接入中用既有 `register` 更新同一身份的版本元数据。常驻不自动注册，不重建 Machine，不触碰 Session/Journal、Run 或 Event。

## 显式启动 / 状态 / 停止

在真实工作树的专用终端启动：

```powershell
& '<Client 目录>/node_modules/.bin/awh.cmd' --config '<原外置 Client config>' resident start
```

这是前台常驻服务，终端需保持开启，不是任务 `start --issue`。每 15 秒核对已有 Project/Executor/Client 绑定，随后只向原 CP 发送一次心跳。不会执行任务、报告业务 Event、retry/sync/Deliver 或进行 GitHub 操作。断网和诊断阻断会显示离线并在下一周期重新检查；没有并发心跳。

另一个终端在同一工作树运行：

```powershell
& '<Client 目录>/node_modules/.bin/awh.cmd' --config '<原外置 Client config>' resident status
& '<Client 目录>/node_modules/.bin/awh.cmd' --config '<原外置 Client config>' resident stop
```

`status` 返回本机服务 running、online、last_seen、observed_at、failures/code，不能替代 CP Reader 的在线判定。Ctrl+C 或 stop 等待在途心跳完成并清除自身 lease。重新 start 复用原身份。停止后 CP 在线状态按既有 60 秒 presence 窗口转离线，不伪造停机 Event。进程异常退出留下 lease 时 status 为 `resident_unreachable`，须由操作人核对原进程后清理该单一 lease；不自动删除或终止任何未知进程。

lease 保存于原仓库外 state，只含随机短期本机控制能力；不要分享或上传该文件。控制监听只接受专用本机 CLI，拒绝浏览器 Origin/cookie；它不能注册、运行或交付任务。保护外置配置/state 的 OS ACL，与既有 Client 凭据边界一致。

## 普通浏览器 Viewer

操作人提供仓库外闭合配置，字段契约见 [Viewer schema](local-viewer.schema.json)。运行时还核对真实路径、唯一登记和 viewer scope；schema 不是批准 Policy。下面是结构示意，占位符必须明确替换：

```json
{
  "schema_version": "1.0",
  "mode": "local_browser_direct",
  "database": "<原 CP v2 SQLite 绝对路径>",
  "port": 4311,
  "viewer": { "id": "windows-local-viewer", "project_ids": ["future-ui"] },
  "local_bindings": [{
    "id": "windows-future-ui",
    "project_id": "future-ui",
    "repository": "zlpoot/future-ui",
    "worktree": "<真实 Git worktree 根目录绝对路径>",
    "client_entry": "<Client 目录>/node_modules/@zlpoot/awh-client/dist/client/cli.js",
    "client_entry_sha256": "<此安装 cli.js 的 SHA-256>",
    "config_file": "<原外置 Client config>"
  }]
}
```

`local_bindings` 可以为空。已批准的 Versioned Work Item 可在同一项附加 `policy_trust_file` 和 `work_item: {id, version}`，二者必须同时存在，Doctor 验证独立批准/指纹，不从表单授权。配置与整个 Client 安装须由受信操作人管理；entry hash 是入口比对，不是完整供应链签名。tarball 来源与 hash 仍需安装前核对。

取得本次安装入口 hash 后，经明确现场授权启动独立 Viewer：

```powershell
Get-FileHash -Algorithm SHA256 '<Client 目录>/node_modules/@zlpoot/awh-client/dist/client/cli.js'
& '<Viewer 目录>/node_modules/.bin/awh-viewer.cmd' --config '<仓库外 Viewer config>'
```

Viewer 只读打开原 v2 DB，不迁移、不 seed、不重启 CP；端口冲突时失败，不停止现有服务。地址栏打开输出的 `http://127.0.0.1:<port>/dashboard`。这是**显式本机 OS 用户访问模式**，不是 LAN/公网匿名服务：exact IPv4 loopback socket/Host/port、同源 Origin/Fetch Metadata、无 CORS、无 Authorization bearer。导航换取仅在本机 Viewer 内存中存在、限定 Project 范围的一小时 HttpOnly / SameSite=Strict cookie；API/资源本身不允许无 cookie 自举。过期后重新启动 Viewer 获得新本机会话。既有独立 cookie authenticator 模式保持可用，不能与 local_browser_direct 混用。

接入向导默认当前 Reader 项目；没有快照时要求选择数据来源。历史 #35 样本仍可手动查看，原 9/4/9 不改写。输入工作树/repository 只匹配当前 Viewer 范围内操作人已登记项，未知项明确 BLOCKED，不扫描磁盘或自动注册。点击“检测当前安装与配置”或“运行离线 Doctor”会通过受保护同源只读通道调用那个安装的固定 `doctor --json`，没有 `--probe-cp`，不会上传配置/secret。报告只显示状态、code/source、下一步、批准版本和观测时间；缺失安装、错误版本/hash、仓库或 Manifest 不匹配均阻断。

Dashboard 的项目 name/enabled 缺失表示属性未维护/未提供，不能解读成连接失败。Machine 来自 Executor；Run/Event/Timeline 来自原 CP，lastRefresh/cursor 与 Reader 离线状态单独显示。新心跳只刷新 presence，不增长历史游标，也不把旧 Run/Event 算成本次接入生成。

## 本轮验证与后续门槛

离线验收使用临时 Git 项目、临时 CP v2 和独立安装包；核对只发送心跳、原项目/Client state 字节不变、启停重启、拒绝越权和普通浏览器会话、REST/SSE presence 刷新。最小命令为 build、typecheck、相关 Client/Doctor/Dashboard 与 `windows-product` 回归，以及本机 synthetic 浏览器 smoke；失败原始日志保留。

真实 Future UI 的 CP/SQLite/身份、第二个真实项目、安装部署、业务写入、App Draft 发布、Ready/Merge、Mac 和新 RC/Release 均不能由离线测试推断 PASS，仍按 #58 各自批准后执行。
