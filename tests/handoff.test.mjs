import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {WebSocketServer} from 'ws';
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 7000) {
  const start = Date.now();
  while (Date.now() - start < ms) {const result = await fn(); if (result) return result; await delay(20);}
  throw new Error('timed out');
}
async function freePort() {const s = net.createServer(); await new Promise(r => s.listen(0,'127.0.0.1',r)); const p = s.address().port; await new Promise(r=>s.close(r)); return p;}

test('daemon：终端打开后台会话时，后台忙则等待、空闲则关闭后台并交给终端', {timeout: 30000}, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-wecom-handoff-'));
  const port = await freePort();
  const server = new WebSocketServer({host:'127.0.0.1',port:0});
  await new Promise(r=>server.on('listening',r));
  const sent = [];
  server.on('connection', ws => ws.on('message', data => {
    const frame = JSON.parse(String(data));
    if (frame.cmd === 'aibot_send_msg') sent.push(frame.body);
    ws.send(JSON.stringify({headers:frame.headers,errcode:0,errmsg:'ok'}));
  }));
  const agentDir = path.join(dir,'agent');
  fs.mkdirSync(path.join(agentDir,'sessions'),{recursive:true});
  const sessionFile = path.join(dir,'bg.jsonl');
  const exitMark = path.join(dir,'rpc-exited');
  const fakePi = path.join(dir,'synthetic-pi.mjs');
  fs.writeFileSync(fakePi, `#!${process.execPath}
import fs from 'node:fs';
import readline from 'node:readline';
const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');
process.on('exit',()=>fs.writeFileSync(${JSON.stringify(exitMark)},'1'));
readline.createInterface({input:process.stdin}).on('line',line=>{
 const c=JSON.parse(line);
 const model={provider:'syn',id:'synthetic-model'};
 const data=c.type==='get_state'?{sessionId:'bg-session',sessionFile:${JSON.stringify(sessionFile)},model}:c.type==='get_available_models'?{models:[model]}:c.type==='get_available_thinking_levels'?{levels:['off']}:{};
 emit({type:'response',id:c.id,command:c.type,success:true,data});
 if(c.type==='prompt') setTimeout(()=>{emit({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'后台结果：'+c.message}]}});emit({type:'agent_settled'});},800);
});
`,{mode:0o700});
  fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({botId:'test-bot',secret:'test-secret',ownerUserId:'owner',localPort:port,
    piBin:fakePi,wsUrl:`ws://127.0.0.1:${server.address().port}`,agentDir,terminal:'none',inboxDir:path.join(dir,'inbox')}));
  fs.writeFileSync(path.join(dir,'.token'),'local-token');
  const child = spawn(process.execPath,['daemon/daemon.mjs'], {cwd:process.cwd(),env:{...process.env,PI_REMOTE_HOME:dir},stdio:['ignore','pipe','pipe']});
  let errors = ''; child.stderr.on('data',d=>errors+=d);
  t.after(async () => {
    child.kill('SIGTERM'); await Promise.race([new Promise(r=>child.once('exit',r)),delay(2000)]); child.kill('SIGKILL');
    for (const client of server.clients) client.terminate(); await new Promise(r=>server.close(r));
    fs.rmSync(dir,{recursive:true,force:true});
  });
  const api = async (url, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`,{method:body?'POST':'GET',headers:{'x-pi-token':'local-token','content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(6000)});
    return response.json();
  };
  await until(async()=>{try {return (await api('/health')).connected;} catch {if (child.exitCode !== null) throw Error(errors); return false;}});
  await api('/command',{text:'创建后台会话 慢任务'});
  const rpc = await until(async()=>(await api('/health')).targets.find(x=>x.kind==='rpc'&&x.busy));
  assert.equal((await api('/health')).current, rpc.key);
  const tui = {mode:'tui',sessionId:'bg-session',sessionFile,cwd:dir,pid:process.pid};
  // 后台还在跑：终端不注册，后台保持不动
  const waiting = await api('/register',tui);
  assert.equal(waiting.waiting,true); assert.equal(waiting.key,undefined);
  assert.ok((await api('/health')).targets.some(x=>x.key===rpc.key));
  await until(()=>sent.some(x=>x.markdown?.content.includes('后台结果：慢任务')));
  // 后台空闲：关掉后台进程，会话和手机绑定都交给终端
  const handed = await api('/register',tui);
  assert.equal(handed.handedOff,true); assert.ok(handed.key);
  assert.ok(fs.existsSync(exitMark), '后台进程应在交接前退出');
  const health = await api('/health');
  assert.equal(health.targets.filter(x=>x.kind==='rpc').length,0);
  assert.equal(health.current,handed.key);
  // 已经是终端会话后再次注册：普通更新，不再报交接
  const again = await api('/register',tui);
  assert.equal(again.key,handed.key); assert.equal(again.handedOff,false);
  assert.equal(errors,'');
});

test('扩展：等待时输入框上方提示并拦下消息，交接后自动刷新会话', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-remote-handoff-ext-'));
  const previous=process.env.PI_REMOTE_HOME; process.env.PI_REMOTE_HOME=dir; process.env.PI_REMOTE_HANDOFF_RETRY_MS='10';
  fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({localPort:18779})); fs.writeFileSync(path.join(dir,'.token'),'token');
  const originalFetch=globalThis.fetch; let busy=true; const calls=[];
  globalThis.fetch=async(url,options)=>{
    const endpoint=new URL(url).pathname; calls.push(endpoint);
    if(endpoint==='/register') return Response.json(busy?{ok:true,waiting:true,tunnel:true}:{ok:true,key:'t1',tunnel:true,handedOff:true});
    if(endpoint==='/poll') return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));
    return Response.json({ok:true});
  };
  const {default: extension, HANDOFF_TEXT}=await import('../extensions/remote.ts');
  const hooks=new Map(), widgets=new Map(), notes=[], sent=[];
  const ui={setStatus(){},setWidget(k,v,o){if(v===undefined)widgets.delete(k);else widgets.set(k,{v,o});},notify(m,l){notes.push([m,l]);}};
  const ctx={mode:'tui',cwd:dir,model:null,getContextUsage:()=>null,isIdle:()=>true,abort(){},ui,
    modelRegistry:{getAvailable:()=>[]},sessionManager:{getSessionFile:()=>path.join(dir,'s.jsonl'),getSessionId:()=>'bg-session',getEntries:()=>[]}};
  const {reload}=extension({on:(n,f)=>hooks.set(n,f),getSessionName:()=>'',sendUserMessage:(text,o)=>sent.push([text,o])});
  t.after(async()=>{await hooks.get('session_shutdown')?.();globalThis.fetch=originalFetch;if(previous===undefined)delete process.env.PI_REMOTE_HOME;else process.env.PI_REMOTE_HOME=previous;fs.rmSync(dir,{recursive:true,force:true});});
  await hooks.get('session_start')({},ctx);
  await until(()=>widgets.size===1, 2000);
  const w=[...widgets.values()][0];
  assert.deepEqual(w.v,[HANDOFF_TEXT.waiting]); assert.equal(w.o.placement,'aboveEditor');
  assert.equal(HANDOFF_TEXT.waiting,'手机端任务运行中，完成后自动刷新 · 现在查看：/remote reload');
  // 等待中：电脑上打字被拦下，扩展自己发的消息不拦
  assert.deepEqual(await hooks.get('input')({text:'你好',source:'interactive'},ctx),{action:'handled'});
  assert.deepEqual(notes.at(-1),[HANDOFF_TEXT.blocked,'warning']);
  assert.equal(await hooks.get('input')({text:'x',source:'extension'},ctx),undefined);
  // 后台结束：清掉提示，触发内部命令重新载入会话
  busy=false;
  await until(()=>sent.length===1, 2000);
  assert.equal(widgets.size,0);
  assert.deepEqual(sent[0],['/remote reload',{expandPromptTemplates:true}]);
  assert.equal(await hooks.get('input')({text:'你好',source:'interactive'},ctx),undefined);
  const freshNotes=[]; const switched=[];
  const cmdCtx={sessionManager:ctx.sessionManager,ui,switchSession:async(file,o)=>{switched.push(file);await o.withSession({ui:{notify:(m,l)=>freshNotes.push([m,l])}});return {cancelled:false};}};
  await reload(cmdCtx);
  assert.deepEqual(switched,[path.join(dir,'s.jsonl')]);
  await delay(5);
  assert.deepEqual(freshNotes,[[HANDOFF_TEXT.done,'info']]);
  // 刷新失败：提示用 /resume
  await reload({...cmdCtx,switchSession:async()=>{throw Error('boom');}});
  assert.deepEqual(notes.at(-1),[HANDOFF_TEXT.failed,'warning']);
  await reload({...cmdCtx,switchSession:async()=>({cancelled:true})});
  assert.deepEqual(notes.at(-1),[HANDOFF_TEXT.failed,'warning']);
});
