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

test('真实 SDK + daemon：多会话选择、回传、去重、中断、历史卡片', {timeout: 60000}, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-wecom-integration-'));
  const port = await freePort();
  const server = new WebSocketServer({host:'127.0.0.1',port:0});
  await new Promise(r=>server.on('listening',r));
  let socket; const sent = [];
  server.on('connection', ws => {socket = ws; ws.on('message', data => {
    const frame = JSON.parse(String(data));
    if (frame.cmd === 'aibot_send_msg') sent.push(frame.body);
    ws.send(JSON.stringify({headers:frame.headers,errcode:0,errmsg:'ok'}));
  });});
  const agentDir = path.join(dir,'agent');
  fs.mkdirSync(path.join(agentDir,'sessions','project'),{recursive:true});
  for (let i=0; i<20; i++) {
    const file = path.join(agentDir,'sessions','project',`${i}.jsonl`);
    fs.writeFileSync(file, [
      {type:'session',id:`hist-${i}`,cwd:dir,timestamp:new Date().toISOString()},
      {type:'session_info',name:`历史${i}可检索项目`,id:`n${i}`},
      {type:'message',message:{role:'user',content:[{type:'text',text:'历史测试开场白'}]}},
    ].map(JSON.stringify).join('\n')+'\n');
  }
  // Relevance fixtures: the name hit is older than the opener-only hit, and must still rank first.
  for (const [f,name,text,age] of [['rel-name','相关性目标会话','无关开场白',3600],['rel-user','普通会话','这里提到相关性目标',60]]) {
    const file=path.join(agentDir,'sessions','project',`${f}.jsonl`);
    fs.writeFileSync(file,[{type:'session',id:f,cwd:dir},{type:'session_info',name,id:`n-${f}`},{type:'message',message:{role:'user',content:[{type:'text',text}]}}].map(JSON.stringify).join('\n')+'\n');
    const tm=new Date(Date.now()-age*1000); fs.utimesSync(file,tm,tm);
  }
  const fakePi = path.join(dir,'synthetic-pi.mjs');
  fs.writeFileSync(fakePi, `#!${process.execPath}
import readline from 'node:readline';
import crypto from 'node:crypto';
const sid=crypto.randomUUID();
const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const c=JSON.parse(line);
 let model=globalThis.model||{provider:'syn',id:'synthetic-model'};
 const models=[{provider:'syn',id:'synthetic-model'},{provider:'syn',id:'synthetic-fast',name:'Synthetic Fast'},{provider:'other',id:'hidden-model'}];
 if(c.type==='set_model') globalThis.model=model=models.find(m=>m.provider===c.provider&&m.id===c.modelId);
 const data=c.type==='get_state'?{sessionId:sid,sessionFile:'',model}:c.type==='get_available_models'?{models}:c.type==='set_model'?model:{};
 emit({type:'response',id:c.id,command:c.type,success:true,data});
 if(c.type==='prompt') setTimeout(()=>{emit({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'后台结果：'+c.message}]}});emit({type:'agent_settled'});},150);
});
`,{mode:0o700});
  fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({botId:'test-bot',secret:'test-secret',ownerUserId:'owner',localPort:port,
    piBin:fakePi,wsUrl:`ws://127.0.0.1:${server.address().port}`,agentDir,terminal:'none',inboxDir:path.join(dir,'inbox')}));
  fs.writeFileSync(path.join(dir,'.token'),'local-token');
  fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify({enabledModels:['syn/*']}));
  const child = spawn(process.execPath,['daemon/daemon.mjs'], {cwd:process.cwd(),env:{...process.env,PI_REMOTE_HOME:dir},stdio:['ignore','pipe','pipe']});
  let errors = ''; child.stderr.on('data',d=>errors+=d);
  t.after(async () => {
    child.kill('SIGTERM'); await Promise.race([new Promise(r=>child.once('exit',r)),delay(2000)]); child.kill('SIGKILL');
    for (const client of server.clients) client.terminate(); await new Promise(r=>server.close(r));
    fs.rmSync(dir,{recursive:true,force:true});
  });
  const api = async (url, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`,{method:body?'POST':'GET',headers:{'x-pi-token':'local-token','content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(4000)});
    return response.json();
  };
  await until(async()=>{try {return (await api('/health')).connected;} catch {if (child.exitCode !== null) throw Error(errors); return false;}});
  const unauthorized = await fetch(`http://127.0.0.1:${port}/health`); assert.equal(unauthorized.status,403);
  const a = await api('/register',{mode:'tui',sessionId:'A',sessionName:'会话A',cwd:dir,model:'test-model',ctxPercent:9.8,contextWindow:1000000});
  const b = await api('/register',{mode:'tui',sessionId:'B',sessionName:'会话B',cwd:dir});
  assert.notEqual(a.key,b.key);
  let seq=0;
  const message = (text, opts={}) => {
    const id=opts.id || `msg-${++seq}`;
    socket.send(JSON.stringify({cmd:'aibot_msg_callback',headers:{req_id:id},body:{msgid:id,aibotid:'test-bot',chattype:'single',from:{userid:opts.user || 'owner'},msgtype:'text',text:{content:text}}}));
    return id;
  };
  const cardSelect = card => socket.send(JSON.stringify({cmd:'aibot_event_callback',headers:{req_id:`card-${++seq}`},body:{msgid:`card-${seq}`,aibotid:'test-bot',chattype:'single',from:{userid:'owner'},msgtype:'event',event:{eventtype:'template_card_event',template_card_event:{task_id:card.task_id,selected_items:{selected_item:[{question_key:card.task_id,option_ids:{option_id:[card.checkbox.option_list.find(o=>o.text.includes('会话A')).id]}}]}}}}}));
  message('ls'); const card = await until(()=>sent.find(x=>x.msgtype==='template_card')?.template_card);
  assert.equal(card.checkbox.option_list.length,2);
  assert.equal(card.main_title.desc,'活跃 2 个 · 发「历史会话」查询历史'); cardSelect(card);
  await until(async()=>(await api('/health')).current===a.key);
  await until(()=>sent.some(x=>x.template_card?.main_title?.title.includes('选择会话')));
  const selectedCard=sent.find(x=>x.template_card?.main_title?.title.includes('选择会话')).template_card;
  assert.equal(selectedCard.emphasis_content.title,'会话A');
  assert.deepEqual(selectedCard.horizontal_content_list.map(x=>x.keyname),['目录','类型','模型','上下文']);
  assert.equal(selectedCard.horizontal_content_list.find(x=>x.keyname==='上下文').value,'9.8% / 1.0m');
  assert.equal(selectedCard.horizontal_content_list.find(x=>x.keyname==='模型').value,'test-model');
  for (const [ctxPercent, expected] of [[0,'0.0% / 1.0m'],[null,'未知 / 1.0m']]) {
    await api('/register',{mode:'tui',sessionId:'A',sessionName:'会话A',cwd:dir,ctxPercent});
    const selected=await api('/command',{text:'select 1'});
    assert.equal(selected.reply.card.horizontal_content_list.find(x=>x.keyname==='上下文').value,expected);
  }
  const status=await api('/command',{text:'状态'}); assert.equal(typeof status.reply,'string'); assert.match(status.reply,/上下文：/);
  const help=await api('/command',{text:'帮助'});
  assert.match(help.reply,/^\*\*📖 命令表\*\*/);
  assert.match(help.reply,/^\*\*Tips\*\*\n\n`1\. /m);
  assert.match(help.reply,/`2\. .*\/tabmodel/);
  assert.doesNotMatch(help.reply,/select/);
  assert.match(help.reply,/历史会话 关键词/); assert.doesNotMatch(help.reply,/\.(ls|h|n|nb|status|help|stop)/);
  // Removed dot commands and bare numbers are ordinary conversation text.
  for (const text of ['.ls','.h','.n','.nb','.stop','.status','.help','.2','.活跃会话','。帮助','2','状态不对','help me']) {
    await api('/command',{text});
    const routed=await api(`/poll?key=${a.key}`);
    assert.equal(routed.messages[0].text,text);
  }
  // Owner-only enforcement end-to-end.
  const before=sent.length; message('禁止执行',{user:'stranger'}); await delay(100); assert.equal(sent.length,before);
  const msgId=message('给A的任务');
  const pollA = await until(async()=>{const result=await api(`/poll?key=${a.key}`); return result.messages?.length && result;});
  assert.equal(pollA.messages[0].text,'给A的任务');
  await api('/turn',{key:a.key,runId:'run-A',local:false,prompt:'给A的任务'});
  // While A is running, switch to B; A must still deliver its own result.
  await api('/command',{text:'选择会话 2'}); // actual order depends on lastActivity; choose via fresh card below
  const list = await api('/command',{text:'ls'});
  assert.equal(list.reply.card.options.length,2);
  await api('/register',{mode:'tui',sessionId:'B',sessionName:'会话B',cwd:dir});
  await api('/command',{text:'选择会话 1'}); // B most recently registered
  assert.equal((await api('/health')).current,b.key);
  await api('/result',{key:a.key,runId:'run-A',text:'A的独立结果',sessionName:'会话A'});
  await until(()=>sent.some(x=>x.markdown?.content.includes('A的独立结果')));
  const aResult=sent.find(x=>x.markdown?.content.includes('A的独立结果')).markdown.content;
  assert.match(aResult,/会话A/);
  assert.equal((await api('/result',{key:a.key,runId:'run-A',text:'重复错误内容'})).stale,true);
  message('给A的任务',{id:msgId}); await delay(100);
  assert.ok(!sent.some(x=>x.markdown?.content.includes('重复错误内容')));
  // B stop request is a control message addressed to its exact current loop.
  await api('/turn',{key:b.key,runId:'run-B',local:true,prompt:'B本地任务'});
  const stop=await api('/command',{text:'停止'}); assert.match(stop.reply,/已请求中断/);
  const pollB=await api(`/poll?key=${b.key}`); assert.deepEqual(pollB.messages,[{type:'abort',runId:'run-B'}]);
  await api('/abort-ack',{key:b.key,runId:'run-B',accepted:true});
  await api('/result',{key:b.key,runId:'run-B',text:'B的部分结果',stopped:true});
  await until(()=>sent.some(x=>x.markdown?.content.includes('B的部分结果')));
  assert.match(sent.find(x=>x.markdown?.content.includes('B的部分结果')).markdown.content,/已中断/);
  const history=await api('/command',{text:'历史会话 可检索'});
  assert.equal(history.reply.card.options.length,20); // no legacy 1000-character truncation
  const names=history.reply.card.options.map(o=>o.text); assert.ok(names.every(n=>n.includes('可检索')));
  const rel=await api('/command',{text:'历史会话 相关性目标'});
  assert.deepEqual(rel.reply.card.options.map(o=>o.text.includes('相关性目标会话')),[true,false]);
  // Used/forged task id cannot select an arbitrary option.
  cardSelect(card); await until(()=>sent.some(x=>x.markdown?.content.includes('已经提交过')));
  assert.equal((await api('/health')).current,b.key);
  const background = await api('/command',{text:'创建后台会话 home 后台任务甲'});
  assert.equal(background.reply.card.card_type,'text_notice');
  assert.equal(background.reply.card.horizontal_content_list.find(x=>x.keyname==='模型').value,'synthetic-model');
  assert.match(background.reply.card.main_title.title,/创建会话/);
  await until(()=>sent.some(x=>x.markdown?.content.includes('后台结果：后台任务甲')));
  const fallback = await api('/command',{text:'创建会话 home 后台任务乙'});
  assert.match(fallback.reply.card.main_title.title,/创建会话/);
  assert.match(fallback.reply.card.sub_title_text,/未找到可用终端/);
  await until(()=>sent.some(x=>x.markdown?.content.includes('后台结果：后台任务乙')));
  // Alias table edited by hand applies to the running daemon without restart.
  const aliasDir=fs.mkdtempSync(path.join(dir,'alias-target-'));
  fs.writeFileSync(path.join(dir,'aliases.json'),JSON.stringify({proj:aliasDir}));
  const aliased=await api('/command',{text:'创建后台会话 proj 别名任务'});
  await until(()=>sent.some(x=>x.markdown?.content.includes('后台结果：别名任务')));
  assert.match(aliased.reply.card.main_title.title,/创建会话/);
  assert.ok((await api('/health')).targets.some(x=>x.cwd===aliasDir));
  fs.writeFileSync(path.join(dir,'aliases.json'),'{broken'); // keeps last good table
  await api('/command',{text:'创建后台会话 proj 坏表任务'});
  await until(()=>sent.some(x=>x.markdown?.content.includes('后台结果：坏表任务')));
  assert.equal((await api('/health')).targets.filter(x=>x.cwd===aliasDir).length,2);
  // Background RPC: model card respects enabledModels, card pick switches via set_model.
  const modelCard=(await api('/command',{text:'model'})).reply.card;
  assert.equal(modelCard.card_type,'vote_interaction');
  assert.deepEqual(modelCard.options.map(o=>o.text),['synthetic-model · syn · ← 当前','Synthetic Fast · syn']);
  message('model'); const nativeModel=await until(()=>sent.filter(x=>x.template_card?.main_title?.title?.includes('切换模型')&&x.template_card.checkbox).at(-1)?.template_card);
  socket.send(JSON.stringify({cmd:'aibot_event_callback',headers:{req_id:`card-${++seq}`},body:{msgid:`card-${seq}`,aibotid:'test-bot',chattype:'single',from:{userid:'owner'},msgtype:'event',event:{eventtype:'template_card_event',template_card_event:{task_id:nativeModel.task_id,selected_items:{selected_item:[{question_key:nativeModel.task_id,option_ids:{option_id:[nativeModel.checkbox.option_list[1].id]}}]}}}}}));
  const switched=await until(()=>sent.find(x=>x.template_card?.card_type==='text_notice'&&x.template_card.main_title.title.includes('切换模型'))?.template_card);
  assert.equal(switched.emphasis_content.title,'Synthetic Fast');
  assert.match((await api('/command',{text:'切换模型'})).reply.card.options[1].text,/← 当前/);
  const direct=await api('/command',{text:'切换模型 synthetic-model'});
  assert.equal(direct.reply.card.emphasis_content.title,'synthetic-model');
  assert.match((await api('/command',{text:'model 不存在'})).reply,/没有匹配的模型/);
  // TUI: models come from registration; switch is delivered through poll and confirmed by /model-ack.
  await api('/register',{mode:'tui',sessionId:'A',sessionName:'会话A',cwd:dir,model:'m1',modelProvider:'p',models:[{provider:'p',id:'m1'},{provider:'p',id:'m2'}]});
  await api('/command',{text:'ls'}); const liveCard=(await api('/command',{text:'ls'})).reply.card;
  const aIndex=liveCard.options.findIndex(o=>o.text.includes('会话A'))+1;
  await api('/command',{text:`选择会话 ${aIndex}`});
  const tuiCard=(await api('/command',{text:'model'})).reply.card;
  assert.deepEqual(tuiCard.options.map(o=>o.text),['m1 · p · ← 当前','m2 · p']);
  const pending=api('/command',{text:'model m2'});
  const ask=await until(async()=>{const r=await api(`/poll?key=${a.key}`); return r.messages?.find(m=>m.type==='set_model');});
  assert.equal(ask.modelId,'m2');
  await api('/model-ack',{key:a.key,reqId:ask.reqId,ok:true,model:'m2',modelProvider:'p'});
  assert.equal((await pending).reply.card.emphasis_content.title,'m2');
  const failing=api('/command',{text:'model m1'});
  const ask2=await until(async()=>{const r=await api(`/poll?key=${a.key}`); return r.messages?.find(m=>m.type==='set_model');});
  await api('/model-ack',{key:a.key,reqId:ask2.reqId,ok:false,error:'未配置认证'});
  assert.match((await failing).reply,/切换模型失败[\s\S]*未配置认证/);
  const all=await api('/health'); assert.equal(all.targets.filter(x=>x.kind==='rpc').length,4); // 2 + 2 alias sessions
  assert.equal(all.targets.filter(x=>x.kind==='tui').length,2);
  assert.equal(errors,'');
});

test('真实 SDK + daemon：未填 userid 启动，绑定码绑定后写回配置', {timeout: 30000}, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-wecom-bind-'));
  const port = await freePort();
  const server = new WebSocketServer({host:'127.0.0.1',port:0});
  await new Promise(r=>server.on('listening',r));
  let socket; const sent = [];
  server.on('connection', ws => {socket = ws; ws.on('message', data => {
    const frame = JSON.parse(String(data));
    if (frame.cmd === 'aibot_send_msg') sent.push(frame.body);
    ws.send(JSON.stringify({headers:frame.headers,errcode:0,errmsg:'ok'}));
  });});
  fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({botId:'test-bot',secret:'test-secret',ownerUserId:'',localPort:port,
    wsUrl:`ws://127.0.0.1:${server.address().port}`,agentDir:path.join(dir,'agent'),terminal:'none',inboxDir:path.join(dir,'inbox')}));
  fs.writeFileSync(path.join(dir,'.token'),'local-token');
  process.env.PI_REMOTE_HOME = dir;
  const {createBindCode} = await import(`../daemon/config.mjs?bind=${Date.now()}`);
  const code = createBindCode(dir);
  const child = spawn(process.execPath,['daemon/daemon.mjs'], {cwd:process.cwd(),env:{...process.env,PI_REMOTE_HOME:dir},stdio:['ignore','pipe','pipe']});
  let errors = ''; child.stderr.on('data',d=>errors+=d);
  t.after(async () => {
    delete process.env.PI_REMOTE_HOME;
    child.kill('SIGTERM'); await Promise.race([new Promise(r=>child.once('exit',r)),delay(2000)]); child.kill('SIGKILL');
    for (const client of server.clients) client.terminate(); await new Promise(r=>server.close(r));
    fs.rmSync(dir,{recursive:true,force:true});
  });
  const health = async () => (await fetch(`http://127.0.0.1:${port}/health`,{headers:{'x-pi-token':'local-token'},signal:AbortSignal.timeout(2000)})).json();
  await until(async()=>{try {return (await health()).connected;} catch {if (child.exitCode !== null) throw Error(errors); return false;}});
  assert.equal((await health()).reason, '已连接，待绑定验证');
  const send = (id, user, text) => socket.send(JSON.stringify({cmd:'aibot_msg_callback',headers:{req_id:id},
    body:{msgid:id,aibotid:'test-bot',chattype:'single',from:{userid:user},msgtype:'text',text:{content:text}}}));
  send('m1','T00000001A',code);
  await until(()=>JSON.parse(fs.readFileSync(path.join(dir,'config.json'),'utf8')).ownerUserId === 'T00000001A');
  await until(()=>sent.some(b=>b.chatid==='T00000001A' && b.template_card?.emphasis_content?.title==='绑定成功'));
  assert.equal((await health()).reason, '已连接');
  assert.equal(fs.existsSync(path.join(dir,'bind.json')), false);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir,'config.json'),'utf8'));
  assert.equal(cfg.localPort, port); assert.equal(cfg.secret, 'test-secret');
});
