import { openSync, closeSync, readSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export const ACTIVITY_TTL = 120_000;
export const READ_LIMIT = 256 * 1024;
const REPLY_READ_LIMIT = 2 * 1024 * 1024;
const stamp = entry => Number.isFinite(Date.parse(entry.timestamp)) ? Date.parse(entry.timestamp) : null;
const short = text => text.replace(/\s+/g, ' ').trim().slice(0, 240);
const unknown = (reason = '没有足够的活动记录，当前状态无法确认。') => ({ status: 'unknown', at: null, turnId: null, eventKey: null, reason, stale: false });
const digest = text => createHash('sha256').update(text).digest('hex').slice(0, 20);

function userTextParts(item) {
  return Array.isArray(item?.content)
    ? item.content.filter(part => ['input_text', 'output_text', 'text'].includes(part?.type)).map(part => part.text || '').join('\n')
    : '';
}

// Codex also records automatic context in user-role response items. Strip a
// complete leading wrapper before treating the remainder as a user request.
// An incomplete wrapper is ambiguous, so do not display any of its contents.
function publicUserText(text) {
  let remaining = text.trim();
  if (/^#\s*AGENTS\.md instructions for\b/i.test(remaining)) return null;
  for (;;) {
    const match = remaining.match(/^<(environment_context|permissions instructions|skills_instructions|recommended_plugins)>/i);
    if (!match) break;
    const close = '</' + match[1] + '>';
    const at = remaining.indexOf(close, match[0].length);
    if (at < 0) return null;
    remaining = remaining.slice(at + close.length).trim();
  }
  return remaining || null;
}

function isAutomaticUserInput(entry) {
  const item = entry?.payload;
  if (entry?.type !== 'response_item' || item?.type !== 'message' || item.role !== 'user') return false;
  if (Array.isArray(item.content) && item.content.some(part => part && !['input_text', 'output_text', 'text'].includes(part.type))) return false;
  const text = userTextParts(item);
  return Boolean(text.trim()) && publicUserText(text) === null;
}

// Only user-visible messages are eligible. Never extract text from reasoning,
// tool output, or assistant analysis records.
export function visibleMessage(entry) {
  const item = entry?.payload;
  if (!item || typeof item !== 'object') return null;
  let role, phase, channel, text, id;
  if (entry.type === 'event_msg' && ['agent_message', 'user_message'].includes(item.type)) {
    role = item.type === 'agent_message' ? 'assistant' : 'user';
    phase = item.phase; channel = item.channel; text = item.message;
  } else if (entry.type === 'response_item' && item.type === 'message') {
    role = item.role; phase = item.phase; channel = item.channel; id = item.id;
    text = userTextParts(item);
  } else if (entry.type === 'event_msg' && item.type === 'item_completed' && ['AgentMessage', 'UserMessage'].includes(item.item?.type)) {
    const message = item.item;
    role = message.type === 'AgentMessage' ? 'assistant' : 'user';
    phase = message.phase; channel = message.channel; id = message.id;
    text = Array.isArray(message.content) ? message.content.filter(part => ['Text', 'text', 'input_text', 'output_text'].includes(part?.type)).map(part => part.text || '').join('\n') : '';
  }
  if (!['assistant', 'user'].includes(role) || [phase, channel].some(value => value && !['commentary', 'final_answer', 'final'].includes(value)) || typeof text !== 'string' || !text.trim()) return null;
  if (role === 'assistant' && ![phase, channel].some(value => ['commentary', 'final_answer', 'final'].includes(value))) return null;
  if (role === 'user' && entry.type === 'response_item') text = publicUserText(text);
  if (!text) return null;
  const visiblePhase = phase || channel || null;
  return { role, phase: visiblePhase === 'final' ? 'final_answer' : visiblePhase, text: text.trim(), id: id || null, at: stamp(entry) };
}

function isUserInput(entry) {
  const item = entry?.payload;
  return (entry?.type === 'response_item' && item?.type === 'message' && item.role === 'user' && !isAutomaticUserInput(entry))
    || (entry?.type === 'event_msg' && (item?.type === 'user_message' || (item?.type === 'item_completed' && item.item?.type === 'UserMessage')));
}

function freshState() { return { activity: unknown(), pending: new Set(), ended: false, lastMessage: '', forkedFromId: null, gitBranch: null }; }

function transition(state, status, entry, key, reason) {
  state.activity = { status, at: stamp(entry), turnId: entry.payload?.turn_id || state.activity.turnId, eventKey: key, reason, stale: false };
}

export function consumeEvent(state, entry, key) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
  const item = entry.payload || {};
  const event = entry.type === 'event_msg' ? item.type : null;
  if (entry.type === 'session_meta') {
    state.forkedFromId = item.forked_from_id || null;
    state.gitBranch = item.git?.branch || null;
  }
  if (event === 'task_started') {
    state.pending.clear();
    state.ended = false;
    state.activity = unknown();
    transition(state, 'active', entry, key, '记录到本轮开始；运行状态根据近期活动推测。');
  } else if (['task_complete', 'turn_aborted'].includes(event)) {
    if (item.turn_id && state.activity.turnId && item.turn_id !== state.activity.turnId) return;
    state.ended = true;
    if (event === 'task_complete' && state.pending.size) {
      transition(state, 'waiting', entry, state.activity.eventKey, '本轮已结束，记录中的提问尚未确认已回答。');
    } else {
      state.pending.clear();
      transition(state, event === 'task_complete' ? 'completed' : 'interrupted', entry, key,
        event === 'task_complete' ? '已记录本轮结束；不代表整个任务已经完成。' : '已记录本轮中断。');
    }
    if (typeof item.last_agent_message === 'string' && item.last_agent_message.trim()) state.lastMessage = short(item.last_agent_message);
  }
  const message = visibleMessage(entry);
  const userInput = isUserInput(entry);
  if (message) state.lastMessage = short(message.text);
  if (userInput) {
    state.pending.clear();
    if (!state.ended && ['active', 'waiting'].includes(state.activity.status)) transition(state, 'active', entry, key, '收到新的用户消息；运行状态根据近期活动推测。');
    else state.activity = unknown('收到新的用户消息，尚未确认本轮是否开始。');
  } else if (message?.role === 'assistant' && !['completed', 'interrupted', 'failed'].includes(state.activity.status)) {
    transition(state, state.pending.size ? 'waiting' : 'active', entry, state.pending.size ? state.activity.eventKey : key,
      state.pending.size ? '记录到提问，尚未确认已回答；Codex 可能仍在继续工作。' : '记录到新的回复；运行状态根据近期活动推测。');
  }
  // A tool invocation is evidence of activity, but its accepted:true receipt
  // only acknowledges displaying an asynchronous question.
  const isCall = entry.type === 'response_item' && item.type === 'function_call';
  const inputCall = isCall && /(^|\.)(request_user_input|request_user_input_async)$/.test(item.name || '');
  const questionItem = event === 'item_completed' && item.item?.type === 'AgentMessage' && Array.isArray(item.item.questions) && item.item.questions.length > 0;
  if (inputCall || questionItem) {
    const requestId = item.call_id || item.item?.id || key;
    const hadPending = state.pending.size > 0;
    if (inputCall || !hadPending) state.pending.add(requestId);
    transition(state, 'waiting', entry, hadPending ? state.activity.eventKey : key, '记录到提问，尚未确认已回答；Codex 可能仍在继续工作。');
  } else if (entry.type === 'response_item' && item.type === 'function_call_output' && state.pending.has(item.call_id)) {
    let result;
    try { result = typeof item.output === 'string' ? JSON.parse(item.output) : item.output; } catch {}
    if (result?.answers && typeof result.answers === 'object') {
      state.pending.delete(item.call_id);
      if (!state.pending.size) transition(state, state.ended ? 'completed' : 'active', entry, key, state.ended ? '本轮已结束，并已记录问题答复。' : '已记录问题答复；运行状态根据近期活动推测。');
    }
  } else if (['active', 'waiting'].includes(state.activity.status) && stamp(entry)) {
    // New complete records keep an active observation fresh without changing
    // its identity (so a waiting prompt never notifies on every tool event).
    state.activity.at = stamp(entry);
  }
}

function observedActivity(state, now) {
  const activity = { ...state.activity };
  if (['active', 'waiting'].includes(activity.status) && (!activity.at || now - activity.at > ACTIVITY_TTL || activity.at > now + 60_000)) {
    return { ...activity, status: 'unknown', stale: true, reason: '超过 2 分钟没有可确认的新活动，当前状态未知。' };
  }
  return activity;
}

function readRange(fd, start, length) {
  const buffer = Buffer.alloc(length);
  const bytes = readSync(fd, buffer, 0, length, start);
  return buffer.subarray(0, bytes);
}

export class RolloutMonitor {
  constructor({ now = Date.now } = {}) { this.cache = new Map(); this.now = now; }

  read(path) {
    if (!path) return { activity: unknown() };
    try {
      const stat = statSync(path);
      let record = this.cache.get(path);
      const identity = `${stat.dev}:${stat.ino}`;
      const reset = !record || record.identity !== identity || stat.size < record.offset || (stat.size === record.offset && stat.mtimeMs !== record.mtime);
      if (reset) record = { identity, offset: 0, mtime: null, pending: Buffer.alloc(0), skipping: false, state: freshState() };
      if (reset || stat.size !== record.offset) {
        const fd = openSync(path, 'r');
        try {
          if (reset) {
            const head = readRange(fd, 0, Math.min(65536, stat.size)).toString('utf8');
            for (const line of head.split('\n').slice(0, 5)) {
              try { const entry = JSON.parse(line); if (entry.type === 'session_meta') consumeEvent(record.state, entry, 'metadata'); } catch {}
            }
          }
          const gap = stat.size - record.offset > READ_LIMIT;
          const start = gap ? stat.size - READ_LIMIT : record.offset;
          if (gap) {
            record.pending = Buffer.alloc(0); record.skipping = true;
            record.state.activity = unknown('部分活动记录较大，当前状态等待新的明确记录。');
            record.state.pending.clear(); record.state.ended = false;
          }
          const data = Buffer.concat([record.pending, readRange(fd, start, stat.size - start)]);
          let cursor = 0;
          const base = start - record.pending.length;
          for (let end; (end = data.indexOf(10, cursor)) !== -1; cursor = end + 1) {
            if (record.skipping) { record.skipping = false; continue; }
            try { consumeEvent(record.state, JSON.parse(data.subarray(cursor, end).toString('utf8')), `${identity}:${base + cursor}`); } catch {}
          }
          const remaining = data.subarray(cursor);
          if (remaining.length > READ_LIMIT) { record.pending = Buffer.alloc(0); record.skipping = true; }
          else record.pending = Buffer.from(remaining);
          record.offset = stat.size; record.mtime = stat.mtimeMs;
          this.cache.set(path, record);
        } finally { closeSync(fd); }
      }
      return { lastMessage: record.state.lastMessage, forkedFromId: record.state.forkedFromId, gitBranch: record.state.gitBranch, activity: observedActivity(record.state, this.now()) };
    } catch {
      this.cache.delete(path);
      return { activity: unknown('活动文件暂时不可读，当前状态未知。') };
    }
  }

  retain(paths) { for (const path of this.cache.keys()) if (!paths.has(path)) this.cache.delete(path); }
}

export async function recentReplies(path) {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    const start = Math.max(0, stat.size - REPLY_READ_LIMIT);
    const buffer = Buffer.alloc(stat.size - start);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await file.read(buffer, bytesRead, buffer.length - bytesRead, start + bytesRead);
      if (!chunk.bytesRead) break;
      bytesRead += chunk.bytesRead;
    }
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    lines.pop(); // Ignore a record that is still being written.
    if (start) lines.shift();
    const replies = [];
    let turnId = null, limited = start > 0, boundary = 0;
    for (const line of lines) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const item = entry.payload || {};
      if (isUserInput(entry) || (entry.type === 'event_msg' && item.type === 'task_started')) boundary++;
      if (entry.type === 'event_msg' && item.type === 'task_started') turnId = item.turn_id || null;
      if (entry.type === 'event_msg' && item.type === 'task_complete' && item.turn_id && turnId && item.turn_id !== turnId) continue;
      let message = visibleMessage(entry);
      if (entry.type === 'event_msg' && item.type === 'task_complete' && typeof item.last_agent_message === 'string' && item.last_agent_message.trim()) {
        message = { role: 'assistant', text: item.last_agent_message.trim(), phase: 'final_answer', at: stamp(entry) };
        turnId = item.turn_id || turnId;
      }
      if (message?.role !== 'assistant') continue;
      const previous = replies.at(-1);
      const text = message.text.slice(0, 16384);
      const truncated = message.text.length > text.length;
      const hash = digest(message.text);
      if (previous?.hash === hash && previous.turnId === turnId && previous.boundary === boundary && (item.type === 'task_complete' || (message.at && previous.at && Math.abs(message.at - previous.at) < 2000))) {
        previous.phase = message.phase || previous.phase;
        continue;
      }
      replies.push({ id: message.id || `${turnId || 'recent'}:${message.at || 0}:${hash}`, turnId, at: message.at, phase: message.phase, text, truncated, hash, boundary });
      if (replies.length > 20) { replies.shift(); limited = true; }
      if (truncated) limited = true;
    }
    return { replies: replies.map(({ hash, boundary, ...reply }) => reply), limited };
  } finally { await file.close(); }
}
