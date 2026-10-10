# R0 第二阶段：第一轮候选包实现

关联 #56 / #54。保持 root private、Client 0.4.6、单仓库和原固定政策。
本轮仅候选包及隔离包级验证；独立 Review 后 Mac 才做真实 arm64 验证。
Windows 结果不能替代 Mac；Runtime Write、Full Delivery、发布均未授权。

## 每台主机分别构建

在当前最终 clean source、锁定依赖已安装的开发环境运行：

```text
node scripts/release-pack.mjs --output <new-candidate-directory>
node scripts/release-validate.mjs --candidate <candidate-directory> <exact-source-sha>
node scripts/release-smoke.mjs <candidate-directory>
```

pack 自行从干净 HEAD 编译 TS/UI，并再次核对 HEAD/工作树；不消费陈旧 dist。
仅支持实际构建主机 win32-x64 或 darwin-arm64，不提供跨平台标记覆盖。
新目录要求避免原地替换候选。失败目录保留，修复后使用新的目录和重新验证。
pnpm 仅用于预先安装开发依赖；产物构建直接使用已锁定 tsc/esbuild 和本机 npm，
build_environment.pnpm=not-used，其他工具版本来自实际执行工具。
Windows npm 不保留 POSIX chmod；打包后只将声明的 bin tar header 归一为 0755，
重算 tar header checksum 后再计算归档 digest，不改变 runtime 文件字节。

每个主机输出四个 native-target npm tgz 和一个 UI ZIP；包含 npm 运行依赖的
完整扁平闭包及第三方许可证。导入图从编译 JS AST 检查；未知裸依赖、相对越界、
非字面动态 import、native/optional dependency 未明确处理、同名版本冲突均拒绝。
Builder 实际只有 Node built-ins，不捆绑开发依赖。
awh-build.json 内含文件 digest、source、实际 build host、lock/policy/contract provenance；
无自身或 tarball hash。archive 外的 candidate-index.json 保存实际字节 digest。
CANDIDATE-SHA256SUMS 覆盖五包及 index，既不是最终 SHA256SUMS，也不是发布 Manifest。
构建 index 永远 package_verification=NOTRUN；后续 smoke 追加独立 evidence，不重写 index。

## 离仓 smoke 与 Mac 交接

smoke 使用系统临时目录的空缓存、非 ASCII/空格独立 prefix，npm offline/ignore-scripts，
清理 NODE_PATH/私有 AWH 环境，PATH 只允许 Node 与系统工具。四包安装时不依赖 Hub
node_modules，安装后 help/version、Windows cmd/PowerShell shim 或 Mac Unix executable
逐个验证。Client 离线 Doctor 正确显示安装元数据，并允许缺真实项目/config 的 BLOCKED；
不伪造真实项目 Doctor PASS。Builder 仅 help/version/离线 Handoff，authority=false。

CP 只初始化新 scratch v2 DB，并以 fixture policy/credential 启动、认证 GET capabilities、
关闭。Viewer 只读同一 scratch DB，显式 enable、外置 session digest/配置与抽取的 UI。
验证未授权请求拒绝、可信会话 exchange、受保护 HTML/JS/CSS/REST、写请求拒绝、
源/contract/静态文件匹配、headless 浏览器实际展示、零 page error、页面 JS/storage
不持有 cookie、退出前后 DB 字节不变。最后删除 install/cache 并空缓存重装。
浏览器只用已安装的 Playwright Chromium 或明确 AWH_DASHBOARD_TEST_BROWSER 路径，
不自动下载；截图仅 scratch 空数据库。浏览器缺失则 smoke 阻塞，不能标 UI 展示 PASS。
Windows smoke 的 IPC launcher 只向 installed main 的现有 SIGTERM handler 输送关闭事件；
shim 另行真实运行。不会依靠 Windows kill 强停来证明正常关闭。
临时目录保留供故障调查；只输出脱敏状态，生成的随机 fixture secret 不上传。

Mac 从独立 Review 的同一 exact head 安装本机锁定依赖，再构建 arm64 包并执行 smoke。
不要复制 Windows node_modules 到 Mac。如果两端 UI build bytes 不同，可选择 Windows UI
为统一静态包，在 Mac smoke 指定 `--ui-from <windows-candidate-directory>`。
此时只复用 OS 无关 UI；Mac 后端必须仍由 Mac 构建。两个 UI provenance 必须同 source。

```text
node scripts/release-smoke.mjs <mac-candidate-directory> --ui-from <windows-candidate-directory>
node scripts/release-assemble.mjs --windows <windows-candidate-directory> --macos <mac-candidate-directory> --output <new-frozen-directory>
node scripts/release-validate.mjs --manifest <frozen-directory> <exact-source-sha>
```

assemble 验证真实九个 `(component,target)`、唯一组件 id/filename、相同源码与
lock/policy/contracts；不能以计划、占位 hash 或不完整集合冻结正式 Manifest。
它检查 smoke 引用的真实产物、source/target 和每项检查；无 evidence 保留 NOTRUN。
结构校验通过不代表必需平台验收通过；输出 package_acceptance=false 或 true，与
publishable=false / Human Release Gate NOT_AUTHORIZED 分开。
Windows 第一轮只有五资产，不生成声称九资产齐全的 release-manifest.json。

最终 Manifest 记录组件 identity/version/entrypoint/requirements、实际闭包与 hash、
兼容要求、平台证据和未验边界；SHA256SUMS 覆盖九包、两指南、Manifest 与附属
smoke evidence，不含自身。冻结后不可覆盖；新 head/补验使用新候选 revision，保留
旧目录和 digest。后续机器部署记录外部 append-only，关联固定 release/source、
Manifest/checksums 和产物 hash；不回写冻结字节。

## Viewer 可信 Session Host

默认 OFF，必须 `awh-viewer --enable --config <absolute-external-json>`。
配置仅允许 schema_version=1.0、database、sessions_file、assets、port；所有文件/资产
均须在仓库外、不经 symlink/junction，existing DB 必须 v2。sessions_file 为现有
createViewerAuthenticator 的闭合 session 数组（id/project_ids/session_sha256/expires_at）。
敏感文件 Mac mode 0600；Windows 由 Owner 设置仅本人 ACL。无自动密钥生成/发现。

唯一 cookie 输送接口 POST /dashboard/session 不生成凭据：仅同一 exact loopback
Origin、text/plain body（43–128 base64url，无换行）且匹配预先授权的未过期 secret 才
返回 HttpOnly/SameSite=Strict/Path=/dashboard cookie。必须在本机受信客户端读取
Owner 外置 secret file，避免 secret 出现在 URL、命令行、stdout、浏览器 JS 或日志。
没有匿名 session、public login 页面、Client bearer 兑换或 Operator API。
普通浏览器可由 Owner 受信的本机 host 集成输送 cookie；本轮 curl cookie jar 只用于包级
验收，不自动向生产浏览器植入 session。HTTP 只绑定 127.0.0.1，不声称支持 Mac LAN viewer。

其余安装与故障分类见两端指南。现有 #30 exception / #35 observe-only、#22 Draft、
Onboarding offline fixture 的历史结论不变。无模型调用，无现存生产 DB/Client/Provider 操作。
