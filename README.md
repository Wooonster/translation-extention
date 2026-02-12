# AI Translate Assistant（Chrome Extension）

划词悬浮翻译扩展：在网页中选中文本后，将鼠标停留在选区附近达到设定时间自动翻译，并在页面上显示悬浮结果框。同时提供 Popup 内的手动翻译面板，支持输入长文本、选择目标语言、复制与重新翻译。

后端支持任意 OpenAI-compatible Chat Completions 接口（如本地 LM Studio 等）。

## 功能与特性
- 划词悬停翻译：选中文本 + 悬停计时触发翻译，结果以悬浮框显示在页面上
- Popup 手动翻译（i need...）：输入文本 + 选择目标语言，点击 `Trans` 或 Ctrl/Cmd + Enter 翻译
- 重新翻译：在手动翻译面板中可重复触发，重试会调整采样参数以获得不同表达
- 一键复制结果：手动翻译结果可直接复制
- API 配置面板（折叠区）：API Endpoint / API Key / Model / System Prompt，并内置 `Preload Model` 预热按钮
- Keep-Alive 保活：可选定时预热防止模型卸载（默认关闭）
- Debug Logs：可控调试日志（默认关闭）
- 结果清洗：对翻译结果自动去除首尾多余空白/换行
- TranslateGemma 适配：当模型名包含 `translategemma` 时自动使用更合适的 Prompt 与语言代码规范化

## 安装（开发者模式）
1. 安装依赖并构建：

```bash
npm i
npm run build
```

2. Chrome 打开 `chrome://extensions/`，启用「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择项目的 `dist/` 目录。

## 使用指南
### 1) 配置 API（Popup → API Configuration）
- API Endpoint：
  - LM Studio 示例：`http://127.0.0.1:1234/v1`
  - 也可填根地址（例如 `http://127.0.0.1:1234`），扩展会自动补全到 Chat Completions 路径（见下文）
- API Key：
  - 若后端不校验可填任意字符串；若后端需要鉴权则填写真实 Key
- Model Name：后端已加载/可用的模型名
- System Prompt：翻译指令（用于一般模型；若检测到 TranslateGemma 会启用专用策略）
- 可选：点击 `Preload Model` 进行预热，降低首次翻译冷启动延迟

### 2) 划词悬停翻译（网页内）
1. 在网页上选中文本。
2. 将鼠标停留在选区附近，等待达到 `Hover Duration`（毫秒）。
3. 页面上出现悬浮翻译结果框。

### 3) 手动翻译（Popup → i need...）
- 在输入框粘贴/输入要翻译的文本（支持长文本，输入框会自动扩展高度，超出部分内部滚动）
- 选择目标语言（Target Language）
- 点击右下角 `Trans` 翻译
- 使用 Ctrl/Cmd + Enter 触发“重新翻译”
- 点击 `Copy` 复制结果

### 4) 其他设置（Popup → Settings）
- Hover Duration：悬停触发时长（毫秒）
- Keep Model Warm：开启后按间隔自动发送预热请求（可设置 15–3600 秒）
- Debug Logs：开启后在扩展相关上下文输出调试日志

## 接口说明（OpenAI-compatible Chat Completions）
扩展使用 `POST {apiUrl}/chat/completions`（并在需要时自动补齐 `/v1`），请求体为标准 Chat Completions 结构：
- `model`
- `messages`
- `temperature/top_p/top_k`（部分后端可能忽略其中的部分字段）

### Endpoint 自动补全规则
当你在 Popup 中填写 `API Endpoint` 时，扩展会尽量容错拼接：
- 以 `/chat/completions` 结尾：直接使用
- 以 `/v1` 结尾：追加 `/chat/completions`
- 否则：追加 `/v1/chat/completions`

## TranslateGemma 说明
当 `Model Name` 包含 `translategemma`（不区分大小写）时：
- 使用更适配 TranslateGemma 的 user-only Prompt（包含源/目标语言代码与“仅输出翻译”约束）
- 对目标语言代码做规范化（如 `zh/zh-cn → zh-Hans`，`zh-tw/zh-hk → zh-Hant` 等）
- “重新翻译”时会调整采样参数以增加多样性

## 权限说明
- `storage`：保存配置到 `chrome.storage.sync`
- `host_permissions: <all_urls>`：允许向你配置的 API Endpoint 发起请求（包括本地地址）

## 隐私
本扩展会将你选中的文本/手动输入的文本发送到你配置的 API Endpoint 进行翻译。详见 [PRIVACY.md](PRIVACY.md)。

## 发布打包
生成可上传/分发的 zip：

```bash
npm run release
```

输出文件：`ai-translate-assistant-<version>.zip`
