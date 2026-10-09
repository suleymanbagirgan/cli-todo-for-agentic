#!/usr/bin/env node
// Claude Code Stop hook: logs every finished turn that did real work
// (at least one tool call) as a completed Joi task.
//
//   hook mode:   reads hook JSON from stdin, re-spawns itself detached
//   worker mode: joi-worklog.js --worker <transcript> <sessionId> <cwd>
//   backfill:    joi-worklog.js --backfill <transcript> [cwd]
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logWork, load } from '../src/store.js';
import { loadConfig, allProjects } from '../src/config.js';
import { withLock } from '../src/io.js';

const STATE_DIR = join(homedir(), '.joi-todo-local', 'worklog');
const MAX_TITLE = 100;

if (process.env.JOI_WORKLOG) process.exit(0);

const [mode, ...rest] = process.argv.slice(2);
if (mode === '--worker') runWorker(...rest);
else if (mode === '--backfill') runWorker(rest[0], basename(rest[0], '.jsonl'), rest[1] || process.cwd());
else hook();

function hook() {
  let input = '';
  process.stdin.on('data', (c) => { input += c; });
  process.stdin.on('end', () => {
    let payload;
    try { payload = JSON.parse(input); } catch { return; }
    const { transcript_path: tp, session_id: sid, cwd } = payload;
    if (!tp || !sid || !existsSync(tp)) return;
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker', tp, sid, cwd || ''], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, JOI_WORKLOG_WORKER: '1' },
    });
    child.unref();
  });
}

function runWorker(tp, sid, cwd) {
  if (!tp || !existsSync(tp)) return;
  mkdirSync(STATE_DIR, { recursive: true });
  const lockPath = join(STATE_DIR, `${sid}.lock`);
  try {
    withLock(lockPath, () => processTranscript(tp, sid, cwd), { retries: 2400, delayMs: 250, staleMs: 600000 });
  } catch (e) {
    log(`worker hata: ${e.message}`);
  }
}

function processTranscript(tp, sid, cwd) {
  const turns = parseTurns(tp);
  const logged = new Set(load().tasks.filter((t) => t.meta?.sessionId === sid).map((t) => t.meta.turnId));
  const cfg = loadConfig();
  const projects = allProjects(cfg);

  for (const turn of turns) {
    if (logged.has(turn.id) || turn.actions.length === 0) continue;
    const { title, project } = summarize(turn, cwd, cfg, projects);
    logWork({
      text: title,
      project,
      meta: {
        sessionId: sid,
        turnId: turn.id,
        cwd,
        prompt: turn.prompt.slice(0, 500),
        files: [...turn.files],
        commits: turn.commits,
        toolCalls: turn.actions.length,
        startedAt: turn.startedAt,
        endedAt: turn.endedAt,
      },
    });
  }
}

function promptText(entry) {
  if (entry.type !== 'user' || entry.isMeta || entry.isSidechain) return null;
  const c = entry.message?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c) || c.some((b) => b.type === 'tool_result')) return null;
  const text = c.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return text || null;
}

function isNoise(text) {
  return /^\s*<(local-command|command-stdout|bash-|system-reminder)/.test(text) || /^\[Request interrupted/.test(text);
}

function parseTurns(tp) {
  const entries = readFileSync(tp, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });

  const turns = [];
  let turn = null;
  for (const e of entries) {
    const prompt = promptText(e);
    if (prompt !== null && !isNoise(prompt)) {
      turn = { id: e.uuid, prompt, startedAt: e.timestamp, endedAt: e.timestamp, actions: [], files: new Set(), paths: new Set(), commits: [], reply: '' };
      turns.push(turn);
      continue;
    }
    if (!turn || e.type !== 'assistant' || e.isSidechain) continue;
    turn.endedAt = e.timestamp || turn.endedAt;
    if (e.cwd) turn.paths.add(e.cwd);
    for (const block of e.message?.content || []) {
      if (block.type === 'text' && block.text.trim()) turn.reply = block.text;
      if (block.type !== 'tool_use') continue;
      const input = block.input || {};
      turn.actions.push(describeAction(block.name, input));
      if (input.file_path && /^(Edit|Write|NotebookEdit)$/.test(block.name)) turn.files.add(input.file_path);
      const commit = block.name === 'Bash' && /git commit/.test(input.command || '') && /-m\s+["']([^"'\n]+)/.exec(input.command);
      if (commit) turn.commits.push(commit[1]);
      for (const m of (input.command || '').matchAll(/(?:~|\/Users\/[^/\s]+)\/[^\s'";&|]+/g)) turn.paths.add(m[0]);
    }
  }
  return turns;
}

function describeAction(name, input) {
  if (name === 'Bash') return `Bash: ${input.description || (input.command || '').slice(0, 80)}`;
  if (input.file_path) return `${name}: ${input.file_path}`;
  if (name === 'Agent') return `Agent: ${input.description || ''}`;
  if (name === 'Skill') return `Skill: ${input.skill}`;
  return name;
}

function summarize(turn, cwd, cfg, projects) {
  const pathProject = projectFromPaths([...turn.files, ...turn.paths, cwd], cfg, projects);
  const fallback = { title: firstLine(turn.commits[0] || turn.prompt), project: pathProject };
  const categories = cfg.categories
    .map((c) => `- ${c.code} (${c.name}): ${cfg.missions?.[c.code] || ''}\n  projeler: ${[c.code.toLowerCase(), ...c.children].join(', ')}`)
    .join('\n');
  const prompt = `Bir Claude Code turunda yapılan işi tek satırlık bir iş logu kaydına dönüştür.

Kullanıcı isteği:
${turn.prompt.slice(0, 1200)}

Yapılan aksiyonlar:
${turn.actions.slice(0, 40).join('\n')}
${turn.commits.length ? `\nCommit'ler:\n${turn.commits.join('\n')}` : ''}

Asistanın son cevabı:
${turn.reply.slice(0, 1500)}

Çalışma dizini: ${cwd}
Değiştirilen dosyalar: ${[...turn.files].slice(0, 15).join(', ') || 'yok'}

Kategoriler ve projeler:
${categories}

Kurallar:
- title: Türkçe, geçmiş zaman, somut sonuç ("X yapıldı", "Y düzeltildi"), en fazla ${MAX_TITLE} karakter, emoji yok
- project: işin ait olduğu en uygun alt proje (kategori açıklamalarına bak); alt proje uymuyorsa kategori kodu (küçük harf); hiçbiri uymuyorsa null

Sadece JSON yaz: {"title": "...", "project": "..."}`;

  try {
    const out = execFileSync('claude', ['-p', '--model', 'haiku', '--no-session-persistence', '--setting-sources', '', '--tools', ''], {
      input: prompt,
      encoding: 'utf8',
      timeout: 90000,
      cwd: STATE_DIR,
      env: { ...process.env, JOI_WORKLOG: '1', HOME: userInfo().homedir, PATH: `${join(userInfo().homedir, '.local/bin')}:${process.env.PATH}` },
    });
    const json = JSON.parse(/\{[\s\S]*\}/.exec(out)[0]);
    const title = firstLine(json.title || '') || fallback.title;
    const project = pathProject || (projects.includes(json.project) ? json.project : null);
    return { title, project };
  } catch (e) {
    log(`özet alınamadı (${turn.id}): ${e.message}`);
    return fallback;
  }
}

function firstLine(text) {
  const line = String(text).split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('<')) || 'İş kaydı';
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1)}…` : line;
}

// Deterministic mapping wins over the model: config.worklogPaths maps a path
// segment (e.g. "joi-todo") to a project; otherwise a segment that equals a
// project name is used. Home-level cwd (no match) leaves it to the model.
function projectFromPaths(paths, cfg, projects) {
  const aliases = cfg.worklogPaths || {};
  for (const path of paths) {
    const segments = (path || '').normalize('NFC').toLowerCase().split('/').reverse();
    for (const seg of segments) {
      if (aliases[seg] && projects.includes(aliases[seg])) return aliases[seg];
      if (seg.length > 2 && projects.includes(seg)) return seg;
    }
  }
  return null;
}

function log(msg) {
  try { writeFileSync(join(STATE_DIR, 'worklog.log'), `${new Date().toISOString()} ${msg}\n`, { flag: 'a' }); } catch {}
}
