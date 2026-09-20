# Renderer 交互演示（mock）

`index.html` 是一个**自包含的静态演示**，用模拟数据展示 T006a 的列表、创建、选择、启停进度、
错误、WebUI 入口与诊断摘要。它不访问网络、Node、文件系统或任意 IPC，也不依赖任何构建产物。

打开方式（AO 会话内）：

```bash
ao preview apps/desktop/src/renderer/demo/index.html
```

## 边界

- 演示使用的是**模拟数据（mock）**，不是真实 DSH 进程，也不是 Electron 实机运行结果；
  不要把本页截图或交互记录当作启动器验收证据。
- 生产界面是 `apps/desktop/src/renderer/` 下的 React 组件，通过显式注入的
  `RendererContractClient` 只调用冻结契约方法；`index.tsx` 在没有注入客户端时会直接抛错，
  不会回退到本演示的 mock。
- 本页与 `apps/desktop/src/renderer/controller.ts` 共享同一套交互语义和中文状态文案，
  但它是独立的 vanilla 实现，仅用于键盘操作、空态/失败态/进行中的可视化验证。
