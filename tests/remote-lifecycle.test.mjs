import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const tick=()=>new Promise(r=>setTimeout(r,5));
async function until(fn){for(let i=0;i<200;i++){if(fn())return;await tick();}throw Error('timeout');}
test('TUI 扩展只中断指定轮次；重载取消旧轮询，不向新会话投递旧消息',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-remote-lifecycle-'));
  const previous=process.env.PI_REMOTE_HOME;process.env.PI_REMOTE_HOME=dir;
  fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({localPort:18778}));fs.writeFileSync(path.join(dir,'.token'),'token');
  const originalFetch=globalThis.fetch;const polls=[],calls=[],messages=[];let registrations=0;
  globalThis.fetch=async(url,options)=>{
    const endpoint=new URL(url).pathname;const body=options.body?JSON.parse(options.body):{};calls.push({endpoint,body});
    if(endpoint==='/register')return Response.json({key:`t${++registrations}`,tunnel:true});
    if(endpoint==='/poll')return new Promise((resolve,reject)=>{
      const onAbort=()=>reject(Error('aborted'));options.signal.addEventListener('abort',onAbort,{once:true});
      polls.push({signal:options.signal,reply:messages=>{options.signal.removeEventListener('abort',onAbort);resolve(Response.json({messages,tunnel:true}));}});
    });
    return Response.json({ok:true});
  };
  const hooks=new Map();let aborts=0; let idle=false;
  const extension=(await import('../extensions/remote.ts')).default;
  const ctx={mode:'tui',cwd:dir,model:{id:'test',contextWindow:1000000},getContextUsage:()=>({tokens:98000,percent:9.8,contextWindow:1000000}),isIdle:()=>idle,abort:()=>aborts++,
    ui:{setStatus(){},notify(){}},sessionManager:{getSessionFile:()=>'',getSessionId:()=>'session-A'}};
  extension({on:(name,fn)=>hooks.set(name,fn),getSessionName:()=>'会话A',sendUserMessage:text=>messages.push(text)});
  t.after(async()=>{await hooks.get('session_shutdown')?.();globalThis.fetch=originalFetch;if(previous===undefined)delete process.env.PI_REMOTE_HOME;else process.env.PI_REMOTE_HOME=previous;fs.rmSync(dir,{recursive:true,force:true});});
  await hooks.get('session_start')({},ctx);await until(()=>polls.length===1);
  assert.equal(calls.find(x=>x.endpoint==='/register').body.contextWindow,1000000);
  assert.equal('autoName' in calls.find(x=>x.endpoint==='/register').body,false); // 未传 autoName 时不上报，daemon 保持等待
  assert.equal(calls.find(x=>x.endpoint==='/register').body.ctxPercent,9.8);
  await hooks.get('before_agent_start')({prompt:'任务'});
  const runId=calls.find(x=>x.endpoint==='/turn').body.runId;
  polls[0].reply([{type:'abort',runId:'old-run'}]);await until(()=>polls.length===2);assert.equal(aborts,0);
  polls[1].reply([{type:'abort',runId}]);await until(()=>polls.length===3);assert.equal(aborts,1);
  assert.ok(calls.some(x=>x.endpoint==='/abort-ack'&&x.body.accepted));
  await hooks.get('message_end')({message:{role:'assistant',content:[{type:'text',text:'正在检查'}],stopReason:'toolUse'}});
  await hooks.get('message_end')({message:{role:'assistant',content:[],stopReason:'aborted'}});
  idle=true; await hooks.get('agent_settled')({},ctx);
  const result=calls.find(x=>x.endpoint==='/result').body;
  assert.equal(result.stopped,true); assert.equal(result.contextWindow,1000000);
  assert.equal(calls.filter(x=>x.endpoint==='/result').length,1);
  await hooks.get('agent_settled')({},ctx);
  assert.equal(calls.filter(x=>x.endpoint==='/result').length,1);
  await hooks.get('session_shutdown')();assert.ok(polls[2].signal.aborted);
  await hooks.get('session_start')({},ctx);await until(()=>polls.length===4);
  polls[2].reply([{text:'旧会话迟到消息'}]);polls[3].reply([{text:'新会话消息'}]);
  await until(()=>messages.length===1);assert.deepEqual(messages,['新会话消息']);
});
