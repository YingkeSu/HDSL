# Windows x64 便携构建（未签名 · 未实机验证）

本记录说明 HDSL 当前**唯一**可交付的 Windows 产物：Electron 桌面壳的未签名 Windows x64 便携 ZIP，以及它**不能**做什么。范围仅限打包与归档完整性；Windows 运行时适配与实机验收仍属 [#8](https://github.com/YingkeSu/HDSL/issues/8)（T008b，见 [路线图](roadmap.md)）与 [ADR 0007](../adr/0007-macos-acceptance-and-internal-distribution.md)。

结论先行：**这是实验性桌面构建。启动未验证；DSH 环境创建/安装既未被平台契约正确拒绝，也未获得支持——它会在 win32 上沿未验证路径推进到产物阶段才失败（见下方“已发现的缺口”）。** 不要把它描述为“Windows 版本已可用”，也不要描述为“win32 已被契约拒绝”。

本记录随构建候选一起合入；桌面入口未上报真实宿主的缺口由**单独变更**负责修复，修复合并后本记录的状态描述需要同步更正（见“已发现的缺口”）。当前 CI 归档只是**候选产物**（Artifact + SHA256），最终 Release 必须在修复合并后按精确 main 提交重建。

## 产物形态

| 项 | 值 |
| --- | --- |
| 目标 | `win32` / `x64` |
| 形态 | 便携 ZIP（解包目录打包），**无安装器、无签名、无公证、无自动更新** |
| 解包顶层目录 | `HDSL-<version>-win32-x64/` |
| ZIP 名（CI 生成） | `HDSL-<version>-win32-x64-<sha7>-portable.zip`，`<sha7>` 为构建基线提交前 7 位 |
| 组件 | Electron `44.4.3`（`apps/desktop` 的 `devDependencies`，由 electron-builder 从官方发行包下载） |
| `<version>` 来源 | `apps/desktop/package.json` 的 `version`；当前为 `0.0.0`，版本号决策未在本轮做出 |

签名与公证不作为当前门槛（ADR 0007 决策 5）；本机 `security find-identity -v -p codesigning` 仍为 `0 valid identities`，仓库内不存在签名身份。ZIP 以工作流内 `Get-FileHash -Algorithm SHA256` 出摘要，与产物一起作为 Actions artifact 保存。

### 候选归档（非 Release）

首个候选归档由 `windows-latest` 构建，仅用于评审与归档核对。**它不是最终 Release 产物**：host 接线缺口修复合并后必须按修复后的精确 main 提交重建。

| 项 | 值 |
| --- | --- |
| 基线提交 | `586214cb32c2aa2be05baeae79b02bbc8b33941f` |
| ZIP | `HDSL-0.0.0-win32-x64-586214c-portable.zip` |
| SHA-256 | `05f9684bb81da1de6b63dd42daa524f908f5e7694bde1aa6d819cd2da8f8e0cf` |
| 大小 | 165,248,959 字节 |
| 归档核对 | PASS：19 个必需文件存在，无禁止内容（未执行 exe） |
| 构建环境 | Windows runner，Node `24.21.0`，pnpm `11.7.0`，Electron `44.4.3` |

## 构建

打包声明在 `apps/desktop/package.json` 的 `build` 字段（`appId: dev.hdsl.launcher`、`productName: HDSL`、`asar: false`、`directories.output: release`、`win.target: [{ target: dir, arch: [x64] }]`）。选择与理由：

- 只声明 `dir` 目标：`dir` 不产生安装器；NSIS/Squirrel 需要额外配置，且在非 Windows 主机上需要 wine。`electron-winstaller`（electron-builder 的传递依赖，仅用于 Squirrel 安装器）的安装脚本已按 `pnpm-workspace.yaml` 的 `allowBuilds` 显式关闭。
- `asar: false`：主进程是 ESM（`"type": "module"`，入口 `dist/main/index.js`），本仓尚未验证 Electron 44 在 asar 内加载 ESM main 与 `preload/bridge.cjs` 的行为；无实机证据前保持目录可核对，是更小的未知面。

命令（仓库根目录）：

```bash
pnpm install --frozen-lockfile
pnpm run package:win        # = pnpm run build:desktop && pnpm --filter @hdsl/desktop run package:win
```

桌面包内的实际打包指令是 `electron-builder --win --x64 --dir`，输出到 `apps/desktop/release/win-unpacked/`。CI 侧由 [windows-portable-build.yml](../../.github/workflows/windows-portable-build.yml) 在 `windows-latest` 上执行同一组命令，再把 `win-unpacked` 复制为 `HDSL-<version>-win32-x64` 目录并压缩为 ZIP。

该工作流是**受控、仅构建**的：`permissions: contents: read`，不含签名/发布凭据，不创建 Release，保留 14 天 artifact；触发为 `workflow_dispatch` 与打包相关路径的 `push`。它只输出候选归档：Windows 上不运行任何测试（单元/集成/实机均不运行），只做构建、归档完整性核对与摘要计算。

## 归档完整性核对（只读，不执行 exe）

```bash
node apps/desktop/scripts/verify-win-package.mjs apps/desktop/release/win-unpacked
```

该脚本只遍历文件树，**不启动 `HDSL.exe`、不运行被测应用、不运行 Windows 测试**。档案必须同时满足“必须存在”和“必须不存在”两组规则：

- 必须存在：`HDSL.exe`；`resources/app/package.json`；`dist/main/index.js`、`dist/preload/bridge.cjs`、`dist/renderer/{index.html,app.js,styles.css}`；生产 workspace 模块 `@hdsl/{contracts,core,runtime}` 的 `dist/index.js`；`@hdsl/runtime/dist/catalog/dependency-closure.js`；运行期静态 catalog `@hdsl/runtime/catalog/dsh-0.1.5-rc.2/closure.json` 与 `dsh-0.1.7-rc.1/closure.json`；声明的生产依赖 `react`、`react-dom`、`yaml`。
- 静态 catalog 必须随包：`dependency-closure.ts` 用 `import.meta.url` 解析 `../../catalog/dsh-<version>`，所以 JSON 位于 `@hdsl/runtime` 包根旁（`packages/runtime/package.json` 的 `files` 同时列出 `dist` 与 `catalog`），不在 `dist` 内。
- 必须不存在：`dist/main/qa-entry.js`（QA 测试入口）、`dist/**/*.map`、`resources/app/src/**`（未构建源码）、工作区清单（`pnpm-lock.yaml`/`pnpm-workspace.yaml`）、`.git` 元数据、`*.log`、诊断导出、`.credentials.yaml` 或 `.hdsl/` 用户数据、`pnpm-cache`/`.cache`/`.scratch`、以及 `electron`/`electron-builder`/`typescript`/`vitest`/`esbuild`/`@types` 等开发依赖目录。

摘要校验（解压前）：

```bash
sha256sum -c SHA256SUMS.txt                  # bash / WSL
Get-FileHash -Algorithm SHA256 .\HDSL-*.zip  # PowerShell，与文件内大写十六进制比对
```

`SHA256SUMS.txt` 为 `sha256sum` 兼容格式（小写摘要 + 两个空格 + 文件名），`build-info.txt` 记录基线提交、平台、Node/pnpm/Electron 版本、打包命令与“未签名 / 无 Windows 主机证据”声明。

## Windows 支持边界（准确版本）

产物能启动成什么样，取决于下面这些仍然生效的门禁。它们**没有**为出包而放宽：

1. `packages/contracts/src/platform.ts`：`VERIFIED_HOSTS` 仅 `[{ platform: 'darwin', arch: 'arm64' }]`。未列出的宿主按设计是“不支持，而不是未测”；`unsupportedCombinationReason` 在宿主未验证时返回 `UNSUPPORTED_COMBINATION`。
2. `packages/runtime/src/catalog/combinations.ts`：目录只登记 macOS ARM64 的 Node/DSH 精确摘要（`22.19.0`/`24.21.0` 与 `0.1.5-rc.2`/`0.1.7-rc.1`），**没有任何 win32 产物**。
3. `packages/core/src/data-root-lock.ts`：`VERIFIED_LOCK_PLATFORMS = ['darwin', 'linux']`。win32 上只有 guarded stale takeover 被显式拒绝（`isLockPlatformVerified` 为 false，`platformVerified: false` 表示不声明跨进程独占），正常 acquire/release/heartbeat 路径不因此拒绝，**启动不在这里失败**。
4. `packages/runtime/src/credentials/injection.ts`：win32 直接抛 `CredentialFailure('UNSUPPORTED_PLATFORM')`（“Windows Credential Manager resolution is not implemented or tested in this slice”），经 `packages/runtime/src/credentials/port.ts` 映射为 `UNSUPPORTED_COMBINATION`。该 provider 在每次 `environments.start` 解析时惰性构建，因此**不影响启动**，只让启动已存在的环境失败。

### 已发现的缺口：桌面入口没有上报真实宿主（由单独变更修复，本 PR 未修改）

`apps/desktop/src/main/app.ts` 的 `bootstrap` 调用 `createDesktopComposition` 时没有传 `host`，而 `packages/core/src/creation-service.ts` 与 `packages/runtime/src/install/runtime-port.ts` 都回退到硬编码默认值 `{ platform: 'darwin', arch: 'arm64' }`。后果：在 win32 上 `environments.create` / `environments.switchVersion` 的宿主守卫会以 `darwin/arm64` 判定通过，**不会**得到干净的 `UNSUPPORTED_COMBINATION`，而是在下载/解压/执行 darwin-arm64 Node 产物阶段失败。

因此当前的准确表述是：**DSH 创建/安装在此构建上既不是“已被平台契约拒绝”，也不是“已被支持”**——它会在错误的宿主判定下推进到产物阶段再失败；win32 凭据解析则是 fail-closed 的。

该缺口的修复需要单独变更与独立验证（不能为出包放宽任何安全门），并且不改变 Windows 支持范围。修复合并后：

- 生产桌面会以真实宿主（例如 `win32/x64`）进入守卫，`environments.create` / `environments.switchVersion` 应得到干净的 `UNSUPPORTED_COMBINATION`；
- **本记录当前的描述会成为历史**，必须在此处更正为修复后的真实行为，而不是保留“未验证路径”的说法；
- 由于行为改变，需要按修复后的精确 main 提交**重建**候选归档与摘要，当前 586214c 的归档不能作为最终 Release 产物。

定位证据（供修复变更使用，均为只读引用）：`apps/desktop/src/main/app.ts` 的 `bootstrap` 在 `createDesktopComposition({ dataRoot, appInfo, openWebUi, pathChooser, lockWaitTimeoutMs })` 中只把真实平台放进 `appInfo`（仅用于展示/来源信息），传递的键集不含 `host`；`apps/desktop/src/main/composition.ts` 的 `host` 为可选入参，只在定义时转发给 `EnvironmentService` 与 `createEnvironmentContractPort`，而 `createRuntimePort(PRODUCTION_RUNTIME_OPTIONS)` 从不接收 host；默认值来自 `packages/core/src/creation-service.ts` 与 `packages/runtime/src/install/runtime-port.ts`；派发侧在 `packages/contracts/src/dispatcher.ts` 用 `runtime.port.host` 调用 `unsupportedCombinationReason`，该宿主经 `packages/core/src/contract-port.ts` 取自 `service.host`。

## 未验证边界

- 未在 Windows 实机启动、未操作界面、未创建或启动任何环境；`HDSL.exe` 只在 CI 里作为文件被核对。
- 未签名、未公证；SmartScreen/Defender 表现、首次启动、主流程均未知。
- 无 Windows 单元/集成测试证据：Windows runner 只做构建、归档完整性核对与摘要计算。
- 无安装器、无自动更新、无完成度声明；`.zip` 之外没有其他分发形态。
- [#8](https://github.com/YingkeSu/HDSL/issues/8) 保持开放；本记录不改变 T008b 的未测事实。
- 版本号仍为 `0.0.0`；归档名中的 `<version>` 会随版本决策变化，而 `<sha7>` 才是可复现的锚点。

相关：[macOS 内测准备](macos-internal-readiness.md)、[工具链](tooling.md)、[测试指南](testing.md)、[ADR 0007](../adr/0007-macos-acceptance-and-internal-distribution.md)。
