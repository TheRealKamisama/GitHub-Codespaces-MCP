# 快速入门 / Quick Start

**当前状态：已有可从源码构建的 M0 传输 PoC 与 M1 首个切片（精确提交任务），没有可安装发行包。源码运行见 [M0 开发说明](M0.md) 与 [M1 首个切片](M1.md)；下面的完整任务流程仍是预期体验，尚不能作为已可运行的操作教程。**

## 中文

### 当前可以准备什么

安装 [Git](https://git-scm.com/downloads) 和 [GitHub CLI](https://cli.github.com/)，并确认 GitHub 账号可使用目标仓库及 Codespaces。Codespaces 的可用额度、组织策略和计费归属以账号实际设置为准。

在本地终端登录并检查身份；不要把凭据复制进项目配置：

```sh
gh auth login
gh auth status
```

准备一个本地 Git 项目及有权推送的远端。由本地开发工具完成 Commit → Push，远端任务验证对应的精确提交。尚未提交或推送的修改不会自动传入 Codespace。

### 首个可安装版本发布后的流程（待实现）

1. 按实际 Release 的安装说明安装 MCP，并在宿主 Agent 中配置；当前不提供占位包名或安装命令。
2. 检查账号与环境，将本地项目绑定到目标仓库、Codespace 和项目别名（例如 `dev/xxx`），选择实例创建及资源回收策略。
3. 在项目中配置一个已支持的命名任务。先使用普通编译或测试命令；Docker 构建与容器测试需要实例具备相应能力。
4. 请求 Agent 在本地提交、推送，再运行远端任务，例如：

   > 请在本地提交并推送当前修改，然后使用 GitHub Codespace MCP，在 dev/xxx 项目中验证本次提交。运行项目已配置的 verify 任务，取回日志和指定产物，完成后按绑定策略释放 Codespace。

5. 核对实际执行 SHA、各步骤结果、日志与产物，以及独立的资源回收结果。构建成功不代表测试通过；停止释放计算资源但保留存储，删除才释放对应存储。

任务完成后的回收由控制进程负责，不依赖用户每次在提示词中提醒。若报告回收失败或状态未知，应在 GitHub Codespaces 页面核对实例状态；本机离线或凭据失效时不能保证及时自动回收。删除前须确认需保留的数据已导出。

### 发布前需补齐的实际操作

安装/卸载与升级命令、宿主配置、最小任务示例、绑定与诊断方法、产物位置和回收故障处理，随实现逐步补充，并在首个可安装预览版前真实验证。当前运行验收为 **NOT RUN**。允许按实际实现小步重构本指南和相关代码，规则见 [贡献规则](../CONTRIBUTING.md#8-小步重构与文档演进)。

## English

**An unreleased M0 transport PoC and the first M1 slice (exact-revision jobs) can be built from source; no installable release is available. See [M0 development instructions](M0.md) and [M1 slice 1](M1.md). The complete task workflow below remains planned, not a working tutorial.**

### Prepare now

Install [Git](https://git-scm.com/downloads) and [GitHub CLI](https://cli.github.com/). Confirm access to the target repository and Codespaces, including your account's quota, organization policies, and billing settings.

Authenticate locally using `gh auth login`, then verify the account with `gh auth status`. Never copy credentials into project configuration. Prepare a local Git repository and a remote you can push to. Local development tools commit and push changes; remote tasks verify that exact commit. Uncommitted or unpushed changes are not transferred automatically.

### Planned workflow after an installable release

1. Install the MCP using the actual release instructions and configure your Agent host. No placeholder package or installation command is provided today.
2. Check the account and environment. Bind the local project to its repository, Codespace, and project alias such as `dev/xxx`; select creation and resource release policies.
3. Configure a supported named task. Start with a regular build or test command. Docker tasks require the corresponding remote capabilities.
4. Ask the Agent:

   > Commit and push the current changes locally. Then use GitHub Codespace MCP to verify that exact commit in project dev/xxx. Run the configured verify task, retrieve logs and selected artifacts, and release the Codespace according to the binding policy.

5. Check the executed SHA, step results, logs, artifacts, and the separate resource release result. A successful build does not prove tests passed. Stopping releases compute but retains storage; deletion releases the associated storage.

The controller is responsible for automatic release without a reminder in every prompt. If release fails or its status is unknown, check the instance in GitHub Codespaces. Timely automatic release cannot be guaranteed while the local machine is offline or credentials are invalid. Confirm that required data has been exported before deletion.

Actual installation, upgrade, uninstall, host configuration, minimal task, binding, diagnostics, artifact locations, and recovery instructions will be added and verified before the first installable preview. Runtime validation is currently **NOT RUN**. Small, scoped code and documentation refactors are allowed as implementation evolves; see [CONTRIBUTING](../CONTRIBUTING.md).
