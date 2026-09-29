import fs from 'node:fs';
import type {ExtensionCommandContext} from '@earendil-works/pi-coding-agent';
import {ALIASES_FILE, loadAliases, saveAliases, parseAliases, checkName, expandDir, tildeDir, missingDirs} from '../daemon/aliases.mjs';

type Table = Record<string, string>;
const RESERVED = new Set(['rm', 'edit', 'list', 'ls', 'help']);
const USAGE = '用法：/remote alias 打开菜单 · /remote alias 名称 [目录]（目录缺省为当前目录） · /remote alias rm 名称 · /remote alias edit 编辑配置表';
const ADD = '＋ 新增别名';
const EDIT = '✎ 编辑配置表';
const label = (n: string, d: string) => `${n}  →  ${d}${fs.existsSync(expandDir(d)) ? '' : '  （目录不存在）'}`;

function validName(name: string) {
  const n = checkName(name);
  if (RESERVED.has(n)) throw new Error(`「${n}」是保留字，换个名字`);
  return n;
}
function validDir(dir: string, cwd: string) {
  const raw = dir.trim() || cwd;
  const abs = expandDir(raw === '.' ? cwd : raw);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`目录不存在：${raw}`);
  return tildeDir(abs);
}
function set(name: string, dir: string, ctx: ExtensionCommandContext) {
  const n = validName(name), d = validDir(dir, ctx.cwd), table: Table = loadAliases();
  const before = table[n];
  saveAliases({...table, [n]: d});
  ctx.ui.notify(before && before !== d ? `已更新 ${n}：${before} → ${d}` : `已设置 ${n} → ${d}\n手机端：创建会话 ${n} 消息`, 'info');
}
function remove(name: string, ctx: ExtensionCommandContext) {
  const table: Table = loadAliases(), n = name.trim().toLowerCase();
  if (!(n in table)) throw new Error(`没有别名「${name}」`);
  delete table[n];
  saveAliases(table);
  ctx.ui.notify(`已删除 ${n}`, 'info');
}
async function edit(ctx: ExtensionCommandContext) {
  let text = fs.existsSync(ALIASES_FILE) ? fs.readFileSync(ALIASES_FILE, 'utf8') : JSON.stringify(loadAliases(), null, 2) + '\n';
  let title = `编辑目录别名（JSON，保存即生效）· ${tildeDir(ALIASES_FILE)}`;
  for (;;) {
    const next = await ctx.ui.editor(title, text);
    if (next === undefined) return;
    try {
      const saved = saveAliases(parseAliases(next, '别名表'));
      const missing = missingDirs(saved);
      ctx.ui.notify(`已保存 ${Object.keys(saved).length} 个别名${missing.length ? `；目录不存在：${missing.join('、')}` : ''}`, missing.length ? 'warning' : 'info');
      return;
    } catch (e) { text = next; title = `✗ ${(e as Error).message} — 修改后重新保存，Esc 放弃`; }
  }
}
async function menu(ctx: ExtensionCommandContext) {
  for (;;) {
    const table: Table = loadAliases();
    const rows = Object.entries(table).map(([n, d]) => label(n, d));
    const pick = await ctx.ui.select(`目录别名 · ${rows.length} 个 · 手机端「创建会话 别名」`, [...rows, ADD, EDIT]);
    if (!pick) return;
    try {
      if (pick === EDIT) return await edit(ctx);
      if (pick === ADD) {
        const name = await ctx.ui.input('别名（如 genie，不含空格）');
        if (!name) continue;
        validName(name);
        const dir = await ctx.ui.input('目录（留空 = 当前目录）', tildeDir(ctx.cwd));
        if (dir === undefined) continue;
        set(name, dir, ctx);
        continue;
      }
      const name = pick.split(/\s+/)[0];
      const action = await ctx.ui.select(`${name} → ${table[name]}`, ['改目录', '改名', '删除']);
      if (action === '改目录') {
        const dir = await ctx.ui.input(`${name} 的新目录（留空 = 当前目录）`, table[name]);
        if (dir !== undefined) set(name, dir, ctx);
      } else if (action === '改名') {
        const next = await ctx.ui.input(`把 ${name} 改名为`, name);
        if (!next || next.trim().toLowerCase() === name) continue;
        const n = validName(next);
        if (n in table) throw new Error(`「${n}」已存在`);
        const {[name]: dir, ...rest} = table;
        saveAliases({...rest, [n]: dir});
        ctx.ui.notify(`已改名 ${name} → ${n}`, 'info');
      } else if (action === '删除' && await ctx.ui.confirm('删除别名', `删除 ${name} → ${table[name]}？目录本身不受影响。`)) {
        remove(name, ctx);
      }
    } catch (e) { ctx.ui.notify((e as Error).message, 'error'); }
  }
}

/** Completions for the text after "/remote alias ". Values are relative to that prefix. */
export function aliasCompletions(prefix: string) {
  const [head, ...rest] = prefix.split(/\s+/);
  let names: string[] = [];
  try { names = Object.keys(loadAliases()); } catch {}
  if (rest.length && head === 'rm') return names.filter(n => n.startsWith(rest.join(' '))).map(n => ({value: `rm ${n}`, label: n}));
  if (rest.length) return [];
  return [
    {value: 'edit', label: 'edit', description: '编辑配置表'},
    {value: 'rm ', label: 'rm', description: '删除别名'},
    ...names.map(n => ({value: `${n} `, label: n, description: '重新指向目录'})),
  ].filter(i => i.label.startsWith(head));
}

/** "/remote alias [args]" */
export async function aliasCommand(args: string, ctx: ExtensionCommandContext) {
  const [head = '', ...rest] = args.trim().split(/\s+/).filter(Boolean);
  const tail = args.trim().slice(head.length).trim();
  try {
    if (!head) return ctx.hasUI ? await menu(ctx) : ctx.ui.notify(Object.entries(loadAliases() as Table).map(([n, d]) => `${n} → ${d}`).join('\n') || '暂无别名', 'info');
    if (head === 'list' || head === 'ls') return ctx.ui.notify(Object.entries(loadAliases() as Table).map(([n, d]) => label(n, d)).join('\n') + `\n配置表：${tildeDir(ALIASES_FILE)}`, 'info');
    if (head === 'edit') return await edit(ctx);
    if (head === 'rm') return rest.length === 1 ? remove(rest[0], ctx) : ctx.ui.notify('用法：/remote alias rm 名称', 'warning');
    if (head === 'help') return ctx.ui.notify(USAGE, 'info');
    set(head, tail, ctx);
  } catch (e) { ctx.ui.notify((e as Error).message, 'error'); }
}
