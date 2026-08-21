#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import meow from 'meow';
import chalk from 'chalk';
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readlinkSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { App } from '../src/App.js';
import {
  load, addTask, toggleTask, removeTask, clearDone, updateTask, undoLast, stats, paths, findTask, setStatus, STATUS,
} from '../src/store.js';
import { parseInput, formatDue, isOverdue } from '../src/parse.js';
import { loadConfig, configPath, catByProject, getCategory, projectOrder, isCategoryLevel } from '../src/config.js';
import { sortTasks, sortTasksGrouped } from '../src/sort.js';
import { startTimer, stopTimer, holdTimer, getActive, elapsedSeconds, formatDuration, formatBigTimer, timeReport, reconcileStaleActive } from '../src/timer.js';
import { completeTask, deleteTask, startOrResume, holdActive } from '../src/actions.js';
import { taskParts } from '../src/format.js';

const cli = meow(`
  ${chalk.green.bold('JOI TODO')}

  ${chalk.bold('Kullanım')}
    $ todo                            interaktif TUI
    $ todo add "görev [+etiket] [!!] [@yarın]"
    $ todo list [+etiket]             proje bazında gruplu liste (default)
    $ todo list --flat                düz sıralı liste
    $ todo top [days]                 sonraki N gün içinde kritik (default 30)
    $ todo done <id>                  toggle tamam
    $ todo edit <id> "yeni metin"     düzenle
    $ todo rm <id>                    sil
    $ todo undo                       son işlemi geri al
    $ todo clear                      bitmişleri sil
    $ todo stats                      istatistik
    $ todo start <id>                 zaman sayacı başlat / hold'dan resume
    $ todo hold                       aktif görevi hold'a al (süre birikimli)
    $ todo stop                       aktif sayacı durdur (READY'ye döner)
    $ todo now                        şu an aktif olan
    $ todo time [today|week|month]    proje bazında zaman dağılımı
    $ todo projects                   proje listesi
    $ todo projects add "isim"        proje ekle
    $ todo projects rm "isim"         proje sil
    $ todo agent "soru"               AI'ya sor (Claude CLI kullanır)
    $ todo sync                       iCloud sync durumu
    $ todo sync on|off                iCloud sync aç/kapat
    $ todo path                       veri dosyaları

  ${chalk.bold('Sözdizimi')}
    +proje          proje (klc, mighty, özaydın, ...)
    !, !!, !!!      öncelik (düşük/orta/yüksek)
    @bugün @yarın @dün @YYYY-MM-DD    tarih

  ${chalk.bold('Örnek')}
    $ todo add "sunum hazırla +klc !! @yarın"
    $ todo list +klc
`, { importMeta: import.meta, flags: {} });

const PRIO_COLOR = { 1: chalk.cyan, 2: chalk.yellow, 3: chalk.red };

function fmt(t) {
  const p = taskParts(t);
  const { done, hold } = p.state;
  const markColor = done ? 'green' : p.state.active ? 'yellow' : 'gray';
  const bits = [chalk[markColor](p.mark)];
  bits.push(hold ? chalk.dim.cyan(p.code) : chalk.cyan(p.code));
  bits.push(done ? chalk.gray.strikethrough(p.text) : hold ? chalk.gray(p.text) : p.text);
  if (p.priority) bits.push((hold ? chalk.dim : PRIO_COLOR[t.priority].bold)(p.priority));
  if (p.project) bits.push((hold || done ? chalk.dim.magenta : chalk.magenta)(p.project));
  if (p.due) bits.push(p.dueOverdue ? chalk.red(p.due) : (hold ? chalk.dim.yellow(p.due) : chalk.yellow(p.due)));
  if (p.holdLabel) bits.push(chalk.dim.yellow(`· ${p.holdLabel}`));
  return bits.join(' ');
}

const cmd = cli.input[0];

async function main() {
  const stale = reconcileStaleActive();
  if (stale) {
    console.error(chalk.yellow(`⏸ eski timer #${stale.id} otomatik hold'a alındı (~${stale.hours}s)`));
  }

  switch (cmd) {
    case undefined: {
      const enterAlt = '\x1b[?1049h\x1b[H\x1b[2J';
      const leaveAlt = '\x1b[?1049l';
      process.stdout.write(enterAlt);
      let left = false;
      const leave = () => {
        if (left) return;
        left = true;
        try { process.stdout.write(leaveAlt); } catch {}
      };
      process.on('exit', leave);
      process.on('SIGINT', () => { leave(); process.exit(130); });
      process.on('SIGTERM', () => { leave(); process.exit(143); });
      process.on('uncaughtException', (err) => { leave(); console.error(err); process.exit(1); });
      const app = render(React.createElement(App), { exitOnCtrlC: true });
      app.waitUntilExit().then(leave, leave);
      return;
    }
    case 'add': {
      const raw = cli.input.slice(1).join(' ').trim();
      if (!raw) { console.error(chalk.red('görev metni gerekli')); process.exit(1); }
      const parsed = parseInput(raw);
      if (!parsed.text) { console.error(chalk.red('metin boş kaldı, sadece token verdin')); process.exit(1); }
      const t = addTask(parsed);
      console.log(chalk.green('+ ') + fmt(t));
      return;
    }
    case 'list':
    case 'ls': {
      const data = load();
      const cfg = loadConfig();
      const filterArg = cli.input[1];
      const filterRaw = filterArg && filterArg.startsWith('+') ? filterArg.slice(1) : null;
      const flat = cli.input.includes('--flat') || cli.input.includes('-f');
      const catMap = catByProject(cfg);
      let tasks = data.tasks;
      if (filterRaw) {
        const filterCat = getCategory(cfg, filterRaw);
        if (filterCat) {
          const catCode = filterCat.code;
          tasks = tasks.filter((t) => catMap.get(t.project) === catCode);
        } else {
          tasks = tasks.filter((t) => t.project === filterRaw.toLowerCase());
        }
      }
      const order = projectOrder(cfg);
      tasks = flat ? sortTasks(tasks) : sortTasksGrouped(tasks, order);
      if (tasks.length === 0) {
        console.log(chalk.dim(filterRaw ? `(+${filterRaw} boş)` : '(boş)'));
        return;
      }
      if (flat) {
        console.log();
        tasks.forEach((t) => console.log('  ' + fmt(t)));
      } else {
        const openTasks = tasks.filter((t) => t.status !== 'COMPLETE');
        const doneTasks = tasks.filter((t) => t.status === 'COMPLETE');
        let lastCat = null;
        let lastProj = null;
        for (const t of openTasks) {
          const cat = catMap.get(t.project);
          const catObj = cat ? cfg.categories.find((c) => c.code === cat) : null;
          if (cat !== lastCat) {
            const catOpen = openTasks.filter((x) => catMap.get(x.project) === cat).length;
            console.log();
            console.log('  ' + chalk.bold.cyan(`━━ ${cat || '?'}`) + chalk.magenta(`  ${catObj?.name || ''}`) + chalk.dim(`  ${catOpen} açık`));
            const mission = cfg.missions?.[cat];
            if (mission) console.log('  ' + chalk.dim.italic(`   ${mission}`));
            lastCat = cat;
            lastProj = null;
          }
          const proj = t.project || '(proje yok)';
          const isDirect = isCategoryLevel(cfg, proj);
          if (!isDirect && proj !== lastProj) {
            const projOpen = openTasks.filter((x) => x.project === proj).length;
            console.log('    ' + chalk.magenta(`└─ +${proj}`) + chalk.dim(`  ${projOpen}`));
            lastProj = proj;
          } else if (isDirect) {
            lastProj = null;
          }
          const indent = isDirect ? '    ' : '      ';
          console.log(indent + fmt(t));
        }
        if (doneTasks.length > 0) {
          console.log();
          console.log('  ' + chalk.gray.bold(`━━ ✓ Bitmiş`) + chalk.dim(`  ${doneTasks.length}`));
          doneTasks.forEach((t) => console.log('  ' + fmt(t)));
        }
      }
      const p = tasks.filter((t) => t.status !== 'COMPLETE').length;
      const d = tasks.filter((t) => t.status === 'COMPLETE').length;
      console.log('\n  ' + chalk.dim(`${p} açık · ${d} bitti${filterRaw ? ` · +${filterRaw}` : ''}`));
      return;
    }
    case 'top': {
      const data = load();
      const cfg = loadConfig();
      const catMap = catByProject(cfg);
      const days = Number(cli.input[1]) || 30;
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() + days);
      const y = cutoff.getFullYear();
      const m = String(cutoff.getMonth() + 1).padStart(2, '0');
      const d = String(cutoff.getDate()).padStart(2, '0');
      const cutoffIso = `${y}-${m}-${d}`;

      const critical = data.tasks.filter((t) => {
        if (t.status === 'COMPLETE') return false;
        if ((t.priority || 0) >= 3) return true;
        if (t.due && t.due <= cutoffIso && (t.priority || 0) >= 1) return true;
        return false;
      });
      const sorted = sortTasksGrouped(critical, projectOrder(cfg));

      console.log();
      console.log('  ' + chalk.bold.red(`▸ TOP — ${days}g içinde kritik (${sorted.length})`));
      console.log('  ' + chalk.dim('─'.repeat(42)));
      if (sorted.length === 0) { console.log('  ' + chalk.dim('(kritik iş yok)')); return; }
      let lastCat = null;
      for (const t of sorted) {
        const cat = catMap.get(t.project);
        if (cat !== lastCat) {
          const catObj = cfg.categories.find((c) => c.code === cat);
          console.log();
          console.log('  ' + chalk.bold.cyan(`━━ ${cat}`) + chalk.magenta(`  ${catObj?.name || ''}`));
          lastCat = cat;
        }
        console.log('    ' + fmt(t));
      }
      return;
    }
    case 'projects': {
      const cfg = loadConfig();
      const data = load();
      const catMap = catByProject(cfg);
      console.log();
      console.log('  ' + chalk.bold.cyan('▸ KATEGORİLER'));
      console.log('  ' + chalk.dim('─'.repeat(40)));
      for (const cat of cfg.categories) {
        const catOpen = data.tasks.filter((t) => catMap.get(t.project) === cat.code && t.status !== 'COMPLETE').length;
        console.log();
        console.log('  ' + chalk.bold.cyan(cat.code) + chalk.magenta(`  ${cat.name}`) + chalk.dim(`  ${catOpen} açık`));
        const mission = cfg.missions?.[cat.code];
        if (mission) console.log('    ' + chalk.dim.italic(mission));
        for (const child of cat.children) {
          const childOpen = data.tasks.filter((t) => t.project === child && t.status !== 'COMPLETE').length;
          console.log('    ' + chalk.magenta(`└─ +${child}`) + chalk.dim(`  ${childOpen}`));
        }
      }
      console.log('\n  ' + chalk.dim(configPath));
      return;
    }
    case 'done':
    case 'toggle': {
      const ref = cli.input[1];
      if (!ref) { console.error(chalk.red('ref gerekli (kod ya da #id)')); process.exit(1); }
      const found = findTask(load(), ref);
      if (!found) { console.error(chalk.red(`${ref} bulunamadı`)); process.exit(1); }
      const r = completeTask(found.id);
      if (!r.ok) { console.error(chalk.red(r.msg)); process.exit(1); }
      if (r.stopped?.ok) console.log(chalk.yellow(`⏸ ${found.code} — +${formatDuration(r.stopped.seconds)}`));
      console.log(r.task.done ? chalk.green(`✓ ${r.task.code}`) : chalk.yellow(`↺ ${r.task.code}`));
      return;
    }
    case 'edit': {
      const ref = cli.input[1];
      const raw = cli.input.slice(2).join(' ').trim();
      if (!ref || !raw) { console.error(chalk.red('kullanım: todo edit <ref> "yeni metin"')); process.exit(1); }
      const data = load();
      const found = findTask(data, ref);
      if (!found) { console.error(chalk.red(`${ref} bulunamadı`)); process.exit(1); }
      const parsed = parseInput(raw);
      const t = updateTask(found.id, parsed);
      console.log(chalk.cyan('✎ ') + fmt(t));
      return;
    }
    case 'rm':
    case 'remove':
    case 'del': {
      const ref = cli.input[1];
      if (!ref) { console.error(chalk.red('ref gerekli')); process.exit(1); }
      const found = findTask(load(), ref);
      if (!found) { console.error(chalk.red(`${ref} bulunamadı`)); process.exit(1); }
      const r = deleteTask(found.id);
      if (!r.ok) { console.error(chalk.red(r.msg)); process.exit(1); }
      console.log(chalk.red(`- ${r.task.code}`));
      return;
    }
    case 'undo': {
      const r = undoLast();
      if (!r.ok) { console.log(chalk.dim(r.msg)); return; }
      console.log(chalk.yellow(`↶ geri alındı: ${r.event.type}`));
      return;
    }
    case 'clear': {
      const data = load();
      const doneCount = data.tasks.filter((t) => t.done).length;
      if (doneCount === 0) { console.log(chalk.dim('temizlenecek bitmiş görev yok')); return; }
      const yes = cli.input.includes('--yes') || cli.input.includes('-y');
      if (!yes) {
        if (!process.stdin.isTTY) {
          console.error(chalk.red(`${doneCount} bitmiş görev silinecek. Onay için: todo clear --yes`));
          process.exit(1);
        }
        process.stdout.write(chalk.yellow(`${doneCount} bitmiş görev kalıcı silinecek. Emin misin? [y/N] `));
        const buf = Buffer.alloc(8);
        const fs = await import('node:fs');
        const bytes = fs.readSync(0, buf, 0, 8, null);
        const answer = buf.toString('utf8', 0, bytes).trim().toLowerCase();
        if (answer !== 'y' && answer !== 'yes') { console.log(chalk.dim('iptal edildi')); return; }
      }
      const n = clearDone();
      console.log(chalk.yellow(`✓ ${n} bitmiş silindi`) + chalk.dim(' · undo ile geri alınabilir'));
      return;
    }
    case 'stats': {
      const s = stats();
      console.log();
      console.log('  ' + chalk.bold.green('▸ İSTATİSTİK'));
      console.log('  ' + chalk.dim('─'.repeat(28)));
      console.log('  ' + chalk.dim('açık        ') + chalk.white(s.pending));
      console.log('  ' + chalk.dim('bitmiş      ') + chalk.gray(s.done));
      console.log('  ' + chalk.dim('toplam      ') + chalk.white(s.total));
      console.log();
      console.log('  ' + chalk.dim('bugün ekle  ') + chalk.cyan(s.addedToday));
      console.log('  ' + chalk.dim('bugün bitir ') + chalk.green(s.doneToday));
      console.log('  ' + chalk.dim('7g ekle     ') + chalk.cyan(s.addedWeek));
      console.log('  ' + chalk.dim('7g bitir    ') + chalk.green(s.doneWeek));
      console.log();
      console.log('  ' + chalk.dim(`toplam event: ${s.events}`));
      return;
    }
    case 'start':
    case 'resume': {
      const ref = cli.input[1];
      if (!ref) { console.error(chalk.red('ref gerekli')); process.exit(1); }
      const found = findTask(load(), ref);
      if (!found) { console.error(chalk.red(`${ref} bulunamadı`)); process.exit(1); }
      const r = startOrResume(found.id);
      if (!r.ok) { console.error(chalk.red(r.msg)); process.exit(1); }
      if (r.stopped?.ok) {
        const prev = load().tasks.find((x) => x.id === r.stopped.id);
        console.log(chalk.yellow(`⏸  önceki ${prev?.code || '#' + r.stopped.id} → hold (+${formatDuration(r.stopped.seconds)})`));
      }
      const verb = r.resumed ? '↻ resume' : '▶ start';
      console.log(chalk.green(`${verb} ${r.task.code} ${r.task.text}`));
      return;
    }
    case 'hold':
    case 'pause': {
      const r = holdActive();
      if (!r.ok) { console.log(chalk.dim(r.msg)); return; }
      const t = load().tasks.find((x) => x.id === r.id);
      console.log(chalk.yellow(`⏸ hold ${t?.code || '#' + r.id} — +${formatDuration(r.seconds)} · toplam ${formatBigTimer(t?.timeSpent || 0)}`));
      return;
    }
    case 'stop': {
      const r = stopTimer();
      if (!r.ok) { console.log(chalk.dim(r.msg)); return; }
      const t = load().tasks.find((x) => x.id === r.id);
      console.log(chalk.yellow(`⏸ ${t?.code || '#' + r.id} — +${formatDuration(r.seconds)}`));
      return;
    }
    case 'now': {
      const active = getActive();
      if (!active) { console.log(chalk.dim('aktif timer yok')); return; }
      const data = load();
      const task = data.tasks.find((t) => t.id === active.id);
      const secs = elapsedSeconds(active);
      const label = task ? fmt(task) : chalk.dim(`#${active.id} (task silinmiş)`);
      console.log(chalk.green('▶ ') + label + chalk.dim(` — ${formatDuration(secs)}`));
      return;
    }
    case 'time': {
      const scopeArg = cli.input[1] || 'week';
      const scope = ['today', 'week', 'month'].includes(scopeArg) ? scopeArg : 'week';
      const r = timeReport({ scope });
      const label = { today: 'BUGÜN', week: 'SON 7 GÜN', month: 'SON 30 GÜN' }[scope];
      console.log();
      console.log('  ' + chalk.bold.cyan(`▸ ZAMAN — ${label}`));
      console.log('  ' + chalk.dim('─'.repeat(38)));
      if (r.total === 0) {
        console.log('  ' + chalk.dim('(veri yok · `todo start <id>` ile başla)'));
        return;
      }
      const entries = Object.entries(r.byProject).sort(([, a], [, b]) => b - a);
      const maxLen = Math.max(...entries.map(([p]) => p.length + 1));
      for (const [proj, secs] of entries) {
        const pct = Math.round((secs / r.total) * 100);
        const bar = '█'.repeat(Math.max(1, Math.round(pct / 4)));
        console.log(
          '  ' + chalk.magenta(('+' + proj).padEnd(maxLen + 2)) +
          chalk.white(formatDuration(secs).padStart(8)) +
          chalk.dim(`  ${pct}%`.padStart(6)) +
          '  ' + chalk.cyan(bar),
        );
      }
      console.log('  ' + chalk.dim('─'.repeat(38)));
      console.log('  ' + chalk.bold('toplam    ') + chalk.white(formatDuration(r.total)) + chalk.dim(`  (${r.stopCount} oturum)`));
      return;
    }
    case 'sync': {
      const sub = cli.input[1];
      const localDir = paths.DIR;
      const iCloudBase = join(homedir(), 'Library/Mobile Documents/com~apple~CloudDocs');
      const iCloudDir = join(iCloudBase, 'joi-todo');

      const isSymlink = existsSync(localDir) && lstatSync(localDir).isSymbolicLink();

      if (!sub || sub === 'status') {
        if (isSymlink) {
          console.log(chalk.green('● sync aktif'));
          console.log(chalk.dim('  ') + readlinkSync(localDir));
        } else {
          console.log(chalk.dim('○ sync kapalı (yerel: ' + localDir + ')'));
        }
        return;
      }
      if (sub === 'on' || sub === 'enable') {
        if (isSymlink) { console.log(chalk.dim('zaten aktif')); return; }
        if (!existsSync(iCloudBase)) { console.error(chalk.red('iCloud Drive bulunamadı: ' + iCloudBase)); process.exit(1); }
        if (existsSync(iCloudDir)) {
          console.error(chalk.red('iCloud\'da zaten var: ' + iCloudDir));
          console.error(chalk.dim('yerel klasörü sil (' + localDir + ') ya da iCloud kopyayı sil, sonra tekrar dene'));
          process.exit(1);
        }
        renameSync(localDir, iCloudDir);
        symlinkSync(iCloudDir, localDir);
        console.log(chalk.green('✓ sync aktif → ') + iCloudDir);
        return;
      }
      if (sub === 'off' || sub === 'disable') {
        if (!isSymlink) { console.log(chalk.dim('sync zaten kapalı')); return; }
        const target = readlinkSync(localDir);
        unlinkSync(localDir);
        renameSync(target, localDir);
        console.log(chalk.yellow('○ sync kapatıldı, veri yerelde: ' + localDir));
        return;
      }
      console.error(chalk.red('bilinmeyen: todo sync ' + sub));
      process.exit(1);
    }
    case 'agent':
    case 'ai':
    case 'ask': {
      const question = cli.input.slice(1).join(' ').trim();
      if (!question) { console.error(chalk.red('soru gerekli')); process.exit(1); }
      const data = load();
      const today = new Date().toISOString().slice(0, 10);
      const ctx = sortTasks(data.tasks).map((t) => {
        const status = t.done ? '[x]' : '[ ]';
        const bits = [`#${t.id}`, status, t.text];
        if (t.priority) bits.push('!'.repeat(t.priority));
        if (t.project) bits.push('+' + t.project);
        if (t.due) bits.push('@' + t.due);
        return bits.join(' ');
      }).join('\n');

      const prompt = `Sen kullanıcının todo listesi için asistanısın. Türkçe, kısa ve öz cevap ver. Gereksiz süs yok.

Bugün: ${today}

Görevler:
${ctx || '(liste boş)'}

Kullanıcının sorusu: ${question}`;

      const claude = spawn('claude', ['-p', prompt], { stdio: ['ignore', 'inherit', 'inherit'] });
      claude.on('error', (err) => {
        if (err.code === 'ENOENT') {
          console.error(chalk.red('claude CLI bulunamadı. Kurulum: https://claude.com/claude-code'));
        } else {
          console.error(chalk.red('hata: ' + err.message));
        }
        process.exit(1);
      });
      claude.on('exit', (code) => process.exit(code ?? 0));
      return;
    }
    case 'path': {
      console.log(paths.FILE);
      console.log(paths.LOG);
      console.log(configPath);
      return;
    }
    default: {
      console.error(chalk.red(`bilinmeyen komut: ${cmd}`));
      console.log(cli.help);
      process.exit(1);
    }
  }
}

main();
