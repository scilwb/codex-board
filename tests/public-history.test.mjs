import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PUBLIC_HISTORY_MAX_MESSAGES,
  PUBLIC_HISTORY_MESSAGE_CHARS,
  PUBLIC_HISTORY_WINDOW_BYTES,
  readPublicHistory,
} from '../server/public-history.mjs';

const line = (type, payload) => JSON.stringify({ timestamp: '2026-09-29T01:00:00.000Z', type, payload }) + '\n';
const user = text => line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const assistant = (text, phase = 'final_answer') => line('response_item', { type: 'message', role: 'assistant', phase, content: [{ type: 'output_text', text }] });

function withFile(t, contents) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-board-public-history-'));
  const path = join(directory, 'rollout.jsonl');
  writeFileSync(path, contents);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return path;
}

test('exact source offsets and newline-inclusive byte lengths survive multibyte text', async t => {
  const metadata = line('session_meta', { id: 'synthetic' });
  const first = user('你好，🌍');
  const second = assistant('检查完成');
  const path = withFile(t, metadata + first + second);
  const offset = Buffer.byteLength(metadata);
  const result = await readPublicHistory({ rolloutPath: path, offset });
  assert.equal(result.startOffset, offset);
  assert.equal(result.endOffset, Buffer.byteLength(metadata + first + second));
  assert.equal(result.nextOffset, result.endOffset);
  assert.equal(result.totalBytes, result.endOffset);
  assert.equal(result.hasMore, false);
  assert.equal(result.limited, false);
  assert.deepEqual(result.messages.map(message => ({ role: message.role, text: message.text, offset: message.offset, byteLength: message.byteLength })), [
    { role: 'user', text: '你好，🌍', offset, byteLength: Buffer.byteLength(first) },
    { role: 'assistant', text: '检查完成', offset: offset + Buffer.byteLength(first), byteLength: Buffer.byteLength(second) },
  ]);
});

test('an offset inside a UTF-8 character skips only that partial record', async t => {
  const first = user('前一条🌍内容');
  const second = assistant('下一条完整内容');
  const path = withFile(t, first + second);
  const inside = Buffer.from(first).indexOf(Buffer.from('🌍')) + 2;
  const result = await readPublicHistory({ rolloutPath: path, offset: inside });
  assert.equal(result.limited, true);
  assert.deepEqual(result.messages.map(message => message.text), ['下一条完整内容']);
  assert.equal(result.messages[0].offset, Buffer.byteLength(first));
  assert.equal(result.nextOffset, Buffer.byteLength(first + second));
});

test('a record crossing the window boundary is retried from its exact start', async t => {
  const privateLine = line('response_item', { type: 'reasoning', encrypted_content: 'x'.repeat(PUBLIC_HISTORY_WINDOW_BYTES - 300) });
  assert.ok(Buffer.byteLength(privateLine) < PUBLIC_HISTORY_WINDOW_BYTES);
  const visible = user('边界消息' + 'a'.repeat(400));
  const path = withFile(t, privateLine + visible);
  const first = await readPublicHistory({ rolloutPath: path, offset: 0 });
  assert.equal(first.endOffset, PUBLIC_HISTORY_WINDOW_BYTES);
  assert.deepEqual(first.messages, []);
  assert.equal(first.nextOffset, Buffer.byteLength(privateLine));
  assert.equal(first.hasMore, true);
  const second = await readPublicHistory({ rolloutPath: path, offset: first.nextOffset });
  assert.equal(second.messages[0].offset, Buffer.byteLength(privateLine));
  assert.equal(second.messages[0].byteLength, Buffer.byteLength(visible));
  assert.equal(second.messages[0].text, '边界消息' + 'a'.repeat(400));
  assert.equal(second.hasMore, false);
});

test('oversized private lines are skipped with monotonic offsets and bounded reads', async t => {
  const privateLine = line('response_item', { type: 'reasoning', raw_content: 'PRIVATE_'.repeat(PUBLIC_HISTORY_WINDOW_BYTES / 4) });
  const path = withFile(t, privateLine + user('可读取的后续请求'));
  const found = [];
  let offset = 0;
  for (let page = 0; page < 8; page++) {
    const result = await readPublicHistory({ rolloutPath: path, offset });
    assert.ok(result.endOffset - result.startOffset <= PUBLIC_HISTORY_WINDOW_BYTES);
    found.push(...result.messages.map(message => message.text));
    if (!result.hasMore) break;
    assert.ok(result.nextOffset > offset, 'a page with more data must advance');
    offset = result.nextOffset;
  }
  assert.deepEqual(found, ['可读取的后续请求']);
});

test('an unfinished EOF line remains unread until its newline arrives', async t => {
  const first = user('已完成的消息');
  const unfinished = assistant('还在写入中的答复').slice(0, -1);
  const path = withFile(t, first + unfinished);
  const page = await readPublicHistory({ rolloutPath: path, offset: 0 });
  assert.deepEqual(page.messages.map(message => message.text), ['已完成的消息']);
  assert.equal(page.nextOffset, Buffer.byteLength(first));
  assert.equal(page.hasMore, false);
  assert.equal(page.limited, true);
  appendFileSync(path, '\n');
  const completed = await readPublicHistory({ rolloutPath: path, offset: page.nextOffset });
  assert.deepEqual(completed.messages.map(message => message.text), ['还在写入中的答复']);
  assert.equal(completed.hasMore, false);
});

test('message cap paginates without skipping the next complete public record', async t => {
  const lines = Array.from({ length: PUBLIC_HISTORY_MAX_MESSAGES + 5 }, (_, index) => user(`第 ${index} 条`));
  const path = withFile(t, lines.join(''));
  const first = await readPublicHistory({ rolloutPath: path });
  assert.equal(first.messages.length, PUBLIC_HISTORY_MAX_MESSAGES);
  assert.equal(first.nextOffset, Buffer.byteLength(lines.slice(0, PUBLIC_HISTORY_MAX_MESSAGES).join('')));
  assert.equal(first.hasMore, true);
  assert.equal(first.limited, true);
  const second = await readPublicHistory({ rolloutPath: path, offset: first.nextOffset });
  assert.equal(second.messages.length, 5);
  assert.equal(second.messages[0].offset, first.nextOffset);
  assert.equal(second.hasMore, false);
  assert.deepEqual([...first.messages, ...second.messages].map(message => message.text), lines.map((_, index) => `第 ${index} 条`));
});

test('one message is limited by Unicode characters while source byte length remains exact', async t => {
  const text = '🌍'.repeat(PUBLIC_HISTORY_MESSAGE_CHARS + 1);
  const record = assistant(text);
  const path = withFile(t, record);
  const result = await readPublicHistory({ rolloutPath: path });
  assert.equal(Array.from(result.messages[0].text).length, PUBLIC_HISTORY_MESSAGE_CHARS);
  assert.equal(result.messages[0].text, '🌍'.repeat(PUBLIC_HISTORY_MESSAGE_CHARS));
  assert.equal(result.messages[0].byteLength, Buffer.byteLength(record));
  assert.equal(result.messages[0].truncated, true);
  assert.equal(result.limited, true);
});

test('private records and automatic user wrappers stay out; stale turn completion is ignored', async t => {
  const records = [
    line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>PRIVATE_ENV</environment_context>\n真实用户请求' }] }),
    line('event_msg', { type: 'user_message', message: '<recommended_plugins>PRIVATE_PLUGINS</recommended_plugins>' }),
    line('event_msg', { type: 'user_message', message: '<environment_context>PRIVATE_UNFINISHED' }),
    line('event_msg', { type: 'user_message', message: '# AGENTS.md instructions for /tmp\nPRIVATE_AGENTS' }),
    line('event_msg', { type: 'user_message', message: '<environment_context>auto</environment_context>\n# AGENTS.md instructions for /tmp\nPRIVATE_NESTED_AGENTS' }),
    line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>auto</environment_context>\n# AGENTS.md instructions for /tmp\nPRIVATE_RESPONSE_AGENTS' }] }),
    line('response_item', { type: 'message', role: 'assistant', phase: 'analysis', content: [{ type: 'output_text', text: 'PRIVATE_ANALYSIS' }] }),
    line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'PRIVATE_UNLABELLED' }] }),
    line('response_item', { type: 'message', role: 'system', content: [{ type: 'output_text', text: 'PRIVATE_SYSTEM' }] }),
    line('response_item', { type: 'function_call_output', output: 'PRIVATE_TOOL' }),
    line('event_msg', { type: 'task_started', turn_id: 'old-turn' }),
    line('event_msg', { type: 'task_started', turn_id: 'current-turn' }),
    line('event_msg', { type: 'task_complete', turn_id: 'old-turn', last_agent_message: 'PRIVATE_STALE' }),
    line('event_msg', { type: 'task_complete', turn_id: 'current-turn', last_agent_message: '本轮公开结论' }),
  ];
  const result = await readPublicHistory({ rolloutPath: withFile(t, records.join('')) });
  assert.deepEqual(result.messages.map(message => message.text), ['真实用户请求', '本轮公开结论']);
  assert.deepEqual(result.messages.map(message => message.phase), [null, 'final_answer']);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
});

test('invalid and beyond-EOF offsets fail with a client range error', async t => {
  const path = withFile(t, user('内容'));
  for (const offset of [-1, 0.5, Number.POSITIVE_INFINITY, 999_999]) {
    await assert.rejects(readPublicHistory({ rolloutPath: path, offset }), error => error instanceof RangeError && error.status === 400);
  }
});
