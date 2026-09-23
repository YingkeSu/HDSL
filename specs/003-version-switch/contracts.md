# A2（#114）契约：`environments.switchCombination`

实现：`packages/core/src/creation-service.ts`（`EnvironmentService.switchCombination`）。

本契约**在 1.1 内追加**，`API_VERSION` 不变（仍 `"1.1"`）。与 A1 的 `versions.dsh` 同型；
1.0 标签不动。

## 1. 方法

| 方法 | 输入 | 返回 | 约束 |
| --- | --- | --- | --- |
| `environments.switchCombination` | `requestId`, `environmentId`, `expectedRevision`, `catalogCombinationId` | `OperationRef`（`kind: 'switch'`） | 环境必须存在、revision 匹配、组合受审且平台匹配；**仅 `stopped` 环境可切换**；提交点后 `operations.cancel` → `CANNOT_CANCEL` |

`catalogCombinationId` 到 `CompositionLock` 的映射、平台匹配与 `UNSUPPORTED_COMBINATION`
判定与 `environments.create` 完全一致（dispatcher 纯守卫，无副作用）。

## 2. 数据模型（additive）

```ts
// OperationKind（dto.ts）
type OperationKind = ... | 'switch' | ...

// CreateJournalRecord（core/journal.ts，durable）
interface CreateJournalRecord {
  schemaVersion: '1';
  kind?: 'create' | 'switch';   // 缺失 = 'create'（旧记录向后兼容）
  ...
}

// generation.json（core，durable）
interface GenerationRecord {
  id: string;
  environmentId: string;
  compositionDigest: string;
  dshVersion?: string;          // 该代 lock/manifest 的 DSH 版本；旧记录缺失
  profileName?: string;
  profileDigest?: string;
  createdAt: string;
}

// environment.json（core，durable，additive）
interface EnvironmentRecord {
  ...
  lastStartedGenerationId?: string | null;  // 最近成功启动到 running 的代
  lastStartedDshVersion?: string | null;    // 其 DSH 版本；缺失/未知不提示
}

// GenerationSummary（contracts dto.ts，restore output，additive）
interface GenerationSummary {
  ...
  dshCompatibilityWarning?: string | null;  // 非阻断降级提示；无提示为 null/缺失
}
```

`EnvironmentSummary`（列表摘要）**不**暴露 `lastStarted*`：它们是回退决策的内部依据，
不是列表字段。如需 UI 展示，后续 PR 再追加。

## 3. 状态与相位

```text
planned → staged → verified → committed(activeGenerationId 原子写入) → finalized
提交前失败/取消 → rolled-back
提交后崩溃     → recover finalize（指针权威）
```

- **D1（操作专属前置）**：`state !== 'stopped'` → `ENVIRONMENT_BUSY`；不自动停进程、
  不自动重启；切换后仍 `stopped`。该规则只属于本方法，不传播。
- **D2**：新代 `npm-ci`（或 fixture `artifacts-only`）安装 + manifest 组成绑定校验 +
  profile 从不可变声明源在切指针前原子发布，再写 `activeGenerationId`。
- **D3**：提交前失败只删 `<gen>` stage 目录；`activeGenerationId`/`compositionDigest`/
  `revision`/`state` 保持；**不**调用 create 的 `#markEnvironmentError`。
- **D4**：不 GC 旧代；回退 `generations.restore`。
- **D5/D6**：降级提示非阻断；同版本（Node 轴）与未知版本不提示；不承诺跨版本 home 兼容。

## 4. 幂等

- 相同 `requestId` + 相同参数 → 返回原 `OperationRef`（dispatcher 账本），不重复安装。
- 目标组合 digest == 当前活动 digest → 成功 no-op operation，不产生新代、`revision` 不变。
- `in-progress` 中断由 `recover()` 依据 journal `kind` 对账：`switch` 回滚不置 `error`。

## 5. 错误映射

| 情形 | code |
| --- | --- |
| 未知 `environmentId` / 无活动代 | `NOT_FOUND` |
| 未知/未受审/平台不匹配组合 | `NOT_FOUND` / `UNSUPPORTED_COMBINATION` |
| `expectedRevision` 不匹配 | `REVISION_CONFLICT` |
| 环境非 `stopped`，或已有未决事务/journal | `ENVIRONMENT_BUSY` |
| 提交点后取消 | `CANNOT_CANCEL` |
| 安装/摘要/磁盘/验证失败 | `DOWNLOAD_FAILED` / `DIGEST_MISMATCH` / `DISK_FULL` / `INTERNAL_ERROR` |

## 6. 回退提示（`generations.restore`）

- 当目标代 DSH 版本**严格早于**环境记录的最近成功启动 DSH 版本时，`restore` 的
  operation output 携带 `dshCompatibilityWarning`（有界、无路径、无秘密）。
- 提示**不阻断**恢复；不撤销/不删除新代写入的数据；不做 schema 降级。
- 同版本、升级、任一版本未知 → 无提示。
