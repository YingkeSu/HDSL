# 桌面主流程 E2E 执行与边界（T007c / #64 执行阶段，父任务 #7）

- Owner：hdsl-25（独立 QA）。本文件与 `tests/e2e/**` 归本切片独占；其它路径只读。
- 候选：PR #68 head `2cdea54a9c65252b8d2809737723018ca5b2f801`（base main `a16146c3b4578889bd72f6d0afd226b74f737935`）。
- 上一冻结 head：`9b52364d8a999617e1537e6ce97c419fb1ebd04e`（红证据即在此 SHA 记录）。
- 实机：macOS 26.3（Darwin 25D125）arm64；Node v24.21.0；pnpm 11.7.0；Electron 44.4.3；驱动方式 CDP（Node 内置 `WebSocket`/`fetch`，不新增依赖）。
- 边界：本切片是**独立 QA**。不 review/改 `apps/desktop/**`、不改 `tests/desktop/**`、不改根配置/lockfile。真实 UI 不得用 SSR/demo 替代；composition/HTTP 证据不得当 GUI 证据。

## 执行矩阵（2cdea54）

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
| E2E-AUTH-01 | ✅ 通过（2cdea54） | `isTrustedDocumentUrl` 精确规范化相等：真实文档 URL 通过；`index.html.attacker`、`index.html/nested/evil.html`、`index%2ehtml`、`?x=1` 一律拒绝；子 frame（`isMainFrame=false`）拒绝 |
| E2E-HOOK-01 | ✅ 通过（2cdea54） | 生产入口设置三个 `HDSL_*` 钩子后正常启动：`credentials.json` 未生成、固定导出路径无文件、stderr 无 `credential-import` 标记 |
| E2E-QAENTRY-DIAG-01 | ✅ 通过（注入列） | `qa-entry --hdsl-qa-export-path`：导出返回 `{exportId,exported:true,redacted:true}`；文件不含 canary/`.credentials.yaml`/`credentials.json`/dataRoot 原文；同 `requestId` 重放不重写文件；不返回路径 |
| E2E-QAENTRY-CRED-01 | ✅ 通过（注入列） | `qa-entry --hdsl-qa-import-path/--hdsl-qa-import-environment`：stderr `credential-import: applied`；`credentials.json` 权限 `0600`、含引用 id/key、无 secret 值 |
| E2E-QAENTRY-CRED-02 | ✅ 通过（注入列） | 含 `value` 字段的文档 `rejected at parse`；`credentials.json` 未生成；secret 不入 stderr |
| E2E-BROWSER-01 | ✅ 通过（注入 opener 列） | 真实 Chrome（临时 profile + CDP）作为注入 opener：`createDesktopComposition({openWebUi})` 启动真实受管 DSH，bootstrap URL 仅交给 `Page.navigate`；**认证断言为 rc2 应用身份**（`title=DeepSeek Harness` + `#root [data-slot="root"]` + `新会话`），并有**无 cookie 第二 profile 的负向对照**（不出现该 shell）；自建随机 keychain canary（stdin 写入，删除后复检不存在） |
| E2E-IFRAME-01 | ✅ 通过（真实窗口子 frame，断言层） | 生产窗口内构造真实 `<iframe>`：`srcdoc` 子 frame **实际执行**且断言 `URL === about:srcdoc` 与可见文本含 `qa-frame`，其上下文 `window.hdsl`/`require`/`process`/`ipcRenderer`/`hdsl.call` **全部 undefined**；该 frame 自身的 `data:` 导航**未产出请求文档**（落在 `chrome-error://chromewebdata/`、无 `qa-data`），按该 frame 的 `data:` `src` 归因；主 frame `catalog.list` 前后正控。**静态配置单独记录**：renderer meta `default-src 'none'` 且无 `frame-src`（配置事实，未做动态归因/未称 CSP 层已验）。带桥子 frame 的真实 `senderFrame` 拒绝仍**未覆盖** |
| E2E-SENDERFRAME-01 | ✅ 通过（测试宿主列，`HDSL_E2E_SENDERFRAME=1`） | 测试专用 Electron 宿主加载生产 `DesktopIpcHost`/信任策略与**生产 preload 原件**；仅宿主开启 `nodeIntegrationInSubFrames` 让**真实子 frame 持桥发真实 IPC**：子 frame 的 `catalog`/`create`/`export`/`openWebUI` 全部 `ok:false` + 受控 `INTERNAL_ERROR`（无 `NOT_FOUND`，证明 dispatch 前拒绝），无环境/导出副作用、无原始异常/栈/路径/secret；主 frame `catalog.list` `ok:true`（生产 catalog 2 条）。该宿主是**纵深验证列，不是产品第一层防线** |
| E2E-SENDERFRAME-02 | ✅ 通过（always-on） | 测试宿主/测试页 fixture 存在且自包含（不启动 Electron） |
| E2E-IFRAME-02 | ✅ 通过（always-on 负控） | 纯分类器负控：无渲染（`about:blank`/空文本）、非该 frame 的 `data:` `src`、`data:` 文档真渲染出 `qa-data`、以及无可观测文档四种情况都**不通过**；正例才通过。不启动 Electron，进入默认 CI |
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
- 全部 opt-in：`8 files / 37 tests`（本批新增 `E2E-SENDERFRAME-01/02`；`E2E-IFRAME-01/02` 与其余 33 条已在 `2cdea54`/`3174447` base 复跑全绿）。
- 默认（gated）：`20 passed | 17 skipped`（tests/e2e，37 条）。

`HDSL_E2E_DESKTOP=1` / `HDSL_E2E_BROWSER=1` / `HDSL_E2E_GUI=1` / `HDSL_E2E_IFRAME=1` / `HDSL_E2E_SENDERFRAME=1` 是显式 opt-in 门（同 T004/T005 真实证据测试的模式）：真实矩阵不进入 `pnpm run test` 默认集。默认 CI 跑工程检查与 always-on 项：夹具自检 17 + Electron binary 探测 1 + iframe 层分类器负控 1 + sender-frame fixture 检查 1 = **20 passed**，其余 **17 skipped**（tests/e2e 共 37 条）。真实矩阵用注册的 `hdsl-e2e-run-*` 临时 base 下的 dataRoot/user-data/profile，不读个人 keychain、不调用模型、不碰用户 `~/.dsh` 或浏览器 profile（例外仅限下面“真实外部验收”人工步骤中明确标注的系统默认浏览器路径）。

## 红证据（9b52364）与修复复验

- **AUTH-01（review P2-1）**：在 `9b52364` 上，纯函数授权边界 `isNavigationAllowed`/`isAuthorizedSender` 接受 `<renderer index.html>.attacker` 等共享前缀的不同资源 —— 同断言 RED。**口径**：这是纯函数授权复现，**未**证明 Chromium 规范化层可利用，不称真实利用。`33bfd1e` 改为 `isTrustedDocumentUrl` 精确规范化相等后，同断言 GREEN（并在最终 base `2cdea54` 复验）。
- **HOOK（review P2-2）**：`9b52364` 上运行期复现（正常启动 + 三个 `HDSL_*` 钩子）在真实 install 步骤超时，**没有干净红**；不补写成功复现。`33bfd1e` 把注入迁到独立 `dist/main/qa-entry.js`；生产入口**不读三个导入/导出授权钩子**（`HDSL_DIAGNOSTICS_EXPORT_PATH`、`HDSL_CREDENTIAL_IMPORT_PATH`、`HDSL_CREDENTIAL_IMPORT_ENVIRONMENT`），而 `HDSL_DATA_ROOT`（`--hdsl-data-root`）是**有意保留**的定位入口，仍走同一独占/校验路径；`E2E-HOOK-01` 独立验证「设置三 env 的正常生产启动无任何读文件/写配置/跳对话框副作用」。

## F1 拒绝信号（已由生产补齐，`2cdea54`）

`33bfd1e` 上该路径没有机器可读的拒绝信号（无 stderr、不退出、`locks/` 无拒绝记录），本切片当时只能用“有界无 page + lease 归属不变 + 同配置空闲 root 正控”归因，并把最小可观测性缺口登记给实现方。

`2cdea54` 在原生错误框**之前**输出单行固定、脱敏的 stderr：`[hdsl] data-root unavailable reason=busy`（另一实例持有时；`unknown` 兜底），不含路径/owner/PID/hostname/secret/异常文本，不写未持锁 dataRoot，用户关闭弹框后退出码 1。`E2E-LOCK-02` 现在断言该精确信号（含 `reason=busy`）且断言该行不含 dataRoot 路径与 `token=`，再断言首实例存活、`lease.json` pid 不变，并保留同配置空闲 root 正控；取证后只终止本测试自己的第二实例进程，不点原生弹框。

## 通道分栏

| lane | 内容 | 能否作真实 UI 证据 |
| --- | --- | --- |
| 真实（production 入口 + CDP） | WIN/IPC/TRUST/LOCK/CREATE/AUTH/HOOK | 能（真实 Electron 窗口与真实键盘） |
| 测试注入（`qa-entry`） | DIAG/CRED 正负向 | **不能**替代真实原生菜单/对话框；仅证明注入入口与校验/排除逻辑 |
| composition/HTTP（hdsl-24） | install/keychain/start/bootstrap 303→200/stop/close | 不能替代 GUI；本文件不作为其证据 |
| SSR / demo | `tests/acceptance/renderer`、`demo/index.html` | 不能替代真实窗口 |
| 测试宿主（`sender-frame-host.mjs`） | 真实子 frame + 生产 handler/preload 原件的 sender 拒绝 | 纵深验证列；**不是产品第一层防线**，不能替代生产窗口列 |

### iframe/sender 两列（不互代）

| 列 | 配置 | 结论 |
| --- | --- | --- |
| 产品窗口列（`E2E-IFRAME-01`） | 生产窗口：真实 CSP（meta `default-src 'none'`、无 `frame-src`）+ preload 不注入子 frame | `srcdoc` 子 frame 真实执行但**无桥**；该 frame 的 `data:` 导航失败。产品第一层防线（CSP + 无子 frame 桥）在此 |
| 测试宿主列（`E2E-SENDERFRAME-01`） | 测试专用宿主，仅其开启 `nodeIntegrationInSubFrames` 且测试页无 CSP；加载生产 `DesktopIpcHost`/信任策略与生产 preload 原件 | 真实子 frame 持桥发真实 IPC，被生产 `senderFrame`/`isMainFrame` 判定在 **dispatch 前拒绝**（受控 `INTERNAL_ERROR`，无副作用）；主 frame 正控 `ok:true` |

## 未验证 / blocked（保留，不重试）

- **原生应用菜单与原生 NSOpenPanel/NSSavePanel**：CDP 到不了渲染树。hdsl-24 的有界核查（AXPress 可按下菜单、真实 `openAndSavePanelService` 出现；`osascript` 发送按键被拒 `error 1002`（**具体 TCC 类别未经独立证实**，不据此断定是 Input Monitoring 或任何单一类别）、AX `windows 0`）已记录，属能力/权限边界 → **blocked/manual**，本切片不再试权限，也不自行改系统授权。
- **隔离真实浏览器 + opener 注入**（✅ 已执行，`E2E-BROWSER-01`）：真实 Chrome（`/Applications/Google Chrome.app`，注册的临时 profile + CDP）作为注入 opener。真实受管 DSH 经 `createDesktopComposition({ openWebUi: createVerifiedWebUiOpener(async url => browser.send('Page.navigate',{url})) })` 启动；bootstrap URL **只**进入 `Page.navigate`，不打印/不落盘/不开 Network 域/不 dump cookie。**认证断言不是页面长度**：必须出现 rc2 应用身份（`title=DeepSeek Harness`、`#root [data-slot="root"]`、`新会话`），并有**无 cookie 的第二 profile 负向对照**（不出现该 shell）。keychain 用自建随机 `hdsl-qa-24-browser-*`（secret 经 stdin），删除后复检 `find-generic-password` 不存在。**分栏**：这是**注入 opener** 证据，不等于真实 `shell.openExternal` 原生打开；后者未在本切片执行。
- **GUI 认证后可用页**：composition 级 303→200（hdsl-24）与本切片的**注入 opener 真实浏览器**已分别记录；真实 `shell.openExternal` 系统浏览器打开仍未验证，保留未验证。
- **真实 DSH 经 UI 启停**（✅ 已执行，`E2E-GUI-STARTSTOP-01`）：凭据用 **setup 注入**（已受审 core 接口 + 自建 keychain canary）准备好后，production 真实 React UI 上 CDP 真实鼠标点击启停，观察到操作面板与 `运行中`/`已停止` 终态；**不代表**原生菜单导入路径已测。
- **真实窗口 iframe 边界**（✅ 已执行，`E2E-IFRAME-01`）：`srcdoc` 子 frame 实际执行但**无启动器桥**（preload 不注入子 frame）；该 frame 自身的 `data:` 导航**失败**（落在 error 文档、无被阻文档标记），按该 frame 的 `data:` `src` 归因。**静态 CSP 配置**（meta `default-src 'none'`、无 `frame-src`）单独列为配置事实，本切片**不声称 CSP 层已动态验证**，也不做唯一原因归因。**该形态的纵深验证**由测试宿主列 `E2E-SENDERFRAME-01` 覆盖（生产 handler/bridge 原件、无生产后门、宿主仅开 `nodeIntegrationInSubFrames`）；它**不是**产品第一层防线，两列不互代。
- Windows x64：未测（T008b）。
- 其余计划场景（`tests/e2e/scenarios/desktop-e2e-scenario-plan.ts`）保持 `blocked`。

## 真实外部验收：可操作人工步骤（未执行，不声称完成）

以下三项**未自动执行也不声称完成**；都必须由人操作、且**不使用 QA 的临时 profile 注入**。前两项只使用独立临时 dataRoot 与自建 keychain canary，不读个人 keychain；**第三项会经过宿主机真实默认浏览器与其用户 profile**，因此本切片**未执行**它，也**不会**自动更改默认浏览器或任何用户配置。

建议在**专用测试 OS 账户**或事先明确选定/切换好的测试浏览器环境下执行；在普通个人环境执行前需用户知情并同意，因为 bootstrap 可能留在浏览器历史/会话中。**不得**声称该 token 为一次性或短期有效：rc2 在同一进程内复用，本切片未证明其过期语义。

1. **原生「环境 → 导入环境凭据引用…」文件选择**：启动 production 应用（`pnpm run build:desktop` 后 `<electron> apps/desktop --hdsl-data-root <临时dir>`）→ 先创建一个环境并在列表选中 → 菜单「环境 → 导入环境凭据引用…」→ 在 NSOpenPanel 选择 `schemaVersion:"1"`、`bindings:[{name,reference:{id,store:"keychain",key:"service#account"}}]` 的 JSON → 预期成功提示；核对 `<dataRoot>/environments/<id>/credentials.json` 为 `0600` 且无 secret 值。自动列以 `qa-entry` 注入替代，不能当原生菜单证据。
2. **诊断保存对话框（NSSavePanel）**：在选中环境上触发「导出诊断」（或不设注入路径调用 `diagnostics.export`）→ 在原生保存框选路径 → 预期文件存在且不含 canary/`.credentials.yaml`/`credentials.json`/dataRoot 原文。自动列以 `--hdsl-qa-export-path` 注入替代。
3. **真实系统浏览器打开**（`shell.openExternal` 路径，与 `E2E-BROWSER-01` 的临时 profile 注入 opener **不同、不可互代**）：running 环境点「打开 WebUI（主进程原生打开）」→ 由 `shell.openExternal` 交给**宿主机默认浏览器/用户 profile** → 人工确认落点与页面可用。**未执行**：本切片未在真实默认浏览器上运行该路径；bootstrap URL 可能进入该浏览器历史/会话。若要在可复核条件下执行，请在专用测试账户或已选定的测试浏览器中操作，并按需在事后自行清理该浏览器历史（本切片不代做、不改用户配置）。

已记录的能力限制：`osascript` 发送按键被拒 `error 1002`（**具体 TCC 类别未经独立证实**）、AX `windows 0`，故上述原生面板无法在当前会话中自动完成；不自行改系统授权，也不承诺授予某一类别后必然可用。


## 真实模型 E2E（用户授权临时凭据；一次性，不重复）

- 链路：production core loader → strict credential port（keychain 引用）→ manager → 真实受管 DSH 0.1.5-rc.2 → 真实模型回复。
- 驱动：临时 Chrome profile + 注入 opener 认证 WebUI；提示经**真实 DSH UI 提交**，非直连 provider API。
- 结果：两轮（短 marker 提示 + 多轮第二个 marker）均取得 **assistant 角色回复**；提交后 composer 清空；marker 在 user 回显链（`Sixlwa_userStack`）与 assistant markdown 链（`hWmORq_body`/`_markdown`）可区分，非用户回显冒充。
- 模型：DSH UI 显示 `DeepSeek-V41-Flash`。**端点未观测**（无网络抓包）；UI 模型名不等于端点证明。用户触发任务 **2 次**（上限 3）；provider usage 未观测——不把预算额度或 DOM 请求数当作 usage。
- 泄漏：诊断导出、launch record 与 DSH home 日志按精确凭据值程序比较，均无命中（只记录布尔，不打印命中内容）。
- 凭据处理：临时凭据经 stdin 写入自建随机 keychain 项，`finally` 删除（delete exit 0 / find-after exit 44）；未进入 Git、日志或报告。临时凭据此后不可用，本切片不重复请求。
- 证据为**一次性**：不可在不重新取得凭据的情况下复跑；仓库不保存该凭据或任何派生值。

## workspace 前置与 QA setup（源码确定 schema）

- 首启必须先有 workspace：否则 composer 为 `contenteditable=false`、发送按钮禁用、会话入口显示「选择一个工作区开始」。
- macOS + loopback（未 SSH）下，目录选择器后端由 `dsh-host-directory-picker-auto` 解析为 `native`；`browse`（页内、CDP 可驱动）仅在非 loopback 绑定或 SSH 启动时挂载。本切片保持 loopback，不扩大监听面，因此 UI 内选择器为原生面板。
- QA setup（非产品功能）：按已安装 `dsh-workspace` 源码确定 schema，在**自有受管 home** 预置 workspace 记录：`unit{name:"workspace",version:2}`、`global{initialized,workspaceIds[],archivedSessionIds[]}`、`tables.workspaces[id] = {path(fs.realpath canon),title,sessionIds[],createdAt(ISO),updatedAt(ISO)}`，id 为 `randomUUID()`。写入前备份原文件。
- **分栏**：这是 **setup**（QA 预置），不是真实 UI 选择、也不是 remote mux 协议调用；协议路径本轮未走通（见下）。
- 验证：两个独立临时 profile 均达到 overlay 不存在、composer `contenteditable=true` 且可聚焦、可输入且发送条件有效（仅填入无害提示，**未提交**）。

## 原生导入/导出：用户实际面板操作 + QA 落盘核验

- **原生引用导入**：用户经真实菜单「环境 → 导入环境凭据引用…」→ 真实 NSOpenPanel 完成选择（AX 可按下菜单，面板窗口按名可见）。QA 独立落盘核验：`credentials.json` 权限 `0600`、仅含引用、与自有引用文件逐字一致、无 `value`/`secret`/`token` 字段、无 `sk-` 形状。
- **诊断导出**：用户经真实产品按钮 → 真实 NSSavePanel 保存（使用默认文件名）。QA 核验：合法 JSON、`0600`、top-level keys 恰为生产白名单（`app`/`compositionLock`/`environment`/`generatedAt`/`launch`/`manifest`/`operations`/`schemaVersion`）；无 `credentials.json`、`.credentials.yaml`、受管绝对路径、canary 或凭据形状、`token=`、`Authorization`。
- **证据归属**：面板操作由**用户**完成，QA 只做独立落盘核验；不冒称全自动。

## 自动化能力限制（当前宿主，已证事实）

- AX/辅助功能 `enabled=true`：菜单项可 `AXPress`，原生面板窗口可通过窗口名观测。
- `osascript` 发送按键被拒 `error 1002`：无法在原生面板输入路径或确认。**具体 TCC 类别未经独立证实**（本地 SDK 头文件仅把 `-1743` 记为 `errAEEventNotPermitted` 的既有值，`-1002` 的 TCC 归属未由本地权威文档证实）；不替换为另一未经证实的类别，也不承诺授予 Input Monitoring 必然解决。
- 原生面板的 AX 元素树无可驱动控件（buttons/textFields/groups/tables/outlines 均为 0）。
- Electron `dialog` API 无 automation hook（本地 `electron.d.ts`：`showOpenDialogSync`/`showSaveDialogSync` 无测试钩子）；`shell.openExternal` 无 profile 隔离参数（`OpenExternalOptions` 仅 `activate`/`workingDirectory`/`logUsage`）。
- 本机无 Xcode/VM/容器工具，仅一个本机用户账户；默认 `https` handler 为系统默认浏览器。
- **待验证建议（非结论）**：`XCUITest`（需 Xcode）或带预授权的隔离 macOS VM/测试账户，可作为后续有界验证方向；本轮未执行，也未改 TCC、系统权限或默认浏览器。不能由「Electron 无 dialog hook」推断所有自动化方案都不可能；也不能由 `error 1002` 直接断定某一授权类别。

## 仍未验（不冒充完成）

- 真实 `shell.openExternal` 系统浏览器路径：会经过个人默认浏览器 profile/历史，需隔离宿主才能验证；本切片未执行。
- 原生面板的**全自动完成**（见上，受当前宿主权限/控件可见性限制）。
- Windows x64：无项目配置宿主，需 Windows 主机，不用 Linux CI 冒充。

## 复核旧审核 F1–F5（PR #65）与 PR #69 review F1–F6

- PR #65 F1–F5：`lstatSync` 识别 symlink（含正向自检）、去恒真断言改为真实 descriptor 断言、版本精确锚定结尾、计数/PATH 措辞——已落地。
- PR #69 review F1：LOCK-02 加同配置空闲 root 正控归因；无机器可读拒绝信号已作为可观测性缺口记录（见上）。
- F2：浏览器认证改为 rc2 应用身份断言 + 无 cookie 负向对照，不以页面长度认证。
- F3：场景计划与真实证据对齐——LOCK-01（user-data 单实例）与 LOCK-02/03（dataRoot 拒绝、释放后重获）分栏；qa-entry 凭据明确标为测试注入非原生菜单。iframe 已在真实窗口另行驱动（见 E2E-IFRAME-01），不再用 popup/nav 冒充子 frame 覆盖。
- F4：残留检查只针对本 run 唯一 base 目录（不再扫描整个 tmpdir，也不删除他人根）。
- F5：keychain 删除结果与再查不存在均硬断言，setup/spawn 纳入 `try/finally`，cleanup 失败显式报告。
- F6：失败输出先经 `sanitizeForReport`（去 token/secret、截断），CDP 每次调用有界超时并清理 pending；旧“expected RED”注释与机器计数已更新。

## 残留

- 真实/注入矩阵：15 条场景（含 `E2E-IFRAME-01`、`E2E-SENDERFRAME-01`）+ 17 条夹具自检 + 4 条 always-on（binary 探测、iframe 分类器负控、sender 宿主 fixture 等），opt-in 合计 `8 files / 37 tests`（本批 sender-frame 执行，其余在既有 base 复跑）。
- `CRED-01/CRED-02` 只覆盖 qa-entry 测试注入列；真实原生菜单/对话框仍未验证。
- 真实 `shell.openExternal` 系统浏览器打开未测（注入 opener 列已验，两者不互代）。
- LOCK-02 的机器可读拒绝信号缺口保持登记（见上）。
- Windows x64 未测（T008b）。
- 本文件与场景计划中的 observation 只对候选 `2cdea54` 有效；候选变更后需重新复验。
