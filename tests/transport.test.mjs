import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import {WeComTransport, PENDING_MEDIA_TTL_MS, MAX_ATTACHMENT_BYTES, selectedIds, disabledSelectionCard, splitMarkdown} from '../daemon/wecom.mjs';
import {plist} from '../daemon/service.mjs';
const turn = () => new Promise(r => setTimeout(r, 15));
function fixture(t, handlers = {}, reuseDir = null) {
  const dir = reuseDir || fs.mkdtempSync(path.join(os.tmpdir(), 'pi-wecom-test-'));
  const client = new EventEmitter(); const sent = []; const updates = [];
  Object.assign(client, {connect() {}, disconnect() {},
    async sendMessage(to, body) {sent.push({to, body});},
    async updateTemplateCard(frame, card) {updates.push(card);},
    async downloadFile() {return {buffer: Buffer.from('image'), filename: '../../photo.png'};},
  });
  const config = {botId: 'test-bot', secret: 'test-secret', ownerUserId: 'owner', inboxDir: path.join(dir, 'inbox')};
  const transport = new WeComTransport({config, dir, client, onMessage: async () => 'ok', onCard: async () => 'selected', ...handlers});
  t.after(() => {transport.stop(); if (!reuseDir) fs.rmSync(dir, {recursive: true, force: true});});
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
test('附件单件上限为企微回调上限：恰好 100MB 受理，超 1 字节整条不投递', async t => {
  assert.equal(MAX_ATTACHMENT_BYTES, 100 * 1024 * 1024);
  const delivered = [];
  const f = fixture(t, {onMessage: async (text, files) => {delivered.push({text, files}); return 'ok';}});
  f.transport.connected = true;
  f.client.downloadFile = async () => ({buffer: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1), filename: 'big.bin'});
  // 带正文的 mixed 消息：若超限件被错误受理，onMessage 会被调用，断言才有判别力。
  f.transport.accept(f.frame('over','看这个文件',{msgtype:'mixed',mixed:{msg_item:[
    {msgtype:'text',text:{content:'看这个文件'}},
    {msgtype:'file',file:{url:'https://example.test/b',aeskey:'test'}}]}}));
  await f.transport.inbound;
  assert.equal(f.transport.pendingMedia.length, 0);
  assert.match(f.sent.map(item => item.body.markdown?.content || '').join('\n'), /附件下载失败/);
  assert.deepEqual(fs.readdirSync(f.transport.config.inboxDir), []);
  // 超限批次不得进入 Pi：provider 未收到任何调用。
  assert.equal(delivered.length, 0);
  // 上限本身是允许值：拒绝条件是 > 而不是 >=。
  const ok = fixture(t);
  ok.transport.connected = true;
  ok.client.downloadFile = async () => ({buffer: Buffer.alloc(MAX_ATTACHMENT_BYTES), filename: 'limit.bin'});
  ok.transport.accept(ok.frame('at-limit','',{msgtype:'file',file:{url:'https://example.test/b',aeskey:'test'}}));
  await ok.transport.inbound;
  assert.equal(ok.transport.pendingMedia.length, 1);
});
test('批次中途失败时回滚本批已落盘附件，不留下孤儿文件', async t => {
  const f = fixture(t); const inbox = f.transport.config.inboxDir;
  let n = 0;
  f.client.downloadFile = async () => {
    if (++n === 1) return {buffer: Buffer.from('first'), filename: 'first.bin'};
    throw new Error('simulated failure');
  };
  // 前一件成功、后一件失败：整条不投递，已写出的那个必须被删掉。
  const body = {msgid: 'm', aibotid: 'test-bot', chattype: 'single', from: {userid: 'owner'},
    msgtype: 'mixed', mixed: {msg_item: [
      {msgtype: 'text', text: {content: '看这两个文件'}},
      {msgtype: 'file', file: {url: 'https://example.test/1', aeskey: 'k'}},
      {msgtype: 'file', file: {url: 'https://example.test/2', aeskey: 'k'}},
    ]}};
  await assert.rejects(f.transport.prepare(body), /simulated failure/);
  assert.deepEqual(fs.readdirSync(inbox), []);
});
test('写入中途失败（如 ENOSPC）回滚本批文件，不留下残片', async t => {
  const f = fixture(t); const inbox = f.transport.config.inboxDir;
  let n = 0;
  f.client.downloadFile = async () => ({buffer: Buffer.from('first'), filename: `f${++n}.bin`});
  // 第二件：先真实写入部分字节再抛错，模拟「文件已创建且不完整」的中途失败。
  const realWriteFileSync = fs.writeFileSync;
  let calls = 0;
  fs.writeFileSync = (fd, data, ...rest) => {
    if (++calls === 2) {
      realWriteFileSync(fd, Buffer.from(data).subarray(0, 1));
      const error = new Error('ENOSPC during write');
      error.code = 'ENOSPC';
      throw error;
    }
    return realWriteFileSync(fd, data, ...rest);
  };
  t.after(() => {fs.writeFileSync = realWriteFileSync;});
  const body = {msgid: 'm', aibotid: 'test-bot', chattype: 'single', from: {userid: 'owner'},
    msgtype: 'mixed', mixed: {msg_item: [
      {msgtype: 'file', file: {url: 'https://example.test/1', aeskey: 'k'}},
      {msgtype: 'file', file: {url: 'https://example.test/2', aeskey: 'k'}},
    ]}};
  await assert.rejects(f.transport.prepare(body), /ENOSPC/);
  fs.writeFileSync = realWriteFileSync;
  // 第一件（已写完）与第二件（半写残片）都必须被清掉。
  assert.deepEqual(fs.readdirSync(inbox), []);
  assert.equal(calls, 2);
});
test('独占创建失败时不得删除已存在的同名文件（EEXIST 不误删）', async t => {
  const f = fixture(t); const inbox = f.transport.config.inboxDir;
  fs.mkdirSync(inbox, {recursive: true});
  // 伪造一个由上一批创建的文件，并让本批算出同名路径，使 openSync('wx') 以 EEXIST 失败。
  const realRandomUUID = crypto.randomUUID;
  crypto.randomUUID = () => 'fixed';
  t.after(() => {crypto.randomUUID = realRandomUUID;});
  const occupied = path.join(inbox, 'fixed-occupied.bin');
  fs.writeFileSync(occupied, 'not ours');
  f.client.downloadFile = async () => ({buffer: Buffer.from('x'), filename: 'occupied.bin'});
  await assert.rejects(f.transport.prepare({msgid: 'm', aibotid: 'test-bot', chattype: 'single',
    from: {userid: 'owner'}, msgtype: 'file', file: {url: 'https://example.test/1', aeskey: 'k'}}),
    error => error.code === 'EEXIST');
  crypto.randomUUID = realRandomUUID;
  // 该文件不是本批创建的，必须原样保留。
  assert.deepEqual(fs.readdirSync(inbox), ['fixed-occupied.bin']);
  assert.equal(fs.readFileSync(occupied, 'utf8'), 'not ours');
});
test('多件全部成功：落盘内容、长度与权限一致，整批返回', async t => {
  const f = fixture(t);
  const payloads = ['alpha', 'beta-payload', 'g']; // 长度不一，防止只验证文件名
  let n = 0;
  f.client.downloadFile = async () => ({buffer: Buffer.from(payloads[n]), filename: `p${++n}.bin`});
  const body = {msgid: 'm', aibotid: 'test-bot', chattype: 'single', from: {userid: 'owner'},
    msgtype: 'mixed', mixed: {msg_item: payloads.map((_, i) => ({msgtype: 'file', file: {url: `https://example.test/${i}`, aeskey: 'k'}}))}};
  const {text, media} = await f.transport.prepare(body);
  assert.equal(text, '');
  assert.equal(media.length, 3);
  // 两阶段 fd 写入后仍必须保证：字节数一致、内容完整、权限 600。
  media.forEach((item, i) => {
    assert.equal(item.bytes, Buffer.byteLength(payloads[i]));
    assert.equal(fs.readFileSync(item.local, 'utf8'), payloads[i]);
    assert.equal(fs.statSync(item.local).size, Buffer.byteLength(payloads[i]));
    assert.equal(fs.statSync(item.local).mode & 0o777, 0o600);
  });
});
test('投递侧与下载侧共用同一上限，不退回裸常量', async t => {
  // daemon.mjs 在模块顶层启动服务，无法 import；这里用源码静态检查守住两侧一致。
  // 目的：防止将来只改一侧，或把投递侧退回 20MB 裸常量而下载侧测试仍然全绿。
  const source = fs.readFileSync(new URL('../daemon/daemon.mjs', import.meta.url), 'utf8');
  assert.match(source, /import \{[^}]*MAX_ATTACHMENT_BYTES[^}]*\} from "\.\/wecom\.mjs"/);
  assert.match(source, /stat\.size > MAX_ATTACHMENT_BYTES/);
  assert.doesNotMatch(source, /20 \* 1024 \* 1024/);
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
test('停机留下重启标记，新进程连上后主动通知一次，且不走欢迎去重', async t => {
  const a = fixture(t);
  a.transport.start();
  a.client.emit('authenticated'); await turn();
  a.transport.drain(); // 优雅退出
  assert.ok(fs.existsSync(a.transport.restartFile), '退出前应留下标记');
  const b = fixture(t, {}, a.dir);
  b.transport.start();
  b.client.emit('authenticated'); await turn();
  assert.deepEqual(b.sent.map(m=>m.body.markdown?.content), ['Pi Remote 已重启，企微已连接，发送`帮助`查看命令。']);
  // 标记为一次性：同一进程内的后续重连不再重复通知。
  b.client.emit('authenticated'); await turn();
  assert.equal(b.sent.length, 1);
  assert.equal(fs.existsSync(b.transport.restartFile), false);
});
test('单纯的网络重连不发重启通知；过期标记被丢弃', async t => {
  const f = fixture(t); f.transport.start();
  f.client.emit('authenticated'); await turn();
  f.client.emit('reconnecting'); f.client.emit('authenticated'); await turn();
  assert.deepEqual(f.sent.map(m=>m.body.markdown?.content), ['Pi Remote 已连接，发送`帮助`查看命令。']);
  // 隔天才开机：不补发早已无关的通知。
  const stale = fixture(t);
  fs.writeFileSync(stale.transport.restartFile, JSON.stringify({at: Date.now() - 11 * 60 * 1000, botId: 'test-bot'}));
  stale.transport.start(); stale.client.emit('authenticated'); await turn();
  assert.deepEqual(stale.sent.map(m=>m.body.markdown?.content), ['Pi Remote 已连接，发送`帮助`查看命令。']);
  assert.equal(fs.existsSync(stale.transport.restartFile), false);
  // 换了机器人（换了配置）也不能把标记算在自己头上。
  const other = fixture(t);
  fs.writeFileSync(other.transport.restartFile, JSON.stringify({at: Date.now(), botId: 'another-bot'}));
  other.transport.start(); other.client.emit('authenticated'); await turn();
  assert.deepEqual(other.sent.map(m=>m.body.markdown?.content), ['Pi Remote 已连接，发送`帮助`查看命令。']);
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
