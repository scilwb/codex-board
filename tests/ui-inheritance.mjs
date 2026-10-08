import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import { createServer } from '../server/index.mjs';
import { makeFixture } from './fixture.mjs';

const fixture = makeFixture();
const calls = [];
const opened = [];
const sent = [];
const sendReceipts = new Map();
const inheritBodies = [];
const errors = [];
const results = [];
const pathFor = id => fixture.db.prepare('SELECT rollout_path FROM threads WHERE id=?').get(id)?.rollout_path;
const sourceId = fixture.ids[0];
const criticalPath = join(fixture.cwd, 'src', 'camera-controller.js');
const missingPath = join(fixture.cwd, 'output', 'pending-report.json');
mkdirSync(dirname(criticalPath), { recursive: true });
writeFileSync(criticalPath, '// Fictional fixture for handoff path verification.\nexport const intervalMs = 20;\nexport const synchronized = true;\n');
appendFileSync(pathFor(sourceId), JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: {
  type: 'user_message', message: `目标：完成双相机时间戳验证。关键文件 [camera-controller.js](${criticalPath}:3)，代码目录 \`${dirname(criticalPath)}\`。已完成采样间隔调整；待办：检查同步误差，将验证结果保存至 \`${missingPath}\`。`,
} }) + '\n');
const sourceSettings = { model: 'gpt-6-astra', modelProvider: 'openai', reasoningEffort: 'ultra', collaborationMode: 'default' };
appendFileSync(pathFor(sourceId), JSON.stringify({ timestamp: new Date().toISOString(), type: 'turn_context', payload: {
  model: sourceSettings.model, effort: sourceSettings.reasoningEffort,
  collaboration_mode: { mode: sourceSettings.collaborationMode, settings: { model: sourceSettings.model, reasoning_effort: sourceSettings.reasoningEffort, developer_instructions: null } },
} }) + '\n');
const sourceBefore = readFileSync(pathFor(sourceId), 'utf8');
let connectedWindows = [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: '虚构的实验工作区', folders: [fixture.cwd], openThreads: [] }];
let failNextSetup = false;
let failNextOpen = false;
let failAfterSend = false;
let creationGate = null;
let releaseCreation = null;
let sendGate = null;
let releaseSend = null;
let releasePreview = null;
const appServer = { async request(method, params) {
  calls.push({ method, params });
  if (method === 'thread/start') {
    assert.equal(params.approvalPolicy, 'never');
    assert.equal(params.permissions, ':danger-full-access');
    assert.equal(Object.hasOwn(params, 'sandbox'), false);
    assert.equal(params.model, sourceSettings.model);
    assert.equal(params.modelProvider, sourceSettings.modelProvider);
    assert.equal(params.config?.model_reasoning_effort, sourceSettings.reasoningEffort);
    const id = randomUUID();
    fixture.insert({ id, title: '虚构的新对话', source: 'appServer' });
    writeFileSync(pathFor(id), JSON.stringify({ type: 'session_meta', payload: { id, cwd: params.cwd } }) + '\n');
    return { thread: { id, path: pathFor(id), cwd: params.cwd } };
  }
  if (method === 'thread/name/set') {
    fixture.db.prepare('UPDATE threads SET name=? WHERE id=?').run(params.name, params.threadId);
    return {};
  }
  if (method === 'thread/settings/update') {
    assert.equal(params.approvalPolicy, 'never');
    assert.equal(params.permissions, ':danger-full-access');
    assert.equal(Object.hasOwn(params, 'sandboxPolicy'), false);
    assert.equal(params.model, sourceSettings.model);
    assert.equal(params.effort, sourceSettings.reasoningEffort);
    assert.deepEqual(params.collaborationMode, { mode: sourceSettings.collaborationMode, settings: { model: sourceSettings.model, reasoning_effort: sourceSettings.reasoningEffort, developer_instructions: null } });
    if (failNextSetup) { failNextSetup = false; throw new Error('模拟来源配置保存失败'); }
    if (creationGate) await creationGate;
    return {};
  }
  if (method === 'thread/unsubscribe') return {};
  if (method === 'thread/archive') {
    fixture.db.prepare('UPDATE threads SET archived=1 WHERE id=?').run(params.threadId);
    return {};
  }
  throw new Error(`Unexpected operation; model execution is forbidden in this fixture: ${method}`);
} };
const bridge = {
  windows: () => connectedWindows,
  async open(id, windowId) {
    opened.push({ id, windowId });
    if (failNextOpen) { failNextOpen = false; throw Object.assign(new Error('模拟 VS Code 打开失败'), { dispatched: false }); }
    return { opened: true, editorOpened: true, verified: true, reused: false };
  },
  async submitInheritance(id, options) {
    const navigation = await this.open(id, options.windowId);
    if (!options.sourceThreadId && readFileSync(pathFor(id), 'utf8').includes('WAX误入的旧交流')) throw Object.assign(new Error('已有其他交流，需要补交接修复'), { dispatched: false, requiresRepair: true });
    if (sendGate) await sendGate;
    if (sendReceipts.has(options.submissionId)) return { ...navigation, ...sendReceipts.get(options.submissionId), alreadySubmitted: true };
    assert.equal(options.settings.model, sourceSettings.model);
    assert.equal(options.settings.reasoningEffort, sourceSettings.reasoningEffort);
    assert.equal(options.settings.cwd, fixture.cwd);
    sent.push({ id, ...options });
    const turnId = randomUUID();
    appendFileSync(pathFor(id), [
      { type: 'user_message', message: options.prompt },
      { type: 'task_started', turn_id: turnId },
      { type: 'agent_message', phase: 'final_answer', message: '已理解虚构交接资料，等待下一条指令。' },
      { type: 'task_complete', turn_id: turnId, last_agent_message: '已理解虚构交接资料，等待下一条指令。' },
    ].map(payload => JSON.stringify({ type: 'event_msg', payload }) + '\n').join(''));
    const receipt = { submitted: true, verified: true, turnId };
    sendReceipts.set(options.submissionId, receipt);
    if (failAfterSend) { failAfterSend = false; throw Object.assign(new Error('模拟已发送但回执丢失'), { dispatched: true }); }
    return { ...navigation, ...receipt };
  },
  async submitRepair(id, options) { return this.submitInheritance(id, options); },
  close() {},
};
const server = createServer({ ...fixture, appServer, bridge, pollIntervalMs: 100 });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const patchOrganization = async body => {
  const response = await fetch(`${base}/api/organization`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, 200);
  return (await response.json()).organization;
};
let browser;
let page;
let handoffRequests = 0;
let inheritanceRequests = 0;
let firstCreatedId;
const editedTitle = '相机验证 · 接续实验';
const promptLimit = 24_000;
const editedPrompt = (`目标：完成双相机时间戳验证。\n已有决定：使用方案 B，保持当前标定参数。\n关键路径：${criticalPath}:3\n下一步待办：检查采样间隔，整理验证结果。\n` + '补充验证记录：保留虚构采样结果，逐项确认时间戳和误差。\n'.repeat(1000)).slice(0, promptLimit - 1) + '。';
const starts = () => calls.filter(call => call.method === 'thread/start').length;
const selectThread = async id => {
  await page.getByTestId('project-all').click();
  await page.getByTestId(`thread-list-${id}`).click();
  await expect(page.getByTestId('detail-thread-id')).toHaveText(id);
};
async function check(name, operation) {
  const start = performance.now();
  await operation();
  results.push({ name, result: 'PASS', durationMs: Math.round(performance.now() - start) });
  console.log(`PASS ${name}`);
}
mkdirSync('artifacts', { recursive: true });
try {
  const project = (await patchOrganization({ action: 'createProject', name: '虚构视觉研究' })).projects[0];
  const task = (await patchOrganization({ action: 'createTask', projectId: project.id, name: '相机验证' })).tasks[0];
  await patchOrganization({ action: 'assign', threadIds: [sourceId], projectId: project.id, taskId: task.id });
  browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_BUNDLED ? {} : { channel: 'chrome' }), headless: true });
  const context = await browser.newContext({ viewport: { width: 1512, height: 1050 }, permissions: ['clipboard-read', 'clipboard-write'] });
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.url().endsWith('/handoff')) handoffRequests++;
    if (request.url().endsWith('/inheritance')) inheritanceRequests++;
    if (request.method() === 'POST' && request.url().endsWith('/inherit')) inheritBodies.push(request.postDataJSON());
  });
  await page.goto(base);
  await check('继承入口按需读取结构化交接与关键路径，沿用配置并支持 24000 字符编辑', async () => {
    await expect(page.getByTestId('thread-list').locator('button')).toHaveCount(3);
    assert.equal(handoffRequests, 0);
    assert.equal(inheritanceRequests, 0);
    assert.equal(calls.length, 0);
    await page.getByTestId('new-thread').click();
    await expect(page.getByTestId('modal-permissions')).toHaveText('Full Access· 完整文件与命令访问，无需逐项审批');
    await page.getByTestId('modal-cancel').click();
    await page.getByTestId(`fork-${sourceId}`).click();
    await expect(page.getByTestId('modal-permissions')).toContainText('Full Access');
    await page.getByTestId('modal-cancel').click();
    assert.equal(handoffRequests, 0);
    await page.getByTestId(`inherit-${sourceId}`).click();
    await expect(page.getByTestId('modal-permissions')).toContainText('完整文件与命令访问，无需逐项审批');
    await expect(page.getByTestId('inherit-prompt')).toBeEnabled();
    await expect(page.getByTestId('modal-title')).toHaveValue(`${fixture.names[0]} · 续聊`);
    await expect(page.getByTestId('modal-cwd')).toHaveValue(fixture.cwd);
    await expect(page.getByTestId('modal-project')).toHaveValue(project.id);
    await expect(page.getByTestId('modal-task')).toHaveValue(task.id);
    await expect(page.getByTestId('inherit-settings-model')).toHaveText(sourceSettings.model);
    await expect(page.getByTestId('inherit-settings-modelProvider')).toHaveText('openai');
    await expect(page.getByTestId('inherit-settings-reasoningEffort')).toHaveText('极高');
    await expect(page.getByTestId('inherit-settings-collaborationMode')).toHaveText('默认模式');
    await expect(page.getByTestId('inherit-settings-plan-note')).toHaveCount(0);
    await expect(page.getByTestId('inherit-settings').locator('input, select, textarea')).toHaveCount(0);
    assert.ok((await page.getByTestId('inherit-prompt').inputValue()).includes(`请处理${fixture.names[0]}`));
    assert.ok((await page.getByTestId('inherit-prompt').inputValue()).includes(criticalPath));
    await expect(page.getByTestId('inherit-prompt')).toHaveAttribute('maxlength', String(promptLimit));
    await expect(page.getByTestId('inherit-prompt')).toHaveAttribute('rows', '14');
    await expect(page.getByTestId('inherit-coverage')).toContainText('公开消息');
    await expect(page.getByTestId('inherit-note')).toContainText('交接内容选入');
    await expect(page.getByTestId('inherit-files')).not.toHaveAttribute('open');
    await page.getByTestId('inherit-files').locator('summary').click();
    await expect(page.getByTestId('inherit-files').locator('li').filter({ hasText: criticalPath })).toContainText('文件存在');
    await expect(page.getByTestId('inherit-files').locator('li').filter({ hasText: missingPath })).toContainText('未找到');
    await page.getByTestId('inherit-files').locator('summary').click();
    assert.equal(handoffRequests, 1);
    assert.equal(calls.length, 0);
    await page.getByTestId('modal-title').fill(editedTitle);
    await page.getByTestId('inherit-prompt').fill(editedPrompt);
    assert.equal(editedPrompt.length, promptLimit);
    await expect(page.getByTestId('inherit-prompt-count')).toHaveText(`${promptLimit} / ${promptLimit}`);
    await expect(page.getByTestId('modal-submit')).toBeEnabled();
    await expect(page.getByTestId('thread-modal')).toContainText('自动发送下方提示词');
    await expect(page.getByTestId('thread-modal')).toContainText('思考状态和继承确认回复');
    await page.screenshot({ path: 'artifacts/ui-inheritance-modal.png', fullPage: true });
  });
  await check('来源配置保存失败保留编辑内容，重试期间禁止重复创建，成功后发送可见首条消息', async () => {
    failNextSetup = true;
    await page.getByTestId('modal-submit').click();
    await expect(page.getByTestId('modal-error')).toContainText('已归档');
    await expect(page.getByTestId('modal-title')).toHaveValue(editedTitle);
    await expect(page.getByTestId('inherit-prompt')).toHaveValue(editedPrompt);
    await expect(page.getByTestId('modal-submit')).toBeEnabled();
    assert.equal(starts(), 1);
    assert.equal(calls.filter(call => call.method === 'thread/archive').length, 1);
    assert.equal(opened.length, 0);
    assert.equal(readFileSync(pathFor(sourceId), 'utf8'), sourceBefore);
    creationGate = new Promise(resolve => { releaseCreation = resolve; });
    await page.getByTestId('modal-submit').click();
    await expect.poll(() => calls.filter(call => call.method === 'thread/settings/update').length).toBe(2);
    await expect(page.getByTestId('modal-submit')).toBeDisabled();
    await expect(page.getByTestId('modal-cancel')).toBeDisabled();
    await expect(page.getByTestId('inherit-prompt')).toBeDisabled();
    await page.getByTestId('thread-modal').locator('form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    assert.equal(starts(), 2);
    sendGate = new Promise(resolve => { releaseSend = resolve; });
    releaseCreation(); creationGate = null;
    await expect(page.getByTestId('thread-modal')).toHaveCount(0);
    await expect.poll(() => opened.length).toBe(1);
    firstCreatedId = await page.getByTestId('detail-thread-id').textContent();
    assert.notEqual(firstCreatedId, sourceId);
    assert.equal(opened[0].id, firstCreatedId);
    await expect(page.getByTestId('inheritance-submission-status')).toContainText('正在向 VS Code 发送');
    await expect(page.getByTestId('inheritance-start')).toBeDisabled();
    assert.equal(sent.length, 0);
    releaseSend(); sendGate = null;
    await expect(page.getByTestId('inheritance-submission-status')).toContainText('交接提示词已发送');
    await expect(page.getByTestId('inheritance-start')).toHaveCount(0);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].id, firstCreatedId);
    assert.equal(sent[0].prompt, editedPrompt);
    assert.ok(readFileSync(pathFor(firstCreatedId), 'utf8').includes('已理解虚构交接资料'));
    const created = server.board.snapshot().threads.find(thread => thread.id === firstCreatedId);
    assert.equal(created.forkedFromId, null);
    assert.equal(created.inheritedFromId, sourceId);
    assert.deepEqual(server.board.store.organization().assignments[firstCreatedId], { projectId: project.id, taskId: task.id });
    assert.equal(server.board.store.inheritance(firstCreatedId).prompt, editedPrompt);
    assert.equal(server.board.store.inheritance(firstCreatedId).prompt.length, promptLimit);
    assert.deepEqual(server.board.store.inheritance(firstCreatedId).settings, sourceSettings);
    assert.equal(calls.filter(call => call.method === 'thread/settings/update').length, 2);
    assert.deepEqual(Object.keys(inheritBodies.at(-1)).sort(), ['cwd', 'projectId', 'prompt', 'requestId', 'taskId', 'title']);
    await expect(page.getByTestId('detail-inherited-from')).toHaveText(sourceId);
    await expect(page.getByTestId('inheritance-context')).toContainText('在 VS Code 查看思考和回复');
    await page.screenshot({ path: 'artifacts/ui-inheritance-created.png', fullPage: true });
  });
  await check('继承关系区别于 Fork，可查看来源且不能删除', async () => {
    await page.getByTestId('project-all').click();
    await expect(page.getByTestId('thread-list').locator('button')).toHaveCount(4);
    await page.locator('.react-flow__controls-fitview').click();
    const edge = page.locator(`.react-flow__edge[data-id="inherit:${firstCreatedId}"]`);
    await expect(edge).toBeVisible();
    await expect(edge).toContainText('继承');
    await edge.locator('.react-flow__edge-textwrapper').click();
    await expect(page.getByTestId('edge-detail')).toContainText('继承关系');
    await expect(page.getByTestId('inherit-source-id')).toHaveText(sourceId);
    await expect(page.getByTestId('delete-edge')).toHaveCount(0);
    await page.getByTestId('inherit-view-source').click();
    await expect(page.getByTestId('detail-thread-id')).toHaveText(sourceId);
  });
  await check('详情按需查看和复制实际提示词，刷新后内容与关系保留', async () => {
    await selectThread(firstCreatedId);
    assert.equal(inheritanceRequests, 0);
    await page.getByTestId('show-inheritance').click();
    await expect(page.getByTestId('inheritance-prompt')).toHaveText(editedPrompt);
    assert.equal(inheritanceRequests, 1);
    await expect(page.getByTestId('inheritance-settings-model')).toHaveText(sourceSettings.model);
    await expect(page.getByTestId('inheritance-settings-reasoningEffort')).toHaveText('极高');
    await expect(page.getByTestId('inheritance-settings-collaborationMode')).toHaveText('默认模式');
    await page.getByTestId('inheritance-copy').click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), editedPrompt);
    await page.getByTestId('collapse-inheritance').click();
    await expect(page.getByTestId('inheritance-prompt')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('thread-list').locator('button')).toHaveCount(4);
    await expect(page.locator(`.react-flow__edge[data-id="inherit:${firstCreatedId}"]`)).toBeVisible();
    assert.equal(inheritanceRequests, 1);
    await selectThread(firstCreatedId);
    await page.getByTestId('show-inheritance').click();
    await expect(page.getByTestId('inheritance-prompt')).toHaveText(editedPrompt);
    assert.equal(inheritanceRequests, 2);
    await expect(page.getByTestId('inheritance-settings-model')).toHaveText(sourceSettings.model);
  });
  await check('打开失败保留新卡，重试同一条对话；回执丢失先核对，提示词原文只发送一次', async () => {
    await selectThread(sourceId);
    await page.getByTestId('detail-inherit').click();
    await expect(page.getByTestId('inherit-prompt')).toBeEnabled();
    await page.getByTestId('modal-title').fill('虚构的续聊 · 手动定位');
    const exactPrompt = '  仅继续检查采集日志。\n';
    await page.getByTestId('inherit-prompt').fill(exactPrompt);
    failNextOpen = true;
    await page.getByTestId('modal-submit').click();
    await expect(page.getByTestId('thread-modal')).toHaveCount(0);
    await expect(page.getByTestId('toast')).toContainText('交接提示词未确认发送');
    const secondCreatedId = await page.getByTestId('detail-thread-id').textContent();
    assert.notEqual(secondCreatedId, sourceId);
    assert.notEqual(secondCreatedId, firstCreatedId);
    await expect(page.getByTestId(`session-node-${secondCreatedId}`)).toBeVisible();
    const attempts = starts();
    assert.equal(attempts, 3);
    assert.equal(opened.at(-1).id, secondCreatedId);
    await expect(page.getByTestId('inheritance-submission-status')).toContainText('继承未完成');
    await expect(page.getByTestId('inheritance-submission-error')).toContainText('模拟 VS Code 打开失败');
    failAfterSend = true;
    await page.getByTestId('inheritance-start').click();
    await expect(page.getByTestId('inheritance-submission-status')).toContainText('发送结果尚未确认');
    await expect(page.getByTestId('inheritance-submission-error')).toContainText('模拟已发送但回执丢失');
    assert.equal(sent.filter(item => item.id === secondCreatedId).length, 1);
    assert.equal(sent.at(-1).prompt, exactPrompt);
    await page.getByTestId('inheritance-start').click();
    await expect(page.getByTestId('inheritance-submission-status')).toContainText('交接提示词已发送');
    await expect(page.getByTestId('toast')).toContainText('交接提示词已发送');
    assert.equal(sent.filter(item => item.id === secondCreatedId).length, 1);
    assert.equal(opened.at(-1).id, secondCreatedId);
    assert.equal(starts(), attempts);
    assert.equal(server.board.snapshot().threads.length, 5);
  });
  await check('多个窗口先选择目标，取消后保留待发送对话，选择后只发送一次', async () => {
    connectedWindows = [...connectedWindows, { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', title: '虚构的第二窗口', folders: [fixture.cwd], openThreads: [] }];
    await page.evaluate(() => localStorage.removeItem('codex-board.window-targets'));
    await page.reload();
    await selectThread(sourceId);
    await page.getByTestId('detail-inherit').click();
    await expect(page.getByTestId('inherit-prompt')).toBeEnabled();
    await page.getByTestId('inherit-prompt').fill('请确认理解交接资料，然后等待。');
    const sendCount = sent.length;
    await page.getByTestId('modal-submit').click();
    await expect(page.getByTestId('window-picker')).toContainText('在哪个窗口发送并打开？');
    const childId = await page.getByTestId('detail-thread-id').textContent();
    assert.equal(sent.length, sendCount);
    await page.getByTestId('window-picker').getByRole('button', { name: '取消' }).click();
    await expect(page.getByTestId('inheritance-submission-status')).toContainText('交接提示词尚未发送');
    await expect(page.getByTestId('inheritance-start')).toBeEnabled();
    const creationCount = starts();
    await page.getByTestId('inheritance-start').click();
    await expect(page.getByTestId('window-picker')).toBeVisible();
    await page.getByTestId('window-option-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb').check();
    await page.getByTestId('window-picker-open').click();
    await expect(page.getByTestId('window-picker')).toHaveCount(0);
    await expect(page.getByTestId('inheritance-submission-status')).toContainText('交接提示词已发送');
    assert.equal(sent.length, sendCount + 1);
    assert.equal(sent.at(-1).id, childId);
    assert.equal(sent.at(-1).windowId, connectedWindows[1].id);
    assert.equal(starts(), creationCount);
    connectedWindows = connectedWindows.slice(0, 1);
  });
  await check('失败继承持续可见，已交流的原对话可预览并补交接，保留旧消息且只发送一次', async () => {
    await selectThread(sourceId);
    await page.getByTestId('detail-inherit').click();
    await expect(page.getByTestId('inherit-prompt')).toBeEnabled();
    const handoff = await page.getByTestId('inherit-prompt').inputValue();
    const sendCount = sent.length;
    failNextOpen = true;
    await page.getByTestId('modal-submit').click();
    await expect(page.getByTestId('thread-modal')).toHaveCount(0);
    const childId = await page.getByTestId('detail-thread-id').textContent();
    await expect(page.getByTestId(`inherit-status-${childId}`)).toHaveText('继承未完成');
    const oldMessage = 'WAX误入的旧交流';
    appendFileSync(pathFor(childId), JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: oldMessage } }) + '\n');
    const creationCount = starts();
    await page.getByTestId('inheritance-start').click();
    await expect(page.getByTestId('repair-dialog')).toBeVisible();
    await expect(page.getByTestId('repair-source')).toContainText(sourceId);
    await expect(page.getByTestId('repair-prompt')).toContainText('唯一直接来源对话 ID');
    await expect(page.getByTestId('repair-prompt')).toContainText(handoff);
    const correction = await page.getByTestId('repair-prompt').textContent();
    assert.equal(sent.length, sendCount, 'preview must not send a model message');
    assert.equal(starts(), creationCount, 'repair must keep the original conversation');
    sendGate = new Promise(resolve => { releaseSend = resolve; });
    await page.getByTestId('repair-submit').click();
    await expect(page.getByTestId('repair-submit')).toBeDisabled();
    await page.getByTestId('repair-dialog').locator('form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    releaseSend(); sendGate = null;
    await expect(page.getByTestId('repair-dialog')).toHaveCount(0);
    await expect(page.getByTestId('detail-thread-id')).toHaveText(childId);
    await expect(page.getByTestId('inheritance-submission-status')).toContainText('交接提示词已发送');
    await expect(page.getByTestId(`inherit-status-${childId}`)).toHaveText('继承');
    assert.equal(sent.length, sendCount + 1);
    assert.equal(sent.at(-1).id, childId);
    assert.equal(sent.at(-1).sourceThreadId, sourceId);
    assert.equal(sent.at(-1).prompt, correction);
    const saved = server.board.store.inheritance(childId);
    assert.equal(saved.prompt, handoff);
    assert.equal(saved.repair.prompt, correction);
    assert.equal(saved.repair.originalSubmission.status, 'needs_repair');
    assert.equal(saved.repair.submission.status, 'submitted');
    assert.equal(saved.submission.status, 'submitted');
    const history = readFileSync(pathFor(childId), 'utf8');
    assert.ok(history.includes(oldMessage));
    assert.equal(history.split(JSON.stringify(correction)).length - 1, 1);
    await page.reload();
    await selectThread(childId);
    await page.getByTestId('detail-open').click();
    await expect(page.getByTestId('toast')).toContainText('已打开');
    assert.equal(sent.length, sendCount + 1);
    assert.equal(starts(), creationCount);
    assert.equal(readFileSync(pathFor(sourceId), 'utf8'), sourceBefore);
  });
  await check('旧版继承显示补发说明，打开已有对话不会自动再发送', async () => {
    const managed = server.board.store.state.managedThreads[firstCreatedId];
    const { submission, ...legacyHandoff } = managed.inheritance;
    server.board.store.remember({ ...managed, inheritance: legacyHandoff });
    const sendCount = sent.length;
    await page.reload();
    await selectThread(firstCreatedId);
    await expect(page.getByTestId('inheritance-submission-status')).toContainText('已继续交流的对话无需补发');
    await expect(page.getByTestId('inheritance-start')).toHaveText('发送交接并打开');
    await page.getByTestId('detail-open').click();
    await expect(page.getByTestId('toast')).toContainText('已打开');
    assert.equal(sent.length, sendCount);
  });
  await check('交接预览读取失败可重试，取消后旧请求不会污染下一张卡', async () => {
    const otherId = fixture.ids[1];
    const otherUrl = `${base}/api/threads/${otherId}/handoff`;
    let failPreview = true;
    await page.route(otherUrl, route => {
      if (failPreview) { failPreview = false; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '模拟预览读取失败' }) }); }
      return route.continue();
    });
    await selectThread(otherId);
    await page.getByTestId('detail-inherit').click();
    await expect(page.getByTestId('inherit-error')).toContainText('模拟预览读取失败');
    await expect(page.getByTestId('modal-submit')).toBeDisabled();
    await page.getByTestId('inherit-retry').click();
    await expect(page.getByTestId('inherit-prompt')).toBeEnabled();
    assert.ok((await page.getByTestId('inherit-prompt').inputValue()).includes(fixture.names[1]));
    await page.getByTestId('modal-cancel').click();
    await page.unroute(otherUrl);

    const delayedUrl = `${base}/api/threads/${sourceId}/handoff`;
    let entered = false;
    const gate = new Promise(resolve => { releasePreview = resolve; });
    await page.route(delayedUrl, async route => {
      const response = await route.fetch(); entered = true;
      await gate;
      await route.fulfill({ response }).catch(() => {});
    });
    await selectThread(sourceId);
    await page.getByTestId('detail-inherit').click();
    await expect.poll(() => entered).toBe(true);
    await expect(page.getByTestId('inherit-loading')).toBeVisible();
    await page.getByTestId('modal-cancel').click();
    await selectThread(otherId);
    await page.getByTestId('detail-inherit').click();
    await expect(page.getByTestId('inherit-prompt')).toBeEnabled();
    const otherPrompt = await page.getByTestId('inherit-prompt').inputValue();
    releasePreview();
    await page.unroute(delayedUrl);
    await expect(page.getByTestId('inherit-prompt')).toHaveValue(otherPrompt);
    await expect(page.getByTestId('inherit-origin')).toContainText(fixture.names[1]);
  });
  await check('缺失配置使用默认说明，计划模式与显式默认值正确展示', async () => {
    await page.getByTestId('modal-cancel').click();
    const otherId = fixture.ids[1];
    const url = `${base}/api/threads/${otherId}/handoff`;
    let settings = {};
    await page.route(url, async route => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), settings } });
    });
    await selectThread(otherId);
    await page.getByTestId('detail-inherit').click();
    await expect(page.getByTestId('inherit-prompt')).toBeEnabled();
    await expect(page.getByTestId('inherit-settings')).toContainText('来源未记录此设置，使用 Codex 默认值');
    await expect(page.getByTestId('inherit-settings-model')).toHaveCount(0);
    await page.getByTestId('modal-cancel').click();
    settings = { model: 'gpt-6-astra', reasoningEffort: null, collaborationMode: 'plan', serviceTier: null };
    await page.getByTestId('detail-inherit').click();
    await expect(page.getByTestId('inherit-prompt')).toBeEnabled();
    await expect(page.getByTestId('inherit-settings-reasoningEffort')).toHaveText('默认');
    await expect(page.getByTestId('inherit-settings-serviceTier')).toHaveText('默认');
    await expect(page.getByTestId('inherit-settings-collaborationMode')).toHaveText('计划模式');
    await expect(page.getByTestId('inherit-settings-plan-note')).toHaveText('已保存计划模式；打开 VS Code 后请核对计划开关。');
    await page.unroute(url);
  });
  await check('超长预览按接口上限截取，超限编辑禁止提交，旧版交接数据仍可读取', async () => {
    await page.getByTestId('modal-cancel').click();
    const url = `${base}/api/threads/${sourceId}/handoff`;
    let mode = 'over-limit';
    await page.route(url, async route => {
      const response = await route.fetch();
      const original = await response.json();
      let data;
      if (mode === 'legacy') {
        const { maxPromptLength, version, coverage, files, ...legacy } = original;
        data = { ...legacy, prompt: '旧版公开消息摘录，可继续编辑。', truncated: false };
      } else {
        data = { ...original, maxPromptLength: mode === 'lower-limit' ? 12000 : promptLimit, prompt: '长'.repeat(promptLimit + 1), truncated: false,
          coverage: { bytesRead: 1024, totalBytes: 4096, sampled: true, windowCount: 3, messageCount: 12 } };
      }
      await route.fulfill({ response, json: data });
    });
    await selectThread(sourceId);
    await page.getByTestId('detail-inherit').click();
    await expect(page.getByTestId('inherit-prompt')).toBeEnabled();
    assert.equal((await page.getByTestId('inherit-prompt').inputValue()).length, promptLimit);
    await expect(page.getByTestId('inherit-note')).toContainText('内容已截取');
    await expect(page.getByTestId('inherit-coverage')).toContainText('分段读取（3 处），未读取内容可能遗漏');
    await expect(page.getByTestId('inherit-coverage')).toContainText('1.0 KB / 4.0 KB');
    await page.getByTestId('inherit-prompt').evaluate(element => element.removeAttribute('maxlength'));
    await page.getByTestId('inherit-prompt').fill('长'.repeat(promptLimit + 1));
    await expect(page.getByTestId('modal-submit')).toBeDisabled();
    const before = starts();
    await page.getByTestId('thread-modal').locator('form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await expect(page.getByTestId('modal-error')).toContainText(`最多 ${promptLimit} 字符`);
    assert.equal(starts(), before);
    await page.getByTestId('modal-cancel').click();

    mode = 'lower-limit';
    await page.getByTestId('detail-inherit').click();
    await expect(page.getByTestId('inherit-prompt')).toBeEnabled();
    await expect(page.getByTestId('inherit-prompt')).toHaveAttribute('maxlength', '12000');
    await expect(page.getByTestId('inherit-prompt-count')).toHaveText('12000 / 12000');
    await expect(page.getByTestId('inherit-note')).toContainText('内容已截取');
    await page.getByTestId('modal-cancel').click();

    mode = 'legacy';
    await page.getByTestId('detail-inherit').click();
    await expect(page.getByTestId('inherit-prompt')).toHaveValue('旧版公开消息摘录，可继续编辑。');
    await expect(page.getByTestId('inherit-prompt')).toHaveAttribute('maxlength', String(promptLimit));
    await expect(page.getByTestId('inherit-coverage')).toHaveCount(0);
    await expect(page.getByTestId('inherit-files')).toHaveCount(0);
    await expect(page.getByTestId('inherit-note')).toContainText('已读取');
    await expect(page.getByTestId('inherit-settings-model')).toHaveText(sourceSettings.model);
    await page.unroute(url);
  });
  await check('窄屏弹窗与长路径清单可操作，空提示禁提交，没有模型调用或浏览器错误', async () => {
    await page.getByTestId('modal-cancel').click();
    await page.getByTestId('detail-inherit').click();
    await expect(page.getByTestId('inherit-prompt')).toBeEnabled();
    await page.setViewportSize({ width: 600, height: 800 });
    await page.getByTestId('inherit-files').locator('summary').click();
    await expect(page.getByTestId('inherit-files')).toContainText(criticalPath);
    await page.getByTestId('inherit-prompt').fill('');
    await expect(page.getByTestId('modal-submit')).toBeDisabled();
    await page.getByTestId('inherit-prompt').fill('目标：继续虚构实验。');
    await expect(page.getByTestId('modal-submit')).toBeEnabled();
    await page.getByTestId('modal-submit').scrollIntoViewIfNeeded();
    const button = await page.getByTestId('modal-submit').boundingBox();
    assert.ok(button.x >= 0 && button.x + button.width <= 600 && button.y >= 0 && button.y + button.height <= 800);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await page.getByTestId('thread-modal').evaluate(element => element.scrollWidth > element.clientWidth), false);
    await page.getByTestId('modal-cancel').click();
    await expect(page.getByTestId('thread-modal')).toHaveCount(0);
    assert.equal(readFileSync(pathFor(sourceId), 'utf8'), sourceBefore);
    assert.equal(calls.some(call => call.method === 'turn/start' || call.method === 'thread/fork'), false);
    assert.deepEqual(errors, []);
  });
  writeFileSync('artifacts/ui-inheritance-results.json', JSON.stringify({ environment: 'Isolated fictional fixture; metadata client and simulated visible native send; no real model calls', results, errors }, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: 'artifacts/ui-inheritance-failure.png', fullPage: true }).catch(() => {});
  console.error(error);
  console.error('Browser errors:', errors);
  process.exitCode = 1;
} finally {
  releaseCreation?.(); releaseSend?.(); releasePreview?.();
  await browser?.close();
  server.board.closeStreams();
  const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed;
  fixture.cleanup();
}
