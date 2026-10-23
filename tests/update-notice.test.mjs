import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const tick=()=>new Promise(r=>setTimeout(r,5));
async function until(fn){for(let i=0;i<200;i++){if(fn())return;await tick();}throw Error('timeout');}
test('TUI 扩展：daemon 落后于磁盘版本时提醒一次，同一 daemon 重新注册不重复',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-remote-update-'));
  const previous=process.env.PI_REMOTE_HOME;process.env.PI_REMOTE_HOME=dir;
  fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({localPort:18779}));fs.writeFileSync(path.join(dir,'.token'),'token');
  const {VERSION}=await import('../daemon/config.mjs');
  const originalFetch=globalThis.fetch;let registrations=0,polls=0,daemon={version:'0.0.1',pid:42};
  globalThis.fetch=async(url,options)=>{
    const endpoint=new URL(url).pathname;
    if(endpoint==='/register')return Response.json({key:`t${++registrations}`,tunnel:true});
    if(endpoint==='/health')return Response.json({ok:true,service:'pi-remote-wecom',...daemon});
    if(endpoint==='/poll'){
      // 前两次轮询失败触发重新注册；之后挂起直到会话结束。
      if(++polls<=2)return new Response('',{status:500});
      return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));
    }
    return Response.json({ok:true});
  };
  const hooks=new Map();const notices=[];
  const ctx={mode:'tui',cwd:dir,model:{id:'test'},getContextUsage:()=>null,isIdle:()=>true,abort(){},
    ui:{setStatus(){},notify:(text,level)=>notices.push({text,level})},sessionManager:{getSessionFile:()=>'',getSessionId:()=>'s',getEntries:()=>[]}};
  (await import('../extensions/remote.ts')).default({on:(name,fn)=>hooks.set(name,fn),getSessionName:()=>'',getThinkingLevel:()=>'off',setThinkingLevel(){},sendUserMessage(){}});
  t.after(async()=>{await hooks.get('session_shutdown')?.();globalThis.fetch=originalFetch;if(previous===undefined)delete process.env.PI_REMOTE_HOME;else process.env.PI_REMOTE_HOME=previous;fs.rmSync(dir,{recursive:true,force:true});});
  await hooks.get('session_start')({},ctx);await until(()=>polls>=3);await tick();
  assert.equal(registrations,3);
  assert.deepEqual(notices,[{text:`Pi Remote 有新版本 v${VERSION}，空闲时执行 /remote restart 生效`,level:'warning'}]);
  // 重启成新进程且版本一致：不再提醒。
  daemon={version:VERSION,pid:43};await hooks.get('session_start')({},ctx);await until(()=>polls>=4);await tick();
  assert.equal(notices.length,1);
});
