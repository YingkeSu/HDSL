# HDSL — Hello DSH Launcher

HDSL 是面向 DeepSeek Harness（DSH）的桌面启动器，用于管理独立的本地工作环境。它为每个环境安装指定版本的 Node.js 和 DSH，管理启动、停止与运行状态，并在系统浏览器中打开 DSH 工作界面。

项目使用 **Electron + React + TypeScript**，目前处于早期开发阶段，可从源码构建运行，尚未提供正式安装包。

## 当前功能

- 创建和切换环境，为不同工作保留独立的配置与运行数据目录。
- 安装锁定版本的 Node.js 和 DSH，校验下载摘要并复用缓存。
- 启动、停止受管进程，查看操作进度、错误和恢复状态。
- 通过系统凭据存储引用加载 API key，导出脱敏诊断。

当前受管运行时仅包含 **macOS Apple Silicon（ARM64）** 组合：DSH `0.1.5-rc.2` 搭配 Node.js `22.19.0` 或 `24.21.0`。Windows 和 Linux 尚未纳入运行时目录。macOS 插件发现、安装、卸载保护、显式构建授权与代际组成恢复已实现；未知服务依赖的插件仍会被阻止卸载。整合包与内测分发属于[后续规划](docs/development/roadmap.md)。当前验收在本机 macOS 完成，Windows 由维护者稍后自行测试。

环境目录隔离不等于操作系统沙箱；DSH 及其插件仍可能访问环境外的文件。

## 从源码运行

准备 Node.js（推荐使用 [.nvmrc](.nvmrc) 指定的 `24.21.0`）、pnpm `11.7.0`。仓库文档检查另外需要 Python 3.9 或更新版本。

```bash
git clone https://github.com/YingkeSu/HDSL.git
cd HDSL
npm install --global pnpm@11.7.0
pnpm install --frozen-lockfile
pnpm run build:desktop
pnpm --filter @hdsl/desktop exec electron .
```

首次运行 Electron、首次创建 DSH 环境都需要网络下载。应用数据默认写入 Electron 的 `userData` 目录；开发时可指定独立目录：

```bash
pnpm --filter @hdsl/desktop exec electron . --hdsl-data-root "$HOME/.hdsl-dev"
```

打开应用后，创建环境并等待安装完成。启动前，需要在 macOS 钥匙串中准备 API key，再通过应用菜单「环境 → 导入环境凭据引用…」导入对应引用。配置格式与具体操作见[凭据配置](docs/development/desktop-integration.md#凭据引用配置主进程原生菜单adr-0004)。

## 开发与检查

```bash
pnpm run typecheck
pnpm run build:desktop
pnpm test
python3 scripts/check_repository.py
```

默认测试包含契约、核心逻辑及文件/进程测试；真实 DSH 安装、Electron 主流程等测试需要单独启用。运行条件见[测试指南](docs/development/testing.md)。修改源码后重新构建并启动应用。

```text
apps/desktop/       Electron 主进程、preload 与 React 界面
packages/contracts/ 共享类型、输入校验与本地接口协议
packages/core/      环境状态、存储与事务协调
packages/runtime/   运行时目录、安装、进程与凭据适配
tests/              单元、集成与桌面验收测试
specs/              功能规格、数据模型与接口契约
docs/               产品设计、架构、开发指南与验证记录
```

## 文档与贡献

- [文档索引](docs/README.md)：按开发任务查找资料。
- [贡献指南](CONTRIBUTING.md)：模块边界、提交要求与检查方式。
- [架构设计](docs/architecture/tdd.md)与[设计决策](docs/adr/README.md)。
- [环境生命周期规格](specs/001-environment-lifecycle/spec.md)与[本地接口](specs/001-environment-lifecycle/contracts/local-api.md)。
- [GitHub Issues](https://github.com/YingkeSu/HDSL/issues)：问题反馈与开发任务。

## 许可

HDSL 自有内容采用 [HDSL 分发有限许可](LICENSE)，按 PCL 官方同款许可适配：允许不以软件本身收费的原样分发，其余权利保留。这是自定义有限许可。第三方依赖遵循各自许可证，见[第三方说明](THIRD_PARTY_NOTICES.md)。
