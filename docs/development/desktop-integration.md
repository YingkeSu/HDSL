# 桌面接线与运行入口（T006 / issue #6）

状态：**实现完成，本地类型/构建/单测与 macOS Electron 冒烟已执行**；真实 UI 主流程 E2E 与
独立安全 review 归后续任务。基线 `origin/main cd8ca74`；本文件与 `apps/desktop/**`、
`tests/desktop/**` 为本次实现所有权；`tests/e2e/**` 与 `docs/development/desktop-validation.md`
归独立 QA（hdsl-25）。

## 组合根

`apps/desktop/src/main/composition.ts` 用已合入的库接线，不重写 core/runtime：

```text
@hdsl/runtime createRuntimePort() ──┐
                                     ▼
EnvironmentService(dataRoot, catalog, runtime, exportDiagnostics)
  ├─ open() 取得 dataRoot 独占租约（与 #43 一致）
  ├─ buildManagedProcessPort(service, dataRoot):
  │    createLaunchCredentialPort({ load: service.launchCredentialRequest })
  │    → createProcessManager({ credentials, onProcessExit: service.handleProcessExit,
  │                            isRecoveryPermitted: () => service.available })
  │    → adaptProcessPort（把 runtime 的 phase 字符串收窄回 core 的四个受管阶段）
  │    → verifyOpenWebUI（只做自有进程 + loopback 校验，不做副作用）
  ├─ attachProcess(...) → recover()（重启对账：adopt→running，其余→stopped）
  └─ createEnvironmentContractPort(...) → createContractRuntime(每窗口独立)

每个窗口：DesktopIpcHost 独立 SubscriptionRegistry + ContractRuntime
```

`openWebUI` 的成功绑定见下节：契约方法仍同步返回 token-free `{ loopbackOrigin }`，
真正打开由 main 在 IPC 前置钩子中 `await` 认证 opener 后再 dispatch。

## 构建与启动

```bash
pnpm install --frozen-lockfile        # Node 必须满足 engines（本项目 24.21.0 / >=26）
pnpm run build:desktop                # tsc -b + renderer bundle(esbuild)
node apps/desktop/scripts/smoke-electron.mjs [--data-root <dir>]
```

- 工具链：Node 24.21.0（`.nvmrc`）或 Node 26（homebrew）；pnpm 11.7.0（`packageManager`）。
  Node 25 不受 engines 支持，`pnpm install` 会 fail-closed。
- `build:desktop` = `pnpm run build`（tsc） + `pnpm run build:renderer`
  （`apps/desktop/scripts/build-renderer.mjs`，esbuild 0.28.2 打包 `browser-entry.ts` →
  `dist/renderer/app.js`，并复制 `index.html`/`styles.css`）。
- 手工启动：`<electron> apps/desktop --hdsl-data-root <dir> --remote-debugging-port=9333`。
  `package.json main = dist/main/index.js`（ESM，Electron 44.4.3）。
- AO 预览不适用（Electron 原生窗口，不是静态页）。

## dataRoot 与单实例/独占

- 解析优先级：`--hdsl-data-root <path>` > `HDSL_DATA_ROOT` > Electron `userData`。
- 双重门禁：`app.requestSingleInstanceLock()`（同 userData 的第二进程直接退出）**与**
  core 跨进程 dataRoot 独占租约（`service.open()`，等待 1500 ms）。
- 拿不到租约：原生错误框 + 退出，不提供可变更 UI；变更类调用返回 `ENVIRONMENT_BUSY`。
- 退出：`before-quit` 先 `service.close()`（停止自有进程树 → 释放租约）；close 失败
  `released: false`，**保留锁**并提示，下次启动 recover 对账。

## 窄 IPC 与 sender 校验

- 通道：`hdsl:contract`（请求/响应 envelope）、`hdsl:selection`（renderer→main 单向选择）、
  `operation.updated`（main→renderer 推送）。三者定义在 `apps/desktop/src/ipc-channels.ts`，
  运行时 preload（`src/preload/bridge.cts`，sandbox 下必须是 CJS）用字面量并由
  `tests/desktop/preload-surface.test.ts` 钉死。
- preload 只暴露 `window.hdsl = { call(request), onOperationUpdated(listener), selectEnvironment(environmentId) }`；
  无通用 `send`/`invoke`/`on`。
- `webPreferences` = `SECURE_WINDOW_DEFAULTS`（`contextIsolation: true`、
  `nodeIntegration: false`、`sandbox: true`）+ `preload: dist/preload/bridge.cjs`。
- sender 校验：仅本进程创建的窗口、仅 main frame、frame URL 前缀等于 renderer index 的 file URL；
  子 frame/未知窗口/外来 URL 返回受控 `INTERNAL_ERROR` envelope。
- 导航：`setWindowOpenHandler` 全拒、`will-navigate` 仅允许 renderer URL、webview 拒绝
  （`src/main/security.ts`）。
- **DSH WebUI 不在 Electron 窗口加载**：`openWebUI` 只返回 token-free origin，真开由 main 原生进行。

## WebUI 原生打开（含 main-only bootstrap 窄接点）

- 冻结契约 `environments.openWebUI` 同步返回 `{ loopbackOrigin }`。
- 前置校验：`ProcessManager.openWebUI(envId)` 必须证明“当前自有进程（pid+startToken+command）+
  loopback”；main 再校验 `isLoopbackOrigin`。
- 打开：`apps/desktop/src/main/webui.ts` 的 `createVerifiedWebUiOpener` 使用 runtime 已在 main 提供的
  `ProcessManager.consumeWebUIBootstrap(envId, open)`（mergeCommit
  `a16146c3b4578889bd72f6d0afd226b74f737935`，PR #67；未改冻结 contracts/core）。它是 async
  且 `await` open 回调，因此 main 在 IPC 前置钩子里 await 结果后才 dispatch，**不会先回 `opened: true`
  再异步失败**；回调抛错映射受控 `INTERNAL_ERROR`，URL 不回显。同 `requestId` 重放时先查幂等
  账本，跳过前置打开，由 dispatcher 返回原结果，不重复开页。
- bootstrap URL 只经回调交给 `shell.openExternal`，不写 record/日志/错误/事件/诊断/renderer。
- runtime 未提供该方法（旧版或 adopt/重启无内存 bootstrap）时返回 `WEBUI_UNAVAILABLE`，
  **不回退打开会 401 的 token-free origin**。
- 真实浏览器 cookie/交互验证归 QA/实机（见下“未验证”）。

## 脱敏诊断导出

- `diagnostics.export`：main 原生 `dialog.showSaveDialogSync` 选路径，写 `0600`，
  只返回 `{ exportId, exported: true, redacted: true }`（不含路径）。
- 白名单（`src/main/diagnostics.ts`）：app 版本/平台、environment 摘要、install manifest、
  活动代际 `composition.lock.json`、该环境 operation 记录、launch 摘要。
- 显式排除且**从不读取**：`<env>/credentials.json`、`<generation>/home/.credentials.yaml`、
  `home/logs/**`、`home/sessions/**`、任何 secret 值。所有字符串先做 dataRoot/generation
  home 路径替换，再 `redactSecretValues`，再 `sanitizeBoundedMessage`（`secret=`/`token=`/
  `Bearer`/绝对路径）；对象键名含 secret/token/cookie 的一律丢弃。
- canary 负向：`tests/desktop/main-diagnostics.test.ts` 在 credentials.json、`.credentials.yaml`、
  home/logs、sessions 放 canary，并在 operation error/manifest stdout/composition URL 注入 canary，
  断言导出文件不含 canary、不含排除文件名、不含 dataRoot 原文。
- 幂等：`requestId` 重放由 dispatcher 账本返回原 `ExportResult`，不再弹窗/覆盖文件。

## 凭据引用配置（主进程原生菜单，ADR 0004）

用户操作：

1. 在窗口环境列表中选择目标环境（选择会上报给 main 并校验存在）。
2. 菜单「环境 → 导入环境凭据引用…」（无选中时该菜单项禁用；执行前重新读取环境与 state）。
3. 原生文件对话框选择 JSON 配置文件。

配置格式（只含变量名与 OS 凭据引用，**没有放 secret 值的位置**）：

```json
{
  "schemaVersion": "1",
  "bindings": [
    {
      "name": "DEEPSEEK_API_KEY",
      "reference": { "id": "cred-…", "store": "keychain", "key": "service#account" }
    }
  ]
}
```

限制与失败提示：≤16 KiB；`bindings` 1–32；变量名不得保留/重复/非法；当前实现仅 `keychain`；
未知字段（含 `value`/`secret`）拒绝；环境 running/starting/stopping 拒绝。失败为原生错误框，
只显示阶段与受控原因；成功只显示条数与“仅存引用、不读写 secret、不复制原文件”。
无引用的环境启动时 main 只读预检并弹原生提示，指向该菜单；启动仍按 fail-closed 失败。

## 运算符/QA 钩子（非用户功能，未设置则完全惰性）

| 环境变量 | 作用 |
| --- | --- |
| `HDSL_DATA_ROOT` / `--hdsl-data-root` | 指定隔离 dataRoot |
| `HDSL_DIAGNOSTICS_EXPORT_PATH` | 用固定路径替代导出保存对话框（headless 确定性） |
| `HDSL_CREDENTIAL_IMPORT_PATH` | 替代导入文件选择对话框（路径来自运算符，不来自 renderer） |
| `HDSL_CREDENTIAL_IMPORT_ENVIRONMENT` | 与上一项同设时，启动后对该已验证环境静默导入一次；只在 stderr 输出 `[hdsl] credential-import hook: applied/rejected …`（无路径/无 secret） |

钩子仍走同一严格校验与既有 `writeEnvironmentCredentials`，不绕过引用/状态守卫。

## QA 对接（供 tests/e2e 复用）

- 启动：`node apps/desktop/scripts/smoke-electron.mjs --data-root <dir>`；脚本默认
  `--remote-debugging-port=9333`，轮询 `http://127.0.0.1:9333/json`，通过 CDP
  `Runtime.evaluate` 断言；成功退出码 0、失败 1，并打印 JSON 结果 + Electron 输出。
- 稳定就绪信号：等 CDP page target 出现后再等 ~1.5 s，断言
  `document.getElementById('root').textContent.length > 0`；`window.hdsl` 三成员精确为
  `call,onOperationUpdated,selectEnvironment`，且 `window.require/process/ipcRenderer` 均 undefined。
- 受控拒绝可观测形式：协议层一律是受控 envelope（`{ ok:false, apiVersion, error:{ code, … } }`），
  CDP 断言 `code`；单实例第二进程是**进程退出**（`requestSingleInstanceLock`）；dataRoot 被占用是
  原生错误框 + 退出（无 envelope），可用退出码/stderr 观测。失锁后的变更调用返回 `ENVIRONMENT_BUSY`。
- 诊断导出：设 `HDSL_DIAGNOSTICS_EXPORT_PATH`，通过 `window.hdsl.call({apiVersion:'1.0',
  method:'diagnostics.export', input:{ requestId, environmentId }})` 触发，断言返回
  `{ exportId, exported:true, redacted:true }` 并检查文件内容。
- 凭据导入：设 `HDSL_CREDENTIAL_IMPORT_PATH` + `HDSL_CREDENTIAL_IMPORT_ENVIRONMENT` 走静默启动钩子；
  或在有 GUI 的会话中手动点原生菜单。revision/state 守卫拒绝体现在凭据记录未写入 + 钩子 stderr
  `rejected at apply`（native 菜单路径为原生错误框）。

## 已验证证据（本地，macOS `Darwin 25.3.0 arm64`）

- 工具链：Node v26.8.1 + pnpm 11.7.0（仓库 `.nvmrc` 为 24.21.0；CI 用该版本）。
- `pnpm run typecheck`：通过。
- `pnpm run build` + `pnpm run build:renderer`：通过（`dist/preload/bridge.cjs`、
  `dist/renderer/app.js` 生成）。
- `pnpm run test`：**60 passed / 5 skipped，661 tests**（含新增 `tests/desktop/**` 8 文件；
  合并后的 e2e/integration 场景按各自 skip 规则跳过）。
- `python3 scripts/check_repository.py`：PASS（27 files / 42 docs / 86 links / 6 JSON / 8 req / 8 tasks）。
- 真实 Electron 冒烟（`smoke-electron.mjs`，Electron 44.4.3）：
  `hasBridge:true`、成员精确 `call,onOperationUpdated,selectEnvironment`、
  `window.require/process/ipcRenderer` 均 false、`rootTextLength:209`，退出码 0。

## 未验证 / 缺口（不得读作已完成）

- 真实 UI 主流程 E2E（创建→选择→启停→进度→错误）、真实 DSH 安装与进程、真实 keychain 解析与
  `service#account` 成功路径：归 QA `tests/e2e/**` 与 T008 实机证据。
- 认证 WebUI 打开的端到端浏览器 cookie/交互：runtime PR #67（`a16146c`）已合入本分支，接线与
  `openVerifiedWebUi` 单元语义已验证；真实浏览器 cookie 建立后的可用页与真实 DSH 进程归 QA/实机。
  本任务不使用 HTTP 303/200 替代真实可用页。
- 主进程凭据导入入口的真实原生菜单/对话框执行与专职安全 review：见 ADR 0004「待验证」。
- Windows x64：未实现、未测（M2 边界）。
- 无独立安全 reviewer 在本会话执行；PR 需由编排指派安全 review。
