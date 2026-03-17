# 浮译/Floator（Chrome Extension）

## 更新日志 (v1.1.0)
- **品牌升级**：
  - 插件名称按语言显示：中文为 `浮译`，英文为 `Floator`。
  - 全新插件图标（16/48/128）与视觉风格同步上线。
- **UI/UX 优化**：
  - Popup 与悬浮翻译框整体重绘，布局更紧凑、阅读层级更清晰。
  - 翻页按钮交互优化：不再出现悬停“下坠”导致难点的问题。
- **交互与稳定性修复**：
  - 追问输入框修复中文输入法（IME）场景下 `Enter` 误发送问题。
  - 源语言行改为始终可见，未识别时显示自动检测状态。

## 更新日志 (v1.0.4)
- **Markdown 支持**：
  - 翻译结果与追问回答现已支持 Markdown 渲染（加粗、列表、代码块等），阅读体验更佳。
  - 代码块添加了语法高亮样式。
- **源语言检测**：
  - 翻译时自动检测源语言，并在悬浮框结果上方显示（如 `[SOURCE: ENGLISH]`）。
  - 支持多语言界面切换（显示 `SOURCE:` 或 `原文：`）。
- **UI/UX 优化**：
  - 修复 Popup 界面输入框底部遮挡问题，增加内边距。
  - 优化语言选择列表的显示格式（如 `English | 英语`）。

## 更新日志 (v1.0.3)
- **多语言界面**：新增中英文界面切换（Popup → Settings → Interface Language）。
- **悬浮框交互升级**：
  - 支持多轮连续追问（Ask AI），对话历史完整保留在当前悬浮框内。
  - 增加“复制”按钮，支持复制原始翻译结果或单条追问回答。
  - 优化翻页交互与布局，操作更顺手。
- **UI/UX 优化**：
  - Popup 界面重构为 Tab 页签式（Translator / Settings）。
  - 优化输入框与按钮布局，避免遮挡。
  - 统一全站图标与配色风格。
- **Bug 修复**：
  - 修复划词选中中文时偶发的触发失效问题。
  - 修复追问模式下复制按钮失效的问题。

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
  - OpenRouter 示例：`https://openrouter.ai/api/v1`
  - 智谱 BigModel 示例：`https://open.bigmodel.cn/api/paas/v4`
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

### OpenRouter 推荐（免费优先）
- 首选模型：`openrouter/free`（由 OpenRouter 自动路由到可用免费模型，稳定兜底）
- 可选增强：`qwen/qwen3-30b-a3b:free`（节点可用时，多语言与对话能力更均衡）

## 接口说明（OpenAI-compatible Chat Completions）
扩展使用 `POST {apiUrl}/chat/completions`（并在需要时自动补齐 `/v1`），请求体为标准 Chat Completions 结构：
- `model`
- `messages`
- `temperature/top_p`

### Endpoint 自动补全规则
当你在 Popup 中填写 `API Endpoint` 时，扩展会尽量容错拼接：
- 以 `/chat/completions` 结尾：直接使用
- 以 `/v{数字}` 结尾（如 `/v1`、`/v4`）：追加 `/chat/completions`
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

输出文件：`floator-<version>.zip`

## License
MIT. See [LICENSE](LICENSE).
