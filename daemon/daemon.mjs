// Multi-session engine adapted from pi-remote (MIT).
// The WeCom transport owns authentication, message dedupe, attachments and durable delivery.
// TUI loop identities come from the extension; late results never settle another loop.
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig, RUN_DIR, VERSION, validateCredentials, ensureToken, saveOwner } from "./config.mjs";
import { resolveTerminal } from "./terminals.mjs";
import { WeComTransport, MAX_ATTACHMENT_BYTES } from "./wecom.mjs";
import { loadAliases } from "./aliases.mjs";
const CFG = loadConfig();
validateCredentials(CFG);
let transport;
const shellQuote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
const HOME = os.homedir();
const DIR = RUN_DIR;
const CODE_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(DIR, "bridge.log");
const CURRENT_FILE = path.join(DIR, ".current");
const SESSIONS_ROOT = path.join(CFG.agentDir, "sessions");
const OUT_DIR = path.join(DIR, "out");
const PORT = CFG.localPort;
const HOST = "127.0.0.1";
const SYNC_WINDOW_MS = 2000;
const NAME_WAIT_MS = Number.isFinite(CFG.nameWaitMs) ? CFG.nameWaitMs : 5000;
const RPC_IDLE_REAP_MS = 2 * 60 * 60000;
const SILENCE_STEPS_MS = [10 * 60000, 30 * 60000, 60 * 60000];
const HIST_LIST = 15;
const HIST_FIND_MAX = 20;
const VOTE_OPT_MAX = 20;
const CARD_TTL_MS = 30 * 60000;
const CARD_BODY_MAX = 108;
const EMPH_MAX = 10;
const EMPH_DESC_MAX = 15;
const EMPH_NAME_MAX = 16;
const POLL_HOLD_MS = 25000;
const MODEL_ACK_MS = 10000;
const COMPACT_MS = 5 * 60000;
const META_ACK_MS = 3000;
const MODEL_LIST_MAX = 60;
const MODEL_ALL_MAX = 500;
// 手机发起的任务里，扩展弹窗转企微卡片；confirm 超时策略见 remoteConfirm。
const UI_POLICY = CFG.remoteConfirm;
const UI_TIMEOUT_MS = CFG.remoteConfirmTimeoutMs;
const UI_TEXT_MAX_BYTES = 1200;
const TUI_STALE_MS = 35000;
// Keep completed results inline until they approach WeCom's 20,480-byte
// Markdown limit. The transport sends each message up to the same 20,000-byte
// safety limit; larger completed results are delivered as Markdown documents.
const PUSH_TEXT_MAX_BYTES = 20_000;
// Re-read on each lookup so /remote alias edits and hand edits apply without restarting.
let lastAliases = {};
function dirAliases() {
    try {
        lastAliases = loadAliases();
    }
    catch (e) {
        log(`目录别名表无效，沿用上次有效版本：${e.message}`);
    }
    return lastAliases;
}
const num = (n) => `${n}.`;
fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
const ts = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().replace("T", " ").slice(0, 19);
const sha8 = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 8);
function log(line) {
    const rec = `[${ts()}] ${line}\n`;
    try {
        fs.appendFileSync(LOG_FILE, rec, {mode: 0o600});
    }
    catch {
        process.stdout.write(rec);
    }
}
const TOKEN = ensureToken();
function expandPath(p) {
    if (!p)
        return HOME;
    if (p === "~")
        return HOME;
    if (p.startsWith("~/"))
        return path.join(HOME, p.slice(2));
    if (path.isAbsolute(p))
        return p;
    return path.join(HOME, p);
}
function resolveCwd(alias) {
    if (!alias)
        return HOME;
    const mapped = dirAliases()[alias.toLowerCase()];
    return expandPath(mapped || alias);
}
/** 扩展 setStatus 文本带 ANSI 颜色与 Nerd Font 图标：手机上只留可读文字。 */
function plainStatus(text) {
    return String(text)
        .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
        .replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, "")
        .replace(/[\u0000-\u001f\u007f\uE000-\uF8FF]/g, " ")
        .replace(/\s+/g, " ").trim();
}
/** 与 Pi footer 相同：向上找 .git（目录或 worktree 文件），读 HEAD 得分支名。 */
function gitBranch(cwd) {
    try {
        for (let dir = path.resolve(cwd);; dir = path.dirname(dir)) {
            const dotGit = path.join(dir, ".git");
            if (fs.existsSync(dotGit)) {
                let gitDir = dotGit;
                if (fs.statSync(dotGit).isFile()) {
                    const m = fs.readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)$/m);
                    if (!m)
                        return "";
                    gitDir = path.resolve(dir, m[1].trim());
                }
                const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
                const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
                return ref ? ref[1] : "detached";
            }
            if (path.dirname(dir) === dir)
                return "";
        }
    }
    catch {
        return "";
    }
}
function tilde(p) {
    return p === HOME ? "~" : p.startsWith(HOME + "/") ? "~" + p.slice(HOME.length) : p;
}
function human(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60)
        return `${s}秒`;
    const m = Math.floor(s / 60);
    if (m >= 60)
        return `${Math.floor(m / 60)}小时${m % 60}分`;
    return `${m}分${s % 60}秒`;
}
function ago(mtimeMs) {
    const d = Date.now() - mtimeMs;
    if (d < 120000)
        return "刚刚";
    if (d < 3600000)
        return `${Math.floor(d / 60000)}分钟前`;
    if (d < 86400000)
        return `${Math.floor(d / 3600000)}小时前`;
    if (d < 172800000)
        return "昨天";
    return `${Math.floor(d / 86400000)}天前`;
}
function sendText(text) { return transport.send(text); }
function slugName(s) {
    const cut = Array.from(stripCtrl(String(s || "")).replace(/\s+/g, "-"))
        .filter((ch) => !/[\/\\:*?"<>|'`$&;()\[\]{}：？＊｜“”]/.test(ch))
        .slice(0, 32)
        .join("")
        .replace(/^[-.…]+|[-.…]+$/g, "");
    return cut || "pi会话";
}
function stampNow(d = new Date()) {
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
async function uploadMdDoc({ name, cwd, body, meta = "" }) {
    const base = `${slugName(name)}-${stampNow()}-${crypto.randomUUID().slice(0, 8)}.md`;
    const file = path.join(OUT_DIR, base);
    const doc = `# ${stripCtrl(String(name || "Pi 会话"))}\n\n> ${[tilde(cwd || HOME), meta].filter(Boolean).join(" · ")}\n\n---\n\n${body}\n`;
    await fsp.writeFile(file, doc, { mode: 0o600 });
    return file;
}
async function pushResult(msg) {
    if (typeof msg === "string" || msg.card)
        return transport.send(msg);
    try {
        return await transport.send({ text: msg.text, file: msg.doc ? await uploadMdDoc(msg.doc) : undefined });
    }
    catch {
        return transport.send(msg.degrade ? msg.degrade() : "结果保存失败，请回到电脑查看会话。");
    }
}
const INBOX_DIR = expandPath(CFG.inboxDir);
async function fetchInboxFile(m) {
    const root = await fsp.realpath(INBOX_DIR);
    const local = await fsp.realpath(m.local);
    if (!local.startsWith(root + path.sep))
        throw new Error("附件不在收件目录");
    const stat = await fsp.stat(local);
    if (!stat.isFile() || stat.size > MAX_ATTACHMENT_BYTES)
        throw new Error("附件超限");
    return local;
}
class MediaFetchError extends Error {
}
async function composeWithMedia(raw, media) {
    if (!media?.length)
        return raw;
    const rs = await Promise.allSettled(media.map(fetchInboxFile));
    const bad = rs.find((r) => r.status === "rejected");
    if (bad) {
        const msg = bad.reason?.message || String(bad.reason);
        log(`附件拉取失败，整条未投递：${msg}`);
        throw new MediaFetchError(`附件拉取失败：${msg}`);
    }
    const paths = rs.map((r) => r.value);
    const notes = media.map((m, i) => m.kind === "image" ? `已收到图片：${paths[i]}（请先用 read 查看）` : `已收到文件：${paths[i]}`);
    const lead = raw || "（见附件，请先查看）";
    return [lead, ...notes].join("\n\n");
}
function markAck(ack, queued) {
    if (ack && queued)
        ack.media = true;
}
async function deliverWithMedia(t, raw, media, ack) {
    let text;
    try {
        text = await composeWithMedia(raw, media);
    }
    catch (e) {
        if (e instanceof MediaFetchError)
            return fmtNotDelivered(t, e.message);
        throw e;
    }
    return deliverAndWait(t, text, ack);
}
async function scanHistory() {
    const out = [];
    let groups;
    try {
        groups = await fsp.readdir(SESSIONS_ROOT);
    }
    catch {
        return out;
    }
    for (const g of groups) {
        const gp = path.join(SESSIONS_ROOT, g);
        let files;
        try {
            files = await fsp.readdir(gp);
        }
        catch {
            continue;
        }
        for (const f of files) {
            if (!f.endsWith(".jsonl"))
                continue;
            const fp = path.join(gp, f);
            try {
                const st = await fsp.stat(fp);
                if (!st.isFile() || st.size === 0)
                    continue;
                out.push({ file: fp, mtimeMs: st.mtimeMs, group: g });
            }
            catch { }
        }
    }
    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return out;
}
const HIST_NAME_MAX = 24;
// 历史检索只用会话名 + 首条用户输入前 USER_HEAD_MAX 个字。
const USER_HEAD_MAX = 100;
const HEAD_SCAN = 256 * 1024; // 会话名与首条输入基本都在文件头部
const TAIL_SCAN = 64 * 1024; // 后期改名写在末尾，以最后一条 session_info 为准
const oneLine = (s) => stripCtrl(String(s || "")).replace(/\s+/g, " ").trim();
function userText(c) {
    if (typeof c === "string")
        return c;
    return Array.isArray(c) ? c.filter((x) => x?.type === "text").map((x) => x.text).join(" ") : "";
}
async function readRange(fh, pos, len) {
    const b = Buffer.alloc(len);
    const { bytesRead } = await fh.read(b, 0, len, pos);
    return b.subarray(0, bytesRead).toString("utf8");
}
async function sessionMeta(file) {
    let name = "";
    let cwd = HOME;
    let id = "";
    let firstUser = "";
    let fh;
    try {
        fh = await fsp.open(file, "r");
        const size = (await fh.stat()).size;
        const headLen = Math.min(HEAD_SCAN, size);
        const lines = (await readRange(fh, 0, headLen)).split("\n");
        if (size > headLen) {
            lines.pop(); // 头部最后一行可能被截断
            const tailLen = Math.min(TAIL_SCAN, size - headLen);
            lines.push(...(await readRange(fh, size - tailLen, tailLen)).split("\n").slice(tailLen < size - headLen ? 1 : 0));
        }
        // 只解析需要的行，跳过大体积的助手/工具输出。
        for (const line of lines) {
            const head = line.slice(0, 120);
            const isUser = !firstUser && head.startsWith('{"type":"message"') && line.slice(0, 300).includes('"role":"user"');
            if (!isUser && !head.startsWith('{"type":"session'))
                continue;
            let o;
            try {
                o = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (o.type === "session") {
                cwd = o.cwd || cwd;
                id = o.id || id;
            }
            else if (o.type === "session_info" && o.name)
                name = oneLine(o.name);
            else if (isUser && o.message?.role === "user")
                firstUser = Array.from(oneLine(userText(o.message.content))).slice(0, USER_HEAD_MAX).join("");
        }
    }
    catch {
        return { name: path.basename(file).slice(0, HIST_NAME_MAX), cwd: HOME, id: "" };
    }
    finally {
        await fh?.close().catch(() => { });
    }
    const cut = (s) => Array.from(s).slice(0, HIST_NAME_MAX).join("");
    const fields = { name: name.toLowerCase(), user: firstUser.toLowerCase() };
    const hay = [fields.name, fields.user].filter(Boolean).join(" ");
    return { name: cut(name) || cut(firstUser) || cut(path.basename(file)) || "(未命名)", cwd, id, hay, fields };
}
let keySeq = 0;
const targets = new Map();
let runSeq = 0;
class Run {
    constructor() {
        this.id = `r${++runSeq}-${Date.now().toString(36)}`;
        this.startedAt = Date.now();
        this.assistantTexts = [];
        this.toolCalls = 0;
        this.toolErrors = 0;
        this.lastTool = "";
        this.lastOutputAt = Date.now();
        this.error = null;
        this.aborted = null;
        this.local = false;
        this.watched = false;
        this.settled = false;
        this._waiters = [];
    }
    get lastText() {
        for (let i = this.assistantTexts.length - 1; i >= 0; i--) {
            if (this.assistantTexts[i].trim())
                return this.assistantTexts[i].trim();
        }
        return "";
    }
    wait() {
        if (this.settled)
            return Promise.resolve(this);
        return new Promise((res) => this._waiters.push(res));
    }
    settle() {
        if (this.settled)
            return;
        this.settled = true;
        this.endedAt = Date.now();
        const w = this._waiters;
        this._waiters = [];
        for (const r of w)
            r(this);
    }
}
let shuttingDown = false;
const kindOf = (t) => (t.kind === "tui" ? "终端可见" : t.kind === "history" ? "历史会话" : "后台会话");
class Target {
    constructor(kind, { cwd, name, sessionFile, sessionId, origin }) {
        this.key = `t${++keySeq}`;
        this.kind = kind;
        this.cwd = cwd || HOME;
        this.name = name || "";
        this.hint = "";
        this.origin = origin || "";
        this.sessionFile = sessionFile || "";
        this.sessionId = sessionId || "";
        this.model = "";
        this.modelProvider = "";
        this.models = [];
        this.allModels = [];
        this.modelScoped = false;
        this.ctxPercent = null;
        this.contextWindow = null;
        this.lastActivity = Date.now();
        this.run = null;
        this.lastSettled = null;
        this.loops = new Map();
        this.closed = false;
        this.mtimeMs = Date.now();
        // footer 信息：扩展状态（终端由扩展上报、后台从 RPC setStatus 收集）、思考强度、累计花费。
        this.statuses = new Map();
        this.thinkingLevel = "";
        this.cost = null;
    }
    get busy() {
        if (this.run && !this.run.settled)
            return true;
        for (const r of this.loops.values())
            if (!r.settled)
                return true;
        return false;
    }
    runForTurn() {
        if (this.run && !this.run.settled) {
            if (this.run.local)
                this.run.local = false;
            return { run: this.run, reused: true };
        }
        this.run = new Run();
        return { run: this.run, reused: false };
    }
    openLoop(id, { local = false } = {}) {
        if (!id)
            return null;
        if (this.loops.has(id))
            return this.loops.get(id);
        const run = this.run && !this.run.settled && !this.loops.has(this.run.id) ? this.run : new Run();
        run.id = id;
        run.local = local;
        this.loops.set(id, run);
        this.run = run;
        if (this.loops.size > 8) {
            for (const k of [...this.loops.keys()].slice(0, this.loops.size - 8)) {
                if (this.loops.get(k)?.settled)
                    this.loops.delete(k);
            }
        }
        return run;
    }
    noteSettled(run) {
        if (run)
            this.lastSettled = run;
    }
    runById(id) {
        if (!id)
            return null;
        if (this.loops.has(id))
            return this.loops.get(id);
        if (this.run && this.run.id === id)
            return this.run;
        return this.lastSettled && this.lastSettled.id === id ? this.lastSettled : null;
    }
    label() {
        if (this.name)
            return this.name;
        if (this.hint)
            return this.hint;
        if (this.kind === "history")
            return "会话";
        return `新会话 · ${tilde(this.cwd)}`;
    }
}
class RpcTarget extends Target {
    constructor(opts) {
        super("rpc", opts);
        this.proc = null;
        this.idSeq = 0;
        this.pendingCmds = new Map();
        this.buf = Buffer.alloc(0);
        this.starting = false;
    }
    async start({ sessionFile } = {}) {
        this.starting = true;
        // 与终端会话能力一致：加载用户扩展、不限制工具；--offline 仅跳过启动时的模型目录刷新。
        const args = ["--mode", "rpc", "--offline"];
        if (sessionFile)
            args.push("--session", sessionFile);
        if (this.name && !sessionFile)
            args.push("--name", this.name);
        this.proc = spawn(CFG.piBin, args, {
            cwd: this.cwd,
            env: { ...process.env, PI_CODING_AGENT_DIR: CFG.agentDir, PI_REMOTE_BACKGROUND: "1" },
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.proc.stdout.on("data", (c) => this._onStdout(c));
        this.proc.stderr.on("data", (c) => {
            const s = String(c).trim();
            if (s)
                log(`rpc[${this.key}] stderr: ${s.slice(0, 300)}`);
        });
        this.proc.stdin?.on("error", (e) => log(`rpc[${this.key}] stdin error: ${e?.message || e}`));
        this.proc.on("error", () => {
            this.closed = true;
            for (const p of this.pendingCmds.values()) {
                clearTimeout(p.timer);
                p.reject(new Error("无法启动 pi，请检查 piBin 与 PATH"));
            }
            this.pendingCmds.clear();
            dropUiPrompts(this);
            targets.delete(this.key);
        });
        this.proc.on("exit", (code, sig) => {
            log(`rpc[${this.key}] exit code=${code} sig=${sig}`);
            this.closed = true;
            for (const [id, p] of this.pendingCmds) {
                clearTimeout(p.timer);
                const e = new Error(`pi 进程退出 (code=${code})`);
                e.outcome = "unknown";
                p.reject(e);
                this.pendingCmds.delete(id);
            }
            if (this.run && !this.run.settled) {
                this.run.error = `pi 进程退出 (code=${code})`;
                this.run.settle();
            }
            dropUiPrompts(this);
            targets.delete(this.key);
        });
        let st;
        try {
            st = await this.cmd("get_state", {}, 30000);
        }
        finally {
            this.starting = false;
        }
        if (st && st.data) {
            this.sessionFile = st.data.sessionFile || this.sessionFile;
            this.sessionId = st.data.sessionId || this.sessionId;
            if (st.data.sessionName)
                this.name = st.data.sessionName;
        }
        log(`rpc[${this.key}] up cwd=${tilde(this.cwd)} session=${this.sessionId.slice(0, 8)}`);
        return this;
    }
    _onStdout(chunk) {
        this.buf = Buffer.concat([this.buf, chunk]);
        let idx;
        while ((idx = this.buf.indexOf(0x0a)) !== -1) {
            let line = this.buf.subarray(0, idx);
            this.buf = this.buf.subarray(idx + 1);
            if (line.length && line[line.length - 1] === 0x0d)
                line = line.subarray(0, line.length - 1);
            const s = line.toString("utf8").trim();
            if (!s)
                continue;
            let rec;
            try {
                rec = JSON.parse(s);
            }
            catch {
                continue;
            }
            this._onRecord(rec);
        }
    }
    _onRecord(rec) {
        if (rec.type === "response") {
            const p = this.pendingCmds.get(rec.id);
            if (p) {
                this.pendingCmds.delete(rec.id);
                clearTimeout(p.timer);
                if (rec.success)
                    p.resolve(rec);
                else {
                    const e = new Error(rec.error || "rpc command failed");
                    e.outcome = "rejected";
                    p.reject(e);
                }
            }
            return;
        }
        if (rec.type === "extension_ui_request") {
            // Pi 在加载完扩展（session_start）后才读 stdin：启动期的阻塞弹窗无法回答，直接失败并说明原因。
            if (this.starting && UI_KINDS.has(rec.method)) {
                this.failStart(`扩展在启动时请求${rec.method === "confirm" ? "确认" : "输入"}（${clip(stripCtrl(String(rec.title || "")), 40)}），后台会话无法处理，请改用终端会话`);
                return;
            }
            if (rec.method === "setStatus" && rec.statusKey) {
                const text = typeof rec.statusText === "string" ? plainStatus(rec.statusText) : "";
                if (text)
                    this.statuses.set(String(rec.statusKey), text.slice(0, 80));
                else
                    this.statuses.delete(String(rec.statusKey));
                return;
            }
            // 后台会话只由手机驱动：所有阻塞弹窗都转到手机（其余 fire-and-forget 忽略）。
            if (UI_KINDS.has(rec.method) && typeof rec.id === "string") {
                openUiPrompt(this, { reqId: rec.id, kind: rec.method, title: rec.title, message: rec.message, options: rec.options, limitMs: rec.timeout }, (answer) => this.uiRespond(rec.id, answer));
            }
            return;
        }
        if (rec.type === "session_info_changed") {
            this.name = rec.name ? stripCtrl(String(rec.name)) : "";
            return;
        }
        const r = this.run;
        this.lastActivity = Date.now();
        switch (rec.type) {
            case "message_end":
                if (rec.message?.role === "assistant" && r) {
                    if (rec.message.stopReason === "error")
                        r.error = "模型请求失败";
                    else
                        r.error = "";
                    if (rec.message.stopReason === "aborted")
                        r.stopped = true;
                    const c = rec.message.content;
                    const t = Array.isArray(c)
                        ? c.filter((x) => x?.type === "text").map((x) => x.text).join("")
                        : typeof c === "string"
                            ? c
                            : "";
                    if (t) {
                        r.assistantTexts.push(t);
                        r.lastOutputAt = Date.now();
                    }
                }
                break;
            case "tool_execution_start":
                if (r) {
                    r.toolCalls++;
                    r.lastTool = rec.toolName || "";
                    r.lastOutputAt = Date.now();
                }
                break;
            case "tool_execution_end":
                if (r && rec.isError)
                    r.toolErrors++;
                break;
            case "agent_settled":
                // 轮次结束（含被停止）：回收卡片并按取消回复（Pi 对已结束的请求忽略回复），避免误报"超时已自动允许"。
                dropUiPrompts(this, { cancelled: true });
                if (r) {
                    r.settle();
                    this.noteSettled(r);
                }
                break;
        }
    }
    cmd(type, extra = {}, timeoutMs = 60000) {
        if (this.closed || !this.proc || this.proc.killed) {
            const e = new Error("rpc 进程已退出");
            e.outcome = "rejected";
            return Promise.reject(e);
        }
        const id = `c${++this.idSeq}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingCmds.delete(id);
                const e = new Error(`rpc ${type} 超时`);
                e.outcome = "unknown";
                reject(e);
            }, timeoutMs);
            this.pendingCmds.set(id, { resolve, reject, timer });
            let line;
            try {
                line = JSON.stringify({ id, type, ...extra }) + "\n";
                this.proc.stdin.write(line);
            }
            catch (err) {
                clearTimeout(timer);
                this.pendingCmds.delete(id);
                const e = new Error(`rpc ${type} 写入失败：${err?.message || err}`);
                e.outcome = "rejected";
                reject(e);
            }
        });
    }
    failStart(why) {
        log(`rpc[${this.key}] 启动失败：${why}`);
        for (const [id, p] of this.pendingCmds) {
            clearTimeout(p.timer);
            const e = new Error(why);
            e.outcome = "rejected";
            p.reject(e);
            this.pendingCmds.delete(id);
        }
        try {
            this.proc?.kill("SIGTERM");
        }
        catch { }
    }
    uiRespond(id, answer) {
        try {
            this.proc?.stdin?.write(JSON.stringify({ type: "extension_ui_response", id, ...answer }) + "\n");
        }
        catch (e) {
            log(`rpc[${this.key}] ui 回复写入失败：${e?.message || e}`);
        }
    }
    async deliver(text) {
        const { run } = this.runForTurn();
        run.inflight = (run.inflight || 0) + 1;
        try {
            await this.cmd("prompt", { message: text, streamingBehavior: "followUp" }, 60000);
            run.inflight--;
            run.acceptedCount = (run.acceptedCount || 0) + 1;
        }
        catch (e) {
            run.inflight--;
            if (e?.outcome !== "rejected") {
                run.acceptedCount = (run.acceptedCount || 0) + 1;
                log(`rpc[${this.key}] prompt 状态未知（${e?.outcome || "未标注"}，按可能已入队处理，等待终态）：${String(e?.message).slice(0, 120)}`);
                return { run, queued: true, uncertain: true };
            }
            if (!run.acceptedCount && !run.inflight) {
                run.error = e.message;
                run.settle();
            }
            else {
                log(`rpc[${this.key}] 投递失败但该轮已有其他内容入队或在途，不结算：${String(e.message).slice(0, 120)}`);
            }
            return { run, queued: false, error: e.message };
        }
        return { run, queued: true };
    }
    async stats() {
        try {
            const r = await this.cmd("get_session_stats", {}, 30000);
            const d = r.data || null;
            const pct = d?.contextUsage?.percent;
            if (d?.contextUsage)
                this.ctxPercent = typeof pct === "number" && Number.isFinite(pct) ? pct : null;
            if (d?.contextUsage?.contextWindow > 0)
                this.contextWindow = d.contextUsage.contextWindow;
            return d;
        }
        catch {
            return null;
        }
    }
    async refreshMeta() {
        try {
            const r = await this.cmd("get_state", {}, 15000);
            const m = r.data?.model;
            if (m?.id)
                this.model = String(m.id);
            if (m?.provider)
                this.modelProvider = String(m.provider);
            if (m?.contextWindow > 0)
                this.contextWindow = m.contextWindow;
            this.thinkingLevel = m?.reasoning && r.data?.thinkingLevel ? String(r.data.thinkingLevel) : "";
        }
        catch (e) {
            log(`rpc[${this.key}] get_state 失败（模型名省略）：${e?.message || e}`);
        }
    }
    async footer() {
        await this.refreshMeta();
        const s = await this.stats();
        if (s && typeof s.cost === "number")
            this.cost = s.cost;
        return s;
    }
    // { models: 默认卡片（scope 优先）, all: 关键词检索范围（全部已认证模型）, scoped: 是否命中 scope }
    async listModels() {
        const r = await this.cmd("get_available_models", {}, 15000);
        const all = (r.data?.models || []).map(modelInfo).filter(Boolean);
        const scoped = scopeModels(all);
        return { models: scoped || all, all, scoped: !!scoped };
    }
    async setModel(m) {
        const r = await this.cmd("set_model", { provider: m.provider, modelId: m.id }, 30000);
        const d = r.data || {};
        this.model = String(d.id || m.id);
        this.modelProvider = String(d.provider || m.provider);
        if (d.contextWindow > 0)
            this.contextWindow = d.contextWindow;
        return { ok: true };
    }
    /** 当前模型可选的思考强度；模型不支持推理时为空。 */
    async thinkingLevels() {
        await this.refreshMeta();
        if (!this.thinkingLevel)
            return { levels: [], current: "" };
        const r = await this.cmd("get_available_thinking_levels", {}, 15000);
        return { levels: (r.data?.levels || []).map(String), current: this.thinkingLevel };
    }
    async setThinking(level) {
        await this.cmd("set_thinking_level", { level }, 15000);
        await this.refreshMeta();
        return { ok: true, level: this.thinkingLevel || level };
    }
    async compact(instructions) {
        const r = await this.cmd("compact", instructions ? { customInstructions: instructions } : {}, COMPACT_MS);
        const d = r.data || {};
        return { ok: true, before: Number(d.tokensBefore) || 0, after: Number(d.estimatedTokensAfter) || 0 };
    }
    async abort() {
        try {
            await this.cmd("abort", {}, 30000);
            return true;
        }
        catch {
            return false;
        }
    }
    close() {
        this.closed = true;
        try {
            this.proc?.stdin?.end();
        }
        catch { }
        setTimeout(() => {
            try {
                this.proc?.kill("SIGTERM");
            }
            catch { }
        }, 3000);
        targets.delete(this.key);
    }
}
class TuiTarget extends Target {
    constructor(opts) {
        super("tui", opts);
        this.inbox = [];
        this.waiter = null;
        this.lastPoll = Date.now();
    }
    get alive() {
        return !this.closed && Date.now() - this.lastPoll < TUI_STALE_MS;
    }
    deliver(text) {
        this.inbox.push({ text });
        if (this.waiter) {
            const w = this.waiter;
            this.waiter = null;
            w();
        }
        const { run } = this.runForTurn();
        return { run, queued: this.alive };
    }
    takeInbox() {
        const m = this.inbox;
        this.inbox = [];
        return m;
    }
    async listModels() {
        // 旧版扩展只上报 models：检索范围退回同一列表。
        const all = this.allModels.length ? this.allModels : this.models;
        return { models: this.models.length ? this.models : all, all, scoped: this.modelScoped };
    }
    /** 经轮询向扩展发请求，扩展用 /meta-ack 回复；失联或超时返回 null。 */
    ask(msg, ms = META_ACK_MS) {
        if (!this.alive)
            return Promise.resolve(null);
        const reqId = `f${Date.now().toString(36)}${crypto.randomUUID().slice(0, 8)}`;
        return new Promise((resolve) => {
            const timer = setTimeout(() => { metaAcks.delete(reqId); resolve(null); }, ms);
            metaAcks.set(reqId, { key: this.key, resolve: (v) => { clearTimeout(timer); resolve(v); } });
            this.inbox.push({ ...msg, reqId });
            this.waiter?.();
        });
    }
    /** 让扩展现取 footer 信息；终端未响应时沿用上次上报。 */
    footer() {
        return this.ask({ type: "get_meta" });
    }
    async thinkingLevels() {
        const s = await this.footer();
        if (!s)
            throw new Error("终端未响应，请稍后重试");
        if (!Array.isArray(s.thinkingLevels))
            throw new Error("终端扩展版本过旧，请在电脑上 /reload");
        this.thinkingLevel = typeof s.thinkingLevel === "string" ? s.thinkingLevel : "";
        return { levels: s.thinkingLevels.map(String), current: this.thinkingLevel };
    }
    async setThinking(level) {
        const r = await this.ask({ type: "set_thinking", level }, MODEL_ACK_MS);
        if (!r)
            return { ok: false, error: "终端未响应，请在电脑上 /reload 后重试" };
        if (r.ok && typeof r.thinkingLevel === "string")
            this.thinkingLevel = r.thinkingLevel;
        return { ok: !!r.ok, level: this.thinkingLevel || level, error: r.error ? String(r.error).slice(0, 120) : "" };
    }
    async compact(instructions) {
        const r = await this.ask({ type: "compact", instructions }, COMPACT_MS);
        if (!r)
            return { ok: false, error: "终端未响应，请在电脑上 /reload 后重试" };
        return { ok: !!r.ok, before: Number(r.tokensBefore) || 0, after: Number(r.tokensAfter) || 0, error: r.error ? String(r.error).slice(0, 120) : "" };
    }
    setModel(m) {
        if (!this.alive)
            return Promise.resolve({ ok: false, error: "终端会话已失联" });
        const reqId = `m${Date.now().toString(36)}${crypto.randomUUID().slice(0, 8)}`;
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                modelAcks.delete(reqId);
                resolve({ ok: false, error: "终端未响应，请在电脑上 /reload 后重试" });
            }, MODEL_ACK_MS);
            modelAcks.set(reqId, { key: this.key, resolve: (v) => { clearTimeout(timer); resolve(v); } });
            this.inbox.push({ type: "set_model", reqId, provider: m.provider, modelId: m.id });
            this.waiter?.();
        });
    }
    close() {
        this.closed = true;
        for (const r of this.loops.values()) {
            if (r.settled || r === this.run)
                continue;
            if (shuttingDown)
                r.aborted = "Pi Bridge 重启";
            else
                r.error = "TUI 会话已关闭";
            r.settle();
        }
        if (this.run && !this.run.settled) {
            if (shuttingDown)
                this.run.aborted = "Pi Bridge 重启";
            else
                this.run.error = "TUI 会话已关闭";
            this.run.settle();
        }
        dropUiPrompts(this);
        targets.delete(this.key);
    }
}
let numMap = [];
const metaCache = new Map();
async function cachedMeta(file, mtimeMs) {
    const k = `${file}:${mtimeMs}`;
    const hit = metaCache.get(k);
    if (hit)
        return hit;
    const meta = await sessionMeta(file);
    if (metaCache.size > 1200)
        for (const kk of [...metaCache.keys()].slice(0, 600))
            metaCache.delete(kk);
    metaCache.set(k, meta);
    return meta;
}
async function metasOf(list, conc = 16) {
    const out = new Array(list.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(conc, list.length) }, async () => {
        for (;;) {
            const k = i++;
            if (k >= list.length)
                return;
            out[k] = await cachedMeta(list[k].file, list[k].mtimeMs);
        }
    }));
    return out;
}
function hayMatch(hay, terms) {
    for (const w of terms)
        if (!hay.includes(w))
            return false;
    return true;
}
// 相关性：会话名 > 开场白；整句命中、前缀命中、越靠前、出现次数越多分越高。
const FIELD_WEIGHT = { name: 10, user: 4 };
function fieldScore(text, w) {
    const at = text.indexOf(w);
    if (at < 0)
        return 0;
    let n = 0;
    for (let i = at; i >= 0; i = text.indexOf(w, i + w.length))
        n++;
    return 1 + (at === 0 ? 1 : 0) + 1 / (1 + at / 20) + Math.min(n - 1, 3) * 0.2 + (text === w ? 2 : 0);
}
function relevance(meta, terms, find) {
    const f = meta.fields || { name: "", user: meta.hay || "" };
    const phrase = find.toLowerCase().replace(/\s+/g, " ");
    let score = 0;
    for (const [k, weight] of Object.entries(FIELD_WEIGHT)) {
        const text = f[k] || "";
        if (!text)
            continue;
        for (const w of terms)
            score += weight * fieldScore(text, w);
        if (terms.length > 1 && text.includes(phrase))
            score += weight * 2;
    }
    return score;
}
const splitTerms = (s) => String(s || "").toLowerCase().split(/\s+/).filter(Boolean);
let histStat = { total: 0, matched: 0, find: "" };
async function buildList(opts = {}) {
    const find = String(opts.find || "").trim();
    const terms = splitTerms(find);
    const live = [...targets.values()].filter((t) => (t.kind !== "tui" ? !t.closed : t.alive));
    live.sort((a, b) => b.lastActivity - a.lastActivity);
    const liveFiles = new Set(live.map((t) => t.sessionFile).filter(Boolean));
    const all = (await scanHistory()).filter((h) => !liveFiles.has(h.file));
    let hist = [];
    let metas = [];
    let matched = 0;
    if (!terms.length) {
        hist = all.slice(0, HIST_LIST);
        metas = await metasOf(hist);
        matched = all.length;
    }
    else {
        const allMetas = await metasOf(all);
        const hits = [];
        for (let k = 0; k < all.length; k++) {
            if (!hayMatch(allMetas[k].hay || "", terms))
                continue;
            hits.push({ h: all[k], meta: allMetas[k], score: relevance(allMetas[k], terms, find) });
        }
        // 同分按最近修改排序。
        hits.sort((a, b) => b.score - a.score || b.h.mtimeMs - a.h.mtimeMs);
        matched = hits.length;
        for (const x of hits.slice(0, HIST_FIND_MAX)) {
            hist.push(x.h);
            metas.push(x.meta);
        }
    }
    histStat = { total: all.length, matched, find };
    const rows = [...live];
    for (let k = 0; k < hist.length; k++) {
        const h = hist[k];
        const meta = metas[k];
        const t = new Target("history", { cwd: meta.cwd, name: meta.name, sessionFile: h.file, sessionId: meta.id });
        t.mtimeMs = h.mtimeMs;
        rows.push(t);
    }
    numMap = rows;
    return numMap;
}
const liveRows = (rows) => rows.filter((t) => t.kind !== "history");
const histRows = (rows) => rows.filter((t) => t.kind === "history");
let currentKey = null;
let currentSessionId = "";
function loadCurrent() {
    try {
        currentSessionId = fs.readFileSync(CURRENT_FILE, "utf8").trim();
    }
    catch {
        currentSessionId = "";
    }
}
function bindCurrent(t) {
    currentKey = t?.key || null;
    if (t)
        watchInflight(t);
    const sid = t?.sessionId || "";
    if (sid === currentSessionId)
        return;
    currentSessionId = sid;
    try {
        if (sid)
            fs.writeFileSync(CURRENT_FILE, sid + "\n", { mode: 0o600 });
        else
            fs.rmSync(CURRENT_FILE, { force: true });
    }
    catch (e) {
        log(`写 .current 失败：${e?.message || e}`);
    }
}
function watchInflight(t) {
    const runs = new Set(t.loops ? [...t.loops.values()] : []);
    if (t.run)
        runs.add(t.run);
    for (const r of runs) {
        if (r.settled || r.watched)
            continue;
        watchAsync(t, r);
        log(`bind → watch inflight target=${t.key} id=${r.id} elapsed=${human(Date.now() - r.startedAt)}`);
    }
}
function currentTarget() {
    if (currentKey) {
        const t = targets.get(currentKey);
        if (t && (t.kind !== "tui" || t.alive))
            return t;
    }
    if (currentSessionId) {
        const t = [...targets.values()].find((x) => x.sessionId === currentSessionId && x.kind !== "history" && (x.kind !== "tui" || x.alive));
        if (t) {
            currentKey = t.key;
            return t;
        }
    }
    return null;
}
function renderList(subset, all, title) {
    const lines = subset.map((t) => {
        const i = all.indexOf(t);
        const bits = [`${num(i + 1)} ${t.label()}`];
        if (t.busy)
            bits.push("运行中");
        bits.push(t.kind === "history" ? ago(t.mtimeMs) : ago(t.lastActivity));
        const cwd = tilde(t.cwd);
        if (cwd !== "~")
            bits.push(cwd);
        if (t.key === currentKey)
            bits.push("← 当前");
        return bits.join(" · ");
    });
    return plainText({
        head: `⚠️ 卡片发送失败 · ${title}`,
        body: lines.join("\n") || "（空）",
        foot: "发送 `选择会话 序号` 直达，如 `选择会话 2`",
    });
}
function clip(s, n) {
    const t = String(s ?? "").replace(/\s+/g, " ").trim();
    const cps = Array.from(t);
    return cps.length <= n ? t : cps.slice(0, Math.max(1, n - 1)).join("") + "…";
}
function truncateUtf8(text, maxBytes) {
    let bytes = 0;
    let out = "";
    for (const char of String(text ?? "")) {
        const n = Buffer.byteLength(char);
        if (bytes + n > maxBytes)
            break;
        out += char;
        bytes += n;
    }
    return out;
}
function promptHint(text) {
    const s = stripCtrl(String(text || "")).trim();
    return s ? clip(s, HIST_NAME_MAX) : "";
}
let taskSeq = 0;
const taskId = (tag) => `task_${String(tag).replace(/[^0-9A-Za-z]/g, "")}_${Date.now()}${++taskSeq}`;
const CTRL_RE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\uFEFF]/;
const CTRL_RE_G = new RegExp(CTRL_RE.source, "g");
function stripCtrl(s) {
    if (!CTRL_RE.test(s))
        return s;
    return s.replace(CTRL_RE_G, " ").replace(/ {2,}/g, " ").trim();
}
const CTRL_KEEP_NL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\uFEFF]/g;
const stripCtrlKeepNl = (s) => String(s ?? "").replace(CTRL_KEEP_NL_RE, " ").replace(/[^\S\n]{2,}/g, " ");
const ASTRAL_TOFU = "□";
const PAIRED_SURROGATE_RE = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;
const LONE_SURROGATE_RE = /[\uD800-\uDFFF]/g;
const hex = (s) => "U+" + s.codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
function stripAstral(s, path, hits) {
    if (!/[\uD800-\uDFFF]/.test(s))
        return s;
    const pairs = [];
    let out = s.replace(PAIRED_SURROGATE_RE, (m) => {
        pairs.push(m);
        return "\u0000" + (pairs.length - 1) + "\u0000";
    });
    out = out.replace(LONE_SURROGATE_RE, (m) => {
        hits.push(`${path}=lone:${hex(m)}`);
        return ASTRAL_TOFU;
    });
    return out.replace(/\u0000(\d+)\u0000/g, (_, i) => pairs[Number(i)]);
}
function sanitizeCard(v, path = "card", hits = []) {
    if (typeof v === "string")
        return stripCtrl(stripAstral(v, path, hits));
    if (Array.isArray(v))
        return v.map((x, i) => sanitizeCard(x, `${path}[${i}]`, hits));
    if (v && typeof v === "object") {
        const o = {};
        for (const [k, val] of Object.entries(v)) {
            const nk = stripCtrl(stripAstral(String(k), `${path}.<key>`, hits));
            o[nk] = sanitizeCard(val, `${path}.${nk}`, hits);
        }
        return o;
    }
    return v;
}
function cardBlock(card, lead = "", fallback = "") {
    const clean = sanitizeCard(card);
    for (const option of card.options || []) {
        const pick = cardPicks.get(option.id);
        if (pick)
            pick.taskId = card.task_id;
    }
    const text = typeof fallback === "function" ? fallback() : String(fallback || lead);
    return { card: clean, fallback: text };
}
const cardPicks = new Map();
function registerPick(info) {
    if (cardPicks.size > 600) {
        // 淘汰最旧的一批；仍在等待回答的弹窗卡片保留。
        for (const k of [...cardPicks.keys()].slice(0, 300))
            if (!(cardPicks.get(k)?.act === "ui" && uiPending.has(cardPicks.get(k).reqId)))
                cardPicks.delete(k);
    }
    const key = `pb_${crypto.randomUUID()}`;
    cardPicks.set(key, { ...info, at: Date.now() });
    return key;
}
const usedTasks = new Map();
function consumeTask(tid) {
    const now = Date.now();
    for (const [k, v] of usedTasks)
        if (now - v.at > CARD_TTL_MS)
            usedTasks.delete(k);
    if (!tid)
        return null;
    const hit = usedTasks.get(tid);
    if (hit)
        return hit;
    usedTasks.set(tid, { at: now, reply: "" });
    return null;
}
function pickState(t) {
    return t.busy ? "← 运行中" : "";
}
function emptyLiveText() {
    return plainText({
        head: "💬 活跃会话 · 0 个",
        body: "现在没有打开的会话，可以新建一个，或者从历史里找。",
        foot: "发送 `创建会话` 新建，或 `历史会话` 找回会话",
    });
}
function optText(t) {
    const bits = [t.label()];
    const st = pickState(t);
    if (st)
        bits.push(st);
    if (t.key === currentKey)
        bits.push("← 当前");
    return bits.join(" · ");
}
const selOpt = (t) => ({
    id: registerPick({
        act: "sel",
        targetKey: t.key,
        sessionFile: t.sessionFile,
        cwd: t.cwd,
        name: t.name,
        find: histStat.find || "",
    }),
    text: optText(t),
});
const PICK_LEAD = "**请选择会话**";
function buildLsCard(rows) {
    const live = liveRows(rows);
    if (!live.length)
        return emptyLiveText();
    const options = live.slice(0, VOTE_OPT_MAX).map((t) => selOpt(t));
    const card = {
        card_type: "vote_interaction",
        title: clip("💬 活跃会话", 26),
        desc: `活跃 ${live.length} 个 · 发「历史会话」查询历史`,
        options,
        mode: 0,
        submit_text: "选择会话",
        task_id: taskId("ls"),
    };
    return cardBlock(card, PICK_LEAD, () => renderList(live, rows, "活跃会话"));
}
function buildHistCard(rows) {
    const hist = histRows(rows);
    const { total, matched, find } = histStat;
    if (find && !hist.length) {
        return plainText({
            head: `🔍 历史检索 · “${clip(find, 16)}”`,
            body: "没有找到。只搜会话名和开场白，不搜全文。",
            foot: `已搜 ${total} 个 · 换个词，或发 \`历史会话\` 看最近 ${HIST_LIST} 条`,
        });
    }
    if (!hist.length) {
        return plainText({
            head: "🗂️ 历史会话 · 0 个",
            body: "~/.pi/agent/sessions 下还没有会话文件。",
            foot: "发送 `创建会话` 或 `创建后台会话` 新建",
        });
    }
    const options = hist.slice(0, VOTE_OPT_MAX).map((t) => selOpt(t));
    const card = {
        card_type: "vote_interaction",
        title: clip(find ? `🔍 “${find}” 的检索结果` : "🗂️ 历史会话", 26),
        desc: find ? `找到 ${matched} 个 · 显示 ${options.length} 个` : `最近 ${options.length} 个 · 发「历史会话 关键词」搜索`,
        options,
        mode: 0,
        submit_text: "选择会话",
        task_id: taskId("h"),
    };
    if (find && matched > options.length)
        log(`历史会话 检索 “${find}” 命中 ${matched} 条，列前 ${options.length}`);
    return cardBlock(card, PICK_LEAD, () => renderList(hist, rows, find ? `检索“${find}”` : "历史会话"));
}
const RULE = "---";
function plainText({ head, body = "", foot = "", extra = "" }) {
    const parts = [`**${head}**`];
    if (body)
        parts.push("", RULE, "", body);
    if (extra)
        parts.push("", extra);
    if (foot)
        parts.push("", RULE, "", footLine(foot));
    return parts.join("\n");
}
// foot 是弱化的元信息：普通段整段包行内代码；含 `指令` 的引导段保持原样，仅指令为行内代码。
function footLine(foot) {
    return String(foot).split(" · ").map((seg) => (seg.includes("`") ? seg : "`" + seg + "`")).join(" · ");
}
function doneFoot(t, run, stats) {
    const foot = [`目录：${tilde(t.cwd)}`, `运行：${human((run.endedAt || Date.now()) - run.startedAt)}`];
    const context = contextPctLabel(t, stats);
    if (context !== "未知")
        foot.push(`上下文：${context}`);
    if (run.toolErrors > 0)
        foot.push(`${run.toolErrors} 失败`);
    if (stats?.cost != null && Number(stats.cost) > 0)
        foot.push(`$${Number(stats.cost).toFixed(4)}`);
    return foot.join(" · ");
}
function ctxPercent(t, stats) {
    const fromStats = stats?.contextUsage?.percent;
    if (typeof fromStats === "number" && isFinite(fromStats))
        return fromStats;
    if (typeof t?.ctxPercent === "number" && isFinite(t.ctxPercent) && t.ctxPercent >= 0)
        return t.ctxPercent;
    return null;
}
function contextWindow(stats, t) {
    const value = stats?.contextUsage?.contextWindow || t?.contextWindow;
    return typeof value === "number" && isFinite(value) && value > 0 ? value : null;
}
function contextWindowLabel(value) {
    if (!value)
        return "未知";
    return value >= 1000000 ? `${(value / 1000000).toFixed(1)}m` : `${Math.round(value / 1000)}k`;
}
function contextLabel(t, stats) {
    const pct = ctxPercent(t, stats);
    const window = contextWindowLabel(contextWindow(stats, t));
    return pct == null ? (window === "未知" ? "未知" : `未知 / ${window}`) : `${pct.toFixed(1)}% / ${window}`;
}
// 三段式文本 foot 只保留百分比，窗口大小留给卡片展示。
function contextPctLabel(t, stats) {
    const pct = ctxPercent(t, stats);
    return pct == null ? "未知" : `${pct.toFixed(1)}%`;
}
function fmtDone(t, run, stats) {
    const foot = doneFoot(t, run, stats);
    const body = (run.lastText || "（无文本输出）").trim();
    const extra = "";
    const state = run.stopped ? "⚠️ 已中断" : "🏁 任务完成";
    const head = `${state} · ${t.label()}`;
    const full = plainText({ head, body, foot, extra });
    const fullBytes = Buffer.byteLength(full);
    if (fullBytes <= PUSH_TEXT_MAX_BYTES)
        return full;
    const note = `字数超限，请查看 Markdown。`;
    log(`交付正文 ${fullBytes} UTF-8 字节 > ${PUSH_TEXT_MAX_BYTES} → 转 Markdown 文档`);
    return {
        text: plainText({ head, body: note, foot, extra }),
        doc: {
            name: t.label(),
            cwd: t.cwd,
            meta: `${human((run.endedAt || Date.now()) - run.startedAt)} · ${body.length} 字`,
            body: extra ? `${body}\n\n---\n\n${extra}` : body,
        },
        degrade: () => plainText({
            head,
            body: `${truncateUtf8(body, PUSH_TEXT_MAX_BYTES - 400)}\n\n…（共 ${body.length} 字，Markdown 文档上传失败，已截断）`,
            foot,
        }),
    };
}
function stateCard({ tag, icon, title, desc, emph, emphMax = EMPH_MAX, body = "", facts = [], lead = "", fallback }) {
    const hc = facts
        .filter(Boolean)
        .slice(0, 6)
        .map((f) => ({ keyname: clip(f.keyname, 5), value: clip(f.value, 26) }));
    const card = {
        card_type: "text_notice",
        main_title: { title: clip(icon ? `${icon} ${title}` : title, 26), desc: clip(desc, 30) },
        card_action: { type: 1, url: "https://work.weixin.qq.com" },
        task_id: taskId(tag),
    };
    if (emph) {
        card.emphasis_content = { title: clip(emph.title, emphMax) };
        if (emph.desc)
            card.emphasis_content.desc = clip(emph.desc, EMPH_DESC_MAX);
    }
    if (body)
        card.sub_title_text = clip(body, CARD_BODY_MAX);
    if (hc.length)
        card.horizontal_content_list = hc;
    return cardBlock(card, lead, fallback);
}
const runFor = (run) => human((run.endedAt || Date.now()) - run.startedAt);
function fmtAccepted(t) {
    const foot = [`目录：${tilde(t.cwd)}`];
    if (t.model)
        foot.push(`模型：${t.model}`);
    return plainText({ head: `⏳ 运行中 · ${t.label()}`, body: "任务已开始运行，完成后推送", foot: foot.join(" · ") });
}
function fmtFail(t, run) {
    return plainText({
        head: `⚠️ 任务失败 · ${t.label()}`,
        body: `错误：${run.error}`,
        foot: `目录：${tilde(t.cwd)} · 运行：${runFor(run)}`,
    });
}
function fmtAborted(t, run) {
    const why = run.aborted === "会话失联" ? "会话失联" : "Pi Bridge 重启";
    return plainText({
        head: `⚠️ 任务中断 · ${t.label()}`,
        body: `${why}，这一轮的结果没能送回。电脑上的任务可能已经完成。`,
        foot: `目录：${tilde(t.cwd)} · 运行：${runFor(run)} · 发送 \`状态\` 查看`,
    });
}
function fmtNotDelivered(t, error) {
    const foot = [`目录：${tilde(t.cwd)}`];
    if (error)
        foot.push(`原因：${String(error).slice(0, 60)}`);
    return plainText({
        head: `⚠️ 未送达 · ${t.label()}`,
        body: "这条消息没有进入会话，附件已保留。请重发。",
        foot: foot.join(" · "),
    });
}
async function deliverAndWait(t, text, ack) {
    t.lastActivity = Date.now();
    if (!t.name)
        t.hint = promptHint(text);
    const { run, queued, error } = await t.deliver(text);
    markAck(ack, queued);
    if (!queued)
        return fmtNotDelivered(t, error);
    const timeout = new Promise((res) => setTimeout(() => res("TIMEOUT"), SYNC_WINDOW_MS));
    const which = await Promise.race([run.wait().then(() => "DONE"), timeout]);
    if (which === "DONE") {
        if (run.watched)
            return fmtAccepted(t);
        if (run.error)
            return fmtFail(t, run);
        const stats = t.stats ? await t.stats() : null;
        const msg = fmtDone(t, run, stats);
        if (typeof msg !== "string" && msg.doc) {
            try {
                return { text: msg.text, file: await uploadMdDoc(msg.doc) };
            }
            catch {
                return msg.degrade();
            }
        }
        return msg;
    }
    watchAsync(t, run);
    return fmtAccepted(t);
}
async function deliverAsync(t, text, ack) {
    t.lastActivity = Date.now();
    if (!t.name)
        t.hint = promptHint(text);
    const { run, queued, error } = await t.deliver(text);
    markAck(ack, queued);
    if (!queued)
        return { notDelivered: true, error };
    return watchAsync(t, run);
}
function trackLocalTurn(t, prompt) {
    if (t.busy)
        return false;
    if (!t.name)
        t.hint = promptHint(prompt || "");
    const run = new Run();
    run.local = true;
    t.run = run;
    t.lastActivity = Date.now();
    watchAsync(t, run);
    return true;
}
const inflightPushes = new Set();
function trackedPush(msg) {
    const p = pushResult(msg).finally(() => inflightPushes.delete(p));
    inflightPushes.add(p);
    return p;
}
function watchAsync(t, run) {
    if (run.watched)
        return;
    run.watched = true;
    let sent = 0;
    const prog = setInterval(() => {
        if (run.settled || sent >= SILENCE_STEPS_MS.length)
            return clearInterval(prog);
        const silent = Date.now() - run.lastOutputAt;
        if (silent < SILENCE_STEPS_MS[sent])
            return;
        const ms = SILENCE_STEPS_MS[sent];
        const step = ms % 3600000 === 0 ? `${ms / 3600000} 小时` : `${Math.round(ms / 60000)} 分钟`;
        sent++;
        const ran = `已运行 ${human(Date.now() - run.startedAt)}`;
        const body = sent >= SILENCE_STEPS_MS.length
            ? `${ran}，连续 ${step} 没有动作，可能卡住了，之后不再提醒。`
            : `${ran}，${step} 没有新动作${run.lastTool ? `，最后一个动作是 ${run.lastTool}` : ""}。`;
        sendText(plainText({ head: `⏳ 运行中 · ${t.label()}`, body, foot: "发送 `状态` 查看详情，或 `停止` 停止" }));
    }, 30000);
    run.wait().then(async () => {
        clearInterval(prog);
        // 后台会话被「停止」且没有任何文本产出：「停止」的即时回复已说明，不再推一条「（无文本输出）」。
        if (run.stopByCmd && !run.error && !run.lastText) {
            log(`async stopped-empty target=${t.key} dur=${human((run.endedAt || Date.now()) - run.startedAt)}（不推送）`);
            return;
        }
        const msg = run.aborted
            ? fmtAborted(t, run)
            : run.error
                ? fmtFail(t, run)
                : fmtDone(t, run, t.stats ? await t.stats() : null);
        const kind = run.aborted ? "aborted" : run.error ? "fail" : "done";
        const shaOf = typeof msg === "string" ? msg : msg.text;
        log(`async ${kind} sha=${sha8(shaOf)} target=${t.key} dur=${human((run.endedAt || Date.now()) - run.startedAt)}` +
            (typeof msg === "string" ? "" : " +md"));
        await trackedPush(msg);
    });
}
const COMMANDS = new Set(["ls", "h", "n", "nb", "stop", "status", "help", "model", "cd", "think", "compact"]);
const NL_ALIASES = [
    ["帮助", "help", false],
    ["活跃会话", "ls", false],
    ["查询活跃会话", "ls", false],
    ["切换会话", "ls", false],
    ["历史会话", "h", true],
    ["查询历史会话", "h", true],
    ["创建会话", "n", true],
    ["新建会话", "n", true],
    ["创建后台会话", "nb", true],
    ["新建后台会话", "nb", true],
    ["状态", "status", false],
    ["查询状态", "status", false],
    ["停止", "stop", false],
    ["停止任务", "stop", false],
    ["切换模型", "model", true],
    ["模型", "model", true],
    ["切换目录", "cd", true],
    ["目录", "cd", true],
    ["切换思考强度", "think", true],
    ["思考强度", "think", true],
    ["压缩会话", "compact", true],
    ["压缩", "compact", true],
].sort((a, b) => b[0].length - a[0].length);
function parseNlAlias(body) {
    for (const [word, cmd, args] of NL_ALIASES) {
        if (!body.startsWith(word))
            continue;
        const tail = body.slice(word.length);
        if (!tail)
            return { cmd, rest: "", alias: word };
        if (!args || !/^\s/.test(tail))
            continue;
        return { cmd, rest: tail.trim(), alias: word };
    }
    return null;
}
function parseCmd(text) {
    const t = text.trim();
    const selection = t.match(/^(?:选择会话|select)\s+(\d+)(?:\s+([\s\S]*))?$/i);
    if (selection)
        return { cmd: selection[1], rest: (selection[2] || "").trim(), alias: "选择会话" };
    const nl = parseNlAlias(t);
    if (nl)
        return nl;
    return parseBare(t);
}
const BARE_ARGS = new Set(["h", "n", "nb", "model", "cd", "think", "compact"]);
function parseBare(t) {
    const m = t.match(/^([A-Za-z]+)(?:\s+([\s\S]*))?$/);
    if (!m)
        return null;
    const cmd = m[1].toLowerCase();
    if (!COMMANDS.has(cmd))
        return null;
    const rest = (m[2] || "").trim();
    if (rest && !BARE_ARGS.has(cmd))
        return null;
    return { cmd, rest, bare: true };
}
const helpText = () => [
    "**📖 命令表**",
    "",
    "---",
    "",
    "| 英文 | 中文 |",
    "|---|---|",
    "| ls | 活跃会话 |",
    "| h | 历史会话 |",
    "| h 关键词 | 历史会话 关键词 |",
    "| n [目录] [消息] | 创建会话 [目录] [消息] |",
    "| nb [目录] [消息] | 创建后台会话 [目录] [消息] |",
    "| model [关键词] | 模型 [关键词] |",
    "| think [强度] | 思考强度 [强度] |",
    "| cd [别名] | 目录 [别名] |",
    "| compact [说明] | 压缩 [说明] |",
    "| status | 状态 |",
    "| stop | 停止 |",
    "| help | 帮助 |",
    "",
    "",
    "---",
    "",
    "**Tips**",
    "",
    "`1. 在电脑 Pi 可通过 /remote 进行配置`",
    "`2. 在电脑 Pi 可通过 /tabmodel 启用会话自动命名`",
].join("\n");

async function resolveNumber(n) {
    if (!numMap.length)
        await buildList();
    const t = numMap[n - 1];
    if (!t)
        return null;
    if (t.kind !== "history")
        return t;
    log(`spawn history target ${path.basename(t.sessionFile)}`);
    const rt = new RpcTarget({ cwd: t.cwd, name: t.name, sessionFile: t.sessionFile });
    targets.set(rt.key, rt);
    try {
        await rt.start({ sessionFile: t.sessionFile });
        await rt.refreshMeta();
    }
    catch (e) {
        rt.close();
        return { failed: plainText({ head: "⚠️ 打开历史会话失败", body: clip(t.name || t.hint || "会话", 40), foot: `原因：${String(e?.message || e).slice(0, 100)}` }) };
    }
    const i = numMap.findIndex((x) => x.key === t.key);
    if (i >= 0)
        numMap[i] = rt;
    return rt;
}
function kilo(n) {
    const v = Number(n);
    if (!isFinite(v))
        return String(n);
    if (v < 1000)
        return String(Math.round(v));
    if (v < 1000000)
        return `${(v / 1000).toFixed(v < 10000 ? 1 : 0)}k`;
    return `${(v / 1000000).toFixed(2)}M`;
}
// ---- 模型切换 ----
const modelAcks = new Map();
const metaAcks = new Map();
function modelInfo(m) {
    if (!m || typeof m !== "object" || !m.id || !m.provider)
        return null;
    const out = { provider: stripCtrl(String(m.provider)), id: stripCtrl(String(m.id)) };
    if (m.name && String(m.name) !== out.id)
        out.name = stripCtrl(String(m.name));
    if (m.contextWindow > 0)
        out.contextWindow = Number(m.contextWindow);
    return out;
}
const modelKey = (m) => `${m.provider}/${m.id}`;
const modelLabel = (m) => m.name || m.id;
function globRe(pat) {
    return new RegExp("^" + pat.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
}
// 后台会话不加载个人扩展，但仍遵循 settings.json 的 enabledModels，与电脑端 Ctrl+P 的范围一致。
function enabledModelPatterns() {
    try {
        const v = JSON.parse(fs.readFileSync(path.join(CFG.agentDir, "settings.json"), "utf8")).enabledModels;
        return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()) : [];
    }
    catch {
        return [];
    }
}
// 返回 enabledModels 命中的模型；未配置或一个都没命中时返回 null（调用方退回全部）。
function scopeModels(models) {
    const pats = enabledModelPatterns();
    if (!pats.length)
        return null;
    const out = [];
    for (const raw of pats) {
        const pat = raw.replace(/:(off|minimal|low|medium|high|xhigh|max)$/, "");
        const re = /[*?]/.test(pat) ? globRe(pat) : null;
        for (const m of models) {
            const hit = re ? re.test(modelKey(m)) || re.test(m.id) : pat.toLowerCase() === modelKey(m).toLowerCase() || pat.toLowerCase() === m.id.toLowerCase();
            if (hit && !out.includes(m))
                out.push(m);
        }
    }
    return out.length ? out : null;
}
const isCurrentModel = (t, m) => m.id === t.model && (!t.modelProvider || m.provider === t.modelProvider);
function modelMatches(models, find) {
    const terms = String(find || "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length)
        return models;
    const exact = models.filter((m) => [m.id, modelKey(m), m.name || ""].some((x) => x.toLowerCase() === terms.join(" ")));
    if (exact.length)
        return exact;
    return models.filter((m) => hayMatch(`${modelKey(m)} ${m.name || ""}`.toLowerCase(), terms));
}
async function buildModelCard(t, find = "") {
    let models, all, scoped;
    try {
        ({ models, all, scoped } = await t.listModels());
    }
    catch (e) {
        return plainText({ head: "⚠️ 读取模型失败", body: String(e?.message || e).slice(0, 120), foot: "稍后重试，或发送 `状态` 查看" });
    }
    if (!models?.length && !all?.length) {
        return plainText({
            head: "⚠️ 没有可选模型",
            body: t.kind === "tui" ? "终端还没上报模型列表，可能需要在电脑上 /reload 更新扩展。" : "这个会话没有配置好认证的模型。",
            foot: "在电脑上执行 /login 或 /model 配置",
        });
    }
    // 无关键词展示 scope；有关键词在全部已认证模型里检索。
    const hits = find ? modelMatches(all, find) : models;
    if (find && !hits.length) {
        return plainText({
            head: `🔍 没有匹配的模型 · “${clip(find, 16)}”`,
            body: `共 ${all.length} 个已认证模型，没有找到包含该关键词的模型。`,
            foot: "发送 `模型` 查看全部",
        });
    }
    if (find && hits.length === 1)
        return applyModel(t, hits[0]);
    const shown = hits.slice(0, VOTE_OPT_MAX);
    const options = shown.map((m) => ({
        id: registerPick({ act: "model", targetKey: t.key, sessionId: t.sessionId, provider: m.provider, modelId: m.id }),
        text: [modelLabel(m), m.provider, isCurrentModel(t, m) ? "← 当前" : ""].filter(Boolean).join(" · "),
    }));
    const more = hits.length > shown.length ? ` · 显示前 ${shown.length} 个` : "";
    const card = {
        card_type: "vote_interaction",
        title: clip(`💡 切换模型 · ${t.label()}`, 26),
        desc: find ? `找到 ${hits.length} 个${more}` : `可选 ${hits.length} 个${more} · 发「模型 关键词」筛选${scoped ? "所有模型" : ""}`,
        options,
        mode: 0,
        submit_text: "切换模型",
        task_id: taskId("model"),
    };
    return cardBlock(card, "**请选择模型**", () => plainText({
        head: `⚠️ 卡片发送失败 · 切换模型`,
        body: shown.map((m) => `${modelLabel(m)} · ${m.provider}${isCurrentModel(t, m) ? " · ← 当前" : ""}`).join("\n"),
        foot: "发送 `模型 模型名` 直接切换",
    }));
}
async function applyModel(t, m) {
    const fail = (why) => plainText({ head: "⚠️ 切换模型失败", body: `${modelLabel(m)} · ${t.label()}`, foot: `原因：${String(why || "未知").slice(0, 80)} · 发送 \`模型\` 重试` });
    let r;
    try {
        r = await t.setModel(m);
    }
    catch (e) {
        return fail(e?.message || e);
    }
    if (!r?.ok)
        return fail(r?.error);
    log(`切换模型 target=${t.key} → ${modelKey(m)}`);
    return buildModelCardDone(t, m);
}
function buildModelCardDone(t, m) {
    const name = modelLabel(m);
    const facts = [
        { keyname: "会话", value: t.label() },
        { keyname: "提供方", value: m.provider },
        { keyname: "上下文", value: contextLabel(t, null) },
    ];
    return stateCard({
        tag: "model",
        icon: "💡",
        title: "切换模型",
        desc: t.busy ? "已切换，当前任务的后续请求生效" : "已切换，下一条消息生效",
        emph: { title: name },
        emphMax: EMPH_NAME_MAX,
        facts,
        fallback: () => plainText({ head: "💡 切换模型", body: name, foot: facts.map((f) => `${f.keyname}：${f.value}`).join(" · ") }),
    });
}
/** 卡片点选时找回会话：key 失效（重注册）则按 sessionId 找。 */
function pickTarget(pick) {
    let t = targets.get(pick.targetKey);
    if (!t || t.closed)
        t = [...targets.values()].find((x) => x.sessionId && x.sessionId === pick.sessionId && x.kind !== "history" && !x.closed);
    return !t || (t.kind === "tui" && !t.alive) ? null : t;
}
async function handleModelPick(pick) {
    const t = pickTarget(pick);
    if (!t)
        return plainText({ head: "⚠️ 切换模型失败", body: "会话已关闭", foot: "发送 `活跃会话` 重新选择会话" });
    const { all: models = [] } = await t.listModels().catch(() => ({}));
    const m = models.find((x) => x.provider === pick.provider && x.id === pick.modelId) || { provider: pick.provider, id: pick.modelId };
    return applyModel(t, m);
}
// ---- 思考强度 ----
const THINK_CN = { off: "关闭", minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "超高", max: "最高" };
const thinkLabel = (l) => (THINK_CN[l] ? `${l} · ${THINK_CN[l]}` : l);
/** 接受英文级别或中文说法（高 / 关闭…）。 */
function thinkArg(arg) {
    const a = arg.trim().toLowerCase();
    return Object.hasOwn(THINK_CN, a) ? a : Object.keys(THINK_CN).find((k) => THINK_CN[k] === arg.trim()) || "";
}
async function buildThinkCard(t, arg = "") {
    let levels, current;
    try {
        ({ levels, current } = await t.thinkingLevels());
    }
    catch (e) {
        return plainText({ head: "⚠️ 读取思考强度失败", body: String(e?.message || e).slice(0, 120), foot: "稍后重试，或发送 `状态` 查看" });
    }
    if (!levels?.length) {
        return plainText({ head: "🧠 当前模型不支持思考强度", body: `${t.model || "未知模型"} · ${t.label()}`, foot: "发送 `模型` 换一个支持推理的模型" });
    }
    if (arg) {
        const want = thinkArg(arg);
        if (!want || !levels.includes(want))
            return plainText({ head: "⚠️ 切换思考强度失败", body: `当前模型不支持：${clip(arg, 20)}`, foot: `可选：${levels.join(" / ")}` });
        return applyThinking(t, want);
    }
    const options = levels.slice(0, VOTE_OPT_MAX).map((l) => ({
        id: registerPick({ act: "think", targetKey: t.key, sessionId: t.sessionId, level: l }),
        text: [thinkLabel(l), l === current ? "← 当前" : ""].filter(Boolean).join(" · "),
    }));
    const card = {
        card_type: "vote_interaction",
        title: clip(`🧠 切换思考强度 · ${t.label()}`, 26),
        desc: clip(`模型 ${t.model || "未知"} · 当前 ${current || "未知"}`, 30),
        options,
        mode: 0,
        submit_text: "切换思考强度",
        task_id: taskId("think"),
    };
    return cardBlock(card, "**请选择思考强度**", () => plainText({
        head: "⚠️ 卡片发送失败 · 切换思考强度",
        body: levels.map((l) => `${thinkLabel(l)}${l === current ? " · ← 当前" : ""}`).join("\n"),
        foot: "发送 `思考强度 high` 直接切换",
    }));
}
const fmtTok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n));
async function compactCard(t, instructions) {
    const fail = (why) => plainText({ head: "⚠️ 压缩会话失败", body: t.label(), foot: `原因：${String(why || "未知").slice(0, 80)}` });
    if (t.busy)
        return fail("会话正在运行，请等任务结束或先 `停止`");
    let r;
    try {
        r = await t.compact(instructions);
    }
    catch (e) {
        return fail(e?.message || e);
    }
    if (!r?.ok)
        return fail(r?.error);
    log(`压缩会话 target=${t.key} ${r.before}→${r.after}`);
    const facts = [{ keyname: "会话", value: t.label() }];
    if (instructions)
        facts.push({ keyname: "重点", value: instructions.slice(0, 40) });
    const change = r.before && r.after ? `${fmtTok(r.before)} → ${fmtTok(r.after)}` : "已压缩";
    return stateCard({
        tag: "compact",
        icon: "🗜️",
        title: "压缩会话",
        desc: "已压缩，下一条消息生效",
        emph: { title: change },
        emphMax: EMPH_NAME_MAX,
        facts,
        fallback: () => plainText({ head: "🗜️ 压缩会话", body: change, foot: facts.map((f) => `${f.keyname}：${f.value}`).join(" · ") }),
    });
}
async function applyThinking(t, level) {
    const fail = (why) => plainText({ head: "⚠️ 切换思考强度失败", body: `${level} · ${t.label()}`, foot: `原因：${String(why || "未知").slice(0, 80)} · 发送 \`思考强度\` 重试` });
    let r;
    try {
        r = await t.setThinking(level);
    }
    catch (e) {
        return fail(e?.message || e);
    }
    if (!r?.ok)
        return fail(r?.error);
    const got = r.level || level;
    log(`切换思考强度 target=${t.key} → ${got}${got !== level ? `（请求 ${level}）` : ""}`);
    const facts = [
        { keyname: "会话", value: t.label() },
        { keyname: "模型", value: t.model || "未知" },
    ];
    return stateCard({
        tag: "think",
        icon: "🧠",
        title: "切换思考强度",
        desc: got !== level ? `模型不支持 ${level}，已调整为 ${got}` : t.busy ? "已切换，当前任务的后续请求生效" : "已切换，下一条消息生效",
        emph: { title: thinkLabel(got) },
        emphMax: EMPH_NAME_MAX,
        facts,
        fallback: () => plainText({ head: "🧠 切换思考强度", body: thinkLabel(got), foot: facts.map((f) => `${f.keyname}：${f.value}`).join(" · ") }),
    });
}
function handleThinkPick(pick) {
    const t = pickTarget(pick);
    if (!t)
        return plainText({ head: "⚠️ 切换思考强度失败", body: "会话已关闭", foot: "发送 `活跃会话` 重新选择会话" });
    return applyThinking(t, pick.level);
}
// ---- 扩展弹窗转手机 ----
const UI_KINDS = new Set(["confirm", "select", "input", "editor", "question"]);
// 提问工具（question / questionnaire）允许手机直接回文字作答：记录等待文字的请求。
const WRITE_LABEL = "✏️ 自己写（直接回复文字）";
const uiPending = new Map();
const durLabel = (ms) => (ms >= 60000 ? `${Math.round(ms / 60000)} 分钟` : `${Math.max(1, Math.round(ms / 1000))} 秒`);
// 弹窗内容放进代码块：避免 `$...$` 被企微渲染成公式、Markdown 符号被解释。
function uiFence(text) {
    const body = truncateUtf8(stripCtrlKeepNl(String(text || "")).trim(), UI_TEXT_MAX_BYTES).replace(/`{3,}/g, "ʼʼʼ");
    return body ? "```\n" + body + "\n```" : "";
}
const uiAfterLabel = (kind) => (kind === "confirm" ? (UI_POLICY === "ask-then-allow" ? "自动允许" : "自动拒绝") : "自动取消");
function uiTimeoutAnswer(kind) {
    return kind === "confirm" ? { confirmed: UI_POLICY === "ask-then-allow" } : { cancelled: true };
}
/**
 * 登记一个待回答的扩展弹窗；reply(answer) 把 {confirmed}|{value}|{cancelled} 交回 Pi。
 * 由 daemon 统一计时：到点 confirm 按 remoteConfirm 处理，其余取消，任务不会卡住。
 */
function openUiPrompt(t, req, reply) {
    const kind = String(req.kind);
    const reqId = String(req.reqId || "");
    if (!reqId || uiPending.has(reqId))
        return;
    const title = stripCtrl(String(req.title || "")).trim() || "扩展请求";
    const detail = uiFence([String(req.title || ""), String(req.message || "")].filter((x) => x.trim()).join("\n\n"));
    const who = t.label();
    log(`ui ${kind} target=${t.key} ${JSON.stringify(clip(title, 60))}`);
    if (kind === "editor" || (kind === "input" && t.kind !== "tui")) {
        // 企微卡片不能输入文字、后台会话也无人在电脑前：直接取消，任务继续。
        reply({ cancelled: true });
        sendText(plainText({ head: `⚠️ 扩展请求输入 · ${who}`, body: detail, foot: "手机上无法填写，已取消 · 需要时请到电脑上操作" }));
        return;
    }
    if (kind === "confirm" && UI_POLICY === "allow") {
        reply({ confirmed: true });
        sendText(plainText({ head: `✅ 已自动允许 · ${who}`, body: detail, foot: "remoteConfirm 为 allow，不再询问" }));
        return;
    }
    const e = { reqId, t, kind, title, reply, done: false, limitMs: req.limitMs };
    // 扩展自带更短的超时：Pi 到点按扩展默认值处理，我们只回收卡片。
    const own = req.limitMs > 0 && req.limitMs < UI_TIMEOUT_MS;
    const wait = own ? req.limitMs : UI_TIMEOUT_MS;
    const after = own ? "按扩展默认处理" : uiAfterLabel(kind);
    e.wait = wait;
    e.expire = () => {
        if (own) {
            if (closeUiPrompt(e))
                sendText(plainText({ head: `⏱️ 请求已超时 · ${who}`, body: uiFence(title), foot: "已按扩展默认值处理，任务继续运行" }));
            return;
        }
        const answer = uiTimeoutAnswer(kind);
        if (settleUiPrompt(e, answer))
            sendText(plainText({ head: `⏱️ 超时未处理，已${uiAfterLabel(kind)} · ${who}`, body: uiFence(title), foot: "任务继续运行，完成后推送" }));
    };
    e.timer = setTimeout(e.expire, wait);
    e.timer.unref?.();
    uiPending.set(reqId, e);
    const limit = durLabel(wait);
    if (kind === "input") {
        // 终端会话：电脑前仍可填写；手机只提醒，到点取消。
        sendText(plainText({ head: `✏️ 电脑端等待输入 · ${who}`, body: detail, foot: `手机上无法填写 · ${limit}内未在电脑上处理将${after}` }));
        return;
    }
    let options;
    if (kind === "question") {
        const list = (Array.isArray(req.options) ? req.options : []).filter((x) => typeof x === "string");
        const descs = Array.isArray(req.descriptions) ? req.descriptions : [];
        const room = VOTE_OPT_MAX - (req.allowText ? 2 : 1);
        e.allowText = !!req.allowText;
        // 只发卡片：说明并入选项文字。
        options = list.slice(0, room).map((v, i) => [`${i + 1}. ${v}${descs[i] ? ` · ${descs[i]}` : ""}`, { index: i + 1, value: v }]);
        if (e.allowText)
            options.push([WRITE_LABEL, { write: true }]);
        options.push(["取消", { cancelled: true }]);
        if (list.length > room)
            e.more = list.length - room;
        const hint = [e.allowText ? "可直接回复文字" : "", e.more ? `另 ${e.more} 项请到电脑选` : "", `${limit}内未答将${after}`].filter(Boolean).join(" · ");
        const card = {
            card_type: "vote_interaction",
            title: clip(`❓ ${title}`, 26),
            desc: clip(hint, 30),
            options: options.map(([text, answer]) => ({ id: registerPick({ act: "ui", reqId, answer, label: text }), text: clip(text, 60) })),
            mode: 0,
            submit_text: "回答",
            task_id: taskId("ui"),
        };
        void transport.send(cardBlock(card, "", () => plainText({ head: "⚠️ 卡片发送失败", body: clip(title, 80), foot: `${e.allowText ? "可直接回复文字作答，或" : "请"}到电脑上处理 · ${limit}内未答将${after}` })));
        return;
    }
    if (kind === "confirm") {
        options = [["允许", { confirmed: true }], ["拒绝", { confirmed: false }]];
    }
    else {
        const list = (Array.isArray(req.options) ? req.options : []).filter((x) => typeof x === "string");
        options = [...list.slice(0, VOTE_OPT_MAX - 1).map((v) => [v, { value: v }]), ["取消", { cancelled: true }]];
        if (list.length > VOTE_OPT_MAX - 1)
            e.more = list.length - (VOTE_OPT_MAX - 1);
    }
    const more = e.more ? ` · 另有 ${e.more} 项请到电脑选择` : "";
    sendText(plainText({ head: `🔐 ${kind === "confirm" ? "需要确认" : "需要选择"} · ${who}`, body: detail, foot: `在下方卡片选择${more} · ${limit}内未选将${after}` }));
    const card = {
        card_type: "vote_interaction",
        title: clip(`🔐 ${title}`, 26),
        desc: clip(`${limit}内未选将${after}`, 30),
        options: options.map(([text, answer]) => ({ id: registerPick({ act: "ui", reqId, answer, label: text }), text: clip(text, 60) })),
        mode: 0,
        submit_text: kind === "confirm" ? "确认" : "选择",
        task_id: taskId("ui"),
    };
    void transport.send(cardBlock(card, "", () => plainText({ head: "⚠️ 卡片发送失败", body: clip(title, 80), foot: `请到电脑上处理 · ${limit}内未选将${after}` })));
}
function closeUiPrompt(e) {
    if (e.done)
        return false;
    e.done = true;
    clearTimeout(e.timer);
    uiPending.delete(e.reqId);
    return true;
}
function settleUiPrompt(e, answer) {
    if (!closeUiPrompt(e))
        return false;
    try {
        e.reply(answer);
    }
    catch (err) {
        log(`ui reply 失败：${err?.message || err}`);
    }
    return true;
}
function dropUiPrompts(t, answer = null) {
    for (const e of [...uiPending.values()])
        if (e.t === t)
            answer ? settleUiPrompt(e, answer) : closeUiPrompt(e);
}
/** 手机回文字：交给当前会话最早一个允许文字作答的提问；没有则返回 null 照常投递。 */
function takeTextAnswer(text) {
    const t = currentTarget();
    const open = [...uiPending.values()].filter((x) => x.kind === "question" && x.allowText);
    // 点过「自己写」的优先（最近一次），否则只回答当前会话的提问。
    const e = open.filter((x) => x.awaitText).sort((a, b) => b.awaitText - a.awaitText)[0] || open.find((x) => t && x.t === t);
    if (!e || !text.trim())
        return null;
    settleUiPrompt(e, { custom: true, value: text.trim() });
    log(`ui answered by phone text target=${e.t.key}`);
    return plainText({ head: `✅ 已回答 · ${e.t.label()}`, body: uiFence(`${e.title}\n→ ${text.trim()}`), foot: "任务继续运行，完成后推送" });
}
function handleUiPick(pick) {
    const e = uiPending.get(pick.reqId);
    if (!e)
        return "这个请求已经处理过（已超时、已在电脑上回答或会话已结束）。";
    if (pick.answer.write) {
        e.awaitText = Date.now();
        // 点了「自己写」：重新计时，留出打字时间（扩展自带超时的由 Pi 决定，不延长）。
        if (!(e.limitMs > 0)) {
            clearTimeout(e.timer);
            e.timer = setTimeout(e.expire, e.wait);
            e.timer.unref?.();
        }
        return plainText({ head: `✏️ 请直接回复文字 · ${e.t.label()}`, body: uiFence(e.title), foot: "下一条非命令消息将作为答案" });
    }
    settleUiPrompt(e, pick.answer);
    log(`ui answered by phone target=${e.t.key} ${JSON.stringify(pick.label)}`);
    const refused = pick.answer.confirmed === false || pick.answer.cancelled;
    return plainText({ head: `${refused ? "🚫" : "✅"} 已${pick.answer.value !== undefined ? "选择" : pick.label} · ${e.t.label()}`, body: uiFence(pick.answer.value !== undefined ? `${e.title}\n→ ${pick.label}` : e.title), foot: "任务继续运行，完成后推送" });
}
const NO_BIND = () => plainText({ head: "⚠️ 未选会话", body: "还没有选定要操作的会话。", foot: "发送 `活跃会话` 选择，或 `创建会话` 新建" });
/** footer 同款信息：目录(分支)、模型·思考强度、上下文、累计花费、其他扩展的状态项。 */
async function footerInfo(t) {
    const s = t.footer ? await t.footer() : null;
    if (t.kind === "tui" && s) {
        t.thinkingLevel = typeof s.thinkingLevel === "string" ? s.thinkingLevel : "";
        if (typeof s.usage?.cost === "number")
            t.cost = s.usage.cost;
        if (Array.isArray(s.statuses))
            t.statuses = new Map(s.statuses.slice(0, 8).map((v, i) => [String(i), stripCtrl(String(v)).slice(0, 80)]));
        if (s.model)
            t.model = String(s.model);
        if (Object.hasOwn(s, "ctxPercent"))
            t.ctxPercent = typeof s.ctxPercent === "number" && Number.isFinite(s.ctxPercent) && s.ctxPercent >= 0 ? s.ctxPercent : null;
        if (s.contextWindow > 0)
            t.contextWindow = s.contextWindow;
    }
    const stats = t.kind === "rpc" ? s : null;
    const branch = gitBranch(t.cwd);
    const lines = [
        `目录：${tilde(t.cwd)}${branch ? ` (${branch})` : ""}`,
        `模型：${t.model || "未知"}${t.thinkingLevel ? ` · ${t.thinkingLevel}` : ""}`,
        `上下文：${contextLabel(t, stats)}${t.cost > 0 ? ` · 花费 $${t.cost.toFixed(3)}` : ""}`,
    ];
    const statuses = [...t.statuses.values()].filter(Boolean);
    if (statuses.length)
        lines.push(`附加信息：${statuses.join(" ｜ ")}`);
    return lines;
}
async function statusCard() {
    const t = currentTarget();
    if (!t)
        return NO_BIND();
    const info = (await footerInfo(t)).map((l) => `- ${l}`).join("\n");
    const kind = kindOf(t);
    const tunnel = transport.connected ? [] : ["企微：断开"];
    if (t.busy) {
        const r = t.run;
        return plainText({
            head: `⏳ 运行中 · ${t.label()}`,
            body: `已运行 ${human(Date.now() - r.startedAt)}${r.lastTool ? `，当前在跑 ${r.lastTool}` : ""}。\n\n${info}`,
            foot: [`类型：${kind}`, ...tunnel, "发送 `停止` 停止"].join(" · "),
        });
    }
    return plainText({
        head: `🧊 空闲 · ${t.label()}`,
        body: `等你发消息，上次活动 ${ago(t.lastActivity)}。\n\n${info}`,
        foot: [`类型：${kind}`, ...tunnel].join(" · "),
    });
}
// ---- 默认目录：只影响之后新建的会话（`创建会话` 不带目录时），已有会话不动 ----
const DEFAULT_DIR_FILE = path.join(DIR, ".default-dir");
function defaultDir() {
    try {
        const d = fs.readFileSync(DEFAULT_DIR_FILE, "utf8").trim();
        if (d && fs.statSync(d).isDirectory())
            return d;
    }
    catch { }
    return HOME;
}
function setDefaultDir(d) {
    if (path.resolve(d) === HOME)
        fs.rmSync(DEFAULT_DIR_FILE, { force: true });
    else
        fs.writeFileSync(DEFAULT_DIR_FILE, d + "\n", { mode: 0o600 });
}
/** 解析目录参数：别名优先，其次 ~/ 路径或绝对路径；不存在返回 null。 */
function dirArg(arg) {
    const d = path.resolve(resolveCwd(arg));
    try {
        return fs.statSync(d).isDirectory() ? d : null;
    }
    catch {
        return null;
    }
}
function applyDefaultDir(d, via = "") {
    setDefaultDir(d);
    log(`默认目录 → ${tilde(d)}${via ? ` (${via})` : ""}`);
    return stateCard({
        tag: "cwd",
        icon: "📁",
        title: "切换目录",
        desc: "之后新建会话默认在此目录，已有会话不受影响",
        emph: { title: via || path.basename(d) || "~", desc: tilde(d) },
        emphMax: EMPH_NAME_MAX,
        fallback: () => plainText({ head: "📁 已切换目录", body: tilde(d), foot: "发送 `创建会话` 在此目录新建 · 已有会话不受影响" }),
    });
}
function buildDirCard(arg) {
    const aliases = dirAliases();
    const cur = defaultDir();
    if (arg) {
        const hit = Object.hasOwn(aliases, arg.toLowerCase()) ? arg.toLowerCase() : "";
        const d = dirArg(arg);
        if (!d)
            return plainText({ head: "⚠️ 切换目录失败", body: `找不到目录：${clip(arg, 40)}`, foot: "发送 `目录` 从别名中选择" });
        return applyDefaultDir(d, hit);
    }
    const rows = [["~", HOME], ...Object.entries(aliases).map(([n, d]) => [n, path.resolve(expandPath(d))])]
        .filter(([n, d], i) => i === 0 || fs.existsSync(d))
        .slice(0, VOTE_OPT_MAX);
    if (rows.length <= 1) {
        return plainText({
            head: `📁 当前目录 · ${tilde(cur)}`,
            body: "还没有配置目录别名。",
            foot: "在电脑 Pi 执行 `/remote alias` 添加 · 或发送 `目录 ~/路径`",
        });
    }
    const options = rows.map(([n, d]) => ({
        id: registerPick({ act: "cwd", dir: d, alias: n === "~" ? "" : n }),
        text: [n, n === "~" ? "" : tilde(d), d === cur ? "← 当前" : ""].filter(Boolean).join(" · "),
    }));
    const card = {
        card_type: "vote_interaction",
        title: clip("📁 切换目录", 26),
        desc: clip(`当前 ${tilde(cur)} · 只影响新建会话`, 30),
        options,
        mode: 0,
        submit_text: "切换目录",
        task_id: taskId("cwd"),
    };
    return cardBlock(card, "**请选择目录**", () => plainText({
        head: "⚠️ 卡片发送失败 · 切换目录",
        body: rows.map(([n, d]) => `${n} · ${tilde(d)}${d === cur ? " · ← 当前" : ""}`).join("\n"),
        foot: "发送 `目录 别名` 直接切换",
    }));
}
function handleDirPick(pick) {
    let ok = false;
    try { ok = fs.statSync(pick.dir).isDirectory(); } catch { }
    if (!ok)
        return plainText({ head: "⚠️ 切换目录失败", body: `目录已不存在：${tilde(pick.dir)}`, foot: "发送 `目录` 重新选择" });
    return applyDefaultDir(pick.dir, pick.alias);
}

function splitDirAndMsg(rest) {
    const parts = rest.split(/\s+/).filter(Boolean);
    let cwd = defaultDir();
    let msg = rest;
    if (parts.length) {
        const maybe = parts[0];
        const cand = resolveCwd(maybe);
        if (dirAliases()[maybe.toLowerCase()] || fs.existsSync(cand)) {
            cwd = cand;
            msg = rest.slice(rest.indexOf(maybe) + maybe.length).trim();
        }
    }
    return { cwd, msg };
}
async function finishCreate(t, msg, media, ack, note = "") {
    bindCurrent(t);
    await buildList();
    let r = null;
    if (msg || media?.length) {
        try {
            r = await deliverAsync(t, await composeWithMedia(msg || "", media), ack);
        }
        catch (e) {
            if (!(e instanceof MediaFetchError))
                throw e;
            r = { notDelivered: true, error: e.message };
        }
        // autoName === false: this session will never be named automatically; undefined (older extension) keeps waiting.
        if (!r?.notDelivered && !t.name && t.autoName === false)
            log("创建会话 未开自动命名，跳过等待会话名");
        else if (!r?.notDelivered && (t.kind === "tui" || t.kind === "rpc") && !t.name) {
            const t0 = Date.now();
            while (!t.name && Date.now() - t0 < NAME_WAIT_MS)
                await new Promise((res) => setTimeout(res, 100));
            log(`创建会话 等会话名 ${t.name ? `命中 ${Date.now() - t0}ms` : `超时 ${NAME_WAIT_MS}ms，用首条截断`}`);
        }
    }
    const foot = [`目录：${tilde(t.cwd)}`, `类型：${kindOf(t)}`];
    if (r?.notDelivered) {
        if (r.error)
            foot.push(`原因：${String(r.error).slice(0, 60)}`);
        return plainText({
            head: "⚠️ 已创建 · 首条未送达",
            body: "会话已经建好，但刚才那条消息没送进去，附件已保留。请重发。",
            foot: [...foot, note].filter(Boolean).join(" · "),
        });
    }
    return buildCreatedCard(t, note);
}
// 后台会话同样由随包命名模块命名；未开命名或未选命名模型时不等会话名。
function backgroundNaming() {
    if (!CFG.tabTitleEnabled)
        return false;
    try {
        return !!JSON.parse(fs.readFileSync(path.join(CFG.agentDir, "pi-tab-title.json"), "utf8")).provider;
    }
    catch {
        return false;
    }
}
async function newBackground(cwd, msg, media, ack, note = "") {
    const rt = new RpcTarget({ cwd, name: "" });
    rt.autoName = backgroundNaming();
    targets.set(rt.key, rt);
    try {
        await rt.start();
        await rt.refreshMeta();
    }
    catch (e) {
        rt.close();
        return plainText({ head: "⚠️ 新建失败 · 后台会话", body: e.message, foot: "发送 `创建会话` 改用终端" });
    }
    return finishCreate(rt, msg, media, ack, note);
}
const NEW_TAB_WAIT_MS = 45000;
function screenLocked() {
    return new Promise((res) => execFile("ioreg", ["-n", "Root", "-d1", "-r"], { timeout: 5000 }, (e, so) => {
        if (e)
            return res(false);
        res(/"IOConsoleLocked"\s*=\s*Yes/.test(String(so)));
    }));
}
async function newTerminalTab(cwd, msg, media, ack) {
    let term;
    try {
        term = await resolveTerminal(CFG);
    }
    catch (e) {
        return plainText({ head: "⚠️ 新建失败 · 标签页", body: e.message, foot: "发送 `创建后台会话` 改用后台" });
    }
    if (!term) {
        log(`创建会话 未找到可用终端（terminal=${CFG.terminal}），已降级为后台会话 cwd=${tilde(cwd)}`);
        return newBackground(cwd, msg, media, ack, "未找到可用终端，已改用后台新建");
    }
    if (term.gui && process.platform === "darwin" && (await screenLocked())) {
        log(`创建会话 遭遇锁屏，已降级为后台会话 cwd=${tilde(cwd)}`);
        return newBackground(cwd, msg, media, ack, "屏幕已锁，已改用后台新建");
    }
    const nonce = `tab${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const known = new Set([...targets.values()].filter((t) => t.kind === "tui").map((t) => t.key));
    let tabId;
    try {
        tabId = await term.open({ cwd, nonce, piBin: [process.execPath, path.join(CODE_DIR, "..", "bin", "launch-pi.mjs"), RUN_DIR].map(shellQuote).join(" "), tmuxSession: CFG.tmuxSession, kittySocket: CFG.kittySocket });
    }
    catch (e) {
        return plainText({
            head: `⚠️ 新建失败 · ${term.label}`,
            body: e.message,
            foot: `${term.hint} · 发送 \`创建后台会话\` 改用后台`,
        });
    }
    log(`${term.name} tab opened cwd=${tilde(cwd)} nonce=${nonce} tab=${tabId}`);
    const deadline = Date.now() + NEW_TAB_WAIT_MS;
    let t = null;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        const cands = [...targets.values()].filter((x) => x.kind === "tui" && x.alive);
        const exact = cands.find((x) => x.origin === nonce);
        if (exact) {
            t = exact;
            break;
        }
        const fresh = cands.filter((x) => !known.has(x.key));
        if (fresh.length) {
            log(`创建会话 等待 nonce 精确匹配：已出现 ${fresh.length} 个新 tui，均未回报本次 nonce`);
        }
    }
    if (!t) {
        return plainText({
            head: "⚠️ 标签页未就绪",
            body: `标签页已经打开，但 ${Math.round(NEW_TAB_WAIT_MS / 1000)} 秒内没等到 pi 注册上来。`,
            foot: `目录：${tilde(cwd)} · 稍后发送 \`活跃会话\` 查看 · 发送 \`创建后台会话\` 改用后台`,
        });
    }
    return finishCreate(t, msg, media, ack);
}
async function applyPick(pick, rows) {
    let row = rows.find((x) => x.key === pick.targetKey);
    if (!row && pick.sessionFile)
        row = rows.find((x) => x.sessionFile === pick.sessionFile);
    const fail = () => plainText({
        head: "⚠️ 切换失败",
        body: pick.name || "会话",
        foot: "会话已关闭或不在列表里 · 发送 `活跃会话` 重新选择",
    });
    if (!row)
        return fail();
    const t = await resolveNumber(rows.indexOf(row) + 1);
    if (!t)
        return fail();
    if (t.failed)
        return t.failed;
    bindCurrent(t);
    return buildSelectedCard(t);
}
async function buildSelectedCard(t) {
    if (t.kind === "rpc") {
        await t.refreshMeta();
        await t.stats();
    }
    const name = t.name || t.hint || "新会话";
    const context = contextLabel(t, null);
    const facts = [
        { keyname: "目录", value: tilde(t.cwd) },
        { keyname: "类型", value: kindOf(t) },
        { keyname: "模型", value: t.model || "未知" },
        { keyname: "上下文", value: context },
    ];
    return stateCard({
        tag: "selected",
        icon: "📥",
        title: "选择会话",
        desc: t.busy ? "进行中，完成后推送结果" : "已选择，可开始对话",
        emph: { title: name },
        emphMax: EMPH_NAME_MAX,
        facts,
        fallback: () => plainText({head: "📥 选择会话", body: name,
            foot: facts.map(f => `${f.keyname}：${f.value}`).join(" · ")}),
    });
}

function buildCreatedCard(t, note = "") {
    const name = t.name || t.hint || "新会话";
    const text = () => plainText({
        head: "✏️ 创建会话",
        body: name,
        foot: [`目录：${tilde(t.cwd)}`, `类型：${kindOf(t)}`, `模型：${t.model || "未知"}`, note].filter(Boolean).join(" · "),
    });
    return stateCard({
        tag: "created",
        lead: `**✏️ 已创建 ${clip(name, 20)}**`,
        icon: "✏️",
        title: "创建会话",
        desc: t.busy ? "任务已开始，完成后推送结果" : "已创建，可开始对话",
        body: note,
        emph: { title: name },
        emphMax: EMPH_NAME_MAX,
        facts: [
            { keyname: "目录", value: tilde(t.cwd) },
            { keyname: "类型", value: kindOf(t) },
            { keyname: "模型", value: t.model || "未知" },
        ],
        fallback: text,
    });
}
const PICK_AGAIN = { model: ["模型", "切换模型"], cwd: ["目录", "切换目录"], think: ["思考强度", "切换思考强度"] };
async function handleCardCallback({ taskId, optionId }) {
    const pick = cardPicks.get(optionId);
    if (pick?.act === "ui" && pick.taskId === taskId) {
        if (consumeTask(taskId))
            return "这张卡片已经提交过。";
        return handleUiPick(pick);
    }
    const again = PICK_AGAIN[pick?.act];
    if (!pick || pick.taskId !== taskId || Date.now() - pick.at > CARD_TTL_MS) {
        return again ? `这张${again[0]}卡片已失效，请发送 \`${again[1]}\` 重新选择。` : "这张会话卡片已失效，请发送 `活跃会话` 或 `历史会话` 重新选择。";
    }
    if (consumeTask(taskId))
        return again ? `这张卡片已经提交过，请发送 \`${again[1]}\` 获取新卡片。` : "这张卡片已经提交过，请发送 `活跃会话` 或 `历史会话` 获取新卡片。";
    if (pick.act === "model")
        return handleModelPick(pick);
    if (pick.act === "think")
        return handleThinkPick(pick);
    if (pick.act === "cwd")
        return handleDirPick(pick);
    const rows = await buildList({ find: pick.find || "" });
    return applyPick(pick, rows);
}
async function handleCommand(text, media = [], ack = { media: false }) {
    const raw = text.trim();
    const parsed = parseCmd(raw);
    if (!parsed && !media.length) {
        const answered = takeTextAnswer(raw);
        if (answered)
            return answered;
    }
    if (!parsed) {
        const t = currentTarget();
        if (!t) {
            const rows = await buildList();
            const live = liveRows(rows);
            if (!live.length) {
                return plainText({
                    head: "⚠️ 消息未投递",
                    body: "还没有会话可以接收这条消息。先新建或找回一个，再重发。",
                    foot: "发送 `创建会话` 新建，或 `历史会话` 找回会话",
                });
            }
            if (media.length) {
                log(`未绑定会话，${media.length} 个附件随正文一同未投递（已回报 mediaAccepted=false）`);
            }
            const options = live.slice(0, VOTE_OPT_MAX).map((x) => selOpt(x));
            const card = {
                card_type: "vote_interaction",
                title: clip("⚠️ 发给哪个会话？", 26),
                desc: "消息未投递 · 请先选择会话，再重发",
                options,
                mode: 0,
                submit_text: "绑定会话",
                task_id: taskId("bind"),
            };
            log(`未绑定会话，退回选择卡（活跃 ${live.length} 个），原文未投递`);
            return cardBlock(card, "**消息未投递，请先选择会话**", () => renderList(live, rows, "消息未投递"));
        }
        return deliverWithMedia(t, raw, media, ack);
    }
    const { cmd, rest } = parsed;
    if (parsed.alias || parsed.bare)
        log(`${parsed.alias ? `中文说法 ${parsed.alias}` : `免前缀 ${cmd}`} → ${cmd}${rest ? ` ${JSON.stringify(rest.slice(0, 60))}` : ""}`);
    if (media.length && ["ls", "h", "status", "help", "stop", "model", "cd", "think", "compact"].includes(cmd)) {
        log(`命令 ${cmd} 不投递内容，${media.length} 个附件未受理（mediaAccepted=false）`);
    }
    if (cmd === "help")
        return helpText();
    if (cmd === "ls")
        return buildLsCard(await buildList());
    if (cmd === "h")
        return buildHistCard(await buildList({ find: rest }));
    if (/^\d+$/.test(cmd)) {
        const n = parseInt(cmd, 10);
        const t = await resolveNumber(n);
        if (t?.failed)
            return t.failed;
        if (!t) {
            return plainText({
                head: "⚠️ 找不到会话",
                body: `没有第 ${n} 个。序号会随列表刷新变化，以最新列表为准。`,
                foot: "发送 `活跃会话` 或 `历史会话` 重新查看",
            });
        }
        bindCurrent(t);
        if (!rest) {
            if (media.length)
                log(`选择会话 ${n} 仅切换会话、不投递内容，${media.length} 个附件未受理`);
            return buildSelectedCard(t);
        }
        return deliverWithMedia(t, rest, media, ack);
    }
    if (cmd === "n" || cmd === "nb") {
        const { cwd, msg } = splitDirAndMsg(rest);
        return cmd === "nb" ? newBackground(cwd, msg, media, ack) : newTerminalTab(cwd, msg, media, ack);
    }
    if (cmd === "stop") {
        const t = currentTarget();
        if (!t)
            return NO_BIND();
        if (!t.busy)
            return plainText({ head: "🧊 无需中断", body: t.label(), foot: "当前空闲，没有在跑的任务" });
        if (t.kind === "tui") {
            if (!t.run?.id)
                return "当前轮次尚未注册，请稍后重试中断。";
            t.inbox.push({ type: "abort", runId: t.run.id });
            t.waiter?.();
            return plainText({ head: "⏳ 已请求中断", body: t.label(), foot: "等待终端确认 · 发送 `状态` 查看" });
        }
        const run = t.run;
        if (run)
            run.stopped = run.stopByCmd = true;
        const ok = await t.abort();
        if (!ok) {
            if (run)
                run.stopped = run.stopByCmd = false;
            return plainText({ head: "⚠️ 中断失败", body: t.label(), foot: "发送 `状态` 查看" });
        }
        return plainText({
            head: "⚠️ 已中断",
            body: t.label(),
            foot: `已运行 ${run ? runFor(run) : "-"}${run?.lastText ? " · 已产出的部分稍后推送" : ""}`,
        });
    }
    if (cmd === "status")
        return statusCard();
    if (cmd === "model") {
        const t = currentTarget();
        if (!t)
            return NO_BIND();
        return buildModelCard(t, rest);
    }
    if (cmd === "think") {
        const t = currentTarget();
        if (!t)
            return NO_BIND();
        return buildThinkCard(t, rest);
    }
    if (cmd === "compact") {
        const t = currentTarget();
        if (!t)
            return NO_BIND();
        return compactCard(t, rest);
    }
    if (cmd === "cd")
        return buildDirCard(rest);
    return plainText({ head: "⚠️ 未实现的命令", body: cmd, foot: "发送 `帮助` 查看命令" });
}
const RUN_STUCK_MS = SILENCE_STEPS_MS[SILENCE_STEPS_MS.length - 1] + 30 * 60000;
setInterval(() => {
    const now = Date.now();
    for (const t of [...targets.values()]) {
        const runs = [...(t.loops?.values?.() || [])];
        if (t.run && !runs.includes(t.run))
            runs.push(t.run);
        for (const r of runs) {
            if (r.settled)
                continue;
            if (now - Math.max(r.lastOutputAt, r.startedAt) < RUN_STUCK_MS)
                continue;
            r.aborted = "会话失联";
            r.settle();
            t.noteSettled?.(r);
            log(`reap stuck run target=${t.key} id=${r.id} idle=${human(now - r.lastOutputAt)}`);
        }
        if (t.loops && t.loops.size > 8) {
            for (const [k, r] of t.loops) {
                if (r.settled && t.loops.size > 8)
                    t.loops.delete(k);
            }
        }
    }
}, 5 * 60000).unref?.();
setInterval(() => {
    const now = Date.now();
    for (const t of [...targets.values()]) {
        if (t.kind !== "rpc" || t.busy || t.key === currentKey)
            continue;
        if (now - t.lastActivity < RPC_IDLE_REAP_MS)
            continue;
        log(`reap idle rpc ${t.key} name=${JSON.stringify(t.label())} idle=${human(now - t.lastActivity)}`);
        t.close();
    }
}, 10 * 60000).unref?.();
function readBody(req) {
    return new Promise((res, rej) => {
        const c = [];
        let n = 0;
        req.on("data", (d) => {
            n += d.length;
            if (n > 8 << 20)
                return rej(new Error("body too large"));
            c.push(d);
        });
        req.on("end", () => res(Buffer.concat(c).toString("utf8")));
        req.on("error", rej);
    });
}
function json(res, code, obj) {
    const b = Buffer.from(JSON.stringify(obj), "utf8");
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": b.length });
    res.end(b);
}
const server = http.createServer((req, res) => {
    void handleHttp(req, res).catch(() => {
        if (!res.headersSent)
            json(res, 400, { error: "invalid request" });
        else
            res.destroy();
    });
});
async function handleHttp(req, res) {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;
    if (req.headers["x-pi-token"] !== TOKEN)
        return json(res, 403, { error: "forbidden" });
    if (p === "/health" && req.method === "GET") {
        return json(res, 200, {
            ok: true, service: "pi-remote-wecom", version: VERSION, pid: process.pid,
            ...transport.status(),
            targets: [...targets.values()].filter(t => t.kind === "tui" ? t.alive : !t.closed).map(t => ({ key: t.key, kind: t.kind, name: t.name, cwd: t.cwd, busy: t.busy })),
            current: currentKey,
        });
    }
    if (p === "/register" && req.method === "POST") {
        let o;
        try {
            o = JSON.parse(await readBody(req));
        }
        catch {
            return json(res, 400, { error: "bad json" });
        }
        if (o.mode && o.mode !== "tui") {
            return json(res, 400, { error: `only tui sessions may register (got ${o.mode})` });
        }
        if (o.pid && [...targets.values()].some((x) => x.kind === "rpc" && x.proc?.pid === o.pid)) {
            return json(res, 400, { error: "refusing self-registration from a daemon-spawned rpc child" });
        }
        let t = [...targets.values()].find((x) => x.kind === "tui" && x.sessionId === o.sessionId);
        if (!t) {
            t = new TuiTarget({
                cwd: o.cwd,
                name: o.sessionName,
                sessionFile: o.sessionFile,
                sessionId: o.sessionId,
                origin: o.origin,
            });
            if (typeof o.autoName === "boolean")
                t.autoName = o.autoName;
            targets.set(t.key, t);
            log(`register TUI ${t.key} cwd=${tilde(t.cwd)} name=${JSON.stringify(o.sessionName || "")} id=${String(o.sessionId).slice(0, 8)} origin=${o.origin || "-"}`);
        }
        else {
            t.closed = false;
            t.cwd = o.cwd || t.cwd;
            t.name = o.sessionName || t.name;
            if (typeof o.autoName === "boolean")
                t.autoName = o.autoName;
            t.sessionFile = o.sessionFile || t.sessionFile;
            t.origin ||= o.origin || "";
        }
        if (o.model)
            t.model = String(o.model);
        if (o.modelProvider)
            t.modelProvider = String(o.modelProvider);
        if (Array.isArray(o.models))
            t.models = o.models.slice(0, MODEL_LIST_MAX).map(modelInfo).filter(Boolean);
        if (Array.isArray(o.allModels))
            t.allModels = o.allModels.slice(0, MODEL_ALL_MAX).map(modelInfo).filter(Boolean);
        if (typeof o.modelScoped === "boolean")
            t.modelScoped = o.modelScoped;
        if (Object.hasOwn(o, "ctxPercent"))
            t.ctxPercent = typeof o.ctxPercent === "number" && Number.isFinite(o.ctxPercent) && o.ctxPercent >= 0 ? o.ctxPercent : null;
        if (o.contextWindow > 0)
            t.contextWindow = o.contextWindow;
        t.pid = o.pid || t.pid;
        t.lastPoll = Date.now();
        t.lastActivity = Date.now();
        if (currentSessionId && t.sessionId === currentSessionId)
            currentKey = t.key;
        await buildList();
        return json(res, 200, { ok: true, key: t.key, tunnel: transport.connected });
    }
    if (p === "/poll" && req.method === "GET") {
        const t = targets.get(url.searchParams.get("key"));
        if (!t || t.kind !== "tui")
            return json(res, 410, { error: "unknown target" });
        t.closed = false;
        t.lastPoll = Date.now();
        const flush = () => {
            if (res.writableEnded)
                return;
            json(res, 200, { messages: t.takeInbox(), tunnel: transport.connected });
        };
        if (t.inbox.length)
            return flush();
        const timer = setTimeout(flush, POLL_HOLD_MS);
        const waiter = () => { clearTimeout(timer); flush(); };
        t.waiter = waiter;
        res.on("close", () => {
            clearTimeout(timer);
            if (t.waiter === waiter)
                t.waiter = null;
        });
        return;
    }
    if (p === "/turn" && req.method === "POST") {
        let o;
        try {
            o = JSON.parse(await readBody(req));
        }
        catch {
            return json(res, 400, { error: "bad json" });
        }
        const t = targets.get(o.key);
        if (!t || t.kind !== "tui")
            return json(res, 410, { error: "unknown target" });
        t.lastActivity = Date.now();
        const bound = currentSessionId && t.sessionId === currentSessionId;
        if (!o.runId) {
            if (!bound)
                return json(res, 200, { ok: true, tracked: false, reason: "not bound" });
            const tracked = trackLocalTurn(t, String(o.prompt || ""));
            return json(res, 200, { ok: true, tracked, legacy: true });
        }
        const known = !!t.runById(o.runId);
        const run = t.openLoop(o.runId, { local: o.local !== false });
        if (!run)
            return json(res, 200, { ok: true, tracked: false, reason: "bad runId" });
        if (!t.name)
            t.hint = promptHint(String(o.prompt || ""));
        if (!known) {
            if (bound)
                watchAsync(t, run);
            log(`loop open target=${t.key} id=${o.runId} ${o.local !== false ? "local" : "phone"}${bound ? "" : " unbound"} ${JSON.stringify(String(o.prompt || "").slice(0, 60))}`);
        }
        return json(res, 200, { ok: true, tracked: !!bound });
    }
    if (p === "/activity" && req.method === "POST") {
        let o = {};
        try {
            o = JSON.parse(await readBody(req));
        }
        catch { }
        const t = targets.get(o.key);
        if (!t)
            return json(res, 410, { error: "unknown target" });
        t.lastActivity = Date.now();
        if (!o.runId)
            return json(res, 200, { ok: true, ignored: "no runId" });
        const run = t.runById?.(o.runId);
        if (!run || run.settled)
            return json(res, 200, { ok: true, stale: true });
        run.lastOutputAt = Date.now();
        return json(res, 200, { ok: true });
    }
    if (p === "/abort-ack" && req.method === "POST") {
        const o = JSON.parse(await readBody(req));
        const t = targets.get(o.key);
        const run = t?.runById?.(o.runId);
        if (run && !run.settled && o.accepted)
            run.stopped = true;
        return json(res, 200, { ok: true });
    }
    if (p === "/meta-ack" && req.method === "POST") {
        let o = {};
        try {
            o = JSON.parse(await readBody(req));
        }
        catch { }
        const t = targets.get(o.key);
        const w = metaAcks.get(o.reqId);
        if (t && w && w.key === t.key) {
            metaAcks.delete(o.reqId);
            w.resolve(o);
        }
        return json(res, 200, { ok: true });
    }
    if (p === "/model-ack" && req.method === "POST") {
        let o = {};
        try {
            o = JSON.parse(await readBody(req));
        }
        catch { }
        const t = targets.get(o.key);
        const w = modelAcks.get(o.reqId);
        if (!t || !w || w.key !== t.key)
            return json(res, 200, { ok: true, stale: true });
        modelAcks.delete(o.reqId);
        if (o.ok) {
            if (o.model)
                t.model = String(o.model);
            if (o.modelProvider)
                t.modelProvider = String(o.modelProvider);
            if (o.contextWindow > 0)
                t.contextWindow = o.contextWindow;
        }
        w.resolve({ ok: !!o.ok, error: o.error ? String(o.error).slice(0, 120) : "" });
        return json(res, 200, { ok: true });
    }
    // 终端会话：扩展在手机发起的轮次里弹窗，终端照常显示，同时转到手机；先回答的一方生效。
    if (p === "/ui-request" && req.method === "POST") {
        let o = {};
        try {
            o = JSON.parse(await readBody(req));
        }
        catch { }
        const t = targets.get(o.key);
        if (!t || t.kind !== "tui" || !t.alive)
            return json(res, 410, { error: "unknown target" });
        if (!UI_KINDS.has(o.kind) || typeof o.reqId !== "string" || !o.reqId || o.reqId.length > 80)
            return json(res, 400, { error: "bad ui request" });
        t.lastActivity = Date.now();
        openUiPrompt(t, o, (answer) => {
            t.inbox.push({ type: "ui_answer", reqId: o.reqId, ...answer });
            t.waiter?.();
        });
        return json(res, 200, { ok: true });
    }
    if (p === "/ui-done" && req.method === "POST") {
        let o = {};
        try {
            o = JSON.parse(await readBody(req));
        }
        catch { }
        const e = uiPending.get(o.reqId);
        if (e && e.t.key === o.key && closeUiPrompt(e))
            log(`ui answered on computer target=${e.t.key}`);
        return json(res, 200, { ok: true });
    }
    if (p === "/deliver-failed" && req.method === "POST") {
        let o = {};
        try {
            o = JSON.parse(await readBody(req));
        }
        catch { }
        const t = targets.get(o.key);
        if (t) {
            t.lastActivity = Date.now();
            log(`deliver FAILED target=${t.key} ${String(o.error || "").slice(0, 160)}`);
        }
        return json(res, 200, { ok: true });
    }
    if (p === "/result" && req.method === "POST") {
        let o;
        try {
            o = JSON.parse(await readBody(req));
        }
        catch {
            return json(res, 400, { error: "bad json" });
        }
        const t = targets.get(o.key);
        if (!t || t.kind !== "tui")
            return json(res, 410, { error: "unknown target" });
        t.lastActivity = Date.now();
        if (o.sessionName)
            t.name = o.sessionName;
        if (o.model)
            t.model = String(o.model);
        if (o.modelProvider)
            t.modelProvider = String(o.modelProvider);
        if (Object.hasOwn(o, "ctxPercent"))
            t.ctxPercent = typeof o.ctxPercent === "number" && Number.isFinite(o.ctxPercent) && o.ctxPercent >= 0 ? o.ctxPercent : null;
        if (o.contextWindow > 0)
            t.contextWindow = o.contextWindow;
        let run = null;
        if (o.runId) {
            run = t.runById(o.runId);
            if (!run || run.settled)
                return json(res, 200, { ok: true, stale: true });
        }
        else {
            run = t.run;
            if (!run || run.settled)
                return json(res, 200, { ok: true, stale: true });
        }
        if (o.stopped)
            run.stopped = true;
        if (o.error)
            run.error = String(o.error);
        if (o.text) {
            run.assistantTexts.push(String(o.text));
            run.lastOutputAt = Date.now();
        }
        if (typeof o.toolCalls === "number")
            run.toolCalls = o.toolCalls;
        if (o.error)
            run.error = String(o.error);
        run.settle();
        t.noteSettled(run);
        return json(res, 200, { ok: true });
    }
    if (p === "/unregister" && req.method === "POST") {
        let o = {};
        try {
            o = JSON.parse(await readBody(req));
        }
        catch { }
        const t = targets.get(o.key);
        if (t) {
            log(`unregister TUI ${t.key}`);
            t.close();
            if (currentKey === t.key)
                currentKey = null;
        }
        return json(res, 200, { ok: true });
    }
    if (p === "/command" && req.method === "POST") {
        try {
            const body = JSON.parse(await readBody(req));
            const ack = { media: false };
            const reply = await handleCommand(String(body.text || ""), [], ack);
            return json(res, 200, { ok: true, reply });
        }
        catch {
            return json(res, 400, { error: "command failed" });
        }
    }
    return json(res, 404, { error: "not found" });
}
transport = new WeComTransport({ config: CFG, dir: DIR, log,
    onMessage: handleCommand, onCard: handleCardCallback, onBind: saveOwner });
server.on("error", error => { log(`监听失败 ${error.code}`); transport.stop(); process.exit(1); });
server.listen(PORT, HOST, () => {
    transport.start();
    loadCurrent();
    log(`daemon up ${HOST}:${PORT} pid=${process.pid}` +
        (currentSessionId ? ` current=${currentSessionId.slice(0, 8)}` : ""));
});
const SHUTDOWN_GRACE_MS = 8000;
for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
        if (shuttingDown)
            return;
        log(`daemon down (${sig})`);
        shuttingDown = true;
        transport.drain(); // 停机即拒收新入站，避免换主人时旧进程在宽限期内仍受理
        const pending = [];
        for (const t of [...targets.values()]) {
            try {
                for (const r of t.loops?.values?.() || [])
                    if (!r.settled)
                        pending.push(r.wait());
                if (t.run && !t.run.settled)
                    pending.push(t.run.wait());
                t.close?.();
            }
            catch { }
        }
        server.close();
        const done = Promise.allSettled(pending).then(() => Promise.allSettled([...inflightPushes]));
        let exited = false;
        const bye = (why) => {
            if (exited)
                return;
            exited = true;
            log(`daemon exit (${why})`);
            transport.stop();
            process.exit(0);
        };
        void done.then(() => bye("回执已发完"));
        setTimeout(() => bye(`${SHUTDOWN_GRACE_MS}ms 硬限`), SHUTDOWN_GRACE_MS);
    });
}
process.on("uncaughtException", (e) => log(`uncaught: ${e?.stack || e}`));
process.on("unhandledRejection", (e) => log(`unhandledRejection: ${e?.stack || e}`));
