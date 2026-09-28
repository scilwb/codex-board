import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { rmSync } from 'node:fs';
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

test('桥接：不可用窗口超时后不给编辑器堆积重试', async t => {
  const { f, bridge, window } = setup(t, { timeoutMs: 30 });
  await assert.rejects(bridge.open(f.ids[0], window.id), error => error.status === 504);
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
