# 生产 GitHub 脚本 fixture 最小发布方案（#78 S4，待审）

状态：**提案，未发布、未授权远端修改**。任何发布动作都必须先经独立静态审通过并由整合 owner 明确确认 owner/命名空间后执行；不得改动既有 S3 已审 commit/tag，不得复用/重写既有 fixture 远端（`YingkeSu/hdsl-plugin-e2e-fixture` 保持不动）。

## 目的

现有 S4 证据（`scripts/research/a4-build-authorization-probe.mjs`）只覆盖受控 `git+file://` 传输。冻结受管 pnpm 11.7.0 上，`git+` 形态的 pinned-lock key 与 `allowBuilds` depPath 已逐字节相等；但 **`github:` shorthand 的 lock key 是 codeload tarball URL，是否等于 pnpm 的 build depPath 未实证**。本 fixture 用最小、可静态审的公开 GitHub 仓库闭环这一条：预览枚举 → 精确授权 → 单次 `allowBuilds` → 安装/生效。

## 范围（最小、可失败）

- 只验证 **root 插件自身 4 个 lifecycle 脚本**在 `github:` shorthand 下的 `allowBuilds` 键与执行。
- **零第三方依赖**；不引入注册表依赖、不引入 `file:`/本地传输、不引入 git 子依赖（受管 pnpm 11.7.0 的 `blockExoticSubdeps` 会以 `ERR_PNPM_EXOTIC_SUBDEP` 受控拒绝，按产品裁决保留默认、不绕过）。
- 漂移对照只做 **hook 集合不变、命令/marker 文本变化**（隔离“文本漂移”与“集合漂移”）。多重集不等已由受控 v2 本地 probe（子集拒绝）与 core 单测覆盖，本 fixture 不重复。
- 无 workflow、无分支保护、不提交 `.npmrc`/`pnpm-workspace.yaml` 等可能携带放行配置的文件。

## 拟发布内容（逐文件精确字节）

建议新公开仓库：`YingkeSu/hdsl-s4-gh-fixture`（编排已确认命名空间；已核当前不存在，新建不覆盖任何仓库；既有 `YingkeSu/hdsl-plugin-e2e-fixture` 保持不动）。

### `package.json`（SHA256 `82a932659f943cee83c35f56f3190d0326cacee06bf95930106bf1dbb602a3c3`）

```json
{
  "name": "hdsl-s4-gh-fixture-root",
  "version": "0.0.1",
  "private": false,
  "type": "module",
  "main": "lib/index.mjs",
  "exports": {
    ".": "./lib/index.mjs",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": [
    "lib/index.mjs",
    "cordis.patch.yml",
    "scripts/mark.mjs"
  ],
  "license": "MIT",
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  },
  "scripts": {
    "preinstall": "node scripts/mark.mjs gh-root-preinstall",
    "install": "node scripts/mark.mjs gh-root-install",
    "postinstall": "node scripts/mark.mjs gh-root-postinstall",
    "prepare": "node scripts/mark.mjs gh-root-prepare"
  }
}
```

### `cordis.patch.yml`（SHA256 `6e0561900d0315602cd2abb1aade7e8d0ba5087e4275d2748b1aaf46c2813fff`）

```yaml
# S4 controlled GitHub fixture: minimal bundle with no service; install-time
# script markers come from package.json scripts, not from this module.
- insert:
    - id: hdsl-s4-gh-fixture-marker
      name: hdsl-s4-gh-fixture-root
```

### `lib/index.mjs`（SHA256 `abed8b134da4420845f8e147ebba8930b1b9847fe0db024d2d66e571679890be`）

```js
// No-op cordis plugin: provides no service, does no work (S4 script axis only).
export const name = 'hdsl-s4-gh-fixture-marker';
export function apply() {}
export default { name, apply };
```

### `scripts/mark.mjs`（SHA256 `62dd040f0e2ca3f354ee42ad302d5c8a581b1cbe089608b0abbce1f46c8ec16c`）

**与受审 v2 fixture 逐字节相同**：只 `node:fs`/`node:path`；缺 `S4_MARKER_DIR` 或参数 ⇒ `exit 3`；否则只写 `<S4_MARKER_DIR>/<name>.marker`；无删除、无越界写、无 `child_process`。

### `README.md`（SHA256 `42320faf9325dc6197b3245c55880c6981db4ba1306526e4610868fd15901a76`）

```markdown
# hdsl-s4-gh-fixture-root

HDSL issue #78 (S4) 的受控测试 fixture。仅用于验证“显式构建授权”在真实 GitHub
`github:` shorthand 下的预览枚举、精确 `allowBuilds` 与安装期脚本执行。

- 四个 lifecycle 脚本只写 `<S4_MARKER_DIR>/gh-root-<hook>.marker`；缺 `S4_MARKER_DIR` 时以
  exit 3 失败（fail closed）。脚本无网络、无子进程、无凭据、无越界写。
- 启动期 `lib/index.mjs` 为 no-op。
- 不得作为生产插件使用；不得在其中放入任何秘密或个人数据。
```

### 身份分层说明

- 包名 = `hdsl-s4-gh-fixture-root`（`package.json.name`，也是 `github:` spec 的包引用）。
- patch 行 `id` = `hdsl-s4-gh-fixture-marker`（profile 内行身份）；patch 行 `name` = 包名。
- `lib/index.mjs` 导出的 `name` = 插件标签 `hdsl-s4-gh-fixture-marker`（与 patch 行身份同层，但不是包引用）。

## 提交矩阵（全部固定 40-hex commit）

- commit 1（`base`）：上述内容（4 hooks，`gh-root-*`）。
- commit 2（`drift-command`）：**仅**把 `postinstall` 命令文本改为 `node scripts/mark.mjs gh-root-postinstall-drift`（同 hook、同版本；`package.json` SHA256 `b573d1dd938f49c92eb04e4633203063743dd58d858b7b98f1be8a7c3b3c29a4`）。
  - 断言：旧授权在 `drift-command` 上 ⇒ `AUTHORIZATION_MISMATCH` 或 `PLUGIN_INTEGRITY_MISMATCH`（由 commit/manifest 摘要漂移检出）；`gh-root-postinstall-drift` marker **不存在**；每阶段前清空 marker 目录，确认无旧名误报；hook 集合必须保持 4 个不变。
- 所有 spec 使用 `github:YingkeSu/hdsl-s4-gh-fixture#<40-hex>`，不用分支/tag 解析。
- 不建分支保护、不放 GitHub Actions。

## 冻结身份（本地快照，未发布）

冻结交付包：`/tmp/s4gh-freeze-snapshot`（只读：`MANIFEST.md` + `root.bundle`），归档 `/tmp/s4gh-freeze-snapshot.tar.gz` SHA256 `fb365aa8da67d1163a29f32ba4c4b39f7001f7de8df98933bbf047e3ff8d44b8`。本地 commit 使用固定身份/时间（`HDSL S4 Fixture <s4-fixture@hdsl.invalid>`，`2026-09-22T00:00:00+00:00`），push bundle 可保留下列 SHA：

| tag | commit | tree |
| --- | --- | --- |
| `base` | `cb265920d7b0d0d5f3616417cd4053176b998f80` | `a35ac522b5b0c221cdb80e8318205377989f3155` |
| `drift` | `a5438460723df91701aca3464af3a0db7f55eaa0` | `8559a66f0960e79443497a5158c72b30f00165f7` |

组合树摘要（精确序列化：按 repo 相对路径字节序升序，逐行 `"<relpath>\t<sha256hex>\n"`，UTF-8 拼接后 SHA-256）：`base` = `b7fbca3a8e7ddafd1772917e11418479e819e95554ffd8f213f1e2b3909813c1`，`drift` = `c48a0790601c841ef5bfd753186895d57b5308ba39b7404108863266b48ed93d`。

## `github:` allowBuilds 键的实证纪律（不得预设形态）

1. 默认拒执行运行（`--ignore-scripts`）中捕获 pinned-lock key（codeload URL）与 pnpm 阻断提示 / depPath 原文，落盘为证据。
2. 用该 depPath **逐字节**构成**单次** `allowBuilds` 键；禁 name-only、禁工作区级/全局 `allowBuilds` 列表、禁 `onlyBuiltDependencies`、禁 `dangerouslyAllowAllBuilds`。
3. `--ignore-scripts=false` + 精确键运行：断言恰好 4 个 `gh-root-*` marker 出现且 `exit 0`。
4. 负控：`--ignore-scripts=false` 但键不精确 ⇒ 仍阻断且 marker=0。
5. 若在冻结 pnpm 11.7.0 上无法构造匹配键 ⇒ 报 **blocked**，不得放宽为全局放行，不得用 `git+file://` 结论替代 GitHub 结论。

## 执行与证据边界

1. 静态审（30/33，只读）：逐文件副作用边界、无网络/凭据/keychain/子进程/越界写、mark.mjs fail-closed 行为；核对本文件逐字内容与 SHA256。
2. 只有审通过后，且整合 owner 明确确认 owner/命名空间后才发布；发布后产不可变 review 快照（bundle + MANIFEST）。
3. 真实受管 Node/pnpm：`preview`（默认拒执行物化，marker=0）→ 精确授权（恰好 4 marker，exit 0）→ `drift-command` 重解析拒绝。
4. desktop 探针使用本地受控传输与 GitHub fixture **分栏记录**；本地 `git+file://` 结论不替代 GitHub 结论，反之亦然。无凭据 GitHub API 限流约 60/h：执行在恢复窗口内一次有界完成，403 即停。
5. 未跑完不得声称生产 GitHub 全链验收。

## 发布后须回报的精确身份

- tag → commit → tree、逐文件 SHA256、仓库 full name（公开、可匿名读）、默认分支、review 出处与 SHA。
- `github:YingkeSu/hdsl-s4-gh-fixture#<commit>` 精确 spec 与 pinned-lock key、实测 `allowBuilds` depPath 的逐字节对照。
- MANIFEST 写明组合摘要的**精确序列化**（分隔符/排序），使第三方可逐字节复算（修正 v2 的非阻断项）。
- 任一字节变化 = 新身份，需重新静态审。

## 需要确认

- owner/命名空间（必须公开、可匿名读，以匹配无凭据生产路径）。
- 是否接受“单仓库两 commit（base / drift-command）”作为最小矩阵。
- 发布授权：本方案获批前**不创建仓库、不 push、不改任何远端**。
