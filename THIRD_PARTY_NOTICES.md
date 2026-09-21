# 第三方说明

## 应用依赖

HDSL 使用 Electron、React 等第三方依赖。直接依赖及版本列在各 workspace 包的 `package.json` 中，完整依赖解析记录在 `pnpm-lock.yaml` 中。各依赖的许可文件随对应软件包提供；分发安装包时需保留相应许可与声明。

## 受管运行时

Node.js 和 DeepSeek Harness（DSH）按运行时目录中的固定来源与摘要下载，不作为 HDSL 自有实现。版本、来源与上游许可核验记录见 [DSH 兼容性研究](docs/research/dsh-compatibility.md)。DSH 的依赖闭包记录位于 `packages/runtime/catalog/`。

## 设计参考

界面与环境管理思路参考 PCL、HMCL，未导入其实现源码或品牌素材。新增第三方代码、图片、字体或其他分发资产时，应记录来源、版本、许可及修改。

HDSL 自有代码当前标记为 `UNLICENSED`；第三方许可不构成对 HDSL 自有代码的许可授权。
