# 产物 / Artifacts (M1)

日期：2026-10-15。状态：**未发布源码实现**。任务可以声明产物：runner 在主步骤结束后、cleanup 步骤之前把它们冻结到任务自己的只读存储并计算 SHA-256；`artifact_download` 用 `gh codespace cp` 取回并按清单校验后放到本地；专用实例在自动停止前把产物与任务一起归档，停止后仍可离线下载。任务模型见 [M1.md](M1.md)，自动停止见 [LIFECYCLE.md](LIFECYCLE.md)，演示见 [SCENARIOS.md](SCENARIOS.md)。

## 声明

`job_submit` 的可选字段 `artifacts`（最多 32 个）：

```json
"artifacts": [
  { "name": "package", "path": "dist/app.tar", "required": true },
  { "name": "build-report", "path": "dist/report" },
  { "name": "coverage", "path": "coverage/lcov.info", "required": false }
]
```

- `name`：任务内唯一的标识（字母数字与 `_.-`），也是下载时使用的名称；不暴露远端路径。
- `path`：源码检出目录内的相对文件或目录；拒绝绝对路径、`..` 与源码根目录本身。
- `required` 默认 `true`。声明产物会改变计划摘要；没有声明产物的计划摘要与之前版本相同，已有 requestId 继续正常对账。

## 收集（runner）

- 时机：主步骤全部结束（成功、失败、超时或取消）之后，cleanup 步骤之前——cleanup 常会删除构建输出，失败任务的测试报告往往最有价值。源码准备失败或未执行到收集的任务报告 `not_collected`。
- 冻结：复制到 `<远端项目根>/.codespace-mcp/jobs/<jobId>/artifacts/<name>`，文件设为只读，SHA-256 按写入的字节计算；之后的步骤或任务无法改变下载内容。
- 安全：路径上任何一级是符号链接、目录产物中含符号链接或特殊文件，整个产物 `rejected / ARTIFACT_PATH_INVALID`，从不跟随链接；最终文件以 `O_NOFOLLOW` 打开。
- 配额：每个任务总计 256 MiB、目录产物合计最多 1000 个文件；超出的产物整体 `too_large`，不截断。
- 状态：`collected`（附 `kind`、`size`、`sha256` 或目录的逐文件清单）、`missing`、`rejected`、`too_large`、`not_collected`。任何必需产物未收集时，原本成功的任务变为 `failed`，错误码取该产物的错误（如 `ARTIFACT_MISSING`）；步骤失败、超时和取消的原因优先保留。可选产物缺失只会被报告。

清单在 `job_get` 的 `artifacts` 字段中，因此没有单独的列表工具。

## 下载（`artifact_download`）

输入 `projectId`、`jobId`、`artifact`（名称）与 `localDestination`（已有目录中的新绝对路径）。

1. 本地归档中已有该产物时直接从归档复制，不需要也不会启动 Codespace；否则实例须为 Available，用 `gh codespace cp -e [-r] remote:<传输路径> <临时路径>` 复制。传输路径是 runner 为该任务创建的别名 `/workspaces/.codespace-mcp-instance/transfer/<jobId>/<name>`（指向冻结存储，见下文“传输路径”），只含 `[A-Za-z0-9._/-]`；本地在调用 gh 前再次校验，否则返回 `TRANSFER_UNSUPPORTED`。
2. 临时副本放在目标旁边，按清单校验：文件的大小与 SHA-256；目录的文件集合必须完全一致、逐文件校验，且不得含链接。
3. 校验通过后放置：文件用硬链接实现“不存在才创建”，不支持硬链接时先检查再改名；目录在检查后改名。已存在的目标返回 `DESTINATION_EXISTS` 且不被修改。

任何失败（`TRANSFER_FAILED`、`HASH_MISMATCH`、传输不完整）都会删除临时副本，不会留下目标文件。传输本身使用 gh 自带的 scp 通道，不另造传输协议；首次使用时 gh 可能在 `~/.ssh` 创建密钥，与 `gh codespace ssh` 相同。

### 传输路径

`gh codespace cp` 的默认“字面”模式会为 scp 旧协议给远端路径加单引号；OpenSSH 9 起客户端 scp 默认使用 SFTP 协议，引号会成为文件名的一部分（真实环境中 OpenSSH 10.0 报 `No such file or directory`），改用旧协议 `-O` 又会触发 scp 的严格文件名检查。因此：runner 在接受声明了产物的任务时创建只含安全字符的别名，并在状态中报告 `transferRoot`；客户端用 `-e` 复制该别名下的路径——这样的路径在两种协议下展开结果都是它本身。远端项目根目录可以包含空格、Unicode 或引号，它不会出现在传输命令中。

## 自动导出（专用实例）

控制进程归档已 settled 的任务时，先按必需产物优先的顺序把已收集的产物复制到暂存目录并逐一校验，再与状态、日志一起原子地移入本地归档。每个任务的导出配额为 64 MiB；超出配额的产物记为 `artifactsSkipped`，留在实例上（停止保留存储），这是有意的取舍而不是失败。导出窗口内复制或校验失败会阻止停止并重试；窗口过后照常停止，状态标为 `exportStatus: PENDING`。

## 检查与证据（2026-10-15）

| 项目 | 结果 | 边界 |
|---|---|---|
| 收集与校验规则 | PASS，可移植 Python | 文件、目录、Unicode 名称、路径与目录内符号链接、特殊文件、缺失、大小与文件数配额、只读冻结副本、声明校验 |
| 任务语义 | PASS，Linux 容器 | 必需产物缺失使任务失败但保留已收集产物；cleanup 删除源文件后冻结副本不变；未执行到收集为 not_collected；演示任务全部产物状态符合声明 |
| 下载语义 | PASS，模拟传输 | 文件与目录、不覆盖、篡改、截短、传输失败、目录多出文件均不留下文件；名称与状态错误；相对路径与不存在的父目录 |
| 导出与离线下载 | PASS，模拟 + Linux 容器端到端 | 导出配额与跳过、导出失败阻止停止且不留半个归档；端到端中下载内容与本地重新计算的 `git archive` 和数据块逐字节一致，停止后从归档离线下载 |
| 计划摘要兼容 | PASS | 不声明产物的计划摘要与上一版本公式一致 |
| 真实 Codespaces | PASS | 见下节 |

## 真实 Codespaces 验证（2026-10-15）

经用户授权在本仓库创建实例 `mcp-artifact-test-vgg44gxvg943wrvx`（basicLinux32gb），通过真实 MCP stdio 服务、真实 `gh codespace cp` 与真实后台控制进程验证；客户端 OpenSSH 10.0，实例 git 2.55，本机 git 2.50。

| 场景 | 结果 | 实际观察 |
|---|---|---|
| 演示任务 | PASS | 精确提交上构建、检查与 cleanup（删除 dist/ 与 reports/）均通过；5 个产物 collected，可选 coverage 为 missing |
| 在线下载（gh codespace cp） | PASS | 5 个产物（含目录与 Unicode 名称）全部校验通过，每次约 9–12 秒；5 MiB 数据块与本地重新计算的字节一致；package 与**本机** `git archive` 同一提交逐字节一致（跨 git 版本） |
| 停止前导出 | PASS | 控制进程导出全部 5 个产物并逐一校验后归档，随后自动停止，GitHub 确认 Shutdown |
| 离线下载 | PASS | 实例 Shutdown 时 5 个产物均从本地归档下载，约 0 秒，与在线下载逐字节相同；实例保持 Shutdown |
| 控制进程崩溃恢复 | PASS | 控制进程在停止确认前被终止（会话中断），记录停在 stopping；下一次工具调用启动的新控制进程确认 Shutdown 并记为 stopped / RELEASED |

真实环境发现并已修复：

1. `gh codespace cp` 字面模式与 SFTP 模式 scp 不兼容，所有下载均为 TRANSFER_FAILED（未写入任何文件）：改为别名路径 + `-e`（`5e260e6`）。
2. 由不带别名的 runner 收集的任务无法复制产物，导致整个任务（包括状态与日志）在导出窗口内无法归档：现归档状态与日志并把产物记为 skipped（`c3d7269`）。

另外观察到：控制进程运行期间重新构建 `dist/`，旧进程内存中的构建摘要与磁盘上的 runner 不一致，每轮都以 HASH_MISMATCH 失败关闭；约 5 分钟后它不再把实例算作待办并可退出，下一次工具调用会以新构建启动控制进程。这是预期的失败关闭行为。

## English

Jobs can declare artifacts (`name`, relative `path`, `required`). After the main steps and before cleanup steps, the runner freezes them into a read-only per-job store with SHA-256. It never follows links, enforces 256 MiB and 1000 files per job, and fails an otherwise successful job when a required artifact is missing. The manifest appears in `job_get`. `artifact_download` copies a frozen artifact with `gh codespace cp` (literal remote path, no custom transfer protocol), or from the local archive when exported. It verifies size and SHA-256 per file before placing the copy, and never overwrites. For dedicated bindings the controller exports artifacts (64 MiB per job, required first) with the job before the automatic stop, so they remain downloadable offline.
