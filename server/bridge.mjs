import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const failure = (message, status = 400) => Object.assign(new Error(message), { status });

/** Local, authenticated editor bridge. Only validated thread IDs can be opened. */
export class EditorBridge {
  constructor({ dataDir, timeoutMs = 12000, staleMs = 35000, pollMs = 20000 } = {}) {
    const path = join(dataDir, 'bridge-token');
    if (!existsSync(path)) writeFileSync(path, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    chmodSync(path, 0o600);
    this.token = readFileSync(path, 'utf8').trim();
    this.timeoutMs = timeoutMs;
    this.staleMs = staleMs;
    this.pollMs = pollMs;
    this.clients = new Map();
    this.commands = new Map();
  }

  authenticate(value) {
    const actual = Buffer.from(typeof value === 'string' ? value : '');
    const expected = Buffer.from(this.token);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw failure('连接认证失败', 403);
  }

  register(body) {
    if (!UUID.test(body.id) || !Number.isSafeInteger(body.pid) || body.pid < 1 || typeof body.title !== 'string' || body.title.length > 300 ||
      !Array.isArray(body.folders) || body.folders.length > 100 || body.folders.some(path => typeof path !== 'string' || !path.startsWith('/') || path.length > 4096) ||
      !Array.isArray(body.openThreads) || body.openThreads.length > 1000 || body.openThreads.some(id => !UUID.test(id)) ||
      (body.activeThreadId != null && !UUID.test(body.activeThreadId))) throw failure('VS Code 连接信息无效');
    const previous = this.clients.get(body.id);
    this.clients.set(body.id, Object.assign(previous || {}, { id: body.id, title: body.title, pid: body.pid, folders: [...body.folders],
      openThreads: [...new Set(body.openThreads)], activeThreadId: body.activeThreadId || null, seenAt: Date.now() }));
  }

  windows() {
    const now = Date.now();
    for (const [id, client] of this.clients) {
      if (now - client.seenAt > this.staleMs && !client.pending) this.clients.delete(id);
    }
    return [...this.clients.values()].filter(client => now - client.seenAt <= this.staleMs).map(({ id, title, folders, openThreads, activeThreadId }) =>
      ({ id, title, folders, openThreads, activeThreadId, connected: true }));
  }

  async poll(id, response) {
    const client = this.clients.get(id);
    if (!client) throw failure('请重新连接 Codex Board', 404);
    client.seenAt = Date.now();
    const take = () => {
      const command = client.queued;
      client.queued = null;
      return command && this.commands.has(command.id) ? command : null;
    };
    if (client.queued) return { command: take() };
    client.waiter?.(null);
    return new Promise(resolve => {
      let timer;
      const done = command => {
        clearTimeout(timer);
        if (client.waiter === done) client.waiter = null;
        response?.off('close', cancel);
        resolve({ command });
      };
      const cancel = () => done(null);
      client.waiter = done;
      response?.once('close', cancel);
      timer = setTimeout(() => done(null), this.pollMs);
      timer.unref();
    });
  }

  open(threadId, windowId) {
    const windows = this.windows();
    let client = windowId ? this.clients.get(windowId) : null;
    if (windowId && !windows.some(window => window.id === windowId)) throw failure('这个 VS Code 窗口未连接，请重新选择窗口', 409);
    if (!client) {
      const matching = windows.filter(window => window.openThreads.includes(threadId));
      if (matching.length === 1) client = this.clients.get(matching[0].id);
      else if (windows.length === 1) client = this.clients.get(windows[0].id);
      else throw failure(windows.length ? '请选择要定位的 VS Code 窗口' : 'VS Code 连接未就绪，请在 VS Code 运行 Codex Board: Connect', 503);
    }
    if (client.pending) {
      if (client.pending.threadId === threadId) return client.pending.promise;
      throw failure('此窗口正在打开另一条对话，请等待完成', 409);
    }
    if (client.cooldownUntil > Date.now()) throw failure('上一次请求尚未完成，请先查看 VS Code，稍后再试', 409);
    const id = randomUUID();
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const pending = { id, clientId: client.id, threadId, promise, resolve, reject };
    pending.timer = setTimeout(() => {
      this.commands.delete(id);
      if (client.pending === pending) client.pending = null;
      if (client.queued?.id === id) client.queued = null;
      client.cooldownUntil = Date.now() + 15000;
      reject(failure('VS Code 未在 12 秒内确认。可能仍在加载或扩展无响应，请先查看 VS Code；没有自动重试。', 504));
    }, this.timeoutMs);
    client.pending = pending;
    this.commands.set(id, pending);
    const command = { id, threadId };
    if (client.waiter) client.waiter(command);
    else client.queued = command;
    return promise;
  }

  result(body) {
    if (!UUID.test(body.clientId) || !UUID.test(body.commandId) || !['opened', 'error'].includes(body.status) ||
      (body.message != null && (typeof body.message !== 'string' || body.message.length > 1000))) throw failure('窗口响应格式无效');
    const pending = this.commands.get(body.commandId);
    if (!pending) return { ignored: true };
    if (pending.clientId !== body.clientId) throw failure('窗口响应不匹配', 403);
    clearTimeout(pending.timer);
    this.commands.delete(body.commandId);
    const client = this.clients.get(body.clientId);
    if (client?.pending === pending) client.pending = null;
    if (client) client.seenAt = Date.now();
    if (body.status === 'error') pending.reject(failure(body.message || 'VS Code 打开失败', 502));
    else if (body.windowFocused !== true) pending.reject(failure('桥接已更新，请在目标 VS Code 窗口执行 Developer: Reload Window 一次后重试', 409));
    else pending.resolve({ opened: true, editorOpened: true, windowFocused: true, verified: true, reused: body.reused === true, method: 'bridge',
      message: body.reused ? '已定位到已打开的对话' : '已打开 VS Code 对话标签', windowId: body.clientId });
    return { accepted: true };
  }

  close() {
    for (const pending of this.commands.values()) { clearTimeout(pending.timer); pending.reject(failure('服务正在重启，请稍后重试', 503)); }
    this.commands.clear();
    for (const client of this.clients.values()) client.waiter?.(null);
    this.clients.clear();
  }
}
