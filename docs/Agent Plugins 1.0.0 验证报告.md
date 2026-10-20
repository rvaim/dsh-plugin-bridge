# Agent Plugins 1.0.0 验证报告

> 本文保留独立格式接入阶段的 201 项验证事实。当前包名已在工作区改为 `@rvaim/dsh-plugin-bridge`（插件桥 / Plugin Bridge），更名及其实际验证单独见[包更名说明](<包更名说明.md>)。

本轮基于工作区包版本 `0.4.4`，未发布；Plugin parser / Source parser 升级为 `3.1.0`。独立格式及来源基线见[兼容说明](<Agent Plugins 1.0.0 兼容说明.md>)。传统 Codex/CC 规则和上一阶段 164 项验证保留在各自文档。

## 验证范围

- 官方 `v1.0.0` 提交 `bd383552095128f6effe895b9257cfd580a6d179` 的本地 Manifest/MCP schema，与版本化官方 endpoint 的内容 hash 一致；加载阶段不访问网络或接受任意远端 schema。
- 根清单独立身份、未知字段和扩展的非致命例外；非法根清单阻止组件发现，传统清单与 Marketplace 不能补充或覆盖 portable core。
- 固定组件直接发现、大小写、真实路径边界与各级失败隔离。
- portable MCP transport、URL/Header、单 executable token、cwd 默认、保留 env、单次替换、未知模板保持字面、不使用传统凭据展开。
- Manager 安装、启停、更新保留数据、卸载、组件连接失败保留同级与 ZIP 包装目录。
- 继续运行全部传统解析、Hook、事务、安全与 Web operations 回归，避免独立格式引入传统规则变化。

## 结果

`npm run verify` 最终通过：**201/201 测试通过，0 失败、0 跳过、0 取消；DSH bundle、包结构与 415 个发布文件检查通过**。包含严格 TypeScript、Typert Host/Remote 生成与 Client 构建。

| 覆盖范围 | 测试数 | 结果 |
|---|---:|---|
| Manifest / 本地 schema / Skill / 真实路径与许可 | 16 | 全部通过 |
| portable MCP / 精确替换 / cwd / 环境及运行边界 | 14 | 全部通过 |
| 独立格式 Source 与安装启停更新卸载 | 7 | 全部通过 |
| 先前传统格式与公共生命周期回归 | 164 | 全部通过 |

新增测试 37 项。与前阶段相比，原先的独立排除测试更新为独立身份支持，不将 Agent Plugins 并入传统 Codex。

`git diff --check` 和 README/中文文档本地链接检查通过。`npm run verify:dsh` 通过；它明确输出依赖实际来自工作区 node_modules，仅验证该解析环境的导出契约，不代表当前 Desktop Web 挂载。

发布检查验证两份 schema 及完整 Apache 许可 JSON 随 `dist/src` 分发。源码 vendor 的字节 hash 与固定官方 tag/endpoint 一致；tsc 可能重排输出 JSON 空白，因此发布 schema 验证使用解析后语义深比较，不冒称输出字节 hash 不变。

交叉审查修复了 Source 预读名称的越界读取、URL scheme 大小写、连接启动失败的独立资源清理，以及 cwd 在实际根目录展开前用虚构哨兵误拒合法返回根路径的问题。所有修复均包含最终回归。

## 实测边界

未安装、启停或修改当前用户 profile，未执行第三方插件程序。运行测试通过受控 DSH Skill/MCP 接口，不等于完成公网 MCP 握手或浏览器端到端验证。当前 Desktop 的 Typert/Web 生成格式迁移仍是单独运行时工作。

stdio 与无配置 Header 的 streamable-http 可映射现有客户端；SSE 不回退 transport，合法但运行未支持的配置 Header HTTP 条目因缺少公开的跨 origin redirect 控制而跳过。未知 namespace 完全忽略，不执行 OpenAI 或其他客户端扩展。

Agent Skills frontmatter 使用本项目明确的 YAML 子集，宿主只支持 ASCII kebab-case 技能名；无法映射的单 Skill 报告并跳过。这是已验证功能子集，不声明完整实现所有 Agent Skills 扩展或 YAML 语法。Source 获取阶段继续沿用原有整体归档/符号链接安全策略；不因 portable parser 的组件隔离规则放宽获取阶段的拒绝边界。
