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
};
function meta(ctx: ExtensionContext) {
  const usage = ctx.getContextUsage();
  return {model: ctx.model?.id || '', modelProvider: ctx.model?.provider || '', ctxPercent: usage?.percent ?? null, contextWindow: usage?.contextWindow ?? ctx.model?.contextWindow ?? null};
}
// Same candidate set as Ctrl+P: scoped models (enabledModels / --models) when configured, else all authenticated models.
function selectableModels(ctx: ExtensionContext) {
  let list: any[] = [];
  try {
    list = ctx.scopedModels?.length ? ctx.scopedModels.map(s => s.model) : ctx.modelRegistry.getAvailable();
  } catch {list = [];}
  return list.slice(0, 60).map(m => ({provider: m.provider, id: m.id, name: m.name || '', contextWindow: m.contextWindow || 0}));
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
    cwd: r.ctx.cwd, pid: process.pid, mode: 'tui', origin, ...meta(r.ctx), models: selectableModels(r.ctx),
    // Lets the daemon skip waiting for a session name that will never come.
    ...(opts.autoName ? {autoName: opts.autoName()} : {}),
  });
  async function stop() {
    const r = active; active = undefined;
    if (!r) return;
    r.cancelled = true;
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
    if (ctx.mode !== 'tui' || process.env.PI_REMOTE_READONLY === '1') return;
    const cfg = loadConfig();
    const r: Runtime = {ctx, cancelled: false, cancel: new AbortController(), key: null,
      token: '', port: cfg.localPort, statusKey: cfg.statusKey, runId: null, text: '',
      toolCalls: 0, queued: 0, stopped: false, error: '', lastBeat: 0};
    active = r;
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
        }
        const response = await call(r, `/poll?key=${encodeURIComponent(r.key!)}`, undefined, 40000);
        if (r.cancelled) break;
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
    const local = r.queued === 0; r.queued = 0;
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
    r.runId = null;
    for (let i = 0; i < 3 && !r.cancelled; i++) {
      if (await call(r, '/result', body)) break;
      await delay(r, 500 * (i + 1));
    }
  });
  const refreshRegistration = async (_event: unknown, ctx: ExtensionContext) => {
    const r = active; if (!r) return;
    r.ctx = ctx;
    if (r.key) await call(r, '/register', registration(r));
  };
  pi.on('session_info_changed', refreshRegistration);
  pi.on('model_select', refreshRegistration);
  pi.on('session_shutdown', stop);
}
