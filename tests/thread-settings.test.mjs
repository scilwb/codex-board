import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readThreadSettings } from '../server/thread-settings.mjs';

const row = { model: 'gpt-6-sol', model_provider: 'openai', reasoning_effort: 'medium' };
const line = (type, payload) => JSON.stringify({ timestamp: '2026-09-29T01:00:00.000Z', type, payload }) + '\n';
function fixture(t, text) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-board-settings-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'rollout.jsonl');
  writeFileSync(path, text);
  return path;
}

test('newer native and turn records override each other per field without copying security settings', async t => {
  const path = fixture(t, [
    line('event_msg', { type: 'thread_settings_applied', thread_settings: {
      model: 'gpt-6-astra', model_provider_id: 'openai', reasoning_effort: 'high',
      collaboration_mode: { mode: 'plan', settings: { model: 'gpt-6-astra', reasoning_effort: 'high', developer_instructions: 'PRIVATE_DEVELOPER_TEXT' } },
      reasoning_summary: 'detailed', service_tier: 'priority',
      approval_policy: 'never', approvals_reviewer: 'user', sandbox_policy: { type: 'dangerFullAccess' },
      personality: 'friendly', disabled_plugin_ids: ['secret-plugin'], api_key: 'PRIVATE_API_KEY',
    } }),
    line('turn_context', { model: 'gpt-6-sol', effort: 'ultra', collaboration_mode: { mode: 'default' }, summary: 'none', service_tier: null, approval_policy: 'on-request' }),
    line('event_msg', { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6-astra', collaboration_mode: { mode: 'plan', settings: { developer_instructions: 'MORE_PRIVATE_TEXT' } } } }),
  ].join(''));
  const settings = await readThreadSettings({ rolloutPath: path, record: row });
  assert.deepEqual(settings, {
    model: 'gpt-6-astra', modelProvider: 'openai', reasoningEffort: 'ultra',
    collaborationMode: 'plan', summary: 'none', serviceTier: null,
  });
  assert.ok(!JSON.stringify(settings).includes('PRIVATE'));
  assert.ok(!JSON.stringify(settings).includes('secret-plugin'));
});

test('explicit null effort and tier survive while absent native fields preserve earlier values', async t => {
  const path = fixture(t, [
    line('turn_context', { model: 'gpt-6-sol', effort: 'xhigh', service_tier: 'priority', collaboration_mode: { mode: 'plan' } }),
    line('event_msg', { type: 'thread_settings_applied', thread_settings: { reasoning_effort: null, service_tier: null } }),
  ].join(''));
  assert.deepEqual(await readThreadSettings({ rolloutPath: path, record: row }), {
    model: 'gpt-6-sol', modelProvider: 'openai', reasoningEffort: null,
    serviceTier: null, collaborationMode: 'plan',
  });
});

test('unavailable rollout keeps only validated SQLite model and effort', async t => {
  const missing = join(mkdtempSync(join(tmpdir(), 'codex-board-settings-missing-')), 'missing.jsonl');
  t.after(() => rmSync(join(missing, '..'), { recursive: true, force: true }));
  assert.deepEqual(await readThreadSettings({ rolloutPath: missing, record: row }), {
    model: 'gpt-6-sol', modelProvider: 'openai', reasoningEffort: 'medium',
  });
  assert.deepEqual(await readThreadSettings({}), {});
});

test('invalid fields, unfinished lines, and oversized records cannot inject settings', async t => {
  const path = fixture(t,
    line('event_msg', { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6-astra', collaboration_mode: { mode: 'plan' } } }) +
    line('event_msg', { type: 'thread_settings_applied', thread_settings: {
      model: 'evil\nmodel', reasoning_effort: 'evil\neffort', collaboration_mode: { mode: 'analysis' }, reasoning_summary: 'private',
    } }) +
    line('response_item', { type: 'function_call_output', output: 'PRIVATE_TOOL'.repeat(35_000) }) +
    '{"type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"model":"unfinished'
  );
  assert.deepEqual(await readThreadSettings({ rolloutPath: path, record: row }), {
    model: 'gpt-6-astra', modelProvider: 'openai', reasoningEffort: 'medium', collaborationMode: 'plan',
  });
});

test('large rollout head settings never override a newer SQLite row when the tail has no settings', async t => {
  const path = fixture(t,
    line('session_meta', { model_provider: 'openai' }) +
    line('event_msg', { type: 'thread_settings_applied', thread_settings: {
      model: 'gpt-5.6-sol', reasoning_effort: 'xhigh', collaboration_mode: { mode: 'plan' }, reasoning_summary: 'detailed',
    } }) +
    line('turn_context', { model: 'gpt-5.6-sol', effort: 'xhigh', collaboration_mode: { mode: 'plan' } }) +
    line('response_item', { type: 'function_call_output', output: 'x'.repeat(3 * 1024 * 1024) }) +
    line('event_msg', { type: 'token_count', info: {} })
  );
  const settings = await readThreadSettings({ rolloutPath: path, record: {
    model: 'gpt-6-astra', model_provider: null, reasoning_effort: 'medium',
  } });
  assert.deepEqual(settings, { model: 'gpt-6-astra', modelProvider: 'openai', reasoningEffort: 'medium' });
});

test('bounded head and tail ignore old middle records and use the newest complete settings', async t => {
  const path = fixture(t,
    line('event_msg', { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6-astra', collaboration_mode: { mode: 'plan' } } }) +
    line('response_item', { type: 'function_call_output', output: 'x'.repeat(3 * 1024 * 1024) }) +
    line('turn_context', { model: 'gpt-6-sol', effort: 'high', collaboration_mode: { mode: 'default' } })
  );
  const settings = await readThreadSettings({ rolloutPath: path, record: row });
  assert.equal(settings.model, 'gpt-6-sol');
  assert.equal(settings.reasoningEffort, 'high');
  assert.equal(settings.collaborationMode, 'default');
  assert.equal(settings.modelProvider, 'openai');
});
