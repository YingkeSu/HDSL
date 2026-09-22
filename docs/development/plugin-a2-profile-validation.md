# A2 profile 接线验证记录（#76）

状态：**A2 接线已在本机有界验证**（真实 `npm-ci` 受管安装 → profile 发布 → 真实受管进程 `--profile` 启动 → 停止），并有 CI 适配器/进程夹具证据。**不代表 A2/E10b/#76 完成**；同环境双代变更/`restore` 仍受未实现 `changes.apply` 门禁。

## 证据分栏

| 层 | 内容 | 证据类型 |
| --- | --- | --- |
| 适配器/夹具（默认 CI） | `executeCommand` seam 验证精确 argv/cwd/env、install→publish→record→argv 闭环、fail-closed（缺失声明源 / symlink 声明 / 内部 staging symlink / manifest name 或 digest 不匹配） | `tests/core/creation.test.ts` |
| 进程/生命周期夹具（默认 CI） | 真实子进程在三个生产相位被 `SIGKILL` 后 `recover()`：before-pointer 回滚无孤儿；after-publish 回滚且**保留带 provenance 的未提交孤儿**；after-pointer 前滚且已发布 profile 与活动代记录 name+digest 一致 | `tests/core/a2-window-kill.test.ts` |
| 摘要 parity（默认 CI） | core 与 runtime 的声明源摘要算法在同一目录（完整 / 可选文件缺席 / package.json 缺失 / 非常规文件）结果一致 | `tests/core/generation-profile.test.ts` |
| 真实 rc.2（opt-in，自有副本） | profileInit 精确参数 → 发布 → 真实 `--profile` 启动就绪 → SIGTERM 停止；无内部 symlink/断链 | `scripts/research/a2-profile-init-boot-probe.sh` |
| **真实 npm-ci 全链（opt-in）** | 真实安装器 `npm-ci` 闭包 + preflight + profileInit → core 发布 → 真实受管进程 `--profile` 启动 `running` → 停止 | `scripts/research/a2-real-install-loop-probe.mjs` |

## 真实 npm-ci 全链

平台 macOS ARM64；固定身份 `darwin-arm64-node22_19_0-dsh0_1_5-rc_2`（node sha256 `c59006db…`、dsh sha256 `f4c54839…`，取自 `VERIFIED_COMBINATIONS`）。命令（缓存目录由环境变量显式提供，脚本复制到自有临时根；无模型请求、无个人凭据、无第三方插件；npm 缓存完整时不需要网络）：

```sh
HDSL_A2_REAL=1 \
HDSL_A2_CACHE=<verified-artifacts-dir> \
HDSL_A2_NPM_CACHE=<verified-npm-cache-dir> \
node scripts/research/a2-real-install-loop-probe.mjs
```

脱敏输出：

```text
install: real npm-ci closure + profileInit for darwin-arm64-node22_19_0-dsh0_1_5-rc_2
install operation: succeeded
staged source: true
published profile: true
record profileName/digest: hdsl-gen-… / 08936a6ce1987559…
manifest.profile: {"name":"hdsl-gen-…","digest":"08936a6ce1987559…"}
staged<->manifest digest equal: true
record<->manifest digest equal: true
provenance: {"schemaVersion":"1","generationId":"gen-…","profileName":"hdsl-gen-…","digest":"08936a6ce1987559…","transactionId":"txn-…"}
start: real managed process with --profile (readiness from the process manager)
start operation: succeeded
environment state after start: running
stop: real managed process stop
stop operation: succeeded
RESULT: PASS — real npm-ci install -> profile publish -> managed --profile start -> stop
```

**能证明**：生产默认 `profileInit:true` 下，真实安装路径能产出 `<generation>/profile` 不可变声明源；`manifest.profile`、代际记录、真实 staged 声明源摘要一致；发布到 `<env>/home/profiles/hdsl-<gen>` 且带 provenance；真实受管进程以 `--profile hdsl-<gen>` 启动就绪并可停止。

**不能证明 / 边界**：同环境双代变更与 `restore`（依赖 `changes.apply`）；E10b 生产接线/双代端到端；E9（`--dump-config` 静态性——本探针只在 profileInit 初始化时使用它，不声称零 bundle 执行）；E1；真实桌面/Windows；S2 预览/下载/UI、S3/S4。

## provenance 与摘要

- 发布时把 `{generationId, profileName, digest, transactionId}` 原子写入临时 profile 的 `.hdsl-profile.json`，rename 后校验；仅供未来 journal 键控 GC 归属，**不授权任何删除**，也不是安全证明。
- 该派生 marker **显式排除**在声明源摘要之外（`PROFILE_DECLARATION_FILES` 不含它）。
- 未提交代的已发布 profile 可能在共享 home 中累积；**当前不回收**。

## 复现注意

- 真实探针为显式 opt-in（`HDSL_A2_REAL=1`），默认 CI 不运行、默认不联网。
- 失败时保留自有临时根并只输出脱敏信息；成功时清理。
- 源缓存只读复制，不修改。
