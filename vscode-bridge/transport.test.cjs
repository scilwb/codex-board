'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const http = require('node:http');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

test('bridge authenticates, registers its window, acknowledges once per duplicate without reopening', async () => {
  const threadId = '11111111-1111-4111-8111-111111111111';
  const token = 'test-only-local-bridge-token';
  const command = { id: 'test-command-once', threadId };
  const registrations = [];
  const results = [];
  let pollCount = 0;
  let completed;
  const done = new Promise(resolve => { completed = resolve; });
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers['x-codex-board-token'], token);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    let reply = {};
    if (req.url === '/api/bridge/register') registrations.push(body);
    else if (req.url.startsWith('/api/bridge/poll?clientId=')) {
      pollCount++;
      if (pollCount > 2) return; // Real backend long-polls here until deactivation.
      reply = { command };
    } else if (req.url === '/api/bridge/result') {
      results.push(body);
      if (results.length === 2) completed();
    } else throw new Error(`Unexpected request: ${req.url}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const group = { viewColumn: 1, tabs: [], activeTab: null };
  const events = [];
  const disposable = () => ({ dispose() {} });
  const fakeVscode = {
    window: {
      state: { focused: true },
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      tabGroups: { all: [group], activeTabGroup: group, onDidChangeTabs: disposable, onDidChangeTabGroups: disposable },
    },
    workspace: {
      name: 'Bridge Test', workspaceFolders: [{ uri: { scheme: 'file', fsPath: '/tmp/bridge-test' } }],
      onDidChangeWorkspaceFolders: disposable,
    },
    commands: {
      registerCommand: disposable,
      async executeCommand(name, uri, viewType) {
        events.push(name);
        if (name === 'vscode.openWith') {
          const tab = { input: { uri, viewType } };
          group.tabs.push(tab); group.activeTab = tab;
        }
      },
    },
    extensions: { getExtension: () => ({ isActive: true }) },
    Uri: { from: uri => uri },
    ViewColumn: { Active: -1 },
  };
  const module = { exports: {} };
  const sandbox = {
    module, exports: module.exports, Buffer, process, setTimeout, clearTimeout, setInterval, clearInterval,
    require(name) {
      if (name === 'vscode') return fakeVscode;
      if (name === 'node:http') return { request: (options, listener) => http.request({ ...options, port }, listener) };
      if (name === 'node:fs/promises') return { readFile: async () => token };
      if (name === './navigation.cjs') return require('./navigation.cjs');
      return require(name);
    },
  };
  vm.runInNewContext(readFileSync(join(__dirname, 'extension.cjs'), 'utf8'), sandbox, { filename: 'extension.cjs' });
  let timeout;
  try {
    module.exports.activate({ subscriptions: [] });
    await Promise.race([done, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Transport test timed out')), 3000); })]);
    assert.equal(registrations[0].title, 'Bridge Test');
    assert.deepEqual(registrations[0].folders, ['/tmp/bridge-test']);
    assert.equal(results.length, 2);
    assert.equal(results[0].status, 'opened');
    assert.equal(results[0].windowFocused, true);
    assert.equal(results[0].commandId, command.id);
    assert.equal(results[1].commandId, command.id);
    assert.equal(events.filter(event => event === 'vscode.openWith').length, 1);
    assert.equal(registrations.at(-1).activeThreadId, threadId);
  } finally {
    clearTimeout(timeout);
    module.exports.deactivate();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
