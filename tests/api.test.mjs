import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer } from '../server/index.mjs';
import { makeFixture } from './fixture.mjs';

async function setup(t) {
  const fixture = makeFixture();
  const calls = [], opened = [];
  const appServer = { async request(method, params) {
    calls.push({ method, params });
    if (method === 'thread/settings/update') return {};
    if (method === 'thread/unsubscribe') return {};
    if (method === 'thread/name/set') {
      fixture.db.prepare('UPDATE threads SET name=? WHERE id=?').run(params.name, params.threadId);
      return {};
    }
    const id = randomUUID();
    fixture.insert({ id, title: '临时新对话', source: 'appServer', parent: params.threadId || null });
    return { thread: { id, cwd: params.cwd, createdAt: Math.floor(Date.now() / 1000), updatedAt: Math.floor(Date.now() / 1000) } };
  } };
  const bridge = {
    windows: () => [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: 'robot-project' }, { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', title: 'other-project' }],
    async open(id, windowId) {
      if (windowId && !this.windows().some(x => x.id === windowId)) throw Object.assign(new Error('窗口已关闭'), { status: 409 });
      opened.push({ id, windowId }); return { opened: true, verified: true, reused: true, editorOpened: true };
    }, close() {},
  };
  const server = createServer({ ...fixture, appServer, bridge, pollIntervalMs: 100 });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.board.closeStreams();
    const done = once(server, 'close');
    server.close(); server.closeAllConnections();
    await done;
    fixture.cleanup();
  });
  const request = async (path, method = 'GET', body, headers = {}) => {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  return { fixture, server, base, request, calls, opened };
}

test('HTTP：会话、项目与错误返回可供 UI 使用', async t => {
  const { request, fixture } = await setup(t);
  assert.equal((await request('/api/snapshot')).body.threads.length, 3);
  assert.equal((await request('/api/projects')).body.projects[0].cwd, fixture.cwd);
  assert.equal((await request('/api/missing')).status, 404);
  assert.equal((await request('/api/threads/not-a-uuid/open-vscode', 'POST', {})).status, 400);
});

test('HTTP：新建和 Fork 使用 metadata API，并复制具体 thread.id', async t => {
  const { request, fixture, calls } = await setup(t);
  const created = await request('/api/threads', 'POST', { cwd: fixture.cwd, title: '新建验收对话' });
  assert.equal(created.status, 201);
  assert.equal(created.body.thread.title, '新建验收对话');
  const forked = await request(`/api/threads/${created.body.thread.id}/fork`, 'POST', { title: 'Fork 验收对话' });
  assert.equal(forked.status, 201);
  assert.equal(forked.body.thread.forkedFromId, created.body.thread.id);
  assert.notEqual(forked.body.thread.id, created.body.thread.id);
  assert.deepEqual(calls.map(x => x.method), ['thread/start', 'thread/name/set', 'thread/settings/update', 'thread/unsubscribe', 'thread/fork', 'thread/name/set', 'thread/settings/update', 'thread/unsubscribe']);
  for (const { params } of calls.filter(x => x.method === 'thread/start' || x.method === 'thread/fork')) {
    assert.equal(params.approvalPolicy, 'never');
    assert.equal(params.permissions, ':danger-full-access');
    assert.equal(Object.hasOwn(params, 'sandbox'), false);
  }
  assert.deepEqual(calls.filter(x => x.method === 'thread/settings/update').map(x => x.params), [
    { threadId: created.body.thread.id, approvalPolicy: 'never', permissions: ':danger-full-access' },
    { threadId: forked.body.thread.id, approvalPolicy: 'never', permissions: ':danger-full-access' },
  ]);
  const snapshot = (await request('/api/snapshot')).body;
  assert.equal(snapshot.threads.find(x => x.id === forked.body.thread.id).title, 'Fork 验收对话');
});

test('HTTP：窗口确认后返回已定位，使用精确对话 ID', async t => {
  const { request, fixture, opened } = await setup(t);
  const result = await request(`/api/threads/${fixture.ids[2]}/open-vscode`, 'POST', {});
  assert.equal(result.status, 200);
  assert.equal(opened[0].id, fixture.ids[2]);
  assert.equal(result.body.verified, true);
});

test('HTTP：拒绝外站发起的写请求与非法数据', async t => {
  const { request, fixture } = await setup(t);
  assert.equal((await request('/api/graph', 'PATCH', { edges: [] }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await request('/api/graph', 'PATCH', { edges: [] }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await request('/api/threads', 'POST', { cwd: '/does-not-exist', title: 'bad' })).status, 400);
  assert.equal((await request('/api/graph', 'PATCH', { positions: { [fixture.ids[0]]: { x: 'wrong', y: 0 } } })).status, 400);
});

test('多窗口：列出窗口，指定窗口路由，拒绝已失效目标', async t => {
  const { request, fixture, opened } = await setup(t);
  assert.equal((await request('/api/vscode/windows')).body.windows.length, 2);
  assert.equal((await request(`/api/threads/${fixture.ids[0]}/open-vscode`, 'POST', { windowId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })).status, 200);
  assert.deepEqual(opened[0], { id: fixture.ids[0], windowId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
  assert.equal((await request(`/api/threads/${fixture.ids[0]}/open-vscode`, 'POST', { windowId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' })).status, 409);
});

test('SSE：外部修改的会话在增量推送中出现', async t => {
  const { fixture, base } = await setup(t);
  const controller = new AbortController();
  const response = await fetch(base + '/api/events', { signal: controller.signal });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const first = decoder.decode((await reader.read()).value);
  assert.match(first, /event: snapshot/);
  fixture.update(fixture.ids[0], '来自 VS Code 的实时更新');
  const timer = setTimeout(() => controller.abort(), 3000);
  let output = '';
  try {
    while (!output.includes('来自 VS Code 的实时更新')) {
      const { value, done } = await reader.read();
      if (done) break;
      output += decoder.decode(value);
    }
    assert.match(output, /来自 VS Code 的实时更新/);
  } finally { clearTimeout(timer); controller.abort(); }
});

test('归档同步：UI 创建的会话被 Codex 归档后不重新出现', async t => {
  const { fixture, request } = await setup(t);
  const created = (await request('/api/threads', 'POST', { cwd: fixture.cwd, title: '归档验收' })).body.thread;
  fixture.db.prepare('UPDATE threads SET archived=1 WHERE id=?').run(created.id);
  assert.ok(!(await request('/api/snapshot')).body.threads.some(x => x.id === created.id));
});

test('项目任务：新建归类，Fork 继承或清空，无效归类不创建对话', async t => {
  const { request, fixture, calls } = await setup(t);
  const projectResult = await request('/api/organization', 'PATCH', { action: 'createProject', name: 'YAM' });
  const projectId = projectResult.body.organization.projects[0].id;
  const taskResult = await request('/api/organization', 'PATCH', { action: 'createTask', projectId, name: '相机模块' });
  const taskId = taskResult.body.organization.tasks[0].id;
  const created = await request('/api/threads', 'POST', { cwd: fixture.cwd, projectId, taskId });
  assert.equal(created.status, 201);
  const parentId = created.body.thread.id;
  let snapshot = (await request('/api/snapshot')).body;
  assert.deepEqual(snapshot.organization.assignments[parentId], { projectId, taskId });
  assert.equal(snapshot.threads.find(thread => thread.id === parentId).folder, 'robot-project');
  const forked = await request(`/api/threads/${parentId}/fork`, 'POST', {});
  assert.equal(forked.status, 201);
  const unassigned = await request(`/api/threads/${parentId}/fork`, 'POST', { projectId: null, taskId: null });
  assert.equal(unassigned.status, 201);
  snapshot = (await request('/api/snapshot')).body;
  assert.deepEqual(snapshot.organization.assignments[forked.body.thread.id], { projectId, taskId });
  assert.equal(snapshot.organization.assignments[unassigned.body.thread.id], undefined);
  const count = calls.length;
  assert.equal((await request('/api/threads', 'POST', { cwd: fixture.cwd, projectId: randomUUID() })).status, 400);
  assert.equal((await request('/api/threads', 'POST', { cwd: fixture.cwd, projectId: null, taskId })).status, 400);
  assert.equal(calls.length, count);
});

test('HTTP：最近回复按需读取，隐藏会话不可访问且不触发模型调用', async t => {
  const { request, fixture, calls } = await setup(t);
  const before = fixture.db.prepare('SELECT * FROM threads ORDER BY id').all();
  const result = await request('/api/threads/' + fixture.ids[0] + '/replies');
  assert.equal(result.status, 200);
  assert.equal(result.body.replies.length, 1);
  assert.equal(result.body.replies[0].text, fixture.names[0] + '已有进展');
  assert.equal(result.body.limited, false);
  assert.equal((await request('/api/threads/not-a-uuid/replies')).status, 400);
  assert.equal((await request('/api/threads/55555555-5555-4555-8555-555555555555/replies')).status, 404);
  assert.equal((await request('/api/threads/44444444-4444-4444-8444-444444444444/replies')).status, 404);
  assert.deepEqual(calls, []);
  assert.deepEqual(fixture.db.prepare('SELECT * FROM threads ORDER BY id').all(), before);
});
