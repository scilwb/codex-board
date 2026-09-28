import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  assert.ok(threads.every(x => x.status === 'unknown'));
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
