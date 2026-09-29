/**
 * pi-remote readonly guard
 *
 * 只在 daemon spawn 的 RPC 子进程里加载（--extension <repo>/daemon/readonly-guard.ts）——
 * 即只对 `.nb` 建的后台会话生效。`.n` 开的 tab 跑裸 pi、已有 TUI 会话跑电脑上那个 pi，
 * 两者都不受本闸约束（有意为之，见设计与实现「权限：只有 .nb 只读」）。
 * 所以拦截文案说「此会话」而不是「手机端」—— 后者会让 pi 与用户都误以为整条链路只读。
 * write / edit 已经被 `--exclude-tools write,edit` 在启动时硬禁用，这里是第二道闸：
 * 拦 bash 里的写操作（重定向 / rm / mv / git push / 包管理器写入等）。
 *
 * 被拦时通过 ctx.ui.notify 发出，RPC 模式下会变成 extension_ui_request，
 * daemon 解析该记录并把「⚠️ 已阻止」附到推送里。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WRITE_PATTERNS: Array<[RegExp, string]> = [
	[/(^|[^0-9<>&])>>?(?![&])/, "输出重定向"],
	[/\brm\s+/, "rm"],
	[/\bmv\s+/, "mv"],
	[/\bcp\s+/, "cp"],
	[/\b(mkdir|rmdir|touch|truncate|ln|chmod|chown|chgrp)\b/, "文件系统写入"],
	[/\bdd\b/, "dd"],
	[/\btee\b/, "tee"],
	[/\bsed\b[^|]*\s-i\b/, "sed -i"],
	[/\bperl\b[^|]*\s-i\b/, "perl -i"],
	[/\bgit\s+(push|commit|add|reset|checkout|merge|rebase|clean|rm|mv|tag|stash)\b/, "git 写操作"],
	[/\b(npm|pnpm|yarn|pip|pip3|brew|cargo|go)\s+(i|install|add|remove|uninstall|publish|get)\b/, "包管理器写入"],
	[/\bsudo\b/, "sudo"],
	[/\bkill(all)?\b/, "kill"],
	[/\b(curl|wget)\b[^|]*(-o|--output|-O)\b/, "下载落盘"],
	[/\bpi\b.*--mode/, "嵌套 pi"],
];

export default function (pi: ExtensionAPI) {
	if (process.env.PI_REMOTE_READONLY !== "1") return;

	pi.on("tool_call", async (event, ctx) => {
		// write / edit 理论上已被 --exclude-tools 摘掉；若仍出现则兜底拦掉。
		if (event.toolName === "write" || event.toolName === "edit") {
			const p = String((event.input as Record<string, unknown>)?.path ?? "?");
			const reason = `⚠️ 已阻止：${event.toolName} ${p}\n此会话为后台只读会话，写操作需在电脑上执行`;
			if (ctx.hasUI) ctx.ui.notify(reason, "warning");
			return { block: true, reason };
		}

		if (event.toolName !== "bash") return undefined;

		const command = String((event.input as Record<string, unknown>)?.command ?? "");
		for (const [re, what] of WRITE_PATTERNS) {
			if (re.test(command)) {
				const reason = `⚠️ 已阻止：bash(${what}) ${command.slice(0, 120)}\n此会话为后台只读会话，写操作需在电脑上执行`;
				if (ctx.hasUI) ctx.ui.notify(reason, "warning");
				return { block: true, reason };
			}
		}
		return undefined;
	});
}
