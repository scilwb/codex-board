import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, Copy, Download, FileText, Library, LoaderCircle, MoreHorizontal, Pencil, Pin, Plus, RefreshCw, Search, Trash2, Upload, X } from 'lucide-react';
import './PromptLibrary.css';

const TITLE_LIMIT = 100;
const CONTENT_LIMIT = 60_000;
const ordered = (items) => [...items].sort((a, b) => Number(b.pinned) - Number(a.pinned) || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime() || a.id.localeCompare(b.id));
const makeDraft = (prompt) => ({ id: prompt?.id || crypto.randomUUID(), title: prompt?.title || '', content: prompt?.content || '', tags: (prompt?.tags || []).join('、'), pinned: !!prompt?.pinned, revision: prompt?.revision, isNew: !prompt });
const draftFields = ({ title, content, tags, pinned }) => JSON.stringify({ title, content, tags, pinned });
const parseTags = (value) => [...new Set(value.split(/[,，、\n]/u).map(tag => tag.trim()).filter(Boolean))];
const dateLabel = (value) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }); };

export default function PromptLibrary({ onClose, notify, api }) {
  const [prompts, setPrompts] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [recovered, setRecovered] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState('');
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [pendingAction, setPendingAction] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [conflict, setConflict] = useState(null);
  const dialogRef = useRef(null);
  const searchRef = useRef(null);
  const titleRef = useRef(null);
  const importRef = useRef(null);
  const menuRef = useRef(null);
  const baseline = useRef('');
  const inFlight = useRef(false);
  const alive = useRef(true);
  const copiedTimer = useRef(null);
  const returnFocus = useRef(typeof document !== 'undefined' ? document.activeElement : null);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const selected = prompts.find(prompt => prompt.id === selectedId);
  const dirty = !!draft && draftFields(draft) !== baseline.current;
  const allTags = useMemo(() => [...new Set(prompts.flatMap(prompt => prompt.tags || []))].sort((a, b) => a.localeCompare(b, 'zh-CN')), [prompts]);
  const visible = useMemo(() => {
    const text = query.trim().toLocaleLowerCase();
    return ordered(prompts).filter(prompt => (!pinnedOnly || prompt.pinned) && (!tag || prompt.tags.includes(tag)) && (!text || `${prompt.title}\n${prompt.content}\n${prompt.tags.join(' ')}`.toLocaleLowerCase().includes(text)));
  }, [prompts, query, tag, pinnedOnly]);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const result = await api('/api/prompts');
      if (!alive.current) return;
      setPrompts(result.prompts);
      setRecovered(!!result.recovered);
      setSelectedId(current => result.prompts.some(prompt => prompt.id === current) ? current : ordered(result.prompts)[0]?.id || null);
    } catch (err) { if (alive.current) setError(err.message || '提示词加载失败'); }
    finally { if (alive.current) setLoading(false); }
  }, [api]);

  useEffect(() => {
    alive.current = true;
    void load();
    searchRef.current?.focus();
    const previouslyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      alive.current = false;
      clearTimeout(copiedTimer.current);
      document.body.style.overflow = previouslyOverflow;
      returnFocus.current?.isConnected && returnFocus.current.focus();
    };
  }, [load]);
  useEffect(() => { if (draft) titleRef.current?.focus(); }, [draft?.id]);
  useEffect(() => {
    if (!menuOpen) return;
    const closeMenu = event => { if (!menuRef.current?.contains(event.target)) setMenuOpen(false); };
    document.addEventListener('pointerdown', closeMenu);
    return () => document.removeEventListener('pointerdown', closeMenu);
  }, [menuOpen]);

  const guarded = (action, description = '离开编辑') => {
    if (inFlight.current) return;
    setMenuOpen(false); setDeleting(false);
    if (dirty) { setPendingAction({ action, description }); return; }
    setPendingAction(null); action();
  };
  const clearDraft = () => { setDraft(null); setConflict(null); setError(''); setPendingAction(null); };
  const pick = (id) => guarded(() => { clearDraft(); setSelectedId(id); setMobileDetail(true); }, '切换提示词');
  const create = () => guarded(() => {
    const next = makeDraft(); baseline.current = draftFields(next);
    setDraft(next); setSelectedId(null); setMobileDetail(true); setConflict(null); setError(''); setQuery(''); setTag(''); setPinnedOnly(false);
  }, '新建提示词');
  const edit = () => {
    if (!selected || inFlight.current) return;
    const next = makeDraft(selected); baseline.current = draftFields(next);
    setDraft(next); setConflict(null); setError(''); setDeleting(false);
  };
  const cancelEdit = () => guarded(() => { clearDraft(); if (!selected) setSelectedId(ordered(prompts)[0]?.id || null); }, '取消编辑');
  const changeDraft = (key, value) => setDraft(current => ({ ...current, [key]: value }));
  const startRequest = () => { if (inFlight.current) return false; inFlight.current = true; setBusy(true); setError(''); return true; };
  const finishRequest = () => { inFlight.current = false; if (alive.current) setBusy(false); };
  const refreshConflict = async (id) => {
    const result = await api('/api/prompts');
    if (alive.current) { setPrompts(result.prompts); setRecovered(!!result.recovered); setConflict({ id, current: result.prompts.find(prompt => prompt.id === id) || null }); }
  };
  const save = async (revision) => {
    if (!draft || inFlight.current || pendingAction || (conflict && revision === undefined)) return;
    const tags = parseTags(draft.tags);
    if (!draft.title.trim()) { setError('给提示词起一个名字，方便以后找到。'); titleRef.current?.focus(); return; }
    if (!draft.content.trim()) { setError('请输入要保存的提示词。'); return; }
    if (draft.title.trim().length > TITLE_LIMIT || draft.content.length > CONTENT_LIMIT) { setError(`标题最多 ${TITLE_LIMIT} 字，提示词最多 ${CONTENT_LIMIT.toLocaleString()} 字。`); return; }
    if (tags.length > 8 || tags.some(value => value.length > 24)) { setError('最多 8 个标签，每个标签最多 24 字。'); return; }
    if (!startRequest()) return;
    const outgoing = draft;
    try {
      const fields = { title: outgoing.title.trim(), content: outgoing.content, tags, pinned: outgoing.pinned };
      // A create request may have committed before its response was lost. Once
      // its saved version is confirmed, an explicit overwrite updates that ID.
      const creating = outgoing.isNew && revision === undefined;
      const result = await api(creating ? '/api/prompts' : `/api/prompts/${outgoing.id}`, {
        method: creating ? 'POST' : 'PATCH',
        body: JSON.stringify(creating ? { id: outgoing.id, ...fields } : { revision: revision ?? outgoing.revision, ...fields }),
      });
      if (!alive.current) return;
      setPrompts(current => [...current.filter(prompt => prompt.id !== result.prompt.id), result.prompt]);
      setRecovered(false);
      setSelectedId(result.prompt.id); clearDraft(); setQuery(''); setTag(''); setPinnedOnly(false);
      notify?.('提示词已保存');
    } catch (err) {
      if (!alive.current) return;
      setError(err.message || '保存失败，草稿仍在，可以重试。');
      if (err.status === 409 || err.status === 404) {
        try { await refreshConflict(outgoing.id); setError(err.status === 404 ? '这个提示词已被删除，草稿仍在。' : '这个提示词已在其他窗口更新，草稿已保留。'); }
        catch { setError('保存版本冲突，草稿已保留。读取最新版本失败，请稍后重试。'); }
      }
    } finally { finishRequest(); }
  };
  const copy = async (prompt) => {
    try {
      await navigator.clipboard.writeText(prompt.content);
      if (!alive.current) return;
      setError(current => current.startsWith('无法访问剪贴板') ? '' : current);
      setCopied(prompt.id); clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => { if (alive.current) setCopied(null); }, 2200);
      notify?.('已复制提示词');
    } catch { if (alive.current) { setError('无法访问剪贴板，请选中右侧提示词手动复制。'); notify?.('复制失败，请手动复制', 'error'); } }
  };
  const pin = async (prompt) => {
    if (!startRequest()) return;
    try {
      const result = await api(`/api/prompts/${prompt.id}`, { method: 'PATCH', body: JSON.stringify({ revision: prompt.revision, pinned: !prompt.pinned }) });
      if (alive.current) { setPrompts(current => current.map(item => item.id === prompt.id ? result.prompt : item)); setRecovered(false); }
    } catch (err) {
      if (alive.current) setError(err.message || '置顶失败');
      if (err.status === 409 || err.status === 404) { try { await load(); setError('提示词已在其他窗口更改，请重试。'); } catch { /* The loader reports failures. */ } }
    } finally { finishRequest(); }
  };
  const remove = async () => {
    if (!selected || !startRequest()) return;
    const outgoing = selected;
    try {
      await api(`/api/prompts/${outgoing.id}`, { method: 'DELETE', body: JSON.stringify({ revision: outgoing.revision }) });
      if (!alive.current) return;
      const remaining = prompts.filter(prompt => prompt.id !== outgoing.id);
      setPrompts(remaining); setRecovered(false); setSelectedId(ordered(remaining)[0]?.id || null); setDeleting(false); setMobileDetail(false);
      notify?.('提示词已删除');
    } catch (err) {
      if (alive.current) setError(err.message || '删除失败');
      if (err.status === 409 || err.status === 404) { await load(); setDeleting(false); setError('提示词已在其他窗口更改，请确认最新内容后再删除。'); }
    } finally { finishRequest(); }
  };
  const exportLibrary = async () => {
    setMenuOpen(false);
    if (!startRequest()) return;
    try {
      // Back up the persisted library, including saves from other windows.
      // This refresh never changes an unsaved editor draft.
      const latest = await api('/api/prompts');
      if (!alive.current) return;
      setPrompts(latest.prompts); setRecovered(!!latest.recovered);
      const blob = new Blob([JSON.stringify({ version: 1, prompts: ordered(latest.prompts) }, null, 2) + '\n'], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
      anchor.href = url; anchor.download = `codex-prompts-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify?.('提示词备份已导出');
    } catch (err) { if (alive.current) setError(err.message || '备份导出失败，请重试。'); }
    finally { finishRequest(); }
  };
  const importLibrary = async (event) => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file || !startRequest()) return;
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('备份文件过大，请使用小于 5 MB 的 JSON 文件。');
      let data;
      try { data = JSON.parse(await file.text()); } catch { throw new Error('备份不是有效的 JSON 文件。'); }
      if (data.version !== 1 || !Array.isArray(data.prompts)) throw new Error('请选择从提示词库导出的 JSON 备份。');
      const result = await api('/api/prompts/import', { method: 'POST', body: JSON.stringify(data) });
      if (!alive.current) return;
      setPrompts(result.prompts); setRecovered(!!result.recovered); clearDraft();
      setSelectedId(current => result.prompts.some(prompt => prompt.id === current) ? current : ordered(result.prompts)[0]?.id || null);
      notify?.(`已导入 ${result.imported} 条${result.skipped ? `，跳过 ${result.skipped} 条重复提示词` : ''}`);
    } catch (err) { if (alive.current) setError(err.message || '导入失败'); }
    finally { finishRequest(); }
  };
  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      if (menuOpen) { setMenuOpen(false); menuRef.current?.querySelector('button')?.focus(); }
      else if (pendingAction) setPendingAction(null);
      else if (deleting) setDeleting(false);
      else guarded(onClose, '关闭提示词库');
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); event.stopPropagation(); searchRef.current?.focus(); searchRef.current?.select(); return; }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && draft) { event.preventDefault(); if (!pendingAction && !conflict) void save(); return; }
    if (event.key === 'Tab') {
      const targets = [...dialogRef.current.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex="0"]')].filter(element => element.getClientRects().length);
      const first = targets[0], last = targets.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      return;
    }
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && (event.target === searchRef.current || event.target.closest('[data-prompts-list]'))) {
      event.preventDefault(); if (!visible.length || inFlight.current) return;
      const index = visible.findIndex(prompt => prompt.id === selectedIdRef.current);
      const next = visible[(index + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length];
      guarded(() => { clearDraft(); setSelectedId(next.id); }, '切换提示词');
      dialogRef.current?.querySelector(`[data-testid="prompts-select-${next.id}"]`)?.scrollIntoView({ block: 'nearest' });
    }
  };
  const hasFilters = !!(query || tag || pinnedOnly);

  return <div className="prompts-overlay" data-testid="prompts-overlay" onPointerDown={event => { if (event.target === event.currentTarget) guarded(onClose, '关闭提示词库'); }}>
    <section className={`prompts-panel ${mobileDetail ? 'show-detail' : ''}`} role="dialog" aria-modal="true" aria-labelledby="prompts-heading" data-testid="prompts-dialog" ref={dialogRef} tabIndex={-1} onKeyDown={onKeyDown}>
      <header className="prompts-header">
        <span className="prompts-mark"><Library size={22} /></span>
        <div className="prompts-heading"><h2 id="prompts-heading">提示词库</h2><p>保存好用的提示词，找到就能复制。</p></div>
        <button className="primary-button prompts-new" onClick={create} disabled={busy || loading} data-testid="prompts-new"><Plus size={16} /><span>新建</span></button>
        <div className="prompts-menu-wrap" ref={menuRef}>
          <button className="prompts-icon" aria-label="备份与导入" aria-expanded={menuOpen} aria-haspopup="true" onClick={() => setMenuOpen(current => !current)} disabled={busy || loading} data-testid="prompts-backup-menu"><MoreHorizontal size={20} /></button>
          {menuOpen && <div className="prompts-menu" data-testid="prompts-backup-options"><button onClick={() => void exportLibrary()} data-testid="prompts-export"><Download size={15} />导出 JSON 备份</button><button onClick={() => guarded(() => importRef.current?.click(), '导入备份')} data-testid="prompts-import"><Upload size={15} />导入 JSON 备份</button></div>}
        </div>
        <input type="file" accept="application/json,.json" ref={importRef} hidden onChange={importLibrary} data-testid="prompts-import-file" />
        <button className="prompts-icon prompts-close" aria-label="关闭提示词库" onClick={() => guarded(onClose, '关闭提示词库')} disabled={busy} data-testid="prompts-close"><X size={21} /></button>
      </header>
      <div className="prompts-search-row">
        <label className="prompts-search"><Search size={17} /><input ref={searchRef} value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索标题、内容或标签" aria-label="搜索提示词" data-testid="prompts-search" />{query ? <button className="prompts-icon" aria-label="清空搜索" onClick={() => { setQuery(''); searchRef.current?.focus(); }}><X size={14} /></button> : <kbd>⌘ / Ctrl K</kbd>}</label>
        <button className={`prompts-pin-filter ${pinnedOnly ? 'active' : ''}`} aria-pressed={pinnedOnly} aria-label="只看置顶提示词" onClick={() => setPinnedOnly(current => !current)} data-testid="prompts-pinned-filter"><Pin size={15} /><span>置顶</span></button>
      </div>
      {pendingAction && <div className="prompts-confirm" role="alert" data-testid="prompts-unsaved"><span>修改尚未保存，确定要{pendingAction.description}吗？</span><div><button className="secondary-button" disabled={busy} data-testid="prompts-continue" onClick={() => { if (!inFlight.current) setPendingAction(null); }}>继续编辑</button><button className="danger-button" disabled={busy} data-testid="prompts-discard" onClick={() => { if (inFlight.current) return; const action = pendingAction.action; clearDraft(); action(); }}>放弃修改</button></div></div>}
      {error && <div className="prompts-error" role="alert" data-testid="prompts-error"><span>{error}</span>{!prompts.length && !draft && !loading && <button onClick={() => void load().then(() => searchRef.current?.focus())} data-testid="prompts-retry"><RefreshCw size={14} />重试</button>}</div>}
      {recovered && <div className="prompts-recovered" role="status" data-testid="prompts-recovered">已从上一次备份恢复，最近一次修改可能不在其中。</div>}
      <div className="prompts-body">
        <aside className="prompts-list-pane" aria-label="已保存提示词">
          {!!allTags.length && <div className="prompts-tag-filters" aria-label="标签筛选"><button className={!tag ? 'active' : ''} onClick={() => setTag('')} aria-pressed={!tag}>全部</button>{allTags.map(value => <button key={value} className={tag === value ? 'active' : ''} aria-pressed={tag === value} onClick={() => setTag(current => current === value ? '' : value)} data-testid={`prompts-tag-${value}`}>{value}</button>)}</div>}
          <div className="prompts-list" data-prompts-list data-testid="prompts-list">
            {loading ? <div className="prompts-small-empty" role="status"><LoaderCircle size={19} className="spin" /><span>正在读取提示词…</span></div> : visible.length ? visible.map(prompt => <div key={prompt.id} className={`prompts-item ${selectedId === prompt.id ? 'selected' : ''}`} data-testid={`prompts-item-${prompt.id}`}>
              <button className="prompts-item-select" onClick={() => pick(prompt.id)} aria-pressed={selectedId === prompt.id} data-testid={`prompts-select-${prompt.id}`}><span className="prompts-item-title">{prompt.pinned && <Pin size={12} aria-label="已置顶" />}<strong>{prompt.title}</strong></span><span className="prompts-item-preview">{prompt.content.replace(/\s+/gu, ' ')}</span>{!!prompt.tags.length && <span className="prompts-item-tags">{prompt.tags.slice(0, 3).map(value => <span key={value}>{value}</span>)}</span>}</button>
              <button className={`prompts-item-copy prompts-icon ${copied === prompt.id ? 'copied' : ''}`} aria-label={`复制 ${prompt.title}`} title="复制提示词" onClick={() => void copy(prompt)} data-testid={`prompts-copy-${prompt.id}`}>{copied === prompt.id ? <Check size={16} /> : <Copy size={16} />}</button>
            </div>) : <div className="prompts-small-empty">{hasFilters ? <Search size={22} /> : <FileText size={22} />}<span>{hasFilters ? '没有匹配的提示词' : '还没有保存的提示词'}</span>{hasFilters ? <button onClick={() => { setQuery(''); setTag(''); setPinnedOnly(false); }} data-testid="prompts-clear-filters">清除筛选</button> : <button onClick={create} data-testid="prompts-create-first-list">新建第一条提示词</button>}</div>}
          </div>
          <footer className="prompts-list-footer">{loading ? '本地提示词库' : `${prompts.length} 条提示词`}<span>↑ ↓ 快速选择</span></footer>
        </aside>
        <main className="prompts-detail" aria-label={draft ? '编辑提示词' : '提示词内容'}>
          <button className="prompts-back" onClick={() => setMobileDetail(false)} data-testid="prompts-back"><ArrowLeft size={16} />返回列表</button>
          {draft ? <>
            <div className="prompts-editor-heading"><span>{draft.isNew ? '新建提示词' : '编辑提示词'}</span><span>{dirty ? '未保存' : '草稿'}</span></div>
            <label className="prompts-field">名称<input ref={titleRef} value={draft.title} maxLength={TITLE_LIMIT} disabled={busy} onChange={event => changeDraft('title', event.target.value)} placeholder="例如：代码审查、任务交接" data-testid="prompts-title" /></label>
            <div className="prompts-editor-meta"><label className="prompts-field">标签<span>可选，用逗号分隔</span><input value={draft.tags} disabled={busy} onChange={event => changeDraft('tags', event.target.value)} placeholder="开发、写作…" data-testid="prompts-tags" /></label><label className="prompts-pin-check"><input type="checkbox" checked={draft.pinned} disabled={busy} onChange={event => changeDraft('pinned', event.target.checked)} data-testid="prompts-pin-editor" /><Pin size={14} />置顶</label></div>
            <label className="prompts-content-label" htmlFor="prompts-editor">提示词</label><textarea id="prompts-editor" className="prompts-editor" value={draft.content} maxLength={CONTENT_LIMIT} disabled={busy} onChange={event => changeDraft('content', event.target.value)} placeholder="粘贴或写下你的提示词，原有换行和缩进会完整保留。" spellCheck={false} data-testid="prompts-content" />
            {conflict && <div className="prompts-conflict" data-testid="prompts-conflict">{conflict.current ? <><details><summary>查看当前保存版本</summary><strong>{conflict.current.title}</strong><pre>{conflict.current.content}</pre></details><div><button className="secondary-button" disabled={busy} onClick={() => guarded(() => { const next = makeDraft(conflict.current); baseline.current = draftFields(next); setDraft(next); setConflict(null); setError(''); }, '读取最新版本')} data-testid="prompts-load-latest">读取最新版本</button><button className="danger-button" disabled={busy} onClick={() => void save(conflict.current.revision)} data-testid="prompts-overwrite">用我的草稿覆盖</button></div></> : <><span>可以把这份草稿另存为新提示词。</span><button className="secondary-button" onClick={() => { const next = { ...draft, id: crypto.randomUUID(), revision: undefined, isNew: true }; setDraft(next); setConflict(null); setError(''); }} data-testid="prompts-save-as-new">另存为新提示词</button></>}</div>}
            <footer className="prompts-detail-footer"><button className="secondary-button" onClick={cancelEdit} disabled={busy} data-testid="prompts-cancel-edit">取消</button><span className="prompts-shortcut">Ctrl / ⌘ Enter 保存</span><button className="primary-button" disabled={busy || !!conflict || !!pendingAction} onClick={() => void save()} data-testid="prompts-save">{busy ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}{busy ? '保存中…' : '保存'}</button></footer>
          </> : selected ? <>
            <div className="prompts-preview-heading"><h3>{selected.title}</h3><button className={`prompts-icon ${selected.pinned ? 'pinned' : ''}`} disabled={busy} onClick={() => void pin(selected)} aria-label={selected.pinned ? '取消置顶' : '置顶提示词'} aria-pressed={selected.pinned} data-testid="prompts-pin"><Pin size={17} /></button><button className="prompts-icon" aria-label="编辑提示词" title="编辑提示词" onClick={edit} disabled={busy} data-testid="prompts-edit"><Pencil size={17} /></button><button className="prompts-icon" aria-label="删除提示词" title="删除提示词" onClick={() => setDeleting(current => !current)} disabled={busy} data-testid="prompts-delete"><Trash2 size={17} /></button></div>
            {!!selected.tags.length && <div className="prompts-preview-tags">{selected.tags.map(value => <button key={value} onClick={() => { setTag(value); setMobileDetail(false); }}>{value}</button>)}</div>}
            <pre className="prompts-preview" tabIndex={0} data-testid="prompts-preview">{selected.content}</pre>
            {deleting && <div className="prompts-delete-confirm" role="alert" data-testid="prompts-delete-confirm"><span>删除这条提示词？</span><button className="secondary-button" onClick={() => setDeleting(false)} disabled={busy}>取消</button><button className="danger-button" onClick={() => void remove()} disabled={busy} data-testid="prompts-confirm-delete">{busy ? '删除中…' : '确认删除'}</button></div>}
            <footer className="prompts-detail-footer"><span className="prompts-update">更新于 {dateLabel(selected.updatedAt)}</span><button className="primary-button prompts-copy-main" onClick={() => void copy(selected)} data-testid="prompts-copy-selected">{copied === selected.id ? <Check size={16} /> : <Copy size={16} />}{copied === selected.id ? '已复制' : '复制提示词'}</button></footer>
          </> : <div className="prompts-empty" data-testid="prompts-empty"><span><FileText size={32} strokeWidth={1.3} /></span><h3>{prompts.length ? '选择一条提示词' : '好用的提示词，随手留存'}</h3><p>{prompts.length ? '点击左侧提示词，查看内容并复制。' : '给它起个名字，加个标签。下次需要时一键复制。'}</p>{!loading && !prompts.length && <button className="primary-button" onClick={create} data-testid="prompts-create-first"><Plus size={16} />保存第一条提示词</button>}</div>}
        </main>
      </div>
      <span className="prompts-sr-only" role="status" aria-live="polite" data-testid="prompts-copy-status">{copied ? '提示词已复制到剪贴板' : ''}</span>
    </section>
  </div>;
}
