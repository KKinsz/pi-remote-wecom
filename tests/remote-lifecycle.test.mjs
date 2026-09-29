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
test('TUI 扩展：手机轮次的弹窗转到手机，谁先答用谁；本地轮次原样透传',async t=>{
  // config.mjs fixes RUN_DIR at first import (the previous test), so reuse that directory.
  const {RUN_DIR}=await import('../daemon/config.mjs');const dir=RUN_DIR;fs.mkdirSync(dir,{recursive:true});
  const previous=process.env.PI_REMOTE_HOME;process.env.PI_REMOTE_HOME=dir;
  fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({localPort:18778}));fs.writeFileSync(path.join(dir,'.token'),'token');
  const originalFetch=globalThis.fetch;const polls=[],calls=[];
  globalThis.fetch=async(url,options)=>{
    const endpoint=new URL(url).pathname;const body=options.body?JSON.parse(options.body):{};calls.push({endpoint,body});
    if(endpoint==='/register')return Response.json({key:'t1',tunnel:true});
    if(endpoint==='/poll')return new Promise((resolve,reject)=>{
      const onAbort=()=>reject(Error('aborted'));options.signal.addEventListener('abort',onAbort,{once:true});
      polls.push({reply:messages=>{options.signal.removeEventListener('abort',onAbort);resolve(Response.json({messages,tunnel:true}));},
        fail:()=>{options.signal.removeEventListener('abort',onAbort);resolve(new Response('gone',{status:410}));}});
    });
    return Response.json({ok:true});
  };
  // Fake terminal dialogs: resolve when the test answers locally, or undefined when aborted.
  const local=[];
  const ui={setStatus(){},notify(){},
    confirm:(title,message,opts)=>new Promise(resolve=>{const d={title,resolve,aborted:false};local.push(d);opts?.signal?.addEventListener('abort',()=>{d.aborted=true;resolve(false);},{once:true});}),
    select:(title,options,opts)=>new Promise(resolve=>{const d={title,resolve,aborted:false};local.push(d);opts?.signal?.addEventListener('abort',()=>{d.aborted=true;resolve(undefined);},{once:true});}),
  };
  const hooks=new Map();
  const extension=(await import(`../extensions/remote.ts?ui=${Date.now()}`)).default;
  const ctx={mode:'tui',cwd:dir,model:{id:'m'},getContextUsage:()=>null,isIdle:()=>true,abort(){},ui,
    sessionManager:{getSessionFile:()=>'',getSessionId:()=>'S'}};
  extension({on:(name,fn)=>hooks.set(name,fn),getSessionName:()=>'S',sendUserMessage(){}});
  t.after(async()=>{await hooks.get('session_shutdown')?.();globalThis.fetch=originalFetch;if(previous===undefined)delete process.env.PI_REMOTE_HOME;else process.env.PI_REMOTE_HOME=previous;fs.rmSync(dir,{recursive:true,force:true});});
  await hooks.get('session_start')({},ctx);await until(()=>polls.length===1);
  // Local turn: no forwarding.
  await hooks.get('before_agent_start')({prompt:'本地'});
  const p0=ui.confirm('本地确认','x');await until(()=>local.length===1);
  assert.ok(!calls.some(x=>x.endpoint==='/ui-request'));
  local[0].resolve(true);assert.equal(await p0,true);
  await hooks.get('agent_settled')({},ctx);
  // Phone turn: forwarded; phone answers first and the terminal dialog is closed.
  polls[0].reply([{text:'手机任务'}]);await until(()=>polls.length===2);
  await hooks.get('before_agent_start')({prompt:'手机任务'});
  const p1=ui.select('选择环境',['dev','prod']);
  await until(()=>calls.some(x=>x.endpoint==='/ui-request'));
  const req=calls.find(x=>x.endpoint==='/ui-request').body;
  assert.equal(req.kind,'select');assert.deepEqual(req.options,['dev','prod']);
  polls[1].reply([{type:'ui_answer',reqId:req.reqId,value:'prod'}]);
  assert.equal(await p1,'prod');assert.equal(local[1].aborted,true);
  // Terminal answers first: daemon is told to retire the phone card.
  const p2=ui.confirm('再确认','y');
  await until(()=>calls.filter(x=>x.endpoint==='/ui-request').length===2&&local.length===3);
  local[2].resolve(true);assert.equal(await p2,true);
  await until(()=>calls.some(x=>x.endpoint==='/ui-done'));
  assert.equal(calls.find(x=>x.endpoint==='/ui-done').body.reqId,calls.filter(x=>x.endpoint==='/ui-request')[1].body.reqId);
  // Daemon lost mid-dialog: the phone answer will never come, the terminal dialog keeps waiting and wins.
  const p3=ui.confirm('失联确认','z');
  await until(()=>calls.filter(x=>x.endpoint==='/ui-request').length===3&&local.length===4);
  let settled=false; p3.then(()=>settled=true);
  polls.at(-1).fail(); await until(()=>calls.filter(x=>x.endpoint==='/register').length>=2);
  await tick(); assert.equal(settled,false); assert.equal(local[3].aborted,false);
  // After re-registering, the pending dialog is re-sent so a restarted daemon shows the card again.
  await until(()=>calls.filter(x=>x.endpoint==='/ui-request').length===4);
  const reqs=calls.filter(x=>x.endpoint==='/ui-request'); assert.equal(reqs[3].body.reqId,reqs[2].body.reqId);
  local[3].resolve(true); assert.equal(await p3,true);
});
