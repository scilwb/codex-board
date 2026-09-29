import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACTIVITY_TTL, READ_LIMIT, RolloutMonitor, recentReplies } from '../server/activity.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-board-activity-'));
  const path = join(directory, 'rollout.jsonl');
  let now = Date.UTC(2026, 8, 28, 12);
  const monitor = new RolloutMonitor({ now: () => now });
  writeFileSync(path, '');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return {
    path, monitor,
    tick(ms = 1000) { now += ms; },
    entry(type, payload) { return { timestamp: new Date(now).toISOString(), type, payload }; },
    append(...records) { appendFileSync(path, records.map(record => JSON.stringify(record)).join('\n') + '\n'); },
    read() { return monitor.read(path); },
  };
}
const event = (f, type, values = {}) => f.entry('event_msg', { type, ...values });
const response = (f, text, values = {}) => f.entry('response_item', { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text }], ...values });
const call = (f, name, callId) => f.entry('response_item', { type: 'function_call', name, call_id: callId, arguments: JSON.stringify({ questions: [{ title: 'Synthetic question', options: [] }] }) });
const output = (f, callId, value) => f.entry('response_item', { type: 'function_call_output', call_id: callId, output: JSON.stringify(value) });
const modern = (f, item) => event(f, 'item_completed', { item });

test('活动：明确开始与结束、旧回合隔离，final_answer 本身不是结束', t => {
  const f = fixture(t);
  f.append(f.entry('session_meta', { forked_from_id: 'parent', git: { branch: 'work' } }), event(f, 'task_started', { turn_id: 'turn-1' }));
  assert.equal(f.read().activity.status, 'active');
  assert.equal(f.read().forkedFromId, 'parent');
  assert.equal(f.read().gitBranch, 'work');
  f.append(response(f, 'A visible final phase', { phase: 'final_answer' }));
  assert.equal(f.read().activity.status, 'active');
  assert.equal(f.read().lastMessage, 'A visible final phase');
  f.append(event(f, 'task_started', { turn_id: 'turn-2' }), event(f, 'task_complete', { turn_id: 'turn-1', last_agent_message: 'Late old result' }));
  assert.equal(f.read().activity.status, 'active');
  assert.equal(f.read().activity.turnId, 'turn-2');
  assert.notEqual(f.read().lastMessage, 'Late old result');
  f.append(event(f, 'task_complete', { turn_id: 'turn-2', last_agent_message: 'Current result' }));
  assert.equal(f.read().activity.status, 'completed');
  assert.equal(f.read().lastMessage, 'Current result');
  f.tick(ACTIVITY_TTL + 1);
  assert.equal(f.read().activity.status, 'completed');
});

test('活动：中断有明确状态且不会误报完成', t => {
  const f = fixture(t);
  f.append(event(f, 'task_started', { turn_id: 'turn' }), event(f, 'turn_aborted', { turn_id: 'turn', reason: 'interrupted' }));
  assert.equal(f.read().activity.status, 'interrupted');
  f.tick(ACTIVITY_TTL + 1);
  assert.equal(f.read().activity.status, 'interrupted');
});

test('提问：同步回答按 call_id 匹配，多问题逐项解除', t => {
  const f = fixture(t);
  f.append(event(f, 'task_started', { turn_id: 'turn' }), call(f, 'functions.request_user_input', 'first'), call(f, 'request_user_input', 'second'));
  const waiting = f.read().activity;
  assert.equal(waiting.status, 'waiting');
  f.append(output(f, 'unrelated', { answers: { q: { answers: ['yes'] } } }));
  assert.equal(f.read().activity.status, 'waiting');
  f.append(output(f, 'first', { answers: { q: { answers: ['yes'] } } }));
  assert.equal(f.read().activity.status, 'waiting');
  f.append(output(f, 'second', { answers: { q: { answers: ['yes'] } } }));
  assert.equal(f.read().activity.status, 'active');
});

test('提问：async accepted 只确认展示，后续活动和本轮结束保持待处理标识', t => {
  const f = fixture(t);
  f.append(event(f, 'task_started', { turn_id: 'turn' }), call(f, 'request_user_input_async', 'question'));
  const key = f.read().activity.eventKey;
  f.tick();
  f.append(output(f, 'question', { accepted: true }), modern(f, { type: 'AgentMessage', id: 'display-question', phase: 'final_answer', delivery: 'async', questions: [{ title: 'Synthetic question', options: [] }], content: [{ type: 'Text', text: 'Synthetic question' }] }));
  assert.equal(f.read().activity.status, 'waiting');
  assert.equal(f.read().activity.eventKey, key);
  f.tick();
  f.append(event(f, 'token_count'), response(f, 'Continue independent work'));
  assert.equal(f.read().activity.status, 'waiting');
  assert.equal(f.read().activity.eventKey, key);
  f.append(event(f, 'task_complete', { turn_id: 'turn' }));
  assert.equal(f.read().activity.status, 'waiting');
  assert.equal(f.read().activity.eventKey, key);
  assert.match(f.read().activity.reason, /本轮已结束/);
  f.append(modern(f, { type: 'UserMessage', id: 'answer', client_id: 'client', content: [{ type: 'text', text: 'Synthetic answer', text_elements: [] }] }));
  assert.equal(f.read().activity.status, 'unknown');
  assert.equal(f.read().lastMessage, 'Synthetic answer');
  f.append(event(f, 'task_started', { turn_id: 'next-turn' }));
  assert.equal(f.read().activity.status, 'active');
});

test('提问：仅现代 questions 项也能识别，response_item 用户回复解除提示', t => {
  const f = fixture(t);
  f.append(event(f, 'task_started', { turn_id: 'turn' }), modern(f, { type: 'AgentMessage', id: 'question', phase: 'final_answer', delivery: 'async', questions: [{ title: 'Synthetic question' }], content: [{ type: 'Text', text: 'Synthetic question' }] }));
  assert.equal(f.read().activity.status, 'waiting');
  f.append(f.entry('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic answer' }] }));
  assert.equal(f.read().activity.status, 'active');
});

test('活动：超时在未写日志时仍降为未知，新记录恢复且等待事件标识稳定', t => {
  const f = fixture(t);
  f.append(event(f, 'task_started', { turn_id: 'turn' }), call(f, 'request_user_input_async', 'question'));
  const key = f.read().activity.eventKey;
  f.tick(ACTIVITY_TTL + 1);
  assert.equal(f.read().activity.status, 'unknown');
  assert.equal(f.read().activity.stale, true);
  f.append(event(f, 'token_count'));
  assert.equal(f.read().activity.status, 'waiting');
  assert.equal(f.read().activity.stale, false);
  assert.equal(f.read().activity.eventKey, key);
});

test('增量读取：半行及 UTF-8 字符拆分直到换行才消费', t => {
  const f = fixture(t);
  f.append(event(f, 'task_started', { turn_id: 'turn' }), response(f, 'Before append'));
  f.read();
  const bytes = Buffer.from(JSON.stringify(response(f, '你好，完整回复')) + '\n');
  const split = bytes.indexOf(Buffer.from('你好')) + 1;
  appendFileSync(f.path, bytes.subarray(0, split));
  assert.equal(f.read().lastMessage, 'Before append');
  appendFileSync(f.path, bytes.subarray(split, bytes.length - 1));
  assert.equal(f.read().lastMessage, 'Before append');
  appendFileSync(f.path, '\n');
  assert.equal(f.read().lastMessage, '你好，完整回复');
});

test('增量读取：缩短及路径轮换清除之前的状态', t => {
  const f = fixture(t);
  f.append(event(f, 'task_started', { turn_id: 'old-turn' }), call(f, 'request_user_input_async', 'question'), response(f, 'Old message'));
  assert.equal(f.read().activity.status, 'waiting');
  writeFileSync(f.path, JSON.stringify(event(f, 'task_started', { turn_id: 'short' })) + '\n');
  assert.equal(f.read().activity.status, 'active');
  assert.equal(f.read().activity.turnId, 'short');
  assert.equal(f.read().lastMessage, '');
  renameSync(f.path, f.path + '.previous');
  writeFileSync(f.path, JSON.stringify(event(f, 'task_complete', { turn_id: 'replacement', last_agent_message: 'Replacement result' })) + '\n');
  assert.equal(f.read().activity.status, 'completed');
  assert.equal(f.read().activity.turnId, 'replacement');
  assert.equal(f.read().lastMessage, 'Replacement result');
});

test('增量读取：超大历史及跨多次读取的超大单行均可恢复后续明确事件', t => {
  const f = fixture(t);
  f.append(f.entry('session_meta', { forked_from_id: 'parent' }), event(f, 'task_started', { turn_id: 'old' }));
  f.read();
  appendFileSync(f.path, JSON.stringify(f.entry('response_item', { type: 'reasoning', raw_content: 'x'.repeat(READ_LIMIT * 2) })) + '\n');
  f.append(event(f, 'task_started', { turn_id: 'after-gap' }));
  assert.equal(f.read().activity.status, 'active');
  assert.equal(f.read().activity.turnId, 'after-gap');
  assert.equal(f.read().forkedFromId, 'parent');
  const oversized = Buffer.from(JSON.stringify(f.entry('response_item', { type: 'reasoning', raw_content: 'x'.repeat(READ_LIMIT * 2) })) + '\n');
  for (let i = 0; i < oversized.length; i += Math.floor(READ_LIMIT / 2)) {
    appendFileSync(f.path, oversized.subarray(i, i + Math.floor(READ_LIMIT / 2)));
    f.read();
  }
  f.append(event(f, 'task_complete', { turn_id: 'after-gap', last_agent_message: 'Recovered result' }));
  assert.equal(f.read().activity.status, 'completed');
  assert.equal(f.read().lastMessage, 'Recovered result');
});

test('隐私：预览与回复详情仅包含用户可见消息，排除 reasoning、analysis 和工具输出', async t => {
  const f = fixture(t);
  f.append(event(f, 'task_started', { turn_id: 'turn' }), response(f, 'Visible reply'),
    response(f, 'PRIVATE_ANALYSIS', { phase: 'analysis' }),
    f.entry('response_item', { type: 'reasoning', summary: [{ text: 'PRIVATE_REASONING' }], encrypted_content: 'PRIVATE_ENCRYPTED' }),
    modern(f, { type: 'Reasoning', id: 'reasoning', raw_content: ['PRIVATE_RAW'], summary_text: ['PRIVATE_SUMMARY'] }),
    modern(f, { type: 'AgentMessage', id: 'analysis', phase: 'analysis', content: [{ type: 'Text', text: 'PRIVATE_MODERN_ANALYSIS' }] }),
    output(f, 'tool', { text: 'PRIVATE_TOOL_OUTPUT' }),
    f.entry('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'PRIVATE_DEVELOPER' }] }));
  assert.equal(f.read().lastMessage, 'Visible reply');
  const replies = await recentReplies(f.path);
  assert.deepEqual(replies.replies.map(item => item.text), ['Visible reply']);
  assert.doesNotMatch(JSON.stringify(replies), /PRIVATE_/);
});

test('回复：同一回复的多种记录去重，跨轮相同内容保留', async t => {
  const f = fixture(t);
  f.append(event(f, 'task_started', { turn_id: 'first' }), response(f, 'Repeated visible reply', { id: 'message-first', phase: 'final_answer' }),
    event(f, 'agent_message', { message: 'Repeated visible reply', phase: 'final_answer' }),
    modern(f, { type: 'AgentMessage', id: 'message-first', phase: 'final_answer', content: [{ type: 'Text', text: 'Repeated visible reply' }] }),
    event(f, 'task_complete', { turn_id: 'first', last_agent_message: 'Repeated visible reply' }));
  f.tick();
  f.append(event(f, 'task_started', { turn_id: 'second' }), response(f, 'Repeated visible reply', { id: 'message-second', phase: 'final_answer' }), event(f, 'task_complete', { turn_id: 'second', last_agent_message: 'Repeated visible reply' }));
  const result = await recentReplies(f.path);
  assert.equal(result.replies.length, 2);
  assert.deepEqual(result.replies.map(item => item.turnId), ['first', 'second']);
  assert.notEqual(result.replies[0].id, result.replies[1].id);
});

test('回复：详情限制 20 条与单条长度，忽略未完成末行', async t => {
  const f = fixture(t);
  f.append(event(f, 'task_started', { turn_id: 'turn' }));
  for (let i = 0; i < 24; i++) { f.tick(); f.append(response(f, `Reply ${i}`, { id: `message-${i}` })); }
  f.append(response(f, 'Long reply '.repeat(2000), { id: 'long-message' }));
  appendFileSync(f.path, JSON.stringify(response(f, 'Still being written')));
  const result = await recentReplies(f.path);
  assert.equal(result.replies.length, 20);
  assert.equal(result.limited, true);
  assert.equal(result.replies.at(-1).text.length, 16384);
  assert.equal(result.replies.at(-1).truncated, true);
  assert.ok(result.replies.every(item => item.text !== 'Still being written'));
});

test('回复：读取大于 2 MiB 的尾部并标记有限记录', async t => {
  const f = fixture(t);
  f.append(response(f, 'Outside the detail window'));
  appendFileSync(f.path, JSON.stringify(f.entry('response_item', { type: 'reasoning', encrypted_content: 'x'.repeat(2 * 1024 * 1024) })) + '\n');
  f.append(event(f, 'task_started', { turn_id: 'recent' }), response(f, 'Inside the detail window'));
  const result = await recentReplies(f.path);
  assert.equal(result.limited, true);
  assert.deepEqual(result.replies.map(item => item.text), ['Inside the detail window']);
});

for (const [name, userRecord] of [
  ['现代纯图片 UserMessage', f => modern(f, { type: 'UserMessage', id: 'image-reply', client_id: 'client', content: [{ type: 'image', image_url: 'data:image/png;base64,synthetic' }] })],
  ['现代无文本 UserMessage', f => modern(f, { type: 'UserMessage', id: 'empty-reply', client_id: 'client', content: [] })],
  ['response_item 纯图片用户消息', f => f.entry('response_item', { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,synthetic' }] })],
  ['response_item 无文本用户消息', f => f.entry('response_item', { type: 'message', role: 'user', content: [] })],
]) {
  test(`提问：${name}也解除已结束回合的提示`, t => {
    const f = fixture(t);
    f.append(event(f, 'task_started', { turn_id: 'turn' }), call(f, 'request_user_input_async', 'question'), event(f, 'task_complete', { turn_id: 'turn' }));
    assert.equal(f.read().activity.status, 'waiting');
    f.append(userRecord(f));
    assert.equal(f.read().activity.status, 'unknown');
    assert.equal(f.read().activity.eventKey, null);
  });
}

test('活动：缺时间戳的明确结束仍可说明本轮已结束，但保留空时间供通知过滤', t => {
  const f = fixture(t);
  f.append(event(f, 'task_started', { turn_id: 'turn' }));
  f.read();
  f.append({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn' } });
  assert.equal(f.read().activity.status, 'completed');
  assert.equal(f.read().activity.at, null);
  assert.equal(f.read().activity.turnId, 'turn');
});

test('活动：中断后晚到的可见助手消息不会恢复运行状态', t => {
  const f = fixture(t);
  f.append(event(f, 'task_started', { turn_id: 'turn' }), call(f, 'request_user_input_async', 'question'), event(f, 'turn_aborted', { turn_id: 'turn' }));
  assert.equal(f.read().activity.status, 'interrupted');
  f.tick();
  f.append(response(f, 'Delayed visible reply'), modern(f, { type: 'AgentMessage', id: 'delayed-message', phase: 'final_answer', content: [{ type: 'Text', text: 'Delayed final phase' }] }));
  assert.equal(f.read().activity.status, 'interrupted');
  assert.equal(f.read().activity.turnId, 'turn');
});

test('容错：非对象及非法 JSON 记录不影响后续活动和回复读取', async t => {
  const f = fixture(t);
  appendFileSync(f.path, 'null\n[]\n"synthetic string"\n{broken-json\n');
  f.append(event(f, 'task_started', { turn_id: 'valid-turn' }), response(f, 'Visible after damaged records'));
  assert.equal(f.read().activity.status, 'active');
  assert.equal(f.read().lastMessage, 'Visible after damaged records');
  const result = await recentReplies(f.path);
  assert.deepEqual(result.replies.map(item => item.text), ['Visible after damaged records']);
});

test('回复：缺开始事件时用户新消息仍分隔两轮相同回复', async t => {
  const f = fixture(t);
  f.append(response(f, 'Same visible answer', { id: 'first-answer', phase: 'final_answer' }));
  f.tick(100);
  f.append(f.entry('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Next synthetic request' }] }), response(f, 'Same visible answer', { id: 'second-answer', phase: 'final_answer' }));
  const result = await recentReplies(f.path);
  assert.equal(result.replies.length, 2);
  assert.notEqual(result.replies[0].id, result.replies[1].id);
});


test('隐私：无公开 phase 的助手原始消息不进入预览，明确公开事件仍可显示', async t => {
  const f = fixture(t);
  f.append(f.entry('response_item', {
    type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'PRIVATE_UNLABELLED_ASSISTANT' }],
  }));
  assert.equal(f.read().lastMessage, '');
  assert.deepEqual((await recentReplies(f.path)).replies, []);
  f.append(event(f, 'agent_message', { phase: 'final_answer', message: 'Public final answer' }));
  assert.equal(f.read().lastMessage, 'Public final answer');
  assert.deepEqual((await recentReplies(f.path)).replies.map(item => item.text), ['Public final answer']);
});

test('隐私：自动用户环境记录不解除提问，完整包装后的真实请求只显示请求', t => {
  const f = fixture(t);
  f.append(event(f, 'task_started', { turn_id: 'turn' }), call(f, 'request_user_input_async', 'question'));
  assert.equal(f.read().activity.status, 'waiting');
  f.append(f.entry('response_item', {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>PRIVATE_ENV_CONTEXT</environment_context>' }],
  }));
  assert.equal(f.read().activity.status, 'waiting');
  assert.notEqual(f.read().lastMessage, 'PRIVATE_ENV_CONTEXT');
  f.append(f.entry('response_item', {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>PRIVATE_ENV_CONTEXT</environment_context>\n## My request:\nContinue test' }],
  }));
  assert.equal(f.read().lastMessage, '## My request: Continue test');
  assert.equal(f.read().activity.status, 'active');
});

test('回复：新回合开始后忽略旧回合迟到的完成摘要', async t => {
  const f = fixture(t);
  f.append(event(f, 'task_started', { turn_id: 'old' }), event(f, 'task_started', { turn_id: 'new' }),
    event(f, 'task_complete', { turn_id: 'old', last_agent_message: 'STALE_OLD_ANSWER' }));
  assert.equal(f.read().activity.status, 'active');
  assert.deepEqual((await recentReplies(f.path)).replies, []);
  f.append(event(f, 'task_complete', { turn_id: 'new', last_agent_message: 'Current answer' }));
  assert.deepEqual((await recentReplies(f.path)).replies.map(item => item.text), ['Current answer']);
});


test('提问：环境包装与真实图片同一用户记录时仍解除等待', t => {
  const f = fixture(t);
  f.append(event(f, 'task_started', { turn_id: 'turn' }), call(f, 'request_user_input_async', 'question'));
  assert.equal(f.read().activity.status, 'waiting');
  f.append(f.entry('response_item', {
    type: 'message', role: 'user', content: [
      { type: 'input_text', text: '<environment_context>PRIVATE_ENV_CONTEXT</environment_context>' },
      { type: 'input_image', image_url: 'data:image/png;base64,synthetic' },
    ],
  }));
  assert.equal(f.read().activity.status, 'active');
  assert.notEqual(f.read().lastMessage, 'PRIVATE_ENV_CONTEXT');
});
