// Storage model (v2): every device appends only to its own op log
// (ops/<deviceId>.jsonl) and never touches another device's file, so iCloud
// never has two writers on one file. State = snapshot.json + all op logs
// replayed in (ts, device, seq) order.
//
// Identity: task ids are `createdMs * 16 + deviceSlot`, unique without any
// coordination. Codes (AX-17) stay human-readable; if two devices claim the
// same code while offline, the lower-slot device keeps it and the other
// shows it with its slot letter (AX-17b). Slot 0 codes never change.
import { readFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, renameSync, statSync } from 'node:fs';
import { homedir, tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadConfig, catByProject } from './config.js';
import { writeAtomic, withLock, ensureDownloaded } from './io.js';

const DIR = join(homedir(), '.joi-todo');
const OPS_DIR = join(DIR, 'ops');
const DEVICES_DIR = join(DIR, 'devices');
const LEGACY_DIR = join(DIR, 'legacy');
const SNAPSHOT = join(DIR, 'snapshot.json');
const LEGACY_TASKS = join(DIR, 'tasks.json');
const LEGACY_EVENTS = join(DIR, 'events.jsonl');
const LOCAL_DIR = join(homedir(), '.joi-todo-local');
const DEVICE_FILE = join(LOCAL_DIR, 'device.json');
// Lock lives in OS tmpdir (never synced) — it only serializes processes on
// this machine; cross-device safety comes from one-writer-per-file.
const LOCK = join(tmpdir(), 'joi-todo.lock');

const ID_SLOTS = 16;
const SLOT_LETTERS = 'abcdefghijklmnop';
const STRAY_TASKS = /^tasks( \d+)?\.json$/;
const STRAY_EVENTS = /^events( \d+)?\.jsonl$/;
const ICLOUD_PLACEHOLDER = /^\.(.+)\.icloud$/;

export const STATUS = { READY: 'READY', ACTIVE: 'ACTIVE', HOLD: 'HOLD', COMPLETE: 'COMPLETE' };

// ── files ───────────────────────────────────────────────────────────────

function listFiles(dir, pattern) {
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  const real = new Set(names.filter((n) => pattern.test(n)));
  for (const n of names) {
    const m = ICLOUD_PLACEHOLDER.exec(n);
    if (m && pattern.test(m[1])) real.add(m[1]);
  }
  return [...real].sort().map((n) => {
    const path = join(dir, n);
    ensureDownloaded(path);
    return path;
  });
}

function readJsonl(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch { return []; }
  // A line can be half-synced from another device; skip it until it lands.
  return raw.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function readJson(path) {
  ensureDownloaded(path);
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

// ── device identity ─────────────────────────────────────────────────────

let deviceCache = null;

function listDevices() {
  return listFiles(DEVICES_DIR, /\.json$/).map(readJson).filter(Boolean);
}

function device() {
  if (deviceCache) return deviceCache;
  mkdirSync(LOCAL_DIR, { recursive: true });
  mkdirSync(DEVICES_DIR, { recursive: true });
  let local = readJson(DEVICE_FILE);
  if (!local?.id) {
    local = { id: randomBytes(4).toString('hex') };
    writeAtomic(DEVICE_FILE, JSON.stringify(local, null, 2));
  }
  const regPath = join(DEVICES_DIR, `${local.id}.json`);
  let reg = readJson(regPath);
  const others = listDevices().filter((d) => d.id !== local.id);
  const outranks = (d) => d.registeredAt < reg.registeredAt || (d.registeredAt === reg.registeredAt && d.id < reg.id);
  // Two devices that registered while offline can pick the same slot; the
  // later registration moves. Ids already issued stay unique (distinct ms).
  if (!reg || others.some((d) => d.slot === reg.slot && outranks(d))) {
    const used = new Set(others.map((d) => d.slot));
    let slot = 0;
    while (used.has(slot)) slot += 1;
    if (slot >= ID_SLOTS) throw new Error(`en fazla ${ID_SLOTS} cihaz desteklenir`);
    reg = { id: local.id, name: hostname(), slot, registeredAt: reg?.registeredAt || new Date().toISOString() };
    writeAtomic(regPath, JSON.stringify(reg, null, 2));
  }
  deviceCache = reg;
  return reg;
}

// ── migration from v1 (single shared tasks.json) ────────────────────────

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

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function moveToLegacy(path, name) {
  mkdirSync(LEGACY_DIR, { recursive: true });
  try { renameSync(path, join(LEGACY_DIR, name)); } catch {}
}

function migrateIfNeeded() {
  mkdirSync(OPS_DIR, { recursive: true });
  if (ensureDownloaded(SNAPSHOT)) return;
  ensureDownloaded(LEGACY_TASKS);
  const base = readJson(LEGACY_TASKS) || { tasks: [], stats: { completed: 0 } };
  writeAtomic(SNAPSHOT, JSON.stringify({
    version: 2,
    createdAt: new Date().toISOString(),
    tasks: (base.tasks || []).map((t) => migrateTask({ ...t })),
    stats: { completed: base.stats?.completed || 0 },
    categoryCounters: base.categoryCounters || {},
  }, null, 2));
  if (existsSync(LEGACY_TASKS)) moveToLegacy(LEGACY_TASKS, 'tasks.json');
  if (ensureDownloaded(LEGACY_EVENTS)) moveToLegacy(LEGACY_EVENTS, 'events.jsonl');
}

// ── replay ──────────────────────────────────────────────────────────────

function opOrder(a, b) {
  return a.ts - b.ts || (a.dev < b.dev ? -1 : a.dev > b.dev ? 1 : 0) || a.seq - b.seq;
}

function fold() {
  migrateIfNeeded();
  const dev = device();
  const snap = readJson(SNAPSHOT) || { tasks: [], stats: { completed: 0 } };
  const tasks = new Map(snap.tasks.map((t) => [t.id, migrateTask({ ...t })]));
  const counters = { ...(snap.categoryCounters || {}) };
  let completed = snap.stats?.completed || 0;

  const ops = listFiles(OPS_DIR, /\.jsonl$/).flatMap(readJsonl).sort(opOrder);
  let own = { seq: 0, ts: 0 };

  for (const op of ops) {
    if (op.dev === dev.id) own = { seq: Math.max(own.seq, op.seq), ts: Math.max(own.ts, op.ts) };
    const t = tasks.get(op.id);
    switch (op.op) {
      case 'create':
        if (tasks.has(op.id)) break;
        tasks.set(op.id, migrateTask({ ...op.task }));
        if (op.task.done) completed += 1;
        break;
      case 'set': {
        if (!t) break;
        const wasDone = t.done;
        Object.assign(t, op.fields);
        if (!wasDone && t.done) completed += 1;
        if (wasDone && !t.done && op.undoes) completed -= 1;
        break;
      }
      case 'inc':
        if (t) t[op.field] = (t[op.field] || 0) + op.by;
        break;
      case 'delete':
        if (t) t.deleted = true;
        break;
    }
  }

  const all = [...tasks.values()];
  reconcileCounters(counters, all);
  const slots = new Map(listDevices().map((d) => [d.id, d.slot]));
  return { tasks, all, ops, own, dev, counters, completed: Math.max(0, completed), slots };
}

function reconcileCounters(counters, tasks) {
  for (const t of tasks) {
    const m = /^([A-Z]+)-(\d+)$/.exec(t.code || '');
    if (!m) continue;
    const n = Number(m[2]);
    if (n > (counters[m[1]] || 0)) counters[m[1]] = n;
  }
}

// Display codes: the lowest (slot, createdAt, id) keeps the code as is.
function displayTasks(state) {
  const live = state.all.filter((t) => !t.deleted).map((t) => ({ ...t }));
  const byCode = new Map();
  for (const t of live) {
    if (!t.code) continue;
    if (!byCode.has(t.code)) byCode.set(t.code, []);
    byCode.get(t.code).push(t);
  }
  const slotOf = (t) => state.slots.get(t.origin) ?? 0;
  for (const group of byCode.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => slotOf(a) - slotOf(b) || String(a.createdAt).localeCompare(String(b.createdAt)) || a.id - b.id);
    const taken = new Set([group[0].code]);
    for (const t of group.slice(1)) {
      let code = `${t.code}${SLOT_LETTERS[slotOf(t)]}`;
      for (let i = 2; taken.has(code); i += 1) code = `${t.code}${SLOT_LETTERS[slotOf(t)]}${i}`;
      taken.add(code);
      t.code = code;
    }
  }
  return live.sort((a, b) => a.id - b.id);
}

function view(state) {
  return { tasks: displayTasks(state), stats: { completed: state.completed } };
}

// ── writes ──────────────────────────────────────────────────────────────

function commit(state, ops) {
  const file = join(OPS_DIR, `${state.dev.id}.jsonl`);
  ensureDownloaded(file);
  const batch = ops.length > 1 ? randomBytes(4).toString('hex') : undefined;
  const lines = ops.map((op) => {
    state.own = { seq: state.own.seq + 1, ts: Math.max(Date.now(), state.own.ts) };
    const full = { ...op, ts: state.own.ts, dev: state.dev.id, seq: state.own.seq, ...(batch && { batch }) };
    applyLocal(state, full);
    return JSON.stringify(full);
  });
  appendFileSync(file, lines.join('\n') + '\n');
}

function applyLocal(state, op) {
  state.ops.push(op);
  const t = state.tasks.get(op.id);
  if (op.op === 'create') {
    const task = migrateTask({ ...op.task });
    state.tasks.set(op.id, task);
    state.all.push(task);
    reconcileCounters(state.counters, [task]);
    if (task.done) state.completed += 1;
  } else if (op.op === 'set' && t) {
    const wasDone = t.done;
    Object.assign(t, op.fields);
    if (!wasDone && t.done) state.completed += 1;
    if (wasDone && !t.done && op.undoes) state.completed -= 1;
    reconcileCounters(state.counters, [t]);
  } else if (op.op === 'inc' && t) {
    t[op.field] = (t[op.field] || 0) + op.by;
  } else if (op.op === 'delete' && t) {
    t.deleted = true;
  }
}

function tx(fn) {
  return withLock(LOCK, () => {
    const state = fold();
    absorbStrays(state);
    return fn(state);
  });
}

function newId(state) {
  let id = Date.now() * ID_SLOTS + state.dev.slot;
  while (state.tasks.has(id)) id += ID_SLOTS;
  return id;
}

function nextCode(state, project, cfg) {
  const cat = catByProject(cfg).get(project) || 'OT';
  state.counters[cat] = (state.counters[cat] || 0) + 1;
  return `${cat}-${state.counters[cat]}`;
}

function pick(obj, keys) {
  return Object.fromEntries(keys.map((k) => [k, obj[k] ?? null]));
}

function setFields(state, t, fields) {
  const stamped = { ...fields, updatedAt: new Date().toISOString() };
  commit(state, [{ op: 'set', id: t.id, fields: stamped, prev: pick(t, Object.keys(stamped)) }]);
  return shown(state, t);
}

function shown(state, t) {
  return displayTasks(state).find((x) => x.id === t.id) || { ...t };
}

const touchedAt = (t) => t.updatedAt || t.doneAt || t.createdAt || '';
const SYNCED_FIELDS = ['text', 'project', 'priority', 'due', 'status', 'done', 'doneAt', 'timeSpent'];

// An outdated client (or an iCloud conflict copy) may still write a v1
// tasks.json. Fold anything new or newer from it into this device's log,
// then park the file in legacy/ so it is absorbed exactly once.
function absorbStrays(state) {
  const strays = listFiles(DIR, STRAY_TASKS);
  const strayEvents = listFiles(DIR, STRAY_EVENTS);
  if (strays.length === 0 && strayEvents.length === 0) return;
  const cfg = loadConfig();
  const ops = [];
  const created = [];
  for (const path of strays) {
    const data = readJson(path);
    if (!data) continue;
    for (const raw of data.tasks || []) {
      const t = migrateTask({ ...raw });
      const mine = state.tasks.get(t.id);
      if (mine && mine.createdAt === t.createdAt) {
        if (touchedAt(t) <= touchedAt(mine)) continue;
        const fields = Object.fromEntries(SYNCED_FIELDS.filter((k) => t[k] !== mine[k]).map((k) => [k, t[k]]));
        if (Object.keys(fields).length) ops.push({ op: 'set', id: t.id, fields, prev: pick(mine, Object.keys(fields)), kind: 'absorb' });
        continue;
      }
      const known = [...state.all, ...created];
      if (known.some((x) => x.createdAt === t.createdAt && x.text === t.text)) continue;
      const id = newId(state);
      const taken = known.some((x) => x.code === t.code);
      const task = { ...t, id, origin: state.dev.id, code: !t.code || taken ? nextCode(state, t.project, cfg) : t.code };
      state.tasks.set(id, task);
      created.push(task);
      ops.push({ op: 'create', id, task, kind: 'absorb' });
    }
  }
  for (const path of strays) moveToLegacy(path, `absorbed-${stamp()}-${path.split('/').pop()}`);
  for (const path of strayEvents) moveToLegacy(path, `events-${stamp()}.jsonl`);
  for (const op of ops) if (op.op === 'create') state.tasks.delete(op.id);
  if (ops.length) commit(state, ops);
}

// ── public API ──────────────────────────────────────────────────────────

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

export function load() {
  return tx(view);
}

function liveTask(state, id) {
  const t = state.tasks.get(id);
  return t && !t.deleted ? t : null;
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
  return tx((state) => {
    const task = { ...makeTask(parsed), id: newId(state), origin: state.dev.id };
    task.code = nextCode(state, parsed.project, loadConfig());
    commit(state, [{ op: 'create', id: task.id, task }]);
    return task;
  });
}

// Records finished work captured from an agent session. `meta.turnId`
// makes it idempotent: replaying the same transcript never duplicates.
export function logWork({ text, project = null, meta }) {
  return tx((state) => {
    const existing = state.all.find((t) => t.meta?.turnId === meta.turnId);
    if (existing) return existing;
    const now = new Date().toISOString();
    const task = {
      ...makeTask({ text, project }),
      id: newId(state),
      origin: state.dev.id,
      status: 'COMPLETE',
      done: true,
      createdAt: meta.startedAt || now,
      doneAt: meta.endedAt || now,
      source: 'agent',
      meta,
    };
    task.code = nextCode(state, project, loadConfig());
    commit(state, [{ op: 'create', id: task.id, task, kind: 'worklog' }]);
    return task;
  });
}

export function toggleTask(id) {
  return tx((state) => {
    const t = liveTask(state, id);
    if (!t) return null;
    const now = !t.done;
    return setFields(state, t, {
      done: now,
      status: now ? 'COMPLETE' : 'READY',
      doneAt: now ? new Date().toISOString() : null,
    });
  });
}

export function setStatus(id, status) {
  return tx((state) => {
    const t = liveTask(state, id);
    if (!t) return null;
    return setFields(state, t, {
      status,
      done: status === 'COMPLETE',
      doneAt: status === 'COMPLETE' ? new Date().toISOString() : null,
    });
  });
}

// Increment, not overwrite: timers on two devices must add up, not race.
export function addTimeSpent(id, seconds) {
  if (!seconds || seconds <= 0) return null;
  return tx((state) => {
    const t = liveTask(state, id);
    if (!t) return null;
    commit(state, [{ op: 'inc', id, field: 'timeSpent', by: seconds }]);
    return { ...t };
  });
}

export function updateTask(id, patch) {
  return tx((state) => {
    const t = liveTask(state, id);
    if (!t) return null;
    const fields = { ...patch };
    if ('project' in patch && patch.project !== t.project) fields.code = nextCode(state, patch.project, loadConfig());
    return setFields(state, t, fields);
  });
}

export function removeTask(id) {
  return tx((state) => {
    const t = liveTask(state, id);
    if (!t) return null;
    const display = shown(state, t);
    commit(state, [{ op: 'delete', id }]);
    return display;
  });
}

export function clearDone() {
  return tx((state) => {
    const done = state.all.filter((t) => !t.deleted && t.done);
    if (done.length) commit(state, done.map((t) => ({ op: 'delete', id: t.id })));
    return done.length;
  });
}

const UNDO_TYPES = { create: 'add', set: 'edit', inc: 'edit', delete: 'remove' };

// Undo walks back through this device's own ops only; the other device's
// work is never rolled back from here.
export function undoLast() {
  return tx((state) => {
    const own = state.ops.filter((o) => o.dev === state.dev.id && o.op !== 'event' && o.kind !== 'absorb');
    const undone = new Set(own.flatMap((o) => o.undoes || []));
    const target = [...own].reverse().find((o) => !o.undoes && !undone.has(o.seq));
    if (!target) return { ok: false, msg: 'geri alınacak bir şey yok' };
    const group = target.batch ? own.filter((o) => o.batch === target.batch && !undone.has(o.seq)) : [target];
    const undoes = group.map((o) => o.seq);
    const inverse = group.reverse().map((o) => {
      if (o.op === 'create') return { op: 'delete', id: o.id, undoes };
      if (o.op === 'delete') return { op: 'set', id: o.id, fields: { deleted: false }, undoes };
      if (o.op === 'inc') return { op: 'inc', id: o.id, field: o.field, by: -o.by, undoes };
      return { op: 'set', id: o.id, fields: o.prev, undoes };
    });
    commit(state, inverse);
    const type = target.kind === 'worklog' ? 'worklog' : target.op === 'set' && 'done' in target.fields ? 'toggle' : UNDO_TYPES[target.op];
    return { ok: true, event: { type } };
  });
}

export function logEvent(event) {
  return tx((state) => commit(state, [{ op: 'event', payload: event }]));
}

// Events in the v1 shape (add/toggle/start/stop/...) for stats and reports.
export function readEvents() {
  return tx((state) => {
    const legacy = listFiles(LEGACY_DIR, /^events.*\.jsonl$/).flatMap(readJsonl);
    const fromOps = state.ops.flatMap((op) => {
      const ts = new Date(op.ts).toISOString();
      if (op.op === 'event') return [{ ts, ...op.payload }];
      if (op.op === 'create') return [{ ts, type: op.kind === 'worklog' ? 'worklog' : 'add', task: op.task }];
      if (op.op === 'set' && op.fields && 'done' in op.fields && op.fields.done !== op.prev?.done) {
        return [{ ts, type: 'toggle', id: op.id, done: op.fields.done }];
      }
      if (op.op === 'delete') return [{ ts, type: 'remove', id: op.id }];
      return [];
    });
    return [...legacy, ...fromOps].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
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

// Cheap change signature for the TUI: any device appending to its log or a
// snapshot rewrite changes it.
export function dataVersion() {
  let names;
  try { names = readdirSync(OPS_DIR); } catch { return ''; }
  return names.map((n) => {
    try { const s = statSync(join(OPS_DIR, n)); return `${n}:${s.size}:${s.mtimeMs}`; } catch { return n; }
  }).join('|');
}

export function deviceInfo() {
  return withLock(LOCK, () => {
    migrateIfNeeded();
    return { self: device(), devices: listDevices() };
  });
}

export const paths = { DIR, FILE: SNAPSHOT, LOG: OPS_DIR };
