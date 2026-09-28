import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, join, extname, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { BoardStore, UUID } from './store.mjs';
import { AppServerClient } from './app-server.mjs';
import { EditorBridge } from './bridge.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const MAX_BODY = 1024 * 1024;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2' };
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

async function readJson(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) throw fail('请求必须使用 application/json', 415);
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw fail('请求内容过大', 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw fail('JSON 格式无效'); }
}

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

function localRequest(request) {
  let host;
  try { host = new URL(`http://${request.headers.host}`).hostname; } catch { return false; }
  return ['localhost', '127.0.0.1', '[::1]'].includes(host);
}

function currentBranch(cwd) {
  try { return execFileSync('git', ['-C', cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { timeout: 1500, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; }
  catch { return null; }
}

function validCwd(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 4096 || value.includes('\0')) throw fail('请选择本机的文件夹绝对路径');
  const cwd = resolve(value);
  try { if (!statSync(cwd).isDirectory()) throw new Error(); } catch { throw fail('文件夹不存在'); }
  return cwd;
}

function validTitle(value, fallback) {
  if (value === undefined || value === '') return fallback;
  if (typeof value !== 'string' || value.trim().length > 120 || !value.trim()) throw fail('对话标题须为 1 到 120 个字符');
  return value.trim();
}

export function createServer(options = {}) {
  const codexHome = options.codexHome || process.env.CODEX_BOARD_CODEX_HOME || join(homedir(), '.codex');
  const dataDir = options.dataDir || process.env.CODEX_BOARD_DATA_DIR || join(homedir(), '.local', 'share', 'codex-board');
  const distDir = resolve(options.distDir || join(ROOT, 'dist'));
  const store = new BoardStore({ codexHome, dataDir });
  const appServer = options.appServer || new AppServerClient({ codexHome, binary: options.codexBinary });
  const bridge = options.bridge || new EditorBridge({ dataDir, ...options.bridgeOptions });
  const clients = new Set();
  let lastSnapshot = '';
  let operationInFlight = false;
  let closed = false;

  function snapshot() {
    let threads = [], error;
    try { threads = store.threads(); } catch (problem) { error = problem.message; }
    return {
      threads,
      graph: store.graph(),
      organization: store.organization(),
      capabilities: { create: !options.disableActions, fork: !options.disableActions, openVscode: !options.disableOpen },
      ...(error ? { error } : {}),
    };
  }

  function broadcast(force = false) {
    if (closed) return;
    const data = JSON.stringify(snapshot());
    if (!force && data === lastSnapshot) return;
    lastSnapshot = data;
    for (const client of clients) {
      if (client.writableLength > 2 * 1024 * 1024) { client.destroy(); clients.delete(client); continue; }
      client.write(`event: snapshot\ndata: ${data}\n\n`);
    }
  }

  function findThread(id) {
    if (!UUID.test(id)) throw fail('对话 ID 格式无效');
    const thread = store.threads().find(item => item.id === id);
    if (!thread) throw fail('找不到这个对话', 404);
    return thread;
  }

  async function createThread(body, parent = null) {
    if (options.disableActions) throw fail('本环境未启用新建和 Fork', 503);
    if (operationInFlight) throw fail('上一个新建或 Fork 正在完成，请稍后重试', 409);
    const cwd = validCwd(body.cwd || parent?.cwd);
    const title = validTitle(body.title, parent ? `${parent.title.slice(0, 100)} · Fork` : '新对话');
    const organization = store.organization();
    const assignment = Object.hasOwn(body, 'projectId')
      ? { projectId: body.projectId, taskId: body.taskId || null }
      : (parent ? organization.assignments[parent.id] : null);
    if (assignment?.projectId != null && !organization.projects.some(project => project.id === assignment.projectId)) throw fail('项目不存在');
    if (assignment?.taskId && !organization.tasks.some(task => task.id === assignment.taskId && task.projectId === assignment.projectId)) throw fail('任务不属于所选项目');
    operationInFlight = true;
    try {
      const result = parent
        ? await appServer.request('thread/fork', { threadId: parent.id, cwd, excludeTurns: true, ephemeral: false })
        : await appServer.request('thread/start', { cwd, ephemeral: false, historyMode: 'legacy', persistExtendedHistory: true });
      const created = result.thread;
      if (!created || !UUID.test(created.id)) throw fail('Codex 未返回有效的会话 ID', 502);
      await appServer.request('thread/name/set', { threadId: created.id, name: title });
      // Release app-server's live agent after the metadata operation. This also
      // flushes durable history before a different VS Code process resumes it.
      await appServer.request('thread/unsubscribe', { threadId: created.id });
      if (typeof created.path === 'string' && !existsSync(created.path)) {
        throw fail(`Codex 尚未持久化新对话 ${created.id}，暂时无法在 VS Code 中打开。`, 502);
      }
      const thread = {
        id: created.id,
        title,
        preview: created.preview || parent?.preview || '',
        cwd: created.cwd || cwd,
        project: basename(created.cwd || cwd),
        branch: created.gitInfo?.branch || currentBranch(cwd),
        updatedAt: (created.updatedAt || Math.floor(Date.now() / 1000)) * 1000,
        createdAt: (created.createdAt || Math.floor(Date.now() / 1000)) * 1000,
        forkedFromId: parent?.id || created.forkedFromId || null,
        status: 'unknown',
        archived: false,
      };
      store.remember(thread);
      if (assignment?.projectId) store.updateOrganization({ action: 'assign', threadIds: [thread.id], ...assignment }, new Set([thread.id]));
      broadcast(true);
      return thread;
    } finally { operationInFlight = false; }
  }

  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (!localRequest(request)) throw fail('只允许从本机访问', 403);
      const url = new URL(request.url, `http://${request.headers.host}`);
      const pathname = decodeURIComponent(url.pathname);
      if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method)) {
        const origin = request.headers.origin;
        if (origin && origin !== `http://${request.headers.host}`) throw fail('拒绝跨站请求', 403);
        if (request.headers['sec-fetch-site'] === 'cross-site') throw fail('拒绝跨站请求', 403);
      }

      if (request.method === 'GET' && pathname === '/api/snapshot') return json(response, 200, snapshot());
      if (pathname.startsWith('/api/bridge/')) {
        bridge.authenticate(request.headers['x-codex-board-token']);
        if (request.method === 'POST' && pathname === '/api/bridge/register') {
          bridge.register(await readJson(request));
          return json(response, 200, { connected: true });
        }
        if (request.method === 'GET' && pathname === '/api/bridge/poll') return json(response, 200, await bridge.poll(url.searchParams.get('clientId'), response));
        if (request.method === 'POST' && pathname === '/api/bridge/result') return json(response, 200, bridge.result(await readJson(request)));
        throw fail('接口不存在', 404);
      }
      if (request.method === 'GET' && pathname === '/api/vscode/windows') {
        const windows = bridge.windows();
        return json(response, 200, { windows, bridgeAvailable: windows.length > 0,
          ...(windows.length ? {} : { error: 'VS Code 连接未就绪，请在 VS Code 运行 Codex Board: Connect' }) });
      }
      if (request.method === 'GET' && pathname === '/api/events') {
        if (clients.size >= 32) throw fail('连接数量过多', 429);
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
        clients.add(response);
        request.on('close', () => clients.delete(response));
        return;
      }
      if (request.method === 'GET' && ['/api/projects', '/api/folders'].includes(pathname)) {
        const projects = new Map();
        for (const thread of store.threads()) if (!projects.has(thread.cwd)) projects.set(thread.cwd, { cwd: thread.cwd, name: thread.project, branch: currentBranch(thread.cwd) });
        return json(response, 200, { projects: [...projects.values()].sort((a, b) => a.cwd.localeCompare(b.cwd)) });
      }
      if (request.method === 'PATCH' && pathname === '/api/organization') {
        const organization = store.updateOrganization(await readJson(request), new Set(store.threads().map(thread => thread.id)));
        broadcast(true);
        return json(response, 200, { organization });
      }
      if (request.method === 'PATCH' && pathname === '/api/graph') {
        const body = await readJson(request);
        const graph = store.updateGraph(body, new Set(store.threads().map(thread => thread.id)));
        broadcast(true);
        return json(response, 200, { graph });
      }
      if (request.method === 'POST' && pathname === '/api/threads') {
        return json(response, 201, { thread: await createThread(await readJson(request)) });
      }
      const forkMatch = pathname.match(/^\/api\/threads\/([^/]+)\/fork$/);
      if (request.method === 'POST' && forkMatch) return json(response, 201, { thread: await createThread(await readJson(request), findThread(forkMatch[1])) });
      const openMatch = pathname.match(/^\/api\/threads\/([^/]+)\/open-vscode$/);
      if (request.method === 'POST' && openMatch) {
        const body = await readJson(request);
        if (options.disableOpen) throw fail('本环境未启用 VS Code 跳转', 503);
        const thread = findThread(openMatch[1]);
        if (body.windowId != null && (typeof body.windowId !== 'string' || !UUID.test(body.windowId))) throw fail('VS Code 窗口标识无效');
        const record = store.database().prepare('SELECT rollout_path FROM threads WHERE id=?').get(thread.id);
        if (!record?.rollout_path || !existsSync(record.rollout_path)) throw fail('这条对话的历史文件不在本机，已停止打开以避免 Codex 反复重试。', 409);
        return json(response, 200, await bridge.open(thread.id, body.windowId));
      }
      if (pathname.startsWith('/api/')) throw fail('接口不存在', 404);
      if (!['GET', 'HEAD'].includes(request.method)) throw fail('不支持此方法', 405);
      const target = resolve(distDir, `.${pathname}`);
      if (target !== distDir && !target.startsWith(`${distDir}/`)) throw fail('路径无效', 403);
      const path = existsSync(target) && statSync(target).isFile() ? target : (!extname(pathname) ? join(distDir, 'index.html') : null);
      if (!path || !existsSync(path)) throw fail('界面文件不存在，请先运行 npm run build', 404);
      response.writeHead(200, {
        'Content-Type': MIME[extname(path)] || 'application/octet-stream',
        'Cache-Control': extname(path) === '.html' ? 'no-cache' : 'public, max-age=3600',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
      });
      if (request.method === 'HEAD') response.end();
      else createReadStream(path).on('error', () => response.destroy()).pipe(response);
    } catch (error) {
      if (!response.headersSent) json(response, error.status || 400, { error: error.message || '操作失败' });
      else response.destroy();
    }
  });

  const timer = setInterval(broadcast, options.pollIntervalMs || 2000);
  timer.unref();
  const heartbeat = setInterval(() => { for (const client of clients) client.write(': keepalive\n\n'); }, 20000);
  heartbeat.unref();
  server.on('close', () => {
    closed = true;
    clearInterval(timer); clearInterval(heartbeat);
    for (const client of clients) client.end();
    clients.clear(); bridge.close(); store.close(); appServer.stop?.();
  });
  server.board = { snapshot, store, appServer, bridge, broadcast, closeStreams() { for (const client of clients) client.end(); bridge.close(); } };
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.CODEX_BOARD_PORT || 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CODEX_BOARD_PORT 无效');
  const server = createServer();
  server.listen(port, '127.0.0.1', () => console.log(`Codex Board: http://127.0.0.1:${port}`));
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  const stop = () => { server.board.closeStreams(); server.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
