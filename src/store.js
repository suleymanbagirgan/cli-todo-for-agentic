import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, catByProject } from './config.js';
import { writeAtomic, withLock, ensureDownloaded } from './io.js';

const DIR = join(homedir(), '.joi-todo');
const FILE = join(DIR, 'tasks.json');
const LOG = join(DIR, 'events.jsonl');
// Lock lives in OS tmpdir (never synced by iCloud/Dropbox) to avoid
// ghost locks between devices when the data dir is a synced symlink.
const LOCK = join(tmpdir(), 'joi-todo.lock');
// iCloud names the losing side of a cross-device write conflict "tasks 2.json".
const CONFLICT_TASKS = /^tasks \d+\.json$/;
const CONFLICT_EVENTS = /^events \d+\.jsonl$/;

function ensure() {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  if (!ensureDownloaded(FILE)) writeAtomic(FILE, JSON.stringify({ tasks: [], nextId: 1, stats: { completed: 0 } }, null, 2));
  if (!ensureDownloaded(LOG)) writeFileSync(LOG, '');
}

function tx(fn) {
  return withLock(LOCK, () => {
    resolveConflicts();
    return fn();
  });
}

const touchedAt = (t) => t.updatedAt || t.doneAt || t.createdAt || '';

function reconcileCounters(data, tasks) {
  data.categoryCounters = data.categoryCounters || {};
  for (const t of tasks) {
    const m = /^([A-Z]+)-(\d+)$/.exec(t.code || '');
    if (!m) continue;
    const n = Number(m[2]);
    if (n > (data.categoryCounters[m[1]] || 0)) data.categoryCounters[m[1]] = n;
  }
}

// Same id + same createdAt → same task, newest edit wins. Same id but a
// different createdAt → both devices added a task concurrently, so the
// incoming one gets a fresh id and code instead of being dropped.
function mergeTasks(data, other, cfg) {
  const byId = new Map(data.tasks.map((t) => [t.id, t]));
  const incoming = [];
  for (const t of other.tasks || []) {
    const mine = byId.get(t.id);
    if (!mine) incoming.push({ ...t });
    else if (mine.createdAt !== t.createdAt) incoming.push({ ...t, id: null });
    else if (touchedAt(t) > touchedAt(mine)) Object.assign(mine, t);
  }
  reconcileCounters(data, [...data.tasks, ...incoming]);
  const usedCodes = new Set(data.tasks.map((t) => t.code).filter(Boolean));
  let maxId = Math.max(0, ...data.tasks.map((t) => t.id || 0), ...incoming.map((t) => t.id || 0));
  for (const t of incoming) {
    if (t.id === null) t.id = ++maxId;
    if (!t.code || usedCodes.has(t.code)) t.code = nextCode(data, t.project, cfg);
    usedCodes.add(t.code);
    data.tasks.push(t);
  }
  data.tasks.sort((a, b) => a.id - b.id);
  data.nextId = Math.max(data.nextId || 1, other.nextId || 1, maxId + 1);
  data.stats = { completed: Math.max(data.stats?.completed || 0, other.stats?.completed || 0) };
}

function resolveConflicts() {
  let names;
  try { names = readdirSync(DIR); } catch { return; }
  const taskCopies = names.filter((n) => CONFLICT_TASKS.test(n));
  const eventCopies = names.filter((n) => CONFLICT_EVENTS.test(n));
  if (taskCopies.length === 0 && eventCopies.length === 0) return;
  ensure();

  if (taskCopies.length) {
    const data = JSON.parse(readFileSync(FILE, 'utf8'));
    const cfg = loadConfig();
    const merged = [];
    for (const name of taskCopies) {
      const path = join(DIR, name);
      try {
        mergeTasks(data, JSON.parse(readFileSync(path, 'utf8')), cfg);
        merged.push(path);
      } catch {}
    }
    writeAtomic(FILE, JSON.stringify(data, null, 2));
    for (const path of merged) unlinkSync(path);
  }

  if (eventCopies.length) {
    const lines = new Set(readFileSync(LOG, 'utf8').split('\n').filter(Boolean));
    for (const name of eventCopies) {
      const path = join(DIR, name);
      for (const line of readFileSync(path, 'utf8').split('\n')) if (line) lines.add(line);
      unlinkSync(path);
    }
    const sorted = [...lines]
      .map((line) => { try { return { line, ts: JSON.parse(line).ts || '' }; } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => a.ts.localeCompare(b.ts));
    writeAtomic(LOG, sorted.map((e) => e.line).join('\n') + '\n');
  }
}

function migrateTask(t) {
  if ('tag' in t && !('project' in t)) {
    t.project = t.tag ?? null;
    delete t.tag;
  }
  if (!('project' in t)) t.project = null;
  if (!('priority' in t)) t.priority = 0;
  if (!('due' in t)) t.due = null;
  if (!('code' in t)) t.code = null;
  if (!('status' in t)) t.status = t.done ? 'COMPLETE' : 'READY';
  if (!('timeSpent' in t)) t.timeSpent = 0;
  return t;
}

function nextCode(data, project, cfg) {
  const catMap = catByProject(cfg);
  const cat = catMap.get(project) || 'OT';
  data.categoryCounters = data.categoryCounters || {};
  data.categoryCounters[cat] = (data.categoryCounters[cat] || 0) + 1;
  return `${cat}-${data.categoryCounters[cat]}`;
}

export function findTask(data, ref) {
  if (ref === null || ref === undefined || ref === '') return null;
  const s = String(ref).trim();
  const asNum = Number(s);
  if (Number.isInteger(asNum) && String(asNum) === s && !s.includes('-')) {
    return data.tasks.find((t) => t.id === asNum);
  }
  const upper = s.toUpperCase();
  return data.tasks.find((t) => t.code && t.code.toUpperCase() === upper);
}

export const STATUS = { READY: 'READY', ACTIVE: 'ACTIVE', HOLD: 'HOLD', COMPLETE: 'COMPLETE' };

export function addTimeSpent(id, seconds) {
  if (!seconds || seconds <= 0) return null;
  return tx(() => {
    const data = loadRaw();
    const t = data.tasks.find((x) => x.id === id);
    if (!t) return null;
    t.timeSpent = (t.timeSpent || 0) + seconds;
    t.updatedAt = new Date().toISOString();
    save(data);
    return t;
  });
}

export function setStatus(id, status) {
  return tx(() => {
    const data = loadRaw();
    const t = data.tasks.find((x) => x.id === id);
    if (!t) return null;
    const before = t.status;
    t.status = status;
    t.updatedAt = new Date().toISOString();
    t.done = status === 'COMPLETE';
    t.doneAt = status === 'COMPLETE' ? new Date().toISOString() : null;
    save(data);
    logEventUnlocked({ type: 'status', id, before, after: status });
    return t;
  });
}

function loadRaw() {
  ensure();
  const data = JSON.parse(readFileSync(FILE, 'utf8'));
  data.tasks = data.tasks.map((t) => migrateTask({ ...t }));
  const maxId = data.tasks.reduce((m, t) => Math.max(m, t.id || 0), 0);
  data.nextId = Math.max(data.nextId || 1, maxId + 1);
  reconcileCounters(data, data.tasks);
  // Reconcile lifetime completed counter. If missing or stale (e.g. edited
  // externally), recompute from events once so the header stays accurate.
  if (!data.stats || typeof data.stats.completed !== 'number') {
    data.stats = { completed: 0 };
    try {
      const raw = readFileSync(LOG, 'utf8').trim();
      if (raw) {
        for (const line of raw.split('\n')) {
          const e = JSON.parse(line);
          if (e.type === 'toggle' && e.done) data.stats.completed += 1;
        }
      }
    } catch {}
  }
  return data;
}

export function load() {
  return tx(loadRaw);
}

export function save(data) {
  ensure();
  writeAtomic(FILE, JSON.stringify(data, null, 2));
}

function logEventUnlocked(event) {
  ensure();
  appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
}

export function logEvent(event) {
  return tx(() => logEventUnlocked(event));
}

export function readEvents() {
  ensure();
  const raw = readFileSync(LOG, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').map((line) => JSON.parse(line));
}

function writeEvents(events) {
  ensure();
  writeAtomic(LOG, events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
}

function makeTask({ text, project = null, priority = 0, due = null }) {
  return {
    id: 0,
    code: null,
    text,
    project,
    priority,
    due,
    status: 'READY',
    done: false,
    timeSpent: 0,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    doneAt: null,
  };
}

export function addTask(parsed) {
  return tx(() => {
    const data = loadRaw();
    const cfg = loadConfig();
    const task = makeTask(parsed);
    const usedIds = new Set(data.tasks.map((t) => t.id));
    while (usedIds.has(data.nextId)) data.nextId += 1;
    task.id = data.nextId;
    task.code = nextCode(data, parsed.project, cfg);
    data.tasks.push(task);
    data.nextId += 1;
    save(data);
    logEventUnlocked({ type: 'add', task: { ...task } });
    return task;
  });
}

export function toggleTask(id) {
  return tx(() => {
    const data = loadRaw();
    const t = data.tasks.find((x) => x.id === id);
    if (!t) return null;
    const before = { done: t.done, status: t.status, doneAt: t.doneAt };
    const now = !t.done;
    t.done = now;
    t.updatedAt = new Date().toISOString();
    t.status = now ? 'COMPLETE' : 'READY';
    t.doneAt = now ? new Date().toISOString() : null;
    // Lifetime counter: matches count of `toggle && done` events over history,
    // so cycles (complete → uncomplete → complete) count each completion.
    if (now) {
      data.stats = data.stats || { completed: 0 };
      data.stats.completed += 1;
    }
    save(data);
    logEventUnlocked({ type: 'toggle', id, done: t.done, status: t.status, before });
    return t;
  });
}

export function removeTask(id) {
  return tx(() => {
    const data = loadRaw();
    const idx = data.tasks.findIndex((x) => x.id === id);
    if (idx === -1) return null;
    const [removed] = data.tasks.splice(idx, 1);
    save(data);
    logEventUnlocked({ type: 'remove', task: removed });
    return removed;
  });
}

export function clearDone() {
  return tx(() => {
    const data = loadRaw();
    const removed = data.tasks.filter((x) => x.done);
    data.tasks = data.tasks.filter((x) => !x.done);
    save(data);
    logEventUnlocked({ type: 'clear', tasks: removed });
    return removed.length;
  });
}

export function updateTask(id, patch) {
  return tx(() => {
    const data = loadRaw();
    const cfg = loadConfig();
    const t = data.tasks.find((x) => x.id === id);
    if (!t) return null;
    const before = { text: t.text, project: t.project, priority: t.priority, due: t.due, code: t.code };
    const projChanged = 'project' in patch && patch.project !== t.project;
    Object.assign(t, patch, { updatedAt: new Date().toISOString() });
    if (projChanged) t.code = nextCode(data, patch.project, cfg);
    save(data);
    logEventUnlocked({ type: 'edit', id, before, after: { ...patch, code: t.code } });
    return t;
  });
}

export function undoLast() {
  return tx(() => {
    const events = readEvents();
    if (events.length === 0) return { ok: false, msg: 'geri alınacak bir şey yok' };

    const last = events[events.length - 1];
    const data = loadRaw();

    switch (last.type) {
      case 'add': {
        const idx = data.tasks.findIndex((x) => x.id === last.task.id);
        if (idx !== -1) data.tasks.splice(idx, 1);
        if (data.nextId === last.task.id + 1) data.nextId = last.task.id;
        break;
      }
      case 'remove': {
        data.tasks.push(migrateTask({ ...last.task }));
        data.tasks.sort((a, b) => a.id - b.id);
        break;
      }
      case 'toggle': {
        const t = data.tasks.find((x) => x.id === last.id);
        if (t) {
          if (last.before) {
            // new format: restore explicit before-state
            t.done = last.before.done;
            t.status = last.before.status;
            t.doneAt = last.before.doneAt ?? null;
          } else {
            // legacy fallback: flip
            t.done = !t.done;
            t.status = t.done ? 'COMPLETE' : 'READY';
            t.doneAt = t.done ? new Date().toISOString() : null;
          }
        }
        // Removing a completion event from the log means the lifetime
        // count also drops by one; other toggle undos leave it alone.
        if (last.done === true) {
          data.stats = data.stats || { completed: 0 };
          if (data.stats.completed > 0) data.stats.completed -= 1;
        }
        break;
      }
      case 'clear': {
        data.tasks.push(...last.tasks.map((t) => migrateTask({ ...t })));
        data.tasks.sort((a, b) => a.id - b.id);
        break;
      }
      case 'edit': {
        const t = data.tasks.find((x) => x.id === last.id);
        if (t) Object.assign(t, last.before);
        break;
      }
      default:
        return { ok: false, msg: `geri alınamıyor: ${last.type}` };
    }

    save(data);
    writeEvents(events.slice(0, -1));
    return { ok: true, event: last };
  });
}

export function stats() {
  const events = readEvents();
  const data = load();
  const now = new Date();
  const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
  const startOfWeek = new Date(startOfDay); startOfWeek.setDate(startOfWeek.getDate() - 7);

  const inRange = (iso, start) => new Date(iso) >= start;

  const addedToday = events.filter((e) => e.type === 'add' && inRange(e.ts, startOfDay)).length;
  const doneToday = events.filter((e) => e.type === 'toggle' && e.done && inRange(e.ts, startOfDay)).length;
  const addedWeek = events.filter((e) => e.type === 'add' && inRange(e.ts, startOfWeek)).length;
  const doneWeek = events.filter((e) => e.type === 'toggle' && e.done && inRange(e.ts, startOfWeek)).length;

  return {
    pending: data.tasks.filter((t) => !t.done).length,
    done: data.tasks.filter((t) => t.done).length,
    total: data.tasks.length,
    addedToday, doneToday, addedWeek, doneWeek,
    events: events.length,
  };
}

export const paths = { DIR, FILE, LOG };
