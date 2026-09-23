# E1（#116）契约：desired-config 管理边界

实现：`packages/runtime/src/plugins/patch-config.ts`（导出见 `packages/runtime/src/index.ts`）。

本契约**不新增** `ContractPort` 方法、preload 白名单方法或 HTTP/Remote 面。它是 runtime 内的适配器契约；产品接线在运行期确认通过前不实现（见 [plan.md](plan.md) §4）。

## 1. 数据模型

```ts
type PatchReloadMode = 'live' | 'startup' | 'unknown';
type PatchEditKind = 'enable' | 'disable' | 'config' | 'remove';
type PatchChangeScope = 'patch-entry' | 'composition';
type PatchActivation = 'restart-required' | 'live-reload-unverified';

interface PatchEditOperation {
  kind: PatchEditKind;
  rowId: string;
  config?: unknown;        // kind='config' 必填；整行替换
}

interface PatchRowView {
  id: string;
  kind: 'insert' | 'override';
  name: string | undefined;   // 无显式 tag 的普通字符串
  nameKnown: boolean;         // 名称为显式 tag/alias/块标量时 false
  disabled: boolean | undefined;
  hasConfig: boolean;
}

interface PatchWriteResult {
  patchPath: string;
  operation: PatchEditKind;
  saved: true;                          // 仅表示 desired config 已原子保存
  runtime: 'pending';                   // 未观测运行期集合
  runtimeVerification: 'unavailable';   // 无可靠公开确认 API
  activation: PatchActivation;
  restartRequired: boolean;
  reloadMode: PatchReloadMode;
  rows: readonly PatchRowView[];
  diagnostics: readonly PatchDiagnostic[];
}
```

## 2. 方法

| 方法 | 输入 | 成功 | 失败 |
| --- | --- | --- | --- |
| `PatchConfigDocument.parse(text)` | patch 文本 | `PatchConfigDocument` | `INVALID_INPUT`（0 字节、非序列根、**多文档**、YAML 错误、`insert` 非序列、超尺寸） |
| `document.edit(op)` | 四类操作 | `{ document, changed }`（`changed` 与实际改动一致） | `NOT_FOUND`（enable/remove 未命中）、`INVALID_INPUT`（空 id / config 无值 / config 不可表示） |
| `document.rows()` / `document.diagnostics()` / `document.toText()` | — | 行视图 / 诊断 / 文本 | — |
| `writePatchFileWithinRoot(profileRoot, patchPath, text)` | profile 根 + 根内路径 + 文本 | 原子落盘 | `INVALID_INPUT`（路径越界/无根）、`INTERNAL_ERROR`（写失败） |
| `resolvePatchReloadMode(profilePackageJsonText)` | profile `package.json` 文本 | `live` / `startup` / `unknown` | — |
| `activationOf(scope, reloadMode)` | 作用域 + reload | `PatchActivation` | — |
| `applyPatchOperation(input)` | `profileRoot` + 根内 `patchPath` + 文本 + 操作 + reload + scope | `PatchWriteResult` | 解析/编辑/越界错误原样返回；写失败 `INTERNAL_ERROR` |

`writePatchFileAtomicRaw` **不是**导出面；唯一公开写入口是锚定的 `writePatchFileWithinRoot`。

## 3. 操作语义与行匹配

- **enable**：清除目标行（own `insert` 行与/或覆盖行）的 `disabled`；**只**删除因本次删除 `disabled` 而变成 `id`-only 的目标覆盖行（该行自身注释随之移除），不触碰无关 override 或注释。目标不存在 → `NOT_FOUND`；无可改动 → `changed: false` 且 `toText()` 返回原文。
- **disable**：为目标 `insert` 行 / 覆盖行写 `disabled: true`；目标只存在于 bundle/base 时新增 `- id: X` + `disabled: true` 覆盖（additive）。
- **config**：用给定值**整行替换**目标行的 `config`（不深合并）；**last-write-wins**：写文档顺序中**最后一个**匹配行（`insert` 行或更后的 `- id:` 覆盖），从而合成结果就是新 config；目标只存在于 bundle/base 时新增覆盖。
- **remove**：删除目标 `insert` 行及其覆盖行；保留其余行。目标不存在 → `NOT_FOUND`。

### 行匹配（明确，不作为安全声明）

- 仅按 profile 内行 `id` 匹配，按**文件顺序**跨 `insert` 行与 `- id:` 覆盖行；重复 id 为 last-write-wins（与 DSH 层合成一致）。
- **不**匹配 `name`：重复 id 携带不同 `name` 时不作消歧，属已知限制而非保护。
- 读-改-写无锁/CAS；并发写属产品接线（见 [spec.md](spec.md) §5），本层不声称并发安全。

## 4. 诚实状态契约（硬约束）

- `saved === true` 只表示 desired config 已保存；**禁止**据此断言运行期 ACTIVE。
- `activation === 'live-reload-unverified'`：profile 显式 `patchReload=live`，预计 watcher 热重载；但 HDSL 未观测，可能落在预热窗口或被吞错。
- `activation === 'restart-required'`：`startup` / `unknown` reload，或 composition 变更；重启后按同一文件确定性加载。
- `runtimeVerification` 在获得经验证的公开只读确认面前恒为 `unavailable`。
- 不得新增私有 Remote、不得伪造 DSH 会话/cookie、不得把 launcher BrowserWindow 假定为已授权。

## 5. 错误码

复用 `@hdsl/contracts` 现有错误码，不新增：

- `INVALID_INPUT`：非法 patch（含多文档）、非法操作输入、写路径越界。
- `NOT_FOUND`：enable/remove 目标行不存在。
- `INTERNAL_ERROR`：原子写失败。

## 6. 原子写与路径锚定

- 唯一公开写入口 `writePatchFileWithinRoot(profileRoot, patchPath, text)` 先做**词法包含**校验（`patchPath` 必须严格位于 `profileRoot` 内），越界 → `INVALID_INPUT`，不发生 IO。
- 原子写：不可预测临时名 + `O_CREAT|O_EXCL|O_NOFOLLOW`、mode `0o600`、file fsync → rename；失败路径 `finally` 清临时文件；rename 后目录 fsync 按平台能力 best-effort（如 Windows 可能不支持）。
- 包含校验为词法（与 core `assertWithin` 同一意图），不是 realpath 沙箱；预先存在的目录符号链接逃逸不在本层防御范围。

## 6. 明确排除

- 不提供 `insert`（新增插件行属包管理 B1 #115）。
- 不编辑 `package.json` / `pnpm-lock.yaml` / bundles（composition 变更需重启）。
- 不做影响分析，不把静态分析设为门禁。
- 不使用 loader 内部 API、`dynamicCordisRunner/*`。
