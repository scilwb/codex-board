import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { GitBranches } from '../server/git.mjs';
import { createServer } from '../server/index.mjs';
import { makeFixture } from './fixture.mjs';

test('Git 查询合并重复请求，缓存到期更新，并限制并发与缓存大小', async () => {
  let now = 0, count = 0, running = 0, peak = 0;
  const releases = [];
  const branches = new GitBranches({ now: () => now, ttlMs: 30, maxEntries: 2, concurrency: 2, read: async cwd => {
    count++; running++; peak = Math.max(peak, running);
    await new Promise(resolve => releases.push(resolve));
    running--;
    return cwd.slice(1) + count;
  } });
  const first = branches.get('/first');
  assert.equal(branches.get('/first'), first);
  const second = branches.get('/second');
  const third = branches.get('/third');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(count, 2);
  releases.splice(0).forEach(release => release());
  const previous = await first;
  await second;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await branches.get('/first'), previous);
  releases.splice(0).forEach(release => release());
  await third;
  assert.equal(peak, 2);
  assert.equal(branches.cache.size, 2);
  now = 31;
  const refresh = branches.get('/first');
  await new Promise(resolve => setImmediate(resolve));
  releases.splice(0).forEach(release => release());
  assert.notEqual(await refresh, previous);
  assert.equal(branches.pending.size, 0);
});

test('Git 出错缓存空分支，过期后可恢复；慢文件夹查询不阻塞快照', async t => {
  let now = 0, broken = true;
  const branches = new GitBranches({ now: () => now, ttlMs: 30, read: async () => { if (broken) throw new Error('git timeout'); return 'main'; } });
  assert.equal(await branches.get('/repo'), null);
  broken = false;
  assert.equal(await branches.get('/repo'), null);
  now = 31;
  assert.equal(await branches.get('/repo'), 'main');
  const fixture = makeFixture();
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const slow = new Promise(resolve => { release = resolve; });
  const server = createServer({ ...fixture, disableActions: true, branches: { async get() { entered(); return slow; } } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    release('main');
    server.board.closeStreams();
    const closed = once(server, 'close');
    server.close(); server.closeAllConnections(); await closed; fixture.cleanup();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const folders = fetch(base + '/api/folders');
  await started;
  const snapshot = await fetch(base + '/api/snapshot', { signal: AbortSignal.timeout(2000) });
  assert.equal(snapshot.status, 200);
  assert.equal((await snapshot.json()).threads.length, 3);
  release('main');
  assert.equal((await (await folders).json()).projects[0].branch, 'main');
});
