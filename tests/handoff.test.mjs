import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHandoff, HANDOFF_PROMPT_LIMIT, HANDOFF_READ_LIMIT } from '../server/handoff.mjs';

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

test('structured handoff preserves the current request, decisions, constraints, verification, and exact file evidence', async t => {
  const path = withFile(t, '');
  const cwd = join(path, '..', 'project');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'driver.py'), 'pass\n');
  const rows = [
    line('event_msg', { type: 'user_message', message: '初始目标：检查采集系统' }),
    line('event_msg', { type: 'user_message', message: '必须保留现有标定参数；不要更改硬件接口。' }),
    line('event_msg', { type: 'agent_message', phase: 'final_answer', message: '决定采用离线回放，因为实机暂不可用。' }),
    line('event_msg', { type: 'agent_message', phase: 'commentary', message: '已修复时间戳解析；关键文件 `src/driver.py:12`。' }),
    line('event_msg', { type: 'agent_message', phase: 'commentary', message: '验证：在项目目录执行 `pytest tests/test_driver.py`，历史记录为 8 passed。' }),
    line('event_msg', { type: 'agent_message', phase: 'commentary', message: '下一步：补做边界采样检查。' }),
    line('event_msg', { type: 'agent_message', phase: 'commentary', message: '阻塞：缺少实机数据。' }),
    line('event_msg', { type: 'user_message', message: '最新目标：先完善日志，不启动实机。' }),
    line('event_msg', { type: 'agent_message', phase: 'final_answer', message: '已收到，停在日志设计阶段。' }),
  ];
  writeFileSync(path, rows.join(''));
  const result = await buildHandoff({ rolloutPath: path, thread: { ...thread, cwd } });
  for (const phrase of ['## 最新用户要求', '## 用户约束与偏好', '## 关键决策与理由', '## 验证、运行方式与结果', '## 阻塞、失败与未决问题', '## 关键文件、目录与产物索引', '先完善日志', '必须保留现有标定参数', '采用离线回放', '因为实机暂不可用', '8 passed', '补做边界采样', '缺少实机数据']) {
    assert.ok(result.prompt.includes(phrase), phrase);
  }
  assert.ok(result.prompt.indexOf('最新目标：') < result.prompt.indexOf('初始目标：'));
  const file = result.files.find(file => file.path === join(cwd, 'src', 'driver.py'));
  assert.equal(file.status, 'file');
  assert.equal(file.line, 12);
  assert.equal(file.evidence.offset, Buffer.byteLength(rows.slice(0, 3).join('')));
  assert.ok(result.prompt.includes(JSON.stringify(file.path)));
  assert.match(result.prompt, /当前可见文件/);
  assert.match(result.prompt, /来源字节/);
  assert.match(result.prompt, /\/history\?offset=/);
  assert.equal(result.coverage.bytesRead, Buffer.byteLength(rows.join('')));
  assert.equal(result.coverage.sampled, false);
  assert.equal(result.coverage.messageCount, rows.length);
  assert.equal(result.version, 2);
  assert.ok(result.prompt.length <= HANDOFF_PROMPT_LIMIT);
});

test('large histories include middle-window file evidence while reading at most 2 MiB', async t => {
  const bytes = Buffer.alloc(5 * 1024 * 1024, 10);
  bytes.write(line('event_msg', { type: 'user_message', message: '从头建立验收目标' }), 0);
  const middleOffset = Math.floor(bytes.length / 2) - 100;
  bytes.write(line('event_msg', { type: 'agent_message', phase: 'final_answer', message: '关键入口是 `src/middle_only.py`，决定保留此方案。' }), middleOffset);
  const ending = line('event_msg', { type: 'user_message', message: '最新请求：继续检查已列出的关键入口' });
  bytes.write(ending, bytes.length - Buffer.byteLength(ending));
  const result = await buildHandoff({ rolloutPath: withFile(t, bytes), thread });
  assert.equal(result.coverage.bytesRead, HANDOFF_READ_LIMIT);
  assert.equal(result.coverage.sampled, true);
  assert.ok(result.coverage.windowCount > 2);
  assert.ok(result.files.some(file => file.path === join(thread.cwd, 'src/middle_only.py')));
  assert.match(result.prompt, /最新请求：继续检查/);
  assert.match(result.prompt, /未读取区间可能仍有重要决定/);
  assert.equal(result.truncated, true);
});

test('paths beyond long-message excerpts survive and worst-case structured sections stay within budget', async t => {
  const rows = [line('event_msg', { type: 'user_message', message: '原目标' + '甲'.repeat(15000) })];
  const terms = ['必须保留', '失败阻塞', '验证命令 npm test', '决定采用', '下一步继续', '已完成'];
  for (let i = 0; i < 60; i++) {
    rows.push(line('event_msg', { type: i % 6 === 0 ? 'user_message' : 'agent_message', phase: 'commentary', message: `${terms[i % 6]} ${i}：${'乙'.repeat(900)}\n关键文件 \`src/very_long_${i}_${'a'.repeat(70)}.py\`` }));
  }
  rows.push(line('event_msg', { type: 'agent_message', phase: 'final_answer', message: '公开说明'.repeat(2000) + '\n关键入口：`src/important_at_end.py`' }));
  rows.push(line('event_msg', { type: 'user_message', message: '当前只检查关键路径。' }));
  const result = await buildHandoff({ rolloutPath: withFile(t, rows.join('')), thread });
  assert.ok(result.prompt.length <= HANDOFF_PROMPT_LIMIT);
  assert.ok(result.files.some(file => file.path === join(thread.cwd, 'src/important_at_end.py')));
  assert.ok(result.prompt.includes(join(thread.cwd, 'src/important_at_end.py')));
  assert.match(result.prompt, /当前只检查关键路径/);
  assert.equal(result.truncated, true);
});

test('a long IDE tab list cannot crowd out the actual latest user instruction', async t => {
  const tabs = Array.from({ length: 90 }, (_, i) => `- file${i}.py: src/${'nested/'.repeat(8)}file${i}.py`).join('\n');
  const path = withFile(t, line('event_msg', { type: 'user_message', message: '开头要求' })
    + line('event_msg', { type: 'user_message', message: `# Context from my IDE setup:\n\n## Open tabs:\n${tabs}\n\n## My request:\n只处理最新的数据格式，不改变硬件。` }));
  const result = await buildHandoff({ rolloutPath: path, thread });
  assert.match(result.prompt, /只处理最新的数据格式，不改变硬件/);
  assert.ok(result.files.length > 0);
  assert.ok(result.prompt.length <= HANDOFF_PROMPT_LIMIT);
});

test('long latest requests and replies retain both their opening and decisive ending', async t => {
  const path = withFile(t,
    line('event_msg', { type: 'user_message', message: '最早目标' })
    + line('event_msg', { type: 'user_message', message: 'CURRENT_REQUEST_START ' + '背景'.repeat(4200) + ' CRITICAL_END_REQUIREMENT' })
    + line('event_msg', { type: 'agent_message', phase: 'final_answer', message: 'CURRENT_REPLY_START ' + '细节'.repeat(4200) + ' CRITICAL_END_RESULT' }));
  const result = await buildHandoff({ rolloutPath: path, thread });
  for (const text of ['CURRENT_REQUEST_START', 'CRITICAL_END_REQUIREMENT', 'CURRENT_REPLY_START', 'CRITICAL_END_RESULT']) assert.ok(result.prompt.includes(text), text);
  assert.equal(result.truncated, true);
  assert.ok(result.prompt.length <= HANDOFF_PROMPT_LIMIT);
});

test('a path citation does not suppress other context from the same message', async t => {
  const path = withFile(t,
    line('event_msg', { type: 'user_message', message: '查看入口资料' })
    + line('event_msg', { type: 'agent_message', phase: 'commentary', message: 'See `src/entry.py`. ' + '说明'.repeat(100) + ' CRITICAL_CONTEXT_NOTE' })
    + line('event_msg', { type: 'agent_message', phase: 'final_answer', message: '准备接续。' }));
  const result = await buildHandoff({ rolloutPath: path, thread });
  assert.ok(result.files.some(file => file.path === join(thread.cwd, 'src/entry.py')));
  assert.match(result.prompt, /CRITICAL_CONTEXT_NOTE/);
});

test('automatic environment wrappers in old event messages cannot become the opening goal', async t => {
  const path = withFile(t,
    line('event_msg', { type: 'user_message', message: '<environment_context>PRIVATE_ENV_CONTEXT</environment_context>' })
    + line('event_msg', { type: 'user_message', message: '<recommended_plugins>PRIVATE_PLUGINS</recommended_plugins>\n真正请求：核对交付物' }));
  const result = await buildHandoff({ rolloutPath: path, thread });
  assert.doesNotMatch(result.prompt, /PRIVATE_ENV_CONTEXT|PRIVATE_PLUGINS/);
  assert.match(result.prompt, /真正请求：核对交付物/);
  assert.equal(result.coverage.messageCount, 1);
});
