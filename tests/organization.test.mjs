import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BoardStore, UUID } from '../server/store.mjs';
import { makeFixture } from './fixture.mjs';

function setup(t) {
  const fixture = makeFixture();
  const store = new BoardStore(fixture);
  t.after(() => { store.close(); fixture.cleanup(); });
  const ids = new Set(fixture.ids);
  const change = body => store.updateOrganization(body, ids);
  return { fixture, store, ids, change };
}

test('研究项目与任务可独立命名，并将不同文件夹的会话归入同一任务', t => {
  const { fixture, store, change } = setup(t);
  fixture.db.prepare('UPDATE threads SET cwd=? WHERE id=?').run(join(fixture.root, 'other-worktree'), fixture.ids[1]);
  const before = fixture.db.prepare('SELECT * FROM threads ORDER BY id').all();
  const project = change({ action: 'createProject', name: ' YAM ' }).projects[0];
  assert.ok(UUID.test(project.id));
  assert.equal(project.name, 'YAM');
  const task = change({ action: 'createTask', projectId: project.id, name: '相机模块' }).tasks[0];
  change({ action: 'assign', threadIds: fixture.ids.slice(0, 2), projectId: project.id, taskId: task.id });
  change({ action: 'renameProject', id: project.id, name: '机器人 YAM' });
  change({ action: 'renameTask', id: task.id, name: 'PR #14' });
  const threads = store.threads();
  const first = threads.find(item => item.id === fixture.ids[0]);
  const second = threads.find(item => item.id === fixture.ids[1]);
  assert.equal(first.folder, 'robot-project');
  assert.equal(second.folder, 'other-worktree');
  assert.equal(first.researchProjectId, project.id);
  assert.equal(second.researchProjectId, project.id);
  assert.equal(first.taskId, task.id);
  assert.equal(second.taskId, task.id);
  assert.equal(threads.find(item => item.id === fixture.ids[2]).researchProjectId, null);
  assert.equal(store.organization().projects[0].name, '机器人 YAM');
  assert.equal(store.organization().tasks[0].name, 'PR #14');
  assert.deepEqual(fixture.db.prepare('SELECT * FROM threads ORDER BY id').all(), before);
});

test('重新分配、删除任务和删除项目只改变手工分类，保留对话与图谱', t => {
  const { fixture, store, ids, change } = setup(t);
  const yam = change({ action: 'createProject', name: 'YAM' }).projects[0];
  const behavior = change({ action: 'createProject', name: 'BEHAVIOR' }).projects[1];
  const camera = change({ action: 'createTask', projectId: yam.id, name: '相机' }).tasks[0];
  const pr = change({ action: 'createTask', projectId: behavior.id, name: 'PR' }).tasks[1];
  const edge = { id: 'manual-edge', source: fixture.ids[0], target: fixture.ids[1], type: 'parallel' };
  store.updateGraph({ positions: { [fixture.ids[0]]: { x: 200, y: 100 } }, edges: [edge] }, ids);
  const graph = structuredClone(store.graph());
  change({ action: 'assign', threadIds: fixture.ids, projectId: yam.id, taskId: camera.id });
  change({ action: 'assign', threadIds: [fixture.ids[1]], projectId: behavior.id, taskId: pr.id });
  change({ action: 'deleteTask', id: camera.id });
  assert.deepEqual(store.organization().assignments[fixture.ids[0]], { projectId: yam.id, taskId: null });
  assert.deepEqual(store.organization().assignments[fixture.ids[1]], { projectId: behavior.id, taskId: pr.id });
  change({ action: 'deleteProject', id: yam.id });
  assert.deepEqual(Object.keys(store.organization().assignments), [fixture.ids[1]]);
  assert.deepEqual(store.organization().tasks, [pr]);
  change({ action: 'assign', threadIds: [fixture.ids[1]], projectId: null, taskId: null });
  assert.deepEqual(store.organization().assignments, {});
  assert.equal(store.threads().length, 3);
  assert.deepEqual(store.graph(), graph);
});

test('旧版 board.json 无损迁移，项目与任务分配重启后保留', t => {
  const fixture = makeFixture();
  const legacy = {
    version: 1,
    positions: { [fixture.ids[0]]: { x: 120, y: 60 } },
    edges: [{ id: 'old-edge', source: fixture.ids[0], target: fixture.ids[1], type: 'reference' }],
    managedThreads: { [fixture.ids[2]]: { title: '已有标题', forkedFromId: fixture.ids[0] } },
  };
  writeFileSync(join(fixture.dataDir, 'board.json'), JSON.stringify(legacy));
  let store = new BoardStore(fixture);
  t.after(() => { store.close(); fixture.cleanup(); });
  assert.deepEqual(store.organization(), { projects: [], tasks: [], assignments: {} });
  assert.ok(store.threads().every(item => item.researchProjectId === null && item.taskId === null));
  const ids = new Set(fixture.ids);
  const project = store.updateOrganization({ action: 'createProject', name: 'YAM' }, ids).projects[0];
  const task = store.updateOrganization({ action: 'createTask', projectId: project.id, name: '运动规划' }, ids).tasks[0];
  store.updateOrganization({ action: 'assign', threadIds: [fixture.ids[0]], projectId: project.id, taskId: task.id }, ids);
  const saved = store.organization();
  store.close();
  store = new BoardStore(fixture);
  assert.deepEqual(store.organization(), saved);
  assert.deepEqual(store.graph(), { positions: legacy.positions, edges: legacy.edges });
  assert.deepEqual(store.state.managedThreads, legacy.managedThreads);
});

test('无效分类请求整体拒绝，批量分配不部分生效', t => {
  const { fixture, store, change } = setup(t);
  const yam = change({ action: 'createProject', name: 'YAM' }).projects[0];
  const behavior = change({ action: 'createProject', name: 'BEHAVIOR' }).projects[1];
  const task = change({ action: 'createTask', projectId: yam.id, name: 'PR' }).tasks[0];
  const other = change({ action: 'createTask', projectId: behavior.id, name: 'PR' }).tasks[1];
  change({ action: 'assign', threadIds: [fixture.ids[0]], projectId: yam.id, taskId: task.id });
  const previous = store.organization();
  const persisted = readFileSync(join(fixture.dataDir, 'board.json'), 'utf8');
  const invalid = [
    { action: 'createProject', name: ' yam ' },
    { action: 'renameProject', id: behavior.id, name: 'YAM' },
    { action: 'createProject', name: ' ' },
    { action: 'createProject', name: 'a'.repeat(81) },
    { action: 'createProject', name: 'OK', id: '__proto__' },
    { action: 'createTask', projectId: yam.id, name: 'pr' },
    { action: 'renameTask', id: task.id, name: '' },
    { action: 'assign', threadIds: [fixture.ids[0], '00000000-0000-4000-8000-000000000000'], projectId: behavior.id, taskId: other.id },
    { action: 'assign', threadIds: [fixture.ids[0]], projectId: behavior.id, taskId: task.id },
    { action: 'assign', threadIds: [fixture.ids[0]], projectId: null, taskId: task.id },
    { action: 'assign', threadIds: ['__proto__'], projectId: yam.id },
    { action: 'assign', threadIds: [], projectId: yam.id },
    { action: 'deleteProject', id: '__proto__' },
    { action: '__proto__' },
    { action: 'constructor' },
    null,
  ];
  for (const body of invalid) {
    assert.throws(() => change(body), JSON.stringify(body));
    assert.deepEqual(store.organization(), previous);
    assert.equal(readFileSync(join(fixture.dataDir, 'board.json'), 'utf8'), persisted);
  }
  const detached = store.organization();
  detached.projects[0].name = 'mutated';
  assert.deepEqual(store.organization(), previous);
});

test('磁盘写入失败时内存分类保持之前状态', t => {
  const { store, change } = setup(t);
  change({ action: 'createProject', name: 'YAM' });
  const previous = store.organization();
  store.save = () => { throw new Error('disk write failed'); };
  assert.throws(() => change({ action: 'createProject', name: 'BEHAVIOR' }), /disk write failed/);
  assert.deepEqual(store.organization(), previous);
});
