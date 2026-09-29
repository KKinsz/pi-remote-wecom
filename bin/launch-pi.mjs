#!/usr/bin/env node
// Called only by a newly-created tab. execFile/spawn arguments never pass through a shell.
import {spawn} from 'node:child_process';
process.env.PI_REMOTE_HOME = process.argv[2];
const {loadConfig} = await import('../daemon/config.mjs');
const cfg = loadConfig();
const child = spawn(cfg.piBin, [], {stdio: 'inherit', env: {...process.env, PI_CODING_AGENT_DIR: cfg.agentDir}});
child.on('error', () => {console.error('无法启动 Pi，请检查 piBin'); process.exitCode = 1;});
child.on('exit', code => {process.exitCode = code || 0;});
