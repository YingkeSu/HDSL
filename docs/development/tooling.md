# 开发工具链

## 环境要求

- Node.js：推荐 `.nvmrc` 中的 `24.21.0`。允许范围由根 `package.json` 的 `engines.node` 定义。
- pnpm：`11.7.0`，与 `packageManager` 和 CI 一致。
- Python：3.9 或更新版本，用于仓库文档检查。

```bash
# 已使用 nvm 时，先执行 nvm install && nvm use
git clone https://github.com/YingkeSu/HDSL.git
cd HDSL
npm install --global pnpm@11.7.0
pnpm install --frozen-lockfile
```

仓库通过 `pnpm-workspace.yaml` 的 `saveExact`、`engineStrict` 与 `pnpm-lock.yaml` 固定依赖。更新依赖时同时提交对应 manifest 和锁文件。Electron、React、TypeScript 等实际版本以各包的 `package.json` 为准。

开发用 Node.js 和安装到环境内的受管 Node.js 相互独立；后者由 `packages/runtime/src/catalog/combinations.ts` 定义。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `pnpm run typecheck` | 检查整个 workspace 的 TypeScript 类型 |
| `pnpm run build` | 编译主进程和共享包 |
| `pnpm run build:renderer` | 打包 React renderer 与静态资源 |
| `pnpm run build:desktop` | 完整桌面构建，包含以上两步 |
| `pnpm --filter @hdsl/desktop exec electron .` | 启动构建后的应用 |
| `pnpm test` | 运行默认 Vitest 测试 |
| `pnpm run test:watch` | 开发时持续运行测试 |
| `python3 scripts/check_repository.py` | 校验项目文档、链接和规格结构 |

首次启动 Electron 时可能下载对应平台的二进制。应用目前没有开发热更新命令，修改后重新构建并启动。数据目录、凭据配置与运行参数见[桌面集成](desktop-integration.md)。

## CI

[Engineering checks](../../.github/workflows/engineering-checks.yml) 在 Ubuntu 上安装锁定依赖并运行类型检查、构建和默认测试。[Repository checks](../../.github/workflows/repository-checks.yml) 运行文档结构检查。

真实 DSH 下载、系统钥匙串、原生 GUI 和跨平台验收需要相应运行环境及显式启用；CI 通过不代表这些场景全部通过。详见[测试指南](testing.md)。
