import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import { createServer } from '../server/index.mjs';
import { makeFixture } from './fixture.mjs';

const fixture = makeFixture();
let enabled = false, tests = 0, lastError = null;
const desktopNotifications = {
  status: () => ({ enabled, available: true, lastError }),
  setEnabled(value) { enabled = value; },
  observe() {},
  async test() { tests++; if (lastError) throw new Error(lastError); },
  close() {},
};
const server = createServer({ ...fixture, desktopNotifications, pollIntervalMs: 100 });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_BUNDLED ? {} : { channel: 'chrome' }), headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const toggle = page.getByTestId('desktop-notifications-toggle');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('desktop-notifications-status')).toContainText('关闭看板仍会提醒');
  await page.reload(); await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  console.log('PASS 桌面通知设置由服务端保存，刷新后保留');
  await page.getByTestId('activity-notifications-toggle').click();
  await expect(page.getByTestId('activity-notifications-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('desktop-notifications-test').click();
  await expect(page.locator('[role="status"]').filter({ hasText: '已发送系统测试通知' })).toBeVisible();
  assert.equal(tests, 1);
  console.log('PASS 页内提示与桌面通知独立，测试通知返回发送结果');
  lastError = '无法连接系统通知服务';
  await page.getByTestId('desktop-notifications-test').click();
  await expect(page.getByTestId('desktop-notifications-status')).toContainText(lastError);
  await expect(page.locator('.toast')).toContainText(lastError);
  console.log('PASS 系统通知失败显示原因，不误报发送成功');
  await toggle.click(); await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await page.setViewportSize({ width: 760, height: 800 });
  await expect(toggle).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  mkdirSync('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/ui-desktop-notifications.png', fullPage: true });
  console.log('PASS 窄屏通知控制可用，无横向溢出或浏览器错误');
} finally {
  await browser.close(); server.board.closeStreams();
  const done = once(server, 'close'); server.close(); server.closeAllConnections(); await done; fixture.cleanup();
}
