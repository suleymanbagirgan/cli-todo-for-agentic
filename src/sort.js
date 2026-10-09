const STATUS_RANK = { ACTIVE: 0, READY: 1, HOLD: 2, COMPLETE: 3 };
const statusRank = (t) => STATUS_RANK[t.status] ?? (t.done ? 3 : 1);

const compareDoneAtDesc = (a, b) => {
  const da = a.doneAt || '';
  const db = b.doneAt || '';
  if (da === db) return b.id - a.id;
  if (!da) return 1;
  if (!db) return -1;
  return db.localeCompare(da);
};

export function sortTasks(tasks) {
  return [...tasks].sort((a, b) => {
    const sa = statusRank(a);
    const sb = statusRank(b);
    if (sa !== sb) return sa - sb;
    if (sa === STATUS_RANK.COMPLETE) return compareDoneAtDesc(a, b);
    const pa = a.priority || 0;
    const pb = b.priority || 0;
    if (pa !== pb) return pb - pa;
    if (a.due !== b.due) {
      if (!a.due) return 1;
      if (!b.due) return -1;
      return a.due.localeCompare(b.due);
    }
    return a.id - b.id;
  });
}

export function sortTasksGrouped(tasks, projectOrder = []) {
  const rank = (p) => {
    const key = p || '(proje yok)';
    const i = projectOrder.indexOf(key);
    return i === -1 ? 999 : i;
  };
  return [...tasks].sort((a, b) => {
    const sa = statusRank(a);
    const sb = statusRank(b);
    if (sa !== sb) {
      if (sa === STATUS_RANK.COMPLETE) return 1;
      if (sb === STATUS_RANK.COMPLETE) return -1;
    }
    if (sa === STATUS_RANK.COMPLETE && sb === STATUS_RANK.COMPLETE) {
      return compareDoneAtDesc(a, b);
    }
    const ra = rank(a.project);
    const rb = rank(b.project);
    if (ra !== rb) return ra - rb;
    const projCmp = (a.project || '').localeCompare(b.project || '');
    if (projCmp !== 0) return projCmp;
    if (sa !== sb) return sa - sb;
    const pa = a.priority || 0;
    const pb = b.priority || 0;
    if (pa !== pb) return pb - pa;
    if (a.due !== b.due) {
      if (!a.due) return 1;
      if (!b.due) return -1;
      return a.due.localeCompare(b.due);
    }
    return a.id - b.id;
  });
}
