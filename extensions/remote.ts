import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {ExtensionAPI, ExtensionCommandContext, ExtensionContext} from '@earendil-works/pi-coding-agent';
import {RUN_DIR, diskVersion, loadConfig, statusKeyAllowed} from '../daemon/config.mjs';
type Json = Record<string, any>;
type Runtime = {
  ctx: ExtensionContext; cancelled: boolean; cancel: AbortController;
  key: string | null; token: string; port: number; statusKey: string;
  runId: string | null; text: string; toolCalls: number; queued: number;
  stopped: boolean; error: string; lastBeat: number; sentTool: string; toolTimer?: ReturnType<typeof setTimeout>;
  phone: boolean; uiWaits: Map<string, (answer: Json) => void>; uiReqs: Map<string, Json>;
  asking: Asking[]; tools: Map<string, string>;
  /** 打开的是后台仍在运行的会话：等它结束后再交给终端。 */
  waiting: boolean;
};
/** 正在执行的提问工具，供 ui.custom 识别：pi 示例 question / questionnaire，以及 AskUserQuestion 类（questions[].question）。 */
type Asking = {toolCallId: string; kind: 'question' | 'questionnaire' | 'auq'; args: Json};
type QOption = {label: string; description?: string; value?: string; preview?: string};
type Question = {id: string; label: string; prompt: string; options: QOption[]; allowOther: boolean; header?: string; multi?: boolean};
type DialogKind = 'confirm' | 'select' | 'input' | 'editor';
const UI_PATCHED = Symbol.for('pi-remote-wecom.ui');
const STATUS_PATCHED = Symbol.for('pi-remote-wecom.status');
const UNKNOWN_UI_NOTICE_MS = Number(process.env.PI_REMOTE_UI_NOTICE_MS) || 30000;
const HANDOFF_RETRY_MS = Number(process.env.PI_REMOTE_HANDOFF_RETRY_MS) || 2000;
const HANDOFF_WIDGET = 'pi-remote-handoff';
/** 隐藏子命令：不在 /remote 补全和菜单里，由扩展自己触发。 */
export const RELOAD_COMMAND = 'remote reload';
/** 与 vendor/tab-title 共用：等待期间会话文件仍由后台进程写入，标签模块不补起名。 */
const HANDOFF_WAITING = Symbol.for('pi-remote-wecom.handoff-waiting');
function setWaiting(r: {waiting: boolean; ctx: ExtensionContext}, on: boolean) {
  r.waiting = on;
  (globalThis as any)[HANDOFF_WAITING] = on;
  r.ctx.ui.setWidget?.(HANDOFF_WIDGET, on ? [HANDOFF_TEXT.waiting] : undefined, {placement: 'aboveEditor'});
}
export const HANDOFF_TEXT = {
  waiting: '手机端任务运行中，完成后自动刷新 · 现在查看：/remote reload',
  blocked: '手机端任务未结束，消息暂未发出',
  done: '手机端任务已完成，会话已更新至最新状态',
  failed: '自动刷新失败，会话可能过时，请输入 /resume 重新打开',
};
/** 会话文件末尾有本进程没载入的条目：启动读文件之后、注册之前，后台进程又写了内容。 */
function diskAhead(ctx: ExtensionContext) {
  const file = ctx.sessionManager.getSessionFile();
  if (!file) return false;
  try {
    const last = fs.readFileSync(file, 'utf8').trimEnd().split('\n').at(-1);
    const id = last ? JSON.parse(last)?.id : undefined;
    return !!id && id !== (ctx.sessionManager.getEntries() as any[]).at(-1)?.id;
  } catch {return false;}
}
const isOptions = (x: unknown): x is QOption[] => Array.isArray(x) && x.every(o => o && typeof o.label === 'string');
/** 按参数形状识别提问工具，不绑定工具名：question {question, options} / questionnaire {questions[]}。 */
function askingKind(args: any): Asking['kind'] | null {
  if (args && typeof args.question === 'string' && isOptions(args.options)) return 'question';
  const qs = args && Array.isArray(args.questions) && args.questions.length ? args.questions : null;
  if (qs?.every((q: any) => q && typeof q.prompt === 'string' && isOptions(q.options))) return 'questionnaire';
  // AskUserQuestion 类（如 @juicesharp/rpiv-ask-user-question）：{questions: [{question, header, options, multiSelect}]}
  if (qs?.every((q: any) => q && typeof q.question === 'string' && isOptions(q.options))) return 'auq';
  return null;
}
/** 与示例 questionnaire 相同的默认值归一化，保证手机答案交回后 details 与终端作答一致。 */
function normalizeQuestions(a: Asking): Question[] {
  if (a.kind === 'question') return [{id: 'q', label: 'Q1', prompt: a.args.question, options: a.args.options, allowOther: true}];
  if (a.kind === 'auq') return a.args.questions.map((q: any, i: number) => ({id: String(i), label: q.header || `Q${i + 1}`,
    prompt: q.question, options: q.options, allowOther: true, header: typeof q.header === 'string' ? q.header : '', multi: q.multiSelect === true}));
  return a.args.questions.map((q: any, i: number) => ({...q, label: q.label || `Q${i + 1}`, allowOther: q.allowOther !== false}));
}
/** 其他扩展 setStatus 的文本带 ANSI 颜色与 Nerd Font 图标：手机上只留可读文字。 */
export function plainStatus(text: string) {
  return String(text)
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '')
    .replace(/[\u0000-\u001f\u007f\uE000-\uF8FF]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
/** 与内置 footer 相同的累计口径：助手消息、工具上报、压缩/分支摘要。 */
function usageTotals(ctx: ExtensionContext) {
  const u = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0};
  const add = (x: any) => {
    if (!x) return;
    u.input += x.input || 0; u.output += x.output || 0;
    u.cacheRead += x.cacheRead || 0; u.cacheWrite += x.cacheWrite || 0;
    u.cost += x.cost?.total || 0;
  };
  try {
    for (const e of ctx.sessionManager.getEntries() as any[]) {
      if (e.type === 'usage') add(e.usage);
      else if (e.type === 'message' && (e.message?.role === 'assistant' || e.message?.role === 'toolResult')) add(e.message.usage);
      else if (e.type === 'branch_summary' || e.type === 'compaction') add(e.usage);
    }
  } catch {}
  return u;
}
// 与 pi-ai getSupportedThinkingLevels 同规则；不直接 import，避免旧版 Pi 缺该导出时整个扩展加载失败。
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export function thinkingLevels(model: any): string[] {
  if (!model?.reasoning) return [];
  return THINKING_LEVELS.filter(level => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    return level === 'xhigh' || level === 'max' ? mapped !== undefined : true;
  });
}
function meta(ctx: ExtensionContext) {
  const usage = ctx.getContextUsage();
  return {model: ctx.model?.id || '', modelProvider: ctx.model?.provider || '', ctxPercent: usage?.percent ?? null, contextWindow: usage?.contextWindow ?? ctx.model?.contextWindow ?? null};
}
const modelBrief = (m: any) => ({provider: m.provider, id: m.id, name: m.name || '', contextWindow: m.contextWindow || 0});
// Default card = Ctrl+P candidates (scoped models via enabledModels / --models, else all authenticated models);
// keyword search covers every authenticated model, so a scope never hides a model from the phone.
function selectableModels(ctx: ExtensionContext) {
  let all: any[] = []; let scoped: any[] = [];
  try {all = ctx.modelRegistry.getAvailable();} catch {all = [];}
  try {scoped = ctx.scopedModels?.length ? ctx.scopedModels.map(s => s.model) : [];} catch {scoped = [];}
  return {
    models: (scoped.length ? scoped : all).slice(0, 60).map(modelBrief),
    allModels: all.slice(0, 500).map(modelBrief),
    modelScoped: scoped.length > 0,
  };
}
// Footer status: Nerd Font phone glyph (U+F10B, monochrome so it can be colored; 📱 falls back to a
// color-emoji block) tinted by state, label in the pill's normal text color. Label color is restored
// with explicit RGB: 39 may not match the themed pill, 0 would also clear the pill background.
type Tone = 'gray' | 'green' | 'orange' | 'red';
const PHONE = '\uf10b';
const TONE_RGB: Record<Tone, string> = {gray: '128;128;128', green: '74;222;128', orange: '251;146;60', red: '248;113;113'};
let labelFg = '\u001b[38;2;240;240;240m';
function configureStatus(cfg: Json) {
  if (/^\d{1,3};\d{1,3};\d{1,3}$/.test(cfg.statusLabelFg || '')) labelFg = `\u001b[38;2;${cfg.statusLabelFg}m`;
}
function renderStatus(label: string, tone: Tone) {
  const icon = `\u001b[38;2;${TONE_RGB[tone]}m${PHONE}`;
  // Placeholder is gray as a whole; real states color only the icon.
  return tone === 'gray' ? `${icon} ${label}${labelFg}` : `${icon}${labelFg} ${label}`;
}
export default function remote(pi: ExtensionAPI, opts: {autoName?: () => boolean} = {}) {
  let active: Runtime | undefined;
  /** 自动刷新完成后在新会话里提示的文案；空则不提示。 */
  let reloadNotice = '';
  let updateNoticePid = 0;
  // 其他扩展写进 footer 的状态项（每人不同）：从 ui.setStatus 截获，状态卡片按需上报。
  const extStatuses = new Map<string, string>();
  function footerInfo(r: Runtime) {
    let thinkingLevel = '';
    try {thinkingLevel = r.ctx.model?.reasoning ? String(pi.getThinkingLevel()) : '';} catch {}
    let cfg: any = {statusKeys: null};
    try {cfg = loadConfig();} catch {}
    const statuses = [...extStatuses].filter(([k, v]) => k !== r.statusKey && v && statusKeyAllowed(cfg, k))
      .sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v).slice(0, 8);
    return {thinkingLevel, thinkingLevels: thinkingLevels(r.ctx.model), usage: usageTotals(r.ctx), statuses};
  }
  /**
   * 手机发起的轮次里，扩展弹窗同时转到手机：终端照常显示，谁先回答用谁的，另一边关闭。
   * Pi 没有官方的"外部回答弹窗"接口，这里替换共享的 ctx.ui 方法；替换失败或不在手机轮次时原样透传。
   */
  async function remoteDialog(kind: DialogKind, req: Json, opts: any, local: (opts: any) => Promise<any>, map: (answer: Json) => any) {
    const r = active;
    if (!r || r.cancelled || !r.key || !r.runId || !r.phone) return local(opts);
    const reqId = randomUUID();
    // lost：daemon 失联/重启导致手机侧答案不会再来，退回只等电脑。
    const answer = new Promise<Json>(resolve => r.uiWaits.set(reqId, resolve));
    const body = {reqId, kind, ...req, limitMs: opts?.timeout};
    const sent = await call(r, '/ui-request', {key: r.key, ...body});
    if (!sent?.ok) {r.uiWaits.delete(reqId); return local(opts);}
    r.uiReqs.set(reqId, body); // 重新注册后重发：daemon 重启时手机上重新出卡片
    // editor 不支持中途关闭：手机轮次里交给 daemon（立即取消并提示）；手机侧失联才打开终端编辑器。
    if (kind === 'editor') {
      const a = await answer;
      return a.lost ? local(opts) : map(a);
    }
    const closeLocal = new AbortController();
    const signal = opts?.signal ? AbortSignal.any([opts.signal, closeLocal.signal]) : closeLocal.signal;
    const localAnswer = local({...opts, signal}).then(value => ({local: true, value}));
    // 兜底：daemon 重启会丢掉手机侧计时，本地按同一策略到点处理（略晚于 daemon，正常情况下不会触发）。
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<{local: false; value: Json}>(resolve => {
      let remoteConfirm = 'ask-then-allow', remoteConfirmTimeoutMs = 600000;
      try {({remoteConfirm, remoteConfirmTimeoutMs} = loadConfig());} catch {}
      if (opts?.timeout > 0 && opts.timeout < remoteConfirmTimeoutMs) return; // 扩展自带更短超时，交给 Pi
      if (sent.parked) return; // 会话未绑定：绑定后才推手机并开始计时，本地按发出时间兜底会提前代答
      fallback = setTimeout(() => resolve({local: false, value: kind === 'confirm' ? {confirmed: remoteConfirm !== 'ask'} : {cancelled: true}}), remoteConfirmTimeoutMs + 5000);
    });
    const phone = answer.then(value => ({local: false as const, value}));
    let winner = await Promise.race([localAnswer, phone, late]);
    if (!winner.local && (winner.value as Json).lost) winner = await Promise.race([localAnswer, late]);
    clearTimeout(fallback);
    r.uiWaits.delete(reqId); r.uiReqs.delete(reqId);
    if (winner.local) {void call(r, '/ui-done', {key: r.key, reqId}); return winner.value;}
    closeLocal.abort();
    return map(winner.value);
  }
  /** 发一个手机端请求；返回 null 表示没发出去（daemon 不可用），只等电脑。 */
  async function askPhone(r: Runtime, kind: string, req: Json) {
    const reqId = randomUUID();
    const answer = new Promise<Json>(resolve => r.uiWaits.set(reqId, resolve));
    const body = {reqId, kind, ...req};
    const sent = r.key ? await call(r, '/ui-request', {key: r.key, ...body}) : null;
    if (!sent?.ok) {r.uiWaits.delete(reqId); return null;}
    r.uiReqs.set(reqId, body);
    return {reqId, answer};
  }
  /**
   * 提问工具（ui.custom）转手机：终端组件照常显示；包一层 factory 拿到它的 done，
   * 手机答完后用工具自己的结果形状调用 done，工具按原逻辑生成结果。电脑先答则收回手机卡片。
   */
  function remoteCustom(ui: any, orig: Function, factory: Function, options: any) {
    // 提问工具不限手机轮次：模型主动提问时人可能已离开电脑，电脑发起的轮次也推到手机。
    const r = active; const asking = r?.asking.shift(); // 一次工具调用只接管第一个 custom
    if (!r || !asking || r.cancelled || !r.key || !r.runId) {
      const local = orig.call(ui, factory, options);
      if (r && !asking) noticeUnknown(r, local);
      return local;
    }
    let done: ((v: any) => void) | undefined;
    let closed = false;
    const wrapped = (tui: any, theme: any, kb: any, d: (v: any) => void) => {
      done = d; return factory(tui, theme, kb, (v: any) => {closed = true; d(v);});
    };
    let localDone = false;
    const local: Promise<any> = Promise.resolve(orig.call(ui, wrapped, options)).finally(() => {localDone = true;});
    // 组件挂载时立即自行关闭（如 AUQ 发现已有浮层，让出后改用浮层重新挂载）：这次不算提问，留给下一次 custom。
    if (closed) {r.asking.unshift(asking); return local;}
    const LOCAL = Symbol('local');
    const localWin = local.then(() => LOCAL, () => LOCAL);
    void (async () => {
      const questions = normalizeQuestions(asking);
      const answers: Json[] = [];
      let cancelled = false;
      for (let i = 0; i < questions.length && !localDone; i++) {
        const q = questions[i];
        const step = questions.length > 1 ? `（${i + 1}/${questions.length}）` : '';
        const tag = q.header ? `[${q.header}] ` : '';
        const req = await askPhone(r, 'question', {title: `${step}${tag}${q.prompt}`, options: q.options.map(o => o.label),
          descriptions: q.options.map(o => [o.description || '', o.preview ? '含预览，详见电脑' : ''].filter(Boolean).join(' · ')),
          allowText: q.allowOther, multi: !!q.multi, ...(q.header ? {header: q.header} : {})});
        if (!req) return;
        const a = await Promise.race([req.answer, localWin]);
        r.uiWaits.delete(req.reqId); r.uiReqs.delete(req.reqId);
        if (a === LOCAL) {void call(r, '/ui-done', {key: r.key, reqId: req.reqId}); return;}
        const v = a as Json;
        if (v.lost) return;
        if (v.cancelled) {cancelled = true; break;}
        const text = typeof v.value === 'string' ? v.value.trim() : '';
        if (q.multi && !v.custom && Array.isArray(v.indexes)) {
          const picked = [...new Set(v.indexes.map(Number))].filter(n => n >= 1 && n <= q.options.length).sort((x, y) => x - y);
          if (!picked.length) {cancelled = true; break;}
          answers.push({q, i, multi: picked.map(n => q.options[n - 1].label)});
          continue;
        }
        const idx = Number(v.index);
        const opt = !v.custom && idx >= 1 ? q.options[idx - 1] : undefined;
        if (opt) answers.push({q, i, opt, index: idx});
        else if (q.allowOther && text) answers.push({q, i, text});
        else {cancelled = true; break;}
      }
      if (localDone || !done) return;
      if (asking.kind === 'auq') {
        // 与 rpiv-ask-user-question 的 QuestionnaireResult 同形，工具按原逻辑生成给模型的回答。
        done({cancelled, answers: answers.map(({q, i, opt, text, multi}) => multi
          ? {questionIndex: i, question: q.prompt, kind: 'multi', answer: null, selected: multi}
          : opt ? {questionIndex: i, question: q.prompt, kind: 'option', answer: opt.label, ...(opt.preview ? {preview: opt.preview} : {})}
          : {questionIndex: i, question: q.prompt, kind: 'custom', answer: text})});
        return;
      }
      const flat = answers.map(({q, opt, text, index}) => opt
        ? {id: q.id, value: opt.value ?? opt.label, label: opt.label, wasCustom: false, index}
        : {id: q.id, value: text, label: text, wasCustom: true});
      if (asking.kind === 'question') {
        const a = flat[0];
        done(cancelled || !a ? null : a.wasCustom ? {answer: a.label, wasCustom: true} : {answer: a.label, wasCustom: false, index: a.index});
      } else done({questions, answers: flat, cancelled});
    })().catch(() => {});
    return local;
  }
  /**
   * 认不出的阻塞界面（未适配的提问工具等）：工具执行中弹出且一段时间没关，提醒手机到电脑上处理，
   * 避免手机侧只看到「没有新动作」。只提醒一次，不代答。
   */
  function noticeUnknown(r: Runtime, local: Promise<any>) {
    if (r.cancelled || !r.key || !r.runId || !r.tools.size) return;
    const tool = [...r.tools.values()].at(-1) || '';
    let open = true;
    const timer = setTimeout(() => {
      if (open && active === r && r.key && r.runId) void call(r, '/ui-notice', {key: r.key, tool});
    }, UNKNOWN_UI_NOTICE_MS);
    void Promise.resolve(local).finally(() => {open = false; clearTimeout(timer);}).catch(() => {});
  }
  function loseUi(r: Runtime) {
    for (const resolve of r.uiWaits.values()) resolve({lost: true});
    r.uiWaits.clear(); r.uiReqs.clear();
  }
  /** 截获其他扩展写进 footer 的状态项；终端显示原样不变。与弹窗补丁分开，任一失败不影响另一个。 */
  function patchStatus(ui: any) {
    if (!ui || ui[STATUS_PATCHED] || typeof ui.setStatus !== 'function') return;
    try {
      const setStatus = ui.setStatus;
      ui.setStatus = (key: string, text: string | undefined) => {
        const clean = typeof text === 'string' ? plainStatus(text) : '';
        if (clean) extStatuses.set(String(key), clean.slice(0, 80)); else extStatuses.delete(String(key));
        return setStatus.call(ui, key, text);
      };
      Object.defineProperty(ui, STATUS_PATCHED, {value: true});
    } catch {}
  }
  function patchUi(ui: any) {
    patchStatus(ui);
    if (!ui || ui[UI_PATCHED] || typeof ui.confirm !== 'function' || typeof ui.select !== 'function') return;
    try {
      const orig = {confirm: ui.confirm, select: ui.select, input: ui.input, editor: ui.editor};
      ui.confirm = (title: string, message: string, opts?: any) => remoteDialog('confirm', {title, message}, opts,
        o => orig.confirm.call(ui, title, message, o), a => !a.cancelled && a.confirmed === true);
      ui.select = (title: string, options: string[], opts?: any) => remoteDialog('select', {title, options}, opts,
        o => orig.select.call(ui, title, options, o), a => a.cancelled ? undefined : options.includes(a.value) ? a.value : undefined);
      if (typeof orig.input === 'function') ui.input = (title: string, placeholder?: string, opts?: any) => remoteDialog('input', {title, message: placeholder || ''}, opts,
        o => orig.input.call(ui, title, placeholder, o), a => a.cancelled ? undefined : a.value);
      if (typeof ui.custom === 'function') {
        const custom = ui.custom;
        ui.custom = (factory: Function, options?: any) => remoteCustom(ui, custom, factory, options);
      }
      if (typeof orig.editor === 'function') ui.editor = (title: string, prefill?: string) => remoteDialog('editor', {title}, undefined,
        () => orig.editor.call(ui, title, prefill), a => a.cancelled ? undefined : a.value);
      Object.defineProperty(ui, UI_PATCHED, {value: true});
    } catch {/* 只读或结构变化：保持原样，终端弹窗照常可用 */}
  }
  /** 运行中的 daemon 落后于磁盘版本时提醒一次（按 daemon pid 去重）。 */
  async function noticeUpdate(r: Runtime) {
    const h = await call(r, '/health');
    const next = diskVersion();
    if (r.cancelled || !h?.version || h.version === next || h.pid === updateNoticePid) return;
    updateNoticePid = Number(h.pid);
    r.ctx.ui.notify(`Pi Remote 有新版本 v${next}，空闲时执行 /remote restart 生效`, 'warning');
  }
  async function call(r: Runtime, endpoint: string, body?: Json, timeout = 3000): Promise<Json | null> {
    try {
      const response = await fetch(`http://127.0.0.1:${r.port}${endpoint}`, {
        method: body ? 'POST' : 'GET',
        headers: {'content-type': 'application/json', 'x-pi-token': r.token},
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.any([r.cancel.signal, AbortSignal.timeout(timeout)]),
      });
      if (!response.ok) return null;
      return await response.json() as Json;
    } catch {return null;}
  }
  // Dedupe so the 40s poll does not repaint an unchanged footer.
  let painted: string | null = null;
  function status(r: Runtime, value: string, tone: Tone = 'gray') {
    if (r.cancelled) return;
    const text = renderStatus(value, tone);
    if (text === painted) return;
    painted = text;
    r.ctx.ui.setStatus(r.statusKey, text);
  }
  const paintLink = (r: Runtime, up: unknown) => up ? status(r, '已连接', 'green') : status(r, '企微未连接 · /remote', 'orange');
  const registration = (r: Runtime, origin = '') => ({
    sessionFile: r.ctx.sessionManager.getSessionFile() || '',
    sessionId: r.ctx.sessionManager.getSessionId(), sessionName: pi.getSessionName() || '',
    cwd: r.ctx.cwd, pid: process.pid, mode: 'tui', origin, ...meta(r.ctx), ...selectableModels(r.ctx),
    // Lets the daemon skip waiting for a session name that will never come.
    ...(opts.autoName ? {autoName: opts.autoName()} : {}),
  });
  async function stop() {
    const r = active; active = undefined;
    if (!r) return;
    r.cancelled = true;
    loseUi(r);
    // Cancel the long poll immediately. Use a separate finite request for unregister.
    r.cancel.abort(); r.ctx.ui.setStatus(r.statusKey, undefined); painted = null;
    if (r.waiting) setWaiting(r, false);
    if (r.key) {
      try {await fetch(`http://127.0.0.1:${r.port}/unregister`, {
        method: 'POST', headers: {'content-type': 'application/json', 'x-pi-token': r.token},
        body: JSON.stringify({key: r.key}), signal: AbortSignal.timeout(1000),
      });} catch {}
    }
  }
  pi.on('session_start', async (_event, ctx) => {
    await stop();
    // 后台会话（daemon 启动的 RPC 子进程）也会加载本包：只在终端会话里连接。
    if (ctx.mode !== 'tui') return;
    const cfg = loadConfig();
    const r: Runtime = {ctx, cancelled: false, cancel: new AbortController(), key: null,
      token: '', port: cfg.localPort, statusKey: cfg.statusKey, runId: null, text: '',
      toolCalls: 0, queued: 0, stopped: false, error: '', lastBeat: 0, sentTool: '', phone: false, uiWaits: new Map(), uiReqs: new Map(), asking: [], tools: new Map(),
      waiting: false};
    active = r;
    extStatuses.clear(); // 新会话/重载时 Pi 已清空 footer 状态
    patchUi(ctx.ui);
    configureStatus(cfg);
    // Placeholder after the session_start chain so the entry sorts last in the footer.
    setTimeout(() => {if (active === r && painted === null) status(r, '连接中', 'gray');}, 0);
    const origin = process.env.PI_REMOTE_TAB || '';
    void (async () => {
      // Let the placeholder land first so a fast daemon reply cannot insert the key earlier.
      await new Promise(resolve => setTimeout(resolve, 0));
      while (!r.cancelled) {
        try {r.token = fs.readFileSync(path.join(RUN_DIR, '.token'), 'utf8').trim();} catch {}
        if (!r.token) {
          status(r, '未配置 · /remote setup', 'red');
          await delay(r, 3000); continue;
        }
        if (!r.key) {
          const registered = await call(r, '/register', registration(r, origin));
          if (r.cancelled) break;
          if (registered?.waiting) {
            if (!r.waiting) setWaiting(r, true);
            paintLink(r, registered.tunnel);
            await delay(r, HANDOFF_RETRY_MS); continue;
          }
          if (!registered?.key) {status(r, '服务未启动 · /remote restart', 'red'); await delay(r, 3000); continue;}
          r.key = registered.key;
          void noticeUpdate(r);
          if (r.waiting || (registered.handedOff && diskAhead(ctx))) {
            // 画面是后台跑完之前的快照：重新载入会话文件。只有命令能切换会话，从这里触发内部命令。
            reloadNotice = r.waiting ? HANDOFF_TEXT.done : '';
            if (r.waiting) setWaiting(r, false);
            try {pi.sendUserMessage(`/${RELOAD_COMMAND}`, {expandPromptTemplates: true});}
            catch {ctx.ui.notify(HANDOFF_TEXT.failed, 'warning');}
          }
          // /register already reports the WeCom link; paint now instead of waiting up to POLL_HOLD_MS for /poll.
          paintLink(r, registered.tunnel);
          // If daemon restarted during a run, restore the exact run identity, not a guessed new turn.
          if (r.runId) await call(r, '/turn', {key: r.key, runId: r.runId, local: r.queued === 0});
          // daemon 对已登记的 reqId 忽略重发；重启后的新 daemon 则重新出卡片并重新计时。
          for (const body of r.uiReqs.values()) await call(r, '/ui-request', {key: r.key, ...body});
        }
        const response = await call(r, `/poll?key=${encodeURIComponent(r.key!)}`, undefined, 40000);
        if (r.cancelled) break;
        // 轮询失败只重新注册：daemon 若仍在，uiPending 与 target 都会保留，手机晚到的答案照样生效；
        // daemon 重启则由本地兜底计时处理。
        if (!response) {r.key = null; continue;}
        paintLink(r, response.tunnel);
        for (const msg of response.messages || []) {
          if (r.cancelled) break;
          if (msg.type === 'abort') {
            const idle = ctx.isIdle();
            const accepted = !!r.runId && msg.runId === r.runId && !idle;
            if (accepted) {r.stopped = true; ctx.abort();}
            const reason = accepted ? '' : idle ? 'idle' : !r.runId ? 'unregistered' : 'other-run';
            await call(r, '/abort-ack', {key: r.key, runId: msg.runId, accepted, reason, currentRunId: r.runId});
            continue;
          }
          if (msg.type === 'ui_answer') {
            const resolve = r.uiWaits.get(String(msg.reqId));
            if (resolve) {r.uiWaits.delete(String(msg.reqId)); resolve(msg);}
            continue;
          }
          if (msg.type === 'get_meta') {
            await call(r, '/meta-ack', {key: r.key, reqId: msg.reqId, ...meta(r.ctx), ...footerInfo(r)});
            continue;
          }
          if (msg.type === 'set_thinking') {
            let ok = false; let error = '';
            try {
              if (!thinkingLevels(r.ctx.model).includes(String(msg.level))) error = '当前模型不支持该思考强度';
              else {pi.setThinkingLevel(String(msg.level) as any); ok = true;}
            } catch (e) {error = String((e as Error)?.message || e).slice(0, 120);}
            const info = footerInfo(r);
            await call(r, '/meta-ack', {key: r.key, reqId: msg.reqId, ok, error, ...meta(r.ctx), ...info});
            if (ok) ctx.ui.notify(`手机已切换思考强度：${info.thinkingLevel}`, 'info');
            continue;
          }
          if (msg.type === 'compact') {
            // 压缩耗时可达数十秒，不阻塞轮询（否则期间收不到停止等消息）：后台完成后再 ack。
            const reqId = msg.reqId; const rt = r;
            const done = (extra: Json) => {void call(rt, '/meta-ack', {key: rt.key, reqId, ...extra});};
            try {
              ctx.ui.notify('手机发起压缩会话', 'info');
              ctx.compact({
                customInstructions: typeof msg.instructions === 'string' && msg.instructions ? msg.instructions : undefined,
                onComplete: (res: any) => done({ok: true, tokensBefore: res?.tokensBefore, tokensAfter: res?.estimatedTokensAfter}),
                onError: (e: Error) => done({ok: false, error: String(e?.message || e).slice(0, 120)}),
              });
            } catch (e) {done({ok: false, error: String((e as Error)?.message || e).slice(0, 120)});}
            continue;
          }
          if (msg.type === 'set_model') {
            let ok = false; let error = '';
            try {
              const model = r.ctx.modelRegistry.find(String(msg.provider), String(msg.modelId));
              if (!model) error = '电脑端找不到该模型';
              else if (!(await pi.setModel(model))) error = '该模型的提供方未配置认证';
              else ok = true;
            } catch (e) {error = String((e as Error)?.message || e).slice(0, 120);}
            await call(r, '/model-ack', {key: r.key, reqId: msg.reqId, ok, error, ...meta(r.ctx)});
            if (ok) ctx.ui.notify(`手机已切换模型：${msg.modelId}`, 'info');
            continue;
          }
          if (typeof msg.text !== 'string' || !msg.text) continue;
          r.queued++;
          if (r.runId) r.phone = true; // 本地轮次中途插入手机消息：与 daemon 一样视为手机轮次
          try {pi.sendUserMessage(msg.text, {deliverAs: 'followUp'});}
          catch {r.queued--; await call(r, '/deliver-failed', {key: r.key, error: 'Pi 拒绝投递'}); continue;}
          ctx.ui.notify('收到手机消息', 'info');
        }
      }
    })().catch(() => status(r, '连接异常 · /reload', 'red'));
  });
  function delay(r: Runtime, ms: number) {
    return new Promise<void>(resolve => {
      const finish = () => {clearTimeout(timer); r.cancel.signal.removeEventListener('abort', finish); resolve();};
      const timer = setTimeout(finish, ms);
      r.cancel.signal.addEventListener('abort', finish, {once: true});
      if (r.cancelled) finish();
    });
  }
  /** 重新载入当前会话（接上手机端后台任务时由 /remote reload 调用）。 */
  async function reload(ctx: ExtensionCommandContext) {
    const notice = reloadNotice; reloadNotice = '';
    const file = ctx.sessionManager.getSessionFile();
    try {
      if (!file) throw new Error('no session file');
      // Pi 切换完会话后发自己的 info 通知，会替换掉同步发出的提示：延后一拍。
      const res = await ctx.switchSession(file, {withSession: async fresh => {if (notice) setTimeout(() => fresh.ui.notify(notice, 'info'), 0);}});
      if (res.cancelled) ctx.ui.notify(HANDOFF_TEXT.failed, 'warning');
    } catch {
      try {ctx.ui.notify(HANDOFF_TEXT.failed, 'warning');} catch {}
    }
  }
  pi.on('input', (event, ctx) => {
    if (!active?.waiting || event.source !== 'interactive') return;
    ctx.ui.notify(HANDOFF_TEXT.blocked, 'warning');
    return {action: 'handled'};
  });
  pi.on('before_agent_start', async (event) => {
    const r = active; if (!r) return;
    r.runId = randomUUID(); r.text = ''; r.toolCalls = 0; r.stopped = false; r.error = ''; r.lastBeat = 0; r.sentTool = '';
    const local = r.queued === 0; r.queued = 0; r.phone = !local;
    if (r.key) await call(r, '/turn', {key: r.key, runId: r.runId, prompt: String(event.prompt ?? '').slice(0, 200), local});
  });
  const currentTool = (r: Runtime) => [...r.tools.values()].pop() || '';
  const report = (r: Runtime) => {
    r.lastBeat = Date.now(); r.sentTool = currentTool(r);
    void call(r, '/activity', {key: r.key, runId: r.runId, tool: r.sentTool});
  };
  // 工具切换稍等再报：短工具连续调用时只报停留下来的那个。
  const beat = () => {
    const r = active;
    if (!r?.key || !r.runId) return;
    if (Date.now() - r.lastBeat >= 15000) return report(r);
    if (r.toolTimer || currentTool(r) === r.sentTool) return;
    r.toolTimer = setTimeout(() => {
      r.toolTimer = undefined;
      if (active === r && r.key && r.runId && currentTool(r) !== r.sentTool) report(r);
    }, 3000);
  };
  pi.on('tool_execution_start', (event) => {
    if (active) {
      active.toolCalls++;
      const kind = askingKind(event?.args);
      if (kind) active.asking.push({toolCallId: event.toolCallId, kind, args: event.args});
      active.tools.set(event.toolCallId, String(event.toolName || ''));
    }
    beat();
  });
  pi.on('tool_execution_end', (event) => {
    if (!active) return;
    active.asking = active.asking.filter(a => a.toolCallId !== event?.toolCallId);
    active.tools.delete(event?.toolCallId);
    beat();
  });
  pi.on('message_end', (event) => {
    const r = active; if (!r || event.message.role !== 'assistant') return;
    const msg = event.message;
    const text = msg.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
    if (text.trim()) r.text = text;
    r.error = msg.stopReason === 'error' ? '模型请求失败，请在电脑上查看详情' : '';
    if (msg.stopReason === 'aborted') r.stopped = true;
    beat();
  });
  pi.on('agent_settled', async (_event, ctx) => {
    const r = active; if (!r?.runId || !ctx.isIdle()) return;
    const id = r.runId;
    const body = {key: r.key, runId: id, text: r.text, toolCalls: r.toolCalls,
      stopped: r.stopped, error: r.error, sessionName: pi.getSessionName() || '', ...meta(ctx)};
    // Snapshot before I/O: a new turn must not be wiped by a late result acknowledgement.
    r.runId = null; r.phone = false; r.asking = []; r.tools.clear();
    for (let i = 0; i < 3 && !r.cancelled; i++) {
      if (await call(r, '/result', body)) break;
      await delay(r, 500 * (i + 1));
    }
  });
  const refreshRegistration = async (_event: unknown, ctx: ExtensionContext) => {
    const r = active; if (!r) return;
    r.ctx = ctx; patchUi(ctx.ui);
    if (r.key) await call(r, '/register', registration(r));
  };
  pi.on('session_info_changed', refreshRegistration);
  pi.on('model_select', refreshRegistration);
  pi.on('session_shutdown', stop);
  return {reload};
}
