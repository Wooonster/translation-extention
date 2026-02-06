# AI Translate Assistant (Chrome Extension)

划词悬浮翻译扩展：选中文本后，将鼠标悬停在选区上达到设定时间后自动翻译，并在页面上方显示悬浮结果框。支持本地 LM Studio（OpenAI-compatible）或任意 OpenAI 兼容接口。

## 功能
- 选中任意网页文本，鼠标悬停达到 `Hover Duration` 后自动触发翻译
- Popup 内配置：API Endpoint / API Key / Model / Prompt
- 模型预热：一键 Preload，降低首次翻译冷启动延迟
- 可选 Keep-Alive：定时预热防止模型卸载（默认关闭）
- Debug Logs：可控调试日志（默认关闭）

## 安装（开发者模式）
1. 安装依赖并构建：

```bash
npm i
npm run build
```

2. Chrome 打开 `chrome://extensions/`，启用「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择项目的 `dist/` 目录。

## 使用
1. 点击浏览器工具栏的扩展图标打开 Popup。
2. 配置：
   - API Endpoint：例如 `http://127.0.0.1:1234/v1`（LM Studio OpenAI-compatible）
   - API Key：LM Studio 可填任意字符串（如 `lm-studio`）
   - Model Name：LM Studio 里加载的模型名
   - System Prompt：翻译指令（默认输出中文）
   - Hover Duration：悬停触发时长（毫秒）
3. 可选：点击 `Preload Model` 进行预热。
4. 在网页上选中文本，把鼠标放到选区上等待悬停时间，出现翻译悬浮框。

## 接口说明（OpenAI-compatible）
扩展默认使用 `POST {apiUrl}/chat/completions`（如果 `apiUrl` 未包含 `/v1` 会自动补全为 `/v1/chat/completions`）。请求体为标准 OpenAI Chat Completions 格式：
- `model`
- `messages`（system + user）

## 权限说明
- `storage`：保存配置到 `chrome.storage.sync`
- `host_permissions: <all_urls>`：允许向你配置的 API Endpoint 发起请求（包括本地地址）

## 隐私
本扩展会将你选中的文本发送到你配置的 API Endpoint 进行翻译。详见 [PRIVACY.md](PRIVACY.md)。

## 发布打包
生成可上传/分发的 zip：

```bash
npm run release
```

输出文件：`ai-translate-assistant-<version>.zip`
