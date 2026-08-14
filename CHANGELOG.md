# 更新日志

## 0.2.2

- 多插件 Marketplace 在交互终端中改用 `@clack/prompts` 复选列表：↑/↓ 移动、Space 选中/反选、Enter 确认；无交互、CI 与 JSON 模式继续要求显式 `--plugin`。
- Source 获取、解析与更新期间显示加载动画；进入复选列表时暂停、确认后恢复，JSON 与管道输出不受影响。
- 修复 Codex Stop Hook 固定发送 `last_assistant_message: null`，导致 ReMe 等插件静默跳过会话写入：现在从当前 DSH turn 已提交的最后一条 `assistant/message` 提取公开文本。
- 支持 Claude Code Hook 的独立 `args` 数组；运行时保留参数边界并按 POSIX Shell/PowerShell 规则逐项引用，不再把 JSON stdin 交给裸 `node` 解析。
- Plugin parser 版本升级到 `2.0.1`，已有安装记录在 DSH 下次加载时会从 Source 真源自动重扫，无需重装旧插件。

## 0.2.1

- 修复发布包安装到 DSH profile 后 Hook 无法注册：`@deepseek-ai/dsh-hook-protocol` 不再是不会随包安装的 optional peer，改为与目标 DSH rc.5 对齐的必装运行依赖。
- Hook adapter 改用 Protocol 自带的 `createDetachedRuns()` 管理异步 Hook 的取消与完全停稳，不再维护一份平行实现。
- 发布清单验证现在会阻止 Hook Protocol 被误改回 peer/optional peer，避免生成表面可安装但运行时缺少 Hook 执行库的包。

## 0.2.0

- 将安装模型重构为相互独立的 Source 与 Plugin：一个 Source 可包含一个或多个 Plugin。
- 支持 Claude Code 与 Codex Marketplace、多插件选择、`--path` 兜底和混合 Marketplace 合并诊断。
- 新增显式/隐式 Source、共享 Source 引用管理、整体更新、原子切换和失败回滚。
- Plugin 安装记录只保存 `sourceId + pluginPath/location`，原始源码只在 Source 中保存一份。
- 对齐 Codex 现行顶层 `skills`、`hooks`、`mcpServers`、`apps` 清单与 Marketplace 内联回退清单，并拒绝未定义的 `paths` 包装字段。
- 对 Claude Code Workflow、LSP、Monitor、Theme、Channel、userConfig、插件依赖等未适配能力提供明确诊断。
- 加强 Git URL、Marketplace 字段、符号链接、归档、凭据和并发锁安全检查。
- 扩充 Source、Marketplace、共享更新、回滚和 CLI 自动化测试。

## 0.1.0

- 初始版本：支持单插件来源的整体安装、Skill/MCP/Hook 适配、事务更新和卸载。
