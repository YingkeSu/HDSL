# dataRoot 独占与核心生命周期协调（#43）

本文件定义 HDSL 在**同一 dataRoot** 上的跨实例 / 跨进程独占锁与核心生命周期协调。
实现见 `packages/core/src/data-root-lock.ts`、`packages/core/src/creation-service.ts`；测试见
`tests/core/data-root-lock.test.ts`、`tests/core/data-root-lock.process.test.ts`、
`tests/core/lifecycle-coordination.test.ts`。本文件是 #43 的设计定稿，须与实现同步更新。

## 1. 目标与边界

- 同一 dataRoot 上的 `create` / `start` / `stop` / `recover` 由独占锁串行化；活跃 dataRoot
  明确拒绝或**有界**等待，不无限阻塞。
- 崩溃后可接管，但绝不回滚其他活跃实例的事务；`recover()` 只在持锁时执行，否则显式拒绝。
- 跨主机 / 共享卷 / 容器不承诺支持：hostname 不一致一律 `unknown`/busy。
- 本文件与实现**不引入 OS 沙箱**语义：锁只约束 HDSL 自己的写者边界。

## 2. 锁对象与线性化点（F1）

```
<dataRoot>/locks/
  data-root.lock/
    lease.json            # 活跃持有者的完整 lease（唯一真值）
  quarantine/<lockId>-<uuid>/   # 被接管/释放的旧锁目录（证据，不盲删）
  evidence/*.json               # takeover / lost / restored 证据
```

lease 字段：`schemaVersion`、`lockId`（每次获取新生成的 ABA 凭证）、`instanceId`、
`pid`、`hostname`、`acquiredAt`、`heartbeatAt`。

**获取的唯一线性化点 = 原子目录发布**：

1. 在 `locks/tmp-<uuid>/lease.json` 写入**完整** lease，`fsync` 文件与目录；
2. `rename(tmpDir → data-root.lock/)`。POSIX 目录 rename 仅在目标缺失（或为空目录）时成功，
   非空目标返回 `ENOTEMPTY` → 让出。

因此 canonical 目录对活持有者**永不缺失 `lease.json`**，不存在“先 `mkdir` canonical 再写 lease”
的双持有窗口。`mkdir` 后延迟写 lease 的变体被明令禁止（回归测试覆盖）。心跳用
`temp file + rename` 原子替换 `lease.json`。

## 3. 接管 / 释放仲裁：recovery guard（F2/F3）

接管与释放的**整段**（重读 canonical → 判 stale → 归档旧目录 → 发布新目录）在一个
OS 原子互斥的 **recovery guard** 内执行：

- guard = `net.createServer().listen({host:'127.0.0.1', port, exclusive:true})`；端口由
  `realpathSync.native(dataRoot)`（解析 symlink + 磁盘大小写）经 SHA-256 派生到
  `[20000, 44999]`。同一目录的不同拼写（`/tmp`→`/private/tmp`、大小写别名）派生同一锁与端口（F2）。
- 进程崩溃时 OS 自动释放端口，**没有 guard 文件**需要修复。
- `EADDRINUSE` 时 `connect` 握手；能证明是 HDSL guard 才按有界等待重试，否则
  **fail closed**（不猜测、不静默换端口）。
- guard 持有期间覆盖“重读 + 判定 + 归档 + 发布”，不是只在判定阶段持有。
- `server.close()` 以有界超时 `await`，确保端口真正释放后才认为 `released`。
- Node 为 socket 设置 `CLOEXEC`，受管子进程不会继承监听 fd；有回归测试覆盖。

## 4. stale 判定与接管规则

只有在**同时**满足下列条件时才允许接管：

1. `hostname` 与本机相等（异 host → `unknown`/busy）；
2. lease schema 有效（损坏 → `unknown`/busy，不删除）；
3. `heartbeatAt` 已超过 `staleAfterMs`；
4. `pid` 可证明不存在，即 `kill(pid, 0)` 返回 `ESRCH`。

`pid` 存活（含 PID 复用 / 僵尸 / 暂停）→ 判 `live`，**永不接管**。`EPERM`/未知 → `unknown`。
空 canonical 目录（`data-root.lock/` 存在但无 `lease.json`）视为崩溃残留，由原子发布会话替换；
损坏的 `lease.json` 一律 fail closed。

## 5. 安全依据与非目标（F6/F9）

- **安全依据**：活持有者 pid 存活 → 任何 contender 判 `live` → 永不接管；因此其存活期间
  canonical lease 不会被替换，`assertHeld()` 与实际写之间不存在“他人替换”窗口。
- `assertHeld()` **不是 CAS**：它只是写前的纵深校验。降低到“活持有者永不被接管”这一条规则
  才是安全性来源。
- 没有把 epoch 写入每条 business 记录（journal/environment）。本切片接受该边界；若未来放宽
  接管条件（跨主机 / 共享卷），必须在记录中持久化 `ownerLockId` 并在读取时拒绝旧 epoch。

## 6. 崩溃点矩阵（F7）

| 崩溃点 | canonical 状态 | 重启后行为 |
| --- | --- | --- |
| 发布新目录前（temp 已写） | 旧状态不变 | 新持有者按正常路径获取；`tmp-*` 残留可清理 |
| 目录 rename 中 | 旧状态或新状态（原子） | 活持有者 lease 完整；无半写 |
| 心跳重写中 | 上一份完整 lease | 心跳过期且 pid 死后可接管 |
| guard 内归档后、发布前 | canonical 缺失 | 无有效 lease ⇒ 无活持有者；guard 内发布新锁 |
| 释放中 | canonical 缺失或指向 quarantine | 下一次获取重建；quarantine 保留为证据 |
| 持锁进程 close | 由 close 顺序决定 | 见 §7；失败则保留锁 |

## 7. close 顺序与锁释放（F8）

`EnvironmentService.close()`：

1. `closed = true`：新的 `create` / `start` / `stop` 立即 `ENVIRONMENT_BUSY`，`recover()` 返回
   `refused`；
2. abort 全部在途 `create` / `start` / `stop` 的 `AbortSignal`；
3. `await` 全部在途任务 settle（runtime 保证其自有进程树已退出后才 resolve）；
4. `await process.close()`：停止本实例可证明自有 / adopted 的 DSH 与安装 / 预检子树；失败返回
   `portFail(INTERNAL_ERROR)`；
5. **仅当** process close `ok` 才 `await lock.release()` 并回读校验；否则保留锁并返回
   `CloseReport.released=false`，调用方不得把 root 当作可重用。

`CloseReport { released; stoppedProcesses; failure? }`。崩溃遗留进程由下一次 `recover()` 按
租约 / 进程身份处理，不靠正常 close 放任。

## 8. 观测接口（供 #45 QA）

`EnvironmentService.lockSnapshot(): DataRootLockSnapshot`（`@hdsl/core` 导出，非冻结 DTO）：

- `state`：`held` / `free` / `busy` / `unknown`；
- `publishedBy` 与 `publishedLease`：真实 owner 身份（含 `lockId` ABA 凭证）；
- `lastAttempt`：最近一次获取结果（`outcome`、`reason`、`waitedMs`、`takeover`）；
- `lastRelease`：释放结果与原因；
- `evidence`：`takeover` / `lost` / `restored` 记录。

## 9. 平台与依赖（F4）

- 依赖：仅 `node:net` / `node:fs` / `node:crypto` / `node:os`，**不新增依赖**，
  `@hdsl/core` 仍只依赖 `@hdsl/contracts`，renderer 不导入。
- macOS ARM64 与 Linux CI：guard 的 TCP 独占、崩溃自动释放、目录 rename 语义已在本仓库
  测试中实证（见 `tests/core`）。
- **Windows x64：未实证（T008），按实际范围受限**。代码**只在** `#takeoverGuarded` 拒绝 `win32`
  的 guard 接管（stale 接管返回 `unknown`/busy）；这**不等于整个 Windows 锁 fail-closed，也不声明
  Windows 支持**。普通获取快路径与 release 在 win32 上没有平台分支，其可达性与安全性**未验证**，
  须 T008 实机核定后再决定按实际范围拒绝或明确受限。
- 跨主机 / 共享卷 / 容器不支持，必须文档化。

## 10. 验收测试映射

| 要求 | 测试 |
| --- | --- |
| 原子发布 / 空目录残留 | `data-root-lock.test.ts` |
| 同进程双实例互斥、有界等待 | `data-root-lock.test.ts` |
| 活 owner + 陈旧心跳不接管 | `data-root-lock.test.ts` |
| 真实双进程互斥、崩溃接管 + 证据 | `data-root-lock.process.test.ts` |
| guard 端口释放 / 子进程不继承 | `data-root-lock.process.test.ts` |
| 多进程接管竞争恰好一个持有者 | `data-root-lock.process.test.ts` |
| 三方交错（旧观察不归档新持有者） | `data-root-lock.test.ts` |
| 释放 ABA 不删除他人 lease | `data-root-lock.test.ts` |
| 持锁 recover 拒绝 / 双实例 | `lifecycle-coordination.test.ts` |
| start/stop/recover/close 状态与顺序 | `lifecycle-coordination.test.ts` |
| close 失败保留锁 | `lifecycle-coordination.test.ts` |
| 现有安装创建与错误终态不退化 | `tests/core/creation.test.ts`、`tests/integration/install` |
