# dsh-compat 0.4.0 验证报告

验证日期：2026-08-15  
交付版本：`0.4.0`
目标 DeepSeek Harness：`0.1.0-rc.6`
Plugin parser：`2.0.1`
Source parser：`2.0.0`

## 1. 结论

0.4.0 移除了独立 `dsh-compat` CLI，并清理了 dsh-compat 自身旧版磁盘记录的 `schemaVersion` 兼容标记。旧 Plugin 的添加、启停与卸载收敛为 Web“设置 → 兼容插件”页面，批量和自动化操作使用 `ctx.compat` 服务 API；Claude Code / Codex 插件格式兼容保持不变。

已验证的关键结果：

- “兼容插件”按 DSH `settings.section` 机制出现在 Agent 预设之后；
- 浏览器 bundle 由 DSH `/plugins/dsh-compat/client.js` 提供并进入 `window.__DSH_BOOT__`；
- 添加弹窗、多插件复选列表、插件列表、卸载确认、Toast 和暗/浅主题均沿用 0.3.1 的 Web 基线；
- 多插件确认后复用第一次固定的 Source 快照，不重复拉取；
- 同一运行进程内启停状态实际完成 `true → false → true`，不需要重启；
- 当前页面的 list、beginAdd、completeAdd 和 setEnabled RPC 无浏览器错误或 Host 错误；
- 发布包不再声明 `bin`，不再依赖 `@clack/prompts`；
- `source.json` / `install.json` / `state.json` / `scan.json` 不再包含 `schemaVersion`，`install.json` 不再写冗余 `pluginPath`；
- 多插件 Source 未显式选择时，`ctx.compat.install` 明确列出全部候选 ID 并拒绝默认全装。

## 2. 自动化验证

执行：

```bash
npm run verify
npm run verify:dsh
```

`npm run verify` 包含：

1. 清理 `dist/`；
2. Typert Host/Remote 生成；
3. TypeScript strict 编译；
4. DSH Client closure-factory bundle；
5. Node test runner；
6. 发布清单和 `npm pack --dry-run` 白名单检查。

本轮结果：**102/102 自动化测试通过**，发布包检查通过，共 367 个发布文件。自动测试覆盖 parser、Source/Plugin manager、事务回滚、runtime/adapters、Hook/MCP/Skill、安全边界、Web gateway 与发布包清单。其中与本轮变更直接相关的检查包括：

- 多插件 Source 未显式选择时拒绝安装并列出候选 ID；
- Web 单插件自动安装与多插件二阶段选择；
- 原输入目录删除后仍可从固定快照完成安装；
- 取消选择清理临时 Source；
- 同一 Source 并发选择的清理责任转交；
- 在线启用、停用和卸载映射；
- 磁盘记录无 `schemaVersion`，且旧记录可被直接读取（多余字段不影响 JSON 解析）；
- `package.json` 不包含 `bin` 与 `@clack/prompts`，不夹带 `src/`、`test/`、`dist/test/` 或 `node_modules/`。

`npm run verify:dsh` 额外导入真实 rc.6 包并核对：

- Cordis `Service`；
- Schemastery schema API；
- Hook Protocol 关键函数；
- MCP Client 可挂载形态；
- `CompatWebGateway` 与 `CompatManager.prepareInstall()`；
- `compatAdmin/{beginAdd,cancelAdd,completeAdd,list,setEnabled,uninstall}` 的 Typert Host/Remote descriptor。

## 3. 真实 DSH Web 验证

0.3.1 报告中的 Web 浏览器实测继续作为 UI 基线：0.4.0 未修改 Client 设置页、Typert Remote、`CompatWebOperations` 或 `CompatRuntimeManager`，因此 0.3.1 已验证的设置导航、添加弹窗、多选、安装后 `running`、动态开关、卸载确认、诊断 disclosure 及暗/浅主题结论仍然适用。

0.3.1 验证观察：

```text
profile dependency: dsh-compat@0.3.1
dump-config: 包含 dsh-compat bundle 条目
boot manifest: 包含 dsh-compat client 条目及四个 inject 边
client route: HTTP 200，内容为 ModuleLoader closure-factory
Typert Remote: 六个 compatAdmin 方法均被严格挂载
```

浏览器实测路径：

```text
设置
→ 兼容插件
→ 添加本地多插件 Marketplace
→ 显示两个候选并勾选
→ 添加所选插件
→ web-alpha / web-beta 均显示运行中
→ 停用 web-alpha
→ aria-checked=false，运行实例停止
→ 再启用 web-alpha
→ aria-checked=true，状态恢复运行中
```

还检查了：

- 空列表，以及读取失败分支的实现与可展示错误映射；
- 添加输入、取消与 Enter 提交；
- 不可安装候选禁用；
- 拉取/安装按钮和正文中的进行中状态；
- 卸载二次确认；
- 中文/英文词典结构；
- DSH 深色与浅色 Token；
- 图标按钮、switch、checkbox 的可访问名称和焦点状态。

## 4. 动态加载边界

### 兼容插件操作

以下操作调用当前 Host 进程中的 `ctx.compat`，会立即驱动 `CompatRuntimeManager`：

- Web/服务 API 添加旧 Plugin；
- 启用；
- 停用；
- 卸载。

这些操作不修改 DSH Client 启动图，所以不需要重启。

### dsh-compat bundle 操作

首次安装、升级或删除 `dsh-compat` 本身会改变 profile 的 Host Loader 条目与 `dsh.client` 图。DSH Typert Loader 和 Client Modules 都缓存包级判定，因此这类变化需要重启 profile，并让 Web 页面重新加载新的 boot manifest。

## 5. 安全与一致性

- Web 不暴露自定义任意 HTTP handler，统一走 DSH Typert `/api` carrier；
- 所有参数和结果使用生成的 Zod v4 strict codec；
- Source 输入继续经过原有 Git、归档、路径、符号链接和凭据安全检查；
- 分步选择只向浏览器返回公开候选字段，不返回 Marketplace 原始配置或凭据；
- request ID 使用随机 UUID，并在取消、页面卸载、插件停止或十分钟过期时清理；
- 安装失败不会提交部分 Plugin；运行启动失败沿用 manager 的原子回滚规则；
- UI 只使用 DSH primitives、locale、Settings Slot 和 `--dsw-*` Token；
- 不再存在的 CLI 不会作为 bin 进入 profile，减少一个未接入 DSH 生命周期的离线入口。

## 6. 已知验证边界

本报告不扩大声明以下内容：

- 未对任意第三方远端 MCP 服务完成网络端到端握手；
- 未在真实模型会话中执行所有第三方 Hook；
- 未通过真实公网超慢 Git 仓库逐帧捕获 loading 动画；本地 Source 完成过快，但进行中 DOM、按钮禁用与 loading 图标已进入编译后的 Client bundle，并通过实现审查；
- 不支持的 Claude Code/Codex 能力仍以结构化诊断公开，不会被描述为已兼容；
- 0.4.0 本轮未重新执行浏览器逐帧回归，UI 验证继承 0.3.1 基线，变更范围只删除 CLI 与其发布入口。

## 7. 发布命令

```bash
npm run verify
npm pack --ignore-scripts
dsh plugin --profile <profile-name> add github:rvaim/dsh-compat#v0.4.0
```

安装或升级 `dsh-compat` 后重启该 profile。之后可直接在“设置 → 兼容插件”中在线添加和管理旧 Plugin。
