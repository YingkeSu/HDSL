# 开发路线图

所有业务阶段均未开始。当前完成仓库、Spec Kit 与开发基线；首版不是只有 001。

| 阶段 | 内容 | 依赖 | 完成门槛 |
| --- | --- | --- | --- |
| M0 证据 | 上游 DSH 参数、版本矩阵、隔离能力、授权核验 | 无 | research R001–R004 可追溯（见 [上游兼容性](../research/dsh-compatibility.md)）；R005/R006 只记录已知边界 |
| M1 环境闭环 | 001 创建、安装、启停、状态、错误 | M0（硬前置仅 R001–R004） | 两环境真实隔离；macOS ARM64 与 Windows x64 分别留下实机证据，未测平台保持未测 |
| M2 事务与插件 | 002 变更预览、插件增减、代际升级与恢复 | M1 | 每个提交边界故障注入可恢复 |
| M3 整合包 | 003 Schema、导入导出、精确重建 | M2 | 无凭据泄漏、拒绝恶意包、重建成功 |
| M4 发布验证 | 打包、签名/更新研究、用户可用性验收 | M1–M3 | MVP 门槛及明确支持矩阵 |
| M5 社区 | 讨论与反馈验证 → Registry/论坛 | M4 与真实分享需求 | 不可变发布、审核/撤销与身份方案 |
| M6 小程序 | 发现、收藏、分享码 | M5 | 官方接入核验与最小闭环 |

M0 的证据门槛为 R001–R004。R005（插件/bundle 锁版本与隔离安装）与 R006（升级迁移与恢复边界）在 T001 只记录已知边界，其实现与真实迁移/恢复实验随 M2（[#9](https://github.com/YingkeSu/HDSL/issues/9)）细化，不阻塞 M1。当前 M1 尚未实现，本文档不声称任何业务阶段完成。

## 下一步

先完成 [T001](../../specs/001-environment-lifecycle/tasks.md)，不要提前把不明确的 DSH 接口写死。然后建立工程 workspace 并按首条纵向切片交付。002/003 在前置证据明确后用 Spec Kit 单独写 spec/plan/tasks，避免一个巨大需求文档冒充所有功能的可执行规格。

## 待决定/验证

- HDSL 自有内容许可证与正式发布政策。
- DSH/Node 精确支持版本、平台最低版本、安装可信来源。
- 无法完整隔离时允许的功能范围。
- Electron 资源与启动性能预算、打包与签名策略。
- 整合包 v1 Schema 与插件来源信任策略。
- 论坛/小程序需求真实性、平台准入与内容治理成本。

GitHub Issues 将保存阶段任务，文档保留稳定的需求/任务 ID；外部 PR 同样进入分诊，但协作者开发中的 PR 不混入需求队列。

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
| T008b | [#8 记录 Windows x64 实机验证（外部主机，未测前保持未测）](https://github.com/YingkeSu/HDSL/issues/8) | T007 / 外部 Windows 主机 |
| M2 | [#9 设计并实现插件事务、升级与代际恢复](https://github.com/YingkeSu/HDSL/issues/9) | T008a/T008b |
| M3 | [#10 设计并实现整合包导入导出与精确重建](https://github.com/YingkeSu/HDSL/issues/10) | M2 |
| M4 | [#11 完成 MVP 打包、发布策略与用户验收](https://github.com/YingkeSu/HDSL/issues/11) | M3 |
| M5 | [#12 验证社区需求并设计论坛与 Registry](https://github.com/YingkeSu/HDSL/issues/12) | M4 |
| M6 | [#13 核验微信小程序接入并设计发现分享流程](https://github.com/YingkeSu/HDSL/issues/13) | M5 |
