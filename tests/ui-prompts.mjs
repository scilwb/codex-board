import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import { createServer } from '../server/index.mjs';
import { makeFixture } from './fixture.mjs';

const fixture = makeFixture();
let modelCalls = 0;
const appServer = { request() { modelCalls++; throw new Error('提示词库不应调用模型'); }, stop() {} };
const desktopNotifications = { status: () => ({ enabled: false, available: false }), observe() {}, close() {} };
const server = createServer({ ...fixture, appServer, desktopNotifications, pollIntervalMs: 100 });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_BUNDLED ? {} : { channel: 'chrome' }), headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'], acceptDownloads: true });
const page = await context.newPage();
const errors = []; page.on('pageerror', error => errors.push(error.message));
let requests = 0; page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/prompts')) requests++; });
const control = (name) => page.getByTestId(`prompts-${name}`);
const saved = async () => (await (await fetch(`${origin}/api/prompts`)).json()).prompts;
const fillNew = async (title, content, tags = '') => {
  await control('new').click(); await control('title').fill(title); await control('content').fill(content); await control('tags').fill(tags);
};
const saveDraft = async () => { await control('save').click(); await expect(control('content')).not.toBeVisible(); };
const importFile = async (path) => {
  await control('backup-menu').click();
  const chooser = page.waitForEvent('filechooser'); await control('import').click(); await (await chooser).setFiles(path);
};
try {
  await page.goto(origin); await expect(control('open')).toBeVisible();
  assert.equal(requests, 0, '不开提示词库时不请求提示词数据');
  let failFirstRead = true;
  const firstRead = async route => {
    if (route.request().method() === 'GET' && failFirstRead) { failFirstRead = false; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '临时无法读取提示词库' }) }); }
    else await route.continue();
  };
  await page.route('**/api/prompts', firstRead);
  await control('open').click(); await expect(control('dialog')).toBeVisible();
  await expect(control('error')).toContainText('临时无法读取'); await control('retry').click(); await expect(control('error')).not.toBeVisible();
  await expect(control('empty')).toContainText('好用的提示词'); await expect(control('search')).toBeFocused();
  await page.unroute('**/api/prompts', firstRead);
  console.log('PASS 提示词库按需加载，首次读取失败可重试，空库可直接新建');

  const exact = '\n  请审查这段代码 🔎\n\t先读 /home/项目/关键文件.py  \n\n保留缩进与空行。\n';
  await fillNew('代码审查', exact, '开发，检查'); await control('pin-editor').check();
  await control('content').press('Control+Enter'); await expect(control('content')).not.toBeVisible();
  const first = (await saved())[0]; assert.equal(first.content, exact); assert.deepEqual(first.tags, ['开发', '检查']); assert.equal(first.pinned, true);
  await expect(control('preview')).toHaveText(exact, { useInnerText: false });
  await control('copy-selected').click(); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), exact);
  await expect(control('copy-selected')).toContainText('已复制');
  console.log('PASS Ctrl Enter 保存，中文、emoji、换行和缩进复制到真实剪贴板且完整保留');

  await fillNew('任务交接', '请先阅读关键路径，然后继续当前任务。', '开发、交接'); await saveDraft();
  let records = await saved(); const second = records.find(prompt => prompt.title === '任务交接');
  await expect(control('list').locator('[data-testid^="prompts-select-"]').first()).toHaveAttribute('data-testid', `prompts-select-${first.id}`);
  await control('search').fill('/home/项目/关键文件.py'); await expect(control('list').locator('[data-testid^="prompts-select-"]')).toHaveCount(1);
  await control('search').fill('不存在的内容'); await expect(control('clear-filters')).toBeVisible(); await control('clear-filters').click();
  await control('tag-检查').click(); await expect(control(`select-${first.id}`)).toBeVisible(); await expect(control(`select-${second.id}`)).not.toBeVisible();
  await control('tag-检查').click(); await control('pinned-filter').click(); await expect(control('list').locator('[data-testid^="prompts-select-"]')).toHaveCount(1); await control('pinned-filter').click();
  await control(`select-${second.id}`).click(); await control('pin').click(); await expect(control('pin')).toHaveAttribute('aria-pressed', 'true');
  await expect(control('list').locator('[data-testid^="prompts-select-"]').first()).toHaveAttribute('data-testid', `prompts-select-${second.id}`);
  await control('pin').click(); await expect(control('pin')).toHaveAttribute('aria-pressed', 'false');
  await control(`copy-${first.id}`).click(); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), exact);
  console.log('PASS 搜索标题和正文、标签筛选、置顶排序与列表一键复制可用');

  await control(`select-${first.id}`).click(); await control('edit').click(); const dirtyText = exact + '尚未保存的补充'; await control('content').fill(dirtyText);
  await control(`select-${second.id}`).click(); await expect(control('unsaved')).toBeVisible(); await control('continue').click(); await expect(control('content')).toHaveValue(dirtyText);
  await control('close').click(); await expect(control('unsaved')).toBeVisible(); await page.keyboard.press('Escape'); await expect(control('unsaved')).not.toBeVisible(); await expect(control('content')).toHaveValue(dirtyText);
  await control('new').click(); await expect(control('unsaved')).toBeVisible();
  await page.keyboard.press('Control+Enter'); assert.equal((await saved()).length, 2); await expect(control('content')).toHaveValue(dirtyText);
  await control('discard').click(); await expect(control('title')).toHaveValue(''); await control('cancel-edit').click();
  console.log('PASS 切换、新建、关闭保护未保存草稿，Escape 取消确认，确认期间快捷键不误保存');

  let lostCreate = true;
  const loseAcknowledgement = async route => {
    if (route.request().method() === 'POST' && lostCreate) { lostCreate = false; await route.fetch(); await route.abort(); }
    else await route.continue();
  };
  await page.route('**/api/prompts', loseAcknowledgement);
  await fillNew('网络重试', '首次提交已保存，响应丢失。'); await control('save').click(); await expect(control('error')).toBeVisible();
  const uncertain = (await saved()).find(prompt => prompt.title === '网络重试'); assert.ok(uncertain);
  await control('content').fill('修改后的重试内容\n  缩进保持'); await control('save').click();
  await expect(control('conflict')).toBeVisible(); await expect(control('content')).toHaveValue('修改后的重试内容\n  缩进保持');
  await control('overwrite').click(); await expect(control('content')).not.toBeVisible();
  const recovered = (await saved()).find(prompt => prompt.id === uncertain.id); assert.equal(recovered.content, '修改后的重试内容\n  缩进保持'); assert.equal((await saved()).length, 3);
  await page.unroute('**/api/prompts', loseAcknowledgement);
  console.log('PASS 创建响应丢失后保留草稿和同一 ID，明确覆盖已提交版本，不重复创建');

  await control(`select-${first.id}`).click(); await control('edit').click(); await control('content').fill(dirtyText);
  const current = (await saved()).find(prompt => prompt.id === first.id);
  const update = await fetch(`${origin}/api/prompts/${first.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: current.revision, content: '另一个窗口保存的版本' }) }); assert.equal(update.status, 200);
  await control('save').click(); await expect(control('conflict')).toBeVisible(); await expect(control('content')).toHaveValue(dirtyText);
  await control('conflict').locator('summary').click(); await expect(control('conflict')).toContainText('另一个窗口保存的版本');
  await control('load-latest').click(); await expect(control('unsaved')).toBeVisible(); await control('discard').click(); await expect(control('content')).toHaveValue('另一个窗口保存的版本');
  await control('content').fill(exact); await saveDraft();
  console.log('PASS 版本冲突刷新保存版本且保留草稿，可比较和有确认地读取最新版本');

  let releaseSave; const saveGate = new Promise(resolve => { releaseSave = resolve; }); let submitted = 0;
  const delayCreate = async route => {
    if (route.request().method() === 'POST') { submitted++; await saveGate; }
    await route.continue();
  };
  await page.route('**/api/prompts', delayCreate);
  await fillNew('防重复保存', '保存请求处理中只发送一次。'); await control('save').click(); await expect(control('save')).toBeDisabled();
  await expect(control('content')).toBeDisabled(); await expect(control('close')).toBeDisabled(); await page.keyboard.press('Control+Enter');
  assert.equal(submitted, 1); releaseSave(); await expect(control('content')).not.toBeVisible(); assert.equal((await saved()).length, 4);
  await page.unroute('**/api/prompts', delayCreate);
  console.log('PASS 请求处理期间禁用编辑和重复保存，不丢失后续草稿');

  const beforeBackup = (await saved()).find(prompt => prompt.title === '防重复保存');
  const concurrentSave = await fetch(`${origin}/api/prompts/${beforeBackup.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: beforeBackup.revision, content: '另一窗口刚保存的内容也要备份' }) }); assert.equal(concurrentSave.status, 200);
  await control('backup-menu').click(); const downloadPromise = page.waitForEvent('download'); await control('export').click();
  const backupPath = join(fixture.root, 'prompts-backup.json'); await (await downloadPromise).saveAs(backupPath);
  const backup = JSON.parse(readFileSync(backupPath, 'utf8')); assert.equal(backup.version, 1); assert.equal(backup.prompts.length, 4); assert.equal(backup.prompts.find(prompt => prompt.id === first.id).content, exact);
  assert.equal(backup.prompts.find(prompt => prompt.id === beforeBackup.id).content, '另一窗口刚保存的内容也要备份');
  await importFile(backupPath); await expect(page.locator('.toast')).toContainText('跳过 4 条'); assert.equal((await saved()).length, 4);
  await control('delete').click(); await control('confirm-delete').click(); await expect(control('delete-confirm')).not.toBeVisible(); assert.equal((await saved()).length, 3);
  await importFile(backupPath); await expect(page.locator('.toast')).toContainText('已导入 1 条'); assert.equal((await saved()).length, 4);
  console.log('PASS JSON 备份保留原文，重复导入跳过，删除后可以用备份恢复');

  await control(`select-${first.id}`).click(); await control('edit').click(); await control('content').fill(dirtyText);
  await control('backup-menu').click(); await control('import').click(); await expect(control('unsaved')).toBeVisible(); await control('continue').click(); await expect(control('content')).toHaveValue(dirtyText);
  await control('cancel-edit').click(); await control('discard').click();
  await control('close').click(); await expect(control('dialog')).not.toBeVisible(); await expect(control('open')).toBeFocused();
  await page.keyboard.press('Control+k'); await expect(control('dialog')).toBeVisible(); await expect(control('search')).toBeFocused();
  await page.keyboard.press('ArrowDown'); const before = await control('list').locator('button[aria-pressed="true"]').getAttribute('data-testid'); await page.keyboard.press('ArrowDown');
  const after = await control('list').locator('button[aria-pressed="true"]').getAttribute('data-testid'); assert.notEqual(before, after);
  await page.keyboard.press('Control+k'); await expect(control('search')).toBeFocused();
  await control('copy-selected').focus(); await page.keyboard.press('Tab'); await expect(control('new')).toBeFocused(); await page.keyboard.press('Shift+Tab'); await expect(control('copy-selected')).toBeFocused();
  console.log('PASS 导入保护草稿，关闭恢复焦点，Ctrl K / 上下键和对话框焦点循环可用');

  await page.reload(); await control('open').click(); await control(`select-${first.id}`).click(); await expect(control('preview')).toHaveText(exact, { useInnerText: false }); assert.equal((await saved()).length, 4);
  await page.evaluate(() => { window.restoreClipboardWrite = navigator.clipboard.writeText; navigator.clipboard.writeText = async () => { throw new Error('blocked'); }; });
  await control('copy-selected').click(); await expect(control('error')).toContainText('无法访问剪贴板'); await expect(page.locator('.toast')).toContainText('复制失败');
  await page.evaluate(() => { navigator.clipboard.writeText = window.restoreClipboardWrite; delete window.restoreClipboardWrite; }); await control('copy-selected').click(); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), exact);
  console.log('PASS 刷新后提示词仍在，复制失败报告真实原因，恢复后再次复制成功');

  mkdirSync('artifacts', { recursive: true }); await page.screenshot({ path: 'artifacts/ui-prompts-desktop.png' });
  await page.setViewportSize({ width: 360, height: 740 }); await expect(control('preview')).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const dialogBox = await control('dialog').boundingBox(); await page.screenshot({ path: 'artifacts/ui-prompts-mobile.png' }); assert.ok(dialogBox.x >= 0 && dialogBox.x + dialogBox.width <= 360, JSON.stringify(dialogBox));
  await control('back').click(); await expect(control(`select-${first.id}`)).toBeVisible(); await control(`copy-${first.id}`).click(); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), exact);
  await control(`select-${first.id}`).click(); await control('edit').click(); await expect(control('content')).toBeVisible();
  await expect(control('save')).toBeInViewport(); await control('content').fill(exact + '手机编辑'); await control('cancel-edit').click(); await control('discard').click();
  await page.screenshot({ path: 'artifacts/ui-prompts-mobile.png' });
  assert.deepEqual(errors, []); assert.equal(modelCalls, 0);
  console.log('PASS 360px 小屏列表与详情切换、复制编辑无溢出，不触发模型或浏览器错误');
} finally {
  await browser.close(); server.board.closeStreams();
  const done = once(server, 'close'); server.close(); server.closeAllConnections(); await done; fixture.cleanup();
}
