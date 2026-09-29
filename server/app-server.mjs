import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

export function codexBinary() {
  if (process.env.CODEX_BOARD_CODEX_BIN) return process.env.CODEX_BOARD_CODEX_BIN;
  const extensions = join(homedir(), '.vscode', 'extensions');
  if (existsSync(extensions)) {
    const candidates = readdirSync(extensions).filter(name => name.startsWith('openai.chatgpt-')).sort().reverse();
    for (const candidate of candidates) {
      const binary = join(extensions, candidate, 'bin', `linux-${process.arch === 'x64' ? 'x86_64' : process.arch}`, 'codex');
      if (existsSync(binary)) return binary;
    }
  }
  return 'codex';
}

/** Local metadata/history client. Never submits turn/start or inference. */
export class AppServerClient {
  constructor({ codexHome, binary = codexBinary(), timeoutMs = 45000, idleTimeoutMs = 30000 } = {}) {
    this.codexHome = codexHome;
    this.binary = binary;
    this.timeoutMs = timeoutMs;
    this.idleTimeoutMs = idleTimeoutMs;
    this.pending = new Map();
    this.nextId = 1;
  }

  async ready() {
    if (this.initializing) return this.initializing;
    const initializing = this.initialize();
    const child = this.child;
    this.initializing = initializing.catch(error => {
      if (this.child === child) this.stop();
      throw error;
    });
    return this.initializing;
  }

  async initialize() {
    const child = spawn(this.binary, ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_HOME: this.codexHome },
    });
    this.child = child;
    this.stderr = '';
    child.stdin.on('error', error => {
      if (this.child === child) this.failPending(new Error(`Codex App Server 连接失败：${error.message}`));
    });
    child.stderr.on('data', chunk => {
      if (this.child === child) this.stderr = (this.stderr + chunk).slice(-2000);
    });
    child.once('error', error => {
      if (this.child === child) this.failPending(new Error(`无法启动 Codex App Server：${error.message}`));
    });
    child.once('exit', () => {
      // A stopped process can exit after its replacement has already started.
      // It must never clear the replacement's pending requests or identity.
      if (this.child !== child) return;
      this.cancelIdleShutdown();
      this.failPending(new Error('Codex App Server 已退出，请重试。'));
      this.initializing = null;
      this.child = null;
    });
    this.lines = createInterface({ input: child.stdout });
    this.lines.on('line', line => {
      if (this.child !== child) return;
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (!pending) {
        if (message.method) this.child?.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'This client only manages conversation metadata.' } }) + '\n');
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || 'Codex 操作失败'));
      else pending.resolve(message.result);
      this.scheduleIdleShutdown(child);
    });
    await this.send('initialize', { clientInfo: { name: 'codex_board', title: 'Codex Board', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    if (this.child !== child) throw new Error('Codex App Server 在初始化时已关闭');
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  }

  send(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.child?.stdin.writable) return reject(new Error('Codex App Server 不可用'));
      this.cancelIdleShutdown();
      const child = this.child;
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} 超时`));
        this.scheduleIdleShutdown(child);
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  async request(method, params) {
    await this.ready();
    return this.send(method, params);
  }

  failPending(error) {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
  }

  cancelIdleShutdown() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  scheduleIdleShutdown(child = this.child) {
    this.cancelIdleShutdown();
    if (!child || this.child !== child || this.pending.size || this.idleTimeoutMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      if (this.child === child && this.pending.size === 0) this.stop();
    }, this.idleTimeoutMs);
    this.idleTimer.unref();
  }

  async stopAndWait({ graceMs = 1000, timeoutMs = 5000 } = {}) {
    const child = this.child;
    if (!child) return;
    // thread/unsubscribe can acknowledge before the native thread writer has
    // been released. Hand the thread to VS Code only after our process exits.
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
      this.stop();
      return;
    }
    await new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(forceTimer);
        clearTimeout(deadline);
        child.off('exit', exited);
        error ? reject(error) : resolve();
      };
      const exited = () => finish();
      const forceTimer = setTimeout(() => child.kill('SIGKILL'), graceMs);
      const deadline = setTimeout(() => finish(new Error('Codex 创建进程尚未退出，对话暂时无法交给 VS Code。')), timeoutMs);
      child.once('exit', exited);
      this.stop();
    });
  }

  stop() {
    this.cancelIdleShutdown();
    const child = this.child;
    this.child = null;
    this.initializing = null;
    this.failPending(new Error('Codex App Server 已关闭'));
    this.lines?.close();
    this.lines = null;
    child?.stdin.end();
    child?.kill('SIGTERM');
  }
}
