# Windows 0.4.8 项目接入与管理员审批

普通用户入口和状态说明见 [Windows 快速指南](windows-product.md)。本机 Future UI / agent-desktop 的真实 Observe 验收已经完成；用户已反馈当前页面使用正常；新增简化接入与本机管理员按钮仍须独立代码 Review，不能外推业务开发交付全链路通过。R1-D 离线测试、R1-E 实机验收、独立代码 Review、Human UAT 和 Release 是分别记录的结果。

## 一次性安装（管理员）

当前设备已配置，无需重做。新设备的管理员先核验审核源码和实际包摘要，将 Client / Viewer 安装到新的 Git 外目录，保护 machine home 和外置配置。运行前提为 Node.js 24+、Git；npm 用于安装。

以下全为占位模板，必须由管理员替换；本次收口不执行这些命令。

```powershell
Get-FileHash -Algorithm SHA256 '<Client tarball>'
Get-FileHash -Algorithm SHA256 '<Viewer tarball>'
npm install --prefix '<新的外置 Client 目录>' --offline --ignore-scripts --no-audit --no-fund '<Client tarball>'
npm install --prefix '<新的外置 Viewer 目录>' --offline --ignore-scripts --no-audit --no-fund '<Viewer tarball>'
& '<Client 安装目录>/node_modules/.bin/awh.cmd' setup --machine-config '<外置 machine.json>' --home '<已建立的私有 machine home>' --endpoint 'https://<受信 CP>:8443' --ca '<公共 CA 文件>' --project-root '<获准的项目根目录>'
```

setup 自行核对安装入口摘要；普通用户不逐项目计算 SHA。它拒绝覆盖已有 setup。旧设备仅可经明确选择 `--reuse-machine-state <原外置 state 目录>` 复用 Machine 元数据，不能复制或重置业务 Session/Journal。开发准备另需受信 Policy anchor/catalog，setup 不批准这些权限。

管理员在闭合外置 Viewer 配置中设置 `machine_config_file`，限定 Project scope、固定已安装 Client 和 IPv4 loopback 监听。配置字段见仓库原有 `local-viewer.schema.json`。Viewer 只读本机原 v2 DB；该方式不实现远程 SQLite 共享或公网 Dashboard。配置/数据库/credential 的真实路径只在本机私有交接保留。

## 普通用户申请（后续经授权的新项目）

点击“添加项目”，选择本机目录，再点“接入项目”。浏览目录只覆盖管理员批准的项目根，不扫描整盘。在确认框核对仓库、分支和目录，默认仅观察；点“确认接入”提交。取消不会提交申请。“高级选项”可选受信开发准备，但必须已有匹配的批准任务，空列表会显示说明并阻止提交。

这一步只在机器 home 产生专用申请和 credential，不创建 Manifest、CP Project/Executor 或 Run/Event。界面提示等待管理员批准；已启用本机管理员入口时，可点“管理员批准并接入…”打开 Windows 原生确认框。用户不分享 credential。原项目已经接入时不重复申请或批准。

## CP-owner 预览与批准（每个新申请）

管理员在 **CP 宿主机** 对专用申请做预览，核对仓库、机器、执行器、模式及单 Project / 单 Executor scope，再确认：

```powershell
node '<CP 安装目录>/dist/control-plane-cli.js' approve-project --request '<外置申请文件>' --database '<已有 v2 SQLite>' --config '<现有 CP-owner 信任配置>'
# 预览核对无误后，由管理员明确执行：
node '<CP 安装目录>/dist/control-plane-cli.js' approve-project --request '<同一外置申请文件>' --database '<同一已有 v2 SQLite>' --config '<同一信任配置>' --confirm
```

授权追加专用、不可变的 enrollment grant 和单仓库/执行器 Client scope；预览及批准命令不写 SQLite。已更新的 CP 验证管理员受控的新信任快照，所以批准无需重启 CP。不得借用旧 Client scope、放宽未知仓库或通过审批激活业务策略。

本机按钮批准后自动继续接入；原 CLI 审批方式批准后，用户再点击“完成接入”并确认。Client 核对 grant/request/专用 credential 后，保留冲突身份、生成缺失的最小 Manifest 和外置项目配置、登记并发送心跳。Viewer 为新增项目启动 Resident。只有真实 Executor 在线才是接入可用；部分失败不能写 PASS。重复完成/审批有幂等边界，但本次体验无需重复执行。

## Doctor 是诊断，不是修复或执行授权

已有项目：填入原工作树，点“接入项目”或“重新检查接入”核对后取消确认框，在“详情与诊断”点击“Doctor 检查”。默认本地检查只读；显式 CLI `--probe-cp` 才增加受信 HTTPS enrollment GET，且不发送心跳。两种检查范围不同。

```powershell
& '<已安装 Client>/node_modules/.bin/awh.cmd' doctor --machine-config '<既有外置 machine.json>' --directory '<原 Git root>' --json
& '<已安装 Client>/node_modules/.bin/awh.cmd' doctor --machine-config '<既有外置 machine.json>' --directory '<原 Git root>' --json --probe-cp
```

当前已核验原件：agent-desktop CP probe 是 5 passed / history not_checked，整体 not_checked、exit 0；CLI 只有 blocked/错误才返回 exit 2。Future UI 旧业务 Doctor dirty/branch/journal blocked、exit 2 与 Observe online 可以同时成立。

“预览 Doctor 修复”先显示计划，再通过独立确认框“确认修复”；修复可能登记和发送心跳，本次人工体验只诊断，不确认修复。修复也不覆盖冲突身份、不改 endpoint/CA、清除 Journal、重试业务 Event 或切分支。

## 身份、在线与会话

Project 按仓库全局关联；Machine 是已安装设备；Worktree 是本机绑定；Executor/Client scope 是每个绑定的专用身份。新 Observe Executor 无 Run 也能按 Project 筛选显示。未来同仓库多个机器/工作树要保留独立身份空间；当前 Windows 同机验证不外推跨机展示或 Mac 验收。

会话期限仍为一小时。0.4.8 顶部“重新进入 Dashboard”做显式同源文档导航，可获得有效本机会话，不重启 Viewer。API 或跨源访问不能自行引导会话。R1-E 证据证明自然期限之后新浏览器资源/API 401 与显式再进入恢复；旧 cookie 拒绝的完整字节闭环和到期原页面同一按钮直接点击未保留，不能补称已验证。

## 当前停止点

Grant 只有 register/presence，不授权业务 Run/Event、Provider/Deliver 或 GitHub 开发写入。已安装 Windows 可人工体验，用户报告页面可用；本次候选独立 Review 尚待完成。Mac、跨机器、Release、Ready/Merge 和新测试仓库须后续独立授权。现有 #59/#60 的已审查 HEAD/Draft 保留。

## 可选本机管理员按钮（一次性配置）

标准 Viewer 入口仍按原配置运行。管理员仅在 Windows CP 宿主机上显式启用旁置入口：

```powershell
node '<Viewer 安装目录>/dist/dashboard-owner-cli.js' --config '<原外置 Viewer 配置>' --owner-config '<受保护的外置 owner 配置>'
```

owner 配置的闭合字段为 schema_version=1.0、cp_entry、cp_entry_sha256、trusted_config_file、database、owner_sid、confirmation_script、confirmation_script_sha256；可选 policy_trust_file。所有文件均在 Git 外，database 必须与 Viewer 相同。管理员核验 CP 来源和两个入口摘要，并把 owner_sid 绑定到获准的 Windows 操作人；确认脚本位于 Viewer 安装的 dist/dashboard/owner-confirm.ps1。不得从项目、Issue 或浏览器接收这些配置。

这不是 Windows UAC 提权或远程管理员登录。原生确认脚本核对当前 Windows 身份，回车默认取消，三分钟超时取消；取消不写审批。每次操作先预览原 CP approve-project，再明确确认；确认前后核对申请与入口摘要。浏览器只传已选本机目录，不能传命令、权限或凭据；已有同源与本机会话保护继续生效。

旁置入口和中文确认脚本随 Viewer 候选打包；已有 0.4.8 原包不会自动获得这些文件。当前本机覆盖不等于正式新 Release。安装到新机器仍需核验独立审查和候选包摘要。
