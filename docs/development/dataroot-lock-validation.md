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
# 16 passed
```

### 断言层级（逐条）

“锁对象”= 直接 `DataRootLock` 断言；“服务”= `createManagedInstall` / 契约 `environments.create` 真实公开入口断言。

| 场景 | 锁对象直接断言 | 服务公开入口断言 | 证据 |
| --- | --- | --- | --- |
| PROC-LOCK-01 双进程 | 真实第二进程 `HELD` / `try-once` `BUSY` exit 3；observer `snapshot` busy/another-instance | **有**：真实 holder 持锁时 `createManagedInstall().available===false`，`environments.create`→`ENVIRONMENT_BUSY`；holder 干净释放后新实例 `available===true` | real |
| PROC-LOCK-01 双实例 | 不适用 | **有**：第二个 `available===false`、`recover().refused`、`create`→`ENVIRONMENT_BUSY` | real |
| PROC-LOCK alias | `canonicalizeDataRoot` 相等 | **有**：别名实例 `available===false` | real |
| PROC-LOCK-03 三方竞争 | **有**：`tryAcquire` 观察→B 接管→guard 重读 busy、B lease 不变、quarantine 无 B.lockId | 见下行 | real |
| PROC-LOCK-03 零重叠持有者 | **有**：3 个真实 `try-once` 恰好 1 `HELD`/2 `BUSY` exit 3 | **有（无重叠受管写）**：真实 holder 持锁期间 `create`→`ENVIRONMENT_BUSY` | real |
| PROC-LOCK-04 旧 owner（ABA） | **有**：A 迟到 `release()`→`released:false`、B lease 保留 | 无（不适用） | injected |
| PROC-LOCK-05 close 顺序 | 不适用 | **有**：OrderingLedger 证明 `writer-settle < lock-release < next-acquire`；在途期间 `publishedBy==="this-instance"`，`operation` 终态 | injected |
| PROC-LOCK 失败留锁 | 不适用 | **有**：`CloseReport.released:false`、`failure.code=INTERNAL_ERROR`、锁仍 held、后续实例不可用 | injected |
| PROC-LOCK-06 损坏/异 host/陈旧存活 | **有**：`unreadable`/`busy`/`unknown`、无 takeover | 无（锁对象级） | injected |
| PROC-LOCK 崩溃接管 | **有**：真实 holder SIGKILL 后 takeover、`staleLease.pid` 匹配 | 无（锁对象级） | real |
| PROC-LOCK-07/08 丢失后不再写 | **有**：`held=false`、`evidence:"lost"`、foreign lease 字节不变 | **有**：失锁后 `create`→`ENVIRONMENT_BUSY`、无新增 environment/operation 持久化、`handleProcessExit` no-op、`close()` 不删 foreign lease | injected（外部篡改，单列） |

### PROC-LOCK-03 可控区间

公开 API 下可确定控制的三个区间：① `tryAcquire()` 同步观察陈旧 lease（返回 false、`takeover:false`、`observedLockId=stale`）；② 真实第二进程 `lock-holder acquire` 合法接管（等其 `HELD` 行，得到 B.lockId）；③ `await A.acquire()` 在 guard 内重读 B live lease。三者按序由 await 固定，不靠 sleep。

### PROC-LOCK-05 close 顺序证明

gated runtime 挂起在途 install；`close()` 先置 abort 但 writer 未 settle 前锁仍 `this-instance`；释放 writer 后 operation 终态，`close()` 才释放（`released:true`、`publishedBy:"none"`），随后新实例 `available:true`。ledger 断言严格顺序。abort 信号本身不作为已停止的证明。

## 负向对照（证明断言能检错）

- owner 释放**自己的** lease：`released:true` 且 canonical lease 消失 → 证明 ABA 的 `released:false` 非恒真。
- 三方竞争恰好一个 `HELD`：若有第二个并发持有者，断言会失败。
- close 顺序：在途期间必须仍 `this-instance`（提前释放会失败），完成后必须 `none`。
- 丢失检测：外部篡改后必须出现 `lost` 且新 lease 保留（若 owner 复活/覆写会失败）。

## 真实 / 注入分栏

- **真实**：真实 OS 进程（`lock-holder.mjs`，同生产实现）、真实文件系统 lease、真实 SIGKILL 崩溃、真实并发抢占、真实 service/契约 `environments.create`。
- **注入**：ABA 的陈旧时钟/探针、close 的 gated runtime、损坏 lease、失败进程端口。
- **单列（外部篡改鲁棒性）**：PROC-LOCK-07/08 通过直接覆写 canonical lease 制造，属**异常篡改防御**，不是协议内 takeover 反例，**不能**作为正常三方接管零重叠的替代，也**不推断**在途 write 已被保护或已停止。

## 边界与未测

- 设计**无 per-record epoch**；`assertHeld()` 是写前纵深校验、非 CAS，存在已文档化窗口；安全依赖“活 owner 永不被接管”。本切片不断言 epoch fencing。
- 协议内“进入 guard 前 B 先接管”的确定性交错需要可选的 test-only hook；当前公共 API 下未使用（如需另行批准）。
- 未执行：PR #48 进程启停/所有权/就绪/端口/超时/崩溃重启（候选未冻结，保持 blocked）；真实 DSH；Windows/Linux 锁语义。
- 无法证明的具体保证列入本节，不扩大 API：协议内“进入 guard 前 B 先接管”的确定性交错、外部篡改下在途 write 是否受保护、跨 host/Windows 语义均**未测**，交专职 review 裁决。
- 本文件不因夹具/锁场景通过而声称 T005 或 T007 完成。

## 清理

- 所有测试只在 `mkdtemp` 根下运行；真实 holder 进程由测试按自有句柄 SIGTERM/SIGKILL 并 `await` 退出；无残留进程或临时目录。
- 未按命令路径盲杀未知进程；外部遗留由所有者自行清理并确认。
