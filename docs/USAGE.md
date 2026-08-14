# 使用与运维

## 1. 安装 bundle

```bash
dsh plugin --profile <profile-name> add ./dsh-compat-0.2.2.tgz
```

按原方式启动 profile。`dsh-compat` 插件会提供 `ctx.compat` 服务，并在 `autoStart=true` 时恢复已启用 Plugin。

独立 CLI：

```bash
dsh-compat help
```

使用自定义 Harness Home：

```bash
dsh-compat --home /path/to/dsh-home list
```

也可以设置 `DSH_HOME`。

## 2. Source 生命周期

### 2.1 添加显式 Source

```bash
dsh-compat source add https://github.com/example/plugins.git --as example
dsh-compat source add ./plugins.zip --as local-market
dsh-compat source add ./monorepo --as monorepo --path packages/a --path packages/b
```

`source add` 只取得并扫描 Source，不会自动安装其全部 Plugin。

### 2.2 查看 Source

```bash
dsh-compat source list
dsh-compat source inspect example
dsh-compat source inspect example --json
```

`inspect` 显示：

- origin 与 ownership；
- revision/commit/SHA-256；
- 检测到的格式；
- 可安装 Plugin；
- 已安装引用；
- Source 与候选诊断。

### 2.3 更新 Source

```bash
dsh-compat source update example
```

可替换来源：

```bash
dsh-compat source update example --source ./replacement.zip
```

更新会整体影响该 Source 的全部已安装 Plugin。Source 新增的候选只出现在可安装列表，不会自动安装。

### 2.4 删除 Source

```bash
dsh-compat source remove example
```

只要仍有 Plugin 引用，删除就会拒绝。显式 Source 引用归零仍保留；隐式 Source 由最后一个 Plugin 卸载时自动回收。

## 3. 安装 Plugin

### 3.1 单插件 Source

```bash
dsh-compat install ./legacy-plugin
dsh-compat install ./legacy-plugin.zip
dsh-compat install ./legacy-plugin.tgz
dsh-compat install github:owner/repo#v1.2.0
```

这会创建隐式 Source，并安装唯一可识别 Plugin。

### 3.2 Marketplace Source

交互终端：

```bash
dsh-compat install https://github.com/example/plugin-market.git
```

系统列出 Marketplace 中准确的 Plugin，输入编号或 ID 选择一个或多个。

CI/无交互环境：

```bash
dsh-compat install https://github.com/example/plugin-market.git \
  --plugin plugin-a \
  --plugin plugin-c
```

不会默认全部安装。一次选择多个 Plugin 时，静态阶段任一项失败则整个命令不提交。

### 3.3 从已添加 Source 安装

```bash
dsh-compat install plugin-a@example
```

或：

```bash
dsh-compat install example --plugin plugin-a --plugin plugin-c
```

### 3.4 `--path` 兜底

```bash
dsh-compat install ./monorepo \
  --path packages/plugin-a \
  --path packages/plugin-b
```

规则：

- 只在 Source 没有 Claude/Codex Marketplace 时使用；
- 每个路径必须位于 Source 内；
- 每个目录重新经过正常 Plugin parser；
- 不会无限递归寻找候选。

### 3.5 管理 ID

```bash
dsh-compat install ./plugin --as local-name --source-as local-source
```

`--as` 只改变 dsh-compat 的 Plugin 管理 ID；`--source-as` 只改变 Source ID。不会改写 MCP `serverName`、Skill 名称或原插件内容。

### 3.6 启用策略

```bash
dsh-compat install ./plugin --no-enable
```

未传 `--no-enable` 时，优先尊重 Marketplace 的 `defaultEnabled`/安装策略；没有相关声明时默认启用。静态 `error` 始终阻止自动启用。

## 4. Plugin 生命周期

```bash
dsh-compat list
dsh-compat inspect plugin-a
dsh-compat disable plugin-a
dsh-compat enable plugin-a
dsh-compat uninstall plugin-a
```

`inspect` 显示安装记录、Source、统一能力、诊断与运行快照。

### 4.1 更新

独占隐式 Source：

```bash
dsh-compat update plugin-a
```

共享 Source：

```bash
dsh-compat update plugin-a --yes
```

不传 `--yes` 时，非交互 CLI 会拒绝；交互 CLI 会列出全部受影响 Plugin 并请求确认。

替换来源：

```bash
dsh-compat update plugin-a --source ./new-source.zip --yes
```

注意：这仍然是 Source 更新，不是只替换共享 Source 中某一个子目录。

### 4.2 priority

安装时：

```bash
dsh-compat install ./plugin --priority 10
```

恢复顺序为 `priority` 升序，再按 `pluginId` 字典序。0.2.x CLI 不提供独立修改 priority 的命令；可在受控停机后修改状态或重新安装，后续版本可增加显式 setter。

## 5. 在线服务 API

独立 CLI 不连接已运行的 DSH。在线生命周期应使用 `ctx.compat`：

```ts
export const inject = ['compat']

export async function apply(ctx) {
  const source = await ctx.compat.sourceAdd('./plugins.zip', { as: 'local-market' })
  const installed = await ctx.compat.install(source.source.id, {
    plugins: ['plugin-a', 'plugin-c'],
  })

  await ctx.compat.disable('plugin-a')
  await ctx.compat.enable('plugin-a')
}
```

共享更新：

```ts
await ctx.compat.update('plugin-a', { confirmShared: true })
```

服务还提供：

```ts
sourceAdd / sourceRemove / sourceUpdate / sourceList / sourceInspect
install / update / enable / disable / uninstall / list / inspect
```

## 6. JSON 输出

```bash
dsh-compat source inspect example --json
dsh-compat list --json
dsh-compat inspect plugin-a --json
```

适合 CI 和自动化。诊断包含稳定的 `level`、`code`、`capability`、`file`、`message`。

## 7. 常见问题

### Source 包含多个 Plugin

错误：

```text
Source ... 包含多个插件，必须显式选择一个或多个 --plugin
```

处理：重复传入 `--plugin`，或在交互终端选择。

### 共享 Source 更新被拒绝

处理：先检查列出的受影响 Plugin，然后在确认整体更新时加 `--yes`，或通过服务 API 传 `confirmShared: true`。

### Plugin 已安装但未启用

执行：

```bash
dsh-compat inspect <plugin-id>
```

查看 `error` 诊断、能力冲突、缺失运行环境或不支持语义。修复原因后再 `enable`。

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

## 8. 运维建议

- 在线实例使用服务 API；离线 CLI 用于停机维护和 CI。
- 更新前查看 Source 的已安装引用。
- 对不可信 Source 先 `source add` / `inspect`，再选择 Plugin。
- 定期备份 `installed/*/data` 和 Source 元数据。
- 不手工复制 Skill/MCP/Hook 到 DSH 全局目录。
- 不在运行中直接修改 `sources/*/package`。
