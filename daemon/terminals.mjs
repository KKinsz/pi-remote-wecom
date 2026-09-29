// 创建会话的终端适配层：在电脑上开一个新终端标签页（或窗口/pane），在指定目录里跑 pi。
//
// 每个适配器只需要把四件事做到：
//   ① 工作目录 = cwd
//   ② 环境变量 PI_REMOTE_TAB=<nonce>（extension 注册时回报，daemon 靠它精确认领这个会话）
//   ③ 初始命令 = pi
//   ④ pi 退出后标签页最好留在 shell（可选）
// 认领只看 nonce，与终端无关 —— 所以新增一个终端只要写一个 open()。
//
// ⚠️ 不要用「模拟按键 / 剪贴板粘贴」实现任何适配器：按键的目标由「此刻焦点在哪」决定，
// 任何一步没到位就会把命令打进用户正在用的那个标签页（避免命令误投递）。
// 只用终端自己的 API（AppleScript 字典 / CLI / socket）。

import { execFile } from "node:child_process";

const run = (bin, args, timeout = 20_000) =>
  new Promise((resolve, reject) =>
    execFile(bin, args, { timeout }, (e, so, se) =>
      e ? reject(new Error(String(se || e.message).trim().slice(0, 200))) : resolve(String(so).trim()),
    ),
  );
const ok = (bin, args) => run(bin, args, 3_000).then(() => true, () => false);
// 按 bundle id 判断 GUI 应用是否在运行：不会顺手把它启动起来，也不受进程名/路径差异影响
// （pgrep -x ghostty 在 macOS 上匹配不到 /Applications/Ghostty.app/.../ghostty）。
const running = (bundleId) =>
  process.platform !== "darwin"
    ? Promise.resolve(false)
    : run("osascript", ["-e", `application id "${bundleId}" is running`], 3_000).then((o) => o === "true", () => false);

/** POSIX shell 单引号转义 */
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
/** 在 shell 里执行的一行命令：cd + 带 nonce 的 pi。用 env 而不是 VAR=x 前缀，fish 也能跑。 */
// piBin is an internally shell-quoted launcher command, not raw config.piBin.
const shellLine = ({ cwd, nonce, piBin }) => `cd ${sq(cwd)} && env PI_REMOTE_TAB=${nonce} ${piBin}`;

const osascript = (script, argv) => run("osascript", ["-e", script, ...argv]);

export const ADAPTERS = {
  ghostty: {
    label: "Ghostty",
    gui: true,
    hint: "需要 Ghostty ≥1.3，并在 系统设置 › 隐私与安全性 › 自动化 中允许",
    detect: () => running("com.mitchellh.ghostty"),
    // Ghostty 1.3+ 原生 AppleScript：目录 / 环境变量 / 初始输入都作为新 surface 的配置传入，
    // 只作用于新建的那个终端。initial input 而非 command：pi 退出后回到 shell。
    open: ({ cwd, nonce, piBin }) =>
      osascript(
        `on run argv
          set {theCwd, theEnv, theInput} to argv
          tell application "Ghostty"
            set cfg to new surface configuration
            set initial working directory of cfg to theCwd
            set environment variables of cfg to {theEnv}
            set initial input of cfg to theInput
            if (count of windows) > 0 then
              set t to new tab in front window with configuration cfg
            else
              set w to new window with configuration cfg
              set t to selected tab of w
            end if
            activate
            return id of t
          end tell
        end run`,
        [cwd, `PI_REMOTE_TAB=${nonce}`, `${piBin}\n`],
      ),
  },

  cmux: {
    label: "cmux",
    gui: true,
    hint: "需要 cmux 正在运行（cmux ping 能通）",
    detect: () => ok("cmux", ["ping"]),
    open: ({ cwd, nonce, piBin }) =>
      run("cmux", [
        "new-workspace",
        "--cwd", cwd,
        "--env", `PI_REMOTE_TAB=${nonce}`,
        // env 前缀是双保险：--env 是否传进初始命令取决于 cmux 版本
        "--command", `env PI_REMOTE_TAB=${nonce} ${piBin}`,
        "--focus", "true",
      ]),
  },

  iterm: {
    label: "iTerm2",
    gui: true,
    hint: "需要 iTerm2，并在 系统设置 › 隐私与安全性 › 自动化 中允许",
    detect: () => running("com.googlecode.iterm2"),
    open: (o) =>
      osascript(
        `on run argv
          set theCmd to item 1 of argv
          tell application "iTerm2"
            if (count of windows) = 0 then
              set w to (create window with default profile command theCmd)
            else
              set w to current window
              tell w to create tab with default profile command theCmd
            end if
            activate
            return id of w
          end tell
        end run`,
        [`/bin/sh -c ${sq(`${shellLine(o)}; exec ${sq(process.env.SHELL || "/bin/sh")} -l`)}`],
      ),
  },

  wezterm: {
    label: "WezTerm",
    gui: true,
    hint: "需要 WezTerm 正在运行（wezterm cli list 能通）",
    detect: () => ok("wezterm", ["cli", "list"]),
    // 用登录 shell 包一层：pi 退出后留在 shell，且 PATH 与手开的标签页一致
    open: ({ cwd, nonce, piBin }) =>
      run("wezterm", [
        "cli", "spawn", "--cwd", cwd, "--",
        "sh", "-c", `env PI_REMOTE_TAB=${nonce} ${piBin}; exec "\${SHELL:-/bin/sh}" -l`,
      ]),
  },

  kitty: {
    label: "kitty",
    gui: true,
    hint: "需要 kitty 开启 allow_remote_control=socket-only 与 listen_on，并配置 kittySocket",
    detect: (cfg = {}) => ok("kitty", ["@", ...(cfg.kittySocket ? ["--to", cfg.kittySocket] : []), "ls"]),
    open: ({ cwd, nonce, piBin, kittySocket }) =>
      run("kitty", [
        "@", ...(kittySocket ? ["--to", kittySocket] : []), "launch", "--type=tab", "--cwd", cwd, "--env", `PI_REMOTE_TAB=${nonce}`,
        "sh", "-c", `${piBin}; exec "\${SHELL:-/bin/sh}" -l`,
      ]),
  },

  tmux: {
    label: "tmux",
    gui: false, // 不依赖图形界面：锁屏下照样能开
    hint: "需要 tmux ≥3.0",
    detect: () => ok("tmux", ["list-sessions"]),
    open: async ({ cwd, nonce, piBin, tmuxSession }) => {
      const cmd = `env PI_REMOTE_TAB=${nonce} ${piBin}; exec "\${SHELL:-/bin/sh}" -l`;
      const has = await ok("tmux", ["has-session", "-t", tmuxSession]);
      const args = has
        ? ["new-window", "-t", `${tmuxSession}:`, "-c", cwd, "-P", "-F", "#{session_name}:#{window_index}", cmd]
        : ["new-session", "-d", "-s", tmuxSession, "-c", cwd, "-P", "-F", "#{session_name}:#{window_index}", cmd];
      return run("tmux", args);
    },
  },

  terminal: {
    label: "Terminal.app",
    gui: true,
    hint: "需要在 系统设置 › 隐私与安全性 › 自动化 中允许控制「终端」",
    detect: () => running("com.apple.Terminal"),
    open: (o) =>
      osascript(
        `on run argv
          tell application "Terminal"
            do script (item 1 of argv)
            activate
          end tell
          return "window"
        end run`,
        [shellLine(o)],
      ),
  },
};

// auto 模式的探测顺序：先专门的，最后才是系统自带
const AUTO_ORDER = ["cmux", "ghostty", "iterm", "wezterm", "kitty", "tmux", "terminal"];

/** 按配置选适配器；返回 { name, ...adapter } 或 null（= 没有可用终端，调用方降级为后台会话）。 */
export async function resolveTerminal(cfg) {
  const want = String(cfg.terminal || "auto").toLowerCase();
  if (want === "none") return null;
  if (want !== "auto") {
    const a = ADAPTERS[want];
    if (!a) throw new Error(`未知终端 "${want}"，可选：auto / ${Object.keys(ADAPTERS).join(" / ")} / none`);
    return { name: want, ...a };
  }
  for (const name of AUTO_ORDER) {
    if (await ADAPTERS[name].detect(cfg)) return { name, ...ADAPTERS[name] };
  }
  return null;
}

// CLI 自检：`node terminals.mjs` 列出探测结果；`node terminals.mjs open <name> <dir>` 实际开一个
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , sub, name, dir] = process.argv;
  if (sub === "open") {
    const a = ADAPTERS[name];
    if (!a) throw new Error(`未知终端 ${name}`);
    const id = await a.open({ cwd: dir || process.cwd(), nonce: `test${Date.now().toString(36)}`, piBin: "pi", tmuxSession: "pi" });
    console.log(`opened ${name}: ${id}`);
  } else {
    for (const n of AUTO_ORDER) console.log(`${(await ADAPTERS[n].detect()) ? "✓" : "·"} ${n}`);
  }
}
