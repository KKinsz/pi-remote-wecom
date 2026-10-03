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
// Real Pi blocks on session_start dialogs before reading stdin.
const startupUi=process.cwd().endsWith('startup-ui');
if(startupUi) emit({type:'extension_ui_request',id:'boot',method:'confirm',title:'启动授权'});
readline.createInterface({input:process.stdin}).on('line',line=>{
 const c=JSON.parse(line);
 let model=globalThis.model||{provider:'syn',id:'synthetic-model',reasoning:true};
 const models=[{provider:'syn',id:'synthetic-model',reasoning:true},{provider:'syn',id:'synthetic-fast',name:'Synthetic Fast'},{provider:'other',id:'hidden-model'}];
 if(c.type==='set_model') globalThis.model=model=models.find(m=>m.provider===c.provider&&m.id===c.modelId);
 if(c.type==='set_thinking_level') globalThis.level=c.level==='max'?'high':c.level;
 const levels=model.reasoning?['off','minimal','low','medium','high']:['off'];
 const data=c.type==='get_state'?{sessionId:sid,sessionFile:'',model,thinkingLevel:globalThis.level||'medium'}:c.type==='get_available_models'?{models}:c.type==='set_model'?model:c.type==='get_available_thinking_levels'?{levels}:c.type==='compact'?{tokensBefore:150000,estimatedTokensAfter:32000,summary:c.customInstructions||''}:{};
 if(startupUi) return;
 if(c.type==='extension_ui_response'){const p=globalThis.waits?.[c.id]; if(p){delete globalThis.waits[c.id]; p(c);} return;}
 emit({type:'response',id:c.id,command:c.type,success:true,data});
 if(c.type==='prompt'&&c.message.startsWith('确认后结束')){
  emit({type:'extension_ui_request',id:'ui-end',method:'confirm',title:'结束前确认'});
  setTimeout(()=>{emit({type:'message_end',message:{role:'assistant',stopReason:'aborted',content:[]}});emit({type:'agent_settled'});},100);
  return;
 }
 if(c.type==='prompt'&&c.message.startsWith('需要确认')){
  const id='ui-'+crypto.randomUUID(); (globalThis.waits||={})[id]=r=>{emit({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'确认结果：'+c.message+'='+JSON.stringify(r.confirmed)}]}});emit({type:'agent_settled'});};
  emit({type:'extension_ui_request',id,method:'confirm',title:'Allow computer use?',message:'控制 $HOME/bin:$PATH'});
  return;
 }
 if(c.type==='prompt') setTimeout(()=>{emit({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'后台结果：'+c.message}]}});emit({type:'agent_settled'});},150);
});
`,{mode:0o700});
  fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({botId:'test-bot',secret:'test-secret',ownerUserId:'owner',localPort:port,
    piBin:fakePi,remoteConfirmTimeoutMs:5000,wsUrl:`ws://127.0.0.1:${server.address().port}`,agentDir,terminal:'none',inboxDir:path.join(dir,'inbox')}));
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
  // Status pulls footer info from the terminal extension: thinking level, cost and other extensions' statuses.
  const statusP=api('/command',{text:'状态'});
  const metaAsk=await until(async()=>(await api(`/poll?key=${a.key}`)).messages?.find(m=>m.type==='get_meta'));
  await api('/meta-ack',{key:a.key,reqId:metaAsk.reqId,model:'test-model',thinkingLevel:'high',usage:{cost:0.1234},statuses:['额度 72%']});
  const status=await statusP; assert.equal(typeof status.reply,'string');
  assert.match(status.reply,/上下文：/); assert.match(status.reply,/test-model · high/);
  assert.match(status.reply,/花费 \$0\.123/); assert.match(status.reply,/附加信息：额度 72%/);
  assert.doesNotMatch(status.reply,/调用 \d+ 次/);
  const help=await api('/command',{text:'帮助'});
  assert.match(help.reply,/^\*\*📖 命令表\*\*/);
  assert.match(help.reply,/^\*\*Tips\*\*\n\n> 1\. /m);
  assert.match(help.reply,/^> 2\. .*\/tabmodel/m);
  assert.match(help.reply,/^> 3\. .*附件/m);
  assert.doesNotMatch(help.reply,/select/);
  assert.doesNotMatch(help.reply,/关键词|重启|后台会话/); assert.doesNotMatch(help.reply,/\.(ls|h|n|nb|status|help|stop)/);
  // Short alias words replace the long ones in the panel.
  assert.match(help.reply,/\| model \| 模型 \|/);
  assert.match(help.reply,/\| think \| 思考强度 \|/);
  assert.match(help.reply,/\| cd \| 目录 \|/);
  assert.doesNotMatch(help.reply,/切换模型 \[关键词\]/);
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
  // A bare alias word is itself a command; only a word that merely starts with an alias, or joins it
  // to the argument without whitespace, is delivered as ordinary conversation.
  const aliasProbes=['模型hidden','目录proj','思考强度high','模型跑得怎么样','目录下有什么','思考强度不够','新建后台会话了'];
  // Send without awaiting each response: an unconsumed delivery to this TUI waits out the 2s sync
  // window, so seven sequential sends add that wait seven times. Commands that answer directly and
  // deliveries that settle early return sooner; the point here is that serial sends only add latency.
  await Promise.all(aliasProbes.map(text=>api('/command',{text})));
  const routed=await api(`/poll?key=${b.key}`);
  assert.deepEqual(routed.messages.map(m=>m.text).sort(),[...aliasProbes].sort());
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
  const aliased=await api('/command',{text:'新建后台会话 proj 别名任务'});
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
  assert.match(modelCard.desc,/可选 2 个 · 发「模型 关键词」筛选所有模型/);
  message('model'); const nativeModel=await until(()=>sent.filter(x=>x.template_card?.main_title?.title?.includes('切换模型')&&x.template_card.checkbox).at(-1)?.template_card);
  socket.send(JSON.stringify({cmd:'aibot_event_callback',headers:{req_id:`card-${++seq}`},body:{msgid:`card-${seq}`,aibotid:'test-bot',chattype:'single',from:{userid:'owner'},msgtype:'event',event:{eventtype:'template_card_event',template_card_event:{task_id:nativeModel.task_id,selected_items:{selected_item:[{question_key:nativeModel.task_id,option_ids:{option_id:[nativeModel.checkbox.option_list[1].id]}}]}}}}}));
  const switched=await until(()=>sent.find(x=>x.template_card?.card_type==='text_notice'&&x.template_card.main_title.title.includes('切换模型'))?.template_card);
  assert.equal(switched.emphasis_content.title,'Synthetic Fast');
  assert.match((await api('/command',{text:'切换模型'})).reply.card.options[1].text,/← 当前/);
  assert.equal((await api('/command',{text:'模型 synthetic-model'})).reply.card.emphasis_content.title,'synthetic-model');
  const direct=await api('/command',{text:'切换模型 synthetic-model'});
  assert.equal(direct.reply.card.emphasis_content.title,'synthetic-model');
  assert.match((await api('/command',{text:'model 不存在'})).reply,/没有匹配的模型/);
  // Keyword search covers all authenticated models, beyond the enabledModels scope.
  assert.equal((await api('/command',{text:'model hidden'})).reply.card.emphasis_content.title,'hidden-model');
  // Background RPC thinking level: card lists the model's levels, pick/direct switch via set_thinking_level.
  assert.match((await api('/command',{text:'切换思考强度'})).reply,/当前模型不支持思考强度/); // hidden-model has no reasoning
  await api('/command',{text:'切换模型 synthetic-model'});
  const thinkCard=(await api('/command',{text:'切换思考强度'})).reply.card;
  assert.equal(thinkCard.card_type,'vote_interaction');
  assert.deepEqual(thinkCard.options.map(o=>o.text),['off · 关闭','minimal · 最低','low · 低','medium · 中 · ← 当前','high · 高']);
  assert.equal((await api('/command',{text:'think 高'})).reply.card.emphasis_content.title,'high · 高');
  assert.match((await api('/command',{text:'切换思考强度'})).reply.card.options[4].text,/← 当前/);
  assert.match((await api('/command',{text:'think max'})).reply,/当前模型不支持：max[\s\S]*可选：off/);
  assert.match((await api('/command',{text:'思考强度 low'})).reply.card.main_title.title,/切换思考强度/);
  // Manual compaction on a background RPC session.
  assert.equal((await api('/command',{text:'压缩 保留代码改动'})).reply.card.emphasis_content.title,'150k → 32.0k');
  assert.equal((await api('/command',{text:'compact'})).reply.card.main_title.title,'🗜️ 压缩会话');
  // TUI: models come from registration; switch is delivered through poll and confirmed by /model-ack.
  await api('/register',{mode:'tui',sessionId:'A',sessionName:'会话A',cwd:dir,model:'m1',modelProvider:'p',models:[{provider:'p',id:'m1'},{provider:'p',id:'m2'}],allModels:[{provider:'p',id:'m1'},{provider:'p',id:'m2'},{provider:'q',id:'m3-extra'}],modelScoped:true});
  await api('/command',{text:'ls'}); const liveCard=(await api('/command',{text:'ls'})).reply.card;
  const aIndex=liveCard.options.findIndex(o=>o.text.includes('会话A'))+1;
  await api('/command',{text:`选择会话 ${aIndex}`});
  const tuiCard=(await api('/command',{text:'model'})).reply.card;
  assert.deepEqual(tuiCard.options.map(o=>o.text),['m1 · p · ← 当前','m2 · p']);
  assert.match(tuiCard.desc,/筛选所有模型/);
  const tuiSearch=(await api('/command',{text:'model m'})).reply.card;
  assert.deepEqual(tuiSearch.options.map(o=>o.text),['m1 · p · ← 当前','m2 · p','m3-extra · q']);
  const pending=api('/command',{text:'model m2'});
  const ask=await until(async()=>{const r=await api(`/poll?key=${a.key}`); return r.messages?.find(m=>m.type==='set_model');});
  assert.equal(ask.modelId,'m2');
  await api('/model-ack',{key:a.key,reqId:ask.reqId,ok:true,model:'m2',modelProvider:'p'});
  assert.equal((await pending).reply.card.emphasis_content.title,'m2');
  const failing=api('/command',{text:'model m1'});
  const ask2=await until(async()=>{const r=await api(`/poll?key=${a.key}`); return r.messages?.find(m=>m.type==='set_model');});
  await api('/model-ack',{key:a.key,reqId:ask2.reqId,ok:false,error:'未配置认证'});
  assert.match((await failing).reply,/切换模型失败[\s\S]*未配置认证/);
  // TUI thinking level: levels come from get_meta, switch goes through set_thinking and /meta-ack.
  const thinkP=api('/command',{text:'think'});
  const tAsk=await until(async()=>(await api(`/poll?key=${a.key}`)).messages?.find(m=>m.type==='get_meta'));
  await api('/meta-ack',{key:a.key,reqId:tAsk.reqId,thinkingLevel:'low',thinkingLevels:['off','low','high','xhigh']});
  assert.deepEqual((await thinkP).reply.card.options.map(o=>o.text),['off · 关闭','low · 低 · ← 当前','high · 高','xhigh · 超高']);
  const setP=api('/command',{text:'think xhigh'});
  const tAsk2=await until(async()=>(await api(`/poll?key=${a.key}`)).messages?.find(m=>m.type==='get_meta'));
  await api('/meta-ack',{key:a.key,reqId:tAsk2.reqId,thinkingLevel:'low',thinkingLevels:['off','low','high','xhigh']});
  const tSet=await until(async()=>(await api(`/poll?key=${a.key}`)).messages?.find(m=>m.type==='set_thinking'));
  assert.equal(tSet.level,'xhigh');
  await api('/meta-ack',{key:a.key,reqId:tSet.reqId,ok:true,thinkingLevel:'xhigh'});
  assert.equal((await setP).reply.card.emphasis_content.title,'xhigh · 超高');
  const oldP=api('/command',{text:'think'});
  const tAsk3=await until(async()=>(await api(`/poll?key=${a.key}`)).messages?.find(m=>m.type==='get_meta'));
  await api('/meta-ack',{key:a.key,reqId:tAsk3.reqId,thinkingLevel:'low'});
  assert.match((await oldP).reply,/扩展版本过旧/);
  // Extension dialogs are forwarded to the phone: background confirm answered by card, then timeout auto-allows.
  const pickUi=(card,label)=>socket.send(JSON.stringify({cmd:'aibot_event_callback',headers:{req_id:`card-${++seq}`},body:{msgid:`card-${seq}`,aibotid:'test-bot',chattype:'single',from:{userid:'owner'},msgtype:'event',event:{eventtype:'template_card_event',template_card_event:{task_id:card.task_id,selected_items:{selected_item:[{question_key:card.task_id,option_ids:{option_id:[card.checkbox.option_list.find(o=>o.text===label).id]}}]}}}}}));
  const uiCards=()=>sent.filter(x=>x.template_card?.main_title?.title?.includes('Allow computer use')).map(x=>x.template_card);
  await api('/command',{text:'创建后台会话 proj 需要确认甲'});
  const uiCard=await until(()=>uiCards()[0]);
  assert.deepEqual(uiCard.checkbox.option_list.map(o=>o.text),['允许','拒绝']);
  assert.match(uiCard.main_title.desc,/未选将自动允许/);
  assert.ok(sent.some(x=>x.markdown?.content.includes('```\nAllow computer use?\n\n控制 $HOME/bin:$PATH\n```'))); // fenced: no math rendering
  pickUi(uiCard,'拒绝');
  await until(()=>sent.some(x=>x.markdown?.content.includes('确认结果：需要确认甲=false')));
  assert.ok(sent.some(x=>x.markdown?.content.includes('已拒绝')));
  // A run that ends while its dialog is pending retires the card: no later "timed out, auto-allowed".
  await api('/command',{text:'创建后台会话 proj 确认后结束'});
  const endCard=await until(()=>sent.filter(x=>x.template_card?.main_title?.title?.includes('结束前确认')).at(-1)?.template_card);
  await until(()=>sent.some(x=>/已中断[\s\S]*### 💬 .*确认后结束/.test(x.markdown?.content||'')));
  pickUi(endCard,'允许'); await until(()=>sent.filter(x=>x.markdown?.content.includes('这个请求已经处理过')).length===1);

  pickUi(uiCard,'允许'); await until(()=>sent.some(x=>x.markdown?.content.includes('已经提交过')));
  await api('/command',{text:'创建后台会话 proj 需要确认乙'});
  await until(()=>uiCards().length===2);
  await until(()=>sent.some(x=>x.markdown?.content.includes('确认结果：需要确认乙=true')),10000);
  assert.ok(sent.some(x=>x.markdown?.content.includes('超时未处理，已自动允许')));
  // A dialog during startup cannot be answered over RPC: fail fast with a clear reason instead of a 30s timeout.
  fs.mkdirSync(path.join(dir,'startup-ui'));
  fs.writeFileSync(path.join(dir,'aliases.json'),JSON.stringify({proj:aliasDir,sui:path.join(dir,'startup-ui')}));
  const started=Date.now(); const boot=await api('/command',{text:'创建后台会话 sui 启动任务'});
  assert.match(boot.reply,/新建失败[\s\S]*启动时请求确认[\s\S]*启动授权/); assert.ok(Date.now()-started<3000);
  // Terminal session: the extension forwards its dialog; phone answer is delivered through poll.
  await api('/command',{text:'ls'});
  const tuiUi=await api('/ui-request',{key:a.key,reqId:'tui-ui-1',kind:'select',title:'选择环境',options:['dev','prod']});
  assert.equal(tuiUi.ok,true);
  const selCard=await until(()=>sent.filter(x=>x.template_card?.main_title?.title?.includes('选择环境')).at(-1)?.template_card);
  assert.deepEqual(selCard.checkbox.option_list.map(o=>o.text),['dev','prod','取消']);
  pickUi(selCard,'prod');
  await until(()=>sent.some(x=>/已选择\*\*[\s\S]*### 💬 会话A/.test(x.markdown?.content||'')&&x.markdown.content.includes('→ prod')));
  const ans=(await api(`/poll?key=${a.key}`)).messages.find(m=>m.type==='ui_answer');
  assert.deepEqual(ans,{type:'ui_answer',reqId:'tui-ui-1',value:'prod'});
  // Answered on the computer first: the phone card becomes stale.
  await api('/ui-request',{key:a.key,reqId:'tui-ui-2',kind:'confirm',title:'电脑先答'});
  const localCard=await until(()=>sent.filter(x=>x.template_card?.main_title?.title?.includes('电脑先答')).at(-1)?.template_card);
  await api('/ui-done',{key:a.key,reqId:'tui-ui-2'});
  pickUi(localCard,'允许'); await until(()=>sent.filter(x=>x.markdown?.content.includes('这个请求已经处理过')).length===2);
  assert.equal((await api('/ui-request',{key:a.key,reqId:'x',kind:'custom'})).error,'bad ui request');
  // Question tool: numbered options + write-your-own; card pick and free-text reply both answer it.
  await api('/ui-request',{key:a.key,reqId:'tui-q-1',kind:'question',title:'用哪个库？',options:['React','Vue'],descriptions:['生态大',''],allowText:true});
  const qCard=await until(()=>sent.filter(x=>x.template_card?.main_title?.title?.includes('用哪个库')).at(-1)?.template_card);
  assert.deepEqual(qCard.checkbox.option_list.map(o=>o.text),['1. React · 生态大','2. Vue','✏️ 自己写（直接回复文字）','取消']);
  assert.match(qCard.main_title.desc,/可直接回复文字/);
  assert.ok(!sent.some(x=>x.markdown?.content.includes('需要回答'))); // 只发卡片
  pickUi(qCard,'2. Vue');
  const qa=await until(async()=>(await api(`/poll?key=${a.key}`)).messages?.find(m=>m.type==='ui_answer'));
  assert.deepEqual(qa,{type:'ui_answer',reqId:'tui-q-1',index:2,value:'Vue'});
  await api('/ui-request',{key:a.key,reqId:'tui-q-2',kind:'question',title:'叫什么？',options:['默认'],allowText:true});
  const q2Card=await until(()=>sent.filter(x=>x.template_card?.main_title?.title?.includes('叫什么')).at(-1)?.template_card);
  pickUi(q2Card,'✏️ 自己写（直接回复文字）');
  await until(()=>sent.some(x=>x.markdown?.content.includes('请直接回复文字')));
  assert.match((await api('/command',{text:'小明'})).reply,/已回答[\s\S]*→ 小明/);
  const qa2=await until(async()=>(await api(`/poll?key=${a.key}`)).messages?.find(m=>m.type==='ui_answer'));
  assert.deepEqual(qa2,{type:'ui_answer',reqId:'tui-q-2',custom:true,value:'小明'});
  // Switch directory: alias picker card sets the default for new sessions only; existing sessions keep their cwd.
  const cdDir=fs.mkdtempSync(path.join(dir,'cd-target-'));
  fs.writeFileSync(path.join(dir,'aliases.json'),JSON.stringify({proj:aliasDir,sui:path.join(dir,'startup-ui'),cdt:cdDir,gone:path.join(dir,'missing')}));
  const cwdBefore=(await api('/health')).targets.map(x=>[x.key,x.cwd]);
  message('切换目录'); const dirCard=await until(()=>sent.filter(x=>x.template_card?.main_title?.title?.includes('切换目录')&&x.template_card.checkbox).at(-1)?.template_card);
  const dirOpts=dirCard.checkbox.option_list.map(o=>o.text);
  assert.ok(dirOpts[0].startsWith('~')); assert.ok(dirOpts.some(t=>t.startsWith('cdt · ')));
  assert.ok(!dirOpts.some(t=>t.startsWith('gone'))); // missing dirs hidden
  socket.send(JSON.stringify({cmd:'aibot_event_callback',headers:{req_id:`card-${++seq}`},body:{msgid:`card-${seq}`,aibotid:'test-bot',chattype:'single',from:{userid:'owner'},msgtype:'event',event:{eventtype:'template_card_event',template_card_event:{task_id:dirCard.task_id,selected_items:{selected_item:[{question_key:dirCard.task_id,option_ids:{option_id:[dirCard.checkbox.option_list.find(o=>o.text.startsWith('cdt')).id]}}]}}}}}));
  await until(()=>sent.some(x=>x.template_card?.card_type==='text_notice'&&x.template_card.main_title.title.includes('切换目录')));
  assert.deepEqual((await api('/health')).targets.filter(x=>cwdBefore.some(([k])=>k===x.key)).map(x=>[x.key,x.cwd]),cwdBefore);
  await api('/command',{text:'创建后台会话 默认目录任务'});
  await until(()=>sent.some(x=>x.markdown?.content.includes('后台结果：默认目录任务')));
  assert.ok((await api('/health')).targets.some(x=>x.cwd===cdDir));
  assert.match((await api('/command',{text:'切换目录 不存在的目录xyz'})).reply,/找不到目录/);
  assert.match(JSON.stringify((await api('/command',{text:'cd ~'})).reply),/切换目录/);
  assert.match((await api('/command',{text:'切换目录'})).reply.card.options[0].text,/← 当前/);
  assert.match((await api('/command',{text:'目录'})).reply.card.task_id,/^task_cwd_/);
  const all=await api('/health'); assert.equal(all.targets.filter(x=>x.kind==='rpc').length,8); // 2 + 2 alias + 3 confirm + 1 default-dir sessions
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

test('真实 daemon：手机「重启」命令走优雅退出并在重新拉起后主动通知', {timeout: 40000}, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-wecom-restart-'));
  const port = await freePort();
  const server = new WebSocketServer({host:'127.0.0.1',port:0});
  await new Promise(r=>server.on('listening',r));
  const sockets = []; const sent = [];
  server.on('connection', ws => {sockets.push(ws); ws.on('message', data => {
    const frame = JSON.parse(String(data));
    if (frame.cmd === 'aibot_send_msg') sent.push(frame.body);
    ws.send(JSON.stringify({headers:frame.headers,errcode:0,errmsg:'ok'}));
  });});
  fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({botId:'test-bot',secret:'test-secret',ownerUserId:'owner',localPort:port,
    wsUrl:`ws://127.0.0.1:${server.address().port}`,agentDir:path.join(dir,'agent'),terminal:'none',inboxDir:path.join(dir,'inbox')}));
  fs.writeFileSync(path.join(dir,'.token'),'local-token');
  // 重启命令要求 launchd 托管，测试里用同名环境变量模拟。
  const spawnDaemon = () => spawn(process.execPath,['daemon/daemon.mjs'],
    {cwd:process.cwd(),env:{...process.env,PI_REMOTE_HOME:dir,XPC_SERVICE_NAME:'dev.pi-remote-wecom.daemon'},stdio:['ignore','pipe','pipe']});
  let child = spawnDaemon();
  let errors = ''; child.stderr.on('data',d=>errors+=d);
  t.after(async () => {
    child.kill('SIGKILL');
    for (const ws of sockets) ws.terminate(); await new Promise(r=>server.close(r));
    fs.rmSync(dir,{recursive:true,force:true});
  });
  const health = async () => (await fetch(`http://127.0.0.1:${port}/health`,{headers:{'x-pi-token':'local-token'},signal:AbortSignal.timeout(2000)})).json();
  await until(async()=>{try {return (await health()).connected;} catch {if (child.exitCode !== null) throw Error(errors); return false;}});
  await until(()=>sent.some(b=>b.chatid==='owner'));
  const welcomed = sent.length;
  const socket = () => sockets[sockets.length-1];
  const sendText = (id, text) => socket().send(JSON.stringify({cmd:'aibot_msg_callback',headers:{req_id:id},
    body:{msgid:id,aibotid:'test-bot',chattype:'single',from:{userid:'owner'},msgtype:'text',text:{content:text}}}));
  sendText('r1','重启');
  await until(()=>sent.some(b=>b.markdown?.content?.includes('正在重启')));
  // 优雅退出：进程自行结束，并留下重启标记。
  await Promise.race([new Promise(r=>child.once('exit',r)),delay(10000)]);
  assert.notEqual(child.exitCode, null, '进程应自行退出');
  assert.ok(fs.existsSync(path.join(dir,'restart.json')), '退出前应留下重启标记');
  // launchd（KeepAlive）在此处的作用：重新拉起一个新进程。
  child = spawnDaemon(); errors = ''; child.stderr.on('data',d=>errors+=d);
  await until(async()=>{try {return (await health()).connected;} catch {if (child.exitCode !== null) throw Error(errors); return false;}});
  await until(()=>sent.some(b=>b.markdown?.content?.includes('已重启')), 10000);
  assert.equal(fs.existsSync(path.join(dir,'restart.json')), false, '标记应被消费');
  // 一次性：后续重连不再重复通知。
  const afterNotice = sent.filter(b=>b.markdown?.content?.includes('已重启')).length;
  sendText('r2','帮助');
  await until(()=>sent.some(b=>b.markdown?.content?.includes('命令表')));
  assert.equal(sent.filter(b=>b.markdown?.content?.includes('已重启')).length, afterNotice);
});
