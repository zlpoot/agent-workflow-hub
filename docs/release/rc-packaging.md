# R0 第二阶段：一次构建、双端包级验证

关联 #56 / #54。2026-10-10 Owner 修订取代旧九资产/双端 native build，旧 revision 原样保留。
保持 root private、Client 0.4.6、单仓库和固定政策。Windows 的结果不代表 Mac；
Mac 验证由 Owner 手动完成，缺证据为 NOTRUN。PR #57 继续 Draft，新 head 需独立 Review。

## 生成一个候选

在最终 exact clean source 的锁定开发依赖环境，仅在 Windows 构建一次：

~~~text
node scripts/release-pack.mjs --output <new-build-directory>
node scripts/release-validate.mjs --candidate <build-directory> <exact-source-sha>
node scripts/release-assemble.mjs --candidate <build-directory> --output <new-frozen-directory>
node scripts/release-kit.mjs --output <new-smoke-kit-directory>
node scripts/release-validate.mjs --manifest <frozen-directory> <exact-source-sha>
node scripts/release-smoke.mjs <frozen-directory>
node scripts/release-validate.mjs --manifest <frozen-directory> <exact-source-sha>
~~~

pack 从 clean HEAD 编译 TS/UI，不消费陈旧 dist，前后重新核对 source/工作树。
生成四个 target=universal Node tgz 和一个 static ZIP；实际 build_environment 如实记录
Windows x64、Node/npm/tsc/esbuild，pnpm=not-used。不提供平台伪装或源码 SHA 覆盖。
npm Windows tar bin header 规范成 0755，最终 hash 在规范后计算，内容字节不变。
源码/依赖/协议/policy/contracts provenance 与完整文件 SHA 内嵌 awh-build.json，
不含自身或归档 digest。归档 digest 在外部 index/Manifest。完整 runtime dependencies
从本机锁定依赖复制为扁平闭包，仅 JS/JSON/文档，包含第三方许可证，无开发依赖。
校验器拒绝 native 扩展、ELF/PE/Mach-O bytes、依赖 os/cpu/生命周期/optional 限制、
非字面动态 import/require、缺失/越界相对导入与未声明裸依赖。构建工具平台性质不进入运行闭包。
AJV 的 opt-in RE2 adapter 需要未安装的 native addon，AWH 固定 validators 不使用它；
只从发行闭包排除这四个 adapter JS/type/source/map 文件及依赖开发测试/工具配置。
保留模块如仍引用缺失 adapter，会被闭包校验拒绝，不把 RE2 作为可用功能分发。

assemble 只消费同一份五资产 candidate；从同 source 指南冻结唯一 Manifest/SHA256SUMS，
不构建第二端、不变更包字节。Manifest verification 为冻结时两端 NOTRUN/null 快照。
SHA256SUMS 覆盖五包、两指南、Manifest，后续 Smoke/截图保持外部追加，不重算它。
所有生成器要求新目录；失败候选和旧证据保留，不原地覆盖。

## Mac 手动复制与独立 Smoke kit

将整个 frozen-directory 和独立 smoke-kit-directory 复制/下载到 Mac 的新外置目录。
先对照 PR 中可信传输归档 SHA，再核对内部资产 SHA。只传候选/kit，不传 node_modules、
任何 PEM/token/config/SQLite 或用户浏览器资料。Mac 不运行 release-pack/assemble，不重建包。

运行组件只需要本机 arm64 Node >=24/npm。Smoke kit 中 TypeScript 5.9.3 负责归档/AST
核验，Playwright 1.62.1 负责浏览器展示，是验证辅助，绝非运行包依赖或第六组件。
辅助依赖可先联网装入 kit 自己目录；候选包安装始终使用独立空缓存 offline，互不复用。
kit.json 记录所有 helper 文件 source/digest。Kit 不需要 Hub clone 或 pnpm。

~~~sh
# 一次性仅安装 kit 的辅助依赖；不运行安装脚本，不下载浏览器
npm install --prefix "<smoke-kit>" --ignore-scripts --no-audit --no-fund
export AWH_DASHBOARD_TEST_BROWSER="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
node "<smoke-kit>/release-validate.mjs" --manifest "<frozen-directory>" <exact-source-sha>
node "<smoke-kit>/release-smoke.mjs" "<frozen-directory>"
node "<smoke-kit>/release-validate.mjs" --manifest "<frozen-directory>" <exact-source-sha>
~~~

使用已有本机 Chrome/Chromium 或已安装 Playwright Chromium；缺浏览器则 BLOCKED，
不自动下载。Smoke 使用全新临时浏览器 context，无现有 profile。手工安装命令见两端指南。
将 Mac 新增的 package-smoke-darwin-arm64.json、平台截图、命令退出码和原始 stdout/stderr
返回 Owner/Reviewer；五包 SHA 必须与 Windows evidence 完全一致，不能只比较版本号。

## 包级测试与证据语义

同一 Smoke 工具从真实 process.platform/arch 选择 win32-x64 或 darwin-arm64，不接受 target 覆盖。
临时系统目录使用空格/非 ASCII prefix，npm offline/ignore-scripts，清理 NODE_PATH/私有 AWH
环境，PATH 仅允许 Node 与系统工具。四包不依赖 checkout、父目录 node_modules 或 pnpm。
验证 help/version、Windows cmd/PowerShell shim 或 Unix executable/shebang、Client offline Doctor，
Builder 只读 Handoff，authority=false。Doctor 缺真实项目/config 的 BLOCKED 是预期结果。
CP 只显式 init 新 scratch v2 DB、认证 GET capabilities 并正常关闭；Viewer 默认 OFF，
显式外置 session/config/UI，只读同一 scratch DB。检查受保护 HTML/JS/CSS/REST、拒绝写入、
实际 headless UI 展示和零 JS error、无浏览器 JS/storage 秘密、退出前后 DB 字节不变。
最后仅删除本次 scratch install/cache 并空缓存重装；保留 scratch 供诊断。

每端只新增 package-smoke-<actual-platform>.json 与各自截图，不替换另一端证据。
PASS 需要七项 checks、实际环境和相同五包 source/hash；失败记录 BLOCKED 和已通过项，
退出非零。已有结果绝不覆盖，失败重试使用新目录复制，旧记录注明替代关系。
release-validate --manifest 同时返回独立的 NOTRUN/PASS/BLOCKED。双端 PASS 只使
package_acceptance=true，publishable=false、authority_verified=false 和 Release Gate 不变。
Runtime Write/Full Delivery 未验收，不运行真实项目、现存 CP/SQLite/session/Provider/模型。

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
