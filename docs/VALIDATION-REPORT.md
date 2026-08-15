# dsh-compat 0.3.1 验证报告

验证日期：2026-08-15  
交付版本：`0.3.1`
目标 DeepSeek Harness：`0.1.0-rc.6`
Plugin parser：`2.0.1`
Source parser：`2.0.0`

## 1. 结论

0.3.1 已完成 DSH Web 原生设置集成与诊断详情 disclosure，并在隔离的真实 DSH `0.1.0-rc.6` Web profile 中通过启动图、Host/Client Remote、设置页面和在线生命周期验证。

已验证的关键结果：

- “兼容插件”按 DSH `settings.section` 机制出现在 Agent 预设之后；
- 浏览器 bundle 由 DSH `/plugins/dsh-compat/client.js` 提供并进入 `window.__DSH_BOOT__`；
- 空状态、添加弹窗、多插件复选列表、插件列表、卸载确认、Toast 和暗/浅主题均正常；
- 多插件确认后复用第一次固定的 Source 快照，不重复拉取；
- 两个测试插件通过 Web 添加后均显示 `running`；
- 同一运行进程内启停状态实际完成 `true → false → true`，不需要重启；
- 当前页面的 list、beginAdd、completeAdd 和 setEnabled RPC 无浏览器错误或 Host 错误；
- `dsh-compat` bundle 本身变更仍遵守 DSH Client Modules 的重启边界。

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
6. CLI help 冒烟；
7. 发布清单和 `npm pack --dry-run` 白名单检查。

自动测试覆盖 parser、Source/Plugin manager、事务回滚、runtime/adapters、Hook/MCP/Skill、CLI、安全边界和 Web gateway。Web 新增测试特别验证：

- 单插件自动安装；
- 多插件二阶段选择；
- 原输入目录删除后仍可从固定快照完成安装；
- 取消选择清理临时 Source；
- 同一 Source 并发选择的清理责任转交；
- 在线启用、停用和卸载映射。

`npm run verify:dsh` 额外导入真实 rc.6 包并核对：

- Cordis `Service`；
- Schemastery schema API；
- Hook Protocol 关键函数；
- MCP Client 可挂载形态；
- `CompatWebGateway` 与 `CompatManager.prepareInstall()`；
- `compatAdmin/{beginAdd,cancelAdd,completeAdd,list,setEnabled,uninstall}` 的 Typert Host/Remote descriptor。

## 3. 真实 DSH Web 验证

使用系统安装的 DSH `0.1.0-rc.6` 创建临时 `web` profile，再安装本地 tarball：

```bash
dsh plugin --profile web add ./dsh-compat-0.3.1.tgz
dsh --profile web --dump-config
dsh --profile web --host 127.0.0.1 --port 0
```

验证观察：

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

真实浏览器中没有执行最终卸载确认，以免通过浏览器删除本地数据；卸载的 stop-before-delete、失败保留和 Source 回收由自动化生命周期测试覆盖。

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
- UI 只使用 DSH primitives、locale、Settings Slot 和 `--dsw-*` Token。

## 6. 已知验证边界

本报告不扩大声明以下内容：

- 未对任意第三方远端 MCP 服务完成网络端到端握手；
- 未在真实模型会话中执行所有第三方 Hook；
- 未通过真实公网超慢 Git 仓库逐帧捕获 loading 动画；本地 Source 完成过快，但进行中 DOM、按钮禁用与 loading 图标已进入编译后的 Client bundle，并通过实现审查；
- 不支持的 Claude Code/Codex 能力仍以结构化诊断公开，不会被描述为已兼容。

## 7. 发布命令

```bash
npm run verify
npm pack --ignore-scripts
dsh plugin --profile <profile-name> add ./dsh-compat-0.3.1.tgz
```

安装或升级 `dsh-compat` 后重启该 profile。之后可直接在“设置 → 兼容插件”中在线添加和管理旧 Plugin。
