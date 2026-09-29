import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { createServer } from '../server/index.mjs';
import { BoardStore } from '../server/store.mjs';
import { makeFixture } from './fixture.mjs';
import { HANDOFF_PROMPT_LIMIT } from '../server/handoff.mjs';

async function setup(t, options = {}) {
  const fixture = makeFixture();
  const calls = [];
  const pathFor = id => fixture.db.prepare('SELECT rollout_path FROM threads WHERE id=?').get(id)?.rollout_path;
  const appServer = { async request(method, params) {
    calls.push({ method, params });
    if (method === 'thread/start') {
      const id = randomUUID();
      fixture.insert({ id, title: '新对话', source: 'appServer' });
      writeFileSync(pathFor(id), JSON.stringify({ type: 'session_meta', payload: { id, cwd: params.cwd } }) + '\n');
      return { thread: { id, path: pathFor(id), cwd: params.cwd } };
    }
    if (method === 'thread/name/set') {
      fixture.db.prepare('UPDATE threads SET name=? WHERE id=?').run(params.name, params.threadId);
      return {};
    }
    if (method === 'thread/settings/update') {
      await options.settingsUpdate?.(params);
      appendFileSync(pathFor(params.threadId), JSON.stringify({ type: 'event_msg', payload: {
        type: 'thread_settings_applied', thread_settings: {
          model: params.model, reasoning_effort: params.effort, collaboration_mode: params.collaborationMode,
        },
      } }) + '\n');
      return {};
    }
    if (method === 'thread/inject_items') {
      await options.inject?.(params);
      for (const item of params.items) appendFileSync(pathFor(params.threadId), JSON.stringify({ type: 'response_item', payload: item }) + '\n');
      return {};
    }
    if (method === 'thread/unsubscribe') return {};
    if (method === 'thread/archive') {
      await options.archive?.(params);
      fixture.db.prepare('UPDATE threads SET archived=1 WHERE id=?').run(params.threadId);
      return {};
    }
    throw new Error(`Unexpected operation: ${method}`);
  }, async stopAndWait() { await options.stopAndWait?.(); } };
  const server = createServer({ ...fixture, appServer, disableActions: options.disableActions, pollIntervalMs: 100 });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.board.closeStreams();
    const done = once(server, 'close');
    server.close(); server.closeAllConnections(); await done;
    fixture.cleanup();
  });
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  return { fixture, calls, request, server, pathFor };
}

test('继承预览按需读取公开片段，隐藏或缺失历史不泄漏，预览不调用模型', async t => {
  const { fixture, calls, request, pathFor } = await setup(t);
  const id = fixture.ids[0];
  const before = readFileSync(pathFor(id), 'utf8');
  const preview = await request(`/api/threads/${id}/handoff`);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.source.id, id);
  assert.ok(preview.body.prompt.includes(`请处理${fixture.names[0]}`));
  assert.ok(preview.body.prompt.includes(fixture.names[0] + '已有进展'));
  assert.ok(preview.body.prompt.length <= HANDOFF_PROMPT_LIMIT);
  assert.equal(preview.body.maxPromptLength, HANDOFF_PROMPT_LIMIT);
  assert.equal(preview.body.version, 2);
  assert.ok(Array.isArray(preview.body.files));
  assert.equal(readFileSync(pathFor(id), 'utf8'), before);
  assert.deepEqual(calls, []);
  assert.equal((await request('/api/threads/44444444-4444-4444-8444-444444444444/handoff')).status, 404);
  assert.equal((await request('/api/threads/55555555-5555-4555-8555-555555555555/handoff')).status, 404);
  assert.equal((await request('/api/threads/bad/handoff')).status, 400);
  unlinkSync(pathFor(id));
  assert.equal((await request(`/api/threads/${id}/handoff`)).status, 503);
});

test('交接中的来源字节可通过只读接口准确找回公开消息，拒绝隐藏会话和非法偏移', async t => {
  const { fixture, request, calls, pathFor } = await setup(t);
  const id = fixture.ids[0];
  const path = pathFor(id);
  appendFileSync(path, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'analysis', content: [{ type: 'output_text', text: 'HISTORY_PRIVATE_ANALYSIS' }] } }) + '\n');
  const before = readFileSync(path, 'utf8');
  const preview = (await request(`/api/threads/${id}/handoff`)).body;
  const offsets = [...preview.prompt.matchAll(/来源字节 (\d+) · 记录长度 (\d+)/g)];
  assert.ok(offsets.length > 0);
  for (const [, offset, byteLength] of offsets) {
    const history = await request(`/api/threads/${id}/history?offset=${offset}`);
    assert.equal(history.status, 200);
    assert.equal(history.body.messages[0].offset, Number(offset));
    assert.equal(history.body.messages[0].byteLength, Number(byteLength));
    assert.ok(!JSON.stringify(history.body).includes('HISTORY_PRIVATE_ANALYSIS'));
  }
  for (const offset of ['-1', 'abc', '1.5', '1e4', '9007199254740992', String(Buffer.byteLength(before) + 1)]) {
    assert.equal((await request(`/api/threads/${id}/history?offset=${offset}`)).status, 400);
  }
  assert.equal((await request('/api/threads/bad/history')).status, 400);
  assert.equal((await request('/api/threads/44444444-4444-4444-8444-444444444444/history')).status, 404);
  assert.equal((await request('/api/threads/55555555-5555-4555-8555-555555555555/history')).status, 404);
  assert.deepEqual(calls, []);
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('继承创建独立ID和短提示上下文，沿用分类，来源持久化且快照不携带提示全文', async t => {
  const { fixture, calls, request, pathFor } = await setup(t);
  const id = fixture.ids[0];
  const sourceBefore = readFileSync(pathFor(id), 'utf8');
  const project = (await request('/api/organization', 'PATCH', { action: 'createProject', name: '继承项目' })).body.organization.projects[0];
  const task = (await request('/api/organization', 'PATCH', { action: 'createTask', projectId: project.id, name: '继承任务' })).body.organization.tasks[0];
  await request('/api/organization', 'PATCH', { action: 'assign', threadIds: [id], projectId: project.id, taskId: task.id });
  const prompt = '交接内容：只需记住选择方案B，等待我的下一条要求。';
  const result = await request(`/api/threads/${id}/inherit`, 'POST', { prompt });
  assert.equal(result.status, 201);
  const created = result.body.thread;
  assert.notEqual(created.id, id);
  assert.equal(created.forkedFromId, null);
  assert.equal(created.inheritedFromId, id);
  assert.equal(created.title, fixture.names[0] + ' · 续聊');
  assert.deepEqual(calls.map(call => call.method), ['thread/start', 'thread/name/set', 'thread/settings/update', 'thread/inject_items', 'thread/unsubscribe']);
  assert.equal(calls[0].params.cwd, fixture.cwd);
  assert.equal(calls[0].params.ephemeral, false);
  assert.deepEqual(calls[3].params, { threadId: created.id, items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }] });
  assert.equal(readFileSync(pathFor(id), 'utf8'), sourceBefore);
  assert.ok(!readFileSync(pathFor(created.id), 'utf8').includes(fixture.names[0] + '已有进展'));
  const snapshot = (await request('/api/snapshot')).body;
  assert.equal(snapshot.threads.find(thread => thread.id === created.id).inheritedFromId, id);
  assert.deepEqual(snapshot.organization.assignments[created.id], { projectId: project.id, taskId: task.id });
  assert.ok(!JSON.stringify(snapshot).includes(prompt));
  const handoff = await request(`/api/threads/${created.id}/inheritance`);
  assert.equal(handoff.status, 200);
  assert.equal(handoff.body.prompt, prompt);
  assert.equal(handoff.body.source.id, id);
  assert.equal((await request(`/api/threads/${id}/inheritance`)).status, 404);
  const reopened = new BoardStore(fixture);
  try {
    assert.equal(reopened.threads().find(thread => thread.id === created.id).inheritedFromId, id);
    assert.equal(reopened.inheritance(created.id).prompt, prompt);
  } finally { reopened.close(); }
});

test('继承校验在创建前完成，允许显式清空项目与任务', async t => {
  const { fixture, request, calls } = await setup(t);
  const url = `/api/threads/${fixture.ids[0]}/inherit`;
  for (const prompt of ['', '   ', null, 3, 'a'.repeat(HANDOFF_PROMPT_LIMIT + 1), 'invalid\0text']) {
    assert.equal((await request(url, 'POST', { prompt })).status, 400);
  }
  assert.equal((await request(url, 'POST', { prompt: '继续', cwd: '/no-such-inheritance-dir' })).status, 400);
  assert.equal((await request(url, 'POST', { prompt: '继续', projectId: randomUUID() })).status, 400);
  assert.equal((await request('/api/threads/55555555-5555-4555-8555-555555555555/inherit', 'POST', { prompt: '继续' })).status, 404);
  assert.equal(calls.length, 0);
  const created = (await request(url, 'POST', { prompt: '继续', projectId: null, taskId: null })).body.thread;
  assert.equal((await request('/api/snapshot')).body.organization.assignments[created.id], undefined);
});

test('继承响应与发布等待创建进程释放写锁，期间不接受第二次创建', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const stopping = new Promise(resolve => { entered = resolve; });
  let stops = 0;
  const { fixture, request, server } = await setup(t, { async stopAndWait() {
    if (++stops === 1) { entered(); await gate; }
  } });
  let returned = false;
  const creation = request(`/api/threads/${fixture.ids[0]}/inherit`, 'POST', { prompt: '交接资料' })
    .then(result => { returned = true; return result; });
  t.after(() => release());
  await stopping;
  assert.equal(returned, false, 'HTTP success must not race the native writer exit');
  assert.equal(Object.values(server.board.store.state.managedThreads).filter(thread => thread.inheritance).length, 0);
  const concurrent = await request(`/api/threads/${fixture.ids[0]}/inherit`, 'POST', { prompt: '另一份资料' });
  assert.equal(concurrent.status, 409);
  release();
  const result = await creation;
  assert.equal(result.status, 201);
  assert.ok(server.board.store.inheritance(result.body.thread.id));
});

test('注入失败归档此次空对话，来源保持原样，重试可成功', async t => {
  let fail = true;
  const { fixture, request, calls, pathFor } = await setup(t, { inject() { if (fail) throw new Error('Unsupported thread/inject_items'); } });
  const id = fixture.ids[0];
  const before = readFileSync(pathFor(id), 'utf8');
  const url = `/api/threads/${id}/inherit`;
  const result = await request(url, 'POST', { prompt: '编辑过的交接内容' });
  assert.equal(result.status, 502);
  assert.match(result.body.error, /已归档/);
  const archivedId = calls.find(call => call.method === 'thread/archive').params.threadId;
  assert.notEqual(archivedId, id);
  assert.equal(readFileSync(pathFor(id), 'utf8'), before);
  assert.equal((await request('/api/snapshot')).body.threads.length, 3);
  fail = false;
  const retry = await request(url, 'POST', { prompt: '编辑过的交接内容' });
  assert.equal(retry.status, 201);
  assert.notEqual(retry.body.thread.id, archivedId);
  assert.equal((await request('/api/snapshot')).body.threads.length, 4);
});

test('归档补偿失败明确指出留下的新ID，不误报继承成功', async t => {
  const { fixture, request, calls } = await setup(t, { inject() { throw new Error('注入失败'); }, archive() { throw new Error('归档失败'); } });
  const result = await request(`/api/threads/${fixture.ids[0]}/inherit`, 'POST', { prompt: '交接内容' });
  const id = calls.find(call => call.method === 'thread/archive').params.threadId;
  assert.equal(result.status, 502);
  assert.ok(result.body.error.includes(id));
  assert.match(result.body.error, /未能自动归档/);
});

test('并行重复创建在前一操作结束前被拒绝', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const { fixture, request, calls } = await setup(t, { async inject() { entered(); await gate; } });
  const url = `/api/threads/${fixture.ids[0]}/inherit`;
  const pending = request(url, 'POST', { prompt: '交接内容' });
  await started;
  try {
    assert.equal((await request(url, 'POST', { prompt: '交接内容' })).status, 409);
  } finally { release(); }
  assert.equal((await pending).status, 201);
  assert.equal(calls.filter(call => call.method === 'thread/start').length, 1);
});

test('禁用操作时不创建继承对话', async t => {
  const { fixture, request, calls } = await setup(t, { disableActions: true });
  assert.equal((await request('/api/snapshot')).body.capabilities.inherit, false);
  assert.equal((await request(`/api/threads/${fixture.ids[0]}/inherit`, 'POST', { prompt: '交接内容' })).status, 503);
  assert.deepEqual(calls, []);
});


test('继承读取最新模型和推理配置，忽略客户端伪造值与安全设置', async t => {
  const { fixture, request, calls, pathFor } = await setup(t);
  const id = fixture.ids[0];
  const writeSettings = (model, effort, mode) => appendFileSync(pathFor(id), JSON.stringify({ type: 'turn_context', payload: {
    model, effort, collaboration_mode: { mode, settings: { model, reasoning_effort: effort, developer_instructions: '不要复制此字段' } },
    approval_policy: 'on-request', sandbox_policy: { type: 'workspace-write' }, approvals_reviewer: 'auto_review',
  } }) + '\n');
  writeSettings('gpt-6-astra', 'xhigh', 'plan');
  const preview = await request(`/api/threads/${id}/handoff`);
  assert.equal(preview.body.settings.model, 'gpt-6-astra');
  assert.equal(preview.body.settings.reasoningEffort, 'xhigh');
  assert.equal(preview.body.settings.collaborationMode, 'plan');
  assert.ok(!JSON.stringify(preview.body.settings).includes('on-request'));
  assert.ok(!JSON.stringify(preview.body.settings).includes('workspace-write'));
  // A source-side setting change while the preview is open must be respected.
  writeSettings('gpt-6-sol', 'ultra', 'default');
  const before = readFileSync(pathFor(id), 'utf8');
  const result = await request(`/api/threads/${id}/inherit`, 'POST', { prompt: '交接内容', model: 'wrong-model', effort: 'low' });
  assert.equal(result.status, 201);
  const start = calls.find(call => call.method === 'thread/start').params;
  assert.equal(start.model, 'gpt-6-sol');
  assert.equal(start.modelProvider, 'openai');
  assert.deepEqual(start.config, { model_reasoning_effort: 'ultra' });
  assert.equal(start.approvalPolicy, 'never');
  assert.equal(start.permissions, ':danger-full-access');
  assert.equal(start.sandbox, undefined);
  const update = calls.find(call => call.method === 'thread/settings/update').params;
  assert.deepEqual(update, {
    threadId: result.body.thread.id, model: 'gpt-6-sol', effort: 'ultra',
    approvalPolicy: 'never', permissions: ':danger-full-access',
    collaborationMode: { mode: 'default', settings: { model: 'gpt-6-sol', reasoning_effort: 'ultra', developer_instructions: null } },
  });
  assert.ok(calls.findIndex(call => call.method === 'thread/settings/update') < calls.findIndex(call => call.method === 'thread/inject_items'));
  const stored = (await request(`/api/threads/${result.body.thread.id}/inheritance`)).body;
  assert.equal(stored.settings.model, 'gpt-6-sol');
  assert.equal(stored.settings.reasoningEffort, 'ultra');
  assert.equal(readFileSync(pathFor(id), 'utf8'), before);
});

test('模型设置写入失败会归档新对话，不默默退回默认配置', async t => {
  const { fixture, request, calls, pathFor } = await setup(t, { settingsUpdate() { throw new Error('配置保存失败'); } });
  appendFileSync(pathFor(fixture.ids[0]), JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6-astra', effort: 'xhigh' } }) + '\n');
  const result = await request(`/api/threads/${fixture.ids[0]}/inherit`, 'POST', { prompt: '交接内容' });
  assert.equal(result.status, 502);
  assert.match(result.body.error, /配置保存失败/);
  assert.ok(calls.some(call => call.method === 'thread/archive'));
  assert.ok(!calls.some(call => call.method === 'thread/inject_items'));
  assert.equal((await request('/api/snapshot')).body.threads.length, 3);
});
