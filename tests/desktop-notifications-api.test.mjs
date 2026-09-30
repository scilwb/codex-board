import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { appendFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from '../server/index.mjs';
import { createActivityTracker } from '../src/activity.js';
import { makeFixture } from './fixture.mjs';

test('桌面通知后台独立运行，静音不回放，HTTP 设置与测试有明确结果', async t => {
  const fixture = makeFixture();
  const observe = createActivityTracker();
  const sent = [];
  let enabled = false, tests = 0, closed = false, testError = null;
  const desktopNotifications = {
    status: () => ({ enabled, available: true, lastError: testError }),
    setEnabled(value) { enabled = value; },
    observe(threads) { const notices = observe(threads); if (enabled) sent.push(...notices); },
    async test() { tests++; if (testError) throw new Error(testError); },
    close() { closed = true; },
  };
  const server = createServer({ ...fixture, desktopNotifications, pollIntervalMs: 20 });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.board.closeStreams();
    const done = once(server, 'close'); server.close(); server.closeAllConnections(); await done;
    assert.equal(closed, true); fixture.cleanup();
  });
  const request = async (method, path, value, headers = {}) => {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await request('GET', '/api/notifications')).body.enabled, false);
  assert.equal((await request('PATCH', '/api/notifications', { enabled: 'true' })).status, 400);
  assert.equal((await request('PATCH', '/api/notifications', { enabled: true }, { origin: 'https://other.invalid' })).status, 403);
  assert.equal((await request('PATCH', '/api/notifications', { enabled: true })).body.enabled, true);
  assert.deepEqual(sent, [], 'enabling must not replay the initial completed threads');
  const file = fixture.db.prepare('SELECT rollout_path FROM threads WHERE id=?').get(fixture.ids[0]).rollout_path;
  const append = (type, payload) => appendFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + '\n');
  append('event_msg', { type: 'task_started', turn_id: 'desktop-turn' });
  append('response_item', { type: 'function_call', name: 'functions.request_user_input', call_id: 'desktop-question', arguments: '{}' });
  // No page, SSE client, or snapshot request: only the server timer observes it.
  for (let i = 0; i < 30 && sent.length < 1; i++) await delay(20);
  assert.equal(sent.length, 1); assert.equal(sent[0].status, 'waiting');
  await delay(60); assert.equal(sent.length, 1, 'repeated background polls must not duplicate notifications');
  await request('PATCH', '/api/notifications', { enabled: false });
  append('response_item', { type: 'function_call_output', call_id: 'desktop-question', output: '{"answers":{"choice":{"answers":["ok"]}}}' });
  append('event_msg', { type: 'task_complete', turn_id: 'desktop-turn', last_agent_message: '已结束' });
  await delay(60);
  await request('PATCH', '/api/notifications', { enabled: true });
  await delay(40); assert.equal(sent.length, 1, 'muted completion must not replay on enable');
  append('event_msg', { type: 'task_started', turn_id: 'next-turn' });
  append('event_msg', { type: 'task_complete', turn_id: 'next-turn', last_agent_message: '另一轮已结束' });
  for (let i = 0; i < 30 && sent.length < 2; i++) await delay(20);
  assert.equal(sent[1]?.status, 'completed');
  assert.equal((await request('POST', '/api/notifications/test', {})).body.ok, true);
  testError = '无法连接系统通知服务';
  const failure = await request('POST', '/api/notifications/test', {});
  assert.equal(failure.status, 400); assert.equal(failure.body.error, testError);
  assert.equal(tests, 2);
});
