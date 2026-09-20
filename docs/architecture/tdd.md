# Technical Design Document

这里 TDD 指技术设计文档；测试驱动开发另见测试策略。

## 选型与模块

初始方向：Electron + React + TypeScript；应用层组织用例，领域核心不依赖 Electron，平台层处理进程、文件和凭据。受管 Node 与 DSH 为独立产物，不把 Electron 内置 Node 当成用户运行时。实际版本在首个工程任务核验后精确锁定。

候选包：`apps/desktop`（main/preload/renderer）、`packages/core`（环境/事务）、`packages/runtime`（安装/进程/上游适配）、`packages/contracts`（边界类型与运行时校验）、`packages/pack`（后续整合包）。避免只有转发代码的空抽象包。

renderer 禁用 Node 集成，开启 context isolation 与 sandbox；通过窄化 preload API 请求操作。DSH WebUI 为不可信页面，不注入 launcher preload，不接触高权限 IPC。先用系统浏览器打开经验证的本地端点，嵌入另开 ADR。

## 存储

```text
<app-data>/
  artifacts/<sha256>/             校验后的不可变下载产物
  environments/<id>/
    environment.json             名称、修订号、活动代际
    generations/<id>/
      composition.lock.json      精确版本、来源、摘要
      config/                    该代际配置
      data/                      可变运行数据
    transactions/<id>.json       持久化操作阶段与恢复信息
  logs/                          脱敏且有容量上限
```

在隔离目录中使用 DSH 的真实配置入口，具体参数须先核验。不得假设设置 HOME 就足够，也不得自动复用宿主 `~/.dsh`。凭据只保存 OS keychain/credential manager 的引用。

## 事务和恢复

1. 获取环境跨进程独占锁，检查 expectedRevision；运行中则拒绝修改。
2. 持久化 journal，准备同卷 staging 代际；校验来源、摘要、磁盘空间与兼容性。
3. 在停止环境的情况下复制必要配置/数据到新代际，保留旧数据；禁止对可变数据硬链接。
4. 验证组成和启动健康，停止验证进程；验证可能产生的数据必须有清理/隔离规则。
5. 以平台支持的原子替换方式更新环境活动指针并持久化，标记提交；Windows/macOS 的 rename、fsync 与锁语义需实测。
6. 重启读取 journal：未切换则清理/保留 staging 供诊断；已切换则补全提交。任何不确定状态先保留所有代际，不猜测性删除。

恢复也使用相同锁、修订检查和指针提交，不能修改运行中环境。恢复旧代际不会合并新会话，也不能撤销外部工作目录或外部服务的变化。

## 上游适配与供应链

允许的 Node/DSH 来源、精确版本和摘要由受审的 catalog 描述。相同来源自己提供的摘要主要防损坏，不自动证明可信；记录 provenance。启动使用参数数组、固定可执行路径、明确环境变量与 cwd，禁止拼接 shell。端口只绑定 loopback，拒绝未验证的任意 URL。

插件安装可能执行代码；仅在用户看到来源与权限风险后执行。共享缓存不得跨版本可写共享依赖。包解析拒绝目录穿越、符号链接逃逸、过量解压、重复目标、错误摘要和不支持 schema。

## 社区与小程序

先用轻量讨论验证需求。之后 Registry 保存不可变 release/digest 与撤销状态，论坛帖子只链接版本；可编辑帖子不作为安装依据。小程序只提供发现、收藏、兼容信息与分享码，桌面端验证分享码并由用户发起安装。平台认证、备案、审核和内容治理是后续研究任务。
