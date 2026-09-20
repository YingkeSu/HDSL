# T005 进程生命周期测试（作者单测/集成，非 QA 验收）

本目录是 T005 进程作者对 `packages/runtime/src/{process,reconcile}` 与
`install/run-command.ts` 的测试，运行于默认 `pnpm run test`。

- `readiness.test.ts`：上游就绪行解析（token 剥离、canonical loopback、非法端口）与 loopback 连接探测。
- `ownership.test.ts`：pid + kernel startToken + command 三项所有权证明；pid 复用/命令不符/不可读的分支。
- `lifecycle.test.ts`：受控子进程上的真实 spawn/就绪/端点归属/幂等/端口冲突/超时/取消/意外退出/整树停止/close。
- `reconcile.test.ts`：崩溃遗留的进程与安装子进程对账；不可证明归属不杀；非本实例不动。
- `run-command.test.ts`：安装/预检子进程超时/取消的整树终止与身份 journal。
- `real-process.evidence.test.ts`：opt-in，使用真实受审 DSH 安装（不调模型）。

受控与真实的边界：`support/fake-dsh.mjs` 复现上游可观测协议（就绪行、`EADDRINUSE`、
SIGTERM、孙进程），用于确定性地驱动真实进程代码；它**不是**上游证据。真实上游
行为只由 `HDSL_REAL_PROCESS=1` 的 opt-in 证据与
[`docs/development/t005-process-evidence.md`](../../docs/development/t005-process-evidence.md)
记录。QA 的独立验收（`tests/integration/process/**`）归 #45。
