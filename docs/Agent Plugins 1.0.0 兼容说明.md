# Agent Plugins 1.0.0 兼容说明

## 独立范围与固定基线

Agent Plugins 是独立的 portable 包格式，标记为 `agent-plugins`，不作为 Codex 或 Claude Code 方言。传统兼容方案保持单独维护。规范基线为官方 `v1.0.0`，提交 `bd383552095128f6effe895b9257cfd580a6d179`，查阅日期 2026-10-20（Asia/Shanghai）。

| 项目 | 固定标识 |
|---|---|
| 规范 | [官方 1.0.0 正文](https://github.com/agentplugins/agent-plugins-spec/blob/bd383552095128f6effe895b9257cfd580a6d179/spec/1.0.0.md) |
| Manifest | `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json` |
| MCP | `https://agent-plugins.org/schemas/1.0.0/mcp.schema.json` |
| Manifest SHA-256 | `0a4aad95ce337878ad38802ebf0daa3fde76abe3f65400c86bcbb1ec0b3ab883` |
| MCP SHA-256 | `6539175bfcdf43085855183e86da40ea94b166547a72b47ae9a0a390516d3acb` |

版本化官方 endpoint 与固定 Git 标签中的两份 schema 已逐一比对。校验使用随包分发的本地 schema，不在加载插件时联网获取 `$schema`。规范正文在 schema 无法表达的例外和文件系统语义上优先。官方 schema 按 Apache-2.0 授权分发，版权与许可证归属随文件保留；本文为本项目对实现行为的说明。

`plugin.json.version` 是插件作者版本；`protocol.version` 是 Agent Plugins 规范版本；本项目 parser/source parser 是内部模型版本，三个版本互不替代。独立格式接入阶段的模型版本为 `3.1.0`；当前工作区的统一模型为 `6.0.0`，Agent Plugins 实现保持 `1.2.0`。根清单仍独占匹配，不允许通过选择其他解析器绕过规范边界，见[单解析器选择与安装契约](<单解析器选择与安装契约.md>)。

## 根清单与组件边界

根目录 `plugin.json` 确定独立包边界。必须先校验 `$schema` 和名称，失效时不发现任何组件，也不回退到 `.codex-plugin`、`.claude-plugin` 或普通目录推断。传统 Marketplace 可作为包的定位来源，但不能补充、覆盖 portable 核心字段。

名称允许 1–64 位小写字母、数字、连字符及点，首尾为字母数字，禁止连续 `--` 或 `..`。作者、版本、URL、邮箱等按规范的 JSON 类型校验，不额外强制 SemVer、URL、邮箱或 SPDX 格式。

未知顶层字段逐项报告并忽略，非对象 `extensions` 报告后忽略。未实现 namespace 不验证其中的值，不导入代码、执行 Hook 或注入 Codex/CC 私有语义。其他根清单校验错误为插件级阻断。

固定组件只有：

- `skills/*/SKILL.md`：仅直接子目录中的精确文件名，不递归发现更深技能。
- `mcp.json`：插件根的 portable MCP 配置。

根 `SKILL.md`、`.mcp.json`、清单内联 `skills` / `mcpServers` / `hooks`、历史客户端目录均不提供 portable 核心能力。缺少固定组件不报错。组件路径损坏、类型错误或越界只禁用该组件，单个 Skill 或 MCP 条目错误只跳过该条目，其他有效能力继续。

## Skill

Skill 格式对照 Agent Skills 规范，而不套用 CC 或 Codex frontmatter 的调用、授权、Hook 或 sidecar 规则。Skill 名称和描述等字段校验后通过 DSH Provider 按需读取正文；不在安装时执行动态内容或安装依赖。不支持的语法或无法映射的宿主约束会报告并跳过该 Skill，不让它的错误阻断同包 MCP。

本项目 YAML 解析器支持明确的子集，尚未声明 Agent Skills 所有 YAML 写法或所有客户端扩展行为均已兼容。忽略的 namespace 和展示信息不等同于其运行语义已实现。

## portable MCP

`mcp.json` 的 schema 版本必须与根 Manifest 的 1.0.0 一致。顶层只允许 `$schema`、`mcpServers`；每个服务器要求显式 `type` 并符合对应封闭变体。顶层无效只禁用 MCP，服务器无效或 transport 尚未支持只跳过对应服务器。连接或认证失败只影响该连接，其他组件继续。

stdio：

- `command` 是单个裸 executable 名或 `./` 插件相对路径，禁止把 Shell 命令字符串当 executable，不展开 command 的占位符。
- 缺省 cwd 为插件根；cwd 只接受 `./...`、`${PLUGIN_ROOT}` 或 `${PLUGIN_DATA}` 锚点，展开后分别执行真实路径包含检查。
- args、env、cwd 只进行两种保留变量的单次、非递归文本替换。未知 `${TOKEN}`、`${TOKEN:-default}` 等保留字面，不查询凭据服务、不继承传统模板解析。
- 替换生成的文本不再扫描占位符。现有字符串中的每个精确 `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` 均替换，包括它位于其他未知文本内部的情况。
- PLUGIN_ROOT 与 PLUGIN_DATA 由宿主提供，配置不能重定义；数据目录先创建、按安装实例独立、更新保留。

远程 MCP：URL 必须为绝对 HTTP(S)、无 userinfo 或 fragment；非 loopback 只允许 HTTPS。Header 字段名和值合法且不得按大小写重复。URL/Header 不做占位符或环境变量替换。

当前 DSH MCP Client 没有公开跨 origin redirect 的配置 Header 控制。为不违反 portable 的转发限制，含非空配置 Header 的远端条目会明确提示运行未适配并跳过，不透传后冒称安全；无配置 Header 的 streamable-http 可接入现有客户端。SSE 合法但本轮不支持运行，跳过时不回退 transport。认证发现和交互凭据不属于 portable 1.0.0 的配置协议，本轮不把 OpenAI 私有认证声明并入核心格式。

## 生命周期、诊断与验证

继续复用 Source 快照、原子安装/更新、插件级开关和卸载，Skill Provider 与 MCP 都归父实例所有。组件隔离性诊断使用非阻断级别，但清单级错误保持阻断。数据目录的更新保留及卸载清理沿用现有布局。

测试和实测状态由[Agent Plugins 1.0.0 验证报告](<Agent Plugins 1.0.0 验证报告.md>)记录。本轮不安装当前用户 profile；当前 Desktop 的 Typert/Web 迁移仍是独立运行时工作，不由 schema 解析测试替代。
