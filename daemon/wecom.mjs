import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {WSClient} from '@wecom/aibot-node-sdk';
import {WELCOME_FILE, BIND_FILE, BIND_MAX_FAILURES} from './config.mjs';

export const PENDING_MEDIA_TTL_MS = 5 * 60 * 1000;
export const MARKDOWN_MAX_BYTES = 20_000;
// 企微回调侧上限。官方文档（开发者中心「接收消息」）表述为「仅支持 100M 大小以内的文件
// 与视频回调」，未给出精确字节定义；本项目按 100 MiB（104,857,600 字节）实现。
// 该检查发生在完整下载并解密之后（SDK 的 downloadFile 返回整个 Buffer），因此它只能
// 拦住超限结果继续落盘，并不能降低下载/解密期间的峰值内存。
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MARKDOWN_ATTACHMENT_NOTICE = '正文超过企微单条消息上限，已作为 Markdown 附件发送。';

// Keep one Markdown message below the project's 20,000-byte safety limit.
// This is deliberately below WeCom's documented 20,480-byte ceiling.
export function splitMarkdown(text, limit = MARKDOWN_MAX_BYTES) {
  const parts = []; let part = ''; let bytes = 0;
  for (const char of String(text)) {
    const n = Buffer.byteLength(char);
    if (bytes + n > limit) { parts.push(part); part = ''; bytes = 0; }
    part += char; bytes += n;
  }
  if (part) parts.push(part);
  return parts;
}
function markdownSteps(text, dir) {
  const value = String(text || '');
  if (Buffer.byteLength(value) <= MARKDOWN_MAX_BYTES)
    return splitMarkdown(value).map(textPart => ({kind: 'text', text: textPart}));
  const file = path.join(dir, `message-${Date.now()}-${crypto.randomUUID()}.md`);
  fs.writeFileSync(file, value, {mode: 0o600, flag: 'wx'});
  return [
    {kind: 'text', text: MARKDOWN_ATTACHMENT_NOTICE},
    {kind: 'file', file},
  ];
}
export function nativeCard(card) {
  if (card.card_type !== 'vote_interaction') return card;
  return {
    card_type: 'vote_interaction', main_title: {title: card.title, ...(card.desc ? {desc: card.desc} : {})}, task_id: card.task_id,
    checkbox: {question_key: card.task_id, mode: 0, option_list: card.options},
    submit_button: {text: card.submit_text || '选择会话', key: 'submit'},
  };
}
// Production callbacks nest fields inside template_card_event; older SDK examples flatten them.
export function cardEvent(event) {
  return event?.template_card_event ?? event ?? {};
}
// Keep the original card intact on update: only lock the options and relabel the submit button.
// WeCom's submit_button has no disable/style field; checkbox.disable greys out the options.
export function disabledSelectionCard(event, original) {
  const nested = cardEvent(event);
  const taskId = nested.task_id || original?.task_id || '';
  const selected = selectedIds(nested);
  if (original?.checkbox?.option_list?.length) {
    const chosen = new Set(selected);
    return {
      ...original,
      task_id: taskId,
      checkbox: {
        ...original.checkbox,
        disable: true,
        option_list: original.checkbox.option_list.map(option => ({...option, is_checked: chosen.has(option.id)})),
      },
      submit_button: {...original.submit_button, text: '已选择', key: original.submit_button?.key || 'submit'},
    };
  }
  // Original card unknown (e.g. very old card): minimal locked card.
  const optionIds = selected.length ? selected : ['selected'];
  return {
    card_type: 'vote_interaction',
    task_id: taskId,
    main_title: {title: '已收到选择', desc: '处理结果稍后送达'},
    checkbox: {
      question_key: taskId,
      mode: 0,
      disable: true,
      option_list: optionIds.map(id => ({id, text: '已选择', is_checked: true})),
    },
    submit_button: {text: '已选择', key: 'submit'},
  };
}
export function selectedIds(event) {
  event = cardEvent(event);
  const selected = event?.selected_items;
  const entries = Array.isArray(selected) ? selected : selected?.selected_item;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap(item => item.option_ids?.option_id || item.option_ids || [])
    .filter(id => typeof id === 'string');
}
export function messageParts(body) {
  const texts = []; const media = [];
  const add = (item) => {
    if (item.msgtype === 'text') texts.push(item.text?.content || '');
    else if (item.msgtype === 'voice') texts.push(item.voice?.content || '');
    else if (['image', 'file'].includes(item.msgtype)) {
      const file = item[item.msgtype];
      if (file?.url) media.push({...file, kind: item.msgtype});
    }
  };
  if (body.msgtype === 'mixed') for (const item of body.mixed?.msg_item || []) add(item);
  else add(body);
  return {text: texts.join('\n').trim(), media};
}
const writeJson = (file, value) => {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value), {mode: 0o600});
  fs.renameSync(tmp, file);
};

/** Exactly one daemon owns the bot. Only the configured owner's direct chat is accepted.
 * Durable outgoing queue is at-least-once: a lost server ACK may cause a duplicate.
 */
export const WELCOME = 'Pi Remote 已连接，发送`帮助`查看命令。';
export const BIND_DONE = '绑定成功，Pi Remote 已连接，发送`帮助`查看命令。';
/**
 * 绑定成功卡片（text_notice）。真机实测约束：main_title 必填；card_action 必须是有效跳转（type 0 或缺省会被拒收）。
 * 不用 source，避免与 main_title 重复显示「Pi Remote」。jump_list type 3 = 点击代用户发送 question。
 */
export const BIND_CARD = {
  card_type: 'text_notice',
  main_title: {title: 'Pi Remote'},
  emphasis_content: {title: '绑定成功', desc: '仅接收你的消息'},
  jump_list: [
    {type: 3, title: '活跃会话', question: '活跃会话'},
    {type: 3, title: '查看帮助', question: '帮助'},
  ],
  card_action: {type: 1, url: 'https://pi.dev'},
};
export const BIND_HINT = '尚未绑定。请在电脑 Pi 执行 `/remote bind`，把显示的 6 位绑定码发到这里。';
export class WeComTransport {
  constructor({config, dir, onMessage, onCard, onBind = () => {}, log = () => {}, client}) {
    this.config = config; this.dir = dir; this.log = log; this.onBind = onBind;
    this.onMessage = onMessage; this.onCard = onCard;
    this.connected = false; this.reason = '未连接'; this.working = false;
    this.sequence = 0; this.closed = false; this.inbound = Promise.resolve(); this.pendingMedia = [];
    this.outDir = path.join(dir, 'outbox'); fs.mkdirSync(this.outDir, {recursive: true, mode: 0o700});
    this.markdownDir = path.join(dir, 'markdown'); fs.mkdirSync(this.markdownDir, {recursive: true, mode: 0o700});
    this.cardsFile = path.join(dir, 'cards.json'); this.cards = new Map();
    try { this.cards = new Map(JSON.parse(fs.readFileSync(this.cardsFile, 'utf8'))); } catch {}
    this.seenFile = path.join(dir, 'seen.json'); this.seen = new Map();
    try { this.seen = new Map(JSON.parse(fs.readFileSync(this.seenFile, 'utf8'))); } catch {}
    // SDK debug logs contain credentials and signed attachment URLs: do not forward them.
    this.client = client || new WSClient({botId: config.botId, secret: config.secret,
      maxReconnectAttempts: -1, maxAuthFailureAttempts: 3, requestTimeout: 10000,
      ...(config.wsUrl ? {wsUrl: config.wsUrl} : {}),
      logger: {debug() {}, info() {}, warn() {}, error() {}}});
    this.welcomeFile = path.join(dir, WELCOME_FILE);
    this.client.on('authenticated', () => {
      this.connected = true; this.reason = this.bound() ? '已连接' : '已连接，待绑定验证';
      if (this.bound()) this.greetOnce();
      void this.flush();
    });
    this.client.on('disconnected', () => {this.connected = false; this.reason = '连接断开，等待重连';});
    this.client.on('reconnecting', () => {this.connected = false; this.reason = '重连中';});
    this.client.on('error', () => {this.reason = '连接或鉴权错误，请运行 /remote 查看';});
    this.client.on('event.disconnected_event', () => {
      this.connected = false; this.reason = '机器人被其他连接占用，请停用重复连接后重启';
      this.client.disconnect(); // Do not enter a bot takeover loop.
    });
    this.client.on('message', frame => this.accept(frame));
    this.client.on('event.template_card_event', frame => this.accept(frame, true));
    this.client.on('event.enter_chat', frame => {
      if (this.closed || this.draining) return;
      const content = this.authorized(frame.body) ? WELCOME : !this.bound() && this.bindable(frame.body) ? BIND_HINT : '';
      if (content) void this.client.replyWelcome(frame, {msgtype: 'text', text: {content}}).catch(() => {});
    });
  }
  /** Proactive welcome once per bot+owner; /remote setup clears the marker so each setup greets again. */
  greetOnce() {
    const key = `${this.config.botId}\n${this.config.ownerUserId}`;
    try { if (JSON.parse(fs.readFileSync(this.welcomeFile, 'utf8')).key === key) return; } catch {}
    try { writeJson(this.welcomeFile, {key}); } catch { this.log('欢迎标记写入失败'); return; }
    void this.send(WELCOME);
  }
  bound() {return Boolean(this.config.ownerUserId);}
  /** Direct chat to this bot from a real sender: the only shape that may bind or control. */
  bindable(body) {
    return typeof body?.from?.userid === 'string' && Boolean(body.from.userid)
      && (body?.chattype === 'single' || (!body?.chattype && !body?.chatid))
      && (!body.aibotid || body.aibotid === this.config.botId);
  }
  authorized(body) {
    return this.bound() && this.bindable(body) && body.from.userid === this.config.ownerUserId;
  }
  /**
   * Unbound daemon: the first direct-chat sender who presents the current one-time code becomes owner.
   * Code lives in bind.json (600), expires, and is burned after BIND_MAX_FAILURES wrong 6-digit guesses.
   * Replies go straight to the sender, never through the owner outbox.
   */
  async tryBind(body, text) {
    const to = body.from.userid;
    const reply = content => this.client.sendMessage(to, {msgtype: 'markdown', markdown: {content}}).catch(() => {});
    const file = path.join(this.dir, BIND_FILE);
    let pending = null;
    try { pending = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    if (this.bindLocked) { this.log('绑定：已锁定'); return reply('绑定已锁定，请在电脑 Pi 执行 `/remote bind` 重新获取绑定码。'); }
    const valid = pending && typeof pending.code === 'string' && pending.expiresAt > Date.now()
      && (pending.failures || 0) < BIND_MAX_FAILURES;
    const guess = String(text || '').trim();
    if (!/^\d{6}$/.test(guess)) { this.log('绑定：收到非绑定码消息'); return reply(BIND_HINT); }
    if (!valid) { this.log('绑定：无有效绑定码'); return reply('绑定码无效或已过期。请在电脑 Pi 执行 `/remote bind` 重新获取。'); }
    const ok = crypto.timingSafeEqual(Buffer.from(guess), Buffer.from(pending.code.padEnd(6).slice(0, 6)));
    if (!ok) {
      pending.failures = (pending.failures || 0) + 1;
      // Fail closed: if the counter cannot be persisted, burn the code instead of allowing unlimited guesses.
      try { writeJson(file, pending); }
      catch {
        pending.failures = BIND_MAX_FAILURES; this.bindLocked = true; // 进程内锁死，重启前不再受理任何绑定码
        try { fs.rmSync(file, {force: true}); } catch {}
        this.log('绑定：失败计数写入失败，绑定码已作废');
      }
      this.log(`绑定：绑定码错误 ${pending.failures}/${BIND_MAX_FAILURES}`);
      return reply(pending.failures >= BIND_MAX_FAILURES
        ? '错误次数过多，绑定码已作废。请在电脑 Pi 执行 `/remote bind` 重新获取。' : '绑定码不正确，请核对电脑上显示的 6 位数字。');
    }
    try { await this.onBind(to); }
    catch { this.log('绑定：写入配置失败'); return reply('电脑端保存绑定失败，请查看 /remote 状态后重试。'); }
    this.config.ownerUserId = to; this.reason = this.connected ? '已连接' : this.reason;
    fs.rmSync(file, {force: true});
    this.log('绑定：已绑定主人');
    // One merged message replaces the separate welcome; mark it sent so greetOnce stays quiet.
    try { writeJson(this.welcomeFile, {key: `${this.config.botId}\n${to}`}); } catch {}
    // Owner is set now, so the durable outbox applies; card failure falls back to the plain text.
    await this.send({card: {...BIND_CARD, task_id: `bind_${Date.now()}`}, fallback: BIND_DONE});
  }
  start() {
    this.client.connect();
    this.timer = setInterval(() => void this.flush(), 5000); this.timer.unref();
  }
  /** Shutdown: refuse new inbound immediately, keep the socket only to flush replies already queued. */
  drain() {this.draining = true;}
  stop() {this.closed = true; clearInterval(this.timer); clearTimeout(this.ackTimer); this.client.disconnect(); this.connected = false;}
  status() {return {connected: this.connected, reason: this.reason, bound: this.bound(), pending: this.queueFiles().length};}
  rememberCard(card) {
    if (!card?.task_id || card.card_type !== 'vote_interaction') return;
    this.cards.delete(card.task_id); this.cards.set(card.task_id, card);
    while (this.cards.size > 100) this.cards.delete(this.cards.keys().next().value);
    try { writeJson(this.cardsFile, [...this.cards]); } catch { this.log('卡片缓存写入失败'); }
  }
  queueFiles() {return fs.readdirSync(this.outDir).filter(f => f.endsWith('.json')).sort();}
  expirePendingMedia(now = Date.now()) {
    const expired = this.pendingMedia.filter(item => now - item.at >= PENDING_MEDIA_TTL_MS);
    if (!expired.length) return 0;
    this.pendingMedia = this.pendingMedia.filter(item => now - item.at < PENDING_MEDIA_TTL_MS);
    for (const item of expired) {
      try { fs.unlinkSync(item.local); }
      catch (error) {
        if (error?.code !== 'ENOENT') this.log('过期附件清理失败，请检查收件目录');
      }
    }
    return expired.length;
  }
  send(message) {
    if (!this.bound()) { this.log('未绑定主人，丢弃待发消息'); return Promise.resolve(false); }
    const packet = typeof message === 'string' ? {text: message} : message;
    if (!packet.text && !packet.card && !packet.file) return Promise.resolve(true);
    const file = path.join(this.outDir, `${Date.now()}-${String(this.sequence++).padStart(8, "0")}-${crypto.randomUUID()}.json`);
    // Explicit fields: never serialize credentials, callbacks or model/context objects.
    const steps = [];
    if (packet.card) steps.push({kind: 'card', card: nativeCard(packet.card), fallback: packet.fallback});
    else steps.push(...markdownSteps(packet.text || '', this.markdownDir));
    if (packet.file) steps.push({kind: 'file', file: packet.file});
    writeJson(file, {recipient: this.config.ownerUserId, steps, cursor: 0, attempts: 0});
    void this.flush(); return Promise.resolve(true); // true means durably queued, not server-delivered.
  }
  async flush() {
    if (!this.connected || this.closed || this.working) return;
    this.working = true;
    try {
      for (const name of this.queueFiles()) {
        if (!this.connected || this.closed) break;
        const file = path.join(this.outDir, name);
        const packet = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (packet.recipient !== this.config.ownerUserId) continue; // never reroute old owner's results
        if (packet.retryAt > Date.now()) break;
        try {
          for (; packet.cursor < packet.steps.length; packet.cursor++) {
            const step = packet.steps[packet.cursor];
            if (step.kind === 'text') await this.client.sendMessage(packet.recipient, {msgtype: 'markdown', markdown: {content: step.text}});
            if (step.kind === 'card') {
              try {
                await this.client.sendMessage(packet.recipient, {msgtype: 'template_card', template_card: step.card});
                this.rememberCard(step.card);
              }
              catch (e) {
                // errcode/errmsg only: never log card body, recipient or credentials.
                this.log(`卡片发送失败 type=${step.card?.card_type} errcode=${e?.errcode ?? '-'} errmsg=${String(e?.errmsg ?? e?.message ?? '').slice(0, 200)}`);
                if (!step.fallback || !this.connected) throw e;
                // Save the downgrade before sending. Raw card JSON is never shown to the user.
                packet.steps.splice(packet.cursor, 1, ...markdownSteps(step.fallback, this.markdownDir));
                writeJson(file, packet); packet.cursor--; continue;
              }
            }
            if (step.kind === 'file') {
              const media = await this.client.uploadMedia(fs.readFileSync(step.file), {type: 'file', filename: path.basename(step.file)});
              await this.client.sendMediaMessage(packet.recipient, 'file', media.media_id);
            }
            writeJson(file, {...packet, cursor: packet.cursor + 1});
          }
          fs.unlinkSync(file);
        } catch {
          packet.attempts++; packet.retryAt = Date.now() + Math.min(300000, 2000 * 2 ** Math.min(packet.attempts, 7));
          writeJson(file, packet); this.log('企微发送失败，已保留待重试'); break;
        }
      }
    } catch {this.log('发件箱读写失败，请检查运行目录');}
    finally {this.working = false;}
  }
  accept(frame, card = false) {
    if (this.closed || this.draining) return;
    const body = frame.body;
    const allowed = this.authorized(body);
    // Record routing decisions, never message text, sender IDs, credentials or URLs.
    this.lastInbound = {at: new Date().toISOString(), kind: card ? 'card' : 'message',
      allowed, ownerMatches: body?.from?.userid === this.config.ownerUserId,
      botMatches: !body?.aibotid || body.aibotid === this.config.botId,
      chatType: ['single', 'group'].includes(body?.chattype) ? body.chattype : 'other',
      hasChatId: Boolean(body?.chatid), hasMessageId: typeof body?.msgid === 'string' && Boolean(body.msgid)};
    this.log(`企微入站 ${JSON.stringify(this.lastInbound)}`);
    const binding = !this.bound() && !card && this.bindable(body);
    if (!allowed && !binding) return;
    const id = frame.body?.msgid;
    if (typeof id !== 'string' || !id) return;
    const now = Date.now();
    for (const [key, at] of this.seen) if (now - at > 86400000) this.seen.delete(key);
    if (this.seen.has(id)) return;
    this.seen.set(id, now);
    if (this.seen.size > 10000) this.seen.delete(this.seen.keys().next().value);
    writeJson(this.seenFile, [...this.seen]);
    if (binding) {
      // Never download attachments or reach Pi before an owner exists. Re-check inside the queue:
      // an earlier queued message may have bound someone meanwhile.
      const {text} = messageParts(body);
      this.inbound = this.inbound.then(() => {
        if (!this.bound()) return this.tryBind(body, text);
        // Arrived before the bind finished: never replay (ordering vs. later messages is not guaranteed).
        if (this.authorized(body)) return this.send('绑定已完成，绑定前发送的这条消息未处理，请重新发送。');
      })
        .catch(() => this.log('绑定处理失败'));
      return;
    }
    // ACK card clicks immediately, independently of slow history scans/new processes.
    if (card) void this.client.updateTemplateCard(frame,
      disabledSelectionCard(body.event, this.cards.get(cardEvent(body.event).task_id)))
      .catch(() => this.log('卡片更新失败，继续处理选择'));
    // Download immediately: URLs expire in five minutes, command queue can be slow.
    const prepared = card ? null : this.prepare(frame.body).then(value => ({value}), () => ({error: true}));
    this.inbound = this.inbound.then(async () => {
      if (card) {
        const event = cardEvent(frame.body.event);
        const reply = await this.onCard({taskId: event.task_id, optionId: selectedIds(event)[0], eventKey: event.event_key});
        await this.send(reply); return;
      }
      const result = await prepared;
      if (result.error) {await this.send('附件下载失败，本条消息未投递，请重新发送。'); return;}
      const {text, media} = result.value;
      const expiredCount = this.expirePendingMedia();
      const expiryNotice = expiredCount
        ? `之前的 ${expiredCount} 个附件已超过 5 分钟并过期，已清理，未与本条消息关联。需要处理它们请重新发送附件和说明文字。`
        : '';
      if (!text && media.length) {
        this.pendingMedia.push(...media.map(item => ({...item, at: now})));
        this.pendingMedia = this.pendingMedia.slice(-4);
        // 多附件会拆成多条入站消息：防抖合并，只回复一条，按暂存总数区分单个/多个。
        if (expiryNotice) this.ackNotice = expiryNotice;
        clearTimeout(this.ackTimer);
        this.ackTimer = setTimeout(() => {
          const n = this.pendingMedia.length, notice = this.ackNotice; this.ackNotice = '';
          if (!n) return;
          const tip = n === 1
            ? '附件已收到，请在 5 分钟内补充说明文字；随后将和该附件一并发送。'
            : `${n} 个附件已收到，请在 5 分钟内补充说明文字；随后将和这 ${n} 个附件一并发送。`;
          void this.send([notice, tip].filter(Boolean).join('\n')).catch(() => this.log('附件确认发送失败'));
        }, 1500);
        this.ackTimer.unref?.();
        return;
      }
      clearTimeout(this.ackTimer);
      if (this.ackNotice) {await this.send(this.ackNotice); this.ackNotice = '';}
      if (!text) {
        await this.send([expiryNotice, '暂不支持这类消息，请发送文字、图片、文件或语音。'].filter(Boolean).join('\n')); return;
      }
      if (expiryNotice) await this.send(expiryNotice);
      const files = [...this.pendingMedia, ...media];
      if (files.length > 4) {await this.send('一次最多处理 4 个附件，请减少附件后重试。'); return;}
      const ack = {media: false};
      const reply = await this.onMessage(text, files, ack);
      if (ack.media) this.pendingMedia = [];
      else if (media.length) this.pendingMedia.push(...media.map(item => ({...item, at: now})));
      await this.send(reply);
    }).catch(async () => {this.log('入站处理失败'); await this.send('电脑端处理失败；消息可能未投递，请查询状态后重试。');});
  }
  async prepare(body) {
    const parts = messageParts(body);
    if (parts.media.length > 4) throw new Error('too many files');
    const dir = this.config.inboxDir.replace(/^~(?=\/|$)/, process.env.HOME);
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    const media = [];
    // 本批独占创建的文件路径。登记时机早于写入完成，任何失败出口都能据此回滚。
    const owned = new Set();
    // 整条消息要么全投递、要么全不投递：中途失败时回滚本批已落盘的文件。
    // 这些文件从未进入 pendingMedia，超时清理覆盖不到，只能在这里删除。
    // 这是异常路径下的尽力回滚，不是崩溃一致性事务：进程被杀、unlink 自身失败等
    // 仍可能留下文件（后者记日志），不应理解为无条件保证。
    const discard = () => {for (const local of owned) {try {fs.unlinkSync(local);}
      catch (error) {if (error?.code !== 'ENOENT') this.log('失败批次附件回滚失败，请检查收件目录');}}};
    try {
      for (const item of parts.media) {
        const url = new URL(item.url);
        if (url.protocol !== 'https:') throw new Error('invalid media URL');
        const {buffer, filename} = await this.client.downloadFile(item.url, item.aeskey);
        if (buffer.length > MAX_ATTACHMENT_BYTES) throw new Error('file too large');
        const name = (filename || (item.kind === 'image' ? '图片.png' : '附件.bin')).replace(/[\p{Cc}\p{Cf}/\\]/gu, '_').slice(0, 100);
        const local = path.join(dir, `${crypto.randomUUID()}-${name}`);
        // 先独占创建并登记归属，再写入：写入本身可能中途失败（如 ENOSPC），
        // 那时文件已存在但还没进入 media，只有提前登记才能被 discard 回收。
        // 'wx' 失败（如 EEXIST）意味着文件不是本批创建的，不得登记、也不得删除。
        const fd = fs.openSync(local, 'wx', 0o600);
        owned.add(local);
        try {fs.writeFileSync(fd, buffer);}
        catch (error) {
          // 关闭失败不得掩盖真正的写入错误；fd 最迟随进程退出释放。
          try {fs.closeSync(fd);} catch {}
          throw error;
        }
        fs.closeSync(fd);
        media.push({local, name, kind: item.kind, bytes: buffer.length});
      }
    } catch (error) {discard(); throw error;}
    return {text: parts.text, media};
  }
}
