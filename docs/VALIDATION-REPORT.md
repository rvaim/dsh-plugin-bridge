# dsh-compat 0.2.2 验证报告

验证日期：2026-08-15  
交付版本：`0.2.2`  
统一内部结构：`schemaVersion = 1`  
Plugin parser 版本：`2.0.1`  
Source parser 版本：`2.0.0`

## 1. 验证结论

`dsh-compat 0.2.2` 已按新版 **Source / Plugin 分离模型**完成实现与回归验证，并修复 Codex Stop payload 丢失最后一条助手文本、Claude Hook `args` 被忽略，以及发布包缺少 Hook Protocol 的问题。一个 Source 可以承载一个或多个旧 Plugin，Source 负责原始内容和整体更新，Plugin 负责安装、启用、禁用、运行与卸载；Skill、MCP、Hook、Agent、Command 始终只是 Plugin 内部能力。

最终发布级验证结果：

```text
TypeScript strict 编译：通过
自动化测试：103 / 103 通过
失败：0
跳过：0
Node 实验性覆盖率：
  行覆盖率：85.37%
  分支覆盖率：75.70%
  函数覆盖率：91.04%
DSH bundle manifest：通过
独立 CLI 冒烟：通过
npm pack dry-run：通过
发布文件白名单：通过
发布文件数量：433
真实 DSH rc.5 契约探针：通过
真实 dsh plugin profile 安装：通过
安装后 Hook Protocol 动态导入：通过
真实 ReMe 清单与隔离 launcher 冒烟：通过
```

这里的“103 项通过”包括 Source parser、Plugin parser、manager、runtime/adapters、CLI、Git、归档安全、锁、事务、发布结构，以及真实 `@deepseek-ai/dsh-hook-protocol` 的加载、执行和实际 Hook adapter 阻止工具调用的契约测试。Hook adapter 的 DSH 事件分发仍主要通过可控 Context 验证；另以真实 ReMe 插件清单和 launcher 做了隔离子进程冒烟，但本报告不会将其扩大表述为真实 DSH agent 会话端到端通过。

## 2. 验证环境

| 项目 | 实际值 |
|---|---|
| 操作系统 | macOS Darwin `25.5.0` arm64 |
| Node.js（执行编译和测试） | `v25.8.0` |
| npm | `11.19.0` |
| pnpm | `11.19.0` |
| TypeScript | `5.9.3` |
| Git | `2.50.1 (Apple Git-155)` |
| 对照的 DeepSeek Harness 版本 | `0.0.1-rc.5` |
| 发布包 Node.js engines | `^22.19.0 || >=24.0.0` |

本次验证使用 Node.js `25.8.0`，位于发布包声明的 `>=24.0.0` 支持范围内。

### 2.1 DSH profile 安装复验

本次使用 DSH `0.0.1-rc.5` 自身的 `dsh plugin` 命令创建临时 profile 并安装发布 tarball。该 profile 由 DSH 生成以下 pnpm 策略：

```text
nodeLinker: hoisted
autoInstallPeers: false
```

安装结果包含 `dsh-compat@0.2.2 → @deepseek-ai/dsh-hook-protocol@0.0.1-rc.5`，`--dump-config` 成功并包含 `dsh-compat` bundle 条目，随后从 profile 内的已安装 `dsh-compat` 动态导入 Hook Protocol 并核对关键导出成功。该复验直接覆盖 0.2.0 发布包中 optional peer 未安装的回归点。

## 3. 执行的发布级命令

### 3.1 一键验证

```bash
npm run verify
```

该命令依次执行：

1. 清理旧的 `dist/`；
2. 使用 TypeScript strict 模式编译源码和测试；
3. 对编译后的测试执行 Node.js test runner；
4. 检查 `package.json`、bin、Node engines、`dsh.bundle` 与 `cordis.patch.yml`；
5. 对独立 CLI 执行 help 冒烟；
6. 执行 `npm pack --dry-run --json --ignore-scripts`；
7. 检查 npm 运行包只包含允许发布的文件，不包含 `src/`、`test/`、`dist/test/` 或 `node_modules/`。

本次结果：

```text
tests 103
pass 103
fail 0
cancelled 0
skipped 0
todo 0
包结构、DSH bundle、CLI 与 344 个发布文件检查通过
```

### 3.2 覆盖率

```bash
node --test \
  --experimental-test-coverage \
  --test-coverage-include='dist/src/**/*.js' \
  --test-reporter=spec \
  dist/test/**/*.test.js
```

结果：

| 指标 | 覆盖率 |
|---|---:|
| 行 | 85.40% |
| 分支 | 76.26% |
| 函数 | 90.79% |

覆盖率由 Node.js 内置实验性覆盖率功能产生，并通过 `--test-coverage-include` 限定到本项目 `dist/src`，避免把新增的外部 Hook Protocol 运行依赖计入本项目覆盖率。覆盖率不是功能正确性的单独证明，最终判断以行为断言、故障注入、事务回滚和发布包回验共同构成。

### 3.3 真实 DSH 契约探针

```bash
npm run verify:dsh
```

安装目标 DSH `0.0.1-rc.5` 依赖后执行探针，核对以下模块：

```text
@deepseek-ai/cordis
@deepseek-ai/schemastery
@deepseek-ai/dsh-hook-protocol
@deepseek-ai/dsh-mcp-client
```

探针结果：

```text
真实 DSH 关键导出契约检查通过
```

此外，已从真实 DSH profile 中的已安装发布包再次执行同一探针并通过。该结果证明关键模块可解析且导出契约匹配；真实远端 MCP 网络握手和真实 agent 会话中的第三方 Hook 子进程执行仍未纳入本次自动烟测。

### 3.4 真实 ReMe Hook 隔离冒烟

使用本机已安装的 ReMe 双格式插件原始清单执行隔离测试，结果如下：

```text
Claude UserPromptSubmit：command + 4 个 args 完整解析并执行，exitCode 0，无 Node SyntaxError
Codex UserPromptSubmit：保存 turn_id=1 的用户问题“测试问题 4567”
Codex Stop：接收 last_assistant_message“测试回复 4567”
ReMe pending job：messages 同时包含上述用户问题和助手回复
```

冒烟使用独立临时 `HOME`/`PLUGIN_DATA`，并将 MCP 端口指向不可连接的隔离端口，因此不会向用户的真实 ReMe 记忆库写入测试内容。它证明真实 ReMe launcher 能消费修复后的命令与 payload；DSH agent 事件到真实 Hook 子进程的完整在线链路仍需在目标 profile 重启后验证。

## 4. 新版架构验证

### 4.1 Source 与 Plugin 分离

已验证以下长期边界：

```text
Source
= Git / Directory / ZIP / TAR / TGZ 的获取、缓存和整体更新单位

Plugin
= Source 中具体旧插件的安装、启用、禁用、运行和卸载单位

Skill / MCP / Hook / Agent / Command
= Plugin 内部能力
```

存储布局：

```text
$DSH_HOME/dsh-compat/
├── sources/
│   └── <sourceId>/
│       ├── source.json
│       ├── scan.json
│       ├── package/
│       └── cache/
├── installed/
│   └── <pluginId>/
│       ├── install.json
│       ├── state.json
│       ├── scan.json
│       ├── data/
│       └── cache/
├── external/
│   └── <sourceId>/
├── temp/
└── locks/
```

已验证 Plugin 安装记录只引用 Source 中的真实目录，不把源码复制到 `installed/<pluginId>/package/`。同一 Source 中多个 Plugin 共用一份完整原始内容。

### 4.2 多插件 Marketplace

已验证：

- Claude Code `.claude-plugin/marketplace.json`；
- Codex `.agents/plugins/marketplace.json`；
- 同一 Source 同时存在两种 Marketplace；
- 同一 `pluginId`、同一真实目录的双格式条目合并；
- 同名不同目录明确冲突；
- 同目录但关键语义冲突明确阻止安装或启用；
- Marketplace 损坏、字段缺失或路径无效时，不退化为递归猜测；
- Marketplace 中没有列出的仓库目录不会被递归识别为插件；
- 无 Marketplace 时只检查 Source 根目录是否为单插件；
- 压缩包只允许剥离一层唯一包装目录；
- `--path` 只作为显式兜底，仍进入正常 parser 验证；
- 一次选择多个 Plugin 时实行全有或全无事务；
- 新 Marketplace 候选在 Source 更新后只进入可安装列表，不自动安装。

### 4.3 显式与隐式 Source

已验证：

- `source add` 创建 `ownership = explicit` 的 Source；
- 显式 Source 引用归零后仍保留；
- 仍有已安装 Plugin 引用时拒绝删除 Source；
- 直接 `install <source>` 创建 `ownership = implicit` 的 Source；
- 最后一个 Plugin 卸载后，隐式 Source 自动删除；
- 损坏或不可读的 `install.json` 会触发保守策略，阻止 Source 误删；
- 卸载共享 Source 中一个 Plugin 不影响其他 Plugin 和 Source 原始内容。

### 4.4 外部 Git Plugin

Marketplace 可以引用另一个 Git 仓库或其中的子目录。已验证：

- 外部内容保存到顶层 `external/<sourceId>/`；
- 外部 Plugin 仍由其 Marketplace Source 管理；
- Source 更新时同时更新 Source 原始内容和外部 Plugin 内容；
- Source 删除时清理其外部内容；
- 新版外部 Plugin 启动失败时，旧 Source、旧 commit、旧元数据和旧运行实例全部恢复；
- 不会因为卸载共享 Source 中一个 Plugin 而误删仍被其他 Plugin 使用的来源。

## 5. parser 验证

### 5.1 兼容逻辑边界

架构测试会静态检查 adapter 源码，确认 adapter 不读取 Claude Code/Codex 原始清单、`.mcp.json` 或 Hook 配置。运行层只接收：

```text
CompatPlugin
CompatSkill
CompatMcpServer
CompatHook
CompatCommand
CompatAgent
```

Claude Code/Codex 的格式、路径、环境变量、Hook 事件、MCP 字段和能力发现规则均先在 `src/parser/` 内规范化。

### 5.2 Claude Code

已验证：

- Marketplace 与单插件清单；
- Skill、MCP、Hook、Command、Agent；
- `${CLAUDE_PLUGIN_ROOT}`、项目目录和结构化路径；
- Hook `command` 与独立 `args` 保持参数边界，POSIX Shell 与 PowerShell 引用规则均有回归测试；
- Marketplace `strict: false` 只使用条目显式声明的能力，不回退扫描默认能力；
- `strict: false` 与本地 `plugin.json` 能力字段冲突时明确报错；
- Workflow、Output Style、LSP、Theme、Monitor、Channel、userConfig、插件依赖等未可靠适配能力产生结构化诊断；
- 不支持的 Hook handler 或事件不被静默忽略。

### 5.3 Codex

已验证：

- 当前顶层 `skills`、`hooks`、`mcpServers`、`apps` 字段；
- 自定义 Skill、Hook、MCP 路径补充默认发现；
- Marketplace 扁平 manifest 只在缺少本地 `plugin.json` 时作为回退；
- PascalCase 与 snake_case Hook；
- Stop 时从当前 turn 的最后一条 `assistant/message` 提取公开文本，不把 reasoning 写入 `last_assistant_message`；
- `mcpServers`、`mcp_servers`、`env_vars`、超时字段的统一转换；
- 未定义的 `paths` 包装字段被明确拒绝，不伪装成当前插件 JSON 规范；
- `apps` 被识别并产生 warning，但不会泄漏到 runtime 形成伪执行；
- 多个 Marketplace Plugin 共用 Source 根目录时，条目显式能力路径形成 Plugin 边界，避免读取其他插件能力。

### 5.4 双格式合并

同一真实 Plugin 同时声明 Claude Code 与 Codex 格式时，已验证：

- 等价 Skill 只注册一次；
- 等价 MCP 只启动一次，并保留组合运行环境；
- 不能证明等价的语义冲突会阻止启用；
- 同一个 Hook 的双方言运行声明会产生明确冲突，避免重复执行；
- 不通过“选择其中一种格式”来静默掩盖冲突。

### 5.5 缓存与真源

已验证：

- `scan.json` 包含 `schemaVersion` 与 parser 版本；
- parser 版本或 Source revision 变化后，从 Source 中的原始 Plugin 文件重新扫描；
- 重扫后重新附加 Source/Marketplace 候选诊断；
- `scan.json` 永远不是事实真源。

## 6. Plugin 整体生命周期验证

每个启用 Plugin 对应一个父运行实例，内部能力绑定到该实例。已验证：

- Skill Provider、MCP 子插件和 Hook 注册随父实例整体建立；
- disable 后源码和数据保留，所有运行能力撤销；
- enable 后整体恢复；
- uninstall 先阻止新请求，再 dispose 父实例，最后删除安装记录；
- dispose 失败时卸载中止，正式内容不先删除；
- enable 启动异常时可靠写回 `enabled = false`；
- 部分能力失败时状态为 `degraded`，其他能力可以继续运行；
- 全部可运行能力失败时立即释放父实例，不留下部分注册；
- `state.json` 只控制整个 Plugin 的 `enabled` 和 `priority`；
- list 按 `priority`、再按 `pluginId` 稳定排序；
- Skill、MCP、Command 等名称冲突明确阻止启用，不自动改名或静默覆盖。

Command 与 Agent 在 0.2.x 中可以识别和诊断，但不执行；该限制会以 warning 呈现，不会被当作已支持能力。

## 7. Source 整体更新与回滚验证

共享 Source 更新会锁定 Source 及所有受影响 Plugin。已验证完整流程：

```text
获取 Source 与 Plugin 锁
→ 下载/复制新版到 temp
→ 重读 Marketplace
→ 检查已安装 Plugin 仍存在
→ 重扫全部受影响 Plugin
→ 静态诊断和冲突检查
→ 停止全部旧运行实例
→ 原子切换 Source 与 external
→ 启动全部新版 Plugin
→ 任一失败则整体恢复旧 Source、旧元数据和旧运行实例
```

故障注入覆盖：

- 新版静态解析 error：不停止旧实例，不切换 Source；
- 第二个新版 Plugin 启动失败：撤销已启动的第一个新版实例并恢复全部旧实例；
- 外部 Git Plugin 启动失败：恢复旧 Source、旧 commit 与旧运行实例；
- 新版运行实例无法停止：保留当前正在使用的 Source 和事务恢复材料；
- 已安装 Plugin 在新版 Marketplace 中消失：拒绝更新；
- 新增 Plugin：只列为可安装，不自动安装；
- 禁用 Plugin 的名称冲突不会阻止 Source 更新，但再次 enable 时会执行冲突检查。

## 8. 安装事务与并发验证

已验证：

- 下载、复制、解压、解析和检查均在 `temp/<transaction-id>/` 完成；
- 所有检查成功后才原子提交 Source 和 Plugin 记录；
- 多 Plugin 安装任一目标失败时全部不提交；
- 同时安装同一 Plugin 只有一个成功；
- Source 锁、Plugin 锁和仓库级锁将管理操作串行化；
- 存活进程持有的长时锁不会因超时被误回收；
- 崩溃遗留的陈旧锁可以回收；
- 刚创建但尚未写完的锁通过 mtime 保护；
- Source 与外部 Plugin 的存储 ID 不能路径逃逸；
- 管理别名不修改旧 Plugin 的内部名称；
- 同一个具体 Source Plugin 不能以不同管理别名重复安装。

## 9. 来源获取与安全验证

### 9.1 安装阶段不执行第三方代码

已验证安装过程不会执行：

```text
npm install
pnpm install
prepare
postinstall
setup.sh
插件自带安装脚本
```

测试夹具包含可观察的恶意 `postinstall`，安装完成后确认脚本没有运行。

### 9.2 Git

已验证：

- GitHub 简写、标准 Git URL、分支、标签、commit SHA；
- 记录最终实际 commit；
- 正式 Source 中不保留 `.git`；
- 不创建 checkout 工作树，因此不触发 smudge/filter；
- URL 内嵌凭据、查询参数、fragment 和不支持协议被拒绝；
- Git ref 选项注入、rev 表达式与空值被拒绝。

### 9.3 ZIP/TAR/TGZ

已验证：

- 正常 ZIP/TAR/TGZ；
- ZIP CRC 篡改；
- `../` 路径穿越；
- 绝对路径、Windows 盘符和 NUL；
- ZIP/TAR 恶意符号链接；
- 指向临时目录外的真实路径；
- 指向普通文件的“目录”符号链接；
- 文件数量、单成员大小和总解压体积预算；
- 失败后不留下正式 Source、Plugin 安装记录或事务目录。

### 9.4 凭据与日志

已验证：

- `${GITHUB_TOKEN}` 等引用不会在安装阶段解析为明文写入缓存；
- MCP env、HTTP Header 与 URL Token 不进入 `scan.json`、日志或 inspect 输出；
- 下游 MCP 异常会经过脱敏；
- 通用脱敏器覆盖 Bearer、查询参数、常见 Token/API Key 前缀。

## 10. CLI 与服务 API 验证

### 10.1 独立 CLI

已验证：

```text
dsh-compat source add/list/inspect/update/remove
dsh-compat install/list/inspect/enable/disable/update/uninstall
```

覆盖：

- JSON 输出；
- 布尔参数可位于位置参数前；
- 未知参数明确失败；
- Marketplace `defaultEnabled=false` 不被 CLI 默认值覆盖；
- 无交互多插件 Source 必须显式 `--plugin`；
- 重复 `--plugin` 原子安装多项；
- 共享 Source 更新必须显式 `--yes`；
- 离线 install/list/inspect/uninstall 冒烟。

本项目没有修改 DSH 启动器，因此实际命令是 `dsh-compat`，不是伪造未注册的 `dsh compat` 子命令。

### 10.2 DSH 服务

构建入口提供 `ctx.compat` 服务，包含 Source 和 Plugin 管理方法。发布结构测试验证：

- `package.json` 的 bundle 声明；
- `cordis.patch.yml`；
- `dist/src/index.js`；
- bin 入口；
- Node.js engines；
- npm 包不夹带测试和源码目录。

## 11. 真实 DSH 验证边界

本次自动化测试中的 Fake DSH Context 用于验证：

- Cordis 风格父子生命周期；
- effect/disposer；
- Skill Provider 注册；
- MCP 子实例管理；
- Hook 事件和结果；
- manager 与 runtime 的失败恢复。

它不等于：

- 启动真实 DeepSeek Harness agent surface 并完成一次模型轮次；
- 在真实 `@deepseek-ai/cordis` 运行树中触发兼容 Plugin 的完整启停；
- 对真实 `dsh-mcp-client` 完成远端 MCP 握手；
- 对真实 DSH Shell/Sandbox 执行第三方 Hook；
- 在目标 DSH profile 中完成兼容 Plugin 的更新、回滚和卸载烟测。

因此本报告的结论分为两层：

1. **已证明：** `dsh-compat` 自身的 parser、Source/Plugin 管理、事务、回滚、安全、CLI、发布结构和模拟 DSH 生命周期行为通过自动化验证；发布 tarball 可由真实 `dsh plugin` 安装到 rc.5 profile，bundle 可组合，Hook Protocol 可解析并满足关键导出契约；真实 ReMe 清单、launcher、`command + args` 和 Codex Stop 消息入队已在隔离环境通过。
2. **尚未证明：** 真实 agent 会话中的第三方 Hook 子进程、真实 MCP 网络握手，以及启用状态下的 profile 更新/回滚/卸载全流程。

## 12. 目标 DSH 环境的最终烟测步骤

在满足 Node.js engines、且安装目标 DSH peer packages 的环境执行：

```bash
npm run verify:dsh

dsh plugin --profile <profile-name> add ./dsh-compat-0.2.2.tgz
dsh --profile <profile-name> --dump-config
```

然后使用受控 fixture 依次验证：

```text
Source add / install
→ 查询 Skill
→ 发现 MCP Tool
→ 触发 Hook
→ disable 后全部撤销
→ enable 后全部恢复
→ 共享 Source update
→ 注入新版启动失败并验证整体回滚
→ uninstall 一个共享 Plugin，确认其他 Plugin 与 Source 保留
→ 卸载最后一个隐式 Source Plugin，确认 Source 自动删除
```

只有在该目标环境烟测完成后，才能进一步声明“真实 DSH 进程级集成通过”和“真实 MCP 网络端到端通过”。
