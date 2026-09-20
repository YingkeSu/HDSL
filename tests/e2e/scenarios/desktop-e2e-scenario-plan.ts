/**
 * T007c desktop main-flow E2E scenario catalogue (plan data, not an executable
 * acceptance suite).
 *
 * Independent QA for `#7` owns `tests/e2e/**` and
 * `docs/development/desktop-validation.md`. This file records which desktop
 * end-to-end scenarios must run once `#6` wires the Electron main process, how
 * each is made deterministic, and which negative control proves the assertion
 * can actually fail.
 *
 * Every entry is `blocked` while `apps/desktop/src/main/index.ts` still throws
 * the T006 placeholder (see `support/desktop-candidate.ts`). `harness.test.ts`
 * checks this catalogue for internal consistency; it never runs the scenarios
 * and must never be cited as desktop validation.
 *
 * Lane separation is load-bearing: `real-dsh` and `synthetic` scenarios drive
 * the real Electron window, while `ssr-markup` / `demo-mock` are supporting
 * checks only. A `realUi` scenario may never be satisfied by an SSR render or
 * the vanilla demo (see `tests/acceptance/renderer/README.md`).
 */

export type E2eLane = 'real-dsh' | 'synthetic' | 'ssr-markup' | 'demo-mock';
export type E2eEvidence = 'real' | 'injected' | 'fixture';

export type DesktopCapability =
  | 'electron.window'
  | 'electron.single-instance'
  | 'preload.bridge'
  | 'ipc.sender-guard'
  | 'renderer.create-select'
  | 'renderer.start-stop'
  | 'operation.progress'
  | 'operation.cancel'
  | 'operation.subscribe'
  | 'webui.native-open'
  | 'webui.auth-bootstrap'
  | 'diagnostics.export'
  | 'credentials.menu-import'
  | 'dataRoot.lock'
  | 'reconcile.restart'
  | 'dsh.managed';

export interface PlannedScenario {
  readonly id: string;
  readonly title: string;
  readonly requirements: readonly string[];
  readonly lane: E2eLane;
  readonly evidence: E2eEvidence;
  /** True when the scenario must drive the real Electron UI, not SSR/demo. */
  readonly realUi: boolean;
  /** A deterministic gate that replaces sleep/retry luck. */
  readonly determinismGate: string;
  /** The falsifiable negative control: how this scenario is proven able to fail. */
  readonly negativeControl: string;
  readonly requires: readonly DesktopCapability[];
  readonly status: 'blocked' | 'ready' | 'executed';
  readonly blocker?: string;
  /** Observed result when the scenario has been executed on a frozen candidate. */
  readonly observation?: string;
}

const NOT_WIRED =
  'apps/desktop main/preload 未接线（#6 无候选；main/index.ts 仍为 T006 placeholder，无窗口/IPC/contextBridge）';

export const DESKTOP_E2E_SCENARIOS: readonly PlannedScenario[] = [
  {
    id: 'E2E-UI-01',
    title: '真实窗口主旅程：创建 → 选择 → 启动 → 停止',
    requirements: ['FR-001', 'FR-003', 'FR-005', 'FR-006', 'SC-002'],
    lane: 'real-dsh',
    evidence: 'real',
    realUi: true,
    determinismGate: '受管安装 + 专用 fixture 凭据 + 就绪行/端口门控；UI 按钮点击后以 operation 终态与 environment state 为判据，不 sleep',
    negativeControl: '未接线候选：无窗口可驱动，场景保持 blocked 且不可用 SSR/demo 替代；候选落地后关掉真实 DSH 就绪门必须超时失败',
    requires: ['electron.window', 'renderer.create-select', 'renderer.start-stop', 'dsh.managed'],
    status: 'blocked',
    blocker: NOT_WIRED,
  },
  {
    id: 'E2E-UI-02',
    title: '重复启动/停止幂等：不产生重复进程，不重复副作用',
    requirements: ['FR-005', 'FR-006'],
    lane: 'synthetic',
    evidence: 'injected',
    realUi: true,
    determinismGate: '启动请求 gate 卡在提交前，连续触发两次 UI 启动；断言同一 operation 或 ENVIRONMENT_BUSY，且子进程数不增',
    negativeControl: '去掉 gate 后两次请求必须产生可观测的重复或冲突；仅凭“最终 running”不算通过',
    requires: ['electron.window', 'renderer.start-stop', 'dsh.managed'],
    status: 'blocked',
    blocker: NOT_WIRED,
  },
  {
    id: 'E2E-CATALOG-01',
    title: '只能选择已核验组合；未核验/未知组合在 UI 被拒',
    requirements: ['FR-002'],
    lane: 'synthetic',
    evidence: 'injected',
    realUi: true,
    determinismGate: 'catalog.list 只返回已核验组合；构造未核验 combinationId 直达 main，断言 UNSUPPORTED_COMBINATION/INVALID_INPUT 且无环境创建',
    negativeControl: '已核验组合必须能创建成功，否则“拒绝一切”会伪装成通过',
    requires: ['electron.window', 'renderer.create-select'],
    status: 'blocked',
    blocker: NOT_WIRED,
  },
  {
    id: 'E2E-PROG-01',
    title: '进度与阶段严格单调；未知百分比不编造',
    requirements: ['FR-006'],
    lane: 'synthetic',
    evidence: 'injected',
    realUi: true,
    determinismGate: '受控操作序列按 operation.sequence 推事件；断言 UI 显示与 sequence 单调一致，progress 为 null 时不渲染百分比',
    negativeControl: '倒退的 sequence 或 NULL→数字的伪造进度必须使断言失败；负向 fixture 单独断言被拒',
    requires: ['electron.window', 'operation.progress', 'preload.bridge'],
    status: 'blocked',
    blocker: NOT_WIRED,
  },
  {
    id: 'E2E-PROG-02',
    title: '失败可理解：阶段、错误码、可重试性在 UI 可见且有终态',
    requirements: ['FR-006', 'SC-003'],
    lane: 'synthetic',
    evidence: 'injected',
    realUi: true,
    determinismGate: '注入 DOWNLOAD_FAILED / START_TIMEOUT / PROCESS_EXITED，断言终态元组（status/error.code/retryable）与 UI 文案，不无限轮询',
    negativeControl: '注入成功路径必须不出现 error；任何“两种终态之一”的宽松断言禁止使用',
    requires: ['electron.window', 'operation.progress', 'renderer.start-stop'],
    status: 'blocked',
    blocker: NOT_WIRED,
  },
  {
    id: 'E2E-CANCEL-01',
    title: '取消语义：提交前 cancelled，提交后 CANNOT_CANCEL',
    requirements: ['FR-006'],
    lane: 'synthetic',
    evidence: 'injected',
    realUi: true,
    determinismGate: '文件 gate 卡在提交边界前；cancel 与 release 顺序完全确定，两次运行分别覆盖提交前/后',
    negativeControl: '提交后取消必须返回 CANNOT_CANCEL；若 UI 把已提交操作显示为 cancelled 则失败',
    requires: ['electron.window', 'operation.cancel', 'operation.progress'],
    status: 'blocked',
    blocker: NOT_WIRED,
  },
  {
    id: 'E2E-SUB-01',
    title: '窗口关闭退订：关闭后不再收到推送，订阅可观测释放',
    requirements: ['FR-006', 'FR-008'],
    lane: 'synthetic',
    evidence: 'injected',
    realUi: true,
    determinismGate: 'OrderingLedger 记录 window:closed → unsubscribe:done → push:after-close；推送迟到时断言死信而非状态写入',
    negativeControl: '关闭后退订若不发生，仍到达的推送必须被断言捕获为失败；只断言“窗口消失”不算通过',
    requires: ['electron.window', 'operation.subscribe', 'preload.bridge'],
    status: 'blocked',
    blocker: NOT_WIRED,
  },
  {
    id: 'E2E-TRUST-01',
    title: 'renderer 只有白名单 preload 面：无任意 IPC / Node / 文件系统',
    requirements: ['FR-003', 'FR-007'],
    lane: 'synthetic',
    evidence: 'injected',
    realUi: true,
    determinismGate: '在真实 renderer 上下文中枚举 window 暴露面并与 PRELOAD_CONTRACT_METHODS 逐项比对；无 send/invoke/on 通用入口',
    negativeControl: '故意调用未暴露通道必须抛错/拒绝；若可达则失败',
    requires: ['electron.window', 'preload.bridge', 'ipc.sender-guard'],
    status: 'executed',
    observation: "已执行 2026-09-20 @33bfd1e：真实窗口 window.hdsl 恰为 {call,onOperationUpdated,selectEnvironment}，window.require/process/ipcRenderer/send/invoke/on 均 undefined",
  },
  {
    id: 'E2E-TRUST-02',
    title: 'sender 伪造被拒：未知 webContents / 非白名单来源不产生副作用',
    requirements: ['FR-003', 'FR-007'],
    lane: 'synthetic',
    evidence: 'injected',
    realUi: true,
    determinismGate: '从非主窗口 webContents（或伪造 sender 通道调用）发起请求；断言被拒且 environments/operations 无副作用',
    negativeControl: '主窗口同一请求必须成功，证明拒绝来自 sender 校验而非“全部失败”',
    requires: ['electron.window', 'ipc.sender-guard'],
    status: 'blocked',
    blocker: NOT_WIRED,
  },
  {
    id: 'E2E-TRUST-03',
    title: '子 frame / 非白名单 origin 被拒（iframe 未在真实窗口驱动）',
    requirements: ['FR-003', 'FR-007'],
    lane: 'synthetic',
    evidence: 'injected',
    realUi: true,
    determinismGate: '真实窗口验证 popup 拒绝与 main frame 外部导航拒绝；子 frame 授权仅用 isTrustedDocumentUrl 对 isMainFrame=false 的纯函数断言',
    negativeControl: '主 frame 的精确文档 URL 必须授权（纯函数）；iframe/子 frame 未在真实窗口驱动，不得用 popup/nav 结果声称 iframe 已覆盖',
    requires: ['electron.window', 'ipc.sender-guard'],
    status: 'executed',
    observation: '已执行 2026-09-20 @33bfd1e：真实窗口 window.open 返回 null、外部导航被拒且 URL 不变；子 frame 仅纯函数断言（isMainFrame=false → false），iframe 未测',
  },
  {
    id: 'E2E-TRUST-04',
    title: 'DSH WebUI 页面无 launcher 桥，无法触达高权限 IPC',
    requirements: ['FR-007'],
    lane: 'real-dsh',
    evidence: 'real',
    realUi: true,
    determinismGate: '真实就绪的 DSH 页面（系统浏览器或受控 webContents）断言 preload 缺失、nodeIntegration 关闭、高权限通道不可达',
    negativeControl: '对启动器自身窗口重复同一探测必须能触达受限桥，证明探测自身有效',
    requires: ['webui.native-open', 'electron.window', 'dsh.managed'],
    status: 'executed',
    observation: '已执行 2026-09-20 @33bfd1e（注入 opener 列）：真实浏览器加载 authenticated DSH 页面时 window.hdsl 为 undefined，页面不持有启动器桥；未在 Electron webContents 内加载 DSH',
  },
  {
    id: 'E2E-WEBUI-01',
    title: 'openWebUI 仅打开属于当前受管进程的已验证 loopback，renderer 不见 token URL',
    requirements: ['FR-004'],
    lane: 'synthetic',
    evidence: 'injected',
    realUi: true,
    determinismGate: '受管进程记录的 endpoint 是唯一合法来源；main 在打开前校验 loopback；注入 opener 列用真实浏览器验证落点',
    negativeControl: '换端口/停进程/非 loopback/无 endpoint 必须 WEBUI_UNAVAILABLE 或 INTERNAL_ERROR，且绝不打开；真实 shell.openExternal 未测',
    requires: ['electron.window', 'webui.native-open', 'dsh.managed'],
    status: 'executed',
    observation: '已执行 2026-09-20 @33bfd1e（注入 opener 列）：真实受管进程 loopback 经 main-only bootstrap 后落在去 query canonical origin；未知/无 endpoint 时 WEBUI_UNAVAILABLE（IPC 用例）。真实 shell.openExternal 原生打开未测',
  },
  {
    id: 'E2E-WEBUI-02',
    title: 'token-free origin 返回 401 不得当作 WebUI 可用；认证 bootstrap 不越界',
    requirements: ['FR-004', 'FR-007'],
    lane: 'real-dsh',
    evidence: 'real',
    realUi: true,
    determinismGate: 'runtime token-free origin 当前仅返回 401（认证 bootstrap 由 hdsl-20 独立子切片承担）；断言 401 下 UI 不显示可用 WebUI，且进入受控失败态',
    negativeControl: '把 401 可达当作 running/可用必须使断言失败；“能连上端口”不构成可用性证据',
    requires: ['webui.native-open', 'webui.auth-bootstrap', 'dsh.managed'],
    status: 'blocked',
    blocker: `${NOT_WIRED}；认证 bootstrap 归 hdsl-20 main-only 子切片，未合入前该场景按 401 边界记录`,
  },
  {
    id: 'E2E-CRED-01',
    title: 'main 原生菜单导入仅引用凭据配置 → 启动按引用注入',
    requirements: ['FR-003', 'FR-007'],
    lane: 'synthetic',
    evidence: 'injected',
    realUi: true,
    determinismGate: '受控 main 环境用 fixture 引用配置走原生菜单入口；断言：引用被接受、启动 env 按引用解析、过程无 value 落盘',
    negativeControl: '含 value/secret 字段的配置必须被拒且不落盘；若被接受则失败',
    requires: ['electron.window', 'credentials.menu-import', 'preload.bridge', 'dsh.managed'],
    status: 'executed',
    observation: '已执行 2026-09-20 @33bfd1e（qa-entry 测试注入列，非原生菜单）：stderr applied；credentials.json 0600、含引用 id/key、无 secret 值。真实原生菜单导入仍未测',
  },
  {
    id: 'E2E-CRED-02',
    title: 'malformed / 超限 / 含密字段的凭据配置被拒且不持久化',
    requirements: ['FR-007'],
    lane: 'synthetic',
    evidence: 'injected',
    realUi: true,
    determinismGate: '逐一投放 malformed JSON、strict-schema 额外字段、超尺寸、含 value/token 字段的配置；断言拒绝 + 目标路径无新文件',
    negativeControl: '合格引用配置必须成功导入，否则“一律拒绝”会伪装成通过',
    requires: ['electron.window', 'credentials.menu-import'],
    status: 'executed',
    observation: "已执行 2026-09-20 @33bfd1e（qa-entry 注入列）：含 value 字段文档 rejected at parse，credentials.json 未生成，secret 不入 stderr",
  },
  {
    id: 'E2E-CRED-03',
    title: '旧选择/revision 被拒：环境状态或组成修订变化后旧配置不得生效',
    requirements: ['FR-003', 'FR-007'],
    lane: 'synthetic',
    evidence: 'injected',
    realUi: true,
    determinismGate: '导入后推进 stateVersion/revision（或停止环境），再以旧选择启动；断言 REVISION_CONFLICT/ENVIRONMENT_BUSY 且无副作用',
    negativeControl: '未变化的合法路径必须成功，证明拒绝来自守卫而非随机失败',
    requires: ['electron.window', 'credentials.menu-import', 'renderer.start-stop'],
    status: 'blocked',
    blocker: NOT_WIRED,
  },
  {
    id: 'E2E-BOOTSTRAP-01',
    title: '认证 bootstrap 不进 renderer/导出/操作记录/普通日志',
    requirements: ['FR-007'],
    lane: 'real-dsh',
    evidence: 'real',
    realUi: true,
    determinismGate: 'bootstrap 完成后以 canary 字符串全量扫描 renderer 快照、导出产物、operation 记录与日志',
    negativeControl: 'canary 必须先在 fixture 中可被 findSecretHits 找到（正控），否则“扫不到”不构成泄漏证据',
    requires: ['webui.auth-bootstrap', 'diagnostics.export', 'dsh.managed'],
    status: 'blocked',
    blocker: `${NOT_WIRED}；认证 bootstrap 归 hdsl-20 独立子切片`,
  },
  {
    id: 'E2E-DIAG-01',
    title: '诊断导出默认排除凭据引用与上游含密文件，且不含 canary',
    requirements: ['FR-007'],
    lane: 'synthetic',
    evidence: 'fixture',
    realUi: true,
    determinismGate: '环境 home 预置 .credentials.yaml 与 logs/** canary；导出后扫描产物，断言默认排除集与零命中',
    negativeControl: '故意改宽默认排除（或把 canary 放进导出源）必须使断言失败；导出不得返回本地路径',
    requires: ['electron.window', 'diagnostics.export'],
    status: 'executed',
    observation: "已执行 2026-09-20 @33bfd1e（qa-entry 注入列）：导出 {exportId,exported:true,redacted:true}；文件不含 canary/.credentials.yaml/credentials.json/dataRoot 原文；同 requestId 重放不重写",
  },
  {
    id: 'E2E-ISO-01',
    title: '隔离 dataRoot：宿主 HOME/~/.dsh 快照不变',
    requirements: ['FR-001'],
    lane: 'synthetic',
    evidence: 'fixture',
    realUi: true,
    determinismGate: 'captureHostGuard 前后逐条比较；diff 非空即失败（guard 反应性由 harness 负向控制证明）',
    negativeControl: '向守卫路径写入一个临时文件使 diff 非空，证明守卫能失败；随后清理并复测相等',
    requires: ['electron.window', 'dataRoot.lock'],
    status: 'blocked',
    blocker: NOT_WIRED,
  },
  {
    id: 'E2E-ISO-02',
    title: '两个环境分别启动，配置/数据/凭据不互相读取',
    requirements: ['FR-001', 'SC-001'],
    lane: 'real-dsh',
    evidence: 'real',
    realUi: true,
    determinismGate: '两个隔离 home 各有独立 canary；分别在真实 DSH 启动后断言 A 的产物不出现 B 的 canary，且差异可证',
    negativeControl: '把 B 的 canary 放进 A 的 home 必须被断言捕获（可失败），否则隔离断言恒真',
    requires: ['electron.window', 'renderer.create-select', 'renderer.start-stop', 'dsh.managed'],
    status: 'blocked',
    blocker: NOT_WIRED,
  },
  {
    id: 'E2E-LOCK-01',
    title: '双实例同一 dataRoot：第二实例在启用 UI 操作前被有界拒绝',
    requirements: ['FR-001', 'FR-008'],
    lane: 'synthetic',
    evidence: 'injected',
    realUi: true,
    determinismGate: '实例 A 持锁写 ready 文件；实例 B 启动后 UI 操作不可用且给出明确拒绝，A 的状态不变',
    negativeControl: 'A 退出后 B 必须能接管，否则“永久拒绝”会伪装成通过',
    requires: ['electron.single-instance', 'dataRoot.lock', 'electron.window'],
    status: 'executed',
    observation: "已执行 2026-09-20 @33bfd1e：同 user-data-dir 第二进程经 requestSingleInstanceLock 退出，首实例仍可服务",
  },
  {
    id: 'E2E-LOCK-02',
    title: '同一 dataRoot 被占用：第二实例被拒且既有 lease 不被改写',
    requirements: ['FR-001', 'FR-008'],
    lane: 'synthetic',
    evidence: 'injected',
    realUi: true,
    determinismGate: '第二实例有界内无 page；同配置在空闲 root 的正控能开窗（归因）；lease.json 的 pid 仍为首实例；终止第二实例后不变',
    negativeControl: '正控必须开窗，否则不能把“无 page”归因于 dataRoot 拒绝；生产该路径无 stderr/exit 信号，已作为最小可观测性缺口报告',
    requires: ['electron.single-instance', 'dataRoot.lock'],
    status: 'executed',
    observation: '已执行 2026-09-20 @33bfd1e：第二进程 8s 内无 page；lease.json pid 仍为首实例；同配置空闲 root 正控开窗；终止第二进程后 lease 不变',
  },
  {
    id: 'E2E-RESTART-01',
    title: '应用重启对账未结束操作与自有进程',
    requirements: ['FR-008'],
    lane: 'synthetic',
    evidence: 'injected',
    realUi: true,
    determinismGate: '提交边界 gate 卡住后杀掉应用；重启读取 journal 后断言未结束操作可查询、自有进程按身份回收',
    negativeControl: '存活的无关对照进程必须不被终止；不可证归属时不得杀',
    requires: ['electron.window', 'reconcile.restart', 'dsh.managed'],
    status: 'blocked',
    blocker: NOT_WIRED,
  },
  {
    id: 'E2E-PROC-EXIT-01',
    title: '受管 DSH 意外退出 → PROCESS_EXITED，UI 不长期停在 running',
    requirements: ['FR-005', 'FR-006'],
    lane: 'synthetic',
    evidence: 'injected',
    realUi: true,
    determinismGate: '受控子进程写 ready 后立即退出；退出由 close 事件判定，不靠 sleep 或轮询猜测',
    negativeControl: '正常运行的对照环境必须保持 running，证明退出检测不是恒真',
    requires: ['electron.window', 'renderer.start-stop', 'dsh.managed', 'operation.progress'],
    status: 'blocked',
    blocker: NOT_WIRED,
  },
  {
    id: 'E2E-BROWSER-01',
    title: '注入 opener：真实浏览器完成认证并落到可用页面（去 query canonical origin）',
    requirements: ['FR-004', 'FR-007'],
    lane: 'real-dsh',
    evidence: 'real',
    realUi: true,
    determinismGate: '真实 Chrome 临时 profile + CDP；bootstrap URL 只经 Page.navigate；有界等最终 location 等于去 query canonical origin',
    negativeControl: 'Page.navigate 返回不算认证成功：若最终 URL 仍带 token query、或认证后 DOM 为空，断言失败；不开 Network 域、不 dump cookie',
    requires: ['webui.native-open', 'webui.auth-bootstrap', 'dsh.managed'],
    status: 'executed',
    observation: '已执行 2026-09-20 @33bfd1e（注入 opener 列）：真实受管 DSH 启动后 bootstrap 经 Page.navigate；认证页断言 rc2 身份（title=DeepSeek Harness + #root [data-slot=root] + 新会话/DOM）；cold 无 cookie 的第二 profile 不出现该 shell（负向）；自建随机 keychain canary 删除并复检不存在。不等于真实 shell.openExternal 原生打开',
  },
  {
    id: 'E2E-LOCK-03',
    title: 'owner 退出后新实例可重新获取同一 dataRoot（释放/再获取与拒绝分栏）',
    requirements: ['FR-001', 'FR-008'],
    lane: 'synthetic',
    evidence: 'injected',
    realUi: true,
    determinismGate: '首实例退出后以同 dataRoot 启动新实例；断言 lease.json 的 pid 变为新实例且窗口可服务',
    negativeControl: '若旧 lease 仍在或新实例无法获取则失败；与 LOCK-02 的拒绝场景分开，不互相代替',
    requires: ['electron.window', 'dataRoot.lock'],
    status: 'executed',
    observation: '已执行 2026-09-20 @33bfd1e：首实例退出后新实例获取 lease（pid 变更）并可调用 catalog.list',
  },
  {
    id: 'E2E-GUI-STARTSTOP-01',
    title: 'production 真实 React 点击启停：进度与终态可见（凭据为 setup 注入）',
    requirements: ['FR-005', 'FR-006'],
    lane: 'real-dsh',
    evidence: 'real',
    realUi: true,
    determinismGate: 'CDP 真实鼠标点击 production UI 的启动/停止按钮；有界等操作面板出现与状态标签变为运行中/已停止',
    negativeControl: '按钮禁用或状态标签不变则失败；凭据经已受审 core 接口 setup 注入并明确标注，不冒充原生菜单导入',
    requires: ['electron.window', 'renderer.start-stop', 'operation.progress', 'dsh.managed'],
    status: 'executed',
    observation: '已执行 2026-09-20 @33bfd1e：setup 注入引用 + 自建 keychain canary 后，真实点击启动→面板显示启动→状态运行中；点击停止→已停止；契约确认 stopped',
  },
];

export interface PlanViolation {
  readonly id: string;
  readonly problem: string;
}

/**
 * Pure consistency validator. `harness.test.ts` runs it over the real catalogue
 * and over deliberately broken synthetic entries (negative control), so the
 * plan cannot silently drift into "everything is green".
 */
export const validateScenarioPlan = (
  scenarios: readonly PlannedScenario[],
): readonly PlanViolation[] => {
  const violations: PlanViolation[] = [];
  const seen = new Set<string>();
  for (const scenario of scenarios) {
    if (scenario.id.trim() === '') {
      violations.push({ id: '(empty)', problem: 'id must not be empty' });
    }
    if (seen.has(scenario.id)) {
      violations.push({ id: scenario.id, problem: 'duplicate id' });
    }
    seen.add(scenario.id);
    if (scenario.requirements.length === 0) {
      violations.push({ id: scenario.id, problem: 'must cite at least one requirement' });
    }
    for (const requirement of scenario.requirements) {
      if (!/^(FR|SC)-\d{3}$/.test(requirement)) {
        violations.push({ id: scenario.id, problem: `malformed requirement id: ${requirement}` });
      }
    }
    if (scenario.determinismGate.trim() === '') {
      violations.push({ id: scenario.id, problem: 'must declare a determinism gate' });
    }
    if (scenario.negativeControl.trim() === '') {
      violations.push({ id: scenario.id, problem: 'must declare a negative control' });
    }
    if (scenario.realUi && scenario.lane !== 'real-dsh' && scenario.lane !== 'synthetic') {
      violations.push({
        id: scenario.id,
        problem: `realUi scenario must run the real Electron window (lane=${scenario.lane})`,
      });
    }
    if (!scenario.realUi && (scenario.lane === 'real-dsh' || scenario.lane === 'synthetic')) {
      violations.push({
        id: scenario.id,
        problem: `non-realUi scenario should not claim a window lane (lane=${scenario.lane})`,
      });
    }
    if (scenario.requires.length === 0) {
      violations.push({ id: scenario.id, problem: 'must declare required capabilities' });
    }
    if (scenario.status === 'blocked' && (scenario.blocker ?? '').trim() === '') {
      violations.push({ id: scenario.id, problem: 'blocked scenario must state a blocker' });
    }
    if (scenario.status === 'ready' && scenario.blocker !== undefined) {
      violations.push({ id: scenario.id, problem: 'ready scenario must not carry a blocker' });
    }
    if (
      scenario.status === 'executed' &&
      (scenario.blocker !== undefined || (scenario.observation ?? '').trim() === '')
    ) {
      violations.push({
        id: scenario.id,
        problem: 'executed scenario must record an observation and no blocker',
      });
    }
  }
  return violations;
};

/** Requirements that must have at least one planned scenario. */
export const REQUIRED_REQUIREMENTS: readonly string[] = [
  'FR-001',
  'FR-002',
  'FR-003',
  'FR-004',
  'FR-005',
  'FR-006',
  'FR-007',
  'FR-008',
];

export const uncoveredRequirements = (
  scenarios: readonly PlannedScenario[],
  required: readonly string[] = REQUIRED_REQUIREMENTS,
): readonly string[] => {
  const covered = new Set(scenarios.flatMap((scenario) => [...scenario.requirements]));
  return required.filter((requirement) => !covered.has(requirement));
};

/** Distinct reasons the desktop suite cannot run yet. */
export const candidateBlockers = (): readonly string[] => {
  const unique = new Set<string>();
  for (const scenario of DESKTOP_E2E_SCENARIOS) {
    if (scenario.status === 'blocked' && scenario.blocker !== undefined) {
      unique.add(scenario.blocker);
    }
  }
  return [...unique];
};
