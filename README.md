# 插件桥 / Plugin Bridge

[![npm version](https://img.shields.io/npm/v/%40rvaim%2Fdsh-plugin-bridge.svg)](https://www.npmjs.com/package/@rvaim/dsh-plugin-bridge)
[![license](https://img.shields.io/npm/l/%40rvaim%2Fdsh-plugin-bridge.svg)](LICENSE)

插件桥（Plugin Bridge）是 DeepSeek Harness（DSH）的外部插件管理工具，支持独立 Agent Plugins 1.0.0、传统 Codex 与 Claude Code 插件。插件作为完整生命周期单元接入 DSH，复用 Source 快照、Skill Provider 和 MCP 子实例。

> 当前版本 `0.10.2`；从 `0.10.0` 起采用每个安装实例固定一个解析器的安装契约。Plugin parser / Source parser 均为 `6.0.0`，Claude Code / Codex 实现均为 `1.3.0`，Agent Plugins 实现保持 `1.2.0`。具体契约见[单解析器选择与安装契约](<docs/单解析器选择与安装契约.md>)，目录边界见[解析器解耦重构说明](<docs/解析器解耦重构说明.md>)。独立格式基线：[Agent Plugins 1.0.0](<docs/Agent Plugins 1.0.0 兼容说明.md>)；传统格式基线：**Codex 0.163.0、Claude Code 2.1.304**。2026-10-22 的市场资料核对属于既有阶段，证据与限制见[市场发现与选择安装验证报告](<docs/市场发现与选择安装验证报告.md>)及[传统插件兼容矩阵](<docs/传统插件兼容矩阵.md>)。
>
> 从 `0.6.0` 起，仅支持 `package.json#engines.dsh` 声明的 DSH 版本；SDK、Hook Protocol 与 Typert 生成器固定为同一基线。管理入口位于侧边栏，主区域显示独立面板；不保留旧 DSH API、旧 codec 或设置页入口。历史阶段的验证事实见[协议兼容验证报告](docs/插件协议兼容验证报告.md)。

![DSH Web 插件桥管理页，展示多个已启用的 Claude Code 与 Codex 插件](https://raw.githubusercontent.com/rvaim/dsh-plugin-bridge/main/docs/assets/compat-settings.png)

## 安装

要求 Node.js `^22.19.0` 或 `>=24.0.0`；使用 Git 来源时还需要 Git。

从 npm 安装指定版本：

```bash
dsh plugin --profile web add @rvaim/dsh-plugin-bridge@0.10.2
```

也可以使用本地构建包：

```bash
npm install
npm run verify
npm pack --ignore-scripts
dsh plugin --profile web add /absolute/path/rvaim-dsh-plugin-bridge-0.10.2.tgz
```

公开发布地址：[npm：@rvaim/dsh-plugin-bridge](https://www.npmjs.com/package/@rvaim/dsh-plugin-bridge)。当前基线以 `package.json#engines.dsh` 为准，不提供旧 DSH 版本兼容。

把 `web` 换成实际 profile 名称即可。首次安装或升级插件桥后，Desktop 用户应保存工作，完整退出并重启 DeepSeek Harness，再重新打开插件桥；仅刷新页面不会清除进程内缓存的 Host 契约。

## 0.10.2 DSH 基线升级

- 本版仅支持 DSH `0.2.1-rc.3`，`engines.dsh`、DSH SDK、Hook Protocol 和 Typert 生成器均固定到该版本。
- 从升级后的 SDK 重新生成严格 Host/Remote 通信产物，并验证实际安装器判定、注册器及 RPC 往返；不使用版本豁免。
- 已有单解析器安装契约保持。安装或升级插件桥本体后，保存工作并完整退出、重启 DeepSeek Harness。

## 0.10.1 安装接口同步检查

- 添加来源、上传归档、确认插件或解析器前，先检查运行中 Host 的真实入参校验器。
- 页面与 Host 契约不同步时，在任何安装业务请求前停止，并显示完整退出重启的明确提示；不转成旧字符串数组，不忽略严格校验。
- 如果遇到 `wire field "plugins" failed boundary validation`，先完整重启 Harness。磁盘包已经升级不表示旧进程里的 Typert schema 已更换；无需为这个问题删除市场来源或插件数据。

## 0.10.0 单解析器选择

- 单一匹配可自动选定；多个匹配必须明确选择，禁用选项同时显示依据与诊断。
- `InstallOptions.plugins` 改为 `{ pluginId, parserId? }[]`。分步完成接口返回 `parser-selection` 或 `installed`，通用 UI 只展示解析器提供的信息。
- 安装记录必填 `InstallMetadata.parserId`；旧 `string[]` 参数与旧安装记录不迁移、不兼容。升级前备份插件数据，再按新契约重新安装；不要编辑缓存冒充迁移。Source / Plugin 扫描缓存均要求解析器快照。
- 元数据、权限、Skill sidecar、MCP 环境绑定及 Hook 方言均来自选定解析器，不再做跨格式 alias merge。
- 外部插件在选中后获取，解析器选择期间固定内容；同一准备会话重试复用内容，取消时释放。
- 更新继续使用已存解析器；缺失或不再匹配时明确拒绝，不回退到其他平台。

完整 API、兼容边界与当前验证记录见[单解析器选择与安装契约](<docs/单解析器选择与安装契约.md>)。历史报告只证明其记录的阶段。

## 0.9.0 市场发现与选择安装（历史功能）

- 自动识别根市场，以及解析器声明范围内的子目录市场；正确定位仓库内子插件与外部 Git/git-subdir 插件。
- 市场即使只有一个候选也先显示选择列表，用户确认后只安装所选项；列表展示实际来源位置和诊断。
- 解析器声明规则，安装层返回 `selectionRequired`，通用 UI 消费结果；新增或移除解析器无需增加厂商分支。
- 服务 API 的市场安装必须显式传入 `plugins`；分步安装调用方需处理新增的必填 `selectionRequired`。独立单插件保留直接安装。
- 外部 Git 仅在确认选中后获取并记录 commit；市场识别不代表第三方 Hook 或 MCP 已通过运行验收。完整边界见[专项报告](docs/市场发现与选择安装验证报告.md)。

## 0.8.1 修复内容

- 同一诊断不再重复显示：候选诊断与来源汇总去重，插件行错误/警告计数与实际条目一致。
- Agent Plugins 警告给出具体名称，例如被忽略的扩展命名空间与被忽略的旧格式目录。
- 诊断面板新增单条和全部复制，诊断正文与详情支持选择文本，复制结果有明确反馈。
- Windows 上提交来源目录的 rename 增加有限重试，避免实时扫描短暂占用造成的偶发添加失败。

## 0.8.0 修复内容

- 修复省略 `parsers` 配置时装配零个解析器的问题；默认启用全部内置解析器，显式 `[]` 仍关闭全部协议。
- Git 来源改用单条持久 `git cat-file --batch` 批量读取对象，避免每个文件启动两个 Git 子进程；Git 暂存元数据移到系统短临时目录，避免 Windows 深路径失败。
- 添加弹窗的“取消”在拉取期间可用；取消信号贯通 Remote、Manager、来源获取、导出和子进程，子进程树退出后才清理临时目录。
- 根插件使用稳定来源种子生成管理 ID，不再受 `acquired-source` 与 `package` 两个暂存目录名影响。
- 根 `plugin.json` 仅在声明 Agent Plugins schema 时参与独占识别，普通根 JSON 不再遮住 Claude Code／Codex 清单。
- 候选列表显示完整阻断诊断。插件数据目录统一为 `$DSH_HOME/dsh-plugin-bridge/`。

## 使用

1. 启动 profile，在 DSH Web 侧边栏点击“插件桥”，在主区域打开管理面板。
2. 点击“添加”，输入 Git URL、`github:owner/repo#ref`、本地目录或 ZIP/TAR/TGZ 归档。
3. Marketplace 来源先显示插件复选列表；独立单插件省略这一步。取得选中插件内容后，唯一匹配可自动选定，多个匹配则等待选择一个解析器。准备会话固定市场快照和已取得的外部插件 commit，重试选择不会再次 clone。
4. 使用开关在线启用或停用整个插件；使用删除按钮卸载。错误或警告数量可以展开查看说明、诊断代码、能力类型与关联文件。
5. 点击刷新会检查每个已安装插件所属 Source 的最新 revision；有更新时插件行会显示“更新”按钮，点击后在当前进程中更新并重启该插件。

旧插件的添加、启用、停用和卸载会立即作用于当前 DSH 进程，通常无需重启。只有安装、升级或删除 `@rvaim/dsh-plugin-bridge` 本体时需要重启 profile。

列表支持按名称、ID 或来源搜索，以及已启用、已停用、需要关注和可更新筛选。更新检查独立于列表显示；检查或刷新失败会保留已知数据并提供重试。共享 Source 更新前会列出受影响插件，确认后才提交。

本包不提供独立 CLI。常用操作在侧边栏打开的管理面板完成；批量与自动化场景使用 `ctx.pluginBridge` 服务 API。

## 服务 API

其他 DSH 插件可以声明：

```ts
export const inject = ['pluginBridge']
```

然后调用：

```ts
ctx.pluginBridge.sourceAdd(source, options?)
ctx.pluginBridge.sourceRemove(sourceId)
ctx.pluginBridge.sourceUpdate(sourceId, options?)
ctx.pluginBridge.sourceList()
ctx.pluginBridge.sourceInspect(sourceId)

ctx.pluginBridge.prepareInstall(source, options?)
ctx.pluginBridge.prepareArchiveInstall(archivePath)
ctx.pluginBridge.listCategories()
ctx.pluginBridge.completeInstallPreparation(preparationId, plugins)
ctx.pluginBridge.releaseInstallPreparation(preparationId)
ctx.pluginBridge.install(sourceOrSourceId, options?)
ctx.pluginBridge.checkUpdates()
ctx.pluginBridge.update(pluginId, options?)
ctx.pluginBridge.enable(pluginId)
ctx.pluginBridge.disable(pluginId)
ctx.pluginBridge.uninstall(pluginId)
ctx.pluginBridge.list()
ctx.pluginBridge.inspect(pluginId)
```

服务 API 的 `plugins` 使用对象数组，例如 `[{ pluginId: 'plugin-a', parserId: 'codex' }]`。`completeInstallPreparation` 返回 `{ kind: 'parser-selection', plugins: ParserChoiceRequest[] }` 或 `{ kind: 'installed', result }`；前一种结果继续保留准备会话，提交同一组插件的选择后才能完成。省略 `parserId` 只允许唯一匹配。接口示例见[安装契约](<docs/单解析器选择与安装契约.md>)。

服务 API 直接通知运行管理器，适合对正在运行的 DSH 实例执行生命周期操作。服务注入名为 `pluginBridge`，Web RPC namespace 为 `pluginBridgeAdmin`，Client locale namespace 为 `pluginBridge`，侧边栏 ID 与主面板 key 均为 `plugin-bridge`；不保留设置页入口或旧 Client namespace 别名。内部 `Compat*` 类型和 `parseCompat*` 函数保留原名。

## Source 与 Plugin

项目区分两个管理概念：

```text
Source = Git 仓库、本地目录或压缩包；负责获取、缓存和整体更新内容
Plugin = Source 中的一个具体旧插件；负责安装、启用、禁用、运行和卸载
```

一个 Source 可以包含一个或多个 Plugin。Skill、MCP、Hook、Agent、Command 都只是 Plugin 内部能力，不会成为独立安装项，也不会被复制到 DSH 的全局目录。

```text
Git / Directory / ZIP / TAR / TGZ
                 │
                 ▼
             Source parser
 Claude Marketplace / Codex Marketplace / 单插件 / paths
                 │
                 ▼
          Source 中的 1..N Plugin
                 │
                 ▼
             matchPlugin → 选定一个 Plugin parser
       Skill / MCP / Hook / 路径与配置语义
                 │
                 ▼
             CompatPlugin
                 │
                 ▼
 Skill Provider / MCP Client / Hook Protocol / Cordis 生命周期
                 │
                 ▼
                 DSH
```

[runtime/adapters](<src/runtime/adapters/>) 与运行层不直接读取 Claude Code / Codex 原始配置；生态差异先由 parser 转换为统一结构。

## 能力范围

### Source

- 支持 Git URL、`github:` 简写、本地目录和 ZIP/TAR/TGZ。
- 支持 Claude Code `.claude-plugin/marketplace.json`、Codex `.agents/plugins/marketplace.json` 及混合 Marketplace。
- 根市场和根显式插件清单优先；两者都不存在时，按解析器声明最多深入 4 层、检查 4096 个目录寻找市场标记。不跟随目录符号链接，遇到市场或显式插件边界即停止向下。嵌套发现是插件桥扩展，不表示上游要求递归扫描。
- 本地候选相对市场根解析，缓存和配置引用保持相对 Source 仓库根。多个市场合并候选；同格式同 ID 的跨市场条目会阻止安装。
- 无 Marketplace 时识别 Source 根目录中的单插件；`paths` 可显式处理非标准目录，不猜测未列出的插件目录。
- 支持显式/隐式 Source、引用计数、共享 Source 整体更新、原子切换和整体回滚。
- 市场候选必须经用户选择；UI 消费 `selectionRequired` 与后续 `parser-selection` 结果。未选中的外部 Git/git-subdir 不联网；选中后才解析 `ref`/HEAD、获取并记录 commit，声明的 `sha` 固定目标。外部插件仍归所属 Source 管理。npm、远端 archive、command 来源保留既有未适配诊断。

### Plugin

- 一次原子安装一个或多个 Plugin；任一目标失败则全部不提交。
- 整体启用、禁用、更新、检查和卸载；一个 Plugin 对应一个父 Cordis 运行实例，安装记录固定一个 `parserId`。
- 多匹配必须明确选择；只采用选定平台的 metadata、policy 与能力，不再跨格式合并 Skill、MCP binding 或 Hook 方言。
- 安装成功与启用成功分离；目录策略、清单预检和选择错误在提交前拒绝，完整能力解析的 `error` 可保留安装记录并阻止启用。
- MCP、Skill、Command 等名称冲突会产生明确诊断，不自动改名或静默覆盖。

### 运行能力

- Claude Code / Codex Skill 发现、frontmatter、动态 Skill Provider，以及正文和资源按需读取。
- MCP stdio 与 streamable-http，通过 DSH `dsh-mcp-client` 接入。
- Claude Code / Codex Hook parser、参数边界、事件映射、matcher、超时、取消、stdout/退出码和结果合并。
- Codex Stop Hook 通过当前 DSH session projection 提取本轮最后一条 `assistant/message` 作为 `last_assistant_message`。
- 当前 DSH 公开持久化 API 不提供 transcript 文件路径，`transcript_path` 按协议配置为空字符串或 `null`；不猜测内部存储路径。
- Command / Agent 可识别并产生 warning，但当前版本不执行。
- Workflow、Output Style、LSP、Theme、Monitor、Channel、userConfig、插件依赖等未可靠适配能力会产生结构化诊断。

## 配置

| 字段 | 含义 | 默认值 |
|---|---|---:|
| `harnessHome` | Harness Home；省略时读取 `DSH_HOME` 或 `~/.dsh` | 环境决定 |
| `workspaceRoot` | MCP 启动与无会话 Hook 的默认工作区 | 当前进程目录 |
| `autoStart` | 启动时恢复 `state.json.enabled` 的 Plugin | `true` |
| `parsers` | 参与解析的已装配实现 id；`[]` 不启用任何解析器 | 全部已装配实现 |
| `hookDefaultTimeoutMs` | Hook 默认超时覆盖值；省略时 CC UserPromptSubmit 为 30 秒，其余已适配事件为 600 秒 | 事件规则 |
| `hookStderrSummaryMaxChars` | Hook 记录中的 stderr 摘要字符上限 | `500` |
| `modelName` | Hook 运行配置要求提供模型字段时使用的名称 | 空字符串 |

## 存储布局

```text
$DSH_HOME/dsh-plugin-bridge/
├── sources/<sourceId>/
│   ├── source.json       # 来源、ownership、revision、commit/归档哈希
│   ├── scan.json         # Source parser 缓存
│   ├── package/          # 完整 Source，只保存一份
│   └── cache/
├── installed/<pluginId>/
│   ├── install.json      # sourceId + sourcePluginId + parserId + location
│   ├── state.json        # 整个 Plugin 的 enabled / priority
│   ├── scan.json         # CompatPlugin 缓存
│   ├── data/             # 更新时保留，卸载时删除
│   └── cache/            # 可重建
├── external/<sourceId>/  # Marketplace 外部 Git Plugin
├── temp/
└── locks/
```

Plugin 安装不会把源码复制到 `installed/<pluginId>/package/`；事实真源始终是 Source 中的原始文件。

## 诊断与状态

- `error`：阻止启用；目录策略、清单预检及选择错误也会阻止提交安装。
- `warning`：可以运行，但存在公开的兼容差异。
- `info`：发现和规范化信息，仅保留在 Host 侧。

重新检查跨插件名称冲突时，只重算 `MCP_SERVER_NAME_CONFLICT`、`SKILL_NAME_CONFLICT`、`COMMAND_NAME_CONFLICT`、`AGENT_NAME_CONFLICT` 四个代码；包括 `HOOK_TIMEOUT_CONFLICT` 在内的其他协议诊断保留。

运行状态包括 `disabled`、`starting`、`running`、`degraded`、`failed`、`stopping`。`degraded` 表示部分能力失败，但 Plugin 仍作为整体管理；全部可运行能力失败时会释放父运行实例。

## 安全模型

- 安装阶段只 clone、copy、extract、read、parse、validate，不执行来源中的安装或构建脚本。
- Git 通过对象导出取得内容，不创建工作树，不触发 checkout 或 smudge/filter。
- 归档检查路径穿越、绝对路径、Windows 盘符、符号链接、CRC、成员数量和体积预算。
- Git URL 不允许内嵌凭据、查询参数或 fragment。
- Token、API Key、Header 等敏感配置使用引用或延迟指针，不写入 scan、日志或 inspect 输出。
- Source 与 Plugin 操作使用文件锁、临时目录和原子重命名；共享更新失败时整体回滚。

详见[安全模型](docs/安全模型.md)。

## 开发与验证

```bash
npm install
npm run verify
npm pack --ignore-scripts
```

`npm run verify` 执行严格 TypeScript 编译、自动化测试、DSH Client/Typert 构建、真实 SDK 的 Host/Client 注册与 RPC 往返、八种解析器组合的物理移除编译/公共入口加载，以及发布白名单检查。`npm run verify:parsers` 可单独重跑可移除性验收。`npm run verify:dsh` 会检查 SDK 与目标版本一致、当前安装器接受包清单、旧 codec 被拒绝、非法 RPC 参数被拦截和卸载后 namespace 被撤回；使用内存载体，不修改用户 profile，也不代表浏览器视觉实测通过。

## 文档

- [核心架构优化实施与验收](docs/核心架构优化实施.md)
- [架构与界面优化审查](docs/架构与界面优化审查.md)
- [单解析器选择与安装契约](<docs/单解析器选择与安装契约.md>)
- [解析器解耦重构说明](docs/解析器解耦重构说明.md)
- [解析器解耦验证报告](docs/解析器解耦验证报告.md)

- [Agent Plugins 1.0.0 兼容说明](<docs/Agent Plugins 1.0.0 兼容说明.md>)
- [Agent Plugins 1.0.0 验证报告](<docs/Agent Plugins 1.0.0 验证报告.md>)
- [传统插件解析兼容方案](docs/传统插件解析兼容方案.md)
- [传统插件兼容矩阵](docs/传统插件兼容矩阵.md)
- [市场发现与选择安装验证报告](docs/市场发现与选择安装验证报告.md)
- [本轮协议兼容验证报告](docs/插件协议兼容验证报告.md)
- [架构与生命周期](docs/架构与生命周期.md)
- [使用与运维](docs/使用与运维.md)
- [安全模型](docs/安全模型.md)
- [测试策略](docs/测试策略.md)
- [历史版本验证报告](docs/历史版本验证报告.md)

## 明确边界

本项目不重新实现 Claude Code 或 Codex Runtime，不修改旧插件源码，不自动重命名能力，不递归扫描整个仓库猜测插件，不自动安装 Marketplace 新增 Plugin，不把 Bash 猜测翻译为 PowerShell，也不执行 Command / Agent。无法可靠兼容的行为会通过诊断公开。发现 ReMe 等仓库中的市场或插件，不代表其中依赖 Claude Code 专用环境的 auto-memory 等功能已能在 DSH 工作；运行能力仍须逐项验证。

## 许可证

[MIT](LICENSE)
