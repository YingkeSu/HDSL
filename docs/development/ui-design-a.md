# 桌面界面与交互验证

界面实现基线：`4eb905c`，记录日期：2026-09-21。

正式 renderer 使用 HMCL 式蓝色顶栏、左侧功能导航与右下常驻启动区。首页显示所选环境和可安装组合；环境详情默认折叠，新建表单按需打开。启动 / 环境 / 任务 / 帮助分别承载日常操作、选择、进度与凭据说明。

界面继续使用现有 `RendererController` 与冻结 DTO。运行中的主按钮打开工作界面，停止作为次操作；首次操作快照缺失时禁用新的变更操作，保留「重试获取状态」。任务支持取消，操作详情保留真实 ID、阶段。凭据引用仍从原生菜单导入。未引入 renderer 文件系统访问、任意 IPC 或当前尚未实现的插件入口。

## 验证证据

- TypeScript 类型检查、桌面构建通过。
- renderer / desktop / engineering：17 个测试文件、129 项通过。
- 真实 Electron smoke 通过：React 挂载，窄 preload 桥接，无 Node 全局暴露。
- `HDSL_E2E_DESKTOP=1` 下执行 `desktop.real.test.ts` 的 E2E-WIN-01 / E2E-WIN-02：2 项通过，验证真实窗口、输入与键盘焦点。其余 7 项未在本轮执行。
- Playwright 对正式 React 组件与控制器执行浏览器交互验收（显式测试传输层）：四种宽度 1440 / 1100 / 1024 / 390，无横向溢出，启动按钮可见；新建弹窗焦点、Esc 恢复焦点、输入错误修正、键盘提交、启停与诊断、首次快照失败后仅重新获取状态、取消、空态创建、加载失败重试、80 字符名称。页面异常 0。
- 截图和机器可读结果由脚本输出到本地 `design-demos/implemented/`，不提交生成产物。模拟传输测试不是实际 DSH 安装或模型调用验收；本轮没有重复执行这些流程。

## 重现

```sh
pnpm run typecheck
pnpm run build:desktop
pnpm exec vitest run tests/renderer tests/desktop tests/engineering
node apps/desktop/scripts/smoke-electron.mjs
HDSL_E2E_DESKTOP=1 pnpm exec vitest run tests/e2e/desktop.real.test.ts -t 'E2E-WIN-0[12]'
# 可选浏览器交互检查：需要另行安装 Playwright 及其 Chromium
HDSL_PLAYWRIGHT_MODULE=/absolute/path/to/node_modules/playwright node scripts/verify-renderer-ui.mjs
python3 scripts/check_repository.py
```

浏览器脚本生成 `.scratch/ui-a`，可用 `python3 -m http.server 4179 --bind 127.0.0.1 --directory .scratch/ui-a` 预览正式组件。顶部显式标注模拟数据。生产入口不会加载测试传输。
