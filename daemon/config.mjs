import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
export const RUN_DIR = process.env.PI_REMOTE_HOME || path.join(os.homedir(), '.config', 'pi-remote-wecom');
export const CONFIG_FILE = path.join(RUN_DIR, 'config.json');
export const WELCOME_FILE = 'welcome.json'; // 已发送主动欢迎的标记
export const RESTART_FILE = 'restart.json'; // 待通知的重启标记：优雅退出前写入，下次连上后消费一次
export const RESTART_NOTICE_TTL_MS = 10 * 60 * 1000; // 停止后长期未启动则不再通知
export const BIND_FILE = 'bind.json'; // 待绑定的一次性绑定码
export const BIND_TTL_MS = 10 * 60 * 1000;
export const BIND_MAX_FAILURES = 5;
// 版本唯一来源为 package.json，避免升级后 startService 误判已是新版而跳过重启。
export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const DEFAULTS = {
  botId: '', secret: '', ownerUserId: '', localPort: 18778,
  terminal: 'auto', tmuxSession: 'pi', kittySocket: '', dirAliases: {home: '~'}, helpAliases: null,
  piBin: 'pi', statusKey: 'bridge', statusLabelFg: '240;240;240',
  nameWaitMs: 5000, inboxDir: path.join(RUN_DIR, 'inbox'),
  agentDir: process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'),
  tabTitleEnabled: true,
  // 手机发起的任务里，扩展弹窗转到企微卡片。confirm 超时策略：ask-then-allow（默认）| ask | allow。
  remoteConfirm: 'ask-then-allow', remoteConfirmTimeoutMs: 180000,
};
export function loadConfig() {
  let user = {};
  try { user = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw new Error('遥控配置无效，请检查 config.json'); }
  const cfg = {...DEFAULTS, ...user};
  if (cfg.wsUrl) {
    const endpoint = new URL(cfg.wsUrl);
    if (endpoint.protocol !== 'wss:' && !(endpoint.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname))) throw new Error('wsUrl 必须使用 wss（本机测试服务除外）');
  }
  if (process.env.PI_REMOTE_PORT) cfg.localPort = Number(process.env.PI_REMOTE_PORT);
  if (!Number.isInteger(cfg.localPort) || cfg.localPort < 1024 || cfg.localPort > 65535) throw new Error('localPort 无效');
  if (!cfg.dirAliases || typeof cfg.dirAliases !== 'object' || Object.values(cfg.dirAliases).some(v => typeof v !== 'string')) throw new Error('dirAliases 无效');
  if (!['ask-then-allow', 'ask', 'allow'].includes(cfg.remoteConfirm)) throw new Error('remoteConfirm 只能是 ask-then-allow、ask 或 allow');
  // 上限 1 天：超过 2^31-1 的 setTimeout 会立即触发，等于直接放行。
  if (!Number.isFinite(cfg.remoteConfirmTimeoutMs) || cfg.remoteConfirmTimeoutMs < 1000 || cfg.remoteConfirmTimeoutMs > 86400000) throw new Error('remoteConfirmTimeoutMs 需在 1000–86400000 毫秒之间');
  return cfg;
}
const validField = v => typeof v === 'string' && v.trim() && !/[\r\n\0]/.test(v);
// ownerUserId 可留空：daemon 进入待绑定状态，由主人在企微单聊发送一次性绑定码完成绑定。
export function validateCredentials(cfg) {
  if (![cfg.botId, cfg.secret].every(validField)) throw new Error('需要 botId、secret；请运行 /remote setup');
  if (cfg.ownerUserId && !validField(cfg.ownerUserId)) throw new Error('ownerUserId 无效；请运行 /remote setup');
}
/** 生成 6 位绑定码并写入运行目录（600），返回明文供电脑端展示。 */
export function createBindCode(dir = RUN_DIR, now = Date.now()) {
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const file = path.join(dir, BIND_FILE);
  const tmp = file + '.' + crypto.randomUUID();
  try {
    fs.writeFileSync(tmp, JSON.stringify({code, expiresAt: now + BIND_TTL_MS, failures: 0}), {mode: 0o600, flag: 'wx'});
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, {force: true}); }
  return code;
}
export function saveConfig(cfg) {
  validateCredentials(cfg);
  fs.mkdirSync(RUN_DIR, {recursive: true, mode: 0o700});
  const tmp = CONFIG_FILE + '.' + crypto.randomUUID();
  try {
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
    fs.renameSync(tmp, CONFIG_FILE);
  } finally { fs.rmSync(tmp, {force: true}); }
  ensureToken();
}
/** 只改磁盘上的 ownerUserId，避免把环境变量覆盖或默认值写回配置。 */
export function saveOwner(userid) {
  let user = {};
  try { user = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  saveConfig({...user, ownerUserId: userid});
}
export function ensureToken() {
  fs.mkdirSync(RUN_DIR, {recursive: true, mode: 0o700});
  const file = path.join(RUN_DIR, '.token');
  try { fs.writeFileSync(file, crypto.randomBytes(32).toString('base64url'), {flag: 'wx', mode: 0o600}); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  return fs.readFileSync(file, 'utf8').trim();
}
