# A2（#114）任务

基线：`ea7f5717c8c2eb9cb051c451fcb4298b3bb71bfa`。首个 PR 只交付 Tier 1。

## Tier 1（本 PR）

- [x] T101 契约：`OperationKind 'switch'`、`environments.switchCombination`、
  `SwitchCombinationCommand`、dispatcher 分支、fixture、`reference-port`、
  `consumer-parity`、`local-api.md`。
- [x] T102 journal：`kind: 'create' | 'switch'`（缺失默认 create，向后兼容）。
- [x] T103 core switch 事务：stopped-only 守卫、no-op、迁移收敛、新代安装验证、
  原子切指针、提交前失败保旧代、旧代保留。
- [x] T104 恢复：`recover()` 按 journal `kind` 分支；`switch` 回滚不置 `error`；
  孤儿 `switch` operation 受控失败。
- [x] T105 启动守卫：存在未决 create/switch journal 时 `start` → `ENVIRONMENT_BUSY`。
- [x] T106 版本记录：`generation.json.dshVersion`；
  `environment.json.lastStarted*` 在 start 成功后写入。
- [x] T107 回退提示：`generations.restore` 输出追加非阻断 `dshCompatibilityWarning`。
- [x] T108 确定性测试：成功/失败保旧代/两崩溃窗口/幂等/no-op/running 守卫/
  未知与不支持组合/启动守卫/孤儿恢复/版本排序与提示。
- [ ] T109 真实 opt-in macOS ARM64 全链证据（C22→C24 真实安装、启动、restore、
  启动 X）：见 `docs/development/version-switch-validation.md`，**未运行项保持未测**。

## 后续（不在本 PR）

- [x] T201 renderer「切换版本」控件 + 回退结果非阻断展示提示（独立组件文件
  `SwitchVersion.tsx`，不编辑 A1 列表组件）（#132，UI-only，未新增事务语义）。
- [ ] T202 扩展支持范围：纳入第二个 DSH 版本（安装/验证证据），单独 PR，改
  `packages/runtime/src/catalog/**`。
- [ ] T203 Tier 2 跨版本真实回退证据与数据兼容提示实测。

## 停止条件

交付物与证据齐备即停；不 close/reopen PR、不改 Actions 设置；无 checks 时如实报告。
