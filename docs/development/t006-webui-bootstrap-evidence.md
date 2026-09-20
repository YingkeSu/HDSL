# T006 前置：main-only WebUI bootstrap 证据

状态：实现与有界真实 DSH 证据完成（macOS ARM64）。相关 issue：#66（本切片）、父任务 #6。基线 main `cd8ca74bece8844f00f9988ec5494575f750e577`。

本文件所有权：T005/T006 前置 runtime 进程作者。上游依据 `docs/research/dsh-compatibility.md` R004（rc.2），边界 ADR 0002。

## 问题与上游证据

- runtime 原先只保留 token-free loopback origin。
- R004（rc.2 实测）：ready 行 `dsh web: http://127.0.0.1:<port>/?token=…`；`GET /?token=…` → `303 See Other` + `Set-Cookie: dsh-auth-*; HttpOnly; SameSite=Strict; Max-Age=2592000`；无 cookie `GET /` → `401`。
- 因此 main 原生打开 token-free origin 得到 401；必须用该进程的 bootstrap URL 建立 cookie。token-free origin 本身**不**是可用 WebUI。

## 接口（runtime 侧 main-only，不改冻结契约）

```ts
interface WebUIBootstrapPort {
  consumeWebUIBootstrap(
    environmentId: string,
    open: (bootstrapUrl: string) => void | Promise<void>,
  ): Promise<PortOutcome<void>>;
}
```

- 挂在 `ProcessManager`（`@hdsl/runtime`），**不**进入 core 的 `ManagedProcessPort`，也不进入冻结的 `ContractPort`；没有通用 reveal 接口，URL 不作为返回值交给调用方。
- `consume` 命名**不**代表 token 一次性：同一受管进程内 token 可复用（R004），但只通过回调交给 main 打开。

## 安全不变量

- **仅内存**：bootstrap URL 在就绪时从 ready 行解析，保存在 runtime 进程内存（`pid + startToken + canonical loopback origin` 绑定）；不写入 `LaunchRecord`、日志、错误、事件、诊断或 renderer。
- **调用前校验**：未 closed；record `running`；identity 自有（pid+startToken+command）；缓存条目 identity 与 record 一致；URL 为 `http(s)`、无 userinfo、host/port 与 record endpoint 完全相同且为标准 loopback（`127.0.0.1` / `[::1]`）；任何不符 → `WEBUI_UNAVAILABLE`。
- **异步后复核**：先做一次 loopback 连通性检查，之后重新确认入口对象未被替换、record 仍 `running` 且身份仍可证明，避免检查期间发生 restart/close 后打开旧 URL。
- **错误不回显**：`open` 回调抛出的异常文本可能含 URL/token，一律只返回固定受控 `INTERNAL_ERROR`。
- **生命周期**：必须持有 token；生命周期 = 该受管进程生命周期（DSH 只在 ready 时打印一次）。在 `start`（替换旧启动前）、`stop`、`watchExit`、`close` 清除；应用重启后 adopt 的进程没有内存 bootstrap → `consumeWebUIBootstrap` 返回 `WEBUI_UNAVAILABLE`，main **不得**回退打开 401 origin。
- **外部 cookie 不可撤销（如实）**：一旦 main 用系统浏览器打开 bootstrap URL，上游设置的 `dsh-auth` cookie（Max-Age 2592000）存在于浏览器中，HDSL 的 JS 清理无法撤销它；清理只阻止后续新的打开。这是已界定的残差。

## 受控测试（默认运行）

`tests/process/webui-bootstrap.test.ts`（真实 Node + 受控 fake DSH，模拟 303/Set-Cookie/401/200）：

- 回调收到 bootstrap URL；token URL → `303` + `dsh-auth` cookie；无 cookie origin → `401`；带 cookie → `200` HTML。
- stop 后 consume → `WEBUI_UNAVAILABLE`（回调未被调用）；未启动环境 → `WEBUI_UNAVAILABLE`。
- `open` 抛错 → 受控 `INTERNAL_ERROR`，message 不含 canary。
- 未 spawn 该进程的第二实例（adopt/无内存 bootstrap）→ `WEBUI_UNAVAILABLE`，不回退 401。
- 负向入口无 secret：`LaunchRecord` 文件与 `openWebUI` 结果均不含 `token=`。

`tests/process/readiness.test.ts` 增加 `parseReadyTarget`：保留 bootstrap URL；拒绝非 loopback、userinfo、非 http(s)、非规范/越界端口。

## 真实 DSH 有界证据（opt-in）

```sh
HDSL_REAL_WEBUI_BOOTSTRAP=1 HDSL_EVIDENCE_KEEP=1 \
HDSL_REAL_WEBUI_BOOTSTRAP_DATA_ROOT=/tmp/hdsl-t004-evidence \
  pnpm exec vitest run tests/process/real-webui-bootstrap.evidence.test.ts --reporter=verbose
```

结果：`1 passed`，3.8s。在真实 rc.2 受管实例（Node 22.19.0 + DSH 0.1.5-rc.2，真实 core loader→strict 凭据端口→manager）上验证：

- bootstrap URL → `303` + `Set-Cookie: dsh-auth-*`；
- token-free origin 无 cookie → `401`；
- 携带 cookie → `200` 且响应为 HTML；
- `LaunchRecord` 不含 `token=`；
- stop 后再 consume → `WEBUI_UNAVAILABLE`。

未调用模型/API，未使用个人凭据（测试内 canary provider）。

## 未测 / 局限

- Windows x64 / Linux 未测（仅 macOS ARM64 有实机证据）。
- 未在真实 GUI 浏览器里验证 cookie 建立后的交互；证据为有界 HTTP 层 303/401/200。
- 不推测/泛化上游 token 协议：只接受 ready 行给出的 canonical loopback bootstrap URL，不跟随任意跳转、不接受外部 origin。
- 外部浏览器 cookie 的持久化与撤销不在 HDSL 控制内（见上）。
