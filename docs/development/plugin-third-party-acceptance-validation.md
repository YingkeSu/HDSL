# 真实第三方 DSH 插件 macOS 安装、启停与卸载验收（#98）

状态（分栏，勿混读）：

- **历史 P0 通过（仅存档）**：`17556e74076bfe583028aee547291d7cfbe14296` 工作树曾通过一次（1 passed / 140.84s）。当时测试文件是**未提交的工作树工件**（不在 `17556e7` 提交内），`create` 走旧直连 `service.createEnvironment(...)` 路径，branch-only。**不得**外推到任何后续 head。
- **修复前失败（已定位）**：测试执行版本 `e83c95cccf5ed6c3e3562ed90bdd67372bf0356f` 的真实链在 merge 树 `47adeff`（`origin/main 9585c62` + `e83c95c`）**两次失败**于第 1 阶段 preview `INTERNAL_ERROR`（见 §1.2/§3.7 与 [#141](https://github.com/YingkeSu/HDSL/issues/141)）。
- **组合验证树 PASS**：产品 `4f1841b9ae9f1f6d9070054a819eac26e97b2b70`（#141 固定 commit 官方 codeload transport 修复）+ 更新后 QA（sha256 `fa803406…`）→ **3 passed / 149.54s**（§1.3）。该修复已并入 main（PR #142，merge `2e855946e5679bfe8bd177ba2f0f352b58393d07`）。
- **当前正式 head 证据**：测试执行版本 `ac435300fa9dab616b8945570923943f1ad1c4f8`（本 PR 分支合并新 main `2e85594` 后）→ **3 passed / 96.45s**（§1.4、§3.8、§5.2）。本文档为随后 docs 提交，不改变该测试执行版本。

本记录只对下方注明的 SHA、候选 pin、平台与测试条件有效；未测项保持未测。

## 0. 范围与定位

- HDSL = DSH 启动器 + 版本管理器；**运行期行为与影响交给 DSH**。本验收只证明“启动器能否管理一个真实、来源锁定的第三方 DSH 插件”，不证明插件安全、不承诺无损卸载、不做静态服务依赖证明。
- 本验收取代旧验收中的“服务依赖未知时保留卸载阻断”（ADR 0005 D21 known/unknown 门禁已由 [#112](https://github.com/YingkeSu/HDSL/issues/112) supersede）。保留：来源/摘要/许可核验、安装期显式构建授权（#78）、凭据与秘密边界、精确版本 pin。
- 运行期相位 ACTIVE/ACK 无 launcher 侧公开路径（E1b [#116](https://github.com/YingkeSu/HDSL/issues/116) 的确认切片为 no-go，见 [#129](https://github.com/YingkeSu/HDSL/issues/129)）；本记录不冒充 HDSL 运行期集合，也不新增私有观测 bridge。
- `hasCustomTag` 门禁缺口按 [#107](https://github.com/YingkeSu/HDSL/pull/110) 登记为 deferred：本验收不改代码、不降门槛、不合并该 PR。

## 1. 基线与环境（分栏）

### 1.1 历史实测运行（本记录 §2–§9 全部结果的来源）

| 项 | 值 |
| --- | --- |
| 历史实测工作树 HEAD | `17556e74076bfe583028aee547291d7cfbe14296` |
| 测试工件身份 | `tests/integration/plugins/third-party-plugin.real.test.ts` 当时是**未提交的工作树工件**（`17556e7` 提交内不存在该文件；后由 `d5939eb` 提交）。**不得**把这次运行当作 `17556e7` 提交内已有测试的结果 |
| create 路径 | 旧路径：测试直连 `managed.service.createEnvironment(...)`，**未**经生产 dispatcher 平台门 |
| 平台 | macOS 26.3（build 25D125）arm64，branch-only |
| 受管组合 | Node `22.19.0` + DSH `0.1.5-rc.2`（`VERIFIED_COMBINATIONS`，catalog revision `t004-2026-09-20.1`） |
| 受管执行器 | pnpm `11.7.0`（`PNPM_EXECUTOR_SPEC`：sha256 `deafa7ec98a1218b6a047289b92fbe2395c1e22d3495bb711653013218ee15ee`） |
| 测试入口 | `tests/integration/plugins/third-party-plugin.real.test.ts`（opt-in） |
| 实测命令 | `HDSL_REAL_THIRD_PARTY_PLUGIN=1 HDSL_98_EVIDENCE_FILE=<path> pnpm exec vitest run tests/integration/plugins/third-party-plugin.real.test.ts` |
| 实测结果 | **1 passed / 1 file（140.84s）** |

### 1.2 修复前失败（`e83c95c` / merge `47adeff`，与 §1.1 不是同一 head）

| 项 | 值 |
| --- | --- |
| 测试执行版本（含本 PR 测试代码修复） | `e83c95cccf5ed6c3e3562ed90bdd67372bf0356f`（本文档为随后 docs-only 更新，不改变该测试执行版本） |
| 目标组合选法 | 按 **Node `22.19.0` + DSH `0.1.5-rc.2` 两个轴**显式选取，不依赖 catalog 顺序；与 main 的 API `1.2` / catalog `a2-tier2-2026-09-24.1`（#138 / #140）新增的 A2 Tier 2 DSH `0.1.7-rc.1` 共存 |
| 平台门 | 真实 lane 仅 `darwin`+`arm64` 运行；其他平台由默认套件负控断言生产 dispatcher 在**任何下载/安装副作用之前**以 `UNSUPPORTED_COMBINATION` 拒绝 |
| branch-only 真实链 | **无 PASS 记录**（未执行） |
| 实际失败 merge 树 | `47adeff` = `origin/main 9585c62` + `e83c95c` |
| merge 树真实链结果 | **2 次失败**，均在第 1 阶段 preview：`INTERNAL_ERROR`（223s / 246s）；见 §3.7 |

### 1.3 组合验证树 PASS（#141 修复 + 更新后 QA）

| 项 | 值 |
| --- | --- |
| 产品（修复）SHA | `4f1841b9ae9f1f6d9070054a819eac26e97b2b70`（#141 transport 修复；已并入 main `2e85594`） |
| QA 测试工件（未提交进修复 PR #142） | `tests/integration/plugins/third-party-plugin.real.test.ts` sha256 `fa80340684a9b046deec8396e9443a4fc706dcc4b4a05370aa7dab0d266d8cbc` |
| 变更 | 发布 profile 声明断言由 `github:<owner>/<name>#<commit>` **替换并加强**为同 commit codeload URL，并加 `gitHosted: true`/`integrity:`/无 `github:` 前缀校验；同时保留 manifest/patch/entry 摘要、无 `allowBuilds`、无脚本授权、移除与重启断言 |
| 结果 | **3 passed（1 file）/ 149.54s** |

### 1.4 当前正式 head 证据

| 项 | 值 |
| --- | --- |
| 测试执行版本（本 PR 分支合并新 main 后） | `ac435300fa9dab616b8945570923943f1ad1c4f8`（merge `1145801`，main `2e85594`） |
| 结果 | **3 passed（1 file）/ 96.45s**；机器可读证据见 §5.2 |

受管安装使用真实网络下载固定 Node/DSH 产物与 DSH 依赖闭包（`npm ci`），不重用宿主 npm 缓存；数据根、HOME、DSH_HOME、TMPDIR 全部在一次性临时目录内，DSH 进程环境由生产 `createProcessManager` 显式白名单化（HOME/DSH_HOME/DSH_AGENTS_HOME/PATH/TMPDIR + `DSH_TELEMETRY_DISABLED=1`/`NODE_NO_WARNINGS=1`），不继承宿主 `AO_*`/令牌类变量。

## 2. 固定候选与来源锁定

主候选固定为 `Hisn00w/ASu-skills` 精确 commit `feb77307b45e9c4a9890e385748eebe5a919eb1b`，不得替换；来源漂移 fail-closed。

| 项 | 值（来源：issue #98 阶段 1 / 独立复核 / 本次实测） |
| --- | --- |
| 查询日期 | 2026-09-23 |
| stars（查询日） | 5,031（严格 >5,000；stars 只是筛选条件，不是安全或兼容背书） |
| 许可 | MIT（仓库 API、`LICENSE`、根清单一致） |
| 精确 commit | `feb77307b45e9c4a9890e385748eebe5a919eb1b` |
| 根清单 sha256 | `3f97ad14125d544069a4d8f75cf8c233f34679077e0722cc620878e75088c7e2` |
| `cordis.patch.yml` sha256 | `d05da6d7fea17a111a59c986e301d3c7d470940f0c6da304a801c0f6bf3b3d56` |
| `lib/index.js` sha256 | `7ac439fd9c048f4c1ef7a9f5aa70c44e08950f4a433b16ce2cf958703965a45a` |
| codeload 归档 sha256 | `a864cf2786c5e05408e6ce76195b6cb19a2be9fa24490617d220f1451325a663`（11,765,640 B；阶段 1 取回并独立复核，本次未重复下载） |
| DSH 入口 | 根清单 `dsh.bundle.patch = ./cordis.patch.yml`；`main = ./lib/index.js` |
| install-time 脚本 | 空（无 `preinstall`/`install`/`postinstall`/`prepare`）；无 `dependencies`/`peerDependencies` |
| bundle 行 | 1 条 `insert`：`id: asu-skill-filesystem`、`name: @deepseek-ai/dsh-skill-filesystem` |

产品门禁在预览中按精确 commit 重新解析：实测 `sourceLock.commitSha`、`packageName=asu-skills`、`packageVersion=0.4.0`、`manifestSha256` 全部命中 pin；安装后发布 profile 内 `node_modules/asu-skills/package.json`、`cordis.patch.yml`、`lib/index.js` 的 sha256 也逐字节命中上表。任何摘要不符即安装库层的 `PLUGIN_INTEGRITY_MISMATCH`/`PLAN_STALE`，测试会失败而非继续。

## 3. 阶段实测结果（**历史运行**：`17556e7` 工作树 / 旧直连 create 路径 / branch-only）

> §3.1–§3.6 的全部结果来自 **§1.1 的历史实测运行**（工作树 `17556e7`，测试为当时未提交的工作树工件，create 走旧直连 `service.createEnvironment` 路径，branch-only）。它们**不适用于**测试执行版本 `e83c95c` 或 merge 树 `47adeff`；当前头/merge 的真实链结果见 §3.7。

### 3.1 预览

- 命令走生产 `ChangePreviewService.previewChange` + 真实 GitHub `GitProvider` + `createResolvingPreviewPort`。
- 结果：`succeeded`。`scriptAssessment = none-detected`；`scripts = []`；**`requiresBuildAuthorization = false`**。
- `planInputsDigest = 3b4d4d00efb01e8a787c86589b993dc9a630d9d7c6ee31134b22c756f03e316c`。
- 该候选仓库无锁文件，计划里的 `closureLockSha256` 是**已解析的目标 profile 锁**摘要（`814c631376f25727dad6ea0e6c40e8fddacf256b5b37e7b120eee34dee8cda37`），不是源仓库锁。
- 计划 `riskItems`（逐字）：
  1. `dependency and bundle changes take effect only after the environment is restarted (DSH has no watcher for this layer)`
  2. `no install-time scripts declared in the parsed manifest; the dependency closure was not enumerated`

### 3.2 安装（不请求、不写构建授权）

- `ChangeApplyService.applyChange` + `buildAuthorization: null`，结果 `succeeded`，从基线代提交到**新活动代**（`gen-9fecd19c745643dc` → `gen-43f3035a81dd43c2`）。
- 发布 profile 的 `package.json` 只加了精确 git 依赖 `github:Hisn00w/ASu-skills#feb7730…`，并把 `asu-skills` 追加进 `dsh.profile.bundles`；声明内**没有** `allowBuilds`/`onlyBuiltDependencies`。安装走受管 pnpm 默认拒执行（`--ignore-scripts`）。
- 显式构建授权（#78）未请求、未写入；预设的“需要授权即停止并记录”分支未触发。

### 3.3 DSH 加载与停止

- 受管进程以生成代 profile `--profile hdsl-<gen> --no-open --host 127.0.0.1 --port 0` 启动，`startEnvironment` 操作 `succeeded`（ready）。运行记录 `state=running`。
- 停止走有界退出：`stopEnvironment` `succeeded`，运行记录不再 `running`；无遗留受管进程。

### 3.4 加载期 `!!js` 观测（如实记录：**未直接观测到求值结果**）

ASu 的 `cordis.patch.yml` 含全包唯一一条加载期 `!!js`：

```yaml
bundledSkillDir: !!js process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:path').dirname(process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('asu-skills/package.json')), 'skills')
```

机制（阶段 2 只读审计 `ASU-EXEC-PATH-AUDIT.md` / `CORDIS-LIFECYCLE-RESEARCH.md` 已静态闭合，本次不重跑候选代码）：`@deepseek-ai/dsh-app-boot` 用注册了 `tag:yaml.org,2002:js` 的 schema 解析 bundle patch；`@deepseek-ai/cordis-plugin-loader` 的 `interpolate` 用 `new Function('ctx','expr','with (ctx) { return eval(expr) }')` 求值。这条表达式只做模块解析 + 路径计算，无网络、无写、无子进程。

本次实测到的证据与边界：

| 观测项 | 结果 | 性质 |
| --- | --- | --- |
| `--dump-config`（离线、不 boot）组合出该行 | 通过：输出含 `asu-skill-filesystem`、`@deepseek-ai/dsh-skill-filesystem`、`bundledSkillDir`、`!!js` | **期望组成**；证明 DSH 自己的 YAML 方言把 `!!js` 解析为表达式节点；**不等于求值** |
| DSH boot 到 ready 且 bundle 处于活动代 | 通过 | 与“求值成功”和“仅该行失败但 boot 仍 ready”都相容，**不能单独判定** |
| 表达式目标路径存在 | `<profile>/node_modules/asu-skills/skills/` 存在且为目录（含 9 个技能目录） | 证明解析 `asu-skills/package.json` 所需包与 `skills/` 在本次安装树内 |
| 运行进程打开文件探针 `lsof -p <pid>` | `lsof_mentions_asu_skills = false` | 外部**未**观测到 `dsh-skill-filesystem` watcher 对 `skills/` 的持有；chokidar/fsevents 不保证暴露 fd，故此值既不能证明也不能否证 provider 已挂载 |
| DSH 宿主日志 | 不可得：宿主 cordis `LoggerService` 在本组合下只写内部缓冲，无 console/file exporter | 无法用 stderr 文本判定该行失败 |

**结论（不臆造成功）**：本次验收**没有**直接观测到该 `!!js` 的求值值，也没有捕获到该行的错误文本。可得的是“组成可解析 + 目标路径存在 + boot 到 ready + 无致命加载失败”。`!!js` 求值的直接确认需要 DSH 运行期相位面，而该面在 launcher 侧无公开路径（#129 no-go）；本记录不把它记为通过，也不伪造“已求值”。这是与 issue 明确要求“失败即失败”一致的诚实缺口。

相关的门禁缺口：`patch-references.ts` 的 `hasCustomTag()` 排除 `tag:yaml.org,2002:` 前缀，因此这条运行时唯一会 `eval` 的 tag 在扫描结果里 `unknown=[]`、不阻塞（#107 / PR #110，deferred，本验收不改）。

### 3.5 B1 包路径移除

- 走生产 `previewChange(action: remove)` + `ChangeApplyService.applyChange`（`removalPort = createPluginRemovalPort`，只对 profile 依赖 + `dsh.profile.bundles` 做声明式增删，restart 语义）。
- 移除预览 `succeeded`：`blockingReferences = []`（**不是**“已证明无害”，而是 #112 后 unknown 不再阻断）；`removals` 非空。
- 移除 apply `succeeded`，提交**新活动代**（`gen-43f3035a81dd43c2` → `gen-1415d35e879541d0`）。
- 新活动代锁不再列出该插件，`pluginSources` 不再绑定该包；新发布 profile 的 `dependencies`/`dsh.profile.bundles` 不含 `asu-skills`。
- 移除计划 `riskItems`（逐字）：
  1. `dependency and bundle changes take effect only after the environment is restarted (DSH has no watcher for this layer)`
  2. `service-level coupling (another layer injecting a Cordis service provided by the removed plugin) is not decidable from patch files; no static reference does not prove the removal is free of impact`
  3. `informational: service dependencies for this plugin are not verified by an HDSL review record (unknown is not a removal blocker; policy superseded by #112)`

### 3.6 移除后的 DSH 行为与残留

- 重启移除代到 ready：`succeeded`。
- 移除代离线 `--dump-config` 不再含 `asu-skills`：通过（**期望组成**口径）。
- 移除代发布 profile 的 `node_modules/asu-skills`：**不存在**（`removed_profile_package_node_modules_present = false`，pnpm 按剪枝后的声明/锁收敛）。
- 边界：本记录不做静态服务依赖证明、不承诺无损卸载、不伪造 `known-empty`；服务耦合轴按上面的 informational risk 记录。旧代目录/旧发布 profile 的保留策略未在本轮单独测量（未测），不作为“已无损”证据。

### 3.7 修复前失败（`e83c95c` / merge `47adeff`，已定位）

测试执行版本 `e83c95c` 的真实 opt-in 链中（**修复前**），`create` 与受管安装 `succeeded`，但第 1 阶段 **preview 失败**：

- 实际执行树：`47adeff` = `origin/main 9585c62` + `e83c95c`（两次运行均在此 merge 树；**本 head 未做 branch-only 真实链运行**）。
- 失败 #1：223s；失败 #2：246s。均为 `kind=preview, status=failed, error.code=INTERNAL_ERROR, message="unclassified internal error"`（operation snapshot 按 `packages/contracts/src/errors.ts` 脱敏，底层消息不可见）。
- 有界定位（隔离 `/tmp`，非重跑全链）：pin 的 GitHub commit / `contents` 请求 `200` 且 `package.json` sha256 命中 pin；`PNPM_EXECUTOR_SPEC` 的 tgz 与 entry 摘要命中；冻结 pnpm@11.7.0 纯 registry 解析 `<45s` 成功；而 pin 的 `github:Hisn00w/ASu-skills#feb7730…` 依赖在 `install --lockfile-only --ignore-scripts` 下停滞 `>200s` 且无 lockfile。生产 `packages/runtime/src/plugins/target-profile.ts` 的 `TARGET_PROFILE_RESOLUTION_TIMEOUT_MS = 180_000` 超时/非零 → `INTERNAL_ERROR`，与该停滞时长一致。
- **归属未定**：不认为已证明产品回归、网络故障或 pnpm 上游缺陷；具体未知=停滞发生在 pnpm 的哪个内部请求。详见诊断 issue [#141](https://github.com/YingkeSu/HDSL/issues/141) 与 PR #136 评论 `5799581978`。
- 旧的 `1 passed / 140.84s` 属于 §1.1 历史运行，**不得外推**到 `e83c95c` / `47adeff`。

### 3.8 修复后结果：组合验证树与当前正式 head（均 PASS）

- #141 修复（固定 commit 官方 codeload transport）并入 main（merge `2e85594`）后：
  - **组合验证树**（产品 `4f1841b` + QA sha256 `fa803406…`）：`3 passed / 149.54s`。
  - **当前正式 head**（测试执行版本 `ac43530`，merge main `2e85594`）：`3 passed / 96.45s`。
- 两次均完整通过 install → preview → apply → start/ready → stop → B1 移除 → restart；关键证据见 §5.2：`scriptAssessment=none-detected`、`requiresBuildAuthorization=false`、发布 profile 声明为精确同 commit codeload URL、发布 `pnpm-lock.yaml` 含 `gitHosted: true` 与 `integrity`、`removed_profile_package_node_modules_present=false`。
- 边界不变：`!!js` 求值仍未直接观测（§3.4）；unknown 服务仍仅作 risk；本结果只对注明的执行树/pin 有效。

## 4. install-time 与 load-time 的执行边界（措辞纪律）

- 本候选 `scripts = []`、`requiresBuildAuthorization = false`、安装期不执行任何第三方 **install-time** 脚本（受管 pnpm `--ignore-scripts`）。
- 这**不等于**“不执行任何第三方代码”：`cordis.patch.yml` 含 1 条 **load-time** `!!js`，会在含该 bundle 的 DSH 进程启动时经 DSH 侧 `new Function`+`eval` 求值。两者是不同的轴，本记录全文区分。
- 技能载荷（`skills/**`，如 `job-apply` 对 Kimi WebBridge 的本机浏览器桥依赖）是**运行期**风险面：本次验收不调用任何 skill、不安装/连接 Kimi WebBridge、不访问已登录浏览器、不使用 CDP。DSH 路径只挂载 in-box 的 `@deepseek-ai/dsh-skill-filesystem`，`lib/index.js` 的 apply 未触发。

## 5. 机器可读证据

### 5.1 历史实测（工作树 `17556e7`；不对应 `e83c95c` / `47adeff`）

`HDSL_98_EVIDENCE_FILE` 输出：

```json
{
  "candidate": "Hisn00w/ASu-skills@feb77307b45e9c4a9890e385748eebe5a919eb1b",
  "queriedAt": "2026-09-23",
  "stars": 5031,
  "archiveSha256": "a864cf2786c5e05408e6ce76195b6cb19a2be9fa24490617d220f1451325a663",
  "manifestSha256": "3f97ad14125d544069a4d8f75cf8c233f34679077e0722cc620878e75088c7e2",
  "patchSha256": "d05da6d7fea17a111a59c986e301d3c7d470940f0c6da304a801c0f6bf3b3d56",
  "entrySha256": "7ac439fd9c048f4c1ef7a9f5aa70c44e08950f4a433b16ce2cf958703965a45a",
  "scriptAssessment": "none-detected",
  "requiresBuildAuthorization": false,
  "planInputsDigest": "3b4d4d00efb01e8a787c86589b993dc9a630d9d7c6ee31134b22c756f03e316c",
  "sourceClosureLockSha256": "814c631376f25727dad6ea0e6c40e8fddacf256b5b37e7b120eee34dee8cda37",
  "baselineGeneration": "gen-9fecd19c745643dc",
  "installedGeneration": "gen-43f3035a81dd43c2",
  "removedGeneration": "gen-1415d35e879541d0",
  "riskItemsDuringPreview": [
    "dependency and bundle changes take effect only after the environment is restarted (DSH has no watcher for this layer)",
    "no install-time scripts declared in the parsed manifest; the dependency closure was not enumerated"
  ],
  "removalRiskItems": [
    "dependency and bundle changes take effect only after the environment is restarted (DSH has no watcher for this layer)",
    "service-level coupling (another layer injecting a Cordis service provided by the removed plugin) is not decidable from patch files; no static reference does not prove the removal is free of impact",
    "informational: service dependencies for this plugin are not verified by an HDSL review record (unknown is not a removal blocker; policy superseded by #112)"
  ],
  "notes": [
    "lsof_mentions_asu_skills=false",
    "removed_profile_package_node_modules_present=false",
    "baseline_generation=gen-9fecd19c745643dc",
    "installed_generation=gen-43f3035a81dd43c2",
    "removed_generation=gen-1415d35e879541d0"
  ]
}
```

### 5.2 当前正式 head（测试执行版本 `ac43530`，merge main `2e85594`）

`HDSL_98_EVIDENCE_FILE` 输出：

```json
{
  "candidate": "Hisn00w/ASu-skills@feb77307b45e9c4a9890e385748eebe5a919eb1b",
  "queriedAt": "2026-09-23",
  "stars": 5031,
  "archiveSha256": "a864cf2786c5e05408e6ce76195b6cb19a2be9fa24490617d220f1451325a663",
  "manifestSha256": "3f97ad14125d544069a4d8f75cf8c233f34679077e0722cc620878e75088c7e2",
  "patchSha256": "d05da6d7fea17a111a59c986e301d3c7d470940f0c6da304a801c0f6bf3b3d56",
  "entrySha256": "7ac439fd9c048f4c1ef7a9f5aa70c44e08950f4a433b16ce2cf958703965a45a",
  "scriptAssessment": "none-detected",
  "requiresBuildAuthorization": false,
  "planInputsDigest": "89e9331c3a257327836ea7b71abb929647109db20fba50c8c58c6c456aa73077",
  "sourceClosureLockSha256": "0b54d743f1242bf6e9581245fb739436305b9874f5391ddcbcdca4eeacaaaff0",
  "baselineGeneration": "gen-96a4b1a04c3d4bb5",
  "installedGeneration": "gen-dea4ecd94b6a4fd4",
  "removedGeneration": "gen-65a9b509683e42b7",
  "notes": [
    "lsof_mentions_asu_skills=false",
    "removed_profile_package_node_modules_present=false"
  ]
}
```

（组合验证树 `4f1841b` + QA `fa803406…` 的同形结果：`3 passed / 149.54s`；generations `gen-185afe1009e547ea`/`gen-fba6895ce5d0460f`/`gen-bc3a5576c04f4af2`。两者仅在随机 generation id 上有差异。）

## 6. 验收对照（Agent Brief）

> 本节对照的是 §1.1 历史运行（工作树 `17556e7`）。修复（#141，PR #142 → main `2e85594`）后：组合验证树与**当前正式 head**（§1.3/§1.4/§3.8）均完成 install → preview → apply → start/ready → stop → B1 移除 → restart 全链 **PASS**；`!!js` 未直接观测等边界不变（§7）。

- [x] 记录查询日期、stars、精确 commit、tree/文件摘要、许可、manifest、DSH 入口、产物摘要；来源漂移 fail-closed（摘要不匹配即失败）。
- [x] 预览/安装未请求、也未写入构建授权或 `allowBuilds`；`requiresBuildAuthorization=false`，未触发“需授权即停”分支。
- [x] 安装提交新活动代；该代 DSH 启动到 ready；停止有界退出，无残留进程。
- [~] `!!js` 求值与 `bundledSkillDir` 解析：已记录组成可解析、目标路径存在于已安装包目录、boot 到 ready、无致命加载失败；**求值结果与错误文本未能直接观测**（见 §3.4，公开面无运行期相位面 #129）。按“失败即失败”如实记为未直接观测。
- [x] 经 B1 包路径移除后提交新活动代；重启后 DSH 期望组成不再含该行。
- [x] 移除后残留按 DSH 行为记录并标注边界；无静态服务依赖证明、无无损卸载承诺、无伪造 `known-empty`。
- [x] 全文区分 install-time 与 load-time 执行。
- [x] `hasCustomTag` 门禁缺口登记 #107 / PR #110（deferred，不改代码、不降门槛）。
- [x] 误执行事件只引用既有证据（`/tmp/qa98-phase1`、`/tmp/qa98-review-44`），未重跑。
- [x] 变更范围限于 `tests/integration/**` 与 `docs/development/*plugin*`；见“检查”。

## 7. 未测 / 缺口

- `!!js` 求值值、该行的 fiber 相位与任何错误文本：HDSL 公开面不可得（#129 no-go）；本记录不将其视为通过。
- 运行期 ACTIVE/ACK 集合与 `--dump-config` 期望组成的等价性（E9）：未证，本记录不声称等价。
- 旧代目录/旧发布 profile 的长期保留与磁盘残留量化：未测。
- Windows/Linux：不在受管 catalog，未测。
- 修复前 `e83c95c` / merge `47adeff` 的真实链：preview `INTERNAL_ERROR`（已定位并修复：#141 / PR #142 → main `2e85594`）。修复后：组合验证树与当前正式 head（§1.3/§1.4/§3.8）全链 PASS，无未通过项。
- 技能载荷（`skills/**` 9 个 `SKILL.md` 与 `job-apply`/`make-resume` 路径）的运行期行为：本次不调用、不评估。
- 运行期遥测/网络副作用的包级审计：D 层边界外（阶段 1 独立复核已记录）。

## 8. 安全约束执行情况

- 独立一次性 data root / HOME / DSH_HOME / TMPDIR；`DSH_TELEMETRY_DISABLED=1`；无个人凭据、无模型调用。
- 只对 pin 的精确 commit 执行；任何来源/patch/清单摘要漂移即失败。
- 未调用任何 skill、未安装/连接 Kimi WebBridge、未访问已登录浏览器、未使用 CDP。
- 出口只涉及 pin 的 GitHub 源与受管 Node/DSH/pnpm 产物所需主机；未观察到非白名单行为，未触发任何拒绝门槛。
- 未新增/绕过 v2 授权守卫，未修改生产安全策略。

## 9. 复现

```sh
# 默认套件不运行本用例（describe.skipIf）。
HDSL_REAL_THIRD_PARTY_PLUGIN=1 \
  pnpm exec vitest run tests/integration/plugins/third-party-plugin.real.test.ts
```

真实 lane 需要网络（GitHub API/codeload + nodejs.org + registry.npmjs.org）；`HDSL_EVIDENCE_KEEP=1` 在失败时保留临时 dataRoot，`HDSL_98_EVIDENCE_FILE` 落盘机器可读证据。R 层结果只对实际执行的精确 SHA 有效，见[测试指南](testing.md)。

平台门与默认套件负控：真实 lane 仅在 `process.platform === 'darwin' && process.arch === 'arm64'` 时运行（`describe.skipIf`），并把真实 host 透传给 `createRuntimePort` / `createManagedInstall`，`environments.create` 走冻结 dispatcher 的 `unsupportedCombinationReason`。默认套件（无网络、opt-in 关闭）另有一条负控：在真实的 `createManagedInstall` 上用 `linux/x64` host + `fetch` 探针 dispatch `environments.create`，断言返回 `UNSUPPORTED_COMBINATION`，且 **fetch 从未被调用、无 environment 行、无 operation 台账条目**——即拒绝发生在下载/安装副作用之前，而不是用跳过真实 lane 代替断言。

以上平台门 / 负控属于**测试执行版本 `ac43530`**（组合验证树先用 `4f1841b` + QA `fa803406…` 验证，再在合并新 main 的正式 head 上复跑）。

## 10. 引用

- 来源与静态执行面：[#98](https://github.com/YingkeSu/HDSL/issues/98)、阶段 1 记录 `/tmp/qa98-phase1/PHASE1-RECORD.md`、独立复核 `/tmp/qa98-review-44/REVIEW-44.md`、只读执行路径审计 `/tmp/qa98-audit-asu/ASU-EXEC-PATH-AUDIT.md` 与 `CORDIS-LIFECYCLE-RESEARCH.md`。
- 误执行事件（`npx --yes tsdown@^0.22.14`，2026-09-23T06:08Z）：只引用既有证据，未重跑。
- 上游接口与路径决策：[#111](https://github.com/YingkeSu/HDSL/issues/111)、B1 [#115](https://github.com/YingkeSu/HDSL/issues/115)（[PR #121](https://github.com/YingkeSu/HDSL/pull/121)）、E1 [#116](https://github.com/YingkeSu/HDSL/issues/116) / [#129](https://github.com/YingkeSu/HDSL/issues/129)、#107 / [PR #110](https://github.com/YingkeSu/HDSL/pull/110)。
- 相关既有验证：[提供者 profile 接线](plugin-a2-profile-validation.md)、[卸载与保留](plugin-remove-validation.md)、[显式构建授权](plugin-build-authorization-validation.md)、[期望组成查看](expected-composition-validation.md)。

## 11. 检查

本记录随附的代码变更涉及 `tests/integration/plugins/third-party-plugin.real.test.ts`（测试执行版本 `ac43530`，本 PR 分支合并新 main `2e85594` 之后）与本文档（随后的 docs 提交，不改变该测试执行版本）。QA 断言由 `github:` 声明**替换并加强**为同 commit codeload URL（并加 `gitHosted`/`integrity`/无 `github:` 前缀校验），未删除既有断言。测试除 opt-in 真实 lane 外还包含默认套件（无网络）的平台门断言：直接验证生产 `unsupportedCombinationReason`，并通过 `createContractRuntime(...).dispatch('environments.create')` 在 `linux/x64` 下断言 `UNSUPPORTED_COMBINATION` 且无下载/安装副作用。本地门禁与 CI 见 PR 正文；默认 `pnpm test` 不运行 opt-in 真实链。正式 head 的真实链**已 PASS**（§1.4/§3.8/§5.2）。
