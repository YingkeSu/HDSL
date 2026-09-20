# T005 真实 DSH 启停与进程所有权管理 — 实现证据

状态：进程模块实现与单元/真实证据已完成（macOS ARM64）；core（#43）与凭据（#44）的整合在各自分支，本文件只声明 runtime 进程模块自身的可观测结果。Windows x64 未测，不声称支持。

- 基线 SHA：`7fbdc1e2607f4f695e6389296f56b3ba2600fa43`（main）。
- 依据：[spec.md](../../specs/001-environment-lifecycle/spec.md)、[plan.md](../../specs/001-environment-lifecycle/plan.md)、[contracts/local-api.md](../../specs/001-environment-lifecycle/contracts/local-api.md)、[ADR 0002](../adr/0002-credential-boundary.md)、[dsh-compatibility.md](../research/dsh-compatibility.md)（T001 R001–R004）、[t004-install-evidence.md](t004-install-evidence.md)。
- 本文件所有权：T005 进程作者。`docs/development/process-validation.md`（QA #45）与 `docs/development/dataroot-ownership.md`（#43）、`docs/development/credentials.md`（#44）由各自作者维护。

## 交付范围与所有权

| 路径 | 内容 |
| --- | --- |
| `packages/runtime/src/process/**` | 真实 DSH 启动、就绪、端点归属、所有权、进程树终止、launch record、观测面 |
| `packages/runtime/src/reconcile/**` | 崩溃遗留的进程与安装子进程对账（与创建事务对账由 core 合并报告） |
| `packages/runtime/src/install/run-command.ts` | 安装/预检子进程的整树终止与可证明身份 journal |
| `tests/process/**` | 进程/所有权/对账/`runCommand`/真实 DSH opt-in 证据 |

未改动 `packages/core/**`、`packages/runtime/src/credentials/**`、renderer 与 QA 目录；未回退他人改动。

## 注入接口（core/runtime 不互相 import，结构类型对接）

冻结于与 #43(hdsl-21) 的协调消息，双方一致：

```ts
interface ProcessLifecycleRequest {
  environmentId: string; expectedRevision: number;
  generationDirectory: string; homeDirectory: string; configDirectory: string; dataDirectory: string;
  nodeExecutable: string; dshEntrypoint: string;
  installMode: 'npm-ci' | 'artifacts-only';
  signal: AbortSignal; onPhase?(phase: string, progress?: number): void;
  port?: 'auto' | number;
}
interface ProcessStartOutcome { pid: number; loopbackOrigin: string }
interface ProcessStopOutcome { pid?: number; wasRunning: boolean }
interface ProcessRecoveryEntry {
  environmentId: string;
  resolution: 'stopped' | 'adopted' | 'no-process' | 'unverifiable';
  loopbackOrigin?: string; detail?: string;
}
interface ManagedProcessPort {
  start(req): Promise<PortOutcome<ProcessStartOutcome>>;
  stop(req): Promise<PortOutcome<ProcessStopOutcome>>;
  openWebUI(environmentId): PortOutcome<OpenWebUIResult>;
  recover(): Promise<{ entries: ProcessRecoveryEntry[] }>;
  close(): Promise<PortOutcome<void>>;
}
```

- **职责划分**：core 负责 guard、operation 持久化、env state、dataRoot 锁与幂等；runtime 只负责真实进程、就绪、端口、所有权与退出。runtime 不写 operation/env state，通过 `onPhase` 汇报阶段。
- **取消**：core abort 传入的 `signal`；runtime 监听并终止自有进程树，不新增 cancel 方法。
- **意外退出**：`createProcessManager({ onProcessExit })` 回调（core 置 `stopped` 并记录 `PROCESS_EXITED`）。
- **锁生命周期**：实例级 dataRoot 独占锁完全由 core 持有；runtime 永不加锁、不假设锁安全。`recover()` 由 core 在自认持锁且确认无其他活跃实例时调用；`isRecoveryPermitted()` 返回 false 时 runtime 不做任何修改。
- **close**：按 hdsl-2 决定，正常关闭必须停止本实例可证明自有/adopted 的 DSH 与仍持有的安装/预检子树并 await 退出；无法证明归属且 pid 存活、或确认不了退出时返回 `portFail(INTERNAL_ERROR)`，core 只有在 `close().ok` 后才释放 dataRoot 锁。

### 凭据注入（T005b #44，已整合）

```ts
interface LaunchEnvironmentHandle { env: Readonly<Record<string,string>>; dispose(): void }
interface LaunchCredentialPort {
  resolveLaunchEnvironment(environmentId: string): Promise<PortOutcome<LaunchEnvironmentHandle>>;
}
```

- `runtime/src/index.ts` 已导出 `./credentials/index.js`（#44 merge `ead40c1`）；进程侧 `import type` 复用 `LaunchCredentialPort` / `LaunchEnvironmentHandle`，不重复声明，避免同名导出歧义。
- runtime 在 spawn 前解析；`handle.env` 与受管隔离变量合并为显式子进程 env；`spawn` 同步拷贝后在同一 `try/finally` 中调用 `handle.dispose()`，覆盖成功、隔离校验失败、spawn 抛错与取消。
- 凭据只走显式 env，绝不进入 argv、`LaunchRecord`、日志或事件；`env` 只在 launch 局部存在，随后清空引用。
- loader 前置条件（已闭合）：`service#account` 完整引用的强制由凭据端口单点负责（#44 PR #53 `b704cd8`）；loader 由 core（#43 PR #52 `5d8b171`/`562fa03`）提供 versioned 引用存储与 `launchCredentialRequest`。runtime 不读凭据配置。

**单一五键映射（与 core `#baseLaunchEnvironment` 精确一致，review P2-C/#60）**：

| key | 值（runtime 由 request 可信路径导出） |
| --- | --- |
| `HOME` | `request.homeDirectory` |
| `DSH_HOME` | `request.homeDirectory` |
| `DSH_AGENTS_HOME` | `join(request.homeDirectory, "agents")` |
| `PATH` | `join(request.generationDirectory,"node","bin") + ":/usr/bin:/bin:/usr/sbin:/sbin"` |
| `TMPDIR` | `join(request.homeDirectory, ".tmp")` |

- `handle.env` 中出现的**任一受管键**若与上表不一致，spawn 前受控失败（`INTERNAL_ERROR`）且 `finally dispose()`；不静默覆盖，不把错位 `nodeExecutable` 混报为凭据冲突。
- `DSH_TELEMETRY_DISABLED`/`NODE_NO_WARNINGS` 为 runtime 启动策略键，单列且不参与五键一致性校验。
- 互操作证据：`tests/process/credentials-integration.test.ts`（真实适配器 + 测试 provider）；`tests/process/core-loader-wiring.test.ts`（真实 core loader→strict port→manager，断言五键与 core 完全一致、canary 注入、宿主 env 不泄漏）。

## 进程记录

`<dataRoot>/process/launches/<environmentId>.json`：

```json
{
  "schemaVersion": "1", "environmentId": "...", "expectedRevision": 1,
  "generationDirectory": "...", "commandFragment": ".../dsh/lib/bin.js",
  "state": "spawning|starting|running|stopping|stopped|failed|unverifiable",
  "identity": { "pid": 1234, "pgid": 1234, "startToken": "Sun Sep 20 ...", "commandFragment": "...", "createdAt": "..." },
  "endpoint": { "origin": "http://127.0.0.1:63059", "host": "127.0.0.1", "port": 63059 },
  "exitCode": null, "processExitedAt": null, "errorCode": null, "errorDetail": null,
  "createdAt": "...", "updatedAt": "...", "sequence": 3
}
```

- `endpoint` 只含标准 loopback origin，**无 token/query/cookie**；token URL 只在就绪解析时短暂存在于内存。
- 安装/预检子进程身份：`<generation>/.hdsl-process-children/<token>.json`，字段 `{ pid, pgid, startToken, commandFragment, createdAt, updatedAt }`。`commandFragment` 只记录可执行文件路径，argv 不落盘。
- 所有权 = pid + kernel `startToken` + command fragment 三项同时匹配；仅 pid 相同不足以认领。pid 被复用（startToken 不同）视为原进程已消失，不杀且允许替换；活着但无法证明归属（probe 不可读/命令不符）不杀，reconcile 记为 `unverifiable`。

## 生命周期语义

- **启动**：同步写 launch intent → 解析凭据 → `spawn` 受管 Node + `web --no-open --host 127.0.0.1 --port 0|<fixed>`（`detached` 自成进程组）→ 记录身份 → 等待 stdout 上 `dsh web: http://127.0.0.1:<port>/?token=…` 并做 loopback TCP 连接确认 → 记录 `running` 与 origin。就绪判定不是固定 sleep，也不把端口打开当就绪。
- **重复启动**：已 running 或同环境有在途任务 → `ENVIRONMENT_BUSY`，不生成第二个进程。
- **重启**：`start()` 在新 spawn / 覆盖 record 前先用旧 record 证据解析旧进程组；不可证则 `INTERNAL_ERROR` 且不覆盖旧记录。
- **停止**：只对可证明自有的树 `SIGTERM → grace → SIGKILL`（组信号 + 后代兜底），await 退出后 `stopped`；无法认领则不杀并返回 `INTERNAL_ERROR`。
- **就绪超时 / 固定端口被占 / 就绪前退出 / 取消**：先终止自有整树再 resolve；错误码见下。
- **recover**：`isRecoveryPermitted()` 为假直接返回空报告；否则对每条 launch record 核身份：可证明且已就绪可达 → `adopted`；可证明但未就绪 → 停止；不可证明的存活 pid → `unverifiable` 不杀；已消失/复用 → `no-process`。同时清理 generation 下仍可证明自有的安装子进程 journal。
- **close**：幂等；拒绝新操作；abort 在途 start/stop 并 await；停止全部自有/adopted running 与安装/预检子树并 await；全部确认退出才返回 `ok`。

### 错误码映射（全部为冻结契约既有码，无新增）

| 场景 | code |
| --- | --- |
| 就绪超时 | `START_TIMEOUT` |
| 固定端口被占 / stderr `EADDRINUSE` | `PORT_UNAVAILABLE` |
| 就绪前子进程退出 | `PROCESS_EXITED` |
| 无凭据引用 / 解析失败（#44 映射；`UNSUPPORTED_PLATFORM` → `UNSUPPORTED_COMBINATION`） | `INTERNAL_ERROR` |
| artifacts-only 真实启动 / spawn 失败 / 隔离校验失败 / loopback 校验失败 / 取消 / 无法证明归属的 stop / close 确认失败 | `INTERNAL_ERROR` |
| 同环境并发 start/stop、已 running 再 start | `ENVIRONMENT_BUSY` |
| openWebUI：非 running / 无 record / 归属不成立 | `WEBUI_UNAVAILABLE` |

## 安全边界

- 就绪行中的 `?token=…` 只在内存解析，持久化的只有 origin；测试断言 `LaunchRecord` 序列化后不含 `token`，也不含 canary 凭据值。
- 子进程 env 为显式构造（`HOME`/`DSH_HOME`/`PATH`/`TMPDIR`/`DSH_AGENTS_HOME` 指向受管目录），不继承宿主环境；测试用 `__HDSL_HOST_LEAK__` 证明宿主变量未泄漏。
- 上游生成的 `<home>/.credentials.yaml` 属环境 home 含密产物，按 ADR 0002 处理；真实证据确认权限 `0600`。HDSL 不把它复制到别处，也不写入普通日志。
- 日志与错误只使用固定受控文案；不转发子进程 stdout/stderr 原文（就绪行解析后即丢弃，退出仅用于 `EADDRINUSE` 分类）。

## 执行的命令、平台与结果

平台：macOS 26.3（Darwin 25.3.0）arm64；Node v24.21.0（`.nvmrc`，pnpm 11.7.0 要求 `^22.19 || ^24 || >=26`，宿主 25.6.1 不满足 engines）。

```sh
pnpm install --frozen-lockfile
pnpm run typecheck     # PASS
pnpm run build         # PASS
pnpm run test          # 47 files passed / 3 skipped; 576 passed / 5 skipped（含 tests/process 67 项）
python3 scripts/check_repository.py   # PASS
```

真实 DSH opt-in 证据（复用 T004 已核验安装，避免重复下载；不发模型调用）：

```sh
HDSL_REAL_PROCESS=1 HDSL_EVIDENCE_KEEP=1 \
HDSL_REAL_PROCESS_DATA_ROOT=/tmp/hdsl-t004-evidence \
  pnpm exec vitest run tests/process/real-process.evidence.test.ts --reporter=verbose
```

结果：`1 passed`，3.6s。运行于提交 `9927af8cb35731f93122e438b1f1a308b0ea695f`（含 #44 凭据适配器整合，基线 `7fbdc1e2`）。

```json
{
  "dataRoot": "/tmp/hdsl-t004-evidence",
  "environmentId": "env-0cbe88017e804ff8",
  "nodeVersion": "22.19.0",
  "dshVersion": "0.1.5-rc.2",
  "installMode": "npm-ci",
  "origin": "http://127.0.0.1:49882",
  "httpStatus": 401,
  "launchRecordState": "running",
  "startTokenPresent": true,
  "upstreamCredentialArtifact": "<dataRoot>/environments/env-0cbe88017e804ff8/generations/gen-67b85eafc97c4083/home/.credentials.yaml",
  "upstreamCredentialMode": "600",
  "homeUntouched": true
}
```

- 就绪来自真实上游 stdout 行 + loopback 连接；对 origin 的无 cookie 请求返回 DSH 的 `401`。
- `Node 22.19.0 + DSH 0.1.5-rc.2`（catalog 组合 A）在受管 generation 内启动、停止，宿主 `~/.dsh` 文件清单不变。
- 停止后 `isProcessAlive(pid) === false`，凭据 `dispose()` 调用 1 次。
- 同一时刻机器上存在一个**不属于本任务**的 DSH 进程（相对路径 `node_modules/@deepseek-ai/dsh/lib/bin.js`，启动于本会话前、pgid 不同）；本实现未对其发出任何信号。这是「只终止自有进程」的旁证。

## CI 回归根因与修复（Ubuntu）

现象：工程 CI 在 `tests/process/lifecycle.test.ts` 的 “terminates the whole tree … START_TIMEOUT” 得到 `PROCESS_EXITED`（约 1.1s 退出，早于 2s 就绪超时）。macOS 本机 8 次重复均通过。

根因（已在本地以确定性单测与集成场景复现）：身份未捕获（`identity === null`）的清理路径只按 `commandFragment` 广播匹配进程。多个测试文件共享同一 `fake-dsh.mjs` 路径，且 vitest 默认跨文件并行；另一个文件的 `close()`（例如 “spawn itself fails” 后清理）会把正在等待超时的 `never-ready` 子进程当作自己的残留杀掉，于是本应 `START_TIMEOUT` 的用例看到子进程提前退出。生产路径本不会冲突（DSH entrypoint 位于每个 environment/generation 的独立目录），但这是真实的广义所有权漏洞，不能只改测试期望。

修复：

- 生产：`findOwnedProcesses(probe, commandFragment, generationDirectory)` 要求候选进程命令行同时包含该记录唯一的 generation 目录；`manager.stop/close` 与 `reconcile` 身份未捕获路径均改用该函数。仅共享可执行路径不再足够。
- 测试：每个 harness 把夹具复制到自己的 generation 目录（`<gen>/fake-dsh.mjs`），`commandFragment` 天然唯一。
- 回归：`tests/process/ownership.test.ts` 的 “identity-free candidate scan”（同 fragment、不同 generation 目录必须不匹配）与 `tests/process/lifecycle.test.ts` 的 “never kills a process that only shares the command fragment …” 锁定该行为。

## Review 修复（PR #48 独立安全/生命周期 review）

reviewed SHA `49b5d599…` → `CHANGES_REQUESTED`（2 P2 + 7 P3）。本轮处置：

| 项 | 处置 | 证据 |
| --- | --- | --- |
| P2-1 身份未捕获清理在扫描失败时 fail-open（#55） | 已修：probe 新增 `tryFindIdsByCommandFragment`（`undefined` = 扫描失败）、`listProcessGroup`；`findOwnedProcessesDetailed` 返回 `{ok:true,processes}|{ok:false,reason}`；identity-null 路径扫描失败或存在候选（命令/目录匹配不足以证明归属，可能是诱饵）时一律**只读失败、不杀**，不再写 `stopped`；`close` 失败则 core 不放锁 | `tests/process/lifecycle.test.ts` “scan availability” 两条 + “identity-null decoy” 用例；`tests/process/ownership.test.ts`；QA `PROCESS-SCAN-01` / `PROCESS-GROUP-ATTR01` 转绿 |
| P2-A 重启覆盖旧遗留进程组（#57） | 已修：`start()` 在新 spawn / 覆盖 record 之前，先用**旧 record 的证据**解析旧进程组；解析成功才新启动，不可证则 `INTERNAL_ERROR` 且**不覆盖旧归属记录**，便于后续/人工处理 | `tests/process/lifecycle.test.ts` “restart over a crashed predecessor” 两条；QA `PROCESS-RESTART-01` 转绿 |
| P2-B 成员级归属与防组复用（#57/#59） | 已修：`cleanupLostLeaderTree` 逐成员证明——组内成员且（命令/生成目录证据 **或** 成员在记录的 leader 退出时间之前已存在，后者为 OS 进程组证据：leader 存活时组号属于我们，未空置不可能被复用）；逐成员 SIGKILL，未知成员不杀；存在不可证成员/扫描失败则 fail-closed、保留 record、`close` 失败不放锁。早期 `watchExit` 收尾也走同一证明 | `tests/process/leftovers.test.ts`（命令证据/退出时间证据/退出后无证据拒杀/扫描失败/真空）；`tests/process/lifecycle.test.ts` “cleans up a crashed parent's descendants…” |
| P2-C 受管 env 五键映射（#60） | 已修：五键精确映射与 core `#baseLaunchEnvironment` 一致（含 `PATH=join(generationDirectory,"node","bin")+":/usr/bin:/bin:/usr/sbin:/sbin"`）；`handle.env` 任一受管键不一致 → spawn 前受控 `INTERNAL_ERROR` 且 `finally dispose()`；`DSH_TELEMETRY_DISABLED`/`NODE_NO_WARNINGS` 为启动策略键、单列 | `tests/process/core-loader-wiring.test.ts`（真实 core loader→strict port→manager）；`tests/process/lifecycle.test.ts` 三条冲突拒绝；QA `PROCESS-ENV-MAP01`/`-CONFLICT` 转绿 |
| P3-1 `LaunchRecordStore.write` 未校验 opaque ID | 已修：与 read/remove 一致校验 | `records.ts` |
| P3-2 凭据响应形状未校验 | 已修：运行时校验 `PortOutcome` 与 handle 形状，映射为受控 `INTERNAL_ERROR`（不再出现 `undefined` code/message） | `lifecycle.test.ts` “rejects a malformed credential result …” |
| P3-3 `captureIdentity` 条件反向 | 已修：活着的 pid 读不到时在 2s 内重试；进程已死时立即失败 | `lifecycle.test.ts` “retries identity capture …” |
| P3-4 launch env 可覆盖受管 PATH/TMPDIR | 已修：五键一致性校验（见 P2-C）；不静默覆盖 | `lifecycle.test.ts` “rejects a launch env that disagrees with … HOME/PATH/DSH_AGENTS_HOME” |
| P3-5 startToken 秒级粒度 | 跟踪：#59（低频、需要同秒 pid 复用且命令一致）；本文件如实记录 | — |
| P3-6 adopt 端点归属 TOCTOU | 跟踪：#59；受 loopback + 唯一 generation 路径约束，不扩大平台声明 | — |
| P3-7 `run-command` 拼接 OS `error.message` | 已修：只保留 OS error code 的受控文案 | `run-command.ts` |

`findOwnedProcesses`/`scan`/`findIdsByCommandFragment` 的旧数组返回签名保留但已标 `@deprecated`（QA 合成用例仍用）；生产清理一律使用 `findOwnedProcessesDetailed`/`tryFindIdsByCommandFragment`，扫描失败不可能被误判为空。逐成员证明只在身份存在时适用；identity-null 记录即使命令与目录双匹配也**不**视为归属证据（诱饵，QA `PROCESS-GROUP-ATTR01`）。

## 未测 / 缺口

- **Windows x64 未测**：`process/**` 使用 POSIX 进程组与 `ps`；`createPosixProcessProbe` 未在 Windows 验证，`detached` 语义不同。未声称支持。
- **Linux 未实机验收**：CI（ubuntu）只跑 typecheck/build/unit；进程组与 `ps` 在 Linux 可用，但真实 DSH 启停未在 Linux 留证。
- **跨实例/跨进程 dataRoot 锁**：归 #43（core）；本模块只注入并不自定锁。锁设计仍在审核（目录主锁 + TCP loopback guard），本文件不把该设计当作已安全。
- **core 整合未完成**：`EnvironmentService` 尚未注入本端口（#43 分支）。凭据适配器（#44，#46 merge `ead40c1`）已接入并由 runtime 根 index 导出。
- **adopted 后 openWebUI 的存活复核**：采用 loopback TCP 可达 + 身份匹配；未覆盖 DSH 进程存活但 HTTP 层挂起的场景（会落到 reconcile 的停止路径）。
- **进程组归属的 OS 依据与残差**：崩溃后逐成员清理时，除命令/生成目录证据外，使用“成员在记录的 leader 退出时间之前已存在”作为 OS 进程组证据（leader 存活时组号属于我们，组未空置便被复用不成立）。残差：`ps -o lstart=` 为秒级，退出边界有 1s 容忍；完整无歧义需要 supervisor/组级 mark，#57/#59 跟踪并请 #8 确认该 OS 路线。
- **子进程 stdout/stderr 不落盘**：因此没有 DSH 启动诊断文件；T006 的诊断导出需另行设计（不在本切片）。
- 未在真实“启动后取消”与“就绪后立即停止”的时序上做穷尽并发压测；关键分支由确定性门控覆盖，无 `skip`/`it.fails` 冒充。
