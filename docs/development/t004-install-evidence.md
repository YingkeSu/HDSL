# T004 受管安装与隔离环境创建 — 实现证据

状态：实现与真实安装证据已完成（macOS ARM64）；Windows x64 未测，不声称支持。
基线：`6da541d866561ad64eaad82b22b33fe5f9ee3e25`（integrates main `eef45a1` + QA fixtures `6da541d`；契约 `contracts-v1.0.0` 仍指 `3e76a49`，未移动标签）。
上游行为依据：[dsh-compatibility.md](../research/dsh-compatibility.md)（T001 R001–R004）。

本文件只记录 T004（安装/创建/隔离/摘要/journal）证据。真实启停、就绪、端口与凭据注入归 T005，不在本文件声称。

## 交付范围

| 包 | 内容 |
| --- | --- |
| `@hdsl/core` | 环境记录、修订/状态语义、操作序列、创建/安装 journal、幂等账本、`EnvironmentService`、`ContractPort` 适配、`createManagedInstall` 组合入口 |
| `@hdsl/runtime` | 受审 catalog、`CompositionLock`/`compositionDigest`、下载+sha256 校验、加固 tar.gz 解压、DSH 依赖闭包、受管预检、`createRuntimePort` |
| 数据资产 | `packages/runtime/catalog/dsh-0.1.5-rc.2/{package.json,package-lock.json,closure.json}` |
| 本任务单测 | `tests/core/**`、`tests/install/**`（QA 的 `tests/integration/install/**` 未改） |

最小包配置改动：`packages/{core,runtime}/tsconfig.build.json` 增加 `"types": ["node"]`（这两个包首次使用 Node 内置模块，否则 `pnpm run build` 无法编译；`package.json` 的 exports/依赖未改）。

## 受审 catalog 与来源

| 组合 | 平台 | Node | 来源 + SHA-256 | DSH |
| --- | --- | --- | --- | --- |
| A | darwin/arm64 | 22.19.0 | `https://nodejs.org/dist/v22.19.0/node-v22.19.0-darwin-arm64.tar.gz` `c59006db…6526d` | `@deepseek-ai/dsh@0.1.5-rc.2` |
| B | darwin/arm64 | 24.21.0 | `https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-arm64.tar.gz` `bed7eea5…f6057` | `@deepseek-ai/dsh@0.1.5-rc.2` |

Node SHA-256 取自官方 `https://nodejs.org/dist/<v>/SHASUMS256.txt`，下载后再由安装器独立复算校验。DSH 顶层 tarball `f4c54839…7480` 与 T001 记录一致。catalog 只列 T001 实测过的这两个 Node 版本，未超证据。

## 依赖闭包（编排要求）

`@deepseek-ai/dsh@0.1.5-rc.2` 只有顶层 tarball 不可运行：它声明约 60 个直接依赖，解析为 **585 个包**。冻结的 `CompositionLock` 字段没有传递树位置，因此闭包作为内部 catalog 锁资产入库：

- `package.json`（规范根工程）+ `package-lock.json`（lockfileVersion 3，每个包带 `integrity`，345,606 字节，sha256 `da075539…a5cd`）。
- `closure.json` 绑定关系：`dshSha256`、`lockSha256`、`packageCount: 585`、`rootResolved`、`rootIntegritySha512`、生成工具版本。
- 安装时由**受管 Node 自带 npm** 在 `<generation>/dsh` 执行 `npm ci --ignore-scripts --no-audit --no-fund`；`HOME`/`DSH_HOME`/`npm_config_cache`/`npm_config_userconfig`/`TMPDIR` 全部指向 generation 或 dataRoot 内，不读写宿主默认目录，且不执行依赖 lifecycle 脚本。
- 一致性绑定：`closure.dshSha256` = 冻结锁的 dsh sha256；下载的 DSH tarball `sha512` 必须等于锁的 `rootIntegrity`；`npm ci` 后对**已安装的 `node_modules/@deepseek-ai/dsh` 做整树摘要**，必须等于从已校验顶层 tarball 解出的参照树摘要（两组合均为 `f5af577d…d5cb`），否则 `DIGEST_MISMATCH`。因此 manifest 记录的 sha256 与实际运行的包是同一份字节。
- 锁资产变化（`closure.json` 记录的 `lockSha256` 不符）会在 `npm ci` 之前直接失败，不会静默改变同一 catalog 组合的重建结果。

## 真实安装证据（opt-in）

命令（本机 macOS 26.3 / arm64）：

```sh
HDSL_REAL_INSTALL=1 HDSL_EVIDENCE_KEEP=1 HDSL_EVIDENCE_DATA_ROOT=/tmp/hdsl-t004-evidence \
  pnpm exec vitest run tests/install/real-install.evidence.test.ts --reporter=verbose
```

结果：`1 passed`，耗时 56.7s；两个组合都走真实官方下载 + 完整闭包 + 预检：

| 项 | 组合 A（Node 22.19.0） | 组合 B（Node 24.21.0） |
| --- | --- | --- |
| `installMode` | `npm-ci` | `npm-ci` |
| `closure.packageCount` | 585 | 585 |
| `closure.lockSha256` | `da075539…a5cd` | `da075539…a5cd` |
| `closure.npmVersion` | 10.9.3 | 11.19.0 |
| `dsh.treeDigest` | `f5af577d…d5cb` | `f5af577d…d5cb` |
| `compositionDigest` | `f2758482…f49ab` | `c18c18b9…a69f2` |
| `node --version` | `v22.19.0`（exit 0） | `v24.21.0`（exit 0） |
| `dsh --version` | `0.1.5-rc.2`（exit 0） | `0.1.5-rc.2`（exit 0） |
| `dsh --help` | exit 0 | exit 0 |
| 宿主 `~/.dsh` 不变 | 是 | 是 |

独立复算（安装后手工执行）：

```sh
shasum -a 256 /tmp/hdsl-t004-evidence/artifacts/sha256/*/*.tar.gz
# c59006db…6526d  node-v22.19.0-darwin-arm64.tar.gz
# bed7eea5…f6057  node-v24.21.0-darwin-arm64.tar.gz
# f4c54839…7480  dsh-0.1.5-rc.2.tgz

/tmp/hdsl-t004-evidence/environments/*/generations/*/node/bin/node --version
# v22.19.0 / v24.21.0（各自 generation）
```

其它观察：每个 generation 约 470–480MB；两个 `node_modules` 完全独立；预检产生的 `node-compile-cache` 落在 `<generation>/home/.tmp`，未触及宿主 `~/.dsh`（其 mtime 保持 `Sep 19 00:00`）。仓库默认 `process.env.HOME` 未被本实现读取用于写入。

## 失败终态（真实文件边界 / 注入）

| 场景 | 注入 | operation 终态 | 环境 |
| --- | --- | --- | --- |
| 摘要不符 | 目标字节与 catalog sha256 不同 | `failed` + `DIGEST_MISMATCH` | `error`，`activeGenerationId=null` |
| 下载中断/不可达 | `failDownloadAfterBytes` / 不可达主机 | `failed` + `DOWNLOAD_FAILED` | `error`，无 active 指针 |
| 磁盘不足 | `forceDiskFull`（确定性守卫）/ 真实 ENOSPC | `failed` + `DISK_FULL` | `error` |
| 中断创建 | `pauseBeforeCommit` 后重启 `recover()` | `failed` + `INTERNAL_ERROR` | `error`，staging 清理、journal 清空 |
| artifacts-only 生产门 | 默认运行 + `closureInstall:false` | `failed` + `INTERNAL_ERROR` | 不提交 active 指针 |

`artifacts-only` 只在显式 `fixtures:{allowArtifactsOnly:true}` 夹具路径可提交，且 manifest 记 `installMode:"artifacts-only"`、`preflight.skipped=true`；默认生产路径拒绝，因此合成夹具不可能被当作完整可启动组合。

## 公开调用面（供 QA #31 / T005）

```ts
import { createManagedInstall } from '@hdsl/core';
import { createRuntimePort, VERIFIED_COMBINATIONS } from '@hdsl/runtime';

const runtime = createRuntimePort({ /* host, fetch, faults, urlRewrites,
  localArtifactDirectory, diskFreeBytes, limits, closureInstall, precheck, npmRegistry */ });
const { port, service, recover, waitForOperation, close } = await createManagedInstall({
  dataRoot, catalog: VERIFIED_COMBINATIONS, runtime,
  /* host, clock, faults, limits:{operationTimeoutMs}, exportDiagnostics, fixtures */
});
const api = createContractRuntime({ port }); // 只走 dispatch
```

- `service.readInstallManifest(environmentId, { generationId? })` 直接返回 manifest（缺失时抛错）；`service.tryReadInstallManifest()` 返回 `PortOutcome`。
- 操作 phase：`queued → downloading → extracting → installing-dependencies → preflight → committing → succeeded|failed`。
- `recover()` 返回 `{ reconciled, finalized, rolledBack, details }`。

## 评审反馈处理（reviewer hdsl-5 对 9fb42d2 的 CHANGES_REQUESTED）

P1（issue #37）已按修复不变量重做：

- 每次尝试使用 `randomUUID()` 后缀的私有 staging；并发尝试不共享可写文件。
- 发布前复算 staging 的 sha256；发布用原子 `rename`。
- 目标已存在时先校验：有效则复用并丢弃本次 staging；无效则原子替换；`ENOENT` 重建目录重试一次，`EEXIST`/`EPERM`/`EACCES`/`ENOTEMPTY` 竞态再校验后复用或显式失败。
- 失败清理只删本次尝试的 staging，不删/截断他人或已发布缓存。
- 回归：`tests/install/concurrency.test.ts`（8 并发同组合全部 ok、缓存恰 2 个有效条目、无 `.part`；损坏缓存原子替换；失败尝试不删已发布条目），`tests/core/creation.test.ts` 6 并发 create 全部成功。

非阻断备注处理：

| 备注 | 处理 |
| --- | --- |
| P2-1 无跨进程/dataRoot 独占锁 | **未修**，记录为 M1 单进程限制；dataRoot 级锁归 T005 `reconcile/**`（见下） |
| P2-2 `recover()` 可能回滚在途创建 | **已修**：journal 循环跳过 `#controllers` 中活跃的 operation；新增在途 recover 回归测试 |
| P2-3 pax/GNU 元数据头无上限 | **已修**：`maxMetadataBytes`（默认 1 MiB）+ 测试 |
| P3-1 `#commit` 对 manifest 绑定校验偏薄 | **已修**：校验 `compositionDigest`、node/dsh sha256 与版本、`closure.installed` |
| P3-2 torn JSON 使整表崩溃 | **已修**：store `read/list` 使用 `tryReadJsonFile`，损坏/撕裂记录按缺失跳过 |
| P3-3 environment 已写、journal 未写的崩溃窗口 | **已修**：`recover()` 扫描无 journal/活跃 operation 的 `creating` 环境并转 `error`，含测试 |
| P3-4 catalog 资产不在 `files` | **已修**：`packages/runtime/package.json` `files: ["dist", "catalog"]`；真正打包/发布仍归 T007/M4 验证 |
| P3-5 `runCommand` 只杀直接子进程 | **未修**，进程树治理归 T005；安装阶段 npm 子进程残留待 T005 统一覆盖 |
| P3-6 合成测试 HOME 断言弱 | **已修**：合成测试改为 `~/.dsh` 目录清单独照前后比对 |

## M1 单进程 / 恢复入口限制（如实陈述）

- `EnvironmentService` 是**单进程、单实例**假设：没有 dataRoot 级跨进程锁，两个实例/两进程对同一 dataRoot 并发写 `environment.json` 是 last-writer-wins。当前 MR 的并发安全只覆盖“同一实例内的并发 create”，不声称跨进程安全。
- `recover()` 是**重启后、开始新工作前**的入口：现在会跳过本进程仍在途的 operation，但同一 dataRoot 上“另一进程正在写”的情形仍无锁保护。该锁与进程树治理归 T005，未在本任务实现。

## 未测 / 缺口

- **Windows x64 未测**（无实机）；catalog 不含 win32 组合，平台不匹配是 `UNSUPPORTED_COMBINATION`。
- 真实启停、就绪、端口冲突、进程树、凭据注入属 T005，未在本任务验证。
- `--ignore-scripts` 下未发现 DSH 闭包需要构建的原生依赖；若将来某个版本需要构建，会作为单独问题报告。
- 磁盘不足只用了注入守卫与 `ENOSPC→DISK_FULL` 映射；未在真实写满卷上复现（QA #31 的 tiny-volume 方案可覆盖）。
- 摘要跨平台“相同语义”只证明算法平台无关（golden 摘要由独立 `shasum` 复算），未在第二平台实测。
- 跨进程/dataRoot 锁与安装阶段子进程树终止未实现（见上）。
