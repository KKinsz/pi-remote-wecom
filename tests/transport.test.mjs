import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import {WeComTransport, PENDING_MEDIA_TTL_MS, selectedIds, disabledSelectionCard, splitMarkdown} from '../daemon/wecom.mjs';
import {plist} from '../daemon/service.mjs';
const turn = () => new Promise(r => setTimeout(r, 15));
function fixture(t, handlers = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-wecom-test-'));
  const client = new EventEmitter(); const sent = []; const updates = [];
  Object.assign(client, {connect() {}, disconnect() {},
    async sendMessage(to, body) {sent.push({to, body});},
    async updateTemplateCard(frame, card) {updates.push(card);},
    async downloadFile() {return {buffer: Buffer.from('image'), filename: '../../photo.png'};},
  });
  const config = {botId: 'test-bot', secret: 'test-secret', ownerUserId: 'owner', inboxDir: path.join(dir, 'inbox')};
  const transport = new WeComTransport({config, dir, client, onMessage: async () => 'ok', onCard: async () => 'selected', ...handlers});
  t.after(() => {transport.stop(); fs.rmSync(dir, {recursive: true, force: true});});
  const frame = (id, text = '你好', extra = {}) => ({headers: {req_id: id}, body: {
    msgid: id, aibotid: 'test-bot', chattype: 'single', from: {userid: 'owner'},
    msgtype: 'text', text: {content: text}, ...extra,
  }});
  return {transport, config, client, sent, updates, dir, frame};
}
test('只接主人单聊，群聊和其他发送者均不能触发 Pi', async t => {
  const calls = []; const f = fixture(t, {onMessage: async text => {calls.push(text); return 'ok';}});
  f.transport.accept(f.frame('1', '合法'));
  f.transport.accept(f.frame('2', '非法', {from: {userid: 'other'}}));
  f.transport.accept(f.frame('3', '群聊', {chattype: 'group', chatid: 'group'}));
  f.transport.accept(f.frame('4', '错机器人', {aibotid: 'another'}));
  await f.transport.inbound; assert.deepEqual(calls, ['合法']);
});
test('按 msgid 去重：重复回调只执行一次，相同文本新消息仍执行', async t => {
  const calls = []; const f = fixture(t, {onMessage: async text => {calls.push(text); return 'ok';}});
  f.transport.accept(f.frame('one')); f.transport.accept(f.frame('one')); f.transport.accept(f.frame('two'));
  await f.transport.inbound; assert.equal(calls.length, 2);
  const reloaded = new WeComTransport({config: f.config, dir: f.dir, client: new EventEmitter(), onMessage: async () => {throw Error('must not execute');}});
  reloaded.accept(f.frame('one')); await reloaded.inbound; reloaded.stop = () => {};
  assert.equal(reloaded.seen.size, 2);
});
test('20,000 字节以内保持单条，超出后按 UTF-8 安全拆分且无丢字', () => {
  const short = '你📱好'.repeat(1999); // 19,990 UTF-8 bytes
  assert.equal(splitMarkdown(short).length, 1);
  const text = '你📱好'.repeat(2001); const parts = splitMarkdown(text);
  assert.equal(parts.join(''), text); assert.ok(parts.every(s => Buffer.byteLength(s) <= 20000));
  assert.ok(parts.length > 1);
});
test('超过 20,000 字节的普通正文改发 Markdown 附件', async t => {
  const f = fixture(t); f.transport.connected = true;
  const uploaded = []; const media = [];
  f.client.uploadMedia = async (buffer, options) => {uploaded.push({buffer, options}); return {media_id: 'md-file'};};
  f.client.sendMediaMessage = async (...args) => {media.push(args);};
  await f.transport.send('你'.repeat(6667)); // 20,001 UTF-8 bytes
  await turn();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].body.markdown.content, '正文超过企微单条消息上限，已作为 Markdown 附件发送。');
  assert.equal(uploaded.length, 1);
  assert.equal(uploaded[0].options.filename.endsWith('.md'), true);
  assert.equal(uploaded[0].buffer.toString(), '你'.repeat(6667));
  assert.deepEqual(media, [['owner', 'file', 'md-file']]);
});
test('原生选择回调兼容 SDK 未声明的 selected_items 结构', () => {
  assert.deepEqual(selectedIds({selected_items: [{question_key:'q', option_ids:['a']}]}), ['a']);
  assert.deepEqual(selectedIds({selected_items:{selected_item:[{option_ids:{option_id:['b']}}]}}), ['b']);
  assert.deepEqual(selectedIds({event_key:'submit'}), []);
});
test('选择回调更新原卡片并禁用选择控件', () => {
  const card = disabledSelectionCard({template_card_event:{task_id:'task',selected_items:{selected_item:[{option_ids:{option_id:['option']}}]}}});
  assert.equal(card.card_type,'vote_interaction');
  assert.equal(card.task_id,'task');
  assert.equal(card.checkbox.disable,true);
  assert.equal(card.submit_button.text,'已选择');
  assert.equal(card.checkbox.option_list[0].id,'option');
});
test('选择回调保留原卡片全部选项与文案，仅锁定并改按钮文字', async t => {
  const f = fixture(t); f.transport.connected = true;
  const options = [{id:'a',text:'会话A'},{id:'b',text:'会话B'},{id:'c',text:'会话C'}];
  await f.transport.send({card: {card_type:'vote_interaction', title:'活跃会话', desc:'活跃 3 个', task_id:'t1', options}, fallback:'fb'});
  await turn();
  f.transport.accept({headers:{req_id:'c1'}, body:{msgid:'c1', aibotid:'test-bot', chattype:'single', from:{userid:'owner'},
    event:{template_card_event:{task_id:'t1', selected_items:{selected_item:[{option_ids:{option_id:['b']}}]}}}}}, true);
  await turn();
  const card = f.updates[0];
  assert.equal(card.main_title.title,'活跃会话');
  assert.equal(card.main_title.desc,'活跃 3 个');
  assert.deepEqual(card.checkbox.option_list.map(o => o.text), ['会话A','会话B','会话C']);
  assert.deepEqual(card.checkbox.option_list.map(o => o.is_checked), [false,true,false]);
  assert.equal(card.checkbox.disable,true);
  assert.equal(card.submit_button.text,'已选择');
});
test('卡片直接发送，保留20项，不展示JSON或额外引导文本', async t => {
  const f = fixture(t); f.transport.connected = true;
  await f.transport.send({card: {card_type:'vote_interaction', title:'会话', desc:'活跃 20 个 · 发「历史会话」查询历史', task_id:'task', options:Array.from({length:20}, (_,i)=>({id:`o${i}`,text:'完整会话标题'.repeat(3)}))}, fallback:'fallback'});
  await turn(); assert.equal(f.sent.length,1);
  assert.equal(f.sent[0].body.template_card.checkbox.option_list.length,20);
  assert.equal(f.sent[0].body.msgtype,'template_card');
  assert.equal(f.sent[0].body.template_card.main_title.desc,'活跃 20 个 · 发「历史会话」查询历史');
});
test('断网发件箱持久化，重新连接后发送，确认后删除', async t => {
  const f = fixture(t); await f.transport.send('离线结果');
  assert.equal(f.sent.length, 0); assert.equal(f.transport.queueFiles().length,1);
  f.transport.connected = true; await f.transport.flush();
  assert.equal(f.sent[0].body.markdown.content,'离线结果'); assert.equal(f.transport.queueFiles().length,0);
});
test('附件先下载，查询不消费，后续投递成功才消费', async t => {
  const calls = []; const f = fixture(t, {onMessage: async (text, files, ack) => {calls.push({text, files}); ack.media = text !== '活跃会话'; return 'ok';}});
  f.transport.accept(f.frame('image','',{msgtype:'image',image:{url:'https://example.test/a',aeskey:'test'}}));
  await f.transport.inbound; assert.equal(f.transport.pendingMedia.length,1);
  f.transport.accept(f.frame('query','活跃会话')); await f.transport.inbound;
  assert.equal(f.transport.pendingMedia.length,1);
  f.transport.accept(f.frame('prompt','解释图片')); await f.transport.inbound;
  assert.equal(f.transport.pendingMedia.length,0); assert.equal(calls[1].files.length,1);
  assert.ok(calls[1].files[0].local.startsWith(f.config.inboxDir + path.sep));
  assert.ok(fs.existsSync(calls[1].files[0].local));
});
test('附件超过5分钟后提示过期，不带入新文字并清理本地文件', async t => {
  const calls = []; const f = fixture(t, {onMessage: async (text, files) => {calls.push({text, files}); return 'ok';}});
  f.transport.connected = true;
  f.transport.accept(f.frame('expired-image', '', {msgtype:'image', image:{url:'https://example.test/a', aeskey:'test'}}));
  await f.transport.inbound;
  const local = f.transport.pendingMedia[0].local;
  f.transport.pendingMedia[0].at = Date.now() - PENDING_MEDIA_TTL_MS - 1;
  f.transport.accept(f.frame('expired-caption', '解释图片'));
  await f.transport.inbound; await f.transport.flush();
  assert.deepEqual(calls, [{text:'解释图片', files:[]}]);
  assert.equal(f.transport.pendingMedia.length, 0);
  assert.equal(fs.existsSync(local), false);
  assert.match(f.sent.map(item => item.body.markdown?.content || '').join('\n'), /超过 5 分钟/);
  assert.match(f.sent.map(item => item.body.markdown?.content || '').join('\n'), /重新发送附件和说明文字/);
});
test('卡片先回应再执行，慢操作不会拖过5秒响应窗口', async t => {
  let finish; const f = fixture(t, {onCard: () => new Promise(r => {finish = r;})});
  f.transport.accept(f.frame('card','',{msgtype:'event',event:{task_id:'t',selected_items:[{option_ids:['o']}]}}), true);
  assert.equal(f.updates.length,1); await turn(); finish('完成'); await f.transport.inbound;
});
test('服务plist转义路径且不包含凭证', () => {
  const text = plist({packageRoot:'/tmp/a & b',node:'/tmp/node',runDir:'/tmp/config',envPath:'/bin'});
  assert.match(text,/a &amp; b/); assert.doesNotMatch(text,/secret|botId/); assert.match(text,/KeepAlive/);
});
test('发件箱重启恢复；附件重试不重复已确认的正文', async t => {
  const f = fixture(t); const file = path.join(f.dir,'result.md');fs.writeFileSync(file,'result');
  await f.transport.send({text:'结果提示',file});
  let fail=true;
  f.client.uploadMedia=async()=>{if(fail) throw Error('offline'); return {media_id:'uploaded'};};
  f.client.sendMediaMessage=async()=>{};
  const restored = new WeComTransport({config:f.config,dir:f.dir,client:f.client});
  restored.connected=true;await restored.flush();
  assert.equal(f.sent.length,1);assert.equal(restored.queueFiles().length,1);
  const queuedFile=path.join(restored.outDir,restored.queueFiles()[0]);
  const queued=JSON.parse(fs.readFileSync(queuedFile));assert.equal(queued.cursor,1);
  fail=false;queued.retryAt=0;fs.writeFileSync(queuedFile,JSON.stringify(queued));
  await restored.flush();assert.equal(f.sent.length,1);assert.equal(restored.queueFiles().length,0);restored.stop();
});

test('真实嵌套卡片回调读取任务和选项，更新卡片带同一任务编号', async t => {
  const calls = []; const f = fixture(t, {onCard: async event => {calls.push(event); return '已选择';}});
  f.transport.accept(f.frame('nested','',{msgtype:'event',event:{eventtype:'template_card_event',template_card_event:{task_id:'task',event_key:'submit',selected_items:{selected_item:[{question_key:'task',option_ids:{option_id:['option']}}]}}}}),true);
  await f.transport.inbound;
  assert.deepEqual(calls,[{taskId:'task',optionId:'option',eventKey:'submit'}]);
  assert.equal(f.updates[0].task_id,'task');
});

test('首次连接提示使用指定文案', async t => {
  const f=fixture(t); const welcomes=[];
  f.client.replyWelcome=async (_frame,body)=>{welcomes.push(body);};
  f.client.emit('event.enter_chat',f.frame('welcome'));
  await turn();
  assert.equal(welcomes[0].text.content,'Pi Remote 已连接，发送`帮助`查看命令。');
});

test('连上后主动给主人发一次欢迎，重连不重复', async t => {
  const f=fixture(t);
  f.transport.start();
  f.client.emit('authenticated'); await turn();
  f.client.emit('authenticated'); await turn();
  const texts=f.sent.map(m=>m.body.markdown?.content);
  assert.deepEqual(texts,['Pi Remote 已连接，发送`帮助`查看命令。']);
  assert.equal(f.sent[0].to,'owner');
});
test('未绑定：绑定码错误计次作废，正确码绑定首个发送者且不触达 Pi', async t => {
  const {createBindCode} = await import('../daemon/config.mjs');
  const calls = []; const saved = [];
  const f = fixture(t, {onMessage: async text => {calls.push(text); return 'ok';}, onBind: async id => {saved.push(id);}});
  f.config.ownerUserId = ''; f.transport.connected = true;
  const code = createBindCode(f.dir);
  const wrong = code === '000000' ? '111111' : '000000';
  f.transport.accept(f.frame('b1', '帮助', {from: {userid: 'mallory'}}));
  f.transport.accept(f.frame('b2', wrong, {from: {userid: 'mallory'}}));
  f.transport.accept(f.frame('b3', code, {chattype: 'group', chatid: 'g', from: {userid: 'mallory'}}));
  f.transport.accept(f.frame('b4', code, {from: {userid: 'owner'}}));
  f.transport.accept(f.frame('b5', code, {from: {userid: 'mallory'}}));
  f.transport.accept(f.frame('b6', '绑定中途', {from: {userid: 'owner'}}));
  await f.transport.inbound;
  f.transport.accept(f.frame('b7', '正常消息', {from: {userid: 'owner'}}));
  await f.transport.inbound; await turn();
  assert.deepEqual(saved, ['owner']);
  assert.equal(f.config.ownerUserId, 'owner');
  assert.deepEqual(calls, ['正常消息']);
  assert.equal(fs.existsSync(path.join(f.dir, 'bind.json')), false);
  assert.ok(f.sent.filter(m => m.to === 'mallory').every(m => !/绑定成功/.test(m.body.markdown.content)));
  const cards = f.sent.filter(m => m.to === 'owner' && m.body.msgtype === 'template_card');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].body.template_card.emphasis_content.title, '绑定成功');
  assert.deepEqual(cards[0].body.template_card.jump_list.map(j => j.question), ['活跃会话', '帮助']);
  assert.equal(f.transport.status().bound, true);
});
test('未绑定：错误 5 次后绑定码作废，过期码不能绑定', async t => {
  const {createBindCode, BIND_MAX_FAILURES} = await import('../daemon/config.mjs');
  const saved = []; const f = fixture(t, {onBind: async id => {saved.push(id);}});
  f.config.ownerUserId = '';
  const code = createBindCode(f.dir);
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < BIND_MAX_FAILURES; i++) f.transport.accept(f.frame(`w${i}`, wrong, {from: {userid: 'x'}}));
  f.transport.accept(f.frame('late', code, {from: {userid: 'owner'}}));
  await f.transport.inbound;
  assert.deepEqual(saved, []);
  const expired = createBindCode(f.dir, Date.now() - 11 * 60 * 1000);
  f.transport.accept(f.frame('exp', expired, {from: {userid: 'owner'}}));
  await f.transport.inbound;
  assert.deepEqual(saved, []); assert.equal(f.config.ownerUserId, '');
});
test('未绑定时不入发件箱，已有发件不改投', async t => {
  const f = fixture(t); f.config.ownerUserId = ''; f.transport.connected = true;
  assert.equal(await f.transport.send('结果'), false);
  assert.equal(f.transport.queueFiles().length, 0);
});
test('未绑定：失败计数无法写盘时作废绑定码（fail closed）', async t => {
  const {createBindCode} = await import('../daemon/config.mjs');
  const saved = []; const f = fixture(t, {onBind: async id => {saved.push(id);}});
  f.config.ownerUserId = '';
  const code = createBindCode(f.dir);
  const wrong = code === '000000' ? '111111' : '000000';
  const bindFile = path.join(f.dir, 'bind.json');
  fs.mkdirSync(bindFile + '.tmp'); // writeJson 的临时文件路径被目录占用 → 写入失败
  f.transport.accept(f.frame('x1', wrong, {from: {userid: 'x'}}));
  await f.transport.inbound;
  assert.equal(fs.existsSync(bindFile), false);
  fs.rmdirSync(bindFile + '.tmp');
  createBindCode(f.dir); // 即使删除失败或文件被恢复，进程内锁仍拒绝
  f.transport.accept(f.frame('x2', code, {from: {userid: 'owner'}}));
  await f.transport.inbound;
  assert.deepEqual(saved, []); assert.equal(f.transport.bindLocked, true);
});
test('停机 drain 后不再受理新入站', async t => {
  const calls = []; const f = fixture(t, {onMessage: async text => {calls.push(text); return 'ok';}});
  f.transport.drain();
  f.transport.accept(f.frame('d1', '停机后'));
  await f.transport.inbound; assert.deepEqual(calls, []);
});
test('绑定成功卡片发送失败时降级为文字', async t => {
  const {createBindCode} = await import('../daemon/config.mjs');
  const f = fixture(t, {onBind: async () => {}});
  f.config.ownerUserId = ''; f.transport.connected = true;
  const original = f.client.sendMessage;
  f.client.sendMessage = async (to, body) => { if (body.msgtype === 'template_card') throw Error('unsupported'); return original(to, body); };
  f.transport.accept(f.frame('fb', createBindCode(f.dir)));
  await f.transport.inbound; await turn();
  assert.ok(f.sent.some(m => m.to === 'owner' && m.body.markdown?.content === '绑定成功，Pi Remote 已连接，发送`帮助`查看命令。'));
});
