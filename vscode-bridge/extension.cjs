'use strict';

const vscode = require('vscode');
const http = require('node:http');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { homedir } = require('node:os');
const { randomUUID } = require('node:crypto');
const { describeTabs, createNavigator } = require('./navigation.cjs');

const PORT = 4317;
const TOKEN_PATH = join(homedir(), '.local', 'share', 'codex-board', 'bridge-token');
let bridge;

function activate(context) {
  const output = vscode.window.createOutputChannel('Codex Board Bridge');
  const id = randomUUID();
  const requests = new Set();
  const completed = new Map();
  const reveal = createNavigator(vscode);
  let stopped = false;
  let running = false;
  let heartbeat;
  let registerTimer;
  let registering = null;
  let waitTimer;
  let wakeWait;
  let token = null;
  let connected = false;

  function request(method, path, value, timeout = 25000) {
    return new Promise((resolve, reject) => {
      if (stopped) { reject(new Error('Bridge stopped')); return; }
      const body = value === undefined ? null : Buffer.from(JSON.stringify(value));
      const req = http.request({
        hostname: '127.0.0.1', port: PORT, method, path,
        headers: {
          'x-codex-board-token': token,
          ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {}),
        },
      }, res => {
        const chunks = [];
        let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > 128 * 1024) { req.destroy(new Error('Bridge response too large')); return; }
          chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => {
          let data;
          try { data = JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
          catch { reject(new Error('Bridge returned invalid JSON')); return; }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const error = new Error(data.error || `Bridge HTTP ${res.statusCode}`);
            error.status = res.statusCode;
            reject(error);
          } else resolve(data);
        });
      });
      requests.add(req);
      req.on('close', () => requests.delete(req));
      req.on('error', reject);
      req.setTimeout(timeout, () => req.destroy(new Error('Bridge request timed out')));
      if (body) req.write(body);
      req.end();
    });
  }

  function metadata() {
    return {
      id, title: vscode.workspace.name || 'VS Code',
      folders: (vscode.workspace.workspaceFolders || []).filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath),
      pid: process.pid,
      ...describeTabs(vscode),
    };
  }

  async function register() {
    if (registering) return registering;
    registering = (async () => {
      token = (await readFile(TOKEN_PATH, 'utf8')).trim();
      if (!token || token.length > 1024 || /[\r\n]/.test(token)) throw new Error('Invalid bridge token');
      await request('POST', '/api/bridge/register', metadata(), 5000);
    })();
    try { await registering; } finally { registering = null; }
  }

  function registerSoon() {
    if (!connected || stopped) return;
    clearTimeout(registerTimer);
    registerTimer = setTimeout(() => { register().catch(() => {}); }, 150);
  }

  function sleep(ms) {
    return new Promise(resolve => {
      wakeWait = resolve;
      waitTimer = setTimeout(() => { wakeWait = null; resolve(); }, ms);
    });
  }

  async function loop() {
    if (running || stopped) return;
    running = true;
    try {
      while (!stopped) {
        try {
          await register();
          if (!connected) output.appendLine('Connected to local Codex Board.');
          connected = true;
          while (!stopped) {
            const { command } = await request('GET', `/api/bridge/poll?clientId=${encodeURIComponent(id)}`);
            if (!command) continue;
            if (typeof command.id !== 'string' || command.id.length > 200) throw new Error('Invalid bridge command');
            let result = completed.get(command.id);
            if (!result) {
              result = await reveal(command.threadId);
              completed.set(command.id, result);
              if (completed.size > 100) completed.delete(completed.keys().next().value);
              output.appendLine(`Open ${command.threadId}: ${result.status}${result.reused ? ' (existing tab)' : ''}${result.message ? ` — ${result.message}` : ''}`);
            }
            await request('POST', '/api/bridge/result', { clientId: id, commandId: command.id, ...result }, 5000);
            await register();
          }
        } catch (error) {
          if (connected && !stopped) output.appendLine(`Disconnected: ${error.message}`);
          connected = false;
          if (!stopped) await sleep(2000);
        }
      }
    } finally { running = false; }
  }

  bridge = {
    dispose() {
      stopped = true;
      connected = false;
      clearInterval(heartbeat);
      clearTimeout(registerTimer);
      clearTimeout(waitTimer);
      wakeWait?.();
      for (const req of requests) req.destroy();
      requests.clear();
    },
  };
  heartbeat = setInterval(() => { if (connected && !stopped) register().catch(() => {}); }, 20000);
  context.subscriptions.push(
    output, bridge,
    vscode.window.tabGroups.onDidChangeTabs(registerSoon),
    vscode.window.tabGroups.onDidChangeTabGroups(registerSoon),
    vscode.workspace.onDidChangeWorkspaceFolders(registerSoon),
    vscode.commands.registerCommand('codexBoard.connect', () => { clearTimeout(waitTimer); wakeWait?.(); wakeWait = null; return loop(); }),
    vscode.commands.registerCommand('codexBoard.open', () => vscode.env.openExternal(vscode.Uri.parse(`http://127.0.0.1:${PORT}`))),
  );
  void loop();
}

function deactivate() { bridge?.dispose(); bridge = null; }
module.exports = { activate, deactivate };
