import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DesktopNotifications } from './desktop-notifications.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const thread = (status, eventKey, at, extras = {}) => ({ id: 'thread-a', title: '夹爪建模', status,
  activity: { eventKey, at, stale: false }, ...extras });

function fixture(t, options = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'codex-board-notifications-'));
  const calls = [];
  const sends = [];
  const run = async (file, args, configuration) => {
    calls.push({ file, args, configuration });
    if (file === '/usr/bin/python3') return { stdout: options.largeBanner ? JSON.stringify({ available: true, backend: 'gtk3' }) : '{}' };
    if (file === 'notify-send' && args[0] === '--help') return { stdout: options.actions ? '--action=NAME=TEXT --wait' : '--urgency --expire-time' };
    if (file === 'gdbus') return { stdout: "(['actions', 'body', 'body-markup'],)" };
    sends.push({ file, args, configuration });
    return options.deliver ? options.deliver(file, args, configuration) : { stdout: '' };
  };
  let now = 100;
  const service = new DesktopNotifications({ dataDir, run, now: () => now, platform: 'linux', ...options });
  t.after(() => { service.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return { service, dataDir, calls, sends, setNow: value => { now = value; } };
}

test('desktop notifications are opt-in, persist securely and probe without sending', async t => {
  const { service, dataDir, calls, sends } = fixture(t);
  assert.equal(service.status().enabled, false);
  assert.equal(service.status().available, null);
  assert.deepEqual(await service.ready(), { enabled: false, available: true, supportsActions: false, presentation: 'system', lastError: null });
  assert.equal(calls.length, 3);
  assert.equal(sends.length, 0);
  service.setEnabled(true);
  const path = join(dataDir, 'desktop-notifications.json');
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { enabled: true });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const restored = new DesktopNotifications({ dataDir, run: async () => ({ stdout: '' }) });
  assert.equal(restored.status().enabled, true);
  restored.close();
  assert.throws(() => service.setEnabled('yes'), /布尔值/);
});

test('first snapshot stays silent and new waiting/completed events each notify once', async t => {
  const { service, sends, setNow } = fixture(t);
  await service.ready();
  service.setEnabled(true);
  service.observe([thread('completed', 'old', 90)]);
  setNow(110);
  service.observe([thread('active', 'start', 110)]);
  setNow(120);
  service.observe([thread('waiting', 'question', 120)]);
  service.observe([thread('waiting', 'question', 120)]);
  setNow(130);
  service.observe([thread('completed', 'done', 130)]);
  service.observe([thread('waiting', 'question', 120)]);
  service.observe([thread('completed', 'archived', 140, { archived: true })]);
  await tick();
  assert.equal(sends.length, 2);
  assert.ok(sends[0].args.includes('Codex 需要你回答'));
  assert.ok(sends[1].args.includes('Codex 本轮已结束'));
  assert.ok(sends.every(send => send.file === 'notify-send'));
  assert.ok(sends.every(send => !send.args.some(arg => arg.startsWith('--action'))));
});

test('muted observations are remembered and enabling does not replay them', async t => {
  const { service, sends, setNow } = fixture(t);
  await service.ready();
  service.observe([thread('active', 'start', 100)]);
  setNow(120);
  service.observe([thread('waiting', 'muted', 120)]);
  service.setEnabled(true);
  service.observe([thread('waiting', 'muted', 120)]);
  await tick();
  assert.equal(sends.length, 0);
  setNow(130);
  service.observe([thread('completed', 'new', 130)]);
  await tick();
  assert.equal(sends.length, 1);
});

test('notification text is bounded plain markup-safe text and never interpreted as CLI options', async t => {
  const { service, sends, setNow } = fixture(t);
  await service.ready();
  service.setEnabled(true);
  service.observe([]);
  setNow(110);
  service.observe([thread('waiting', 'new', 110, { title: '--help <b>$(touch /tmp/unsafe)</b>&\n' + '长'.repeat(300) })]);
  await tick();
  const { args, configuration } = sends[0];
  assert.equal(args.at(-3), '--');
  assert.match(args.at(-1), /&lt;b&gt;\$\(touch \/tmp\/unsafe\)&lt;\/b&gt;&amp;/);
  assert.ok(args.at(-1).length < 240);
  assert.equal(configuration.timeout, 4000);
  assert.ok(configuration.signal instanceof AbortSignal);
});

test('supported notification action opens only its associated thread', async t => {
  const opened = [];
  const { service, sends, setNow } = fixture(t, { actions: true, onOpen: async id => opened.push(id),
    deliver: async () => ({ stdout: 'open\n' }) });
  assert.equal((await service.ready()).supportsActions, true);
  service.setEnabled(true);
  service.observe([]);
  setNow(110);
  service.observe([thread('completed', 'new', 110)]);
  await tick();
  assert.deepEqual(opened, ['thread-a']);
  assert.ok(sends[0].args.includes('--action=open=打开对话'));
  assert.equal(sends[0].configuration.timeout, 20000);
  await service.test();
  assert.ok(!sends[1].args.some(arg => arg.startsWith('--action')));
  assert.deepEqual(opened, ['thread-a']);
});

test('test notification delivers while disabled and reports send failures', async t => {
  let failing = false;
  const { service, sends } = fixture(t, { deliver: async () => {
    if (failing) throw new Error('No desktop session');
    return { stdout: '' };
  } });
  await service.test();
  assert.equal(service.status().enabled, false);
  assert.equal(sends.length, 1);
  assert.ok(sends[0].args.includes('Codex Board · 桌面提醒测试'));
  failing = true;
  await assert.rejects(service.test(), /发送失败/);
  assert.match(service.status().lastError, /发送失败/);
  failing = false;
  await service.test();
  assert.equal(service.status().lastError, null);
});

test('missing notify-send or unavailable DBus produces meaningful status and tests retry detection', async t => {
  for (const target of ['notify-send', 'gdbus']) {
    let callCount = 0;
    const { service } = fixture(t, { run: async file => {
      callCount += 1;
      if (file === target) throw Object.assign(new Error('unavailable'), { code: target === 'notify-send' ? 'ENOENT' : 1 });
      return { stdout: '--help' };
    } });
    assert.equal((await service.ready()).available, false);
    await service.ready();
    assert.equal(callCount, target === 'notify-send' ? 2 : 3);
    await assert.rejects(service.test(), target === 'notify-send' ? /notify-send/ : /桌面会话/);
    await service.ready();
    assert.equal(callCount, target === 'notify-send' ? 4 : 6);
  }
});

test('desktop service becoming ready after startup recovers on test or later observations', async t => {
  let online = false;
  let sends = 0;
  const { service, setNow } = fixture(t, { run: async (file, args) => {
    if (file === 'gdbus' && !online) throw new Error('desktop starting');
    if (file === 'notify-send' && args[0] !== '--help') sends += 1;
    return { stdout: '' };
  } });
  assert.equal((await service.ready()).available, false);
  online = true;
  await service.test();
  assert.equal(service.status().available, true);
  assert.equal(service.status().lastError, null);
  assert.equal(sends, 1);

  const delayed = fixture(t, { run: async file => {
    if (file === 'gdbus' && !online) throw new Error('desktop starting');
    return { stdout: '' };
  } });
  online = false;
  assert.equal((await delayed.service.ready()).available, false);
  delayed.service.setEnabled(true);
  await delayed.service.ready();
  online = true;
  delayed.setNow(30101);
  delayed.service.observe([]);
  await delayed.service.ready();
  assert.equal(delayed.service.status().available, true);
});

test('missing optional gdbus CLI does not block a working notify-send', async t => {
  const { service } = fixture(t, { run: async file => {
    if (file === 'gdbus') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return { stdout: '' };
  } });
  assert.equal((await service.ready()).available, true);
  await service.test();
});

test('corrupt settings default off and failed persistence leaves the previous enabled state', async t => {
  const { service, dataDir } = fixture(t);
  await service.ready();
  service.close();
  const path = join(dataDir, 'desktop-notifications.json');
  writeFileSync(path, '{broken');
  const recovered = new DesktopNotifications({ dataDir, run: async () => ({ stdout: '' }) });
  t.after(() => recovered.close());
  assert.equal(recovered.status().enabled, false);
  assert.match(recovered.status().lastError, /无法读取/);
  recovered.setEnabled(true);
  assert.equal(recovered.status().lastError, null);
  rmSync(path);
  mkdirSync(path);
  assert.throws(() => recovered.setEnabled(false));
  assert.equal(recovered.status().enabled, true);
});

test('notification delivery concurrency and queue are bounded; disabling drops queued notices', async t => {
  const pending = [];
  const { service, sends, setNow } = fixture(t, { maxConcurrent: 2, maxQueue: 3, deliver: () =>
    new Promise(resolve => pending.push(resolve)) });
  await service.ready();
  service.setEnabled(true);
  service.observe([]);
  setNow(110);
  service.observe(Array.from({ length: 8 }, (_, index) => thread('completed', 'done', 110, { id: `thread-${index}` })));
  await tick();
  assert.equal(sends.length, 2);
  assert.equal(service.queue.length, 1);
  service.setEnabled(false);
  pending.forEach(resolve => resolve({ stdout: '' }));
  await tick();
  assert.equal(sends.length, 2);
  assert.equal(service.active, 0);
});

test('close aborts outstanding native processes and prevents future sends', async t => {
  let pendingSignal;
  const { service, sends, setNow } = fixture(t, { deliver: (file, args, { signal }) => new Promise((resolve, reject) => {
    pendingSignal = signal;
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  }) });
  await service.ready();
  service.setEnabled(true);
  service.observe([]);
  setNow(110);
  service.observe([thread('completed', 'done', 110)]);
  await tick();
  service.close();
  assert.equal(pendingSignal.aborted, true);
  await tick();
  await assert.rejects(service.test(), /已关闭/);
  service.observe([thread('completed', 'done-2', 120)]);
  await tick();
  assert.equal(sends.length, 1);
  assert.equal(service.controllers.size, 0);
});

test('large banners use readable hierarchy, one banner at a time, and a click opens the correct thread', async t => {
  const banners = [], opened = [];
  const { service, sends, setNow } = fixture(t, { largeBanner: true, onOpen: id => opened.push(id),
    launchBanner(payload, options) {
      let close;
      const closed = new Promise(resolve => { close = resolve; });
      banners.push({ payload, options, close });
      return { shown: Promise.resolve({ suppressed: false }), closed };
    } });
  assert.equal((await service.ready()).presentation, 'large-banner');
  service.setEnabled(true); service.observe([]); setNow(110);
  service.observe([thread('waiting', 'ask', 110), thread('completed', 'done', 110, { id: 'thread-b', title: '电机测试' })]);
  await tick();
  assert.equal(banners.length, 1, 'banners must not overlap');
  assert.deepEqual(banners[0].payload, { status: 'waiting', title: '夹爪建模', body: '', durationMs: 25000, openable: true });
  banners[0].options.onOpen(); await tick(); assert.deepEqual(opened, ['thread-a']);
  banners[0].close({}); await tick();
  assert.equal(banners.length, 2);
  assert.equal(banners[1].payload.status, 'completed');
  assert.equal(banners[1].payload.durationMs, 18000);
  assert.equal(sends.length, 0, 'large mode must not also emit a small duplicate system popup');
  banners[1].close({}); await tick();
  assert.equal(service.controllers.size, 0);
});

test('banner test responds after display rather than after timeout; closing the service aborts it', async t => {
  let show, close, signal;
  const { service } = fixture(t, { largeBanner: true, launchBanner(payload, options) {
    signal = options.signal;
    const shown = new Promise(resolve => { show = resolve; });
    const closed = new Promise(resolve => { close = resolve; });
    signal.addEventListener('abort', () => close({ aborted: true }));
    assert.equal(payload.openable, false);
    return { shown, closed };
  } });
  await service.ready();
  let returned = false;
  const testing = service.test().then(() => { returned = true; });
  await tick(); assert.equal(returned, false);
  show({}); await testing;
  assert.equal(service.bannerVisible, true);
  await assert.rejects(service.test(), /正在显示/);
  service.close(); await tick();
  assert.equal(signal.aborted, true);
  assert.equal(service.controllers.size, 0);
});

test('banner test explains do-not-disturb suppression', async t => {
  const { service } = fixture(t, { largeBanner: true, launchBanner: () => ({
    shown: Promise.resolve({ suppressed: true }), closed: Promise.resolve({}),
  }) });
  await assert.rejects(service.test(), /勿扰/);
});

test('answering or muting while a banner starts cancels it without a false delivery error', async t => {
  const { service, setNow } = fixture(t, { largeBanner: true, launchBanner(payload, { signal }) {
    let rejectShown, close;
    const shown = new Promise((_, reject) => { rejectShown = reject; });
    const closed = new Promise(resolve => { close = resolve; });
    signal.addEventListener('abort', () => { rejectShown(new Error('window was cancelled')); close({ aborted: true }); });
    return { shown, closed };
  } });
  await service.ready(); service.setEnabled(true); service.observe([]); setNow(110);
  service.observe([thread('waiting', 'question', 110)]); await tick();
  assert.equal(service.bannerVisible, true);
  service.observe([thread('active', 'answer', 120)]); await tick();
  assert.equal(service.bannerVisible, false);
  assert.equal(service.status().lastError, null);
});
