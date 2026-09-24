HDSL 首个打包体验版：在桌面上管理 DSH 环境、版本与插件。

### 下载

- **Mac（Apple 芯片）**：下载 `mac-arm64.zip`，解压后将 HDSL.app 拖入应用程序。
- **Windows（Intel / AMD 64 位）**：下载 `win-x64-…-portable.zip`，完整解压后打开 HDSL.exe。当前仅供界面预览，不能创建、安装或运行 DSH 环境，尚未经过 Windows 实机使用验收。
- Intel Mac、Windows ARM 与 Linux 暂无支持。

### 你可以做什么

在受支持的 Mac 上创建独立环境，自动安装运行环境，启动与停止 DSH，在浏览器中打开工作界面；发现、安装与移除插件，切换已支持的版本，恢复历史版本与插件组成。

### 使用前

- 这是早期体验版。Mac 未经 Developer ID 签名与公证，Windows 未签名，系统可能拦截打开。仅从本仓库下载并核对 SHA256SUMS.txt；无需关闭全局安全保护。
- 首次安装需要网络；启动前仍需通过 macOS 钥匙串配置 API 密钥，见[使用指南](https://github.com/YingkeSu/HDSL/blob/main/docs/user-guide.md)。
- 受管环境目前仅支持 macOS ARM64，DSH 0.1.5-rc.2 / 0.1.7-rc.1。
- 恢复组成不会回滚文件或会话数据。插件可以访问环境外的文件，请备份重要数据并仅安装可信插件。
- 整合包分享尚未提供。

构建来源见随包发布的 build-info 文件，压缩包校验值见 SHA256SUMS.txt。打包和文件完整性检查不代表所有平台的实际功能都已通过验收。
