import { open } from 'node:fs/promises';

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 2 * 1024 * 1024;
const MAX_LINE_BYTES = 256 * 1024;
const token = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value) ? value : null;
const effort = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
const summary = value => ['auto', 'concise', 'detailed', 'none'].includes(value) ? value : null;
const has = (object, key) => object != null && Object.hasOwn(object, key);

async function readWindow(file, start, length) {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await file.read(buffer, filled, length - filled, start + filled);
    if (!bytesRead) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

function completeEntries(buffer, start) {
  const entries = [];
  let cursor = 0;
  if (start) {
    const newline = buffer.indexOf(10);
    if (newline < 0) return entries;
    cursor = newline + 1;
  }
  for (let end; (end = buffer.indexOf(10, cursor)) !== -1; cursor = end + 1) {
    const line = buffer.subarray(cursor, end);
    if (!line.length || line.length > MAX_LINE_BYTES) continue;
    try {
      const value = JSON.parse(line.toString('utf8'));
      if (value && typeof value === 'object' && !Array.isArray(value)) entries.push(value);
    } catch { /* In-progress or malformed records do not contribute settings. */ }
  }
  return entries;
}

function assignToken(result, key, value) {
  const safe = token(value);
  if (safe) result[key] = safe;
}

function assignNullable(result, key, value, validate) {
  if (value === null) result[key] = null;
  else {
    const safe = validate(value);
    if (safe) result[key] = safe;
  }
}

function applyRecord(result, record) {
  if (!record || typeof record !== 'object') return;
  assignToken(result, 'model', record.model);
  assignToken(result, 'modelProvider', record.model_provider ?? record.modelProvider);
  const value = record.reasoning_effort ?? record.reasoningEffort;
  const safe = effort(value);
  if (safe) result.reasoningEffort = safe;
}

function applyNative(result, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  if (has(value, 'model')) assignToken(result, 'model', value.model);
  if (has(value, 'model_provider_id')) assignToken(result, 'modelProvider', value.model_provider_id);
  if (has(value, 'reasoning_effort')) assignNullable(result, 'reasoningEffort', value.reasoning_effort, effort);
  if (has(value, 'service_tier')) assignNullable(result, 'serviceTier', value.service_tier, token);
  if (has(value, 'reasoning_summary')) assignNullable(result, 'summary', value.reasoning_summary, summary);
  if (has(value, 'collaboration_mode')) {
    const mode = value.collaboration_mode?.mode ?? value.collaboration_mode;
    if (mode === 'default' || mode === 'plan') result.collaborationMode = mode;
  }
}

function applyTurnContext(result, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  if (has(value, 'model')) assignToken(result, 'model', value.model);
  if (has(value, 'model_provider_id')) assignToken(result, 'modelProvider', value.model_provider_id);
  if (has(value, 'effort')) assignNullable(result, 'reasoningEffort', value.effort, effort);
  if (has(value, 'service_tier')) assignNullable(result, 'serviceTier', value.service_tier, token);
  if (has(value, 'summary')) assignNullable(result, 'summary', value.summary, summary);
  if (has(value, 'collaboration_mode')) {
    const mode = value.collaboration_mode?.mode ?? value.collaboration_mode;
    if (mode === 'default' || mode === 'plan') result.collaborationMode = mode;
  }
}

/**
 * Read only explicit model-facing settings from a validated rollout and its
 * SQLite row. A bounded head/tail view means absent fields are unknown, not
 * defaults. Native records are applied in file order so the newest value for
 * each field wins. Security settings and developer instructions are excluded.
 */
export async function readThreadSettings({ rolloutPath, record } = {}) {
  const result = {};
  applyRecord(result, record);
  if (typeof rolloutPath !== 'string' || !rolloutPath) return result;
  let file;
  try { file = await open(rolloutPath, 'r'); }
  catch { return result; }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || !stat.size) return result;
    const split = stat.size > HEAD_BYTES + TAIL_BYTES;
    const windows = split
      ? [{ start: 0, length: HEAD_BYTES, kind: 'head' }, { start: stat.size - TAIL_BYTES, length: TAIL_BYTES, kind: 'tail' }]
      : [{ start: 0, length: stat.size, kind: 'whole' }];
    for (const window of windows) {
      for (const entry of completeEntries(await readWindow(file, window.start, window.length), window.start)) {
        if (window.kind === 'head') {
          // A bounded head record can be arbitrarily older than SQLite. It
          // must not overwrite current model, effort, or mode. Session origin
          // metadata may fill a missing provider only.
          if (entry.type === 'session_meta' && !has(result, 'modelProvider')) {
            assignToken(result, 'modelProvider', entry.payload?.model_provider);
          }
          continue;
        }
        if (entry.type === 'event_msg' && entry.payload?.type === 'thread_settings_applied') applyNative(result, entry.payload.thread_settings);
        else if (entry.type === 'turn_context') applyTurnContext(result, entry.payload);
      }
    }
    return result;
  } finally { await file.close(); }
}
