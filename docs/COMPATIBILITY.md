# 兼容矩阵

## 1. Source 与 Marketplace

| 能力 | Claude Code | Codex | 当前行为 |
|---|---|---|---|
| Marketplace | `.claude-plugin/marketplace.json` | `.agents/plugins/marketplace.json` | 支持 |
| 一个 Source 多 Plugin | 支持 | 支持 | 必须选择，不默认全装 |
| 混合 Marketplace | 支持 | 支持 | 同目录同语义合并，否则诊断冲突 |
| 无 Marketplace 根插件 | 支持 | 支持 | 只检查根目录 |
| `--path` | 支持 | 支持 | 无 Marketplace 时显式兜底 |
| Source 内目录 | 相对路径 | `local.path` | 支持，校验真实路径 |
| 外部 Git | 支持 | 支持 | 支持 Git 与 git-subdir |
| npm/archive 远端位置 | 可识别 | 可识别 | 明确诊断，当前版本不安装 |

压缩包、本地目录和 Git 最终都进入同一 Source parser，不使用不同的 Plugin 猜测逻辑。

## 2. Plugin 清单

### Claude Code

支持：

- `.claude-plugin/plugin.json`；
- Marketplace 条目声明的能力路径与 `strict` 语义；
- `skills`、`mcpServers`、`hooks`、`commands`、`agents`；
- 默认能力目录和配置文件；
- `${CLAUDE_PLUGIN_ROOT}`、`${CLAUDE_PROJECT_DIR}`、`${CLAUDE_PLUGIN_DATA}` 等路径变量。

以下现行能力会明确诊断，不会伪装成已兼容：

- Workflow；
- Output Style；
- LSP Server；
- Theme；
- Monitor；
- Channel；
- `bin/` 与 `settings.json`；
- `userConfig`；
- Claude Plugin dependency。

其中需要交互配置或依赖编排的关键能力会产生 `error` 并阻止自动启用；可安全忽略运行注册但必须公开差异的能力产生 `warning`。

### Codex

支持：

- `.codex-plugin/plugin.json`；
- 现行顶层 `skills`、`hooks`、`mcpServers`、`apps`、`interface`；
- 兼容早期 `mcp_servers`、`commands`、`agents` 与 snake_case Hook；
- 缺少本地 `plugin.json` 时，使用 Marketplace 条目的内联 manifest 作为回退；
- 自定义 Skill、Hook 和字符串形式 MCP 路径在默认发现基础上追加；
- 多个 Marketplace Plugin 共用 Source 根目录时，以条目显式能力路径作为 Plugin 边界；
- PascalCase 与早期 snake_case Hook 名称。

顶层 `apps` 会被识别并产生 `CODEX_APPS_UNSUPPORTED` warning，当前版本不注册 Codex App。`paths` 是 Codex 内部规范化结构，不是当前插件 JSON 的公开包装字段；旧包若把能力放在 `paths` 下，会产生 `CODEX_PLUGIN_PATHS_UNSUPPORTED` 或 `CODEX_MARKETPLACE_PATHS_UNSUPPORTED` error，而不是猜测执行。

## 3. Skill

| 功能 | 状态 |
|---|---|
| `SKILL.md` 发现 | 支持 |
| frontmatter 名称、描述、元数据 | 支持 |
| 模型/用户调用控制 | 支持可映射字段 |
| 正文按需读取 | 支持 |
| 资源相对目录 | 支持 |
| 动态 DSH Skill Provider | 支持 |
| 全局复制到 `$DSH_HOME/skills` | 禁止 |

Skill 直接从 Source 中该 Plugin 的原始目录读取。Provider 随 Plugin 父实例撤销。

## 4. MCP

支持配置外层：

```json
{ "mcpServers": { "name": {} } }
```

和：

```json
{ "mcp_servers": { "name": {} } }
```

支持：

- stdio：`command`、`args`、`cwd`、`env`；
- Codex `env_vars` / `envVars`；
- streamable-http：`url`、`headers`；
- `toolCallTimeoutMs` / `tool_timeout_sec`；
- `failOnStartupError`；
- `reconnect`；
- 原配置中的 `enabled=false` / `disabled=true`。

明确限制：

- SSE transport：`error`；
- MCP Resource/Prompt：`warning`，当前只注册 Tool；
- `startup_timeout_sec`：`warning`，不能精确映射；
- 工具审批/白名单字段：`warning`，交给 DSH 自身策略；
- `serverName` 不满足 DSH 约束：`error`，不自动改名。

每个 MCP Server 作为 Plugin 父实例的子插件挂载。工具名保持：

```text
mcp__<serverName>__<rawName>
```

## 5. Hook

### Claude Code 事件映射

| Claude Code | DSH |
|---|---|
| `SessionStart` | `agent/session-start` |
| `UserPromptSubmit` | `agent/pre-step` |
| `PreToolUse` | `tools/pre-execute` |
| `PostToolUse` | `tools/post-execute` |
| `Stop` | `agent/turn-stopping` |
| `SubagentStart` | `subagent/start` |
| `SubagentStop` | `subagent/end` |

### Codex

支持 PascalCase 事件和早期 snake_case：

- `SessionStart` / `session_start`；
- `UserPromptSubmit` / `user_prompt_submit`；
- `PreToolUse` / `pre_tool_use`；
- `PostToolUse` / `post_tool_use`；
- `Stop` / `stop`。

### 共同能力

- command handler；
- matcher；
- timeout；
- detached/async；
- stdin payload；
- stdout 与 exit code 解析；
- 多 Hook 结果合并；
- 取消与停止清理；
- Hook 运行记录；
- deny/context 等可映射决策。

不支持的事件或非 command handler 会产生 `error`，不会静默跳过。`updatedInput`、`systemMessage` 等当前不能精确接入 DSH 的结果会产生 warning。

Hook 执行优先复用 `@deepseek-ai/dsh-hook-protocol` 与 `ctx.shell`，不建立第二套平行协议运行框架。

`@deepseek-ai/dsh-hook-protocol` 是发布包的必装运行依赖，而不是 optional peer。DSH profile 使用 `pnpm` 安装 `dsh-compat` 时会同时安装该库；否则 Hook adapter 会在运行时动态导入失败。上游 `dsh-hooks-claude-code` / `dsh-hooks-codex` 只接受单个进程级 `configPath`，不能直接消费本项目已归一化的多文件、Marketplace 内联配置与延迟凭据，因此本项目复用其共享 Protocol，由自己的 Plugin 级 adapter 完成方言映射。

## 6. Command 与 Agent

- parser 会识别 Markdown 内容、名称、描述和元数据；
- 统一结构、类型和 adapters 目录已保留；
- 当前版本不执行或注册；
- 每个发现项产生 `COMMAND_RUNTIME_UNSUPPORTED` 或 `AGENT_RUNTIME_UNSUPPORTED` warning。

## 7. 路径、环境变量与凭据

| 旧语义 | 内部结构 | 解析时机 |
|---|---|---|
| Plugin 根目录变量 | `plugin-root` | 运行时 |
| Plugin 数据目录变量 | `plugin-data` | 运行时 |
| 项目/Workspace 变量 | `workspace-root` | 当前会话或运行时 |
| `${TOKEN_NAME}` | `env` 引用 | 运行时 |
| 原 JSON 中的潜在明文 | `deferred-json` 指针 | 运行时从原文件读取 |

安装 parser 不展开 Token，也不把配置明文复制到 `scan.json`。

## 8. Node 依赖与安装脚本

如果旧插件 `package.json` 声明 `dependencies`、`optionalDependencies` 或 `peerDependencies`，parser 产生 `NODE_DEPENDENCIES_NOT_INSTALLED` warning。

这不代表自动执行包管理器。当前版本安装阶段不会运行 npm/pnpm/bun 或生命周期脚本；插件必须自带运行依赖，或由用户在受控环境中显式准备。

## 9. 跨平台原则

不会把 `bash check.sh` 自动翻译为 PowerShell，也不会猜测作者意图。目标平台缺少所需 shell 或可执行文件时，通过诊断或运行错误明确暴露。

## 10. 不制造伪兼容

以下行为明确禁止：

- 自动改写 MCP/Skill/Command 名称；
- 静默覆盖同名能力；
- 存在 Marketplace 时递归猜 Plugin；
- 忽略损坏清单并回退到其他识别方式；
- 自动修改旧插件源码；
- 自动安装 Source 更新后新出现的 Plugin；
- 将未支持能力标记为“已运行”。
