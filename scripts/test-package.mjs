// Load the actual npm artifact using only its production dependencies and a real Pi host.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-remote-package-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
try {
  const [pack] = JSON.parse(execFileSync(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', dir], {encoding:'utf8'}));
  execFileSync('tar', ['-xzf', path.join(dir, pack.filename), '-C', dir]);
  const root = path.join(dir, 'package');
  execFileSync(npm, ['install', '--omit=dev', '--ignore-scripts', '--package-lock=false', '--prefix', root], {stdio:'inherit'});
  execFileSync(process.execPath, ['--test', 'tests/pi-load.test.mjs'], {
    stdio:'inherit', env:{...process.env, PI_REMOTE_TEST_ENTRY:path.join(root,'extensions','index.ts')},
  });
} finally { fs.rmSync(dir, {recursive:true, force:true}); }
