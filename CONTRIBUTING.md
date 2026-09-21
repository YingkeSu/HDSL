# 贡献指南

开发环境与启动命令见 [README](README.md)，详细工具配置见[工具链](docs/development/tooling.md)。问题和功能建议通过 [GitHub Issues](https://github.com/YingkeSu/HDSL/issues) 跟踪。

## 开始修改

1. 阅读相关功能规格、[领域术语](CONTEXT.md)和[架构决策](docs/adr/README.md)。较大的功能先在 Issue 中说明用户场景、范围和验收方式。
2. 从最新 `main` 创建分支，保持一次修改聚焦一个问题。
3. 修改接口时同步契约、消费方及相关测试；新增架构决策写入 `docs/adr/`。
4. 修复缺陷时增加能够复现问题的测试，平台相关行为记录实际验证平台。

## 模块边界

- `contracts` 定义共享 DTO、协议和校验，不依赖其他业务包。
- `core` 管理状态、存储与用例；`runtime` 实现安装、进程和系统适配。二者通过端口组合，不互相导入。
- Electron 主进程负责组合模块和系统交互。renderer 只能调用 preload 提供的有限接口，不直接导入 Node.js 或 Electron。
- API key、会话、环境数据和未脱敏日志不得提交；环境目录隔离不能描述为 OS 沙箱。

## 提交前检查

```bash
pnpm run typecheck
pnpm run build:desktop
pnpm test
python3 scripts/check_repository.py
```

真实安装、进程与桌面测试的启用方式见[测试指南](docs/development/testing.md)。PR 请说明行为变化、验证方式及未验证的平台；测试替身和真实运行结果分别记录。

## 文档约定

- 稳定的领域术语放在 `CONTEXT.md`，架构决策放在 `docs/adr/`。
- 开发操作放在 `docs/development/`；验证记录注明版本、平台、命令、结果与局限。
- 功能规格和接口放在 `specs/`，产品范围与未来目标放在 `docs/product/`。
- 通用个人工具配置、Agent 编排记录、会话笔记和设计试稿留在本地，不提交到项目仓库。
