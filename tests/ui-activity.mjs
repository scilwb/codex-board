import assert from 'node:assert/strict';
import { once } from 'node:events';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import { createServer } from '../server/index.mjs';
import { makeFixture } from './fixture.mjs';

const fixture = makeFixture();
const server = createServer({ ...fixture, appServer: { async request() { return {}; } }, pollIntervalMs: 100 });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_BUNDLED ? {} : { channel: 'chrome' }), headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
const results = [];
let replyRequests = 0;
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => { if (request.url().endsWith('/replies')) replyRequests++; });
function append(id, type, payload) {
  const file = fixture.db.prepare('SELECT rollout_path FROM threads WHERE id=?').get(id).rollout_path;
  appendFileSync(file, `${JSON.stringify({ timestamp: new Date().toISOString(), type, payload })}\n`);
}
async function check(name, operation) {
  const start = performance.now();
  await operation();
  results.push({ name, result: 'PASS', durationMs: Math.round(performance.now() - start) });
  console.log(`PASS ${name}`);
}
const [first, second] = fixture.ids;
const firstNode = () => page.getByTestId(`session-node-${first}`);
const closeDetail = async () => {
  const close = page.getByRole('button', { name: '关闭详情', exact: true });
  if (await close.isVisible()) await close.click();
};
mkdirSync('artifacts', { recursive: true });
try {
  await page.goto(base);
  await check('首次历史状态静默，回复只在点击后读取', async () => {
    await expect(page.getByTestId('thread-list').locator('button')).toHaveCount(3);
    await expect(firstNode()).toContainText('本轮结束');
    await expect(page.getByTestId('activity-notices')).toHaveCount(0);
    assert.equal(replyRequests, 0);
    await page.getByTestId(`thread-list-${first}`).click();
    await expect(page.getByTestId('show-replies')).toBeVisible();
    assert.equal(replyRequests, 0);
    await page.getByTestId('show-replies').click();
    await expect(page.getByTestId('reply-list')).toContainText(`${fixture.names[0]}已有进展`);
    assert.equal(replyRequests, 1);
  });
  await check('新活动不自动读取全文，手动刷新只展示公开回复', async () => {
    append(first, 'event_msg', { type: 'task_started', turn_id: 'activity-turn' });
    append(first, 'response_item', { type: 'message', role: 'assistant', phase: 'analysis', content: [{ type: 'output_text', text: '不应显示的内部内容' }] });
    append(first, 'response_item', { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: '已经检查相机连接，正在验证。' }] });
    await expect(page.getByTestId('thread-detail')).toContainText('运行中（推测）');
    await expect(page.getByTestId('recent-replies')).toContainText('有新活动');
    assert.equal(replyRequests, 1);
    await page.getByTestId('refresh-replies').click();
    await expect(page.getByTestId('reply-list')).toContainText('已经检查相机连接');
    await expect(page.getByTestId('reply-list')).not.toContainText('不应显示的内部内容');
    assert.equal(replyRequests, 2);
    await page.getByTestId('collapse-replies').click();
    await expect(page.getByTestId('reply-list')).toHaveCount(0);
  });
  await check('切换对话时延迟返回的旧请求不会混入新回复', async () => {
    let release;
    let intercepted = false;
    const gate = new Promise(resolve => { release = resolve; });
    const url = `${base}/api/threads/${first}/replies`;
    await page.route(url, async route => {
      const response = await route.fetch();
      intercepted = true;
      await gate;
      await route.fulfill({ response }).catch(() => {});
    });
    await page.getByTestId('show-replies').click();
    await expect.poll(() => intercepted).toBe(true);
    await page.getByTestId(`thread-list-${second}`).click();
    await expect(page.getByTestId('show-replies')).toBeVisible();
    await page.getByTestId('show-replies').click();
    await expect(page.getByTestId('reply-list')).toContainText(`${fixture.names[1]}已有进展`);
    release();
    await page.unroute(url);
    await expect(page.getByTestId('reply-list')).not.toContainText('已经检查相机连接');
    await closeDetail();
  });
  await check('运行中与需处理状态实时更新，拖动中的位置保持', async () => {
    const heading = firstNode().locator('.card-heading');
    const box = await heading.boundingBox();
    await page.mouse.move(box.x + 50, box.y + 8);
    await page.mouse.down();
    await page.mouse.move(box.x + 105, box.y + 55, { steps: 10 });
    const node = page.locator(`.react-flow__node[data-id="${first}"]`);
    const before = await node.evaluate(element => element.style.transform);
    append(first, 'response_item', { type: 'function_call', name: 'functions.request_user_input_async', call_id: 'question-a', arguments: '{"question":"继续吗？"}' });
    await expect(firstNode()).toContainText('需你处理（推测）');
    assert.equal(await node.evaluate(element => element.style.transform), before);
    await page.mouse.up();
    await closeDetail();
    await expect(page.locator('.activity-notice.waiting')).toHaveCount(1);
    append(first, 'response_item', { type: 'function_call_output', call_id: 'question-a', output: '{"accepted":true}' });
    append(first, 'event_msg', { type: 'task_complete', turn_id: 'activity-turn', last_agent_message: '已提出问题，等待确认。' });
    await expect.poll(() => server.board.snapshot().threads.find(thread => thread.id === first)?.activity.reason).toContain('提问尚未确认');
    await expect(page.locator('.activity-notice.waiting')).toHaveCount(1);
  });
  await check('断线重连不重复旧提示，新一轮结束单独提示', async () => {
    await page.locator('.activity-notice.waiting').getByRole('button', { name: '关闭状态提示' }).click();
    server.board.closeStreams();
    await expect(page.getByTestId('sync-status')).toContainText('已断开');
    await expect(page.getByTestId('sync-status')).toContainText('已连接', { timeout: 10000 });
    await expect(page.getByTestId('activity-notices')).toHaveCount(0);
    append(first, 'response_item', { type: 'function_call_output', call_id: 'question-a', output: '{"answers":{"confirm":{"answers":["继续"]}}}' });
    await expect(firstNode()).toContainText('本轮结束');
    await expect(page.locator('.activity-notice.completed')).toHaveCount(1);
    await page.screenshot({ path: 'artifacts/ui-activity.png', fullPage: true });
  });
  await check('提示关闭后保持静音，重新开启和刷新不复读历史', async () => {
    await page.getByTestId('activity-notifications-toggle').click();
    await expect(page.getByTestId('activity-notifications-toggle')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('activity-notices')).toHaveCount(0);
    append(second, 'event_msg', { type: 'task_started', turn_id: 'second-turn' });
    append(second, 'response_item', { type: 'function_call', name: 'functions.request_user_input', call_id: 'question-b', arguments: '{}' });
    await expect(page.getByTestId(`thread-list-${second}`)).toContainText('需你处理（推测）');
    await expect(page.getByTestId('activity-notices')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('activity-notifications-toggle')).toHaveAttribute('aria-pressed', 'false');
    await page.getByTestId('activity-notifications-toggle').click();
    await expect(page.getByTestId('activity-notices')).toHaveCount(0);
    assert.equal(await page.evaluate(() => localStorage.getItem('codex-board.activity-notifications')), 'on');
  });
  await check('窄屏没有横向溢出或浏览器错误', async () => {
    await page.setViewportSize({ width: 760, height: 800 });
    await expect(page.getByTestId('activity-notifications-toggle')).toBeVisible();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    assert.deepEqual(errors, []);
  });
  writeFileSync('artifacts/ui-activity-results.json', JSON.stringify({ results, errors }, null, 2));
} catch (error) {
  await page.screenshot({ path: 'artifacts/ui-activity-failure.png', fullPage: true });
  console.error(error);
  console.error('Browser errors:', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.board.closeStreams();
  const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed;
  fixture.cleanup();
}
