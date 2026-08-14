# 架构与生命周期

## 1. 五层边界

```text
第一层：Source 获取
Git / Directory / Archive
        │
        ▼
第二层：parser/source
Marketplace、单插件识别、--path、Plugin 位置
        │
        ▼
第三层：Plugin parser
Claude/Codex Skill、MCP、Hook、Agent、Command、路径、环境变量
        │
        ▼
第四层：Plugin manager/runtime
安装、启停、运行状态、更新、卸载、父生命周期
        │
        ▼
第五层：adapters
Compat* → DSH Skill/MCP/Hook
```

职责不能倒置：Source 获取层不理解 Skill；`parser/source` 不解析具体能力；adapters 不读取 Marketplace 或旧格式；runtime 不根据生态分支执行。

## 2. Source、Plugin 与能力

```text
一个 Source
    │
    └── 1..N Plugin
             │
             ├── 0..N Skill
             ├── 0..N MCP
             ├── 0..N Hook
             ├── 0..N Agent
             └── 0..N Command
```

Source 是内容获取与更新单位。Plugin 是安装、启用、禁用、运行和卸载单位。内部能力永远不成为独立安装项。

### 2.1 Source 类型

- Git：记录 URL、ref 和最终实际 commit。
- Archive：记录本地路径和 SHA-256。
- Directory：保存目录快照和内容 revision。

Source 的 `ownership`：

- `explicit`：由 `source add` 创建，引用归零仍保留。
- `implicit`：由直接 `install <source>` 创建，引用归零自动回收。

### 2.2 Plugin 位置

`CompatPluginLocation` 支持：

- `source-path`：Source `package/` 内的相对路径；
- `git`：Marketplace 指向外部 Git；
- `git-subdir`：外部 Git 的子目录；
- `npm`、`archive`、`unsupported`：当前可被识别并诊断，0.2.x 不会伪装成已支持。

外部 Git Plugin 放在 `external/<sourceId>/`，仍属于 Source 的版本和更新事务。

## 3. 存储模型

```text
$DSH_HOME/dsh-compat/
├── sources/<sourceId>/
│   ├── source.json
│   ├── scan.json
│   ├── package/
│   └── cache/
├── installed/<pluginId>/
│   ├── install.json
│   ├── state.json
│   ├── scan.json
│   ├── data/
│   └── cache/
├── external/<sourceId>/
├── temp/
└── locks/
```

### 3.1 Source 事实真源

`sources/<sourceId>/package/` 保存完整原始 Source。多 Plugin 共享同一份内容，避免每个安装项复制源码，也保证共享 Source 的所有 Plugin 使用同一个版本。

### 3.2 Plugin 安装记录

`install.json` 只保存：

```ts
{
  schemaVersion: 1,
  pluginId,
  sourceId,
  sourcePluginId,
  pluginPath?,
  location,
  materialization?,
  installedAt,
  updatedAt?
}
```

`state.json` 只保存整个 Plugin：

```ts
{
  schemaVersion: 1,
  enabled: boolean,
  priority: number
}
```

禁止出现按 Skill/MCP/Hook 分拆的启停开关。

### 3.3 缓存失效

- Source `scan.json` 带 `parserVersion`。
- Plugin `scan.json` 同时带 `parserVersion` 与 `sourceRevision`。
- 任一版本不匹配即从原始 Source 重新扫描。
- `scan.json` 从来不是事实真源。

## 4. Source 定位流程

```text
取得 Source 目录
       │
       ├─ 发现 Claude Marketplace ─┐
       ├─ 发现 Codex Marketplace ──┼─ 合并候选
       │                           │
       └─ 均不存在                 ┘
              │
              ├─ 有 --path：逐项验证
              └─ 无 --path：只检查根目录是否为单插件
```

存在 Marketplace 时不会递归猜测未列出的目录，也不会自动安装全部候选。混合 Marketplace 只有在同一规范化 ID、同一真实目录且关键语义一致时才能合并。

## 5. Plugin parser

Plugin parser 是兼容编译层，负责：

- 识别 Claude Code/Codex 清单和默认目录；
- 验证字段、路径、事件、handler、transport；
- 将路径变量编译成结构化运行值；
- 保留凭据引用与延迟 JSON 指针；
- 产生统一 `CompatPlugin` 与结构化诊断；
- 合并等价能力，拒绝语义冲突。

`CompatPlugin` 是 adapters 的唯一 Plugin 输入：

```ts
interface CompatPlugin {
  schemaVersion: 1
  id: string
  name: string
  version?: string
  sourceId: string
  sourcePluginId: string
  formats: Array<'claude-code' | 'codex'>
  skills: CompatSkill[]
  mcpServers: CompatMcpServer[]
  hooks: CompatHook[]
  commands: CompatCommand[]
  agents: CompatAgent[]
  diagnostics: CompatDiagnostic[]
  manifestFiles: string[]
}
```

## 6. 安装事务

```text
仓库锁 + Source/Plugin 锁
        │
        ▼
创建 temp/<transaction-id>
        │
        ▼
获取并安全检查完整 Source
        │
        ▼
parser/source 定位候选
        │
        ▼
用户/调用方选择 1..N Plugin
        │
        ▼
物化外部 Git、逐个 Plugin parser
        │
        ▼
兼容与跨 Plugin 名称冲突检查
        │
        ▼
一次性提交 Source 与全部 installed 记录
        │
        ▼
按 enabled 策略启动父实例
```

一次安装多个 Plugin 时，静态阶段整体成功或整体失败。不会产生只安装了一部分的状态。

## 7. 共享 Source 更新

共享 Source 更新是单个事务：

```text
锁 Source + 全部受影响 Plugin
        │
        ▼
新版 Source 获取到 temp
        │
        ▼
重新读取 Marketplace
        │
        ▼
确认每个已安装 Plugin 仍存在
        │
        ▼
重新解析全部受影响 Plugin
        │
        ▼
检查全局能力冲突
        │
        ▼
停止旧父实例
        │
        ▼
原子切换 Source 与外部物化内容
        │
        ▼
写新扫描记录并启动新版
        │
        ├─ 成功：清理备份
        └─ 失败：恢复旧 Source、旧记录、旧运行实例
```

新 Marketplace 出现的 Plugin 只进入可安装列表，不会自动安装。已安装 Plugin 消失时默认拒绝更新，不猜测改名或迁移。

`update <pluginId>` 对独占隐式 Source 可直接执行；对共享 Source 必须由调用方显式确认影响范围。

## 8. 运行实例与 adapters

每个启用 Plugin 创建一个父 Cordis 运行实例：

```text
Plugin 父实例
├── Skill Provider
├── MCP 子插件 1..N
├── Hook 监听与运行集合
├── Command adapter（0.2.x 不执行）
└── Agent adapter（0.2.x 不执行）
```

父实例停止时：

- Skill Provider 撤销；
- MCP 子 Fiber 递归释放，工具注销并断开连接；
- Hook 监听撤销，未完成运行收到取消并等待清理；
- 所有 effect/disposer 一起释放。

如果部分能力失败，状态可为 `degraded`；如果全部可运行能力失败，父实例被立即 dispose，避免部分注册残留。

## 9. 冲突与稳定顺序

启用前检查活动 Plugin 的全局能力名，包括 MCP `serverName`、Skill 名称及已实现的其他可见名称。冲突产生 `error`，不会自动加前缀或覆盖。

恢复顺序固定为：

```text
priority 升序 → pluginId 字典序
```

## 10. 卸载与 Source 回收

```text
锁 Plugin
  ↓
阻止新运行请求
  ↓
dispose 父实例并等待子资源
  ↓
事务删除 installed/<pluginId>
  ↓
统计 Source 引用
  ├─ 仍被引用：保留 Source
  ├─ 引用为 0 且 explicit：保留 Source
  └─ 引用为 0 且 implicit：删除 Source 与 external 内容
```

DSH 已经持久化的历史会话、工具调用和 Hook 结果属于历史事实，卸载不会回删。
