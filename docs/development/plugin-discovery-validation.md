# 插件发现与详情 S1 验证记录（#75）

本记录只对下列版本、平台与命令有效；它不把 mock 当真实网络，也不把本地 fixture 当作真实 GitHub 全链路证据。

- 平台：macOS 26.3（Apple Silicon，arm64）；Node `24.21.0`（`.nvmrc`）；pnpm `11.7.0`。
- 范围：S1 插件发现与详情（GitHub 只读检索闭环）。S2 预览/变更/恢复未实现。

## rev 2（独立复审 CHANGES_REQUESTED 后的修复）

- **必修 1**：1.0→1.1 的 E2E harness 迁移由本片承接：`tests/e2e/support/desktop-ui.ts` 的
  `CONTRACT_API_VERSION` 改为引用共享 `API_VERSION`；`sender-frame-parent/child.html` 改用
  `__HDSL_API_VERSION__` 占位符，由 `desktop.sender-frame.real.test.ts` 生成临时页时注入。
  始终运行的 fixture sanity 用例断言占位符存在且不再有硬编码 `1.0`。
- **CR 建议 1（同时修）**：GitHub 适配器把 `response.json()` 纳入同一 15s deadline 与调用方 abort；新增
  「响应头已到、body 停住」的超时与取消测试。
- **建议 2**：自由文本 `description` 带省略号裁剪到 512；`license` 超出则置空；结构性标识/URL 不裁剪，
  超界/非法时只丢弃该条命中并以 `incompleteResults=true` 暴露，补超界/坏命中回归测试。
- **建议 3**：新增标记级转义负控（`description`/`topics`/`license` 含 `<script>`/`<img onerror>` → 实际 HTML 不含原始标签）。
- **建议 4**：详情面板接入 `plugins.inspect`（选中命中后可重新获取权威详情），并同步 002 规格口径。
- **建议 5**：新增契约层组合路由用例：`operations.cancel` 命中插件操作且不回落环境服务；未知 id 仍回落为 `NOT_FOUND`。

### rev 2 有界真实 Electron 抽查

- 同一一次性 CDP 探针从真实窗口调用 `catalog.list`（使用共享 `API_VERSION` 构造信封）：`ok=true`、返回 2 个已核验组合；证明迁移后的 harness 版本与 1.1 主进程匹配。
- 重跑一次有界真实 GitHub 只读探针（未认证，一次 search + 一次 inspect，`per_page=10`）：search succeeded（`totalCount=15659`、`hasMore=true`、最长 description 345 字符），inspect succeeded（`deepseek-ai/deepseek-harness`），确认 body deadline/裁剪重构未破坏真实链路。


## 自动化检查（默认 CI 口径）

| 命令 | 结果 |
| --- | --- |
| `pnpm run typecheck` | 通过 |
| `pnpm run build:desktop` | 通过（main/preload 与 renderer bundle） |
| `pnpm test` | 通过：69 个文件、728 项通过、24 项跳过（跳过项为既有 opt-in 证据测试） |
| `python3 scripts/check_repository.py` | 通过（23 个必需文件、154 条本地链接） |

新增测试（均为受控响应，不访问真实网络）：

- `tests/plugins/github-source.test.ts`：精确查询编码、`total_count`/`incomplete_results`/1000 上限口径、
  403/429 → `RATE_LIMITED` + `retryAfterSeconds`、连接失败/超时 → `NETWORK_UNAVAILABLE`、
  不读取 `GITHUB_TOKEN`、404 → `SOURCE_NOT_FOUND`、仓库名含 `_`/`.`。
- `tests/plugins/plugin-discovery.test.ts`：succeeded 携带 payload、受限流失败映射、**取消为终态且迟到结果不能复活**、非插件操作不归该服务所有。
- `tests/contracts/plugin-output.test.ts`：逐 kind `OperationSnapshot.output` 规则、`retryAfterSeconds` 上线、
  `plugins.search` 全局且不查询环境。
- `tests/renderer/plugin-discovery.test.ts`：控制器发送的查询逐字符一致、限流提示、网络失败不改变环境组成、
  取消终态；DOM-free React 标记断言（精确查询、非安全声明、截断口径、S2 预览占位）。
- 契约 fixture 表新增 `plugins.search`/`plugins.inspect` 行与 `1.1`（minor 不匹配行迁移为 `1.2`）。

## 浏览器模拟层（DOM-free React）

`tests/renderer/plugin-discovery.test.ts` 与 `tests/acceptance/renderer/static-markup.acceptance.test.ts`
通过 `react-dom/server` 渲染正式组件，断言状态矩阵与可访问结构。它证明组件行为，
**不是** Electron 实机、DSH 安装或真实 GitHub 验收。

## Electron 层（真实窗口，bounded）

- `node apps/desktop/scripts/smoke-electron.mjs`：通过；`window.hdsl` 只暴露
  `call`/`onOperationUpdated`/`selectEnvironment`，无 `require`/`process`/`ipcRenderer`，React 已挂载。
- 一次性 CDP 探针（未入库，bounded，不创建环境、不启动受管进程）驱动真实窗口进入「发现插件」页：
  - 默认查询框与检索后展示的精确查询均为 `topic:dsh-plugin fork:false archived:false`，逐字符一致；
  - 真实 GitHub 检索成功：`total_count=15649`、`incomplete_results=false`、返回 100 行、显示
    “最多返回前 1000 条 / 还有更多结果未显示”；
  - 结果详情面板打开，来源预览按钮为 `disabled`，并显示“预览本体属于 S2、当前版本尚未实现”；
  - “发现不代表可安装或安全”“仅展示，不作为安全或可安装性依据”均渲染。

## 真实 GitHub 只读探针（显式有界，不进默认 CI）

- 方式：未认证 `api.github.com`，仅 `plugins.search` + 一次 `plugins.inspect`，`timeoutMs` 5–8 秒、`per_page` 5–100；
  通过已构建的 `createGitHubPluginSource` 直接调用；结果：
  - 一次探针在限额耗尽时得到真实 `403/429` 路径 → `RATE_LIMITED`，`retryAfterSeconds` 由
    `x-ratelimit-reset` 计算（证明真实限流形态可机读），未重试、未轮询；
  - 限额恢复后：`plugins.search` succeeded（`totalCount=15649`，`hasMore=true`），
    `plugins.inspect` succeeded（`deepseek-ai/deepseek-harness`）；
  - 该探针发现真实仓库名可含 `_`（如 `AI_Animation`），据此修正仓库名 schema 并补回归测试
    （此前会把合法结果误判为 `INTERNAL_ERROR`）。
- 局限：仅一次成功调用，不覆盖 TLS/代理/重定向/真实排序/`codeload`；本地 fixture 不等于真实链路。

## 未测边界

- Windows x64/Linux：未测，保持未测（本片不改变平台支持声明）。
- 真实 DSH 安装、受管进程、安装期脚本授权与卸载：未测（S2–S4）。
- 真实 Electron 中的取消：未在真实窗口观测（控制器与服务层已单测）；检索过快，未构造稳定取消窗口。
- Playwright 浏览器交互脚本：未运行（未安装 Playwright，不为此新增依赖）。
- S2 来源预览/变更计划/应用/恢复与 `preview`/`apply`/`restore` kind：**未实现**，界面明确标注，不伪造成功。
