# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# GitHub Codespaces MCP — Claude 交接说明

交接日期：2026-10-14。请先读本文，再读引用的项目文档。本文是接手开发的 Summary，不是云端验收报告。

## 项目目标与当前阶段

为本地 AI Agent 提供仅以 **GitHub Codespaces** 为远端后端的 MCP。开发在本地进行；宿主按用户授权完成 **Commit → Push**，MCP 在远端获取并验证精确提交，再执行通用任务，取回结果并自动释放受管资源。Docker 是可选任务模板，不是核心依赖。

当前仅交付了 **M0 传输 PoC 的本地实现**。代码基线为 `7dfd8f1966f53b44678ac691ceb1d067b376a8d8`，原开发分支为 `codex/m0-protocol-transport`。本次交接另有文档提交；接手时用 `git log`、`git status` 和远端 refs 确认最终版本，不把基线 SHA 当成永远最新。

内部 package 版本为 `0.1.0-alpha.0`，`private: true` 防止误发 npm；许可证 MIT。没有 Release、标签、公开软件包或完整云端验收。用户本次授权创建并推送 **Private** GitHub 仓库，名称中的空格规范化为 `GitHub-Codespaces-MCP`，账号为 `TheRealKamisama`。不要擅自改成 Public。

## 必读文档

1. [README.md](README.md)：项目概览。
2. [docs/M0.md](docs/M0.md)：**当前真实可用范围**、源码运行、故障边界和验证证据。
3. [CODESPACE_MCP_DEVELOPMENT.md](CODESPACE_MCP_DEVELOPMENT.md)：完整产品目标、模块边界、M0–M3、A01–A28 验收；大量能力仍未实现。
4. [docs/MCP_ENGINEERING_PRINCIPLES.md](docs/MCP_ENGINEERING_PRINCIPLES.md)：英文工具契约、中英输出、协议与安全原则、P01–P12。
5. [CONTRIBUTING.md](CONTRIBUTING.md)：Git、验证、兼容、版本和发行规则。
6. [docs/QUICKSTART.md](docs/QUICKSTART.md)、[SECURITY.md](SECURITY.md)：准备步骤、未交付的完整工作流及安全报告政策。

若目录中新增 AGENTS.md 或更具体指令，也要先阅读。设计文档中的完整工具表不能当作已实现 API 清单。

## 已实现的代码

技术栈：TypeScript、Node.js 22+、官方 MCP SDK、Zod；Linux 远端为 Python 3 标准库 runner。依赖版本与 lockfile 已固定。

| 文件/目录 | 职责 |
|---|---|
| `src/cli.ts`、`src/mcp.ts` | stdio MCP；仅声明 tools capability；启动时不访问云端 |
| `src/contracts.ts` | 严格输入与输出 schema，英文标识，schemaVersion=1 |
| `src/github.ts` | gh 身份检查、只读 API、实例查询和分页 |
| `src/application.ts` | 本机绑定、prepare 持久化/恢复、诊断编排 |
| `src/storage.ts` | JSON 状态、原子替换、跨进程目录锁 |
| `src/transport/process.ts` | shell=false、argv、时间/输出限制、Windows 进程树清理 |
| `src/transport/runner.ts` | 固定 SSH 入口、stdin JSON、随包 runner 摘要验证 |
| `runner/bootstrap.py` | 空目录归属检查、路径检查、安装与调用 runner |
| `runner/main.py` | 握手、generation、固定十秒 detached 诊断与查询 |
| `scripts/build.mjs` | 复制 runner，生成 version/Git SHA/dirty/runner 摘要元数据 |
| `tests/` | Node 本地/模拟/SDK 契约，以及 Python portable/Linux 集成测试 |

调用链（需跨文件才能看清）：`cli.ts` 读取 `dist/build.json`（缺失即无法启动，必须先构建），状态目录为 `CODESPACE_MCP_STATE_DIR`，否则 `%LOCALAPPDATA%` 或 `~/.local/state` 下的 `github-codespace-mcp` → `mcp.ts` 把工具调用分派到 `Application` → `Application` 经 `Github`（所有 gh 调用都走 `transport/process.ts` 的 `execute`）和 `RunnerPort` 工作。`Runner.call` 每次都重新校验 `dist/runner/main.py` 摘要，再通过 `gh codespace ssh` 下发**固定命令**（base64 内嵌的 `bootstrap.py`）；action、binding、build 元数据与 runner 源码全部走 stdin JSON。握手要求远端 version/gitSha/dirty/runnerSha256 与本地构建完全一致，因此改动 `runner/main.py` 或产生新提交后都必须重新构建。`Github` 的 `Executor` 和 `RunnerPort` 是测试注入模拟 gh/runner 的接缝。

当前只有五个工具：

- `environment_check`：检查 gh、结构化认证状态与 `/user` 实际账号。`gh auth status --json` 退出 0 不等于认证成功。
- `codespace_list`：已有实例分页列表，不启动实例。
- `project_bind`：校验账号、仓库、实例 owner，保存本机版本化绑定；仅 shared/reuse_only。
- `codespace_prepare`：先记录 operation，再检查 Available、安装 runner 并握手；同 requestId 重用 operationId。每次重新探测，不把旧 ready 当成当前 ready。
- `runner_probe`：start/status 一个固定十秒诊断，同 requestId 不重复启动；**不是通用 job**。

工具输出同时给出 structuredContent 和相同 JSON 文本；英文稳定错误码，中英错误消息。prepare 的调用结果包含操作状态，必须检查 `data.state` 和 `errorCode`；`ready` 仅说明 M0 传输就绪，不表示项目初始化或任意任务就绪。

## 尚未实现

project_inspect、本地项目根目录发现、远端 fetch/精确 SHA 检出、通用 job_submit/get/logs/cancel、步骤执行器、服务、输入上传、产物接口、端口转发、Docker 模板、实例创建/启动/停止/删除、本地回收控制进程、实例租约和自动导出/释放。

目前 start_existing/create_if_missing 被 schema 拒绝。既有共享实例不会被本 PoC 自动停止。不要通过新增一个“执行任意命令”捷径绕开身份绑定、持久化幂等、精确 SHA 或资源生命周期。

## 验证证据及复现

以下是 **2026-10-13 的已完成记录**，本次文档交接不冒充重新测试：

| 检查 | 结果与范围 |
|---|---|
| TypeScript 类型检查、构建 | PASS，Windows Node 24.21.0 |
| Node 测试 | PASS，14 项；真实 SDK stdio、Windows 参数/原子写入/进程树，以及模拟 gh/runner 故障恢复 |
| Python portable | PASS，5 项；包含模拟 sleep 的诊断状态测试，不能证明后台存活 |
| gh 身份模块 | PASS，真实只读；gh 2.100.0、keyring 和 `/user` 账号一致；不证明 Codespaces 权限 |
| Linux 安装/后台进程集成 | NOT RUN；当时无可用 Linux/WSL，1 项明确跳过 |
| 真实 Codespaces 安装/SSH 断线/重启 | NOT RUN；未绑定或修改云端实例 |
| 精确 SHA、通用任务、自动回收 | NOT RUN，未实现 |

```sh
npm ci
npm run typecheck
npm test
python tests/runner_test.py
```

单项测试：Node 测试从 `dist/` 导入，必须先 `npm run build`，再执行 `node --test --test-name-pattern "<名称片段>" tests/core.test.mjs`；Python 用 `python tests/runner_test.py PortableTests.test_generation_change_is_interruption_not_success`。`tests/runner_test.py` 直接按文件路径加载 `runner/main.py`，不需要构建。

`npm test` 包含构建。Python 命令需要可用的 Python 3；Linux 集成只在 Linux 且已有可写 `/workspaces` 时执行。Windows Node 22、macOS/Linux 本地客户端兼容性均未验证。

宿主直接启动 `node /absolute/path/to/dist/cli.js serve --stdio`；不要用 npm start 作为 stdio 宿主入口，npm 的标题输出会污染协议。构建要求本仓库 Git 元数据；输出 `dist/build.json`，不要提交 dist。

## 已知问题与需要复核的边界

- Windows 受限沙箱下 gh 曾报告认证错误，沙箱外真实认证模块验证成功；不要据此让用户反复登录或提供 token。
- npm 默认缓存在受限环境可能 EPERM，可进程级设置仓库内 `.cache/npm`；不改全局设置。
- Windows taskkill 可能被沙箱拒绝。实现已改为有界返回 PROCESS_CLEANUP_UNCONFIRMED；14 项最终 Node 检查在允许终止自己子进程的沙箱外运行。
- 本地 mutation.lock 在进程崩溃后不自动抢占；必须确认全部相关 MCP 进程退出后才能处理空锁目录，不可删除整个状态库。
- Available 与 SSH 连接之间有竞态；还没有 devcontainer post-create 就绪验证，也未真实验证 gh SSH 参数和 stdin 行为。
- 安装缺失/损坏 owner 标识时失败关闭；不自动接管用户目录。同用户恶意代码不在隔离保证内。
- 诊断记录在 spawn 前持久化；接受后崩溃可能留下 unknown，不能以新请求偷偷重跑。generation 变化与暂时不可达要区分。
- Linux 代码仍需实际运行和审查：路径/符号链接、flock、安装中断、会话脱离、摘要、坏状态与 generation 均不能只凭 Windows 单元测试判定通过。

## 建议接手顺序

1. 确认本地状态、origin、当前 SHA，阅读以上文档；复现适用的本地检查。先修真实发现的问题，不把完善所有技术规范作为开工前提。
2. 补齐 M0 的 Linux 集成与真实 Codespaces 传输验收。已有实例也需明确目标、可用目录及操作授权；不要从仓库推送授权推导创建/启动计费资源授权。最小真实验证步骤见 docs/M0.md。
3. 推进 M1：精确 pushed SHA 验证、隔离源码、通用多步骤任务、持久化 requestId→jobId、查询/日志/取消、产物；**同时完成本地回收控制进程、实例级租约、结果归档和自动停止**。自动回收未通过真实验收就不算任务闭环完成。
4. 再做 M2 项目体验、服务/端口/恢复和可选删除；M3 Docker 与发行。不要为赶进度提前发布“可用预览版”。

## 必须保留的约束

- 仅 GitHub Codespaces；不扩展通用 SSH、其他云或本地容器后端。
- 本地 Commit/Push 属宿主职责；MCP 消费已推送的完整 SHA，并在执行前验证实际 HEAD 与请求一致，不隐式 pull/merge 或改测最新分支。
- 长任务独立于 MCP/SSH 连接；幂等接受、状态查询、观测失败、任务失败和取消确认分别处理。
- 任务结束默认导出后停止受管实例；共享实例须协调全部租约；删除是独立策略且须确保保留数据已导出。停止保留存储，不能声称释放全部资源。
- 保持稳定英文工具/字段，中英仅影响呈现，不影响计划摘要、权限或去重。
- 按 CONTRIBUTING.md 小步提交；不强推、不重写已有公开历史，不提交凭据/本机状态/产物。报告 PASS/FAIL/NOT RUN，区分真实、模拟及用户报告。
- 本次仅授权私有仓库创建与推送，以及 Claude 交接文档；不附带公开仓库、发包、打标签、发布 Release 或计费云资源操作授权。后续按用户最新授权执行。

给 Claude 的起始任务：**接手本仓库，先复现并审查 M0，明确未验证边界，再按上述顺序推进可验收的小步开发。将实际行为、证据与文档同步更新，不把设计写成已可用功能。**
