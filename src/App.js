import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput, useApp, useStdout } from 'ink';
import { ScrollView } from 'ink-scroll-view';
import htm from 'htm';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load, addTask, updateTask, undoLast, readEvents } from './store.js';
import { manifestos as defaultManifestos } from './manifestos.js';

const personalManifestoPath = join(homedir(), '.joi-todo', 'manifestos.js');
const manifestos = existsSync(personalManifestoPath)
  ? (await import(pathToFileURL(personalManifestoPath).href)).manifestos
  : defaultManifestos;
import { parseInput } from './parse.js';
import { loadConfig, catByProject, getCategory, projectOrder, isCategoryLevel } from './config.js';
import { sortTasks, sortTasksGrouped } from './sort.js';
import { getActive, elapsedSeconds, formatDuration, formatBigTimer, reconcileStaleActive } from './timer.js';
import { completeTask, deleteTask, startOrResume, holdActive } from './actions.js';
import { taskParts } from './format.js';

const html = htm.bind(React.createElement);

const PRIORITY_COLOR = { 1: 'cyan', 2: 'yellow', 3: 'red' };

function TaskRow({ task, selected, mode }) {
  const isSel = selected && mode === 'list';
  const p = taskParts(task);
  const { done, active, hold } = p.state;
  const baseColor = done ? 'gray' : active ? 'yellow' : hold ? 'gray' : isSel ? 'greenBright' : 'white';
  const prefix = isSel ? '▸ ' : '  ';
  const dueColor = p.dueOverdue ? 'red' : 'yellow';

  return html`
    <${Text}>
      <${Text} color=${baseColor} strikethrough=${done} bold=${isSel}>${prefix}${p.mark} <//>
      <${Text} color="cyan" bold=${isSel} dimColor=${hold}>${p.code}<//>
      <${Text} color=${baseColor} strikethrough=${done} bold=${isSel}> ${p.text}<//>
      ${p.priority ? html`<${Text} color=${PRIORITY_COLOR[task.priority]} bold dimColor=${hold}> ${p.priority}<//>` : ''}
      ${p.project ? html`<${Text} color="magenta" dimColor=${done || hold}> ${p.project}<//>` : ''}
      ${p.due ? html`<${Text} color=${dueColor} dimColor=${hold}> ${p.due}<//>` : ''}
      ${p.holdLabel ? html`<${Text} color="yellow" dimColor> · ${p.holdLabel}<//>` : ''}
    <//>
  `;
}

function setProjectInInput(input, project) {
  const stripped = input.replace(/(^|\s)\+[\wçğıöşüÇĞİÖŞÜ-]+/g, '').replace(/\s+/g, ' ').trim();
  return stripped ? `${stripped} +${project}` : `+${project}`;
}

export function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [termRows, setTermRows] = useState(stdout?.rows || 24);
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setTermRows(stdout.rows || 24);
    stdout.on('resize', onResize);
    return () => stdout.off('resize', onResize);
  }, [stdout]);
  const [data, setData] = useState(load());
  const [config] = useState(loadConfig());
  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState('list');
  const scrollRef = useRef(null);
  const taskChildIdxRef = useRef(new Map());
  useEffect(() => {
    if (!stdout || !scrollRef.current) return;
    const onResize = () => scrollRef.current?.remeasure();
    stdout.on('resize', onResize);
    return () => stdout.off('resize', onResize);
  }, [stdout]);
  const [prevMode, setPrevMode] = useState('add');
  const [input, setInput] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [filter, setFilter] = useState(null);
  const [pickerIdx, setPickerIdx] = useState(0);
  const [flash, setFlash] = useState('');
  const [active, setActive] = useState(getActive());
  const [, setTick] = useState(0);

  const computeShipped = () => readEvents().filter((e) => e.type === 'toggle' && e.done).length;
  const [totalShipped, setTotalShipped] = useState(computeShipped());
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const iv = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(iv);
  }, []);

  const refresh = () => { setData(load()); setActive(getActive()); setTotalShipped(computeShipped()); };

  useEffect(() => {
    const stale = reconcileStaleActive();
    if (stale) {
      setFlash(`⏸ eski timer #${stale.id} otomatik hold'a alındı (~${stale.hours}s)`);
      setActive(null);
      setData(load());
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    const iv = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(iv);
  }, [active?.id, active?.startedAt]);
  const allTasks = data.tasks;
  const catMap = catByProject(config);
  const order = projectOrder(config);
  let filtered = allTasks;
  if (filter) {
    const filterCat = getCategory(config, filter);
    if (filterCat) {
      filtered = allTasks.filter((t) => catMap.get(t.project) === filterCat.code);
    } else {
      filtered = allTasks.filter((t) => t.project === filter);
    }
  }
  const openTasks = sortTasksGrouped(filtered.filter((t) => t.status !== 'COMPLETE'), order);
  const doneTasks = sortTasks(filtered.filter((t) => t.status === 'COMPLETE'));
  const tasks = [...openTasks, ...doneTasks];

  useEffect(() => {
    if (cursor >= tasks.length && tasks.length > 0) setCursor(tasks.length - 1);
    if (tasks.length === 0) setCursor(0);
  }, [tasks.length]);

  let overhead = 17;
  if (flash) overhead += 2;
  if (mode === 'add' || mode === 'edit') overhead += 5;
  const scrollHeight = Math.max(3, termRows - overhead);

  const cursorTaskId = tasks[cursor]?.id ?? null;
  useEffect(() => {
    const sv = scrollRef.current;
    if (!sv) return;
    const childIdx = taskChildIdxRef.current.get(cursor);
    if (childIdx === undefined) return;
    const pos = sv.getItemPosition(childIdx);
    if (!pos) return;
    const offset = sv.getScrollOffset();
    const vh = sv.getViewportHeight();
    if (pos.top < offset) {
      sv.scrollTo(pos.top);
    } else if (pos.top + pos.height > offset + vh) {
      sv.scrollTo(pos.top + pos.height - vh);
    }
  }, [cursor, cursorTaskId, tasks.length, scrollHeight]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(''), 1800);
    return () => clearTimeout(t);
  }, [flash]);

  const startEdit = (task) => {
    setEditingId(task.id);
    let s = task.text;
    if (task.project) s += ` +${task.project}`;
    if (task.priority) s += ` ${'!'.repeat(task.priority)}`;
    if (task.due) s += ` @${task.due}`;
    setInput(s);
    setMode('edit');
  };

  const openPicker = () => {
    setPrevMode(mode);
    const current = parseInput(input).project;
    const idx = current ? Math.max(0, config.projects.indexOf(current)) : 0;
    setPickerIdx(idx);
    setMode('picker');
  };

  useInput((rawCh, key) => {
    const ch = typeof rawCh === 'string' ? rawCh : '';
    const lc = ch.toLowerCase();
    if (mode === 'picker') {
      if (key.escape) { setMode(prevMode); return; }
      if (key.return) {
        const proj = config.projects[pickerIdx];
        if (proj) setInput((s) => setProjectInInput(s, proj));
        setMode(prevMode);
        return;
      }
      if (lc === 'j' || key.downArrow) { setPickerIdx((i) => Math.min(config.projects.length - 1, i + 1)); return; }
      if (lc === 'k' || key.upArrow) { setPickerIdx((i) => Math.max(0, i - 1)); return; }
      if (ch && /^[1-9]$/.test(ch)) {
        const i = Number(ch) - 1;
        if (i < config.projects.length) {
          setInput((s) => setProjectInInput(s, config.projects[i]));
          setMode(prevMode);
        }
      }
      return;
    }

    if (mode === 'add' || mode === 'edit') {
      if (key.escape) { setMode('list'); setInput(''); setEditingId(null); return; }
      if (key.tab) { openPicker(); return; }
      if (key.return) {
        const parsed = parseInput(input);
        if (parsed.text) {
          if (mode === 'add') {
            addTask(parsed);
            setFlash(`+ eklendi: ${parsed.text}`);
          } else {
            updateTask(editingId, parsed);
            setFlash(`✎ #${editingId} güncellendi`);
          }
          refresh();
        }
        setInput(''); setMode('list'); setEditingId(null);
        return;
      }
      if (key.backspace || key.delete) { setInput(input.slice(0, -1)); return; }
      if (ch && !key.ctrl && !key.meta) setInput(input + ch);
      return;
    }

    if (mode === 'filter') {
      if (key.escape) { setMode('list'); setInput(''); return; }
      if (key.tab) { openPicker(); return; }
      if (key.return) {
        const val = input.trim().replace(/^\+/, '') || null;
        setFilter(val);
        setInput(''); setMode('list');
        setFlash(val ? `filtre: +${val}` : 'filtre kaldırıldı');
        return;
      }
      if (key.backspace || key.delete) { setInput(input.slice(0, -1)); return; }
      if (ch && !key.ctrl && !key.meta) setInput(input + ch);
      return;
    }

    if (ch === 'q' || key.escape) { exit(); return; }
    if (ch === 'a' || ch === 'i') { setInput(''); setMode('add'); return; }
    if (lc === 'j' || key.downArrow) { setCursor((c) => Math.min(tasks.length - 1, c + 1)); return; }
    if (lc === 'k' || key.upArrow) { setCursor((c) => Math.max(0, c - 1)); return; }
    if (key.pageDown || (key.ctrl && lc === 'd')) { setCursor((c) => Math.min(tasks.length - 1, c + 10)); return; }
    if (key.pageUp || (key.ctrl && lc === 'u')) { setCursor((c) => Math.max(0, c - 10)); return; }
    if (ch === 'g') { setCursor(0); return; }
    if (ch === 'G' || key.end) { setCursor(Math.max(0, tasks.length - 1)); return; }
    if (key.home) { setCursor(0); return; }
    if (ch === 'c' || ch === ' ' || key.return) {
      const t = tasks[cursor];
      if (t) {
        const wasOpen = t.status !== 'COMPLETE';
        const r = completeTask(t.id);
        if (r.ok) setFlash(r.stopped ? `✓ ${t.code || '#' + t.id} tamam · +${formatDuration(r.stopped.seconds)}` : (r.task.done ? `✓ ${r.task.code}` : `↺ ${r.task.code}`));
        refresh();
        if (wasOpen && r.ok && r.task.done) {
          const newOpenCount = openTasks.length - 1;
          if (cursor >= newOpenCount && newOpenCount > 0) setCursor(newOpenCount - 1);
        }
      }
      return;
    }
    if (ch === 'd' || ch === 'x') {
      const t = tasks[cursor];
      if (t) {
        const r = deleteTask(t.id);
        if (r.ok) setFlash(`- silindi ${r.task.code}`);
        refresh();
        if (cursor >= tasks.length - 1 && cursor > 0) setCursor(cursor - 1);
      }
      return;
    }
    if (ch === 'e') {
      const t = tasks[cursor];
      if (t) startEdit(t);
      return;
    }
    if (ch === 'u') {
      const r = undoLast();
      setFlash(r.ok ? `↶ geri alındı: ${r.event.type}` : r.msg);
      refresh();
      return;
    }
    if (ch === 's') {
      const t = tasks[cursor];
      if (!t) return;
      const r = startOrResume(t.id);
      if (!r.ok) { setFlash(r.msg); return; }
      const verb = r.resumed ? '↻ resume' : '▶ start';
      setFlash(r.stopped?.ok ? `${verb} ${r.task.code} · önceki #${r.stopped.id} → hold (+${formatDuration(r.stopped.seconds)})` : `${verb} ${r.task.code}`);
      refresh();
      return;
    }
    if (ch === 'h') {
      const t = tasks[cursor];
      if (!t) return;
      const r = holdActive(t.id);
      if (!r.ok) { setFlash(r.msg); return; }
      setFlash(`⏸ ${t.code || '#' + r.id} hold · +${formatDuration(r.seconds)}`);
      refresh();
      return;
    }
    if (ch === '/') { setInput(''); setMode('filter'); return; }
    if (ch === 'F') { setFilter(null); setFlash('filtre kaldırıldı'); }
    if (ch === 'r') refresh();
  });

  const activeTask = active ? allTasks.find((t) => t.id === active.id) : null;
  const openCount = allTasks.filter((t) => t.status !== 'COMPLETE').length;
  const doneCount = allTasks.filter((t) => t.status === 'COMPLETE').length;

  return html`
    <${Box} flexDirection="column" padding=${1}>
      <${Box} flexDirection="column" paddingX=${1}>
        <${Box} justifyContent="space-between">
          <${Text}>
            <${Text} color="greenBright" bold>◆ JOI<//>
            <${Text} color="green" bold> TODO<//>
            ${filter ? html`<${Text} dimColor>   ·  filtre: <//><${Text} color="magenta">+${filter}<//>` : ''}
          <//>
          <${Text} dimColor>
            ${openCount} açık  ·  ${doneCount} bitti
          <//>
        <//>
        <${Text} dimColor>
          <${Text} color="greenBright" bold>${totalShipped}<//>
          <${Text} dimColor> tasks shipped all-time  ·  ${String(now.getDate()).padStart(2,'0')}.${String(now.getMonth()+1).padStart(2,'0')}.${now.getFullYear()} ${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][now.getDay()]}  ·  ${Math.ceil((new Date(now.getFullYear() + 1, 0, 1) - now) / 86400000)} days left in ${now.getFullYear()}<//>
        <//>
        <${Text} italic color="yellow">${'» ' + manifestos[Math.floor(Date.now() / 86400000) % manifestos.length]}<//>
      <//>

      <${Box}
        marginTop=${1}
        borderStyle="round"
        borderColor=${active ? 'green' : 'gray'}
        paddingX=${2}
      >
        ${active && activeTask ? html`
          <${Text}>
            <${Text} color="greenBright" bold>▶  <//>
            <${Text} color="greenBright" bold>${formatBigTimer(elapsedSeconds(active))}<//>
            <${Text} dimColor>    <//>
            <${Text} color="cyan" bold>${activeTask.code}<//>
            <${Text} color="white">   ${activeTask.text}<//>
            ${activeTask.project ? html`<${Text} color="magenta">    +${activeTask.project}<//>` : ''}
          <//>
        ` : html`
          <${Text} dimColor>
            <${Text}>○  hazır<//>
            <${Text}>     ·  bir görev seç, <//>
            <${Text} color="cyan">s<//>
            <${Text}> ile timer başlat<//>
          <//>
        `}
      <//>

      ${(() => {
        const t = tasks[cursor];
        if (!t) return null;
        if (t.status === 'COMPLETE') {
          const dkey = t.doneAt ? t.doneAt.slice(0, 10) : null;
          const label = dkey
            ? (() => { const d = new Date(t.doneAt); return `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()} ${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getDay()]}`; })()
            : 'tarihsiz';
          return html`
            <${Box} marginTop=${1} paddingX=${1}>
              <${Text}>
                <${Text} color="greenBright" bold>◆ SHIPPED<//>
                <${Text} dimColor>   ·   <//>
                <${Text} color="cyan" bold>${label}<//>
              <//>
            <//>
          `;
        }
        const cat = catMap.get(t.project);
        const catObj = cat ? config.categories.find((c) => c.code === cat) : null;
        const proj = t.project || '(proje yok)';
        const isDirect = isCategoryLevel(config, proj);
        const projPart = isDirect ? null : html`<${Text} key="brc-proj"><${Text} dimColor>   ·   <//><${Text} color="magenta">+${proj}<//><//>`;
        return html`
          <${Box} marginTop=${1} paddingX=${1}>
            <${Text}>
              <${Text} key="brc-cat" bold color="cyan">━━ ${cat || '?'}<//>
              <${Text} key="brc-catname" color="magenta">  ${catObj?.name || ''}<//>
              ${projPart}
            <//>
          <//>
        `;
      })()}

      <${Box} flexDirection="column" marginTop=${0} height=${scrollHeight}>
        ${tasks.length === 0
          ? html`<${Text} dimColor italic>  ${filter ? `(+${filter} projesi boş)` : "(görev yok — 'a' ile ekle)"}<//>`
          : (() => {
              const rows = [];
              const idxMap = new Map();
              let lastCat = null;
              let lastProj = null;
              let doneHeaderShown = false;
              const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
              const dateLabel = (iso) => {
                if (!iso) return 'tarihsiz';
                const d = new Date(iso);
                const dd = String(d.getDate()).padStart(2, '0');
                const mm = String(d.getMonth() + 1).padStart(2, '0');
                const yyyy = d.getFullYear();
                return `${dd}.${mm}.${yyyy}  ${dayNames[d.getDay()]}`;
              };
              let lastDoneDate = null;
              tasks.forEach((t, i) => {
                if (t.status === 'COMPLETE') {
                  if (!doneHeaderShown) {
                    rows.push(html`<${Text} key="hdr-done-spacer"> <//>`);
                    rows.push(html`
                      <${Box}
                        key="hdr-done"
                        borderStyle="single"
                        borderColor="gray"
                        borderBottom=${false}
                        borderLeft=${false}
                        borderRight=${false}
                        flexDirection="column"
                      >
                        <${Text}>
                          <${Text} color="greenBright" bold>◆ SHIPPED<//>
                          <${Text} color="green" bold>  ARCHIVE<//>
                          <${Text} dimColor>   ·   ${doneTasks.length} completed<//>
                        <//>
                      <//>
                    `);
                    doneHeaderShown = true;
                  }
                  const dkey = t.doneAt ? t.doneAt.slice(0, 10) : 'tarihsiz';
                  if (dkey !== lastDoneDate) {
                    if (lastDoneDate !== null) rows.push(html`<${Text} key=${'done-date-spc-' + dkey}> <//>`);
                    const dayCount = doneTasks.filter((x) => (x.doneAt ? x.doneAt.slice(0,10) : 'tarihsiz') === dkey).length;
                    rows.push(html`
                      <${Box} key=${'done-date-' + dkey} paddingLeft=${2}>
                        <${Text}>
                          <${Text} color="cyan" dimColor bold>${dateLabel(t.doneAt)}<//>
                          <${Text} dimColor>  ${dayCount}<//>
                        <//>
                      <//>
                    `);
                    lastDoneDate = dkey;
                  }
                  idxMap.set(i, rows.length);
                  rows.push(html`
                    <${Box} key=${'task-' + t.id} paddingLeft=${2}>
                      <${TaskRow} task=${t} selected=${i === cursor} mode=${mode} />
                    <//>
                  `);
                  return;
                }
                const cat = catMap.get(t.project);
                const catObj = cat ? config.categories.find((c) => c.code === cat) : null;
                if (cat !== lastCat) {
                  if (lastCat !== null) rows.push(html`<${Text} key=${'cat-spc-' + (cat || 'none')}> <//>`);
                  const catOpen = openTasks.filter((x) => catMap.get(x.project) === cat).length;
                  const mission = config.missions?.[cat];
                  rows.push(html`
                    <${Box} key=${'cat-' + (cat || 'none')} flexDirection="column">
                      <${Text}>
                        <${Text} bold color="cyan">━━ ${cat || '?'}<//>
                        <${Text} color="magenta">  ${catObj?.name || ''}<//>
                        <${Text} dimColor>  ${catOpen} açık<//>
                      <//>
                      ${mission ? html`<${Text} dimColor italic>   ${mission}<//>` : ''}
                    <//>
                  `);
                  lastCat = cat;
                  lastProj = null;
                }
                const proj = t.project || '(proje yok)';
                const isDirect = isCategoryLevel(config, proj);
                if (!isDirect && proj !== lastProj) {
                  const projOpen = openTasks.filter((x) => x.project === proj).length;
                  rows.push(html`
                    <${Box} key=${'proj-' + (cat || 'none') + '-' + proj} paddingLeft=${2}>
                      <${Text}>
                        <${Text} color="magenta">└─ +${proj}<//>
                        <${Text} dimColor>  ${projOpen}<//>
                      <//>
                    <//>
                  `);
                  lastProj = proj;
                } else if (isDirect) {
                  lastProj = null;
                }
                idxMap.set(i, rows.length);
                rows.push(html`
                  <${Box} key=${'task-' + t.id} paddingLeft=${isDirect ? 2 : 4}>
                    <${TaskRow} task=${t} selected=${i === cursor} mode=${mode} />
                  <//>
                `);
              });
              taskChildIdxRef.current = idxMap;
              return html`<${ScrollView} ref=${scrollRef}>${rows}<//>`;
            })()}
      <//>

      ${(mode === 'add' || mode === 'edit') && html`
        <${Box} marginTop=${1} borderStyle="single" borderColor="cyan" paddingX=${1} flexDirection="column">
          <${Text}>
            <${Text} color="cyan">${mode === 'add' ? '+ ' : '✎ '}<//>
            <${Text} color="white">${input}<//>
            <${Text} color="cyan">_<//>
          <//>
          <${Text} dimColor>ipucu: Tab: proje · +etiket · ! !! !!! · @bugün @yarın @2026-08-20<//>
        <//>
      `}

      ${mode === 'filter' && html`
        <${Box} marginTop=${1} borderStyle="single" borderColor="magenta" paddingX=${1}>
          <${Text}>
            <${Text} color="magenta">filtre +<//>
            <${Text} color="white">${input}<//>
            <${Text} color="magenta">_<//>
          <//>
        <//>
      `}

      ${mode === 'picker' && html`
        <${Box} marginTop=${1} borderStyle="double" borderColor="magenta" paddingX=${1} flexDirection="column">
          <${Text} bold color="magenta">proje seç<//>
          ${config.projects.map((p, i) => {
            const sel = i === pickerIdx;
            const num = i < 9 ? `${i + 1}` : ' ';
            return html`
              <${Text} key=${p} color=${sel ? 'magentaBright' : 'white'} bold=${sel}>
                ${sel ? '▸ ' : '  '}[${num}] +${p}
              <//>
            `;
          })}
        <//>
      `}

      ${flash && html`
        <${Box} marginTop=${1}><${Text} color="yellow">${flash}<//><//>
      `}

      <${Box} marginTop=${1} borderStyle="single" borderColor="gray" paddingX=${1}>
        <${Text} dimColor>
          ${mode === 'add' || mode === 'edit'
            ? 'enter: kaydet · tab: proje · esc: iptal'
            : mode === 'picker'
            ? '1-9/j/k: gez · enter: seç · esc: iptal'
            : mode === 'filter'
            ? 'enter: uygula · tab: proje · esc: iptal'
            : 'a: ekle · e: düzenle · s: start · h: hold · c: complete · d: sil · u: geri al · /: filtre · j/k/↑↓: gez · g/G: baş/son · ^D/^U: hızlı · q: çık'}
        <//>
      <//>
    <//>
  `;
}
