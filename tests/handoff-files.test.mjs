import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { collectHandoffFiles } from '../server/handoff-files.mjs';

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-board-handoff-files-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, 'docs'), { recursive: true });
  await mkdir(join(cwd, 'src'), { recursive: true });
  await writeFile(join(cwd, 'docs', '项目 方案.md'), 'fixture');
  await writeFile(join(cwd, 'src', 'main.ts'), 'fixture');
  await writeFile(join(cwd, 'README.md'), 'fixture');
  await writeFile(join(cwd, 'Dockerfile'), 'fixture');
  return cwd;
}

const message = (text, offset = 7, role = 'user', phase = undefined) => ({ text, offset, role, phase, region: 'all' });

test('extracts absolute and relative Markdown links with line numbers, Unicode, spaces, and plain files', async t => {
  const cwd = await fixture(t);
  const absolute = join(cwd, 'src', 'main.ts');
  const messages = [message([
    `请检查[入口](${absolute}:42)和[中文文档](<docs/项目 方案.md:8>)。`,
    '另外参考 `README.md`、`Dockerfile`、src/main.ts。',
    '## Open tabs:',
    '- 文档: docs/项目 方案.md',
  ].join('\n'), 271)];
  const result = await collectHandoffFiles({ messages, cwd });
  const files = new Map(result.files.map(file => [file.path, file]));
  assert.equal(result.omitted, false);
  assert.deepEqual([...files.keys()].sort(), [absolute, join(cwd, 'docs', '项目 方案.md'), join(cwd, 'README.md'), join(cwd, 'Dockerfile')].sort());
  assert.equal(files.get(absolute).line, 42);
  assert.equal(files.get(join(cwd, 'docs', '项目 方案.md')).line, 8);
  for (const file of files.values()) {
    assert.equal(file.status, 'file');
    assert.equal(file.evidence.offset, 271);
    assert.equal(file.evidence.role, 'user');
    assert.ok(file.evidence.text.length <= 160);
  }
});

test('plain relative paths, missing files, directories, and symlinks have accurate metadata', async t => {
  const cwd = await fixture(t);
  await symlink(join(cwd, 'src', 'main.ts'), join(cwd, 'link.ts'));
  const result = await collectHandoffFiles({
    cwd,
    messages: [message('修改 ./src/main.ts，测试 ../missing.py，并检查 `docs/` 和 `link.ts`。', 12)],
  });
  const files = new Map(result.files.map(file => [file.path, file]));
  assert.equal(files.get(join(cwd, 'src', 'main.ts')).status, 'file');
  assert.equal(files.get(resolve(cwd, '../missing.py')).status, 'missing');
  assert.equal(files.get(join(cwd, 'docs')).status, 'directory');
  assert.equal(files.get(join(cwd, 'link.ts')).status, 'unverified');
});

test('ignores URLs, domains, commands, expressions, and private assistant phases', async t => {
  const cwd = await fixture(t);
  const result = await collectHandoffFiles({ cwd, messages: [
    message('链接 [仓库](https://github.com/org/README.md) 与 https://example.com/src/main.ts；`npm run build`、`foo(bar)`、`x=${value}`。'),
    message('私密路径 `secret/private.ts`', 18, 'assistant', 'analysis'),
    message('我已测试 `src/main.ts`。', 29, 'assistant', 'commentary'),
  ] });
  assert.deepEqual(result.files.map(file => file.path), [join(cwd, 'src', 'main.ts')]);
  assert.equal(result.files[0].evidence.offset, 29);
  assert.equal(result.files[0].evidence.role, 'assistant');
});

test('does not turn shell commands or HTTP routes into file paths', async t => {
  const cwd = await fixture(t);
  const result = await collectHandoffFiles({ cwd, messages: [
    message('运行 `npm test src/main.ts`、`python scripts/run.py`、`git diff src/main.ts`，再调用 `GET /api/threads/x`。'),
    message('HTTP 示例：GET /api/threads/x；实际入口是 `src/main.ts`。', 81),
  ] });
  assert.deepEqual(result.files.map(file => file.path), [join(cwd, 'src', 'main.ts')]);
  assert.equal(result.files[0].evidence.offset, 81);
});

test('recognizes ordinary absolute paths and punctuation without treating a URL as a path', async t => {
  const cwd = await fixture(t);
  const absolute = join(cwd, 'src', 'main.ts');
  const result = await collectHandoffFiles({ cwd, messages: [
    message(`The entry is ${absolute}. The guide is README.md, while https://example.com/docs/api.md is external.`),
  ] });
  assert.deepEqual(result.files.map(file => file.path).sort(), [absolute, join(cwd, 'README.md')].sort());
});

test('keeps a spaced Unicode relative path intact in ordinary prose', async t => {
  const cwd = await fixture(t);
  const result = await collectHandoffFiles({ cwd, messages: [message('请看 docs/项目 方案.md，再检查当前文件。')] });
  assert.deepEqual(result.files.map(file => file.path), [join(cwd, 'docs', '项目 方案.md')]);
  assert.equal(result.files[0].status, 'file');
});

test('latest reference wins deduplication and long public message tails remain searchable', async t => {
  const cwd = await fixture(t);
  const messages = [
    message('[旧位置](src/main.ts:4)', 10),
    message('无关内容 '.repeat(60_000) + '\n已修改 `src/main.ts:83`，请查看新位置。', 900, 'assistant', 'commentary'),
  ];
  const result = await collectHandoffFiles({ messages, cwd });
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].path, join(cwd, 'src', 'main.ts'));
  assert.equal(result.files[0].line, 83);
  assert.equal(result.files[0].evidence.offset, 900);
  assert.match(result.files[0].evidence.text, /已修改/);
});

test('caps the output at 24 and still keeps the newest path after more than 512 candidates', async t => {
  const cwd = await fixture(t);
  const older = Array.from({ length: 540 }, (_, index) => `[文件](missing/old-${index}.md)`).join(' ');
  const result = await collectHandoffFiles({ cwd, maxFiles: 100, messages: [
    message(older, 1),
    message('刚编辑 `src/main.ts`，这是当前关键入口。', 1000, 'assistant', 'commentary'),
  ] });
  assert.equal(result.files.length, 24);
  assert.equal(result.omitted, true);
  assert.ok(result.files.some(file => file.path === join(cwd, 'src', 'main.ts')));
  assert.ok(result.files.every(file => file.evidence.text.length <= 160));
});
