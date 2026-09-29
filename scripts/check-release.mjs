// Release gate: package completeness + common accidental credential disclosures.
// Reports locations only; never prints matched secrets. This is not a full secret scanner.
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const problems = [];
const publicRelease = process.argv.includes('--public');
if (publicRelease) {
  const repo = pkg.repository?.url;
  const match = typeof repo === 'string' && repo.match(/^git\+https:\/\/github\.com\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)\.git$/);
  if (!match || ['OWNER', 'REPOSITORY'].some(value => match.slice(1).includes(value))) {
    problems.push('package.json: select an actual public GitHub repository before publishing');
  } else {
    const base = `https://github.com/${match[1]}/${match[2]}`;
    if (pkg.homepage !== base || pkg.bugs?.url !== `${base}/issues`) problems.push('package.json: homepage and bugs must match the public repository');
  }
  if (!pkg.keywords?.includes('pi-package')) problems.push('package.json: missing pi-package keyword');
}

if (pkg.version !== lock.version || pkg.version !== lock.packages[''].version) problems.push('package-lock.json: version mismatch');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const [pack] = JSON.parse(execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {encoding:'utf8'}));
const files = pack.files.map(f => f.path);
for (const file of [...pkg.pi.extensions, ...Object.values(pkg.bin), 'vendor/tab-title/LICENSE', 'LICENSE', 'README.md', 'README.zh-CN.md', 'CHANGELOG.md', 'NOTICE.md', 'SECURITY.md', 'CONTRIBUTING.md', 'RELEASING.md', 'config.example.json']) {
  if (!files.includes(file.replace(/^\.\//, ''))) problems.push(`${file}: missing from package`);
}
for (const file of files) {
  if (!/^(extensions\/|daemon\/|bin\/|vendor\/|package.json$|README(?:\.zh-CN)?.md$|CONTRIBUTING.md$|RELEASING.md$|NOTICE.md$|CHANGELOG.md$|LICENSE$|SECURITY.md$|config.example.json$)/.test(file)) problems.push(`${file}: unexpected package file`);
}
let tracked;
try { tracked = execFileSync('git', ['ls-files', '-z'], {encoding:'utf8'}).split('\0').filter(Boolean); }
catch { tracked = files; }
const patterns = [
  /\/Users\/[a-zA-Z][a-zA-Z0-9_-]*\//,
  /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/,
  /\b(?:gh[pousr]_[a-zA-Z0-9]{30,}|AKIA[A-Z0-9]{16}|evnIns-[a-z0-9]+)/,
  /["']?(?:secret|botId|api_key|access_token)["']?\s*[:=]\s*["'][a-zA-Z0-9_+\/-]{20,}["']/i,
];
const words = process.env.PI_REMOTE_SENSITIVE_WORDS_FILE;
const privateWords = words ? fs.readFileSync(words, 'utf8').split(/\r?\n/).filter(w => w && !w.startsWith('#')) : [];
for (const file of new Set([...tracked, ...files])) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
  if (/(^|\/)(?:\.env(?:\..+)?|config.json|aliases.json|\.token)$/.test(file) || /\.(?:pem|key)$/.test(file)) problems.push(`${file}: local-only file`);
  const buffer = fs.readFileSync(file);
  if (buffer.includes(0)) continue;
  buffer.toString('utf8').split('\n').forEach((line, i) => {
    if ((publicRelease && /https?:\/\/(?:[\w-]+\.)*woa\.com\b/i.test(line)) || patterns.some(p => p.test(line)) || privateWords.some(w => line.includes(w))) problems.push(`${file}:${i + 1}: suspected private data`);
  });
}
if (problems.length) { console.error(problems.join('\n')); process.exitCode = 1; }
else console.log(`Release checks passed: ${files.length} package files; v${pkg.version}; no common secret patterns found.`);
