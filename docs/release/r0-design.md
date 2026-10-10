# R0 第一阶段：组件冻结与统一发布包设计

状态：`DESIGN_FROZEN / RC_NOT_BUILT / RELEASE_NOT_AUTHORIZED`。本文件落实
[Issue #54](https://github.com/zlpoot/agent-workflow-hub/issues/54) 第一阶段；只冻结发布工程范围，
不宣告包级、真实 Runtime Write 或 Full Delivery 验收通过。

## 事实基线与冻结范围

核对日期：2026-10-10。GitHub main 准备基线为
`43823f9f70360543b8cdf07682764af6bb4d6601`。这是源码盘点基线，不是 tag、
发布源码 SHA 或本设计 PR 的最终 head。实际发包必须重新记录最终 exact clean source。

冻结新增业务功能；只允许后续明确授权的打包、独立运行入口、安装配置文档及最小兼容修复。
保持现有单仓库、root `private:true`、锁文件和固定权限模型；不要求拆长期 shared 包、
新发布服务、自动监听、工作流引擎、Docker 或 GitHub Actions。不得顺便实施
#22/#27/#31；本阶段不改产品代码、依赖、配置、生产数据库或项目工作树。

| 冻结项 | 当前事实 / 来源 | R0 决定 |
| --- | --- | --- |
| 总版 | root `package.json`: `0.1.0`, private | 候选名提议 `v0.1.0-rc.1`，未建 tag，未发布 |
| Client | `src/client/version.ts`: `@zlpoot/awh-client@0.4.6` | 保留独立版本；同版本不同 source/bytes 必须由 digest 区分 |
| CP | `src/control-plane-cli.ts`, `src/control-plane/store.ts` | 独立分发；SQLite schema **2**，正常 serve 只开已有兼容 DB |
| Viewer | `src/dashboard/gateway.ts`, `security.ts`, `store.ts` 的 `DashboardReadStore` | 独立只读 sidecar；默认 OFF，显式受信会话与资产选择 |
| Dashboard UI | `scripts/dashboard-build.mjs`, `dashboard/`, Dashboard OpenAPI | 独立静态归档；API `1.0.0`，DTO/validator 与 Viewer 配对 |
| Builder | `src/builder-cli.ts`, `builder.ts`, `profiles.ts`, `validator.ts` | 独立 CLI；App identity、精确 selected set、单仓库 token 不变 |
| Protocol / Handoff | `src/protocol/schema.json`, `src/validator.ts` | Protocol `1.0`、Handoff `0.1`，按实际导入闭包随包分发 |
| Onboarding | `src/onboarding/api.ts`, `contracts/onboarding-v1.openapi.json` | API `1.0.0` 仅 offline fixture；不发布生产 Operator/Pairing 服务 |
| 构建工具 | root package / lock | Node `>=24`，pnpm `11.25.0`；真实完整工具版本写进 Manifest |

冻结是组件、接口与发布范围冻结，不是给任何已有 workflow 新增任务权限。
Profile/Work Item 仍是受信政策/声明数据，不是独立进程。`agent-desktop` 保持 dormant。
Client 内含 deliver/revision/recovery 实现，不等于对应工作获准执行。

## 五个分发目标与九个候选资产

四个 Node 组件每个平台一包，另有一个 OS 无关 UI 包，共九个组件资产。
同一个 GitHub Release 还包含唯一 `release-manifest.json`、`SHA256SUMS` 和两端安装指南。
包名及新增命令名在下表中是**设计名称，尚未实现或 registry 发布**。现有 Client 的
`awh` 命令保留。CP/Viewer/Builder 的拟议包版本为 `0.1.0-rc.1`；不改 root 版本。

| 组件 / 拟议 npm identity | 当前入口与缺口 | 设计入口 / 归档 |
| --- | --- | --- |
| Client / `@zlpoot/awh-client@0.4.6` | `scripts/client-pack.mjs` 已 pack；无 source/平台 provenance 清单 | 保留 `awh` → `dist/client/cli.js`；`awh-client-0.4.6-<target>.tgz` |
| CP / `@zlpoot/awh-control-plane@0.1.0-rc.1` | `dist/control-plane-cli.js` 仅 checkout 内可运行 | 拟议 `awh-control-plane`；`awh-control-plane-0.1.0-rc.1-<target>.tgz` |
| Viewer / `@zlpoot/awh-viewer@0.1.0-rc.1` | `createDashboardGateway()` 是库；无 standalone trusted Session Host CLI | 拟议 `awh-viewer`；`awh-viewer-0.1.0-rc.1-<target>.tgz` |
| UI / build `0.1.0-rc.1` | `dist/dashboard-ui/` 有静态 build；无发布归档 | 受保护 `/dashboard`；`awh-dashboard-ui-0.1.0-rc.1-static.zip` |
| Builder / `@zlpoot/awh-builder@0.1.0-rc.1` | `dist/builder-cli.js` 仅 checkout 内可运行；无 bin shebang/help | 拟议 `awh-builder` 与只读 `awh-handoff-check`；`awh-builder-0.1.0-rc.1-<target>.tgz` |

`<target>` 仅为 `win32-x64` 或 `darwin-arm64`。macOS x64 及其他目标均
`NOT_VERIFIED`，不出现在首轮必需资产集合中。UI 的静态性质不代表两端浏览器已经实测。
Node/pnpm/Git/浏览器不塞入归档；运行须外装 Node 24+，Client 项目检查与 Builder
transport 另需 Git。消费者从本地 `.tgz` 安装不需要 pnpm、TypeScript、esbuild 或 Hub clone。

每个 Node 包均为 ESM，声明 `engines.node >=24` 及该资产对应的 npm `os`/`cpu`，
安装前另核对实际平台，拒绝错误架构，不能用 force 绕过。新增 bin 须补 shebang 和 npm shims，
验证 PowerShell/cmd 与 macOS 可执行权限。产物名带平台，但包内 identity/version 保持一致。
不把 root `package.json` 当成分发包，不取消 private，不附加未经选择的项目许可证。
保留随第三方依赖分发的许可证/NOTICE。

### 导入闭包和排除项

编译后按相对导入、JSON import、动态加载与资源读取生成闭包清单，不能只复制入口文件。
首轮后端不 bundle 成单文件，不重写逻辑，不移动 shared contracts；临时 staging 为每包
生成自己的 package metadata。逐包列明直接/传递 runtime 依赖的锁定版本和完整文件列表。
闭包不明、同名依赖版本冲突、越界资源或安装后缺失 import 均停止发包。

| 目标 | 必需编译/资源闭包 | 不作为该包入口的内容 |
| --- | --- | --- |
| Client | 现有 pack 的 `client/`, `protocol/`（含 schema）, `shared/`, `validator.js`, `profiles.js`, `builder.js`, `control-plane/security.js`；Client/Doctor/versioned-profile 指南 | CP writer/server CLI、Viewer、UI、Onboarding fixture、开发测试 |
| CP | `control-plane-cli.js`, `control-plane/`, 实际导入的 `protocol/`, `shared/`, `dashboard/` 只读路由依赖及 JSON | Client、Builder、UI 静态 build、Operator fixture/seed CLI |
| Viewer | 新 trusted host 入口、`dashboard/`、`DashboardReadStore` 所在 store/security 模块、其 protocol/shared 闭包；Dashboard contract/资产校验 metadata | CP serve/init、Client/Builder CLI、任何写/seed/Operator 入口 |
| Builder | `builder-cli.js`, `builder.js`, `profiles.js`, `validator.js`, `cli.js` 及实际新增导入闭包 | CP/Viewer/Client CLI、Onboarding、UI |
| UI | `index.html`, `app.js`, `app.css`；对应 Dashboard DTO contract、generated validator provenance、build-inputs 清单 | node_modules、服务端代码、凭据、外部远程资源 |

CP server 当前导入 Dashboard 路由，因此不能为了目录整洁漏掉它们；默认 OFF 保持不变。
Viewer 当前 `store.ts` 也含 writer 类，第一轮可随共享模块进入闭包，但 host 仅构造
`DashboardReadStore`，只读打开已有 v2 DB，不暴露 writer API、不初始化/seed/migrate。
不宣称“包内没有任何 writer 代码”。Builder 当前预期仅 Node built-ins，是否零 npm
runtime 依赖由闭包验证确认。其他 Node 包 bundling 锁定的 Ajv/ajv-formats 及传递 runtime
依赖；开发依赖不会因为 root build 使用它们就进入后端归档。

UI `app.css` 来自 esbuild CSS 输出，不能只打包脚本；validator 已进入浏览器 bundle，
`validators.cjs` 可作为 build provenance 文件分发但不新增 Gateway 静态路由。
React/Radix 和 generated validators 已在 UI build 内，不要求服务端安装这些 devDependencies。

统一拒绝开发 `src/`、tests、`.git`、`.handoff`、pnpm store、绝对工作区路径、真实 config/DB、
Client journal/session/Machine UUID、PEM/JWT/token。允许明确标注 inert 的配置示例/指南；
不能默认加载，也不能带可信授权或可用会话。schema/示例只能辅助校验，不改变 policy。

## 独立入口与安装布局

后续入口最小变更单独审查，不在第一阶段实现。CP 包装现有 init/serve 参数和错误分类，
不做默认 DB 创建、schema 升级或开机服务。`init` 只用于另行授权的新 scratch DB；
正常 serve 必须已有 v2 DB、受信 Profile 与明确外置 runtime/trusted/TLS 配置。

Viewer 需要独立启动/停止入口，显式 opt-in、外置已有 DB、外置受信 session digest 配置、
匹配的 UI 资产目录以及显式端口；不从 CP Client bearer 发行 Viewer cookie。受信 Session
Host 的 cookie 输送机制是后续必须补齐并独立审查的发布缺口：只接受 Human 预配 opaque
secret，HttpOnly/SameSite=Strict/Path=/dashboard、现有 exact loopback/same-origin 边界，
不在 URL、stdout 或浏览器 JS 暴露值，不提供匿名/public 自动 issuer 或 Operator API。
现有 Session Host 不构成可独立运行包；该项未补齐时 Viewer 必须标 `BLOCKED`。

Builder 新增 help/version 可在无 App credential 情况下只读检查安装；原有纯
`awh-handoff-check` 离线校验保持 `authority_verified=false`。preflight 需要 App key，
不能把缺 key 的负向测试或只读校验写成 live Builder PASS。实际执行 cwd 仍为目标受信
Git worktree，包在仓库外；key 在所有仓库及安装目录之外。政策代码跟随 exact source，
不允许安装配置指定任意 branch/repo/API/Git 参数，不为 #54 产品执行创建新 workflow。

安装布局（示意，非实际路径或生产配置）：

```text
<external-install>/rc.1/<component>-<target>/  # npm prefix/包 runtime 或 UI 静态资源
<external-config>/                          # operator-owned configs/keys/session files
<external-state>/                          # CP v2 DB 或 Client journal/session，独立保留
<actual-project-worktree>/                  # project manifest 与受信工作树；不复制到包中
```

两个平台分别从对应本地资产安装（拟议使用 `npm install --prefix <dir> --ignore-scripts
--offline --no-audit --no-fund <artifact.tgz>`），先验证 digest，禁止 registry fallback；
捆绑闭包须使隔离空缓存安装可行。使用 prefix 的 `.bin`/Windows shims 或明确 node 入口，
不依赖 checkout 的 dist、父目录 node_modules 或开发 PATH。安装不会修改系统 trust/PATH。
卸载/重装仅操作安装目录；不删除 external-state/config、Machine UUID 或原数据库。
更新以新 prefix 旁置安装、明确选中后运行；回退不能自动降级 SQLite/Policy/历史。

Windows 使用 owner-only ACL，macOS 使用 owner-only key/credential 模式并拒绝不受信
symlink/junction 重定向；空格、非 ASCII 路径、不同 cwd、signal 退出、native HTTPS、
Node built-in SQLite 均纳入平台 smoke。不把 Windows node_modules 拷贝到 Mac。

## Release Manifest v1 设计

发布时唯一事实文件为 `release-manifest.json`，`kind=awh_release_manifest`、
`schema_version=1.0`。第一阶段只提供 [惰性设计例子](release-plan.example.json)，
它是 `kind=awh_release_plan`，null 表示尚无证据；**不是可接受的发布 Manifest**。

| 字段 / 对象 | 实际发布清单约束 |
| --- | --- |
| `release` | 固定 release id、name、tag、`channel=rc`、发行前冻结的 RC 状态、`source_commit` 完整 40 hex、source clean、Human gate/evidence 引用；名称不等于授权，发布状态变化不回写冻结字节 |
| `components[]` | 恰好五个唯一 id，包 identity/version 或 UI build version、entrypoints、protocol/schema/contract requirements；记录嵌入 policy 与 contracts 的 digest |
| `artifacts[]` | filename 全局唯一；(`component`, `target`) 组合唯一且 component 必须引用已定义 id；九个必需组合各恰好一次，不同组件可使用相同 target；size_bytes >0、sha256 64 hex、source_commit、package/build version、build_environment 和 runtime Node minimum |
| `build_environment` | OS/CPU、完整 Node/pnpm/npm/compiler/bundler 版本（未使用项显式 n/a）、lockfile SHA-256、offline install closure 清单和证据链接；不放绝对路径或环境变量转储 |
| `compatibility[]` | Client↔CP Protocol 1.0/v2、UI↔Viewer Dashboard 1.0.0+contract hash、Builder↔内嵌固定 Profile+Handoff 0.1；范围与实际 tests/evidence、status 明确 |
| `verification[]` | layer=package/runtime_write/full_delivery、target、status=PASS/BLOCKED/NOTRUN/NOT_VERIFIED、exact source/artifact digest、原始日志/evidence；不存在证据不得 PASS |
| `unsupported_targets[]` | 明确 darwin-x64 等未实测目标；不由 architecture-independent 静态 UI 推导后端 PASS |

实际清单 fail-closed：未知字段、重复 components[].id、重复 artifacts[].filename、
重复 (`component`, `target`) 组合、未定义 component 引用、丢失必需组合、未解析占位符/null
source/digest/环境、资产字节 hash 或包内部 identity/source 不符、source drift、缺兼容证据，
均拒绝发布资格。验证中的 NOTRUN/BLOCKED 可以保留为事实，但不能通过必需门槛。
同一 target 在不同组件中重复是合法的，不进行全局 target 去重。
计划和 actual 的独立 kind 避免把例子误认真实发行。

每包内嵌 `awh-build.json`：组件/source/target/Node/lock/closure 与 contract/policy
digest。外部 Manifest 记录**完成 pack 后**的归档字节 digest；内嵌文件不放自身 tarball
digest，避免自引用。`SHA256SUMS` 包含九个归档、安装指南和最终 Manifest 的 hash；
Manifest 不包含自己的 hash，checksums 也不包含自身。发行前完成证据快照后冻结
Release Manifest、SHA256SUMS、九个资产及安装指南；发布后字节保持不变，机器安装、
运行或新增验收均不得原地编辑或替换它们。需要补充发布元数据时，只能以新名称/新
revision、对应新 hash 和明确独立审核另行发布，保留旧事实，不替换原 Manifest、
SHA256SUMS、tag 或资产。

### 独立部署记录

后续部署与验证记录存于仓库外独立的 `deployment-records`（或等价附件），不放入
Release Manifest，也不重算原发行 SHA256SUMS。每条记录以固定 release id/tag、
release source SHA、原 Manifest/SHA256SUMS digest 及 (`component`, `target`, artifact
SHA-256) 为引用，先校验它们与原发行清单一致，再记录脱敏 instance alias、roles
(cp/viewer/client/builder)、OS/CPU/Node、deployed source/build SHA、部署/验证时间、
status 和 evidence。引用不符或缺失即拒绝记录为该 Release 的部署证据。
不得包含 Machine UUID、私有 config、IP/host/key/token。

记录只能追加；纠错新增带旧 record id 的替代记录，保留原记录和替代关系，不覆盖旧事实。
记录可以有自己的 digest/版本，但不能由此改变固定 Release/产物哈希或推定发布、live
或 Full Delivery 权限。计划例子的 `deployment_records_design` 仅描述此外部记录格式，
不是正式 Manifest 字段或真实部署记录；未来实际部署证据按此独立保存。

同轮九个产物初始要求一个 exact clean source；Windows x64、Mac arm64 各自安装锁定
依赖并构建 Node 包，不能复用另一 OS 的 native dependency 闭包。UI 可单次构建，记录
其 build host、源码/contract/input digest，并在两端 Viewer 验证；不默认 hash 可重复。
将来允许 UI/Viewer 不同 source 时，须在 Manifest 明确两者来源及独立兼容测试，重新
Human 审核；本 RC 不靠版本号相同放行不同 source。

## 兼容与历史事实

| 配对 / 历史 | 发布要求 / 当前限制 |
| --- | --- |
| Client 0.4.6 ↔ CP | Protocol 1.0 + SQLite v2；保留 immutable Policy binding、namespace、注册身份、journal 与 sequence/idempotency |
| Viewer ↔ UI | Dashboard 1.0.0 + exact contract hash；启动前匹配 assets provenance；API/DTO validator 不匹配即拒绝，不降级过滤未知事件 |
| Builder ↔ Profile | 内嵌 source/policy digest；固定 selected-set metadata-only 检查及当前单仓库 token；Manifest/config 不授予工作流 |
| #30 | `PHASE_C_ACCEPTED_WITH_EXCEPTION` 原样保留；打包不能改写成无条件 PASS |
| #35 | Windows First Usable Observe-only 历史保留；旧 8 Run/52 Event 重放不算新增回写，更不算 Mac PASS |
| Registry Client version | 既有登记版本可能落后于实际安装 0.4.6；分别展示 observed registry version、installed artifact identity 与 evidence，不自动重注册覆盖历史 |
| #22 / Draft #28 | 未完成独立 Review/两端真实 Deliver；不得列为首版 Full Delivery PASS |
| #34 / B0 | Work Item Observe/Develop 和 Operator/Pairing 仅 offline；不当作新任务 Provider live 权限 |
| 旧文档示例 | `config/README.md` 尚标 Client 0.4.4；安装指南按 actual Manifest，保留旧例子的历史性，不照抄为当前已部署状态 |

## 分层验收与执行顺序

当前所有 R0 候选包级与集成级检查为 `NOTRUN`。源码盘点与 App 身份预检 PASS 只说明
可以准备设计，不填充以下验收。Windows x64 + Mac arm64 是首轮必需硬件。

| 层 / 目标 | 验收动作与记录 | 本阶段状态 / gate |
| --- | --- | --- |
| 包级 / Win x64 | 四 Node 包独立安装→版本/help/offline Doctor→scratch CP init/serve/stop→只读 Viewer + UI→卸载/重装；隔离 DB/可信 fixture | NOTRUN；第二阶段 candidate 制作授权后 |
| 包级 / Mac arm64 | 同上；Node SQLite、路径/权限、Git、外置 App key、verified HTTPS 定向确认 | NOTRUN；必须由 Mac 真实主机执行 |
| Builder 有 key | 精确 metadata-only selected set、单仓库有效 token、actor；只读 live preflight 单独标记 | NOTRUN；外置 key + 明确预检范围，绝不顺带 push |
| Builder 无 key | help/version/离线 Handoff；preflight 明确 BLOCKED，无 user fallback | NOTRUN；不能冒充 App live acceptance |
| 集成 / Windows Future UI | 由候选 Client 新 start/event/finish→唯一中央 CP commit→真实 Dashboard 回读 | NOTRUN；真实注册/Event/会话各需明确 Human Live 授权 |
| 集成 / Mac WebSkill | 同一 Release Client、同一中央 CP；现有授权 verified SAN/CA HTTPS，保全 #147/#160 | NOTRUN；可信配置/网络任一缺失标 BLOCKED |
| 交付 / 每端 | 真 PR/App evidence/confirmed Handoff/独立 Review/Human merge/完成同步 | NOTRUN；独立 Deliver 授权，不由 runtime write 推定 |

两端 CP 本机 smoke 只使用各自独立 scratch DB；禁止两机同时对原生产 SQLite 启写 CP。
Mac localhost scratch 成功不代表 Windows 原库迁移或已接同一 CP。跨机 Client 可经
verified HTTPS 接中央 CP；当前 Viewer exact loopback HTTP 不支持 LAN/Mac 远程浏览器。
中央 Viewer 的受保护页面核对两端数据即可；若要求远程 Mac 打开 Viewer，需要单独的
HTTPS/session host 设计与 live gate，不能去掉现有 loopback/security 限制满足矩阵。

真实回写逐端保存：release/artifact digest、installed source、受控 Work Item、Executor/
Machine（私有验收记录，公开摘要脱敏）、Run ID、新 Event sequence/global cursor、
source SHA、时间和 Dashboard 查询结果。核对同一 CP 的新增提交与 UI 读取，记录其他
项目、原 DB/配置和信任根未覆盖的前后证据；旧历史截图或本地 journal 不算 server commit。

顺序：本设计独立 Review → Human 授权第二阶段最小入口/pack 实现 → 两端候选包级 smoke
→ 分别获得 live 授权后 Windows 再 Mac 真实回写 → 包/源码/跨端证据 independent Review
→ **新的 Human release gate** → 建 tag、GitHub Release、上传资产。npm registry 发布另行授权。

只有两端真实 Runtime Write 证据全齐才可 `RUNTIME_WRITE_ACCEPTED`；只有两端另行授权的
完整 GitHub 交付闭环全齐才可 `FULL_DELIVERY_ACCEPTED`。首轮允许 Observe + Runtime Write
RC，必须明确限制；当前二者均未接受。

Windows/macOS 最终安装指南分别涵盖：verify Manifest/digests → 安装 CP/Viewer → 安装
Client/Builder → 手工选择外置受信配置/project identity → offline Doctor → 获准后网络
Doctor/注册/workflow 上报 → Dashboard 按 Run/cursor 核对。命令应从已验证安装包复现，
不用 checkout/pnpm build。按 Node/arch、import closure、路径/权限、DB/schema/policy、
TLS/SAN/CA、session、identity/scope、Event/cursor、Provider authorization 分别诊断；
禁止自动修配置、换身份、reset 分支、迁移 DB 或降级证书。

## 第一阶段交付和停止点

交付此设计与惰性九资产清单，保留 source links、缺口和全部未验状态，提交一个 docs-only
Draft PR，供独立 Review。第一阶段不制作 RC、不创建 Release/tag、不启停生产 CP/Viewer、
不签新 session、不运行真实 Client 注册/Event/Deliver。完成后停止修改，等待 Human 指定
后续阶段。任何候选 source/bytes 变化都重新核对 Manifest 和相关证据。
