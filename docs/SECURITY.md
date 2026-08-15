# 安全模型

## 1. 威胁边界

Source 和旧插件内容均视为不可信输入。安装阶段的目标是完成静态获取、验证与解析，而不是执行第三方代码。

默认允许：

```text
clone / copy / extract / read / parse / validate
```

默认禁止：

```text
npm install
pnpm install
bun install
prepare
postinstall
setup.sh
任意插件自带安装脚本
```

## 2. Git 获取

- URL 只允许明确支持的协议。
- HTTP/HTTPS/Git URL 不允许内嵌用户名、密码或 Token。
- 拒绝查询参数和 fragment，避免敏感值写入元数据。
- Git ref 使用安全子集，拒绝选项注入、rev 表达式和控制字符。
- 获取过程不创建工作树，不执行 checkout，不触发 smudge/filter。
- 最终内容不保留 `.git`，并记录实际 commit。

Marketplace 外部 Git Plugin 也使用相同获取器，并由 Source 的更新事务整体管理。

## 3. 归档解压

ZIP/TAR/TGZ 解压前后检查：

- `../` 与路径穿越；
- 绝对路径；
- Windows 盘符路径；
- NUL；
- 指向目标目录外的符号链接；
- 非法成员类型；
- ZIP CRC；
- 单文件大小、总解压体积和成员数量预算。

任何成员都不得逃出当前 `temp/<transaction-id>/`。失败时删除事务目录，不提交 Source。

## 4. Source 与 Plugin 路径

- Source ID、Plugin ID 和外部缓存目录名必须通过存储 ID 校验。
- Marketplace `source-path` 必须规范化为 Source 内路径。
- 对符号链接使用真实路径判断，最终目标必须位于 Source 内且是目录。
- `paths` 逐项经过同样校验。
- 不允许通过路径名访问 `dsh-compat` 根目录外内容。

## 5. 凭据与延迟配置

真正的 Token、API Key、Secret、Authorization Header 或 URL Token 不得写入：

```text
source.json
install.json
scan.json
日志
inspect 输出
持久化异常消息
```

`${NAME}` 保存为环境变量引用。原 JSON 中可能含明文的 command、args、env、url、headers 和 Hook 命令，安装扫描只保存 `deferred-json` 文件/JSON Pointer；运行时才从原 Source 文件读取并解析。

脱敏器覆盖：

- Bearer Token；
- Authorization/Header 常见形式；
- URL 查询参数；
- `token=`、`api_key=` 等键值；
- 常见 GitHub/OpenAI 风格密钥前缀；
- MCP 下游异常中的已解析环境变量和 Header 值。

## 6. 事务与锁

至少使用：

- 仓库锁；
- Source 锁；
- Plugin 锁。

锁文件记录进程信息，并区分存活进程、陈旧锁和半写锁。并发安装同一 Plugin、Source update 与 install/uninstall、update 与 disable 等操作被串行化。

正式目录只通过原子重命名提交：

```text
无状态 → 完整状态
```

不允许“下载了一半”或“只更新共享 Source 中一部分 Plugin”。

## 7. 共享 Source 更新安全

Source 更新先在临时目录取得新版并完成：

- Marketplace 重扫；
- 已安装 Plugin 存在性检查；
- 全部受影响 Plugin 重新解析；
- 跨 Plugin 冲突检查；
- 外部 Git 物化；
- 静态诊断。

全部通过后才停止旧实例和切换 Source。启动新版失败时恢复旧 Source、旧外部缓存、旧安装记录和旧父实例。

如果极端文件系统错误导致回滚重命名本身失败，事务恢复材料会保留，不会为了“清理干净”而删除唯一可恢复副本。

## 8. 卸载顺序

卸载必须先停止父运行实例并等待所有子资源释放，再事务删除 `installed/<pluginId>`。Source 只有在引用为零且 `ownership=implicit` 时才能删除。

损坏或无法读取的 `install.json` 会触发保守阻止：系统不会在无法证明引用关系时删除 Source。

## 9. 运行时边界

安装阶段不执行代码不代表启用阶段无风险。启用 Plugin 后，MCP Server 与 Hook 本质上是用户选择运行的第三方程序，权限取决于 DSH Shell/Sandbox、操作系统账户和部署配置。

建议：

- 在受控 DSH profile 中运行；
- 使用最小权限凭据；
- 对不可信插件保持禁用并先执行 `inspect`；
- 根据部署环境配置 Shell/Sandbox；
- 对要求 Bash、Node、Python 或其他可执行文件的插件显式准备环境；
- 不把 Source 目录授予不必要的写权限。

## 10. 已知安全边界

- 当前版本不提供通用依赖安装沙箱。
- 不会验证远端 MCP Server 的业务可信度。
- 不会把旧插件命令自动重写为“更安全”的替代命令，因为那会改变语义。
- 运行时网络访问和进程权限最终由 DSH 与部署环境控制。
