import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import { createServer } from '../server/index.mjs';
import { makeFixture } from './fixture.mjs';

const fixture = makeFixture();
const opened = [];
const appServer = { async request(method, params) {
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
  windows: () => [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: 'robot-project', folders: [fixture.cwd], openThreads: [] }],
  async open(id, windowId) { opened.push({ id, windowId }); return { opened: true, editorOpened: true, verified: true, reused: false }; },
  close() {},
};
const server = createServer({ ...fixture, appServer, bridge, pollIntervalMs: 150 });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_BUNDLED ? {} : { channel: 'chrome' }), headless: true });
const context = await browser.newContext({ viewport: { width: 1512, height: 982 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const results = [];
async function check(name, operation) {
  const start = performance.now();
  await operation();
  const result = { name, result: 'PASS', durationMs: Math.round(performance.now() - start) };
  results.push(result); console.log(`PASS ${name} (${result.durationMs}ms)`);
}
async function closeDetail() {
  const button = page.getByRole('button', { name: '关闭详情', exact: true });
  if (await button.isVisible()) await button.click();
}
mkdirSync('artifacts', { recursive: true });
try {
  await page.goto(base);
  await check('真实浏览器加载、项目分组、Fork 来源显示', async () => {
    await expect(page.getByTestId('thread-list').locator('button')).toHaveCount(3);
    await expect(page.getByTestId('sync-status')).toContainText('已连接');
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
    await expect(page.getByTestId(`session-node-${fixture.ids[2]}`)).toContainText('Fork');
  });
  await page.screenshot({ path: 'artifacts/ui-fixture.png', fullPage: true });
  await check('分支筛选与完整 ID 搜索', async () => {
    await page.getByTestId('branch-filter').selectOption('feature/robot');
    await expect(page.getByTestId('thread-list').locator('button')).toHaveCount(1);
    await page.getByTestId('branch-filter').selectOption('');
    await page.getByTestId('thread-search').fill(fixture.ids[0]);
    await expect(page.getByTestId('thread-list').locator('button')).toHaveCount(1);
    await expect(page.getByTestId('thread-list')).toContainText(fixture.names[0]);
    await page.getByTestId('thread-search').fill('');
    await expect(page.getByTestId('thread-list').locator('button')).toHaveCount(3);
  });
  await check('复制子对话 ID 写入真实系统剪贴板', async () => {
    await page.getByTestId(`copy-${fixture.ids[2]}`).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), fixture.ids[2]);
  });
  await check('拖动卡片后刷新位置不丢失', async () => {
    const heading = page.getByTestId(`session-node-${fixture.ids[0]}`).locator('.card-heading');
    const box = await heading.boundingBox();
    await page.mouse.move(box.x + 80, box.y + 12);
    await page.mouse.down();
    await page.mouse.move(box.x + 145, box.y + 100, { steps: 15 });
    await page.mouse.up();
    await expect.poll(() => server.board.store.graph().positions[fixture.ids[0]]).toBeTruthy();
    const position = structuredClone(server.board.store.graph().positions[fixture.ids[0]]);
    await page.reload();
    await expect(page.getByTestId(`session-node-${fixture.ids[0]}`)).toBeVisible();
    assert.deepEqual(server.board.store.graph().positions[fixture.ids[0]], position);
    const style = await page.locator(`.react-flow__node[data-id="${fixture.ids[0]}"]`).getAttribute('style');
    assert.ok(style.includes(`${position.x}px`) && style.includes(`${position.y}px`), style);
  });
  await check('鼠标拖拽连线、修改关系、刷新持久化、删除连线', async () => {
    await closeDetail();
    await page.getByTestId('relation-type').selectOption('parallel');
    await page.waitForTimeout(300);
    const source = await page.getByTestId(`session-source-${fixture.ids[0]}`).boundingBox();
    const target = await page.getByTestId(`session-target-${fixture.ids[1]}`).boundingBox();
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 25 });
    await page.mouse.up();
    await expect(page.getByTestId('edge-type')).toBeVisible();
    await expect.poll(() => server.board.store.graph().edges.length).toBe(1);
    assert.equal(server.board.store.graph().edges[0].type, 'parallel');
    await page.getByTestId('edge-type').selectOption('serial');
    await expect.poll(() => server.board.store.graph().edges[0]?.type).toBe('serial');
    const edgeId = server.board.store.graph().edges[0].id;
    await page.reload();
    const edge = page.locator(`.react-flow__edge[data-id="${edgeId}"]`);
    await expect(edge).toBeVisible();
    // Click the visible relation label. A routed SVG line's bounding-box
    // center can be empty canvas; normal clicks also wait for layout stability.
    await edge.locator('.react-flow__edge-textwrapper').click();
    await expect(page.getByTestId('edge-type')).toHaveValue('serial');
    await page.getByTestId('delete-edge').click();
    await expect.poll(() => server.board.store.graph().edges.length).toBe(0);
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  });
  await check('外部对话变化实时进入 UI', async () => {
    fixture.update(fixture.ids[0], '外部实时消息已到达');
    await expect(page.getByTestId(`session-node-${fixture.ids[0]}`)).toContainText('外部实时消息已到达', { timeout: 4000 });
  });
  await check('点击 VS Code 按钮发送对应子对话 ID', async () => {
    await page.getByTestId(`open-${fixture.ids[2]}`).click();
    await expect.poll(() => opened.length).toBe(1);
    assert.equal(opened[0].id, fixture.ids[2]);
    await expect(page.getByTestId('toast')).toContainText('已打开');
  });
  await check('新建与 Fork 表单、父子关系、独立 ID', async () => {
    await page.getByTestId('new-thread').click();
    await page.getByTestId('modal-title').fill('浏览器新建验收');
    await page.getByTestId('modal-cwd').fill(fixture.cwd);
    await page.getByTestId('modal-submit').click();
    await expect(page.getByTestId('thread-modal')).toHaveCount(0);
    await expect(page.getByTestId('thread-detail')).toContainText('浏览器新建验收');
    const createdId = await page.getByTestId('detail-thread-id').textContent();
    await page.getByTestId('detail-fork').click();
    await page.getByTestId('modal-title').fill('浏览器 Fork 验收');
    await page.getByTestId('modal-submit').click();
    await expect(page.getByTestId('thread-modal')).toHaveCount(0);
    await expect(page.getByTestId('thread-detail')).toContainText('浏览器 Fork 验收');
    const forkedId = await page.getByTestId('detail-thread-id').textContent();
    assert.notEqual(forkedId, createdId);
    assert.equal(server.board.snapshot().threads.find(x => x.id === forkedId).forkedFromId, createdId);
    await expect(page.getByTestId('thread-detail')).toContainText(createdId);
  });
  await check('创建失败保留输入并明确显示错误', async () => {
    await page.getByTestId('new-thread').click();
    await page.getByTestId('modal-title').fill('应保留的标题');
    await page.getByTestId('modal-cwd').fill('/invalid-path-does-not-exist');
    await page.getByTestId('modal-submit').click();
    await expect(page.getByTestId('modal-error')).toContainText('文件夹不存在');
    await expect(page.getByTestId('modal-title')).toHaveValue('应保留的标题');
    await page.getByTestId('modal-cancel').click();
  });
  await check('窄屏布局可操作且没有 JavaScript 错误', async () => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(page.getByTestId('new-thread')).toBeVisible();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    assert.deepEqual(errors, []);
  });
  writeFileSync('artifacts/ui-results.json', JSON.stringify({ environment: 'Chrome; isolated fixture data and injected Codex metadata client', results, errors }, null, 2));
} catch (error) {
  await page.screenshot({ path: 'artifacts/ui-failure.png', fullPage: true });
  console.error(error);
  console.error('Browser errors:', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.board.closeStreams();
  const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed;
  fixture.cleanup();
}
