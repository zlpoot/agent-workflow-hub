# Windows 0.4.8 快速使用指南

这份指南对应当前已上线的 Windows 本机 Client / Viewer 0.4.8，以及来自已审查源码的 CP。Future UI 与 agent-desktop 的真实 Observe 接入已经完成 R1-E 验收；用户已反馈当前页面使用正常；本次接入简化和本机管理员按钮属于独立修复候选，仍需独立代码 Review，不扩大为完整业务链路验收。

## 普通用户日常查看

1. 在当前 Windows 机器的浏览器打开 [Dashboard](http://127.0.0.1:4311/dashboard)。无需重装或启动第二套服务。此地址只适用于这台机器。
2. 点击左侧“项目”（Projects），按仓库字段找到 `zlpoot/future-ui` 和 `zlpoot/agent-desktop`。项目名称或启用状态显示“未提供”表示没有提供该属性，不表示离线。
3. 点击“执行器”（Executors），查看“在线状态”和“最近服务端联系”。点执行器名称可以打开详情，查看机器归属和数据来源。在线依据 CP 注册/心跳时间，不是业务执行批准。
4. 页面上方“按项目筛选”下拉显示 **Project ID**，不是仓库名。先从“项目”卡片复制 agent-desktop 对应的 ID，再到“执行器”选择它。即使该项目没有 Run，其已登记执行器也应显示。需要查看其他项目时切回“全部项目”。筛选器在项目/执行器/运行等视图显示，概览没有该筛选器。
5. 顶部“刷新”读取当前数据。“重新进入 Dashboard”重新打开同一个 Dashboard 文档入口，恢复本机会话。0.4.8 会话到期后无需重启 Viewer；再次进入后仍可查看授权项目。不要通过停服务解决会话到期。

“在线”表示 Resident 正在发送 presence；“离线”表示最近联系超过 CP 的有效窗口；Reader 显示 offline/outdated 时，执行器状态可能为“未知”，应先区分读取服务失联与执行器离线。Run、Event 与 Timeline 是既有业务历史，心跳不会创建新的业务记录。agent-desktop 当前零 Run 是正常的 Observe 状态。

## 查看 Doctor 与接入说明

点击顶部“添加项目”，打开当前真实接入入口。旧四步向导和 #35 历史样本已从产品页面移除；原证据和业务历史仍保留。

展开“已接入项目”，从中找到 agent-desktop 的本机工作树。将该目录填入“项目目录”，点击“接入项目”或“重新检查接入”，核对确认框后可取消；展开“详情与诊断”，点击“Doctor 检查”查看逐项状态和建议。本次体验只做识别和 Doctor，不重复提交申请、确认接入或执行修复。Doctor 结果在新增项目区域逐项显示；这一 UI 操作没有独立 CLI 退出码展示。

agent-desktop 的 R1-E 显式 CP 只读 probe 原件为 **5 passed / 1 not_checked，整体 not_checked，CLI exit 0**。history not_checked 表示保留的历史未在该 Doctor 中对账，不等于接入失败，也不等于全项 PASS。界面 Doctor 默认本地诊断，和带 `--probe-cp` 的 CLI 结果有不同的检查范围，不能要求所有项照抄原 probe。

Future UI 的既有业务 Doctor 可能显示 dirty、branch 或 journal blocked（旧记录 CLI exit 2）。这些是 Workflow readiness 的检查结果；如果 Executor 仍在线，不能据此判为 Observe 离线。不要为了消除提示切换分支、清理改动或重试业务 Journal。

## 新项目接入如何进行

后续经明确授权增加项目时：选择本机 Git 目录 → “接入项目” → 确认框核对仓库、分支、目录和默认“仅观察” → “确认接入” → 在待批准区域点击“管理员批准并接入…” → Windows 管理员确认框明确批准 → 到“执行器”确认真实在线。未配置本机管理员入口时，等待管理员按原 CLI 批准，再点“完成接入”并确认。取消确认框不会提交申请；取消管理员确认保留已提交的申请。详细管理员步骤见 [项目接入](project-enrollment.md)。

普通用户无需手写 credential、SHA、Manifest 或 JSON；申请不会立即注册项目。批准之后完成接入才会生成缺失的最小 Manifest 和外置项目配置、注册并启动 Resident。Observe 允许保留本机改动。当前 Grant 只有 `register_presence`，不能创建业务 Run/Event、调用 Provider 或 Deliver。“受信开发准备”同样不是自动执行权限。

本次 5–10 分钟体验不新增项目、不为原项目重复申请或批准。

## 一次性管理员设置与日常操作分工

管理员负责：核验候选来源与 tarball SHA-256，安装独立 Client / Viewer 到 Git 之外；准备 Node.js 24+、Git、安装用 npm；保护外置 machine home、配置、信任文件和身份；设置固定 CP endpoint / 公共 CA / 允许的项目根目录；用 `awh setup` 初始化或显式复用原 Machine 元数据；把 machine 配置接入 Viewer；在 CP 宿主机批准专用 Observe 申请。

当前机器以上设置已经完成。普通用户只需打开 Dashboard、查看项目/执行器、识别目录、读 Doctor、等待管理员批准以及重新进入会话。本机管理员入口是显式可选配置，提供按钮和 Windows 原生确认框；未配置时保留宿主机 CLI 审批方式。按钮只批准专用登记和心跳，不批准新的开发任务或 GitHub 写权限。用户不需要复制秘密或修改 JSON。

## 运行、停止与升级边界

当前本机已接入 Future UI、agent-desktop、test-awh。test-awh 是仅观察接入，没有已批准的开发任务。本次体验不执行停止、重启或升级。Resident 通常每 15 秒检查原绑定并发送心跳；正常停机之后 CP 按既有 60 秒 presence 窗口判离线，体验清单不要求重做 TTL 测试。

维护时管理员必须另外安排窗口：CP 管理既有 v2 SQLite；Viewer 只读该库；原 Future UI Resident 是单独启动的，新增项目 Resident 受 Viewer 生命周期管理。关闭 Viewer 可能停止由它启动的新增项目 Resident，因此浏览器页面关闭与 Viewer 进程停止不是同一操作。

升级先保留原安装、逻辑一致备份、配置及身份；新字节需要来源/摘要核验及现场授权。只在当前 DB/trust 兼容的前提下回退二进制，不能为恢复“在线”而恢复接入前旧 DB/trust、覆盖身份或删除 Journal/State。包内 `os/cpu`、平台验证和迁移路径须以其实际元数据为准，Windows 实测不外推 Mac。

## 已交付范围

Windows Client / Viewer 0.4.8 包和真实双项目 Observe 已可供本机体验。CP 是 PR #60 已审查源码的实机编译产物，不能称为新的独立正式 npm CP 包。#57 是早期打包候选；统一五资产跨平台发行、Mac 验证、Release Manifest/Tag/npm 发布仍归 #54/#56，尚未完成。跨机器、24×7、开发→PR→Review→Merge 全链路也不由本次本机 Observe 验收证明。
