# DSH 行为探针证据（真实官方 DSH）

状态：已执行。范围仅限真实官方 DeepSeek Harness（DSH）上游运行时行为；HDSL 应用尚未实现，本文不构成 001 的 macOS/Windows 实机验收，也不代替 T007/T008。

**本文按精确版本分节，禁止跨版本混用结论。** 两台可复现脚本：

- [tests/probes/dsh_behavior_probes.sh](../../tests/probes/dsh_behavior_probes.sh)：单安装/单版本的行为探针（S0–S6）。
- [tests/probes/dsh_install_anchor_probes.sh](../../tests/probes/dsh_install_anchor_probes.sh)：两个安装之间的模块回退锚点与隔离对比。

相关文档：[上游验证计划](../../specs/001-environment-lifecycle/research.md)（R001–R006）、[001 规格](../../specs/001-environment-lifecycle/spec.md)、[来源与缺口](provenance.md)、[环境生命周期契约](../../specs/001-environment-lifecycle/contracts/local-api.md)。

## 1. 目的与边界

回答 001 直接依赖的上游问题：DSH 如何解析 home、如何隔离环境、WebUI 如何绑定与就绪、端口冲突如何失败、如何停止自有进程，以及两个必须由启动器管理的文件系统边界——`$DSH_HOME/profiles/node_modules` 模块回退与 `$DSH_HOME/.credentials.yaml` 凭据文档。产出是**上游行为证据**，不是 HDSL 实现或验收。

## 2. 官方来源与版本核验（R001 部分）

| 项 | 结论 | 证据 |
| --- | --- | --- |
| 官方仓库 | `https://github.com/deepseek-ai/deepseek-harness`（PUBLIC） | `gh repo view deepseek-ai/deepseek-harness --json visibility,licenseInfo,defaultBranchRef` |
| 许可证 | MIT | `licenseInfo.key=mit`；本地 `LICENSE` 首行 `MIT License / Copyright (c) 2026 DeepSeek` |
| 默认分支 | `master` | 同上 |
| hdsl-3 候选版本 | tag `dsh-v0.1.5-rc.2` = `fb2c4b9e698e30edb738bca4cf0618587db7d203` | `git ls-remote --tags origin 'dsh-v0.1.5-rc.2'`，与 hdsl-3 提供一致 |
| 本机已构建版本 | tag `dsh-v0.1.6-alpha.2` = `ddefc45fbc7f8e46dd73185e68295696d1297887` | `git rev-parse HEAD` 与 `git ls-remote --tags` 一致；GitHub Release 2026-09-17 Pre-release |
| npm dist-tags | `latest=0.1.5-rc.2`，`alpha=0.1.6-alpha.2`，`next=0.1.5-rc.2` | `npm view @deepseek-ai/dsh dist-tags` |
| npm 完整性（rc.2） | `sha512-PHR/3ZHpJNWXlDQ3UweFb7calWbSMJd2GD3z2iPJ8zAKL7ipuzyPy5xGbaXf2OA8hc0SAGJeoUW7nfatCNOYw==` | `npm view @deepseek-ai/dsh@0.1.5-rc.2 dist.integrity`（`shasum=37d635377c9807c47d49d662ca00d6d5ea5792de`） |
| Node engine | `^22.19.0 \|\| >=24.0.0` | 仓库根 `package.json` `engines.node` |

**注意**：npm `latest` 会随发布变动；T001 支持矩阵必须写显式版本 + tag SHA + 完整性，不要写 `latest`。本次两个版本均从 npm 安装到独立目录，安装命令见第 12 节。

## 3. 方法与安全约束

- 依赖：POSIX shell、Node（DSH 运行时）、`python3`（占端口/遍历 symlink/HTTP）、`curl`、`lsof`、`pgrep`。
- 每次运行用 `env -i` 清空环境，仅注入临时 `HOME`、`DSH_HOME`、`DSH_AGENTS_HOME`、`DSH_TELEMETRY_DISABLED=1`、占位 `DEEPSEEK_API_KEY=keyless-probe-no-call`、`NODE_NO_WARNINGS=1`。
- 不读写操作者真实 `~/.dsh`、settings 或凭据；每次启动都在临时 CWD；不发起模型请求；输出中 `?token=` 与 `dsh-auth-*` cookie 脱敏。
- 进程只对自己 `spawn` 且未被 `wait` 回收的 PID 发信号：`wait` 成功后立即移出存活集合，`cleanup` 不会向陈旧 PID 发信号。
- 硬断言版本（`DSH_EXPECT_VERSION`）、来源 commit 与干净树（`DSH_EXPECT_COMMIT`）、Node（`DSH_EXPECT_NODE`）；自动累计并打印 `assertions: N/M passed`；`curl`/`lsof`/`pgrep` 缺失即 FATAL，不会假通过。
- 临时目录在退出时清理，**SIGINT/SIGTERM 中断也会清理**；需保留现场请先复制工作目录。
- 未覆盖 Windows：没有 Windows 主机，未在 WSL/虚拟机执行，不产生任何 Windows 结论。

## 4. 运行环境

| 项 | 值 |
| --- | --- |
| 运行时间 | 2026-09-20（本机时区 UTC+8） |
| 平台 | `Darwin 25.3.0 arm64`（macOS，Apple Silicon） |
| Node | `v25.6.1` |
| 版本实例 1 | `0.1.5-rc.2`，npm 安装于 `/tmp/dsh-015`（同版本副本人 `/tmp/dsh-015b`） |
| 版本实例 2 | `0.1.6-alpha.2`，npm 安装于 `/tmp/dsh-016`；另有本机 checkout 构建 `/Users/suyingke/labs/ds/deepseek-harness/apps/cli/lib/bin.js` |

## 5. 分版本结果摘要

两次**独立完整运行**均 `EXIT=0`（脚本自动计数）：rc.2 `38/38`，alpha.2 `40/40`。不要合并解读两个版本的结论。

### 5.1 0.1.5-rc.2（install root `/tmp/dsh-015`，label `0.1.5-rc.2`，`assertions: 38/38 passed, 0 failed`）

| 编号 | 场景 | 结果 |
| --- | --- | --- |
| S0 | 版本/平台/安装根 | PASS（`cli --version` = 0.1.5-rc.2） |
| S1 | 默认 `$HOME/.dsh`；含 `profiles/node_modules` | PASS |
| S2 | 显式 `DSH_HOME`；两环境隔离；宿主默认 home 无改动 | PASS |
| S2b | 空白 `DSH_HOME` 被忽略，不在 CWD 建 `.dsh` | PASS（dump-config 529 行） |
| S3 | loopback 就绪、token/cookie 鉴权、仅 `127.0.0.1`、`0.0.0.0` 拒绝 | PASS（200 HTML 27,660 字节） |
| S4 | 端口占用 → exit 1 + `EADDRINUSE`；**无结构化诊断文件** | PASS（见 7.2 差异） |
| S5 | `SIGTERM`→0、`SIGINT`→130、端口释放、无关进程存活 | PASS |
| S6 | 回退 symlink 全部锚定安装根；凭据 0600/每环境独立 | PASS（646 链接，0 越界） |

### 5.2 0.1.6-alpha.2（install root 本机 checkout，label `0.1.6-alpha.2`，`assertions: 40/40 passed, 0 failed`）

| 编号 | 场景 | 结果 |
| --- | --- | --- |
| S0 | 版本/平台/安装根 | PASS（`cli --version` = 0.1.6-alpha.2，`git describe` = `dsh-v0.1.6-alpha.2`） |
| S1 | 默认 `$HOME/.dsh`；**不含** `profiles/node_modules` | PASS |
| S2 | 显式 `DSH_HOME`；两环境隔离；宿主默认 home 无改动 | PASS |
| S2b | 空白 `DSH_HOME` 被忽略，不在 CWD 建 `.dsh` | PASS（dump-config 558 行） |
| S3 | loopback 就绪、token/cookie 鉴权、仅 `127.0.0.1`、`0.0.0.0` 拒绝 | PASS（200 HTML 31,187 字节） |
| S4 | 端口占用 → exit 1 + 结构化 `startup failed` + `logs/startup-*.log` | PASS |
| S5 | `SIGTERM`→0、`SIGINT`→130、端口释放、无关进程存活 | PASS |
| S6 | **未创建** `profiles/node_modules`（runtime resolution）；凭据 0600/每环境独立 | PASS（fallback 记为 NOTE） |

## 6. 两个版本一致的行为（各自独立复验）

- 默认 home = `~/.dsh`，可被显式 `DSH_HOME` 覆盖，也可被 `HOME` 重定向。
- 显式 `DSH_HOME` 下不写宿主默认 home；两个环境各自独立端口、独立 profile，且各自持有 DSH 生成的独立 `profiles/web` manifest；两次启动生成的凭据 secret 不同（用 DSH 产物作为隔离证据，不用探针自写的标记文件）。
- 仅含空白的 `DSH_HOME="   "` 被忽略，不会解析为 CWD。
- 就绪信号为 stdout 的 `dsh web: http://127.0.0.1:<port>/?token=<opaque>`；本机热构建约 1–3 秒。
- `GET /?token=…` → `303` + `Set-Cookie: dsh-auth-…; HttpOnly; SameSite=Strict; Max-Age=2592000; Path=/`；无 cookie `GET /` → `401`；带 cookie → `200` HTML。token 是**进程作用域**的引导 token（同一进程生命周期内可重复使用，实测同一 URL 连续两次都返回 303），认证由 cookie 承担，不是一次性 token。
- 监听仅 `127.0.0.1`；`--host 0.0.0.0` 被安全拒绝，exit 1。
- 端口占用：exit 1，`EADDRINUSE`，不打印就绪 URL。
- `SIGTERM` → exit 0；`SIGINT` → exit 130；停止后端口释放；无关进程存活；`web` 运行期未观察到子进程。
- `$DSH_HOME/.credentials.yaml` 权限 `0600`，含 `client-connection/browser-session` grant，secret 每环境不同；不写到安装根、CWD 或 `HOME`。
- `--host 0.0.0.0` 被拒时**仍已写入** `$DSH_HOME/profiles/web/`（首次初始化先于 app 参数校验，两版本一致）。

## 7. 版本差异（必须分版本处理）

### 7.1 `$DSH_HOME/profiles/node_modules` 模块回退

| | 0.1.5-rc.2 | 0.1.6-alpha.2 |
| --- | --- | --- |
| 首次 `web` 启动是否创建 | **是** | **否** |
| 内容 | 646 个包 symlink（含 `@scope/` 下嵌套），递归全部指向安装根 | 无 |
| 解析方式 | 磁盘 symlink 回退（`healProfilesModuleFallback`） | runtime resolution（`resolutionMode` 默认 `runtime`，只计算不落盘） |
| `--dump-config` 是否创建 | 否 | 否 |

rc.2 实测 `$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-base` → `/private/tmp/dsh-015/node_modules/@deepseek-ai/dsh-base`，版本 `0.1.5-rc.2`。alpha.2 启动后该目录不存在。

### 7.2 端口占用时的诊断产物

- **0.1.5-rc.2**：stderr 是原始 Node 异常栈（多层 `[cause]`，含 `EADDRINUSE`），**不写** `$DSH_HOME/logs/startup-*.log`，无 `startup failed` 汇总，也未点名 `webserver (required)`。
- **0.1.6-alpha.2**：stderr 为 `dsh: startup failed: 2 required plugins did not activate` + `Failed plugins (1): webserver (required)` + `Full diagnostics: $DSH_HOME/logs/startup-*.log`，诊断文件真实落盘。

含义：HDSL 不能假设“失败必有结构化诊断文件或友好错误”。若按候选 rc.2 交付，需要自行捕获原始栈并在适配层生成可读错误与诊断。

### 7.3 其他小差异

- `--profile web --dump-config` 组合树：rc.2 529 行，alpha.2 558 行（组合不同，非缺陷）。
- 认证后首页 HTML：rc.2 27,660 字节，alpha.2 31,187 字节。

## 8. 受管安装隔离：回退 symlink 与安装锚点

用 [dsh_install_anchor_probes.sh](../../tests/probes/dsh_install_anchor_probes.sh) 对比两个独立安装（两次运行，结果见下）。

### 8.1 同一版本、两个安装目录（A=`/tmp/dsh-015`，B=`/tmp/dsh-015b`，均 0.1.5-rc.2）

- 独立环境：home A 的 646 链接全部锚定 A，home B 全部锚定 B → 每环境独立安装即可独立解析。
- 共享安装：两个 home C/D 都由 A 启动，二者核心模块都锚定 A → **共享一个安装时，核心 bundle 模块不按环境隔离**。
- 重新指向：已由 A 初始化的 home A 再用 B 启动后，链接**重新锚定**到 B（`@deepseek-ai/dsh-base` 变为 B 路径）→ 回退是**可变状态，跟随最后一次启动所用的安装**，不是环境自己 pin 的。
- 凭据：四个 home 各自 `0600`，无越界。

### 8.2 不同版本（A=`/tmp/dsh-015` 0.1.5-rc.2，B=`/tmp/dsh-016` 0.1.6-alpha.2）

- home B 无回退链接（alpha.2 行为）。
- home A 用 alpha.2 重新启动后，磁盘上**遗留** rc.2 的旧链接（仍指向 `/tmp/dsh-015`）；alpha.2 不重写。alpha.2 采用 runtime resolution，该遗留是否被实际采用未验证（见第 11 节）。

### 8.3 对 HDSL 的结论

1. 环境隔离只覆盖“每环境一个 `DSH_HOME` + profile + 数据”，**不覆盖受管安装**；核心 bundle 来自运行中的安装锚点。
2. 若 HDSL 让多个环境共用一个 DSH 安装，则这些环境共享同一份核心运行时模块；要隔离受管安装版本，必须**每环境独立安装目录**（独立 `installAnchor`）。
3. 回退可被“换个安装启动同一 home”改写（rc.2 会 re-heal）。HDSL 必须显式决定并记录“哪个环境用哪个安装启动”，不能依赖 home 自带的固定指向。
4. 升级/切换安装时需处理遗留回退链接，尤其是 rc.2↔alpha.2 之间的机制变化。

## 9. 凭据文件边界

- 位置：`$DSH_HOME/.credentials.yaml`，权限 `0600`（上游强制）。`$DSH_HOME` 目录本次在 umask `022` 下观察到为 `0755`，这是 `0777 & ~umask` 的结果，**不是上游文档化保证**（凭据层另有请求 `0700` 的路径）；探针只打印观察值，不断言固定 mode。
- 内容键：`client-connection/browser-session`（`kind: grant`，含自动生成的 secret，即 WebUI cookie 的凭据来源）。
- 每环境独立生成，secret 不同；不出现在安装根、CWD、`$HOME`，也不因 `--host 0.0.0.0` 被拒而产生（未完整启动）。
- HDSL 必须把该文件视为本地机密：排除在整合包、导出、普通日志之外（FR-007）。

## 10. 对 001 适配契约的含义

- FR-001/FR-004：每环境一个 `DSH_HOME` 的目录隔离成立；但这是目录/进程隔离，不是 OS 沙箱。
- FR-002：可锁定的上游标识 = npm 版本 + `dist.integrity`(sha512) + Git tag/commit + Node engine；不要信任 `latest`。受管安装必须每环境独立（第 8 节）。
- FR-004：就绪判定解析 `dsh web: http://127.0.0.1:<port>/?token=…` 或做带 cookie 的 HTTP 探测；校验 loopback 绑定。
- FR-005：`SIGTERM`→0、`SIGINT`→130 可用；`web` 当前无子进程，进程树/PID 复用仍需在真实工具执行场景复验。
- FR-006/FR-008：**rc.2 与 alpha.2 的诊断能力不同**（7.2）。按 rc.2 交付需自建可读错误与诊断；不要把 alpha.2 的 `logs/startup-*.log` 当作 rc.2 的既有能力。
- FR-007：`.credentials.yaml` 必须脱敏/排除。

## 11. 未测与局限

- **Windows x64 完全未测**（无主机），不得据此声称 T008 或跨平台支持。
- 未测 R005（插件/bundle 锁版本与隔离安装）与 R006（升级迁移/恢复）。
- 未执行模型 API 调用；未验证需凭据的会话、工具执行、子进程、sandbox backend。
- 未验证 alpha.2 是否会在 runtime resolution 中采用 rc.2 遗留的磁盘回退链接；只观察到遗留链接存在。
- 未测其他 profile（`headless`/`sdk`/`sdk-minimal`/`acp`）与 Electron desktop host（其 `healIsolatedProfileModuleFallback` 路径未验证）。
- 未测 HDSL 层并发幂等、应用重启 reconciliation、磁盘不足、中文/空格路径、长时运行。
- 就绪时延（约 1–3 秒）仅反映本机热构建，不是验收阈值。
- 本机 checkout 含用户未跟踪文件；探针未修改任何已跟踪文件。版本/npm 可达性核验发生在当天，未来可能变化。

## 12. 复现方法

```sh
# 安装两个精确版本到独立目录（非破坏性，使用临时 npm cache）
mkdir -p /tmp/dsh-015 /tmp/dsh-016
( cd /tmp/dsh-015 && printf '{"private":true}\n' > package.json && \
  npm_config_cache=/tmp/dsh-npm-cache npm install --no-save @deepseek-ai/dsh@0.1.5-rc.2 )
( cd /tmp/dsh-016 && printf '{"private":true}\n' > package.json && \
  npm_config_cache=/tmp/dsh-npm-cache npm install --no-save @deepseek-ai/dsh@0.1.6-alpha.2 )

# 单版本行为探针（每个版本单独运行，不要混用输出）
# 来源 checkout 版本须同时绑定 commit 与 Node；npm 版本无 .git 时跳过 commit 断言
DSH_BIN=/tmp/dsh-015/node_modules/@deepseek-ai/dsh/lib/bin.js DSH_INSTALL_ROOT=/tmp/dsh-015 \
DSH_LABEL=0.1.5-rc.2 DSH_EXPECT_VERSION=0.1.5-rc.2 DSH_EXPECT_NODE=v25.6.1 \
  tests/probes/dsh_behavior_probes.sh

DSH_REPO="${DSH_REPO:-/path/to/deepseek-harness}" \
DSH_LABEL=0.1.6-alpha.2 DSH_EXPECT_VERSION=0.1.6-alpha.2 \
DSH_EXPECT_COMMIT=ddefc45fbc7f8e46dd73185e68295696d1297887 DSH_EXPECT_NODE=v25.6.1 \
  tests/probes/dsh_behavior_probes.sh

# 两个安装之间的隔离对比（同版本或跨版本）
DSH_BIN_A=/tmp/dsh-015/node_modules/@deepseek-ai/dsh/lib/bin.js DSH_INSTALL_ROOT_A=/tmp/dsh-015 \
DSH_BIN_B=/tmp/dsh-016/node_modules/@deepseek-ai/dsh/lib/bin.js DSH_INSTALL_ROOT_B=/tmp/dsh-016 \
  tests/probes/dsh_install_anchor_probes.sh
```

脚本对 `DSH_EXPECT_VERSION` / `DSH_EXPECT_COMMIT` / `DSH_EXPECT_NODE` 做硬断言（未设置则记 NOTE，不冒充已验证）；启动前检查 `curl`/`lsof`/`pgrep`，缺失即 FATAL 退出；所有 DSH 启动都在临时 CWD，并断言调用目录无副作用；自动累计并打印 `assertions: N/M passed`；进程被 `wait` 回收后立即移出存活集合，`cleanup` 只对仍存活的 PID 发信号，绝不会向陈旧 PID 发信号。

脚本失败返回 1 并逐条打印断言；临时工作目录在退出时删除，**中断（SIGINT/SIGTERM）也会删除**；需保留现场请先自行复制工作目录。
