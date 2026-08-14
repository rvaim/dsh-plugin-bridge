# 从 0.1.x 迁移到 0.2.0

## 1. 模型变化

0.1.x 使用：

```text
plugins/<pluginId>/package/
```

一份来源直接等同于一个 Plugin。

0.2.0 改为：

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
└── external/<sourceId>/
```

Source 保存完整原始来源；Plugin 安装记录只引用 `sourceId`、`sourcePluginId` 与位置，不再复制源码。

## 2. 自动迁移时机

管理器第一次执行 Source 或 Plugin 操作时，会在仓库锁内检查：

```text
$DSH_HOME/dsh-compat/plugins/<pluginId>/
```

可唯一识别时：

1. 创建一个独占的隐式 Source；
2. 将旧 `package/` 移入 `sources/<sourceId>/package/`；
3. 迁移 `state.json`、`data/` 和可复用缓存；
4. 创建 `installed/<pluginId>/install.json`；
5. 重新运行 Source parser 与 Plugin parser；
6. 原子提交成功后删除旧目录。

迁移不执行第三方脚本，不修改旧插件源码，不把能力复制到 DSH 其他目录。

## 3. 保守失败

如果旧 `package/` 中存在 Marketplace，并且包含多个 Plugin，而旧记录无法证明对应哪一个 Plugin，自动迁移会停止并完整保留旧目录。

系统不会使用以下方式猜测：

- 选择 Marketplace 第一个条目；
- 按目录扫描顺序；
- 仅凭旧管理 ID 模糊匹配；
- 自动拆分成多个已安装 Plugin。

## 4. 手工处理歧义迁移

1. 停止使用该 Harness Home 的 DSH 进程；
2. 备份整个目录；
3. 把旧 `package/` 作为新 Source 添加；
4. 使用 `--plugin` 或 `--path` 明确选择；
5. 核对 `data/` 是否需要迁入新的 `installed/<pluginId>/data/`；
6. 验证后再删除旧目录。

示例：

```bash
dsh-compat source add /backup/old-package --as recovered-source
dsh-compat install recovered-source --plugin plugin-a
```

## 5. 备份与回滚

迁移前建议：

```bash
cp -a "$DSH_HOME/dsh-compat" "$DSH_HOME/dsh-compat.backup"
```

迁移使用临时目录和原子重命名。出现异常时，系统优先保留旧目录和恢复材料。不要在 DSH 正运行时手工移动 `sources/`、`installed/` 或 `external/`。

## 6. 行为差异

- 0.2.0 的 `update <plugin>` 可能更新共享 Source 的多个 Plugin。
- 显式 Source 在引用归零后不自动删除。
- 隐式 Source 在最后一个引用卸载后自动删除。
- Plugin 目录不再含 `package/`。
- Source 新增 Marketplace Plugin 不会自动安装。
- `scan.json` 的 parser 版本升级到 `2.0.0`，旧缓存会重建。

## 7. 升级到 0.2.2

0.2.2 将 Plugin parser 版本升级为 `2.0.1`。DSH 下次加载已启用 Plugin 时会从 Source 真源自动重建 `scan.json`，因此 Claude Hook 新增的 `args` 结构无需重新安装旧 Plugin。

升级 bundle 后仍需重启一次对应 DSH profile；重启时会同时应用新的 Stop payload adapter 和 parser 重扫。Plugin 的 `data/`、启用状态与 Source 内容不会被删除。
