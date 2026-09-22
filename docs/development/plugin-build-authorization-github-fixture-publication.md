# 生产 GitHub 脚本 fixture 发布与实测记录（#78 S4）

本文件是**发布/实测证据追加**，不修改任何已审冻结交付件。冻结提案与逐字字节见
[plugin-build-authorization-github-fixture-proposal.md](plugin-build-authorization-github-fixture-proposal.md)。

- v1 冻结快照 `/tmp/s4gh-freeze-snapshot`（归档 `fb365aa8da67d1163a29f32ba4c4b39f7001f7de8df98933bbf047e3ff8d44b8`）。
- v3 冻结快照 `/tmp/s4gh-freeze3-snapshot`（归档 `fb85355ad9e6787552e7ef9bad1f921fff0a74f5c9598cd452b1d3c911cba80c`）。

## 发布事实（PUBLIC 仓库 `YingkeSu/hdsl-s4-gh-fixture`）

`YingkeSu/hdsl-plugin-e2e-fixture`（S3）未动；无 workflow、无分支保护、无 `.npmrc`/`pnpm-workspace.yaml`/凭据；未 publish npm。

### 当前（v3）

| ref | commit | tree |
| --- | --- | --- |
| `base-v3` | `71f9a972d068cb00ffcfd085f631ff3bc2c23c03` | `42854453ed7088d22738cbf7c534b85e8e6652be` |
| `drift-v3` | `a5d3e7e2597cbe3736bab3abf81148637f74faea` | `642d6519a6b9228f9c136e2f8a3624a2fb9ecc2d` |
| `main`（默认分支，保持不变） | `a5438460723df91701aca3464af3a0db7f55eaa0` | `8559a66f0960e79443497a5158c72b30f00165f7` |

逐文件 SHA256（v3；`drift-v3` 仅 `package.json` 不同）：

| path | base-v3 | drift-v3 |
| --- | --- | --- |
| `package.json` | `82a932659f943cee83c35f56f3190d0326cacee06bf95930106bf1dbb602a3c3` | `b573d1dd938f49c92eb04e4633203063743dd58d858b7b98f1be8a7c3b3c29a4` |
| `cordis.patch.yml` | `6e0561900d0315602cd2abb1aade7e8d0ba5087e4275d2748b1aaf46c2813fff` | 同 |
| `lib/index.mjs` | `abed8b134da4420845f8e147ebba8930b1b9847fe0db024d2d66e571679890be` | 同 |
| `scripts/mark.mjs` | `9d205611d5f7e4df1e5cdbc363cfe06b71ca8ed06462b7707060e10a5698c8da` | 同 |
| `README.md` | `63a67147a32a68152a54e73dc7165287e4a699f6a37d0eccc795db7a9a696050` | 同 |

组合摘要（relpath 升序逐行 `"<relpath>\t<sha256>\n"`，UTF-8，再 SHA-256）：base-v3 `c1d217aca26c262bdf6cc0dec7fe3abee266dfbe8cbd37be967a5685df47ade1`；drift-v3 `c8fe9ddb197e464767c0aa106a5fffc7cfb4fbfa6a39e8bcd05913d77227a6a7`。

精确 spec：`github:YingkeSu/hdsl-s4-gh-fixture#71f9a972d068cb00ffcfd085f631ff3bc2c23c03`（base-v3）、`…#a5d3e7e2597cbe3736bab3abf81148637f74faea`（drift-v3）。所有 spec 固定 40-hex commit。

### v1（旧 source，历史证据；仅作分栏参考）

`base` = `cb265920d7b0d0d5f3616417cd4053176b998f80`、`drift` = `a5438460723df91701aca3464af3a0db7f55eaa0`，`README.md` = `42320faf…`，`scripts/mark.mjs` = `62dd040f…`（要求显式 `S4_MARKER_DIR`，缺则 exit 3，**不适用于真实 production executor**）。该身份的 13/13 key probe 只绑定 `cb265920…`。

## 独立静态审（发布前）

| 版本 | 审阅 | 范围 | 结论 |
| --- | --- | --- | --- |
| v1 | 30 / 33 | 副作用 + 身份 + marker 可观测性 | APPROVED |
| v3 | 30 | README 差异 + 身份链 | APPROVED（归档 `fb85355a…`） |
| v3 | 33 | 身份/hash/远端 | APPROVED（`71f9a972`/`a5d3e7e2`） |

## `github:` allowBuilds 键实测（v3，已完成）

由 runtime 子任务在冻结受管 pnpm 11.7.0 + 受管 Node 上执行**单次有界** probe（`scripts/research/a4-github-key-probe.mjs`，opt-in，不进默认 CI），受审 `base-v3`，**14/14 PASS**。关键：probe **不注入** `S4_MARKER_DIR`，marker 路径为既有 `$TMPDIR/hdsl-s4-fixture-markers`，与生产 desktop 的解析路径一致。

- default deny：`install --ignore-scripts` exit 0，markers=0。
- 无 allow 时 `--ignore-scripts=false`：阻断（exit≠0）、markers=0；从 pnpm 提示取回精确 depPath。
- **pinned-lock key 与 depPath 逐字节相同**（`keyEqualsLock=true`）。
- 用该 depPath 逐字节构造单次 `allowBuilds`：exit 0，**恰好 4 个 `gh-root-*` marker**（preinstall/install/postinstall/prepare）。
- 负控：name-only 错 key ⇒ 阻断、markers=0；**base-v3 key 套 drift-v3** ⇒ 阻断、markers=0（源码断言：`BASE_COMMIT=71f9a972…`、`DRIFT_COMMIT=a5d3e7e2…`，漂移段用 base-v3 depPath 套 drift-v3）。
- 未放宽 `blockExoticSubdeps`；未用工作区级/全局 `allowBuilds` 列表、`onlyBuiltDependencies`、`dangerouslyAllowAllBuilds`。

**结论**：生产 `github:` shorthand 的 `allowBuilds` depPath == pinned-lock key（codeload tarball 形态）。本地 `git+file://` 结论与之分栏。

### exact allowBuilds key（v3）

```text
hdsl-s4-gh-fixture-root@https://codeload.github.com/YingkeSu/hdsl-s4-gh-fixture/tar.gz/71f9a972d068cb00ffcfd085f631ff3bc2c23c03
```

生产清理边界：probe 结束时其临时 workspace 被移除，**这是 probe 自身的清理，不等价于生产保证**。生产端口的“授权只在单次安装期间存在、发布前声明/config 无持久授权”由默认 CI 的 `tests/plugins/apply-authorization.test.ts` 与 `tests/core/change-apply-authorized.test.ts` 单独断言（发布前 `pnpm-workspace.yaml` 不存在）。

## 真实 production desktop 链（opt-in，独立 QA）

由独立 QA 子任务在**真实 production Electron + bridge** 上执行，绑定代码 `e80fe5585f0733661ec74e06bd34d81c687eb5fe` 与 fixture `base-v3 71f9a972d068cb00ffcfd085f631ff3bc2c23c03`，**PASS**：

- 方法：自有 dataRoot；marker **仅观测** `<env home>/.tmp/hdsl-s4-fixture-markers/`，**未注入** `S4_MARKER_DIR`，未改生产 env/IPC；无 start/keychain；网络未 403。
- 预览（UI）：精确 commit `71f9a972…`；包 `hdsl-s4-gh-fixture-root@0.0.1`；manifest 摘要 `82a93265…`；脚本评估 `detected`，已枚举 4 个 root hook；执行器 `pnpm@11.7.0`；无沙箱警示包含“且不受 DSH 或 HDSL 沙箱保护”与“未授权时默认拒绝执行”；授权 checkbox 未勾选时“确认并授权安装”**disabled**。
- 拒绝（未授权）：UI 按钮 disabled；API `changes.apply` 无 `buildAuthorization` ⇒ `BUILD_NOT_AUTHORIZED`；组成/修订不变。marker 采样：授权 apply 之前清空后，经 preview 与未授权 apply，采样到 0 marker（`markersAfterRefusal=[]`）。
- 显式授权：勾选后点击安装 ⇒“安装已提交：新代际 …”；markers **恰好 4 个**（`gh-root-preinstall/install/postinstall/prepare`）；`composition.lock` 含该插件；profile `pnpm-workspace.yaml`/`package.json` **无 `allowBuilds`/`onlyBuiltDependencies`**（授权配置不持久化）。
- 精确范围（30 复核）：上一条指 **workspace 配置**；已发布代际的 `profile/node_modules/.modules.yaml` 保留 pnpm 自身 install-state 的 `allowBuilds`（一个精确键），属安装态而非 HDSL 授权载体，新代际不继承；其是否构成后续放行门未独立 probe，按记录不按“磁盘无任何 allowBuilds 字节”表述。
- 漂移 + 旧授权（**API 级，如实分栏**：UI 不保留旧 plan）：以旧 base-v3 授权（`{commitSha:71f9a972…, scripts: base4}`）对 drift-v3 计划（`commit a5d3e7e2…`）调 `changes.apply` ⇒ `AUTHORIZATION_MISMATCH`（**执行前拒绝**，未创建操作）。
  - marker 采样边界：**未在漂移前后做受控清空/对照**，因此只能证明“**未出现新的 `gh-root-postinstall-drift.marker`**且原 4 文件仍在”，**不得**据此声称“原 4 hook 在 drift 上零执行”；“执行前拒绝”由上述 API 守卫证据支持。
  - 旁证（非受控对照）：4 个 marker 的 mtime 与授权 apply 操作 `updatedAt` 一致，早于 drift preview，与“未被重写”一致。

未覆盖：drift 旧授权的 **UI 跨 preview** 覆盖不可行，故该条为 API 级证据（不伪称界面覆盖）；未执行 start。

## 边界

- 桌面正控的 marker 证据必须来自真实 `apply`（显式授权）对 `<env home>/.tmp/hdsl-s4-fixture-markers/` 的观察；`preview` 以 `--ignore-scripts` 运行，**不产生 marker**（无 marker 属代码预期，不等于 QA 执行观测）。显式 `S4_MARKER_DIR` 仅限独立 opt-in probe，桌面不注入额外 env。
- 本地 `git+file://` 结论与 GitHub 结论分栏，互不替代。
- 任一冻结字节变化 = 新身份，需重新静态审。
- 真实 desktop 与生产 GitHub 全链的端到端验收仍以实际证据为准；未跑完不得声称通过。
