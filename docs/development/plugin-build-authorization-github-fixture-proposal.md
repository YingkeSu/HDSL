# 生产 GitHub 脚本 fixture 最小发布方案（#78 S4，待审）

状态：**提案，未发布、未授权远端修改**。任何发布动作都必须先经独立静态审通过并由整合 owner 执行；不得改动既有 S3 已审 commit/tag，不得复用/重写既有 fixture 远端。

## 目的

现有 S4 证据（`scripts/research/a4-build-authorization-probe.mjs`）只覆盖受控 `git+file://` 传输。冻结受管 pnpm 11.7.0 上，`git+` 形态的 pinned-lock key 与 `allowBuilds` depPath 已逐字节相等；但 **`github:` shorthand 的 lock key 是 codeload tarball URL，是否等于 pnpm 的 build depPath 未实证**。本 fixture 用小而有界、可静态审的公开 GitHub 仓库闭环这一条：预览枚举 → 精确授权 → 单次 `allowBuilds` → 重启生效。

## 范围（最小、可失败）

- 只验证 **root 插件自身 4 个 lifecycle 脚本**在 `github:` shorthand 下的 `allowBuilds` 键与执行。
- 不引入注册表依赖、不引入 `file:`/本地传输、不引入 git 子依赖（受管 pnpm 11.7.0 的 `blockExoticSubdeps` 会以 `ERR_PNPM_EXOTIC_SUBDEP` 受控拒绝，且该策略按 34 证据未放宽；是否支持另立决策）。
- 漂移对照用同仓库的第二个 commit：改一个脚本命令文本（同 hook、同版本），验证 manifest 摘要变化 ⇒ 旧授权 `AUTHORIZATION_MISMATCH`/`PLUGIN_INTEGRITY_MISMATCH`。

## 拟发布内容（逐文件，全部无网络/无凭据/无子进程）

建议新公开仓库：`YingkeSu/hdsl-s4-gh-fixture`（或项目确认的受控命名空间；**不覆盖**任何现有仓库）。

| 文件 | 内容 |
| --- | --- |
| `package.json` | `name: hdsl-s4-gh-fixture-root`、`version: 0.0.1`、`dsh.bundle.patch: "cordis.patch.yml"`、`scripts: { preinstall, install, postinstall, prepare }` 各调用 `node scripts/mark.mjs <name>` |
| `scripts/mark.mjs` | 与受审 v2 fixture 相同的 fail-closed 脚本（`62dd040f…`）：只 `node:fs`/`node:path`；缺 `S4_MARKER_DIR` 或参数 ⇒ `exit 3`；否则只写 `<S4_MARKER_DIR>/<name>.marker`；无删除、无越界写、无 `child_process` |
| `cordis.patch.yml` | 仅一条 `- insert: [{ id, name: hdsl-s4-gh-fixture-root, ... }]` 的最小合法 patch（与 v2 同形状） |
| `lib/index.mjs` | 启动期 no-op 插件（与 v2 同形状） |
| `README.md` | 明示“HDSL S4 测试 fixture；脚本只在本机写 marker；无网络/凭据/个人数据；不得用于生产” |

- commit 1（`base`）：上述内容；`scripts/mark.mjs` 与 v2 逐字节相同。
- commit 2（`drift`）：仅改 `package.json` 里 `postinstall` 命令文本（或 marker 名加 `-v2`），用于漂移失效对照。
- 不建分支保护/不放 GitHub Actions（避免任何自动执行）。仓库本身不触发任何 workflow。

## 精确身份记录（发布后写入验证文档）

- tag → commit → tree、逐文件 SHA256、仓库 full name、默认分支。
- `github:<owner>/<name>#<commit>` 的精确 spec 与受管 pnpm 生成的 pinned-lock key（用于确认其是否等于 `allowBuilds` depPath）。
- 记录“静态审通过”的 review 出处与 SHA。

## 执行与证据边界

1. 静态审（30/33，只读）：逐文件副作用边界、无网络/凭据/keychain/子进程/越界写、mark.mjs fail-closed 行为。
2. 只有审通过后才允许：真实受管 Node/pnpm 运行预览（默认拒执行物化，断言 marker=0）→ 精确授权（断言恰好 root 4 个 marker 出现且 exit 0）→ 漂移 commit 重解析拒绝。
3. desktop 探针使用本地受控传输与受审 GitHub fixture 分栏记录；本地 `git+file://` 结论**不**替代 GitHub 结论，反之亦然。
4. 未跑完不得声称生产 GitHub 全链验收。

## 需要确认

- 仓库命名空间与 owner（是否用受控个人/组织账号；必须公开可匿名读，以匹配无凭据生产路径）。
- 是否接受“单仓库两 commit（base/drift）”作为最小矩阵，或需要独立 `drift` 仓库。
- 发布授权：本方案获批前**不创建仓库、不 push、不改任何远端**。
