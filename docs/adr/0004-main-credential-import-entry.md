# 0004：主进程凭据引用导入入口

- 状态：accepted（issue #6 / T006，2026-09-20）
- 关联：#6、#43（dataRoot 锁）、#52（T005c 引用存储）、[ADR 0002](0002-credential-boundary.md)、[ADR 0003](0003-core-credential-reference-store.md)
- 依据：`specs/001-environment-lifecycle/contracts/local-api.md`（冻结方法白名单）、`docs/development/desktop-integration.md`

## 背景

ADR 0003 规定受管用户凭据只存 OS 凭据存储**引用**，由 core 的
`EnvironmentService.writeEnvironmentCredentials` 受信写入，且**不新增任意 IPC 凭据查询方法**。
T006 需要让用户实际配置引用，但冻结的 `@hdsl/contracts` 方法白名单里没有凭据写入方法，
renderer 也不得提交任意路径或 secret 值。

## 决策

1. **入口归主进程原生应用菜单**：新增菜单项「环境 → 导入环境凭据引用…」。
   文件选择由 main 的**原生**文件对话框完成（`dialog.showOpenDialogSync`），
   renderer 不参与、不接收路径。
2. **只接受引用、拒绝值**：配置文件为 `{ "schemaVersion": "1", "bindings": [ { "name", "reference": { id, store, key } } ] }`。
   严格校验：打开前 `O_NOFOLLOW`（拒符符号链接）+ `O_NONBLOCK`（特殊文件不阻塞）+ `fstat`
   检查常规文件与 16 KiB 上限，再限定读取 16 KiB+1（无无界读）；未知字段拒绝、`bindings` 1–32 条、
   变量名复用 runtime 的 `CREDENTIAL_NAME_PATTERN` 与 `RESERVED_ENVIRONMENT_NAMES`、重复名拒绝、
   当前实现只接受 `store: "keychain"`。含 `value`/`secret` 等字段即是未知字段，直接拒绝；
   不扫描“像 secret 的值”，因为格式本身没有放值的位置。
3. **目标环境来自经校验的选择状态**：renderer 通过独立的单向选择通道上报当前环境；
   main 只在 `findEnvironment` 能解析时记录，且在导入执行前**重新读取**环境，
   校验存在性与 state（`creating`/`starting`/`running`/`stopping` 拒绝），
   不能只靠陈旧选中 ID。
4. **写路径复用既有受信 API**：校验通过后调用
   `writeEnvironmentCredentials({ environmentId, bindings, expectedRevision: 当前 revision })`。
   不新增 IPC 方法，不扩冻结 DTO，不枚举 keychain，不做真实 keychain 写入/查询扩权；
   `service#account` 完整性由已实现的 runtime 端口在启动时 fail-closed 强制。
5. **不复制原文件、不记原文**：只读取文本用于校验；不复制文件、不写日志正文。
   失败只在原生对话框显示受控文案（阶段 + 原因），成功只报条数与“仅存引用”。
6. **无引用启动的显式提示**：`environments.start` 前，main 用
   `launchCredentialRequest` 做**只读**存在性预检（不解析 keychain）；缺引用时弹原生提示，
   指向本菜单入口，启动仍按 core/runtime 的 fail-closed 语义失败。

## 替代方案

- **新增 `credentials.write` IPC 方法**：改变冻结方法白名单，renderer 可提交任意引用，拒绝。
- **renderer 提交文件路径**：把主进程文件系统暴露给不可信页面，拒绝。
- **把引用塞进 `environment.json` 或环境创建参数**：改变冻结形状并扩大可见面，拒绝。
- **只在界面内存保存引用**：不跨重启，且与 T005c 存储重复，拒绝。

## 后果

- 用户配置凭据是**主进程原生**流程，不是 renderer 按钮；QA 的自动化可通过
  操作者环境变量钩子（见 `docs/development/desktop-integration.md`）获得确定性路径，
  但不接受 renderer 路径。
- 诊断导出默认排除 `<env>/credentials.json`（ADR 0003 登记的非阻塞项在本任务落地）。
- 本入口处理的是**引用**，不改变“秘密只在 OS store、运行时解析注入”的边界。

## 验证状态

- 实现：`apps/desktop/src/main/credential-import.ts`（严格解析 + `O_NOFOLLOW`/`fstat` 有界读取 + symlink 拒绝）、`menu.ts`、`app.ts` 菜单接线；生产入口 `index.ts` 不读任何导入/导出钩子，headless 注入只在单独测试入口 `qa-entry.ts`（非 package `main`，已从发布 `files` 排除），见 `docs/development/desktop-integration.md`。
- 已验证（单元）：严格解析/拒绝矩阵、状态与存在性守卫、只调用引用写入、有界读取（oversize/symlink/非普通文件）、无 secret 落盘、菜单启用/点击。
- 已验证（composition/main 级真实 macOS）：真实 keychain canary `service#account` 解析 + 导入 + 启动/停止（见 `docs/development/desktop-integration.md` 证据）。
- 待验证：真实 Electron 原生菜单/对话框的人工/受控运行归 QA25；专职安全 review 对新 SHA 重审。
