import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ADAPTERS, resolveTerminal} from '../daemon/terminals.mjs';

function capture(t, fail = () => false) {
  const calls = [];
  t.mock.method(childProcess, 'execFile', (bin, args, _opts, done) => {
    calls.push({bin, args});
    queueMicrotask(() => done(fail(bin, args) ? Error('not running') : null, 'created-id', ''));
  });
  syncBuiltinESMExports();
  t.after(() => {t.mock.restoreAll(); syncBuiltinESMExports();});
  return calls;
}
const options = {cwd:"/tmp/project's folder", nonce:'tab123', piBin:"'/opt/tools/node' '/opt/pi package/launch-pi.mjs' '/tmp/remote home'", tmuxSession:'pi', kittySocket:'unix:/tmp/kitty-test'};

test('六种终端通过原生接口启动，并传递目录、启动器和会话 nonce', async t => {
  const calls = capture(t);
  for (const name of ['ghostty','cmux','iterm','wezterm','kitty','tmux']) {
    const start = calls.length;
    await ADAPTERS[name].open(options);
    const serialized = JSON.stringify(calls.slice(start));
    assert.ok(serialized.includes("/tmp/project") && serialized.includes("folder"), name);
    assert.match(serialized, /tab123/, name);
    assert.match(serialized, /launch-pi\.mjs/, name);
    assert.doesNotMatch(serialized, /System Events|keystroke|clipboard/, name);
  }
  const iterm = calls.find(c => c.bin === 'osascript' && c.args[1].includes('iTerm2'));
  assert.match(iterm.args[1], /create tab with default profile command theCmd/);
  assert.doesNotMatch(iterm.args[1], /write text|tell current session/);
  const kitty = calls.find(c => c.bin === 'kitty');
  assert.deepEqual(kitty.args.slice(0,4), ['@','--to',options.kittySocket,'launch']);
});

test('iTerm2 启动命令保留空格、引号及 shell 元字符，不执行目录中的命令', async t => {
  const calls = capture(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'pi-terminal-'));
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  const cwd = path.join(dir,"project' $(touch INJECTED) with spaces");
  fs.mkdirSync(cwd);
  // The launcher records its environment; the final shell exits immediately.
  const launcher = path.join(dir,'record.mjs');
  fs.writeFileSync(launcher, "import fs from 'node:fs'; fs.writeFileSync('observed.json',JSON.stringify({cwd:process.cwd(),nonce:process.env.PI_REMOTE_TAB}));");
  const quote = s => "'" + s.replace(/'/g,"'\\''") + "'";
  await ADAPTERS.iterm.open({cwd,nonce:'tab-safe',piBin:`${quote(process.execPath)} ${quote(launcher)}`});
  childProcess.execFileSync('/bin/sh',['-c',calls[0].args[2]],{stdio:'pipe',input:'exit\n',env:{...process.env,HOME:dir,ZDOTDIR:dir}});
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd,'observed.json'))),{cwd:fs.realpathSync(cwd),nonce:'tab-safe'});
  assert.equal(fs.existsSync(path.join(dir,'INJECTED')),false);
  assert.equal(fs.existsSync(path.join(cwd,'INJECTED')),false);
});

test('kitty 自动探测使用指定 socket，tmux 无目标会话时新建独立会话', async t => {
  const calls = capture(t, (bin,args) => bin !== 'kitty' && !(bin === 'tmux' && args[0] === 'new-session'));
  const selected = await resolveTerminal({terminal:'auto',kittySocket:options.kittySocket});
  assert.equal(selected.name,'kitty');
  assert.deepEqual(calls.find(c => c.bin === 'kitty').args,['@','--to',options.kittySocket,'ls']);
  await ADAPTERS.tmux.open(options);
  assert.equal(calls.at(-1).args[0],'new-session');
  assert.ok(calls.at(-1).args.includes('-d'));
});

test('禁用终端不探测；指定终端和错误配置不被静默替换', async t => {
  const calls = capture(t);
  assert.equal(await resolveTerminal({terminal:'none'}),null);
  assert.equal((await resolveTerminal({terminal:'wezterm'})).name,'wezterm');
  await assert.rejects(resolveTerminal({terminal:'invalid'}),/未知终端/);
  assert.equal(calls.length,0);
});
