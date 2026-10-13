# GitHub Codespace MCP 贡献与版本管理

本规则自首个设计提交开始生效。代码、设计和测试都进入 Git；本地凭据、运行状态和任务产物不进入仓库。项目以 MIT 开源，贡献内容须有权按同一许可证分发，复用第三方内容须保留其许可证和归属。

## 1. 提交原则

- 一个 Commit 对应一个明确、可解释的变更目的。功能、修复、重构和无关格式调整分开；紧密关联的实现、必要测试和文档在同一提交中交付。
- 在工作完成且相应检查通过后及时提交，不等到项目完成才生成一个巨大提交。需要保留中间状态时在工作分支提交，并如实说明尚未完成的检查，不伪造 PASS。
- 提交前查看 `git status`、完整差异和暂存差异；使用明确的文件路径暂存，避免把凭据、产物或其他任务改动一起提交。
- 不使用空泛的 `update`、`fix stuff` 或仅时间戳作为消息。主线不保留无说明的 WIP 提交。
- 不修改他人提交、不重写已公开历史；未推送的个人工作分支可按需要整理。普通流程不 force push。
- 修复保持聚焦，不在功能提交中顺带大范围重命名或升级依赖。引入依赖时解释用途、许可证和运行时影响。
- 编译产物、缓存、日志、下载数据、用户绑定、token 和真实任务输入不纳入 Git。确认可公开的最小测试 fixture 可以明确纳入，需去除个人/敏感信息。

提交格式使用 Conventional Commits：

```text
<type>(<scope>)!: <summary>

<可选正文：原因、行为变化、兼容性影响>

Validation: <执行的检查及结果；未运行项和原因>
BREAKING CHANGE: <有破坏性变更时说明迁移方式>
```

`scope` 和 `!` 按需使用。推荐类型：`feat`、`fix`、`docs`、`refactor`、`test`、`build`、`ci`、`chore`、`perf`、`revert`。推荐 scope：`auth`、`codespaces`、`source`、`jobs`、`runner`、`lifecycle`、`artifacts`、`ports`、`protocol`、`docs`、`repo`。正文可使用中文，摘要应简短明确。

示例：

```text
feat(lifecycle): stop managed codespaces after exporting results
fix(jobs): reconcile submissions after a lost response
docs(design): define instance release policies
feat(protocol)!: version the runner cancellation response
```

## 2. 验证门槛与证据

按变更性质执行有意义的检查，不为文档改动要求不存在的构建命令：

| 变更 | 最低检查 |
|---|---|
| 文档和配置示例 | 链接/命名一致性、可解析示例、`git diff --check` |
| 本地 MCP 或模块 | 类型检查、相关单元/契约测试；实现具备构建流程后执行构建 |
| runner、进程/取消/产物 | 相关 Linux 集成测试；涉及 SSH 存活或实例行为时补真实 Codespaces 验收 |
| 回收、权限、发布 | 故障路径、共享实例/数据保留边界；准确区分模拟与真实环境证据 |

报告统一使用 PASS、FAIL、NOT RUN；未验证的平台、环境和用户自测范围必须写明。仅有 fake gh 或容器测试不能标记为“真实 Codespaces 已验证”。检查通过后若修改了相关内容，应重跑受影响检查。

当前尚无源码、测试命令或 CI；不得把本规范描述成已部署的自动门禁。随着实现添加实际脚本与 CI，并同步更新此文档。

## 3. 分支与合并

- 主线为 `main`，首个项目基线可以直接提交到 main。
- 后续使用短生命周期工作分支，Agent 默认 `codex/<task>`；人工贡献可使用 `feat/<task>` 或 `fix/<task>`。
- 不创建长期 develop 分支；通过小型 PR 合并到 main。默认 squash merge 为一个可独立回退的变更；确有独立逻辑步骤时可保留有意义的提交。
- main 中的已实现功能应保持可构建、相关测试通过；当前设计阶段不因此虚构运行结果。
- 公共仓库创建后配置保护：禁止 force push/删除 main，已存在的 CI 检查作为合并条件。当前尚未配置远端保护，PR 人工审批要求由维护者决定，不让单维护者项目因无法自审而停滞。
- 多分支并行工作前检查 worktree 和未提交改动；不覆盖他人文件、不删除已有 stash。

## 4. 三种版本分别管理

| 版本 | 规则 | 当前状态 |
|---|---|---|
| 设计文档修订 | 文档页首 `0.x` 与日期，重大设计调整递增并说明 | 0.4，不代表软件发布 |
| 软件发行 | SemVer：`MAJOR.MINOR.PATCH`，标签 `vX.Y.Z` | 尚无发行，不创建假 v0.0.0 标签 |
| MCP 工具/runner/配置协议 | 显式协议/schema 版本及兼容矩阵 | 文档中的 schemaVersion=1 是提议，尚未实现 |

软件版本约定：

- 初始可安装预览版可从 `0.1.0-alpha.1` 开始；这是计划，不是当前已存在的版本。
- `0.x` 阶段：新增能力或不兼容变更提升 MINOR；保持兼容的修复提升 PATCH。不兼容变更仍须使用 `!`/BREAKING CHANGE 并说明迁移，不能借“尚未 1.0”隐藏破坏性影响。
- `1.0.0` 及以后：不兼容变化提升 MAJOR，兼容的新功能提升 MINOR，兼容修复提升 PATCH。
- 预发布使用 `alpha.N`、`beta.N`、`rc.N`，对同一目标版本递增；稳定版不带预发布后缀。
- 同一个发行版本发布后不可覆盖、复用或移动标签；问题通过新版本修复。
- 不因每次 Commit 自动提升软件版本。文档或 CI 单独调整通常进入 Unreleased，随适当发行交付。
- 实现 package manifest 后，以主包版本为单一软件版本来源；打包的 runner 与本地服务同版本交付，协议号独立。生成产物和握手应包含软件版本、Git SHA 和 runner 摘要，不手工维护多个漂移版本号。

工具参数、输出、任务状态语义或用户配置的破坏性变更必须明确协议/迁移策略。客户端与 runner 不兼容时拒绝执行并给出诊断，不静默升级后继续使用旧状态文件。

## 5. Changelog、标签与发行

`CHANGELOG.md` 保留 Unreleased 区域，按 Added/Changed/Fixed/Removed/Security 分类。记录用户可见行为和迁移说明，不复制所有 Commit 消息。准备发行时才建立带版本和日期的条目。

发行顺序：

1. 汇总范围、版本、兼容矩阵与未验证项；确认 MIT/第三方许可证和可公开内容。
2. 完成版本与 Changelog 更新，执行适用检查；发布构建须对应精确提交，不能从未知脏工作区打包。
3. 提交 release 准备变更，并记录 SHA。根据明确授权推送目标分支，核对远端 SHA。
4. 在已验证 SHA 上创建 annotated tag，例如 `v0.1.0-alpha.1`，按授权推送标签；不让自动化擅自签发版本。
5. 从该标签构建并发布对应产物及 SHA-256、验证摘要、已知限制。远端 GitHub Release 和包注册表发布是独立操作。
6. 核对远端标签对应提交、Release 版本与实际产物。下一轮改动回到 Unreleased。

首个预览版至少完成通用任务闭环和自动回收的真实 Codespaces 验收；未完成的 Docker、服务或平台支持应明确列为不可用。首个稳定版须满足承诺范围的验收矩阵并提供安装、升级、回收故障处理文档。

## 6. 授权与账号归属

- 项目正式名称：**GitHub Codespace MCP**。
- 计划开源账号：[TheRealKamisama](https://github.com/TheRealKamisama)。建议仓库 slug：`github-codespace-mcp`，尚未创建/绑定。
- 当前用户要求从一开始进行 Git 管理，授权建立本地基线 Commit；此后在已授权的开发任务范围内按本规则维护本地提交。
- “将会开源”不等于现在创建公共仓库、推送、打标签或发布包。执行这些外部操作需要该次请求或已有明确授权。
- Git 作者使用贡献者自身身份；本项目首次提交采用维护者 GitHub 账号名和 noreply 邮箱，仅设置 repository-local 配置，不修改全局配置，不编造 AI 联署作者。
- 开源账号归属不代表 GitHub 官方项目；README 不宣称官方背书。

贡献前检查是否存在更具体的项目指令。发生任务范围冲突时，以维护者明确的当前指令为准，并同步调整相关文档。

## 7. MCP 工程与语言约定

后续实现遵循 [MCP 工程原则](docs/MCP_ENGINEERING_PRINCIPLES.md)：稳定英文工具契约、中英交互模板与结果说明、schema 校验、structuredContent、调用失败与任务失败分离、stdout 协议纯净、真实能力协商、持久化幂等与自动回收。

修改模板或翻译时不改变权限、执行计划、错误码或任务去重逻辑；中英示例保持行为等价。修改协议时更新 schema、契约测试、兼容说明和 Changelog。首次公开可安装预览版前补齐英文入门文档，不把当前中文文档状态描述为已交付完整双语文档。
