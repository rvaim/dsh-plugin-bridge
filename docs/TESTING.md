# 测试策略

## 1. 一键验证

```bash
npm run verify
```

该命令依次执行：

1. 清理旧编译产物；
2. TypeScript strict 编译；
3. Node.js 自动化测试；
4. 发布文件、CLI、DSH bundle 和 `npm pack --dry-run` 检查。

当前自动化测试数量和最终命令输出以 [VALIDATION-REPORT.md](VALIDATION-REPORT.md) 为准。

## 2. Source parser 测试

覆盖：

- Claude Marketplace；
- Codex Marketplace；
- 同一 Source 同时存在两种 Marketplace；
- 同名同真实目录合并；
- 同名不同目录冲突；
- 同目录关键元数据冲突；
- 损坏 JSON 与缺少必需字段；
- 不存在路径、路径逃逸、符号链接和普通文件目标；
- 外部 Git、git-subdir 与不支持位置；
- 单插件 Source；
- ZIP 单层包装目录；
- `--path`；
- Marketplace 之外的目录不会被递归猜测。

## 3. Plugin parser 测试

真实 Claude Code/Codex 结构进入 parser，再检查 `CompatPlugin`：

```text
旧插件目录
   ↓
parser
   ↓
CompatPlugin
```

覆盖：

- Skill、MCP、Hook、Command、Agent；
- Claude/Codex 路径和环境变量；
- Codex 现行顶层组件字段、默认发现补充、非法 `paths` 包装字段与 Marketplace manifest 回退；
- Claude 新能力的显式 unsupported 诊断；
- 非法能力路径和字段类型；
- MCP transport、env、timeout、凭据指针；
- Hook 事件、handler、matcher 和双方言冲突；
- 能力重名；
- Node 依赖 warning；
- 明文凭据不进入扫描结构。

## 4. Adapter 与 runtime 测试

Adapter 测试直接构造统一结构，不依赖 Claude/Codex 原始 fixture，以证明两层真正解耦。

覆盖：

- adapter 不读取 `.claude-plugin`、`.codex-plugin`、`.mcp.json` 或 Hook 原始配置；
- Skill Provider 注册和撤销；
- MCP 子插件与工具生命周期；
- Hook 事件、payload、deny/context、取消和清理；
- 部分能力失败进入 `degraded`；
- 全部能力失败立即 dispose 父实例；
- parserVersion/sourceRevision 变化重新扫描；
- 重扫后保留 Source 候选诊断；
- 下游异常脱敏。

测试使用受控 Fake DSH Context 验证 Cordis 风格 effect/disposer 和服务交互。它不是对真实远端 MCP 网络服务的声明。

## 5. Manager 与事务测试

覆盖：

- 显式/隐式 Source；
- 多 Plugin 选择与全有或全无安装；
- Source 只保存一份完整内容；
- Source 引用归零策略；
- 共享 Source 整体更新；
- 新候选不自动安装；
- 已安装 Plugin 消失时拒绝更新；
- 第二个新版 Plugin 启动失败时整体恢复；
- 外部 Git Source 更新与回滚；
- 运行实例无法停止时保留正式内容和恢复材料；
- 管理别名与重复安装；
- 损坏 install 记录时保守阻止删除；
- 启用失败回写 disabled；
- dispose 失败时不先删文件；
- 并发重复安装与锁回收；

## 6. Source 获取与安全测试

覆盖：

- 普通 ZIP/TAR/TGZ；
- ZIP CRC 篡改；
- `../` 路径穿越；
- ZIP/TAR 恶意符号链接；
- 单成员和总解压预算；
- 本地目录外链；
- Git 分支、标签、commit SHA；
- Git ref 注入；
- Git URL 凭据、查询参数、fragment 与协议；
- 不创建 checkout，因此不触发 smudge/filter；
- 不执行 package 生命周期脚本。

## 7. CLI 与包测试

覆盖：

- `source add/list/inspect/remove/update`；
- 单插件离线安装、检查和卸载；
- 多插件无交互选择；
- Marketplace `defaultEnabled=false`；
- 共享更新 `--yes`；
- 参数顺序与未知参数；
- JSON 输出；
- `package.json`、`cordis.patch.yml`、bin 和 Node engines；
- npm 包只包含 `dist/src`、中文文档和 bundle 文件，不夹带 `src/`、`test/`、`dist/test/` 或 `node_modules/`。

## 8. 真实 DSH 契约探针

在安装了目标 peerDependencies 的 DSH profile 或源码 checkout 中运行：

```bash
npm run verify:dsh
```

探针核对：

- `@deepseek-ai/cordis` 的 `Service`；
- `@deepseek-ai/schemastery` 的 schema API；
- `@deepseek-ai/dsh-hook-protocol` 关键函数；
- `@deepseek-ai/dsh-mcp-client` 可挂载插件形态；
- `dsh-compat` 的 `apply`、`inject` 和 `Config` 导出。

该探针不伪造缺少的依赖。如果当前环境没有目标 DSH 包，会明确失败并列出缺项。

## 9. 新增兼容逻辑的要求

每次增加生态格式或能力适配时，应同时满足：

1. parser fixture/结构测试；
2. 统一结构断言；
3. adapter 独立测试；
4. 生命周期和 dispose 测试；
5. 失败恢复测试；
6. Secret 与路径安全测试；
7. 文档和兼容矩阵更新。
