import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-remote-alias-'));
process.env.PI_REMOTE_HOME = dir;
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({dirAliases: {Home: '~'}, botId: 'b', secret: 's', ownerUserId: 'u'}));
const {ALIASES_FILE, loadAliases} = await import('../daemon/aliases.mjs');
const {default: extension} = await import('../extensions/index.ts');
test.after(() => fs.rmSync(dir, {recursive: true, force: true}));

function harness(answers = []) {
  const commands = {}, notes = [];
  extension({registerCommand: (n, c) => commands[n] = c, on() {}, registerTool() {}, appendEntry() {}, getSessionName() {}, setSessionName() {}});
  const next = () => answers.shift();
  const ctx = {cwd: dir, hasUI: true, ui: {
    notify: (m, t) => notes.push([t, m]),
    select: async () => next(), input: async () => next(), confirm: async () => next(), editor: async () => next(),
  }};
  return {ui: ctx.ui, commands, run: args => commands.remote.handler(`alias ${args}`, ctx), complete: p => commands.remote.getArgumentCompletions(`alias ${p}`), notes};
}

test('未保存前沿用 config.json 的 dirAliases；首次修改生成独立配置表', async () => {
  assert.deepEqual(loadAliases(), {home: '~'});
  const h = harness();
  await h.run('proj');
  assert.deepEqual(JSON.parse(fs.readFileSync(ALIASES_FILE, 'utf8')), {home: '~', proj: dir.replace(os.homedir(), '~')});
  await h.run(`tmp ${os.tmpdir()}`);
  await h.run('rm proj');
  assert.deepEqual(Object.keys(loadAliases()), ['home', 'tmp']);
});

test('非法名称与不存在目录给出错误，不写入', async () => {
  const h = harness(), before = fs.readFileSync(ALIASES_FILE, 'utf8');
  await h.run('bad /no/such/dir');
  await h.run('rm');
  await h.run('rm nope');
  assert.equal(fs.readFileSync(ALIASES_FILE, 'utf8'), before);
  assert.deepEqual(h.notes.map(n => n[0]), ['error', 'warning', 'error']);
});

test('编辑配置表：JSON 出错时带错误提示重开，修正后保存', async () => {
  const h = harness(['{bad', '{"A": "~", "b": "~/nope-xyz"}']);
  await h.run('edit');
  assert.deepEqual(loadAliases(), {a: '~', b: '~/nope-xyz'});
  assert.match(h.notes.at(-1)[1], /已保存 2 个别名；目录不存在：b/);
});

test('/remote 菜单进入目录别名，选中别名后改名', async () => {
  const h = harness(['目录别名 alias', 'a  →  ~', '改名', 'home', undefined]);
  await h.commands.remote.handler('', {cwd: dir, hasUI: true, ui: h.ui});
  assert.deepEqual(Object.keys(loadAliases()).sort(), ['b', 'home']);
});

test('补全：子命令与已有别名', () => {
  const h = harness();
  assert.deepEqual(h.complete('h').map(i => i.value), ['alias home ']);
  assert.deepEqual(h.complete('rm ').map(i => i.value), ['alias rm b', 'alias rm home']);
  assert.deepEqual(h.commands.remote.getArgumentCompletions('al').map(i => i.value), ['alias']);
  assert.equal(h.commands.alias, undefined);
});
