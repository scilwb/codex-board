import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import { createServer } from '../server/index.mjs';
import { makeFixture } from './fixture.mjs';

const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_BUNDLED ? {} : { channel: 'chrome' }), headless: true });
const results = [];
const errors = [];
mkdirSync('artifacts', { recursive: true });
async function check(name, operation, { positioned = true } = {}) {
  if (process.env.UI_RESILIENCE_CASE && !name.includes(process.env.UI_RESILIENCE_CASE)) return;
  const fixture = makeFixture();
  const calls = [];
  const pathFor = id => fixture.db.prepare('SELECT rollout_path FROM threads WHERE id=?').get(id)?.rollout_path;
  const appServer = { async request(method, params) {
    calls.push({ method, params });
    if (method === 'thread/start' || method === 'thread/fork') {
      const id = randomUUID();
      fixture.insert({ id, title: '隔离创建测试', source: 'appServer', parent: method === 'thread/fork' ? params.threadId : null });
      return { thread: { id, path: pathFor(id), cwd: params.cwd || fixture.cwd } };
    }
    if (method === 'thread/name/set') { fixture.db.prepare('UPDATE threads SET name=? WHERE id=?').run(params.name, params.threadId); return {}; }
    if (method === 'thread/settings/update' || method === 'thread/unsubscribe') return {};
    if (method === 'thread/inject_items') { for (const item of params.items) appendFileSync(pathFor(params.threadId), JSON.stringify({ type: 'response_item', payload: item }) + '\n'); return {}; }
    if (method === 'thread/archive') { fixture.db.prepare('UPDATE threads SET archived=1 WHERE id=?').run(params.threadId); return {}; }
    throw new Error(`Unexpected model operation: ${method}`);
  } };
  const server = createServer({ ...fixture, appServer, pollIntervalMs: 60_000 });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.ok(response.ok, `Fixture request failed: ${path} ${response.status}`);
    return response.json();
  };
  const edgeId = randomUUID();
  if (positioned) await request('/api/graph', 'PATCH', { positions: Object.fromEntries(fixture.ids.map((id, i) => [id, { x: i * 350 + 40, y: 40 }])), edges: [{ id: edgeId, source: fixture.ids[0], target: fixture.ids[1], type: 'reference' }] });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
  await page.addInitScript(() => {
    const NativeEventSource = EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(...args) { super(...args); window.fixtureEvents = this; }
    };
  });
  page.on('pageerror', error => errors.push({ name, error: error.message }));
  const emit = async () => {
    const snapshot = await request('/api/snapshot');
    await page.evaluate(data => window.fixtureEvents.dispatchEvent(new MessageEvent('snapshot', { data: JSON.stringify(data) })), snapshot);
  };
  const ready = async () => {
    await page.goto(base);
    await expect(page.getByTestId('thread-list').locator('button')).toHaveCount(3);
    await expect(page.getByTestId('sync-status')).toContainText('已连接');
    // The canvas performs its initial fit after 90 ms; start gestures after it settles.
    await page.waitForTimeout(150);
  };
  const rendered = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  try {
    await operation({ page, fixture, server, base, request, emit, ready, rendered, edgeId, calls });
    results.push({ name, result: 'PASS' });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, result: 'FAIL', error: error.message });
    console.error(`FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await page.close();
    server.board.closeStreams();
    const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed;
    fixture.cleanup();
  }
}
try {
  await check('延迟 HTTP 快照不能回退已收到的新 SSE 数据', async ({ page, fixture, base, ready, emit, rendered }) => {
    let release;
    let entered = false;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route(`${base}/api/snapshot`, async route => {
      const response = await route.fetch(); entered = true;
      await gate;
      await route.fulfill({ response }).catch(() => {});
    });
    try {
      await ready();
      await expect.poll(() => entered).toBe(true);
      fixture.update(fixture.ids[0], '这是较新的同步消息');
      await emit();
      await expect(page.getByTestId(`session-node-${fixture.ids[0]}`)).toContainText('这是较新的同步消息');
      const response = page.waitForResponse(`${base}/api/snapshot`);
      release(); await response; await rendered();
      assert.ok((await page.getByTestId(`session-node-${fixture.ids[0]}`).textContent()).includes('这是较新的同步消息'), 'Old HTTP response rolled the card back');
    } finally { release(); }
  });
  await check('拖动中的卡片遇到快照更新仍保留选中状态和坐标', async ({ page, fixture, ready, emit, rendered }) => {
    await ready();
    const id = fixture.ids[0];
    const card = page.getByTestId(`session-node-${id}`);
    const node = page.locator(`.react-flow__node[data-id="${id}"]`);
    const box = await card.locator('.card-heading').boundingBox();
    await page.mouse.move(box.x + 80, box.y + 10); await page.mouse.down();
    await page.mouse.move(box.x + 125, box.y + 55, { steps: 8 });
    try {
      await expect(card).toHaveClass(/is-selected/);
      const before = await node.evaluate(element => element.style.transform);
      fixture.update(id, '拖动过程中到达的新消息');
      await emit(); await rendered();
      assert.ok((await card.getAttribute('class')).includes('is-selected'), 'Snapshot removed the dragged card selection');
      assert.equal(await node.evaluate(element => element.style.transform), before);
    } finally { await page.mouse.up(); }
  });
  await check('前一次连线保存失败不能覆盖后一次编辑，全部失败回到已保存值', async ({ page, base, edgeId, ready, rendered }) => {
    await ready();
    await page.locator(`.react-flow__edge[data-id="${edgeId}"] .react-flow__edge-textwrapper`).click();
    const pending = [];
    await page.route(`${base}/api/graph`, route => { if (route.request().method() === 'PATCH') pending.push(route); else return route.continue(); });
    try {
      await page.getByTestId('edge-type').selectOption('serial');
      await expect.poll(() => pending.length).toBe(1);
      await page.getByTestId('edge-type').selectOption('parallel');
      await pending[0].fulfill({ status: 503, contentType: 'application/json', body: '{"error":"第一次保存失败"}' });
      await expect.poll(() => pending.length).toBe(2);
      await rendered();
      const intermediate = await page.getByTestId('edge-type').inputValue();
      await pending[1].fulfill({ status: 503, contentType: 'application/json', body: '{"error":"第二次保存失败"}' });
      await rendered();
      const final = await page.getByTestId('edge-type').inputValue();
      assert.deepEqual({ intermediate, final }, { intermediate: 'parallel', final: 'reference' });
    } finally { for (const route of pending) await route.abort().catch(() => {}); }
  });
  await check('拖动保存失败保护较新的拖动，全部失败后回退已保存坐标', async ({ page, fixture, base, ready, emit, rendered }) => {
    await ready();
    const id = fixture.ids[0];
    const card = page.getByTestId(`session-node-${id}`);
    const node = page.locator(`.react-flow__node[data-id="${id}"]`);
    const transform = () => node.evaluate(element => element.style.transform);
    const original = await transform();
    const pending = [];
    await page.route(`${base}/api/graph`, route => { if (route.request().method() === 'PATCH') pending.push(route); else return route.continue(); });
    const drag = async () => {
      const box = await card.locator('h3').boundingBox();
      await page.mouse.move(box.x + 60, box.y + 10); await page.mouse.down();
      await page.mouse.move(box.x + 120, box.y + 50, { steps: 8 });
      await page.mouse.up();
      await rendered();
    };
    try {
      await drag();
      await expect.poll(() => pending.length).toBe(1);
      await drag();
      const latest = await transform();
      assert.notEqual(latest, original);
      await pending[0].fulfill({ status: 503, contentType: 'application/json', body: '{"error":"第一次位置保存失败"}' });
      await expect.poll(() => pending.length).toBe(2);
      await rendered();
      assert.equal(await transform(), latest, 'Old failure rolled back the newer drag');
      await pending[1].fulfill({ status: 503, contentType: 'application/json', body: '{"error":"第二次位置保存失败"}' });
      await rendered();
      assert.equal(await transform(), original, 'Failed saves left an unsaved position on screen');
      await emit(); await rendered();
      assert.equal(await transform(), original, 'A later snapshot resurrected the failed position');
    } finally { for (const route of pending) await route.abort().catch(() => {}); }
  });
  await check('筛选期间新消息改变排序，恢复筛选仍保持原卡片布局', async ({ page, fixture, ready, emit, rendered }) => {
    await ready();
    const id = fixture.ids[0];
    const node = () => page.locator(`.react-flow__node[data-id="${id}"]`);
    const original = await node().evaluate(element => element.style.transform);
    await page.getByTestId('branch-filter').selectOption('feature/robot');
    await expect(page.getByTestId('thread-list').locator('button')).toHaveCount(1);
    fixture.db.prepare('UPDATE threads SET updated_at_ms=? WHERE id=?').run(Date.now() + 10000, fixture.ids[1]);
    await emit(); await rendered();
    await page.getByTestId('branch-filter').selectOption('');
    await expect(page.getByTestId('thread-list').locator('button')).toHaveCount(3);
    await rendered();
    assert.equal(await node().evaluate(element => element.style.transform), original);
  }, { positioned: false });
  await check('创建响应丢失后重试复用请求标识，只创建一个新会话', async ({ page, base, fixture, ready, calls }) => {
    await ready();
    let loseFirst = true;
    const bodies = [];
    await page.route(`${base}/api/threads`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      bodies.push(route.request().postDataJSON());
      if (loseFirst) { loseFirst = false; await route.fetch(); await route.abort('failed'); return; }
      return route.continue();
    });
    await page.getByTestId('new-thread').click();
    await page.getByTestId('modal-title').fill('只创建一次的隔离会话');
    await page.getByTestId('modal-cwd').fill(fixture.cwd);
    await page.getByTestId('modal-submit').click();
    await expect(page.getByTestId('modal-error')).toBeVisible();
    await page.getByTestId('modal-submit').click();
    await expect(page.getByTestId('thread-modal')).toHaveCount(0);
    assert.equal(calls.filter(call => call.method === 'thread/start').length, 1);
    assert.ok(bodies[0].requestId, 'Creation needs a stable request ID');
    assert.equal(bodies[1].requestId, bodies[0].requestId);
    await expect(page.getByTestId('thread-list').locator('button')).toHaveCount(4);
  });
  assert.deepEqual(errors, []);
} finally {
  writeFileSync('artifacts/ui-resilience-results.json', JSON.stringify({ results, errors }, null, 2));
  await browser.close();
}
