# DSH 上游兼容性与最小支持矩阵（T001）

状态：R001–R004 已完成真实证据；R005/R006 记录已知边界并标注属 M2。本文件不声称 T002 已开始，也不声称任何平台“支持”除实测之外的范围。

- 基线 SHA：`76f2bc5a537833a01ac389e08449dc28d6d73f0b`（HDSL），frozen 契约见 `cf9af902`（PR #16）。
- 本文件所有权：T001 作者。上游事实按「实测 / 官方文档 / 未验证」三档标注，不把上游文档当成我们的执行证据。
- 实验平台：macOS `Darwin 25.3.0 arm64`（macOS 26.3），Node v25.6.1（另加 22.19.0 / 24.21.0 / 26.8.1 矩阵），npm 11.9.0，pnpm 11.7.0。
- 实验时间：2026-09-20。
- 复现脚本：[dsh-web-probe.sh](../../scripts/research/dsh-web-probe.sh)、[dsh-version-hop-probe.sh](../../scripts/research/dsh-version-hop-probe.sh)。
- 相关决策：[ADR 0001](../adr/0001-bootstrap-architecture.md)、[ADR 0002](../adr/0002-credential-boundary.md)；计划见 [research.md](../../specs/001-environment-lifecycle/research.md)。

## 结论摘要

1. 官方上游确定为 `deepseek-ai/deepseek-harness`，MIT，处于 developer preview，README 明示会破坏兼容。
2. 候选固定版本为 **`@deepseek-ai/dsh@0.1.5-rc.2`**（npm `latest`/`next`），对应 git tag `dsh-v0.1.5-rc.2`。`alpha` tag 是 `0.1.6-alpha.2`。**必须显式锁精确版本**：多个 bundle 包的 `latest` 仍指向远古 `0.0.1-rc.1`，裸 `add`/裸 `npx` 会拿到旧版本。
3. 最小支持组合（实测）：**macOS ARM64 + DSH 0.1.5-rc.2 + Node 22.19.0 / 24.21.0**（另有 25.6.1、26.8.1 通过）。Windows x64 是目标平台但**本任务无实机，未测**。
4. 隔离入口是 `DSH_HOME`（优先级：显式配置 > `$DSH_HOME` > `~/.dsh`；空白值视为未设置）。两环境实测互不串用，宿主默认目录不变。
5. `$DSH_HOME/profiles/node_modules` 是从“运行中的 DSH 安装目录”symlink 出来的运行时回退。**DSH_HOME 不是自包含环境**：多个环境共用一个 DSH 安装时，核心 bundle 模块解析都指向该安装；要并存不同 DSH 版本必须每环境独立安装目录。
6. 上游**没有** OS keychain/credential-manager provider（`credentials-local` README 明确 OS-keychain provider “deferred … none is shipped”）；受管用户凭据只能由 HDSL 解析后注入显式进程环境（launch env 优先级最高）。
7. 上游会在环境 home 自动写凭据类产物：`.credentials.yaml`（0600，含 Web 会话 grant secret）与 `.anonymous-user-id`。**ADR 0002 的假设在 0.1.5-rc.2 上复现**，可转正；但 `logs/` 诊断目录在本轮 rc.2 启动失败中**未复现**（见 R004 与“未验证”）。
8. 上游**没有**用户级备份/回滚/降级保证；HDSL 的恢复能力必须自建（M2）。

## R001 — 官方仓库、发布来源与许可证

| 项 | 值 | 证据 |
| --- | --- | --- |
| 官方仓库 | `https://github.com/deepseek-ai/deepseek-harness` | GitHub API `/repos/deepseek-ai/deepseek-harness`，`private: false` |
| 描述 | `DeepSeek Harness: Everything is a Plugin.` | 同上 |
| 默认分支 | `master` | 同上 |
| 许可证 | MIT（`spdx_id: MIT`） | 同上；仓库根 `LICENSE` |
| 官网 / 文档 | `https://deepseek.com/harness`、`https://deepseek-harness.github.io/deepseek-harness/` | repo `homepage`；README |
| 成熟度 | developer preview，README 原文 “THERE WILL BE COMPATIBILITY-BREAKING CHANGES.” | README |
| npm 包 | `@deepseek-ai/dsh`，`bin: { "dsh": "lib/bin.js" }`，`type: module` | 发布包 `package.json` |

固定候选版本：

| 项 | 0.1.5-rc.2（候选） | 0.1.6-alpha.2（观察） | master |
| --- | --- | --- | --- |
| git tag / commit | `dsh-v0.1.5-rc.2` = `fb2c4b9e698e30edb738bca4cf0618587db7d203` | `dsh-v0.1.6-alpha.2` = `ddefc45fbc7f8e46dd73185e68295696d1297887` | `0.1.6-alpha.2`（滚动） |
| GitHub Release | 存在，`prerelease: true`，无资产 | 存在，`prerelease: true`，无资产 | — |
| npm dist-tag | `latest`、`next` | `alpha` | — |
| 发布包 `engines` | 空 | 空 | — |
| tag 根 `package.json` `engines.node` | `^22.19.0 \|\| >=24.0.0` | `^22.19.0 \|\| >=24.0.0` | `^22.19.0 \|\| >=24.0.0` |
| tag 根 `packageManager` | `pnpm@11.7.0` | `pnpm@11.7.0` | `pnpm@11.7.0` |
| Session writer `SESSION_FORMAT_VERSION` | `3` | `3` | `3` |

注意区分：**`engines` 来自固定 rc.2 tag 的源码仓库根，不等于已发布 npm CLI 的声明约束**（发布包 `engines` 为空）。Node 启动矩阵见 R002。

下载验证方式：

```sh
# 0.1.5-rc.2 发布 tarball
curl -sL https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.5-rc.2.tgz -o dsh-0.1.5-rc.2.tgz
shasum -a 256 dsh-0.1.5-rc.2.tgz
# -> f4c54839d69e82bf1c3a5a41a910c3ce1405cd9e9d97d753c0c04f406c7d7480
```

- npm `dist.integrity`（sha512-…）：`sha512-8Xc8hCQHcIWRmTCVU/xZdp6/qMsWMeAd2ObChKDEsfhUPJFXx6H0lgeb1DxUMD86HZrrVN+1bCvn1ppjZ/fOxw==`；`dist.shasum`（sha1）= `2c78db39568d910868f1e4f34062a4f346d4815d`。
- 实测下载的 tarball SHA-256 与上表一致，sha1 与 `dist.shasum` 一致。
- **无 npm provenance 证明**：`registry.npmjs.org/-/npm/v1/attestations/@deepseek-ai%2Fdsh@0.1.5-rc.2` 返回 `{"error":"Not found"}`，且发布元数据无 `gitHead`。因此 npm 完整性只证明“传输/内容一致”，不自动证明来源可信；HDSL catalog 仍需自行记录 provenance。

观察：发布 tarball 的 `dsh.configTrees` 指向 `../../packages/preset/agent-presets/presets`（仓库相对路径，不在 tarball 内）。这是发布布局观察，不影响本地启动，但说明不能假设发布包是仓库的完整镜像。

## R002 — Node / OS / arch 支持与候选组合

上游依据（固定版本，不混用）：

- rc.2 tag 根 `engines.node = ^22.19.0 || >=24.0.0`；`packageManager = pnpm@11.7.0`。
- 上游 CI（master `.github/workflows/ci.yml`）Node 兼容矩阵：`22.19`、`24.9`、`26`；Linux x64 阻塞 PR。Windows x64 为 `windows node 24 / build|coverage|native-tests` 阻塞 lane；macOS 与 Linux ARM64 在 `ci-master.yml` 的 master lanes。
- 这些是**上游**的验证范围，不是 HDSL 的实测结论。

HDSL 本机实测（rc.2，macOS ARM64，每版本独立 `DSH_HOME`，隔离启动并 SIGTERM 停止）：

| Node | 结果 | 就绪（首个 URL） | SIGTERM |
| --- | --- | --- | --- |
| v22.19.0 | PASS | 是 | exit 0，端口释放 |
| v24.21.0 | PASS | 是 | exit 0，端口释放 |
| v25.6.1 | PASS | 是 | exit 0，端口释放 |
| v26.8.1 | PASS | 是 | exit 0，端口释放 |

**最小支持矩阵（本任务结论）**：

| 组合 | 平台 | DSH | Node | 状态 |
| --- | --- | --- | --- | --- |
| A（主） | macOS ARM64 | 0.1.5-rc.2 | 22.19.0 | 实测通过（启动/就绪/停止） |
| B（备） | macOS ARM64 | 0.1.5-rc.2 | 24.21.0 | 实测通过（启动/就绪/停止） |
| — | Windows x64 | 0.1.5-rc.2 | 22.19.0 / 24.x | **未测**：无实机，只称目标平台 |
| — | macOS ARM64 | 0.1.6-alpha.2 | 25.6.1 | 仅用于跨版本边界实验，非候选 |

范围建议：M1 只声明 macOS ARM64 的 A/B 组合。Node 最低版本以 rc.2 tag 的 `engines` 为上限约束、以本机 22.19.0 实测为下界证据；未在 Windows 或 Linux 上任一声称通过。

## R003 — 决定 profile / 配置 / 插件 / 会话 / home 的参数

隔离入口（官方文档 + 实测）：

- `DSH_HOME`：优先级「显式配置 > `$DSH_HOME` > `~/.dsh`」；**空白或全空白 `$DSH_HOME` 视为未设置**，不会解析到当前目录。实测：独立 `DSH_HOME` 下启动，宿主 `~/.dsh` 文件清单（内容哈希）不变；用 `HOME=<tmp>` 覆盖时写入 `<tmp>/.dsh`。
- `--profile <name>` / `dsh <name>`：profile 目录固定为 `$DSH_HOME/profiles/<name>`。
- `$DSH_HOME/cordis.patch.yml`：home 级补丁层，优先级高于 profile 自己的 `cordis.patch.yml`。
- profile 目录 `package.json`：`dependencies`（pnpm 管理的 out-of-tree 插件）+ `dsh.profile.bundles`（有序层列表）。
- `dsh plugin --profile <name> <pnpm-args>`：把剩余参数原样转发给 pnpm，cwd = profile 目录；`pnpm` 必须在 PATH 上。
- `--patch <path>`：额外补丁层，可重复。
- 组合顺序：各 bundle patch → profile `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch`（逐行后者覆盖前者，整行 `config` 替换、不深合并）。
- Session 日志根：`dshHomePath('sessions')`（RC.2 默认配置实测）；KV 存储根：`dshHomePath('storages')`。`--dump-default-config`/`--dump-config` 可离线查看组合树。
- 凭据文件路径：默认 `$DSH_HOME/.credentials.yaml`；凭据解析优先级「launch env > 该文件 > 项目 `.env` > `$DSH_HOME/.env`」。

两环境标记实验（rc.2，实测）：

- 两个独立 `DSH_HOME` 各自生成 `.anonymous-user-id`、`.credentials.yaml`、`profiles/`、`storages/`；两环境的浏览器 grant secret 不同。
- 向环境 A 的 `web` profile 安装本地/注册表插件后，环境 B 的 `profiles/web/package.json` 依赖与 bundle 列表不变。
- profile 目录自带 `pnpm-workspace.yaml`（`nodeLinker: hoisted`、`autoInstallPeers: false`）与 `pnpm-lock.yaml`。

**关键边界（对 HDSL 环境模型有直接影响）**：

- `$DSH_HOME/profiles/node_modules` 不是独立安装，而是一组指向**当前运行安装目录**的 symlink 回退（实测：`@deepseek-ai/*` 全部 symlink 到 `node_modules/@deepseek-ai/dsh...` 所在安装）。in-box bundle 永远来自当前运行的安装。
- 推论：`DSH_HOME` 只隔离 profile 级插件与用户数据；它**不能**隔离“受管 DSH 安装版本”。HDSL 若要并存两个 DSH 版本环境，必须每环境独立安装目录（受管 runtime artifact），并让该环境启动时使用自己的安装。
- 独立目录 + 独立 home + 独立进程 **不等于 OS 安全沙箱**；插件在宿主进程内执行任意代码（上游 `SAFETY.md` 明确不保证隔离）。HDSL 文案沿用 CONTEXT 不变量，不得写成沙箱。
- 中文 + 空格路径实测可用：`DSH_HOME=/tmp/…/中文 环境/home test` 正常启动并生成 home。

上游落盘产物（rc.2 实测，复核 ADR 0002）：

| 路径 | 权限 | 内容 | 说明 |
| --- | --- | --- | --- |
| `$DSH_HOME/.credentials.yaml` | `0600` | `version: 1` + `client-connection/browser-session` grant secret | Web 会话短期 secret，非 HDSL 管理的用户 API key |
| `$DSH_HOME/.anonymous-user-id` | `0644` | 随机 id | 非秘密，但属环境私有 |
| `$DSH_HOME/` 根目录 | `0755` | — | 目录本身不可读限制不成立，含密文件靠 0600 |
| `$DSH_HOME/profiles/<n>/…` | 目录/文件默认 | profile 组成 | 含组成锁三元组 |

**ADR 0002 复核结论**：`.credentials.yaml`（0600，Web grant secret）在 `0.1.5-rc.2` 上真实复现，路径、权限、内容类别与 ADR 假设一致，可据此把 ADR 0002 相关表述从「待复核」转正。`logs/` 见 R004 的未复现说明。

## R004 — 启动 WebUI、就绪检测与停止进程树

真实命令（候选基线）：

```sh
DSH_HOME=<env-home> node <install>/node_modules/@deepseek-ai/dsh/lib/bin.js \
  web --no-open --host 127.0.0.1 --port <port>
```

实测协议（rc.2，Node 22.19/24.21/25.6/26.8）：

| 观察 | 结果 |
| --- | --- |
| 就绪信号 | stdout 打印 `dsh web: http://127.0.0.1:<port>/?token=<redacted>`，仅在 Loader 树 settled 后打印 |
| 绑定地址 | `lsof` 显示仅 `127.0.0.1:<port>` LISTEN；`--host 0.0.0.0` 被明确拒绝 |
| token URL | `GET /?token=…` → `303 See Other` + `Set-Cookie: dsh-auth-*; HttpOnly; SameSite=Strict; Max-Age=2592000` |
| 无 cookie | `GET /api` → `401`；`GET /` 无 cookie → `401` |
| 停止 | 首个 `SIGTERM` → 退出码 0，5 秒内完成，端口释放 |
| 进程树 | `dsh web` 实测为单进程，无子进程；停止后无残留 |
| 端口冲突 | 第二实例 exit 1，`EADDRINUSE: address already in use 127.0.0.1:<port>`；第一实例不受影响 |
| 不安全 host | `--host 0.0.0.0` → exit 1，stderr：`--host 0.0.0.0 is intentionally not supported yet for safety: it would expose remote code execution to the network; use 127.0.0.1 instead` |
| `SIGINT` | 上游 CLI 参考记录退出码 130（本轮未实测，只测 SIGTERM）；第二个信号强制立即退出 |
| 启动失败诊断 | rc.2 的 `EADDRINUSE` 与非法 `DSH_TOOLS_MODE` 失败都只打印 Node 栈到 stderr，**未生成** `$DSH_HOME/logs/`；上游文档描述的 `logs/startup-*.log` 在本轮 rc.2 未复现（见“未验证”） |

对 HDSL 的适配含义：

- 就绪判定用“打印的 URL 行 + 该 URL 可被 HDSL 以 loopback 访问”，不要用固定 sleep，也不要用 TCP 端口打开当作就绪。
- WebUI 入口必须使用 `main` 侧已验证的 loopback endpoint；token URL 是敏感值，不得进入 renderer、普通日志、诊断导出。
- 停止用 `SIGTERM` 即符合上游普通停止协议；HDSL 仍需自行跟踪进程所有权，并要求超时后按平台处理进程树（FR-005），不得只凭 PID。
- 端口选择建议优先 `--port 0`（OS 分配）以避免冲突；若需固定端口，必须处理 `EADDRINUSE`。
- HDSL 必须自带就绪超时（拟定 60s，T002/T005 锁定），上游没有“就绪超时”概念。

跨版本 home 兼容实验（rc.2 ↔ 0.1.6-alpha.2，同一 `DSH_HOME`，无 session）：

- rc.2 启动 → alpha.2 启动 → rc.2 再次启动，三次都成功就绪；
- 三次之间 `DSH_HOME` 内非 `node_modules` 文件**内容哈希完全一致**（无 profile/storage 重写）。

这支持“两个候选版本可共用同一 home 形态”，但不覆盖 session 日志迁移（R006）。

## R005 — 插件 / bundle 锁版本与隔离安装（属 M2，已知边界）

> 按冻结后的 [tasks.md](../../specs/001-environment-lifecycle/tasks.md)，R005 不在 M1 完成条件内。以下为 rc.2 实测与官方源码/文档边界，供 M2 使用；不得据此实现 M2。

- `dsh plugin --profile <n> add <pkg>` 转发 pnpm；实测写 `dependencies`、创建/更新 profile `pnpm-lock.yaml`（lockfileVersion `9.0`），并按 `dsh.bundle.patch` 对账 `dsh.profile.bundles`。
- 精确版本锁：`add @deepseek-ai/dsh-subagent-codex@0.1.5-rc.2` → `package.json` 记录 `0.1.5-rc.2`，lockfile 记录 `version: 0.1.5-rc.2` 与 `resolution.integrity: sha512-…`；bundle 自动加入层栈。
- 升级对账：先装 `@deepseek-ai/dsh-subagent-codex@0.0.1-rc.1`（该版本无 `dsh.bundle`，正确 warning），再 `add …@0.1.5-rc.2` → 安装版本更新且 bundle 加入列表。rc.2 上对账正常；explorer 在 alpha.2 观察到的“bundle 未更新”在 rc.2 干净实验中**未复现**（其实验被中断，不作结论）。
- 裸 `add @deepseek-ai/dsh-subagent-codex`（不带版本）实测装到 `0.0.1-rc.1`（该类包 `latest` 落后），并打印“declares no dsh.bundle”warning。**HDSL catalog 必须显式锁精确版本**。
- 本地 `link:` / `file:` 插件只锁 specifier（相对路径），**无 integrity**；注册表精确版本才有版本 + 完整性锁。要复现组成必须保留 `package.json + pnpm-lock.yaml + cordis.patch.yml`。
- git 源码包安装时通过 `prepare` 构建，pnpm ≥10 默认阻止，需把提示的 key 写入 profile `pnpm-workspace.yaml` 的 `allowBuilds` 后重跑；已构建 tarball / 本地 checkout 不需要。
- 隔离单元是 profile 目录（各自 `node_modules`），**不是 OS 沙箱**；in-box bundle 仍来自当前运行安装（见 R003）。
- 未找到上游用户级“整合包导出/导入/registry”命令；可分享单位目前是 profile 目录三元组（标注为“未找到证据”）。
- 安装操作审计日志位于 profile 的 `.plugin-manager/logs/operation-*/`。

## R006 — 升级是否迁移可变数据（属 M2，已知边界）

> R006 不在 M1 完成条件内。以下为 rc.2 实测 + 固定版本源码/文档证据。

- `SESSION_FORMAT_VERSION = 3` 在 rc.2、0.1.6-alpha.2、master 均一致；released format = 3（evidence tag `dsh-v0.1.5-alpha.1`）。候选两版之间**没有** session 格式迁移。
- 迁移是相邻版本链 v0→v1→v2→v3；已发布边冻结；只写最终目标代际，已提交代际不移动/替换/删除；读打开只在内存准备、不写盘；写打开先校验再“无覆盖发布”。
- 拒绝边界：无法忠实解释的历史日志定向拒绝；未知必需事件 fail-closed；比当前更新的格式拒绝并提示升级；**不保证降级兼容**。
- 无内置备份/回滚；HDSL 的“升级失败可恢复”必须自建（代际目录 + 切换前快照）。
- 其他数据（固定版本文档）：域 KV `storage-sqlite` 版本不符直接 `version-mismatch`，无迁移；旧 `$DSH_HOME/config.yaml` 被忽略；`credentials-local` 在启动时把预发布扁平布局原地升级到 `version: 1`。
- 本机实测的跨版本 home（rc.2 ↔ alpha.2）非 session 文件内容不变，与“相邻版本不重写已存在数据”一致；session 迁移本身本轮未用真实 session 复现。

## 未验证 / 缺口 / 范围调整

- **Windows x64 完全未测**：无实机。T008b 保持未测/needs-info；不得声称支持。本任务不等待 Windows 主机。
- **Linux 未测**（仅上游 CI 声明）。
- 未创建真实 session，故未执行 session 日志迁移/恢复实验；R006 只达到“格式版本 + 源码/文档边界 + home 形态”证据。
- `logs/startup-*.log` 在 rc.2 未复现（port 冲突与非法 `DSH_TOOLS_MODE` 都只打印栈）。ADR 0002 / PR14 依据的 alpha.2 观察与本轮 rc.2 存在版本差异，需按版本分别记录；`.credentials.yaml` 已复现，`logs/` 保持“待按版本复核”。
- 未测：无 TTY / 受限网络下的 `plugin add` 超时；磁盘不足；应用重启对账；并发启停幂等；下载中断/摘要错误；凭据缺失时的启动失败信息。
- 未找到上游用户级 pack/registry 证据（“未找到证据”，非“不支持”）。
- 上游处于 developer preview，`latest` dist-tag 会漂移；catalog 必须固定精确版本 + tag commit + tarball SHA-256。

## 复现步骤

```sh
# 1) 核心协议探针（Node 矩阵、就绪、loopback、SIGTERM、host 拒绝、端口冲突、宿主 home 边界）
scripts/research/dsh-web-probe.sh /tmp/dsh-probe
NODE_BINS="/path/node22/bin/node /path/node24/bin/node" scripts/research/dsh-web-probe.sh /tmp/dsh-probe

# 2) 跨版本 home 探针
scripts/research/dsh-version-hop-probe.sh /tmp/dsh-hop 0.1.5-rc.2 0.1.6-alpha.2
```

两个脚本都只写临时目录、覆盖 `HOME`/`DSH_HOME`，并在捕获日志中把 `token=` 脱敏为 `<redacted>`。仓库检查见 `python3 scripts/check_repository.py`。
