import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {RUN_DIR, loadConfig, ensureToken, validateCredentials, VERSION} from './config.mjs';
const exec = promisify(execFile);
export const LABEL = 'dev.pi-remote-wecom.daemon';
const domain = () => `gui/${process.getuid()}`;
export const SERVICE_FILE = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const xml = s => String(s).replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
export function plist({node = process.execPath, packageRoot = root, runDir = RUN_DIR, envPath = process.env.PATH || ''} = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(path.join(packageRoot, 'daemon', 'daemon.mjs'))}</string></array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(envPath)}</string><key>PI_REMOTE_HOME</key><string>${xml(runDir)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(path.join(runDir, 'service.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(runDir, 'service.log'))}</string>
</dict></plist>\n`;
}
export async function health() {
  const cfg = loadConfig();
  let token;
  try {token = fs.readFileSync(path.join(RUN_DIR, '.token'), 'utf8').trim();} catch {return null;}
  try {
    const response = await fetch(`http://127.0.0.1:${cfg.localPort}/health`, {
      headers: {'x-pi-token': token}, signal: AbortSignal.timeout(1500)});
    if (!response.ok) return null;
    const value = await response.json();
    return value.service === 'pi-remote-wecom' ? value : null;
  } catch {return null;}
}
function macOnly() {if (process.platform !== 'darwin') throw new Error('自动服务管理目前支持 macOS；其他系统可用 pi-remote-wecom run 前台运行。');}
async function assertIdle() {
  const h = await health();
  if (h?.targets?.some(t => t.busy)) throw new Error('仍有任务运行，请等任务结束或先中断，再维护后台服务。');
}
export async function stopService() {
  macOnly(); await assertIdle();
  try {await exec('launchctl', ['bootout', `${domain()}/${LABEL}`], {timeout: 15000});}
  catch (e) {
    // Already absent is fine; an installed service that cannot stop must be reported.
    try {await exec('launchctl', ['print', `${domain()}/${LABEL}`], {timeout: 3000});}
    catch {return;}
    throw new Error('无法停止后台服务，请检查 launchctl 状态');
  }
}
export async function startService() {
  macOnly();
  const cfg = loadConfig(); validateCredentials(cfg); ensureToken();
  const h = await health();
  if (h?.version === VERSION) return h;
  await assertIdle();
  await stopService();
  fs.mkdirSync(path.dirname(SERVICE_FILE), {recursive: true});
  fs.writeFileSync(SERVICE_FILE, plist(), {mode: 0o600});
  await exec('plutil', ['-lint', SERVICE_FILE], {timeout: 3000});
  await exec('launchctl', ['bootstrap', domain(), SERVICE_FILE], {timeout: 15000});
  for (let i = 0; i < 20; i++) {
    const ready = await health(); if (ready) return ready;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`服务未就绪，请检查 ${path.join(RUN_DIR, 'service.log')}（端口可能被占用）`);
}
export async function restartService() {await stopService(); return startService();}
export async function uninstallService() {
  await stopService(); fs.rmSync(SERVICE_FILE, {force: true});
  return '后台服务与登录自启动已移除；配置和凭证保留在本机。';
}
