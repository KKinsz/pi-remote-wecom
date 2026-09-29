import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {ExtensionAPI, ExtensionContext} from '@earendil-works/pi-coding-agent';
import {RUN_DIR, loadConfig} from '../daemon/config.mjs';
type Json = Record<string, any>;
type Runtime = {
  ctx: ExtensionContext; cancelled: boolean; cancel: AbortController;
  key: string | null; token: string; port: number; statusKey: string;
  runId: string | null; text: string; toolCalls: number; queued: number;
  stopped: boolean; error: string; lastBeat: number;
  phone: boolean; uiWaits: Map<string, (answer: Json) => void>; uiReqs: Map<string, Json>;
};
type DialogKind = 'confirm' | 'select' | 'input' | 'editor';
const UI_PATCHED = Symbol.for('pi-remote-wecom.ui');
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
      let remoteConfirm = 'ask-then-allow', remoteConfirmTimeoutMs = 180000;
      try {({remoteConfirm, remoteConfirmTimeoutMs} = loadConfig());} catch {}
      if (opts?.timeout > 0 && opts.timeout < remoteConfirmTimeoutMs) return; // 扩展自带更短超时，交给 Pi
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
  function loseUi(r: Runtime) {
    for (const resolve of r.uiWaits.values()) resolve({lost: true});
    r.uiWaits.clear(); r.uiReqs.clear();
  }
  function patchUi(ui: any) {
    if (!ui || ui[UI_PATCHED] || typeof ui.confirm !== 'function' || typeof ui.select !== 'function') return;
    try {
      const orig = {confirm: ui.confirm, select: ui.select, input: ui.input, editor: ui.editor};
      ui.confirm = (title: string, message: string, opts?: any) => remoteDialog('confirm', {title, message}, opts,
        o => orig.confirm.call(ui, title, message, o), a => !a.cancelled && a.confirmed === true);
      ui.select = (title: string, options: string[], opts?: any) => remoteDialog('select', {title, options}, opts,
        o => orig.select.call(ui, title, options, o), a => a.cancelled ? undefined : options.includes(a.value) ? a.value : undefined);
      if (typeof orig.input === 'function') ui.input = (title: string, placeholder?: string, opts?: any) => remoteDialog('input', {title, message: placeholder || ''}, opts,
        o => orig.input.call(ui, title, placeholder, o), a => a.cancelled ? undefined : a.value);
      if (typeof orig.editor === 'function') ui.editor = (title: string, prefill?: string) => remoteDialog('editor', {title}, undefined,
        () => orig.editor.call(ui, title, prefill), a => a.cancelled ? undefined : a.value);
      Object.defineProperty(ui, UI_PATCHED, {value: true});
    } catch {/* 只读或结构变化：保持原样，终端弹窗照常可用 */}
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
      toolCalls: 0, queued: 0, stopped: false, error: '', lastBeat: 0, phone: false, uiWaits: new Map(), uiReqs: new Map()};
    active = r;
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
          if (!registered?.key) {status(r, '服务未启动 · /remote restart', 'red'); await delay(r, 3000); continue;}
          r.key = registered.key;
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
            const accepted = !!r.runId && msg.runId === r.runId && !ctx.isIdle();
            if (accepted) {r.stopped = true; ctx.abort();}
            await call(r, '/abort-ack', {key: r.key, runId: msg.runId, accepted});
            continue;
          }
          if (msg.type === 'ui_answer') {
            const resolve = r.uiWaits.get(String(msg.reqId));
            if (resolve) {r.uiWaits.delete(String(msg.reqId)); resolve(msg);}
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
  pi.on('before_agent_start', async (event) => {
    const r = active; if (!r) return;
    r.runId = randomUUID(); r.text = ''; r.toolCalls = 0; r.stopped = false; r.error = ''; r.lastBeat = 0;
    const local = r.queued === 0; r.queued = 0; r.phone = !local;
    if (r.key) await call(r, '/turn', {key: r.key, runId: r.runId, prompt: event.prompt.slice(0, 200), local});
  });
  const beat = () => {
    const r = active;
    if (!r?.key || !r.runId || Date.now() - r.lastBeat < 15000) return;
    r.lastBeat = Date.now(); void call(r, '/activity', {key: r.key, runId: r.runId});
  };
  pi.on('tool_execution_start', () => {if (active) active.toolCalls++; beat();});
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
    r.runId = null; r.phone = false;
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
}
