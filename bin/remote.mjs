#!/usr/bin/env node
import fs from 'node:fs';
import {loadConfig, saveConfig, RUN_DIR} from '../daemon/config.mjs';
import {health, startService, stopService, restartService, uninstallService} from '../daemon/service.mjs';
const command = process.argv[2] || 'help';
try {
  if (command === 'run') await import('../daemon/daemon.mjs');
  else if (command === 'configure') {
    if (!process.argv[3]) throw new Error('用法：pi-remote-wecom configure /本机/凭证.json');
    if (await health()) throw new Error('请先停止服务，再修改配置');
    saveConfig({...loadConfig(), ...JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))});
    console.log('配置已保存，运行 start 启动。');
  } else if (command === 'start') console.log(await startService());
  else if (command === 'stop') {await stopService(); console.log('已停止，运行 start 恢复。');}
  else if (command === 'restart') console.log(await restartService());
  else if (command === 'uninstall') console.log(await uninstallService());
  else if (command === 'status' || command === 'doctor') console.log(await health() || `服务未运行。配置目录：${RUN_DIR}`);
  else console.log('pi-remote-wecom configure <JSON文件> | start | stop | restart | status | doctor | uninstall | run');
} catch (e) {console.error(e.message); process.exitCode = 1;}
