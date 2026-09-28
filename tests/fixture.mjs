import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'codex-board-qa-'));
  const codexHome = join(root, 'codex');
  const dataDir = join(root, 'board');
  const cwd = join(root, 'robot-project');
  mkdirSync(join(codexHome, 'sessions'), { recursive: true });
  mkdirSync(dataDir);
  mkdirSync(cwd);
  const db = new DatabaseSync(join(codexHome, 'state_5.sqlite'));
  db.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER,
    updated_at INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER,
    source TEXT, cwd TEXT, title TEXT, name TEXT, git_branch TEXT,
    first_user_message TEXT DEFAULT '', preview TEXT DEFAULT '',
    archived INTEGER DEFAULT 0, thread_source TEXT, agent_path TEXT,
    model_provider TEXT DEFAULT 'openai', cli_version TEXT DEFAULT 'test'
  )`);
  const ids = ['11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333'];
  const names = ['相机采集修复', '机械臂并行评估', '相机方案 Fork'];
  const files = new Map();
  function insert({ id, title, branch = 'feature/camera', source = 'vscode', archived = 0, parent = null }) {
    const file = join(codexHome, 'sessions', `rollout-${id}.jsonl`);
    const now = Date.now();
    writeFileSync(file, [
      { type: 'session_meta', payload: { id, cwd, source, forked_from_id: parent } },
      { type: 'event_msg', payload: { type: 'user_message', message: `请处理${title}` } },
      { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: `${title}已有进展` } },
    ].map(x => JSON.stringify({ timestamp: new Date(now).toISOString(), ...x })).join('\n') + '\n');
    db.prepare(`INSERT INTO threads (id,rollout_path,created_at,updated_at,created_at_ms,updated_at_ms,
      source,cwd,title,name,git_branch,first_user_message,preview,archived)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, file, Math.floor(now / 1000), Math.floor(now / 1000),
        now, now, source, cwd, title, title, branch, `请处理${title}`, `${title}已有进展`, archived);
    files.set(id, file);
  }
  ids.forEach((id, i) => insert({ id, title: names[i], branch: i === 1 ? 'feature/robot' : 'feature/camera', parent: i === 2 ? ids[0] : null }));
  insert({ id: '44444444-4444-4444-8444-444444444444', title: '隐藏的子代理', source: '{"subagent":{"other":"test"}}' });
  insert({ id: '55555555-5555-4555-8555-555555555555', title: '已归档对话', archived: 1 });
  return {
    root, codexHome, dataDir, cwd, db, ids, names, insert,
    update(id, text) {
      appendFileSync(files.get(id), JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'user_message', message: text } }) + '\n');
      db.prepare('UPDATE threads SET updated_at_ms=?,updated_at=?,preview=? WHERE id=?').run(Date.now(), Math.floor(Date.now() / 1000), text, id);
    },
    cleanup() { db.close(); rmSync(root, { recursive: true, force: true }); },
  };
}
