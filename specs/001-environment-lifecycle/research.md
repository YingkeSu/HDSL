# 上游验证计划

状态：R001–R004 已执行并留证（2026-09-20，macOS ARM64）；R005/R006 记入已知边界并标注属 M2，不在 M1 完成条件内。证据正文见 [docs/research/dsh-compatibility.md](../../docs/research/dsh-compatibility.md)，复现脚本见 [scripts/research/](../../scripts/research/)。

M1 硬前置仅 R001–R004。R001–R004 完成不等于 T002 可以跳过契约冻结；T002 仍依赖契约（T003）与本文档的证据。

| 编号 | 必须回答的问题 | 证据/完成标准 | 状态与证据 |
| --- | --- | --- | --- |
| R001 | DSH 官方仓库、发布来源和许可证是什么？ | 官方 URL、commit/tag、授权范围，下载验证方式 | 完成：`deepseek-ai/deepseek-harness`，MIT；候选 `@deepseek-ai/dsh@0.1.5-rc.2`，tag `dsh-v0.1.5-rc.2` = `fb2c4b9…`；tarball SHA-256 已复核；无 npm provenance |
| R002 | 支持哪些 Node/OS/arch？ | 固定两个候选组合，CLI help 与安装日志 | 完成（macOS ARM64）：A = DSH 0.1.5-rc.2 + Node 22.19.0；B = 0.1.5-rc.2 + Node 24.21.0；另 25.6.1/26.8.1 通过。rc.2 tag `engines.node = ^22.19.0 \|\| >=24.0.0`。Windows x64 未测 |
| R003 | 哪些参数决定 profile、配置、插件、会话和 home？ | 两环境标记实验，监测宿主默认目录是否被写入 | 完成：`DSH_HOME` > `~/.dsh`（空白视为未设置）；profile/bundle/patch 参数已核实；两环境互不串用、宿主 `~/.dsh` 不变；`.credentials.yaml`(0600, Web grant) 复现；`profiles/node_modules` 为安装目录 symlink 回退，DSH_HOME 非自包含 |
| R004 | 如何启动 WebUI、检测就绪并停止进程树？ | 真实命令、loopback 绑定、端口冲突、超时、终止证据 | 完成：就绪行 `dsh web: http://127.0.0.1:<port>/?token=…`；仅 loopback；`SIGTERM` exit 0 且端口释放；`EADDRINUSE` 第二实例 exit 1；`--host 0.0.0.0` exit 1；单进程无子进程；rc.2 启动失败未生成 `logs/` |
| R005 | 插件/bundle 能否锁版本并隔离安装？ | 原生命令、依赖解析、安装脚本行为及现有限制 | **M2 范围**：rc.2 实测 `dsh plugin … add` 转发 pnpm、profile 级 `pnpm-lock.yaml` 与 `dsh.profile.bundles` 对账；精确版本锁 + integrity；裸 add 会装到旧版；profile 级隔离非 OS 沙箱。细节见兼容性文档，不在 M1 验收 |
| R006 | 升级是否迁移可变数据？ | 备份、迁移、恢复实验；支持与拒绝边界 | **M2 范围**：rc.2/alpha.2 `SESSION_FORMAT_VERSION = 3`；相邻版本链迁移、只写最终代际、fail-closed、不保证降级、无内置备份；rc.2↔alpha.2 同一 home 非 session 文件内容不变。真实 session 迁移未复现 |

完成即停：最小支持矩阵与适配契约已记录（见兼容性文档“结论摘要/最小支持矩阵”）；未验证项按平台与版本如实标注。禁止在未验证前编写“兼容所有版本”的实现。

后续 M2 验证边界：R005/R006 的实现与真实 session 迁移/恢复实验随 M2（issue #9）细化；在 M2 规格建立前，不得据本文档实现插件事务或升级恢复。Windows x64 实机验证归 T008b，拿到主机前保持未测。
