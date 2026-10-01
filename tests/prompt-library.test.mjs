import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { PromptLibrary, PROMPT_LIMITS } from '../server/prompt-library.mjs';
import { createServer } from '../server/index.mjs';
import { makeFixture } from './fixture.mjs';

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'codex-board-prompts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  return { root, dataDir, library: new PromptLibrary({ dataDir }) };
}

const input = (overrides = {}) => ({ id: randomUUID(), title: '代码复查', content: '请核查关键路径。', ...overrides });
const status = (expected, pattern) => error => error.status === expected && (!pattern || pattern.test(error.message));

test('提示词：首次读取不写文件，保存精确保留格式，重启可读且权限为 0600', t => {
  const { library, dataDir } = setup(t);
  assert.deepEqual(library.list(), { version: 1, prompts: [] });
  assert.equal(existsSync(dataDir), false);
  const content = '  请检查 /home/zxcx/Projects/umi\r\n\n    继续工作\n\t';
  const saved = library.create(input({ title: '  本地工作  ', content, tags: ['代码', '代码', ' 路径 '], pinned: true })).prompt;
  assert.equal(saved.content, content);
  assert.equal(saved.title, '本地工作');
  assert.deepEqual(saved.tags, ['代码', '路径']);
  assert.equal(saved.revision, 1);
  assert.equal(statSync(library.path).mode & 0o777, 0o600);
  assert.deepEqual(new PromptLibrary({ dataDir }).list().prompts, [saved]);
  assert.deepEqual(readdirSync(dataDir), ['prompts.json']);
});

test('提示词：客户端 ID 使重复保存幂等，不同内容不能覆盖相同 ID', t => {
  const { library } = setup(t);
  const value = input({ id: 'ABCDEFAB-1234-4234-8234-ABCDEFABCDEF' });
  const first = library.create(value).prompt;
  const raw = readFileSync(library.path, 'utf8');
  assert.equal(first.id, value.id.toLowerCase());
  assert.deepEqual(library.create(value).prompt, first);
  assert.equal(readFileSync(library.path, 'utf8'), raw);
  assert.equal(existsSync(library.backupPath), false);
  assert.throws(() => library.create({ ...value, content: '另一份内容' }), status(409));
  assert.equal(library.list().prompts.length, 1);
});

test('提示词：独立服务实例使用磁盘当前版本，拒绝陈旧编辑和删除', t => {
  const { library, dataDir } = setup(t);
  const second = new PromptLibrary({ dataDir });
  const original = library.create(input()).prompt;
  assert.equal(second.list().prompts[0].revision, 1);
  const edited = library.update(original.id, { revision: 1, title: '修复后复查' }).prompt;
  assert.equal(edited.revision, 2);
  assert.throws(() => second.update(original.id, { revision: 1, content: '陈旧覆盖' }), status(409));
  assert.throws(() => second.delete(original.id, { revision: 1 }), status(409));
  assert.equal(second.list().prompts[0].title, '修复后复查');
  const updated = second.update(original.id, { revision: 2, pinned: true }).prompt;
  assert.equal(updated.revision, 3);
  assert.equal(library.list().prompts[0].pinned, true);
  assert.deepEqual(library.delete(original.id, { revision: 3 }), { ok: true });
  assert.deepEqual(second.list().prompts, []);
  assert.throws(() => second.update(original.id, { revision: 3, title: '被删除后修改' }), status(404));
});

test('提示词：编辑需要版本，无修改不会无谓增加版本', t => {
  const { library } = setup(t);
  const saved = library.create(input()).prompt;
  for (const body of [{ title: '标题' }, { revision: 0, title: '标题' }, { revision: 1 }, { revision: 1, ignored: true }]) {
    assert.throws(() => library.update(saved.id, body), status(400));
  }
  assert.deepEqual(library.update(saved.id, { revision: 1, title: saved.title }).prompt, saved);
  assert.equal(existsSync(library.backupPath), false);
});

test('提示词：严格验证文本、标签、标志和集合边界，拒绝操作不落盘', t => {
  const { library, dataDir } = setup(t);
  const invalid = [
    { id: 'bad' }, { title: ' ' }, { title: 'a'.repeat(101) }, { content: '\n ' },
    { content: 'a'.repeat(60001) }, { tags: null }, { tags: ['a'.repeat(25)] },
    { tags: Array.from({ length: 9 }, (_, i) => `标签${i}`) }, { pinned: 'true' }, { extra: true },
  ];
  for (const value of invalid) assert.throws(() => library.create(input(value)), status(400));
  assert.equal(existsSync(dataDir), false);
  const accepted = library.create(input({ title: 'a'.repeat(100), content: 'a'.repeat(60000), tags: Array.from({ length: 8 }, (_, i) => String(i).repeat(24)) })).prompt;
  assert.equal(accepted.content.length, 60000);
});

test('提示词：导入按完整标题和内容去重，ID 冲突生成新 ID，现有内容不会被覆盖', t => {
  const { library } = setup(t);
  const existing = library.create(input({ pinned: true, tags: ['原有'] })).prompt;
  const result = library.import({ version: 1, prompts: [
    { ...existing, id: randomUUID(), pinned: false, tags: ['导入'] },
    { ...existing, title: '新提示词', content: '  多行\n\n内容\n', revision: 12 },
    input({ title: '新提示词', content: '  多行\n\n内容\n' }),
  ] });
  assert.equal(result.imported, 1);
  assert.equal(result.skipped, 2);
  assert.equal(result.prompts.length, 2);
  assert.deepEqual(result.prompts[0], existing);
  assert.notEqual(result.prompts[1].id, existing.id);
  assert.equal(result.prompts[1].revision, 1);
  assert.equal(result.prompts[1].content, '  多行\n\n内容\n');
  assert.equal(library.import(library.list()).imported, 0);
});

test('提示词：导入先完整验证，坏记录和超过条目限制不会部分保存', t => {
  const { library } = setup(t);
  library.create(input());
  const before = readFileSync(library.path, 'utf8');
  const badImports = [
    { version: 2, prompts: [] }, { version: 1, prompts: [input(), input({ content: '' })] },
    { version: 1, prompts: [input({ createdAt: 'today' })] },
    { version: 1, prompts: [input({ updatedAt: Number.MAX_SAFE_INTEGER })] },
    { version: 1, prompts: [input({ createdAt: 8_640_000_000_000_001 })] },
    { version: 1, prompts: [input({ revision: 0 })] },
    { version: 1, prompts: [input({ id: 'abcdefab-1234-4234-8234-abcdefabcdef' }), input({ id: 'ABCDEFAB-1234-4234-8234-ABCDEFABCDEF' })] },
    { version: 1, prompts: Array.from({ length: 501 }, () => input()) },
  ];
  for (const value of badImports) assert.throws(() => library.import(value), status(400));
  assert.equal(readFileSync(library.path, 'utf8'), before);
  assert.equal(existsSync(library.backupPath), false);
  const full = { version: 1, prompts: Array.from({ length: 500 }, (_, i) => input({ title: `提示词 ${i}` })) };
  assert.throws(() => library.import(full), status(413));
  assert.equal(readFileSync(library.path, 'utf8'), before);
});

test('提示词：日期上界导入后编辑仍可读取，不会触发备份回退丢失编辑', t => {
  const { library, dataDir } = setup(t);
  const maximumDate = 8_640_000_000_000_000;
  const imported = library.import({ version: 1, prompts: [input({ createdAt: maximumDate, updatedAt: maximumDate })] }).prompts[0];
  const edited = library.update(imported.id, { revision: 1, title: '日期上界仍保存编辑' }).prompt;
  assert.equal(edited.updatedAt, maximumDate);
  assert.equal(edited.revision, 2);
  assert.deepEqual(library.list().prompts, [edited]);
  assert.deepEqual(new PromptLibrary({ dataDir }).list().prompts, [edited]);
  assert.equal(JSON.parse(readFileSync(library.path, 'utf8')).prompts[0].title, edited.title);
});

test('提示词：按 UTF-8 总字节限制整个导入事务', t => {
  const { library } = setup(t);
  library.create(input());
  const before = readFileSync(library.path, 'utf8');
  const prompts = Array.from({ length: 24 }, (_, i) => input({ title: `长提示词 ${i}`, content: '中'.repeat(PROMPT_LIMITS.content) }));
  assert.throws(() => library.import({ version: 1, prompts }), status(413, /4 MB/));
  assert.equal(readFileSync(library.path, 'utf8'), before);
});

test('提示词：写入失败不发布虚假状态，修复目录后同一实例可以保存', t => {
  const { library, dataDir } = setup(t);
  const saved = library.create(input()).prompt;
  mkdirSync(library.backupPath);
  assert.throws(() => library.update(saved.id, { revision: 1, title: '未落盘的编辑' }), status(503));
  assert.deepEqual(library.list().prompts, [saved]);
  assert.equal(existsSync(library.lockPath), false);
  assert.equal(readdirSync(dataDir).some(name => name.endsWith('.tmp')), false);
  rmSync(library.backupPath, { recursive: true });
  assert.equal(library.update(saved.id, { revision: 1, title: '真正保存' }).prompt.revision, 2);
});

test('提示词：损坏主文件读取备份，下次保存保留损坏原件，双损坏拒绝覆盖', t => {
  const { library, dataDir } = setup(t);
  const saved = library.create(input()).prompt;
  library.update(saved.id, { revision: 1, title: '第二版' });
  assert.equal(statSync(library.backupPath).mode & 0o777, 0o600);
  writeFileSync(library.path, '{damaged');
  assert.deepEqual(library.list().prompts, [saved]);
  assert.equal(library.list().recovered, true);
  assert.equal(readFileSync(library.path, 'utf8'), '{damaged');
  library.update(saved.id, { revision: 1, title: '恢复保存' });
  assert.equal(library.list().recovered, undefined);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(library.path, 'utf8'))), ['version', 'prompts']);
  const preserved = readdirSync(dataDir).filter(name => name.startsWith('prompts.json.corrupt-'));
  assert.equal(preserved.length, 1);
  assert.equal(readFileSync(join(dataDir, preserved[0]), 'utf8'), '{damaged');
  writeFileSync(library.path, '{broken'); writeFileSync(library.backupPath, '{also broken');
  assert.throws(() => library.list(), status(503));
  assert.throws(() => library.create(input()), status(503));
  assert.equal(readFileSync(library.path, 'utf8'), '{broken');
});

test('提示词：其他活跃进程的写锁不可移除', t => {
  const { library, dataDir } = setup(t);
  mkdirSync(dataDir); mkdirSync(library.lockPath);
  writeFileSync(join(library.lockPath, 'owner'), String(process.pid));
  assert.throws(() => library.create(input()), status(409));
  assert.equal(existsSync(library.lockPath), true);
  assert.equal(existsSync(library.path), false);
});

test('提示词：并行独立进程恢复死锁并保存，所有条目保留', async t => {
  const { library, dataDir } = setup(t);
  mkdirSync(dataDir); mkdirSync(library.lockPath);
  writeFileSync(join(library.lockPath, 'owner'), '2147483647');
  const moduleUrl = new URL('../server/prompt-library.mjs', import.meta.url).href;
  const script = `
    import { PromptLibrary } from ${JSON.stringify(moduleUrl)};
    import { randomUUID } from 'node:crypto';
    import { setTimeout as delay } from 'node:timers/promises';
    const library = new PromptLibrary({ dataDir: ${JSON.stringify(dataDir)} });
    for (let i = 0; i < 12; i++) {
      const value = { id: randomUUID(), title: process.pid + '-' + i, content: '并发保存内容' };
      for (let retry = 0; ; retry++) {
        try { library.create(value); break; }
        catch (error) { if (error.status !== 409 || retry > 100) throw error; await delay(5); }
      }
    }
  `;
  await Promise.all(Array.from({ length: 4 }, async () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    const [code] = await once(child, 'exit'); assert.equal(code, 0, stderr);
  }));
  assert.equal(library.list().prompts.length, 48);
  assert.equal(new Set(library.list().prompts.map(prompt => prompt.title)).size, 48);
});

async function setupHttp(t, withoutCodex = false) {
  const fixture = makeFixture();
  if (withoutCodex) {
    fixture.db.close();
    rmSync(fixture.codexHome, { recursive: true, force: true });
    mkdirSync(fixture.codexHome);
  }
  const calls = [];
  const desktopNotifications = { observe() {}, status: () => ({ enabled: false }), close() {} };
  const server = createServer({ ...fixture, desktopNotifications, appServer: { request(method) { calls.push(method); throw new Error('must not call Codex'); }, stop() {} } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.board.closeStreams();
    const done = once(server, 'close'); server.close(); server.closeAllConnections(); await done;
    if (withoutCodex) rmSync(fixture.root, { recursive: true, force: true });
    else fixture.cleanup();
  });
  const request = async (method, path, body, headers = {}) => {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  return { fixture, server, base, request, calls };
}

test('提示词 HTTP：完整 CRUD 与导入，跨站保护，原始对话文件和索引不变', async t => {
  const { fixture, server, request, calls } = await setupHttp(t);
  const rows = fixture.db.prepare('SELECT * FROM threads ORDER BY id').all();
  const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
  const history = rows.map(row => hash(row.rollout_path));
  const boardBefore = existsSync(fixture.dataDir + '/board.json') ? readFileSync(fixture.dataDir + '/board.json', 'utf8') : null;
  assert.deepEqual((await request('GET', '/api/prompts')).body, { version: 1, prompts: [] });
  for (const headers of [{ origin: 'https://evil.invalid' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await request('POST', '/api/prompts', input(), headers)).status, 403);
    assert.equal((await request('POST', '/api/prompts/import', { version: 1, prompts: [] }, headers)).status, 403);
  }
  assert.equal((await request('POST', '/api/prompts', input(), { 'content-type': 'text/plain' })).status, 415);
  const created = await request('POST', '/api/prompts', input());
  assert.equal(created.status, 201);
  const prompt = created.body.prompt;
  assert.equal((await request('PATCH', `/api/prompts/${prompt.id}`, { revision: 1, tags: ['审查'], pinned: true })).body.prompt.revision, 2);
  assert.equal((await request('DELETE', `/api/prompts/${prompt.id}`, { revision: 1 })).status, 409);
  const imported = await request('POST', '/api/prompts/import', { version: 1, prompts: [input({ title: '导入的提示词' })] });
  assert.equal(imported.body.imported, 1);
  assert.equal((await request('DELETE', `/api/prompts/${prompt.id}`, { revision: 2 })).body.ok, true);
  assert.equal((await request('PATCH', '/api/prompts/not-a-uuid', { revision: 1, title: '无效' })).status, 400);
  assert.equal(server.board.snapshot().prompts, undefined, 'full prompt bodies must not enter routine snapshots/SSE');
  assert.deepEqual(calls, []);
  assert.deepEqual(fixture.db.prepare('SELECT * FROM threads ORDER BY id').all(), rows);
  assert.deepEqual(rows.map(row => hash(row.rollout_path)), history);
  assert.equal(existsSync(fixture.dataDir + '/board.json') ? readFileSync(fixture.dataDir + '/board.json', 'utf8') : null, boardBefore);
});

test('提示词 HTTP：没有 Codex 索引也可管理提示词，导入单独接受大于 1 MB 的备份', async t => {
  const { request, calls } = await setupHttp(t, true);
  const prompts = Array.from({ length: 20 }, (_, i) => input({ title: `提示词 ${i}`, content: 'a'.repeat(60000) }));
  const exported = { version: 1, prompts };
  assert.equal((await request('POST', '/api/prompts/import', exported)).body.imported, 20);
  assert.equal((await request('GET', '/api/prompts')).body.prompts.length, 20);
  assert.equal((await request('POST', '/api/prompts', { ...input(), content: 'a'.repeat(1024 * 1024) })).status, 413);
  assert.equal((await request('POST', '/api/prompts/import', { version: 1, prompts, extra: 'a'.repeat(5 * 1024 * 1024) })).status, 413);
  assert.equal((await request('GET', '/api/prompts')).body.prompts.length, 20);
  assert.deepEqual(calls, []);
});
