import fs from 'node:fs';
import path from 'node:path';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {getAgentDir} from '@earendil-works/pi-coding-agent';
import remote from './remote.ts';
import {aliasCommand, aliasCompletions} from './alias.ts';
import tabTitle, {namingEnabled} from '../vendor/tab-title/index.ts';
import {RUN_DIR, WELCOME_FILE, BIND_FILE, BIND_TTL_MS, loadConfig, saveConfig, createBindCode} from '../daemon/config.mjs';
import {health, startService, stopService, restartService} from '../daemon/service.mjs';

const SUBCOMMANDS: [string, string][] = [
  ['setup', '配置'], ['bind', '重新绑定'], ['restart', '重启'], ['stop', '停止'], ['alias', '目录别名'],
];
const configured = (cfg: {botId: string; secret: string}) => !!(cfg.botId && cfg.secret);
const BIND_MANUAL = '手动填写 userid（形如 T12345678A）';
const BIND_CODE = '企微发送绑定码（推荐，无需查 userid）';
const BIND_KEEP = '保留当前绑定';
/** 清空主人 → 生成绑定码 → (重)启服务；绑定码只显示在本机。 */
async function startBinding(ctx: any, save: () => void, prefix = '') {
  // 旧 daemon 仍持有旧主人：必须确认它已退出，再清空主人并发码，否则 startService 可能直接复用旧进程。
  // launchctl bootout 会等待进程退出；daemon 收到 SIGTERM 即拒收新入站。端口仍被占用说明有手动 run 的进程。
  await stopService();
  for (let i = 0; i < 20 && await health(); i++) await new Promise(r => setTimeout(r, 250));
  if (await health()) throw new Error('旧的遥控服务仍在运行（可能是手动 run 启动），请先停止后再绑定。');
  save();
  const code = createBindCode();
  const state = await startService();
  const minutes = Math.round(BIND_TTL_MS / 60000);
  // 只发一条：Pi 会用后一条 info 通知替换前一条，绑定码必须是最后一条。
  ctx.ui.notify(`${prefix}绑定码 ${code}（${minutes} 分钟内有效）：在企微单聊机器人发送这 6 位数字，完成后只接受你的消息。${state.connected ? '' : '服务正在连接企微。'}`, 'info');
  void watchBinding(ctx, Date.now() + BIND_TTL_MS);
}
/** 后台轮询绑定结果，在 Pi 界面回报成功/作废/过期；不阻塞命令。 */
async function watchBinding(ctx: any, deadline: number) {
  const bindFile = path.join(RUN_DIR, BIND_FILE);
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    const state = await health().catch(() => null);
    if (state?.bound) return ctx.ui.notify('企微绑定成功，手机遥控已可用。', 'info');
    if (state && !fs.existsSync(bindFile)) return ctx.ui.notify('绑定码已作废，执行 /remote bind 重新获取。', 'warning');
  }
  ctx.ui.notify('绑定码已过期，执行 /remote bind 重新获取。', 'warning');
}
function summary(state: any) {
  return state ? `${state.reason} · 活跃会话 ${state.targets.length} · v${state.version}` : '后台服务未运行';
}

export default function (pi: ExtensionAPI) {
  const cfg = loadConfig();
  // Legacy single-file install is common. Do not register the same commands twice.
  let legacyTitle = fs.existsSync(path.join(getAgentDir(), 'extensions', 'auto-tab-name', 'index.ts'));
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(getAgentDir(), 'settings.json'), 'utf8'));
    legacyTitle ||= (settings.packages || []).some((p: string | {source: string}) =>
      /(?:^|[/:])pi-(?:ghostty-)?tab-title(?:[@/#]|$)/.test(typeof p === 'string' ? p : p.source));
  } catch {}
  // Keep hook order: remote first, then naming. Legacy namers own their model settings, so assume they name sessions.
  remote(pi, {autoName: () => legacyTitle || (cfg.tabTitleEnabled && namingEnabled())});
  if (cfg.tabTitleEnabled && !legacyTitle) tabTitle(pi);
  pi.registerCommand('remote', {
    description: '企微多会话遥控：状态与 setup / restart / stop / alias',
    getArgumentCompletions: prefix => {
      const m = prefix.match(/^alias\s+([\s\S]*)$/);
      if (m) return aliasCompletions(m[1]).map(i => ({...i, value: `alias ${i.value}`}));
      if (/\s/.test(prefix)) return null;
      return SUBCOMMANDS.filter(([v]) => v.startsWith(prefix)).map(([value, description]) => ({value, label: value, description}));
    },
    handler: async (args, ctx) => {
      let action = args.trim().split(/\s+/)[0] || '';
      if (!action && !configured(loadConfig())) action = 'setup';
      if (!action) {
        const choice = await ctx.ui.select(`企微遥控 · ${summary(await health())}`, SUBCOMMANDS.map(([v, d]) => `${d} ${v}`));
        if (!choice) return;
        action = choice.split(' ').at(-1)!;
      }
      if (action === 'alias') return aliasCommand(args.trim().slice('alias'.length), ctx);
      try {
        if (action === 'setup') {
          const running = await health();
          if (running?.targets?.some((t: {busy: boolean}) => t.busy)) throw new Error('请先等遥控任务结束，再修改配置。');
          const existing = loadConfig();
          const botId = await ctx.ui.input('专用企微机器人 BotID（API 模式 → 长连接）', existing.botId);
          if (!botId) return;
          const secret = await ctx.ui.input('Bot Secret（仅在本机配置保存，不进入模型对话）');
          if (!secret) return;
          // 同一机器人重配时可保留主人；换机器人后企微 userid 仍有效，但仍需明确选择。
          const modes = existing.ownerUserId ? [BIND_KEEP, BIND_CODE, BIND_MANUAL] : [BIND_CODE, BIND_MANUAL];
          const mode = await ctx.ui.select('谁可以通过企微控制这台电脑？', modes);
          if (!mode) return;
          let ownerUserId = mode === BIND_KEEP ? existing.ownerUserId : '';
          if (mode === BIND_MANUAL) {
            ownerUserId = (await ctx.ui.input('允许控制电脑的企微 userid（不是显示姓名）', existing.ownerUserId))?.trim() || '';
            if (!ownerUserId) return;
          }
          const save = () => {
            saveConfig({...existing, botId: botId.trim(), secret: secret.trim(), ownerUserId, agentDir: getAgentDir()});
            fs.rmSync(path.join(RUN_DIR, WELCOME_FILE), {force: true}); // 重新配置后，下次连上再发一次欢迎
          };
          if (mode === BIND_CODE) {
            await startBinding(ctx, save, '配置已保存，已注册登录自启动。');
            return;
          }
          if (running) await stopService();
          save();
          if (await ctx.ui.confirm('启用手机遥控', '现在启动并注册登录自启动？关闭 Pi 后仍可从手机创建和管理会话。')) {
            const state = await startService();
            ctx.ui.notify(state.connected ? '企微已连接' : '后台服务已启动，正在连接企微；/remote 查看状态', 'info');
          }
          ctx.ui.notify('配置已保存，执行 /reload 可更新连接。', 'info');
        } else if (action === 'bind') {
          const existing = loadConfig();
          if (!configured(existing)) throw new Error('请先执行 /remote setup 填写 BotID 和 Secret。');
          if (existing.ownerUserId && !(await ctx.ui.confirm('重新绑定', '将解除当前绑定，在企微发送新绑定码后恢复遥控。继续？'))) return;
          await startBinding(ctx, () => saveConfig({...existing, ownerUserId: ''}));
        } else if (action === 'start' || action === 'restart') {
          // Merged: start when stopped, restart (idle-checked) when running so config/upgrades take effect.
          const state = (await health()) ? await restartService() : await startService();
          ctx.ui.notify(state.connected ? '企微已连接' : '服务已启动，等待企微连接；/remote 查看状态', 'info');
        } else if (action === 'stop') {
          await stopService(); ctx.ui.notify('遥控已停止，/remote restart 恢复；已有终端会话保留。', 'info');
        } else if (action === 'status' || action === 'doctor') {
          // Hidden legacy alias: /remote itself now shows status.
          ctx.ui.notify(summary(await health()), 'info');
        } else ctx.ui.notify('用法：/remote（状态与菜单）| setup | bind | restart | stop | alias', 'warning');
      } catch (error) {ctx.ui.notify((error as Error).message, 'error');}
    },
  });
}
