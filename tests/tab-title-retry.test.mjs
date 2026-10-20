import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isolateConfig } from './isolated-config.mjs';
process.env.PI_TAB_TITLE_RETRY_MS = '1';
process.env.PI_TAB_TITLE_REOPEN_MS = '10';
delete process.env.PI_REMOTE_BACKGROUND;
const { default: extension } = await import('../vendor/tab-title/index.ts');
const configDir = isolateConfig();
writeFileSync(join(configDir, 'pi-tab-title.json'), JSON.stringify({ version: 1, provider: 'tencent-copilot', model: 'deepseek-v4.1-flash' }));
const WAITING = Symbol.for('pi-remote-wecom.handoff-waiting');
const delay = ms => new Promise(r => setTimeout(r, ms));
const ok = text => ({ stopReason: 'stop', content: [{ type: 'text', text }] });
const userMsg = { type: 'message', message: { role: 'user', content: '合成首条输入' } };

function harness(t, { mode = 'tui', entries = [], replies }) {
  const hooks = new Map(), titles = [], notes = [], calls = [];
  let currentName = null;
  const ctx = {
    mode, isIdle: () => true, signal: new AbortController().signal,
    sessionManager: { getEntries: () => entries, getBranch: () => entries },
    ui: { setTitle: x => titles.push(x), notify: (m, l) => notes.push([m, l]) },
    modelRegistry: {
      find: () => ({ id: 'deepseek-v4.1-flash', provider: 'tencent-copilot' }),
      complete: async () => { const r = replies[calls.length]; calls.push(1); if (r instanceof Error) throw r; return r; },
    },
  };
  const emit = async (name, event = {}) => { for (const h of hooks.get(name) ?? []) await h(event, ctx); };
  extension({
    on(name, h) { hooks.set(name, [...hooks.get(name) ?? [], h]); },
    registerCommand() {}, registerTool() {},
    appendEntry(customType, data) { entries.push({ type: 'custom', customType, data }); },
    getSessionName: () => currentName,
    setSessionName(n) { currentName = n; void emit('session_info_changed', { name: n }); },
  });
  t.after(() => emit('session_shutdown'));
  const states = () => entries.filter(e => e.customType === 'auto-tab-name:v1').map(e => e.data);
  return { emit, calls, titles, notes, states, name: () => currentName };
}

test('起名偶发失败时自动重试一次', async t => {
  const h = harness(t, { replies: [Error('ECONNRESET'), ok('重试后的名字')] });
  await h.emit('session_start');
  await h.emit('before_agent_start', { prompt: '合成输入' });
  await delay(30);
  assert.equal(h.calls.length, 2);
  assert.equal(h.name(), '重试后的名字');
  assert.equal(h.notes.length, 0);
});

test('重试仍失败：最多请求两次，记为失败并提示', async t => {
  const h = harness(t, { replies: [Error('a'), Error('b'), ok('不应请求')] });
  await h.emit('session_start');
  await h.emit('before_agent_start', { prompt: '合成输入' });
  await delay(30);
  assert.equal(h.calls.length, 2);
  assert.equal(h.states().at(-1).status, 'failed');
  assert.equal(h.notes.at(-1)[1], 'warning');
});

test('终端打开起名失败的会话时补起一次，已补过的不再补', async t => {
  const entries = [{ type: 'custom', customType: 'auto-tab-name:v1', data: { version: 1, status: 'failed', source: 'auto' } }, userMsg];
  const h = harness(t, { entries, replies: [ok('补起的名字')] });
  await h.emit('session_start');
  assert.equal(h.calls.length, 0);
  await delay(40);
  assert.equal(h.calls.length, 1);
  assert.equal(h.name(), '补起的名字');
  assert.equal(h.titles.at(-1), '补起的名字');
  const again = [{ type: 'custom', customType: 'auto-tab-name:v1', data: { version: 1, status: 'failed', source: 'auto', retried: true } }, userMsg];
  const h2 = harness(t, { entries: again, replies: [ok('x')] });
  await h2.emit('session_start'); await delay(40);
  assert.equal(h2.calls.length, 0);
});

test('补起名也失败：记下已补过，下次打开不再补', async t => {
  const entries = [{ type: 'custom', customType: 'auto-tab-name:v1', data: { version: 1, status: 'failed', source: 'auto' } }, userMsg];
  const h = harness(t, { entries, replies: [Error('a'), Error('b')] });
  await h.emit('session_start'); await delay(60);
  assert.equal(h.calls.length, 2);
  const last = h.states().at(-1);
  assert.equal(last.status, 'failed'); assert.equal(last.retried, true); assert.equal(last.title, undefined);
});

test('等待后台会话结束期间不补起名；非终端不补', async t => {
  globalThis[WAITING] = true;
  t.after(() => { delete globalThis[WAITING]; });
  const failed = () => [{ type: 'custom', customType: 'auto-tab-name:v1', data: { version: 1, status: 'failed', source: 'auto' } }, userMsg];
  const h = harness(t, { entries: failed(), replies: [ok('x')] });
  await h.emit('session_start'); await delay(40);
  assert.equal(h.calls.length, 0);
  globalThis[WAITING] = false;
  process.env.PI_REMOTE_BACKGROUND = '1';
  t.after(() => { delete process.env.PI_REMOTE_BACKGROUND; });
  const bg = harness(t, { mode: 'rpc', entries: failed(), replies: [ok('x')] });
  await bg.emit('session_start'); await delay(40);
  assert.equal(bg.calls.length, 0);
});

test('后台会话起名失败时把原因写到 stderr；终端里不写', async t => {
  const logged = [];
  t.mock.method(console, 'error', (...a) => logged.push(a.join(' ')));
  process.env.PI_REMOTE_BACKGROUND = '1';
  t.after(() => { delete process.env.PI_REMOTE_BACKGROUND; });
  const bg = harness(t, { mode: 'rpc', replies: [Error('socket hang up'), Error('socket hang up')] });
  await bg.emit('session_start');
  await bg.emit('before_agent_start', { prompt: '合成输入' }); await delay(30);
  assert.deepEqual(logged, ['[tab-title] naming failed, retrying: socket hang up', '[tab-title] naming failed: socket hang up']);
  const tui = harness(t, { replies: [Error('x'), Error('x')] });
  await tui.emit('session_start');
  await tui.emit('before_agent_start', { prompt: '合成输入' }); await delay(30);
  assert.equal(logged.length, 2);
});
