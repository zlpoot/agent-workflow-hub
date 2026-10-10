# macOS arm64 候选包安装与待执行验证

本指南不是 Mac PASS。Mac mini 实机须从独立 Review 的 exact source 构建自己的依赖
和四个 arm64 包；Windows node_modules 不可复制。Node.js >=24 arm64 + npm，项目
操作另需 Git。Intel x64/其他目标 NOT_VERIFIED。无 tag/Release/npm 发布授权。

核对可信候选 index / CANDIDATE-SHA256SUMS，或最终九资产 Manifest / SHA256SUMS；
`shasum -a 256 <artifact>` 与可信 digest 对照，再离仓安装：

```sh
npm install --prefix "<external-prefix>" --cache "<new-empty-cache>" --offline --ignore-scripts --no-audit --no-fund "<candidate>/awh-control-plane-0.1.0-rc.1-darwin-arm64.tgz" "<candidate>/awh-viewer-0.1.0-rc.1-darwin-arm64.tgz" "<candidate>/awh-client-0.4.6-darwin-arm64.tgz" "<candidate>/awh-builder-0.1.0-rc.1-darwin-arm64.tgz"
unzip "<candidate>/awh-dashboard-ui-0.1.0-rc.1-static.zip" -d "<external-ui>"
"<external-prefix>/node_modules/.bin/awh-control-plane" --help
"<external-prefix>/node_modules/.bin/awh-viewer" --help
"<external-prefix>/node_modules/.bin/awh" --version
"<external-prefix>/node_modules/.bin/awh-builder" --version
```

离线空缓存必须无 registry fallback。验证 npm Unix symlink/shebang/executable、空格/非
ASCII 路径、本机 Node SQLite、正常退出、删除本次 prefix 后重装。实际证据使用
release-smoke.mjs，统一 UI 可通过 --ui-from 选择；不能更改已有 smoke/Manifest 字节。

CP 只对 Mac 新 scratch v2 DB 做 init/serve。正常配置全部仓库外、显式绝对路径，无
symlink；Mac secret/session file mode 0600，目录 owner-only。Viewer 默认 OFF，
需要 --enable --config，配置同 Windows，验证 UI source/contract 和真实文件 hash。
受信 host 使用 Owner 预配 secret exchange 到 HttpOnly cookie；无匿名发凭据。
退出用 Ctrl+C。Builder 无 key 仅 help/version/离线校验，不用用户 gh 身份代替 App。

实际 WebSkill/Future UI 项目接入尚未授权；不要改 WebSkill #147/#160 或真实项目 config。
候选 Client 离线 Doctor 不访问 CP。后续单独授权真实 Run/Event 时，Mac 必须连接
Windows 同一中央 CP 的已有受信 HTTPS，验证真实 SAN/CA；Mac localhost scratch 不算
中央迁移成功。现有 Viewer 只 exact loopback，Mac 远程浏览器不被支持。

卸载只处理本次外置安装目录，不删 state/config/Machine identity。故障分类与 Windows
指南一致；绝不以 force、放宽证书、第二生产 writer 或自动 Provider 写入绕过阻塞。
