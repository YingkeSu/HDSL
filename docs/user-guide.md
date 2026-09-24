# 开始使用 HDSL

从 [Releases](https://github.com/YingkeSu/HDSL/releases) 下载对应平台的压缩包。Mac 版适用于 Apple 芯片电脑；Windows 版目前只能预览界面，不能安装或启动 DSH。

## 安装与打开

Mac：解压，将 `HDSL.app` 拖入「应用程序」，然后打开。当前体验版未经过 Developer ID 签名与 Apple 公证；如果系统拦截，请先核对下载来源与 Release 提供的 SHA-256，再在「系统设置 → 隐私与安全性」中查看本次打开的提示。无需关闭系统的全局安全保护。

Windows：完整解压，双击文件夹里的 `HDSL.exe`。不要单独移动这个文件，其旁边的文件也是应用的一部分。

## 创建环境

点击创建环境，为它命名并选择已支持的版本。保持联网，等待安装结束。每个环境分别保存配置和运行数据，可以按项目或用途命名。

## 配置 API 密钥（Mac）

当前版本还没有直接填写密钥的界面，需要先在系统钥匙串中保存密钥，再告诉 HDSL 去哪里读取。

1. 打开 macOS「钥匙串访问」，在登录钥匙串中新建一个密码项目。
2. 项目名称填写 `HDSL-DeepSeek`，账户填写 `default`，密码填写你的 API 密钥，然后保存。
3. 用纯文本编辑器将下面的内容保存为 `hdsl-credentials.json`。这里仅填写钥匙串项目的位置，**不要把 API 密钥填进这个文件**。

```json
{
  "schemaVersion": "1",
  "bindings": [
    {
      "name": "DEEPSEEK_API_KEY",
      "reference": {
        "id": "cred-deepseek",
        "store": "keychain",
        "key": "HDSL-DeepSeek#default"
      }
    }
  ]
}
```

4. 回到 HDSL，选中一个已停止的环境，使用顶部菜单「环境 → 导入环境凭据引用…」，选择刚才的文件。
5. 启动环境。系统若询问是否允许访问钥匙串，核对请求后按需授权。

其他模型服务的变量名需要与其配置相匹配。进一步说明见[凭据配置](development/desktop-integration.md#凭据引用配置主进程原生菜单adr-0004)。

## 日常使用

- 启动环境后，在浏览器中打开 DSH 工作界面；结束使用时，在 HDSL 中停止环境。
- 安装插件前先查看来源和变更预览。出现构建授权提示时，只授权你信任的内容。
- 版本或插件变更可能需要先停止环境，完成后再启动。
- 恢复历史组成不会恢复个人文件或撤销会话数据变化；切换版本前请备份重要数据。

需要帮助时，请通过 [Issues](https://github.com/YingkeSu/HDSL/issues) 提供系统版本、复现步骤与错误提示，不要附上密钥或私密会话。
