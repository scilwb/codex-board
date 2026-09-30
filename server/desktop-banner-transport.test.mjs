import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { launchDesktopBanner, BANNER_PYTHON, BANNER_HELPER } from './desktop-banner.mjs';

function processFixture() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = signal => { queueMicrotask(() => child.emit('close', null, signal)); return true; };
  let input = ''; child.stdin.on('data', chunk => { input += chunk; });
  return { child, input: () => JSON.parse(input), spawnProcess(file, args) {
    assert.equal(file, BANNER_PYTHON); assert.deepEqual(args, [BANNER_HELPER]); return child;
  } };
}
const payload = { title: '模型 <b>标题</b>', body: '', status: 'waiting', openable: true, durationMs: 25000 };

test('banner display acknowledgement and close are independent; title goes through stdin only', async () => {
  const fixture = processFixture(); let opened = 0;
  const banner = launchDesktopBanner(payload, { spawnProcess: fixture.spawnProcess, onOpen: () => { opened++; } });
  assert.deepEqual(fixture.input(), payload);
  fixture.child.stdout.write('{"event":"shown"}\n');
  assert.deepEqual(await banner.shown, { suppressed: false });
  fixture.child.stdout.write('{"event":"open"}\n{"event":"open"}\n');
  assert.equal(opened, 1);
  fixture.child.emit('close', 0);
  assert.equal((await banner.closed).error, null);
});

test('failed launch or missing display acknowledgement cannot report a displayed banner', async () => {
  const failed = processFixture();
  const banner = launchDesktopBanner(payload, { spawnProcess: failed.spawnProcess });
  failed.child.emit('error', new Error('missing interpreter'));
  await assert.rejects(banner.shown, /无法显示/);
  assert.ok((await banner.closed).error);
  const hung = processFixture();
  const waiting = launchDesktopBanner(payload, { spawnProcess: hung.spawnProcess, startupTimeoutMs: 10 });
  await assert.rejects(waiting.shown, /无法显示/);
  await waiting.closed;
});

test('do-not-disturb suppression is explicit and service shutdown aborts the popup', async () => {
  const fixture = processFixture(); const controller = new AbortController();
  const banner = launchDesktopBanner(payload, { spawnProcess: fixture.spawnProcess, signal: controller.signal });
  fixture.child.stdout.write('{"event":"suppressed"}\n');
  assert.equal((await banner.shown).suppressed, true);
  controller.abort();
  assert.equal((await banner.closed).aborted, true);
});
