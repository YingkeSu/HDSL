# Implementation Plan: 受管环境创建与启动

**Branch**: `001-environment-lifecycle`（待创建） | **Date**: 2026-09-20 | **Spec**: [spec.md](spec.md)

## Summary

先证明 DSH 的安装、隔离、就绪与终止协议，再实现从 UI 到真实进程的最小闭环。不要先编造适配器参数或把 mock UI 当成完成。

## Technical Context

- 语言：TypeScript；候选 Electron + React，实际版本在 T002 锁定。
- 工程：拟采用 pnpm workspace，core/runtime/contracts 独立边界。
- 存储：应用数据目录中的 JSON 锁定记录、操作状态与代际目录；凭据在 OS store。
- 测试：领域单元、文件/进程集成、有限 UI E2E；候选 Vitest/Playwright。
- 平台：macOS ARM64、Windows x64 目标；最低版本待上游验证。
- 约束：启动就绪默认上限拟定 60 秒，可配置；下载有取消与有限重试，实际阈值验证后锁定。无远程管理、无后台遥测。

## Constitution Check

设计覆盖用户闭环、精确组成、窄 IPC、显式安全边界与风险测试。上游参数、真实平台验证尚未通过，因此本 plan 不代表已就绪的实施证明。T001 是 T002–T008 的硬前置。

## Project Structure

当前 spec/plan/tasks/data-model/contracts/research 已存在。代码在对应任务中创建：

```text
apps/desktop/src/main/       应用用例与 Electron 生命周期
apps/desktop/src/preload/    窄 IPC
apps/desktop/src/renderer/   环境列表 / 进度 / 错误
packages/contracts/src/     类型与输入校验
packages/core/src/          环境模型、状态与存储端口
packages/runtime/src/       Node/DSH catalog、安装器与进程适配
tests/integration/         文件 / 真实进程
tests/e2e/                 主流程
```

## Implementation Sequence

T001 上游验证 → T002 工程与依赖 → T003 契约 → T004 创建/安装 → T005 启停/恢复观察 → T006 UI → T007–T008 验证。具体范围与停止条件见 [tasks](tasks.md)。

## Complexity Tracking

暂不增加数据库、远程服务、插件 marketplace 或通用任务框架。需要时用 ADR 说明实际驱动问题。
