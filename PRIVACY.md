# 隐私政策（AI Translate Assistant）

最后更新：2026-02-06

## 收集与使用
- 扩展会在你触发翻译时，将你选中的文本发送到你在 Popup 中配置的 API Endpoint，用于生成翻译结果。
- 扩展不会主动收集浏览历史、账号信息或设备标识。

## 存储
- 配置项（API Endpoint、API Key、模型名、Prompt、Hover 时长、Keep-Alive 开关等）存储在 `chrome.storage.sync` 中，便于在同一 Chrome 账号下同步。

## 日志
- 默认不输出调试日志。
- 当你在 Popup 中打开 Debug Logs 时，扩展可能在控制台输出运行状态信息（不应包含选中文本内容）。

## 第三方服务
- 你配置的 API Endpoint 可能是本地服务（如 LM Studio），也可能是第三方服务。第三方服务如何处理数据取决于对方的隐私政策与部署方式。

## 你的控制权
- 你可以随时在 Popup 中修改或清空配置，或卸载扩展以停止所有数据处理。

如需联系，请在项目仓库的 Issues 中反馈。
