# GitHub Codespace MCP

面向本地 AI Agent 的 GitHub Codespaces 工作区管理与通用任务执行 MCP。

**状态：已有未发布的 M0 传输 PoC 与 M1 首个切片（精确提交任务），可从源码构建；没有可安装发行版，未完成真实 Codespaces 验收。**

已实现 stdio MCP、gh 身份检查、已有实例的本机绑定、reuse_only prepare、固定十秒 runner 诊断，以及 M1 首个切片：只读 `project_inspect` 和在已推送精确提交上执行的异步多步骤任务（`job_submit/get/logs/cancel`）。Windows、Linux 本地、模拟与 Linux 容器检查已运行；产物、自动导出/回收、实例租约尚未实现。源码运行方式、证据与剩余边界见 [M0 开发说明](docs/M0.md) 与 [M1 首个切片](docs/M1.md)。

远端仓库为 [TheRealKamisama/GitHub-Codespaces-MCP](https://github.com/TheRealKamisama/GitHub-Codespaces-MCP)，当前为 **Private**。项目许可证为 [MIT](LICENSE)，后续公开需另行授权；npm 包名尚未预留，没有已发布包。

## 目标流程

1. 用户在本地通过 GitHub CLI 登录。
2. Agent 在本地修改代码并按授权 Commit → Push。
3. MCP 在 Codespace 中检出精确提交，执行编译、测试、脚本或临时服务等任务。
4. 下载日志和指定产物，自动停止受管 Codespace；可选导出后删除，释放后续存储占用。

仅覆盖 GitHub Codespaces。MCP 是通用 worker，不内置任何工具链的专用逻辑：Docker 构建和容器测试与 npm、Gradle 一样，由普通 command/shell 步骤调用，容器等进程组外资源由 cleanup 步骤按 job 标签清理；普通远端任务无需 Docker。

## 项目文档

- [Claude 交接 Summary](CLAUDE.md)：当前实现、历史验证证据、未完成项、接手顺序与授权边界。

- [M0 开发 PoC / Development PoC](docs/M0.md)：传输、绑定、prepare、源码构建、恢复边界和检查结果。
- [M1 首个切片 / Exact-Revision Jobs](docs/M1.md)：project_inspect 与精确提交任务的行为、幂等恢复、远端布局和检查结果。
- [快速入门 / Quick Start](docs/QUICKSTART.md)：中英文准备步骤与待实现的完整任务流程，当前无可安装发行版。
- [安全政策 / Security Policy](SECURITY.md)：安全问题报告方式、当前渠道状态与披露原则。
- [开发设计与代码边界](CODESPACE_MCP_DEVELOPMENT.md)：模块、接口、任务模型、回收策略和验收标准。
- [贡献、Commit 与版本管理](CONTRIBUTING.md)：日常开发、验证、分支和发行规则。
- [中英交互与 MCP 工程原则](docs/MCP_ENGINEERING_PRINCIPLES.md)：语言层次、协议契约、安全和兼容性要求。
- [变更记录](CHANGELOG.md)：尚未发布与正式发行的用户可见变化。

设计文档版本、软件 SemVer 和 runner/配置协议版本互相独立。当前不提供安装命令，不将设计里程碑标为软件 Release。

开发允许小步重构代码并同步修订文档，不要求提前补齐所有技术规范；范围、验证与兼容规则见贡献指南。

语言设计：工具名与字段保持单套英文，M0 错误消息支持中英文；完整自然语言任务工作流和可选模板尚未交付。当前文档以中文为主，M0 和快速入门包含英文说明。
