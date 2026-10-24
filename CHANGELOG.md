# 更新日志

## 0.10.2 — 2026-10-24

- 将 `engines.dsh`、DSH SDK、Hook Protocol、Typert 生成器及全部 DSH peer 依赖统一固定到 `0.2.1-rc.3`，解决当前 Desktop 因版本不匹配拒绝加载插件桥的问题；不使用版本豁免或扩大未验证的支持范围。
- 使用目标 SDK 重新生成严格 Host/Remote 通信产物；显式固定真实 SDK 探针使用的 `dsh-llm` 开发依赖。
- 包清单回归与发布校验覆盖所有直接 DSH 依赖，发布校验同时检查传递 SDK 的锁定版本；真实安装器探针验证目标版本可接受、旧基线被拒绝。
- 构建时生成并发布浏览器捆绑依赖的完整第三方许可证声明，包结构检查验证其版本与内容。
- 同步 README 与安装运维示例。升级插件桥本体后需保存工作，完整退出并重启 DeepSeek Harness。
- 发布验证通过：433/433 项测试、12 轮真实 SDK RPC、8 种解析器物理移除组合与 582 个发布文件检查；SDK 探针未安装到用户 profile，不代表现场浏览器验收。

## 0.10.1 — 2026-10-22

- 修复升级后新页面向旧 Host 契约提交安装对象时，仅显示 `completeAdd.plugins failed boundary validation` 的问题。安装、上传及确认前调用只读 `contract`，检查运行中 `completeAdd` 的真实 codec，而不是磁盘包版本。
- 检测到旧 `string[]` 校验器、缺失检查端点或协议失配时，在任何安装业务调用前停止并明确提示完整退出、重启 DeepSeek Harness；不兼容旧参数，也不放宽严格校验。
- 补充真实 Client bundle + SDK Gateway 在直接与 JSON transport 下的两阶段安装回归，覆盖首次省略 `parserId`、确认指定解析器、旧缓存 Host、缺失端点及非 JSON 值。网络和权限错误仍显示原始原因，不伪装成重启问题。
- Typert Loader 按包名永久缓存生成 manifest；更换插件包需要完整重启宿主进程。网页刷新、重新安装或切换开关不会替换已加载的 Host schema。
- 修复版全量 433 项测试、12 轮真实 SDK/RPC、8 种解析器移除组合与 581 个发布文件检查通过。

## 0.10.0 — 2026-10-22

本版不兼容旧安装 API 和旧安装记录：`InstallOptions.plugins` 改为 `{ pluginId, parserId? }[]`，`completeInstallPreparation` 返回 `parser-selection` / `installed` 联合结果；`InstallMetadata.parserId` 与扫描记录的 `parserSnapshot` 必填。不迁移旧 `string[]` 参数或从旧 `formats` 猜测平台，旧记录需按新流程重新安装。

- 每个安装实例只采用一个解析器。新增轻量 `matchPlugin`、注册标签与匹配依据；唯一匹配可自动选定，多匹配由通用界面逐插件选择，不默认使用首项。
- 删除跨平台 Skill/MCP/Hook 等能力拼接，仅扫描与执行选定解析器；未选平台的展示元数据、调用权限、目录策略和不支持字段不混入结果。
- 选择持久化并贯穿启用、重启、缓存重扫和来源更新；已选解析器缺失或失配时明确阻断，保留既有数据与启用意愿，不交给另一平台兜底。
- 选中外部插件后获取并固定内容，解析器选择期间重试不重新拉取移动分支；取消、过期和同来源多会话按独立所有权回收。
- 修复安装已提交后临时清理失败被误报为安装失败的问题：返回成功及清理警告，保留重试责任；准备失败叠加清理失败也不会丢失暂存目录归属。
- 跨插件名称冲突只按四个明确代码清理，保留 Hook 等解析冲突；来源内插件简写保留显式 `parserId`，选择参数统一使用稳定 `pluginId`。
- Plugin / Source parser 模型均升至 `6.0.0`，Claude Code / Codex 实现升至 `1.3.0`，Agent Plugins 实现保持 `1.2.0`。
- 全量 414 项测试、8 项真实 SDK RPC、8 种解析器物理移除组合和分发结构检查通过；真实双平台仓库的静态验证与运行限制见[单解析器选择与安装契约](docs/单解析器选择与安装契约.md)。

## 0.9.0 — 2026-10-22

本版调整安装选择契约：`InstallPreparation` 和 Web `selection` 结果新增必填 `selectionRequired`；Marketplace 与手动多路径来源必须显式选择插件，只有独立单插件来源保留默认安装。直接使用服务 API 时，市场即使只有一个候选也需要传入 `plugins`。

- Claude Code / Codex 解析器声明有界嵌套市场发现，支持 ReMe 一类市场位于仓库子目录的布局；根市场和显式插件优先，最多深入 4 层、检查 4096 个目录，不沿目录符号链接发现市场。
- 市场根与 Source 仓库根分别定位：本地子插件、`metadata.pluginRoot`、内联 Hook/MCP 的延迟文件引用保持正确路径；外部 Git/git-subdir 的仓库位置不受本地前缀影响。
- 市场无论有一个还是多个候选，链接与上传入口均先展示通用选择列表；列表显示实际插件位置与阻断诊断，不按 Codex/Claude 名称决定交互。
- 保留外部 Git 仅在选中确认后获取的机制；补齐本地/外仓混合、未选不可达仓库、子目录、`ref` / `sha` 固定和更新来源保留的端到端回归。
- 同格式、同 ID 的跨市场声明明确报冲突，避免静默丢失一方的 Hook 或其他策略。Source parser 升至 `5.1.0`，Claude Code / Codex 实现升至 `1.2.0`。
- 全量 356 项测试、8 种解析器可移除组合、真实 DSH SDK/RPC 和分发结构检查通过；官方核对证据与运行限制见[市场发现与选择安装验证报告](docs/市场发现与选择安装验证报告.md)。

## 0.8.1 — 2026-10-22

- 修复同一诊断在候选列表与来源汇总中重复的问题；插件行错误/警告计数与诊断条目一致。
- Agent Plugins 扩展与旧组件警告现在列出实际命名空间和目录名称，并在 details 中保留结构化数据。
- 插件诊断面板支持复制单条或全部诊断，消息与详情可选择文本，复制有成功/失败反馈。
- Windows 提交来源目录时对 rename 的瞬时 EPERM/EACCES/EBUSY 做有限重试，其他错误照常失败。

## 0.8.0 — 2026-10-22

- 修复默认配置未显式设置 `parsers` 时装配零个解析器的问题；省略启用全部内置解析器，显式 `[]` 禁用全部。
- Git 来源改用单条持久 `git cat-file --batch` 批量导出对象；Git 暂存元数据使用系统短临时目录，修复深目录长路径失败。
- 添加和安装请求贯通 `AbortSignal`；拉取期间可取消，取消后等待子进程树退出并回收事务。
- 根插件使用持久化稳定来源种子生成候选 ID，修复 `acquired-source`/`package` 两次扫描不一致。
- 根 `plugin.json` 仅在声明 Agent Plugins schema 时参与独占识别；候选列表返回完整诊断。
- 插件数据目录统一为 `$DSH_HOME/dsh-plugin-bridge/`，不包含旧名称别名或迁移代码。

## 0.7.0 — 2026-10-22

解析器开发契约增加必填 `category` 声明，引擎端口增加 `categories` 与 `dispose()`，Web 列表 ready 结果新增 `categories`。自定义解析器或引擎应按[架构说明](docs/动态贡献与本地文件选择.md)补齐；协议解析规则、模型版本和磁盘数据目录保持。

- 解析器自声明分类贡献，由 owner-scoped 注册表随引擎装配与撤销；Host 返回当前分类目录，客户端动态生成页内导航和格式标签，新增或移除解析器无需修改导航代码。
- 分类与搜索、运行状态筛选组合；零计数分类保留，当前分类移除后返回全部，窄屏使用同一目录的分类选择控件。
- 添加来源弹窗增加跨平台标准文件选择器，支持 ZIP/TAR/TGZ/TAR.GZ；通过 DSH 已认证、仅 owner 可用的流式接口上传，限制 30 MiB、2 个并发和 10 分钟接收期限，支持取消与关闭清理。
- 上传原件纳入 Source 所有权，按摘要复用并保留更新原件；同内容已有外部归档安全接管，已有准备会话和原清理责任保持。
- 统一贡献架构、生命周期与新增/移除步骤见[动态贡献与本地文件选择](docs/动态贡献与本地文件选择.md)。

## 0.6.0 — 2026-10-21

- GitHub 上游迁至 `https://github.com/rvaim/dsh-plugin-bridge`，同步 npm repository/homepage/issues 与当前安装文档；稳定数据目录保持 `$DSH_HOME/dsh-plugin-bridge/`。

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

此版本包含服务命名和开发 API 调整。支持的解析能力与 Desktop 运行边界见[验证报告](<docs/解析器解耦验证报告.md>)。

### 包标识与展示名称调整

- 中文名称：插件桥。
- 英文名称：Plugin Bridge。
- Cordis 插件 ID：`plugin-bridge`。
- npm 包名：`@rvaim/dsh-plugin-bridge`，版本 `0.5.0`。

当前服务统一为 `ctx.pluginBridge`，RPC namespace 为 `pluginBridgeAdmin`，Client locale namespace 为 `settings.pluginBridge`，Settings section ID 为 `plugin-bridge`；不保留旧 namespace 别名。内部 `Compat*` 类型及 `parseCompat*` 函数保留原名。数据目录为 `$DSH_HOME/dsh-plugin-bridge/`；repository 为 `https://github.com/rvaim/dsh-plugin-bridge`。历史发布记录保留当时事实。

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

- npm 包名改为公开组织包 `@rvaim/dsh-plugin-bridge`，并统一 Cordis resolver、Web Client ModuleLoader 与 Typert 的包级标识。
- README 将 npm 安装和 Web 使用流程移至最前，加入兼容插件设置页截图与旧 GitHub 依赖替换说明。
- 发布清单增加 npm registry、GitHub repository 元数据和截图校验。

## 0.4.2

- 补丁版本：完善 GitHub 安装说明，给出稳定的 `allowBuilds` 仓库级 key，避免 pnpm 报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`。

## 0.4.1

- 补丁版本：版本号更新为 `0.4.1`，README、使用文档与验证报告改用 GitHub 仓库 tag `v0.4.1` 安装。

## 0.4.0

- 移除独立 `dsh-plugin-bridge` CLI 及 `@clack/prompts` 依赖：旧 Plugin 的添加、启停和卸载统一通过“设置 → 兼容插件”页面或 `ctx.compat` 服务 API 完成。
- 移除仅供 CLI 交互选择使用的 `InstallOptions.selectPlugins` 与 `PluginSelectionRequiredError`；多插件 Source 直接通过 `plugins` 显式选择，Web 二阶段流程继续使用 `prepareInstall/completeAdd`。
- 发布包不再声明 `bin`。
- 移除 dsh-plugin-bridge 自身旧版磁盘兼容标记：`source.json`、`install.json`、`state.json` 与 `scan.json` 不再写入 `schemaVersion`，`install.json` 不再写冗余 `pluginPath` 字段，并去掉相关旧版本校验与旧 `source.json` 缺失 `name` 的回填逻辑；删除无调用者的 `DEFAULT_PLUGIN_STATE`、`listPluginRecordsForSource`、`selectExtractedPluginRoot`、`rollbackRemove`。
- 合并重复的已安装插件根目录解析逻辑，统一走 `resolveInstalledPluginPackageRoot()`。

## 0.3.1

- 兼容插件列表中的错误与警告数量支持原位展开，显示诊断说明、稳定代码、能力类型和关联文件。
- Web Remote 只发送 error/warning 的公开诊断字段，不传输 info 或内部 details。
- 修复长版本号和多个格式标签把插件名称压缩到不可见的问题。

## 0.3.0

- 新增与 DSH Web 原生设置面板融合的“兼容插件”页面，可查看当前 profile 中由 dsh-plugin-bridge 管理的插件，并在线启用、停用和卸载。
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
