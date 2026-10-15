# 示例场景 / Demo Scenarios

日期：2026-10-14。本页展示这个通用 worker 能做什么。每个场景都是 [`examples/jobs/`](../examples/jobs/) 中的一份 `job_submit` 计划，全部只使用通用的 `command`/`shell`/`cleanup` 步骤：**MCP 对 Docker、Node、Gradle 等工具没有任何专用代码**。

每个场景都标明验证程度，不把示例写成已验证的能力：

- **容器中实际运行**：`tests/runner_test.py` 在 Linux 容器（tmpfs `/workspaces`，本地 bare 仓库替代 github.com）中通过真实 runner 执行，并检查示例声明的 `expect` 结果。仍不是 Codespaces 验收。
- **仅 schema 校验**：`tests/examples.test.mjs` 确认它是有效的 `job_submit` 计划；需要对应工具链，实际运行为 **NOT RUN**。

## 如何使用

1. `project_inspect`（`localProjectRoot` 为本地检出的绝对路径）确认 HEAD 已推送，得到 `suggestedSource`。
2. 把示例文件中的 `plan` 与 projectId、requestId、source 合并后调用 `job_submit`：

```json
{
  "projectId": "dev/sample",
  "requestId": "ci-2026-10-14-1",
  "source": { "ref": "refs/heads/main", "commit": "<suggestedSource.commit>" },
  "timeoutSeconds": 600,
  "steps": [ "...examples/jobs/python-unittest.json 中 plan.steps 的内容..." ]
}
```

3. 用 `job_get`（`waitSeconds` ≤ 20）轮询到 `settled`，`job_logs` 按 `nextCursor` 分页读日志。断线后用同一 requestId 重新提交会得到同一个任务。

## 场景一览

| 场景 | 展示的能力 | 需要 | 验证程度 |
|---|---|---|---|
| [python-unittest](../examples/jobs/python-unittest.json) | 精确提交、无 shell 的 argv 步骤、由 test 步骤得出 verification | python3 | 容器中实际运行：succeeded，verification PASS |
| [service-integration](../examples/jobs/service-integration.json) | 在步骤内启动临时 HTTP 服务、等待就绪、测试；步骤结束后 runner 结束残留的服务进程 | sh、python3 | 容器中实际运行：PASS，且确认无残留进程 |
| [repository-report](../examples/jobs/repository-report.json) | 分析类任务、worktree 内可用 git、shell 管道 | sh、git | 容器中实际运行：verification NOT_CONFIGURED（不是 PASS） |
| [environment-probe](../examples/jobs/environment-probe.json) | 查看实例实际提供的 CPU/内存/磁盘与工具链，缺失的工具报告为 not installed 而不失败 | sh | 容器中实际运行 |
| [timeouts-and-optional-steps](../examples/jobs/timeouts-and-optional-steps.json) | 步骤级期限；optional 步骤超时不使任务失败；cleanup 总会运行 | sh | 容器中实际运行：slow-optional-check 为 timed_out，任务 succeeded |
| [failure-is-reported-honestly](../examples/jobs/failure-is-reported-honestly.json) | 测试失败后后续步骤为 not_run，cleanup 仍运行，失败不被掩盖 | sh | 容器中实际运行：failed / STEP_FAILED，verification FAIL，cleanup PASS |
| [docker-build-and-test](../examples/jobs/docker-build-and-test.json) | 用普通步骤构建镜像并在容器内测试；按 image ID 运行；按 job 标签清理容器 | docker | 仅 schema 校验 |
| [docker-postgres-integration](../examples/jobs/docker-postgres-integration.json) | 一次性 Postgres 容器（daemon 管理、在进程组外）、就绪等待、集成测试，无论成功/失败/取消都按标签清理 | docker、python3、pytest | 仅 schema 校验 |
| [node-ci](../examples/jobs/node-ci.json) | npm ci、可选 lint、测试；步骤级 `CI=true` | node、npm | 仅 schema 校验 |
| [gradle-build](../examples/jobs/gradle-build.json) | 长构建与任务期限；`--no-daemon` 让进程不超出所在步骤 | Java、仓库中的 Gradle wrapper | 仅 schema 校验 |
| [rust-cargo](../examples/jobs/rust-cargo.json) | `--locked` 使用提交中的锁文件；步骤级环境变量 | cargo | 仅 schema 校验 |

## 真实 Codespace 结果（2026-10-14）

在真实 Codespace 上实际运行并得到文档声明结果的示例：environment-probe、repository-report、service-integration、timeouts-and-optional-steps、failure-is-reported-honestly、node-ci（以本仓库为项目）。Docker 构建/容器测试与 Postgres 容器以同样的通用步骤模式在真实实例上通过，包括取消后 cleanup 移除容器；但 docker-build-and-test、docker-postgres-integration 示例本身需要带对应 Dockerfile / 测试的仓库，未按原样运行。gradle-build、rust-cargo、python-unittest 未在真实实例上运行。详见 [M1 真实验证](M1.md#真实-codespaces-验证2026-10-14)。

## 编写自己的任务时的要点

- **进程组外的资源**：runner 只管理步骤自己的进程组。`docker run -d`、数据库容器、`nohup` 进程不在进程组内：用 `CODESPACE_MCP_JOB_ID` 打标签，并在 `cleanup` 步骤中按标签清理（见两个 Docker 示例）。`cancelled` 只确认步骤进程组已退出。
- **后台守护进程**：会在步骤结束后继续存活的守护进程（如 Gradle daemon）应关闭，或放进同一步骤并接受步骤结束时被结束。
- **验证范围**：只有非 optional 的 `test` 步骤计入 `verification`。只有 build/analysis 步骤的任务是 `NOT_CONFIGURED`，不会报告“测试通过”。
- **工具缺失**：MCP 不预先探测或安装工具；缺失时对应步骤以 `EXECUTABLE_UNAVAILABLE` 或非零退出失败。可先运行 environment-probe 查看实例情况。
- **凭据**：步骤环境不含 `GH_TOKEN`/`GITHUB_TOKEN`。需要的密钥应通过实例已有的机制提供，不写进步骤参数或日志。

## 规划中，尚未实现

以下场景依赖还没有实现的功能，目前**不能**运行，列在这里只是为了说明方向：

| 场景 | 缺少的功能 |
|---|---|
| 把测试报告、构建产物下载到本地 | 产物收集与 `artifact_download`（M1） |
| 任务结束后自动导出结果并停止 Codespace | 本地回收控制进程、实例租约（M1） |
| 长期运行的开发服务器，并转发到本机浏览器 | `service` 步骤与 `port_forward`（M2） |
| 运行仓库中按名称定义的任务（`.codespace-mcp/project.json`） | 命名任务配置（M2） |
| 在 scratch 目录中处理本地上传的数据文件 | `input_upload` 与 workspace 执行上下文 |

在这些功能实现之前，报告和数据只能通过 `job_logs` 读取。

## English

This page shows what the general worker can do. Every scenario is a `job_submit` plan in [`examples/jobs/`](../examples/jobs/), built only from generic `command`, `shell` and `cleanup` steps. The MCP has no Docker-, Node-, Gradle- or Rust-specific code.

Six scenarios run for real through the actual runner in a Linux container, and the test checks the outcome each example promises: Python unit tests, an in-step HTTP service with a smoke test (no leftover process afterwards), a repository report, an environment probe, a per-step timeout on an optional check, and an honestly reported failure. The Docker build/test, Docker Postgres integration, Node CI, Gradle and Rust scenarios are schema-validated only; running them on a real Codespace is NOT RUN. None of this is Codespaces acceptance.

To use one, take `suggestedSource` from `project_inspect`, merge the example's `plan` with your projectId, requestId and source, then call `job_submit` and poll `job_get` and `job_logs`. Resources outside the step process group, such as containers, must carry the `CODESPACE_MCP_JOB_ID` label and be removed in a cleanup step. Downloading artifacts, automatic export/stop, long-running services with port forwarding, named tasks and input upload are planned and do not work yet.
