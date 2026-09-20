# DSH 行为探针证据（真实官方 DSH）

状态：已执行。范围仅限真实官方 DeepSeek Harness（DSH）上游运行时行为；HDSL 应用尚未实现，本文不构成 001 的 macOS/Windows 实机验收，也不代替 T007/T008。可复现脚本：[tests/probes/dsh_behavior_probes.sh](../../tests/probes/dsh_behavior_probes.sh)。

相关文档：[上游验证计划](../../specs/001-environment-lifecycle/research.md)（R001–R006）、[001 规格](../../specs/001-environment-lifecycle/spec.md)、[来源与缺口](provenance.md)、[环境生命周期契约](../../specs/001-environment-lifecycle/contracts/local-api.md)。

## 1. 目的与边界

回答 001 直接依赖的上游问题：DSH 如何解析 home、如何隔离环境、WebUI 如何绑定与就绪、端口冲突如何失败、如何停止自有进程。产出是**上游行为证据**，用于 T001 支持矩阵与后续适配器设计；没有 HDSL 代码，因此不宣称任何 HDSL 功能完成。

## 2. 官方来源与版本核验（R001 部分）

| 项 | 结论 | 证据 |
| --- | --- | --- |
| 官方仓库 | `https://github.com/deepseek-ai/deepseek-harness`（PUBLIC） | `gh repo view deepseek-ai/deepseek-harness --json visibility,licenseInfo,defaultBranchRef` |
| 许可证 | MIT | 仓库 `licenseInfo.key=mit`；本地 `LICENSE` 首行 `MIT License / Copyright (c) 2026 DeepSeek` |
| 默认分支 | `master` | 同上 |
| 最新发布 | `v0.1.6-alpha.2`（Pre-release，2026-09-17T13:30:16Z） | `gh release list --repo deepseek-ai/deepseek-harness` |
| 精确提交 | tag `dsh-v0.1.6-alpha.2` = `ddefc45fbc7f8e46dd73185e68295696d1297887` | `git ls-remote --tags origin 'dsh-v0.1.6*'` 与本地 `git rev-parse HEAD` 一致 |
| npm 包 | `@deepseek-ai/dsh@0.1.6-alpha.2`，`bin: {dsh: lib/bin.js}` | `npm view @deepseek-ai/dsh@0.1.6-alpha.2 version dist.integrity bin` |
| npm 完整性 | `sha512-PHR/3ZHpJNWXlDQ3U9weFb7calWbSMJd2GD3z2iPJ8zAKL7ipuzyPy5xGbaXf2OA8hc0SAGJeoUW7nfatCNOYw==` | 同上；`dist.shasum=37d635377c9807c47d49d662ca00d6d5ea5792de` |
| npm dist-tags | `latest=0.1.5-rc.2`，`alpha=0.1.6-alpha.2`，`next=0.1.5-rc.2` | `npm view @deepseek-ai/dsh dist-tags` |
| Node engine | `^22.19.0 \|\| >=24.0.0` | 仓库根 `package.json` `engines.node` |

本机探针使用的二进制来自 checkout 构建产物 `apps/cli/lib/bin.js`，`git describe` 为 `dsh-v0.1.6-alpha.2`，`git status --porcelain` 无已跟踪改动。**注意**：npm `latest` 仍指向 `0.1.5-rc.2`，HDSL 若按“默认 latest”安装会得到更旧版本；精确锁定必须显式写 `0.1.6-alpha.2` 或提交 SHA。

## 3. 方法与安全约束

- 脚本仅使用仓库已有依赖：POSIX shell、Node（DSH 运行时）、`python3`（仅用于占端口）、`curl`/`lsof`/`pgrep`。
- 每次运行都用 `env -i` 清空环境，仅注入：位于临时目录的 `HOME`、`DSH_HOME`、`DSH_AGENTS_HOME`，`DSH_TELEMETRY_DISABLED=1`，占位 `DEEPSEEK_API_KEY=keyless-probe-no-call`，`NODE_NO_WARNINGS=1`。
- 不读取、不写入操作者真实 `~/.dsh`、settings 或凭据；不发起模型请求；只对自己 `spawn` 的进程发信号。
- 所有临时目录在退出时清理；URL 中的 `?token=` 与 `dsh-auth-*` cookie 在输出中脱敏。
- 未覆盖 Windows：没有 Windows 主机，也未在 WSL 或虚拟机中执行，因此不产生任何 Windows 结论。

## 4. 运行环境

| 项 | 值 |
| --- | --- |
| 运行时间 | 2026-09-20（本机时区 UTC+8） |
| 平台 | `Darwin 25.3.0 arm64`（macOS，Apple Silicon） |
| Node | `v25.6.1` |
| DSH CLI | `0.1.6-alpha.2` @ `ddefc45fbc7f8e46dd73185e68295696d1297887` |
| Web 构建产物 | 存在 `apps/cli/lib/bin.js` 与 `apps/web/dist/index.html` |

## 5. 结果总览

脚本一次完整运行 26 条断言全部通过（`SCRIPT_EXIT=0`）。

| 编号 | 场景 | 结果 |
| --- | --- | --- |
| S0 | 来源/版本/平台 | PASS |
| S1 | `DSH_HOME` 未设 → 默认 `$HOME/.dsh` | PASS |
| S2 | 显式 `DSH_HOME` 生效；A/B 两环境隔离；宿主默认 home 无改动；空白 `DSH_HOME` 被忽略 | PASS |
| S3 | loopback 就绪、token/cookie 鉴权、仅绑定 `127.0.0.1`、`--host 0.0.0.0` 拒绝 | PASS |
| S4 | 端口占用 → 非零退出、无就绪 URL、写诊断报告、点名 required 插件 | PASS |
| S5 | `SIGTERM` 退出 0、`SIGINT` 退出 130、自有端口释放、无关进程存活、无残留子进程 | PASS |

## 6. 详细发现

### S1 默认 home 解析

命令（脚本内等价形式，`DSH_HOME` 未设置）：

```sh
env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME="$FAKE_HOME" DSH_AGENTS_HOME="$FAKE_AGENTS" \
  DSH_TELEMETRY_DISABLED=1 DEEPSEEK_API_KEY=keyless-probe-no-call NODE_NO_WARNINGS=1 \
  node apps/cli/lib/bin.js --profile web --host 127.0.0.1 --port 0 --no-open
# stdout: dsh web: http://127.0.0.1:<port>/?token=<redacted>
```

结果：`$HOME/.dsh/` 被创建，含 `profiles/web/{package.json,cordis.yml,cordis.patch.yml,pnpm-workspace.yaml}`、`storages/workspace.json`、`.credentials.yaml`。确认默认 home 为 `~/.dsh`，且能被 `HOME` 重定向（`resolveDshHome` 用 OS home）。

### S2 显式 `DSH_HOME` 与两环境隔离

- 两个 `DSH_HOME`（A、B）同时启动 `web`，各自绑定独立临时端口（脚本实测如 `59689`/`59690`），各自持有独立 `profiles/web` 与 `.credentials.yaml`。
- 在 A、B 分别写入互斥标记文件后，对方 home 不可见，未发现交叉读取。
- 记录运行前后宿主默认 home（`$HOME/.dsh`）的递归文件 mtime/size 列表，A/B 运行期间**完全一致**，证明显式 `DSH_HOME` 下不写宿主默认 home。
- 仅含空白的 `DSH_HOME="   "` 被忽略：`--profile web --dump-config` 退出 0，且**未**在当前工作目录创建 `.dsh`（未把空白解析为 CWD）；dump 输出 558 行组合树。

### S3 loopback 就绪与鉴权

就绪信号是 stdout 的 `dsh web: <url>`，其中 `<url>` 为 `http://127.0.0.1:<port>/?token=<opaque>`。启动到就绪在本机约 1–3 秒（`--port 0` 取临时端口）。

首次带 token 请求：

```text
GET /?token=<redacted>            → HTTP 303 See Other
  location: /
  set-cookie: dsh-auth-<...>=<redacted>; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict
GET /  （无 cookie）               → HTTP 401
GET /  （带上述 cookie，跟随重定向）→ HTTP 200，约 31 KB HTML（`<html ...>`，Web SPA）
```

即：token 是引导用途，认证由 `dsh-auth-*` cookie 承担；`HttpOnly; SameSite=Strict; Path=/`，有效期 30 天。HDSL 若要嵌入或探测 WebUI，必须按此流程处理 cookie，不能只抓一次带 token 的 URL。

绑定检查：`lsof -nP -a -p <pid> -iTCP:<port> -sTCP:LISTEN` 仅显示 `127.0.0.1:<port>`，未发现 `0.0.0.0`/通配地址。

`--host 0.0.0.0` 被安全拒绝：

```text
exit=1
error: --host 0.0.0.0 is intentionally not supported yet for safety: it would expose remote code execution to the network; use 127.0.0.1 instead
```

### S4 端口占用

用受控 `python3` 监听 `127.0.0.1:<port>` 后，以 `--port <port>` 启动 `web`：

```text
exit=1
dsh: startup failed: 2 required plugins did not activate
  Failed plugins (1):
    webserver (required)  Package: @deepseek-ai/dsh-host-webserver
  Plugins waiting for services (...): connection (required) ... webRuntime
  EADDRINUSE
Full diagnostics: $DSH_HOME/logs/startup-<ts>-<uuid>.log
```

- 未打印任何就绪 URL（不存在“假就绪”）。
- 失败诊断写入 `$DSH_HOME/logs/`；本机文件名如 `startup-2026-09-20T09-05-42.434Z-9510e934-....log`。
- 退出码 1，可被上层作为可重试/可展示错误捕获。

### S5 停止自有进程

- `SIGTERM` 给 `dsh web` 主进程：退出码 `0`；停止后原监听端口不再 `LISTEN`。
- `SIGINT`：退出码 `130`。
- 本次构建的 `web` 运行期**未观察到子进程**（`pgrep -P` 递归为空），因此“进程树停止”在当前场景等价于停止主进程本身；这**不能**外推到执行工具/子 agent 的场景，需在 T005 单独验证。
- 停止 `dsh` 期间，探针自己启动的无关 `sleep` 进程存活，未被误杀。

### 其他观察（不作为 bug）

1. `--host 0.0.0.0` 虽被拒绝，但 `$DSH_HOME/profiles/web/` 已在此之前被自动初始化并留在磁盘（该次未生成 `storages/`/`.credentials.yaml`）。即“参数被拒”不代表 home 无副作用；HDSL 的失败清理与幂等需把“首次初始化”视为已完成步骤。
2. 全新 `DSH_HOME` 首次 `web` 启动会生成 `$DSH_HOME/.credentials.yaml`，内含自动生成的 `client-connection/browser-session` grant secret，文件权限 `0600`；`$DSH_HOME` 目录本身为 `0755`（由 DSH 创建）。该文件是本地机密，必须被 HDSL 排除在整合包、导出与普通日志之外（对应 FR-007）。
3. 未知 profile（`--profile does-not-exist`）退出 1，stderr 打印带完整 Node 栈的诊断与创建提示；HDSL 需自行收敛为用户可读错误。

## 7. 对 001 适配契约的含义（证据，不是实现）

- FR-001 / FR-004：上游已支持“每环境一个 `DSH_HOME`”的目录隔离；host 默认 `~/.dsh` 会被显式 `DSH_HOME` 覆盖，亦可由 `HOME` 重定向。但这是**目录与进程隔离，不是 OS 沙箱**，与 CONTEXT 不变量一致。
- FR-002：可精确锁定的上游标识已存在：npm `@deepseek-ai/dsh@<ver>` + `dist.integrity`（sha512）、Git tag + commit SHA、Node engine 约束。锁版本不要信任 npm `latest`。
- FR-004：就绪判定应解析 stdout 的 `dsh web: http://127.0.0.1:<port>/?token=...` 或做带 cookie 的 HTTP 探测；绑定地址应校验为 loopback。
- FR-005：`SIGTERM`→0、`SIGINT`→130 是可用约定；但由于 web 进程当前无子进程，进程树与 PID 复用问题必须在真实工具执行/T005 场景复验。
- FR-007 / FR-008：`$DSH_HOME/.credentials.yaml` 与 `$DSH_HOME/logs/startup-*.log` 是两个需要脱敏/排除的产物；失败诊断真实存在且路径可预测。

## 8. 未测与局限

- **Windows x64 完全未测**（无主机），不得据此声称 T008 或跨平台支持。
- 未测 R005（插件/bundle 锁版本与隔离安装）与 R006（升级迁移/恢复）。
- 未执行任何模型 API 调用；未验证需凭据的会话、工具执行、子进程、sandbox backend（bwrap/Landlock/Seatbelt）。
- 未测其他 profile（`headless`、`sdk`、`sdk-minimal`、`acp`）与 Electron desktop host。
- 未测 HDSL 层面的并发启动/停止幂等、应用重启后的 reconciliation、磁盘不足、中文/空格路径、长时运行内存与日志增长。
- 就绪时延（约 1–3 秒）只反映本机热构建产物；冷启动或首次初始化会更慢，不能当作验收阈值。
- 本机 checkout 含用户未跟踪文件，探针未修改任何已跟踪文件；npm/仓库可达性核验发生在当天，未来 tag 可能变化。

## 9. 复现方法

```sh
DSH_REPO=/path/to/deepseek-harness tests/probes/dsh_behavior_probes.sh
# 可选：DSH_NODE=/path/to/node DSH_PYTHON=/path/to/python3
```

脚本失败时返回 1，并打印每条断言；临时工作目录在退出时删除。若要保留现场，可在运行中中断进程（脚本的 `trap` 会清理）。
