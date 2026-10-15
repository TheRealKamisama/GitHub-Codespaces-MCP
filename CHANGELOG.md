# Changelog

本文件记录 GitHub Codespace MCP 的用户可见变化。软件采用 SemVer；当前没有软件发行版本。

## [Unreleased]

### Fixed

- 控制进程在导出与租约检查之间结束的任务可能未导出就停止实例（真实 Codespace 发现）；现先查租约再导出，运行中任务阻止停止。prepare 与 job_submit 不再跨网络调用持有本地状态锁。
- 真实 Codespace 的非登录 SSH 会话缺少 CODESPACE_NAME 与 git 令牌，导致 prepare 和私有 fetch 失败；bootstrap 现从平台 .env 补充缺失变量，步骤环境同时移除 GITHUB_CODESPACE_TOKEN。
- 中断任务的运行中步骤显示为 interrupted，未 settled 任务的汇总从步骤实时计算。

### Changed

- 设计 0.5：定位为通用 worker，取消 Docker 专用模板与步骤类型；Docker 构建与容器测试作为通用步骤场景验收，进程组外资源用 job 标签与 cleanup 步骤处理；明确 `cancelled` 仅确认步骤进程组。

### Added

- 产物：job_submit 可声明 artifacts，runner 在主步骤后、cleanup 前冻结到只读存储并计算 SHA-256（拒绝链接，配额 256 MiB/1000 文件）；artifact_download 经 gh codespace cp 或本地归档取回并按清单校验后不覆盖地放置；专用实例停止前导出产物（64 MiB/任务）。新增 artifact-build-and-download 演示。详见 docs/ARTIFACTS.md。
- M1 第二部分：dedicated 绑定与 start_existing；本地释放控制进程按需启动，导出 settled 任务到本地归档（状态、日志、SHA-256 回执），统计远端实例级租约与本地未确认提交、hold、prepare 租约，宽限后原子关闭远端入口并停止实例，GitHub 确认 Shutdown 后才报告释放；新增 codespace_release（status/request/hold/unhold）；已归档任务离线读取。已在真实 Codespace 上验证（A21、A22、停止后离线读取、start_existing），详见 docs/LIFECYCLE.md。
- 首轮真实 Codespaces 验证（2026-10-14）：在本仓库创建实例并通过真实 MCP stdio 服务验证 prepare、跨会话存活、私有仓库 fetch、精确 SHA、本项目 CI、示例、Docker/Postgres、取消、排队与停止重启后的 interrupted；详见 docs/M1.md。
- 示例场景（docs/SCENARIOS.md、examples/jobs/）：11 个仅使用通用步骤的 job 计划；6 个在 Linux 容器中实际运行并核对声明结果，Docker/Postgres/Node/Gradle/Rust 示例仅 schema 校验。runner 日志对被信号结束的步骤记录信号名。
- 未发布 M1 首个切片：只读 `project_inspect`；`job_submit/get/logs/cancel` 在已推送的精确提交上异步执行 command/shell 多步骤任务，独立 worktree、进程组取消与确认、cleanup 步骤、execution/verification/cleanup 分别汇总、requestId 幂等与响应丢失对账、项目运行槽。Linux 容器集成与端到端检查通过，真实 Codespaces 仍 NOT RUN；产物与自动回收未实现。详见 docs/M1.md。
- M0 首次在 Linux 客户端与 Linux 容器（可写 `/workspaces`）中通过检查；新增 `scripts/linux-container-test.sh`。

- Claude 接手 Summary（CLAUDE.md），记录 M0 实现、验证边界与后续路线；按授权建立 GitHub-Codespaces-MCP 私有仓库用于交接，未发布软件。

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
