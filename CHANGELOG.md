# 更新日志

## 0.6.0 — 2026-10-21

- GitHub 上游迁至 `https://github.com/rvaim/dsh-plugin-bridge`，同步 npm repository/homepage/issues 与当前安装文档；稳定数据目录保持 `$DSH_HOME/dsh-compat/`。

- SDK、Hook Protocol 和 Typert 生成器统一到 `engines.dsh` 声明的当前 DSH 版本；重新生成使用 `create()` 工厂的严格 Host/Remote codec，不保留旧格式转换。
- 插件桥从设置页迁至侧边栏 `sidebar.panellist`，点击后在 `main` 打开独立管理面板；Client locale namespace 改为 `pluginBridge`，删除旧入口与组件别名。
- 运行层改用当前 Shell、Session projection 和官方事件/消息类型，删除 `shell.run` 与 `session.events` 的旧 Host 回退。
- 契约探针使用真实 SDK 注册器和 Host/Client dispatcher，验证 RPC 往返、非法输入与卸载；Client 测试验证实际浏览器 bundle 的入口注册和资源释放。
- 管理面板拆分查询/变更状态、插件行、添加流程与操作确认；增加本地检索、状态筛选、持续错误与重试、共享来源更新影响确认，复用宿主 Switch 和 Modal 焦点管理。
- 管理层持有分步安装准备会话，完成/释放在仓库锁内复核来源实例、revision、所有权与引用；Host 添加请求独立管理 TTL、去重、取消竞争和关闭清理。
- 更新检查改为短锁捕获快照、锁外探测、短锁重验；检查期间变化的来源或引用返回过期结果，不阻塞列表和不相关生命周期操作。
- repository 移除运行回调，由 manager 显式同步运行状态；运行协调失败以独立诊断呈现。安装与更新共用内容准备模块，完整保留原有提交和补偿顺序。
- Host/Service 使用真实 Cordis Context，运行层引用官方 Skill/MCP/生命周期类型；删除遮蔽官方类型的旧 MCP 声明，测试替身改用真实 Cordis 与 Skill 注册表。
- 解析代码、解析模型版本、协议模块及磁盘数据目录不变。本次不自动安装、发布或修改用户 profile。

## 0.5.0 — 2026-10-21

此版本以新包名 `@rvaim/dsh-plugin-bridge` 交付，包含不兼容的服务命名和开发 API 调整；旧包不会自动升级或迁移 profile。支持的解析能力与当前 Desktop 运行边界分别记录，见[包更名说明](<docs/包更名说明.md>)和[验证报告](<docs/解析器解耦验证报告.md>)。

### 包标识与展示名称调整

- 中文名称：插件桥。
- 英文名称：Plugin Bridge。
- Cordis 插件 ID：`plugin-bridge`。
- npm 包名：`@rvaim/dsh-plugin-bridge`，版本 `0.5.0`。

当前服务统一为 `ctx.pluginBridge`，RPC namespace 为 `pluginBridgeAdmin`，Client locale namespace 为 `settings.pluginBridge`，Settings section ID 为 `plugin-bridge`；不保留旧 namespace 别名。内部 `Compat*` 类型及 `parseCompat*` 函数保留原名。数据 namespace 继续使用 `dsh-compat`，磁盘目录仍为 `$DSH_HOME/dsh-compat/`；repository 仍为 `https://github.com/rvaim/dsh-compat`。本次不自动修改任何 profile，历史发布记录保留当时的包名和 API，详细边界见[包更名说明](<docs/包更名说明.md>)。

### 源码目录收敛

- `src` 一级目录从 13 个收敛为 10 个：`composition`、`manager`、`parser`、`protocols`、`runtime`、`shared`、`source`、`store`、`types`、`web`；其他职责分工不变。
- 加载器迁至 [manager/plugin-loader.ts](<src/manager/plugin-loader.ts>)；能力适配器归入 [runtime/adapters/](<src/runtime/adapters/>)，Hook/MCP/Skill 实现压平为三个文件；Web 按 [host/](<src/web/host/>) 与 [client/](<src/web/client/>) 收拢；协议共享描述类型迁至 [types/protocol.ts](<src/types/protocol.ts>)。
- 删除旧 `src/core/`、`src/adapters/`、`src/client/`、`src/protocols/shared/`，不保留 re-export、转发文件或兼容门面；完整映射见[解析器解耦重构说明](<docs/解析器解耦重构说明.md>)。
- 本次仅调整目录归属，Plugin parser / Source parser 模型版本仍为 `5.0.0`，各内置协议实现版本仍为 `1.1.0`；不更改解析语义、运行逻辑、执行 profile 或用户 profile。最终验证和发布文件数量由本轮实际执行结果记录。

### 解析器解耦重构

- CC、传统 Codex、Agent Plugins 完整实现归独立协议目录，唯一装配文件引用具体模块；协议专属旧 API、转发门面和反向查询注册表全部删除。
- 新增统一解析契约、显式引擎、格式边界元数据及八种组合验收。缺失解析器明确诊断，不回退其他格式；混合目录同名策略保守阻断。
- 核心管理/加载器通过端口注入，缓存比较全局版本、Source revision 和解析器快照；全局缓存版本为 5.0.0，各内置解析实现版本为 1.1.0。
- 运行层按显式语义 profile 和环境绑定执行，来源格式仅作元数据；共享模板无厂商变量别名，删除旧环境模式、IR alias 和默认 Manager 构造，`codexModel` 改为 `modelName`。
- 拆出 Manager 类型、仓库及完整更新事务；解析器移除后保留用户启用意愿和数据，停止失效运行能力。
- 完整验证增加无对应实现目录时的真实构建/公共入口加载，并输出中文重构说明与验证报告。


### Agent Plugins 1.0.0 独立格式接入

- 新增 `agent-plugins` 独立身份，使用根 `plugin.json`，不归入传统 Codex/CC 方言；只有本地支持的 canonical schema 可加载。
- 内置官方 v1.0.0 Manifest/MCP schema、固定来源与 Apache-2.0 许可，使用显式 Ajv 运行依赖离线校验；未知核心字段/扩展按规范例外忽略。
- 固定发现直接子目录 Skill 与根 mcp.json，按组件及单条目隔离错误；实现 portable stdio、无配置 Header 的 streamable-http、默认 cwd、真实路径检查、保留 env 和单次占位符展开。
- 复用原有安装、更新、数据保留和卸载；新增独立格式回归及中文兼容/验证文档。Parser/source parser 为 3.1.0。
- SSE、配置 Header 的 HTTP 转发及未实现 namespace 有明确边界；当前 Desktop Web 的 Typert 迁移仍独立处理。

### 传统协议兼容修订

- 明确上游基线：Codex 0.163.0 传统格式、Claude Code 2.1.304 和 2026-10-20 官方文档；Agent Plugins 1.0.0 采用单独的解析器，不并入传统规则。
- 修正两平台 Manifest/Marketplace 的替换、追加、strict、Hook 事件覆盖、MCP 有序覆盖及 defaultEnabled；补充 Command 对象来源与合法未适配能力诊断。
- 扩充事件目录、matcher、Handler 声明；支持 Hook 失败阻断、完整工具 JSON、当前 Shell/Agent/Session 接入和直接 argv 执行，失败不再记为 pass/running。
- 补充 Codex Skill sidecar、CC 调用提示和布尔语义、传统 MCP Header/env/bearer 与延迟模板；未兑现权限和执行限制阻止启用。
- Plugin parser / Source parser 升级至 3.0.0，已有扫描缓存重扫；文档改为中文命名，新增实施方案和本轮验证报告。
- 上述修订在 `0.5.0` 汇总交付，阶段性缓存版本和验证事实保留在中文报告中；当前 Desktop Web 的 Typert 生成契约迁移和页面端到端验证仍单独列为运行时边界。


## 0.4.4

- Web 设置页新增更新检测：刷新时探测每个已安装插件所属 Source 的最新 revision，有更新时显示“更新”按钮。
- 新增 `compatAdmin/checkUpdates` 与 `compatAdmin/update` RPC，并暴露 `ctx.compat.checkUpdates()` 服务 API。
- 更新按钮直接复用现有原子更新事务；共享 Source 会整体更新并返回全部受影响插件。

## 0.4.3

- npm 包名改为公开组织包 `@rvaim/dsh-compat`，并统一 Cordis resolver、Web Client ModuleLoader 与 Typert 的包级标识。
- README 将 npm 安装和 Web 使用流程移至最前，加入兼容插件设置页截图与旧 GitHub 依赖替换说明。
- 发布清单增加 npm registry、GitHub repository 元数据和截图校验。

## 0.4.2

- 补丁版本：完善 GitHub 安装说明，给出稳定的 `allowBuilds` 仓库级 key，避免 pnpm 报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`。

## 0.4.1

- 补丁版本：版本号更新为 `0.4.1`，README、使用文档与验证报告改用 GitHub 仓库 tag `v0.4.1` 安装。

## 0.4.0

- 移除独立 `dsh-compat` CLI 及 `@clack/prompts` 依赖：旧 Plugin 的添加、启停和卸载统一通过“设置 → 兼容插件”页面或 `ctx.compat` 服务 API 完成。
- 移除仅供 CLI 交互选择使用的 `InstallOptions.selectPlugins` 与 `PluginSelectionRequiredError`；多插件 Source 直接通过 `plugins` 显式选择，Web 二阶段流程继续使用 `prepareInstall/completeAdd`。
- 发布包不再声明 `bin`。
- 移除 dsh-compat 自身旧版磁盘兼容标记：`source.json`、`install.json`、`state.json` 与 `scan.json` 不再写入 `schemaVersion`，`install.json` 不再写冗余 `pluginPath` 字段，并去掉相关旧版本校验与旧 `source.json` 缺失 `name` 的回填逻辑；删除无调用者的 `DEFAULT_PLUGIN_STATE`、`listPluginRecordsForSource`、`selectExtractedPluginRoot`、`rollbackRemove`。
- 合并重复的已安装插件根目录解析逻辑，统一走 `resolveInstalledPluginPackageRoot()`。

## 0.3.1

- 兼容插件列表中的错误与警告数量支持原位展开，显示诊断说明、稳定代码、能力类型和关联文件。
- Web Remote 只发送 error/warning 的公开诊断字段，不传输 info 或内部 details。
- 修复长版本号和多个格式标签把插件名称压缩到不可见的问题。

## 0.3.0

- 新增与 DSH Web 原生设置面板融合的“兼容插件”页面，可查看当前 profile 中由 dsh-compat 管理的插件，并在线启用、停用和卸载。
- 新增带进度反馈的 Web 添加弹窗：单插件 Source 拉取后直接安装，多插件 Source 使用复选列表选择；选择阶段复用第一次固定的 Source 快照，不重复拉取。
- Web 管理调用通过 DSH Typert Remote 严格 schema 暴露；浏览器端复用 DSH 的 Settings Slot、UI primitives、主题 token 与中英文 locale。
- 新增未完成选择的回收机制：取消、页面卸载或请求超时都会尝试删除未被引用的临时隐式 Source。
- 对齐 DSH `0.1.0-rc.6` 的 Client、Typert 与 Hook Protocol 契约。

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
