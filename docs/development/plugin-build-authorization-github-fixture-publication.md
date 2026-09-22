# 生产 GitHub 脚本 fixture 发布与实测记录（#78 S4）

本文件是**发布/实测证据追加**，不修改已审冻结交付件。冻结提案与逐字字节见
[plugin-build-authorization-github-fixture-proposal.md](plugin-build-authorization-github-fixture-proposal.md)
（approved 版本 @ `2b2ca71`，doc SHA256 `b924d6ef7514fcb100d7c0c3a453a23d3bacc7911fcb09b0212027d24559a141`）；
冻结快照 `/tmp/s4gh-freeze-snapshot`（归档 SHA256 `fb365aa8da67d1163a29f32ba4c4b39f7001f7de8df98933bbf047e3ff8d44b8`）**保持不动**。

## 独立静态审（发布前）

| 审阅 | 范围 | 结论 | 出处摘要 |
| --- | --- | --- | --- |
| 30 | 脚本副作用 + 逐字字节 + 身份 | APPROVED | `/tmp/hdsl-s4-gh-fixture-freeze-review.md` |
| 33 | 文件清单/摘要/身份/marker 可观测性 | APPROVED | 绑定 doc `2b2ca71` 与快照归档 `fb365aa8…`；从 `root.bundle` 独立导入复算 |

## 发布事实（PUBLIC）

- full name：`YingkeSu/hdsl-s4-gh-fixture`（新建；发布前去重确认此前不存在；`YingkeSu/hdsl-plugin-e2e-fixture` 未动）
- 远端 refs（`git ls-remote` 实测）：

| ref | commit | tree |
| --- | --- | --- |
| `base` | `cb265920d7b0d0d5f3616417cd4053176b998f80` | `a35ac522b5b0c221cdb80e8318205377989f3155` |
| `drift` | `a5438460723df91701aca3464af3a0db7f55eaa0` | `8559a66f0960e79443497a5158c72b30f00165f7` |
| `main`（默认分支） | `a5438460723df91701aca3464af3a0db7f55eaa0` | `8559a66f0960e79443497a5158c72b30f00165f7` |

- 远端逐文件 SHA256（与冻结交付一致）：

| path | base | drift |
| --- | --- | --- |
| `package.json` | `82a932659f943cee83c35f56f3190d0326cacee06bf95930106bf1dbb602a3c3` | `b573d1dd938f49c92eb04e4633203063743dd58d858b7b98f1be8a7c3b3c29a4` |
| `cordis.patch.yml` | `6e0561900d0315602cd2abb1aade7e8d0ba5087e4275d2748b1aaf46c2813fff` | 同 |
| `lib/index.mjs` | `abed8b134da4420845f8e147ebba8930b1b9847fe0db024d2d66e571679890be` | 同 |
| `scripts/mark.mjs` | `62dd040f0e2ca3f354ee42ad302d5c8a581b1cbe089608b0abbce1f46c8ec16c` | 同 |
| `README.md` | `42320faf9325dc6197b3245c55880c6981db4ba1306526e4610868fd15901a76` | 同 |

- 精确 spec：`github:YingkeSu/hdsl-s4-gh-fixture#cb265920d7b0d0d5f3616417cd4053176b998f80`（base）、
  `github:YingkeSu/hdsl-s4-gh-fixture#a5438460723df91701aca3464af3a0db7f55eaa0`（drift）。
- 无 workflow、无分支保护、无 `.npmrc`/`pnpm-workspace.yaml`/凭据；未 publish npm。

## `github:` allowBuilds 键实测（已完成）

由 runtime 子任务在冻结受管 pnpm 11.7.0 + 受管 Node 上执行**单次有界** probe（`scripts/research/a4-github-key-probe.mjs`，opt-in，不进默认 CI），受审 PUBLIC fixture `YingkeSu/hdsl-s4-gh-fixture@base cb265920d7b0d0d5f3616417cd4053176b998f80`，**13/13 PASS**：

- default deny：`install --ignore-scripts` exit 0，markers=0。
- 阻断提示 depPath 原文：`hdsl-s4-gh-fixture-root@https://codeload.github.com/YingkeSu/hdsl-s4-gh-fixture/tar.gz/cb265920d7b0d0d5f3616417cd4053176b998f80`。
- **pinned-lock key 与 depPath 逐字节相同**（`keyEqualsLock=true`）。
- 无 allow 时 `--ignore-scripts=false`：`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` exit 1，markers=0。
- 用该 depPath 逐字节构造单次 `allowBuilds`：exit 0，**恰好 4 个 `gh-root-*` marker**（preinstall/install/postinstall/prepare），无多余。
- 负控：name-only 错 key ⇒ 阻断 exit 1、markers=0；用 base key 套 drift commit（`a5438460…`）⇒ 阻断 exit 1、markers=0。
- 未放宽 `blockExoticSubdeps`；未用工作区级/全局 `allowBuilds` 列表、`onlyBuiltDependencies`、`dangerouslyAllowAllBuilds`。probe 结束时其临时 workspace 被移除（**这是 probe 自身的清理，不等价于生产保证**）；生产端口的“授权只在单次安装期间存在、发布前声明/config 无持久授权”由默认 CI 的 `tests/plugins/apply-authorization.test.ts` 与 `tests/core/change-apply-authorized.test.ts` 单独断言（发布前 `pnpm-workspace.yaml` 不存在）。

**结论**：生产 `github:` shorthand 的 `allowBuilds` depPath == pinned-lock key（codeload tarball 形态），可作为最终 exact key；本地 `git+file://` 结论与之分栏。

### exact key（最终 MANIFEST）

```text
hdsl-s4-gh-fixture-root@https://codeload.github.com/YingkeSu/hdsl-s4-gh-fixture/tar.gz/cb265920d7b0d0d5f3616417cd4053176b998f80
```

非阻塞：默认分支 `main` 指向 `drift`（`a5438460…`），与冻结批准一致；该 probe 只针对 `base` 的 deny/allow，drift 由负控（base key 套 drift commit 应阻断）覆盖。

## 边界

- 本地 `git+file://` 结论与 GitHub 结论分栏，互不替代。
- 任一冻结字节变化 = 新身份，需重新静态审。
- 真实 desktop 与生产 GitHub 全链的端到端验收仍以实际证据为准；未跑完不得声称通过。
