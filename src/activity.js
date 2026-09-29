const STATUSES = {
  active: { label: '运行中（推测）' },
  waiting: { label: '需你处理（推测）' },
  completed: { label: '本轮结束' },
  interrupted: { label: '本轮中断' },
  failed: { label: '运行失败' },
  unknown: { label: '状态未知' },
};

export function activityPresentation(thread) {
  const status = Object.hasOwn(STATUSES, thread?.status) ? thread.status : 'unknown';
  const reason = thread?.activity?.reason || (status === 'unknown' ? '暂无可确认的运行状态。' : STATUSES[status].label);
  return { status, label: STATUSES[status].label, reason };
}

// Keep this tracker across SSE reconnects. The first snapshot establishes the
// baseline; older events and repeated event keys never produce notifications.
export function createActivityTracker() {
  let startedAt = null;
  const histories = new Map();
  return (threads, now = Date.now()) => {
    const firstSnapshot = startedAt === null;
    if (firstSnapshot) startedAt = now;
    const notices = [];
    for (const thread of threads) {
      const activity = thread.activity;
      if (!activity?.eventKey) continue;
      const at = Number.isFinite(activity.at) ? activity.at : null;
      const previous = histories.get(thread.id);
      const seen = previous?.seen || new Set();
      const repeated = seen.has(activity.eventKey);
      const older = previous?.at != null && (at == null || at < previous.at);
      const notifiable = ['waiting', 'completed'].includes(thread.status);
      if (notifiable) seen.add(activity.eventKey);
      if (seen.size > 128) seen.delete(seen.values().next().value);
      histories.delete(thread.id);
      histories.set(thread.id, { at: Math.max(previous?.at ?? 0, at ?? 0) || null, seen });
      if (histories.size > 2000) histories.delete(histories.keys().next().value);
      // A newly discovered old thread may appear after a snapshot refresh.
      const historical = at != null ? at < startedAt : !previous;
      if (!firstSnapshot && !historical && !older && !repeated && notifiable && !activity.stale && !thread.archived) {
        notices.push({ id: `${thread.id}:${activity.eventKey}`, threadId: thread.id, title: thread.title?.trim() || '未命名对话', status: thread.status });
      }
    }
    return notices;
  };
}
