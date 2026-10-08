# Issue #21 / C1-C Client 协作约定

Human 已启动 https://github.com/zlpoot/agent-workflow-hub/issues/21，依赖 #19/#20 已合并，父任务 #18。本约定替代旧 #8/#19/#20 的单任务限制，唯一实施任务 #21；#3 继续暂停，不自动进入 #22/#23。完整读取 Issue/最新评论，核对远端 main；App JWT live selected-set/permissions preflight 失败停止，不回退用户身份。

从最新 main 建立 codex/c1c-client，通过关联 #21 的一个 Draft PR 串行交付代码、测试与规范；不直推/重写 main、不加未经选择的许可证。保留 Node.js + TypeScript + pnpm 单包、C0 只读 CLI、v0.1 Handoff、C1-A Protocol、C1-B Control Plane 和 Builder transport/Ready 边界。固定 hub/c1c：repository=Hub，base=main，branch=codex/c1c-client，work item=Hub #21，verification=pnpm check。

范围：versioned independently installable CLI/Client，消费者无需 Hub source checkout；init/register/status/start --issue/event/finish，deliver 等待 #22。项目仅 minimal .awh/project.yaml，校验 C1-A schema 与真实 Git root/origin；machine UUID 仓库外持久化，不绑定项目路径；上报 executor/type/machine/name/platform/arch/version/last-seen。显式 CP endpoint/专用 CP credential，不使用 GitHub/App/user 凭据 fallback；数据始终 authority_verified=false。Policy 由 CP trusted config 提供，不接受 Manifest 上传 Policy；命令/URL/权限均为声明，不执行产品命令。成功结束不绕过 independent exact-head Review，受控测试可显式 failed finish。

Human 追加授权真实双平台环境：Windows 192.168.2.5 为 CP 主机，仓库外 SQLite/trusted config，固定监听 127.0.0.1:4310；Mac mini 192.168.2.3 经同一 LAN SSH local forward 到自身 127.0.0.1:4311，无 Tailscale/明文 LAN HTTP。检查 OpenSSH，不可用则准备仅 Mac IP 可连接的方案；系统组件/防火墙需管理员执行时报告阻断，先完成可检查脚本。两端各有独立 CP Client/受信 Profile/仓库外配置，不输出 token/私钥/凭据值。允许显式部署 CP 保持运行。Mac 由 Human 运行安装/连接/验收指令。

真实 Future UI/WebSkill 验收只增加身份 Manifest 并做受控 runtime Run；记录实际 root/origin/branch/HEAD/status 前后，不切活动分支、不修改 AGENTS/产品代码/contracts/依赖/lockfile，不 reset/clean/discard、不跑产品测试/模型/网站/付费流程，不触碰 WebSkill #147/PR #160 或 Future UI #70。不创建产品影子工作区。仅在实际 Windows Future UI 和 Mac WebSkill 都用独立安装包连接同一 CP，完成 register/start/event/status 后标双平台 PASS；fixture/Windows-only/配置声明不替代 Mac，缺口阻断 Ready。

selected-set inspection 始终 metadata-only，精确允许 {Hub}、{Hub,future-ui}、{Hub,future-ui,webskill}、{Hub,future-ui,webskill,agent-desktop}。agent-desktop dormant：无 Profile/write token/read-write/bootstrap/migration。未知/第五仓库、重复、数量不一致、All repositories fail-closed。write token 请求/响应只当前单一 Profile repo。Builder 不透传任意 repo/base/branch/API/URL/Git/gh，不提供 approve/review decision/merge/administration/workflow mutation。

固定 feature ref before → authenticated_read_probe → receive_pack_dry_run → same ref after → 相同才 push；首次 ABSENT→ABSENT。读取/验证/ref 变化/expiry/transport FAIL 停止。保留 generic/scoped helper reset、单一 App header、system/global config/hooks/redirect 禁用、exact safe.directory、local override 拒绝、proxy 与 secret suppression；不输出 authenticated transport text/secret，不放宽 transport。

Codex 实现/测试/修复属于 Builder 验证，不是独立 Review。最终提交后在 exact clean head 跑 pnpm check，记录环境、前后 SHA、命令、退出码、统计和原始输出，失败原因/日志保留。独立安装/双方实际验收证据发布到同一 PR 的 App 评论或双方可读附件。push/PR/evidence/Handoff/Ready 只 App installation identity，不使用 gh 用户写入。PEM/JWT/token 不进入 Git/对话/日志/交接。

真实 JSON 放 gitignored .handoff/；先 pending 评论并回读，再 confirmed，运行本 CLI 与准确 expected-head；更新同评论 JSON/CLI/evidence，回读并核对远端 base/head 才 Ready。有阻断保持 Draft，不宣告完成。最终 SHA 不 commit 到仓库；新提交重新验证/交接，保留旧记录注明替代。完成后报告 PR/base/head/check/独立安装/双端证据及 READY_FOR_CHATGPT_REVIEW；Human 通知 ChatGPT exact-head 独立 Review。Codex 不 approve/merge/close/代填 Review/进入下一任务；Issue 的自动 merge 建议不放宽会话约束。

不实现 Dashboard、Builder Adapter/#22、remote scheduler/queue/start-pause-resume-cancel、模型 API、工作流引擎、Docker、GitHub Actions、自动监听/自动合并或无关授权变更。
