# 使用与运维

## 1. 安装 bundle

```bash
dsh plugin --profile <profile-name> add github:rvaim/dsh-compat#v0.4.0
```

> 从 GitHub 安装会运行包内 `prepare` 构建；如果 pnpm 阻止该构建，请按提示把 `dsh-compat` 加入 profile 的 `pnpm-workspace.yaml` `allowBuilds` 后重试。

按原方式启动 profile。`dsh-compat` 插件会提供 `ctx.compat` 服务，并在 `autoStart=true` 时恢复已启用 Plugin。

### 1.1 Web 设置页面

在 Web profile 中打开“设置 → 兼容插件”即可在线管理当前 profile：

- 开关会立即启动或停止整个旧 Plugin 的父 Cordis 实例；
- 卸载会先停止运行实例，再删除安装记录，并按 Source 引用规则回收内容；
- “添加”支持 Git URL、`github:` 简写、本地目录和归档；拉取期间显示进度；
- 单插件 Source 直接安装，多插件 Source 会显示可勾选列表；确认后复用同一份已固定快照，不会再次拉取；
- 插件行中的错误或警告数量可以展开；错误会阻止启用，警告表示插件仍可运行但部分兼容行为可能不同。详情包含诊断说明、稳定代码、能力类型和关联文件。

这些操作都通过当前 DSH 进程执行，不要求重启。只有首次安装、升级或删除 `dsh-compat` 这个 DSH bundle 本身时，Host/Client 插件图发生变化，需要重启 profile 并刷新 Web 页面。

本包不提供独立 CLI。Web 页面负责常用的添加、启停和卸载；Source 维护、批量操作和自动化应使用下方的 `ctx.compat` 服务 API。

## 2. Source 生命周期

### 2.1 添加显式 Source

```ts
await ctx.compat.sourceAdd('https://github.com/example/plugins.git', { as: 'example' })
await ctx.compat.sourceAdd('./plugins.zip', { as: 'local-market' })
await ctx.compat.sourceAdd('./monorepo', { as: 'monorepo', paths: ['packages/a', 'packages/b'] })
```

`sourceAdd` 只取得并扫描 Source，不会自动安装其全部 Plugin。

Web 页面“添加”成功时为新建来源创建隐式 Source；最后一个引用该隐式 Source 的 Plugin 卸载后，Source 自动回收。

### 2.2 查看 Source

```ts
const sources = await ctx.compat.sourceList()
const detail = await ctx.compat.sourceInspect('example')
```

`inspect` 显示：

- origin 与 ownership；
- revision/commit/SHA-256；
- 检测到的格式；
- 可安装 Plugin；
- 已安装引用；
- Source 与候选诊断。

### 2.3 更新 Source

```ts
await ctx.compat.sourceUpdate('example')
```

可替换来源：

```ts
await ctx.compat.sourceUpdate('example', { source: './replacement.zip' })
```

更新会整体影响该 Source 的全部已安装 Plugin。Source 新增的候选只出现在可安装列表，不会自动安装。

### 2.4 删除 Source

```ts
await ctx.compat.sourceRemove('example')
```

只要仍有 Plugin 引用，删除就会拒绝。显式 Source 引用归零仍保留；隐式 Source 由最后一个 Plugin 卸载时自动回收。

## 3. 安装 Plugin

### 3.1 Web 添加

在“设置 → 兼容插件”的添加弹窗中输入来源：

- 单插件 Source 拉取并解析后直接安装；
- 多插件 Marketplace 显示可勾选候选；确认后从同一份固定快照安装，不会二次拉取；
- 取消、页面卸载或请求超时会回收本次创建且未被引用的临时 Source。

### 3.2 单插件 Source

```ts
await ctx.compat.install('./legacy-plugin')
await ctx.compat.install('./legacy-plugin.zip')
await ctx.compat.install('./legacy-plugin.tgz')
await ctx.compat.install('github:owner/repo#v1.2.0')
```

这会创建隐式 Source，并安装唯一可识别 Plugin。

### 3.3 Marketplace Source

多插件来源不会默认全部安装，必须显式传入 `plugins`：

```ts
await ctx.compat.install('https://github.com/example/plugin-market.git', {
  plugins: ['plugin-a', 'plugin-c'],
})
```

Web 之外的分步前端可以先 `prepareInstall` 取得候选与固定快照，再调用 `install`：

```ts
const prepared = await ctx.compat.prepareInstall('./plugin-market')
// 展示 prepared.plugins，等待用户选择……
await ctx.compat.install(prepared.sourceId, { plugins: ['plugin-a', 'plugin-c'] })
// 用户取消时回收临时 Source：
await ctx.compat.sourceRemove(prepared.sourceId)
```

一次选择多个 Plugin 时，静态阶段任一项失败则整个安装不提交。

### 3.4 从已添加 Source 安装

```ts
await ctx.compat.install('plugin-a@example')
```

或：

```ts
await ctx.compat.install('example', { plugins: ['plugin-a', 'plugin-c'] })
```

### 3.5 `paths` 兜底

```ts
await ctx.compat.install('./monorepo', {
  paths: ['packages/plugin-a', 'packages/plugin-b'],
})
```

规则：

- 只在 Source 没有 Claude/Codex Marketplace 时使用；
- 每个路径必须位于 Source 内；
- 每个目录重新经过正常 Plugin parser；
- 不会无限递归寻找候选。

### 3.6 管理 ID

```ts
await ctx.compat.install('./plugin', { as: 'local-name', sourceAs: 'local-source' })
```

`as` 只改变 dsh-compat 的 Plugin 管理 ID；`sourceAs` 只改变 Source ID。不会改写 MCP `serverName`、Skill 名称或原插件内容。

### 3.7 启用策略

```ts
await ctx.compat.install('./plugin', { enable: false })
```

未传 `enable` 时，优先尊重 Marketplace 的 `defaultEnabled`/安装策略；没有相关声明时默认启用。静态 `error` 始终阻止自动启用。

## 4. Plugin 生命周期

Web 设置页可直接开关和卸载；服务 API 等价调用为：

```ts
const plugins = await ctx.compat.list()
const detail = await ctx.compat.inspect('plugin-a')
await ctx.compat.disable('plugin-a')
await ctx.compat.enable('plugin-a')
await ctx.compat.uninstall('plugin-a')
```

`inspect` 显示安装记录、Source、统一能力、诊断与运行快照。

### 4.1 更新

独占隐式 Source：

```ts
await ctx.compat.update('plugin-a')
```

共享 Source：

```ts
await ctx.compat.update('plugin-a', { confirmShared: true })
```

未传 `confirmShared` 时更新会以 `SharedSourceUpdateError` 拒绝，并列出全部受影响 Plugin。替换来源：

```ts
await ctx.compat.update('plugin-a', { source: './new-source.zip', confirmShared: true })
```

注意：这仍然是 Source 更新，不是只替换共享 Source 中某一个子目录。

### 4.2 priority

安装时：

```ts
await ctx.compat.install('./plugin', { priority: 10 })
```

恢复顺序为 `priority` 升序，再按 `pluginId` 字典序。当前版本不提供独立修改 priority 的 Web 控件；可在受控停机后修改 `state.json` 或重新安装。

## 5. 在线服务 API

其他插件可声明：

```ts
export const inject = ['compat']
```

然后使用：

```ts
const source = await ctx.compat.sourceAdd('./plugins.zip', { as: 'local-market' })
const installed = await ctx.compat.install(source.source.id, {
  plugins: ['plugin-a', 'plugin-c'],
})

await ctx.compat.disable('plugin-a')
await ctx.compat.enable('plugin-a')
```

共享更新：

```ts
await ctx.compat.update('plugin-a', { confirmShared: true })
```

服务还提供：

```ts
sourceAdd / sourceRemove / sourceUpdate / sourceList / sourceInspect
install / update / enable / disable / uninstall / list / inspect / prepareInstall
```

## 6. 常见问题

### Source 包含多个 Plugin

Web 页面会展示可勾选列表。通过服务 API 直接 `install` 时必须传入：

```ts
plugins: ['plugin-a', 'plugin-c']
```

错误会列出全部候选 ID，不会默认全装。

### 共享 Source 更新被拒绝

处理：先检查列出的受影响 Plugin，然后通过服务 API 传 `confirmShared: true`。

### Plugin 已安装但未启用

在 Web 设置页展开诊断详情，或调用：

```ts
await ctx.compat.inspect('<plugin-id>')
```

查看 `error` 诊断、能力冲突、缺失运行环境或不支持语义。修复原因后再启用。

### Source 不能删除

仍有 Plugin 引用，或存在损坏的 `install.json` 导致无法安全判断。先修复/备份元数据或逐个卸载引用 Plugin，不要强制删除共享 Source。

### MCP 处于 degraded

检查：

- 环境变量/凭据是否存在；
- command、cwd 和可执行文件；
- HTTP URL/Header；
- `failOnStartupError`；
- DSH MCP client 日志与 Sandbox 权限。

### Node 依赖 warning

`dsh-compat` 不会自动运行包管理器。确认插件是否已经提交依赖或可直接运行；否则在受控环境中显式准备依赖，并评估第三方脚本风险。

### Windows 上 Bash 命令失败

不会自动转换为 PowerShell。安装 Bash/WSL 等插件明确依赖的环境，或者选择跨平台版本的插件。

## 7. 运维建议

- 日常操作优先使用 Web 设置页；批量与自动化使用 `ctx.compat` 服务 API。
- 更新前查看 Source 的已安装引用。
- 对不可信 Source 先 `sourceAdd` / `sourceInspect`，再选择 Plugin。
- 定期备份 `installed/*/data` 和 Source 元数据。
- 不手工复制 Skill/MCP/Hook 到 DSH 全局目录。
- 不在运行中直接修改 `sources/*/package`。
