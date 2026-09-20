# 当前可执行与后续验收

## 现在

```bash
python3 scripts/check_repository.py
specify check
SPECIFY_FEATURE_DIRECTORY=specs/001-environment-lifecycle .specify/scripts/bash/check-prerequisites.sh --json --require-tasks --include-tasks
```

本仓库尚无桌面应用，不能运行 `pnpm dev`。下列流程是实现后的验收脚本，不是当前使用说明。

## 001 实现后

1. 在干净应用数据目录打开 HDSL，选择 catalog 的受支持版本组合并创建 A。
2. 选择另一组合创建 B；记录两个组成摘要。
3. 启动 A，等待就绪，打开本地 WebUI，写入仅属于 A 的可识别配置/数据。
4. 停止 A，启动 B；验证看不到 A 的数据，宿主默认 DSH 目录未改变。
5. 重复点击启动，不应产生第二个进程；停止并检查所属进程退出。
6. 注入摘要错误、端口冲突、进程退出；检查错误可理解且诊断不含秘密。
7. 分别记录 macOS ARM64 与 Windows x64 的实际版本、命令、日志和结果。
