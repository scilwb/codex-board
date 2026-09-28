'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createNavigator, describeTabs, threadIdFromTab } = require('./navigation.cjs');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const uri = id => ({ scheme: 'openai-codex', authority: 'route', path: `/local/${id}` });
const tab = id => ({ input: { viewType: 'chatgpt.conversationEditor', uri: uri(id) } });

function fakeVscode({ existing = [], open, installed = true } = {}) {
  const calls = [];
  const groups = existing.map((id, i) => ({ viewColumn: i + 1, tabs: [tab(id)], activeTab: null }));
  if (!groups.length) groups.push({ viewColumn: 1, tabs: [], activeTab: null });
  const vscode = {
    window: { state: { focused: true }, tabGroups: { all: groups, activeTabGroup: groups[0] } },
    Uri: { from: value => value },
    ViewColumn: { Active: -1 },
    extensions: { getExtension: () => installed ? { isActive: true } : null },
    commands: { async executeCommand(command, resource, viewType, options) {
      calls.push({ command, resource, viewType, options });
      if (command !== 'vscode.openWith') return;
      if (open) await open();
      const group = groups.find(group => group.viewColumn === options.viewColumn) || groups[0];
      let opened = group.tabs.find(item => item.input.uri === resource);
      if (!opened) { opened = { input: { uri: resource, viewType } }; group.tabs.push(opened); }
      group.activeTab = opened;
      vscode.window.tabGroups.activeTabGroup = group;
    } },
  };
  return { vscode, calls };
}

test('existing conversation reuses its exact URI and column, then focuses its window', async () => {
  const { vscode, calls } = fakeVscode({ existing: [B, A] });
  const existing = vscode.window.tabGroups.all[1].tabs[0];
  existing.input.uri.query = 'preserved=yes';
  const result = await createNavigator(vscode)(A);
  assert.deepEqual(result, { status: 'opened', reused: true, windowFocused: true });
  assert.equal(calls[0].resource, existing.input.uri);
  assert.equal(calls[0].options.viewColumn, 2);
  assert.equal(calls[0].options.preview, false);
  assert.equal(calls[1].command, 'workbench.action.switchToMainWindow');
  assert.equal(vscode.window.tabGroups.all[1].tabs.length, 1);
  assert.deepEqual(describeTabs(vscode), { openThreads: [B, A], activeThreadId: A });
});

test('new conversation opens one custom editor without a CLI/deep link', async () => {
  const { vscode, calls } = fakeVscode();
  assert.deepEqual(await createNavigator(vscode)(A), { status: 'opened', reused: false, windowFocused: true });
  assert.deepEqual(calls[0].resource, uri(A));
  assert.equal(calls[0].viewType, 'chatgpt.conversationEditor');
  assert.equal(calls[0].options.viewColumn, -1);
});

test('timeout holds the in-flight latch and prevents stacking new open operations', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { vscode, calls } = fakeVscode({ open: () => gate });
  const reveal = createNavigator(vscode, { timeoutMs: 20 });
  assert.equal((await reveal(A)).status, 'error');
  const second = await reveal(B);
  assert.match(second.message, /上一次打开仍未结束/);
  assert.equal(calls.length, 1);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await reveal(B)).status, 'opened');
  assert.equal(calls.filter(call => call.command === 'vscode.openWith').length, 2);
});

test('invalid ID, missing extension, and command failure return bounded errors', async () => {
  const missing = fakeVscode({ installed: false });
  assert.match((await createNavigator(missing.vscode)(A)).message, /未安装/);
  assert.equal(missing.calls.length, 0);
  assert.equal((await createNavigator(missing.vscode)('../bad')).status, 'error');
  const failed = fakeVscode({ open: async () => { throw new Error('renderer unavailable'); } });
  assert.match((await createNavigator(failed.vscode)(A)).message, /renderer unavailable/);
});

test('command completion alone cannot acknowledge an inactive or wrong conversation tab', async () => {
  const { vscode } = fakeVscode({ existing: [B] });
  const group = vscode.window.tabGroups.all[0];
  group.activeTab = group.tabs[0];
  // VS Code can accept a command while its target editor has not become active.
  vscode.commands.executeCommand = async () => {};
  const result = await createNavigator(vscode)(A);
  assert.equal(result.status, 'error');
  assert.match(result.message, /尚未确认目标对话标签页处于活动状态/);
  assert.equal(describeTabs(vscode).activeThreadId, B);
});

test('does not report success when the operating system leaves another window in front', async () => {
  const { vscode } = fakeVscode();
  vscode.window.state.focused = false;
  let disposed = false;
  vscode.window.onDidChangeWindowState = () => ({ dispose() { disposed = true; } });
  const result = await createNavigator(vscode, { focusTimeoutMs: 10 })(A);
  assert.equal(result.status, 'error');
  assert.match(result.message, /未将 VS Code 窗口切到前台/);
  assert.equal(disposed, true);
});

test('only Codex local conversation custom editor tabs count as open', () => {
  assert.equal(threadIdFromTab(tab(A)), A);
  assert.equal(threadIdFromTab({ input: { uri: uri(A) } }), null);
  assert.equal(threadIdFromTab({ input: { viewType: 'other', uri: uri(A) } }), null);
  assert.equal(threadIdFromTab({ input: { viewType: 'chatgpt.conversationEditor', uri: { ...uri(A), authority: 'wrong' } } }), null);
});
