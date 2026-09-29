import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { RolloutMonitor, recentReplies } from './activity.mjs';
import { buildHandoff } from './handoff.mjs';
import { readThreadSettings } from './thread-settings.mjs';
import { readPublicHistory } from './public-history.mjs';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const shorten = (value, limit = 240) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';
const timestamp = (seconds, milliseconds) => Number(milliseconds) > 0 ? Number(milliseconds) : Number(seconds || 0) * 1000;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => value === null ? null : createHash('sha256').update(value).digest('hex');
const defaultOrganization = () => ({ projects: [], tasks: [], assignments: {} });
const defaultState = () => ({ version: 1, positions: {}, edges: [], managedThreads: {}, organization: defaultOrganization(), creationRequests: {} });

function parseState(raw) {
  const parsed = JSON.parse(raw);
  if (!isRecord(parsed) || (parsed.positions !== undefined && !isRecord(parsed.positions)) ||
    (parsed.edges !== undefined && !Array.isArray(parsed.edges)) ||
    (parsed.managedThreads !== undefined && !isRecord(parsed.managedThreads)) ||
    (parsed.creationRequests !== undefined && !isRecord(parsed.creationRequests)) ||
    (parsed.organization !== undefined && parsed.organization !== null && !isRecord(parsed.organization))) throw new Error('Codex Board 元数据结构无效');
  const organization = parsed.organization || defaultOrganization();
  if ((organization.projects !== undefined && !Array.isArray(organization.projects)) ||
    (organization.tasks !== undefined && !Array.isArray(organization.tasks)) ||
    (organization.assignments !== undefined && !isRecord(organization.assignments)) ||
    (organization.projects || []).some(item => !isRecord(item) || typeof item.id !== 'string' || typeof item.name !== 'string') ||
    (organization.tasks || []).some(item => !isRecord(item) || typeof item.id !== 'string' || typeof item.projectId !== 'string' || typeof item.name !== 'string') ||
    Object.values(organization.assignments || {}).some(item => !isRecord(item))) throw new Error('Codex Board 项目元数据结构无效');
  if (Object.values(parsed.positions || {}).some(value => !isRecord(value) || !Number.isFinite(value.x) || !Number.isFinite(value.y)) ||
    (parsed.edges || []).some(edge => !isRecord(edge) || typeof edge.id !== 'string' || typeof edge.source !== 'string' || typeof edge.target !== 'string' || typeof edge.type !== 'string') ||
    Object.values(parsed.managedThreads || {}).some(value => !isRecord(value)) ||
    Object.entries(parsed.creationRequests || {}).some(([id, receipt]) => !UUID.test(id) || !isRecord(receipt) ||
      typeof receipt.fingerprint !== 'string' || !/^[0-9a-f]{64}$/i.test(receipt.fingerprint) || !UUID.test(receipt.threadId))) throw new Error('Codex Board 元数据结构无效');
  return { ...defaultState(), ...parsed, organization: { ...defaultOrganization(), ...organization } };
}

function writeAtomic(path, content) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: 'wx', mode: 0o600, flush: true });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

function acquireWriteLock(path) {
  const conflict = () => Object.assign(new Error('另一个 Codex Board 实例正在保存元数据，请稍后重试'), { status: 409 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(path, { mode: 0o700 });
      try { writeFileSync(join(path, 'owner'), String(process.pid), { flag: 'wx', mode: 0o600 }); }
      catch (error) { rmSync(path, { recursive: true, force: true }); throw error; }
      return () => rmSync(path, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let stale = false;
      try {
        const age = Date.now() - statSync(path).mtimeMs;
        let pid = null;
        try { pid = Number(readFileSync(join(path, 'owner'), 'utf8')); } catch { /* owner may not be written yet */ }
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); } catch (error) { stale = error.code === 'ESRCH'; }
        } else stale = age > 5000;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!stale || attempt > 0) throw conflict();
      rmSync(path, { recursive: true, force: true });
    }
  }
  throw conflict();
}

export class BoardStore {
  constructor({ codexHome, dataDir }) {
    this.codexHome = codexHome;
    this.dataDir = dataDir;
    this.graphPath = join(dataDir, 'board.json');
    this.backupPath = `${this.graphPath}.bak`;
    this.lockPath = `${this.graphPath}.lock`;
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const primary = existsSync(this.graphPath) ? readFileSync(this.graphPath, 'utf8') : null;
    this.revision = digest(primary);
    this.recoveredFromBackup = false;
    this.corruptPreservedRevision = null;
    this.state = defaultState();
    if (primary !== null) {
      try { this.state = parseState(primary); }
      catch (error) {
        if (!existsSync(this.backupPath)) throw new Error('Codex Board 元数据已损坏，且没有可用备份；原文件已保留', { cause: error });
        try { this.state = parseState(readFileSync(this.backupPath, 'utf8')); }
        catch (backupError) { throw new Error('Codex Board 元数据和备份均已损坏；原文件已保留', { cause: backupError }); }
        this.recoveredFromBackup = true;
        console.warn('Codex Board 元数据损坏，已从备份恢复；损坏原件会在下次写入前另存。');
      }
    } else if (existsSync(this.backupPath)) {
      try { this.state = parseState(readFileSync(this.backupPath, 'utf8')); }
      catch (error) { throw new Error('Codex Board 元数据备份已损坏；原文件已保留', { cause: error }); }
      this.recoveredFromBackup = true;
      console.warn('Codex Board 元数据文件缺失，已从备份恢复。');
    }
    // Existing boards predate research projects. Keep all their graph metadata;
    // filesystem folders do not imply a research project or task assignment.
    this.rolloutMonitor = new RolloutMonitor();
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

  rollout(path) { return this.rolloutMonitor.read(path); }

  async replies(id) {
    if (!UUID.test(id)) throw new Error('对话 ID 格式无效');
    const row = this.database().prepare('SELECT rollout_path FROM threads WHERE id=?').get(id);
    if (!row?.rollout_path) throw new Error('找不到这条对话的回复记录');
    return recentReplies(row.rollout_path);
  }

  async publicHistory(id, offset) {
    if (!UUID.test(id)) throw new Error('对话 ID 格式无效');
    const row = this.database().prepare('SELECT rollout_path FROM threads WHERE id=?').get(id);
    if (!row?.rollout_path) throw new Error('找不到这条对话的历史记录');
    return readPublicHistory({ rolloutPath: row.rollout_path, offset });
  }

  async handoff(thread) {
    if (!UUID.test(thread.id)) throw new Error('对话 ID 格式无效');
    const row = this.database().prepare('SELECT rollout_path FROM threads WHERE id=?').get(thread.id);
    if (!row?.rollout_path) throw new Error('找不到这条对话的历史记录');
    const [handoff, settings] = await Promise.all([
      buildHandoff({ rolloutPath: row.rollout_path, thread }),
      this.threadSettings(thread.id),
    ]);
    return { ...handoff, settings };
  }

  async threadSettings(id) {
    if (!UUID.test(id)) throw new Error('对话 ID 格式无效');
    const record = this.database().prepare('SELECT * FROM threads WHERE id=?').get(id);
    if (!record) throw new Error('找不到来源对话的配置');
    return readThreadSettings({ rolloutPath: record.rollout_path, record });
  }

  inheritance(id) {
    const handoff = this.state.managedThreads[id]?.inheritance;
    return handoff ? structuredClone(handoff) : null;
  }

  threads() {
    const db = this.database();
    const managedIds = Object.keys(this.state.managedThreads);
    const archivedFilter = this.columns.has('archived') ? 'archived = 0 AND ' : '';
    const placeholders = managedIds.map(() => '?').join(',');
    const rows = db.prepare(`SELECT * FROM threads WHERE ${archivedFilter}(source IN ('cli','vscode','appServer','app-server')${managedIds.length ? ` OR id IN (${placeholders})` : ''})`).all(...managedIds);
    this.rolloutMonitor.retain(new Set(rows.map(row => row.rollout_path)));
    const threads = rows.map(row => {
      const managed = this.state.managedThreads[row.id] || {};
      const rollout = this.rollout(row.rollout_path);
      const assignment = this.state.organization.assignments[row.id];
      const inheritedPreview = managed.inheritance?.prompt && rollout.lastMessage === shorten(managed.inheritance.prompt)
        ? managed.preview : null;
      return {
        id: row.id,
        title: shorten(row.name || managed.title || row.title || row.first_user_message || '未命名对话', 120),
        preview: inheritedPreview || rollout.lastMessage || shorten(row.preview || row.first_user_message),
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
        inheritedFromId: managed.inheritedFromId || null,
        status: rollout.activity.status,
        activity: inheritedPreview && rollout.activity.status === 'unknown'
          ? { ...rollout.activity, reason: '交接上下文已载入，发送下一条消息即可继续。' } : rollout.activity,
        archived: false,
      };
    });
    // Official archive/deletion always wins over this board's metadata cache.
    // Created sessions must persist through the official API before remembering them.
    return threads.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  }

  graph(validIds) {
    if (validIds === undefined) return structuredClone({ positions: this.state.positions, edges: this.state.edges });
    return {
      positions: Object.fromEntries(Object.entries(this.state.positions).filter(([id]) => validIds.has(id))),
      edges: this.state.edges.filter(edge => validIds.has(edge.source) && validIds.has(edge.target)).map(edge => ({ ...edge })),
    };
  }

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
    const serialized = JSON.stringify(state, null, 2) + '\n';
    const release = acquireWriteLock(this.lockPath);
    try {
      const current = existsSync(this.graphPath) ? readFileSync(this.graphPath, 'utf8') : null;
      const currentRevision = digest(current);
      if (currentRevision !== this.revision) {
        // Reject the stale mutation, but make the same server usable on retry.
        // Never silently merge a graph or receipt computed from old state.
        if (current !== null) {
          try {
            this.state = parseState(current);
            this.recoveredFromBackup = false;
          } catch (error) {
            if (!existsSync(this.backupPath)) throw new Error('Codex Board 元数据已被外部写坏，且没有可用备份', { cause: error });
            this.state = parseState(readFileSync(this.backupPath, 'utf8'));
            this.recoveredFromBackup = true;
            console.warn('Codex Board 元数据已被外部写坏，已从备份恢复。');
          }
        } else if (existsSync(this.backupPath)) {
          this.state = parseState(readFileSync(this.backupPath, 'utf8'));
          this.recoveredFromBackup = true;
        } else throw new Error('Codex Board 元数据已被外部删除，且没有可用备份');
        this.revision = currentRevision;
        this.corruptPreservedRevision = null;
        throw Object.assign(new Error('Codex Board 元数据已被另一实例修改，现已重新载入，请重试'), { status: 409 });
      }
      if (current !== null && this.recoveredFromBackup && this.corruptPreservedRevision !== currentRevision) {
        writeAtomic(`${this.graphPath}.corrupt-${Date.now()}-${randomUUID()}`, current);
        this.corruptPreservedRevision = currentRevision;
      }
      if (current !== null && !this.recoveredFromBackup) writeAtomic(this.backupPath, current);
      writeAtomic(this.graphPath, serialized);
      this.revision = digest(serialized);
      this.recoveredFromBackup = false;
      this.corruptPreservedRevision = null;
      if (current === null && !existsSync(this.backupPath)) {
        try { writeAtomic(this.backupPath, serialized); }
        catch (error) { console.warn('Codex Board 备份写入失败：', error.message); }
      }
    } finally { release(); }
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
      const hiddenEdges = this.state.edges.filter(edge => !validIds.has(edge.source) || !validIds.has(edge.target));
      nextEdges = [...hiddenEdges, ...patch.edges.map(edge => {
        if (!edge || typeof edge.id !== 'string' || edge.id.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(edge.id) || !validIds.has(edge.source) || !validIds.has(edge.target) || edge.source === edge.target || !['serial', 'parallel', 'reference'].includes(edge.type)) throw new Error('连线端点、类型或 ID 无效');
        const pair = `${edge.source}:${edge.target}`;
        if (seenIds.has(edge.id) || seenPairs.has(pair)) throw new Error('连线重复');
        seenIds.add(edge.id); seenPairs.add(pair);
        return { id: edge.id, source: edge.source, target: edge.target, type: edge.type };
      })];
    }
    const nextState = { ...this.state, positions: nextPositions, edges: nextEdges };
    this.save(nextState);
    this.state = nextState;
    return this.graph(validIds);
  }

  creationRequest(requestId) {
    if (typeof requestId !== 'string' || !UUID.test(requestId)) return null;
    const receipt = this.state.creationRequests[requestId];
    return receipt ? { fingerprint: receipt.fingerprint, threadId: receipt.threadId } : null;
  }

  remember(thread, { requestId, fingerprint, assignment } = {}) {
    if (!thread || typeof thread !== 'object' || !UUID.test(thread.id)) throw new Error('会话元数据无效');
    if (requestId !== undefined && (!UUID.test(requestId) || typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/i.test(fingerprint))) throw new Error('创建请求回执无效');
    if (requestId === undefined && fingerprint !== undefined) throw new Error('创建请求回执无效');
    const managedThreads = { ...this.state.managedThreads, [thread.id]: structuredClone(thread) };
    let creationRequests = this.state.creationRequests;
    if (requestId !== undefined) {
      const previous = this.creationRequest(requestId);
      if (previous && (previous.fingerprint !== fingerprint || previous.threadId !== thread.id)) throw Object.assign(new Error('创建请求 ID 已用于其他会话'), { status: 409 });
      creationRequests = { ...creationRequests, [requestId]: { fingerprint, threadId: thread.id } };
      const oldest = Object.keys(creationRequests).slice(0, Math.max(0, Object.keys(creationRequests).length - 1000));
      for (const id of oldest) delete creationRequests[id];
    }
    let organization = this.state.organization;
    if (assignment !== undefined) {
      const assignments = { ...organization.assignments };
      if (assignment === null) delete assignments[thread.id];
      else {
        if (!isRecord(assignment) || Object.keys(assignment).some(key => !['projectId', 'taskId'].includes(key)) ||
          typeof assignment.projectId !== 'string' || !UUID.test(assignment.projectId) ||
          !organization.projects.some(project => project.id === assignment.projectId) ||
          (assignment.taskId != null && (typeof assignment.taskId !== 'string' || !UUID.test(assignment.taskId) ||
            !organization.tasks.some(task => task.id === assignment.taskId && task.projectId === assignment.projectId)))) throw new Error('项目或任务分配无效');
        assignments[thread.id] = { projectId: assignment.projectId, taskId: assignment.taskId ?? null };
      }
      organization = { ...organization, assignments };
    }
    const nextState = { ...this.state, managedThreads, creationRequests, organization };
    this.save(nextState);
    this.state = nextState;
  }
  close() { this.db?.close(); }
}
