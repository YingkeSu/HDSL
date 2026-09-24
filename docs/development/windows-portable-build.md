# Windows x64 打包：便携 ZIP 与 NSIS 安装包（未签名 · 未实机验证）

本记录说明 HDSL 当前可交付的两个 Windows x64 产物：Electron 桌面壳的未签名便携 ZIP，以及未签名的 NSIS `.exe` 安装包，以及它们**不能**做什么。范围仅限打包、归档完整性与安装/卸载文件布局；Windows 运行时适配与实机验收仍属 [#8](https://github.com/YingkeSu/HDSL/issues/8)（T008b，见 [路线图](roadmap.md)）与 [ADR 0007](../adr/0007-macos-acceptance-and-internal-distribution.md)。安装器任务见 [#160](https://github.com/YingkeSu/HDSL/issues/160)。

结论先行：**这是实验性桌面构建。启动未验证；DSH 环境创建/安装既未被平台契约正确拒绝，也未获得支持——它会在 win32 上沿未验证路径推进到产物阶段才失败（见下方“已发现的缺口”）。** 不要把它描述为“Windows 版本已可用”，也不要描述为“win32 已被契约拒绝”。

本记录随构建候选一起合入；桌面入口未上报真实宿主的缺口由**单独变更**负责修复，修复合并后本记录的状态描述需要同步更正（见“已发现的缺口”）。当前 CI 归档只是**候选产物**（Artifact + SHA256），**最终 Release 的前置条件是：host 接线修复合并、根 README 更新合入，然后在精确 `main` 提交上重建并记录新摘要**；发布渠道为 `windows-preview`，不是完整 MVP 发布。

## 产物形态

| 项 | 值 |
| --- | --- |
| 目标 | `win32` / `x64` |
| 形态 | ① 便携 ZIP（解包目录打包）；② NSIS `.exe` 安装包。两者**均未签名、未公证、无自动更新** |
| 解包顶层目录 | `HDSL-<version>-win-x64/` |
| ZIP 名（CI 生成） | `HDSL-<version>-win-x64-<sha7>-portable.zip`，`<sha7>` 为构建基线提交前 7 位；artifact 名 `hdsl-win-x64-portable-<完整提交>` |
| 安装器名（CI 生成） | `HDSL-<version>-win-x64-<sha7>-setup.exe`；artifact 名 `hdsl-win-x64-installer-<完整提交>`；electron-builder 原始名 `HDSL-<version>-win-x64-setup.exe`（工作流补 `<sha7>`） |
| 安装器配置 | `nsis`：`oneClick: false`、`perMachine: false`、`allowToChangeInstallationDirectory: true`、`deleteAppDataOnUninstall: false`（见下） |
| 组件 | Electron `44.4.3`（`apps/desktop` 的 `devDependencies`，由 electron-builder 从官方发行包下载） |
| `<version>` 来源 | `apps/desktop/package.json` 的 `version`；当前为 `0.1.0-preview.1`（本轮不改版本号） |
| 发布渠道 | `windows-preview`（未签名、未实机验证的预览归档，不等于完整 MVP 发布） |
| 计划标签 | 发布时由维护者按当次版本决定（不使用 contracts 或其他无关标签；本轮不打 tag、不发 Release） |

签名与公证不作为当前门槛（ADR 0007 决策 5）；本机 `security find-identity -v -p codesigning` 仍为 `0 valid identities`，仓库内不存在签名身份。ZIP 与安装器均以工作流内 `Get-FileHash -Algorithm SHA256` 出摘要，与产物一起作为 Actions artifact 保存。`nsis` 目标不声明 `certificateFile`：产物是明确的**未签名安装器**，Windows SmartScreen 可能提示「未知发布者」，需点「更多信息 → 仍要运行」；不要为此关闭系统全局安全设置。

### 候选归档（非 Release，旧命名）

首个候选归档由 `windows-latest` 构建，仅用于评审与归档核对。**它不是最终 Release 产物**：host 接线缺口修复与根 README 合入后，必须按修复后的精确 `main` 提交重建（命名采用上表的 `win-x64` 形式；下表记录的是当时实际产出的旧命名）。

| 项 | 值 |
| --- | --- |
| 基线提交 | `586214cb32c2aa2be05baeae79b02bbc8b33941f` |
| ZIP（旧命名） | `HDSL-0.0.0-win32-x64-586214c-portable.zip` |
| SHA-256 | `05f9684bb81da1de6b63dd42daa524f908f5e7694bde1aa6d819cd2da8f8e0cf` |
| 大小 | 165,248,959 字节 |
| 归档核对 | PASS：19 个必需文件存在，无禁止内容（未执行 exe） |
| 构建环境 | Windows runner，Node `24.21.0`，pnpm `11.7.0`，Electron `44.4.3` |

## 构建

打包声明在 `apps/desktop/package.json` 的 `build` 字段（`appId: dev.hdsl.launcher`、`productName: HDSL`、`asar: false`、`directories.output: release`）。Windows 声明两个目标：`win.target: [{ target: dir, arch: [x64] }, { target: nsis, arch: [x64] }]`。选择与理由：

- `dir`（便携 ZIP 的来源）：`--dir` 只产出解包目录，CI 再打包为 ZIP；用于便携分发与归档完整性核对。
- `nsis`（`.exe` 安装器）：electron-builder 内置 NSIS 目标，在 `windows-latest` 上由官方工具链构建，**不需要**本机 wine。选择 `oneClick: false`（向导式安装）、`perMachine: false`（按用户安装，不需提权）、`allowToChangeInstallationDirectory: true`（可选目录，也便于 CI 静默装到隔离目录）、`deleteAppDataOnUninstall: false`（卸载**不**默认删除用户数据）。`electron-winstaller`（传递依赖，仅用于 Squirrel 安装器）仍按 `pnpm-workspace.yaml` 的 `allowBuilds` 显式关闭；本仓库不使用 Squirrel。
- `asar: false`：主进程是 ESM（`"type": "module"`，入口 `dist/main/index.js`），本仓尚未验证 Electron 44 在 asar 内加载 ESM main 与 `preload/bridge.cjs` 的行为；无实机证据前保持目录可核对，是更小的未知面。

命令（仓库根目录）：

```bash
pnpm install --frozen-lockfile
pnpm run package:win          # 便携目录，跨平台可构建
pnpm run package:win:nsis     # NSIS 安装器，Windows 主机上可完整产出
```

桌面包内的打包指令分别是 `electron-builder --win --x64 --dir`（输出 `apps/desktop/release/win-unpacked/`）与 `electron-builder --win nsis --x64`（输出 `apps/desktop/release/HDSL-<version>-win-x64-setup.exe`）。`--dir` 与显式目标名互不干扰：`package:win` 只产目录，`package:win:nsis` 只产安装器。macOS/Linux 上构建 NSIS 需要额外工具链，本仓库只在 `windows-latest` 上构建安装器。

CI 侧由 [windows-portable-build.yml](../../.github/workflows/windows-portable-build.yml) 执行：

- job `portable-zip`：`pnpm --filter @hdsl/desktop run package:win`，把 `win-unpacked` 复制为 `HDSL-<version>-win-x64` 目录并压缩为 ZIP；产出 `SHA256SUMS.txt` 与 `build-info.txt`。
- job `nsis-installer`：`pnpm --filter @hdsl/desktop run package:win:nsis`，核对安装器文件格式，执行静默安装/升级/卸载验收，再重命名为 `HDSL-<version>-win-x64-<sha7>-setup.exe`；产出 `SHA256SUMS-installer.txt` 与 `build-info-installer.txt`。
- job `verify-linux-checksums`（`ubuntu-latest`）：下载两个 artifact，用 GNU `sha256sum -c` 消费 `SHA256SUMS.txt` 与 `SHA256SUMS-installer.txt`，并断言无 CR。这是发布 publish 与用户侧校验的真实消费者测试（仅靠写文件时的字符串断言不够）。

该工作流是**受控、仅构建**的：`permissions: contents: read`，不含签名/发布凭据，不创建 Release，保留 14 天 artifact；触发为 `workflow_dispatch` 与打包相关路径的 `push`。Windows 上不运行单元/集成测试；`portable-zip` 只做构建与归档完整性核对；`nsis-installer` 额外在隔离 runner 上静默运行安装器/卸载器以取得安装/卸载**文件布局**证据，但**不启动已安装的 GUI 应用**，因此不是 Windows 主机或 GUI 验收。

## 归档完整性核对（只读，不执行 exe）

```bash
node apps/desktop/scripts/verify-win-package.mjs apps/desktop/release/win-unpacked
```

该脚本只遍历文件树，**不启动 `HDSL.exe`、不运行被测应用、不运行 Windows 测试**。档案必须同时满足“必须存在”和“必须不存在”两组规则：

- 必须存在：`HDSL.exe`；`resources/app/package.json`；`dist/main/index.js`、`dist/preload/bridge.cjs`、`dist/renderer/{index.html,app.js,styles.css}`；生产 workspace 模块 `@hdsl/{contracts,core,runtime}` 的 `dist/index.js`；`@hdsl/runtime/dist/catalog/dependency-closure.js`；运行期静态 catalog `@hdsl/runtime/catalog/dsh-0.1.5-rc.2/{closure.json,package.json,package-lock.json}` 与 `dsh-0.1.7-rc.1/{closure.json,package.json,package-lock.json}`；声明的生产依赖 `react`、`react-dom`、`yaml`；以及 `extraResources` 携带的 `resources/LICENSE.hdsl.txt` 与 `resources/THIRD_PARTY_NOTICES.md`。
- 静态 catalog 必须随包：`dependency-closure.ts` 用 `import.meta.url` 解析 `../../catalog/dsh-<version>`，所以 JSON 位于 `@hdsl/runtime` 包根旁（`packages/runtime/package.json` 的 `files` 同时列出 `dist` 与 `catalog`），不在 `dist` 内。
- **catalog 的 `package-lock.json` 必须用 `extraResources` 补回**：`readDependencyClosure` 同时读 `closure.json`、`package.json` 与 `package-lock.json`，任一缺失就返回 `undefined`，环境创建会以 `INTERNAL_ERROR`（“no audited dependency closure”）失败；而 electron-builder 的默认 `excludedNames` 会剔除 app 树里**所有** `package-lock.json`。因此 `build.extraResources` 从 `../../packages/runtime/catalog` 以 `filter: [dsh-*/package-lock.json]` 复制回 `app/node_modules/@hdsl/runtime/catalog`（不因此带回 `service-verifications` 审查数据）。已验证：本机 macOS ARM64 打包后 `readDependencyClosure('0.1.7-rc.1')` 在包内返回有效 closure。
- 必须不存在：`dist/main/qa-entry.js`（QA 测试入口）、`dist/**/*.map`、`resources/app/src/**`（未构建源码）、工作区清单（`pnpm-lock.yaml`/`pnpm-workspace.yaml`）、`.git` 元数据、`*.log`、诊断导出、`.credentials.yaml` 或 `.hdsl/` 用户数据、`pnpm-cache`/`.cache`/`.scratch`、以及 `electron`/`electron-builder`/`typescript`/`vitest`/`esbuild`/`@types` 等开发依赖目录。

安装器文件格式核对（只读，不执行安装器）：

```bash
node apps/desktop/scripts/verify-win-package.mjs --installer apps/desktop/release/HDSL-<version>-win-x64-<sha7>-setup.exe
```

该检查只读取文件头与签名块：要求文件达到 Electron NSIS 安装器的合理大小、具备 Windows PE 的 `MZ` 头与 `PE\0\0` 签名，并包含 NSIS 的 `NullsoftInst` 签名标记。最后一条正是「不是把 `win-unpacked/HDSL.exe` 改名」的可执行判据：便携 exe 也是 PE 文件，但没有 `NullsoftInst` 标记，会被拒绝。它**不执行安装器**。（可执行文件版本资源中的 `CompanyName` 与产品身份由 #149 / PR #153 负责，本检查不替代它。）

`--audit` 模式在路径规则之外对有界内容做扫描（跳过二进制与超大文件，**只输出规则 id 与相对路径，不输出匹配到的明文**）：

```bash
node apps/desktop/scripts/verify-win-package.mjs --audit apps/desktop/release/win-unpacked   # 便携目录
node apps/desktop/scripts/verify-win-package.mjs --audit <已安装目录>                          # NSIS 实际安装 payload
```

内容标记限于高信号、低误报的几类：测试专用环境变量名（如 `HDSL_QA_REAL_INSTALL`）、私钥块、AWS access key 前缀与 GitHub token 前缀；正常的 `apiKey`/`secret`/`127.0.0.1` 等生产字符串不会误报。`nsis-installer` job 在第 1 步静默安装后对**已安装目录**同时运行路径规则与 `--audit`，因此审计对象是 NSIS 安装器实际落盘的 payload，而不是 `win-unpacked` 配置推导。

摘要校验（解压前）：

```bash
sha256sum -c SHA256SUMS.txt                  # bash / WSL
Get-FileHash -Algorithm SHA256 .\HDSL-*.zip  # PowerShell，与文件内大写十六进制比对
```

`SHA256SUMS.txt` / `SHA256SUMS-installer.txt` 为 `sha256sum` 兼容格式（小写摘要 + 两个空格 + 文件名，**LF 行尾、无 BOM**——Windows 的 `Set-Content` 默认 CRLF 并可能带 BOM，会让 Ubuntu publish 的 `sha256sum -c` 与用户侧校验失败，故工作流用 `[System.IO.File]::WriteAllText(..., UTF8Encoding(false))` 显式写 LF；每个 job 还用 `apps/desktop/scripts/verify-checksum-file.mjs` 对**真实产物文件**做字节级检查，并用一个 CRLF 控制文件证明该检查会拒绝，再由 `verify-linux-checksums` 用 GNU `sha256sum -c` 消费）；`build-info.txt` 与 `build-info-installer.txt` 分别记录便携 ZIP 与安装器的 artifact 名、版本、完整基线提交、平台、Node/pnpm/Electron 版本、打包命令、发布渠道、安装器选项与“未签名 / 无 Windows GUI 证据”声明。

## 静默安装 / 升级 / 卸载验收（一次性 CI runner）

`nsis-installer` job 在 `windows-latest` 的隔离临时目录中执行：

1. `installer.exe /S /D=<隔离目录>` 静默安装，核对 `HDSL.exe` 存在，并对**已安装目录**运行 `verify-win-package.mjs <隔离目录>`（与便携 ZIP 相同的生产内容规则）。
2. 在 `%APPDATA%\HDSL`、`%APPDATA%\@hdsl\desktop` 与 `%LOCALAPPDATA%\HDSL` 放置哨兵文件，再原地重跑安装器，验证**升级不删除用户数据**。
3. `Uninstall HDSL.exe /S` 静默卸载，等待 `HDSL.exe` 消失，确认应用文件已移除且三处哨兵仍在。

这证明的是安装/升级/卸载的**文件布局与用户数据保留**；runner 是一次性隔离环境，**不**证明 GUI 首次启动、主流程、代码签名或 Defender/SmartScreen 行为。`deleteAppDataOnUninstall: false` 与哨兵共同保证「不默认删除用户数据」。

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

- 未在 Windows 实机启动、未操作界面、未创建或启动任何环境；`HDSL.exe` 在 CI 里只作为文件被核对，安装/卸载验收也**不启动** GUI 应用。
- 未签名、未公证；SmartScreen/Defender 表现、首次启动、升级后首次启动与主流程均未知。
- 无 Windows 单元/集成测试证据：Windows runner 只做构建、归档完整性核对、安装/卸载文件布局验收与摘要计算。
- 安装/卸载证据来自一次性 `windows-latest` runner 的静默执行，不是维护者实机 GUI 验收；无自动更新、无完成度声明。
- [#8](https://github.com/YingkeSu/HDSL/issues/8) 保持开放；本记录不改变 T008b 的未测事实。
- 版本号仍为 `0.1.0-preview.1`；归档名中的 `<version>` 会随版本决策变化，而 `<sha7>` 才是可复现的锚点。

相关：[macOS 内测准备](macos-internal-readiness.md)、[工具链](tooling.md)、[测试指南](testing.md)、[ADR 0007](../adr/0007-macos-acceptance-and-internal-distribution.md)。
