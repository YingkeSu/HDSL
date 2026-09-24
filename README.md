<div align="center">

# HDSL
### Hello DSH Launcher

**把版本、环境与插件放在一起，让 DSH 的启动更简单。**

面向 DeepSeek Harness 的桌面启动器与版本管理器。

[下载与发布](https://github.com/YingkeSu/HDSL/releases) · [快速开始](#快速开始) · [文档](docs/README.md) · [反馈问题](https://github.com/YingkeSu/HDSL/issues)

</div>

---

## 一个入口，管理你的 DSH

HDSL 负责选择版本、准备环境、管理插件组成，以及启动和停止 DSH。DSH 负责插件的实际加载、动态生命周期与运行行为。

我们希望它是一个好用的启动器，而不是另一套插件运行时。

### 选择版本，而不是反复配置工具链

查看上游 DSH 版本与发布渠道，区分已支持和尚未支持的组合；为环境安装指定的 Node.js 与 DSH，并在需要时切换版本。下载来源、版本和摘要都有明确记录。

> “已支持”表示 HDSL 已具备相应的安装与验证能力，不表示对上游版本作出安全担保。

### 为不同工作保留独立环境

创建多个环境，分别保存配置与运行数据；查看进度和状态，启动、停止或重启受管进程，在系统浏览器中打开 DSH 工作界面。

环境之间采用目录与进程管理层面的隔离，**不是操作系统沙箱**。

### 让插件管理回到 DSH 的机制上

发现、预览、安装和移除插件，管理包依赖与组成记录。包依赖或 bundles 变更需要重启；支持的 entry 配置操作则写入用户 patch，交给 DSH 处理。

保存配置不等于确认运行期已经生效。界面会明确显示 **“已保存 / 等待 DSH 应用（未确认 ACTIVE）”**，并提供显式重启入口。

插件加载、卸载后带来的运行影响由 DSH 处理。HDSL 不承诺任意插件的无损卸载，也不把未知服务依赖本身作为禁止卸载的理由。

### 出错时，保留清楚的边界

HDSL 提供代际组成记录、恢复入口、操作状态与脱敏诊断。安装期构建脚本默认拒绝执行，需要时显式授权。

**恢复组成不等于回滚数据。** 不同 DSH 版本可能改变共享 home 或会话数据；降级提示不是数据兼容性保证。

## 平台与发布状态

HDSL 仍处于早期开发阶段。请用独立环境试用，并备份重要数据。

| 平台 | 当前状态 |
| --- | --- |
| macOS Apple Silicon（ARM64） | 已有受管安装、启停、版本切换和插件验收记录；具体覆盖范围见验证文档 |
| Windows x64 | 实验性 Windows x64 桌面构建；未实机验证；当前不支持在 Windows 创建/安装 DSH 环境 |
| Linux / 其他架构 | 未提供完整支持声明 |

当前受管目录包含 DSH `0.1.5-rc.2`、`0.1.7-rc.1`，分别搭配 Node.js `22.19.0` 或 `24.21.0`，**这些已支持组合目前均为 macOS ARM64**。版本发现列表中的其他版本不等于可直接安装。

Windows 产物若发布，其可用功能、已知限制和下载方式以对应 Release 说明为准。**有构建产物，不等于通过平台验收。**

## 快速开始

### 从源码运行

准备 [`.nvmrc`](.nvmrc) 指定的 Node.js，以及 pnpm `11.7.0`：

```bash
git clone https://github.com/YingkeSu/HDSL.git
cd HDSL

npm install --global pnpm@11.7.0
pnpm install --frozen-lockfile
pnpm run build:desktop
pnpm --filter @hdsl/desktop exec electron .
```

首次安装 Electron、创建 DSH 环境时需要网络。应用数据默认存放在 Electron 的 `userData` 目录。

在 macOS 上开发或试用时，可指定独立的数据目录：

```bash
pnpm --filter @hdsl/desktop exec electron . --hdsl-data-root "$HOME/.hdsl-dev"
```

### 第一次使用

1. 创建环境，选择当前平台已支持的运行时组合。
2. 等待安装完成，按[凭据配置指南](docs/development/desktop-integration.md#凭据引用配置主进程原生菜单adr-0004)准备并导入凭据引用。
3. 启动环境，在系统浏览器中打开 DSH。
4. 按需管理版本与插件；需要重启的变更会明确提示。

当前凭据接入以 macOS 系统钥匙串路径为基础。不要将个人 API key 写入仓库、普通日志或待分发文件。

## 文档导航

| 我想了解…… | 从这里开始 |
| --- | --- |
| 如何开发和检查项目 | [贡献指南](CONTRIBUTING.md) · [测试指南](docs/development/testing.md) |
| 当前验证了什么、没有验证什么 | [macOS 验证记录](docs/development/validation-001.md) |
| 桌面接线与凭据配置 | [桌面集成指南](docs/development/desktop-integration.md) |
| 插件配置为什么不直接显示“已生效” | [运行期 entry 验证](docs/development/plugin-runtime-entry-validation.md) |
| 为什么采用这些设计 | [架构决策](docs/adr/README.md) · [项目上下文](CONTEXT.md) |
| 接下来要做什么 | [路线图](docs/development/roadmap.md) · [GitHub Issues](https://github.com/YingkeSu/HDSL/issues) |

完整目录见 [docs/README.md](docs/README.md)。

## 参与开发

技术栈：**Electron · React · TypeScript · pnpm**

```text
apps/desktop/       桌面主进程、preload 与界面
packages/contracts/ 共享类型、输入校验与本地接口
packages/core/      环境状态、存储与事务协调
packages/runtime/   运行时安装、进程、插件与凭据适配
tests/              单元、集成和 opt-in 实机验收
specs/              规格、计划与契约
docs/               架构、开发指南与验证记录
```

提交前执行：

```bash
pnpm run typecheck
pnpm run build:desktop
pnpm test
python3 scripts/check_repository.py
```

文档检查需要 Python 3.9 或更新版本。真实 DSH 与 Electron 验收为单独启用的测试，不应把默认测试全绿当作所有平台已验证。

欢迎通过 Issues 报告问题。请附上 HDSL / DSH / Node.js 版本、操作系统、复现步骤和脱敏日志；**不要提交密钥或私人配置**。

## 许可

使用与分发条件以仓库 [LICENSE](LICENSE) 为准；第三方组件遵循各自许可证，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目不以“开源”措辞替代实际许可条款。

---

<div align="center">

**HDSL 管理启动与组成，DSH 负责运行与加载。**

</div>
