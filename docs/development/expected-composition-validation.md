# E2（#118）期望组成只读验证记录

范围：本记录只对**下列精确版本/平台/条件**有效。它不是桌面验收、不是安全认证，也不是 E9（`--dump-config` == 运行期加载集合）等价性证明。历史计数与 SHA 不自动跟随当前提交。

- 上游版本：受管 `@deepseek-ai/dsh@0.1.5-rc.2`（本机只读副本 `/private/tmp/dsh-015`）。
- 运行时：Node `v25.6.1`（**仅本机探针**；受管组合仍为 22.19.0 / 24.21.0）。平台：macOS ARM64。
- 方式：隔离自有 `HOME`/`DSH_HOME`/`TMPDIR`，`DSH_TELEMETRY_DISABLED=1`；无网络、无第三方代码、无模型、无个人凭据。
- 前置事实：[#111 comment 5790424872](https://github.com/YingkeSu/HDSL/issues/111#issuecomment-5790424872)。

## 1. 离线 dump（只读）

命令（`env -i` 清空宿主环境后仅注入受管映射键）：

```sh
env -i PATH=/usr/bin:/bin \
  HOME=$HOME_ISO DSH_HOME=$HOME_ISO TMPDIR=$TMPDIR_ISO \
  DSH_TELEMETRY_DISABLED=1 NODE_NO_WARNINGS=1 \
  node /private/tmp/dsh-015/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --profile web --dump-config
```

结果（两次独立运行一致）：

| 项 | 值 |
| --- | --- |
| exit code | `0` |
| stdout 行数 / 字节 | `539` / `17,072` |
| stderr 字节 | `0` |
| `# ==` 段落数 | `20` |
| `!!js` 出现次数（逐字保留） | `15` |
| stdout sha256 | `7e488f8771181ab5394797d982cb98dceaed26463be62cc87f4fb8d29b9d175c` |

段落标签分布：

```text
10  # == @deepseek-ai/dsh-base
 9  # == @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app
 1  # == @deepseek-ai/dsh-web-app
```

- 输出是**分组段落拼接**（非单一逻辑文档），与实测一致。
- `!!js`（如 `root: !!js dshHomePath('sessions')`、`disabled: !!js process.platform === 'win32'`）**逐字保留、不被求值**；解析器只做 AST 检查，从不 `eval`、也不 resolve alias。

## 2. 解析与契约（默认 CI）

`packages/runtime/src/plugins/expected-composition.ts`
+ `tests/plugins/expected-composition.test.ts`、`tests/core/expected-composition.test.ts`、`tests/renderer/expected-composition.test.ts`：

- 分组解析：多段标签保留；非序列根 / YAML 错误 → `group-parse-failed`，后续段落仍解析；缺 id 行 → `row-ignored`；前言 → `preamble-ignored`；alias / merge key → `unresolved-construct`。
- `!!js` 原文逐字保留（`config.unevaluated = true`），并断言原文**不含**求值后的路径/环境值。
- `disabled: !!js …` → `disabled = null`、`disabledKnown = false`，不猜测布尔。
- 服务：终态固定 `basis='dump-config'` / `runtimeVerification='unavailable'`；`bundles`/`patchReload` 取自 profile 声明；stderr 与 config 原文在跨桥前做**脱敏**（绝对路径 → `<path>`），`!!js` 仍保留；running → `ENVIRONMENT_BUSY`；无活动代 → `NOT_FOUND`；取消后迟到结果被忽略。
- 截断绝不静默：为强制 `truncated` 诊断保留一个槽位，凡诊断/行/段任一下降都在终态回填；6000 行 `!!js` 饱和回归断言 `rowCount=5000` 且必含 `truncated`。
- 默认 CI 内的 port 边界用例（真实 `createExpectedCompositionPort` → `runCommand` → `spawn`）：宿主 `process.execPath` 被拒；子进程环境恰为受管映射/策略键（无宿主继承、无凭据键；macOS 仅允许系统注入 `__CF_USER_TEXT_ENCODING`）；`journalProcess:false` 不落 `.hdsl-process-children`。
- 渲染：强制文案“期望组成（dump）≠ 运行期 ACTIVE”；stderr 警告与解析诊断如实显示；切换选中环境后在途/陈旧 dump 被清空/丢弃。

opt-in 真实受管调用（`tests/plugins/expected-composition.test.ts`）：

```sh
# runner 为 Node 24.21.0（pnpm/vitest 的 process.execPath）；
# HDSL_EXPECTED_COMPOSITION_NODE 必须指向一个**不同的** node 可执行文件，
# 否则 createExpectedCompositionPort 按设计拒绝（避免宿主/Electron 二进制）。
PATH="$HOME/tools/node-24.21.0/bin:$PATH" \
HDSL_EXPECTED_COMPOSITION_REAL=1 \
HDSL_EXPECTED_COMPOSITION_DSH=/private/tmp/dsh-015/node_modules/@deepseek-ai/dsh/lib/bin.js \
HDSL_EXPECTED_COMPOSITION_NODE=/Users/suyingke/tools/node-25.6.1/bin/node \
pnpm exec vitest run tests/plugins/expected-composition.test.ts
```

结果：PASS（exit 0；行数 > 0；含未求值 `!!js`）。这是适配器/解析器证据，不是运行期加载集合证据。

## 3. 边界：派生的 `cordis.yml` 会被重写

`--dump-config` 会重写该 profile 的**派生** `cordis.yml`（ADR 0006 明确其为 live 派生状态，不进入代际身份）。实测两次运行：`cordis.yml` mtime 变化，而 `cordis.patch.yml` / `package.json` / `pnpm-workspace.yaml` **未变**，dump 逐字节一致。

因此实现：

- 只接受 stopped 环境（running/starting/stopping → `ENVIRONMENT_BUSY`），避免与活动 DSH 进程的 profile 相互影响；
- 不写 desired config / entry / package / version；
- 禁用 install-child journal（只读 inspection，不写所有权记录）。

## 4. 未测 / blocked

- **运行期 ACTIVE 确认 blocked**：`pluginInventory/list` 需官方 WebUI 会话，HDSL 不伪造会话、不新增私有 Remote；本切片不声明 ACTIVE。
- **E9 未证**：dump 与运行期加载集合的等价性仍未实证；生效判据只到“活动代记录 + 离线解析组合树”。
- Windows / Linux 未测；仅 loopback 未证。
