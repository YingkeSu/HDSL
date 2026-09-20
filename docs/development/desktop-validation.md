# 桌面主流程 E2E QA 准备与边界（T007c / #64，父任务 #7）

- Owner：hdsl-25（独立 QA）。本文件与 `tests/e2e/**` 归本切片独占；其它路径只读。
- 基线（base）：`cd8ca74bece8844f00f9988ec5494575f750e577`（`origin/main`，已 `git fetch` 核实）。
- 交付分支：`ao/hdsl-25/t007c-desktop-e2e-prep`（base 之上的单一 QA 提交；精确 head 见对应 PR）。
- 日期：2026-09-20。
- 实机平台：macOS 26.3（Darwin 25D125）arm64；Node v24.21.0；pnpm 11.7.0。
- 说明：本文件是**准备与计划**。真实 Electron/React 窗口与 IPC 验收在 #6 候选就绪前保持 `blocked`，不把夹具自检或 SSR/demo 结果当作桌面验收。

## 所有权与范围

本切片只做两件事：

1. 可执行的**安全夹具自检**（`tests/e2e/harness.test.ts` + `tests/e2e/support/**`）：证明夹具真实、确定、可清理、可失败。
2. **需求 → 场景映射**（`tests/e2e/scenarios/desktop-e2e-scenario-plan.ts`）：逐条列出 #6 就绪后要跑的真实窗口/IPC 场景、确定性闸门、负向对照与阻塞原因。

不实现生产代码、不修改 `apps/desktop/**`、不修改其它切片（`tests/integration/**`、`tests/renderer/**`、`tests/acceptance/**`）的单测、不 review PR。

## 状态

| 项 | 状态 |
| --- | --- |
| T006 桌面壳（#6） | **未就绪**：`apps/desktop/src/main/index.ts` 仍是 T002/T006 placeholder（`bootstrapDesktop()` 直接抛错，无窗口、无 `ipcMain`、preload 未接 `contextBridge`）；`ao/hdsl-24/root` 相对 `main` 无提交 |
| 与 #6 的边界冻结 | **已请求**（`ao send` → hdsl-24）；回复未到位前按“未定”处理 |
| 夹具自检 | **完成**：17 条真实 vitest 通过 |
| 场景套件 | **未注册**：24 条全部 `blocked`，不使用 `skip` / `it.fails` 冒充完成 |

## 去重：本切片补什么

| 已有证据 | 覆盖 | 本切片不重复 |
| --- | --- | --- |
| #31 / PR #41（`tests/integration/install`） | 创建/安装的真实文件、摘要、磁盘、路径安全 | 不重跑安装边界 |
| #45 / PR #47、#50、#63（`tests/integration/process`） | 进程启停/所有权/端口/超时/锁 | 不重跑进程生命周期 |
| `tests/acceptance/renderer`（PR #34/#38） | renderer controller 黑盒行为 + DOM-free SSR 标记 | 不用 SSR 代替真实窗口 |
| `tests/contracts`、`tests/acceptance/contracts` | 契约包络/幂等/脱敏 | 不重跑契约夹具 |
| 本切片（`tests/e2e`，T007c） | **真实 Electron 窗口 + preload IPC + 原生打开 + 诊断导出 + 单实例/dataRoot 门禁** | 补 E2E 层，不替代上面任一层 |

## 与 #6 的边界冻结请求

已在 `ao send` 中向 hdsl-24 请求冻结；在得到候选 SHA 与答复前，下列均为**待定**，场景据此保持 `blocked`：

1. **Electron 启动入口**：`main` 字段是否仍指 `dist/main/index.js`；受控/无头启动方式；是否提供可观测入口（如 `--remote-debugging-port` 或等价受限 test hook）；Electron 版本（当前锁定 44.4.3）。
2. **隔离 dataRoot**：main 从何处读取（env `HDSL_DATA_ROOT` / CLI flag / 用户配置）；是否强制单实例或 dataRoot 独占锁（#6 补充验收）；双实例拒绝行为与退出后锁释放的观测方式。
3. **可信窗口 / 发送方**：窗口是否保持 `SECURE_WINDOW_DEFAULTS`（`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`，见 [tdd.md](../architecture/tdd.md)）；preload 暴露面的确切对象名/方法名；sender 校验策略（`webContents` 身份、origin 白名单、拒绝子 frame、拒绝 DSH WebUI 页面）及其可观测信号。
4. **进度观测**：`progress`/`phase` 推送到 renderer 的通道；窗口关闭/卸载时的 `unsubscribe` 生命周期；失败/取消的 UI 文案与错误码；诊断导出是否为 main 原生保存对话框且只返回 `{ exportId, exported, redacted }`（不含路径）。
5. **测试依赖归属**：真实窗口驱动需要额外依赖（Playwright Electron 或等价 CDP 客户端）。根 `package.json` / `pnpm-lock.yaml` 属 #6 所有者；本切片**不并发修改 lockfile**，等待 #6 或编排者指定 root 配置 owner。
6. **就绪信号**：候选实现到精确 SHA 后，据此恢复真实窗口/IPC 验收。

### 编排者补充冻结项（2026-09-20）

- **WebUI 可用性**：runtime 现阶段的 token-free origin 只返回 **401**；认证 bootstrap 由 hdsl-20 的 main-only 独立子切片承担。**401 可达不等于 WebUI 可用**，不得据此显示 running/可用（见 `E2E-WEBUI-02`、`E2E-BOOTSTRAP-01`）。
- **凭据配置入口**：仅允许 main 原生菜单导入**只含引用**的配置文件（大小上限、strict schema、禁止 value 字段；main 侧环境 revision/state 守卫）。冻结 IPC **不新增**通用凭据查询或文件路径入口。
- **QA 覆盖要求**：真实菜单入口配置引用 → 启动；malformed / 含密字段配置被拒且不落盘；旧选择/revision 被拒；DSH 页面无桥；bootstrap 不进入 renderer/导出/操作记录。
- **不扩大范围**：不读个人 keychain、不调用模型、不操作用户 DSH 实例。

## 通道分栏（真实 UI 不得用 SSR/demo 替代）

| lane | 含义 | 能否满足 `realUi` 场景 |
| --- | --- | --- |
| `real-dsh` | 真实受管 DSH 安装 + 真实 Electron 窗口（不调模型） | 能 |
| `synthetic` | 真实 Electron 窗口 + 受控/注入的 main 依赖（非上游证据） | 能（仅在明确标注 synthetic 时） |
| `ssr-markup` | `react-dom/server` 静态标记（`tests/acceptance/renderer` 已覆盖） | **不能** |
| `demo-mock` | `apps/desktop/src/renderer/demo/index.html` 自包含 mock | **不能** |

`validateScenarioPlan` 在夹具自检中强制该不变量：`realUi` 场景的 lane 只能是 `real-dsh` 或 `synthetic`，负向对照会用一个“SSR 冒充真实窗口”的条目证明该校验确实会失败。

## 安全边界

- **临时 dataRoot + 自建 canary**：所有场景在 `mkdtemp` 根下运行；每个环境 home 预置 `hdsl-e2e-canary-*`（仅夹具值），写入 `.credentials.yaml`（0600）与 `logs/boot.log`。
- **宿主守卫**：`captureHostGuard` 前后比较真实 `~/.dsh` 与常规 HDSL app-data 目录；diff 非空即失败。守卫的可失败性由夹具自检负向控制证明，避免恒真断言（教训 L2）。
- **只清登记资源**：`QaResourceRegistry` 只释放显式注册项；未登记的 sentinel 不被删除；清理失败进入 `CleanupReport.failed` 并显式报错，不静默（教训 L19）。
- **不触碰真实凭据**：不读个人 keychain、不调用模型、不操作用户 `~/.dsh` 或用户 DSH 实例；凭据引用配置只做“拒绝/不落盘”断言。
- **可失败负向 + 确定性闸门**：每条场景都要求文件 gate / 事件门控与可失败负向对照；禁止“两种终态之一”的宽松断言或 sleep 赌时序（教训 L17）。

## 场景映射（24 条，全部 blocked）

完整定义（含确定性闸门与负向对照）见 [`tests/e2e/scenarios/desktop-e2e-scenario-plan.ts`](../../tests/e2e/scenarios/desktop-e2e-scenario-plan.ts)。

| ID | 场景 | FR/SC | lane | 关键负向对照 |
| --- | --- | --- | --- | --- |
| E2E-UI-01 | 创建 → 选择 → 启动 → 停止 | FR-001/003/005/006, SC-002 | real-dsh | 无窗口时不得用 SSR/demo 替代；关掉就绪门必须超时失败 |
| E2E-UI-02 | 重复启动/停止幂等 | FR-005/006 | synthetic | 去 gate 后必须能观察到重复/冲突 |
| E2E-CATALOG-01 | 仅已核验组合可选 | FR-002 | synthetic | 已核验组合必须能创建成功 |
| E2E-PROG-01 | 进度严格单调、未知不编造 | FR-006 | synthetic | 倒退 sequence / 伪造百分比必须失败 |
| E2E-PROG-02 | 失败阶段/错误码/可重试可见 | FR-006, SC-003 | synthetic | 成功路径不得出现 error |
| E2E-CANCEL-01 | 提交前 cancelled / 提交后 CANNOT_CANCEL | FR-006 | synthetic | 已提交操作显示 cancelled 即失败 |
| E2E-SUB-01 | 窗口关闭退订、无关闭后推送 | FR-006/008 | synthetic | 未退订时迟到推送必须被捕获 |
| E2E-TRUST-01 | renderer 只有白名单 preload 面 | FR-003/007 | synthetic | 调未暴露通道必须被拒 |
| E2E-TRUST-02 | 伪造 sender 被拒且无副作用 | FR-003/007 | synthetic | 主窗口同请求必须成功 |
| E2E-TRUST-03 | 子 frame / 非白名单 origin 被拒 | FR-003/007 | synthetic | 主 frame 同调用必须成功 |
| E2E-TRUST-04 | DSH 页面无桥、不可达高权限 IPC | FR-007 | real-dsh | 启动器窗口同探测必须可触达受限桥 |
| E2E-WEBUI-01 | 仅打开自有已验证 loopback | FR-004 | synthetic | 换端口/停进程/非 loopback/token URL 必须拒绝 |
| E2E-WEBUI-02 | 401 不得当作 WebUI 可用 | FR-004/007 | real-dsh | 401 可达被判 running 即失败 |
| E2E-CRED-01 | 菜单导入引用配置 → 启动注入 | FR-003/007 | synthetic | 含 value/secret 字段必须被拒且不落盘 |
| E2E-CRED-02 | malformed/超限/含密配置被拒不落盘 | FR-007 | synthetic | 合格引用配置必须能导入 |
| E2E-CRED-03 | 旧选择/revision 被拒 | FR-003/007 | synthetic | 未变化合法路径必须成功 |
| E2E-BOOTSTRAP-01 | bootstrap 不进 renderer/导出/记录/日志 | FR-007 | real-dsh | canary 必须先在夹具中可被找到（正控） |
| E2E-DIAG-01 | 导出默认排除含密文件、零 canary 命中 | FR-007 | synthetic | 改宽默认排除必须使断言失败 |
| E2E-ISO-01 | 隔离 dataRoot、宿主 HOME 不变 | FR-001 | synthetic | 故意写守卫路径必须触发 diff |
| E2E-ISO-02 | 两环境互不读取 | FR-001, SC-001 | real-dsh | 交叉放入 canary 必须被捕获 |
| E2E-LOCK-01 | 双实例同 dataRoot 第二实例被拒 | FR-001/008 | synthetic | A 退出后 B 必须能接管 |
| E2E-LOCK-02 | 退出释放锁、无残留 | FR-008 | synthetic | 崩溃后接管/报告而非静默成功 |
| E2E-RESTART-01 | 重启对账未结束操作与自有进程 | FR-008 | synthetic | 无关对照进程不得被终止 |
| E2E-PROC-EXIT-01 | 受管 DSH 意外退出 → PROCESS_EXITED | FR-005/006 | synthetic | 正常运行环境必须保持 running |

需求覆盖：FR-001..FR-008 全部至少一条场景，`uncoveredRequirements()` 在夹具自检中断言为空。

## 前置与阻塞清单

| 阻塞 | 说明 | 解除条件 |
| --- | --- | --- |
| #6 未实现 | main 无窗口/IPC，preload 未接 `contextBridge` | hdsl-24 实现到精确 SHA 并提供可执行入口 |
| 边界未冻结 | Electron 启动、dataRoot 隔离、sender 校验、进度通道、依赖归属未答复 | hdsl-24 按上节逐项确认 |
| 测试依赖 | 真实窗口驱动需要额外依赖；根配置/lockfile 不属本切片 | #6 或编排者指定 owner 并给出入口 |
| 认证 bootstrap | token-free origin 仅 401；main-only 认证 bootstrap 归 hdsl-20 | hdsl-20 子切片合入后按 401 之外的边界复测 |

## 依赖与 lockfile 归属

真实窗口驱动候选方案（待 #6/编排者确认，本切片不自行加依赖）：

- Playwright 的 Electron 支持；或
- Electron `--remote-debugging-port` + Node 内置 `WebSocket` 的 CDP 客户端（不新增依赖，但需 main 提供受控调试入口）。

无论采用哪种，本切片都不修改根 `package.json` / `pnpm-lock.yaml`，避免与 #6 并发改同一 lockfile（教训 L12）。

## 执行记录（base `cd8ca74`）

```sh
# 平台：macOS 26.3 arm64；Node v24.21.0（PATH=/Users/suyingke/tools/node-24.21.0/bin）
git fetch origin && git rev-parse origin/main        # cd8ca74bece8844f00f9988ec5494575f750e577
pnpm install --frozen-lockfile                        # ok
pnpm exec tsc -p tsconfig.json                        # typecheck pass
pnpm exec vitest run tests/e2e/harness.test.ts        # 17 passed
pnpm run test                                         # 51 files passed | 4 skipped; 610 passed | 6 skipped
python3 scripts/check_repository.py                   # PASS: 27 required files, 42 authored docs, 86 local links, 6 JSON files
ls -d "$TMPDIR"/hdsl-e2e-*                             # 无残留
```

夹具自检基线为 17 条（`tests/e2e/harness.test.ts`）。该数字由 vitest 输出给出，文档不另行手抄计数。

## 残留与未测

- **未测**：真实 Electron 窗口、preload IPC 传输、原生打开 WebUI、诊断导出、单实例/dataRoot 门禁、真实 DSH 经 UI 的主旅程。全部 `blocked`，等待 #6。
- **未测**：Windows x64（归 T008b，无实机前保持未测）。
- **未验证假设**：`--remote-debugging-port` 受控入口是否被 #6 接受；Playwright Electron 是否加入依赖；凭据配置大小上限的具体字节数（`CREDENTIAL_CONFIG_MAX_BYTES_EXPECTED` 只是 QA 侧期望，需 #6 冻结）。
- **边界**：本切片的 24 条场景目前是**计划数据**，不是已执行验收；任何“E2E 通过”的说法在 #6 就绪并真实执行前都不成立。

## 后续步骤（#6 就绪后）

1. 记录候选精确 SHA，重新冻结 `support/desktop-candidate.ts` 的探测器（必要时）。
2. 将可运行场景状态由 `blocked` 改为 `ready`，移除对应 `blocker`；仍未具备前置的场景继续 `blocked`。
3. 按 lane 执行真实窗口场景，记录命令、平台、结果与失败项；真实 DSH 场景使用临时 dataRoot + 夹具 canary，不调模型。
4. 更新本文件与 `tests/e2e/README.md` 的状态表，再交由 T008 记录平台实机验证。
