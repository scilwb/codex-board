import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHandoff, HANDOFF_PROMPT_LIMIT } from '../server/handoff.mjs';

const thread = { id: '11111111-1111-4111-8111-111111111111', title: '夹爪调试', cwd: '/tmp/gripper' };
const line = (type, payload) => JSON.stringify({ timestamp: '2026-09-29T01:00:00.000Z', type, payload }) + '\n';

function withFile(t, contents) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-board-handoff-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'rollout.jsonl');
  writeFileSync(path, contents);
  return path;
}

test('handoff includes only public messages, deduplicates stored representations, and waits for a new instruction', async t => {
  const path = withFile(t, [
    line('session_meta', { id: thread.id }),
    line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '请检查夹爪关节限位' }] }),
    line('event_msg', { type: 'user_message', message: '请检查夹爪关节限位' }),
    line('event_msg', { type: 'task_started', turn_id: 'turn-1' }),
    line('response_item', { type: 'message', role: 'assistant', phase: 'analysis', content: [{ type: 'output_text', text: 'PRIVATE_ANALYSIS' }] }),
    line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'UNLABELLED_ASSISTANT' }] }),
    line('response_item', { type: 'message', role: 'system', content: [{ type: 'output_text', text: 'PRIVATE_SYSTEM' }] }),
    line('response_item', { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: '我先查看关节定义。' }] }),
    line('event_msg', { type: 'agent_message', phase: 'commentary', message: '我先查看关节定义。' }),
    line('response_item', { type: 'function_call_output', output: 'PRIVATE_TOOL_OUTPUT' }),
    line('response_item', { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '关节限位已核对。' }] }),
    line('event_msg', { type: 'agent_message', phase: 'final_answer', message: '关节限位已核对。' }),
    line('event_msg', { type: 'task_complete', last_agent_message: '关节限位已核对。' }),
  ].join(''));

  const handoff = await buildHandoff({ rolloutPath: path, thread });
  assert.deepEqual(handoff.source, thread);
  assert.equal(handoff.messageCount, 3);
  assert.equal(handoff.truncated, false);
  assert.equal(handoff.prompt.split('请检查夹爪关节限位').length - 1, 1);
  assert.equal(handoff.prompt.split('我先查看关节定义。').length - 1, 1);
  assert.equal(handoff.prompt.split('关节限位已核对。').length - 1, 1);
  for (const secret of ['PRIVATE_ANALYSIS', 'UNLABELLED_ASSISTANT', 'PRIVATE_SYSTEM', 'PRIVATE_TOOL_OUTPUT']) {
    assert.ok(!handoff.prompt.includes(secret), `${secret} must not appear`);
  }
  assert.match(handoff.prompt, /历史参考/);
  assert.match(handoff.prompt, /核实当前文件/);
  assert.match(handoff.prompt, /等待我的下一条指令/);
  assert.match(handoff.prompt, /不要自动继续旧任务/);
  assert.ok(handoff.prompt.includes(JSON.stringify(path)));
});

test('when the opening is unreadable, the earliest visible tail user message is clearly labelled as a fragment', async t => {
  const path = withFile(t,
    line('session_meta', { opaque: 'x'.repeat(80 * 1024) }) +
    line('response_item', { type: 'function_call_output', output: 'PRIVATE_MIDDLE'.repeat(100_000) }) +
    line('event_msg', { type: 'user_message', message: '尾部可读的新请求' }) +
    line('event_msg', { type: 'agent_message', phase: 'commentary', message: '正在检查现状。' }));
  const handoff = await buildHandoff({ rolloutPath: path, thread });
  assert.equal(handoff.messageCount, 2);
  assert.equal(handoff.truncated, true);
  assert.match(handoff.prompt, /最早可读的用户片段（来源开头可能不完整）/);
  assert.match(handoff.prompt, /尾部可读的新请求/);
  assert.match(handoff.prompt, /正在检查现状/);
  assert.ok(!handoff.prompt.includes('PRIVATE_MIDDLE'));
});

test('environment wrappers in user-role records do not replace the real IDE request', async t => {
  const path = withFile(t, [
    line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /tmp/gripper\nAUTOMATIC_AGENT_RULES' }] }),
    line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<recommended_plugins>auto</recommended_plugins>\n<environment_context>auto</environment_context>' }] }),
    line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# Context from my IDE setup:\n\n## My request:\n检查夹爪设计' }] }),
    line('event_msg', { type: 'user_message', message: '# Context from my IDE setup:\n\n## My request:\n检查夹爪设计' }),
    line('event_msg', { type: 'agent_message', phase: 'final_answer', message: '已看到请求。' }),
  ].join(''));
  const handoff = await buildHandoff({ rolloutPath: path, thread });
  assert.equal(handoff.messageCount, 2);
  assert.match(handoff.prompt, /## 开头用户目标/);
  assert.match(handoff.prompt, /检查夹爪设计/);
  assert.ok(!handoff.prompt.includes('AUTOMATIC_AGENT_RULES'));
  assert.ok(!handoff.prompt.includes('<environment_context>'));
});

test('a wrapper followed by an explicit user request remains eligible', async t => {
  const path = withFile(t, line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>auto</environment_context>\n## My request:\n请看当前文件' }] }));
  const handoff = await buildHandoff({ rolloutPath: path, thread });
  assert.equal(handoff.messageCount, 1);
  assert.match(handoff.prompt, /请看当前文件/);
});

test('long public history stays under the prompt limit and retains the latest request', async t => {
  const rows = [line('event_msg', { type: 'user_message', message: '开头目标：' + '甲'.repeat(30_000) })];
  for (let i = 0; i < 18; i++) {
    rows.push(line('event_msg', { type: 'agent_message', phase: 'commentary', message: `进度 ${i}：` + '乙'.repeat(2_000) }));
  }
  rows.push(line('event_msg', { type: 'user_message', message: '最后的用户请求：请只等待下一步' }));
  for (let i = 0; i < 14; i++) {
    rows.push(line('event_msg', { type: 'agent_message', phase: 'commentary', message: `后续进度 ${i}：` + '丙'.repeat(2_000) }));
  }
  rows.push(line('event_msg', { type: 'agent_message', phase: 'final_answer', message: '已收到最后请求。' }));
  const handoff = await buildHandoff({ rolloutPath: withFile(t, rows.join('')), thread });
  assert.ok(handoff.prompt.length <= HANDOFF_PROMPT_LIMIT);
  assert.equal(handoff.truncated, true);
  assert.match(handoff.prompt, /最后的用户请求：请只等待下一步/);
  assert.match(handoff.prompt, /已收到最后请求/);
  assert.ok(handoff.messageCount <= 11);
});

test('repeated inheritance labels the earlier handoff and preserves the latest real user request', async t => {
  const inheritedThread = { ...thread, inheritedFromId: '22222222-2222-4222-8222-222222222222' };
  const rows = [line('event_msg', { type: 'user_message', message: '【独立新对话的历史交接资料】\n旧交接资料：' + '甲'.repeat(8_000) })];
  rows.push(line('event_msg', { type: 'user_message', message: '本轮真正请求：继续检查当前夹爪文件' }));
  for (let i = 0; i < 14; i++) {
    rows.push(line('event_msg', { type: 'agent_message', phase: 'commentary', message: `新的过程回复 ${i}：` + '乙'.repeat(2_000) }));
  }
  rows.push(line('event_msg', { type: 'agent_message', phase: 'final_answer', message: '本轮已结束。' }));
  const handoff = await buildHandoff({ rolloutPath: withFile(t, rows.join('')), thread: inheritedThread });
  assert.deepEqual(handoff.source, thread);
  assert.ok(handoff.prompt.length <= HANDOFF_PROMPT_LIMIT);
  assert.match(handoff.prompt, /## 之前载入的交接资料（节选）/);
  assert.ok(!handoff.prompt.includes('## 开头用户目标'));
  assert.match(handoff.prompt, /本轮真正请求：继续检查当前夹爪文件/);
  assert.match(handoff.prompt, /本轮已结束/);
  assert.equal(handoff.truncated, true);
});

test('a trailing head cut does not make an already readable opening goal uncertain', async t => {
  const path = withFile(t,
    line('event_msg', { type: 'user_message', message: '真正的开头目标' }) +
    line('response_item', { type: 'function_call_output', output: 'x'.repeat(900_000) }) +
    line('event_msg', { type: 'agent_message', phase: 'final_answer', message: '最近答复' }));
  const handoff = await buildHandoff({ rolloutPath: path, thread });
  assert.equal(handoff.truncated, true);
  assert.match(handoff.prompt, /## 开头用户目标/);
  assert.match(handoff.prompt, /真正的开头目标/);
  assert.match(handoff.prompt, /最近答复/);
});

test('missing, empty, and private-only histories fail without inventing a handoff', async t => {
  const empty = withFile(t, '');
  await assert.rejects(buildHandoff({ rolloutPath: empty, thread }), /历史为空/);
  await assert.rejects(buildHandoff({ rolloutPath: `${empty}.missing`, thread }), /不可读取/);
  const privateOnly = withFile(t,
    line('response_item', { type: 'message', role: 'assistant', phase: 'analysis', content: [{ type: 'output_text', text: 'private' }] }) +
    line('response_item', { type: 'function_call_output', output: 'tool output' }));
  await assert.rejects(buildHandoff({ rolloutPath: privateOnly, thread }), /没有可读取的公开消息/);
});

test('a private or incomplete trailing record does not leak into the handoff', async t => {
  const path = withFile(t,
    line('event_msg', { type: 'user_message', message: '只保留这条公开消息' }) +
    '{"type":"response_item","payload":{"type":"message","role":"assistant","phase":"analysis","content":"PRIVATE_PARTIAL');
  const handoff = await buildHandoff({ rolloutPath: path, thread });
  assert.equal(handoff.messageCount, 1);
  assert.equal(handoff.truncated, true);
  assert.match(handoff.prompt, /只保留这条公开消息/);
  assert.ok(!handoff.prompt.includes('PRIVATE_PARTIAL'));
});


test('handoff strips automatic environment text while keeping the request after a complete wrapper', async t => {
  const path = withFile(t,
    line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text',
      text: '<environment_context>PRIVATE_ENV_CONTEXT</environment_context>\n## My request:\nContinue test' }] }));
  const handoff = await buildHandoff({ rolloutPath: path, thread });
  assert.match(handoff.prompt, /Continue test/);
  assert.doesNotMatch(handoff.prompt, /PRIVATE_ENV_CONTEXT|<environment_context>/);
});

test('handoff fails closed on an unfinished automatic wrapper even if it contains a request marker', async t => {
  const path = withFile(t,
    line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text',
      text: '<environment_context>PRIVATE_ENV_CONTEXT\n## My request:\nFAKE_REQUEST' }] }) +
    line('event_msg', { type: 'user_message', message: 'Actual request' }));
  const handoff = await buildHandoff({ rolloutPath: path, thread });
  assert.match(handoff.prompt, /Actual request/);
  assert.doesNotMatch(handoff.prompt, /PRIVATE_ENV_CONTEXT|FAKE_REQUEST/);
});

test('handoff ignores an old turn completion recorded after a newer turn began', async t => {
  const path = withFile(t,
    line('event_msg', { type: 'user_message', message: 'Opening request' }) +
    line('event_msg', { type: 'task_started', turn_id: 'old' }) +
    line('event_msg', { type: 'task_started', turn_id: 'new' }) +
    line('event_msg', { type: 'task_complete', turn_id: 'old', last_agent_message: 'STALE_OLD_ANSWER' }) +
    line('event_msg', { type: 'task_complete', turn_id: 'new', last_agent_message: 'Current answer' }));
  const handoff = await buildHandoff({ rolloutPath: path, thread });
  assert.match(handoff.prompt, /Current answer/);
  assert.doesNotMatch(handoff.prompt, /STALE_OLD_ANSWER/);
});
