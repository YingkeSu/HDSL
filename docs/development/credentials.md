# OS 凭据引用解析与显式进程环境（T005b / issue #44）

状态：**适配器已实现，macOS 真实 canary 证据已执行**（opt-in，见下）。Windows **未实现、未测**；Linux 未实现。本文件不声称 T005 的进程启停/就绪验收，也不声称 T006 的导出/UI 验收。

- 父任务：[#5](https://github.com/YingkeSu/HDSL/issues/5)；本切片：[#44](https://github.com/YingkeSu/HDSL/issues/44)。
- 基线 SHA：`7fbdc1e2607f4f695e6389296f56b3ba2600fa43`（main，2026-09-20）。
- 文件所有权：`packages/runtime/src/credentials/**`、`tests/credentials/**`、本文件。runtime 根 `index.ts` 由 T005 进程作者整合；本切片不修改 `core`/`process`/`renderer`/冻结契约。
- 决策依据：[ADR 0002](../adr/0002-credential-boundary.md)、[上游兼容性](../research/dsh-compatibility.md)、[行为探针](../research/dsh-behavior-probes.md)、[本地 API 契约](../../specs/001-environment-lifecycle/contracts/local-api.md)。
- 执行平台：macOS 26.3（`Darwin 25.3.0 arm64`），Node `v26.8.1`（root `engines` 允许 `>=26.0.0`；CI 用 `.nvmrc` 的 24.21.0）。

## 1. 范围与不变量

HDSL 受管用户凭据（如模型 API key）只保存为 OS 凭据存储**引用**，启动受管 DSH 时按引用解析并注入**显式子进程环境**。本切片实现该解析与注入机制，不实现环境配置存储（process/core 职责）。

- 引用值（secret）只在 `resolveLaunchEnvironment` 返回的 `LaunchEnvironment.env` 中瞬时存在；进程模块 spawn 后立即丢弃，不作为持久状态、不写文件/日志/导出/Git。
- 生产默认构造真实 OS provider，**绝不回退测试替身**；不支持的平台直接失败（`UNSUPPORTED_PLATFORM`）。
- 不提供“任意凭据查询”接口，也不引入全权限 shell；renderer 不接触任何凭据值。
- 无引用/引用缺失/取消失败时**闭合失败**，错误消息不含 secret。
- 与上游 Web 会话 secret（`$DSH_HOME/.credentials.yaml` 的 `browser-session` grant）无关；后者是上游落盘产物，按 ADR 0002 视为环境 home 含密数据处理，本切片不读取、不改写它。

## 2. 已核验的上游 rc.2 事实（官方精确来源）

本机从 npm 安装的 `@deepseek-ai/dsh@0.1.5-rc.2`（与 [dsh-compatibility.md](../research/dsh-compatibility.md) R001 的 tag `dsh-v0.1.5-rc.2` = `fb2c4b9e…` 对应）中直接读取，不跨版本混用：

| 事实 | 精确来源 |
| --- | --- |
| 模型 API key 默认环境变量 = `DEEPSEEK_API_KEY` | `@deepseek-ai/dsh-llm-deepseek/lib/index.js`：`const DEFAULT_API_KEY_ENV = "DEEPSEEK_API_KEY"` |
| 凭据引用是 POSIX shell 标识符命名的环境变量名 | `@deepseek-ai/dsh-credentials/lib/types/index.d.ts`：`credentialRef(value)` 接受 “a POSIX shell identifier such as `DEEPSEEK_API_KEY`” |
| 解析优先级：launch env > `$DSH_HOME/.credentials.yaml` > 调用目录 `.env` > `$DSH_HOME/.env` | `@deepseek-ai/dsh-credentials-local/README.md`（“Keys are resolved in one fixed order”） |
| 解析读取的是启动环境快照，而不是启动后变化的 `process.env` | `@deepseek-ai/dsh-launch-environment/README.md` |
| 上游**没有** OS keychain/credential-manager provider（明确 deferred） | `@deepseek-ai/dsh-credentials-local/README.md`、`@deepseek-ai/dsh-credentials-local/lib/types/index.d.ts` |

结论：受管用户凭据只能由 HDSL 解析后注入子进程的**继承环境**（launch env 层优先级最高），因此本适配器构造 `spawn(..., { env })` 用的显式环境；不写 `.env`，不依赖上游文件层。

## 3. macOS `security` 行为（真实执行）

用专用随机 canary 在登录钥匙串执行（`security` 为 `/usr/bin/security`）：

| 场景 | 命令/结果 | 映射 |
| --- | --- | --- |
| 成功 | `find-generic-password -s <svc> [-a <acct>] -w`，exit 0，secret 在 **stdout** | 返回 `stdout`（去掉一个行尾换行） |
| 条目不存在 | exit `44`（`errSecItemNotFound`），stderr `… could not be found in the keychain.` | `CREDENTIAL_NOT_FOUND` |
| 用户取消授权 | 非零 + stderr 含 `User canceled` | `CREDENTIAL_ACCESS_CANCELLED` |
| 其它拒绝/错误 | 非零 | `CREDENTIAL_ACCESS_DENIED`（stderr 经脱敏 + 512 字符上限） |
| 认证 UI 阻塞 | runner 超时（默认 10s，canary 用 5s）→ SIGKILL | `RESOLUTION_TIMEOUT`，不与被阻塞的 UI 交互 |
| 空值 | exit 0 但 stdout 为空/仅换行 | `CREDENTIAL_NOT_FOUND`（上游规则：空值等同未配置） |

- secret **从不出现在命令行参数**：读取只用 `-w`（stdout），测试写入 canary 时把密码写到 `security` 的 stdin（`-w` 作为最后一个参数触发提示），不落 argv。
- 子进程只继承最小环境 `{ HOME, PATH }`；`security` 的 stderr 在不成功分支才作为脱敏诊断，成功分支的 stdout 只作为 secret 返回，不记录。
- 探针实测最小环境（`HOME` + `PATH`）即可读写登录钥匙串。

## 4. Keychain 引用编码

冻结 DTO `CredentialReference` 只有 `{ id, store, key }`，macOS 的定位信息编码进 `key`：

- `key = "<service>"`：只按 service 查找；
- `key = "<service>#<account>"`：按 service + account 查找；
- service 不得为空/含 `#`/控制字符；`#` 后 account 不得为空；总长 ≤ 256（与冻结 DTO 一致）。

辅助函数：`keychainKey({ service, account? })`、`parseKeychainKey(key)`（均在 `packages/runtime/src/credentials/reference.ts`）。

## 5. 与 T005 进程作者的窄接口

机制层（环境无关，`packages/runtime/src/credentials/injection.ts`）：

```ts
interface CredentialInjection {
  readonly store: OsCredentialStore; // 'keychain'
  resolveLaunchEnvironment(request: {
    bindings: readonly CredentialBinding[];   // { name: env 变量名, reference: CredentialReference }
    baseEnv: Readonly<Record<string, string>>; // 调用方自己的显式基础环境
  }): Promise<LaunchEnvironment>;             // { env, injectedVariables, dispose() }
}
```

环境作用域适配层（`packages/runtime/src/credentials/port.ts`），直接符合协商签名：

```ts
interface LaunchCredentialPort {
  resolveLaunchEnvironment(environmentId: string): Promise<PortOutcome<Readonly<Record<string, string>>>>;
}
// createLaunchCredentialPort({ load: (environmentId) => Promise<{ bindings, baseEnv }>, ... })
```

- `load` 由进程模块提供（environmentId → 该环境的凭据引用 + 显式基础环境）；凭据模块不读 core/环境存储，也不持有环境状态。
- 成功返回 `portOk(env)`：`env` 是 `baseEnv` 合并凭据变量后的**显式子进程环境**（不继承宿主 `process.env`）。
- 失败返回 `portFail(code, message)`：`message` 已是无值消息。错误码映射：`UNSUPPORTED_PLATFORM → UNSUPPORTED_COMBINATION`，其余 → `INTERNAL_ERROR`（冻结契约无凭据专用码）。
- 常量 `DEFAULT_MODEL_API_KEY_VARIABLE = 'DEEPSEEK_API_KEY'` 供双方复用，避免二次硬编码。

进程模块需要在 spawn 后立刻丢弃 `env` 引用；机制层 `LaunchEnvironment.dispose()` 可额外尝试擦除（见局限）。

## 6. 校验规则（全部在读取存储前完成）

- 变量名必须是 POSIX shell 标识符，且不在保留集（`PATH`/`HOME`/`DSH_HOME`/`NODE_OPTIONS`/`LD_PRELOAD` 等）。
- 变量名不得与 `baseEnv` 冲突、不得重复绑定。
- `reference.store` 必须与 provider store 一致。
- bindings 为空 → `MISSING_REFERENCE`（启动失败，符合“缺引用失败”）。
- 任一读取失败即整体失败，不返回部分环境。

## 7. 平台支持

| 平台 | 状态 | 证据 |
| --- | --- | --- |
| macOS（darwin） | 已实现，真实 canary 证据已执行 | 本文第 8 节 |
| Windows（win32） | **未实现、未测**；`createOsCredentialProvider` 抛 `UNSUPPORTED_PLATFORM` | 无实机；不声称支持 |
| Linux/其它 | 未实现（`secret-service` 仅在冻结 store 字面量中出现） | 不声称支持 |

## 8. 测试与证据

默认单测（CI 在 ubuntu 上运行，全部使用注入的测试替身，**不接触真实钥匙串**）：

```sh
pnpm exec vitest run tests/credentials
```

真实 canary 证据（仅 macOS，opt-in）：

```sh
HDSL_KEYCHAIN_CANARY=1 pnpm exec vitest run tests/credentials/keychain-canary.evidence.test.ts --reporter=verbose
```

本次执行输出（2026-09-20，macOS arm64，Node `v26.8.1`）：

```text
HDSL_KEYCHAIN_CANARY_EVIDENCE {"platform":"darwin","service":"hdsl.canary.credentials.1f83ee86a56f","resolvedRealKeychain":true,"injectedExplicitChildEnv":true,"hostEnvironmentNotInherited":true,"missingReferenceCode":"CREDENTIAL_NOT_FOUND","absentReferenceCode":"MISSING_REFERENCE"}
```

证据测试的安全边界：

- 只用随机服务名 `hdsl.canary.credentials.<hex>` + 随机 account 的**自建**条目；创建前断言其不存在，创建后 `finally` 删除并断言再次查找为 44。
- 不列举、不搜索、不读取任何其他钥匙串条目；不读用户已有凭据。
- canary 值经 stdin 写入，不进 argv；不进日志（只打印布尔与 code）。
- 若系统弹认证 UI，provider 超时失败并终止，不与弹窗交互；若用户已有条目/钥匙串不可用，测试在创建前断言阶段即以明确错误停止，不继续读取。

单测覆盖（`tests/credentials/`，65 项，1 项 opt-in 跳过）：引用语法与编码、`security` 退出码映射、取消/超时/拒绝、显式 env 合并与擦除、不继承宿主环境、保留名/冲突/重复/store 不匹配、`PortOutcome` 映射、以及源码级防线（无 `console.*`、无 `process.env`、无文件写入）。

## 9. 明确局限与未测

- **Windows 完全未实现/未测**：`credential-manager` 路径不存在，也不在无实机前声称支持。
- **Linux 未实现**。
- **GUI 认证 UI 无法被可靠检测**：只能用超时终止；若用户在超时内取消，映射为 `CREDENTIAL_ACCESS_CANCELLED`。不使用任何绕过 ACL 的手段。
- **ACL 提示**：用户自建、且 ACL 不信任 `security` 工具的条目仍可能触发一次系统授权；HDSL 不静默处理，超时即失败并报告。
- **`dispose()` 是尽力擦除**：JS 字符串不可变，引擎/GC 内可能短期留存副本；真正保证是“不持久化 + 不跨进程传播”，不是内存擦除。
- 未做真实的“有 key 的模型请求”验证；本切片不调用付费模型 API。
- 未验证锁定钥匙串、无登录会话（SSH/CI）下的行为；这些在 CI 上会被跳过。
- runtime 根 `index.ts` 未导出本模块（由 #5 整合），因此消费方暂不能从 `@hdsl/runtime` 顶层导入；测试用相对源码路径，`tsc -b` 仍会编译 `src/**`。
