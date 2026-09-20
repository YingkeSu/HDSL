# HDSL 领域上下文

正式名称：HDSL — Hello DSH Launcher。原讨论的“栈舱 / Harness Dock”仅为历史工作名。

## 术语

| 术语 | 定义与边界 |
| --- | --- |
| Runtime artifact | 特定平台、架构、版本及摘要的 Node 或 DSH 安装产物 |
| Environment（环境） | 用户命名的工作环境，含活动代际指针及运行状态 |
| Generation（代际） | 一次验证过的组成快照；配置与插件组成固定，运行数据仍可变 |
| Composition lock | 精确运行时、插件版本、来源与摘要的锁定记录 |
| Workspace | 用户工作目录，可能位于环境外，恢复代际不撤销其改动 |
| Plugin | 在 DSH 中加载的扩展，可能执行宿主代码 |
| Pack（整合包） | 可分享的组成清单与允许公开的配置，不包含凭据或私有会话 |
| Change plan | 带基础修订号、有效期和风险提示的变更预览 |
| Operation | 可查询进度、取消状态与错误的长时操作 |
| Registry | 后续提供不可变整合包发布版本与撤销状态的服务 |

## 不变量

- 一个环境同时最多有一个修改事务；运行中的环境拒绝变更与恢复。
- 活动代际只在准备与验证成功后切换，失败时旧代际可用。
- 相同锁定组成不代表运行数据或模型响应相同。
- 独立目录、进程与 home 不等于操作系统安全沙箱。
- 受管用户凭据只以 OS 凭据存储引用保存；上游可能写入环境 home 的本地凭据产物（如 `.credentials.yaml` Web grant secret）同样视为秘密，不进入整合包、导出、普通日志与 Git。见 [ADR 0002](docs/adr/0002-credential-boundary.md)。

这是单领域上下文，即使未来采用 monorepo 也不自动分裂上下文。决策见 [ADR](docs/adr/README.md)。
