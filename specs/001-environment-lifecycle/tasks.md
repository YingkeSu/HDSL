# Tasks: 受管环境创建与启动

状态：全部未实施。初始化文档不计为业务任务完成；GitHub 跟踪入口见 [路线图](../../docs/development/roadmap.md)。本清单是实施前规格修订，不授权绕过 T001 开始业务工程。

## Phase 0 — 证据门槛

- [ ] T001 在 docs/research/dsh-compatibility.md 记录 R001–R004 的上游证据与最小支持矩阵；R005/R006 只记录当前已知边界并注明属 M2。完成条件：最小可支持组合有真实命令和结果，或明确不可行项及范围调整；不得用未执行的 R005/R006 阻塞 M1。文件所有权：docs/research/dsh-compatibility.md、specs/001-environment-lifecycle/research.md（本任务不修改 tasks/contracts/data-model）。

## Phase 1 — 工程与契约（依赖 T001 的 R001–R004）

- [ ] T002 建立 apps/desktop、packages/core、packages/runtime、packages/contracts 的 workspace，锁依赖版本，增加类型/构建/单元测试 CI。CI 平台范围仅 lint/type/unit（现有 ubuntu workflow）；路径/权限/锁/rename/进程树等平台敏感集成归 T008 实机，不在 T002 声明通过。完成条件：干净检出可安装并通过检查，不引入虚假业务功能。文件所有权：apps/desktop、packages/*、根工具配置、.github/workflows。
- [ ] T003 在 packages/contracts/src 定义并校验 [contracts/local-api.md](contracts/local-api.md)：共享 DTO（RuntimeCombination、EnvironmentSummary、OperationSnapshot、SubscriptionRef、ExportResult）、`API_VERSION` 与包络版本比对、幂等/未知 ID/平台不支持/版本不匹配错误码、事件订阅/退订。产出「方法 × 合法/非法 fixture × 期望错误码」表并打契约版本标签。完成条件：renderer 和 main 使用同一契约，合法输入通过、未知字段/非法 ID/错误修订/冲突 requestId 被拒绝且秘密不出现在错误中。文件所有权：packages/contracts/src。
- [ ] T003.1（T003 内交付物，不新增业务任务）冻结契约后供 T004–T008 依赖；此后契约字段/错误码变更须新版本并同步本文件与 data-model。

## Phase 2 — US1

- [ ] T004 在 packages/core/src 与 packages/runtime/src/{catalog,install,composition} 实现环境创建、受管产物安装、精确锁定、compositionDigest 规范化及失败记录。完成条件：两个隔离环境和损坏下载测试通过，宿主默认目录无改动；相同语义组成跨平台摘要稳定；磁盘不足有终态。文件所有权：packages/core/src/**、packages/runtime/src/{catalog,install,composition}/**。

## Phase 3 — US2

- [ ] T005 在 packages/runtime/src/{process,reconcile,credentials} 实现真实 DSH 启停、就绪、端口冲突处理、进程所有权跟踪、重启 reconciliation，以及凭据引用解析与显式进程环境注入。完成条件：重复启动、端口冲突、异常退出、停止进程树场景通过；无 OS 凭据引用时启动失败且错误不含值；上游生成的 `.credentials.yaml` 与日志不进入导出/普通日志。文件所有权：packages/runtime/src/{process,reconcile,credentials}/**。

## Phase 4 — US3 与 UI

- [ ] T006 在 apps/desktop/src 实现列表、创建、启动/停止、进度和脱敏错误，以及 main 原生打开 WebUI。完成条件：可通过 UI 完成主旅程；WebUI 仅打开属于当前受管进程的已验证 loopback endpoint，renderer 不接收携带 token 的 URL；DSH 页面无法触达高权限 IPC，且给出可复现验证方法（系统浏览器打开 + 断言 preload 缺席 / nodeIntegration 关闭）；导出诊断不含 canary secret。文件所有权：apps/desktop/src/{main,preload,renderer}/**。

## Phase 5 — 验证

- [ ] T007 在 tests/integration/{install,process} 与 tests/e2e 验证 spec 全部 FR 和风险场景。完成条件：产出 FR-001..FR-008 → 用例 ID 映射表与真实执行结果；真实文件与进程边界覆盖隔离、冲突、超时、重启、秘密；不把 mock 结果视为实机结果。文件所有权：tests/integration/install/**、tests/integration/process/**、tests/e2e/**、docs/development/testing.md。
- [ ] T008a 在 docs/development/validation-001.md 记录 macOS ARM64 的真实验收与缺口（本机可执行）。完成条件：每项明确通过/失败/未测，不将 mock 结果标作实机支持。依赖 T007。
- [ ] T008b 在 docs/development/validation-001.md 记录 Windows x64 的真实验收与缺口。依赖外部 Windows x64 主机与 T007；在拿到主机前保持 needs-info/ready-for-human，标记未测，不声称支持。文件所有权：docs/development/validation-001.md。

## 执行纪律

按依赖推进，阻塞时报告具体证据。多 agent 分工时按上表子目录所有权切分并记录基线 SHA，禁止覆盖其他人的实现；此任务清单本身不授权自动并行派发。PR 开出且要求的检查通过后报告停止；无 checks 时报告无 CI，不改 Actions 设置，不 close/reopen PR，不合并。只有编排者（hdsl-2）可派发并发会话。
