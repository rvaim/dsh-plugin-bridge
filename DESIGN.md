# dsh-compat Web 设计约定

## 继承关系

dsh-compat Web 设置页是 DeepSeek Harness 现有设置面板的局部扩展。视觉与交互真源是 DSH 的 `ui-settings-general`、`ui-settings-plugin-inventory` 与 `ui-primitives`，而不是本项目自建的设计系统。

## 页面结构

- 通过 `settings.section` 注册独立的“兼容插件”导航项，排序在 Agent 预设之后。
- 内容列沿用设置面板的 760px 最大内容宽度、紧凑标题/说明层级和 12–14px 间距节奏。
- 插件列表以全宽管理行呈现。左侧承载名称、来源、格式与能力摘要；右侧承载实时状态、启停开关与卸载动作。
- 错误与警告数量是行内 disclosure trigger；展开内容留在原管理行中，以说明为主、诊断代码/能力/文件为辅，不用第二层 Modal 打断上下文。
- 添加与选择流程使用 DSH `Modal`、`Input` 和 `Button`；反馈使用 `Toast`，进行中状态使用现有 loading 图标。

## 视觉语言

- 只使用 `--dsw-*` 颜色、边框、背景、阴影、字体和动效 Token。
- 控件采用 DSH 既有圆角与密度：列表容器 10px 圆角，输入 8px 圆角，主要按钮使用 primitive 的胶囊按钮。
- 状态色只用于状态点、简短标签和错误文案，不铺设大面积强调色。
- 不使用渐变、玻璃拟态、装饰性插画或另行加载字体。

## 状态与可访问性

- 初次读取、拉取来源、安装、启停和卸载都必须有可见且可被辅助技术识别的忙碌状态。
- 启停控件使用原生 button 加 `role="switch"`/`aria-checked`；多插件候选使用原生 checkbox。
- 诊断 disclosure 使用 `aria-expanded`、`aria-controls` 与具名 region；错误/警告文字和级别标签共同表达严重程度，不只依赖颜色。
- 所有图标按钮提供本地化名称；键盘焦点使用 DSH business-primary 焦点环。
- `prefers-reduced-motion` 下取消旋转以外的非必要过渡，并用静态状态文字保持含义。
- 窄内容区将管理行垂直堆叠，操作区不覆盖插件信息。
