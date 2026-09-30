import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ReactFlow, Background, Controls, Handle, Position, MarkerType, BaseEdge,
  applyNodeChanges, ConnectionMode,
} from '@xyflow/react';
import {
  ArrowUpRight, Check, ChevronDown, Copy, FolderOpen, GitBranch,
  GitFork, Link2, LoaderCircle, Map as MapIcon, Plus, Search, Trash2, X, Pencil, Layers,
  Bell, BellOff, MessageSquare, RefreshCw, ArrowRightToLine,
} from 'lucide-react';
import '@xyflow/react/dist/style.css';
import { routeAroundCards } from './edgeRouting.js';
import { activityPresentation, createActivityTracker } from './activity.js';
import './styles.css';

const RELATIONS = { serial: '串行', parallel: '并行', reference: '参考' };
const HANDOFF_PROMPT_LIMIT = 24_000;
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
function parentOf(thread) { return thread?.inheritedFromId || thread?.forkedFromId; }
function edgeSignature(edges) {
  return JSON.stringify(edges.map(({ id, source, target, type }) => ({ id, source, target, type })).sort((a, b) => a.id.localeCompare(b.id)));
}

function ActivityBadge({ thread }) {
  const activity = activityPresentation(thread);
  return <span className={`activity-badge ${activity.status}`} data-status={activity.status} title={activity.reason} data-testid={`activity-${thread.id}`}><span className={`status-dot ${activity.status}`} aria-hidden="true" />{activity.label}</span>;
}

const SessionCard = React.memo(function SessionCard({ id, data, selected }) {
  const { thread, onCopy, onOpen, onFork, onInherit, canFork, canInherit, canOpen, opening, project, task, timeLabel } = data;
  return (
    <article className={`session-card ${selected ? 'is-selected' : ''}`} data-status={activityPresentation(thread).status} data-testid={`session-node-${id}`}>
      <Handle type="target" position={Position.Left} className="connection-handle" data-testid={`session-target-${id}`} aria-label="连接到此对话" />
      <div className="card-heading">
        <ActivityBadge thread={thread} />
        <span className="card-time">{timeLabel}</span>
      </div>
      <h3 title={titleOf(thread)}>{titleOf(thread)}</h3>
      <p className="card-preview">{thread.preview || '暂无内容预览'}</p>
      <div className="card-meta">
        <div className={`card-taxonomy ${project ? '' : 'unassigned'}`} title={project ? `${project.name}${task ? ` / ${task.name}` : ''}` : '未归类'}><span>{project?.name || '未归类'}</span>{task && <><span className="taxonomy-separator">/</span><span>{task.name}</span></>}</div>
        <span className="card-branch" title={`Git 分支：${thread.branch || '未知'}`}><GitBranch size={10} /><span>{thread.branch || '分支未知'}</span></span>
        {thread.inheritedFromId && <span className="inherit-badge" title="由交接提示词继承的新对话"><ArrowRightToLine size={11} />继承</span>}
        {thread.forkedFromId && <span className="fork-badge"><GitFork size={11} /> Fork</span>}
      </div>
      <div className="card-actions nodrag nopan">
        <button className="card-open" disabled={!canOpen} data-testid={`open-${id}`} onClick={(event) => { event.stopPropagation(); onOpen(thread); }}>{opening ? <LoaderCircle size={14} className="spin" /> : <ArrowUpRight size={14} />}{opening ? '正在定位…' : 'VS Code'}</button>
        <button className="card-inherit" title="用交接提示词继承为新对话" disabled={!canInherit} data-testid={`inherit-${id}`} onClick={(event) => { event.stopPropagation(); onInherit(thread); }}><ArrowRightToLine size={13} /><span>继承</span></button>
        <button className="card-copy" title="复制对话 ID" aria-label="复制对话 ID" data-testid={`copy-${id}`} onClick={(event) => { event.stopPropagation(); onCopy(thread.id); }}><Copy size={13} /><span>ID</span></button>
        <button className="icon-button fork-button" title="从此对话 Fork" aria-label="从此对话 Fork" disabled={!canFork} data-testid={`fork-${id}`} onClick={(event) => { event.stopPropagation(); onFork(thread); }}><GitFork size={14} /></button>
      </div>
      <Handle type="source" position={Position.Right} className="connection-handle" data-testid={`session-source-${id}`} aria-label="从此对话连线" />
    </article>
  );
}, (previous, next) => previous.id === next.id && previous.selected === next.selected && previous.data === next.data);
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
  const [activityNotices, setActivityNotices] = useState([]);
  const [activityNotifications, setActivityNotifications] = useState(() => { try { return localStorage.getItem('codex-board.activity-notifications') !== 'off'; } catch { return true; } });
  const [desktopNotificationBusy, setDesktopNotificationBusy] = useState(false);
  const desktopNotificationRequest = useRef(false);
  const [workspaceOptions, setWorkspaceOptions] = useState([]);
  const [saving, setSaving] = useState(false);
  const [clockMinute, setClockMinute] = useState(() => Math.floor(Date.now() / 60_000));
  const flow = useRef(null);
  const positions = useRef({});
  const positionRevisions = useRef(new Map());
  const positionFallbacks = useRef(new Map());
  const dragging = useRef(new Set());
  const localEdges = useRef(null);
  const edgeRevision = useRef(0);
  const confirmedGraph = useRef(emptyGraph);
  const layoutPositions = useRef(new Map());
  const snapshotGeneration = useRef(0);
  const graph = useRef(emptyGraph);
  const lastSnapshot = useRef(0);
  const toastTimer = useRef(null);
  const fitTimer = useRef(null);
  const mounted = useRef(true);
  const saveQueue = useRef(Promise.resolve());
  const opening = useRef(false);
  const trackActivity = useRef(createActivityTracker());
  const activityNotificationsEnabled = useRef(activityNotifications);
  const windowTargets = useRef((() => { try { return JSON.parse(localStorage.getItem('codex-board.window-targets') || '{}'); } catch { return {}; } })());
  const selectionKey = `${selectedProject}|${selectedTask}|${folder}|${branch}|${search}`;

  const notify = useCallback((message, kind = 'success') => {
    clearTimeout(toastTimer.current);
    setToast({ message, kind });
    toastTimer.current = setTimeout(() => setToast(null), kind === 'error' ? 6500 : 3200);
  }, []);

  const receiveSnapshot = useCallback((next) => {
    if (!next || !Array.isArray(next.threads)) return;
    snapshotGeneration.current++;
    const notices = trackActivity.current(next.threads);
    if (activityNotificationsEnabled.current && notices.length) setActivityNotices((current) => [...current, ...notices].slice(-3));
    lastSnapshot.current = Date.now();
    const incoming = { positions: {}, edges: [], ...next.graph };
    confirmedGraph.current = incoming;
    const threadIds = new Set(next.threads.map((thread) => thread.id));
    for (const cache of [layoutPositions.current, positionRevisions.current, positionFallbacks.current]) {
      for (const id of cache.keys()) if (!threadIds.has(id)) cache.delete(id);
    }
    for (const [id, position] of Object.entries(positions.current)) {
      const saved = incoming.positions[id];
      if (!dragging.current.has(id) && saved && saved.x === position.x && saved.y === position.y) delete positions.current[id];
    }
    if (localEdges.current && edgeSignature(incoming.edges) === edgeSignature(localEdges.current)) localEdges.current = null;
    graph.current = { positions: { ...incoming.positions, ...positions.current }, edges: localEdges.current || incoming.edges };
    const nextState = { ...next, graph: graph.current, organization: next.organization || emptyOrganization, capabilities: next.capabilities || {} };
    setSnapshot((current) => {
      if (JSON.stringify(current) === JSON.stringify(nextState)) return current;
      const previousThreads = new Map(current.threads.map((thread) => [thread.id, thread]));
      return { ...nextState, threads: next.threads.map((thread) => {
        const previous = previousThreads.get(thread.id);
        return previous && JSON.stringify(previous) === JSON.stringify(thread) ? previous : thread;
      }), organization: JSON.stringify(current.organization) === JSON.stringify(nextState.organization) ? current.organization : nextState.organization };
    });
    setError(next.error || '');
    setLoading(false);
  }, []);

  const refreshSnapshot = useCallback(async () => {
    const generation = snapshotGeneration.current;
    try {
      const next = await api('/api/snapshot');
      if (mounted.current && snapshotGeneration.current === generation) receiveSnapshot(next);
    } catch (err) {
      if (mounted.current && snapshotGeneration.current === generation) throw err;
    }
  }, [receiveSnapshot]);

  const toggleActivityNotifications = () => {
    const enabled = !activityNotifications;
    activityNotificationsEnabled.current = enabled;
    setActivityNotifications(enabled);
    if (!enabled) setActivityNotices([]);
    try { localStorage.setItem('codex-board.activity-notifications', enabled ? 'on' : 'off'); } catch { /* Browser storage may be disabled. */ }
  };

  const desktopNotifications = snapshot.desktopNotifications;
  const updateDesktopNotifications = async (test = false) => {
    if (desktopNotificationRequest.current) return;
    desktopNotificationRequest.current = true;
    setDesktopNotificationBusy(true);
    try {
      await api(test ? '/api/notifications/test' : '/api/notifications', {
        method: test ? 'POST' : 'PATCH',
        body: JSON.stringify(test ? {} : { enabled: !desktopNotifications?.enabled }),
      });
      await refreshSnapshot();
      if (test) notify('已发送系统测试通知，请查看桌面顶部或通知中心。');
    } catch (err) { notify(`桌面通知：${err.message}`, 'error'); }
    finally { desktopNotificationRequest.current = false; if (mounted.current) setDesktopNotificationBusy(false); }
  };

  useEffect(() => {
    mounted.current = true;
    let stopped = false;
    const refresh = () => refreshSnapshot().catch((err) => { if (!stopped) { setError(err.message); setLoading(false); } });
    refresh();
    api('/api/projects').then((result) => { if (!stopped) setWorkspaceOptions(result.projects || []); }).catch(() => {});
    const events = new EventSource('/api/events');
    events.onopen = () => setConnected(true);
    events.onerror = () => setConnected(false);
    events.addEventListener('snapshot', (event) => {
      try { receiveSnapshot(JSON.parse(event.data)); setConnected(true); } catch { setError('同步数据无法读取，正在重试。'); }
    });
    const interval = setInterval(() => { if (document.visibilityState === 'visible') { setClockMinute(Math.floor(Date.now() / 60_000)); if (Date.now() - lastSnapshot.current > 15_000) refresh(); } }, 10_000);
    return () => { stopped = true; mounted.current = false; events.close(); clearInterval(interval); clearTimeout(toastTimer.current); };
  }, [receiveSnapshot, refreshSnapshot]);

  const threads = useMemo(() => snapshot.threads.filter((thread) => !thread.archived).map((thread) => {
    if (connected || !['active', 'waiting'].includes(thread.status)) return thread;
    return { ...thread, status: 'unknown', activity: { ...thread.activity, status: 'unknown', stale: true, reason: '同步连接已断开，当前运行状态无法确认。' } };
  }).sort((a, b) => b.updatedAt - a.updatedAt), [snapshot.threads, connected]);
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
      const parent = parentOf(thread);
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(thread);
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
      while (byId.has(parentOf(ancestor)) && !checked.has(parentOf(ancestor))) {
        ancestor = byId.get(parentOf(ancestor)); checked.add(ancestor.id);
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
  const selectedInherited = selectedEdgeId?.startsWith('inherit:') ? threads.find((thread) => `inherit:${thread.id}` === selectedEdgeId) : null;

  const updateOrganization = useCallback(async (patch) => {
    setOrganizationSaving(true);
    try {
      const result = await api('/api/organization', { method: 'PATCH', body: JSON.stringify(patch) });
      snapshotGeneration.current++;
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
  const inheritThread = useCallback((thread) => setModal({ kind: 'inherit', thread, cwd: thread.cwd, title: `${titleOf(thread).slice(0, 112)} · 续聊`, ...organization.assignments[thread.id] }), [organization.assignments]);

  useEffect(() => {
    setNodes((current) => {
      const existing = new Map(current.map((node) => [node.id, node]));
      const assigned = new Map();
      layoutThreads.forEach((thread) => {
        const position = positions.current[thread.id] || snapshot.graph.positions[thread.id] || layoutPositions.current.get(thread.id) || existing.get(thread.id)?.position;
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
        layoutPositions.current.set(thread.id, position);
        const selected = thread.id === selectedThreadId;
        const data = { thread, onCopy: copyId, onOpen: openThread, onFork: forkThread, onInherit: inheritThread, canInherit: snapshot.capabilities.inherit !== false && snapshot.capabilities.create !== false && !openingThreadId, canFork: snapshot.capabilities.fork !== false, canOpen: snapshot.capabilities.openVscode !== false && !openingThreadId, opening: openingThreadId === thread.id, project: organization.projects.find((project) => project.id === organization.assignments[thread.id]?.projectId), task: organization.tasks.find((task) => task.id === organization.assignments[thread.id]?.taskId), timeLabel: relativeTime(thread.updatedAt) };
        const sameData = old && Object.keys(data).every((key) => old.data[key] === data[key]);
        if (sameData && old.selected === selected && old.position.x === position.x && old.position.y === position.y) return old;
        return { ...old, id: thread.id, type: 'session', position, selected, data: sameData ? old.data : data };
      });
    });
  }, [layoutThreads, snapshot.graph.positions, snapshot.capabilities, selectedThreadId, copyId, openThread, forkThread, inheritThread, organization, openingThreadId, clockMinute]);

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
    const inherited = visibleThreads.filter((thread) => thread.inheritedFromId && ids.has(thread.inheritedFromId)).map((thread) => ({
      id: `inherit:${thread.id}`, source: thread.inheritedFromId, target: thread.id, type: 'routed', label: '继承', data: { cards },
      deletable: false, selected: selectedEdgeId === `inherit:${thread.id}`,
      markerEnd: { type: MarkerType.ArrowClosed, color: '#609293', width: 14, height: 14 },
      style: { stroke: '#609293', strokeWidth: selectedEdgeId === `inherit:${thread.id}` ? 2 : 1.5, strokeDasharray: '7 3' },
      labelStyle: { fill: '#4f7d7e', fontSize: 11 }, labelBgStyle: { fill: '#f7f8f5' }, labelBgPadding: [6, 3], labelBgBorderRadius: 4,
      interactionWidth: 20,
    }));
    return [...forks, ...inherited, ...manual];
  }, [snapshot.graph.edges, visibleThreads, selectedEdgeId, nodes]);

  const startDrag = useCallback((_event, node) => {
    clearTimeout(fitTimer.current);
    snapshotGeneration.current++;
    positionRevisions.current.set(node.id, (positionRevisions.current.get(node.id) || 0) + 1);
    if (!positionFallbacks.current.has(node.id)) positionFallbacks.current.set(node.id, layoutPositions.current.get(node.id) || node.position);
    setSelectedThreadId(node.id);
    setSelectedEdgeId(null);
    dragging.current.add(node.id);
    positions.current[node.id] = node.position;
  }, []);
  const savePosition = useCallback(async (_event, node) => {
    const { id, position } = node;
    const revision = positionRevisions.current.get(id);
    dragging.current.delete(id);
    positions.current[id] = position;
    graph.current = { ...graph.current, positions: { ...graph.current.positions, [id]: position } };
    const settle = (saved) => {
      if (positionRevisions.current.get(id) !== revision || dragging.current.has(id)) return;
      delete positions.current[id];
      layoutPositions.current.set(id, saved);
      graph.current = { ...graph.current, positions: { ...graph.current.positions, [id]: saved } };
      setSnapshot((current) => ({ ...current, graph: { ...current.graph, positions: { ...current.graph.positions, [id]: saved } } }));
    };
    try {
      const result = await persist({ positions: { [id]: position } });
      snapshotGeneration.current++;
      const saved = result.graph.positions[id];
      confirmedGraph.current = { ...confirmedGraph.current, positions: { ...confirmedGraph.current.positions, [id]: saved } };
      settle(saved);
    } catch {
      settle(confirmedGraph.current.positions[id] || positionFallbacks.current.get(id));
    }
  }, [persist]);

  const saveEdges = useCallback(async (edges) => {
    const revision = ++edgeRevision.current;
    snapshotGeneration.current++;
    localEdges.current = edges;
    graph.current = { ...graph.current, edges };
    setSnapshot((current) => ({ ...current, graph: { ...current.graph, edges } }));
    try {
      const result = await persist({ edges });
      snapshotGeneration.current++;
      confirmedGraph.current = { ...confirmedGraph.current, edges: result.graph.edges };
      if (edgeRevision.current === revision) {
        localEdges.current = null;
        graph.current = { ...graph.current, edges: result.graph.edges };
        setSnapshot((current) => ({ ...current, graph: { ...current.graph, edges: result.graph.edges } }));
      }
    } catch {
      if (edgeRevision.current !== revision) return;
      localEdges.current = null;
      const savedEdges = confirmedGraph.current.edges;
      graph.current = { ...graph.current, edges: savedEdges };
      setSnapshot((current) => ({ ...current, graph: { ...current.graph, edges: savedEdges } }));
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
  const onCreated = async (thread, assignment, kind) => {
    setModal(null);
    snapshotGeneration.current++;
    setSnapshot((current) => ({ ...current, threads: [thread, ...current.threads.filter((item) => item.id !== thread.id)], organization: { ...current.organization, assignments: { ...current.organization.assignments, [thread.id]: assignment } } }));
    setBranch('');
    setSearch('');
    setSelectedProject(assignment?.projectId || '');
    setSelectedTask(assignment?.taskId || '');
    setFolder('');
    setSelectedThreadId(thread.id);
    setSelectedEdgeId(null);
    notify(kind === 'inherit' ? '交接上下文已载入，正在打开 VS Code。' : '对话已创建，可打开 VS Code 继续。');
    try { await refreshSnapshot(); } catch (err) { notify(err.message, 'error'); }
    setTimeout(() => flow.current?.fitView({ nodes: [{ id: thread.id }], padding: 1.5, maxZoom: 1, duration: 200 }), 250);
    if (kind === 'inherit') await openThread(thread);
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
          {visibleThreads.map((thread) => <button className={`thread-list-item ${thread.id === selectedThreadId ? 'selected' : ''}`} data-status={activityPresentation(thread).status} key={thread.id} title={`${titleOf(thread)}\n${activityPresentation(thread).label}\n${thread.id}`} onClick={() => focusThread(thread)} data-testid={`thread-list-${thread.id}`}><span className={`list-thread-dot ${activityPresentation(thread).status}`} aria-hidden="true" /><span className="list-thread-text"><strong>{titleOf(thread)}</strong><small><span className="list-thread-status">{activityPresentation(thread).label}</span> · {relativeTime(thread.updatedAt)}</small></span></button>)}
          {!loading && !visibleThreads.length && <p className="sidebar-empty">{search ? '没有匹配的对话' : '暂无对话'}</p>}
        </div>
        <button className="activity-toggle" aria-pressed={activityNotifications} title="需你处理或本轮结束时显示页内提示" onClick={toggleActivityNotifications} data-testid="activity-notifications-toggle">{activityNotifications ? <Bell size={13} /> : <BellOff size={13} />}<span>页内提示</span><strong>{activityNotifications ? '开启' : '关闭'}</strong></button>
        {desktopNotifications && <div className="desktop-notifications">
          <button className="activity-toggle" aria-pressed={desktopNotifications.enabled} disabled={desktopNotificationBusy} title="需要你回答或本轮结束时发送系统桌面通知，离开看板仍可收到" onClick={() => updateDesktopNotifications()} data-testid="desktop-notifications-toggle">{desktopNotifications.enabled ? <Bell size={13} /> : <BellOff size={13} />}<span>桌面通知</span><strong>{desktopNotificationBusy ? '处理中…' : desktopNotifications.enabled ? '开启' : '关闭'}</strong></button>
          <div className="desktop-notification-help"><span data-testid="desktop-notifications-status">{desktopNotifications.lastError || (desktopNotifications.available === false ? '系统通知暂不可用' : desktopNotifications.enabled ? '切换页面、关闭看板仍会提醒' : '需要你回答 · 本轮结束')}</span><button disabled={desktopNotificationBusy} onClick={() => updateDesktopNotifications(true)} data-testid="desktop-notifications-test">测试</button></div>
        </div>}
        <div className="sidebar-footer"><span className={`sync-indicator ${connected ? 'connected' : ''}`} /><span data-testid="sync-status">{loading ? '正在读取…' : connected ? '本机同步已连接' : '同步连接已断开，重试中'}</span>{(saving || organizationSaving) && <LoaderCircle size={12} className="spin" aria-label="正在保存" />}</div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="workspace-heading"><span className="eyebrow">{selectedTask && selectedTask !== 'unassigned' ? tasks.find((task) => task.id === selectedTask)?.name : '对话地图'}</span><h1>{selectedProjectName}<span>{visibleThreads.length}</span></h1></div>
          <div className="toolbar"><label className="branch-select folder-select" title={folder || '按文件夹筛选'}><FolderOpen size={14} /><select aria-label="筛选文件夹" data-testid="folder-filter" value={folder} onChange={(event) => { setFolder(event.target.value); setBranch(''); setSelectedThreadId(null); setSelectedEdgeId(null); }}><option value="">全部文件夹</option>{folders.map((item) => <option key={item.key} value={item.key}>{shortPath(item.key)}</option>)}</select><ChevronDown size={12} /></label><label className="branch-select"><GitBranch size={14} /><select aria-label="筛选 Git 分支" data-testid="branch-filter" value={branch} onChange={(event) => { setBranch(event.target.value); setSelectedThreadId(null); setSelectedEdgeId(null); }}><option value="">全部分支</option>{branches.map((name) => <option key={name} value={name}>{name}</option>)}</select><ChevronDown size={12} /></label><span className="toolbar-divider" /><label className="relation-select"><Link2 size={14} /><span>连线</span><select aria-label="新连线关系" data-testid="relation-type" value={relationType} onChange={(event) => setRelationType(event.target.value)}>{Object.entries(RELATIONS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label></div>
        </header>
        {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={async () => { try { await refreshSnapshot(); } catch (err) { setError(err.message); } }}>重试</button></div>}
        <div className="canvas-area">
          <ReactFlow nodes={nodes} edges={flowEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onInit={(instance) => { flow.current = instance; }} onNodesChange={(changes) => setNodes((current) => applyNodeChanges(changes, current))} onNodeDragStart={startDrag} onNodeDrag={(_event, node) => { positions.current[node.id] = node.position; }} onNodeDragStop={savePosition} onNodeClick={(_event, node) => { setSelectedThreadId(node.id); setSelectedEdgeId(null); }} onEdgeClick={(_event, edge) => { setSelectedEdgeId(edge.id); setSelectedThreadId(null); }} onPaneClick={() => { setSelectedThreadId(null); setSelectedEdgeId(null); }} onConnect={onConnect} onConnectStart={() => clearTimeout(fitTimer.current)} connectionMode={ConnectionMode.Loose} isValidConnection={(connection) => connection.source !== connection.target} minZoom={0.2} maxZoom={1.8} deleteKeyCode={null} fitView fitViewOptions={{ padding: 0.18, minZoom: 0.6, maxZoom: 1 }} onlyRenderVisibleElements proOptions={{ hideAttribution: true }} aria-label="对话关系画布">
            <Background color="#dce2d9" gap={22} size={1} />
            <Controls showInteractive={false} position="bottom-left" />
          </ReactFlow>
          {!loading && visibleThreads.length > 0 && <div className="canvas-hint">拖动卡片调整位置 · 拖动两侧圆点连接对话</div>}
          {loading && <div className="canvas-empty"><LoaderCircle className="spin" size={26} /><h2>正在读取本机对话</h2></div>}
          {!loading && visibleThreads.length === 0 && <div className="canvas-empty"><span className="empty-icon"><MapIcon size={29} strokeWidth={1.3} /></span><h2>{search || branch ? '没有匹配的对话' : '从一条对话开始'}</h2><p>{search || branch ? '调整搜索或分支筛选后再试。' : '本机 Codex 对话会自动出现在这里。'}</p>{!search && !branch && <button className="primary-button" onClick={openNew} disabled={snapshot.capabilities.create === false}><Plus size={14} /> 新建对话</button>}</div>}

          {selectedThread && <aside className="detail-panel" data-testid="thread-detail">
            <div className="detail-heading"><span>对话详情</span><button className="icon-button" aria-label="关闭详情" onClick={() => setSelectedThreadId(null)}><X size={16} /></button></div>
            <h2>{titleOf(selectedThread)}</h2>
            <div className="detail-activity" data-status={activityPresentation(selectedThread).status}><ActivityBadge thread={selectedThread} /><p>{activityPresentation(selectedThread).reason}</p>{selectedThread.activity?.at && <small>状态记录于 {new Date(selectedThread.activity.at).toLocaleString('zh-CN')}</small>}</div>
            <p className="detail-preview">{selectedThread.preview || '暂无内容预览'}</p>
            <RecentReplies key={selectedThread.id} thread={selectedThread} />
            {selectedThread.inheritedFromId && <InheritedPrompt key={`inherited:${selectedThread.id}`} threadId={selectedThread.id} notify={notify} />}
            <div className="assignment-fields"><div className="assignment-label"><label htmlFor="assign-project">项目</label><button className="icon-button" aria-label="编辑项目和任务" title="编辑项目和任务" onClick={() => setOrganizationModal({ projectId: selectedAssignment.projectId })}><Pencil size={12} /></button></div><select id="assign-project" className="form-input" data-testid="assign-project" value={selectedAssignment.projectId || ''} disabled={organizationSaving} onChange={(event) => assignThread(event.target.value)}><option value="">未归类</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select><div className="assignment-label"><label htmlFor="assign-task">任务</label>{selectedAssignment.projectId && <button className="icon-button" aria-label="添加项目任务" title="添加项目任务" onClick={() => setOrganizationModal({ projectId: selectedAssignment.projectId, action: 'createTask' })}><Plus size={12} /></button>}</div><select id="assign-task" className="form-input" data-testid="assign-task" value={selectedAssignment.taskId || ''} disabled={organizationSaving || !selectedAssignment.projectId} onChange={(event) => assignThread(selectedAssignment.projectId, event.target.value)}><option value="">未指定任务</option>{organization.tasks.filter((task) => task.projectId === selectedAssignment.projectId).map((task) => <option key={task.id} value={task.id}>{task.name}</option>)}</select></div>
            <dl><dt>对话 ID <button className="icon-button" aria-label="复制详情中的对话 ID" data-testid="detail-copy" onClick={() => copyId(selectedThread.id)}><Copy size={12} /></button></dt><dd className="thread-id" data-testid="detail-thread-id">{selectedThread.id}</dd><dt>文件夹</dt><dd>{shortPath(selectedThread.cwd) || '未知'}</dd><dt>Git 分支</dt><dd>{selectedThread.branch || '分支未知'}</dd><dt>最近活动</dt><dd>{selectedThread.updatedAt ? new Date(Number(selectedThread.updatedAt)).toLocaleString('zh-CN') : '未知'}</dd>{selectedThread.inheritedFromId && <><dt>继承来源</dt><dd className="thread-id" data-testid="detail-inherited-from">{selectedThread.inheritedFromId}</dd></>}{selectedThread.forkedFromId && <><dt>Fork 来源</dt><dd className="thread-id">{selectedThread.forkedFromId}</dd></>}</dl>
            <button className="primary-button full-width" onClick={() => openThread(selectedThread)} disabled={snapshot.capabilities.openVscode === false || !!openingThreadId} data-testid="detail-open">{openingThreadId === selectedThread.id ? <LoaderCircle size={15} className="spin" /> : <ArrowUpRight size={15} />}{openingThreadId === selectedThread.id ? '正在定位…' : '在 VS Code 打开'}</button><button className="change-window" onClick={() => openThread(selectedThread, true)} disabled={snapshot.capabilities.openVscode === false || !!openingThreadId} data-testid="change-window">选择其他 VS Code 窗口</button><button className="secondary-button full-width inherit-detail-button" onClick={() => inheritThread(selectedThread)} disabled={snapshot.capabilities.inherit === false || snapshot.capabilities.create === false || !!openingThreadId} data-testid="detail-inherit"><ArrowRightToLine size={14} />继承为新对话</button><button className="secondary-button full-width" onClick={() => forkThread(selectedThread)} disabled={snapshot.capabilities.fork === false} data-testid="detail-fork"><GitFork size={14} /> 从此对话 Fork</button>
          </aside>}
          {activityNotices.length > 0 && <section className="activity-notices" aria-label="状态提示" aria-live="polite" data-testid="activity-notices">{activityNotices.map((notice) => <div className={`activity-notice ${notice.status}`} data-status={notice.status} key={notice.id}><button className="activity-notice-open" onClick={() => { const thread = threads.find((item) => item.id === notice.threadId); if (thread) focusThread(thread); setActivityNotices((current) => current.filter((item) => item.id !== notice.id)); }}>{notice.status === 'waiting' ? <Bell size={15} /> : <Check size={15} />}<span><strong>{activityPresentation(notice).label}</strong><span>{notice.title}</span></span></button><button className="icon-button" aria-label="关闭状态提示" onClick={() => setActivityNotices((current) => current.filter((item) => item.id !== notice.id))}><X size={14} /></button></div>)}</section>}
          {(selectedManualEdge || selectedFork || selectedInherited) && <aside className="detail-panel relation-panel" data-testid="edge-detail"><div className="detail-heading"><span>{selectedInherited ? '继承关系' : selectedFork ? 'Fork 关系' : '编辑关系'}</span><button className="icon-button" aria-label="关闭关系详情" onClick={() => setSelectedEdgeId(null)}><X size={16} /></button></div><div className="edge-endpoints"><span>{titleOf(threads.find((thread) => thread.id === (selectedManualEdge?.source || selectedInherited?.inheritedFromId || selectedFork?.forkedFromId)))}</span><span className="edge-direction">↓</span><span>{titleOf(threads.find((thread) => thread.id === (selectedManualEdge?.target || selectedInherited?.id || selectedFork?.id)))}</span></div>{selectedManualEdge ? <><label className="field-label" htmlFor="edge-kind">关系类型</label><select id="edge-kind" className="form-input" value={selectedManualEdge.type} data-testid="edge-type" onChange={(event) => saveEdges(graph.current.edges.map((edge) => edge.id === selectedManualEdge.id ? { ...edge, type: event.target.value } : edge))}>{Object.entries(RELATIONS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><p className="field-note">用于标记对话关系，不会自动传递上下文或执行任务。</p><button className="danger-button full-width" data-testid="delete-edge" onClick={() => { saveEdges(graph.current.edges.filter((edge) => edge.id !== selectedManualEdge.id)); setSelectedEdgeId(null); }}><Trash2 size={13} /> 删除连线</button></> : selectedInherited ? <><p className="field-note">这条新对话由来源对话的交接提示词创建，继承关系自动保留。</p><dl><dt>来源对话 ID</dt><dd className="thread-id" data-testid="inherit-source-id">{selectedInherited.inheritedFromId}</dd></dl><button className="secondary-button full-width" data-testid="inherit-view-source" onClick={() => { const source = threads.find((thread) => thread.id === selectedInherited.inheritedFromId); if (source) focusThread(source); }}><ArrowUpRight size={13} />查看来源对话</button></> : <p className="field-note">这条关系来自 Codex 的真实 Fork 记录，自动同步。</p>}</aside>}
        </div>
      </main>
      {modal && <ThreadModal key={`${modal.kind}:${modal.thread?.id || 'new'}`} modal={modal} folders={workspaceOptions.length ? workspaceOptions : folders} organization={organization} onClose={() => setModal(null)} onCreated={onCreated} />}
      {organizationModal && <OrganizationModal initial={organizationModal} organization={organization} onClose={() => setOrganizationModal(null)} onSave={updateOrganization} />}
      {windowPicker && <WindowPicker picker={windowPicker} onClose={() => setWindowPicker(null)} onOpen={launchThread} />}
      {toast && <div className={`toast ${toast.kind}`} role="status" data-testid="toast">{toast.kind === 'success' ? <Check size={15} /> : <X size={15} />}{toast.message}</div>}
    </div>
  );
}

function InheritedSettings({ settings, title = '沿用来源配置', testId = 'inherit-settings' }) {
  const config = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
  const effortLabels = { none: '无', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高', ultra: '极高', default: '默认' };
  const tierLabels = { default: '默认', standard: '标准', priority: '优先', fast: '快速', flex: '弹性' };
  const fields = [
    ['model', '模型', (value) => value],
    ['modelProvider', '提供方', (value) => value],
    ['reasoningEffort', '推理强度', (value) => value === null ? '默认' : effortLabels[value] || value],
    ['collaborationMode', '协作模式', (value) => value === 'plan' ? '计划模式' : value === 'default' ? '默认模式' : value],
    ['serviceTier', '服务等级', (value) => value === null ? '默认' : tierLabels[value] || value],
  ];
  const rows = fields.filter(([key]) => Object.hasOwn(config, key) && (typeof config[key] === 'string' && config[key].trim() || ['reasoningEffort', 'serviceTier'].includes(key) && config[key] === null));
  const missing = ['model', 'reasoningEffort', 'collaborationMode', 'serviceTier'].some((key) => !rows.some(([field]) => field === key));
  return <section className="inherit-settings" data-testid={testId} aria-label={title}>
    <h3>{title}</h3>
    {rows.length > 0 && <dl className="inherit-settings-grid">{rows.map(([key, label, format]) => <div key={key}><dt>{label}</dt><dd data-testid={`${testId}-${key}`}>{format(config[key])}</dd></div>)}</dl>}
    {!rows.length ? <p>来源未记录此设置，使用 Codex 默认值。</p> : missing && <p>来源未记录的设置使用 Codex 默认值。</p>}
    {config.collaborationMode === 'plan' && <p className="inherit-settings-plan-note" data-testid={`${testId}-plan-note`}>已保存计划模式；打开 VS Code 后请核对计划开关。</p>}
  </section>;
}

function InheritedPrompt({ threadId, notify }) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const request = useRef(null);
  useEffect(() => () => { request.current?.abort(); request.current = null; }, []);
  const load = async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
    setExpanded(true); setLoading(true); setError('');
    try {
      const data = await api(`/api/threads/${encodeURIComponent(threadId)}/inheritance`, { signal: controller.signal });
      if (request.current === controller && !controller.signal.aborted) setResult({ source: data.source, prompt: typeof data.prompt === 'string' ? data.prompt : '', settings: data.settings });
    } catch (err) {
      if (request.current === controller && (!controller.signal.aborted || timedOut)) setError(timedOut ? '读取超时，请重试。' : err.message);
    } finally {
      clearTimeout(timeout);
      if (request.current === controller && (!controller.signal.aborted || timedOut)) setLoading(false);
    }
  };
  const collapse = () => { request.current?.abort(); request.current = null; setExpanded(false); setLoading(false); setError(''); };
  const copyPrompt = async () => {
    try { await navigator.clipboard.writeText(result.prompt); notify('已复制交接提示词'); }
    catch { notify('复制失败，可选中下方提示词手动复制。', 'error'); }
  };
  return <section className="inheritance-context" data-testid="inheritance-context">
    <p className="handoff-note">交接上下文已载入，打开后发送下一条消息即可继续。</p>
    {!expanded ? <button className="secondary-button full-width" onClick={load} aria-expanded="false" data-testid="show-inheritance"><ArrowRightToLine size={14} />查看交接提示词</button> : <>
      <div className="replies-heading"><strong>交接提示词</strong><button className="icon-button" title="复制交接提示词" aria-label="复制交接提示词" onClick={copyPrompt} disabled={loading || !result?.prompt} data-testid="inheritance-copy"><Copy size={13} /></button><button className="replies-collapse" onClick={collapse} data-testid="collapse-inheritance">收起</button></div>
      {loading && <p className="handoff-loading" role="status"><LoaderCircle size={13} className="spin" />正在读取交接提示词…</p>}
      {error && <div className="form-error" role="alert">{error}<button className="handoff-retry" onClick={load} data-testid="inheritance-retry">重试</button></div>}
      {result && <><p className="handoff-note">来源：{result.source?.title || '原对话'}</p><InheritedSettings settings={result.settings} title="已继承配置" testId="inheritance-settings" /><pre className="inheritance-prompt" data-testid="inheritance-prompt">{result.prompt || '暂无可显示的交接提示词。'}</pre></>}
    </>}
  </section>;
}

function RecentReplies({ thread }) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [loadedActivityKey, setLoadedActivityKey] = useState(null);
  const request = useRef(null);
  useEffect(() => () => { request.current?.abort(); request.current = null; }, []);

  const loadReplies = async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const activityKey = `${thread.activity?.eventKey || ''}:${thread.activity?.at || ''}`;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
    setExpanded(true); setLoading(true); setError('');
    try {
      const data = await api(`/api/threads/${encodeURIComponent(thread.id)}/replies`, { signal: controller.signal });
      if (request.current === controller && !controller.signal.aborted) {
        setResult({ replies: Array.isArray(data.replies) ? data.replies : [], limited: !!data.limited });
        setLoadedActivityKey(activityKey);
      }
    } catch (err) {
      if (request.current === controller && (!controller.signal.aborted || timedOut)) setError(timedOut ? '读取超时，请重试。' : err.message);
    } finally {
      clearTimeout(timeout);
      if (request.current === controller && (!controller.signal.aborted || timedOut)) setLoading(false);
    }
  };
  const collapse = () => {
    request.current?.abort(); request.current = null;
    setExpanded(false); setLoading(false); setError('');
  };
  const newerActivity = result && loadedActivityKey !== `${thread.activity?.eventKey || ''}:${thread.activity?.at || ''}`;
  return <section className="recent-replies" data-testid="recent-replies">
    {!expanded ? <button className="secondary-button full-width" onClick={loadReplies} data-testid="show-replies"><MessageSquare size={14} />查看最近回复</button> : <>
      <div className="replies-heading"><strong>最近回复</strong><button className="icon-button" title="刷新回复" aria-label="刷新回复" onClick={loadReplies} disabled={loading} data-testid="refresh-replies"><RefreshCw size={13} className={loading ? 'spin' : ''} /></button><button className="replies-collapse" onClick={collapse} data-testid="collapse-replies">收起</button></div>
      <p className="replies-note">{newerActivity ? '有新活动，可刷新查看最近回复。' : '按需加载，可能不含完整历史。'}</p>
      {loading && <p className="replies-loading" role="status"><LoaderCircle size={13} className="spin" />正在读取回复…</p>}
      {error && <p className="form-error" role="alert">{error}<button className="replies-retry" onClick={loadReplies}>重试</button></p>}
      {result && <div className="reply-list" data-testid="reply-list">{result.replies.map((reply) => <article className="reply-item" key={reply.id}><div className="reply-meta"><strong>{reply.phase === 'commentary' ? '进展回复' : ['final', 'final_answer'].includes(reply.phase) ? '本轮回复' : '回复'}</strong><time>{reply.at ? new Date(reply.at).toLocaleString('zh-CN') : '时间未知'}</time></div><p>{reply.text}</p>{reply.truncated && <small>此条回复较长，仅显示部分内容。</small>}</article>)}{!result.replies.length && <p className="replies-note">暂未读取到最近回复。</p>}</div>}
      {result?.limited && <p className="replies-note">仅展示部分最近回复，完整对话请在 VS Code 查看。</p>}
    </>}
  </section>;
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

function HandoffCoverage({ handoff }) {
  const { coverage, files } = handoff;
  const hasCoverage = coverage && [coverage.bytesRead, coverage.totalBytes, coverage.messageCount].every((value) => Number.isFinite(value) && value >= 0);
  const paths = Array.isArray(files) ? files.filter((file) => typeof file?.path === 'string' && file.path) : null;
  const formatBytes = (bytes) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  const statuses = { file: '文件存在', directory: '目录存在', missing: '未找到', unverified: '未核验' };
  if (!hasCoverage && !paths) return null;
  return <div className="handoff-coverage">
    {hasCoverage && <p className="handoff-note" data-testid="inherit-coverage">已扫描 {coverage.messageCount} 条公开消息，读取 {formatBytes(coverage.bytesRead)} / {formatBytes(coverage.totalBytes)}。{coverage.sampled && ` 分段读取${Number.isInteger(coverage.windowCount) && coverage.windowCount > 0 ? `（${coverage.windowCount} 处）` : ''}，未读取内容可能遗漏。`}</p>}
    {paths && (paths.length ? <details className="handoff-files" data-testid="inherit-files"><summary><span data-testid="inherit-file-count">关键路径 · {paths.length} 项</span><span className="handoff-files-hint">查看清单</span></summary><ul>{paths.map((file, index) => <li key={`${file.path}:${file.line || ''}:${index}`}><code>{file.path}{Number.isInteger(file.line) && file.line > 0 ? `:${file.line}` : ''}</code><span className={`handoff-file-status ${['missing', 'unverified'].includes(file.status) ? 'is-unverified' : ''}`}>{statuses[file.status] || statuses.unverified}</span></li>)}</ul><p className="handoff-note">路径来自公开记录，存在性按生成时结果显示。</p></details> : <p className="handoff-note" data-testid="inherit-file-count">未提取到关键路径，请补充需要保留的文件或目录。</p>)}
  </div>;
}

function ThreadModal({ modal, folders, organization, onClose, onCreated }) {
  const isInherit = modal.kind === 'inherit';
  const [title, setTitle] = useState(modal.title);
  const [cwd, setCwd] = useState(modal.cwd);
  const [projectId, setProjectId] = useState(modal.projectId || '');
  const [taskId, setTaskId] = useState(modal.taskId || '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [prompt, setPrompt] = useState('');
  const [handoff, setHandoff] = useState({ loading: isInherit, loaded: false, error: '', truncated: false, messageCount: 0 });
  const handoffRequest = useRef(null);
  const submitBusy = useRef(false);
  const creationRequest = useRef(null);
  const sourceId = modal.thread?.id;
  const maxPromptLength = handoff.maxPromptLength || HANDOFF_PROMPT_LIMIT;

  const loadHandoff = useCallback(async () => {
    if (!isInherit || !sourceId) return;
    handoffRequest.current?.abort();
    const controller = new AbortController();
    handoffRequest.current = controller;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
    setHandoff((current) => ({ ...current, loading: true, error: '' }));
    try {
      const result = await api(`/api/threads/${encodeURIComponent(sourceId)}/handoff`, { signal: controller.signal });
      if (handoffRequest.current !== controller || controller.signal.aborted) return;
      const text = typeof result.prompt === 'string' ? result.prompt : '';
      const limit = Number.isInteger(result.maxPromptLength) && result.maxPromptLength > 0 ? Math.min(result.maxPromptLength, HANDOFF_PROMPT_LIMIT) : HANDOFF_PROMPT_LIMIT;
      setPrompt(text.slice(0, limit));
      setHandoff({ loading: false, loaded: true, error: '', truncated: !!result.truncated || text.length > limit, messageCount: Number(result.messageCount) || 0, settings: result.settings, maxPromptLength: limit, version: result.version, coverage: result.coverage, files: result.files });
    } catch (err) {
      if (handoffRequest.current === controller && (!controller.signal.aborted || timedOut)) setHandoff((current) => ({ ...current, loading: false, error: timedOut ? '读取超时，请重试。' : err.message }));
    } finally { clearTimeout(timeout); }
  }, [isInherit, sourceId]);

  useEffect(() => {
    loadHandoff();
    return () => { handoffRequest.current?.abort(); handoffRequest.current = null; };
  }, [loadHandoff]);
  useEffect(() => {
    const handler = (event) => { if (event.key === 'Escape' && !submitBusy.current) onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  async function submit(event) {
    event.preventDefault();
    if (submitBusy.current) return;
    if (!cwd.trim()) { setError('请选择或填写文件夹。'); return; }
    if (isInherit && (!handoff.loaded || handoff.loading)) { setError('请先读取交接提示词。'); return; }
    if (isInherit && (!prompt.trim() || prompt.length > maxPromptLength)) { setError(`交接提示词不能为空，且最多 ${maxPromptLength} 字符。`); return; }
    submitBusy.current = true;
    setSubmitting(true); setError('');
    const assignment = { projectId: projectId || null, taskId: taskId || null };
    let result;
    try {
      const url = ['fork', 'inherit'].includes(modal.kind) ? `/api/threads/${encodeURIComponent(sourceId)}/${modal.kind}` : '/api/threads';
      const payload = { cwd: cwd.trim(), title: title.trim(), ...assignment, ...(isInherit ? { prompt: prompt.trim() } : {}) };
      const fingerprint = `${url}:${JSON.stringify(payload)}`;
      if (creationRequest.current?.fingerprint !== fingerprint) creationRequest.current = { fingerprint, requestId: crypto.randomUUID() };
      result = await api(url, { method: 'POST', body: JSON.stringify({ ...payload, requestId: creationRequest.current.requestId }) });
      if (!result.thread?.id) throw new Error('创建结果尚未确认，请保持当前内容重试。');
    } catch (err) {
      setError(err instanceof TypeError ? '连接中断，创建结果尚未确认。请保持当前内容重试，以恢复本次结果。' : err.message); setSubmitting(false); submitBusy.current = false;
      return;
    }
    // Creation has succeeded. Opening the editor is a separate action, so an
    // editor failure must never re-enable this POST or create another thread.
    await onCreated(result.thread, assignment, modal.kind);
  }
  const blocked = submitting || (isInherit && (!handoff.loaded || handoff.loading || !prompt.trim() || prompt.length > maxPromptLength));
  const actionIcon = modal.kind === 'fork' ? <GitFork size={14} /> : isInherit ? <ArrowRightToLine size={14} /> : <Plus size={14} />;
  return <div className="modal-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !submitBusy.current) onClose(); }}><section className={`modal ${isInherit ? 'inherit-modal' : ''}`} role="dialog" aria-modal="true" aria-labelledby="modal-title" data-testid="thread-modal">
    <div className="modal-heading"><span className="modal-icon">{modal.kind === 'fork' ? <GitFork size={21} /> : isInherit ? <ArrowRightToLine size={21} /> : <Plus size={21} />}</span><button className="icon-button" onClick={onClose} disabled={submitting} aria-label="关闭窗口"><X size={18} /></button></div>
    <h2 id="modal-title">{modal.kind === 'fork' ? 'Fork 对话' : isInherit ? '继承为新对话' : '新建对话'}</h2>
    <p className="modal-description">{modal.kind === 'fork' ? '沿用这条对话的上下文，并创建新的独立对话。' : isInherit ? '创建独立新对话，沿用已记录的来源配置并带入下方交接提示词，适合长对话继续。创建后会打开 VS Code，发送下一条消息即可继续。' : '创建后可在 VS Code 中开始对话。'}</p>
    {['fork', 'inherit'].includes(modal.kind) && <div className={`fork-origin ${isInherit ? 'inherit-origin' : ''}`} data-testid={isInherit ? 'inherit-origin' : undefined}>{isInherit ? <ArrowRightToLine size={13} /> : <GitFork size={13} />}<span>{titleOf(modal.thread)}</span></div>}
    <div className="creation-permissions" data-testid="modal-permissions"><strong>Full Access</strong><span>· 完整文件与命令访问，无需逐项审批</span></div>
    <form onSubmit={submit}>
      <label className="field-label" htmlFor="thread-title">对话名称 <span>可选</span></label><input className="form-input" id="thread-title" data-testid="modal-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：相机初始化问题" autoFocus maxLength={120} disabled={submitting} />
      <label className="field-label" htmlFor="thread-cwd">文件夹</label><input className="form-input path-input" id="thread-cwd" data-testid="modal-cwd" list="workspace-paths" value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="/home/…/your-project" required disabled={submitting} /><datalist id="workspace-paths">{[...new Set(folders.map((item) => item.cwd).filter(Boolean))].map((path) => <option value={path} key={path} />)}</datalist>
      <div className="modal-assignment"><div><label className="field-label" htmlFor="modal-project">项目</label><select id="modal-project" className="form-input" data-testid="modal-project" value={projectId} disabled={submitting} onChange={(event) => { setProjectId(event.target.value); setTaskId(''); }}><option value="">未归类</option>{organization.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></div><div><label className="field-label" htmlFor="modal-task">任务</label><select id="modal-task" className="form-input" data-testid="modal-task" value={taskId} disabled={submitting || !projectId} onChange={(event) => setTaskId(event.target.value)}><option value="">未指定任务</option>{organization.tasks.filter((task) => task.projectId === projectId).map((task) => <option key={task.id} value={task.id}>{task.name}</option>)}</select></div></div>
      {isInherit && handoff.loaded && <InheritedSettings settings={handoff.settings} />}
      {isInherit && <section className="handoff-editor"><div className="handoff-label"><label className="field-label" htmlFor="inherit-prompt">交接提示词</label><span data-testid="inherit-prompt-count">{prompt.length} / {maxPromptLength}</span></div><p className="field-note" id="inherit-prompt-help">{handoff.loaded && handoff.version !== 2 ? '下方为公开消息摘录，可补充目标、关键路径、已完成、待办和验证线索。' : '结构化交接，含关键路径、已完成、待办和验证线索；未记录项需补齐。'}请检查并编辑后继续。</p>
        {handoff.loading && <p className="handoff-loading" role="status" data-testid="inherit-loading"><LoaderCircle size={14} className="spin" />正在读取交接内容…</p>}
        {handoff.error && <div className="form-error" role="alert" data-testid="inherit-error">{handoff.error}<button className="handoff-retry" type="button" onClick={loadHandoff} disabled={submitting} data-testid="inherit-retry">重新读取</button></div>}
        {handoff.loaded && <HandoffCoverage handoff={handoff} />}
        <textarea id="inherit-prompt" className="form-input handoff-textarea" data-testid="inherit-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} disabled={submitting || handoff.loading || !handoff.loaded} maxLength={maxPromptLength} rows={14} aria-describedby="inherit-prompt-help" placeholder="目标：
已有决定：
下一步待办：" />
        {handoff.loaded && <p className={`handoff-note ${handoff.truncated ? 'is-truncated' : ''}`} data-testid="inherit-note">{handoff.messageCount ? `${handoff.version === 2 ? '交接内容选入' : '已读取'} ${handoff.messageCount} 条公开消息。` : '暂无可用公开消息，可自行补写交接提示词。'}{handoff.truncated && ' 内容已截取，请补齐需要保留的信息。'}</p>}
      </section>}
      {error && <p className="form-error" role="alert" data-testid="modal-error">{error}</p>}
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose} disabled={submitting} data-testid="modal-cancel">取消</button><button type="submit" className="primary-button" disabled={blocked} data-testid="modal-submit">{submitting ? <LoaderCircle className="spin" size={14} /> : actionIcon}{submitting ? '正在创建…' : modal.kind === 'fork' ? '创建 Fork' : isInherit ? '继承并打开' : '创建对话'}</button></div>
    </form>
  </section></div>;
}

createRoot(document.getElementById('root')).render(<App />);
