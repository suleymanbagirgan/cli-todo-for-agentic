import { load, toggleTask, removeTask, findTask } from './store.js';
import { getActive, stopTimer, holdTimer, startTimer } from './timer.js';

export function completeTask(id) {
  const active = getActive();
  const data = load();
  const t = data.tasks.find((x) => x.id === id);
  if (!t) return { ok: false, msg: `#${id} bulunamadı` };

  let stopped = null;
  if (active?.id === id && t.status !== 'COMPLETE') {
    stopped = stopTimer('COMPLETE');
    return { ok: true, task: t, stopped, alreadyDone: false };
  }
  const toggled = toggleTask(id);
  return { ok: true, task: toggled, stopped: null, alreadyDone: !toggled.done };
}

export function deleteTask(id) {
  const active = getActive();
  const t = load().tasks.find((x) => x.id === id);
  if (!t) return { ok: false, msg: `#${id} bulunamadı` };
  if (active?.id === id) stopTimer();
  removeTask(id);
  return { ok: true, task: t };
}

export function startOrResume(id) {
  const t = load().tasks.find((x) => x.id === id);
  if (!t) return { ok: false, msg: `#${id} bulunamadı` };
  if (t.status === 'COMPLETE') return { ok: false, msg: 'bitmiş görev · önce geri aç' };
  const active = getActive();
  if (active?.id === id) return { ok: false, msg: 'zaten aktif · h ile hold, c ile complete' };
  const wasHold = t.status === 'HOLD';
  const r = startTimer(id);
  if (!r.ok) return r;
  return { ok: true, task: r.task, stopped: r.stopped, resumed: wasHold };
}

export function holdActive(id) {
  const active = getActive();
  if (!active) return { ok: false, msg: 'aktif timer yok' };
  if (id !== undefined && active.id !== id) return { ok: false, msg: 'sadece aktif görev hold\'a alınır' };
  return holdTimer();
}

export function resolveRef(ref) {
  return findTask(load(), ref);
}
