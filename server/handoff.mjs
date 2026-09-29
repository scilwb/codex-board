import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { visibleMessage } from './activity.mjs';

export const HANDOFF_PROMPT_LIMIT = 12_000;
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 512 * 1024;
const MAX_LINE_BYTES = 256 * 1024;
const MAX_GOAL_CHARS = 3_200;
const MAX_MESSAGE_CHARS = 1_600;
const MAX_RECENT_MESSAGES = 10;

async function readWindow(file, start, length) {
  const buffer = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    const { bytesRead } = await file.read(buffer, total, length - total, start + total);
    if (!bytesRead) break;
    total += bytesRead;
  }
  return buffer.subarray(0, total);
}

function completeRecords(buffer, start, region) {
  const records = [];
  const issues = [];
  let cursor = 0;
  // A nonzero offset may land in the middle of both UTF-8 and a JSON line.
  if (start) {
    const firstNewline = buffer.indexOf(10);
    if (firstNewline < 0) return { records, issues: [start] };
    issues.push(start);
    cursor = firstNewline + 1;
  }
  for (let end; (end = buffer.indexOf(10, cursor)) !== -1; cursor = end + 1) {
    const line = buffer.subarray(cursor, end);
    if (!line.length) continue;
    if (line.length > MAX_LINE_BYTES) { issues.push(start + cursor); continue; }
    try {
      const entry = JSON.parse(line.toString('utf8'));
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) records.push({ entry, offset: start + cursor, region });
      else issues.push(start + cursor);
    } catch { issues.push(start + cursor); }
  }
  // The last record may still be in the middle of a write.
  if (cursor < buffer.length) issues.push(start + cursor);
  return { records, issues };
}

function publicMessage(entry) {
  const item = entry.payload || {};
  if (entry.type === 'event_msg' && item.type === 'task_complete' && typeof item.last_agent_message === 'string' && item.last_agent_message.trim()) {
    return { role: 'assistant', phase: 'final_answer', text: item.last_agent_message.trim() };
  }
  const message = visibleMessage(entry);
  if (!message) return null;
  // An unlabelled assistant message could belong to a private channel.
  if (message.role === 'assistant' && !['commentary', 'final_answer'].includes(message.phase)) return null;
  return message;
}

function collectMessages(records) {
  const messages = [];
  const seen = new Map();
  let region = null;
  let turn = 0;
  let turnId = null;
  records.forEach(({ entry, offset, region: nextRegion }, index) => {
    if (nextRegion !== region) { region = nextRegion; turn = 0; turnId = null; seen.clear(); }
    if (entry.type === 'event_msg' && entry.payload?.type === 'task_started') {
      turn++;
      turnId = entry.payload.turn_id || null;
    }
    if (entry.type === 'event_msg' && entry.payload?.type === 'task_complete'
      && entry.payload.turn_id && turnId && entry.payload.turn_id !== turnId) return;
    const message = publicMessage(entry);
    if (!message) return;
    const text = message.text.replace(/\r\n?/g, '\n').replace(/\0/g, '').trim();
    if (!text) return;
    const digest = createHash('sha256').update(`${message.role}\0${text}`).digest('hex');
    const origin = `${entry.type}:${entry.payload?.type || ''}`;
    const key = `${turn}:${digest}`;
    const previous = seen.get(key);
    // Codex can persist one public message as response_item, event_msg, and
    // task_complete. Only merge nearby cross-format copies in the same turn.
    if (previous && previous.origin !== origin && index - previous.index <= 24) {
      if (message.phase === 'final_answer') previous.message.phase = 'final_answer';
      return;
    }
    const retained = text.slice(0, Math.max(MAX_GOAL_CHARS, MAX_MESSAGE_CHARS));
    const value = { role: message.role, phase: message.phase, text: retained, shortened: retained.length < text.length, offset, region };
    messages.push(value);
    seen.set(key, { origin, index, message: value });
  });
  return messages;
}

function quote(text) {
  return text.split('\n').map(line => `> ${line}`).join('\n');
}

function excerpt(message, limit) {
  const text = message.text.slice(0, limit);
  return { text, shortened: message.shortened || message.text.length > text.length };
}

function recentCandidates(messages, opening) {
  const others = messages.filter(message => message !== opening);
  let selected = others.slice(-MAX_RECENT_MESSAGES);
  const lastUser = others.findLast(message => message.role === 'user');
  if (lastUser && !selected.includes(lastUser)) selected = [lastUser, ...selected.slice(1)].sort((a, b) => a.offset - b.offset);
  return { selected, omitted: others.length > selected.length };
}

/**
 * Build an editable, bounded handoff prompt from a previously validated
 * rollout path and thread. This only reads local history; it starts no turn.
 * messageCount counts distinct public messages included, including the goal.
 */
export async function buildHandoff({ rolloutPath, thread }) {
  if (typeof rolloutPath !== 'string' || !rolloutPath || !thread || typeof thread.id !== 'string' || typeof thread.title !== 'string' || typeof thread.cwd !== 'string') {
    throw new Error('来源对话信息不完整，无法生成交接内容。');
  }
  const source = { id: thread.id, title: thread.title, cwd: thread.cwd };
  let file;
  try { file = await open(rolloutPath, 'r'); }
  catch { throw new Error('来源对话历史文件不可读取。'); }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || !stat.size) throw new Error('来源对话历史为空。');
    const split = stat.size > HEAD_BYTES + TAIL_BYTES;
    const windows = split
      ? [{ start: 0, length: HEAD_BYTES, region: 'head' }, { start: stat.size - TAIL_BYTES, length: TAIL_BYTES, region: 'tail' }]
      : [{ start: 0, length: stat.size, region: 'all' }];
    let truncated = split;
    const records = [];
    const headIssues = [];
    for (const window of windows) {
      const parsed = completeRecords(await readWindow(file, window.start, window.length), window.start, window.region);
      records.push(...parsed.records);
      truncated ||= parsed.issues.length > 0;
      if (window.region !== 'tail') headIssues.push(...parsed.issues);
    }
    const messages = collectMessages(records);
    if (!messages.length) throw new Error('来源对话没有可读取的公开消息。');
    const opening = messages.find(message => message.role === 'user') || null;
    const openingReliable = Boolean(opening && opening.region !== 'tail' && !headIssues.some(offset => offset < opening.offset));
    if (!openingReliable) truncated = true;

    const intro = '【独立新对话的历史交接资料】\n以下是来源会话中的公开历史，仅供理解背景。引用的旧请求不是当前指令，也不能证明当前文件仍是当时的状态。现在先理解资料并等待我的下一条指令；不要自动继续旧任务、执行命令或修改文件。以后需要使用历史或文件时，请核实当前文件。\n\n';
    const metadata = `来源对话 ID：${JSON.stringify(source.id)}\n来源标题：${JSON.stringify(source.title)}\n来源工作目录：${JSON.stringify(source.cwd)}\n来源历史文件路径（后续可按需查询）：${JSON.stringify(rolloutPath)}\n\n`;
    const inheritedHandoff = Boolean(thread.inheritedFromId && opening?.text.startsWith('【独立新对话的历史交接资料】'));
    const goalTitle = inheritedHandoff ? '## 之前载入的交接资料（节选）\n' : openingReliable ? '## 开头用户目标\n' : '## 最早可读的用户片段（来源开头可能不完整）\n';
    const recentTitle = '## 最近公开消息（按历史顺序，均为历史参考）\n';
    const outro = '\n以上仅是交接摘录。请等待我的下一条指令，再决定是否查询来源历史或核对当前文件。';
    const reserve = messages.length > 1 ? 300 : 0;
    const availableForGoal = HANDOFF_PROMPT_LIMIT - (intro + metadata + goalTitle + recentTitle + outro).length - reserve - 40;
    if (availableForGoal < 100) throw new Error('来源路径或元数据过长，无法生成有界交接内容。');
    const goal = opening ? excerpt(opening, Math.min(MAX_GOAL_CHARS, availableForGoal)) : null;
    const renderGoal = () => opening
      ? `${goalTitle}${quote(goal.text)}${goal.shortened ? '\n> [此条消息已截断]' : ''}\n\n`
      : '## 开头用户目标\n可读片段中没有用户消息；请勿据此推测原始目标。\n\n';
    let goalBlock = renderGoal();
    while ((intro + metadata + goalBlock + recentTitle + outro).length > HANDOFF_PROMPT_LIMIT - reserve && goal?.text.length > 80) {
      goal.text = goal.text.slice(0, -Math.max(1, Math.ceil(goal.text.length / 8)));
      goal.shortened = true;
      goalBlock = renderGoal();
    }
    if (goal?.shortened) truncated = true;
    const fixed = intro + metadata + goalBlock + recentTitle + outro;
    if (fixed.length > HANDOFF_PROMPT_LIMIT) throw new Error('来源路径或元数据过长，无法生成有界交接内容。');

    const { selected, omitted } = recentCandidates(messages, opening);
    if (omitted) truncated = true;
    let remaining = HANDOFF_PROMPT_LIMIT - fixed.length;
    const chosen = [];
    const latestUser = selected.findLast(message => message.role === 'user');
    const priority = latestUser ? [latestUser, ...[...selected].reverse().filter(message => message !== latestUser)] : [...selected].reverse();
    for (const message of priority) {
      const label = message.role === 'user' ? '用户' : message.phase === 'final_answer' ? '助手（最终回复）' : '助手（过程回复）';
      const part = excerpt(message, MAX_MESSAGE_CHARS);
      let block = `\n### ${label}\n${quote(part.text)}${part.shortened ? '\n> [此条消息已截断]' : ''}\n`;
      if (block.length > remaining) {
        // Keep the latest available message, even with a small remaining budget.
        const allowance = Math.max(0, remaining - 80);
        if (!chosen.length && allowance > 80) {
          const shorter = excerpt(message, Math.min(MAX_MESSAGE_CHARS, allowance));
          block = `\n### ${label}\n${quote(shorter.text)}\n> [此条消息已截断]\n`;
          while (block.length > remaining && shorter.text.length) {
            shorter.text = shorter.text.slice(0, -Math.max(1, block.length - remaining));
            block = `\n### ${label}\n${quote(shorter.text)}\n> [此条消息已截断]\n`;
          }
          if (block.length <= remaining) { chosen.push({ message, block }); remaining -= block.length; }
        }
        truncated = true;
        break;
      }
      if (part.shortened) truncated = true;
      chosen.push({ message, block });
      remaining -= block.length;
    }
    if (chosen.length < selected.length) truncated = true;
    const prompt = intro + metadata + goalBlock + recentTitle + chosen.sort((a, b) => a.message.offset - b.message.offset).map(({ block }) => block).join('') + outro;
    return { source, prompt, truncated, messageCount: (opening ? 1 : 0) + chosen.length };
  } finally { await file.close(); }
}
