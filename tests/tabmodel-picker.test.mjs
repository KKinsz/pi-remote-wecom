import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {initTheme} from '@earendil-works/pi-coding-agent';
import extension from '../vendor/tab-title/index.ts';
import {isolateConfig} from './isolated-config.mjs';
const agentDir=isolateConfig();
initTheme('dark');
const models=[{provider:'p',id:'big'},{provider:'p',id:'light'}];
function setup(ui,mode){
 const hooks={},commands={};
 extension({on:(n,h)=>hooks[n]=h,registerCommand:(n,h)=>commands[n]=h,registerTool(){},appendEntry(){},getSessionName:()=>'',setSessionName(){}});
 const modelRegistry={getAvailable:()=>models,find:(p,id)=>models.find(m=>m.provider===p&&m.id===id),getError:()=>undefined,refresh:async()=>({})};
 const ctx={mode,hasUI:true,sessionManager:{getEntries:()=>[],getBranch:()=>[]},modelRegistry,ui:{setTitle(){},notify(){},...ui}};
 return {hooks,commands,ctx};
}
const saved=()=>JSON.parse(readFileSync(join(agentDir,'pi-tab-title.json'),'utf8'));
test('/tabmodel 在 TUI 中用 Pi 原生模型选择器，选中后保存',async()=>{
 let rendered=[];
 const {hooks,commands,ctx}=setup({select:()=>assert.fail('TUI 不应使用普通列表'),custom:(factory)=>new Promise(resolve=>{
  const component=factory({requestRender(){}},{fg:(_c,t)=>t},{},resolve);
  rendered=component.render(80).join('\n');
  component.dispose?.();
  resolve('p/light');
 })},'tui');
 await hooks.session_start({},ctx);
 await commands.tabmodel.handler('',ctx);
 assert.match(rendered,/light/);
 assert.match(rendered,/命名模型/);
 assert.doesNotMatch(rendered,/\/login/);
 assert.deepEqual(saved(),{version:1,provider:'p',model:'light'});
 await hooks.session_shutdown({},ctx);
});
test('/tabmodel 在非 TUI 模式回退到普通列表',async(t)=>{
 const previous=process.env.PI_REMOTE_BACKGROUND;process.env.PI_REMOTE_BACKGROUND='1';
 t.after(()=>{if(previous===undefined)delete process.env.PI_REMOTE_BACKGROUND;else process.env.PI_REMOTE_BACKGROUND=previous;});
 let options;
 const {hooks,commands,ctx}=setup({select:async(_t,o)=>{options=o;return 'p/big';},custom:()=>assert.fail('非 TUI 不应挂载组件')},'rpc');
 await hooks.session_start({},ctx);
 await commands.tabmodel.handler('',ctx);
 assert.deepEqual(options,['p/big','p/light']);
 assert.deepEqual(saved(),{version:1,provider:'p',model:'big'});
 await hooks.session_shutdown({},ctx);
});
