# Security and data handling

This extension allows the bound WeCom account to operate local Pi sessions with those sessions' permissions. It is intended for a personal account on a trusted computer, not a multi-tenant service.

- Only the bound owner's direct messages are accepted. While unbound, the daemon only checks binding codes and does not route prompts or download attachments. Codes are shown locally, expire after ten minutes, and are invalidated after five incorrect attempts or successful use.
- The HTTP service listens on loopback and requires a random token on every endpoint. Do not expose it through a public proxy or share the token.
- Credentials and tokens are stored locally with restrictive permissions. The setup Secret input is not masked. Reset the bot Secret and rerun setup if it may have been disclosed.
- The background RPC read-only guard prevents some accidental writes; it is not an OS sandbox and cannot prevent every shell or extension side effect. Terminal sessions keep their existing permissions.
- Prompts and attachments are sent to the model configured for the selected Pi session. Optional naming sends up to 1,000 characters of the first input to the selected naming model.
- Logs, received files, and results are retained locally and may contain private information. Redact them before sharing and clean up files as needed.
- Outbound delivery retries can produce duplicates if an acknowledgement is lost. An incoming message recorded before a daemon crash is not automatically replayed. Check session state before resending work.

Report vulnerabilities privately to the repository maintainer. If a private reporting channel is not available, request a contact without posting exploit details or private data in a public issue.

## 简体中文


本扩展让机器人主人通过企微驱动本机 Pi，权限等同于所选 Pi 会话。只用于自己的账号与受信任电脑，不作为多租户服务。

- 仅接收配置的主人 userid 单聊，并核对回调中的机器人标识；群聊与其他账号拒绝处理。
- 未绑定主人时不接触 Pi、不下载附件、不回传结果，只校验绑定码：码仅显示在本机，10 分钟过期，错 5 次作废，绑定成功即删除；首个发送正确码的单聊账号成为主人。绑定码不要发给他人或截图外传。
- daemon 仅监听回环地址，每个本机 HTTP 接口均校验随机 token。不要代理到公网或共享 token。
- Bot Secret 只保存于本机配置；运行目录默认 700，凭证与 token 默认 600。不要提交运行目录、日志、会话文件、附件或结果。
- 后台 RPC 的只读工具限制属于防误操作保护，不能阻止所有 shell 写入、网络请求或其他扩展的副作用，不是系统沙箱。TUI 使用自身权限。
- 用户文字、附件和命令会交给所选 Pi 模型处理；启用自动命名后，首条输入最多 1000 字符会发给所选命名模型。请使用适合所处理数据的模型服务。
- 收件文件、结果和日志默认保留；日志可能包含目录、会话名、部分输入与错误信息。分享排障材料前应自行脱敏。
- 首次配置界面的 Secret 输入不遮罩。凭证疑似泄露时，在企微机器人管理端重置 Secret，再运行 `/remote setup`；需要撤销本机 token 时先停止 daemon，删除运行目录的 `.token` 后重启并在 Pi 执行 `/reload`。

依赖锁定于 `package-lock.json`。提交前运行 `npm run check`，发布前另运行 `npm audit --omit=dev`。敏感信息检查仅覆盖常见模式，可通过 `PI_REMOTE_SENSITIVE_WORDS_FILE` 指定仓库外的个人关键词文件（每行一条，不打印命中内容）；它不能替代人工审查或历史扫描。

发现漏洞时，通过仓库维护者的私密渠道提供最小复现；不要在公开 issue 中粘贴凭证或业务数据。
