import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { CodexIpcClient, publicSubmissionState } from './codex-ipc.mjs';

const THREAD = '01234567-89ab-cdef-0123-456789abcdef';
const OWNER = 'owner-client';
const text = value => [{ type: 'text', text: value, text_elements: [] }];

async function nativeFixture(t, { state = { turns: [] }, dropStartAck = false, ownerAvailable = true, timeoutMs = 1000, unresumedReads = 0, onHistoryRead, ignoreSettingsUpdate = false, rejectSettingsUpdate = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-board-ipc-'));
  const endpoint = join(dir, 'ipc.sock');
  const sockets = new Set();
  const starts = [];
  const requests = [];
  let revision = 0;
  let historyReads = 0;
  const server = createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    function write(value) {
      const body = Buffer.from(JSON.stringify(value));
      const frame = Buffer.alloc(body.length + 4);
      frame.writeUInt32LE(body.length);
      body.copy(frame, 4);
      // Multibyte JSON and a fragmented header/body exercise the actual wire.
      socket.write(frame.subarray(0, 2));
      socket.write(frame.subarray(2, 11));
      socket.write(frame.subarray(11));
    }
    function snapshot() {
      write({ type: 'broadcast', version: 11, method: 'thread-stream-state-changed', sourceClientId: OWNER,
        targetClientIds: ['board-client'], params: { hostId: 'local', conversationId: THREAD, change: { type: 'snapshot', revision: ++revision, conversationState: state } } });
    }
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = buffer.readUInt32LE();
        if (buffer.length < size + 4) return;
        const message = JSON.parse(buffer.subarray(4, size + 4).toString());
        buffer = buffer.subarray(size + 4);
        if (message.type === 'broadcast') {
          if (message.params.following) snapshot();
          continue;
        }
        requests.push(message);
        const response = { type: 'response', requestId: message.requestId, resultType: 'success', method: message.method, handledByClientId: OWNER };
        if (message.method === 'initialize') response.result = { clientId: 'board-client' };
        else if (message.method === 'thread-owner-discovery') {
          if (!ownerAvailable) { response.resultType = 'error'; response.error = 'no-client-found'; }
          else response.result = { supportsUntrustedAppInput: true };
        } else if (message.method === 'thread-follower-load-complete-history') {
          if (unresumedReads-- > 0) { response.resultType = 'error'; response.error = 'Conversation must be resumed before loading history'; }
          else { onHistoryRead?.(state, ++historyReads); snapshot(); response.result = { revision }; }
        } else if (message.method === 'thread-follower-update-thread-settings') {
          if (rejectSettingsUpdate) { response.resultType = 'error'; response.error = 'unsupported-settings'; }
          else {
            const settings = message.params.threadSettings;
            if (!ignoreSettingsUpdate) {
              state.latestThreadSettings = { ...state.latestThreadSettings, ...settings };
              // Current Codex snapshots expose the permission profile ID,
              // while the request accepts the permissions string.
              delete state.latestThreadSettings.permissions;
              state.latestThreadSettings.activePermissionProfile = { id: settings.permissions };
              if (settings.model) state.latestModel = settings.model;
              if (settings.effort !== undefined) state.latestReasoningEffort = settings.effort;
              if (settings.collaborationMode) state.latestCollaborationMode = settings.collaborationMode;
              else if (state.latestCollaborationMode) {
                state.latestCollaborationMode = { ...state.latestCollaborationMode, settings: {
                  ...state.latestCollaborationMode.settings,
                  model: settings.model ?? state.latestCollaborationMode.settings.model,
                  reasoning_effort: settings.effort !== undefined ? settings.effort : state.latestCollaborationMode.settings.reasoning_effort,
                } };
              }
              if (state.latestCollaborationMode) state.latestThreadSettings.collaborationMode = state.latestCollaborationMode;
            }
            response.result = { applied: true };
          }
        } else if (message.method === 'thread-follower-start-turn') {
          starts.push(message.params.turnStart);
          const request = message.params.turnStart.request;
          state.turns = [{ turnId: 'native-turn-1', status: 'inProgress', params: request, items: [] }];
          response.result = { result: { turn: { id: 'native-turn-1', status: 'inProgress' } } };
          if (dropStartAck) continue;
        } else throw Error(`Unexpected method ${message.method}`);
        write(response);
      }
    });
  });
  await new Promise(resolve => server.listen(endpoint, resolve));
  const client = new CodexIpcClient({ endpoint, timeoutMs, ownerTimeoutMs: 100, retryMs: 5 });
  t.after(async () => { client.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  return { client, starts, requests, state };
}

test('inheritance sends a visible native turn through its VS Code owner with source model and full access', async t => {
  const { client, starts, requests } = await nativeFixture(t, { state: { turns: [{ turnId: null, status: 'completed', items: [{ type: 'reasoning', text: 'private data' }] }] } });
  const submissionId = randomUUID();
  const settings = { cwd: '/workspace', model: 'gpt-6.1-sol', reasoningEffort: 'ultra', collaborationMode: 'plan', serviceTier: 'priority', summary: 'detailed' };
  const result = await client.submitInheritance(THREAD, { prompt: '请读取关键路径并继续任务。', settings, submissionId });
  assert.deepEqual(result, { submitted: true, verified: true, turnId: 'native-turn-1' });
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0], {
    request: { threadId: THREAD, clientUserMessageId: submissionId, input: text('请读取关键路径并继续任务。'), cwd: '/workspace', approvalPolicy: 'never', permissions: ':danger-full-access', model: 'gpt-6.1-sol', effort: 'ultra', serviceTier: 'priority', summary: 'detailed', collaborationMode: { mode: 'plan', settings: { model: 'gpt-6.1-sol', reasoning_effort: 'ultra', developer_instructions: null } } },
    context: { inheritThreadSettings: false, useAppServerPermissionDefault: false },
  });
  const start = requests.find(item => item.method === 'thread-follower-start-turn');
  assert.equal(start.version, 2);
  assert.equal(start.targetClientId, OWNER);
  assert.equal(Object.hasOwn(start, 'hostId'), false);
  assert.equal(client.snapshots.size, 0);
});

test('a confirmed public prompt reconciles a retry without submitting twice', async t => {
  const { client, starts } = await nativeFixture(t, { state: { turns: [{ turnId: 'already-sent', params: { input: text('交接提示词') }, status: 'completed' }] } });
  assert.deepEqual(await client.submitInheritance(THREAD, { prompt: '交接提示词', submissionId: randomUUID() }), { submitted: true, verified: true, reconciled: true, turnId: 'already-sent' });
  assert.equal(starts.length, 0);
});

test('another user message or pending native admission prevents inheritance submission', async t => {
  for (const state of [
    { turns: [{ turnId: 'another-turn', params: { input: text('其他用户输入') } }] },
    { turns: [{ turnId: null, status: 'inProgress', params: { input: text('交接提示词') } }] },
    { turns: [], unconfirmedTurnSubmissions: [{ requestId: 'in-flight' }] },
  ]) {
    const { client, starts } = await nativeFixture(t, { state });
    await assert.rejects(client.submitInheritance(THREAD, { prompt: '交接提示词', submissionId: randomUUID() }), /已有其他用户消息|尚未确认/);
    assert.equal(starts.length, 0);
  }
});

test('a lost native acknowledgement is marked uncertain and a later retry reads the actual turn first', async t => {
  const { client, starts } = await nativeFixture(t, { dropStartAck: true, timeoutMs: 60 });
  const submission = { prompt: '继续之前的任务', submissionId: randomUUID() };
  await assert.rejects(client.submitInheritance(THREAD, submission), error => error.dispatched === true);
  const result = await client.submitInheritance(THREAD, submission);
  assert.equal(result.reconciled, true);
  assert.equal(result.turnId, 'native-turn-1');
  assert.equal(starts.length, 1);
});

test('concurrent clicks share one submission and changing its contents is rejected', async t => {
  const { client, starts } = await nativeFixture(t);
  const submission = { prompt: '同一次继承', submissionId: randomUUID() };
  const first = client.submitInheritance(THREAD, submission);
  const second = client.submitInheritance(THREAD, submission);
  await assert.rejects(client.submitInheritance(THREAD, { ...submission, prompt: '更换内容' }), /正在发送/);
  const results = await Promise.all([first, second]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(starts.length, 1);
});

test('an uncertain persisted receipt only reconciles and never sends into an empty reconnected UI', async t => {
  const { client, starts, state } = await nativeFixture(t);
  const submission = { prompt: '继承提示词', submissionId: randomUUID(), allowDispatch: false };
  await assert.rejects(client.submitInheritance(THREAD, submission), error => error.dispatched === true && /停止自动补发/.test(error.message));
  assert.equal(starts.length, 0);
  state.turns = [{ turnId: 'persisted-turn', params: { input: text(submission.prompt) }, status: 'completed' }];
  assert.deepEqual(await client.submitInheritance(THREAD, submission), { submitted: true, verified: true, reconciled: true, turnId: 'persisted-turn' });
  assert.equal(starts.length, 0);
});

test('a missing native owner fails before any model request is dispatched', async t => {
  const { client, starts } = await nativeFixture(t, { ownerAvailable: false });
  await assert.rejects(client.submitInheritance(THREAD, { prompt: '交接提示词', submissionId: randomUUID() }), error => error.dispatched === false && /尚未接管/.test(error.message));
  assert.equal(starts.length, 0);
});

test('ownership before native resume completes retries history safely before submitting', async t => {
  const { client, starts, requests } = await nativeFixture(t, { unresumedReads: 2 });
  const result = await client.submitInheritance(THREAD, { prompt: '等待恢复后继承', submissionId: randomUUID() });
  assert.equal(result.submitted, true);
  assert.equal(starts.length, 1);
  const methods = requests.map(item => item.method);
  assert.equal(methods.filter(method => method === 'thread-follower-load-complete-history').length, 4);
  assert.equal(methods.at(-1), 'thread-follower-start-turn');
});

test('a stale empty UI resume state needs independent complete empty public-history proof', async t => {
  const { client, starts, requests } = await nativeFixture(t, { unresumedReads: 100 });
  const submission = { prompt: '空对话继承', submissionId: randomUUID() };
  await assert.rejects(client.submitInheritance(THREAD, submission), error => error.dispatched === false && /尚未完成加载/.test(error.message));
  assert.equal(starts.length, 0);
  const result = await client.submitInheritance(THREAD, { ...submission, historyEmptyVerified: true });
  assert.equal(result.submitted, true);
  assert.equal(starts.length, 1);
  assert.equal(requests.at(-1).method, 'thread-follower-start-turn');
});

test('fresh empty-history proof still cannot resend a persisted uncertain submission', async t => {
  const { client, starts } = await nativeFixture(t, { unresumedReads: 100 });
  await assert.rejects(client.submitInheritance(THREAD, { prompt: '未知发送结果', submissionId: randomUUID(), historyEmptyVerified: true, allowDispatch: false }), error => error.dispatched === true && /停止自动补发/.test(error.message));
  assert.equal(starts.length, 0);
});

test('an actual matching turn in a fresh owner snapshot reconciles even if UI resume state remains stale', async t => {
  const { client, starts } = await nativeFixture(t, { unresumedReads: 100, state: { turns: [{ turnId: 'confirmed-visible-turn', params: { input: text('继承提示词') }, status: 'inProgress' }], threadRuntimeStatus: { type: 'active' } } });
  const result = await client.submitInheritance(THREAD, { prompt: '继承提示词', submissionId: randomUUID(), allowDispatch: false });
  assert.deepEqual(result, { submitted: true, verified: true, reconciled: true, turnId: 'confirmed-visible-turn' });
  assert.equal(starts.length, 0);
});

test('canonical history projection contains only real public user turns', () => {
  const publicState = publicSubmissionState({ turnHistory: { kind: 'canonical', history: { entitiesByKey: {
    injected: { turnId: null, status: 'completed', params: { input: text('hidden injection') } },
    actual: { turnId: 'native-1', status: 'completed', params: { clientUserMessageId: 'submission-1' }, items: [{ type: 'userMessage', content: text('用户输入') }, { type: 'reasoning', text: 'private reasoning' }, { type: 'agentMessage', text: 'output' }] },
    duplicate: { turnId: 'native-1', params: { input: text('duplicate') } },
  } } }, developerInstructions: 'private instructions' });
  assert.deepEqual(publicState, { revision: 0, pending: false, turns: [{ turnId: 'native-1', status: 'completed', submissionId: 'submission-1', text: '用户输入' }] });
  assert.equal(JSON.stringify(publicState).includes('private'), false);
});

test('explicit repair can add a visible correction to an idle occupied thread with source settings', async t => {
  const { client, starts, state } = await nativeFixture(t, { state: { turns: [{ turnId: 'wax-turn', params: { input: text('WAX提问') }, status: 'completed' }] } });
  await assert.rejects(client.submitInheritance(THREAD, { prompt: 'UMI交接', submissionId: randomUUID() }), error => error.requiresRepair === true && error.dispatched === false);
  assert.equal(starts.length, 0);
  const sourceThreadId = '11111111-1111-4111-8111-111111111111';
  const result = await client.submitRepair(THREAD, { sourceThreadId, prompt: 'UMI更正交接', submissionId: randomUUID(), settings: { model: 'gpt-6-astra', reasoningEffort: 'max' } });
  assert.equal(result.submitted, true);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].request.threadId, THREAD);
  assert.equal(starts[0].request.model, 'gpt-6-astra');
  assert.equal(starts[0].request.effort, 'max');
  assert.deepEqual(starts[0].request.input, text('UMI更正交接'));
  assert.equal(starts[0].request.permissions, ':danger-full-access');
});

test('source without a mode replaces a target collaboration model before the first visible turn', async t => {
  const state = { turns: [], latestModel: 'gpt-6.1-sol', latestReasoningEffort: 'medium',
    latestCollaborationMode: { mode: 'default', settings: { model: 'gpt-6.1-sol', reasoning_effort: 'medium', developer_instructions: 'private-mode-data' } },
  };
  const { client, starts, requests } = await nativeFixture(t, { state });
  await client.submitInheritance(THREAD, { prompt: 'UMI继承确认', submissionId: randomUUID(), settings: { model: 'gpt-6-astra', reasoningEffort: 'max' } });
  const update = requests.find(item => item.method === 'thread-follower-update-thread-settings');
  assert.equal(update.version, 2);
  assert.equal(update.targetClientId, OWNER);
  assert.equal(state.latestCollaborationMode.settings.model, 'gpt-6-astra');
  assert.equal(state.latestCollaborationMode.settings.reasoning_effort, 'max');
  assert.equal(starts[0].context.inheritThreadSettings, false);
  const effectiveMode = starts[0].request.collaborationMode ?? (starts[0].context.inheritThreadSettings ? state.latestCollaborationMode : null);
  assert.equal(effectiveMode?.settings.model ?? starts[0].request.model, 'gpt-6-astra');
  const projected = publicSubmissionState(state);
  assert.equal(projected.settings.model, 'gpt-6-astra');
  assert.equal(projected.settings.approvalPolicy, 'never');
  assert.equal(JSON.stringify(projected).includes('private-mode-data'), false);
});

test('acknowledged but unapplied source settings and unsupported metadata fail before a visible turn', async t => {
  for (const behavior of [{ ignoreSettingsUpdate: true }, { rejectSettingsUpdate: true }]) {
    const { client, starts } = await nativeFixture(t, { ...behavior, state: { turns: [], latestModel: 'gpt-6.1-sol', latestReasoningEffort: 'medium' } });
    await assert.rejects(client.submitInheritance(THREAD, { prompt: '不能假报继承成功', submissionId: randomUUID(), settings: { model: 'gpt-6-astra', reasoningEffort: 'max' } }), error => error.dispatched === false);
    assert.equal(starts.length, 0);
  }
});

test('repair waits for an active conversation and rejects history changed between its two checks', async t => {
  const sourceThreadId = '11111111-1111-4111-8111-111111111111';
  const busy = await nativeFixture(t, { state: { turns: [], threadRuntimeStatus: { type: 'active' } } });
  await assert.rejects(busy.client.submitRepair(THREAD, { sourceThreadId, prompt: '修复', submissionId: randomUUID() }), error => error.dispatched === false);
  assert.equal(busy.starts.length, 0);
  const changed = await nativeFixture(t, { state: { turns: [{ turnId: 'old', params: { input: text('旧消息') }, status: 'completed' }] }, onHistoryRead(state, count) {
    if (count === 2) state.turns.push({ turnId: 'new', params: { input: text('刚刚的新输入') }, status: 'completed' });
  } });
  await assert.rejects(changed.client.submitRepair(THREAD, { sourceThreadId, prompt: '修复', submissionId: randomUUID() }), /内容发生变化/);
  assert.equal(changed.starts.length, 0);
});

test('repair with a lost acknowledgement only reconciles the same visible correction', async t => {
  const { client, starts } = await nativeFixture(t, { dropStartAck: true, timeoutMs: 40, state: { turns: [{ turnId: 'old', params: { input: text('旧输入') }, status: 'completed' }] } });
  const params = { sourceThreadId: '11111111-1111-4111-8111-111111111111', prompt: '来源更正', submissionId: randomUUID() };
  await assert.rejects(client.submitRepair(THREAD, params), error => error.dispatched === true);
  const result = await client.submitRepair(THREAD, { ...params, allowDispatch: false });
  assert.equal(result.reconciled, true);
  assert.equal(starts.length, 1);
});
