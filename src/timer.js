import { readFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { load, logEvent, readEvents, setStatus, addTimeSpent } from './store.js';
import { writeAtomic } from './io.js';

const LOCAL_DIR = join(homedir(), '.joi-todo-local');
const ACTIVE = join(LOCAL_DIR, 'active.json');

const LEGACY_DIR = join(homedir(), '.joi-todo');
const LEGACY_ACTIVE = join(LEGACY_DIR, 'active.json');

const STALE_HOURS = 12;

function ensure() {
  if (!existsSync(LOCAL_DIR)) mkdirSync(LOCAL_DIR, { recursive: true });
}

function migrateLegacyActive() {
  if (existsSync(ACTIVE)) return;
  if (!existsSync(LEGACY_ACTIVE)) return;
  ensure();
  try {
    const raw = readFileSync(LEGACY_ACTIVE, 'utf8');
    writeAtomic(ACTIVE, raw);
    unlinkSync(LEGACY_ACTIVE);
  } catch {}
}
migrateLegacyActive();

export function getActive() {
  if (!existsSync(ACTIVE)) return null;
  try {
    return JSON.parse(readFileSync(ACTIVE, 'utf8'));
  } catch {
    return null;
  }
}

export function elapsedSeconds(active) {
  if (!active?.startedAt) return 0;
  return Math.round((Date.now() - new Date(active.startedAt).getTime()) / 1000);
}

export function stopTimer(toState = 'READY') {
  const active = getActive();
  if (!active) return { ok: false, msg: 'aktif timer yok' };
  const seconds = elapsedSeconds(active);
  unlinkSync(ACTIVE);
  logEvent({ type: 'stop', id: active.id, seconds, startedAt: active.startedAt, toState });
  if (seconds > 0) addTimeSpent(active.id, seconds);
  const data = load();
  const t = data.tasks.find((x) => x.id === active.id);
  if (t && t.status === 'ACTIVE') setStatus(active.id, toState);
  return { ok: true, id: active.id, seconds };
}

export function holdTimer() {
  return stopTimer('HOLD');
}

export function startTimer(id) {
  const data = load();
  const task = data.tasks.find((t) => t.id === id);
  if (!task) return { ok: false, msg: `#${id} bulunamadı` };

  let stopped = null;
  if (getActive()) stopped = holdTimer();

  ensure();
  const startedAt = new Date().toISOString();
  writeAtomic(ACTIVE, JSON.stringify({ id, startedAt }, null, 2));
  logEvent({ type: 'start', id });
  setStatus(id, 'ACTIVE');
  return { ok: true, task, startedAt, stopped };
}

export function reconcileStaleActive({ maxHours = STALE_HOURS } = {}) {
  const active = getActive();
  if (!active) return null;
  const secs = elapsedSeconds(active);
  if (secs < maxHours * 3600) return null;
  const r = holdTimer();
  return r.ok ? { id: r.id, seconds: r.seconds, hours: Math.round(secs / 360) / 10 } : null;
}

export function formatDuration(seconds) {
  if (!seconds || seconds < 60) return `${Math.max(0, seconds)}sn`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m}dk`;
  if (m === 0) return `${h}s`;
  return `${h}s ${m}dk`;
}

export function formatBigTimer(seconds) {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(sec)}`;
  return `${pad(m)}:${pad(sec)}`;
}

export function timeReport({ scope = 'week' } = {}) {
  const events = readEvents();
  const now = new Date();
  const start = new Date(now);
  if (scope === 'today') {
    start.setHours(0, 0, 0, 0);
  } else if (scope === 'week') {
    start.setDate(start.getDate() - 7);
  } else if (scope === 'month') {
    start.setDate(start.getDate() - 30);
  }

  const stops = events.filter((e) => e.type === 'stop' && new Date(e.ts) >= start);
  const data = load();
  const byProject = {};
  let total = 0;

  for (const e of stops) {
    const task = data.tasks.find((t) => t.id === e.id);
    const proj = task?.project || '(proje yok)';
    byProject[proj] = (byProject[proj] || 0) + (e.seconds || 0);
    total += e.seconds || 0;
  }

  return { byProject, total, scope, from: start.toISOString(), stopCount: stops.length };
}
