# Pi Remote WeCom

English · [简体中文](README.zh-CN.md)

Control your local [Pi coding agent](https://pi.dev) from WeCom on your phone. One bot connects to a local daemon that manages multiple Pi sessions.

- Resume a running session or find a previous conversation.
- Create terminal or background sessions, send text and attachments, switch models, and stop tasks.
- Keep terminal tab titles and phone session names in sync, with optional model-generated names.
- Connect directly through the official WeCom WebSocket SDK. No public server or callback endpoint is required.

## Screenshots

| Commands | Sessions | New session | Switch models | Task results |
| --- | --- | --- | --- | --- |
| <a href="https://raw.githubusercontent.com/KKinsz/pi-remote-wecom/main/docs/images/commands.png"><img src="https://raw.githubusercontent.com/KKinsz/pi-remote-wecom/main/docs/images/commands.png" width="180" alt="Commands"></a> | <a href="https://raw.githubusercontent.com/KKinsz/pi-remote-wecom/main/docs/images/sessions.png"><img src="https://raw.githubusercontent.com/KKinsz/pi-remote-wecom/main/docs/images/sessions.png" width="180" alt="Sessions"></a> | <a href="https://raw.githubusercontent.com/KKinsz/pi-remote-wecom/main/docs/images/create-session.png"><img src="https://raw.githubusercontent.com/KKinsz/pi-remote-wecom/main/docs/images/create-session.png" width="180" alt="New session"></a> | <a href="https://raw.githubusercontent.com/KKinsz/pi-remote-wecom/main/docs/images/switch-model.png"><img src="https://raw.githubusercontent.com/KKinsz/pi-remote-wecom/main/docs/images/switch-model.png" width="180" alt="Switch models"></a> | <a href="https://raw.githubusercontent.com/KKinsz/pi-remote-wecom/main/docs/images/task-result.png"><img src="https://raw.githubusercontent.com/KKinsz/pi-remote-wecom/main/docs/images/task-result.png" width="180" alt="Task results"></a> |

## Install

Requires **macOS, Node.js ≥22.19, Pi Coding Agent** (tested with 0.87.1), and a dedicated WeCom intelligent bot with **API mode → persistent connection** enabled. A regular group webhook bot is not sufficient. Feature availability depends on your enterprise; use with external enterprise accounts has not been separately verified.

Install from npm:

```sh
pi install npm:pi-remote-wecom
```

Or from Git:

```sh
pi install git:github.com/KKinsz/pi-remote-wecom
```

Alternatively, install from a source checkout:

```sh
npm ci --ignore-scripts
pi install "$PWD"
```

1. Create a dedicated intelligent bot in WeCom and copy its BotID and Secret. Share it with yourself so you can find it on your phone. Do not reuse a bot connected to another client.
2. In Pi, run `/reload`, then `/remote setup`. Enter the BotID and Secret and choose binding by code. The extension starts the daemon, registers macOS login startup, and displays a six-digit code locally.
3. Send that code in a direct message to the bot. After binding succeeds, choose **活跃会话** or send `ls` to select a session. Only the bound account can control Pi.

The UI and bot replies are currently primarily in Chinese. English command aliases are supported.

**Optional naming:** run `/tabmodel` to choose a naming model. New sessions are named from their first input; `/tabmodel reset` disables this. Without a naming model, no naming request is made and the session list uses the first input.

## Commands

On your phone, select a session and send a message to continue it.

| Command | Action |
|---|---|
| `ls` | Select an active terminal or background session |
| `h [keywords]` | Search and resume session history |
| `n [directory] [message]` | Create a terminal session |
| `nb [directory] [message]` | Create a background RPC session |
| `model [keywords]` | Switch the current session's model; the list follows your scope (enabledModels), keywords search all authenticated models |
| `status` | Show the current session's status |
| `stop` | Interrupt the current task |
| `help` | Show all commands |

Send an image or file, then add instructions within five minutes. Up to four attachments are accepted per batch, each at most 20 MB. Completed tasks send their results back; long results arrive as a Markdown file.

In Pi:

| Command | Action |
|---|---|
| `/remote` | View connection status and manage the daemon |
| `/remote setup` | Configure the bot |
| `/remote bind` | Bind or rebind your WeCom account |
| `/remote restart` / `/remote stop` | Start or restart / stop the daemon |
| `/remote alias` | Manage directory aliases |
| `/tabmodel` | Choose an automatic naming model; `reset` disables it |
| `/tabname name` | Rename a session manually |

## Terminals and configuration

Adapters are provided for **Ghostty, cmux, iTerm2, WezTerm, kitty, and tmux**. Automatic selection uses an available terminal; if none is available or the screen is locked, session creation can fall back to background mode. Opening a terminal tab may change focus.

Set `terminal` in `~/.config/pi-remote-wecom/config.json`, then run `/remote restart` while idle:

| Terminal | Value | Requirements |
|---|---|---|
| Ghostty | `ghostty` | ≥1.3; macOS Automation permission |
| cmux | `cmux` | `cmux ping` available |
| iTerm2 | `iterm` | macOS Automation permission |
| WezTerm | `wezterm` | `wezterm cli list` available |
| kitty | `kitty` | Remote control enabled; set `kittySocket` to its Unix socket |
| tmux | `tmux` | ≥3.0; optional `tmuxSession` |

Use `auto` for automatic selection or `none` for background sessions only. See [configuration examples](config.example.json) and [terminal setup details](README.zh-CN.md#支持的终端).

macOS is the primary supported platform. Other systems can run `node bin/remote.mjs run` in the foreground, but full platform support is not claimed.

## Updates and removal

For a source checkout, update the code and run `npm ci --ignore-scripts`. For Pi-managed Git/npm installs, use `pi update --extensions`; pinned versions or tags require changing the source explicitly. Then run `/reload` in Pi and `/remote restart` while idle. Restart after dependency updates as well.

Before removing the package, run `node bin/remote.mjs uninstall` from its installed directory to stop the daemon and remove login startup. Then run `pi remove <original-install-source>` and `/reload`. Removing the Pi package alone does not remove its launchd service. Configuration, logs, and attachments remain in `~/.config/pi-remote-wecom/` for manual cleanup.

## Validation and boundaries

The maintainer has confirmed real-device testing of the main workflow and major commands. Automated checks also cover offline Pi loading, session routing, binding, deduplication, attachments, and card callbacks. This does not claim exhaustive validation of every terminal, external enterprise account, or sleep/network failure scenario.

Only the bound user's direct messages are accepted. The computer must remain awake and online. Background sessions have a read-only guard, which is not an OS sandbox; terminal sessions retain their existing permissions. Credentials stay on the local machine, but setup does not mask the Secret input. See [security and data handling](SECURITY.md).

## Development

```sh
npm ci --ignore-scripts
npm run check
npm run test:package
```

Tests use isolated temporary directories and fake credentials, without changing your Pi settings, starting launchd services, or calling a model. See [Contributing](CONTRIBUTING.md) for workflow and [Releasing](RELEASING.md) for distribution.

[MIT License](LICENSE) · [Changelog](CHANGELOG.md) · [Source notices](NOTICE.md) · [Pi package format](https://pi.dev/docs/latest/packages)
