import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
test('remoteConfirm 配置：默认 ask-then-allow / 3 分钟；非法策略与越界超时报错', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-remote-config-'));
  const previous = process.env.PI_REMOTE_HOME; process.env.PI_REMOTE_HOME = dir;
  t.after(() => {if (previous === undefined) delete process.env.PI_REMOTE_HOME; else process.env.PI_REMOTE_HOME = previous; fs.rmSync(dir, {recursive: true, force: true});});
  const {loadConfig} = await import(`../daemon/config.mjs?cfg=${Date.now()}`);
  const write = v => fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(v));
  write({});
  assert.equal(loadConfig().remoteConfirm, 'ask-then-allow');
  assert.equal(loadConfig().remoteConfirmTimeoutMs, 180000);
  write({remoteConfirm: 'ask', remoteConfirmTimeoutMs: 86400000});
  assert.equal(loadConfig().remoteConfirm, 'ask');
  write({remoteConfirm: 'yes'}); assert.throws(loadConfig, /remoteConfirm/);
  // > 2^31-1 would make setTimeout fire immediately, i.e. auto-allow at once.
  write({remoteConfirmTimeoutMs: 2 ** 31}); assert.throws(loadConfig, /remoteConfirmTimeoutMs/);
  write({remoteConfirmTimeoutMs: 10}); assert.throws(loadConfig, /remoteConfirmTimeoutMs/);
});
