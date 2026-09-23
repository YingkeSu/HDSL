# 测试策略：覆盖需求与风险

不以全仓 100% 行覆盖作为目标。每个 P0 需求必须关联验收场景；每个高风险故障至少有一个真实边界测试。纯转发、样式与生成模板不重复测试实现细节。

## 覆盖矩阵

| 风险/需求 | 层级 | 最小有效证据 |
| --- | --- | --- |
| 契约版本与包络 | 契约 | apiVersion 不完全一致（major 或 minor）被拒且无副作用；包络含 apiVersion；未知字段被拒 |
| 组成锁定与兼容判断 | 单元/契约 | 相同输入稳定输出；拒绝未知 schema/摘要不匹配；跨平台规范化摘要一致；url 不参与摘要 |
| 幂等与未知 ID | 契约 | 相同 requestId/参数返回原结果且不重做副作用（含 ExportResult 摘要）；同 requestId 不同参数 → IDEMPOTENCY_CONFLICT；未知 ID → NOT_FOUND |
| 修订语义 | 契约/集成 | 纯启停不改变 revision、只递增 stateVersion；组成切换递增 revision；过期 expectedRevision 被拒 |
| 两环境串用 | 集成+实机 | 不同版本和数据标记不互相读取 |
| 启停与就绪 | 进程集成 | 真实子进程、占用端口、退出、超时、幂等 stop |
| 事件订阅 | 契约/集成 | 每 operation sequence 递增，多操作订阅按 operationId 分组；unsubscribe 后停止；重连以 operations.get 为准 |
| 事务中断/磁盘满/锁冲突 | 文件集成 | 各提交边界故障注入与进程重启恢复；创建/安装未完成操作可对账 |
| 路径穿越/链接/解压膨胀 | 包集成 | 恶意 fixture 被拒绝且外部目录无改动 |
| 凭据泄漏（受管用户 API 凭据） | 导出/日志集成 | 注入 canary secret 到凭据引用，进程环境按引用解析；所有导出/日志/错误无命中（导出项归 T006） |
| 凭据泄漏（上游生成 secret） | 文件/导出集成 | 确认环境 home 的 `.credentials.yaml` 与 `logs/` 被排除且导出脱敏；不假设上游不落盘；不要求改由 OS store 引用（见 [ADR 0002](../adr/0002-credential-boundary.md)） |
| WebUI 端点 | 进程/UI 集成 | main 原生打开属于当前受管进程的 loopback endpoint；renderer 不接收 token URL；非 loopback/非本进程被拒 |
| 恢复的可变数据边界 | 集成+UI | 旧数据保留，提示新会话不自动合并 |
| 用户主流程 | 少量 E2E | 创建 → 启动 → 停止 → 变更 → 恢复 |
| 跨平台差异 | macOS/Windows 实机 | 路径、权限、锁、rename、进程树、签名与打包 |

## 工具与边界

当前使用 Vitest 测试核心与契约，真实桌面测试通过 Electron 与 CDP 驱动；工具版本由 workspace 依赖锁定。不要为每个 DSH 版本乘上所有插件组合：支持矩阵选受支持边界版本与代表性组合，未知组合明确标识。

CI 包含仓库文档检查，以及 Ubuntu 上的类型检查、构建和默认 Vitest 测试。真实 DSH、凭据和 GUI 场景通过环境变量单独启用，不属于默认 CI；路径、权限、锁、rename 与进程树等平台敏感项由 T008 实机验收，不得用 ubuntu 结果代替 macOS/Windows 结论。当前验收在本机 macOS ARM64 完成；Windows x64 由维护者稍后自行测试，未测前不声称支持、不阻塞 macOS 阶段，见 [ADR 0007](../adr/0007-macos-acceptance-and-internal-distribution.md)。

故障修复增加能复现旧故障的测试；检查通过后没有新变化不反复跑全套。测试替身必须在结果中显式标注，不得把 mock 记作实机证据。

## 运行测试

```bash
pnpm run typecheck
pnpm run build:desktop
pnpm test
python3 scripts/check_repository.py

# 按修改范围运行
pnpm exec vitest run tests/contracts tests/core
pnpm exec vitest run tests/renderer tests/desktop
pnpm exec vitest run tests/integration/install tests/integration/process
```

默认测试也会创建临时文件和测试子进程；真实安装、钥匙串及桌面测试另有启用条件。执行前阅读对应说明：

- [安装集成测试](../../tests/integration/install/README.md)。
- [进程集成测试](../../tests/integration/process/README.md)与[运行时进程测试](../../tests/process/README.md)。
- [桌面 E2E](../../tests/e2e/README.md)：需要可运行 Electron 的桌面环境；真实 DSH 下载需要网络。

跳过的测试不计为通过。历史结果保留在各验证记录中，新提交应记录本次实际执行的结果。
