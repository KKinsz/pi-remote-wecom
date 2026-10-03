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
  const hooks=new Map();let aborts=0; let idle=false;let thinking='high'; const thinkingSet=[];
  const extension=(await import('../extensions/remote.ts')).default;
  const painted=new Map();
  const entries=[{type:'message',message:{role:'assistant',usage:{input:10,output:5,cacheRead:0,cacheWrite:0,cost:{total:0.02}}}},{type:'compaction',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,cost:{total:0.01}}}];
  const ctx={mode:'tui',cwd:dir,model:{id:'test',contextWindow:1000000,reasoning:true},getContextUsage:()=>({tokens:98000,percent:9.8,contextWindow:1000000}),isIdle:()=>idle,abort:()=>aborts++,
    ui:{setStatus(k,v){painted.set(k,v);},notify(){}},sessionManager:{getSessionFile:()=>'',getSessionId:()=>'session-A',getEntries:()=>entries}};
  extension({on:(name,fn)=>hooks.set(name,fn),getSessionName:()=>'会话A',getThinkingLevel:()=>thinking,setThinkingLevel:l=>{thinkingSet.push(l);thinking=l;},sendUserMessage:text=>messages.push(text)});
  t.after(async()=>{await hooks.get('session_shutdown')?.();globalThis.fetch=originalFetch;if(previous===undefined)delete process.env.PI_REMOTE_HOME;else process.env.PI_REMOTE_HOME=previous;fs.rmSync(dir,{recursive:true,force:true});});
  await hooks.get('session_start')({},ctx);await until(()=>polls.length===1);
  assert.equal(calls.find(x=>x.endpoint==='/register').body.contextWindow,1000000);
  assert.equal('autoName' in calls.find(x=>x.endpoint==='/register').body,false); // 未传 autoName 时不上报，daemon 保持等待
  assert.equal(calls.find(x=>x.endpoint==='/register').body.ctxPercent,9.8);
  // Footer info: other extensions' statuses are captured (ANSI/icon stripped), own status excluded, cleared on undefined.
  ctx.ui.setStatus('quota','\u001b[32m\uf0e7 额度 72%\u001b[0m'); ctx.ui.setStatus('idle','空闲 3m'); ctx.ui.setStatus('idle',undefined);
  assert.equal(painted.get('quota'),'\u001b[32m\uf0e7 额度 72%\u001b[0m'); // terminal rendering untouched
  polls[0].reply([{type:'get_meta',reqId:'f1'}]);await until(()=>calls.some(x=>x.endpoint==='/meta-ack'));
  const metaAck=calls.find(x=>x.endpoint==='/meta-ack').body;
  assert.deepEqual(metaAck.statuses,['额度 72%']); assert.equal(metaAck.thinkingLevel,'high');
  assert.deepEqual(metaAck.thinkingLevels,['off','minimal','low','medium','high']);
  assert.equal(Number(metaAck.usage.cost.toFixed(2)),0.03); assert.equal(metaAck.reqId,'f1');
  await until(()=>polls.length===2); polls.shift();
  // Thinking level from the phone: unsupported levels are refused, supported ones go through pi.setThinkingLevel.
  polls[0].reply([{type:'set_thinking',reqId:'s1',level:'max'},{type:'set_thinking',reqId:'s2',level:'low'}]);
  await until(()=>calls.filter(x=>x.endpoint==='/meta-ack').length===3);
  const [bad,good]=calls.filter(x=>x.endpoint==='/meta-ack').slice(1).map(x=>x.body);
  assert.equal(bad.ok,false); assert.match(bad.error,/不支持/);
  assert.equal(good.ok,true); assert.equal(good.thinkingLevel,'low'); assert.deepEqual(thinkingSet,['low']);
  await until(()=>polls.length===2); polls.shift();
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
test('TUI 扩展：question / questionnaire 工具（ui.custom）转手机，按工具原结果形状交回',async t=>{
  const {RUN_DIR}=await import('../daemon/config.mjs');const dir=RUN_DIR;fs.mkdirSync(dir,{recursive:true});
  const previous=process.env.PI_REMOTE_HOME;process.env.PI_REMOTE_HOME=dir;
  fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({localPort:18778}));fs.writeFileSync(path.join(dir,'.token'),'token');
  const originalFetch=globalThis.fetch;const polls=[],calls=[];
  globalThis.fetch=async(url,options)=>{
    const endpoint=new URL(url).pathname;const body=options.body?JSON.parse(options.body):{};calls.push({endpoint,body});
    if(endpoint==='/register')return Response.json({key:'t1',tunnel:true});
    if(endpoint==='/poll')return new Promise((resolve,reject)=>{
      const onAbort=()=>reject(Error('aborted'));options.signal.addEventListener('abort',onAbort,{once:true});
      polls.push({reply:messages=>{options.signal.removeEventListener('abort',onAbort);resolve(Response.json({messages,tunnel:true}));}});
    });
    return Response.json({ok:true});
  };
  // Fake custom(): the factory receives done; the test can also finish it locally.
  const shown=[];
  const ui={setStatus(){},notify(){},confirm:async()=>true,select:async()=>undefined,
    custom:(factory)=>new Promise(resolve=>{const s={done:v=>{s.closed=true;resolve(v);}};factory({},{},{},s.done);shown.push(s);})};
  const hooks=new Map();
  const extension=(await import(`../extensions/remote.ts?q=${Date.now()}`)).default;
  const ctx={mode:'tui',cwd:dir,model:{id:'m'},getContextUsage:()=>null,isIdle:()=>true,abort(){},ui,
    sessionManager:{getSessionFile:()=>'',getSessionId:()=>'S'}};
  extension({on:(name,fn)=>hooks.set(name,fn),getSessionName:()=>'S',sendUserMessage(){}});
  t.after(async()=>{await hooks.get('session_shutdown')?.();globalThis.fetch=originalFetch;if(previous===undefined)delete process.env.PI_REMOTE_HOME;else process.env.PI_REMOTE_HOME=previous;});
  await hooks.get('session_start')({},ctx);await until(()=>polls.length===1);
  const reqs=()=>calls.filter(x=>x.endpoint==='/ui-request').map(x=>x.body);
  // Local (desktop) turn: question is also forwarded; the phone answers.
  await hooks.get('before_agent_start')({prompt:'本地'});
  await hooks.get('tool_execution_start')({toolCallId:'c0',toolName:'question',args:{question:'本地问',options:[{label:'A'}]}});
  const p0=ui.custom(()=>({}));await until(()=>reqs().length===1);
  polls[0].reply([{type:'ui_answer',reqId:reqs()[0].reqId,index:1,value:'A'}]);
  assert.deepEqual(await p0,{answer:'A',wasCustom:false,index:1});
  calls.length=0; // 以下下标从 0 重新计
  await hooks.get('agent_settled')({},ctx);
  // Phone turn, question: phone picks option 2.
  await until(()=>polls.length===2);polls[1].reply([{text:'手机任务'}]);await until(()=>polls.length===3);
  await hooks.get('before_agent_start')({prompt:'手机任务'});
  await hooks.get('tool_execution_start')({toolCallId:'c1',toolName:'question',args:{question:'用哪个库？',options:[{label:'React',description:'生态大'},{label:'Vue'}]}});
  const p1=ui.custom(()=>({}));await until(()=>reqs().length===1);
  assert.equal(reqs()[0].kind,'question');assert.deepEqual(reqs()[0].options,['React','Vue']);assert.equal(reqs()[0].allowText,true);
  assert.deepEqual(reqs()[0].descriptions,['生态大','']);
  polls[2].reply([{type:'ui_answer',reqId:reqs()[0].reqId,index:2,value:'Vue'}]);
  assert.deepEqual(await p1,{answer:'Vue',wasCustom:false,index:2});
  await hooks.get('tool_execution_end')({toolCallId:'c1'});
  // Phone writes free text.
  await hooks.get('tool_execution_start')({toolCallId:'c2',toolName:'question',args:{question:'名字？',options:[{label:'默认'}]}});
  const p2=ui.custom(()=>({}));await until(()=>reqs().length===2);
  polls[3].reply([{type:'ui_answer',reqId:reqs()[1].reqId,custom:true,value:' 小明 '}]);
  assert.deepEqual(await p2,{answer:'小明',wasCustom:true});
  await hooks.get('tool_execution_end')({toolCallId:'c2'});
  // Questionnaire: two questions asked one after another, answers returned in questionnaire shape.
  const qs=[{id:'scope',prompt:'范围？',options:[{value:'all',label:'全部'},{value:'part',label:'部分'}]},{id:'pri',label:'优先级',prompt:'优先级？',options:[{value:'p0',label:'P0'}],allowOther:false}];
  await hooks.get('tool_execution_start')({toolCallId:'c3',toolName:'questionnaire',args:{questions:qs}});
  const p3=ui.custom(()=>({}));await until(()=>reqs().length===3);
  assert.equal(reqs()[2].title,'（1/2）范围？');
  polls[4].reply([{type:'ui_answer',reqId:reqs()[2].reqId,index:2,value:'部分'}]);
  await until(()=>reqs().length===4);assert.equal(reqs()[3].allowText,false);
  polls[5].reply([{type:'ui_answer',reqId:reqs()[3].reqId,index:1,value:'P0'}]);
  const r3=await p3;
  assert.equal(r3.cancelled,false);
  assert.deepEqual(r3.answers,[{id:'scope',value:'part',label:'部分',wasCustom:false,index:2},{id:'pri',value:'p0',label:'P0',wasCustom:false,index:1}]);
  assert.deepEqual(r3.questions.map(q=>q.label),['Q1','优先级']);
  await hooks.get('tool_execution_end')({toolCallId:'c3'});
  // Terminal answers first: phone card retired via /ui-done.
  await hooks.get('tool_execution_start')({toolCallId:'c4',toolName:'question',args:{question:'电脑答',options:[{label:'X'}]}});
  const p4=ui.custom(()=>({}));await until(()=>reqs().length===5);
  shown.at(-1).done({answer:'X',wasCustom:false,index:1});
  assert.deepEqual(await p4,{answer:'X',wasCustom:false,index:1});
  await until(()=>calls.some(x=>x.endpoint==='/ui-done'&&x.body.reqId===reqs()[4].reqId));
  // Unrelated custom() (no question tool running) is untouched.
  const p5=ui.custom(()=>({}));await tick();assert.equal(reqs().length,5);shown.at(-1).done('ok');assert.equal(await p5,'ok');
});
