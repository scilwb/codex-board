import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer } from '../server/index.mjs';
import { makeFixture } from './fixture.mjs';

async function setup(t, options = {}) {
  const fixture = makeFixture();
  const calls = [];
  const appServer = { async request(method, params) {
    calls.push({ method, params });
    if (method === 'thread/start' || method === 'thread/fork') {
      const id = randomUUID();
      fixture.insert({ id, title: '新对话', source: 'appServer', parent: params.threadId || null });
      return { thread: { id, cwd: fixture.cwd, gitInfo: { branch: 'main' } } };
    }
    if (method === 'thread/name/set') fixture.db.prepare('UPDATE threads SET name=? WHERE id=?').run(params.name, params.threadId);
    if (method === 'thread/archive') fixture.db.prepare('UPDATE threads SET archived=1 WHERE id=?').run(params.threadId);
    if (method === 'thread/settings/update') await options.settings?.();
    return {};
  } };
  let server, base;
  async function start() {
    server = createServer({ ...fixture, appServer });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    server.board.closeStreams();
    const closed = once(server, 'close');
    server.close(); server.closeAllConnections(); await closed;
  }
  await start();
  t.after(async () => { await stop(); fixture.cleanup(); });
  const post = async (path, body) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { fixture, calls, post, store: () => server.board.store, restart: async () => { await stop(); await start(); } };
}

test('新建、Fork、继承丢响应后的同请求重试返回原 ID，不重复创建', async t => {
  const { fixture, post, calls } = await setup(t);
  for (const kind of ['new', 'fork', 'inherit']) {
    const path = kind === 'new' ? '/api/threads' : `/api/threads/${fixture.ids[0]}/${kind}`;
    const body = { cwd: fixture.cwd, title: '同一创建请求', requestId: randomUUID(), ...(kind === 'inherit' ? { prompt: '交接内容' } : {}) };
    const first = await post(path, body);
    assert.equal(first.status, 201);
    const before = calls.length;
    const retry = await post(path, body);
    assert.equal(retry.status, 201);
    assert.equal(retry.body.thread.id, first.body.thread.id);
    assert.equal(calls.length, before);
    const changed = await post(path, { ...body, title: '已修改' });
    assert.equal(changed.status, 409);
    assert.equal(calls.length, before);
  }
  assert.equal(calls.filter(call => call.method === 'thread/inject_items').length, 0);
});

test('并发的同一创建请求合并等待，其他请求不会创建第二条对话', async t => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const { fixture, calls, post } = await setup(t, { settings: async () => { entered(); await gate; } });
  const body = { cwd: fixture.cwd, requestId: randomUUID() };
  const first = post('/api/threads', body);
  await started;
  const second = post('/api/threads', body);
  try {
    assert.equal((await post('/api/threads', { ...body, title: '不同内容' })).status, 409);
    assert.equal((await post('/api/threads', { ...body, requestId: randomUUID() })).status, 409);
  } finally { release(); }
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.equal(a.body.thread.id, b.body.thread.id);
  assert.equal(calls.filter(call => call.method === 'thread/start').length, 1);
});

test('创建凭据跨服务重启保留，来源归档仍可重试，子对话归档不重复创建', async t => {
  const { fixture, post, calls, restart } = await setup(t);
  const path = `/api/threads/${fixture.ids[0]}/inherit`;
  const body = { requestId: randomUUID(), prompt: '继续之前的任务' };
  const first = await post(path, body);
  assert.equal(first.status, 201);
  fixture.db.prepare('UPDATE threads SET archived=1 WHERE id=?').run(fixture.ids[0]);
  await restart();
  const count = calls.length;
  assert.equal((await post(path, body)).body.thread.id, first.body.thread.id);
  fixture.db.prepare('UPDATE threads SET archived=1 WHERE id=?').run(first.body.thread.id);
  const unavailable = await post(path, body);
  assert.equal(unavailable.status, 410);
  assert.match(unavailable.body.error, /已归档或不可用/);
  assert.equal(calls.length, count);
});

test('保存失败归档未完成对话，不留下成功凭据，同请求可以恢复重试', async t => {
  const { fixture, post, store, calls } = await setup(t);
  const originalSave = store().save;
  store().save = () => { throw new Error('模拟磁盘写入失败'); };
  const body = { cwd: fixture.cwd, requestId: randomUUID() };
  const failed = await post('/api/threads', body);
  assert.equal(failed.status, 502);
  assert.match(failed.body.error, /已归档/);
  assert.equal(store().creationRequest(body.requestId), null);
  store().save = originalSave;
  const retry = await post('/api/threads', body);
  assert.equal(retry.status, 201);
  assert.equal(calls.filter(call => call.method === 'thread/archive').length, 1);
  assert.equal(store().threads().length, 4);
});

test('无效请求 ID 在调用 Codex 前被拒绝', async t => {
  const { fixture, post, calls } = await setup(t);
  for (const requestId of ['', null, {}, 'not-a-uuid']) {
    assert.equal((await post('/api/threads', { cwd: fixture.cwd, requestId })).status, 400);
  }
  assert.equal(calls.length, 0);
});
