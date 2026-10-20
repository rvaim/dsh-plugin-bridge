# 插件桥（Plugin Bridge）产品约定

## 产品定位

插件桥（Plugin Bridge）让 DeepSeek Harness 用户在不改写外部插件的前提下，把独立 Agent Plugins 1.0.0、Claude Code 与 Codex 插件作为完整 Source/Plugin 安装、检查并运行。它负责外部插件的来源快照、能力解析、冲突诊断、运行状态和生命周期，不替代 DSH 自身的 Cordis 包管理。

中文名称为“插件桥”，英文名称为“Plugin Bridge”；Cordis 插件 ID 为 `plugin-bridge`，npm 包名为 `@rvaim/dsh-plugin-bridge`。0.5.0 起使用新包名，不自动迁移用户 profile。GitHub repository 和 `$DSH_HOME/dsh-compat/` 数据目录保留，详见[包更名说明](<docs/包更名说明.md>)。

## 目标用户与使用场景

- 已使用 DSH，但仍有 Claude Code 或 Codex 插件资产的开发者。
- 用户在当前运行的 profile 中添加可信的本地目录、归档或 Git 来源，并希望立即使用其中已支持的 hook、skill 与 MCP 能力，同时看到其他能力的明确诊断。
- 同一来源可能包含一个或多个插件：单插件直接安装，多插件必须由用户明确选择。

## 当前产品能力

- 通过 Web 设置页或 `ctx.pluginBridge` 管理 Source 与 Plugin；不再提供独立 CLI。
- 安装、启用、停用和卸载操作在在线服务中直接驱动 `CompatRuntimeManager`，无需重启当前 DSH 进程。
- Web 设置页管理当前运行 profile 中由插件桥托管的插件；不跨 profile 修改其他部署。
- 插件桥包本身首次加入 profile 或升级时会改变 DSH Host/Client 启动组合，需要重新启动该 profile 并重新载入页面。之后在设置页添加的外部插件不改变 DSH Client 启动图。

## 安全与交互约束

- 来源输入接受现有解析器支持的 Git URL、`github:` 简写、本地目录与归档路径。
- 拉取和解析期间必须显示明确的进行中状态，并阻止重复提交。
- 多插件来源使用可访问的复选列表；不可安装或含阻断错误的候选不可选择。
- 卸载必须二次确认。失败必须保留原状态并把可执行的错误信息呈现给用户。
- Web 页面必须沿用 DSH 设置插槽、语言服务、UI primitives 与 `--dsw-*` 主题 Token，不创建独立视觉体系。

## 成功标准

用户能在设置中打开“插件桥”，看到当前插件及运行状态；通过一个添加弹窗输入来源，在拉取提示后完成单插件自动安装或多插件选择；并能在不重启当前 profile 的情况下启用、停用和卸载外部插件。
