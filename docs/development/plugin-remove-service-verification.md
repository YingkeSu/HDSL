# 服务核验记录：`hdsl-plugin-e2e-fixture` @ `e7825788`（known empty providers）

状态：**confirmed（独立核验通过）**｜关联：ADR 0005 D21、`specs/002-plugin-transactions/spec.md`（S3）、#77。
本文件是**可持久复核**的仓库内验证记录；catalog 证据（`packages/runtime/catalog/service-verifications/hdsl-plugin-e2e-fixture.json`）指向本文件。

## 绑定（更换 commit/manifest 或任一文件即失效 → unknown）

| 项 | 值 |
| --- | --- |
| repository | `YingkeSu/hdsl-plugin-e2e-fixture` |
| commitSha（精确源码） | `e7825788cce5e056a0eee6c1ff1ffbbf7c1c8838` |
| manifest `package.json` SHA-256 | `ee613a2eb425a24bc44e946d84e36b7ceb2f594f1214913ff34dd0d0e450ba5c` |
| tree SHA-256 | `a0336c83accebb1430d2f95f8bb12c8c7f5da808221765854547fc46296ebc2e` |
| tree 摘要算法 | 对 `(relpath, fileSha256)` 排序后拼接再做 SHA-256（**仅此算法**；勿与其它 tree 算法混用） |
| provides | `[]`（**known empty**） |

逐文件 SHA-256（与该 commit 逐字节对应）：

| path | SHA-256 |
| --- | --- |
| `README.md` | `9c59037693e2e7de28a102c5b32b073cf5a6b3f8635895f992df5bec3689c0c7` |
| `cordis.patch.yml` | `6bb83e39e6fe843fc61dda6520d52262c453393856585e461b06eb7ada918211` |
| `lib/index.mjs` | `a8cf6175a2ebcf9fc6538704c3b68de697012476c4b8f9446b49a902d8579263` |
| `package.json` | `ee613a2eb425a24bc44e946d84e36b7ceb2f594f1214913ff34dd0d0e450ba5c` |
| `pnpm-lock.yaml` | `17c814b167307942d3609c7b9d916ceddb85839573ab39baa114e30edb132a1a` |

精确源码 permalink（复核入口）：

- tree：<https://github.com/YingkeSu/hdsl-plugin-e2e-fixture/tree/e7825788cce5e056a0eee6c1ff1ffbbf7c1c8838>
- 关键文件：<https://github.com/YingkeSu/hdsl-plugin-e2e-fixture/blob/e7825788cce5e056a0eee6c1ff1ffbbf7c1c8838/lib/index.mjs>、<https://github.com/YingkeSu/hdsl-plugin-e2e-fixture/blob/e7825788cce5e056a0eee6c1ff1ffbbf7c1c8838/cordis.patch.yml>、<https://github.com/YingkeSu/hdsl-plugin-e2e-fixture/blob/e7825788cce5e056a0eee6c1ff1ffbbf7c1c8838/package.json>

## 审查范围与结论（独立核验，hdsl-33）

- 方式：一次性有界获取该精确公开 commit 的归档（codeload tar.gz，HTTP200，1876B）到临时目录；**未执行 fixture**、无模型、无凭据、无仓库改动、无 claim/PR。
- 审查的**完整小源码**（5 个文件，无隐藏文件/符号链接）结论：
  - `lib/index.mjs` 仅导出 `name` / `apply` / `default`；**无** Service 类、`provide`/`ctx`/`inject`/`.set(` 等注册或占用服务的构造；`apply()` 无参数（无 `ctx`），其函数体仅 `DSH_HOME` 守卫 + marker 写入；无动态 `import()`/`require`/`eval`/`new Function`；仅 `node:fs`/`node:path`，无网络/socket/`child_process`，除 `DSH_HOME` 外无 `process.env` 访问；零第三方依赖（无 `dependencies`、无 `scripts`，lock 为空闭包）。
  - `cordis.patch.yml` 仅一条 insert（`id: hdsl-e2e-marker`，`name: hdsl-plugin-e2e-fixture`），无 `provide`/`service`/`inject` 声明。
- 结论：**known empty providers** —— 该 commit 不注册/提供任何 Cordis 服务。
- 审查报告：`/tmp/qa33/fixture-cordis-review-e7825788.md`（QA 侧一次性产物；本文件是其持久化、可复核的仓库内记录）。

## 边界（不得外推）

- **仅对该精确 commit 有效**：换 commit、换任一文件或 manifest 摘要不匹配 ⇒ 记录失效，判定回落为 **unknown 阻塞**（ADR 0005 D21）。
- **不是任意插件的安全保证**：“`apply()` 无参数”是本 fixture 的**完整小源码审查**结论，**不得**泛化为“任何 JS 都无法注册服务”。对其它插件，服务提供方仍须逐插件核验（显式声明 + 独立核验记录）。
- 本记录**未**执行 fixture、**未**证明运行期加载/服务解析行为；运行期生效仍以「活动代际记录 + 受管 DSH 离线解析组合树」与真实重启验收为准。
- 本记录**不**构成运行时沙箱/隔离承诺（ADR 0005 D21 语义：仅 HDSL 卸载分析的声明/核验范围）。
