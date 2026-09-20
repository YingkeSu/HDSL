# 工具链初始化记录

日期：2026-09-20。

## Spec Kit

来源：[GitHub Spec Kit](https://github.com/github/spec-kit)，安装版本 `specify-cli==1.0.8`。本机通过 uv 安装全局 Specify CLI，仓库使用包内模板：

```bash
specify init --here --integration codex --integration-options='--skills' --script sh --non-interactive
```

初始化完成后已改写 constitution，并手工整理 001 spec、plan、tasks、research、data-model、quickstart 与本地契约。本次没有声称运行了 Spec Kit 的整条实现流程。

Codex skills 已提交到 `.agents/skills/`；`.specify/feature.json` 是每个 checkout 的当前功能指针，按官方规则不提交。新 checkout 使用 quickstart 的 `SPECIFY_FEATURE_DIRECTORY` 选择 001。

## Matt Pocock engineering skills

按用户指定的 setup-matt-pocock-skills 初始化 tracker、triage 与 domain 配置。技能引用的 seed 文件在本机技能目录缺失，因此按 SKILL.md 的字段和规则创建等价配置，不将其表述为模板原样拷贝。

后续 to-issues、triage、to-prd 使用 tracker 配置；领域建模、架构分析、诊断和 tdd 类技能读取 CONTEXT 与 ADR。配置可直接编辑 `docs/agents/*.md`；切换 tracker 时再重新执行 setup。

## T002 TypeScript 工程与 CI

日期：2026-09-20。基线：`35906854cae9ed69de6a6d0830a726a4ef767d31`（origin/main，T001 PR #19 合并后）。所有权：根工具配置、`apps/desktop`、`packages/{contracts,core,runtime}`、`.github/workflows`、本文件与 README 开发入口。

工具链（精确版本，全部经官方 registry / 官方下载页核验，不使用浮动 `latest`）：

| 组件 | 版本 | 核验来源 | 说明 |
| --- | --- | --- | --- |
| Node | 24.21.0 | T001 的 macOS ARM64 实测组合；nodejs.org `v24.21.0/SHASUMS256.txt` | 开发工具链，独立于受管 DSH 运行时 |
| Node tarball 校验 | `node-v24.21.0-darwin-arm64.tar.xz` = `6239d4cf92d864487ec8cd3615038f7b67e7f58b77b21cd2f09ea9fbd68065fe` | 同上 `SHASUMS256.txt` | 本机安装前逐值比对通过 |
| pnpm | 11.7.0 | 本机 `pnpm -v`；npm registry 存在该版本 | `package.json` `packageManager` 与 CI 固定同一版本（有测试校验） |
| TypeScript | 7.0.2 | registry.npmjs.org `latest` | TS7 已移除 `baseUrl`，`paths` 使用相对形式 |
| Electron | 44.4.3 | registry.npmjs.org `latest`；`engines.node >= 22.12.0` | 44.x 无 install script，二进制首次 `require('electron')` 才懒加载；CI 只 typecheck/build，不取二进制 |
| React / React DOM | 19.3.0 / 19.3.0 | registry.npmjs.org `latest` | renderer 的 React + TSX 编译链路 |
| vitest | 5.0.1 | registry.npmjs.org `latest`；`engines` = `^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0` | 声明的 `engines` 不含 Node 25（未受支持；实测仍能跑通 15 个测试，但不作为受支持工具链）；这也是开发工具链不选 Node 25.6.1 的原因，修复后由 `engineStrict` 强制 |
| @types/node | 24.13.6 | registry.npmjs.org 24.x 最新 | 匹配 Node 24 运行时 |
| @types/react / @types/react-dom | 19.3.0 / 19.3.0 | registry.npmjs.org `latest` | |

锁定方式：`pnpm-workspace.yaml`（`saveExact: true`、`engineStrict: true`）、`package.json` `engines.node = ^22.19.0 || ^24.0.0 || >=26.0.0`、`.nvmrc = 24.21.0`、提交 `pnpm-lock.yaml`。**pnpm 11 不读取 `.npmrc` 的 `save-exact`/`engine-strict`**，本项目不使用 `.npmrc`；这两个键放在 `pnpm-workspace.yaml` 才生效（PR #20 独立复审 F1 实测）。`tests/engineering/` 校验：无浮动版本、workspace 依赖边方向、Electron/React 不出现在领域包、renderer 不导入 Node 内建或 Electron、CI 与 `packageManager` 的 pnpm 版本一致，并在临时工作区实际调用 pnpm 验证 `saveExact`（新增依赖写入精确版本）与 `engineStrict`（不支持 engines 时安装失败、支持时通过），不用文本断言代替行为验证。

命令（干净检出）：

```bash
corepack enable                        # 按 packageManager 获取 pnpm 11.7.0
pnpm install --frozen-lockfile
pnpm run typecheck                     # tsc -p tsconfig.json
pnpm run build                         # tsc -b tsconfig.build.json
pnpm run test                          # vitest run
python3 scripts/check_repository.py
```

本机实测（macOS `Darwin 25.3.0 arm64`，Node v24.21.0，pnpm 11.7.0，2026-09-20）：`install`、`--frozen-lockfile`、`typecheck`、`build`、`test`（3 files / 17 tests，含实际调用 pnpm 的 `saveExact`/`engineStrict` 行为验证）与 `check_repository` 均通过。

范围与边界：新增 `.github/workflows/engineering-checks.yml`，只在 ubuntu-latest 运行 typecheck/build/unit；`repository-checks.yml` 继续独立运行 Python 仓库校验。平台敏感项（路径、权限、锁、rename、进程树）归 T008 实机验收；本 CI 不含 lint（T002 交付范围为 type/build/unit），也不含 Electron 打包或启动。workspace 包导出有意为空，业务契约属 T003。

## 当前检查范围

Repository checks 仍只检查文档结构、链接、JSON 与需求/任务 ID。T002 已建立 workspace、锁定依赖并新增 ubuntu typecheck/build/unit CI；它不覆盖 Electron 打包/启动、平台敏感文件与进程行为，也不覆盖任何业务验收。上述任何绿色结果都不能读作启动器通过测试。
