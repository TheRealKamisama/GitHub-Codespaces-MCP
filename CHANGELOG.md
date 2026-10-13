# Changelog

本文件记录 GitHub Codespace MCP 的用户可见变化。软件采用 SemVer；当前没有软件发行版本。

## [Unreleased]

### Added

- 未发布 M0 传输 PoC：官方 SDK stdio、严格中英结构化工具结果、gh 身份核验、版本化本机绑定、reuse_only prepare 持久化与摘要 runner 安装入口。
- 固定十秒 detached runner 诊断及相同请求重连查询；Windows 本地与模拟检查已通过，Linux/真实 SSH 存活仍 NOT RUN。
- 源码构建与锁定依赖、Windows 子进程参数/有界清理、状态原子写入、SDK 契约测试、Python 单元及待运行 Linux 集成测试；详见 docs/M0.md。

- 中英文快速入门草案、安全报告政策、开源支持规则，以及开发中小步重构代码和文档的约定；安装与运行流程仍待实现验证。
- Codespaces 专用 MCP 设计：本地 Commit/Push、精确提交的远端通用任务、异步日志与产物回传。
- 自动资源回收设计：导出后停止、可选导出后删除、实例租约与本地后台回收控制进程。
- MIT 许可证、贡献规则、Commit 规范、分支与版本发布原则。
- Git 忽略规则与跨平台换行约定。
- 中英双语交互设计与 MCP 工程原则：提示词层次、稳定工具契约、结构化错误、能力协商、stdio、安全与兼容验收。

除明确标为 M0 的实现外，其余为设计和项目管理基线。通用远端任务、精确 SHA 验证与自动回收仍未实现，未发布任何软件版本。
