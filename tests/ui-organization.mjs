import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import { createServer } from '../server/index.mjs';
import { makeFixture } from './fixture.mjs';

const fixture = makeFixture();
const otherFolder = join(fixture.root, 'another-worktree');
mkdirSync(otherFolder);
fixture.db.prepare('UPDATE threads SET cwd=? WHERE id=?').run(otherFolder, fixture.ids[2]);
const windowId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const opened = [];
let bridgeConnected = true;
let finishOpen;
const bridge = {
  windows: () => bridgeConnected ? [{ id: windowId, title: 'YAM workspace', folders: [fixture.cwd], openThreads: [] }] : [],
  async open(id, destination) {
    opened.push({ id, destination });
    await new Promise((resolve) => { finishOpen = resolve; });
    return { opened: true, editorOpened: true, verified: true, reused: true };
  },
  close() {},
};
const server = createServer({ ...fixture, appServer: { request: async () => ({}) }, bridge, pollIntervalMs: 100 });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_BUNDLED ? {} : { channel: 'chrome' }), headless: true });
const page = await browser.newPage({ viewport: { width: 1512, height: 982 } });
const errors = [];
const results = [];
page.on('pageerror', (error) => errors.push(error.message));
async function check(name, operation) {
  const started = performance.now();
  await operation();
  const result = { name, result: 'PASS', durationMs: Math.round(performance.now() - started) };
  results.push(result); console.log(`PASS ${name} (${result.durationMs}ms)`);
}
async function saveName(name) {
  await page.getByTestId('organization-name').fill(name);
  await page.getByTestId('organization-submit').click();
  await expect(page.getByTestId('organization-name')).toHaveCount(0);
}
async function selectThread(id) {
  await page.getByTestId('project-all').click();
  await page.getByTestId(`thread-list-${id}`).click();
  await expect(page.getByTestId('detail-thread-id')).toHaveText(id);
}
let yam, behavior, camera;
mkdirSync('artifacts', { recursive: true });
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await check('旧会话默认全部显示，文件夹与研究项目分开', async () => {
    await expect(page.getByTestId('thread-list').locator('button')).toHaveCount(3);
    await expect(page.getByTestId('project-item')).toHaveCount(0);
    await expect(page.getByTestId('folder-filter').locator('option')).toHaveCount(3);
    await expect(page.getByTestId('project-unassigned')).toContainText('3');
  });
  await check('手动新建 YAM 和 BEHAVIOR，创建并改名任务及项目', async () => {
    await page.getByTestId('add-project').click(); await saveName('YAM');
    yam = server.board.store.organization().projects.find((project) => project.name === 'YAM');
    await page.getByTestId('organization-add-task').click(); await saveName('Camera');
    camera = server.board.store.organization().tasks[0];
    await page.getByTestId(`rename-task-${camera.id}`).click(); await saveName('相机模块');
    await expect(page.getByTestId(`organization-task-${camera.id}`)).toHaveText('相机模块');
    await page.getByTestId(`rename-project-${yam.id}`).click(); await saveName('YAM 研究');
    await expect(page.getByTestId(`organization-project-${yam.id}`)).toHaveText('YAM 研究');
    await page.getByTestId('organization-add-project').click(); await saveName('BEHAVIOR');
    behavior = server.board.store.organization().projects.find((project) => project.name === 'BEHAVIOR');
    await page.getByTestId('organization-close').click();
    await expect(page.getByTestId('project-item')).toHaveCount(2);
    await expect(page.getByTestId('thread-list').locator('button')).toHaveCount(3);
  });
  await check('单个对话手动归类到项目和任务，即时保存', async () => {
    await selectThread(fixture.ids[0]);
    await page.getByTestId('assign-project').selectOption(yam.id);
    await expect(page.getByTestId('assign-task')).toBeEnabled();
    await page.getByTestId('assign-task').selectOption(camera.id);
    await expect.poll(() => server.board.store.organization().assignments[fixture.ids[0]]?.taskId).toBe(camera.id);
    await selectThread(fixture.ids[1]); await page.getByTestId('assign-project').selectOption(behavior.id);
    await expect.poll(() => server.board.store.organization().assignments[fixture.ids[1]]?.projectId).toBe(behavior.id);
    await selectThread(fixture.ids[2]); await page.getByTestId('assign-project').selectOption(yam.id);
    await expect.poll(() => server.board.store.organization().assignments[fixture.ids[2]]?.projectId).toBe(yam.id);
  });
  await check('重复分类名称显示错误并允许恢复，不产生重复记录', async () => {
    await page.getByTestId('manage-organization').click();
    await page.getByTestId('organization-add-project').click();
    await page.getByTestId('organization-name').fill('yam 研究');
    await page.getByTestId('organization-submit').click();
    await expect(page.getByTestId('organization-error')).toContainText('名称已存在');
    await expect(page.getByTestId('organization-submit')).toBeEnabled();
    assert.equal(server.board.store.organization().projects.length, 2);
    await page.getByTestId(`organization-project-${yam.id}`).click();
    await expect(page.getByTestId('organization-error')).toHaveCount(0);
    await page.getByTestId('organization-add-task').click();
    await page.getByTestId('organization-name').fill('相机模块');
    await page.getByTestId('organization-submit').click();
    await expect(page.getByTestId('organization-error')).toContainText('名称已存在');
    assert.equal(server.board.store.organization().tasks.length, 1);
    await page.getByTestId('organization-close').click();
  });
  await check('新建继承当前筛选，Fork 继承原归类，改项目清空原任务', async () => {
    await page.locator(`[data-testid="project-item"][data-project-id="${yam.id}"]`).click();
    await page.getByTestId('task-filter').selectOption(camera.id);
    await page.getByTestId('new-thread').click();
    await expect(page.getByTestId('modal-project')).toHaveValue(yam.id);
    await expect(page.getByTestId('modal-task')).toHaveValue(camera.id);
    await expect(page.getByTestId('modal-cwd')).toHaveValue(fixture.cwd);
    await page.getByTestId('modal-cancel').click();
    await selectThread(fixture.ids[0]);
    await page.getByTestId('detail-fork').click();
    await expect(page.getByTestId('modal-project')).toHaveValue(yam.id);
    await expect(page.getByTestId('modal-task')).toHaveValue(camera.id);
    await page.getByTestId('modal-project').selectOption(behavior.id);
    await expect(page.getByTestId('modal-task')).toHaveValue('');
    await expect(page.getByTestId('modal-task').locator('option')).toHaveCount(1);
    await page.getByTestId('modal-project').selectOption('');
    await expect(page.getByTestId('modal-task')).toBeDisabled();
    await page.getByTestId('modal-cancel').click();
  });
  await check('研究项目跨文件夹分组，任务和文件夹独立筛选', async () => {
    await page.locator(`[data-testid="project-item"][data-project-id="${yam.id}"]`).click();
    await expect(page.getByTestId('thread-list').locator('button')).toHaveCount(2);
    await page.getByTestId('folder-filter').selectOption(fixture.cwd);
    await expect(page.getByTestId('thread-list').locator('button')).toHaveCount(1);
    await expect(page.getByTestId('thread-list')).toContainText(fixture.names[0]);
    await page.getByTestId('folder-filter').selectOption(otherFolder);
    await expect(page.getByTestId('thread-list')).toContainText(fixture.names[2]);
    await page.getByTestId('folder-filter').selectOption('');
    await page.getByTestId('task-filter').selectOption(camera.id);
    await expect(page.getByTestId('thread-list').locator('button')).toHaveCount(1);
    await expect(page.getByTestId(`session-node-${fixture.ids[0]}`)).toContainText('相机模块');
    await page.getByTestId('task-filter').selectOption('unassigned');
    await expect(page.getByTestId('thread-list')).toContainText(fixture.names[2]);
    await page.getByTestId('project-all').click();
    await page.getByTestId('folder-filter').selectOption(fixture.cwd);
    await expect(page.getByTestId('thread-list').locator('button')).toHaveCount(2);
  });
  await check('刷新后项目、任务和对话归类保留', async () => {
    await page.reload();
    await selectThread(fixture.ids[0]);
    await expect(page.getByTestId('assign-project')).toHaveValue(yam.id);
    await expect(page.getByTestId('assign-task')).toHaveValue(camera.id);
    await expect(page.getByTestId(`session-node-${fixture.ids[0]}`)).toContainText('YAM 研究');
    await page.screenshot({ path: 'artifacts/ui-organization.png', fullPage: true });
  });
  await check('定位期间显示反馈并阻止重复点击，仅确认后显示成功', async () => {
    const button = page.getByTestId('detail-open');
    await button.click({ clickCount: 2 });
    await expect(button).toBeDisabled();
    await expect(button).toContainText('正在定位');
    await button.evaluate((node) => { node.click(); node.click(); });
    await expect.poll(() => opened.length).toBe(1);
    assert.deepEqual(opened[0], { id: fixture.ids[0], destination: windowId });
    assert.equal(await page.getByTestId('toast').count(), 0);
    finishOpen();
    await expect(page.getByTestId('toast')).toContainText('已定位到已打开的对话');
    await expect(button).toBeEnabled();
  });
  await check('未连接 VS Code 时明确报错且不启动编辑器', async () => {
    bridgeConnected = false;
    await page.getByTestId('detail-open').click();
    await expect(page.getByTestId('toast')).toContainText('Codex Board: Connect');
    assert.equal(opened.length, 1);
    await expect(page.getByTestId('detail-open')).toBeEnabled();
  });
  await check('删除任务及项目仅清除归类，全部对话和连线保留', async () => {
    const before = server.board.snapshot().threads.map((thread) => thread.id).sort();
    const graphBefore = server.board.store.graph();
    await page.getByTestId('manage-organization').click();
    await page.getByTestId(`organization-project-${yam.id}`).click();
    await page.getByTestId(`delete-task-${camera.id}`).click();
    await page.getByTestId('organization-confirm-delete').click();
    await expect(page.getByTestId(`organization-task-${camera.id}`)).toHaveCount(0);
    assert.deepEqual(server.board.store.organization().assignments[fixture.ids[0]], { projectId: yam.id, taskId: null });
    await page.getByTestId(`delete-project-${yam.id}`).click();
    await page.getByTestId('organization-confirm-delete').click();
    await expect(page.getByTestId(`organization-project-${yam.id}`)).toHaveCount(0);
    await page.getByTestId('organization-close').click();
    await expect(page.getByTestId('thread-list').locator('button')).toHaveCount(3);
    assert.deepEqual(server.board.snapshot().threads.map((thread) => thread.id).sort(), before);
    assert.deepEqual(server.board.store.graph(), graphBefore);
    await expect(page.getByTestId('project-unassigned')).toContainText('2');
    assert.deepEqual(errors, []);
  });
  writeFileSync('artifacts/ui-organization-results.json', JSON.stringify({ environment: 'Chrome; isolated fixture and injected editor bridge; no live editor modified', results, errors }, null, 2));
} catch (error) {
  await page.screenshot({ path: 'artifacts/ui-organization-failure.png', fullPage: true });
  console.error(error); console.error('Browser errors:', errors); process.exitCode = 1;
} finally {
  finishOpen?.();
  await browser.close();
  server.board.closeStreams();
  const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed;
  fixture.cleanup();
}
