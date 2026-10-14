# Changelog

## 1.2.0
- Local vocabulary bank on this device: save a word or a phrase from the floating card, with pronunciation, meanings, a part of speech for a single word, and the page it came from
- User language: an English interface, or the interface in the language you choose, with that language kept as the default translation target
- Floating card and Bank: quieter controls, phrase selection, a review reminder, and a Markdown review you can download
- Content-script console: KaTeX stays off quirks-mode frames, and a reloaded extension closes the old card instead of leaving an uncaught context error

## 1.1.0
- 品牌升级：插件名称按语言显示（中文 `浮译` / 英文 `Floator`），并替换全套插件图标（16/48/128）
- Popup 与悬浮框视觉重构，布局更紧凑，交互反馈更清晰
- 修复追问输入框在中文输入法场景下按 Enter 误发送的问题
- 源语言显示改为始终可见，缺失时显示自动检测状态
- 修复悬浮框翻页按钮悬停位移导致的难点击问题

## 1.0.4
- 翻译结果与追问回答支持 Markdown 渲染，代码块带语法高亮样式
- 翻译时显示源语言，并随界面语言切换标签
- Popup 输入框底部留出空间，语言列表改为更清晰的双语格式

## 1.0.3
- Popup 设置中可切换中英文界面
- 悬浮框支持多轮追问，可复制翻译或单条回答
- Popup 改为 Translator / Settings 页签
- 修复划词选中中文时偶发不触发，以及追问模式下复制失效

## 1.0.1
- 修复悬停触发稳定性：支持多行/长选区，且无需继续移动鼠标也可触发
- Popup 集成全部设置项：预热、Keep-Alive、Debug、Hover Duration
- Prompt 优化：更稳定输出中文
- 默认关闭调试日志；Keep-Alive 改为可选
- 权限最小化：仅保留 storage
