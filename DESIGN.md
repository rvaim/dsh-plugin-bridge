# 插件桥（Plugin Bridge） Web 设计约定

## 继承关系

插件桥（Plugin Bridge） Web 面板是 DeepSeek Harness 主区域的原生扩展。入口与容器的视觉、交互真源是 DSH 的 `ui-sidebar`、`ui-layout`、`ui-plugin-manager` 与 `ui-primitives`。

## 页面结构

- 在 `sidebar.panellist` 注册 `plugin-bridge` 导航项，在 `main` 注册同 key 的管理面板。中文名“插件桥”、英文名“Plugin Bridge”；选择、活动状态和键盘行为由 DSH 侧边栏提供，不再注册设置 section。
- Client locale namespace 为 `pluginBridge`；中文说明为“在当前 profile 中管理和运行 Claude Code、Codex 与 Agent Plugins 外部插件。开关与卸载会立即作用于当前进程。”，英文说明为“Manage and run external plugins for Claude Code, Codex, and Agent Plugins in the current profile. Changes apply to this process immediately.”。
- 独立容器继承宿主管理面板的全高滚动、响应式水平留白和窗口标题区避让；内容列保持 760px 最大宽度、紧凑标题/说明层级和 12–14px 间距节奏。
- 插件列表以全宽管理行呈现。左侧承载名称、来源、格式与能力摘要；右侧承载实时状态、启停开关与卸载动作。
- 错误与警告数量是行内 disclosure trigger；展开内容留在原管理行中，以说明为主、诊断代码/能力/文件为辅，不用第二层 Modal 打断上下文。
- 添加与选择流程使用 DSH `Modal`、`Input` 和 `Button`；成功反馈使用 `Toast`，失败保留为列表、插件行或弹窗内可恢复的持续提示。
- 列表支持名称、ID、来源检索以及启用/停用/需关注/可更新筛选；结果为空时明确提供清除筛选。统计只用紧凑行内文本。
- 读取列表不等待远端更新检查；两种请求独立显示状态，失败保留已知数据。
- 共享来源更新显示受影响插件并经确认提交；卸载继续二次确认。
- 弹窗的 Escape、Tab 和返回焦点由 DSH `Modal` 管理，流程切换仅补充步骤初始焦点；低高度下正文滚动、操作按钮保持可见。

## 视觉语言

- 只使用 `--dsw-*` 颜色、边框、背景、阴影、字体和动效 Token。
- 控件采用 DSH 既有圆角与密度：列表容器 10px 圆角，输入 8px 圆角，主要按钮使用 primitive 的胶囊按钮。
- 状态色只用于状态点、简短标签和错误文案，不铺设大面积强调色。
- 不使用渐变、玻璃拟态、装饰性插画或另行加载字体。

## 状态与可访问性

- 初次读取、拉取来源、安装、启停和卸载都必须有可见且可被辅助技术识别的忙碌状态。
- 启停控件复用 DSH `Switch` 与其 `role="switch"`/`aria-checked` 语义；多插件候选使用原生 checkbox。
- 诊断 disclosure 使用 `aria-expanded`、`aria-controls` 与具名 region；错误/警告文字和级别标签共同表达严重程度，不只依赖颜色。
- 所有图标按钮提供本地化名称；键盘焦点使用 DSH business-primary 焦点环。
- `prefers-reduced-motion` 下取消旋转以外的非必要过渡，并用静态状态文字保持含义。
- 窄内容区将管理行垂直堆叠，操作区不覆盖插件信息。
