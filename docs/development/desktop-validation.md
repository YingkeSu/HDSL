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
| E2E-LOCK-02 | ✅ 通过 | 同 dataRoot、不同 user-data-dir：第二进程 8s 内无 page target；`<dataRoot>/locks/data-root.lock/lease.json` 的 `pid` 仍为**首实例** pid，终止第二进程后不变；**同配置在空闲 root 的正控能开窗**（归因，非恒真） |
| E2E-LOCK-03 | ✅ 通过 | 首实例退出后，新实例以同 dataRoot 重新获取 lease（pid 变更）并可服务（与 LOCK-02 的“拒绝”分栏） |
| E2E-CREATE-01 | ✅ 通过 | 纯键盘主流程（Tab 到按钮 + Enter 激活）→ 真实 install（Node 22.19.0 + DSH 0.1.5-rc.2，npm-ci）→ `state=stopped`；磁盘核实 `environment.json`、`generations/<id>/composition.lock.json`、`install-manifest.json` 落盘（约 41s） |
| E2E-AUTH-01 | ✅ 通过（33bfd1e） | `isTrustedDocumentUrl` 精确规范化相等：真实文档 URL 通过；`index.html.attacker`、`index.html/nested/evil.html`、`index%2ehtml`、`?x=1` 一律拒绝；子 frame（`isMainFrame=false`）拒绝 |
| E2E-HOOK-01 | ✅ 通过（33bfd1e） | 生产入口设置三个 `HDSL_*` 钩子后正常启动：`credentials.json` 未生成、固定导出路径无文件、stderr 无 `credential-import` 标记 |
| E2E-QAENTRY-DIAG-01 | ✅ 通过（注入列） | `qa-entry --hdsl-qa-export-path`：导出返回 `{exportId,exported:true,redacted:true}`；文件不含 canary/`.credentials.yaml`/`credentials.json`/dataRoot 原文；同 `requestId` 重放不重写文件；不返回路径 |
| E2E-QAENTRY-CRED-01 | ✅ 通过（注入列） | `qa-entry --hdsl-qa-import-path/--hdsl-qa-import-environment`：stderr `credential-import: applied`；`credentials.json` 权限 `0600`、含引用 id/key、无 secret 值 |
| E2E-QAENTRY-CRED-02 | ✅ 通过（注入列） | 含 `value` 字段的文档 `rejected at parse`；`credentials.json` 未生成；secret 不入 stderr |
| E2E-BROWSER-01 | ✅ 通过（注入 opener 列） | 真实 Chrome（临时 profile + CDP）作为注入 opener：`createDesktopComposition({openWebUi})` 启动真实受管 DSH，bootstrap URL 仅交给 `Page.navigate`；**认证断言为 rc2 应用身份**（`title=DeepSeek Harness` + `#root [data-slot="root"]` + `新会话`），并有**无 cookie 第二 profile 的负向对照**（不出现该 shell）；自建随机 keychain canary（stdin 写入，删除后复检不存在） |
| E2E-GUI-STARTSTOP-01 | ✅ 通过（setup 注入凭据） | production 真实 React UI：CDP 真实鼠标点击「启动」→ 操作面板显示启动 → 状态标签 `运行中`；点击「停止」→ `已停止`；契约确认 stopped。凭据经已受审 core 接口 setup 注入 + 自建 keychain canary，**不冒充原生菜单导入** |
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
HDSL_E2E_GUI=1 pnpm exec vitest run tests/e2e/desktop.gui.real.test.ts
pnpm exec vitest run tests/e2e/harness.test.ts   # 常驻，不需 opt-in
```

机器计数（本机 macOS 26.3 arm64，Node 24.21.0）：
- 全部 opt-in：`6 passed / 33 tests`。
- 默认（gated）：`2 passed | 4 skipped; 18 passed | 15 skipped`。

`HDSL_E2E_DESKTOP=1` / `HDSL_E2E_BROWSER=1` / `HDSL_E2E_GUI=1` 是显式 opt-in 门（同 T004/T005 真实证据测试的模式）：真实矩阵不进入 `pnpm run test` 默认集，CI 保持只跑夹具自检。真实矩阵用注册的 `hdsl-e2e-run-*` 临时 base 下的 dataRoot/user-data/profile，不读个人 keychain、不调用模型、不碰用户 `~/.dsh` 或浏览器 profile。

## 红证据（9b52364）与修复复验

- **AUTH-01（review P2-1）**：在 `9b52364` 上，纯函数授权边界 `isNavigationAllowed`/`isAuthorizedSender` 接受 `<renderer index.html>.attacker` 等共享前缀的不同资源 —— 同断言 RED。**口径**：这是纯函数授权复现，**未**证明 Chromium 规范化层可利用，不称真实利用。`33bfd1e` 改为 `isTrustedDocumentUrl` 精确规范化相等后，同断言 GREEN。
- **HOOK（review P2-2）**：`9b52364` 上运行期复现（正常启动 + 三个 `HDSL_*` 钩子）在真实 install 步骤超时，**没有干净红**；不补写成功复现。`33bfd1e` 把注入迁到独立 `dist/main/qa-entry.js`，生产入口不再读任何钩子；`E2E-HOOK-01` 独立验证「设置三 env 的正常生产启动无任何读文件/写配置/跳对话框副作用」。

## 未解决的可观测性缺口（review F1）

`E2E-LOCK-02` 的“第二实例被拒”路径当前**没有机器可读的拒绝信号**：实测该进程不输出 stderr、不退出（阻塞在原生错误框），`locks/` 也不产生拒绝记录（只有首实例的 `lease.json`）。因此本切片只能用“有界无 page + lease 归属不变 + 同配置空闲 root 正控”归因。若要 CI 可独立断言该拒绝，需要一个受控且脱敏的可观测点（例如输出一行脱敏 stderr 并以非零码退出，或写一条受控拒绝证据）；这是**生产可观测性最小缺口**，归后续实现（不属本 QA 改动范围）。

## 通道分栏

| lane | 内容 | 能否作真实 UI 证据 |
| --- | --- | --- |
| 真实（production 入口 + CDP） | WIN/IPC/TRUST/LOCK/CREATE/AUTH/HOOK | 能（真实 Electron 窗口与真实键盘） |
| 测试注入（`qa-entry`） | DIAG/CRED 正负向 | **不能**替代真实原生菜单/对话框；仅证明注入入口与校验/排除逻辑 |
| composition/HTTP（hdsl-24） | install/keychain/start/bootstrap 303→200/stop/close | 不能替代 GUI；本文件不作为其证据 |
| SSR / demo | `tests/acceptance/renderer`、`demo/index.html` | 不能替代真实窗口 |

## 未验证 / blocked（保留，不重试）

- **原生应用菜单与原生 NSOpenPanel/NSSavePanel**：CDP 到不了渲染树。hdsl-24 的有界核查（AXPress 可按下菜单、真实 `openAndSavePanelService` 出现；`osascript` 发送按键 `error 1002`（Input Monitoring 未授权）、AX `windows 0`）已记录，属能力/权限边界 → **blocked/manual**，本切片不再试权限，也不自行改系统授权。
- **隔离真实浏览器 + opener 注入**（✅ 已执行，`E2E-BROWSER-01`）：真实 Chrome（`/Applications/Google Chrome.app`，注册的临时 profile + CDP）作为注入 opener。真实受管 DSH 经 `createDesktopComposition({ openWebUi: createVerifiedWebUiOpener(async url => browser.send('Page.navigate',{url})) })` 启动；bootstrap URL **只**进入 `Page.navigate`，不打印/不落盘/不开 Network 域/不 dump cookie。**认证断言不是页面长度**：必须出现 rc2 应用身份（`title=DeepSeek Harness`、`#root [data-slot="root"]`、`新会话`），并有**无 cookie 的第二 profile 负向对照**（不出现该 shell）。keychain 用自建随机 `hdsl-qa-24-browser-*`（secret 经 stdin），删除后复检 `find-generic-password` 不存在。**分栏**：这是**注入 opener** 证据，不等于真实 `shell.openExternal` 原生打开；后者未在本切片执行。
- **GUI 认证后可用页**：composition 级 303→200（hdsl-24）与本切片的**注入 opener 真实浏览器**已分别记录；真实 `shell.openExternal` 系统浏览器打开仍未验证，保留未验证。
- **真实 DSH 经 UI 启停**（✅ 已执行，`E2E-GUI-STARTSTOP-01`）：凭据用 **setup 注入**（已受审 core 接口 + 自建 keychain canary）准备好后，production 真实 React UI 上 CDP 真实鼠标点击启停，观察到操作面板与 `运行中`/`已停止` 终态；**不代表**原生菜单导入路径已测。
- Windows x64：未测（T008b）。
- 其余计划场景（`tests/e2e/scenarios/desktop-e2e-scenario-plan.ts`）保持 `blocked`。

## 复核旧审核 F1–F5（PR #65）与 PR #69 review F1–F6

- PR #65 F1–F5：`lstatSync` 识别 symlink（含正向自检）、去恒真断言改为真实 descriptor 断言、版本精确锚定结尾、计数/PATH 措辞——已落地。
- PR #69 review F1：LOCK-02 加同配置空闲 root 正控归因；无机器可读拒绝信号已作为可观测性缺口记录（见上）。
- F2：浏览器认证改为 rc2 应用身份断言 + 无 cookie 负向对照，不以页面长度认证。
- F3：场景计划与真实证据对齐——LOCK-01（user-data 单实例）与 LOCK-02/03（dataRoot 拒绝、释放后重获）分栏；qa-entry 凭据明确标为测试注入非原生菜单；iframe 未测不用 popup/nav 冒充。
- F4：残留检查只针对本 run 唯一 base 目录（不再扫描整个 tmpdir，也不删除他人根）。
- F5：keychain 删除结果与再查不存在均硬断言，setup/spawn 纳入 `try/finally`，cleanup 失败显式报告。
- F6：失败输出先经 `sanitizeForReport`（去 token/secret、截断），CDP 每次调用有界超时并清理 pending；旧“expected RED”注释与机器计数已更新。

## 残留

- 真实/注入矩阵：13 条场景 + 17 条夹具自检，opt-in 合计 `6 files / 33 tests` 全绿。
- `CRED-01/CRED-02` 只覆盖 qa-entry 测试注入列；真实原生菜单/对话框仍未验证。
- 真实 `shell.openExternal` 系统浏览器打开未测（注入 opener 列已验，两者不互代）。
- LOCK-02 的机器可读拒绝信号缺口保持登记（见上）。
- Windows x64 未测（T008b）。
- 本文件与场景计划中的 observation 只对候选 `33bfd1e` 有效；候选变更后需重新复验。
