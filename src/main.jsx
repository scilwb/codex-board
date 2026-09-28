import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ReactFlow, Background, Controls, Handle, Position, MarkerType, BaseEdge,
  applyNodeChanges, ConnectionMode,
} from '@xyflow/react';
import {
  ArrowUpRight, Check, ChevronDown, Copy, FolderOpen, GitBranch,
  GitFork, Link2, LoaderCircle, Map as MapIcon, Plus, Search, Trash2, X, Pencil, Layers,
} from 'lucide-react';
import '@xyflow/react/dist/style.css';
import { routeAroundCards } from './edgeRouting.js';
import './styles.css';

const RELATIONS = { serial: '串行', parallel: '并行', reference: '参考' };
const emptyGraph = { positions: {}, edges: [] };
const emptyOrganization = { projects: [], tasks: [], assignments: {} };

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  let body;
  try { body = await response.json(); } catch { body = {}; }
  if (!response.ok) throw new Error(body.error || body.message || `请求失败（${response.status}）`);
  return body;
}

function relativeTime(value) {
  const elapsed = Math.max(0, Date.now() - Number(value || 0));
  if (!value) return '时间未知';
  if (elapsed < 60_000) return '刚刚';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)} 天前`;
  return new Date(Number(value)).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

function projectKey(thread) { return thread.cwd || thread.project || '未知文件夹'; }
function shortPath(value) { return (value || '').replace(/^\/home\/[^/]+\//, '~/'); }
function projectName(value) { return value.split('/').filter(Boolean).at(-1) || value; }
function titleOf(thread) { return thread?.title?.trim() || '未命名对话'; }
function edgeSignature(edges) {
  return JSON.stringify(edges.map(({ id, source, target, type }) => ({ id, source, target, type })).sort((a, b) => a.id.localeCompare(b.id)));
}

const SessionCard = React.memo(function SessionCard({ id, data, selected }) {
  const { thread, onCopy, onOpen, onFork, canFork, canOpen, opening, project, task } = data;
  return (
    <article className={`session-card ${selected ? 'is-selected' : ''}`} data-testid={`session-node-${id}`}>
      <Handle type="target" position={Position.Left} className="connection-handle" data-testid={`session-target-${id}`} aria-label="连接到此对话" />
      <div className="card-heading">
        <span className={`status-dot ${thread.status === 'active' ? 'active' : ''}`} title={thread.status === 'active' ? '运行中' : thread.status === 'idle' ? '空闲' : '运行状态未知'} />
        <span className="card-time">{relativeTime(thread.updatedAt)}</span>
        <span className="card-branch" title={`Git 分支：${thread.branch || '未知'}`}><GitBranch size={10} /><span>{thread.branch || '分支未知'}</span></span>
        {thread.forkedFromId && <span className="fork-badge"><GitFork size={11} /> Fork</span>}
      </div>
      <h3 title={titleOf(thread)}>{titleOf(thread)}</h3>
      <p className="card-preview">{thread.preview || '暂无内容预览'}</p>
      <div className={`card-taxonomy ${project ? '' : 'unassigned'}`} title={project ? `${project.name}${task ? ` / ${task.name}` : ''}` : '未归类'}><span>{project?.name || '未归类'}</span>{task && <><span className="taxonomy-separator">/</span><span>{task.name}</span></>}</div>
      <div className="card-actions nodrag nopan">
        <button className="card-open" disabled={!canOpen} data-testid={`open-${id}`} onClick={(event) => { event.stopPropagation(); onOpen(thread); }}>{opening ? <LoaderCircle size={14} className="spin" /> : <ArrowUpRight size={14} />}{opening ? '正在定位…' : 'VS Code'}</button>
        <button className="card-copy" title="复制对话 ID" aria-label="复制对话 ID" data-testid={`copy-${id}`} onClick={(event) => { event.stopPropagation(); onCopy(thread.id); }}><Copy size={13} /><span>ID</span></button>
        <button className="icon-button fork-button" title="从此对话 Fork" aria-label="从此对话 Fork" disabled={!canFork} data-testid={`fork-${id}`} onClick={(event) => { event.stopPropagation(); onFork(thread); }}><GitFork size={14} /></button>
      </div>
      <Handle type="source" position={Position.Right} className="connection-handle" data-testid={`session-source-${id}`} aria-label="从此对话连线" />
    </article>
  );
});
const nodeTypes = { session: SessionCard };

function RoutedEdge(props) {
  const route = routeAroundCards({ ...props, cards: props.data?.cards || [] });
  return <BaseEdge id={props.id} path={route.path} labelX={route.labelX} labelY={route.labelY} label={props.label} markerStart={props.markerStart} markerEnd={props.markerEnd} style={props.style} interactionWidth={props.interactionWidth} labelStyle={props.labelStyle} labelBgStyle={props.labelBgStyle} labelBgPadding={props.labelBgPadding} labelBgBorderRadius={props.labelBgBorderRadius} />;
}
const edgeTypes = { routed: RoutedEdge };

function App() {
  const [snapshot, setSnapshot] = useState({ threads: [], graph: emptyGraph, organization: emptyOrganization, capabilities: {} });
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [selectedProject, setSelectedProject] = useState('');
  const [selectedTask, setSelectedTask] = useState('');
  const [folder, setFolder] = useState('');
  const [organizationModal, setOrganizationModal] = useState(null);
  const [organizationSaving, setOrganizationSaving] = useState(false);
  const [branch, setBranch] = useState('');
  const [search, setSearch] = useState('');
  const [nodes, setNodes] = useState([]);
  const [selectedThreadId, setSelectedThreadId] = useState(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState(null);
  const [relationType, setRelationType] = useState('reference');
  const [modal, setModal] = useState(null);
  const [windowPicker, setWindowPicker] = useState(null);
  const [openingThreadId, setOpeningThreadId] = useState(null);
  const [toast, setToast] = useState(null);
  const [workspaceOptions, setWorkspaceOptions] = useState([]);
  const [saving, setSaving] = useState(false);
  const flow = useRef(null);
  const positions = useRef({});
  const dragging = useRef(new Set());
  const localEdges = useRef(null);
  const graph = useRef(emptyGraph);
  const lastSnapshot = useRef(0);
  const toastTimer = useRef(null);
  const fitTimer = useRef(null);
  const mounted = useRef(true);
  const saveQueue = useRef(Promise.resolve());
  const opening = useRef(false);
  const windowTargets = useRef((() => { try { return JSON.parse(localStorage.getItem('codex-board.window-targets') || '{}'); } catch { return {}; } })());
  const selectionKey = `${selectedProject}|${selectedTask}|${folder}|${branch}|${search}`;

  const notify = useCallback((message, kind = 'success') => {
    clearTimeout(toastTimer.current);
    setToast({ message, kind });
    toastTimer.current = setTimeout(() => setToast(null), kind === 'error' ? 6500 : 3200);
  }, []);

  const receiveSnapshot = useCallback((next) => {
    if (!next || !Array.isArray(next.threads)) return;
    lastSnapshot.current = Date.now();
    const incoming = { positions: {}, edges: [], ...next.graph };
    for (const [id, position] of Object.entries(positions.current)) {
      const saved = incoming.positions[id];
      if (!dragging.current.has(id) && saved && saved.x === position.x && saved.y === position.y) delete positions.current[id];
    }
    if (localEdges.current && edgeSignature(incoming.edges) === edgeSignature(localEdges.current)) localEdges.current = null;
    graph.current = { positions: { ...incoming.positions, ...positions.current }, edges: localEdges.current || incoming.edges };
    setSnapshot({ ...next, graph: graph.current, organization: next.organization || emptyOrganization, capabilities: next.capabilities || {} });
    setError(next.error || '');
    setLoading(false);
  }, []);

  useEffect(() => {
    mounted.current = true;
    let stopped = false;
    const refresh = () => api('/api/snapshot').then((next) => { if (!stopped) receiveSnapshot(next); }).catch((err) => { if (!stopped) { setError(err.message); setLoading(false); } });
    refresh();
    api('/api/projects').then((result) => { if (!stopped) setWorkspaceOptions(result.projects || []); }).catch(() => {});
    const events = new EventSource('/api/events');
    events.onopen = () => setConnected(true);
    events.onerror = () => setConnected(false);
    events.addEventListener('snapshot', (event) => {
      try { receiveSnapshot(JSON.parse(event.data)); setConnected(true); } catch { setError('同步数据无法读取，正在重试。'); }
    });
    const interval = setInterval(() => { if (document.visibilityState === 'visible' && Date.now() - lastSnapshot.current > 15_000) refresh(); }, 10_000);
    return () => { stopped = true; mounted.current = false; events.close(); clearInterval(interval); clearTimeout(toastTimer.current); };
  }, [receiveSnapshot]);

  const threads = useMemo(() => [...snapshot.threads].filter((thread) => !thread.archived).sort((a, b) => b.updatedAt - a.updatedAt), [snapshot.threads]);
  const organization = snapshot.organization || emptyOrganization;
  const folders = useMemo(() => {
    const map = new Map();
    threads.forEach((thread) => {
      const key = projectKey(thread);
      if (!map.has(key)) map.set(key, { key, name: projectName(key), cwd: thread.cwd, count: 0 });
      map.get(key).count++;
    });
    return [...map.values()];
  }, [threads]);
  const projects = useMemo(() => organization.projects.map((project) => ({ ...project, count: threads.filter((thread) => organization.assignments[thread.id]?.projectId === project.id).length })), [organization, threads]);
  const unassignedCount = threads.filter((thread) => !organization.assignments[thread.id]?.projectId).length;
  const projectThreads = useMemo(() => threads.filter((thread) => {
    const assignment = organization.assignments[thread.id];
    if (selectedProject === 'unassigned') return !assignment?.projectId;
    return !selectedProject || assignment?.projectId === selectedProject;
  }), [threads, selectedProject, organization.assignments]);
  const tasks = useMemo(() => organization.tasks.filter((task) => task.projectId === selectedProject), [organization.tasks, selectedProject]);
  const scopedThreads = useMemo(() => projectThreads.filter((thread) => {
    if (folder && projectKey(thread) !== folder) return false;
    const taskId = organization.assignments[thread.id]?.taskId;
    return selectedTask === 'unassigned' ? !taskId : !selectedTask || taskId === selectedTask;
  }), [projectThreads, folder, selectedTask, organization.assignments]);
  const branches = useMemo(() => [...new Set(scopedThreads.map((thread) => thread.branch || '分支未知'))].sort(), [scopedThreads]);
  const visibleThreads = useMemo(() => scopedThreads.filter((thread) => {
    if (branch && (thread.branch || '分支未知') !== branch) return false;
    const query = search.trim().toLowerCase();
    return !query || `${titleOf(thread)} ${thread.id}`.toLowerCase().includes(query);
  }), [scopedThreads, branch, search]);
  const layoutThreads = useMemo(() => {
    const byId = new Map(visibleThreads.map((thread) => [thread.id, thread]));
    const children = new Map();
    visibleThreads.forEach((thread) => {
      if (!children.has(thread.forkedFromId)) children.set(thread.forkedFromId, []);
      children.get(thread.forkedFromId).push(thread);
    });
    const placed = new Set();
    const ordered = [];
    const visit = (thread) => {
      if (placed.has(thread.id)) return;
      placed.add(thread.id); ordered.push(thread);
      (children.get(thread.id) || []).forEach(visit);
    };
    visibleThreads.forEach((thread) => {
      let ancestor = thread;
      const checked = new Set([thread.id]);
      while (byId.has(ancestor.forkedFromId) && !checked.has(ancestor.forkedFromId)) {
        ancestor = byId.get(ancestor.forkedFromId); checked.add(ancestor.id);
      }
      visit(ancestor);
    });
    visibleThreads.forEach(visit);
    return ordered;
  }, [visibleThreads]);
  const selectedThread = threads.find((thread) => thread.id === selectedThreadId);
  const selectedAssignment = organization.assignments[selectedThreadId] || {};
  const selectedProjectName = selectedProject === 'unassigned' ? '未归类' : projects.find((project) => project.id === selectedProject)?.name || '全部对话';
  const selectedManualEdge = snapshot.graph.edges.find((edge) => edge.id === selectedEdgeId);
  const selectedFork = selectedEdgeId?.startsWith('fork:') ? threads.find((thread) => `fork:${thread.id}` === selectedEdgeId) : null;

  const updateOrganization = useCallback(async (patch) => {
    setOrganizationSaving(true);
    try {
      const result = await api('/api/organization', { method: 'PATCH', body: JSON.stringify(patch) });
      setSnapshot((current) => ({ ...current, organization: result.organization }));
      return result.organization;
    } finally { setOrganizationSaving(false); }
  }, []);
  const assignThread = async (projectId, taskId = null) => {
    try { await updateOrganization({ action: 'assign', threadIds: [selectedThreadId], projectId: projectId || null, taskId: taskId || null }); }
    catch (err) { notify(`分类保存失败：${err.message}`, 'error'); }
  };
  const chooseProject = (id) => {
    setSelectedProject(id); setSelectedTask(''); setFolder(''); setBranch('');
    setSelectedThreadId(null); setSelectedEdgeId(null);
  };
  useEffect(() => {
    if (selectedProject && selectedProject !== 'unassigned' && !organization.projects.some((project) => project.id === selectedProject)) setSelectedProject('');
    if (selectedTask && selectedTask !== 'unassigned' && !organization.tasks.some((task) => task.id === selectedTask && task.projectId === selectedProject)) setSelectedTask('');
  }, [organization, selectedProject, selectedTask]);

  const persist = useCallback((patch) => {
    setSaving(true);
    const request = saveQueue.current.catch(() => {}).then(() => api('/api/graph', { method: 'PATCH', body: JSON.stringify(patch) }));
    saveQueue.current = request;
    request.catch((err) => { if (mounted.current) notify(`保存失败：${err.message}`, 'error'); }).finally(() => { if (mounted.current && saveQueue.current === request) setSaving(false); });
    return request;
  }, [notify]);

  const copyId = useCallback(async (id) => {
    try { await navigator.clipboard.writeText(id); notify('已复制对话 ID'); }
    catch { notify('复制失败，请在详情中选中 ID 复制。', 'error'); }
  }, [notify]);
  const launchThread = useCallback(async (thread, windowId, windowTitle = '') => {
    opening.current = true;
    setOpeningThreadId(thread.id);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const result = await api(`/api/threads/${encodeURIComponent(thread.id)}/open-vscode`, { method: 'POST', body: JSON.stringify({ windowId }), signal: controller.signal });
      if (!result.opened || !result.verified) throw new Error(result.message || 'VS Code 未确认打开，请检查编辑器连接。');
      if (windowId !== undefined) {
        windowTargets.current[thread.cwd || projectKey(thread)] = { id: windowId, title: windowTitle };
        try { localStorage.setItem('codex-board.window-targets', JSON.stringify(windowTargets.current)); } catch { /* Browser storage may be disabled. */ }
      }
      setWindowPicker(null);
      notify(result.reused ? '已定位到已打开的对话' : '已打开 VS Code 对话标签');
    } catch (err) {
      if (err.name === 'AbortError') err = new Error('定位超时，请检查 VS Code 是否响应后再试。');
      notify(`打开失败：${err.message}`, 'error'); err.reported = true; throw err;
    } finally { clearTimeout(timeout); opening.current = false; setOpeningThreadId(null); }
  }, [notify]);
  const openThread = useCallback(async (thread, chooseWindow = false) => {
    if (opening.current) return;
    opening.current = true;
    setOpeningThreadId(thread.id);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const result = await api('/api/vscode/windows', { signal: controller.signal });
      const windows = result.windows || [];
      if (!windows.length || result.bridgeAvailable === false) {
        notify(result.error || 'VS Code 连接未就绪，可在 VS Code 运行 Codex Board: Connect', 'error'); return;
      }
      const saved = windowTargets.current[thread.cwd || projectKey(thread)];
      const validSaved = windows.find((window) => saved && typeof saved === 'object' && window.id === saved.id && window.title === saved.title);
      const alreadyOpen = windows.filter((window) => window.openThreads?.includes(thread.id));
      const sameFolder = windows.filter((window) => window.folders?.includes(thread.cwd));
      const destination = !chooseWindow && alreadyOpen.length === 1 ? alreadyOpen[0] : validSaved;
      if (windows.length > 1 && (chooseWindow || !destination)) {
        setWindowPicker({ thread, windows, selected: destination?.id ?? sameFolder[0]?.id ?? windows[0].id });
        return;
      }
      const target = destination || windows[0];
      await launchThread(thread, target.id, target.title);
    } catch (err) { if (!err.reported) notify(`打开失败：${err.name === 'AbortError' ? '连接检查超时，请稍后再试。' : err.message}`, 'error'); }
    finally { clearTimeout(timeout); opening.current = false; setOpeningThreadId(null); }
  }, [launchThread, notify]);
  const forkThread = useCallback((thread) => setModal({ kind: 'fork', thread, cwd: thread.cwd, title: `${titleOf(thread).slice(0, 112)} · Fork`, ...organization.assignments[thread.id] }), [organization.assignments]);

  useEffect(() => {
    setNodes((current) => {
      const existing = new Map(current.map((node) => [node.id, node]));
      const assigned = new Map();
      layoutThreads.forEach((thread) => {
        const position = positions.current[thread.id] || snapshot.graph.positions[thread.id] || existing.get(thread.id)?.position;
        if (position) assigned.set(thread.id, position);
      });
      return layoutThreads.map((thread, index) => {
        const old = existing.get(thread.id);
        let position = assigned.get(thread.id);
        if (!position) {
          let slot = index;
          do {
            position = { x: (slot % 3) * 350 + 40, y: Math.floor(slot / 3) * 228 + 40 };
            slot++;
          } while ([...assigned.values()].some((used) => Math.abs(used.x - position.x) < 310 && Math.abs(used.y - position.y) < 195));
          assigned.set(thread.id, position);
        }
        return {
          ...old,
          id: thread.id,
          type: 'session',
          position,
          selected: thread.id === selectedThreadId,
          data: { thread, onCopy: copyId, onOpen: openThread, onFork: forkThread, canFork: snapshot.capabilities.fork !== false, canOpen: snapshot.capabilities.openVscode !== false && !openingThreadId, opening: openingThreadId === thread.id, project: organization.projects.find((project) => project.id === organization.assignments[thread.id]?.projectId), task: organization.tasks.find((task) => task.id === organization.assignments[thread.id]?.taskId) },
        };
      });
    });
  }, [layoutThreads, snapshot.graph.positions, snapshot.capabilities, selectedThreadId, copyId, openThread, forkThread, organization, openingThreadId]);

  useEffect(() => {
    fitTimer.current = setTimeout(() => {
      if (flow.current && visibleThreads.length) {
        flow.current.fitView({ nodes: visibleThreads.slice(0, 6).map(({ id }) => ({ id })), padding: 0.22, minZoom: 0.6, maxZoom: 1, duration: 0 });
      }
    }, 90);
    return () => clearTimeout(fitTimer.current);
    // Fit after a deliberate filter change, preserving the viewport during sync.
  }, [selectionKey]);

  const flowEdges = useMemo(() => {
    const ids = new Set(visibleThreads.map((thread) => thread.id));
    const cards = nodes.map((node) => ({ id: node.id, x: node.position.x, y: node.position.y, width: node.measured?.width || 290, height: node.measured?.height || 185 }));
    const manual = snapshot.graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)).map((edge) => ({
      ...edge,
      type: 'routed',
      data: { relation: edge.type, cards },
      label: RELATIONS[edge.type] || edge.type,
      selected: edge.id === selectedEdgeId,
      markerEnd: edge.type === 'parallel' ? undefined : { type: MarkerType.ArrowClosed, color: edge.id === selectedEdgeId ? '#35755a' : '#a4b0a9', width: 15, height: 15 },
      style: { stroke: edge.id === selectedEdgeId ? '#35755a' : '#a4b0a9', strokeWidth: edge.id === selectedEdgeId ? 2 : 1.5, strokeDasharray: edge.type === 'reference' ? '5 5' : undefined },
      labelStyle: { fill: '#617068', fontSize: 11 }, labelBgStyle: { fill: '#f7f8f5' }, labelBgPadding: [6, 3], labelBgBorderRadius: 4,
      interactionWidth: 20,
    }));
    const forks = visibleThreads.filter((thread) => thread.forkedFromId && ids.has(thread.forkedFromId)).map((thread) => ({
      id: `fork:${thread.id}`, source: thread.forkedFromId, target: thread.id, type: 'routed', label: 'Fork', data: { cards },
      deletable: false, selected: selectedEdgeId === `fork:${thread.id}`,
      markerEnd: { type: MarkerType.ArrowClosed, color: '#a29ab7', width: 14, height: 14 },
      style: { stroke: '#a29ab7', strokeWidth: 1.4, strokeDasharray: '3 5' },
      labelStyle: { fill: '#887c9d', fontSize: 11 }, labelBgStyle: { fill: '#f7f8f5' }, labelBgPadding: [6, 3], labelBgBorderRadius: 4,
      interactionWidth: 20,
    }));
    return [...forks, ...manual];
  }, [snapshot.graph.edges, visibleThreads, selectedEdgeId, nodes]);

  const saveEdges = useCallback(async (edges) => {
    const before = graph.current.edges;
    localEdges.current = edges;
    graph.current = { ...graph.current, edges };
    setSnapshot((current) => ({ ...current, graph: { ...current.graph, edges } }));
    try { await persist({ edges }); }
    catch {
      localEdges.current = null;
      graph.current = { ...graph.current, edges: before };
      setSnapshot((current) => ({ ...current, graph: { ...current.graph, edges: before } }));
    }
  }, [persist]);
  const onConnect = useCallback(({ source, target }) => {
    if (!source || !target || source === target) return;
    if (graph.current.edges.some((edge) => edge.source === source && edge.target === target)) { notify('这两条对话已有连线，点击连线可修改。'); return; }
    const edge = { id: crypto.randomUUID(), source, target, type: relationType };
    saveEdges([...graph.current.edges, edge]);
    setSelectedEdgeId(edge.id);
    setSelectedThreadId(null);
  }, [relationType, saveEdges, notify]);
  const focusThread = useCallback((thread) => {
    setSelectedThreadId(thread.id);
    setSelectedEdgeId(null);
    setTimeout(() => flow.current?.fitView({ nodes: [{ id: thread.id }], padding: 1.5, maxZoom: 1.05, duration: 250 }), 30);
  }, []);
  const openNew = () => setModal({ kind: 'new', cwd: folder || visibleThreads[0]?.cwd || projectThreads[0]?.cwd || workspaceOptions[0]?.cwd || '', title: '', projectId: selectedProject === 'unassigned' ? null : selectedProject || null, taskId: selectedTask === 'unassigned' ? null : selectedTask || null });
  const onCreated = async (thread, assignment) => {
    setModal(null);
    setBranch('');
    setSearch('');
    setSelectedProject(assignment?.projectId || '');
    setSelectedTask(assignment?.taskId || '');
    setFolder('');
    setSelectedThreadId(thread.id);
    setSelectedEdgeId(null);
    notify('对话已创建，可打开 VS Code 继续。');
    try { receiveSnapshot(await api('/api/snapshot')); } catch (err) { notify(err.message, 'error'); }
    setTimeout(() => flow.current?.fitView({ nodes: [{ id: thread.id }], padding: 1.5, maxZoom: 1, duration: 200 }), 250);
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><MapIcon size={21} strokeWidth={1.65} /></span><div><strong>Codex Board</strong><span>对话地图</span></div></div>
        <button className="new-thread-button" onClick={openNew} disabled={loading || snapshot.capabilities.create === false} data-testid="new-thread"><Plus size={16} /> 新建对话</button>
        <div className="sidebar-section-label"><span>项目 · 研究方向</span><div className="section-actions"><button className="icon-button" title="管理项目和任务" aria-label="管理项目和任务" data-testid="manage-organization" onClick={() => setOrganizationModal({ projectId: selectedProject })}><Pencil size={12} /></button><button className="icon-button" title="新建项目" aria-label="新建项目" data-testid="add-project" onClick={() => setOrganizationModal({ action: 'createProject' })}><Plus size={14} /></button></div></div>
        <nav className="project-list" aria-label="项目">
          <button className={`project-item ${selectedProject === '' ? 'selected' : ''}`} onClick={() => chooseProject('')} data-testid="project-all"><Layers size={15} /><span>全部项目</span><em>{threads.length}</em></button>
          <button className={`project-item ${selectedProject === 'unassigned' ? 'selected' : ''}`} onClick={() => chooseProject('unassigned')} data-testid="project-unassigned"><span className="unassigned-symbol">·</span><span>未归类</span><em>{unassignedCount}</em></button>
          {projects.map((project) => <button key={project.id} className={`project-item ${selectedProject === project.id ? 'selected' : ''}`} title={project.name} onClick={() => chooseProject(project.id)} data-testid="project-item" data-project-id={project.id}><Layers size={15} /><span>{project.name}</span><em>{project.count}</em></button>)}
        </nav>
        {selectedProject && selectedProject !== 'unassigned' && <div className="task-filter"><div className="sidebar-section-label"><span>任务</span><button className="icon-button" title="新建任务" aria-label="新建任务" data-testid="add-task" onClick={() => setOrganizationModal({ projectId: selectedProject, action: 'createTask' })}><Plus size={14} /></button></div><select className="form-input" aria-label="筛选任务" data-testid="task-filter" value={selectedTask} onChange={(event) => { setSelectedTask(event.target.value); setBranch(''); setSelectedThreadId(null); setSelectedEdgeId(null); }}><option value="">全部任务</option><option value="unassigned">未指定任务</option>{tasks.map((task) => <option key={task.id} value={task.id}>{task.name}</option>)}</select></div>}
        <div className="sidebar-section-label thread-list-label">对话 <span>{visibleThreads.length}</span></div>
        <label className="search-box"><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索标题 / ID" aria-label="搜索标题或 ID" data-testid="thread-search" />{search && <button onClick={() => setSearch('')} aria-label="清空搜索"><X size={12} /></button>}</label>
        <div className="thread-list" data-testid="thread-list">
          {visibleThreads.map((thread) => <button className={`thread-list-item ${thread.id === selectedThreadId ? 'selected' : ''}`} key={thread.id} title={`${titleOf(thread)}\n${thread.id}`} onClick={() => focusThread(thread)} data-testid={`thread-list-${thread.id}`}><span className={`list-thread-dot ${thread.status === 'active' ? 'active' : ''}`} /><span className="list-thread-text"><strong>{titleOf(thread)}</strong><small>{relativeTime(thread.updatedAt)}</small></span></button>)}
          {!loading && !visibleThreads.length && <p className="sidebar-empty">{search ? '没有匹配的对话' : '暂无对话'}</p>}
        </div>
        <div className="sidebar-footer"><span className={`sync-indicator ${connected ? 'connected' : ''}`} /><span data-testid="sync-status">{loading ? '正在读取…' : connected ? '本机同步已连接' : '同步连接已断开，重试中'}</span>{(saving || organizationSaving) && <LoaderCircle size={12} className="spin" aria-label="正在保存" />}</div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="workspace-heading"><span className="eyebrow">{selectedTask && selectedTask !== 'unassigned' ? tasks.find((task) => task.id === selectedTask)?.name : '对话地图'}</span><h1>{selectedProjectName}<span>{visibleThreads.length}</span></h1></div>
          <div className="toolbar"><label className="branch-select folder-select" title={folder || '按文件夹筛选'}><FolderOpen size={14} /><select aria-label="筛选文件夹" data-testid="folder-filter" value={folder} onChange={(event) => { setFolder(event.target.value); setBranch(''); setSelectedThreadId(null); setSelectedEdgeId(null); }}><option value="">全部文件夹</option>{folders.map((item) => <option key={item.key} value={item.key}>{shortPath(item.key)}</option>)}</select><ChevronDown size={12} /></label><label className="branch-select"><GitBranch size={14} /><select aria-label="筛选 Git 分支" data-testid="branch-filter" value={branch} onChange={(event) => { setBranch(event.target.value); setSelectedThreadId(null); setSelectedEdgeId(null); }}><option value="">全部分支</option>{branches.map((name) => <option key={name} value={name}>{name}</option>)}</select><ChevronDown size={12} /></label><span className="toolbar-divider" /><label className="relation-select"><Link2 size={14} /><span>连线</span><select aria-label="新连线关系" data-testid="relation-type" value={relationType} onChange={(event) => setRelationType(event.target.value)}>{Object.entries(RELATIONS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label></div>
        </header>
        {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={async () => { try { receiveSnapshot(await api('/api/snapshot')); } catch (err) { setError(err.message); } }}>重试</button></div>}
        <div className="canvas-area">
          <ReactFlow nodes={nodes} edges={flowEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onInit={(instance) => { flow.current = instance; }} onNodesChange={(changes) => setNodes((current) => applyNodeChanges(changes, current))} onNodeDragStart={(_event, node) => { clearTimeout(fitTimer.current); dragging.current.add(node.id); positions.current[node.id] = node.position; }} onNodeDrag={(_event, node) => { positions.current[node.id] = node.position; }} onNodeDragStop={(_event, node) => { dragging.current.delete(node.id); positions.current[node.id] = node.position; graph.current.positions[node.id] = node.position; persist({ positions: { [node.id]: node.position } }).catch(() => {}); }} onNodeClick={(_event, node) => { setSelectedThreadId(node.id); setSelectedEdgeId(null); }} onEdgeClick={(_event, edge) => { setSelectedEdgeId(edge.id); setSelectedThreadId(null); }} onPaneClick={() => { setSelectedThreadId(null); setSelectedEdgeId(null); }} onConnect={onConnect} onConnectStart={() => clearTimeout(fitTimer.current)} connectionMode={ConnectionMode.Loose} isValidConnection={(connection) => connection.source !== connection.target} minZoom={0.2} maxZoom={1.8} deleteKeyCode={null} fitView fitViewOptions={{ padding: 0.18, minZoom: 0.6, maxZoom: 1 }} onlyRenderVisibleElements proOptions={{ hideAttribution: true }} aria-label="对话关系画布">
            <Background color="#dce2d9" gap={22} size={1} />
            <Controls showInteractive={false} position="bottom-left" />
          </ReactFlow>
          {!loading && visibleThreads.length > 0 && <div className="canvas-hint">拖动卡片调整位置 · 拖动两侧圆点连接对话</div>}
          {loading && <div className="canvas-empty"><LoaderCircle className="spin" size={26} /><h2>正在读取本机对话</h2></div>}
          {!loading && visibleThreads.length === 0 && <div className="canvas-empty"><span className="empty-icon"><MapIcon size={29} strokeWidth={1.3} /></span><h2>{search || branch ? '没有匹配的对话' : '从一条对话开始'}</h2><p>{search || branch ? '调整搜索或分支筛选后再试。' : '本机 Codex 对话会自动出现在这里。'}</p>{!search && !branch && <button className="primary-button" onClick={openNew} disabled={snapshot.capabilities.create === false}><Plus size={14} /> 新建对话</button>}</div>}

          {selectedThread && <aside className="detail-panel" data-testid="thread-detail">
            <div className="detail-heading"><span>对话详情</span><button className="icon-button" aria-label="关闭详情" onClick={() => setSelectedThreadId(null)}><X size={16} /></button></div>
            <h2>{titleOf(selectedThread)}</h2>
            <p className="detail-preview">{selectedThread.preview || '暂无内容预览'}</p>
            <div className="assignment-fields"><div className="assignment-label"><label htmlFor="assign-project">项目</label><button className="icon-button" aria-label="编辑项目和任务" title="编辑项目和任务" onClick={() => setOrganizationModal({ projectId: selectedAssignment.projectId })}><Pencil size={12} /></button></div><select id="assign-project" className="form-input" data-testid="assign-project" value={selectedAssignment.projectId || ''} disabled={organizationSaving} onChange={(event) => assignThread(event.target.value)}><option value="">未归类</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select><div className="assignment-label"><label htmlFor="assign-task">任务</label>{selectedAssignment.projectId && <button className="icon-button" aria-label="添加项目任务" title="添加项目任务" onClick={() => setOrganizationModal({ projectId: selectedAssignment.projectId, action: 'createTask' })}><Plus size={12} /></button>}</div><select id="assign-task" className="form-input" data-testid="assign-task" value={selectedAssignment.taskId || ''} disabled={organizationSaving || !selectedAssignment.projectId} onChange={(event) => assignThread(selectedAssignment.projectId, event.target.value)}><option value="">未指定任务</option>{organization.tasks.filter((task) => task.projectId === selectedAssignment.projectId).map((task) => <option key={task.id} value={task.id}>{task.name}</option>)}</select></div>
            <dl><dt>对话 ID <button className="icon-button" aria-label="复制详情中的对话 ID" data-testid="detail-copy" onClick={() => copyId(selectedThread.id)}><Copy size={12} /></button></dt><dd className="thread-id" data-testid="detail-thread-id">{selectedThread.id}</dd><dt>文件夹</dt><dd>{shortPath(selectedThread.cwd) || '未知'}</dd><dt>Git 分支</dt><dd>{selectedThread.branch || '分支未知'}</dd><dt>最近活动</dt><dd>{selectedThread.updatedAt ? new Date(Number(selectedThread.updatedAt)).toLocaleString('zh-CN') : '未知'}</dd>{selectedThread.forkedFromId && <><dt>Fork 来源</dt><dd className="thread-id">{selectedThread.forkedFromId}</dd></>}</dl>
            <button className="primary-button full-width" onClick={() => openThread(selectedThread)} disabled={snapshot.capabilities.openVscode === false || !!openingThreadId} data-testid="detail-open">{openingThreadId === selectedThread.id ? <LoaderCircle size={15} className="spin" /> : <ArrowUpRight size={15} />}{openingThreadId === selectedThread.id ? '正在定位…' : '在 VS Code 打开'}</button><button className="change-window" onClick={() => openThread(selectedThread, true)} disabled={snapshot.capabilities.openVscode === false || !!openingThreadId} data-testid="change-window">选择其他 VS Code 窗口</button><button className="secondary-button full-width" onClick={() => forkThread(selectedThread)} disabled={snapshot.capabilities.fork === false} data-testid="detail-fork"><GitFork size={14} /> 从此对话 Fork</button>
          </aside>}
          {(selectedManualEdge || selectedFork) && <aside className="detail-panel relation-panel" data-testid="edge-detail"><div className="detail-heading"><span>{selectedFork ? 'Fork 关系' : '编辑关系'}</span><button className="icon-button" aria-label="关闭关系详情" onClick={() => setSelectedEdgeId(null)}><X size={16} /></button></div><div className="edge-endpoints"><span>{titleOf(threads.find((thread) => thread.id === (selectedManualEdge?.source || selectedFork?.forkedFromId)))}</span><span className="edge-direction">↓</span><span>{titleOf(threads.find((thread) => thread.id === (selectedManualEdge?.target || selectedFork?.id)))}</span></div>{selectedManualEdge ? <><label className="field-label" htmlFor="edge-kind">关系类型</label><select id="edge-kind" className="form-input" value={selectedManualEdge.type} data-testid="edge-type" onChange={(event) => saveEdges(graph.current.edges.map((edge) => edge.id === selectedManualEdge.id ? { ...edge, type: event.target.value } : edge))}>{Object.entries(RELATIONS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><p className="field-note">用于标记对话关系，不会自动传递上下文或执行任务。</p><button className="danger-button full-width" data-testid="delete-edge" onClick={() => { saveEdges(graph.current.edges.filter((edge) => edge.id !== selectedManualEdge.id)); setSelectedEdgeId(null); }}><Trash2 size={13} /> 删除连线</button></> : <p className="field-note">这条关系来自 Codex 的真实 Fork 记录，自动同步。</p>}</aside>}
        </div>
      </main>
      {modal && <ThreadModal modal={modal} folders={workspaceOptions.length ? workspaceOptions : folders} organization={organization} onClose={() => setModal(null)} onCreated={onCreated} />}
      {organizationModal && <OrganizationModal initial={organizationModal} organization={organization} onClose={() => setOrganizationModal(null)} onSave={updateOrganization} />}
      {windowPicker && <WindowPicker picker={windowPicker} onClose={() => setWindowPicker(null)} onOpen={launchThread} />}
      {toast && <div className={`toast ${toast.kind}`} role="status" data-testid="toast">{toast.kind === 'success' ? <Check size={15} /> : <X size={15} />}{toast.message}</div>}
    </div>
  );
}

function WindowPicker({ picker, onClose, onOpen }) {
  const [selected, setSelected] = useState(picker.selected);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const handler = (event) => { if (event.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, busy]);
  return <div className="modal-overlay"><section className="modal window-modal" role="dialog" aria-modal="true" aria-labelledby="window-modal-title" data-testid="window-picker"><div className="modal-heading"><span className="modal-icon"><ArrowUpRight size={21} /></span><button className="icon-button" disabled={busy} onClick={onClose} aria-label="关闭窗口选择"><X size={18} /></button></div><h2 id="window-modal-title">在哪个窗口打开？</h2><p className="modal-description">已打开多个 VS Code 窗口。选择会记住，供这个文件夹下次使用。</p><div className="window-options">{picker.windows.map((window) => <label className={`window-option ${selected === window.id ? 'selected' : ''}`} key={window.id}><input type="radio" name="vscode-window" checked={selected === window.id} onChange={() => setSelected(window.id)} disabled={busy} data-testid={`window-option-${window.id}`} /><span>{window.title || `VS Code 窗口 ${window.id}`}</span></label>)}</div><div className="modal-actions"><button className="secondary-button" onClick={onClose} disabled={busy}>取消</button><button className="primary-button" disabled={busy} data-testid="window-picker-open" onClick={async () => { setBusy(true); try { await onOpen(picker.thread, selected, picker.windows.find((window) => window.id === selected)?.title); } catch { setBusy(false); } }}>{busy ? <LoaderCircle className="spin" size={14} /> : <ArrowUpRight size={14} />}{busy ? '正在打开…' : '打开对话'}</button></div></section></div>;
}

function OrganizationModal({ initial, organization, onClose, onSave }) {
  const [projectId, setProjectId] = useState(organization.projects.some((project) => project.id === initial.projectId) ? initial.projectId : organization.projects[0]?.id || '');
  const [editing, setEditing] = useState(initial.action ? { action: initial.action } : organization.projects.length ? null : { action: 'createProject' });
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(null);
  const tasks = organization.tasks.filter((task) => task.projectId === projectId);
  const selectedProject = organization.projects.find((project) => project.id === projectId);
  const isTask = editing?.action?.endsWith('Task');
  useEffect(() => {
    if (projectId && !organization.projects.some((project) => project.id === projectId)) setProjectId(organization.projects[0]?.id || '');
  }, [organization.projects, projectId]);
  useEffect(() => {
    const handler = (event) => { if (event.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [busy, onClose]);
  const edit = (action, item) => { setEditing({ action, id: item?.id }); setName(item?.name || ''); setError(''); setDeleting(null); };
  const submit = async (event) => {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true); setError('');
    try {
      const next = await onSave({ action: editing.action, ...(editing.id ? { id: editing.id } : {}), ...(editing.action === 'createTask' ? { projectId } : {}), name: name.trim() });
      if (editing.action === 'createProject') setProjectId(next.projects.find((project) => !organization.projects.some((old) => old.id === project.id))?.id || projectId);
      setEditing(null); setName('');
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true); setError('');
    try { await onSave({ action: deleting.kind === 'project' ? 'deleteProject' : 'deleteTask', id: deleting.id }); setDeleting(null); setEditing(null); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  return <div className="modal-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}><section className="modal organization-modal" role="dialog" aria-modal="true" aria-labelledby="organization-title" data-testid="organization-modal">
    <div className="modal-heading"><span className="modal-icon"><Layers size={21} /></span><button className="icon-button" onClick={onClose} disabled={busy} aria-label="关闭分类管理" data-testid="organization-close"><X size={18} /></button></div>
    <h2 id="organization-title">项目和任务</h2><p className="modal-description">项目是研究方向，任务是该项目中的具体分工。</p>
    <div className="organization-columns"><div><div className="organization-heading"><span>项目</span><button className="icon-button" aria-label="添加项目" data-testid="organization-add-project" disabled={busy} onClick={() => edit('createProject')}><Plus size={14} /></button></div><div className="organization-list">{organization.projects.map((project) => <div className={`organization-row ${projectId === project.id ? 'selected' : ''}`} key={project.id}><button className="organization-item" data-testid={`organization-project-${project.id}`} title={project.name} disabled={busy} onClick={() => { setProjectId(project.id); setEditing(null); setDeleting(null); setError(''); }}>{project.name}</button><button className="icon-button" aria-label={`重命名项目 ${project.name}`} data-testid={`rename-project-${project.id}`} disabled={busy} onClick={() => edit('renameProject', project)}><Pencil size={12} /></button><button className="icon-button" aria-label={`删除项目 ${project.name}`} data-testid={`delete-project-${project.id}`} disabled={busy} onClick={() => { setDeleting({ kind: 'project', ...project }); setEditing(null); }}><Trash2 size={12} /></button></div>)}{!organization.projects.length && <p className="organization-empty">例如 YAM、BEHAVIOR</p>}</div></div>
    <div><div className="organization-heading"><span>{selectedProject ? `${selectedProject.name} · 任务` : '任务'}</span><button className="icon-button" aria-label="添加任务" data-testid="organization-add-task" disabled={busy || !selectedProject} onClick={() => edit('createTask')}><Plus size={14} /></button></div><div className="organization-list">{tasks.map((task) => <div className="organization-row" key={task.id}><span className="organization-item" data-testid={`organization-task-${task.id}`} title={task.name}>{task.name}</span><button className="icon-button" aria-label={`重命名任务 ${task.name}`} data-testid={`rename-task-${task.id}`} disabled={busy} onClick={() => edit('renameTask', task)}><Pencil size={12} /></button><button className="icon-button" aria-label={`删除任务 ${task.name}`} data-testid={`delete-task-${task.id}`} disabled={busy} onClick={() => { setDeleting({ kind: 'task', ...task }); setEditing(null); }}><Trash2 size={12} /></button></div>)}{!tasks.length && <p className="organization-empty">{selectedProject ? '例如相机模块、PR #184' : '先添加一个项目'}</p>}</div></div></div>
    {editing && <form onSubmit={submit} className="organization-form"><label className="field-label" htmlFor="organization-name">{editing.action.startsWith('rename') ? '重命名' : '新建'}{isTask ? `任务${selectedProject ? ` · ${selectedProject.name}` : ''}` : '项目'}</label><div className="organization-input-row"><input id="organization-name" className="form-input" data-testid="organization-name" value={name} autoFocus onChange={(event) => setName(event.target.value)} placeholder={isTask ? '例如：相机模块' : '例如：YAM'} maxLength={80} disabled={busy} required /><button type="submit" className="primary-button" data-testid="organization-submit" disabled={busy || !name.trim() || (isTask && !selectedProject)}>{busy ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}保存</button></div>{editing.action === 'createProject' && !organization.projects.length && <div className="project-suggestions">{['YAM', 'BEHAVIOR'].map((value) => <button type="button" key={value} disabled={busy} onClick={() => setName(value)}>{value}</button>)}</div>}</form>}
    {deleting && <div className="organization-delete"><p>删除{deleting.kind === 'project' ? '项目' : '任务'}「{deleting.name}」？{deleting.kind === 'project' ? '其任务和归类会移除，对话保留。' : '对话保留在原项目中。'}</p><button className="secondary-button" disabled={busy} onClick={() => setDeleting(null)}>取消</button><button className="danger-button" data-testid="organization-confirm-delete" disabled={busy} onClick={remove}>删除分类</button></div>}
    {error && <p className="form-error" role="alert" data-testid="organization-error">{error}</p>}
  </section></div>;
}

function ThreadModal({ modal, folders, organization, onClose, onCreated }) {
  const [title, setTitle] = useState(modal.title);
  const [cwd, setCwd] = useState(modal.cwd);
  const [projectId, setProjectId] = useState(modal.projectId || '');
  const [taskId, setTaskId] = useState(modal.taskId || '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const handler = (event) => { if (event.key === 'Escape' && !submitting) onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, submitting]);
  async function submit(event) {
    event.preventDefault();
    if (!cwd.trim()) { setError('请选择或填写文件夹。'); return; }
    setSubmitting(true); setError('');
    try {
      const url = modal.kind === 'fork' ? `/api/threads/${encodeURIComponent(modal.thread.id)}/fork` : '/api/threads';
      const assignment = { projectId: projectId || null, taskId: taskId || null };
      const result = await api(url, { method: 'POST', body: JSON.stringify({ cwd: cwd.trim(), title: title.trim(), ...assignment }) });
      await onCreated(result.thread, assignment);
    } catch (err) { setError(err.message); setSubmitting(false); }
  }
  return <div className="modal-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !submitting) onClose(); }}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" data-testid="thread-modal"><div className="modal-heading"><span className="modal-icon">{modal.kind === 'fork' ? <GitFork size={21} /> : <Plus size={21} />}</span><button className="icon-button" onClick={onClose} disabled={submitting} aria-label="关闭窗口"><X size={18} /></button></div><h2 id="modal-title">{modal.kind === 'fork' ? 'Fork 对话' : '新建对话'}</h2><p className="modal-description">{modal.kind === 'fork' ? '沿用这条对话的上下文，并创建新的独立对话。' : '创建后可在 VS Code 中开始对话。'}</p>{modal.kind === 'fork' && <div className="fork-origin"><GitFork size={13} /><span>{titleOf(modal.thread)}</span></div>}<form onSubmit={submit}><label className="field-label" htmlFor="thread-title">对话名称 <span>可选</span></label><input className="form-input" id="thread-title" data-testid="modal-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：相机初始化问题" autoFocus maxLength={120} disabled={submitting} /><label className="field-label" htmlFor="thread-cwd">文件夹</label><input className="form-input path-input" id="thread-cwd" data-testid="modal-cwd" list="workspace-paths" value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="/home/…/your-project" required disabled={submitting} /><datalist id="workspace-paths">{[...new Set(folders.map((item) => item.cwd).filter(Boolean))].map((path) => <option value={path} key={path} />)}</datalist><div className="modal-assignment"><div><label className="field-label" htmlFor="modal-project">项目</label><select id="modal-project" className="form-input" data-testid="modal-project" value={projectId} disabled={submitting} onChange={(event) => { setProjectId(event.target.value); setTaskId(''); }}><option value="">未归类</option>{organization.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></div><div><label className="field-label" htmlFor="modal-task">任务</label><select id="modal-task" className="form-input" data-testid="modal-task" value={taskId} disabled={submitting || !projectId} onChange={(event) => setTaskId(event.target.value)}><option value="">未指定任务</option>{organization.tasks.filter((task) => task.projectId === projectId).map((task) => <option key={task.id} value={task.id}>{task.name}</option>)}</select></div></div>{error && <p className="form-error" role="alert" data-testid="modal-error">{error}</p>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose} disabled={submitting} data-testid="modal-cancel">取消</button><button type="submit" className="primary-button" disabled={submitting} data-testid="modal-submit">{submitting ? <LoaderCircle className="spin" size={14} /> : modal.kind === 'fork' ? <GitFork size={14} /> : <Plus size={14} />}{submitting ? '正在创建…' : modal.kind === 'fork' ? '创建 Fork' : '创建对话'}</button></div></form></section></div>;
}

createRoot(document.getElementById('root')).render(<App />);
