import { mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bridgePackage = JSON.parse(readFileSync(join(root, 'vscode-bridge/package.json'), 'utf8'));
execFileSync('python3', [join(root, 'vscode-bridge/build.py')], { stdio: 'inherit' });
execFileSync('code', ['--install-extension', join(root, 'vscode-bridge', `${bridgePackage.name}-${bridgePackage.version}.vsix`), '--force'], { stdio: 'inherit', timeout: 60000 });
const unitDir = join(homedir(), '.config/systemd/user');
const appsDir = join(homedir(), '.local/share/applications');
mkdirSync(unitDir, { recursive: true });
mkdirSync(appsDir, { recursive: true });
const escapeUnit = value => String(value).replace(/%/g, '%%').replace(/"/g, '\\"');
const envLines = ['DISPLAY', 'XAUTHORITY'].filter(key => process.env[key])
  .map(key => `Environment="${key}=${escapeUnit(process.env[key])}"`).join('\n');
writeFileSync(join(unitDir, 'codex-board.service'), `[Unit]
Description=Local Codex conversation board
After=graphical-session.target

[Service]
Type=simple
WorkingDirectory=${escapeUnit(root)}
ExecStart="${escapeUnit(process.execPath)}" "${escapeUnit(join(root, 'server/index.mjs'))}"
Environment="PATH=${escapeUnit(dirname(process.execPath))}:${escapeUnit(join(homedir(), '.npm-global/bin'))}:/usr/local/bin:/usr/bin:/bin"
${envLines}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`);
chmodSync(join(root, 'scripts/launch.sh'), 0o755);
writeFileSync(join(appsDir, 'codex-board.desktop'), `[Desktop Entry]
Version=1.0
Type=Application
Name=Codex Board
Comment=Codex 对话地图
Exec="${join(root, 'scripts/launch.sh')}"
Icon=applications-development
Terminal=false
Categories=Development;
`);
execFileSync('systemctl', ['--user', 'daemon-reload']);
execFileSync('systemctl', ['--user', 'enable', '--now', 'codex-board.service']);
console.log('Codex Board: http://127.0.0.1:4317');
