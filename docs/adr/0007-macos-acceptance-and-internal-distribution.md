# 0007：本机 macOS 验收、插件候选与内测分发

- 日期：2026-09-23；状态：accepted（维护者明确决定）。
- 基线：`b8a1aca42fefb2570f6a956d81a4dbd655d4f3a6`。
- 承接：[MVP](../product/mvp.md)、[路线图](../development/roadmap.md)、ADR 0005/0006。
- 取代原 MVP/路线图中“Windows 实机验收是当前 macOS 后续阶段的硬依赖”的要求；不改写历史测试结果。

## 决策

1. **当前在本机 macOS ARM64 完成测试即可**。Windows 由维护者稍后自行测试，继续标为未测；T008b 不阻塞当前 macOS 稳定性、整合包和内测准备。Windows 的运行时适配、目录组合与实机验收仍需完成后才可声明支持。
2. **验收候选允许自主检索 GitHub stars 严格大于 5,000 的插件**。记录查询时间、stars、精确 commit、manifest 与产物摘要，并核对 DSH 插件入口、依赖、许可及安装期脚本。stars 仅为候选筛选条件；原有精确授权、来源完整性和卸载服务依赖核验不因 stars 放宽。无法安装、未知服务依赖导致拒绝卸载等都应记录为真实结果。
3. **先完成稳定性与真实桌面验收，再进入整合包**。优先有界诊断 #88 退出/租约观察，补齐当前 macOS 主流程证据、真实插件验收和契约/文档收尾；不以历史合入或单元测试代替本次桌面验收。
4. **采用 PCL 官方同款分发有限许可的 HDSL 适配版**，权威全文为根目录 [LICENSE](../../LICENSE)。这是自定义有限许可，不标为 MIT、GPL 或 OSI 开源许可。第三方代码仍遵循各自许可。PCL 特有用户协议、Minecraft 功能限制与非法律性质的合理使用指南不直接移植到 HDSL。
5. **发布方式为 macOS 内测分发，不上 App Store**。维护者随后修正了原“签名公测”选择；Developer ID 签名和 Apple 公证不再是本轮内测门槛。内测包必须明确未签名/未公证状态与适用平台，验证解包、首次启动和主流程；不修改系统 Gatekeeper 全局设置。

## 来源与实现边界

- PCL 官方仓库原 `Hex-Dragon/PCL2` 重定向至 `Meloong-Git/PCL`。[核验提交](https://github.com/Meloong-Git/PCL/blob/8f7686457443e790670ee22157d98eee8ca2e20c/LICENCE) 指向[官方法律声明](https://shimo.im/docs/rGrd8pY8xWkt6ryW#anchor-X0bo)，已读取“PCL 分发有限许可”全文。只适配名称、权利主体及日期，不复制 PCL 公司身份。
- Apple：[Developer ID](https://developer.apple.com/developer-id/)、[公证流程](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)。
- 本机 `security find-identity -v -p codesigning` 返回 `0 valid identities found`（2026-09-23）。当前内测不依赖该身份。若后续改为 Developer ID 分发，再由维护者配置签名及公证凭据；不导出私钥，不写入仓库。
- GitHub 旧父任务中的双平台依赖是历史要求；当前执行范围按本 ADR 与更新后的本地规格。任务平台范围改变不自动关闭旧 Issue，也不代表缺口已验收。

## 验证状态

决策与来源已核验；本 ADR 不声明稳定性、第三方插件、整合包或内测分发已经完成。执行证据分别落在开发验证记录。
