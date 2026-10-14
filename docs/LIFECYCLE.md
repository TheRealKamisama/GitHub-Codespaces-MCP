# 使用后自动停止 / Automatic Release (M1 Slice 2)

日期：2026-10-15。状态：**未发布源码实现**。本文描述 M1 的第二部分：专用实例在使用完成后由本地控制进程导出结果并自动停止。设计依据见 [开发设计 §5.4](../CODESPACE_MCP_DEVELOPMENT.md)；任务模型见 [M1.md](M1.md)。

## 两种归属

| ownership | 允许的 prepare | 使用后 | 说明 |
|---|---|---|---|
| `shared` | 仅 `reuse_only` | 从不启动、从不停止；`codespace_release request` 返回 `BLOCKED_SHARED_USAGE` | M0 起的默认含义；无法感知浏览器会话等外部使用 |
| `dedicated` | `reuse_only` 或 `start_existing` | `stop_after_export`：导出后停止 | 绑定即为显式接管：所有使用者应通过本工具登记任务或 hold |

`resourcePolicy`（仅 dedicated）：`graceSeconds` 默认 60，`exportTimeoutSeconds` 默认 300。同一实例的所有绑定必须同为 shared 或同为 dedicated，否则 `CONFIG_INVALID`。旧的 shared 绑定无需迁移。

`codespace_prepare` 的策略默认取绑定的 `preparePolicy`，且不能超过它（`POLICY_NOT_ALLOWED`）。`start_existing` 通过官方 REST `POST /user/codespaces/{name}/start` 启动 Shutdown 实例，单次调用最多等待约 20 秒，未就绪时返回 `state: "starting"`，用同一 requestId 继续调用。本工具仍**不创建、不删除**实例。

## 本地控制进程

`node dist/cli.js controller` 是隐藏的后台进程，由触及 dedicated 绑定的工具调用（bind、prepare、job_submit、codespace_release）按需启动；MCP 启动本身不访问云端。每个状态目录只运行一个（`controller.lock`，持有者进程已退出时接管）；所有 dedicated 实例都已停止且无待办时自动退出。它独立于 MCP 进程：对话窗口关闭不影响已接受的任务、导出与停止。日志写在状态目录的 `controller.log`。

每约 15 秒，对每个 dedicated 实例：

1. **对账**：发送后结果不明（`pending/unknown`）超过 60 秒的提交向远端查询；远端存在则记为 accepted，`JOB_NOT_FOUND` 则记为 `not_sent`（远端接受记录先于执行写入，所以不存在即未执行）。
2. **导出**：本机提交的已 settled 任务导出到状态目录 `archive/<jobId>/`：最终状态、日志（最多 8 MiB，按 1 MiB 分页且不拆分 UTF-8 字符）与带 SHA-256 的回执。先写入临时目录再改名，崩溃不会留下半个归档。超过上限时回执标 `truncated`，完整日志仍在远端。
3. **统计使用租约**：远端实例级注册表中所有项目、所有客户端未 settled 的任务；未过期的 hold；本机未确认的提交；5 分钟内的 prepare（避免“prepare 后提交前被停止”，显式 request 时忽略）；导出窗口内导出失败的任务。
4. **宽限**：无租约后进入 `grace`，期间出现新租约则重新开始；`graceSeconds: 0` 或 `codespace_release request` 跳过宽限。
5. **关闭入口并停止**：在远端用实例锁原子地再次检查空闲并写入关闭标记（新任务返回 `CODESPACE_RELEASING`，对已有 requestId 的对账仍可用），然后调用 `POST /user/codespaces/{name}/stop`。
6. **确认**：只有 GitHub 返回 `Shutdown` 后才记为 `stopped`、`computeRelease: RELEASED`；`storageRelease` 始终为 `RETAINED`（停止保留存储）。

失败处理：停止请求失败时先重新打开远端入口，再以指数退避加抖动重试；接受了但 120 秒内未生效也算一次失败；5 次后为 `action_required`，直到再次 `codespace_release request`。导出窗口内失败会阻止停止；窗口过后照常停止并标 `exportStatus: PENDING`，远端文件保留。实例被空闲超时或他人停止时记为 stopped。

## 远端实例注册表

`/workspaces/.codespace-mcp-instance/` 位于所有项目根目录之外，记录本实例上的每个受管项目根目录、hold 与关闭标记。新任务的接受与关闭检查在同一把实例锁内完成，因此不存在“检查空闲后又接受新任务”的竞争。关闭标记在实例重启（generation 变化）或 600 秒后失效：停止请求没有生效时任务可以恢复。测试可用 `CODESPACE_MCP_INSTANCE_ROOT` 指定 `/workspaces` 下的隔离目录，避免测试套件作为任务运行时关闭真实实例。

## 读取已停止实例上的结果

已归档的任务由 `job_get`、`job_logs`、`job_cancel` 直接读取本地归档，**不连接也不重新启动** Codespace。没有归档（如 `exportStatus: PENDING`）时返回 `CODESPACE_NOT_READY`；需要时可用 `codespace_prepare`（`start_existing`）显式启动后再读取。

## codespace_release

| action | 行为 |
|---|---|
| `status` | 释放记录：`state`（idle / waiting_for_leases / grace / stopping / stopped / blocked / retry_pending / action_required）、`blockers`、`computeRelease`、`storageRelease`、`exportStatus`、尝试次数与错误 |
| `request` | 不再等待宽限与 prepare 租约，尽快释放；任务、hold 与未确认提交仍会阻止停止（仅 dedicated） |
| `hold` / `unhold` | 有期限（60 秒到 4 小时）的保留，用于调试；记录在远端，所有客户端可见 |

## 尚未实现

`delete_after_export` 与实例创建（`create_if_missing`）；产物收集与下载（目前只归档状态与日志）；本地控制进程崩溃后由操作系统自动拉起（下次相关工具调用会重新启动它）；关机或离线期间的即时释放（依赖官方空闲超时兜底）；归档与远端任务目录的保留期清理。

## 检查与证据（2026-10-15）

| 项目 | 结果 | 边界 |
|---|---|---|
| 控制进程状态机 | PASS，模拟 | 导出→宽限→关闭→停止→GitHub 确认；hold、未确认提交、prepare 租约与 request；关闭竞争；停止失败退避与 action_required；接受但未生效的停止；导出窗口；共享实例与策略上限；start_existing；单实例锁 |
| 远端关闭协议 | PASS，Linux 容器 | 活动任务时拒绝关闭；hold 阻止关闭；关闭后新任务 `CODESPACE_RELEASING` 而已有任务仍可对账；只有关闭者能重新打开 |
| 端到端 | PASS，Linux 容器 | 真实 Application、Controller、bootstrap 与 runner，仅 gh/SSH 为桩：约 1.8 MB 多字节日志逐字节一致地导出，关闭入口、停止、停止后从归档读取 |
| 真实 Codespaces | 见下节 | |

## English

Slice 2 of M1 adds automatic release for **dedicated** bindings. A shared binding is never started or stopped by this server. A dedicated binding may use `start_existing`, and after use a local background controller (`node dist/cli.js controller`, started on demand, one per state directory) does the following:
- archives each settled job's final status and log locally, with SHA-256 receipts;
- counts usage across all projects and clients through an instance-wide remote registry, plus local unconfirmed submissions, recent prepares and failed exports;
- waits out a grace period;
- atomically closes remote intake and calls the official stop API;
- reports `stopped` / `RELEASED` only after GitHub confirms `Shutdown`.

Storage is always `RETAINED`. Stop failures reopen intake and back off, ending in `action_required` after five attempts. Archived jobs are read locally without contacting or restarting the instance. `codespace_release` exposes status, request, hold and unhold. Deletion, instance creation and artifacts are not implemented.
