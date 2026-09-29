import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BoardStore } from '../server/store.mjs';
import { makeFixture } from './fixture.mjs';

test('会话索引：仅用户会话，正确分支与真实 fork 父节点', t => {
  const f = makeFixture();
  const store = new BoardStore(f);
  t.after(() => { store.close(); f.cleanup(); });
  const threads = store.threads();
  assert.equal(threads.length, 3);
  assert.equal(threads.find(x => x.id === f.ids[1]).branch, 'feature/robot');
  assert.equal(threads.find(x => x.id === f.ids[2]).forkedFromId, f.ids[0]);
  assert.ok(threads.every(x => x.status === 'completed'));
  assert.ok(threads.every(x => x.updatedAt > 1000000000000));
});

test('增量同步：已有缓存后仍读到新消息和新标题', t => {
  const f = makeFixture();
  const store = new BoardStore(f);
  t.after(() => { store.close(); f.cleanup(); });
  store.threads();
  f.update(f.ids[0], '已完成相机检查，等待下一步');
  f.db.prepare('UPDATE threads SET name=? WHERE id=?').run('新的会话标题', f.ids[0]);
  const updated = store.threads().find(x => x.id === f.ids[0]);
  assert.equal(updated.title, '新的会话标题');
  assert.equal(updated.preview, '已完成相机检查，等待下一步');
});

test('拖拽与连线：持久化、局部位置合并、编辑和删除', t => {
  const f = makeFixture();
  let store = new BoardStore(f);
  t.after(() => { store.close(); f.cleanup(); });
  const ids = new Set(f.ids);
  const edge = { id: 'edge-1', source: f.ids[0], target: f.ids[1], type: 'parallel' };
  store.updateGraph({ positions: { [f.ids[0]]: { x: 130, y: 240 } }, edges: [edge] }, ids);
  store.updateGraph({ positions: { [f.ids[1]]: { x: 520, y: 240 } } }, ids);
  store.close();
  store = new BoardStore(f);
  assert.deepEqual(store.graph().positions[f.ids[0]], { x: 130, y: 240 });
  assert.equal(store.graph().edges[0].type, 'parallel');
  store.updateGraph({ edges: [{ ...edge, type: 'serial' }] }, ids);
  assert.equal(store.graph().edges[0].type, 'serial');
  store.updateGraph({ edges: [] }, ids);
  assert.deepEqual(store.graph().edges, []);
  const saved = JSON.parse(readFileSync(join(f.dataDir, 'board.json'), 'utf8'));
  assert.equal(saved.positions[f.ids[1]].x, 520);
});

test('连线校验：拒绝自连、伪造节点、重复线和无效坐标，保留原状态', t => {
  const f = makeFixture();
  const store = new BoardStore(f);
  t.after(() => { store.close(); f.cleanup(); });
  const ids = new Set(f.ids);
  const edge = { id: 'edge-1', source: f.ids[0], target: f.ids[1], type: 'reference' };
  store.updateGraph({ edges: [edge] }, ids);
  for (const patch of [
    { edges: [{ ...edge, target: edge.source }] },
    { edges: [{ ...edge, target: 'missing' }] },
    { edges: [edge, { ...edge, id: 'edge-2' }] },
    { positions: { [f.ids[0]]: { x: Infinity, y: 0 } } },
    { edges: [{ ...edge, type: 'fork' }] },
  ]) assert.throws(() => store.updateGraph(patch, ids));
  assert.deepEqual(store.graph().edges, [edge]);
});

test('Codex 会话数据库只读：保存关系不改写对话内容', t => {
  const f = makeFixture();
  const store = new BoardStore(f);
  t.after(() => { store.close(); f.cleanup(); });
  const before = f.db.prepare('SELECT * FROM threads ORDER BY id').all();
  store.threads();
  store.updateGraph({ positions: { [f.ids[0]]: { x: 42, y: 73 } } }, new Set(f.ids));
  assert.deepEqual(f.db.prepare('SELECT * FROM threads ORDER BY id').all(), before);
});


test('写入失败不会发布未落盘的图谱、会话、分组或创建回执', t => {
  const f = makeFixture();
  const store = new BoardStore(f);
  t.after(() => { store.close(); f.cleanup(); });
  const ids = new Set(f.ids);
  const project = store.updateOrganization({ action: 'createProject', name: 'YAM' }, ids).projects[0];
  const before = readFileSync(join(f.dataDir, 'board.json'), 'utf8');
  const receipt = { requestId: randomUUID(), fingerprint: 'a'.repeat(64), assignment: { projectId: project.id, taskId: null } };
  const created = { id: randomUUID(), title: '继承会话', inheritance: { prompt: '历史交接' } };
  store.save = () => { throw new Error('disk full'); };
  assert.throws(() => store.updateGraph({ positions: { [f.ids[0]]: { x: 9, y: 10 } } }, ids), /disk full/);
  assert.deepEqual(store.graph(), { positions: {}, edges: [] });
  assert.throws(() => store.remember(created, receipt), /disk full/);
  assert.equal(store.creationRequest(receipt.requestId), null);
  assert.equal(store.state.managedThreads[created.id], undefined);
  assert.equal(store.organization().assignments[created.id], undefined);
  assert.equal(readFileSync(join(f.dataDir, 'board.json'), 'utf8'), before);
});

test('创建回执、继承元数据和项目分配一起持久化，拒绝错误分配', t => {
  const f = makeFixture();
  const store = new BoardStore(f);
  t.after(() => { store.close(); f.cleanup(); });
  const project = store.updateOrganization({ action: 'createProject', name: 'YAM' }, new Set(f.ids)).projects[0];
  const task = store.updateOrganization({ action: 'createTask', projectId: project.id, name: '相机' }, new Set(f.ids)).tasks[0];
  const created = { id: randomUUID(), title: '继承会话', inheritedFromId: f.ids[0], inheritance: { prompt: '历史交接', settings: { model: 'gpt-6-sol' } } };
  const requestId = randomUUID(), fingerprint = 'b'.repeat(64);
  assert.throws(() => store.remember(created, { requestId, fingerprint, assignment: { projectId: project.id, taskId: randomUUID() } }), /项目或任务分配无效/);
  assert.equal(store.creationRequest(requestId), null);
  store.remember(created, { requestId, fingerprint, assignment: { projectId: project.id, taskId: task.id } });
  const reopened = new BoardStore(f);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.creationRequest(requestId), { fingerprint, threadId: created.id });
  assert.deepEqual(reopened.inheritance(created.id), created.inheritance);
  assert.deepEqual(reopened.organization().assignments[created.id], { projectId: project.id, taskId: task.id });
  assert.throws(() => reopened.remember({ id: randomUUID() }, { requestId, fingerprint }), error => error.status === 409);
});

test('board.json 损坏时恢复上一个有效快照，两个副本都损坏则保留原件报错', t => {
  const f = makeFixture();
  const store = new BoardStore(f);
  t.after(() => { store.close(); f.cleanup(); });
  const ids = new Set(f.ids), boardPath = join(f.dataDir, 'board.json'), backupPath = `${boardPath}.bak`;
  store.updateGraph({ positions: { [f.ids[0]]: { x: 1, y: 2 } } }, ids);
  store.updateGraph({ positions: { [f.ids[0]]: { x: 3, y: 4 } } }, ids);
  assert.equal(JSON.parse(readFileSync(backupPath, 'utf8')).positions[f.ids[0]].x, 1);
  writeFileSync(boardPath, '{broken');
  const recovered = new BoardStore(f);
  t.after(() => recovered.close());
  assert.equal(recovered.graph().positions[f.ids[0]].x, 1);
  assert.equal(readFileSync(boardPath, 'utf8'), '{broken');
  recovered.updateGraph({ positions: { [f.ids[1]]: { x: 5, y: 6 } } }, ids);
  assert.equal(JSON.parse(readFileSync(boardPath, 'utf8')).positions[f.ids[1]].x, 5);
  const corruptCopies = readdirSync(f.dataDir).filter(name => name.startsWith('board.json.corrupt-'));
  assert.equal(corruptCopies.length, 1);
  assert.equal(readFileSync(join(f.dataDir, corruptCopies[0]), 'utf8'), '{broken');
  writeFileSync(boardPath, '{broken again');
  writeFileSync(backupPath, '{broken backup');
  assert.throws(() => new BoardStore(f), /元数据和备份均已损坏/);
  assert.equal(readFileSync(boardPath, 'utf8'), '{broken again');
});

test('两个看板实例的旧状态不能覆盖新状态，崩溃遗留锁可恢复', t => {
  const f = makeFixture();
  const first = new BoardStore(f), stale = new BoardStore(f);
  t.after(() => { first.close(); stale.close(); f.cleanup(); });
  const ids = new Set(f.ids);
  const lock = join(f.dataDir, 'board.json.lock');
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner'), '999999999');
  first.updateGraph({ positions: { [f.ids[0]]: { x: 11, y: 12 } } }, ids);
  assert.equal(existsSync(lock), false);
  assert.throws(() => stale.updateGraph({ positions: { [f.ids[1]]: { x: 21, y: 22 } } }, ids), error => error.status === 409);
  assert.equal(stale.graph().positions[f.ids[0]].x, 11);
  assert.equal(stale.graph().positions[f.ids[1]], undefined);
  stale.updateGraph({ positions: { [f.ids[1]]: { x: 21, y: 22 } } }, ids);
  const persisted = JSON.parse(readFileSync(join(f.dataDir, 'board.json'), 'utf8'));
  assert.equal(persisted.positions[f.ids[0]].x, 11);
  assert.equal(persisted.positions[f.ids[1]].x, 21);
});

test('归档会话的图谱元素隐藏且修改可见连线时保留，以便解除归档恢复', t => {
  const f = makeFixture();
  const store = new BoardStore(f);
  t.after(() => { store.close(); f.cleanup(); });
  const edge = { id: 'edge-archived', source: f.ids[0], target: f.ids[1], type: 'reference' };
  store.updateGraph({ positions: { [f.ids[1]]: { x: 7, y: 8 } }, edges: [edge] }, new Set(f.ids));
  f.db.prepare('UPDATE threads SET archived=1 WHERE id=?').run(f.ids[1]);
  const visible = new Set(store.threads().map(thread => thread.id));
  assert.deepEqual(store.graph(visible), { positions: {}, edges: [] });
  store.updateGraph({ edges: [] }, visible);
  f.db.prepare('UPDATE threads SET archived=0 WHERE id=?').run(f.ids[1]);
  assert.deepEqual(store.graph(new Set(store.threads().map(thread => thread.id))).edges, [edge]);
});
