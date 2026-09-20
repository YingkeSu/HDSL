# dataRoot 锁与核心生命周期验证（T007b / issue #45 锁切片）

状态：**锁切片已注册并在候选上真实执行；不代表 T005/T007 整体验收**。进程启停/所有权（PR #48）未冻结，仍在本地集成、未注册。
本文件与 `tests/integration/process/**` 的锁场景由 issue #45 QA 独占；QA 只测不改生产、不做 review。

## 元数据

| 项 | 值 |
| --- | --- |
| 任务 | [#45 T007b](https://github.com/YingkeSu/HDSL/issues/45)，父 #7；锁接口 #43 |
| 候选（PR base） | 会话 hdsl-21 `ao/hdsl-21/t005a-dataroot-lock` @ `5bf7091011b137955ab4cfd83c746b9baf01b832`（PR [#49](https://github.com/YingkeSu/HDSL/pull/49)，CI 4 绿） |
| QA 分支 | `ao/hdsl-23/lock-qa` |
| 公开入口 | `@hdsl/core`：`createManagedInstall`、`DataRootLock`、`canonicalizeDataRoot`（内部 API，非冻结 `@hdsl/contracts` DTO；只读观测） |
| 共享测试夹具 | `tests/install/synthetic.ts`（离线合成产物，非生产）；真实第二进程 `tests/core/support/lock-holder.mjs`（生产同实现，只读复用） |
| 执行平台 | macOS 26.3（Darwin 25.3.0 arm64），Node `v24.21.0` |
| Windows / Linux | **未测**；本切片不声明支持 |

## 场景与结果

命令（候选分支）：

```sh
pnpm exec vitest run tests/integration/process/lock.integration.test.ts tests/integration/process/lock-lifecycle.integration.test.ts
# 15 passed
```

| 场景 | 证据 | 确定性门控 | 结果 |
| --- | --- | --- | --- |
| PROC-LOCK-01 双进程独占 | real | 真实第二进程 `HELD`，`try-once` `BUSY` exit 3 | PASS |
| PROC-LOCK-01 双实例（service 层） | real | 同一 dataRoot 第二个 `createManagedInstall().available===false`；`recover().refused`；`environments.create`→`ENVIRONMENT_BUSY` | PASS |
| PROC-LOCK alias 别名 | real | `..`/符号链接/真实拼写 `canonicalizeDataRoot` 相等且互斥 | PASS |
| PROC-LOCK-03 三方竞争 | real | `tryAcquire()` 只观察（`takeover:false`、`observedLockId=stale`）→ 真实 B 接管 → 再 `acquire` 重读 B live lease=busy、B lease 不变、quarantine 无 B.lockId | PASS |
| PROC-LOCK-03 并发零重叠持有者 | real | 3 个真实 `try-once` 并发：恰好 1 个 `HELD`、2 个 `BUSY` exit 3 | PASS |
| PROC-LOCK-04 旧 owner（ABA） | injected | B 接管 `lockId2` 后 A 迟到 `release()`→`released:false` 且 B lease 保留 | PASS |
| PROC-LOCK-05 close 顺序 | injected | gated runtime 挂起在途 install；`close()` 先 abort，未放行前 `publishedBy==="this-instance"`，放行后 `released:true`、`publishedBy==="none"`、operation 终态 | PASS |
| PROC-LOCK 失败留锁 | injected | 进程端口 `close()` 失败 → `CloseReport.released:false`、`failure.code=INTERNAL_ERROR`、锁仍 held，后续实例不可用 | PASS |
| PROC-LOCK-06 损坏 lease | injected | 直接写损坏 `lease.json` → `publishedBy==="unreadable"`、`state==="unknown"`、拒绝 | PASS |
| PROC-LOCK-06 异 host | injected | 合法但异 hostname lease → `busy`、无 takeover | PASS |
| PROC-LOCK-06 陈旧心跳但 PID 存活 | injected | 过期心跳 + 存活 PID → `busy`、无 takeover | PASS |
| PROC-LOCK 崩溃接管 | real | 真实 holder 被 SIGKILL；持有者 `pid` 死亡 + 心跳过期后 takeover，`staleLease.pid` 匹配 | PASS |
| PROC-LOCK-07/08 丢失后不再写 | injected（外部篡改，单列） | 外部覆写 canonical lease → owner `held=false`、`evidence kind:"lost"`、新 lease 未被删除/覆写、新受管写 `ENVIRONMENT_BUSY`、`handleProcessExit` no-op | PASS |

## 负向对照（证明断言能检错）

- owner 释放**自己的** lease：`released:true` 且 canonical lease 消失 → 证明 ABA 的 `released:false` 非恒真。
- 三方竞争恰好一个 `HELD`：若有第二个并发持有者，断言会失败。
- close 顺序：在途期间必须仍 `this-instance`（提前释放会失败），完成后必须 `none`。
- 丢失检测：外部篡改后必须出现 `lost` 且新 lease 保留（若 owner 复活/覆写会失败）。

## 真实 / 注入分栏

- **真实**：真实 OS 进程（`lock-holder.mjs`，同生产实现）、真实文件系统 lease、真实 SIGKILL 崩溃、真实并发抢占、真实 service/契约 `environments.create`。
- **注入**：ABA 的陈旧时钟/探针、close 的 gated runtime、损坏 lease、失败进程端口。
- **单列（外部篡改鲁棒性）**：PROC-LOCK-07/08 通过直接覆写 canonical lease 制造；这是外部篡改，不是协议内 takeover 反例。

## 边界与未测

- 设计**无 per-record epoch**；`assertHeld()` 是写前纵深校验、非 CAS，存在已文档化窗口；安全依赖“活 owner 永不被接管”。本切片不断言 epoch fencing。
- 协议内“进入 guard 前 B 先接管”的确定性交错需要可选的 test-only hook；当前公共 API 下未使用（如需另行批准）。
- 未执行：PR #48 进程启停/所有权/就绪/端口/超时/崩溃重启（候选未冻结，保持 blocked）；真实 DSH；Windows/Linux 锁语义。
- 本文件不因夹具/锁场景通过而声称 T005 或 T007 完成。

## 清理

- 所有测试只在 `mkdtemp` 根下运行；真实 holder 进程由测试按自有句柄 SIGTERM/SIGKILL 并 `await` 退出；无残留进程或临时目录。
- 未按命令路径盲杀未知进程；外部遗留由所有者自行清理并确认。
