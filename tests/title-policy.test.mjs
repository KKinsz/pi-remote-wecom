import test from 'node:test';
import assert from 'node:assert/strict';
import extension,{namingEnabled,titleUnits,truncateTitle} from '../vendor/tab-title/index.ts';
import {isolateConfig} from './isolated-config.mjs';
const agentDir=isolateConfig();
test('新用户未选命名模型不发请求，手动命名照常工作',async()=>{
 const hooks={},commands={},titles=[];let calls=0,name='';
 const ctx={mode:'tui',sessionManager:{getEntries:()=>[],getBranch:()=>[]},ui:{setTitle:t=>titles.push(t),notify(){}},modelRegistry:{find:()=>{calls++;throw Error('must not run');}}};
 extension({on:(n,h)=>hooks[n]=h,registerCommand:(n,h)=>commands[n]=h,registerTool(){},appendEntry(){},getSessionName:()=>name,setSessionName:n=>name=n});
 await hooks.session_start({},ctx);await hooks.before_agent_start({prompt:'测试输入'},ctx);
 assert.equal(calls,0);await commands.tabname.handler('手动会话名称',ctx);assert.equal(name,'手动会话名称');assert.equal(titles.at(-1),name);
 await hooks.session_shutdown({},ctx);
});
test('保留当前安装版的中英文标题长度与完整单词截断体验',()=>{
 assert.equal(titleUnits('Pi package 打包改造'),6);
 const title=truncateTitle('Pi package 扩展打包多会话遥控改造优化');
 assert.ok(titleUnits(title)<=10);assert.ok(title.includes('package'));assert.ok(!title.endsWith('packa'));
});
test('未选命名模型时 namingEnabled 为 false，选定后为 true',async()=>{
 const fs=await import('node:fs');const path=await import('node:path');
 const file=path.join(agentDir,'pi-tab-title.json');fs.rmSync(file,{force:true});
 assert.equal(namingEnabled(),false);
 fs.writeFileSync(file,JSON.stringify({version:1,provider:'p',model:'m'}));assert.equal(namingEnabled(),true);
 fs.writeFileSync(file,'{bad');assert.equal(namingEnabled(),false);
 fs.rmSync(file,{force:true});
});
