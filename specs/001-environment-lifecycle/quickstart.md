# 环境生命周期：运行与手工验收

## 构建并运行

按[项目 README](../../README.md)准备 Node.js 和 pnpm，然后执行：

```bash
pnpm install --frozen-lockfile
pnpm run build:desktop
pnpm --filter @hdsl/desktop exec electron . --hdsl-data-root "$HOME/.hdsl-dev"
```

当前运行时目录仅包含 macOS ARM64 组合。启动 DSH 前，按[桌面集成指南](../../docs/development/desktop-integration.md)准备系统凭据引用并通过原生菜单导入。该流程需要网络和可用凭据。

## 手工验收场景

1. 使用独立的测试数据目录打开 HDSL，选择运行时目录中的组合并创建环境 A。
2. 选择另一组合创建 B，记录两个组成摘要。
3. 导入各环境的凭据引用，启动 A，等待就绪，打开本地 WebUI，写入仅属于 A 的可识别配置或数据。
4. 停止 A，启动 B；验证数据不会串用，宿主默认 DSH 目录未改变。
5. 重复点击启动，不应产生第二个进程；停止并检查所属进程退出。
6. 在专用测试环境中注入摘要错误、端口冲突或进程异常退出，检查错误与诊断脱敏。
7. 记录版本、平台、命令、结果及未测项。Windows 需先补充运行时适配与组合，再开展对应实机验收。

自动化入口见[测试指南](../../docs/development/testing.md)，已有结果与缺口见[桌面验证记录](../../docs/development/desktop-validation.md)。
