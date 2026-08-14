# dsh-compat

`dsh-compat` 是 DeepSeek Harness（DSH）的旧插件兼容层。它让原本面向 Claude Code、Codex 的插件尽量保持原目录与语义运行，而不是把每个插件重新迁移成 DSH 原生插件。

项目坚持两个独立的管理概念：

```text
Source = Git 仓库、本地目录或压缩包；负责获取、缓存和整体更新内容
Plugin = Source 中的一个具体旧插件；负责安装、启用、禁用、运行和卸载
```

一个 Source 可以包含一个或多个 Plugin。Skill、MCP、Hook、Agent、Command 都只是 Plugin 内部能力，不会成为独立安装项，也不会被复制到 DSH 的全局目录。

> 当前交付版本：`0.2.2`。Plugin parser 版本为 `2.0.1`，Source parser 版本为 `2.0.0`，内部缓存结构 `schemaVersion` 为 `1`。实现按 2026-08-15 可取得的 DSH `0.0.1-rc.5` 接口核对。

## 核心边界

```text
来源获取层
Git / Directory / ZIP / TAR / TGZ
          │
          ▼
parser/source
Claude Marketplace / Codex Marketplace / 单插件识别 / --path
          │
          ▼
Source 中的 1..N Plugin
          │
          ▼
Plugin parser
Claude Code / Codex 的 Skill、MCP、Hook、路径和配置语义
          │
          ▼
CompatPlugin
          │
          ▼
runtime + adapters
Skill Provider / dsh-mcp-client / dsh-hook-protocol / Cordis 生命周期
          │
          ▼
DSH
```

`adapters` 和 `runtime` 不读取 Claude Code/Codex 原始配置。生态差异必须先由 `parser` 转换为统一结构。

## 已实现功能

### Source

- Git URL、`github:owner/repo#ref`、本地目录、ZIP、TAR、TGZ/TAR.GZ。
- Claude Code `.claude-plugin/marketplace.json`。
- Codex `.agents/plugins/marketplace.json`。
- 同一个 Source 同时存在两种 Marketplace。
- 同名同真实目录条目合并；同名不同目录或语义冲突明确报错。
- 无 Marketplace 时识别 Source 根目录中的单插件。
- 压缩包仅允许去掉一层唯一包装目录。
- `--path` 作为非标准目录结构的显式兜底，不递归猜测。
- 显式 Source 与隐式 Source、引用计数、共享 Source 生命周期。
- 共享 Source 整体更新、全部受影响 Plugin 重新解析、原子切换与整体回滚。
- Marketplace 外部 Git/git-subdir Plugin 归 Source 所有并使用 Source 专属缓存。

### Plugin

- 一次选择一个或多个 Plugin 原子安装；任一目标失败则全部不提交。
- Plugin 整体启用、禁用、更新、检查、列表和卸载。
- `state.json` 只控制整个 Plugin 的 `enabled` 与 `priority`。
- 一个 Plugin 对应一个父 Cordis 运行实例，内部能力随父实例一起释放。
- 安装成功与启用成功分离；有静态 `error` 时保留安装记录并保持禁用。
- MCP、Skill、Command 等名称冲突明确诊断，不自动改名或静默覆盖。
- 0.1.x 单插件存储布局的保守自动迁移。

### 运行能力

- Claude Code / Codex Skill 发现、frontmatter 解析、动态 Skill Provider、正文和资源按需读取。
- MCP stdio 与 streamable-http，通过 DSH 的 `dsh-mcp-client` 子插件接入。
- Claude Code / Codex Hook parser、`command + args` 参数边界、DSH 事件映射、matcher、超时、取消、stdout/退出码处理与结果合并。
- Codex Stop payload 从当前 DSH turn 的最后一条 `assistant/message` 提取 `last_assistant_message`；无文本时才传 `null`。
- Command / Agent 可识别并产生明确 warning；0.2.x 不执行。
- Claude Code Workflow、Output Style、LSP、Theme、Monitor、Channel、userConfig、插件依赖等未可靠适配能力均有结构化诊断。
- Codex 现行顶层 `skills`、`hooks`、`mcpServers`、`apps` 与 Marketplace 扁平 manifest 回退。
- Codex 自定义 Skill、Hook、MCP 路径按当前规范补充默认发现；多个 Marketplace Plugin 共用 Source 根目录时，以条目显式路径作为 Plugin 边界。
- 未定义的 `paths` 包装字段明确报错，不会被误当成当前 Codex 插件 JSON 规范。

## 环境要求

- Node.js：`^22.19.0` 或 `>=24.0.0`。
- DeepSeek Harness：本版本按 `0.0.1-rc.5` 的公开接口核对。
- Git：仅 Git Source 或 Marketplace 外部 Git Plugin 需要。

## 安装到 DSH profile

发布包是 DSH bundle，`package.json` 声明 `dsh.bundle.patch`，并包含 `cordis.patch.yml`：

```bash
dsh plugin --profile <profile-name> add ./dsh-compat-0.2.2.tgz
```

启动该 profile 后，插件会在 `ctx.compat` 暴露服务，并按稳定顺序恢复已启用 Plugin。

从源码构建：

```bash
npm run verify
npm pack --ignore-scripts
```

## 独立管理 CLI

本项目不修改 DSH 启动器，因此独立命令是 `dsh-compat`，不是伪造的 `dsh compat`。

### 管理 Source

```bash
dsh-compat source add https://github.com/example/plugins.git --as example-market
dsh-compat source list
dsh-compat source inspect example-market
dsh-compat source update example-market
dsh-compat source remove example-market
```

`source add` 创建显式 Source。显式 Source 在没有安装 Plugin 时仍会保留，只有用户主动删除才消失。

### 从单插件 Source 安装

```bash
dsh-compat install ./legacy-plugin
dsh-compat install ./legacy-plugin.zip
dsh-compat install github:owner/repo#v1.2.0
```

直接 `install` 会创建隐式 Source。最后一个引用该隐式 Source 的 Plugin 卸载后，Source 自动删除。

### 从多插件 Marketplace 安装

交互终端会显示准确的 Plugin 列表并要求选择，不会默认全部安装。CI 或无交互环境必须显式选择：

```bash
dsh-compat install ./plugin-market \
  --plugin plugin-a \
  --plugin plugin-c
```

也可以先添加 Source，再按 `plugin@source` 安装：

```bash
dsh-compat source add ./plugin-market --as official
dsh-compat install plugin-a@official
```

非标准目录只能显式使用 `--path`，且 Source 中不能已有受支持 Marketplace：

```bash
dsh-compat install ./monorepo --path packages/plugin-a --path packages/plugin-b
```

### 管理 Plugin

```bash
dsh-compat list
dsh-compat inspect plugin-a
dsh-compat disable plugin-a
dsh-compat enable plugin-a
dsh-compat update plugin-a --yes
dsh-compat uninstall plugin-a
```

如果 Plugin 与其他已安装 Plugin 共用 Source，`update plugin-a` 实际会更新整个 Source。交互 CLI 会显示受影响 Plugin；无交互环境必须传入 `--yes`。

独立 CLI 是离线管理器，不连接已经运行的 DSH 进程。正在运行的 profile 应优先通过 `ctx.compat` 操作，或者先停止 DSH 再用 CLI 修改启用状态、更新或卸载。

## DSH 服务 API

其他插件可声明：

```ts
export const inject = ['compat']
```

然后使用：

```ts
ctx.compat.sourceAdd(source, options?)
ctx.compat.sourceRemove(sourceId)
ctx.compat.sourceUpdate(sourceId, options?)
ctx.compat.sourceList()
ctx.compat.sourceInspect(sourceId)

ctx.compat.install(sourceOrSourceId, options?)
ctx.compat.update(pluginId, options?)
ctx.compat.enable(pluginId)
ctx.compat.disable(pluginId)
ctx.compat.uninstall(pluginId)
ctx.compat.list()
ctx.compat.inspect(pluginId)
```

服务 API 会直接通知运行管理器，适合对正在运行的 DSH 实例执行生命周期操作。

## 配置

| 字段 | 含义 | 默认值 |
|---|---|---:|
| `harnessHome` | Harness Home；省略时读取 `DSH_HOME` 或 `~/.dsh` | 环境决定 |
| `workspaceRoot` | MCP 启动与无会话 Hook 的默认工作区 | 当前进程目录 |
| `autoStart` | 启动时恢复 `state.json.enabled` 的 Plugin | `true` |
| `hookDefaultTimeoutMs` | Hook 未声明超时时的默认毫秒数 | `600000` |
| `hookStderrSummaryMaxChars` | Hook 记录中的 stderr 摘要字符上限 | `500` |
| `codexModel` | Codex Hook payload 中的模型名 | 空字符串 |

## 存储布局

```text
$DSH_HOME/dsh-compat/
├── sources/
│   └── <sourceId>/
│       ├── source.json       # 来源、ownership、revision、Git commit/归档哈希
│       ├── scan.json         # Marketplace/Source parser 缓存
│       ├── package/          # 完整 Source，只保存一份
│       └── cache/
├── installed/
│   └── <pluginId>/
│       ├── install.json      # sourceId + sourcePluginId + pluginPath/location
│       ├── state.json        # 整个 Plugin 的 enabled / priority
│       ├── scan.json         # CompatPlugin 缓存
│       ├── data/             # 更新时保留，卸载时删除
│       └── cache/            # 可重建
├── external/
│   └── <sourceId>/           # Marketplace 外部 Git Plugin，仍由 Source 所有
├── temp/
└── locks/
```

Plugin 安装不会把源码复制到 `installed/<pluginId>/package/`。事实真源始终是 Source 中的原始 Plugin 文件。

## 诊断与运行状态

- `error`：Plugin 可以安装和检查，但不能自动启用。
- `warning`：可以运行，但存在必须公开的兼容差异。
- `info`：发现和规范化信息。

运行状态：`disabled`、`starting`、`running`、`degraded`、`failed`、`stopping`。

`degraded` 表示部分能力失败，Plugin 仍是一个整体；不会因此把失败能力拆成独立管理项。如果全部可运行能力失败，父运行实例会被释放，避免残留部分注册。

## 安全模型

- 安装阶段默认只允许 clone、copy、extract、read、parse、validate。
- 不执行 `npm install`、`pnpm install`、`prepare`、`postinstall`、`setup.sh` 或插件自带安装脚本。
- Git 通过对象导出取得内容，不创建工作树，不触发 checkout 或 smudge/filter。
- 归档检查路径穿越、绝对路径、Windows 盘符、符号链接、CRC、成员数量与体积预算。
- Git URL 不允许内嵌凭据、查询参数或 fragment。
- Token、API Key、Header 和敏感配置按引用/延迟指针保存，不写入 scan、日志或 inspect 输出。
- Source 与 Plugin 操作使用文件锁、临时目录和原子重命名；共享更新失败时整体回滚。

详见 [安全模型](docs/SECURITY.md)。

## 验证

```bash
npm run verify
```

执行严格 TypeScript 编译、全部自动化测试、CLI 冒烟、DSH bundle 清单和 `npm pack --dry-run` 发布白名单检查。

在已安装目标 DSH peerDependencies 的 profile 或源码 checkout 中运行：

```bash
npm run verify:dsh
```

该探针核对 Cordis、Schemastery、Hook Protocol、MCP Client 和 `dsh-compat` 入口的关键导出契约。当前容器是否具备这些真实依赖，以 [验证报告](docs/VALIDATION-REPORT.md) 的实际输出为准。

## 文档

- [架构与生命周期](docs/ARCHITECTURE.md)
- [使用与运维](docs/USAGE.md)
- [兼容矩阵](docs/COMPATIBILITY.md)
- [从 0.1.x 迁移](docs/MIGRATION.md)
- [安全模型](docs/SECURITY.md)
- [测试策略](docs/TESTING.md)
- [验证报告](docs/VALIDATION-REPORT.md)

## 明确边界

0.2.x 不重新实现 Claude Code 或 Codex Runtime，不修改原插件源码，不自动重命名能力，不递归扫描整个仓库猜插件，不自动安装 Marketplace 新增 Plugin，不把 Bash 猜测翻译为 PowerShell，也不执行 Command/Agent。无法可靠兼容的行为必须通过诊断公开。

## 许可证

MIT
