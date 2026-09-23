# 开发路线图

当前已实现环境创建、受管安装、进程启停、桌面主界面及 macOS 插件 MVP（发现、安装、卸载保护、构建授权、代际组成恢复）。受管运行时目录仅包含 macOS ARM64；完整桌面验收、跨 DSH 版本升级、整合包与内测分发仍有后续工作。

2026-09-23 维护者决策见 [ADR 0007](../adr/0007-macos-acceptance-and-internal-distribution.md)：本机 macOS 完成当前测试；Windows 由维护者稍后自行测试，不再阻塞 macOS 阶段。

| 阶段 | 内容 | 依赖 | 完成门槛 |
| --- | --- | --- | --- |
| M0 证据 | 上游 DSH 参数、版本矩阵、隔离能力、授权核验 | 无 | research R001–R004 可追溯（见 [上游兼容性](../research/dsh-compatibility.md)）；R005/R006 只记录已知边界 |
| M1 环境闭环 | 001 创建、安装、启停、状态、错误 | M0（硬前置仅 R001–R004） | 两环境真实隔离；本机 macOS ARM64 实机证据；Windows 延后由维护者验证 |
| M2 事务与插件 | 002 变更预览、插件增减、代际升级与恢复 | M1 | 每个提交边界故障注入可恢复 |
| M3 整合包 | 003 Schema、导入导出、精确重建 | M2 | 无凭据泄漏、拒绝恶意包、重建成功 |
| M4 发布验证 | macOS 内测打包与用户验收（不上 App Store） | M1–M3（macOS） | MVP 门槛、内测包及明确支持矩阵 |
| M5 社区 | 讨论与反馈验证 → Registry/论坛 | M4 与真实分享需求 | 不可变发布、审核/撤销与身份方案 |
| M6 小程序 | 发现、收藏、分享码 | M5 | 官方接入核验与最小闭环 |

M0 的证据门槛为 R001–R004。R005（插件/bundle 锁版本与隔离安装）与 R006（升级迁移与恢复边界）在 T001 只记录已知边界，其实现与真实迁移/恢复实验随 M2（[#9](https://github.com/YingkeSu/HDSL/issues/9)）细化，不阻塞 M1。M1 已有实现与部分 macOS 实机记录；完整发布门槛仍需逐项验证。Windows 未测事实保留，按 ADR 0007 独立跟踪。

## 下一步

1. 有界复现并处理 #88 Electron 退出/租约观察，补齐 T006/T007/T008a 当前 macOS 桌面证据；不把测试清理时的 SIGKILL 计作正常退出。
2. 自主搜索 GitHub stars > 5,000 的真实 DSH 插件；核验精确 commit、入口、脚本、许可与服务依赖后执行验收，记录成功与受控拒绝。stars 不替代安全或兼容核验。
3. 收尾契约版本标签、错误分类和过时文档；插件受限范围以 #73 最终验收记录与实现为准。
4. 稳定性与桌面验收收尾后，补整合包规格和实施计划，验证本机独立数据目录之间的导出/导入/重建；跨机结果仍单列未测。
5. 达到 MVP 门槛后制作 macOS 内测包，不上 App Store；签名与公证不作为当前门槛。Windows 由维护者稍后自行测试，不在此序列中等待。

## 待决定/验证

- 已定：自有内容采用 [HDSL 分发有限许可](../../LICENSE)（PCL 同款适配），发布方式为内测分发。
- 扩充 DSH/Node 支持矩阵和平台最低版本；已验证来源与摘要见[上游研究](../research/dsh-compatibility.md)。
- 无法完整隔离时允许的功能范围。
- Electron 资源与启动性能预算和内测打包实现；签名身份仅在后续决定签名分发时配置。
- 整合包 v1 Schema 与插件来源信任策略。
- 论坛/小程序需求真实性、平台准入与内容治理成本。

GitHub Issues 将保存阶段任务，文档保留稳定的需求/任务 ID；外部 PR 同样进入分诊，但协作者开发中的 PR 不混入需求队列。

## 当前任务状态

2026-09-23 核对基线 `b8a1aca`：T001–T005 已合入；T006/T007/T008 仍在收尾。macOS 插件 MVP #73 及 #74–#79 已关闭，#9 整体仍未完成；#88 退出观察、#95 GitHub 403 分类精度与契约 1.1 标签仍待收尾。既有子集验收不代表任意第三方插件可无损卸载或全部运行期生效等价性已证。

## GitHub 任务索引

| ID | GitHub Issue | 依赖 |
| --- | --- | --- |
| T001 | [#1 核验 DSH 上游接口与最小支持矩阵](https://github.com/YingkeSu/HDSL/issues/1) | 无 |
| T002 | [#2 建立 TypeScript 桌面 workspace 与工程 CI](https://github.com/YingkeSu/HDSL/issues/2) | T001 |
| T003 | [#3 实现本地契约与边界输入校验](https://github.com/YingkeSu/HDSL/issues/3) | T002 |
| T003.1 | 属 T003 交付物：契约冻结与版本标签 | T003 |
| T004 | [#4 实现受管安装与隔离环境创建](https://github.com/YingkeSu/HDSL/issues/4) | T003 |
| T005 | [#5 实现真实 DSH 启停与进程所有权管理](https://github.com/YingkeSu/HDSL/issues/5) | T004 |
| T006 | [#6 实现简洁环境界面与脱敏诊断](https://github.com/YingkeSu/HDSL/issues/6) | T005 |
| T007 | [#7 补齐首条切片的集成与主流程验收](https://github.com/YingkeSu/HDSL/issues/7) | T006 |
| T008a | [#8 记录 macOS ARM64 实机验证](https://github.com/YingkeSu/HDSL/issues/8) | T007 |
| T008b | [#8 记录 Windows x64 实机验证（维护者稍后自行测试）](https://github.com/YingkeSu/HDSL/issues/8) | T007 / Windows 适配 / 维护者主机；不阻塞 macOS |
| M2 | [#9 设计并实现插件事务、升级与代际恢复](https://github.com/YingkeSu/HDSL/issues/9) | T008a；Windows 分支另依赖 T008b |
| M3 | [#10 设计并实现整合包导入导出与精确重建](https://github.com/YingkeSu/HDSL/issues/10) | M2 |
| M4 | [#11 完成 MVP 打包、发布策略与用户验收](https://github.com/YingkeSu/HDSL/issues/11) | M3 |
| M5 | [#12 验证社区需求并设计论坛与 Registry](https://github.com/YingkeSu/HDSL/issues/12) | M4 |
| M6 | [#13 核验微信小程序接入并设计发现分享流程](https://github.com/YingkeSu/HDSL/issues/13) | M5 |
