import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FRAME = 16 * 1024 * 1024;
const VERSIONS = { initialize: 0, 'thread-owner-discovery': 1, 'thread-follower-load-complete-history': 1, 'thread-follower-start-turn': 2 };

function failure(message, dispatched = false) {
  return Object.assign(new Error(message), { dispatched });
}

function inputText(input) {
  if (!Array.isArray(input)) return '';
  return input.filter(item => item?.type === 'text' || item?.type === 'input_text').map(item => item.text ?? '').join('\n');
}

// The native stream includes internal context and reasoning. Retain only the
// public user inputs needed to verify a submission; never expose the snapshot.
export function publicSubmissionState(state) {
  const turns = state?.turnHistory?.kind === 'canonical'
    ? Object.values(state.turnHistory.history?.entitiesByKey ?? {})
    : state?.turns ?? [];
  const seen = new Set();
  return {
    revision: 0,
    pending: (state?.unconfirmedTurnSubmissions?.length ?? 0) > 0 || state?.threadRuntimeStatus?.type === 'active'
      || turns.some(turn => !turn?.turnId && turn?.status === 'inProgress' && inputText(turn.params?.input)),
    turns: turns.filter(turn => {
      if (!turn?.turnId || seen.has(turn.turnId)) return false;
      seen.add(turn.turnId);
      return true;
    }).map(turn => ({
      turnId: turn.turnId,
      status: turn.status,
      submissionId: turn.params?.clientUserMessageId ?? null,
      text: inputText(turn.params?.input) || (turn.items ?? []).filter(item => item?.type === 'userMessage').map(item => inputText(item.content)).join('\n'),
    })),
  };
}

export class CodexIpcClient {
  constructor({ codexHome = join(homedir(), '.codex'), endpoint, timeoutMs = 30000, ownerTimeoutMs = 15000, retryMs = 200, maxFrameBytes = MAX_FRAME } = {}) {
    this.endpoint = endpoint ?? join(codexHome, 'ipc', 'ipc.sock');
    this.timeoutMs = timeoutMs;
    this.ownerTimeoutMs = ownerTimeoutMs;
    this.retryMs = retryMs;
    this.maxFrameBytes = maxFrameBytes;
    this.socket = null;
    this.clientId = 'initializing-client';
    this.pending = new Map();
    this.snapshots = new Map();
    this.snapshotWaiters = new Set();
    this.submissions = new Map();
    this.following = new Map();
    this.connecting = null;
    this.closed = false;
  }

  async ready() {
    if (this.closed) throw failure('Codex 连接已关闭。');
    if (this.socket && !this.socket.destroyed && this.clientId !== 'initializing-client') return;
    if (this.connecting) return this.connecting;
    this.connecting = this.initialize();
    try { await this.connecting; } finally { this.connecting = null; }
  }

  async initialize() {
    let stat;
    try { stat = await lstat(this.endpoint); }
    catch { throw failure('Codex 的本地连接未就绪，请先在 VS Code 打开 Codex。'); }
    if (!stat.isSocket() || (process.getuid && stat.uid !== process.getuid())) throw failure('Codex 本地连接的所有者无效。');
    const socket = connect(this.endpoint);
    this.socket = socket;
    this.clientId = 'initializing-client';
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4) {
          const size = buffer.readUInt32LE(0);
          if (!size || size > this.maxFrameBytes) throw failure('Codex 本地消息大小无效。');
          if (buffer.length < size + 4) break;
          const message = JSON.parse(buffer.subarray(4, size + 4).toString('utf8'));
          buffer = buffer.subarray(size + 4);
          this.receive(message);
        }
      } catch (error) { this.disconnect(error, socket); }
    });
    socket.on('error', error => this.disconnect(failure(`Codex 本地连接失败：${error.code || error.message}`), socket));
    socket.on('close', () => this.disconnect(failure('Codex 本地连接已断开。'), socket));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(failure('Codex 本地连接超时。')); }, this.timeoutMs);
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
      socket.once('error', () => { clearTimeout(timer); reject(failure('无法连接 VS Code 中的 Codex。')); });
    });
    const response = await this.request('initialize', { clientType: 'codex-board' });
    if (typeof response.result?.clientId !== 'string') throw failure('Codex 本地连接没有返回有效客户端。');
    this.clientId = response.result.clientId;
  }

  disconnect(error, socket = this.socket) {
    if (socket !== this.socket) return;
    this.socket = null;
    this.clientId = 'initializing-client';
    this.snapshots.clear();
    this.following.clear();
    socket?.destroy();
    for (const [id, item] of this.pending) {
      clearTimeout(item.timer);
      item.reject(failure(error.message, item.dispatched));
      this.pending.delete(id);
    }
    for (const waiter of this.snapshotWaiters) waiter.reject(error);
  }

  write(message) {
    const socket = this.socket;
    if (!socket?.writable || socket.destroyed) throw failure('Codex 本地连接不可用。');
    const body = Buffer.from(JSON.stringify(message));
    if (body.length > this.maxFrameBytes) throw failure('继承消息过大。');
    const frame = Buffer.alloc(body.length + 4);
    frame.writeUInt32LE(body.length, 0);
    body.copy(frame, 4);
    socket.write(frame);
  }

  request(method, params, { targetClientId, timeoutMs = this.timeoutMs, mutation = false } = {}) {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const item = { resolve, reject, dispatched: false, method };
      item.timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(failure('Codex 未及时确认请求，请检查对话后重试。', item.dispatched));
      }, timeoutMs);
      this.pending.set(requestId, item);
      try {
        this.write({ type: 'request', requestId, sourceClientId: this.clientId, version: VERSIONS[method], method, params, targetClientId, timeoutMs });
        item.dispatched = mutation;
      } catch (error) {
        clearTimeout(item.timer);
        this.pending.delete(requestId);
        reject(failure(error.message, false));
      }
    });
  }

  receive(message) {
    if (message.type === 'response') {
      const item = this.pending.get(message.requestId);
      if (!item) return;
      clearTimeout(item.timer);
      this.pending.delete(message.requestId);
      if (message.resultType !== 'success') item.reject(failure(`Codex 拒绝请求：${message.error || '未知错误'}`, item.dispatched));
      else if (message.method !== item.method) item.reject(failure('Codex 返回了不匹配的请求确认。', item.dispatched));
      else item.resolve(message);
    } else if (message.type === 'client-discovery-request') {
      this.write({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } });
    } else if (message.type === 'broadcast' && message.method === 'thread-stream-state-changed' && message.version === 11) {
      const { conversationId, hostId, change } = message.params ?? {};
      if (hostId !== 'local' || change?.type !== 'snapshot' || this.following.get(conversationId) !== message.sourceClientId) return;
      if (message.targetClientIds && !message.targetClientIds.includes(this.clientId)) return;
      const state = publicSubmissionState(change.conversationState);
      state.revision = change.revision;
      state.owner = message.sourceClientId;
      this.snapshots.set(conversationId, state);
      for (const waiter of this.snapshotWaiters) waiter.check();
    }
  }

  async discoverOwner(threadId, { timeoutMs = this.ownerTimeoutMs } = {}) {
    if (!UUID.test(threadId ?? '')) throw failure('继承对话 ID 无效。');
    await this.ready();
    const deadline = Date.now() + timeoutMs;
    do {
      try {
        const result = await this.request('thread-owner-discovery', { hostId: 'local', conversationId: threadId }, { timeoutMs: Math.min(1500, Math.max(1, deadline - Date.now())) });
        if (result.handledByClientId && result.result?.supportsUntrustedAppInput === true) return result.handledByClientId;
      } catch (error) {
        if (!/no-client-found|请求超时|及时确认|request-timeout/.test(error.message)) throw error;
      }
      if (Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(this.retryMs, deadline - Date.now())));
    } while (Date.now() < deadline);
    throw failure('VS Code 尚未接管新对话，继承提示词还未发送。请等待对话加载后重试。');
  }

  follow(threadId, owner, following) {
    if (following) { this.following.set(threadId, owner); this.snapshots.delete(threadId); }
    this.write({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1, sourceClientId: this.clientId, targetClientIds: [owner], params: { hostId: 'local', conversationId: threadId, following } });
    if (!following) { this.following.delete(threadId); this.snapshots.delete(threadId); }
  }

  waitSnapshot(threadId, owner, revision) {
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (error, state) => { clearTimeout(timer); this.snapshotWaiters.delete(waiter); error ? reject(error) : resolve(state); };
      const waiter = {
        reject: error => finish(error),
        check: () => {
          const state = this.snapshots.get(threadId);
          if (state?.owner === owner && state.revision >= revision) finish(null, state);
        },
      };
      timer = setTimeout(() => finish(failure('无法核实新对话的消息状态，继承提示词尚未发送。')), this.timeoutMs);
      this.snapshotWaiters.add(waiter);
      waiter.check();
    });
  }

  async readConversation(threadId, owner, { historyEmptyVerified = false, matchingPrompt } = {}) {
    const deadline = Date.now() + this.ownerTimeoutMs;
    this.follow(threadId, owner, true);
    for (;;) {
      try {
        const response = await this.request('thread-follower-load-complete-history', { conversationId: threadId }, {
          targetClientId: owner,
          timeoutMs: Math.min(this.timeoutMs, Math.max(1, deadline - Date.now())),
        });
        if (!Number.isInteger(response.result?.revision)) throw failure('Codex 没有确认完整对话状态。');
        return await this.waitSnapshot(threadId, owner, response.result.revision);
      } catch (error) {
        // Empty threads can have a loaded native writer while the extension
        // leaves its UI resumeState stale. Use the fresh owner snapshot only
        // when the backend independently verified the entire public history
        // is empty. A partial cached history alone cannot prove this.
        if (/must be resumed before loading history/i.test(error.message)) {
          const state = await this.waitSnapshot(threadId, owner, 0);
          if (matchingPrompt && state.turns.some(turn => turn.text === matchingPrompt)) return state;
          if (historyEmptyVerified && !state.pending && state.turns.length === 0) return state;
        }
        // The custom editor can claim ownership before its asynchronous
        // thread/resume finishes. These read-only requests are safe to retry.
        const transient = /must be resumed|not being streamed|no-client-found|became unavailable|Conversation .*not found|stream owner.*unavailable/i.test(error.message);
        if (!transient) throw error;
        if (Date.now() >= deadline) throw failure('VS Code 对话尚未完成加载，继承提示词还未发送。请等待加载后重试。');
        await new Promise(resolve => setTimeout(resolve, Math.min(this.retryMs, deadline - Date.now())));
        if (/no-client-found|became unavailable|stream owner.*unavailable/i.test(error.message)) {
          const replacement = await this.discoverOwner(threadId, { timeoutMs: Math.max(1, deadline - Date.now()) });
          if (replacement !== owner) {
            this.follow(threadId, owner, false);
            owner = replacement;
            this.follow(threadId, owner, true);
          }
        }
      }
    }
  }

  async submitInheritance(threadId, { prompt, settings = {}, submissionId, allowDispatch = true, historyEmptyVerified = false }) {
    if (!UUID.test(submissionId ?? '') || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 24000) throw failure('继承提示词或发送标识无效。');
    const key = threadId;
    const existing = this.submissions.get(key);
    if (existing) {
      if (existing.prompt !== prompt || existing.submissionId !== submissionId) throw failure('这个对话的继承提示词正在发送，请等待确认。');
      return existing.promise;
    }
    const promise = this.performSubmission(threadId, { prompt, settings, submissionId, allowDispatch, historyEmptyVerified });
    this.submissions.set(key, { prompt, submissionId, promise });
    try { return await promise; }
    finally { this.submissions.delete(key); }
  }

  async performSubmission(threadId, { prompt, settings, submissionId, allowDispatch, historyEmptyVerified }) {
    let owner;
    try {
      owner = await this.discoverOwner(threadId);
      const state = await this.readConversation(threadId, owner, { historyEmptyVerified, matchingPrompt: prompt });
      owner = state.owner;
      const existing = state.turns.find(turn => turn.text === prompt);
      if (existing) return { submitted: true, verified: true, reconciled: true, turnId: existing.turnId };
      if (allowDispatch === false) throw failure('发送结果仍未确认，已停止自动补发以避免重复，请先检查 VS Code。', true);
      if (state.pending || state.turns.some(turn => turn.submissionId === submissionId)) throw failure('对话中存在尚未确认或不匹配的发送，请检查对话后重试。', true);
      if (state.turns.some(turn => turn.text)) throw failure('新对话已有其他用户消息，已停止自动发送以避免重复。');
      const mode = typeof settings.collaborationMode === 'string' ? settings.collaborationMode : settings.collaborationMode?.mode;
      const collaborationMode = settings.model && ['default', 'plan'].includes(mode)
        ? { mode, settings: { model: settings.model, reasoning_effort: settings.reasoningEffort ?? null, developer_instructions: null } }
        : null;
      const request = {
        threadId,
        clientUserMessageId: submissionId,
        input: [{ type: 'text', text: prompt, text_elements: [] }],
        cwd: settings.cwd ?? null,
        approvalPolicy: 'never',
        permissions: ':danger-full-access',
        ...(settings.model ? { model: settings.model } : {}),
        ...(settings.reasoningEffort != null ? { effort: settings.reasoningEffort } : {}),
        ...(settings.serviceTier !== undefined ? { serviceTier: settings.serviceTier } : {}),
        ...(settings.summary !== undefined ? { summary: settings.summary } : {}),
        ...(collaborationMode ? { collaborationMode } : {}),
      };
      const response = await this.request('thread-follower-start-turn', {
        conversationId: threadId,
        turnStart: { request, context: { inheritThreadSettings: true, useAppServerPermissionDefault: false } },
      }, { targetClientId: owner, mutation: true });
      const result = response.result?.result;
      const turnId = result?.turn?.id;
      if (typeof turnId !== 'string' || !turnId) throw failure('Codex 已接收请求，但没有返回执行轮次；请检查对话后重试。', true);
      return { submitted: true, verified: true, turnId };
    } finally {
      if (owner && this.socket?.writable && this.following.has(threadId)) {
        try { this.follow(threadId, owner, false); } catch { /* Closing must not hide the submission result. */ }
      }
    }
  }

  close() {
    this.closed = true;
    this.disconnect(failure('Codex Board 已关闭。'));
  }
}
