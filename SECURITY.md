# 安全政策 / Security Policy

## 当前状态与支持版本

项目处于设计阶段，没有软件发行或已验证的安全运行能力。发行后的版本维护策略见 [贡献规则](CONTRIBUTING.md#9-开源维护与支持)。本政策不承诺漏洞响应或修复时限。

## 报告安全问题

公共仓库建立后，应在首次预览版发布前启用 GitHub Private Vulnerability Reporting，并核对私密报告入口。当前仓库尚未创建，因此该入口尚不可用，也没有已公布的替代安全邮箱。

不要在公开 Issue、PR 或日志中贴出 token、私钥、私人数据或可直接利用的漏洞细节。私密入口不可用时，可以通过维护者的 [GitHub 主页](https://github.com/TheRealKamisama)查询已公布的联系渠道；如果没有私密渠道，仅公开请求建立安全联系，不附漏洞细节。

私密报告应包含受影响版本、复现条件、潜在影响和已脱敏的最小复现。若凭据已泄露，应先撤销或轮换凭据；删除公开文本不能恢复凭据安全。维护者确认问题后，在私密渠道协调修复、版本与披露，再发布不含敏感数据的安全公告。

## English

This project is in the design phase and has no software releases. See [CONTRIBUTING](CONTRIBUTING.md) for the planned version support policy. No response or remediation SLA is promised.

GitHub Private Vulnerability Reporting must be enabled and checked before the first public preview. The public repository has not been created, so this reporting channel is not available yet, and no alternative security email has been published.

Do not publish credentials, private data, or exploitable details in issues, pull requests, or logs. Check the [maintainer's GitHub profile](https://github.com/TheRealKamisama) for an established private contact. If none exists, request a private reporting channel without disclosing the vulnerability. Include affected versions, reproduction conditions, impact, and a redacted minimal example in the private report. Revoke or rotate exposed credentials immediately. Coordinate remediation and disclosure privately before publishing a sanitized advisory.
