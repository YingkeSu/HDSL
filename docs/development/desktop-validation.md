# 桌面主流程 E2E 执行与边界（T007c / #64 执行阶段，父任务 #7）

- Owner：hdsl-25（独立 QA）。本文件与 `tests/e2e/**` 归本切片独占；其它路径只读。
- 候选：PR #68 head `33bfd1e32d0f121a640ba713a4fa165f906c8ffe`（base main `a16146c3b4578889bd72f6d0afd226b74f737935`）。
- 上一冻结 head：`9b52364d8a999617e1537e6ce97c419fb1ebd04e`（红证据即在此 SHA 记录）。
- 实机：macOS 26.3（Darwin 25D125）arm64；Node v24.21.0；pnpm 11.7.0；Electron 44.4.3；驱动方式 CDP（Node 内置 `WebSocket`/`fetch`，不新增依赖）。
- 边界：本切片是**独立 QA**。不 review/改 `apps/desktop/**`、不改 `tests/desktop/**`、不改根配置/lockfile。真实 UI 不得用 SSR/demo 替代；composition/HTTP 证据不得当 GUI 证据。

## 执行矩阵（33bfd1e）

真实 Electron 窗口 + 真实 CDP 驱动，全部带显式超时（无无界等待）：

| 用例 | 结果 | 证据摘要 |
| --- | --- | --- |
| E2E-WIN-01 | ✅ 通过 | 真实窗口挂载 React（`#root` 有内容，标题「HDSL 环境管理」）；`window.hdsl` 恰好 `call,onOperationUpdated,selectEnvironment`；`window.require/process/ipcRenderer` 与 `send/invoke/on` 全 `undefined` |
| E2E-WIN-02 | ✅ 通过 | 真实键盘：`Input.dispatchKeyEvent` 输入文本进 `#create-name`（React 受控值更新）；Tab 焦点遍历 `name → select → button`，按钮文本「创建」且可用 |
| E2E-TRUST-01 | ✅ 通过 | `window.open` 返回 `null`；`location` 改 `https://example.com` 被 `will-navigate` 拒绝，URL 不变，渲染存活 |
| E2E-IPC-01 | ✅ 通过 | `catalog.list` 返回两条已核验组合；未知 method→`INVALID_INPUT`；`apiVersion:2.0`→`CONTRACT_VERSION_MISMATCH`；未知 env `environments.stop`→`NOT_FOUND`；未知 `operations.get`→`NOT_FOUND`；未知 env `environments.openWebUI`→`WEBUI_UNAVAILABLE`；响应无 token/`file://`/loopback 泄漏 |
| E2E-LOCK-01 | ✅ 通过 | 同 `--user-data-dir` 第二进程经 `requestSingleInstanceLock` 退出，首实例仍可服务 |
| E2E-LOCK-02 | ✅ 通过 | 同 dataRoot、不同 user-data-dir：第二进程 8s 内无 page target；`<dataRoot>/locks/data-root.lock/lease.json` 的 `pid` 仍为**首实例** pid，终止第二进程后不变（非“无 target 恒真”） |
| E2E-CREATE-01 | ✅ 通过 | 纯键盘主流程（Tab 到按钮 + Enter 激活）→ 真实 install（Node 22.19.0 + DSH 0.1.5-rc.2，npm-ci）→ `state=stopped`；磁盘核实 `environment.json`、`generations/<id>/composition.lock.json`、`install-manifest.json` 落盘（约 41s） |
| E2E-AUTH-01 | ✅ 通过（33bfd1e） | `isTrustedDocumentUrl` 精确规范化相等：真实文档 URL 通过；`index.html.attacker`、`index.html/nested/evil.html`、`index%2ehtml`、`?x=1` 一律拒绝；子 frame（`isMainFrame=false`）拒绝 |
| E2E-HOOK-01 | ✅ 通过（33bfd1e） | 生产入口设置三个 `HDSL_*` 钩子后正常启动：`credentials.json` 未生成、固定导出路径无文件、stderr 无 `credential-import` 标记 |
| E2E-QAENTRY-DIAG-01 | ✅ 通过（注入列） | `qa-entry --hdsl-qa-export-path`：导出返回 `{exportId,exported:true,redacted:true}`；文件不含 canary/`.credentials.yaml`/`credentials.json`/dataRoot 原文；同 `requestId` 重放不重写文件；不返回路径 |
| E2E-QAENTRY-CRED-01 | ✅ 通过（注入列） | `qa-entry --hdsl-qa-import-path/--hdsl-qa-import-environment`：stderr `credential-import: applied`；`credentials.json` 权限 `0600`、含引用 id/key、无 secret 值 |
| E2E-QAENTRY-CRED-02 | ✅ 通过（注入列） | 含 `value` 字段的文档 `rejected at parse`；`credentials.json` 未生成；secret 不入 stderr |
| E2E-BROWSER-01 | ✅ 通过（注入 opener 列） | 真实 Chrome（临时 profile + CDP）作为注入 opener：`createDesktopComposition({openWebUi})` 启动真实受管 DSH，bootstrap URL 仅交给 `Page.navigate`；最终文档为去 query 的 canonical loopback origin，认证后 DOM 有内容（`outerHTML > 1000`），DSH 页面无 `window.hdsl`；自建随机 keychain canary（stdin 写入，finally 删除） |
| harness 自检 | ✅ 17/17 | 夹具安全自检（登记清理/宿主守卫可失败/canary oracle/gate/候选探测器/隔离 dataRoot/计划校验，含 symlink 识别与负向控制） |

命令（真实矩阵，opt-in）：

```sh
export PATH=/Users/suyingke/tools/node-24.21.0/bin:$PATH
pnpm install --frozen-lockfile
pnpm run build:desktop
HDSL_E2E_DESKTOP=1 pnpm exec vitest run tests/e2e/desktop.real.test.ts
HDSL_E2E_DESKTOP=1 pnpm exec vitest run tests/e2e/desktop.findings.real.test.ts
HDSL_E2E_DESKTOP=1 pnpm exec vitest run tests/e2e/desktop.injected.real.test.ts
HDSL_E2E_BROWSER=1 pnpm exec vitest run tests/e2e/desktop.browser.real.test.ts
pnpm exec vitest run tests/e2e/harness.test.ts   # 常驻，不需 opt-in
```

`HDSL_E2E_DESKTOP=1` 是显式 opt-in 门（同 T004/T005 真实证据测试的模式）：真实矩阵不进入 `pnpm run test` 默认集，CI 保持只跑夹具自检。真实矩阵用注册的 `hdsl-e2e-*` 临时 dataRoot/user-data，不读个人 keychain、不调用模型、不碰用户 `~/.dsh` 或浏览器 profile。

## 红证据（9b52364）与修复复验

- **AUTH-01（review P2-1）**：在 `9b52364` 上，纯函数授权边界 `isNavigationAllowed`/`isAuthorizedSender` 接受 `<renderer index.html>.attacker` 等共享前缀的不同资源 —— 同断言 RED。**口径**：这是纯函数授权复现，**未**证明 Chromium 规范化层可利用，不称真实利用。`33bfd1e` 改为 `isTrustedDocumentUrl` 精确规范化相等后，同断言 GREEN。
- **HOOK（review P2-2）**：`9b52364` 上运行期复现（正常启动 + 三个 `HDSL_*` 钩子）在真实 install 步骤超时，**没有干净红**；不补写成功复现。`33bfd1e` 把注入迁到独立 `dist/main/qa-entry.js`，生产入口不再读任何钩子；`E2E-HOOK-01` 独立验证「设置三 env 的正常生产启动无任何读文件/写配置/跳对话框副作用」。

## 通道分栏

| lane | 内容 | 能否作真实 UI 证据 |
| --- | --- | --- |
| 真实（production 入口 + CDP） | WIN/IPC/TRUST/LOCK/CREATE/AUTH/HOOK | 能（真实 Electron 窗口与真实键盘） |
| 测试注入（`qa-entry`） | DIAG/CRED 正负向 | **不能**替代真实原生菜单/对话框；仅证明注入入口与校验/排除逻辑 |
| composition/HTTP（hdsl-24） | install/keychain/start/bootstrap 303→200/stop/close | 不能替代 GUI；本文件不作为其证据 |
| SSR / demo | `tests/acceptance/renderer`、`demo/index.html` | 不能替代真实窗口 |

## 未验证 / blocked（保留，不重试）

- **原生应用菜单与原生 NSOpenPanel/NSSavePanel**：CDP 到不了渲染树。hdsl-24 的有界核查（AXPress 可按下菜单、真实 `openAndSavePanelService` 出现；`osascript` 发送按键 `error 1002`（Input Monitoring 未授权）、AX `windows 0`）已记录，属能力/权限边界 → **blocked/manual**，本切片不再试权限，也不自行改系统授权。
- **隔离真实浏览器 + opener 注入**（✅ 已执行，`E2E-BROWSER-01`）：真实 Chrome（`/Applications/Google Chrome.app`，注册的临时 profile + CDP，`--remote-debugging-port` 由空闲端口分配）作为注入 opener。真实受管 DSH 经 `createDesktopComposition({ openWebUi: createVerifiedWebUiOpener(async url => browser.send('Page.navigate',{url})) })` 启动；bootstrap URL **只**进入 `Page.navigate`，不打印/不落盘/不开 Network 域/不 dump cookie。断言：最终 `location.href` 是**去 query** 的 canonical loopback origin，认证后 DOM 非空（`textContent > 50`、`outerHTML > 1000`），且 DSH 页面 `window.hdsl === undefined`。keychain 用自建随机 `hdsl-qa-24-browser-*`（secret 经 stdin），`finally` 删除并确认无残留。**分栏**：这是**注入 opener** 证据，不等于真实 `shell.openExternal` 原生打开；后者未在本切片执行。
- **GUI 认证后可用页**：composition 级 303→200（hdsl-24）与本切片的**注入 opener 真实浏览器**已分别记录；真实 `shell.openExternal` 系统浏览器打开仍未验证，保留未验证。
- **真实 DSH 经 UI 启停**：`environments.start` 对无凭据环境会弹原生提示，headless 下阻塞 → 归 manual；composition 级启停与真实浏览器认证页见上。
- Windows x64：未测（T008b）。
- 其余计划场景（`tests/e2e/scenarios/desktop-e2e-scenario-plan.ts`）保持 `blocked`。

## 复核旧审核 F1–F5（PR #65）

- F1 `statSync` 不识别 symlink → 已改 `lstatSync` 并加 symlink 正向自检。
- F2 恒真断言 → 已改为断言真实候选 descriptor（window/IPC/preload 均 true、placeholder 不存在、ready=true）。
- F3 版本前缀误判（`44.4.3-beta`）→ `isExactVersion` 锚定结尾，负向断言。
- F4 执行记录计数 → 本章程记录以实际 vitest 输出为准。
- F5 机器私有 PATH → 本文件与 README 统一写「本机 PATH」，仅命令示例处保留前缀。

## 残留

- 12 条真实/注入场景 + 1 条注入 opener 真实浏览器场景已执行通过；`CRED-01/CRED-02` 只覆盖注入列，真实原生菜单仍未验证。
- 真实 `shell.openExternal` 系统浏览器打开、GUI 启停、Windows 未测，均显式保留。
- 本文件与场景计划中的 observation 只对候选 `33bfd1e` 有效；候选变更后需重新复验。
