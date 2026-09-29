import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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

test('App Server 交接等待进程退出，返回后其他进程可立即取得写锁', { timeout: 5000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-board-writer-release-'));
  const binary = join(directory, 'fake-codex');
  const lock = join(directory, 'writer.lock');
  writeFileSync(binary, `#!/usr/bin/env node
const { createInterface } = require('node:readline');
const { openSync, closeSync, unlinkSync } = require('node:fs');
const { join } = require('node:path');
const lock = join(process.env.CODEX_HOME, 'writer.lock');
let writer;
setInterval(() => {}, 1000);
process.on('exit', () => {
  if (writer === undefined) return;
  closeSync(writer);
  unlinkSync(lock);
});
process.on('SIGTERM', () => setTimeout(() => process.exit(0), 180));
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  let response;
  try {
    if (message.method === 'writer/claim') writer = openSync(lock, 'wx');
    response = { id: message.id, result: { pid: process.pid } };
  } catch {
    response = { id: message.id, error: { code: -32000, message: 'already has an active writer' } };
  }
  process.stdout.write(JSON.stringify(response) + '\\n');
});
`, { mode: 0o700 });
  const first = new AppServerClient({ codexHome: directory, binary, idleTimeoutMs: 0 });
  const successor = new AppServerClient({ codexHome: directory, binary, idleTimeoutMs: 0 });
  try {
    await first.request('writer/claim', {});
    await successor.ready();
    const child = first.child;
    let exited = false;
    let resolved = false;
    child.once('exit', () => { exited = true; });
    const stopping = first.stopAndWait().then(() => { resolved = true; });

    await delay(40);
    assert.equal(resolved, false, 'handoff cannot finish while shutdown is pending');
    assert.equal(exited, false, 'the original writer is still alive');
    assert.equal(existsSync(lock), true, 'writer ownership survives unsubscribe/shutdown initiation');
    await assert.rejects(successor.request('writer/claim', {}), /active writer/);

    await stopping;
    assert.equal(exited, true, 'handoff resolves only after the child exit event');
    assert.equal(existsSync(lock), false, 'original writer released its lock');
    assert.equal((await successor.request('writer/claim', {})).pid, successor.child.pid);
  } finally {
    await Promise.all([first.stopAndWait(), successor.stopAndWait()]);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('App Server 不响应 SIGTERM 时交接会限时强制退出', { timeout: 3000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-board-force-stop-'));
  const binary = join(directory, 'fake-codex');
  writeFileSync(binary, `#!/usr/bin/env node
const { createInterface } = require('node:readline');
setInterval(() => {}, 1000);
process.on('SIGTERM', () => {});
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n');
});
`, { mode: 0o700 });
  const client = new AppServerClient({ codexHome: directory, binary, idleTimeoutMs: 0 });
  try {
    await client.ready();
    const child = client.child;
    await client.stopAndWait({ graceMs: 50, timeoutMs: 1000 });
    assert.equal(child.signalCode, 'SIGKILL', 'unresponsive child is killed after the grace period');
    assert.equal(client.child, null);
    assert.equal(client.pending.size, 0);
  } finally {
    await client.stopAndWait({ graceMs: 50, timeoutMs: 1000 });
    rmSync(directory, { recursive: true, force: true });
  }
});
