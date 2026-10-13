# GitHub Codespace MCP

面向本地 AI Agent 的 GitHub Codespaces 工作区管理与通用任务执行 MCP。

**状态：设计阶段，尚无可安装的软件版本，未完成真实 Codespaces 验收。**

项目计划在 [TheRealKamisama](https://github.com/TheRealKamisama) 账号下开源，许可证为 [MIT](LICENSE)。建议仓库标识为 `github-codespace-mcp`；具体远端仓库尚未创建或绑定，npm 包名也尚未预留。

## 目标流程

1. 用户在本地通过 GitHub CLI 登录。
2. Agent 在本地修改代码并按授权 Commit → Push。
3. MCP 在 Codespace 中检出精确提交，执行编译、测试、脚本或临时服务等任务。
4. 下载日志和指定产物，自动停止受管 Codespace；可选导出后删除，释放后续存储占用。

仅覆盖 GitHub Codespaces。Docker 构建和容器测试是可选任务模板，普通远端任务无需 Docker。

## 项目文档

- [开发设计与代码边界](CODESPACE_MCP_DEVELOPMENT.md)：模块、接口、任务模型、回收策略和验收标准。
- [贡献、Commit 与版本管理](CONTRIBUTING.md)：日常开发、验证、分支和发行规则。
- [变更记录](CHANGELOG.md)：尚未发布与正式发行的用户可见变化。

设计文档版本、软件 SemVer 和 runner/配置协议版本互相独立。当前不提供安装命令，不将设计里程碑标为软件 Release。
