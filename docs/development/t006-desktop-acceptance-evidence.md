# T006 桌面界面与脱敏诊断 — 当前 main 验收证据

状态：**当前基线 macOS ARM64 实机验收通过**。本文件只记录本次在本机 production Electron 上真实执行的结果与未测边界，不改变任何生产行为，也不代表 Windows/Linux 或原生面板已验收。

- 任务：[#6 T006 实现简洁环境界面与脱敏诊断](https://github.com/YingkeSu/HDSL/issues/6)；依赖 T005（[#5](https://github.com/YingkeSu/HDSL/issues/5)，已关闭）。
- 基线 SHA：`a36fdb96cbc8be529f5ddd68d132fc9adc92ffe9`（`origin/main`）。
- 平台：macOS 26.3（Build `25D125`，Darwin arm64）；Node `v24.21.0`（`.nvmrc`）；pnpm `11.7.0`；Electron `44.4.3`。
- 本文件与新增回归测试所有权：T006 实现方。`tests/e2e/**` 与 [desktop-validation.md](desktop-validation.md) 仍归独立 QA（hdsl-25），本文件不修改它们。

## 1. 相对当前 main 的验收差距

对比 `docs/development/desktop-integration.md`（实现时基线 `cd8ca74`）与 `docs/development/desktop-validation.md`（QA 候选 `2cdea54`/`df3508b`/`3174447`）后确认：

**已交付、本次未重复实现**：环境创建/列表/选择/启停 UI、窄 preload 桥、sender 校验、精确文档 URL 导航策略、脱敏诊断导出、WebUI main-only 认证 bootstrap、组合根 dataRoot 独占门禁。这些在本基线 unit/desktop 测试中为绿。

**真实缺口（本次处置）**：

1. 上述 desktop 验收证据都锚定在旧候选 SHA（`2cdea54` 等），早于当前 main 的插件 MVP 系列改动；没有当前基线的真实 production Electron 证据。
2. “dataRoot 独占门禁必须在启用 UI 操作前生效”只有 composition 级与 E2E 级证据，缺少**源码顺序级**的回归守卫（防止后续重构把窗口/IPC 构造挪到门禁之前）。
3. `desktop-integration.md` 的“未验证/缺口”段落与后续已执行的真实证据相互矛盾（例如仍称真实 GUI 点击未执行）。

本次交付：新增 1 条源码顺序回归测试（`tests/desktop/entry-boundary.test.ts`），并在当前基线重跑全部真实桌面验收并如实记录。**未发现生产代码缺陷，故未改 `apps/desktop/src`**。

## 2. 验收目标映射（当前基线真实证据）

| #6 验收目标 | 真实证据（当前基线） | 分栏 |
| --- | --- | --- |
| UI 完成创建、选择、启停 | `E2E-CREATE-01` 纯键盘创建→真实受管安装（Node 22.19.0 + DSH 0.1.5-rc.2，npm-ci）→`stopped`；`E2E-WIN-02` 真实键盘焦点/受控输入；`E2E-GUI-START-STOP-01` production React 真实鼠标点击启停→`运行中`/`已停止` | 真实 production Electron |
| 进度与错误可理解 | `E2E-GUI-START-STOP-01` 操作面板阶段与状态标签终态；`tests/renderer/ui.test.ts` 进度已知/未知、错误码+可重试、首次快照失败可重试；`tests/desktop/main-ipc.test.ts` 受控错误码 | 真实 GUI + renderer/unit |
| DSH 页面无法调用高权限 IPC | `E2E-BROWSER-01` 真实 Chrome 加载已认证 DSH 页面，页面无启动器桥（并有 cold 无 cookie 负向对照）；`E2E-IFRAME-01` production 窗口 `srcdoc` 子 frame 无桥、`data:` 导航失败；`E2E-SENDERFRAME-01` 真实子 frame 携带生产桥发真实 IPC 在 dispatch 前被拒；`E2E-WIN-01` `window.hdsl` 恰为三成员；`E2E-TRUST-01` popup/外导航拒绝 | 真实浏览器（注入 opener）/ 真实窗口 / 测试宿主 |
| 导出诊断不含 canary | `E2E-QAENTRY-DIAG-01` 导出 `{exported:true,redacted:true}`，文件不含 canary/`.credentials.yaml`/`credentials.json`/dataRoot 原文；`tests/desktop/main-diagnostics.test.ts` 白名单与 canary 负向 | 测试注入（qa-entry）+ unit |
| 组合根单实例/dataRoot 独占在 UI 前生效 | `E2E-LOCK-01` 同 user-data 第二进程退出；`E2E-LOCK-02` 同 dataRoot 第二实例固定 stderr `reason=busy`、无 page、`lease.json` pid 不变、空闲 root 正控开窗；`E2E-LOCK-03` 退出后新实例重获；`tests/desktop/main-composition.test.ts` 双实例拒绝；**新增** `entry-boundary` 源码顺序守卫 | 真实 production Electron + unit |

## 3. 执行命令与结果（当前基线）

工程检查（Node 24.21.0）：

```sh
pnpm install --frozen-lockfile
pnpm run typecheck                  # PASS
pnpm run build:desktop              # PASS（tsc -b + esbuild renderer bundle）
pnpm test                           # 107 files passed | 11 skipped；1029 passed | 27 skipped
python3 scripts/check_repository.py # PASS
```

真实 production Electron（opt-in；每文件独立注册 `hdsl-e2e-*` 临时 dataRoot/user-data，真实网络安装，无模型调用）：

```sh
HDSL_E2E_DESKTOP=1      pnpm exec vitest run tests/e2e/desktop.real.test.ts            # 9 passed，84.1s
HDSL_E2E_DESKTOP=1      pnpm exec vitest run tests/e2e/desktop.findings.real.test.ts   # 2 passed，45.0s
HDSL_E2E_IFRAME=1       pnpm exec vitest run tests/e2e/desktop.iframe.real.test.ts     # 2 passed，5.0s
HDSL_E2E_SENDERFRAME=1  pnpm exec vitest run tests/e2e/desktop.sender-frame.real.test.ts # 2 passed，0.5s
HDSL_E2E_DESKTOP=1      pnpm exec vitest run tests/e2e/desktop.injected.real.test.ts   # 3 passed，91.7s
HDSL_E2E_GUI=1          pnpm exec vitest run tests/e2e/desktop.gui.real.test.ts        # 1 passed，50.2s
HDSL_E2E_BROWSER=1      pnpm exec vitest run tests/e2e/desktop.browser.real.test.ts    # 1 passed，44.1s
pnpm exec vitest run tests/e2e/harness.test.ts                                          # 17 passed（always-on）
```

真实/注入分栏逐条：

| 用例 | 结果 | 分栏（可作何证据） |
| --- | --- | --- |
| E2E-WIN-01/02、TRUST-01、IPC-01 | 通过 | 真实 production Electron 窗口 + CDP |
| E2E-LOCK-01/02/03 | 通过 | 真实 production Electron；`E2E-LOCK-02` 断言固定脱敏 stderr、无 page、lease 归属不变、空闲 root 正控 |
| E2E-CREATE-01 | 通过 | 真实 production Electron；真实受管安装落盘 |
| E2E-AUTH-01、E2E-HOOK-01 | 通过 | 纯函数授权边界 + 生产入口不读测试钩子（`E2E-HOOK-01` 真实启动） |
| E2E-IFRAME-01/02 | 通过 | 真实生产窗口子 frame 边界 + always-on 分类器负控 |
| E2E-SENDERFRAME-01/02 | 通过 | **测试宿主列**：仅宿主开启子 frame 节点集成；证明生产 sender 判定，不是产品第一层防线 |
| E2E-QAENTRY-DIAG-01、CRED-01/02 | 通过 | **测试注入列**（`qa-entry` 固定路径）；不能替代原生菜单/对话框 |
| E2E-GUI-START-STOP-01 | 通过 | 真实 production UI 点击；凭据为 setup 注入 + 自建随机 keychain canary，**非**原生菜单导入 |
| E2E-BROWSER-01 | 通过 | 真实受管 DSH + 真实 Chrome；**注入 opener**（`Page.navigate`），不等同真实 `shell.openExternal` |

## 4. #5 跨进程 dataRoot 独占证据复核（只读）

[#5](https://github.com/YingkeSu/HDSL/issues/5) 已关闭。其跨进程独占实现归 core（#43），本次在当前基线复跑并确认仍为真实第二进程证据，未改动：

```sh
pnpm exec vitest run tests/core/data-root-lock.test.ts tests/core/data-root-lock.process.test.ts
# 18 passed，3.3s
```

其中 `data-root-lock.process.test.ts` 覆盖：真实第二进程被拒、崩溃接管并保留 quarantine 证据、guard 端口释放、多真实进程竞争恰好一个持有者。`E2E-LOCK-02/03` 在真实 production Electron 上另行确认同一 dataRoot 的拒绝与释放后重获。本文件**不**声明 T005 整体验收，仅确认其锁证据在本基线可用。

## 5. 清理与凭据边界

- 所有真实/注入用例使用注册的 `hdsl-e2e-*` 临时 dataRoot/user-data（`mkdtemp` 下），不读个人 keychain、不调用模型、不碰用户 `~/.dsh` 或用户浏览器 profile。
- `E2E-GUI-START-STOP-01` 与 `E2E-BROWSER-01` 使用**自建随机** canary 写入 macOS `security` keychain，`finally` 删除。
- 取证后复核：无残留 `hdsl-qa-*` keychain 项、无残留 `/tmp/hdsl-e2e-*` 根、无残留 HDSL Electron 进程。未使用任何个人凭据；未触碰 #97 许可文件或 #88 历史 QA 样本。
- 真实安装产物由 harness 清理；本文件不保存任何 secret 或派生值。

## 6. 未测 / 非声明（不得读作已完成）

- **Windows x64 / Linux**：未测，不声明支持。
- **原生菜单与原生 NSOpenPanel/NSSavePanel**：未自动执行（宿主能力/权限限制），真实人工操作仍未验证；“真实系统浏览器 `shell.openExternal`”同样未测，注入 opener 列不可互代。
- **进度/错误的全真实 Electron 故障注入**：错误码与可重试性由 renderer 组件测试与受控契约用例覆盖；未在真实 Electron 上注入 `START_TIMEOUT`/`PROCESS_EXITED` 破坏路径。计划中的 `E2E-PROG-01/02` 仍在其 QA 场景计划中登记。
- **`tests/e2e/scenarios/desktop-e2e-scenario-plan.ts` 的 `blocked: NOT_WIRED` 标记**：与当前已接线 main 漂移（该文件与 `desktop-validation.md` 归 QA 所有，本文件不改动，仅记录漂移供 QA 处理）。
- **#88 Electron 退出/租约观察**：不在本切片范围，本文件不作结论、未改其样本。
- **DSH 认证 token 的时效/撤销语义**：未验证，不声称一次性或短期有效。

结论：在当前基线 `a36fdb96` 的 macOS ARM64 上，T006 四项验收目标与 dataRoot 独占补充验收均有真实 production Electron（或明确分栏的注入/测试宿主）证据支撑；生产代码无需改动。完成即停止。
