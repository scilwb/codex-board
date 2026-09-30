import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { createServer } from '../server/index.mjs';
import { UUID } from '../server/store.mjs';
import { makeFixture } from './fixture.mjs';

async function setup(t, options = {}) {
  const fixture = makeFixture();
  const appCalls = [], submissions = [], opens = [];
  const pathFor = id => fixture.db.prepare('SELECT rollout_path FROM threads WHERE id=?').get(id)?.rollout_path;
  const appServer = {
    async request(method, params) {
      appCalls.push({ method, params });
      if (method === 'thread/start') {
        const id = randomUUID();
        fixture.insert({ id, title: '新对话', source: 'appServer' });
        writeFileSync(pathFor(id), JSON.stringify({ type: 'session_meta', payload: { id, cwd: params.cwd } }) + '\n');
        return { thread: { id, path: pathFor(id), cwd: params.cwd } };
      }
      if (method === 'thread/name/set') fixture.db.prepare('UPDATE threads SET name=? WHERE id=?').run(params.name, params.threadId);
      else if (method === 'thread/archive') fixture.db.prepare('UPDATE threads SET archived=1 WHERE id=?').run(params.threadId);
      else if (!['thread/settings/update', 'thread/unsubscribe'].includes(method)) throw new Error(`Unexpected operation: ${method}`);
      return {};
    }, async stopAndWait() {},
  };
  const accepted = new Map();
  const accept = (id, params) => {
    if (!accepted.has(params.submissionId)) {
      const turnId = randomUUID();
      accepted.set(params.submissionId, turnId);
      appendFileSync(pathFor(id), JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: params.prompt } }) + '\n');
      appendFileSync(pathFor(id), JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } }) + '\n');
    }
    return { submitted: true, opened: true, verified: true, turnId: accepted.get(params.submissionId) };
  };
  const bridge = {
    async submitInheritance(id, params) {
      submissions.push({ id, params });
      return options.submit ? options.submit(id, params, accept) : accept(id, params);
    },
    async open(id, windowId) { opens.push({ id, windowId }); return { opened: true, verified: true }; },
    close() {},
  };
  let server, base;
  async function start() {
    server = createServer({ ...fixture, appServer, bridge, disableActions: options.disableActions, disableOpen: options.disableOpen });
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
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const create = async (prompt = '完整交接提示词\n保留关键文件与用户约束。\n') => {
    const response = await request(`/api/threads/${fixture.ids[0]}/inherit`, 'POST', { prompt, requestId: randomUUID() });
    assert.equal(response.status, 201);
    return response.body.thread;
  };
  return { fixture, request, create, appCalls, submissions, opens, accepted, pathFor, store: () => server.board.store,
    restart: async () => { await stop(); await start(); } };
}

const submissionPath = id => `/api/threads/${id}/inheritance/start`;

test('继承先保存独立空对话，再经编辑器发送完整可见首条消息，快照只发布发送状态', async t => {
  const { fixture, create, request, pathFor, store, appCalls, submissions } = await setup(t);
  appendFileSync(pathFor(fixture.ids[0]), JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6.1-sol', effort: 'ultra',
    collaboration_mode: { mode: 'default', settings: { model: 'gpt-6.1-sol', reasoning_effort: 'ultra' } } } }) + '\n');
  const sourceBefore = readFileSync(pathFor(fixture.ids[0]), 'utf8');
  const prompt = '用户亲自编辑的提示词\n/home/example/关键文件.md\n结尾保持空行。\n';
  const child = await create(prompt);
  assert.equal(child.inheritanceSubmission.status, 'pending');
  assert.ok(!appCalls.some(call => ['thread/inject_items', 'turn/start'].includes(call.method)));
  assert.ok(!readFileSync(pathFor(child.id), 'utf8').includes(prompt));
  const before = structuredClone(store().state);
  const windowId = randomUUID();
  const result = await request(submissionPath(child.id), 'POST', { windowId });
  assert.equal(result.status, 200);
  assert.equal(result.body.submitted, true);
  assert.equal(result.body.opened, true);
  assert.equal(result.body.verified, true);
  assert.equal(result.body.submission.status, 'submitted');
  assert.ok(UUID.test(result.body.submission.submissionId));
  assert.equal(result.body.turnId, result.body.submission.turnId);
  assert.deepEqual(submissions[0], { id: child.id, params: { windowId, prompt,
    settings: { model: 'gpt-6.1-sol', modelProvider: 'openai', reasoningEffort: 'ultra', collaborationMode: 'default', cwd: fixture.cwd },
    submissionId: result.body.submission.submissionId, allowDispatch: true, historyEmptyVerified: true } });
  assert.equal(readFileSync(pathFor(fixture.ids[0]), 'utf8'), sourceBefore);
  assert.ok(readFileSync(pathFor(child.id), 'utf8').includes(JSON.stringify(prompt)));
  const after = structuredClone(store().state);
  delete before.managedThreads[child.id].inheritance.submission;
  delete after.managedThreads[child.id].inheritance.submission;
  assert.deepEqual(after, before, 'sending modifies only inheritance submission metadata');
  const snapshot = (await request('/api/snapshot')).body;
  const shown = snapshot.threads.find(thread => thread.id === child.id);
  assert.equal(shown.inheritanceSubmission.status, 'submitted');
  assert.match(shown.preview, /已发送/);
  assert.ok(!JSON.stringify(snapshot).includes(prompt));
});

test('已确认发送后的网络重试与服务重启不重复发送，只在指定窗口时重新打开', async t => {
  const { create, request, submissions, opens, restart } = await setup(t);
  const child = await create();
  const first = await request(submissionPath(child.id), 'POST', {});
  await restart();
  const replay = await request(submissionPath(child.id), 'POST', {});
  assert.equal(replay.status, 200);
  assert.equal(replay.body.alreadySubmitted, true);
  assert.equal(replay.body.opened, false);
  assert.equal(replay.body.turnId, first.body.turnId);
  assert.equal(submissions.length, 1);
  assert.equal(opens.length, 0);
  const windowId = randomUUID();
  assert.equal((await request(submissionPath(child.id), 'POST', { windowId })).body.opened, true);
  assert.deepEqual(opens, [{ id: child.id, windowId }]);
  assert.equal(submissions.length, 1);
});

test('同一子对话并发发送请求合并，其他子对话仍能独立发送', async t => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const { create, request, submissions } = await setup(t, { async submit(id, params, accept) { entered(); await gate; return accept(id, params); } });
  const child = await create();
  const first = request(submissionPath(child.id), 'POST', {});
  await started;
  const second = request(submissionPath(child.id), 'POST', {});
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.body.turnId, b.body.turnId);
  assert.equal(submissions.length, 1);
});

test('发送前明确失败保留子对话和提示词，再试沿用同一发送标识', async t => {
  let fail = true;
  const { create, request, submissions, fixture, appCalls, store } = await setup(t, { submit(id, params, accept) {
    if (fail) throw Object.assign(new Error('目标窗口未连接'), { status: 503, dispatched: false });
    return accept(id, params);
  } });
  const child = await create();
  const failed = await request(submissionPath(child.id), 'POST', {});
  assert.equal(failed.status, 503);
  assert.equal(failed.body.submission.status, 'failed');
  assert.equal(failed.body.threadId, child.id);
  assert.equal(store().threads().length, 4);
  assert.ok(store().inheritance(child.id).prompt);
  assert.ok(!appCalls.some(call => call.method === 'thread/archive'));
  fail = false;
  const retry = await request(submissionPath(child.id), 'POST', {});
  assert.equal(retry.status, 200);
  assert.equal(submissions[1].params.submissionId, submissions[0].params.submissionId);
  assert.equal(submissions[1].params.allowDispatch, true);
  assert.notEqual(child.id, fixture.ids[0]);
});

test('消息已提交但响应丢失标为未知，重启后同一标识确认现有消息不会再次发送', async t => {
  let lose = true;
  const { create, request, submissions, accepted, restart, pathFor } = await setup(t, { submit(id, params, accept) {
    const result = accept(id, params);
    if (lose) throw Object.assign(new Error('等待编辑器确认超时'), { status: 504, dispatched: true });
    return result;
  } });
  const prompt = '仅发送一次的首条接续消息。';
  const child = await create(prompt);
  const failed = await request(submissionPath(child.id), 'POST', {});
  assert.equal(failed.status, 504);
  assert.equal(failed.body.submission.status, 'unknown');
  await restart();
  lose = false;
  const retry = await request(submissionPath(child.id), 'POST', {});
  assert.equal(retry.status, 200);
  assert.equal(retry.body.submission.status, 'submitted');
  assert.equal(submissions[1].params.submissionId, submissions[0].params.submissionId);
  assert.equal(submissions[1].params.allowDispatch, false);
  assert.equal(accepted.size, 1);
  assert.equal(readFileSync(pathFor(child.id), 'utf8').split(prompt).length - 1, 1);
});

test('重启中断的发送状态改为未知，保留发送标识供桥接核对', async t => {
  const { create, request, store, restart, submissions } = await setup(t, { submit(id, params, accept) {
    if (!params.allowDispatch) throw Object.assign(new Error('现有空历史无法确认此前发送结果'), { status: 503, dispatched: true });
    return accept(id, params);
  } });
  const child = await create();
  const submissionId = randomUUID();
  store().updateInheritanceSubmission(child.id, { status: 'dispatching', submissionId, updatedAt: Date.now() });
  await restart();
  const snapshot = (await request('/api/snapshot')).body;
  assert.equal(snapshot.threads.find(thread => thread.id === child.id).inheritanceSubmission.status, 'unknown');
  const retry = await request(submissionPath(child.id), 'POST', {});
  assert.equal(retry.status, 503);
  assert.equal(retry.body.submission.status, 'unknown');
  assert.equal(submissions[0].params.submissionId, submissionId);
  assert.equal(submissions[0].params.allowDispatch, false);
  assert.equal(submissions[0].params.historyEmptyVerified, true);
});

test('未知发送的核对遇到窗口断开仍保持未知，后续核对不能重新允许发送', async t => {
  let phase = 0;
  const { create, request, submissions } = await setup(t, { submit(id, params, accept) {
    if (phase++ === 0) {
      accept(id, params);
      throw Object.assign(new Error('发送后确认丢失'), { status: 504, dispatched: true });
    }
    if (phase === 2) throw Object.assign(new Error('核对时窗口断开'), { status: 503, dispatched: false });
    return accept(id, params);
  } });
  const child = await create();
  assert.equal((await request(submissionPath(child.id), 'POST', {})).body.submission.status, 'unknown');
  assert.equal((await request(submissionPath(child.id), 'POST', {})).body.submission.status, 'unknown');
  assert.equal((await request(submissionPath(child.id), 'POST', {})).body.submission.status, 'submitted');
  assert.deepEqual(submissions.map(item => item.params.allowDispatch), [true, false, false]);
  assert.equal(new Set(submissions.map(item => item.params.submissionId)).size, 1);
});

test('桥接未明确确认真实发送时不误报完成，仍可重新核对', async t => {
  const { create, request } = await setup(t, { submit() { return { opened: true, verified: true, submitted: false }; } });
  const child = await create();
  const result = await request(submissionPath(child.id), 'POST', {});
  assert.equal(result.status, 502);
  assert.equal(result.body.submission.status, 'unknown');
  assert.equal(result.body.submitted, undefined);
});

test('旧版仅注入上下文的继承对话可补发保存的提示词，快照显示兼容状态', async t => {
  const { fixture, store, request, submissions, pathFor } = await setup(t);
  const id = randomUUID(), prompt = '旧继承保存的提示词';
  fixture.insert({ id, title: '旧继承', source: 'appServer' });
  writeFileSync(pathFor(id), JSON.stringify({ type: 'response_item', payload: {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }],
  } }) + '\n');
  store().remember({ id, title: '旧继承', cwd: fixture.cwd, inheritedFromId: fixture.ids[0], preview: '旧版上下文',
    inheritance: { source: { id: fixture.ids[0], title: fixture.names[0], cwd: fixture.cwd }, prompt, settings: {} } });
  const snapshot = (await request('/api/snapshot')).body;
  assert.equal(snapshot.threads.find(thread => thread.id === id).inheritanceSubmission.status, 'legacy');
  assert.match(snapshot.threads.find(thread => thread.id === id).preview, /查看接续状态/);
  assert.equal((await request(submissionPath(id), 'POST', {})).status, 200);
  assert.equal(submissions[0].params.prompt, prompt);
});

test('发送接口校验来源、窗口和历史文件，拒绝普通、隐藏和归档对话', async t => {
  const { fixture, create, request, submissions, pathFor } = await setup(t);
  assert.equal((await request(submissionPath(fixture.ids[0]), 'POST', {})).status, 404);
  assert.equal((await request(submissionPath('bad'), 'POST', {})).status, 400);
  for (const id of ['44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555']) {
    assert.equal((await request(submissionPath(id), 'POST', {})).status, 404);
  }
  const child = await create();
  assert.equal((await request(submissionPath(child.id), 'POST', { windowId: 'not-a-window' })).status, 400);
  unlinkSync(pathFor(child.id));
  assert.equal((await request(submissionPath(child.id), 'POST', {})).status, 409);
  assert.equal(submissions.length, 0);
});

test('非空、超出窗口、无效记录或未写完的历史都不能证明新对话为空', async t => {
  const { create, request, submissions, pathFor } = await setup(t);
  const records = [
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: '已有真实用户消息' } }) + '\n',
    JSON.stringify({ type: 'session_meta', payload: { oversized: 'x'.repeat(140 * 1024) } }) + '\n',
    'invalid json record\n',
    JSON.stringify({ type: 'session_meta', payload: { id: randomUUID() } }),
  ];
  for (const text of records) {
    const child = await create();
    appendFileSync(pathFor(child.id), text);
    await request(submissionPath(child.id), 'POST', {});
    assert.equal(submissions.at(-1).params.historyEmptyVerified, false);
  }
});

test('历史读取失败不提供空记录证明，也不会启动看板应用服务器读取或恢复历史', async t => {
  const { create, request, submissions, store, appCalls } = await setup(t);
  const child = await create();
  const original = store().publicHistory;
  const before = appCalls.length;
  store().publicHistory = async () => { throw new Error('历史读取失败'); };
  try {
    await request(submissionPath(child.id), 'POST', {});
    assert.equal(submissions[0].params.historyEmptyVerified, false);
    assert.equal(appCalls.length, before);
  } finally { store().publicHistory = original; }
});

for (const disabled of ['disableOpen', 'disableActions']) {
  test(`禁用 ${disabled} 时保存的继承提示也不会发送`, async t => {
    const { fixture, request, store, submissions } = await setup(t, { [disabled]: true });
    const id = fixture.ids[0];
    store().remember({ id, inheritedFromId: fixture.ids[1], inheritance: { prompt: '不应发送', settings: {}, source: { id: fixture.ids[1] } } });
    assert.equal((await request(submissionPath(id), 'POST', {})).status, 503);
    assert.equal(submissions.length, 0);
  });
}

test('发送凭据写盘失败时不调用桥接，初始状态与提示词保持不变', async t => {
  const { create, request, store, submissions } = await setup(t);
  const child = await create();
  const before = structuredClone(store().state);
  const save = store().save;
  store().save = () => { throw new Error('磁盘写入失败'); };
  try {
    const result = await request(submissionPath(child.id), 'POST', {});
    assert.equal(result.status, 400);
    assert.equal(submissions.length, 0);
    assert.deepEqual(store().state, before);
  } finally { store().save = save; }
});

test('发送后凭据落盘失败不归档子对话，恢复后按既有凭据确认一次发送', async t => {
  let storeRef, fail = true;
  const { create, request, store, submissions, accepted, appCalls } = await setup(t, { submit(id, params, accept) {
    const result = accept(id, params);
    if (fail) storeRef.save = () => { throw new Error('发送确认写盘失败'); };
    return result;
  } });
  storeRef = store();
  const save = storeRef.save;
  const child = await create();
  const failed = await request(submissionPath(child.id), 'POST', {});
  assert.equal(failed.body.submission.status, 'dispatching');
  assert.ok(!appCalls.some(call => call.method === 'thread/archive'));
  storeRef.save = save; fail = false;
  assert.equal((await request(submissionPath(child.id), 'POST', {})).status, 200);
  assert.equal(submissions[1].params.submissionId, submissions[0].params.submissionId);
  assert.equal(submissions[1].params.allowDispatch, false);
  assert.equal(accepted.size, 1);
});

test('状态写入拒绝改动发送标识或撤销已确认发送，未知字段不能覆盖提示词', async t => {
  const { create, request, store } = await setup(t);
  const child = await create();
  const before = structuredClone(store().state);
  for (const submission of [
    { status: 'wrong', updatedAt: Date.now() },
    { status: 'pending', updatedAt: Date.now(), prompt: '替换提示词' },
    { status: 'dispatching', updatedAt: Date.now(), submissionId: 'bad' },
  ]) assert.throws(() => store().updateInheritanceSubmission(child.id, submission), /状态无效/);
  assert.deepEqual(store().state, before);
  await request(submissionPath(child.id), 'POST', {});
  const sent = store().inheritance(child.id).submission;
  assert.throws(() => store().updateInheritanceSubmission(child.id, { ...sent, submissionId: randomUUID() }), /标识不能改变/);
  assert.throws(() => store().updateInheritanceSubmission(child.id, { ...sent, status: 'pending' }), /不能再次提交/);
});
