# 体验版发布

产物只上传 GitHub Releases；`dist/`、`release/`、应用包及增量编译缓存均不提交。

1. 同步更新根目录与所有 workspace 的 `package.json` 版本和 `docs/releases/preview-notes.md`。
2. 参考已有检查与平台验收证据，按本次变更和维护者要求决定是否补充检查；发布工作流只负责打包，不重复运行测试套件。
3. 推送代码后，在检查通过的提交上创建与应用版本一致的 `v<version>` 标签并推送。
4. `Release preview` 工作流先核对标签版本，再分别构建 macOS ARM64 与 Windows x64；完整性检查和 SHA-256 校验成功后，才创建 GitHub prerelease 并附上 macOS `.dmg`（主分发格式）、macOS 备用 `.zip`、Windows 归档与校验值、构建来源。

本机 Mac 打包（未签名/未公证）：`pnpm run build:desktop && pnpm --filter @hdsl/desktop run package:mac`。`build.mac` 同时声明 `dir` 与 `dmg` 两个 ARM64 目标：输出 `apps/desktop/release/mac-arm64/HDSL.app`（结构校验与诊断用）与正式分发主格式 `apps/desktop/release/HDSL-<version>-mac-arm64.dmg`。文件核验：`node apps/desktop/scripts/verify-mac-package.mjs apps/desktop/release/mac-arm64/HDSL.app`。

DMG 挂载与版式核验（只读、临时挂载点，结束自动卸载）：`node apps/desktop/scripts/verify-mac-dmg.mjs apps/desktop/release/HDSL-<version>-mac-arm64.dmg`。它校验映像可挂载、包含完整 `HDSL.app` 与指向 `/Applications` 的拖拽链接，并干净卸载；不启动应用、不读写真实用户 profile。DMG 未签名、未公证（[ADR 0007](../adr/0007-macos-acceptance-and-internal-distribution.md)），不配置 Developer ID 凭据。

Windows 构建沿用[便携构建说明](windows-portable-build.md)。其构建工作流不运行应用；发布工作流在两平台产物齐备后负责上传 Release。Windows 实机验收保持未测。

生产启动入口解析真实宿主平台并传入 core/runtime。不支持的平台在下载前拒绝创建和切换环境，不再默认为 macOS ARM64。该边界由平台与桌面接线测试覆盖。

Mac 成品启动检查：`node apps/desktop/scripts/smoke-electron.mjs --executable "$PWD/apps/desktop/release/mac-arm64/HDSL.app/Contents/MacOS/HDSL"`。它使用临时数据目录核验真实窗口、渲染内容与 preload 安全边界；不创建 DSH 环境，清理时终止进程，不作为正常退出验收。
