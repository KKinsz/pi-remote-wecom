# Pi Remote WeCom

[English](README.md) · 简体中文

用手机企微遥控电脑上的 Pi。一个 Pi 扩展，集成多会话管理、终端标签命名和任务结果回传。

- **随时接着聊**：选择正在运行的会话，或查找历史会话继续任务。
- **远程开工**：新建终端或后台会话，发送文字、图片和文件，切换模型、停止任务。
- **会话自动命名**：根据首条输入生成名称，也可手动修改；终端标签与手机会话名同步。
- **本机直连**：通过企微智能机器人长连接工作，无需额外服务器。

## 功能预览

| 命令帮助 | 会话管理 | 创建会话 | 切换模型 | 任务回传 |
| --- | --- | --- | --- | --- |
| <a href="https://raw.githubusercontent.com/KKinsz/pi-remote-wecom/main/docs/images/commands.png"><img src="https://raw.githubusercontent.com/KKinsz/pi-remote-wecom/main/docs/images/commands.png" width="180" alt="命令帮助"></a> | <a href="https://raw.githubusercontent.com/KKinsz/pi-remote-wecom/main/docs/images/sessions.png"><img src="https://raw.githubusercontent.com/KKinsz/pi-remote-wecom/main/docs/images/sessions.png" width="180" alt="会话管理"></a> | <a href="https://raw.githubusercontent.com/KKinsz/pi-remote-wecom/main/docs/images/create-session.png"><img src="https://raw.githubusercontent.com/KKinsz/pi-remote-wecom/main/docs/images/create-session.png" width="180" alt="创建会话"></a> | <a href="https://raw.githubusercontent.com/KKinsz/pi-remote-wecom/main/docs/images/switch-model.png"><img src="https://raw.githubusercontent.com/KKinsz/pi-remote-wecom/main/docs/images/switch-model.png" width="180" alt="切换模型"></a> | <a href="https://raw.githubusercontent.com/KKinsz/pi-remote-wecom/main/docs/images/task-result.png"><img src="https://raw.githubusercontent.com/KKinsz/pi-remote-wecom/main/docs/images/task-result.png" width="180" alt="任务回传"></a> |

## 安装

需要 **macOS、Node.js ≥22.19、Pi Coding Agent**（已验证 0.87.1），以及一个专用的企微智能机器人。

从 npm 安装：

```sh
pi install npm:pi-remote-wecom
```

或从 Git 安装：

```sh
pi install git:github.com/KKinsz/pi-remote-wecom
```

也可在仓库目录中直接源码安装：

```sh
npm ci --ignore-scripts
pi install "$PWD"
```

需要能创建 API 模式长连接机器人的企微账号；普通微信群机器人 webhook 不适用。不同企业的功能开放与管理策略可能不同，外部企业账号兼容性尚未单独确认。

1. 企微 **工作台 → 智能机器人 → 创建机器人**，选 **API 模式 → 使用长连接**，在详情页复制 BotID 和 Secret。需新建专用机器人（一个 BotID 只能有一条长连接），并分享给自己以便在手机上找到。
2. 在 Pi 中执行 `/reload`，再执行 `/remote setup`，填写 BotID 和 Secret，Pi 会显示 6 位绑定码。
3. 在企微单聊机器人发送绑定码，收到「绑定成功」卡片后，点 **活跃会话** 即可开始聊天。

**自动命名**：手机靠会话名挑选会话。执行 `/tabmodel` 选一个命名模型后，每个新会话会根据首条输入生成短标题，同步到终端标签和手机；不选则不命名、不耗 token，列表显示首条输入。

## 常用命令

**手机企微**：选中会话后，直接发消息即可。

| 缩写 | 命令 | 用途 |
|---|---|---|
| `ls` | `活跃会话` | 选择正在运行的会话 |
| `h` | `历史会话 [关键词]` | 查找并继续历史会话 |
| `n` | `创建会话 [目录] [消息]` | 打开新终端会话 |
| `nb` | `创建后台会话 [目录] [消息]` | 在后台启动会话 |
| `model` | `切换模型 [关键词]` | 切换当前会话的模型；列表按 scope（enabledModels），关键词检索全部已认证模型 |
| `status` / `stop` / `help` | `状态` / `停止` / `帮助` | 查看状态、中断任务、查看全部命令 |

图片或文件可先发送，再在 5 分钟内补充说明；每次最多 4 件，每件不超过 20MB。任务完成后自动回传结果，长结果以文件发送。

**电脑 Pi**：

| 命令 | 用途 |
|---|---|
| `/remote` | 查看状态与管理服务 |
| `/remote setup` | 配置机器人 |
| `/remote bind` | 重新绑定企微账号 |
| `/remote restart` / `/remote stop` | 启动或重启 / 停止服务 |
| `/remote alias` | 设置常用目录别名 |
| `/tabmodel` | 选择自动命名模型；`reset` 关闭 |
| `/tabname 名称` | 手动修改会话名 |

## 支持的终端

支持 **Ghostty、cmux、iTerm2、WezTerm、kitty、tmux**。默认自动选择正在运行的终端；没有可用终端或屏幕锁定时，可创建后台会话。

<details>
<summary>终端设置</summary>

在 `~/.config/pi-remote-wecom/config.json` 中设置 `terminal`，修改后执行 `/remote restart`。终端命令需在 PATH 中可用。

| 终端 | `terminal` | 前提 |
|---|---|---|
| Ghostty | `ghostty` | ≥1.3，允许 macOS 自动化控制 |
| cmux | `cmux` | `cmux ping` 可用 |
| iTerm2 | `iterm` | 允许 macOS 自动化控制 |
| WezTerm | `wezterm` | `wezterm cli list` 可用 |
| kitty | `kitty` | 开启 `allow_remote_control socket-only` 和 `listen_on`，将实际 Unix socket 地址填入 `kittySocket` |
| tmux | `tmux` | ≥3.0；可用 `tmuxSession` 指定会话 |

`auto` 自动选择，`none` 仅使用后台会话。更多字段见 [配置示例](config.example.json)。

</details>

## 验证范围

维护者已确认：主流程和主要指令通过真机验收。自动测试另覆盖 Pi 离线加载、会话路由、绑定校验、消息去重、附件与卡片协议。此记录不代表所有终端、外部企业账号或休眠/断网等异常场景均已逐项验收。

当前交互文案主要为中文，支持上表中的英文短命令。macOS 是主要支持平台；其他系统仅提供前台 daemon 运行方式，未声明完整支持。

## 升级与卸载

源码安装升级后，在包目录运行 `npm ci --ignore-scripts`，在 Pi 执行 `/reload`，待任务空闲后执行 `/remote restart`。Pi 管理的 Git/npm 安装可用 `pi update --extensions` 更新，再执行相同步骤；固定版本或标签需要显式修改安装源。

卸载前，先在包目录执行 `node bin/remote.mjs uninstall` 停止服务并删除自启动，再执行 `pi remove <原安装源>` 和 `/reload`。仅移除 Pi 包不会删除 launchd 服务。配置、日志和附件保留在 `~/.config/pi-remote-wecom/`，按需自行清理。

## 使用说明

仅接受配置账号的单聊消息；电脑睡眠或关机时离线。后台会话有只读保护，但不是系统沙箱；终端会话沿用自身权限。凭证保存在本机，Secret 输入不遮罩；日志、附件和结果需自行清理。详见 [安全说明](SECURITY.md)。

## 开发

```sh
npm ci --ignore-scripts
npm run check
npm run test:package
```

[MIT License](LICENSE) · [更新记录](CHANGELOG.md) · [贡献指南](CONTRIBUTING.md) · [来源说明](NOTICE.md)
