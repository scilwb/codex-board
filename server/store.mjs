import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, readSync, statSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const shorten = (value, limit = 240) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';
const timestamp = (seconds, milliseconds) => Number(milliseconds) > 0 ? Number(milliseconds) : Number(seconds || 0) * 1000;

export class BoardStore {
  constructor({ codexHome, dataDir }) {
    this.codexHome = codexHome;
    this.dataDir = dataDir;
    this.graphPath = join(dataDir, 'board.json');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.state = { version: 1, positions: {}, edges: [], managedThreads: {}, organization: { projects: [], tasks: [], assignments: {} } };
    if (existsSync(this.graphPath)) {
      const parsed = JSON.parse(readFileSync(this.graphPath, 'utf8'));
      this.state = { ...this.state, ...parsed };
    }
    // Existing boards predate research projects. Keep all their graph metadata;
    // filesystem folders do not imply a research project or task assignment.
    if (!this.state.organization) this.state.organization = { projects: [], tasks: [], assignments: {} };
    this.rolloutCache = new Map();
  }

  database() {
    if (this.db) return this.db;
    const names = readdirSync(this.codexHome).filter(name => /^state_\d+\.sqlite$/.test(name)).sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
    if (!names.length) throw new Error('没有找到 Codex 会话索引，请先在本机打开一次 Codex 对话。');
    this.db = new DatabaseSync(join(this.codexHome, names[0]), { readOnly: true });
    this.db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 1000;');
    this.columns = new Set(this.db.prepare('PRAGMA table_info(threads)').all().map(row => row.name));
    return this.db;
  }

  rollout(path) {
    if (!path) return {};
    try {
      const stat = statSync(path);
      const cached = this.rolloutCache.get(path);
      if (cached && cached.size === stat.size && cached.mtime === stat.mtimeMs) return cached.value;
      const fd = openSync(path, 'r');
      let head, tail;
      try {
        const headBuffer = Buffer.alloc(Math.min(65536, stat.size));
        readSync(fd, headBuffer, 0, headBuffer.length, 0);
        head = headBuffer.toString('utf8');
        const tailBuffer = Buffer.alloc(Math.min(65536, stat.size));
        readSync(fd, tailBuffer, 0, tailBuffer.length, Math.max(0, stat.size - tailBuffer.length));
        tail = tailBuffer.toString('utf8');
      } finally { closeSync(fd); }
      const value = {};
      for (const line of head.split('\n').slice(0, 5)) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'session_meta') {
            value.forkedFromId = entry.payload?.forked_from_id || null;
            value.gitBranch = entry.payload?.git?.branch || null;
            break;
          }
        } catch {}
      }
      for (const line of tail.split('\n').reverse()) {
        try {
          const entry = JSON.parse(line);
          const item = entry.payload;
          if (entry.type === 'event_msg' && ['user_message', 'agent_message'].includes(item?.type) && typeof item.message === 'string') {
            value.lastMessage = shorten(item.message);
            break;
          }
          if (entry.type === 'response_item' && item?.type === 'message' && ['user', 'assistant'].includes(item.role)) {
            const text = (item.content || []).filter(part => typeof part.text === 'string').map(part => part.text).join(' ');
            if (text) { value.lastMessage = shorten(text); break; }
          }
        } catch {}
      }
      this.rolloutCache.set(path, { size: stat.size, mtime: stat.mtimeMs, value });
      return value;
    } catch { return {}; }
  }

  threads() {
    const db = this.database();
    const managedIds = Object.keys(this.state.managedThreads);
    const archivedFilter = this.columns.has('archived') ? 'archived = 0 AND ' : '';
    const placeholders = managedIds.map(() => '?').join(',');
    const rows = db.prepare(`SELECT * FROM threads WHERE ${archivedFilter}(source IN ('cli','vscode','appServer','app-server')${managedIds.length ? ` OR id IN (${placeholders})` : ''})`).all(...managedIds);
    const threads = rows.map(row => {
      const managed = this.state.managedThreads[row.id] || {};
      const rollout = this.rollout(row.rollout_path);
      const assignment = this.state.organization.assignments[row.id];
      return {
        id: row.id,
        title: shorten(row.name || managed.title || row.title || row.first_user_message || '未命名对话', 120),
        preview: rollout.lastMessage || shorten(row.preview || row.first_user_message),
        cwd: row.cwd,
        folder: basename(row.cwd) || row.cwd,
        // Retained for older clients; new UI uses folder + organization.
        project: basename(row.cwd) || row.cwd,
        researchProjectId: assignment?.projectId || null,
        taskId: assignment?.taskId || null,
        branch: row.git_branch || rollout.gitBranch || managed.branch || null,
        updatedAt: timestamp(row.updated_at, row.updated_at_ms),
        createdAt: timestamp(row.created_at, row.created_at_ms),
        forkedFromId: rollout.forkedFromId || managed.forkedFromId || null,
        status: 'unknown',
        archived: false,
      };
    });
    // Official archive/deletion always wins over this board's metadata cache.
    // Created sessions must persist through the official API before remembering them.
    return threads.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  }

  graph() { return { positions: this.state.positions, edges: this.state.edges }; }

  organization() { return structuredClone(this.state.organization); }

  updateOrganization(body, validIds) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('项目与任务数据格式无效');
    const fields = {
      createProject: ['name'], renameProject: ['id', 'name'], deleteProject: ['id'],
      createTask: ['projectId', 'name'], renameTask: ['id', 'name'], deleteTask: ['id'],
      assign: ['threadIds', 'projectId', 'taskId'],
    };
    if (!Object.hasOwn(fields, body.action)) throw new Error('项目与任务操作无效');
    if (Object.keys(body).some(key => key !== 'action' && !fields[body.action].includes(key))) throw new Error('项目与任务数据包含未知字段');
    const organization = this.organization();
    const requireId = id => {
      if (typeof id !== 'string' || !UUID.test(id)) throw new Error('项目或任务 ID 无效');
      return id;
    };
    const project = id => {
      const result = organization.projects.find(item => item.id === requireId(id));
      if (!result) throw new Error('项目不存在');
      return result;
    };
    const task = id => {
      const result = organization.tasks.find(item => item.id === requireId(id));
      if (!result) throw new Error('任务不存在');
      return result;
    };
    const name = (value, siblings, exceptId) => {
      if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) throw new Error('名称不能为空且不能超过 80 个字符');
      const trimmed = value.trim();
      if (siblings.some(item => item.id !== exceptId && item.name.toLowerCase() === trimmed.toLowerCase())) throw new Error('名称已存在');
      return trimmed;
    };
    switch (body.action) {
      case 'createProject':
        organization.projects.push({ id: randomUUID(), name: name(body.name, organization.projects) });
        break;
      case 'renameProject': {
        const item = project(body.id);
        item.name = name(body.name, organization.projects, item.id);
        break;
      }
      case 'deleteProject': {
        const item = project(body.id);
        organization.projects = organization.projects.filter(value => value.id !== item.id);
        organization.tasks = organization.tasks.filter(value => value.projectId !== item.id);
        for (const [id, assignment] of Object.entries(organization.assignments)) {
          if (assignment.projectId === item.id) delete organization.assignments[id];
        }
        break;
      }
      case 'createTask': {
        const parent = project(body.projectId);
        const siblings = organization.tasks.filter(value => value.projectId === parent.id);
        organization.tasks.push({ id: randomUUID(), projectId: parent.id, name: name(body.name, siblings) });
        break;
      }
      case 'renameTask': {
        const item = task(body.id);
        const siblings = organization.tasks.filter(value => value.projectId === item.projectId);
        item.name = name(body.name, siblings, item.id);
        break;
      }
      case 'deleteTask': {
        const item = task(body.id);
        organization.tasks = organization.tasks.filter(value => value.id !== item.id);
        for (const assignment of Object.values(organization.assignments)) {
          if (assignment.taskId === item.id) assignment.taskId = null;
        }
        break;
      }
      case 'assign': {
        if (!Array.isArray(body.threadIds) || !body.threadIds.length || body.threadIds.length > 10000 || body.threadIds.some(id => typeof id !== 'string' || !UUID.test(id) || !validIds.has(id))) throw new Error('请选择有效的对话');
        const taskId = body.taskId ?? null;
        if (body.projectId === null) {
          if (taskId !== null) throw new Error('分配任务时必须选择所属项目');
          for (const id of body.threadIds) delete organization.assignments[id];
        } else {
          const parent = project(body.projectId);
          if (taskId !== null && task(taskId).projectId !== parent.id) throw new Error('任务不属于所选项目');
          for (const id of body.threadIds) organization.assignments[id] = { projectId: parent.id, taskId };
        }
        break;
      }
    }
    // Validate and write a complete next state before publishing the change in
    // memory. Rejected requests and failed writes cannot partially reassign.
    const nextState = { ...this.state, organization };
    this.save(nextState);
    this.state = nextState;
    return this.organization();
  }

  save(state = this.state) {
    const temporary = `${this.graphPath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    renameSync(temporary, this.graphPath);
  }

  updateGraph(patch, validIds) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('图谱数据格式无效');
    if (Object.keys(patch).some(key => !['positions', 'edges'].includes(key))) throw new Error('图谱数据包含未知字段');
    const nextPositions = { ...this.state.positions };
    if (patch.positions !== undefined) {
      if (!patch.positions || typeof patch.positions !== 'object' || Array.isArray(patch.positions)) throw new Error('卡片位置格式无效');
      for (const [id, position] of Object.entries(patch.positions)) {
        if (!validIds.has(id)) throw new Error('卡片对应的对话不存在');
        if (!position || typeof position !== 'object' || Object.keys(position).some(key => !['x', 'y'].includes(key)) || !Number.isFinite(position.x) || !Number.isFinite(position.y) || Math.abs(position.x) > 1000000 || Math.abs(position.y) > 1000000) throw new Error('卡片坐标无效');
        nextPositions[id] = { x: position.x, y: position.y };
      }
    }
    let nextEdges = this.state.edges;
    if (patch.edges !== undefined) {
      if (!Array.isArray(patch.edges) || patch.edges.length > 10000) throw new Error('连线格式无效');
      const seenIds = new Set(), seenPairs = new Set();
      nextEdges = patch.edges.map(edge => {
        if (!edge || typeof edge.id !== 'string' || edge.id.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(edge.id) || !validIds.has(edge.source) || !validIds.has(edge.target) || edge.source === edge.target || !['serial', 'parallel', 'reference'].includes(edge.type)) throw new Error('连线端点、类型或 ID 无效');
        const pair = `${edge.source}:${edge.target}`;
        if (seenIds.has(edge.id) || seenPairs.has(pair)) throw new Error('连线重复');
        seenIds.add(edge.id); seenPairs.add(pair);
        return { id: edge.id, source: edge.source, target: edge.target, type: edge.type };
      });
    }
    this.state.positions = nextPositions;
    this.state.edges = nextEdges;
    this.save();
    return this.graph();
  }

  remember(thread) { this.state.managedThreads[thread.id] = thread; this.save(); }
  close() { this.db?.close(); }
}
