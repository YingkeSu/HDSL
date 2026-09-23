# E2（#118）任务

基线 `ea7f5717c8c2eb9cb051c451fcb4298b3bb71bfa`。

| 任务 | 内容 | 状态 |
| --- | --- | --- |
| T-E2-001 | 分组 `# ==` 解析：每段独立单文档/序列；前言/非序列/YAML 错误显式诊断 | 完成 |
| T-E2-002 | 行模型 `(id, name, disabled, config?)`；缺 id 不伪造 | 完成 |
| T-E2-003 | `!!js` / 非字面 tag / alias / merge key 逐字保留、不求值；`disabled: !!js` 记为未知 | 完成 |
| T-E2-004 | 有界解析（dump/段落/行/config/诊断）与 `truncated` 诊断 | 完成 |
| T-E2-005 | 受管 `--dump-config` 调用：隔离 env、无凭据、无 journal、超时/abort/输出上限 | 完成 |
| T-E2-006 | 契约：`compositions.expected` + `ExpectedCompositionView` + 操作 kind `composition` + 输出 schema | 完成 |
| T-E2-007 | core 服务：操作生命周期、环境/代际/profile 解析、busy/无代守卫、取消、stderr/config 脱敏 | 完成 |
| T-E2-008 | main 接线 + renderer 只读面板与强制“期望组成（dump）≠ 运行期 ACTIVE”文案 | 完成 |
| T-E2-009 | 测试：解析/调用 opt-in/服务/契约路由/渲染 | 完成 |
| T-E2-010 | spec/contracts/plan/tasks + local-api.md + 验证记录 + 导航 | 完成 |
| T-E2-011 | 运行期 ACTIVE 集合确认 | **blocked**（无经验证的公开只读会话面；见 [spec](spec.md) §2） |
| T-E2-012 | E9（dump == 运行期加载集合） | 未证（不声称） |
| T-E2-013 | Windows/Linux | 未测 |
