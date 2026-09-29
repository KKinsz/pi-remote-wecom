import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';

test('真实 Pi 0.87.1 离线加载单一包入口，注册遥控与命名命令', {timeout:15000}, async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-package-load-'));
  const cli=path.resolve('node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
  const entry=path.resolve(process.env.PI_REMOTE_TEST_ENTRY || 'extensions/index.ts');
  const child=spawn(process.execPath,[cli,'--mode','rpc','--offline','--no-extensions','--extension',entry],{
    cwd:dir,env:{...process.env,PI_CODING_AGENT_DIR:path.join(dir,'agent'),PI_REMOTE_HOME:path.join(dir,'remote')},stdio:['pipe','pipe','pipe'],
  });
  t.after(()=>{child.kill('SIGKILL');fs.rmSync(dir,{recursive:true,force:true});});
  let out='',err=''; child.stderr.on('data',b=>err+=b);
  const response=await new Promise((resolve,reject)=>{
    child.stdout.on('data', b=>{
      out+=b; for (const line of out.split('\n')) {
        try {const msg=JSON.parse(line);if(msg.type==='response'&&msg.id==='commands') resolve(msg);} catch {}
      }
    });
    child.on('exit',code=>reject(Error(`Pi exit ${code}: ${err}`)));
    child.stdin.write(JSON.stringify({id:'commands',type:'get_commands'})+'\n');
  });
  assert.equal(response.success,true,JSON.stringify(response));
  const names=response.data.commands.map(c=>c.name);
  for(const expected of ['remote','tabname','tabmodel']) assert.ok(names.includes(expected),JSON.stringify(response));
  assert.ok(!names.includes('alias'),'alias 应为 /remote 子项');
  assert.doesNotMatch(err,/Failed to load|Cannot find|SyntaxError/);
});
