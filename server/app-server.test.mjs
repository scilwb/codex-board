import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AppServerClient } from './app-server.mjs';

test('App Server 空闲释放、按需重启，旧进程退出不会中断新请求', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-board-app-server-'));
  const binary = join(directory, 'fake-codex');
  // Delayed shutdown reproduces an old child exiting after its replacement has
  // started. A real protocol request stays pending throughout that race.
  writeFileSync(binary, `#!/usr/bin/env node
const { createInterface } = require('node:readline');
setInterval(() => {}, 1000);
process.on('SIGTERM', () => setTimeout(() => process.exit(0), 120));
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  setTimeout(() => process.stdout.write(JSON.stringify({ id: message.id, result: { pid: process.pid, method: message.method } }) + '\\n'), message.params?.delayMs || 0);
});
`, { mode: 0o700 });
  const client = new AppServerClient({ codexHome: directory, binary, timeoutMs: 2000, idleTimeoutMs: 40 });
  try {
    const first = await client.request('read', {});
    assert.equal(first.pid, client.child.pid);
    await delay(70);
    assert.equal(client.child, null, 'metadata process released after idle interval');

    const second = await client.request('read', {});
    assert.notEqual(second.pid, first.pid, 'a new process starts only when requested');
    const replacement = client.child;
    const pending = client.request('slow/read', { delayMs: 220 });
    await delay(150);
    assert.equal(client.child, replacement, 'old process exit does not clear its replacement');
    assert.equal(client.pending.size, 1, 'idle timer does not cancel an active request');
    assert.equal((await pending).pid, second.pid);

    await delay(70);
    assert.equal(client.child, null);
    assert.equal(client.idleTimer, null);
  } finally {
    client.stop();
    await delay(150);
    rmSync(directory, { recursive: true, force: true });
  }
});
