// Public preview: isolated static app, invented data, no Codex files or services.
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'docs/assets');
const now = Date.parse('2026-09-28T12:00:00Z');
const id = (value) => `11111111-1111-4111-8111-${String(value).padStart(12, '0')}`;
const projects = [{ id: id(101), name: 'YAM' }, { id: id(102), name: 'BEHAVIOR' }];
const tasks = [
  { id: id(201), projectId: id(101), name: '方案设计' },
  { id: id(202), projectId: id(101), name: '相机模块' },
  { id: id(203), projectId: id(101), name: 'PR 审查' },
  { id: id(204), projectId: id(101), name: '集成验证' },
  { id: id(205), projectId: id(102), name: '环境评估' },
];
const examples = [
  ['双臂相机 · 方案设计', '梳理相机生命周期与采集接口，拆分实现、审查和验证任务。', 'main', '/workspace/yam', 201, 101],
  ['相机模块 · 生命周期修复', '在独立分支实现连接与释放，补齐断连后恢复流程。', 'fix/camera', '/workspace/yam-camera', 202, 101],
  ['PR #42 · 独立代码审查', '核对接口兼容性与变更范围，整理需要补充的测试项。', 'review/pr-42', '/workspace/yam-review', 203, 101],
  ['采集链路 · 集成验证', '汇总实现与审查结论，验证相机重连和采集退出流程。', 'test/integration', '/workspace/yam', 204, 101],
  ['环境评估 · 指标设计', '整理评估任务与成功判据。', 'eval/baseline', '/workspace/behavior', 205, 102],
  ['策略基线 · 结果检查', '对比演示样本与基线输出。', 'eval/policy', '/workspace/behavior', null, 102],
];
const threads = examples.map(([title, preview, branch, cwd], index) => ({
  id: id(index + 1), title, preview, branch, cwd, folder: cwd, project: cwd.split('/').at(-1),
  createdAt: now - 3600_000, updatedAt: now - (index + 2) * 60_000,
  archived: false, status: 'unknown', ...(index === 1 ? { forkedFromId: id(1) } : {}),
}));
const snapshot = {
  threads,
  capabilities: { create: true, fork: true, openVscode: true },
  organization: { projects, tasks, assignments: Object.fromEntries(examples.map((row, index) => [id(index + 1), { projectId: id(row[5]), taskId: row[4] ? id(row[4]) : null }])) },
  graph: {
    positions: {
      [id(1)]: { x: 30, y: 170 }, [id(2)]: { x: 410, y: 20 },
      [id(3)]: { x: 410, y: 330 }, [id(4)]: { x: 790, y: 170 },
      [id(5)]: { x: 30, y: 620 }, [id(6)]: { x: 410, y: 620 },
    },
    edges: [
      { id: id(301), source: id(2), target: id(4), type: 'serial' },
      { id: id(302), source: id(3), target: id(4), type: 'parallel' },
    ],
  },
};
const errors = [];
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const sockets = new Set();
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path === '/api/events') {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
    return;
  }
  if (path === '/api/snapshot' || path === '/api/projects') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(path === '/api/snapshot' ? snapshot : { projects: [...new Set(threads.map((thread) => thread.cwd))].map((cwd) => ({ cwd })) }));
    return;
  }
  if (path.startsWith('/api/')) {
    errors.push(`Unexpected API request: ${request.method} ${path}`);
    response.writeHead(405).end('Preview is read only');
    return;
  }
  const file = resolve(root, 'dist', path === '/' ? 'index.html' : `.${path}`);
  if (!file.startsWith(`${root}/dist/`)) return response.writeHead(404).end();
  try {
    const content = await readFile(file);
    response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
    response.end(content);
  } catch { response.writeHead(404).end(); }
});
server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise((done) => server.listen(0, '127.0.0.1', done));
let browser;
try {
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_BUNDLED ? {} : { channel: 'chrome' }), headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5, locale: 'zh-CN', timezoneId: 'UTC' });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.setFixedTime(now);
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'networkidle' });
  await page.locator(`[data-project-id="${id(101)}"]`).click();
  await page.getByTestId(`session-node-${id(4)}`).waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(output, 'board-preview.png'), animations: 'disabled' });
  if (await page.locator('.session-card').count() !== 4) throw new Error('Expected four YAM demo cards');
  if (!(await page.getByTestId('sync-status').textContent()).includes('已连接')) throw new Error('Demo SSE did not connect');
  const text = await page.locator('body').innerText();
  if (/\/home\/|lwb|thusigs/.test(text)) throw new Error('Unexpected private text in public screenshot');
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('Public preview captured: docs/assets/board-preview.png (2400×1500). All data is invented; no Codex service accessed.');
} finally {
  await browser?.close();
  for (const socket of sockets) socket.destroy();
  await new Promise((done) => server.close(done));
}
