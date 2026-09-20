# Tasks: 受管环境创建与启动

状态：全部未实施。初始化文档不计为业务任务完成；GitHub 跟踪入口见 [路线图](../../docs/development/roadmap.md)。

## Phase 0 — 证据门槛

- [ ] T001 在 docs/research/dsh-compatibility.md 记录 R001–R006 上游证据、支持矩阵与适配边界。完成条件：最小可支持组合有真实命令和结果，或明确不可行项及范围调整。

## Phase 1 — 工程与契约（依赖 T001）

- [ ] T002 建立 apps/desktop、packages/core、packages/runtime、packages/contracts 的 workspace，锁依赖版本，增加类型/构建/测试 CI。完成条件：干净检出可安装并通过检查，不引入虚假业务功能。
- [ ] T003 在 packages/contracts/src 定义并校验 contracts/local-api.md，建立合法/非法输入测试；依赖 T002。完成条件：renderer 和 main 使用同一契约，非法输入被拒绝。

## Phase 2 — US1

- [ ] T004 在 packages/core/src 与 packages/runtime/src 实现环境创建、受管产物安装、精确锁定及失败记录；依赖 T003。完成条件：两个隔离环境和损坏下载测试通过，宿主默认目录无改动。

## Phase 3 — US2

- [ ] T005 在 packages/runtime/src 实现真实 DSH 启停、就绪、所有权跟踪、重启 reconciliation；依赖 T004。完成条件：重复启动、端口冲突、异常退出与停止进程树场景通过。

## Phase 4 — US3 与 UI

- [ ] T006 在 apps/desktop/src 实现列表、创建、启动/停止、进度和脱敏错误；依赖 T005。完成条件：可通过 UI 完成主旅程，DSH 页面无法触达高权限 IPC。

## Phase 5 — 验证

- [ ] T007 在 tests/integration 与 tests/e2e 验证 spec 全部 FR 和风险场景；依赖 T006。完成条件：需求—测试映射与真实执行结果齐全。
- [ ] T008 在 docs/development/validation-001.md 记录 macOS ARM64/Windows x64 的真实验收及缺口；依赖 T007。完成条件：每个平台明确通过/失败/未测，不将 mock 结果标作实机支持。

## 执行纪律

按依赖推进，阻塞时报告具体证据。后续多 agent 分工需为每个任务指定文件所有权和基线 SHA，禁止覆盖其他人的实现；此任务清单本身不授权自动并行派发。PR 开出且要求的检查通过后报告停止；无 checks 时报告无 CI，不改 Actions 设置，不 close/reopen PR。
