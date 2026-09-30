import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const python = '/usr/bin/python3';
const helper = fileURLToPath(new URL('./desktop-banner.py', import.meta.url));
const available = existsSync(python);

function evaluate(lines) {
  const source = ['import io, json, runpy', 'module = runpy.run_path(' + JSON.stringify(helper) + ')', ...lines].join('\n');
  return execFileSync(python, ['-c', source], { encoding: 'utf8' }).trim();
}

test('large desktop banner validates and bounds its payload without importing GTK or showing a window', { skip: !available }, () => {
  const result = JSON.parse(evaluate([
    "payload = module['read_payload'](io.BytesIO(json.dumps({'status':'waiting','title':'标题\\n' * 400,'body':'内容' * 200,'durationMs':999999,'openable':True}).encode()))",
    'print(json.dumps(payload))',
  ]));
  assert.equal(result.status, 'waiting');
  assert.equal(result.title.length, 240);
  assert.ok(!result.title.includes('\n'));
  assert.equal(result.body.length, 120);
  assert.equal(result.durationMs, 120000);
  assert.equal(result.openable, true);
});

test('large desktop banner defaults durations and treats button visibility as a boolean', { skip: !available }, () => {
  const result = JSON.parse(evaluate([
    "rows = [module['read_payload'](io.BytesIO(json.dumps({'status':status,'openable':'yes'}).encode())) for status in ['waiting','completed','test']]",
    'print(json.dumps(rows))',
  ]));
  assert.deepEqual(result.map(row => row.durationMs), [25000, 18000, 12000]);
  assert.ok(result.every(row => row.title === '未命名对话' && row.body === '' && row.openable === false));
});

test('large desktop banner rejects malformed and oversized input without echoing private content', { skip: !available }, () => {
  assert.equal(evaluate([
    'rejected = 0',
    'for raw in [b\'{private secret\', b\'[]\', b\'{}\', b\'{"status":"unknown"}\', b\'{"status":"waiting","durationMs":true}\', b\' \' * 32769]:',
    '    try:',
    "        module['read_payload'](io.BytesIO(raw))",
    '    except (ValueError, TypeError):',
    '        rejected += 1',
    'print(rejected)',
  ]), '6');
  let error;
  try {
    execFileSync(python, [helper], { input: 'private secret', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (caught) { error = caught; }
  assert.equal(error.status, 1);
  assert.equal(error.stdout, '');
  assert.match(error.stderr, /Desktop banner unavailable/);
  assert.ok(!error.stderr.includes('private secret'));
});

test('large desktop banner checks GNOME notification settings read-only and honors Do Not Disturb', { skip: !available }, () => {
  const result = JSON.parse(evaluate([
    'from types import SimpleNamespace',
    'def gio(show):',
    '    schema = SimpleNamespace(has_key=lambda key: True)',
    '    source = SimpleNamespace(lookup=lambda name, recursive: schema)',
    '    return SimpleNamespace(SettingsSchemaSource=SimpleNamespace(get_default=lambda:source), Settings=SimpleNamespace(new_full=lambda *args:SimpleNamespace(get_boolean=lambda key:show)))',
    "print(json.dumps([module['notifications_muted'](gio(True)),module['notifications_muted'](gio(False)),module['notifications_muted'](SimpleNamespace())]))",
  ]));
  assert.deepEqual(result, [false, true, false]);
});
