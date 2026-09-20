# core 环境凭据引用存储与 launch loader（T005c / issue #52）

本文件定义 core 侧的环境凭据**引用**存储与 `launchCredentialRequest` loader。
决策见 [ADR 0003](../adr/0003-core-credential-reference-store.md)；解析与注入机制见
`docs/development/credentials.md`（T005b / #44）。本文件只描述引用，**不包含任何 secret**。

## 定位与边界

- core 保存**环境级**的凭据绑定：环境变量名 → `CredentialReference`（冻结 DTO `{ id, store, key }`）。
- core 不解析 keychain、不读取 secret 值、不做 `service#account` 语义判断；这些由 #44/#51 的
  `createLaunchCredentialPort` 在生产路径统一 fail-closed 强制。
- core 不 import `@hdsl/runtime`；loader 返回的形状与 #44 的 `LaunchCredentialRequest` **结构等价**。
- 组合根（#6）接线：`createLaunchCredentialPort({ load: service.launchCredentialRequest })` →
  `createProcessManager({ credentials })`。

## 存储

路径（由环境 ID 内生，不接受调用方路径）：

```
<dataRoot>/environments/<environmentId>/credentials.json
```

严格版本化 schema（未知字段拒绝，值只允许引用）：

```json
{
  "schemaVersion": "1",
  "revision": 1,
  "bindings": [
    {
      "name": "DEEPSEEK_API_KEY",
      "reference": { "id": "cred-…", "store": "keychain", "key": "service#account" }
    }
  ],
  "updatedAt": "2026-09-20T00:00:00.000Z"
}
```

- `revision` 是**凭据记录**自己的单调计数；环境本身仍有 `revision`（组合代际修订）。
- `0600` 权限、`temp + fsync + rename` 原子写；写入在 #43 的 dataRoot 独占锁下。
- 引用与绑定不进入 `EnvironmentSummary`、renderer、诊断导出、普通日志或整合包。
- 单环境最多一条记录（覆盖写即更新）；M1 是否支持“单一默认 keychain item”的多环境复用由 #6 需求确认。

## 校验

- 顶层与每一项用 `@hdsl/contracts` 的 `credentialReferenceSchema` + 严格对象 schema 校验；未知字段拒绝。
- `bindings` 非空、`name` 非空且有界、`reference` 形状合法。
- **权威的变量名语法/保留名/shadow/重复绑定校验仍在 `@hdsl/runtime` 的 `injection.ts`**（启动时一次性
  fail-closed）；core 不复制该语法，避免两处漂移。
- 校验失败：写入返回 `INVALID_INPUT`（受信 API 的编程错误），不落盘。

## API（内部受信，不改冻结 IPC 白名单）

- `EnvironmentService.writeEnvironmentCredentials({ environmentId, bindings, expectedRevision? })`
  → `PortOutcome<{ revision: number }>`；守卫：`closed` → `INTERNAL_ERROR`，失锁 → `ENVIRONMENT_BUSY`，
  环境不存在 → `NOT_FOUND`，`starting`/`running`/`stopping` → `ENVIRONMENT_BUSY`，
  `expectedRevision` 不符 → `REVISION_CONFLICT`。
- `EnvironmentService.clearEnvironmentCredentials({ environmentId, expectedRevision? })` → `PortOutcome<void>`（同一组守卫）。
- `EnvironmentService.launchCredentialRequest(environmentId): Promise<LaunchCredentialRequest>`
  - 只读；环境不存在、无活动代际、记录缺失/损坏 → **reject**（fail-closed）。
  - 返回 `{ bindings, baseEnv }`，`baseEnv` 由该代际的 `generationPaths` 构造：
    `HOME`/`DSH_HOME` = generation `home/`，`DSH_AGENTS_HOME` = `home/agents`，`TMPDIR` = `home/.tmp`，
    `PATH` = 受管 Node `bin` + 系统路径；不继承宿主 `process.env`。
  - 这是 #44 `LaunchCredentialLoader` 的 `load` 实现，故返回 `Promise`；`createLaunchCredentialPort`
    会把 reject 映射为受控失败。

## fail-closed 语义

| 情况 | 行为 |
| --- | --- |
| 未配置引用 / 记录缺失 | loader reject；启动失败（`INTERNAL_ERROR`），不静默无凭据启动 |
| 记录损坏 / JSON 非法 / 未知字段 | loader reject；写入拒绝；不删除损坏证据 |
| 失锁（异常） | mutation 返回 `ENVIRONMENT_BUSY`；loader 仍只读，不写 |
| 绑定名非法/保留/冲突/重复 | 由 #44 `injection.ts` 在解析时 fail-closed |
| `service#account` account 缺失 | 由 #51 生产路径 fail-closed |

绝不隐式回退宿主 `process.env`、`~/.dsh` 或上游 `.credentials.yaml`。

## 验收映射

| 要求 | 测试 |
| --- | --- |
| 完整引用绑定返回 | `tests/core/credential-store.test.ts` |
| 缺引用 / 损坏 / 非法 schema fail-closed | 同上 |
| 状态守卫（运行/启停中拒绝） | 同上 |
| `0600` 权限与原子写 | 同上 |
| `baseEnv` 正确且不继承宿主 | 同上 |
| 无 secret 落盘、引用不进 summary | 同上 |
| core 不 import runtime | `tests/engineering/workspace-boundaries.test.ts` |
| 组合根接线 | #6（后续） |
