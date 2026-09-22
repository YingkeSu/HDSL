# 受管 pnpm 默认拒执行哨兵验证（#76 / E1）

状态：**在冻结的受管 pnpm 11.7.0 链上真实执行**。观察的是**外部 marker 文件**（副作用），不是 executor 自报。这是执行器/哨兵证据；不代表 #76 安装闭环完成。

## 冻结制品（有界官方下载，自有缓存，未执行）

| 项 | 值 |
| --- | --- |
| url | `https://registry.npmjs.org/pnpm/-/pnpm-11.7.0.tgz` |
| sha512（= registry integrity） | `sha512-GcyFLBIMcSV2DyRD7mvgyltA+fUFmN4aCaHxd1A+AQ5Xwjx3ZG4B52HeWb+HT7IqM5jDOrlpH8E+uUa28PTWIA==` |
| sha256（制品） | `deafa7ec98a1218b6a047289b92fbe2395c1e22d3495bb711653013218ee15ee` |
| 入口 `bin/pnpm.mjs` sha256 | `ff3224d46b47fbb24a7e9fe15fededef7e00892d07d4e376b6762d4899906bfd` |
| 解包树摘要 | `b364f1bde35b9716f9af7b6018b64834490b63b783e3e3b462962e22c0dae1d1` |

受管 Node 身份：`v22.19.0`（已核受管安装）。固定为 `PNPM_EXECUTOR_SPEC`（常量，非 renderer 任意 URL）。

## 哨兵实验（`scripts/research/a2-pnpm-sentinel-probe.sh`，opt-in）

自有已审 fixture：根项目 + `git+file://` 受控本地依赖，其 `preinstall/install/postinstall/prepare` 与根 `preinstall` 均写外部 marker。

```text
deny: pnpm install --ignore-scripts
  exit=0 markers=0
allow(test-only): pnpm install --ignore-scripts=false + precise allowBuilds
  exit=0 markers=5: gitdep-install gitdep-postinstall gitdep-preinstall gitdep-prepare root-preinstall
RESULT: PASS — default deny wrote no markers; isolated allow triggered preinstall/install/postinstall/prepare + root
```

### 精确条件（实测，不作版本默认推断）

- **默认拒执行**：`--ignore-scripts` 同时阻断根项目与依赖的 `preinstall/install/postinstall/prepare`（0 marker，exit 0）。生产默认参数常量 `DEFAULT_INSTALL_ARGS = ['install','--ignore-scripts']`。
- **隔离显式 allow（仅测试负控，非 S4 生产授权）**：需要**精确** `allowBuilds: {"<name>@git+<url>#<sha>": true}` + `--ignore-scripts=false`。仅写名字 `allowBuilds: [fixture-gitdep]` 被拒：`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`，错误信息本身要求精确 spec+commit（与 ADR D14"授权绑定精确 commit + 脚本集合"一致）。
- **`file:` 依赖反例**：`file:` 依赖的构建脚本无法用 `allowBuilds`/`pnpm.onlyBuiltDependencies` 放行（`ERR_PNPM_IGNORED_BUILDS: fixture-dep@file:../dep`）。因此依赖/prepare 哨兵用**受控 git 依赖**复现，**不以 `file:` 依赖推断所有 Git/注册表行为**。
- `prepare` 只在 git 源路径触发（实测）：默认拒下不写 marker，隔离 allow 下 `gitdep-prepare` 出现。

## 边界

- 隔离 allow 形式**不进入生产**、**不开放 S4 授权**；生产默认恒为 `--ignore-scripts`。
- executor 自报 `executedInstallScripts=[]` **不作为**默认拒执行证明；本记录的证据是外部 marker。
- 未验：真实 GitHub 全链路、注册表依赖的构建放行、桌面 E2E、Windows。
