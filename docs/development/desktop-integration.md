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

本文中的执行计数与基线描述属于 T006 实现时的记录。后续桌面与原生操作结果见[桌面验证](desktop-validation.md)。

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
- 手工启动：`pnpm --filter @hdsl/desktop exec electron . --hdsl-data-root <dir>`。
  `package.json main = dist/main/index.js`（ESM，Electron 44.4.3）。

## dataRoot 与单实例/独占

- 解析优先级：`--hdsl-data-root <path>` > `HDSL_DATA_ROOT` > Electron `userData`。
- 该 flag 只接受**空格分隔**写法（`resolveDataRoot` 按 `argv.indexOf` + 下一参数取值）；`--hdsl-data-root=<path>` 等号写法**不生效**，会静默回退到 `userData`（表现为“尚无环境”）。
- 双重门禁：`app.requestSingleInstanceLock()`（同 userData 的第二进程直接退出）**与**
  core 跨进程 dataRoot 独占租约（`service.open()`，等待 1500 ms）。
- 拿不到租约：原生错误框 + 退出，不提供可变更 UI；变更类调用返回 `ENVIRONMENT_BUSY`。
- 退出：`before-quit` 先 `service.close()`（停止自有进程树 → 释放租约）。close 成功才正常退出。
  若 `released: false`（未能证明进程停止，或租约未能确认删除），main **不声称进程退出后仍持有锁**：
  显示原生告警后 `app.exit(1)`，仅保留 `lease.json`/launch record 作为**残留证据**。下次启动先
  `recover()`；若存在 `unverifiable` 进程，main 侧**禁止 `environments.create`/`environments.start`**
  （返回受控 `ENVIRONMENT_BUSY` + 原生提示），只保留 stop/读/导出以便人工处置；不得覆盖归属。
  人工处置边界：确认并清理残留进程后重启，由 recover 重新对账。
- 数据目录不可用分支：在显示原生错误框**之前**向 stderr 输出单行固定信号
  `[hdsl] data-root unavailable reason=<busy|unknown>`（`busy` = 另一实例持有；其余 = `unknown`；
  不含路径/owner/PID/hostname/secret/异常文本）；用户关闭错误框后进程以**退出码 1** 结束；
  不向未持锁 dataRoot 写任何 evidence。该信号是生产真实行为，用于无窗口/无 page 时的归因。

## 窄 IPC 与 sender 校验

- 通道：`hdsl:contract`（请求/响应 envelope）、`hdsl:selection`（renderer→main 单向选择）、
  `operation.updated`（main→renderer 操作进度推送）、`environment.updated`（main→renderer 受管
  进程退出后的环境状态投影，issue #108）。四者定义在 `apps/desktop/src/ipc-channels.ts`，
  运行时 preload（`src/preload/bridge.cts`，sandbox 下必须是 CJS）用字面量并由
  `tests/desktop/preload-surface.test.ts` 钉死。
- preload 只暴露 `window.hdsl = { call(request), onOperationUpdated(listener),
  onEnvironmentUpdated(listener), selectEnvironment(environmentId) }`；
  无通用 `send`/`invoke`/`on`。`environment.updated` 只在 core 已把环境置 stopped 且状态确实变化后
  由 main 广播，renderer 按 `stateVersion` 合并（不轮询、不手动刷新）；该投影不代表插件 `ACTIVE` 代改变。
- `webPreferences` = `SECURE_WINDOW_DEFAULTS`（`contextIsolation: true`、
  `nodeIntegration: false`、`sandbox: true`）+ `preload: dist/preload/bridge.cjs`。
- sender 校验与导航共用**精确可信文档 URL**（`src/main/trusted-url.ts`）：仅本进程创建的窗口、
  仅 main frame、`frameUrl` 归一化后必须**完全等于** `dist/renderer/index.html` 的 file URL。
  拒绝前缀路径后缀（`index.html.evil`）、归一化穿越（`index.html/../x`）、编码分隔符（`%2f`/
  `%5c`）、query/hash、子 frame 与未知窗口；协议层返回受控 `INTERNAL_ERROR` envelope。
- 导航：`setWindowOpenHandler` 全拒、`will-navigate` 只允许该精确文档 URL、
  `will-frame-navigate` 拒绝任何子 frame 导航与任何非可信 URL、webview 拒绝
  （`src/main/security.ts`）。
- `ipcMain.handle` 的异步边界整体 `try/catch`：任何 dialog/core 异常都返回固定受控
  `INTERNAL_ERROR` envelope，不把原始异常交给 `invoke`；选择通知也 best-effort 不抛出。
- 账本作用域：幂等账本（`readIdempotency`/`writeIdempotency`）是**进程全局、按 dataRoot 持久化**，
  同一 `requestId` 从不同窗口重放也返回原结果且不重复副作用（冻结契约以 requestId 为幂等键）；
  **订阅注册表是每窗口**，跨窗口订阅 id 互不可见。
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
- 输出原子性：导出写到目标同目录的随机临时文件（`openSync('wx', 0o600)`，预置符号链接或已有文件会失败而不被跟随），`fsync` 后 `rename` 覆盖目标；目标本身若是符号链接，`rename` 替换链接而非写穿。
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

限制与失败提示：打开前先 `O_NOFOLLOW`（拒绝符号链接）、`O_NONBLOCK`（特殊文件不阻塞）、`fstat`
检查常规文件与 ≤16 KiB，再限定读取 16 KiB+1，不做无界读；`bindings` 1–32；变量名不得保留/重复/
非法；当前实现仅 `keychain`；未知字段（含 `value`/`secret`）拒绝；环境 running/starting/stopping 拒绝。
失败为原生错误框，只显示阶段与受控原因；成功只显示条数与“仅存引用、不读写 secret、不复制原文件”。
无引用的环境启动时 main 只读预检并弹原生提示，指向该菜单；启动仍按 fail-closed 失败。

## 测试入口注入（仅测试，生产入口不读任何钩子）

生产入口 `src/main/index.ts` 以默认参数启动 `startDesktopApp`（只有原生菜单 + 原生对话框），**不读**
任何 `HDSL_*` 导入/导出钩子，也不靠 `NODE_ENV` 或任意 env 开关绕过用户确认。
headless QA 使用单独、显式启动的测试入口 `dist/main/qa-entry.js`（非 package `main`，已从发布
`files` 排除）：

```bash
electron apps/desktop/dist/main/qa-entry.js \
  --hdsl-data-root <dir> --user-data-dir <dir> \
  [--hdsl-qa-export-path <file>] \
  [--hdsl-qa-import-path <file>] [--hdsl-qa-import-environment <envId>]
```

| 参数 | 作用 |
| --- | --- |
| `--hdsl-data-root` / `HDSL_DATA_ROOT` | 指定隔离 dataRoot（生产入口允许，用于实例隔离） |
| `--hdsl-qa-export-path` | 固定导出路径，替代原生保存对话框 |
| `--hdsl-qa-import-path` | 固定导入路径，替代原生打开对话框 |
| `--hdsl-qa-import-environment` | 与上一项同设时对该已验证环境启动后静默导入一次；stderr 只输出 `[hdsl] credential-import: applied/rejected at …`（无路径/无 secret） |

测试入口仍走同一严格校验、有界读取与既有 `writeEnvironmentCredentials`，不绕过引用/状态守卫。
这些注入**只算测试列**，正文档不得当原生菜单/对话框验收；后者的真实操作归 \"真实 GUI 操作\"。

## QA 对接（供 tests/e2e 复用）

- 启动：`node apps/desktop/scripts/smoke-electron.mjs --data-root <dir>`；脚本自动分配空闲 CDP
  端口与独立 `--user-data-dir`，轮询 `http://127.0.0.1:<port>/json`，通过 CDP
  `Runtime.evaluate` 断言；成功退出码 0、失败 1，并打印 JSON 结果 + Electron 输出。
- 稳定就绪信号：等 CDP page target 出现后再等 ~1.5 s，断言
  `document.getElementById('root').textContent.length > 0`；`window.hdsl` 四成员精确为
  `call,onEnvironmentUpdated,onOperationUpdated,selectEnvironment`，且 `window.require/process/ipcRenderer` 均 undefined。
- 受控拒绝可观测形式：协议层一律是受控 envelope（`{ ok:false, apiVersion, error:{ code, … } }`），
  CDP 断言 `code`；单实例第二进程是**进程退出**（`requestSingleInstanceLock`）；dataRoot 被占用是
  原生错误框 + 退出（无 envelope），可用退出码/stderr 观测。失锁后的变更调用返回 `ENVIRONMENT_BUSY`。
- 诊断导出：用测试入口 `--hdsl-qa-export-path <file>`，通过 `window.hdsl.call({apiVersion:'1.1',
  method:'diagnostics.export', input:{ requestId, environmentId }})` 触发，断言返回
  `{ exportId, exported:true, redacted:true }` 并检查文件内容。
- 凭据导入：用测试入口 `--hdsl-qa-import-path`（+ `--hdsl-qa-import-environment` 走静默启动导入）；
  或在有 GUI 的会话中手动点原生菜单。revision/state 守卫拒绝体现在凭据记录未写入 + stderr
  `rejected at apply`（native 菜单路径为原生错误框）。
- 重启对账门禁：构造“退出时 `released:false` 且残留不可证进程”后重启，断言 `environments.start`/
  `environments.create` 返回受控 `ENVIRONMENT_BUSY` + 原生提示，stop/读/导出仍可用。

## 已验证证据（本地，macOS 26.3 / `Darwin 25.3.0 arm64`）

- 工具链：Node v26.8.1 + pnpm 11.7.0（仓库 `.nvmrc` 为 24.21.0；CI 用该版本）。
- `pnpm run typecheck`：通过。
- `pnpm run build` + `pnpm run build:renderer`：通过（`dist/preload/bridge.cjs`、
  `dist/renderer/app.js`、`dist/main/qa-entry.js` 生成）。
- `pnpm run test`：**62 passed / 5 skipped，684 tests**（含 `tests/desktop/**` 11 文件）。
- `python3 scripts/check_repository.py`：PASS。
- 真实 Electron 冒烟（`smoke-electron.mjs`，Electron 44.4.3，生产入口）：
  `hasBridge:true`、成员精确 `call,onOperationUpdated,selectEnvironment`、
  `window.require/process/ipcRenderer` 均 false、`rootTextLength:209`，退出码 0。
- 真实 macOS 主流程（composition/main 级，脚本 `apps/desktop/scripts/real-main-flow-evidence.mjs`，
  生产 candidate 后与本批同 commit；用真实 `createRuntimePort()` + 真实 macOS `security` CLI）：
  真实 install（Node 22.19.0 + DSH 0.1.5-rc.2 npm-ci）→ 同一 `applyCredentialFile` 导入引用 →
  start 阶段 `spawning`/`waiting-ready`/`finished` 且 state=running → `openWebUI` 经 Main-only
  `consumeWebUIBootstrap`（bootstrap 303 + Set-Cookie，带 cookie GET origin = 200 / 27660 B）→
  launch record 无 token/canary → diagnostics 不含 canary/`.credentials.yaml`/`credentials.json`/
  dataRoot 原文 → stop=stopped → close released=true → 宿主 `~/.dsh` 递归 `name:size:mtime` 快照前后一致。
  keychain canary 随机 `hdsl-t006-evidence-<hex>#t006`，创建前不存在、secret 经 stdin、
  finally `delete` 退出码 0 并 `find` 断言不存在（exit 44）通过。
- **真实 GUI 操作（原生菜单/保存对话框/点击）不在本表**：归 QA25 与人工；测试注入列不冒充它。

## 未验证 / 缺口（不得读作已完成）

- 当前基线的真实 production Electron macOS ARM64 验收（创建/选择/启停、窄桥、sender/iframe 隔离、
  diagnostics canary、dataRoot 独占门禁）已在
  [t006-desktop-acceptance-evidence.md](t006-desktop-acceptance-evidence.md) 记录并分栏；本文件不再重复。
- 原生菜单与原生 NSOpenPanel/NSSavePanel、真实系统浏览器 `shell.openExternal`：仍未自动执行，
  归 QA25 与人工；注入 opener 列不可互代。
- 认证 WebUI 的浏览器 cookie 建立后的真实 GUI 可用页：composition 级已证 303→cookie→200 页面；
  真实浏览器列见上证据文件的注入 opener 分栏，不用 HTTP 303/200 冒充 GUI 可用页。
- Windows x64：未实现、未测（M2 边界）。
- 安全 review：8 已对 9b52364 CHANGES_REQUESTED 2/2；本批实现 P2-1/P2-2/P3 后需重新 review 新 SHA。

