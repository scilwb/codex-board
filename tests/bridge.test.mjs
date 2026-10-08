import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EditorBridge } from '../server/bridge.mjs';
import { createServer } from '../server/index.mjs';
import { makeFixture } from './fixture.mjs';

function setup(t, options = {}) {
  const f = makeFixture();
  const bridge = new EditorBridge({ dataDir: f.dataDir, ...options });
  const window = { id: randomUUID(), title: 'robot-project', pid: process.pid, folders: [f.cwd], openThreads: [f.ids[0]], activeThreadId: f.ids[0] };
  bridge.register(window);
  t.after(() => { bridge.close(); f.cleanup(); });
  return { f, bridge, window };
}

test('桥接：等待窗口实际确认，重复点击合并为一个命令', async t => {
  const { f, bridge, window } = setup(t);
  const first = bridge.open(f.ids[0], window.id);
  assert.equal(bridge.open(f.ids[0], window.id), first);
  assert.throws(() => bridge.open(f.ids[1], window.id), /正在打开/);
  const { command } = await bridge.poll(window.id);
  let settled = false;
  first.then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false);
  bridge.register(window); // A heartbeat must preserve the in-flight object.
  bridge.result({ clientId: window.id, commandId: command.id, status: 'opened', reused: true, windowFocused: true });
  assert.equal((await first).reused, true);
  assert.equal(bridge.clients.get(window.id).pending, null);
});

test('继承发送先等待目标窗口确认，再由原生对话所有者接收提示词', async t => {
  const submissions = [];
  const ipcClient = {
    async submitInheritance(threadId, body) {
      submissions.push({ threadId, body });
      return { submitted: true, verified: true, turnId: randomUUID() };
    }, close() {},
  };
  const { f, bridge, window } = setup(t, { ipcClient });
  const body = { windowId: window.id, prompt: '验证交接内容', submissionId: randomUUID(), settings: { model: 'gpt-6.1-sol', reasoningEffort: 'ultra' } };
  const starting = bridge.submitInheritance(f.ids[0], body);
  const { command } = await bridge.poll(window.id);
  assert.equal(submissions.length, 0, 'no inference before the editor confirms navigation');
  bridge.result({ clientId: window.id, commandId: command.id, status: 'opened', windowFocused: true });
  const result = await starting;
  assert.equal(result.opened, true);
  assert.equal(result.submitted, true);
  assert.equal(result.verified, true);
  assert.deepEqual(submissions, [{ threadId: f.ids[0], body: { prompt: body.prompt, submissionId: body.submissionId, settings: body.settings } }]);
});

test('继承定位失败不会发送提示词，也不会把打开当作发送成功', async t => {
  const ipcClient = { async submitInheritance() { throw new Error('must not send'); }, close() {} };
  const { f, bridge, window } = setup(t, { ipcClient });
  const failed = bridge.submitInheritance(f.ids[0], { windowId: window.id, prompt: '测试', submissionId: randomUUID() });
  const { command } = await bridge.poll(window.id);
  bridge.result({ clientId: window.id, commandId: command.id, status: 'error', message: '无法打开目标标签' });
  await assert.rejects(failed, error => error.dispatched === false && /无法打开目标/.test(error.message));
});

test('继承发送接受精确标签确认，窗口失焦只返回提醒', async t => {
  const sent = [];
  const ipcClient = { async submitInheritance(id, body) { sent.push({ id, body }); return { submitted: true, verified: true, turnId: 'visible-turn' }; }, close() {} };
  const { f, bridge, window } = setup(t, { ipcClient });
  const sending = bridge.submitInheritance(f.ids[0], { windowId: window.id, prompt: 'UMI交接', submissionId: randomUUID() });
  const { command } = await bridge.poll(window.id);
  assert.equal(command.allowUnfocused, true);
  bridge.result({ clientId: window.id, commandId: command.id, status: 'opened', editorOpened: true,
    activeThreadId: f.ids[0], windowFocused: false, warning: '目标已确认，窗口未到前台' });
  const result = await sending;
  assert.equal(result.submitted, true);
  assert.equal(result.windowFocused, false);
  assert.match(result.warning, /窗口未到前台/);
  assert.equal(sent.length, 1);
});

test('旧桥接的焦点错误必须等后续新鲜目标注册，不能凭缓存发送', async t => {
  const sent = [];
  const ipcClient = { async submitInheritance(id) { sent.push(id); return { submitted: true, verified: true, turnId: 'legacy-confirmed' }; }, close() {} };
  const { f, bridge, window } = setup(t, { ipcClient });
  const sending = bridge.submitInheritance(f.ids[0], { prompt: '正确来源', submissionId: randomUUID() });
  const { command } = await bridge.poll(window.id);
  bridge.result({ clientId: window.id, commandId: command.id, status: 'error',
    message: '对话标签已定位，但系统未将 VS Code 窗口切到前台；请点击任务栏中的目标窗口。' });
  await Promise.resolve(); assert.equal(sent.length, 0);
  bridge.register({ ...window, activeThreadId: f.ids[1], openThreads: [f.ids[0], f.ids[1]] });
  await Promise.resolve(); assert.equal(sent.length, 0);
  bridge.register(window);
  assert.equal((await sending).submitted, true);
  assert.deepEqual(sent, [f.ids[0]]);
});

test('继承窗口回执给出另一个对话时，即使已聚焦也拒绝发送', async t => {
  const ipcClient = { async submitInheritance() { throw Error('must not dispatch'); }, close() {} };
  const { f, bridge, window } = setup(t, { ipcClient });
  const sending = bridge.submitInheritance(f.ids[0], { prompt: '正确来源', submissionId: randomUUID() });
  const { command } = await bridge.poll(window.id);
  bridge.result({ clientId: window.id, commandId: command.id, status: 'opened', editorOpened: true,
    activeThreadId: f.ids[1], windowFocused: true });
  await assert.rejects(sending, error => error.dispatched === false && /ID 与目标不匹配/.test(error.message));
});

test('桥接：不可用窗口超时后不给编辑器堆积重试', async t => {
  const { f, bridge, window } = setup(t, { timeoutMs: 30 });
  await assert.rejects(bridge.open(f.ids[0], window.id), error => error.status === 504 && /1 秒/.test(error.message));
  assert.equal(bridge.commands.size, 0);
  assert.throws(() => bridge.open(f.ids[0], window.id), /尚未完成/);
  assert.equal(bridge.clients.get(window.id).queued, null);
});

test('桥接：旧插件缺少窗口焦点确认时拒绝假成功并提示更新', async t => {
  const { f, bridge, window } = setup(t);
  for (const windowFocused of [undefined, false]) {
    const opening = bridge.open(f.ids[0], window.id);
    const { command } = await bridge.poll(window.id);
    bridge.result({ clientId: window.id, commandId: command.id, status: 'opened', reused: true, windowFocused });
    await assert.rejects(opening, error => error.status === 409 && /Developer: Reload Window/.test(error.message));
    assert.equal(bridge.commands.size, 0);
    assert.equal(bridge.clients.get(window.id).pending, null);
  }
});

test('桥接：令牌、窗口响应归属和掉线窗口均校验', async t => {
  const { f, bridge, window } = setup(t);
  assert.throws(() => bridge.authenticate('wrong'), error => error.status === 403);
  bridge.authenticate(bridge.token);
  const opening = bridge.open(f.ids[0], window.id);
  const { command } = await bridge.poll(window.id);
  assert.throws(() => bridge.result({ clientId: randomUUID(), commandId: command.id, status: 'opened' }), /不匹配/);
  bridge.result({ clientId: window.id, commandId: command.id, status: 'error', message: '扩展未响应' });
  await assert.rejects(opening, /扩展未响应/);
  bridge.clients.get(window.id).seenAt = 0;
  assert.deepEqual(bridge.windows(), []);
  assert.throws(() => bridge.open(f.ids[0], window.id), error => error.status === 409);
});

test('桥接：断开或替换长轮询时清理监听，并可重新连接', async t => {
  const { bridge, window } = setup(t);
  const firstResponse = new EventEmitter();
  const firstPoll = bridge.poll(window.id, firstResponse);
  const nextResponse = new EventEmitter();
  const nextPoll = bridge.poll(window.id, nextResponse);
  assert.deepEqual(await firstPoll, { command: null });
  assert.equal(firstResponse.listenerCount('close'), 0);
  assert.equal(nextResponse.listenerCount('close'), 1);
  nextResponse.emit('close');
  assert.deepEqual(await nextPoll, { command: null });
  assert.equal(nextResponse.listenerCount('close'), 0);
  assert.equal(bridge.clients.get(window.id).waiter, null);

  bridge.clients.get(window.id).seenAt = 0;
  assert.deepEqual(bridge.windows(), []);
  await assert.rejects(bridge.poll(window.id), error => error.status === 404);
  bridge.register(window);
  assert.equal(bridge.windows()[0].id, window.id);
  const reconnectedPoll = bridge.poll(window.id, nextResponse);
  bridge.close();
  assert.deepEqual(await reconnectedPoll, { command: null });
  assert.equal(nextResponse.listenerCount('close'), 0);
});

test('真实 HTTP 桥接：未收到编辑器回执前接口不报告成功', async t => {
  const f = makeFixture();
  const server = createServer({ ...f });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.board.closeStreams(); const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; f.cleanup(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const bridgeHeaders = { 'content-type': 'application/json', 'x-codex-board-token': server.board.bridge.token };
  const id = randomUUID();
  const register = await fetch(base + '/api/bridge/register', { method: 'POST', headers: bridgeHeaders, body: JSON.stringify({ id, title: 'Test', pid: process.pid, folders: [f.cwd], openThreads: [] }) });
  assert.equal(register.status, 200);
  assert.equal((await fetch(base + '/api/bridge/poll?clientId=' + id)).status, 403);
  let settled = false;
  const open = fetch(base + `/api/threads/${f.ids[0]}/open-vscode`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ windowId: id }) }).then(response => { settled = true; return response.json(); });
  const { command } = await (await fetch(base + '/api/bridge/poll?clientId=' + id, { headers: bridgeHeaders })).json();
  assert.equal(settled, false);
  assert.equal(command.threadId, f.ids[0]);
  await fetch(base + '/api/bridge/result', { method: 'POST', headers: bridgeHeaders, body: JSON.stringify({ clientId: id, commandId: command.id, status: 'opened', reused: true, windowFocused: true }) });
  const opened = await open;
  assert.equal(opened.editorOpened, true);
  assert.equal(opened.windowFocused, true);
  const row = f.db.prepare('SELECT rollout_path FROM threads WHERE id=?').get(f.ids[1]);
  rmSync(row.rollout_path);
  const missing = await fetch(base + `/api/threads/${f.ids[1]}/open-vscode`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ windowId: id }) });
  assert.equal(missing.status, 409);
  assert.equal(server.board.bridge.commands.size, 0);
});


test('桥接：回执丢失后重复投递同一个命令 ID，迟到回执不重复完成', async t => {
  const { f, bridge, window } = setup(t);
  const opening = bridge.open(f.ids[0], window.id);
  const first = (await bridge.poll(window.id)).command;
  const retry = (await bridge.poll(window.id)).command;
  assert.deepEqual(retry, first);
  bridge.result({ clientId: window.id, commandId: retry.id, status: 'opened', windowFocused: true });
  assert.equal((await opening).verified, true);
  assert.deepEqual(bridge.result({ clientId: window.id, commandId: retry.id, status: 'opened', windowFocused: true }), { ignored: true });
  assert.equal(bridge.commands.size, 0);
});

test('桥接：同一窗口新进程注册时结束旧长轮询并允许重新取命令', async t => {
  const { f, bridge, window } = setup(t);
  const response = new EventEmitter();
  const waiting = bridge.poll(window.id, response);
  assert.equal(response.listenerCount('close'), 1);
  bridge.register({ ...window, pid: window.pid + 1 });
  assert.deepEqual(await waiting, { command: null });
  assert.equal(response.listenerCount('close'), 0);
  const opening = bridge.open(f.ids[0], window.id);
  const command = (await bridge.poll(window.id)).command;
  bridge.result({ clientId: window.id, commandId: command.id, status: 'opened', windowFocused: true });
  assert.equal((await opening).verified, true);
  assert.throws(() => bridge.register(null), error => error.status === 400);
  assert.throws(() => bridge.result(null), error => error.status === 400);
});


test('桥接：损坏或空令牌不能成为有效认证凭证', t => {
  const f = makeFixture();
  t.after(() => f.cleanup());
  writeFileSync(join(f.dataDir, 'bridge-token'), '');
  assert.throws(() => new EditorBridge({ dataDir: f.dataDir }), /桥接令牌损坏/);
});
