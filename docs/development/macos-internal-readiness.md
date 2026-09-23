# macOS 内测准备（2026-09-23）

决策见 [ADR 0007](../adr/0007-macos-acceptance-and-internal-distribution.md)。基线 `b8a1aca42fefb2570f6a956d81a4dbd655d4f3a6`；本轮不改生产功能，补充许可、执行范围与退出回归检查。当前不是可发布内测包的验收声明。

## 本轮执行顺序

1. 稳定性：有界复现 #88，区分正常退出、SIGKILL 兜底与租约残留；保留可回归的真实 Electron 测试。
2. 本机桌面主流程、真实插件候选、凭据原生入口、系统浏览器与诊断验收；未跑项目单列。
3. 契约 1.1 标签与 #95 分类精度收尾、文档纠偏。
4. 上述完成后设计和实现整合包，在本机独立环境验证导出、预检、导入与精确重建；跨机结果另列未测。
5. 制作 macOS ARM64 内测包，记录版本/SHA/摘要、未签名与未公证状态，验证解包、首次启动及用户流程；不上 App Store。Windows 留给维护者稍后测试。

## 退出观察 #88

新增 `tests/e2e/desktop.quit.real.test.ts`，使用生产 Electron 入口和独立临时 dataRoot，不调用模型，不安装插件：

- 渲染就绪后确认租约存在；分别发送 SIGTERM、从 renderer 请求关闭窗口。
- 10 秒内须以 code 0、无 signal 退出，并且租约已消失；清理函数的 SIGKILL 不计通过。
- 初次运行 2/2 超时；随后单独关闭窗口再次超时且租约仍存在。
- 为区分窗口关闭与 composition.close，短暂增加三个阶段观测点并重新编译，2/2 通过；移除全部临时日志后重新编译，2/2 仍通过。
- **结论：尚无已证根因、无生产修复**。构建产物状态和时序均可能影响结果，不能据绿测关闭 #88。此最小空环境场景也不替代已有运行环境/在途插件事务的退出验收。

复跑入口：

```sh
pnpm run build:desktop
HDSL_E2E_DESKTOP=1 pnpm exec vitest run tests/e2e/desktop.quit.real.test.ts
HDSL_E2E_GUI=1 pnpm exec vitest run tests/e2e/desktop.gui.real.test.ts
```

真实 GUI 启停使用测试专属 keychain canary 与 setup 引用注入，不能计作原生菜单导入验收。本轮真实 Electron 联合执行：退出两条 + 真实 GUI 启停一条，共 **3 passed**（64.19 秒，macOS ARM64）。退出断言为 `code: 0, signal: null` 且租约删除；未改生产代码。

## 第三方插件候选

2026-09-23 GitHub API 检索 `topic:dsh-plugin stars:>5000 fork:false archived:false` 返回 30 个仓库。stars 是查询时快照；结果含工具、桌面应用和列表，并非均为可安装 DSH 插件。读取精确 commit 的 manifest，再通过真实 `createGitHubPluginSource().previewSource()`（公开无认证 HTTPS）核对生产适配器输出；未执行候选插件代码。

| 仓库 | Stars | 精确 commit | 本轮结果 |
| --- | ---: | --- | --- |
| [yjh051108/dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite) | 7,204 | `195273352f23bff7f9023ebe2ec0cdbdf9c98f10` | 根 manifest 有 `dsh.bundle.patch`；生产来源预览成功，发现根 `prepare` 脚本，需精确授权；完整物化/安装/启动/卸载未跑 |
| [zhu1090093659/dsh-web](https://github.com/zhu1090093659/dsh-web) | 7,941 | `c5679ffd0a070797bcdfaee89a27cafab19c41be` | 根 manifest 有 `dsh.bundle.patch`；生产来源预览成功，依赖闭包未完整枚举，脚本风险 `unknown`；仍需完整预览物化；不得当作无脚本并直接授权 |
| [nexu-io/open-design](https://github.com/nexu-io/open-design) | 97,663 | 本轮只用于候选排除，不纳入执行锁 | 根为工作区应用，DSH 适配不等于根包可作为 HDSL 插件安装；不纳入本轮插件执行候选 |

来源证据（固定版本）：

- [routing-suite package.json](https://github.com/yjh051108/dsh-routing-suite/blob/195273352f23bff7f9023ebe2ec0cdbdf9c98f10/package.json)：manifest SHA-256 `aff0ae195f897f80e6912d7e246b8fdbcfcbbc73d0740ab5ac8663687a8eeab7`；包 `@dsh-external/dsh-super-injector@0.3.3`；`prepare` 调用 `injector/scripts/prepare.mjs`。manifest 标 BSD-3-Clause，README 写 MIT，执行候选审查需核对该提交 LICENSE 后记录差异，不能仅凭 README 声称许可一致。
- [dsh-web package.json](https://github.com/zhu1090093659/dsh-web/blob/c5679ffd0a070797bcdfaee89a27cafab19c41be/package.json)：manifest SHA-256 `e73b6c66513337e02424e5879deb28593e66acd2c80530892f76aa7b02c2b188`；包 `dsh-web@0.1.1`；固定依赖 `@linxin666/dsh-web-all@0.3.24`；来源锁闭包摘要 `009186cd1b15e87a68f215c18b4b31501482f052bc3fa2e3285df338560813f0`。

后续执行使用独立测试数据根、锁定源码和受管执行器，先核对精确脚本及依赖，再进行安装/启动/停止/卸载/恢复验收。未知服务依赖仍按 ADR 0005 D21 阻止卸载，不能因为 stars 达标就加入已核验服务目录或扩大用户授权。

## 内测分发边界

本机当前没有有效代码签名身份，**不阻塞本轮内测准备**。Developer ID、公证与 App Store 均不作为本次交付前置；以后选择签名分发时再配置。不关闭系统安全机制来包装首次启动成功。

当前没有内测包；整合包尚未实现、#88 根因未证、候选真实插件全链未验收、原生菜单与默认系统浏览器的当前版本验证未补齐。Windows 未测。以上均不得在发布说明中写为已完成。
