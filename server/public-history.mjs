import { open } from 'node:fs/promises';
import { publicUserText, visibleMessage } from './activity.mjs';

export const PUBLIC_HISTORY_WINDOW_BYTES = 128 * 1024;
export const PUBLIC_HISTORY_MAX_MESSAGES = 20;
export const PUBLIC_HISTORY_MESSAGE_CHARS = 6_000;

const invalidOffset = () => Object.assign(new RangeError('历史记录字节偏移无效'), { status: 400 });

async function readExactly(file, start, length) {
  const buffer = Buffer.alloc(length);
  let count = 0;
  while (count < length) {
    const result = await file.read(buffer, count, length - count, start + count);
    if (!result.bytesRead) throw new Error('历史文件在读取期间发生变化，请重试');
    count += result.bytesRead;
  }
  return buffer;
}

function publicMessage(entry, currentTurnId) {
  const payload = entry?.payload;
  if (entry?.type === 'event_msg' && payload?.type === 'task_complete') {
    if (payload.turn_id && currentTurnId && payload.turn_id !== currentTurnId) return null;
    return typeof payload.last_agent_message === 'string' && payload.last_agent_message.trim()
      ? { role: 'assistant', phase: 'final_answer', text: payload.last_agent_message.trim() }
      : null;
  }
  const message = visibleMessage(entry);
  if (!message) return null;
  if (message.role === 'user') {
    const text = publicUserText(message.text);
    return text ? { role: 'user', phase: message.phase, text } : null;
  }
  return { role: message.role, phase: message.phase, text: message.text };
}

function boundedText(text) {
  const characters = Array.from(text);
  const truncated = characters.length > PUBLIC_HISTORY_MESSAGE_CHARS;
  return { text: truncated ? characters.slice(0, PUBLIC_HISTORY_MESSAGE_CHARS).join('') : text, truncated };
}

/**
 * Read a bounded window from a validated Codex rollout and return only public
 * user/assistant text. Offsets are bytes in the original JSONL file. A caller
 * should request nextOffset until hasMore is false; an unfinished EOF line is
 * withheld until Codex writes its newline.
 */
export async function readPublicHistory({ rolloutPath, offset = 0 }) {
  if (typeof rolloutPath !== 'string' || !rolloutPath) throw new TypeError('历史文件路径无效');
  if (!Number.isSafeInteger(offset) || offset < 0) throw invalidOffset();
  const file = await open(rolloutPath, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new TypeError('历史路径不是普通文件');
    const totalBytes = stat.size;
    if (offset > totalBytes) throw invalidOffset();
    const length = Math.min(PUBLIC_HISTORY_WINDOW_BYTES, totalBytes - offset);
    const data = await readExactly(file, offset, length);
    const endOffset = offset + data.length;
    let cursor = 0;
    let limited = false;
    let pendingEofLine = false;
    let nextOffset = offset;
    let turnId = null;
    const messages = [];

    if (offset && data.length) {
      const previous = await readExactly(file, offset - 1, 1);
      if (previous[0] !== 10) {
        const newline = data.indexOf(10);
        if (newline < 0) {
          return { messages, startOffset: offset, endOffset, nextOffset: endOffset,
            hasMore: endOffset < totalBytes, limited: true, totalBytes };
        }
        cursor = newline + 1;
        nextOffset = offset + cursor;
        limited = true;
      }
    }

    while (cursor < data.length) {
      if (messages.length >= PUBLIC_HISTORY_MAX_MESSAGES) { limited = true; break; }
      const end = data.indexOf(10, cursor);
      if (end < 0) {
        const lineStart = offset + cursor;
        limited = true;
        if (endOffset === totalBytes) {
          // A writer may still complete this final record later.
          nextOffset = lineStart;
          pendingEofLine = true;
        } else if (cursor === 0) {
          // The record itself is larger than our bounded window. Advance into
          // it so subsequent calls can eventually reach the next newline.
          nextOffset = endOffset;
        } else {
          // Retry this record at the start of the next bounded window.
          nextOffset = lineStart;
        }
        break;
      }

      const lineOffset = offset + cursor;
      const lineBytes = end - cursor;
      // Match handoff citations: the source record length includes its newline.
      const byteLength = lineBytes + 1;
      const line = data.subarray(cursor, end);
      cursor = end + 1;
      nextOffset = offset + cursor;
      if (!lineBytes) continue;
      let entry;
      try { entry = JSON.parse(line.toString('utf8')); }
      catch { limited = true; continue; }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { limited = true; continue; }
      if (entry.type === 'event_msg' && entry.payload?.type === 'task_started') turnId = entry.payload.turn_id || null;
      const message = publicMessage(entry, turnId);
      if (!message) continue;
      const bounded = boundedText(message.text);
      if (bounded.truncated) limited = true;
      messages.push({ role: message.role, phase: message.phase, text: bounded.text,
        offset: lineOffset, byteLength, truncated: bounded.truncated });
    }

    const hasMore = !pendingEofLine && nextOffset < totalBytes;
    if (hasMore) limited = true;
    return { messages, startOffset: offset, endOffset, nextOffset, hasMore, limited, totalBytes };
  } finally { await file.close(); }
}
