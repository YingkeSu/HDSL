# Feature Specification: 受管环境创建与启动

**Feature Branch**: `001-environment-lifecycle`（规划分支，实施时创建）
**Created**: 2026-09-20
**Status**: Draft — 上游适配证据待补，尚未实施
**Input**: HDSL 简洁 UI、版本管理与隔离需求的首条纵向切片。

## User Scenarios & Testing

### User Story 1 — 创建精确版本的环境（Priority: P1）

用户从已核验的支持列表选择 Node/DSH 组合，创建命名环境，无需修改全局安装。

**Independent Test**: 在临时应用目录创建两个不同组成的环境，检查锁定记录、目录与宿主默认配置不受影响。

**Acceptance Scenarios**:
1. Given 已支持的组合，When 创建，Then 精确版本、来源和摘要写入组成锁，环境处于 stopped。
2. Given 下载中断或摘要错误，When 创建失败，Then 环境不得显示可启动，残留以 failed 操作可查询。
3. Given 已有环境 A，When 创建 B，Then B 不继承 A 的配置、插件或运行数据。

### User Story 2 — 启动与停止（Priority: P1）

用户选择环境后使用唯一主启动按钮运行 DSH，启动成功才提供 WebUI 入口。

**Independent Test**: 使用受管运行时启动真实 DSH，验证就绪、绑定地址、停止后子进程退出；伪进程测试不能代替真实验收。

**Acceptance Scenarios**:
1. Given stopped 环境，When 启动，Then 使用锁定的可执行路径与隔离设置，健康检查通过后显示 running。
2. Given starting/running 环境，When 重复启动，Then 返回现有操作/状态，不生成重复进程。
3. Given running 环境，When 停止，Then 先正常终止，超时后按平台策略处理所属进程树，成功后为 stopped。
4. Given 端口冲突或启动超时，When 启动失败，Then 显示可操作错误，释放所拥有资源，不误终止他人进程。

### User Story 3 — 可理解的失败（Priority: P2）

用户可查看阶段、可重试错误和脱敏诊断。

**Independent Test**: 注入下载失败、未知版本及启动失败，用户可看到原因与下一步；诊断产物中不含 canary secret。

### Edge Cases

磁盘不足、中文和带空格路径、进程意外退出、并发请求、应用重启留下子进程、未知上游版本、不支持平台、就绪超时、敏感信息出现在上游日志。

## Requirements

- **FR-001**: 系统 MUST 创建独立环境 ID、名称和数据根目录，禁止写入其他环境或自动共享默认 DSH home。
- **FR-002**: 系统 MUST 使用精确运行时版本、平台、来源和 SHA-256，拒绝不受支持的组成。
- **FR-003**: 系统 MUST 通过受核验适配器、参数数组和显式进程环境启动；不得拼接 shell。
- **FR-004**: 系统 MUST 在有限超时内完成就绪检测，失败给出错误；WebUI 仅使用已验证的 loopback 地址。
- **FR-005**: 系统 MUST 对重复启动/停止保持幂等，并跟踪进程退出；不得仅凭过期 PID 终止进程。
- **FR-006**: 系统 MUST 以 operation 表示耗时操作，暴露阶段、最终结果与可重试状态。
- **FR-007**: 系统 MUST 脱敏日志与错误详情，凭据只保存系统凭据引用。
- **FR-008**: 系统 MUST 保留创建失败的诊断状态；应用重启检查未结束操作及自己拥有的进程。

### Key Entities

Environment、CompositionLock、RuntimeArtifact、Operation；字段草案见 data-model，恢复/插件/包的完整设计将在后续规格细化。

## Success Criteria

- **SC-001**: 两个不同组成环境可分别启动，配置与数据隔离实测通过。
- **SC-002**: 主流程可从 UI 完成，不要求用户手动修改 PATH 或全局 DSH 安装。
- **SC-003**: 每种列出的失败场景有可查询终态，测试不无限等待。
- **SC-004**: 声明支持的平台分别留下真实 DSH 启停证据；在这之前只称目标平台。

## Assumptions

首版目标 macOS ARM64 与 Windows x64；具体 OS 最低版本、DSH 与 Node 组合由 research 决定。网络和用户凭据是启动前置条件。插件编辑、升级/恢复和包分享不在此切片内，但在产品 MVP 内。
