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

## 未测 / 缺口

- **Windows x64 未测**（无实机）；catalog 不含 win32 组合，平台不匹配是 `UNSUPPORTED_COMBINATION`。
- 真实启停、就绪、端口冲突、进程树、凭据注入属 T005，未在本任务验证。
- `--ignore-scripts` 下未发现 DSH 闭包需要构建的原生依赖；若将来某个版本需要构建，会作为单独问题报告。
- 磁盘不足只用了注入守卫与 `ENOSPC→DISK_FULL` 映射；未在真实写满卷上复现（QA #31 的 tiny-volume 方案可覆盖）。
- 摘要跨平台“相同语义”只证明算法平台无关（golden 摘要由独立 `shasum` 复算），未在第二平台实测。
